const { ingestJob, logScrape } = require("../database");
const { fetchJSON, stripHTML, sleep } = require("./_http");

const API = "https://www.arbeitnow.com/api/job-board-api";
const MAX_PAGES = 10;

async function scrapeArbeitnow() {
  const start = Date.now();
  let jobsFound = 0;
  let newJobs = 0;
  let errors = null;

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await fetchJSON(`${API}?page=${page}`);
      const items = Array.isArray(data?.data) ? data.data : [];
      if (items.length === 0) break;

      let newInPage = 0;
      for (const j of items) {
        jobsFound++;
        const tags = (j.tags || []).concat(j.job_types || []).join(", ");
        const jobData = {
          external_id: j.slug || j.url,
          source: "arbeitnow",
          title: j.title || "Unknown",
          company: j.company_name || "Unknown",
          location: j.location || (j.remote ? "Remote" : "Europe"),
          salary: null,
          description: stripHTML(j.description || "").slice(0, 2000),
          url: j.url || `https://www.arbeitnow.com/jobs/companies/${j.slug}`,
          posted_date: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
          tags,
          job_type: (j.job_types || []).join(",") || "full-time",
          experience_level: null,
          is_remote: j.remote ? 1 : 0,
          is_easy_apply: 0,
          score: 0,
          rating: "+",
          score_breakdown: "",
        };

        if (ingestJob(jobData)) { newJobs++; newInPage++; }
      }

      // Stop when the page brought nothing new — we've hit the old part of the feed.
      if (newInPage === 0 && page > 1) break;
      await sleep(300);
    }
    console.log(`[Arbeitnow] ${newJobs} new / ${jobsFound} seen`);
  } catch (err) {
    errors = err.message;
    console.error(`[Arbeitnow] ${err.message}`);
  }

  logScrape.run({ source: "arbeitnow", jobs_found: jobsFound, new_jobs: newJobs, errors, duration_ms: Date.now() - start });
  return { jobsFound, newJobs, errors };
}

module.exports = { scrapeArbeitnow };
