const express = require("express");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");
require("dotenv").config();

const { db, POSTED_AT, getJobById, getStats, updateJobStatus, logScrape } = require("./database");
const { scrapeRemoteOK } = require("./scrapers/remoteok");
const { scrapeLinkedIn } = require("./scrapers/linkedin");
const { scrapeKariyer } = require("./scrapers/kariyer");
const { scrapeToptalent } = require("./scrapers/toptalent");
const { scrapeArbeitnow } = require("./scrapers/arbeitnow");
const { scrapeRemotive } = require("./scrapers/remotive");
const { scrapeJobicy } = require("./scrapers/jobicy");
const { scrapeWWR } = require("./scrapers/weworkremotely");
const { scrapeHNHiring } = require("./scrapers/hnhiring");
const { scrapeBoards } = require("./scrapers/boards");
const { scrapeIrishJobs } = require("./scrapers/irishjobs");
const { scrapeLinkedInTR } = require("./scrapers/linkedin_tr");
const { scrapeWorkable } = require("./scrapers/workable");
const { scrapeLinkedInAbroad, enrichLinkedInDescriptions } = require("./scrapers/linkedin_tr");
const { initTelegram, sendAlert, notifyPriorityJobs, stopTelegram } = require("./telegram");

// Rotate server.log if it's grown past 5 MB
try {
  const logPath = path.join(__dirname, "server.log");
  if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) {
    fs.renameSync(logPath, logPath + ".1");
  }
} catch (e) { /* ignore rotation failures */ }

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Serve CV for download
app.get("/api/cv", (req, res) => {
  res.sendFile(path.join(__dirname, "cv.pdf"));
});

// ─── API Routes ───────────────────────────────────────────────────────────────

const LOCATION_PATTERNS = {
  ireland: ["%ireland%", "%dublin%", "%cork%", "%galway%", "%sligo%", "%limerick%", "%waterford%"],
  turkey: [
    "%turkey%", "%türkiye%", "%istanbul%", "%i̇stanbul%", "%ankara%", "%izmir%",
    "%bursa%", "%antalya%", "%kocaeli%", "%gebze%", "%adana%", "%eskişehir%", "%konya%"
  ],
  uk: ["%uk%", "%london%", "%united kingdom%", "%england%", "%manchester%", "%edinburgh%", "%scotland%", "%wales%"],
  europe: [
    "%germany%", "%berlin%", "%netherlands%", "%amsterdam%", "%france%", "%paris%",
    "%spain%", "%portugal%", "%sweden%", "%europe%"
  ],
  canada: ["%canada%", "%toronto%", "%vancouver%", "%montreal%", "%ontario%"],
  singapore: ["%singapore%"],
  gulf: ["%united arab emirates%", "%dubai%", "%abu dhabi%", "%qatar%", "%doha%", "%saudi%", "%riyadh%"],
  anz: ["%australia%", "%sydney%", "%melbourne%", "%new zealand%", "%auckland%"],
};

const TIME_MAP = {
  "24h": "-1 day",
  "week": "-7 days",
  "2weeks": "-14 days",
  "month": "-1 month",
  "3months": "-3 months",
};

function buildJobFilters({ status, source, search, priority, location, time }) {
  const where = [];
  const params = [];

  if (status === "favorites") {
    // Every starred job, whatever its status — applied ones included.
    where.push("favorite = 1");
  } else if (status === "filtered") {
    // Jobs the scorer's rules removed — for checking a rule isn't too strict.
    where.push("status = 'new' AND filter_reason IS NOT NULL AND is_expired = 0");
  } else if (status && status !== "all") {
    where.push("status = ?");
    params.push(status);
  } else {
    where.push("status != 'hidden'");
  }

  // Rules (US-only, senior…) and expiry only prune the "new" feed — anything
  // you saved, applied to or hid yourself always stays visible.
  if (!status || status === "new" || status === "all") where.push("filter_reason IS NULL AND is_expired = 0");

  if (source && source !== "all") {
    where.push("source = ?");
    params.push(source);
  }

  if (location && location !== "all") {
    if (location === "remote") {
      where.push("is_remote = 1");
    } else if (LOCATION_PATTERNS[location]) {
      const patterns = LOCATION_PATTERNS[location];
      where.push("(" + patterns.map(() => "LOWER(location) LIKE ?").join(" OR ") + ")");
      params.push(...patterns);
    }
  }

  if (priority === "S") where.push("score >= 80");
  else if (priority === "A") where.push("score >= 60 AND score < 80");
  else if (priority === "B") where.push("score < 60");

  // Filter on when the job was POSTED, not when we happened to scrape it.
  if (time && time !== "all" && TIME_MAP[time]) {
    where.push(`julianday(${POSTED_AT}) > julianday('now', ?)`);
    params.push(TIME_MAP[time]);
  }

  if (search) {
    where.push("(title LIKE ? OR company LIKE ? OR description LIKE ? OR tags LIKE ? OR location LIKE ?)");
    const q = `%${search}%`;
    params.push(q, q, q, q, q);
  }

  return { whereClause: where.length ? "WHERE " + where.join(" AND ") : "", params };
}

