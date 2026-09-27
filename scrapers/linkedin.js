const { chromium } = require("playwright");
const { ingestJob, updateJobScore, logScrape, db } = require("../database");
const { scoreJob } = require("../scorer");
const path = require("path");
const fs = require("fs");

const SESSION_DIR = path.join(__dirname, "..", "session", "linkedin");

// How many freshly-inserted LinkedIn jobs to enrich with a full description per
// run. Each enrichment is one detail-page fetch — LinkedIn throttles hard, so
// keep this modest.
const MAX_DESCRIPTION_FETCHES = 60;

// Search queries to cover wide net
const SEARCH_QUERIES = [
  // Remote software engineering
  // ─── Remote (worldwide) ────────────────────────────────────────────────────
  { keywords: "junior software engineer", location: "Remote", remote: true },
  { keywords: "junior software developer", location: "Remote", remote: true },
  { keywords: "software developer", location: "Remote", remote: true },
  { keywords: "full stack developer", location: "Remote", remote: true },
  { keywords: "backend developer", location: "Remote", remote: true },
  { keywords: "frontend developer", location: "Remote", remote: true },
  { keywords: "junior developer", location: "Remote", remote: true },
  { keywords: "graduate software engineer", location: "Remote", remote: true },
  { keywords: ".NET developer", location: "Remote", remote: true },
  { keywords: "Node.js developer", location: "Remote", remote: true },
  { keywords: "React developer", location: "Remote", remote: true },
  { keywords: "Python developer", location: "Remote", remote: true },
  // AI/ML Remote
  { keywords: "machine learning engineer", location: "Remote", remote: true },
  { keywords: "AI engineer", location: "Remote", remote: true },
  { keywords: "data scientist", location: "Remote", remote: true },
  { keywords: "junior data engineer", location: "Remote", remote: true },

  // ─── Turkey/Istanbul (EXPANDED) ──────────────────────────────────────────
  { keywords: "software engineer", location: "Istanbul, Turkey" },
  { keywords: "software developer", location: "Istanbul, Turkey" },
  { keywords: "junior software engineer", location: "Istanbul, Turkey" },
  { keywords: "junior developer", location: "Istanbul, Turkey" },
  { keywords: "full stack developer", location: "Istanbul, Turkey" },
  { keywords: "backend developer", location: "Istanbul, Turkey" },
  { keywords: "frontend developer", location: "Istanbul, Turkey" },
  { keywords: ".NET developer", location: "Istanbul, Turkey" },
  { keywords: "Python developer", location: "Istanbul, Turkey" },
  { keywords: "React developer", location: "Istanbul, Turkey" },
  { keywords: "Node.js developer", location: "Istanbul, Turkey" },
  { keywords: "Java developer", location: "Istanbul, Turkey" },
  { keywords: "C# developer", location: "Istanbul, Turkey" },
  { keywords: "machine learning engineer", location: "Istanbul, Turkey" },
  { keywords: "data scientist", location: "Istanbul, Turkey" },
  { keywords: "devops engineer", location: "Istanbul, Turkey" },
  { keywords: "cloud engineer", location: "Istanbul, Turkey" },
  // Turkish language searches
  { keywords: "yazılım mühendisi", location: "İstanbul" },
  { keywords: "yazılım geliştirici", location: "İstanbul" },
  { keywords: "junior yazılım", location: "İstanbul" },
  { keywords: "full stack geliştirici", location: "İstanbul" },
  { keywords: "backend geliştirici", location: "İstanbul" },
  { keywords: "frontend geliştirici", location: "İstanbul" },
  // Turkey wider (Ankara, Izmir, Bursa, Antalya, Kocaeli, remote Turkey)
  { keywords: "software engineer", location: "Turkey" },
  { keywords: "software developer", location: "Turkey" },
  { keywords: "yazılım mühendisi", location: "Türkiye" },
  { keywords: "yazılım geliştirici", location: "Türkiye" },
  { keywords: "software engineer", location: "Turkey", remote: true },
  { keywords: "junior developer", location: "Turkey", remote: true },
  { keywords: "yazılım", location: "Türkiye", remote: true },
  { keywords: "junior developer", location: "Ankara, Turkey" },
  { keywords: "software engineer", location: "Ankara, Turkey" },
  { keywords: "yazılım mühendisi", location: "Ankara" },
  { keywords: "software engineer", location: "İzmir, Turkey" },
  { keywords: "yazılım geliştirici", location: "İzmir" },
  { keywords: "software engineer", location: "Bursa, Turkey" },
  { keywords: "software engineer", location: "Antalya, Turkey" },
  { keywords: "software engineer", location: "Kocaeli, Turkey" },
  { keywords: "software engineer", location: "Gebze, Turkey" },
  { keywords: ".net geliştirici", location: "İstanbul" },
  { keywords: "react geliştirici", location: "İstanbul" },
  { keywords: "mobil geliştirici", location: "İstanbul" },
  { keywords: "veri bilimci", location: "Türkiye" },
  { keywords: "yapay zeka mühendisi", location: "Türkiye" },

  // ─── Ireland ──────────────────────────────────────────────────────────────
  { keywords: "software engineer", location: "Ireland" },
  { keywords: "software developer", location: "Ireland" },
  { keywords: "junior developer", location: "Ireland" },
  { keywords: "junior software engineer", location: "Ireland" },
  { keywords: "graduate software engineer", location: "Ireland" },
  { keywords: "full stack developer", location: "Ireland" },
  { keywords: ".NET developer", location: "Ireland" },
  { keywords: "C# developer", location: "Ireland" },
  { keywords: "Python developer", location: "Ireland" },
  { keywords: "React developer", location: "Ireland" },
  { keywords: "software developer", location: "Dublin, Ireland" },
  { keywords: "machine learning", location: "Ireland" },

  // ─── UK ───────────────────────────────────────────────────────────────────
  { keywords: "junior software engineer", location: "United Kingdom", remote: true },
  { keywords: "software developer remote", location: "United Kingdom", remote: true },
  { keywords: "graduate developer", location: "United Kingdom", remote: true },

  // ─── Europe ───────────────────────────────────────────────────────────────
  { keywords: "junior software engineer remote", location: "Europe", remote: true },
  { keywords: "software developer remote", location: "Germany", remote: true },
  { keywords: "software developer remote", location: "Netherlands", remote: true },

  // ─── USA Remote ───────────────────────────────────────────────────────────
  { keywords: "junior software engineer remote", location: "United States", remote: true },
  { keywords: "software developer remote", location: "United States", remote: true },
  { keywords: "entry level software engineer", location: "United States", remote: true },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}

