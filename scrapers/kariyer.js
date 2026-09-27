const { logScrape } = require("../database");

// Kariyer.net is behind PerimeterX bot protection. The scraper reliably hits a
// "Access to this page has been denied" / captcha interstitial and returns 0
// results. Defeating PX requires either a residential-proxy solver or
// interactive session work; instead we cover Turkey through Toptalent,
// LinkedIn (Turkey queries), Indeed (tr.indeed.com) and the remote boards.
//
// Keeping the module so server.js can still call it, but it's a no-op.

async function scrapeKariyer() {
  console.log("[Kariyer.net] Skipped — site is PerimeterX-protected. See scrapers/kariyer.js for notes.");
  logScrape.run({
    source: "kariyer",
    jobs_found: 0,
    new_jobs: 0,
    errors: "disabled: PerimeterX bot wall",
    duration_ms: 0,
  });
  return { jobsFound: 0, newJobs: 0, errors: "disabled" };
}

module.exports = { scrapeKariyer };
