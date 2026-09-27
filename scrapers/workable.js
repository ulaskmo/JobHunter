const { ingestJob, logScrape } = require("../database");
const { fetchJSON, stripHTML, sleep } = require("./_http");
const { KEYWORDS_TR } = require("./linkedin_tr");

// Workable's cross-company search (jobs.workable.com) filtered to Turkey — covers
// every company in Turkey that hires through Workable, no per-company list needed.

const MAX_PAGES = 3;

function toJob(j) {
  const loc = j.location || {};
  return {
    external_id: j.id,
    source: "workable",
    title: j.title || "Unknown",
    company: j.company?.title || "",
    location: (j.locations && j.locations[0]) || [loc.city, loc.countryName].filter(Boolean).join(", "),
    salary: null,
    description: stripHTML(j.description || "").slice(0, 2000),
    url: j.url,
    posted_date: j.created || null,
    tags: j.department || "",
    job_type: j.employmentType || null,
    experience_level: null,
    is_remote: j.workplace === "remote" ? 1 : 0,
    is_easy_apply: 0,
    score: 0,
    rating: "+",
    score_breakdown: "",
  };
}

async function scrapeWorkable() {
  const start = Date.now();
  let jobsFound = 0;
  let newJobs = 0;
  const errors = [];

  for (const kw of KEYWORDS_TR) {
    let token = null;
    for (let p = 0; p < MAX_PAGES; p++) {
      const params = new URLSearchParams({ query: kw, location: "Turkey" });
      if (token) params.set("pageToken", token);
      try {
        const data = await fetchJSON(`https://jobs.workable.com/api/v1/jobs?${params}`);
        const jobs = (data.jobs || []).map(toJob);
        jobsFound += jobs.length;
        for (const j of jobs) if (ingestJob(j)) newJobs++;
        token = data.nextPageToken;
        if (!token || jobs.length === 0) break;
      } catch (e) {
        errors.push(`${kw}: ${e.message}`);
        break;
      }
      await sleep(400);
    }
  }

  console.log(`[Workable] ${newJobs} new / ${jobsFound} seen (${errors.length} errors)`);
  logScrape.run({
    source: "workable",
    jobs_found: jobsFound,
    new_jobs: newJobs,
    errors: errors.length ? errors.slice(0, 10).join("; ") : null,
    duration_ms: Date.now() - start,
  });
  return { jobsFound, newJobs, errors };
}

module.exports = { scrapeWorkable };