// Get all jobs with filters
app.get("/api/jobs", (req, res) => {
  const { sort, limit, offset } = req.query;
  const { whereClause, params } = buildJobFilters(req.query);

  let orderBy = `ORDER BY score DESC, julianday(${POSTED_AT}) DESC`;
  if (sort === "date") orderBy = `ORDER BY julianday(${POSTED_AT}) DESC`;
  else if (sort === "company") orderBy = "ORDER BY company ASC";
  else if (sort === "applied") orderBy = "ORDER BY applied_at DESC";

  const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
  const off = Math.max(parseInt(offset) || 0, 0);

  const jobs = db.prepare(`SELECT * FROM jobs ${whereClause} ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, lim, off);

  const total = db.prepare(`SELECT COUNT(*) as count FROM jobs ${whereClause}`).get(...params);

  res.json({ jobs, total: total.count });
});

// Get stats
app.get("/api/stats", (req, res) => {
  const stats = getStats.get();
  const sources = db.prepare(
    "SELECT source, COUNT(*) as count FROM jobs GROUP BY source"
  ).all();
  const recentScrapes = db.prepare(
    "SELECT * FROM scrape_log ORDER BY scraped_at DESC LIMIT 10"
  ).all();

  res.json({ stats, sources, recentScrapes });
});

// Update job status
app.put("/api/jobs/:id/status", (req, res) => {
  const { status } = req.body;
  const validStatuses = ["new", "applied", "interview", "rejected", "saved", "hidden"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  updateJobStatus.run({ id: req.params.id, status });
  res.json({ success: true });
});

// Star / unstar a job
app.put("/api/jobs/:id/favorite", (req, res) => {
  db.prepare("UPDATE jobs SET favorite = ? WHERE id = ?").run(req.body.favorite ? 1 : 0, req.params.id);
  res.json({ success: true });
});

// Get single job
app.get("/api/jobs/:id", (req, res) => {
  const job = getJobById.get({ id: req.params.id });
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// Manual scrape trigger
app.post("/api/scrape", async (req, res) => {
  if (isScraping) {
    return res.status(409).json({ error: "A scrape run is already in progress" });
  }
  const { source } = req.body;
  res.json({ message: `Scraping ${source || "all"} started...` });

  runAllScrapers({ onlySource: source }).catch((err) => {
    console.error(`Scrape error: ${err.message}`);
  });
});

// ─── Scraper Scheduler ────────────────────────────────────────────────────────
let isScraping = false;

async function runAllScrapers({ onlySource } = {}) {
  if (isScraping) {
    console.log("Skipping scrape: previous run still in progress");
    return;
  }
  isScraping = true;

  console.log("\n=== Running all scrapers ===");
  const startTime = Date.now();
  const beforeCount = getStats.get().total;
  const errors = [];

  // Each entry: [name, fn, tier]
  // tier "fast"     — JSON/RSS APIs; safe to run all at once.
  // tier "playwright" — launches a browser; serialize to avoid OOM + bans.
  const runners = [
    ["remoteok",       scrapeRemoteOK,   "fast"],
    ["arbeitnow",      scrapeArbeitnow,  "fast"],
    ["remotive",       scrapeRemotive,   "fast"],
    ["jobicy",         scrapeJobicy,     "fast"],
    ["weworkremotely", scrapeWWR,        "fast"],
    ["hnhiring",       scrapeHNHiring,   "fast"],
    ["boards",         scrapeBoards,     "fast"],
    ["irishjobs",      scrapeIrishJobs,  "fast"],
    ["linkedin_tr",    scrapeLinkedInTR, "fast"],
    ["workable",       scrapeWorkable,   "fast"],
    ["linkedin_abroad", scrapeLinkedInAbroad, "fast"],
    ["linkedin",       scrapeLinkedIn,   "playwright"],
    ["toptalent",      scrapeToptalent,  "playwright"],
    ["kariyer",        scrapeKariyer,    "fast"], // no-op (PX wall)
  ];

  try {
    const selected = onlySource
      ? runners.filter(([name]) => name === onlySource)
      : runners;

    // Fast scrapers in parallel — they hit different hosts, no contention.
    const fastRunners = selected.filter(([, , tier]) => tier === "fast");
    if (fastRunners.length > 0) {
      console.log(`Running ${fastRunners.length} API scrapers in parallel...`);
      await Promise.all(
        fastRunners.map(async ([name, fn]) => {
          try { await fn(); }
          catch (e) {
            console.error(`${name} scraper failed:`, e.message);
            errors.push(`${name}: ${e.message}`);
          }
        })
      );
    }

    // Playwright-based scrapers sequentially — each launches Chromium.
    const pwRunners = selected.filter(([, , tier]) => tier === "playwright");
    for (const [name, fn] of pwRunners) {
      try { await fn(); }
      catch (e) {
        console.error(`${name} scraper failed:`, e.message);
        errors.push(`${name}: ${e.message}`);
      }
    }

    // Fill in real descriptions for the best LinkedIn cards and rescore them.
    if (!onlySource) {
      try { await enrichLinkedInDescriptions(); }
      catch (e) { errors.push(`enrich: ${e.message}`); }
    }

    // Expire anything posted more than 30 days ago, from every source.
    try {
      const result = db.prepare(`
        UPDATE jobs SET is_expired = 1
        WHERE is_expired = 0 AND julianday('now') - julianday(${POSTED_AT}) > 30
      `).run();
      if (result.changes > 0) console.log(`Marked ${result.changes} stale jobs as expired.`);
    } catch (e) { /* non-fatal */ }

    const afterStats = getStats.get();
    const newJobs = afterStats.total - beforeCount;
    const duration = Date.now() - startTime;

    console.log(`=== Scraping complete. ${newJobs} new jobs in ${Math.round(duration / 1000)}s ===\n`);

    try {
      logScrape.run({
        source: onlySource || "all",
        jobs_found: afterStats.total,
        new_jobs: newJobs,
        errors: errors.length ? errors.join("; ") : null,
        duration_ms: duration,
      });
    } catch (e) { /* log table is best-effort */ }

    // Alert once per job: every new Turkey match, plus anything scoring 75+.
    const tr = LOCATION_PATTERNS.turkey;
    const alertJobs = db.prepare(
      `SELECT * FROM jobs WHERE notified_at IS NULL AND status = 'new' AND is_expired = 0
       AND filter_reason IS NULL AND (score >= 80 OR ${tr.map(() => "LOWER(location) LIKE ?").join(" OR ")})
       ORDER BY score DESC`
    ).all(...tr);
    if (alertJobs.length > 0) await notifyPriorityJobs(alertJobs);
    db.prepare("UPDATE jobs SET notified_at = datetime('now') WHERE notified_at IS NULL").run();
  } finally {
    isScraping = false;
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
let httpServer;
let cronJob;

async function start() {
  initTelegram();

  httpServer = app.listen(PORT, () => {
    console.log(`\n  Job Hunter Dashboard: http://localhost:${PORT}\n`);
  });

  console.log("Running initial scrape...");
  await runAllScrapers();

  const interval = parseInt(process.env.SCRAPE_INTERVAL) || 60;
  cronJob = cron.schedule(`*/${interval} * * * *`, () => {
    runAllScrapers().catch((err) => console.error("Scheduled scrape failed:", err.message));
  });

  console.log(`Scrapers scheduled to run every ${interval} minutes.`);
  await sendAlert(
    "<b>Job Hunter Bot Started!</b>\n" +
    "Scrapers running. Dashboard available.\n" +
    "Send /help for commands."
  );
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}, shutting down...`);

  if (cronJob) { try { cronJob.stop(); } catch (e) {} }
  if (httpServer) { await new Promise((r) => httpServer.close(() => r())); }
  try { await stopTelegram(); } catch (e) {}
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch (e) {}
  try { db.close(); } catch (e) {}

  console.log("Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
