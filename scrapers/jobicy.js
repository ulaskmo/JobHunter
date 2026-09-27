const { ingestJob, logScrape } = require("../database");
const { fetchJSON, stripHTML, sleep } = require("./_http");

const API = "https://jobicy.com/api/v2/remote-jobs";
// Jobicy supports ?tag= and ?industry= narrowing. We fan out across a handful
// of relevant queries and dedupe on their id.
const QUERIES = [
  { industry: "dev" },
  { tag: "software" },
  { tag: "python" },
  { tag: "javascript" },
  { tag: "react" },
  { tag: "nodejs" },
  { tag: "fullstack" },
  { tag: "backend" },
  { tag: "frontend" },
  { tag: "junior" },
  { tag: "ai" },
  { tag: "ml" },
  {},
];

async function scrapeJobicy() {
  const start = Date.now();
  let jobsFound = 0;
  let newJobs = 0;
  let errors = null;

  try {
    const seen = new Set();
    for (const q of QUERIES) {
      const params = new URLSearchParams({ count: "50" });
      if (q.tag) params.set("tag", q.tag);
      if (q.industry) params.set("industry", q.industry);
      let data;
      try { data = await fetchJSON(`${API}?${params}`); }
      catch (e) { console.error(`[Jobicy] ${JSON.stringify(q)} ${e.message}`); continue; }
      const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

      for (const j of jobs) {
        const id = String(j.id);
        if (seen.has(id)) continue;
        seen.add(id);
        jobsFound++;
        const jobData = {
          external_id: id,
          source: "jobicy",
          title: j.jobTitle || j.title || "Unknown",
          company: j.companyName || "Unknown",
          location: j.jobGeo || "Remote",
          salary: j.annualSalaryMax ? `${j.annualSalaryMin || ""}-${j.annualSalaryMax} ${j.salaryCurrency || ""}` : null,
          description: stripHTML(j.jobDescription || j.description || "").slice(0, 2000),
          url: j.url,
          posted_date: j.pubDate || null,
          tags: Array.isArray(j.jobIndustry) ? j.jobIndustry.join(", ") : (j.jobIndustry || ""),
          job_type: Array.isArray(j.jobType) ? j.jobType.join(",") : (j.jobType || "full-time"),
          experience_level: j.jobLevel || null,
          is_remote: 1,
          is_easy_apply: 0,
          score: 0,
          rating: "+",
          score_breakdown: "",
        };

        if (ingestJob(jobData)) newJobs++;
      }
      await sleep(300);
    }
    console.log(`[Jobicy] ${newJobs} new / ${jobsFound} seen`);
  } catch (err) {
    errors = err.message;
    console.error(`[Jobicy] ${err.message}`);
  }

  logScrape.run({ source: "jobicy", jobs_found: jobsFound, new_jobs: newJobs, errors, duration_ms: Date.now() - start });
  return { jobsFound, newJobs, errors };
}

module.exports = { scrapeJobicy };
