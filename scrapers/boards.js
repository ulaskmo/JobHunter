const { ingestJob, logScrape } = require("../database");
const { fetchJSON, stripHTML, sleep } = require("./_http");

// Greenhouse and Lever both expose public JSON job boards per company:
//   https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
//   https://api.lever.co/v0/postings/{token}?mode=json
//
// The "token" is usually the company's slug on that ATS. This list is a
// curated starter — add more as you find them. Companies that are not on
// Greenhouse/Lever get skipped silently.

const GREENHOUSE = [
  // Ireland / Dublin offices
  "stripe", "intercom", "hubspot", "coinbase", "squareinc",
  "workhuman", "flipdish", "tines", "wayflyer",
  "soundcloud", "autodesk", "atlassian",
  // Europe / remote-friendly
  "airbnb", "snowflake", "gitlab", "cloudflare", "datadog",
  "mozilla", "elastic", "zendesk", "asana", "figma",
  "shopify", "monzo", "revolut", "wise", "bumble",
  "plaid", "mongodb", "n26", "deliveroo", "curve",
  "deepmind", "anthropic", "openai", "huggingface",
  "scaleai", "databricks", "twilio", "notion",
  // Turkey-active (verified 2026-09: Trendyol/Insider/Peak/Getir are NOT on
  // Greenhouse — "peak" and "insider" tokens belong to unrelated US companies)
  "dreamgames",
];

const LEVER = [
  // Ireland / Dublin / EU with Lever boards
  "brex", "ramp", "replicate", "mux", "mercury",
  "netlify", "discord", "supabase", "vercel",
  "runwayml", "labelbox", "pinecone", "modal",
  "linear", "census", "retool", "mistral",
  "palantir", "anysphere",
  // Turkey (verified 2026-09)
  "trendyol", "insiderone", "peakgames", "dreamgames", "iyzico", "picus",
  "commencis", "dataroid", "ciceksepeti", "getmidas",
];

// Ashby: https://api.ashbyhq.com/posting-api/job-board/{token}
const ASHBY = ["codeway"];

// SmartRecruiters: company id, filtered to Turkey postings.
const SMARTRECRUITERS = ["deliveryhero"]; // Yemeksepeti / Delivery Hero TR

function normaliseJob(raw, company, source) {
  return { ...raw, source, company };
}

async function scrapeGreenhouseCompany(token) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;
  const data = await fetchJSON(url);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map((j) => {
    const location = j.location?.name || j.offices?.map((o) => o.name).filter(Boolean).join(", ") || "";
    const description = stripHTML(j.content || "").slice(0, 2000);
    const isRemote = /\bremote\b|\banywhere\b/i.test(location + " " + j.title) ? 1 : 0;
    return {
      external_id: String(j.id),
      source: "greenhouse",
      title: j.title || "Unknown",
      company: token,
      location,
      salary: null,
      description,
      url: j.absolute_url,
      posted_date: j.updated_at || j.first_published || null,
      tags: (j.departments || []).map((d) => d.name).join(", "),
      job_type: "full-time",
      experience_level: null,
      is_remote: isRemote,
      is_easy_apply: 0,
      score: 0,
      rating: "+",
      score_breakdown: "",
    };
  });
}

async function scrapeLeverCompany(token) {
  const url = `https://api.lever.co/v0/postings/${token}?mode=json`;
  const jobs = await fetchJSON(url);
  if (!Array.isArray(jobs)) return [];
  return jobs.map((j) => {
    const location =
      j.categories?.location ||
      j.categories?.allLocations?.join(", ") ||
      "";
    const description = stripHTML(j.descriptionPlain || j.description || "").slice(0, 2000);
    const isRemote = /\bremote\b|\banywhere\b/i.test(location + " " + (j.text || "") + " " + description) ? 1 : 0;
    return {
      external_id: j.id,
      source: "lever",
      title: j.text || "Unknown",
      company: token,
      location,
      salary: null,
      description,
      url: j.hostedUrl || j.applyUrl,
      posted_date: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      tags: [j.categories?.team, j.categories?.department].filter(Boolean).join(", "),
      job_type: j.categories?.commitment || "full-time",
      experience_level: null,
      is_remote: isRemote,
      is_easy_apply: 0,
      score: 0,
      rating: "+",
      score_breakdown: "",
    };
  });
}

