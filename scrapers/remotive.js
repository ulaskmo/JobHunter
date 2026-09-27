const { ingestJob, logScrape } = require("../database");
const { fetchJSON, stripHTML } = require("./_http");

const API = "https://remotive.com/api/remote-jobs";
// Remotive's category filter narrows results and lets us fan out a bit.
const CATEGORIES = [
  "software-dev",
  "data",
  "devops",
  "qa",
  "all-others", // grab remainder in case category mis-tagging
];

async function scrapeRemotive() {
  const start = Date.now();
  let jobsFound = 0;
  let newJobs = 0;
  let errors = null;

  try {
    for (const cat of CATEGORIES) {
      let data;
      try { data = await fetchJSON(`${API}?category=${cat}`); }
      catch (e) { console.error(`[Remotive] ${cat} fetch err: ${e.message}`); continue; }
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
      console.log(`[Remotive] category ${cat}: ${jobs.length} jobs`);

      for (const j of jobs) {
        jobsFound++;
        const jobData = {
          external_id: String(j.id),
          source: "remotive",
          title: j.title || "Unknown",
          company: j.company_name || "Unknown",
          location: j.candidate_required_location || "Remote",
          salary: j.salary || null,
          description: stripHTML(j.description || "").slice(0, 2000),
          url: j.url,
          posted_date: j.publication_date || null,
          tags: (j.tags || []).join(", "),
          job_type: j.job_type || "full-time",
          experience_level: null,
          is_remote: 1,
          is_easy_apply: 0,
          score: 0,
          rating: "+",
          score_breakdown: "",
        };

        if (ingestJob(jobData)) newJobs++;
      }
    }
    console.log(`[Remotive] ${newJobs} new / ${jobsFound} seen`);
  } catch (err) {
    errors = err.message;
    console.error(`[Remotive] ${err.message}`);
  }

  logScrape.run({ source: "remotive", jobs_found: jobsFound, new_jobs: newJobs, errors, duration_ms: Date.now() - start });
  return { jobsFound, newJobs, errors };
}

module.exports = { scrapeRemotive };
