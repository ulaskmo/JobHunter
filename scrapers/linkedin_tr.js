const { db, ingestJob, logScrape } = require("../database");
const { request, decodeEntities, stripHTML, sleep } = require("./_http");
const { scoreJob } = require("../scorer");

// Turkey-wide LinkedIn search over the public (logged-out) jobs endpoint — plain
// HTTP, no browser. Most Turkish company careers pages just link to their
// LinkedIn jobs, so a country-wide search is effectively "every careers page".
// Rows share source/external_id with scrapers/linkedin.js, so no duplicates.

const KEYWORDS_TR = [
  // Turkish
  "yazılım geliştirici", "yazılım mühendisi", "yazılım uzmanı",
  "yazılım geliştirme uzmanı", "junior yazılım", "yeni mezun yazılım",
  "bilgisayar mühendisi", "programcı", "uygulama geliştirici",
  ".net geliştirici", "c# geliştirici", "backend geliştirici",
  "frontend geliştirici", "full stack geliştirici", "mobil uygulama geliştirici",
  "erp geliştirici", "erp danışmanı", "sap abap",
  // English
  "software engineer", "software developer", "junior software engineer",
  "junior developer", "graduate software engineer", "associate software engineer",
  ".NET developer", "C# developer", "backend developer", "full stack developer",
  "frontend developer", "web developer", "application developer", "programmer",
  "ERP developer", "ERP consultant", "SAP ABAP developer", "Dynamics 365 developer",
  "Python developer", "Java developer", "React developer", "Node.js developer",
];

const MAX_PAGES = 4; // 10 cards per page

const pick = (html, re) => decodeEntities((html.match(re)?.[1] || "").replace(/\s+/g, " ").trim());

