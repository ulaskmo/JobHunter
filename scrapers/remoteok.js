const https = require("https");
const { insertJob, logScrape } = require("../database");
const { scoreJob } = require("../scorer");

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "JobHunterBot/1.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function scrapeRemoteOK() {
  const start = Date.now();
  let jobsFound = 0;
  let newJobs = 0;
  let errors = null;

  try {
    console.log("[RemoteOK] Fetching jobs...");
    const data = await fetchJSON("https://remoteok.com/api");

    // First item is metadata, rest are jobs
    const jobs = data.filter((item) => item.id && item.position);
    jobsFound = jobs.length;
    console.log(`[RemoteOK] Found ${jobsFound} jobs`);

    for (const job of jobs) {
      const tags = (job.tags || []).join(", ");
      const description = (job.description || "").replace(/<[^>]*>/g, " ").substring(0, 2000);

      const jobData = {
        external_id: String(job.id),
        source: "remoteok",
        title: job.position || "Unknown",
        company: job.company || "Unknown",
        location: job.location || "Remote",
        salary: job.salary || null,
        description: description,
        url: job.url || `https://remoteok.com/remote-jobs/${job.slug || job.id}`,
        posted_date: job.date || null,
        tags: tags,
        job_type: "full-time",
        experience_level: null,
        is_remote: 1,
        is_easy_apply: 0,
        score: 0,
        rating: "+",
        score_breakdown: "",
      };

      // Score the job
      const scoring = scoreJob(jobData);
      if (scoring.hidden) continue; // Skip excluded jobs entirely
      jobData.score = scoring.score;
      jobData.rating = scoring.rating;
      jobData.score_breakdown = scoring.breakdown;
      jobData.is_remote = scoring.is_remote || 1;

      try {
        const result = insertJob.run(jobData);
        if (result.changes > 0) newJobs++;
      } catch (e) {
        // Duplicate, skip
      }
    }

    console.log(`[RemoteOK] ${newJobs} new jobs added`);
  } catch (err) {
    errors = err.message;
    console.error(`[RemoteOK] Error: ${err.message}`);
  }

  logScrape.run({
    source: "remoteok",
    jobs_found: jobsFound,
    new_jobs: newJobs,
    errors: errors,
    duration_ms: Date.now() - start,
  });

  return { jobsFound, newJobs, errors };
}

module.exports = { scrapeRemoteOK };
