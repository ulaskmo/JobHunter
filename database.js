const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "jobs.db"));

// Enable WAL mode for better concurrent access
db.pragma("journal_mode = WAL");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT,
    location TEXT,
    salary TEXT,
    description TEXT,
    url TEXT NOT NULL,
    posted_date TEXT,
    scraped_at TEXT DEFAULT (datetime('now')),
    tags TEXT,
    job_type TEXT,
    experience_level TEXT,
    is_remote INTEGER DEFAULT 0,
    is_easy_apply INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    rating TEXT DEFAULT '+',
    score_breakdown TEXT,
    status TEXT DEFAULT 'new',
    applied_at TEXT,
    notes TEXT,
    UNIQUE(source, external_id),
    UNIQUE(source, url)
  );

  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    applied_at TEXT DEFAULT (datetime('now')),
    method TEXT,
    status TEXT DEFAULT 'applied',
    response TEXT,
    notes TEXT,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  );

  CREATE TABLE IF NOT EXISTS scrape_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    scraped_at TEXT DEFAULT (datetime('now')),
    jobs_found INTEGER DEFAULT 0,
    new_jobs INTEGER DEFAULT 0,
    errors TEXT,
    duration_ms INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(score DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
  CREATE INDEX IF NOT EXISTS idx_jobs_scraped ON jobs(scraped_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_status_score ON jobs(status, score DESC);
`);

// Ensure columns added after v1 exist (idempotent)
for (const col of [
  "ALTER TABLE jobs ADD COLUMN is_expired INTEGER DEFAULT 0",
  "ALTER TABLE jobs ADD COLUMN verified_at TEXT",
  // Set when the scorer's rules exclude a job (US-only, senior, …). Kept
  // separate from status='hidden', which is only ever the user's own Hide.
  "ALTER TABLE jobs ADD COLUMN filter_reason TEXT",
  // Star — independent of status, so a favourite stays starred after applying.
  "ALTER TABLE jobs ADD COLUMN favorite INTEGER DEFAULT 0",
]) {
  try { db.exec(col); } catch (e) { /* column already exists */ }
}

// Telegram de-dupe: a job is alerted once. When the column is first added,
// mark every existing row as already notified so we don't flood the chat.
try {
  db.exec("ALTER TABLE jobs ADD COLUMN notified_at TEXT");
  db.exec("UPDATE jobs SET notified_at = datetime('now')");
} catch (e) { /* column already exists */ }

// LinkedIn cards used to capture "\n\n   1 week ago" into the location.
db.exec(`UPDATE jobs SET location = trim(substr(location, 1, instr(location, char(10)) - 1))
         WHERE instr(location, char(10)) > 0`);

// Posting date, falling back to scrape date — what "Past week" etc. filter on.
const POSTED_AT = "COALESCE(NULLIF(posted_date, ''), scraped_at)";

// ─── Prepared Statements ──────────────────────────────────────────────────────
const insertJob = db.prepare(`
  INSERT OR IGNORE INTO jobs (external_id, source, title, company, location, salary, description, url, posted_date, tags, job_type, experience_level, is_remote, is_easy_apply, score, rating, score_breakdown, filter_reason)
  VALUES (@external_id, @source, @title, @company, @location, @salary, @description, @url, @posted_date, @tags, @job_type, @experience_level, @is_remote, @is_easy_apply, @score, @rating, @score_breakdown, @filter_reason)
`);

const updateJobScore = db.prepare(`
  UPDATE jobs SET score = @score, score_breakdown = @score_breakdown WHERE id = @id
`);

const setJobStatus = db.prepare(`
  UPDATE jobs SET status = @status, applied_at = CASE WHEN @status = 'applied' THEN datetime('now') ELSE applied_at END WHERE id = @id
`);
const insertApplication = db.prepare(`INSERT INTO applications (job_id, method, status) VALUES (?, 'manual', ?)`);

// Status change + application log. Every move into applied/interview/rejected
// is recorded so outcomes can be tracked per source later.
const updateJobStatus = {
  run: db.transaction(({ id, status }) => {
    setJobStatus.run({ id, status });
    if (["applied", "interview", "rejected"].includes(status)) insertApplication.run(id, status);
  }),
};

const getJobs = db.prepare(`
  SELECT * FROM jobs ORDER BY score DESC, scraped_at DESC
`);

const getJobsByStatus = db.prepare(`
  SELECT * FROM jobs WHERE status = @status ORDER BY score DESC, scraped_at DESC
`);

const getJobById = db.prepare(`
  SELECT * FROM jobs WHERE id = @id
`);

const getStats = db.prepare(`
  SELECT
    SUM(CASE WHEN filter_reason IS NULL THEN 1 ELSE 0 END) as total,
    SUM(CASE WHEN status = 'new' AND filter_reason IS NULL AND is_expired = 0 THEN 1 ELSE 0 END) as new_count,
    SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) as applied_count,
    SUM(CASE WHEN status = 'interview' THEN 1 ELSE 0 END) as interview_count,
    SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected_count,
    SUM(CASE WHEN status = 'saved' THEN 1 ELSE 0 END) as saved_count,
    SUM(CASE WHEN status = 'hidden' THEN 1 ELSE 0 END) as hidden_count,
    SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END) as favorite_count,
    SUM(CASE WHEN filter_reason IS NOT NULL AND status = 'new' AND is_expired = 0 THEN 1 ELSE 0 END) as filtered_count,
    SUM(CASE WHEN score >= 80 AND status = 'new' AND filter_reason IS NULL AND is_expired = 0 THEN 1 ELSE 0 END) as priority_count
  FROM jobs
`);

const logScrape = db.prepare(`
  INSERT INTO scrape_log (source, jobs_found, new_jobs, errors, duration_ms)
  VALUES (@source, @jobs_found, @new_jobs, @errors, @duration_ms)
`);

const searchJobs = db.prepare(`
  SELECT * FROM jobs
  WHERE (title LIKE @query OR company LIKE @query OR description LIKE @query OR tags LIKE @query)
  ORDER BY score DESC, scraped_at DESC
`);

// Score a scraped job and insert it. Rule-filtered jobs are stored with their
// filter_reason (shown in the Filtered tab) so a bad rule can be spotted —
// except plain non-software titles, which are pure noise.
// Returns true when a new, visible row was inserted.
function ingestJob(job) {
  const s = require("./scorer").scoreJob(job);
  if (s.hidden && /^(Not a software role|Title doesn't match)/.test(s.filter_reason)) return false;
  job.score = s.score;
  job.rating = s.rating;
  job.score_breakdown = s.breakdown;
  job.filter_reason = s.filter_reason;
  if (s.is_remote) job.is_remote = 1;
  try { return insertJob.run(job).changes > 0 && !s.hidden; } catch (e) { return false; }
}

module.exports = {
  db,
  POSTED_AT,
  ingestJob,
  insertJob,
  updateJobScore,
  updateJobStatus,
  getJobs,
  getJobsByStatus,
  getJobById,
  getStats,
  logScrape,
  searchJobs,
};
