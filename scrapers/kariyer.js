const fs = require("fs");
const path = require("path");
const { chromium } = require("patchright");
const { ingestJob, logScrape } = require("../database");
const { sleep } = require("./_http");

// Kariyer.net sits behind PerimeterX. Stock Playwright got the "Press & Hold"
// wall; Patchright in a visible (off-screen) Chrome passes (tested 2026-09-28),
// same approach as scrapers/indeed.js. The listing lives in window.__NUXT__
// (minified JS, not JSON), and Patchright evaluates in an isolated world, so a
// tiny injected <script> copies it into a DOM attribute we can read.
// Pagination is client-side (cp=2 renders empty), so: one page per keyword.
// PerimeterX blocks bursts (2nd search in quick succession got "Press & Hold"),
// so each hourly run takes a rotating batch of 5 keywords, spaced 15–25s apart
// — the full list is covered every 3 hours. PX flags the browser *profile*
// (its _px cookies), not the IP: a block wipes the profile so the next run
// starts clean (tested: flagged profile blocked, fresh one scraped 142 cards).

const PROFILE_DIR = path.join(__dirname, "..", "session", "kariyer");
const BATCH = 5;

const KEYWORDS = [
  "yazılım geliştirici", "yazılım mühendisi", "junior yazılım", "yeni mezun yazılım",
  "stajyer yazılım", "bilgisayar mühendisi", "c# developer", "backend developer",
  "frontend developer", "full stack developer", "python developer", "java developer",
  "yapay zeka", "siber güvenlik", "erp geliştirici",
];

// Pure: "Bugün", "Dün", "5 saat", "21 gün", "2 hafta", "1 ay" → ISO date.
function ageToDate(age, now = Date.now()) {
  const a = (age || "").toLocaleLowerCase("tr");
  const n = parseInt(a, 10) || 1;
  let days = null;
  if (/bugün|saat|dakika|yeni/.test(a)) days = 0;
  else if (/dün/.test(a)) days = 1;
  else if (/gün/.test(a)) days = n;
  else if (/hafta/.test(a)) days = n * 7;
  else if (/ay/.test(a)) days = n * 30;
  return days === null ? null : new Date(now - days * 86400000).toISOString().slice(0, 10);
}

// Pure: one __NUXT__ advertisement item → our job row.
function toJob(j) {
  const model = (j.workModelText || "").toLocaleLowerCase("tr");
  const remote = /uzaktan/.test(model);
  return {
    external_id: String(j.jobId),
    source: "kariyer",
    title: j.title || "Unknown",
    company: j.subTitle || "",
    location: `${j.cityName || j.location || ""}, Türkiye${remote ? " (Uzaktan)" : model ? ` (${j.workModelText})` : ""}`,
    salary: null,
    description: "",
    url: `https://www.kariyer.net${j.url}`,
    posted_date: ageToDate(j.adDate || j.time),
    tags: remote ? "remote" : "",
    job_type: j.workTypeText || null,
    experience_level: null,
    is_remote: remote ? 1 : 0,
    is_easy_apply: j.isEasyApply ? 1 : 0,
    score: 0,
    rating: "+",
    score_breakdown: "",
  };
}

async function readListing(page) {
  await page.addScriptTag({
    content: "document.documentElement.dataset.jh = JSON.stringify(((window.__NUXT__ || {}).state || {}).advertisement || null)",
  });
  return JSON.parse((await page.getAttribute("html", "data-jh")) || "null");
}

async function scrapeKariyer() {
  const start = Date.now();
  let jobsFound = 0, newJobs = 0;
  const errors = [];

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    viewport: null,
    args: ["--window-position=-2400,0"], // off-screen; headless gets blocked
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  let blocked = false;
  const batches = Math.ceil(KEYWORDS.length / BATCH);
  const b = Math.floor(Date.now() / 3600000) % batches;
  const keywords = KEYWORDS.slice(b * BATCH, b * BATCH + BATCH);

  try {
    for (const kw of keywords) {
      await page.goto(`https://www.kariyer.net/is-ilanlari?kw=${encodeURIComponent(kw)}`, { waitUntil: "domcontentloaded", timeout: 45000 })
        .catch((e) => errors.push(`${kw}: ${e.message}`));
      let ad = null;
      for (let i = 0; i < 8 && !ad; i++) {
        await sleep(2000);
        ad = await readListing(page).catch(() => null);
      }
      if (!ad) {
        const html = await page.content().catch(() => "");
        if (/Access to this page has been denied|px-captcha|Press & Hold/i.test(html)) {
          errors.push("PerimeterX block — profile reset for next run");
          blocked = true;
          break;
        }
        errors.push(`${kw}: no listing data`);
        continue;
      }
      jobsFound += ad.list.length;
      for (const j of ad.list) if (j.jobId && ingestJob(toJob(j))) newJobs++;
      await sleep(15000 + Math.random() * 10000);
    }
  } finally {
    await ctx.close().catch(() => {});
    if (blocked) fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }

  console.log(`[Kariyer.net] ${newJobs} new / ${jobsFound} seen (${errors.length} errors)`);
  logScrape.run({
    source: "kariyer",
    jobs_found: jobsFound,
    new_jobs: newJobs,
    errors: errors.length ? errors.slice(0, 10).join("; ") : null,
    duration_ms: Date.now() - start,
  });
  return { jobsFound, newJobs, errors };
}

module.exports = { scrapeKariyer, toJob, ageToDate };

// node scrapers/kariyer.js          → run a scan now
// node scrapers/kariyer.js --check  → self-check of the parsing
if (require.main === module) {
  if (process.argv.includes("--check")) {
    const assert = require("assert");
    const now = Date.parse("2026-09-28T12:00:00Z");
    assert.strictEqual(ageToDate("Bugün", now), "2026-09-28");
    assert.strictEqual(ageToDate("5 saat", now), "2026-09-28");
    assert.strictEqual(ageToDate("Dün", now), "2026-09-27");
    assert.strictEqual(ageToDate("21 gün", now), "2026-09-07");
    assert.strictEqual(ageToDate("2 hafta", now), "2026-09-14");
    assert.strictEqual(ageToDate("", now), null);
    const j = toJob({ jobId: 4549730, title: "Mobil Yazılım Geliştirici", subTitle: "Fonet", cityName: "Ankara",
      adDate: "21 gün", url: "/is-ilani/fonet-4549730", workModelText: "Uzaktan", isEasyApply: true });
    assert.strictEqual(j.url, "https://www.kariyer.net/is-ilani/fonet-4549730");
    assert.strictEqual(j.location, "Ankara, Türkiye (Uzaktan)");
    assert.strictEqual(j.is_remote, 1);
    assert.strictEqual(j.external_id, "4549730");
    console.log("kariyer self-check ok");
  } else {
    scrapeKariyer().then(() => process.exit(0));
  }
}
