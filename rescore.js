const { db } = require("./database");
const { scoreJob } = require("./scorer");

const update = db.prepare(`
  UPDATE jobs
  SET score = @score,
      rating = @rating,
      score_breakdown = @score_breakdown,
      is_remote = @is_remote,
      status = CASE
        WHEN @hidden = 1 THEN 'hidden'
        WHEN status = 'hidden' AND @hidden = 0 THEN 'new'
        ELSE status
      END
  WHERE id = @id
`);

const rows = db.prepare("SELECT * FROM jobs").all();
console.log(`Rescoring ${rows.length} jobs...`);

let hidden = 0, unhidden = 0, scoreChanged = 0;

const tx = db.transaction(() => {
  for (const job of rows) {
    const s = scoreJob(job);
    const nowHidden = s.hidden ? 1 : 0;
    const wasHidden = job.status === "hidden" ? 1 : 0;

    if (nowHidden && !wasHidden) hidden++;
    if (!nowHidden && wasHidden) unhidden++;
    if (job.score !== s.score) scoreChanged++;

    update.run({
      id: job.id,
      score: s.score,
      rating: s.rating,
      score_breakdown: s.breakdown,
      is_remote: s.is_remote,
      hidden: nowHidden,
    });
  }
});

tx();

console.log(`Done. ${scoreChanged} scores changed. ${hidden} newly hidden, ${unhidden} unhidden.`);
db.close();