async function scrapeAshbyCompany(token) {
  const data = await fetchJSON(`https://api.ashbyhq.com/posting-api/job-board/${token}`);
  return (data?.jobs || []).map((j) => ({
    external_id: j.id,
    source: "ashby",
    title: j.title || "Unknown",
    company: token,
    location: j.location || "",
    salary: null,
    description: (j.descriptionPlain || "").slice(0, 2000),
    url: j.jobUrl,
    posted_date: j.publishedAt || null,
    tags: j.department || "",
    job_type: j.employmentType || "full-time",
    experience_level: null,
    is_remote: j.isRemote ? 1 : 0,
    is_easy_apply: 0,
    score: 0,
    rating: "+",
    score_breakdown: "",
  }));
}

async function scrapeSmartRecruitersCompany(company) {
  const data = await fetchJSON(`https://api.smartrecruiters.com/v1/companies/${company}/postings?country=tr&limit=100`);
  return (data?.content || []).map((j) => ({
    external_id: j.id,
    source: "smartrecruiters",
    title: j.name || "Unknown",
    company: j.company?.name || company,
    location: [j.location?.city, "Türkiye"].filter(Boolean).join(", "),
    salary: null,
    description: "",
    url: `https://jobs.smartrecruiters.com/${company}/${j.id}`,
    posted_date: j.releasedDate || null,
    tags: j.department?.label || "",
    job_type: j.typeOfEmployment?.label || "full-time",
    experience_level: j.experienceLevel?.label || null,
    is_remote: j.location?.remote ? 1 : 0,
    is_easy_apply: 0,
    score: 0,
    rating: "+",
    score_breakdown: "",
  }));
}

const ingest = ingestJob;

async function scrapeBoards() {
  const start = Date.now();
  let jobsFound = 0;
  let newJobs = 0;
  let errors = [];

  // Greenhouse
  for (const token of GREENHOUSE) {
    try {
      const jobs = await scrapeGreenhouseCompany(token);
      jobsFound += jobs.length;
      for (const j of jobs) {
        if (await ingest(j)) newJobs++;
      }
      await sleep(200);
    } catch (e) {
      errors.push(`gh:${token}:${e.message}`);
    }
  }
  console.log(`[Boards] Greenhouse done — ${newJobs} new so far`);

  // Lever
  for (const token of LEVER) {
    try {
      const jobs = await scrapeLeverCompany(token);
      jobsFound += jobs.length;
      for (const j of jobs) {
        if (await ingest(j)) newJobs++;
      }
      await sleep(200);
    } catch (e) {
      errors.push(`lv:${token}:${e.message}`);
    }
  }

  for (const [prefix, list, fn] of [
    ["ab", ASHBY, scrapeAshbyCompany],
    ["sr", SMARTRECRUITERS, scrapeSmartRecruitersCompany],
  ]) {
    for (const token of list) {
      try {
        const jobs = await fn(token);
        jobsFound += jobs.length;
        for (const j of jobs) if (await ingest(j)) newJobs++;
      } catch (e) {
        errors.push(`${prefix}:${token}:${e.message}`);
      }
    }
  }

  console.log(`[Boards] ${newJobs} new / ${jobsFound} seen (${errors.length} company errors)`);

  logScrape.run({
    source: "boards",
    jobs_found: jobsFound,
    new_jobs: newJobs,
    errors: errors.length ? errors.slice(0, 10).join("; ") : null,
    duration_ms: Date.now() - start,
  });
  return { jobsFound, newJobs, errors: errors.length };
}

module.exports = { scrapeBoards };
