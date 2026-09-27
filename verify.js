// Visits LinkedIn job URLs still marked active and flags any that show a
// closure notice. Run with: node verify.js
//
// Strategy:
//   - Pull LinkedIn rows from the DB that are `status != 'hidden'`,
//     `is_expired = 0`, and either never verified or verified > 3 days ago.
//   - Visit each URL with Playwright. If the page text contains any of the
//     known "closed" markers (EN/TR), set `is_expired = 1`.
//   - Mark `verified_at = now()` regardless so we don't revisit too soon.
//
// Rate-limited. Uses the existing LinkedIn persistent session.

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { db } = require("./database");

const SESSION_DIR = path.join(__dirname, "session", "linkedin");
const MAX_TO_CHECK = parseInt(process.env.VERIFY_LIMIT) || 100;

const CLOSED_MARKERS = [
  "no longer accepting applications",
  "this job is no longer accepting applications",
  "no longer available",
  "this job has been removed",
  "ilan artık yayında değil",
  "ilan süresi dolmuş",
  "başvurular kapandı",
];

const rows = db.prepare(`
  SELECT id, url, scraped_at FROM jobs
  WHERE source = 'linkedin'
    AND is_expired = 0
    AND status != 'hidden'
    AND (verified_at IS NULL OR julianday('now') - julianday(verified_at) > 3)
  ORDER BY scraped_at ASC
  LIMIT ?
`).all(MAX_TO_CHECK);

if (rows.length === 0) {
  console.log("No LinkedIn jobs need verification.");
  db.close();
  process.exit(0);
}

const markExpired = db.prepare(`UPDATE jobs SET is_expired = 1, verified_at = datetime('now') WHERE id = ?`);
const markVerified = db.prepare(`UPDATE jobs SET verified_at = datetime('now') WHERE id = ?`);

(async () => {
  console.log(`Verifying ${rows.length} LinkedIn jobs...`);
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const browser = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: true,
    viewport: { width: 1366, height: 768 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const page = await browser.newPage();
  let closed = 0;
  let open = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      await page.goto(row.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await new Promise((r) => setTimeout(r, 1500));

      const text = (await page.evaluate(() => document.body.innerText.toLowerCase())) || "";
      const isClosed = CLOSED_MARKERS.some((m) => text.includes(m));

      if (isClosed) {
        markExpired.run(row.id);
        closed++;
        console.log(`  CLOSED  #${row.id}`);
      } else {
        markVerified.run(row.id);
        open++;
      }
    } catch (e) {
      errors++;
      console.error(`  ERROR   #${row.id}: ${e.message}`);
    }

    // Be polite
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));
  }

  await browser.close();
  db.close();

  console.log(`Done. ${closed} closed, ${open} still open, ${errors} errors.`);
})();