// Pure: parse one page of guest-search HTML into job rows.
function parseCards(html) {
  return html.split("<li>").slice(1).map((li) => {
    const id = pick(li, /data-entity-urn="(urn:li:jobPosting:\d+)"/);
    const url = pick(li, /class="base-card__full-link[^"]*"\s+href="([^"?]+)/);
    if (!id || !url) return null;
    return {
      external_id: id,
      source: "linkedin",
      title: pick(li, /base-search-card__title">([\s\S]*?)<\/h3>/) || "Unknown",
      company: pick(li, /base-search-card__subtitle">[\s\S]*?>([\s\S]*?)<\/a>/),
      location: pick(li, /job-search-card__location">([\s\S]*?)<\/span>/),
      salary: null,
      description: "",
      url,
      posted_date: pick(li, /<time[^>]*datetime="([^"]+)"/) || null,
      tags: "",
      job_type: null,
      experience_level: null,
      is_remote: 0,
      is_easy_apply: 0,
      score: 0,
      rating: "+",
      score_breakdown: "",
    };
  }).filter(Boolean);
}

// Run keyword × location guest searches and ingest the cards.
// queries: [{ keywords, location, remote? }]
async function runGuestSearch(sourceName, queries, maxPages) {
  const start = Date.now();
  let jobsFound = 0;
  let newJobs = 0;
  const errors = [];

  outer: for (const q of queries) {
    for (let p = 0; p < maxPages; p++) {
      const params = new URLSearchParams({
        keywords: q.keywords, location: q.location, f_TPR: "r604800", start: String(p * 10),
      });
      if (q.remote) params.set("f_WT", "2");
      const res = await request(
        `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`
      ).catch((e) => ({ status: 0, body: "", err: e.message }));
      if (res.status === 429) { errors.push("429 rate limited — stopping early"); break outer; }
      if (res.status !== 200) { errors.push(`${q.keywords}@${q.location}: HTTP ${res.status} ${res.err || ""}`); break; }
      const jobs = parseCards(res.body);
      if (jobs.length === 0) break;
      jobsFound += jobs.length;
      for (const j of jobs) {
        if (q.remote) { j.is_remote = 1; j.tags = "remote"; }
        if (ingestJob(j)) newJobs++;
      }
      await sleep(1500 + Math.random() * 1500);
    }
  }

  console.log(`[${sourceName}] ${newJobs} new / ${jobsFound} seen (${errors.length} errors)`);
  logScrape.run({
    source: sourceName,
    jobs_found: jobsFound,
    new_jobs: newJobs,
    errors: errors.length ? errors.slice(0, 10).join("; ") : null,
    duration_ms: Date.now() - start,
  });
  return { jobsFound, newJobs, errors };
}

function scrapeLinkedInTR() {
  return runGuestSearch("linkedin_tr", KEYWORDS_TR.map((keywords) => ({ keywords, location: "Türkiye" })), MAX_PAGES);
}

// Wealthy markets beyond IE/TR/EU: remote roles (A tier) and on-site (B tier).
const ABROAD_LOCATIONS = [
  "Canada", "Singapore", "United Arab Emirates", "Qatar", "Saudi Arabia",
  "Australia", "New Zealand", "Switzerland", "Luxembourg",
];
const ABROAD_KEYWORDS = [
  "junior software engineer", "software developer", "graduate software engineer",
  ".NET developer", "Python developer", "AI engineer", "full stack developer",
  "cyber security analyst",
];
function scrapeLinkedInAbroad() {
  const queries = [];
  for (const location of ABROAD_LOCATIONS)
    for (const keywords of ABROAD_KEYWORDS) queries.push({ keywords, location });
  // Remote roles open worldwide / EMEA — the widest net for A tier.
  for (const location of ["Worldwide", "EMEA", "European Union"])
    for (const keywords of ABROAD_KEYWORDS) queries.push({ keywords, location, remote: true });
  return runGuestSearch("linkedin_abroad", queries, 2);
}

// Pure: pull description + seniority out of a guest jobPosting page.
function parsePosting(html) {
  const desc = stripHTML(html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/)?.[1] || "");
  const level = pick(html, /description__job-criteria-text[^>]*>([\s\S]*?)</);
  return { description: desc.slice(0, 5000), experience_level: level || null };
}

// LinkedIn cards carry no description. Fetch the real text for the best
// unenriched jobs (plain HTTP, no login) and rescore — this is what catches
// "must be a US citizen" and fills in the stack match.
async function enrichLinkedInDescriptions(limit = 120) {
  const rows = db.prepare(`
    SELECT * FROM jobs
    WHERE source = 'linkedin' AND status IN ('new', 'saved') AND filter_reason IS NULL
      AND is_expired = 0 AND length(coalesce(description, '')) < 500
    ORDER BY score DESC, scraped_at DESC LIMIT ?
  `).all(limit);
  const update = db.prepare(`
    UPDATE jobs SET description = @description, experience_level = @experience_level,
      score = @score, rating = @rating, score_breakdown = @breakdown,
      is_remote = @is_remote, filter_reason = @filter_reason
    WHERE id = @id
  `);
  let done = 0, filtered = 0;
  for (const job of rows) {
    const id = String(job.external_id).match(/\d+$/)?.[0];
    if (!id) continue;
    const res = await request(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`)
      .catch(() => ({ status: 0, body: "" }));
    if (res.status === 429) break;
    if (res.status === 404) { db.prepare("UPDATE jobs SET is_expired = 1 WHERE id = ?").run(job.id); continue; }
    if (res.status !== 200) continue;
    const { description, experience_level } = parsePosting(res.body);
    if (description.length < 100) continue;
    const s = scoreJob({ ...job, description });
    update.run({ id: job.id, description, experience_level, ...s });
    done++;
    if (s.hidden) filtered++;
    await sleep(1000 + Math.random() * 1000);
  }
  console.log(`[LinkedIn-enrich] ${done} descriptions fetched, ${filtered} newly filtered`);
  return { done, filtered };
}

module.exports = { scrapeLinkedInTR, scrapeLinkedInAbroad, enrichLinkedInDescriptions, parseCards, parsePosting, KEYWORDS_TR };

// Self-check: node scrapers/linkedin_tr.js --check
if (require.main === module && process.argv.includes("--check")) {
  const assert = require("assert");
  const html = `<ul><li>
    <div class="base-card" data-entity-urn="urn:li:jobPosting:42">
    <a class="base-card__full-link absolute" href="https://tr.linkedin.com/jobs/view/dev-42?position=1&amp;x=2">
    <h3 class="base-search-card__title">
      Junior Yaz&#305;l&#305;m Geli&#351;tirici
    </h3>
    <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="x">
      Acme A.&#350;.
    </a></h4>
    <span class="job-search-card__location"> İstanbul, Türkiye </span>
    <time class="job-search-card__listdate" datetime="2026-09-21">5 days ago</time>
  </li><li><div>no id here</div></li></ul>`;
  const [j, ...rest] = parseCards(html);
  assert.strictEqual(rest.length, 0);
  assert.strictEqual(j.external_id, "urn:li:jobPosting:42");
  assert.strictEqual(j.url, "https://tr.linkedin.com/jobs/view/dev-42");
  assert.strictEqual(j.title, "Junior Yazılım Geliştirici");
  assert.strictEqual(j.company, "Acme A.Ş.");
  assert.strictEqual(j.location, "İstanbul, Türkiye");
  assert.strictEqual(j.posted_date, "2026-09-21");
  const post = parsePosting(`<div class="show-more-less-html__markup x"><p>Build APIs in <b>C#</b></p></div>
    <span class="description__job-criteria-text description__job-criteria-text--criteria">
      Entry level </span>`);
  assert.strictEqual(post.description, "Build APIs in C#");
  assert.strictEqual(post.experience_level, "Entry level");
  console.log("linkedin_tr self-check ok");
}
