const { chromium } = require("playwright");
const { ingestJob, logScrape } = require("../database");
const { sleep, stripHTML } = require("./_http");
const path = require("path");
const fs = require("fs");

const SESSION_DIR = path.join(__dirname, "..", "session", "toptalent");
const BASE = "https://toptalent.co";

// Toptalent requires a live session cookie (ASP.NET) before /Job/SearchJob
// returns real results. So we warm up a Playwright page, then hit the API from
// the page context to inherit the cookies.
//
// Each category we iterate pulls many pages from the API. DepartmentSeo /
// CitySeo narrow results the way the category page's URL would.
const CATEGORIES = [
  { department: "yazilim", city: null },
  { department: "bilgi-teknolojileri", city: null },
  { department: null, city: "istanbul-avrupa" },
  { department: null, city: "istanbul-anadolu" },
  { department: null, city: "ankara" },
  { department: null, city: "izmir" },
  { department: null, city: "bursa" },
  { department: null, city: "kocaeli" },
  // Broad sweeps (no filter)
  { department: null, city: null },
];

const SEARCH_KEYWORDS = [
  "", "yazılım", "developer", "engineer", "junior", "yeni mezun",
  "full stack", "backend", "frontend", ".net", "react", "python", "java",
];

const MAX_PAGES_PER_QUERY = 12;
const PAGE_SIZE = 20;

async function callSearchJob(page, body) {
  return page.evaluate(async (payload) => {
    const resp = await fetch("/Job/SearchJob", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "*/*",
      },
      body: JSON.stringify(payload),
    });
    return { status: resp.status, body: await resp.text() };
  }, body);
}

function parseCardsHTML(html) {
  // Each job card is wrapped in <a class="position" href="..."> but the
  // attribute order in the server-rendered response is actually
  // <a href="..." class="position">. Match the anchor block first, then pull
  // href out of the attribute string so we don't depend on ordering.
  const out = [];
  const anchorRe = /<a\b([^>]*?\bclass="position"[^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const attrs = m[1];
    const hrefMatch = attrs.match(/href="([^"]+)"/);
    if (!hrefMatch) continue;
    const href = hrefMatch[1];
    const inner = m[2];
    const title = (inner.match(/<h5[^>]*class="card-title[^"]*"[^>]*>([\s\S]*?)<\/h5>/i) || [])[1] || "";
    const cardText = (inner.match(/<p[^>]*class="card-text"[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "";
    const loc = (cardText.match(/<span[^>]*class="text-grey-l[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || "";
    const cardPlain = stripHTML(cardText);
    const locPlain = stripHTML(loc);
    const company = cardPlain.replace(locPlain, "").trim();
    out.push({
      url: href.startsWith("http") ? href : BASE + href,
      title: stripHTML(title).slice(0, 200),
      company: company.slice(0, 120),
      location: locPlain.slice(0, 120) || "Turkey",
    });
  }
  return out;
}

async function scrapeToptalent() {
  const start = Date.now();
  let totalFound = 0;
  let totalNew = 0;
  let errors = null;

  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const seenUrls = new Set();
  let browser;
  try {
    browser = await chromium.launchPersistentContext(SESSION_DIR, {
      headless: true,
      viewport: { width: 1366, height: 768 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "tr-TR",
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });
    const page = await browser.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // Warm up session
    await page.goto(BASE + "/is-ilanlari", { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2500);

    for (const cat of CATEGORIES) {
      for (const keyword of SEARCH_KEYWORDS) {
        // Skip weird combos (no keyword + city only = covered by no-filter sweep)
        if (!cat.department && !cat.city && !keyword) continue;

        let emptyStreak = 0;
        for (let pageNum = 1; pageNum <= MAX_PAGES_PER_QUERY; pageNum++) {
          try {
            const payload = {
              pageSize: PAGE_SIZE,
              pageNumber: pageNum,
              isCardView: false,
              SearchKey: keyword,
              DepartmentIds: [],
              CityIds: [],
              PositionLevelIds: [],
              OrderBy: "newests",
              FilterTags: [null],
              DepartmentSeo: cat.department,
              CitySeo: cat.city,
            };
            const resp = await callSearchJob(page, payload);
            if (resp.status !== 200) { emptyStreak++; break; }

            const cards = parseCardsHTML(resp.body);
            if (cards.length === 0) { emptyStreak++; if (emptyStreak >= 2) break; else continue; }
            emptyStreak = 0;

            let newInThisBatch = 0;
            for (const card of cards) {
              if (!card.title || !card.url) continue;
              if (seenUrls.has(card.url)) continue;
              seenUrls.add(card.url);
              totalFound++;

              const jobData = {
                external_id: card.url,
                source: "toptalent",
                title: card.title,
                company: card.company || "Unknown",
                location: card.location,
                salary: null,
                description: `${card.title} - ${card.company} - ${card.location}`,
                url: card.url,
                posted_date: new Date().toISOString(),
                tags: [cat.department, cat.city, keyword].filter(Boolean).join(","),
                job_type: "full-time",
                experience_level: null,
                is_remote: 0,
                is_easy_apply: 0,
                score: 0,
                rating: "+",
                score_breakdown: "",
              };

              if (ingestJob(jobData)) { totalNew++; newInThisBatch++; }
            }

            // If a whole page returned but no new rows landed, we're looping
            // through duplicates — stop paginating this query.
            if (newInThisBatch === 0 && pageNum > 1) break;

            await sleep(400 + Math.random() * 600);
          } catch (e) {
            console.error(`[Toptalent] page ${pageNum} err: ${e.message}`);
            break;
          }
        }
      }
      console.log(`[Toptalent] After category ${cat.department || ""}/${cat.city || ""}: ${totalNew} new (${totalFound} seen)`);
    }
  } catch (err) {
    errors = err.message;
    console.error(`[Toptalent] Fatal: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  console.log(`[Toptalent] Done. ${totalNew} new / ${totalFound} seen.`);
  logScrape.run({
    source: "toptalent",
    jobs_found: totalFound,
    new_jobs: totalNew,
    errors,
    duration_ms: Date.now() - start,
  });
  return { jobsFound: totalFound, newJobs: totalNew, errors };
}

module.exports = { scrapeToptalent };