async function scrapeLinkedIn() {
  const start = Date.now();
  let totalFound = 0;
  let totalNew = 0;
  let errors = null;

  fs.mkdirSync(SESSION_DIR, { recursive: true });

  let browser;
  try {
    browser = await chromium.launchPersistentContext(SESSION_DIR, {
      headless: true,
      viewport: { width: 1366, height: 768 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "en-GB",
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });

    const page = await browser.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // LinkedIn public job search (no login needed for browsing)
    // We use the public jobs search URL which doesn't require authentication
    for (const query of SEARCH_QUERIES) {
      try {
        console.log(`[LinkedIn] Searching: "${query.keywords}" in ${query.location}`);

        const params = new URLSearchParams({
          keywords: query.keywords,
          location: query.location,
          f_TPR: "r2592000", // Past month (filtering done in dashboard)
          position: "1",
          pageNum: "0",
        });
        if (query.remote) {
          params.set("f_WT", "2"); // Remote filter
        }

        const searchUrl = `https://www.linkedin.com/jobs/search/?${params.toString()}`;
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(randomDelay(2000, 4000));

        // Scroll to load more results
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollBy(0, 800));
          await sleep(randomDelay(1000, 2000));
        }

        // Extract job cards from public LinkedIn search
        const jobCards = await page.$$eval(
          ".base-card, .job-search-card, .base-search-card, [data-entity-urn]",
          (cards) =>
            cards.map((card) => {
              const titleEl = card.querySelector(".base-search-card__title, h3, .job-search-card__title");
              const companyEl = card.querySelector(".base-search-card__subtitle, h4, .job-search-card__subtitle");
              const locationEl = card.querySelector(".job-search-card__location, .base-search-card__metadata");
              const linkEl = card.querySelector("a");
              const timeEl = card.querySelector("time");

              return {
                title: titleEl?.textContent?.trim() || "",
                company: companyEl?.textContent?.trim() || "",
                // The metadata node also holds "1 week ago" etc. on later lines.
                location: (locationEl?.textContent || "").trim().split("\n")[0].trim(),
                url: linkEl?.href || "",
                posted_date: timeEl?.getAttribute("datetime") || "",
                external_id: card.getAttribute("data-entity-urn") || linkEl?.href || "",
              };
            })
        );

        console.log(`[LinkedIn] Found ${jobCards.length} cards for "${query.keywords}"`);
        totalFound += jobCards.length;

        for (const card of jobCards) {
          if (!card.title || !card.url) continue;

          // Clean up the URL
          let jobUrl = card.url;
          if (jobUrl.includes("?")) jobUrl = jobUrl.split("?")[0];

          const jobData = {
            external_id: card.external_id || jobUrl,
            source: "linkedin",
            title: card.title,
            company: card.company,
            location: card.location,
            salary: null,
            description: `${card.title} at ${card.company} - ${card.location}`,
            url: jobUrl,
            posted_date: card.posted_date || null,
            tags: query.remote ? `${query.keywords} remote` : query.keywords,
            job_type: "full-time",
            experience_level: null,
            is_remote: query.remote ? 1 : 0,
            is_easy_apply: 0,
            score: 0,
            rating: "+",
            score_breakdown: "",
          };

          if (ingestJob(jobData)) totalNew++;
        }

        // Be polite between searches
        await sleep(randomDelay(5000, 10000));
      } catch (searchErr) {
        console.error(`[LinkedIn] Search error for "${query.keywords}": ${searchErr.message}`);
      }
    }
    // ─── Pass 2: enrich top new jobs with full descriptions ──────────────────
    try {
      const candidates = db.prepare(`
        SELECT id, url, title, company, location, tags, is_easy_apply, is_remote, description
        FROM jobs
        WHERE source = 'linkedin'
          AND scraped_at > datetime('now', '-2 hours')
          AND (description IS NULL OR length(description) < 200)
          AND is_expired = 0
          AND status = 'new'
        ORDER BY score DESC, scraped_at DESC
        LIMIT ?
      `).all(MAX_DESCRIPTION_FETCHES);

      if (candidates.length > 0) {
        console.log(`[LinkedIn] Enriching ${candidates.length} job detail pages...`);
        const updateDesc = db.prepare(`UPDATE jobs SET description = @description WHERE id = @id`);

        for (const job of candidates) {
          try {
            await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 20000 });
            await sleep(randomDelay(1500, 3000));

            const details = await page.evaluate(() => {
              const selectors = [
                ".show-more-less-html__markup",
                ".description__text",
                "[class*='jobs-description']",
                "[class*='jobs_description']",
                ".jobs-box__html-content",
                "section.description",
              ];
              for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText && el.innerText.length > 100) {
                  return el.innerText;
                }
              }
              // Fallback: grab the whole main content
              const main = document.querySelector("main") || document.body;
              return (main && main.innerText) ? main.innerText.slice(0, 5000) : "";
            });

            if (details && details.length > 200) {
              const description = details.replace(/\s+/g, " ").trim().slice(0, 5000);
              updateDesc.run({ id: job.id, description });
              // Rescore with the richer description — can bump or demote the job
              const rescored = scoreJob({ ...job, source: "linkedin", description });
              if (rescored.hidden) {
                // e.g. the full text reveals "must be a US citizen"
                db.prepare("UPDATE jobs SET filter_reason = ? WHERE id = ?").run(rescored.filter_reason, job.id);
              } else {
                updateJobScore.run({ id: job.id, score: rescored.score, score_breakdown: rescored.breakdown });
                db.prepare("UPDATE jobs SET rating = ? WHERE id = ?").run(rescored.rating, job.id);
              }
            }
          } catch (e) { /* per-job failure is fine */ }
        }
      }
    } catch (e) {
      console.error(`[LinkedIn] description-enrichment pass failed: ${e.message}`);
    }
  } catch (err) {
    errors = err.message;
    console.error(`[LinkedIn] Fatal error: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  console.log(`[LinkedIn] Done. ${totalNew} new jobs from ${totalFound} total.`);

  logScrape.run({
    source: "linkedin",
    jobs_found: totalFound,
    new_jobs: totalNew,
    errors: errors,
    duration_ms: Date.now() - start,
  });

  return { jobsFound: totalFound, newJobs: totalNew, errors };
}

module.exports = { scrapeLinkedIn };
