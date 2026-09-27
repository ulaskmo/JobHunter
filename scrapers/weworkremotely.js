const { insertJob, logScrape } = require("../database");
const { scoreJob } = require("../scorer");
const { fetchText, stripHTML, decodeEntities, sleep } = require("./_http");

// WeWorkRemotely publishes per-category RSS feeds. These cover software
// development, devops, and full-stack roles.
const FEEDS = [
  "https://weworkremotely.com/categories/remote-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",
];

function parseItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const pick = (tag) => {
      // Support CDATA
      const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, "i");
      const mm = block.match(re);
      return decodeEntities((mm && (mm[1] ?? mm[2])) || "").trim();
    };
    items.push({
      title: pick("title"),
      link: pick("link"),
      description: pick("description"),
      pubDate: pick("pubDate"),
      guid: pick("guid"),
      region: pick("region"),
    });
  }
  return items;
}

// WWR titles look like "Company: Position". Split on the first colon.
function splitCompanyTitle(raw) {
  const idx = raw.indexOf(":");
  if (idx < 0) return { company: "", title: raw };
  return { company: raw.slice(0, idx).trim(), title: raw.slice(idx + 1).trim() };
}

async function scrapeWWR() {
  const start = Date.now();
  let jobsFound = 0;
  let newJobs = 0;
  let errors = null;

  try {
    const seen = new Set();
    for (const url of FEEDS) {
      let xml;
      try { xml = await fetchText(url); }
      catch (e) { console.error(`[WWR] ${url} err: ${e.message}`); continue; }
      const items = parseItems(xml);

      for (const it of items) {
        if (!it.link || seen.has(it.link)) continue;
        seen.add(it.link);
        jobsFound++;
        const { company, title } = splitCompanyTitle(it.title || "");

        const jobData = {
          external_id: it.guid || it.link,
          source: "weworkremotely",
          title: title || it.title || "Unknown",
          company: company || "Unknown",
          location: it.region || "Remote",
          salary: null,
          description: stripHTML(it.description).slice(0, 2000),
          url: it.link,
          posted_date: it.pubDate ? new Date(it.pubDate).toISOString() : null,
          tags: "",
          job_type: "full-time",
          experience_level: null,
          is_remote: 1,
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

        try {
          const r = insertJob.run(jobData);
          if (r.changes > 0) newJobs++;
        } catch (e) { /* dup */ }
      }
      await sleep(500);
    }
    console.log(`[WWR] ${newJobs} new / ${jobsFound} seen`);
  } catch (err) {
    errors = err.message;
    console.error(`[WWR] ${err.message}`);
  }

  logScrape.run({ source: "weworkremotely", jobs_found: jobsFound, new_jobs: newJobs, errors, duration_ms: Date.now() - start });
  return { jobsFound, newJobs, errors };
}

module.exports = { scrapeWWR };
