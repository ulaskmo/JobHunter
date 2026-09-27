const { insertJob, logScrape } = require("../database");
const { scoreJob } = require("../scorer");
const { fetchJSON, stripHTML, sleep } = require("./_http");

// Each month there's a "Ask HN: Who is hiring?" thread. We find the latest few
// via Algolia, then pull their children via the Hacker News firebase API.
// Each child comment is one job posting — we treat the first line as the
// title/company blurb.
const ALGOLIA = "https://hn.algolia.com/api/v1";
const HN_ITEM = "https://hacker-news.firebaseio.com/v0/item";

async function findHiringThreads(limit = 3) {
  // `whoishiring` is the dedicated HN account that posts the monthly
  // "Who is hiring?" and "Who wants to be hired?" stories; search_by_date
  // scoped to that author returns the monthly threads in reverse-chron order.
  const url = `${ALGOLIA}/search_by_date?tags=story,author_whoishiring&hitsPerPage=20`;
  const data = await fetchJSON(url);
  const hits = (data.hits || [])
    .filter((h) => /who is hiring\?/i.test(h.title || ""))
    .sort((a, b) => (b.created_at_i || 0) - (a.created_at_i || 0));
  return hits.slice(0, limit);
}

// Very loose parse: first non-empty line = title/company line.
// Heuristic: "Company (Location) | tags | URL" or "Company | Location | Title".
function parseComment(textHTML) {
  const text = stripHTML(textHTML);
  const firstLine = text.split("\n")[0].split(". ")[0].trim();
  // Try to split on "|" or " - "
  const parts = firstLine.split(/\s*[|•–—]\s*|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  let company = parts[0] || "Unknown";
  let title = parts.slice(1).join(" | ").trim() || firstLine;
  // Strip "(REMOTE)" style from company
  company = company.replace(/\s*\(.*?\)\s*$/, "").trim().slice(0, 120);
  return { company, title: title.slice(0, 200), firstLine };
}

async function scrapeHNHiring() {
  const start = Date.now();
  let jobsFound = 0;
  let newJobs = 0;
  let errors = null;

  try {
    const threads = await findHiringThreads(3);
    console.log(`[HNHiring] Found ${threads.length} threads`);

    for (const t of threads) {
      const story = await fetchJSON(`${HN_ITEM}/${t.objectID}.json`);
      const kids = (story?.kids || []).slice(0, 400); // cap
      console.log(`[HNHiring] thread ${t.objectID} has ${kids.length} top-level replies`);

      // Fetch in parallel chunks
      const CHUNK = 20;
      for (let i = 0; i < kids.length; i += CHUNK) {
        const batch = kids.slice(i, i + CHUNK);
        const results = await Promise.all(
          batch.map((id) => fetchJSON(`${HN_ITEM}/${id}.json`).catch(() => null))
        );
        for (const item of results) {
          if (!item || item.deleted || item.dead || !item.text) continue;
          jobsFound++;
          const { company, title, firstLine } = parseComment(item.text);
          const description = stripHTML(item.text).slice(0, 2000);

          // Detect location and remote flag heuristically — Hacker News posts
          // have no structured location field.
          const hay = description.toLowerCase();
          const isRemote = /\bremote\b|\bwork from anywhere\b|\bwfh\b/i.test(hay) ? 1 : 0;
          const loc =
            (hay.match(/\b([A-Za-z]+(?:\s+[A-Za-z]+)?),\s+(?:CA|NY|TX|UK|IE|USA|Ireland|Turkey|Germany|Netherlands|Spain|France|Europe)\b/) || [])[0] ||
            (hay.includes("ireland") ? "Ireland" : null) ||
            (hay.includes("dublin") ? "Dublin, Ireland" : null) ||
            (hay.includes("istanbul") || hay.includes("turkey") ? "Turkey" : null) ||
            (isRemote ? "Remote" : "");

          const url = `https://news.ycombinator.com/item?id=${item.id}`;
          const jobData = {
            external_id: String(item.id),
            source: "hnhiring",
            title,
            company,
            location: loc,
            salary: null,
            description: `${firstLine}\n\n${description}`.slice(0, 2000),
            url,
            posted_date: item.time ? new Date(item.time * 1000).toISOString() : null,
            tags: `hn-${t.objectID}`,
            job_type: "full-time",
            experience_level: null,
            is_remote: isRemote,
            is_easy_apply: 0,
            score: 0,
            rating: "+",
            score_breakdown: "",
          };

          const scoring = scoreJob(jobData);
          if (scoring.hidden) continue;
          jobData.score = scoring.score;
          jobData.rating = scoring.rating;
          jobData.score_breakdown = scoring.breakdown;
          if (scoring.is_remote) jobData.is_remote = 1;

          try {
            const r = insertJob.run(jobData);
            if (r.changes > 0) newJobs++;
          } catch (e) { /* dup */ }
        }
        await sleep(200);
      }
    }

    console.log(`[HNHiring] ${newJobs} new / ${jobsFound} seen`);
  } catch (err) {
    errors = err.message;
    console.error(`[HNHiring] ${err.message}`);
  }

  logScrape.run({ source: "hnhiring", jobs_found: jobsFound, new_jobs: newJobs, errors, duration_ms: Date.now() - start });
  return { jobsFound, newJobs, errors };
}

module.exports = { scrapeHNHiring };
