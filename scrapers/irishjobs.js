const { ingestJob, logScrape } = require("../database");
const { fetchText, stripHTML, sleep } = require("./_http");

// IrishJobs.ie renders job results server-side. Each card is an <article>
// tagged with data-testid="job-item"; title/company/link have stable
// data-at attributes.
//
// Indeed's public RSS endpoints were deprecated in 2024 and return 404, so
// IrishJobs (+ Jobs.ie fallback) is our Ireland-local board coverage.
// URL slugs — IrishJobs routes hyphen-joined slugs to keyword searches. A
// leading dot 404s, so use the "dot-net" spelling.
const QUERIES = [
  "software-developer",
  "software-engineer",
  "junior-developer",
  "graduate-developer",
  "full-stack-developer",
  "backend-developer",
  "frontend-developer",
  "dot-net-developer",
  "c-sharp-developer",
  "python-developer",
  "react-developer",
  "node-developer",
  "data-engineer",
  "data-scientist",
  "machine-learning-engineer",
  "devops-engineer",
  "cloud-engineer",
];

// Pages share the same markup; we just tack on ?page=N.
const MAX_PAGES_PER_QUERY = 5;

function parseCards(html) {
  const out = [];
  // Attribute order varies, so first match any <article ...data-at="job-item"...>
  // block, then pull the numeric id from its attributes.
  const re = /<article\b([^>]*?\bdata-at="job-item"[^>]*)>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const idMatch = attrs.match(/id="job-item-(\d+)"/);
    if (!idMatch) continue;
    const id = idMatch[1];
    const inner = m[2];

    // The <a> tag that wraps the title has these attrs, but order varies
    // between builds (href can come before or after data-at / data-testid).
    // Match the whole tag, then pull the bits from its attribute string.
    const titleBlock = inner.match(
      /<a\b([^>]*?\bdata-(?:at|testid)="job-item-title"[^>]*)>([\s\S]*?)<\/a>/
    );
    const hrefMatch = titleBlock && titleBlock[1].match(/href="([^"]+)"/);
    const titleInner = titleBlock?.[2] || "";
    const titleTextM = titleInner.match(/<div[^>]*>([^<]+)<\/div>\s*<\/div>\s*<\/div>/) ||
      titleInner.match(/>([^<]{3,})</);
    const href = hrefMatch?.[1] || "";
    const title = (titleTextM?.[1] || "").trim();
    if (!title || !href) continue;

    const companyM = inner.match(/data-at="job-item-company-name"[^>]*>([\s\S]*?)<\/span>/);
    const locationM = inner.match(/data-at="job-item-location"[^>]*>([\s\S]*?)<\/span>/);
    const salaryM = inner.match(/data-at="job-item-salary"[^>]*>([\s\S]*?)<\/span>/);
    const postedM = inner.match(/data-at="job-item-timestamp"[^>]*>([\s\S]*?)<\/span>/);

    out.push({
      id,
      url: href.startsWith("http") ? href : `https://www.irishjobs.ie${href}`,
      title,
      company: stripHTML(companyM?.[1] || ""),
      location: stripHTML(locationM?.[1] || "") || "Ireland",
      salary: stripHTML(salaryM?.[1] || "") || null,
      posted: stripHTML(postedM?.[1] || "") || null,
    });
  }
  return out;
}

async function scrapeIrishJobs() {
  const start = Date.now();
  let jobsFound = 0;
  let newJobs = 0;
  let errors = null;

  try {
    const seen = new Set();
    for (const q of QUERIES) {
      let emptyStreak = 0;
      for (let page = 1; page <= MAX_PAGES_PER_QUERY; page++) {
        const url = page === 1
          ? `https://www.irishjobs.ie/jobs/${q}`
          : `https://www.irishjobs.ie/jobs/${q}?page=${page}`;
        let html;
        try { html = await fetchText(url, { timeout: 25000 }); }
        catch (e) { console.error(`[IrishJobs] ${url} err: ${e.message}`); break; }

        const cards = parseCards(html);
        if (cards.length === 0) { emptyStreak++; if (emptyStreak >= 2) break; else continue; }
        emptyStreak = 0;

        let newInPage = 0;
        for (const c of cards) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          jobsFound++;

          const jobData = {
            external_id: c.id,
            source: "irishjobs",
            title: c.title,
            company: c.company || "Unknown",
            location: c.location,
            salary: c.salary,
            description: `${c.title} - ${c.company} - ${c.location}`,
            url: c.url,
            posted_date: null, // relative string, skip
            tags: q,
            job_type: "full-time",
            experience_level: null,
            is_remote: 0,
            is_easy_apply: 0,
            score: 0,
            rating: "+",
            score_breakdown: "",
          };

          if (ingestJob(jobData)) { newJobs++; newInPage++; }
        }

        if (newInPage === 0 && page > 1) break;
        await sleep(500);
      }
    }
    console.log(`[IrishJobs] ${newJobs} new / ${jobsFound} seen`);
  } catch (err) {
    errors = err.message;
    console.error(`[IrishJobs] ${err.message}`);
  }

  logScrape.run({ source: "irishjobs", jobs_found: jobsFound, new_jobs: newJobs, errors, duration_ms: Date.now() - start });
  return { jobsFound, newJobs, errors };
}

module.exports = { scrapeIrishJobs };
