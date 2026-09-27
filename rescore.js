const { db, POSTED_AT } = require("./database");
const { scoreJob } = require("./scorer");

// One-time migration: before filter_reason existed, the scorer's exclusions were
// stored as status='hidden' with a "- …" breakdown. Those were never the
// user's own Hide, so give them back their status and let filter_reason decide.
const migrated = db.prepare(
  "UPDATE jobs SET status = 'new' WHERE status = 'hidden' AND score_breakdown LIKE '- %'"
).run().changes;
if (migrated) console.log(`Migrated ${migrated} auto-hidden rows to filter_reason.`);

const update = db.prepare(`
  UPDATE jobs
  SET score = @score, rating = @rating, score_breakdown = @score_breakdown,
      is_remote = @is_remote, filter_reason = @filter_reason
  WHERE id = @id
`);

const rows = db.prepare("SELECT * FROM jobs").all();
console.log(`Rescoring ${rows.length} jobs...`);

let filtered = 0, scoreChanged = 0;
db.transaction(() => {
  for (const job of rows) {
    const s = scoreJob(job);
    if (s.hidden) filtered++;
    if (job.score !== s.score) scoreChanged++;
    update.run({
      id: job.id,
      score: s.score,
      rating: s.rating,
      score_breakdown: s.breakdown,
      is_remote: s.is_remote,
      filter_reason: s.filter_reason,
    });
  }
})();

const expired = expireOldJobs();
console.log(`Done. ${scoreChanged} scores changed, ${filtered} filtered by rules, ${expired} newly expired.`);
db.close();

function expireOldJobs() {
  return db.prepare(`
    UPDATE jobs SET is_expired = 1
    WHERE is_expired = 0 AND julianday('now') - julianday(${POSTED_AT}) > 30
  `).run().changes;
}
