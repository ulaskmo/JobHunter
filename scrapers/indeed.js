const path = require("path");
const { chromium } = require("patchright");
const { ingestJob, logScrape } = require("../database");
const { stripHTML, sleep } = require("./_http");

// Indeed sits behind Cloudflare. Plain HTTP and stock Playwright are blocked
// (it detects the CDP automation leak). Patchright — a drop-in Playwright with
// that leak patched — passes with a real visible Chrome, no human needed
// (tested 2026-09-28). Headless is still blocked, so the window is placed
// off-screen. ponytail: if Cloudflare tightens again, fall back to Jooble API.

const PROFILE_DIR = path.join(__dirname, "..", "session", "indeed");
const PAGES = 2; // ~15 cards per page

const SEARCHES = [
  ...["software developer", "junior software engineer", "graduate software engineer",
    ".net developer", "c# developer", "python developer", "full stack developer",
    "ai engineer", "cyber security analyst"]
    .map((q) => ({ domain: "ie.indeed.com", q, l: "Ireland" })),
  ...["software developer", "yazılım geliştirici", "yazılım mühendisi",
    ".net developer", "junior developer", "ai engineer"]
    .map((q) => ({ domain: "tr.indeed.com", q, l: "Türkiye" })),
  ...["software developer", "junior developer"]
    .map((q) => ({ domain: "ie.indeed.com", q, l: "Remote" })),
];

// Pure: pull the job cards Indeed embeds in the page as JSON.
function parseResults(html) {
  const m = html.match(/window\.mosaic\.providerData\["mosaic-provider-jobcards"\]\s*=\s*(\{.*?\});\s*window\.mosaic/s);
  if (!m) return null;
  try { return JSON.parse(m[1]).metaData.mosaicProviderJobCardsModel.results || []; }
  catch { return null; }
}

// Pure: Indeed's embedded mosaic job card → our job row.
function toJob(r, domain) {
  const posted = r.pubDate || r.createDate;
  return {
    external_id: r.jobkey,
    source: "indeed",
    title: r.displayTitle || r.title || "Unknown",
    company: r.company || r.truncatedCompany || "",
    location: r.formattedLocation || r.jobLocationCity || "",
    salary: r.salarySnippet?.text || null,
    description: stripHTML(r.snippet || ""),
    url: `https://${domain}/viewjob?jk=${r.jobkey}`,
    posted_date: posted ? new Date(posted).toISOString() : null,
    tags: r.remoteLocation ? "remote" : "",
    job_type: null,
    experience_level: null,
    is_remote: r.remoteLocation ? 1 : 0,
    is_easy_apply: r.indeedApplyEnabled ? 1 : 0,
    score: 0,
    rating: "+",
    score_breakdown: "",
  };
}

async function scrapeIndeed() {
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

  try {
    outer: for (const s of SEARCHES) {
      for (let p = 0; p < PAGES; p++) {
        const params = new URLSearchParams({ q: s.q, l: s.l, fromage: "7", start: String(p * 10) });
        await page.goto(`https://${s.domain}/jobs?${params}`, { waitUntil: "domcontentloaded", timeout: 45000 })
          .catch((e) => errors.push(`${s.q}@${s.domain}: ${e.message}`));
        // Cloudflare's check usually clears within a few seconds.
        let results = null;
        for (let i = 0; i < 15 && !results; i++) {
          await sleep(2000);
          results = parseResults(await page.content().catch(() => ""));
          if (!results && /no results|did not match any jobs|eşleşen iş bulunamadı/i.test(await page.content().catch(() => ""))) results = [];
        }
        if (!results) {
          const title = await page.title().catch(() => "?");
          errors.push(/sign in/i.test(title)
            ? "Indeed wants a login — run: npm run indeed-login"
            : `blocked (${title}) — stopping`);
          break outer;
        }
        if (results.length === 0) break;
        jobsFound += results.length;
        for (const r of results) if (r.jobkey && ingestJob(toJob(r, s.domain))) newJobs++;
        await sleep(3000 + Math.random() * 3000);
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  console.log(`[Indeed] ${newJobs} new / ${jobsFound} seen (${errors.length} errors)`);
  logScrape.run({
    source: "indeed",
    jobs_found: jobsFound,
    new_jobs: newJobs,
    errors: errors.length ? errors.slice(0, 10).join("; ") : null,
    duration_ms: Date.now() - start,
  });
  return { jobsFound, newJobs, errors };
}

// One-off: open the scraper's Chrome profile on-screen so the user can sign
// in to Indeed. The login cookie stays in session/indeed for every later run.
async function indeedLogin() {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, channel: "chrome", viewport: null });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://secure.indeed.com/auth?hl=en_IE&co=IE").catch(() => {});
  console.log("Sign in to Indeed in the Chrome window, then close the window.");
  await new Promise((resolve) => ctx.on("close", resolve));
}

module.exports = { scrapeIndeed, indeedLogin, toJob, parseResults };

// node scrapers/indeed.js          → run a scan now
// node scrapers/indeed.js --login  → sign in once (npm run indeed-login)
// node scrapers/indeed.js --check  → self-check of the card mapping
if (require.main === module) {
  if (process.argv.includes("--check")) {
    const assert = require("assert");
    const j = toJob({
      jobkey: "abc123", displayTitle: "Junior .NET Developer", company: "Acme",
      formattedLocation: "Dublin, County Dublin", pubDate: 1790000000000,
      snippet: "<ul><li>C# and SQL</li></ul>", remoteLocation: false, indeedApplyEnabled: true,
      salarySnippet: { text: "€40,000 a year" },
    }, "ie.indeed.com");
    assert.strictEqual(j.url, "https://ie.indeed.com/viewjob?jk=abc123");
    assert.strictEqual(j.title, "Junior .NET Developer");
    assert.strictEqual(j.description, "C# and SQL");
    assert.strictEqual(j.salary, "€40,000 a year");
    assert.strictEqual(j.is_easy_apply, 1);
    assert.ok(j.posted_date.startsWith("2026-09"));
    const html = `<script>window.mosaic.providerData["mosaic-provider-jobcards"]={"metaData":{"mosaicProviderJobCardsModel":{"results":[{"jobkey":"k1"}]}}};window.mosaic.x=1;</script>`;
    assert.deepStrictEqual(parseResults(html), [{ jobkey: "k1" }]);
    assert.strictEqual(parseResults("<html>Just a moment...</html>"), null);
    console.log("indeed self-check ok");
  } else if (process.argv.includes("--login")) {
    indeedLogin().then(() => process.exit(0));
  } else {
    scrapeIndeed().then(() => process.exit(0));
  }
}
