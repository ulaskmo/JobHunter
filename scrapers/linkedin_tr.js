const { ingestJob, logScrape } = require("../database");
const { request, decodeEntities, sleep } = require("./_http");

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

async function scrapeLinkedInTR() {
  const start = Date.now();
  let jobsFound = 0;
  let newJobs = 0;
  const errors = [];

  outer: for (const kw of KEYWORDS_TR) {
    for (let p = 0; p < MAX_PAGES; p++) {
      const params = new URLSearchParams({
        keywords: kw, location: "Türkiye", f_TPR: "r604800", start: String(p * 10),
      });
      const res = await request(
        `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`
      ).catch((e) => ({ status: 0, body: "", err: e.message }));
      if (res.status === 429) { errors.push("429 rate limited — stopping early"); break outer; }
      if (res.status !== 200) { errors.push(`${kw}: HTTP ${res.status} ${res.err || ""}`); break; }
      const jobs = parseCards(res.body);
      if (jobs.length === 0) break;
      jobsFound += jobs.length;
      for (const j of jobs) if (ingestJob(j)) newJobs++;
      await sleep(1500 + Math.random() * 1500);
    }
  }

  console.log(`[LinkedIn-TR] ${newJobs} new / ${jobsFound} seen (${errors.length} errors)`);
  logScrape.run({
    source: "linkedin_tr",
    jobs_found: jobsFound,
    new_jobs: newJobs,
    errors: errors.length ? errors.slice(0, 10).join("; ") : null,
    duration_ms: Date.now() - start,
  });
  return { jobsFound, newJobs, errors };
}

module.exports = { scrapeLinkedInTR, parseCards, KEYWORDS_TR };

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
  console.log("linkedin_tr self-check ok");
}
