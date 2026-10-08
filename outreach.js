// Cold outreach: email Turkish tech companies asking about junior full-stack roles.
//
// Pipeline (one row per company in `outreach`):
//   pending  → found in jobs.db, website not looked up yet
//   no_site  → couldn't find / verify a website
//   no_email → website found but no generic address (careers_url may be set — apply by hand)
//   draft    → email found, draft written, waiting for your review
//   approved → you approved it; the sender sends these on weekdays, DAILY_CAP per day
//   sent / replied / bounced / failed / skipped
const path = require("path");
const fs = require("fs");
const express = require("express");
const { db } = require("./database");
const { request, stripHTML, decodeEntities, sleep } = require("./scrapers/_http");
require("dotenv").config();

const DAILY_CAP = parseInt(process.env.OUTREACH_DAILY_CAP) || 15;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const configured = () => Boolean(GMAIL_USER && GMAIL_PASS);
// Your details live in .env so they never land in the (public) repo.
const NAME = process.env.OUTREACH_NAME || "";
const NAME_EN = NAME.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i").replace(/İ/g, "I");
const PHONE = process.env.OUTREACH_PHONE || "";
const LINKEDIN = process.env.OUTREACH_LINKEDIN || "";

// Both go on every email — the recipient opens whichever they prefer.
const CVS = ["TR", "EN"].map((l) => ({
  filename: `${NAME_EN.replace(/\s+/g, "_") || "CV"}_CV_${l}.pdf`,
  path: path.join(__dirname, `cv-${l.toLowerCase()}.pdf`),
}));

db.exec(`
  CREATE TABLE IF NOT EXISTS outreach (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL UNIQUE,
    city TEXT,
    city_rank INTEGER DEFAULT 9,
    job_title TEXT,
    domain TEXT,
    website TEXT,
    about TEXT,
    email TEXT,
    careers_url TEXT,
    status TEXT DEFAULT 'pending',
    subject TEXT,
    body TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    checked_at TEXT,
    sent_at TEXT,
    replied_at TEXT,
    reply_subject TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach(status, city_rank);
`);
for (const col of [
  "ALTER TABLE outreach ADD COLUMN lang TEXT DEFAULT 'tr'",
  "ALTER TABLE outreach ADD COLUMN emails_found TEXT", // every usable address on the site, best first
  "ALTER TABLE outreach ADD COLUMN contact_count INTEGER DEFAULT 0",
  "ALTER TABLE outreach ADD COLUMN kind TEXT DEFAULT 'first'", // what the next send is: first | followup | redirect
  "ALTER TABLE outreach ADD COLUMN referred_by TEXT",
  "ALTER TABLE outreach ADD COLUMN reply_text TEXT",
  "ALTER TABLE outreach ADD COLUMN reply_class TEXT",   // interested | later | no | unknown
  "ALTER TABLE outreach ADD COLUMN opener TEXT",        // unused (AI first lines were removed)
  "ALTER TABLE outreach ADD COLUMN email_source TEXT",  // page the address was found on
  "ALTER TABLE outreach ADD COLUMN source TEXT DEFAULT 'jobs'", // jobs | yc | collectivespark
]) {
  try { db.exec(col); } catch (e) { /* column already exists */ }
}

// One row per email actually sent — the row in `outreach` only holds the latest state.
db.exec(`
  CREATE TABLE IF NOT EXISTS outreach_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outreach_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    kind TEXT,
    message_id TEXT,
    sent_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sends_email ON outreach_sends(email, sent_at);
  -- Inbox messages already handled, so a reply is processed once.
  CREATE TABLE IF NOT EXISTS outreach_seen (message_id TEXT PRIMARY KEY);
`);

const BUMP_DAYS = 7;         // one short nudge in the same thread if the first email gets no reply
const RECONTACT_DAYS = 60;   // unanswered (or "not right now") companies come back to Review after this
const MAX_CONTACTS = 4;      // first email, 1-week reminder, two 60-day follow-ups — then leave them alone
const FREEMAIL = /^(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|yandex|protonmail|msn)\./;

// ─── Seeding from jobs.db ─────────────────────────────────────────────────────
const CITIES = [
  ["İstanbul", 1, /istanbul|i̇stanbul/],
  ["Ankara", 2, /ankara/],
  ["İzmir", 3, /izmir|i̇zmir/],
  ["Antalya", 4, /antalya/],
  ["Samsun", 5, /samsun/],
  ["Bursa", 6, /bursa/],
  ["Kocaeli", 6, /kocaeli|gebze/],
  ["Eskişehir", 6, /eskişehir|eskisehir/],
  ["Konya", 6, /konya/],
  ["Adana", 6, /adana/],
  ["Türkiye", 8, /turkey|türkiye|turkiye/],
];

function cityOf(location) {
  const l = (location || "").toLowerCase();
  for (const [name, rank, re] of CITIES) if (re.test(l)) return { city: name, city_rank: rank };
  return null;
}

// Companies of every size are fine; recruitment agencies just forward you to
// their listings, and "Gizli" (confidential) posts have no real company.
// Tested against trLower(name), so no Turkish accents here.
const AGENCY = /(?<![\p{L}\p{N}])(recruit|recruitment|staffing|headhunt|insan kaynaklari|kariyer|manpower|adecco|randstad|kelly services|hays|michael page|robert half|gizli)(?![\p{L}\p{N}])/iu;

const insertCompany = db.prepare(`INSERT OR IGNORE INTO outreach (company, city, city_rank, job_title, status, error, domain, source)
  VALUES (@company, @city, @city_rank, @job_title, @status, @error, @domain, @source)`);

// Every Turkish company that posted a dev job becomes a candidate. Companies
// you've already applied to are recorded as skipped so they're never emailed.
function seedFromJobs() {
  const rows = db.prepare(`
    SELECT company, location, title, status FROM jobs
    WHERE company IS NOT NULL AND TRIM(company) != ''
    ORDER BY scraped_at DESC
  `).all();
  const contacted = new Set(rows.filter((r) => ["applied", "interview", "rejected"].includes(r.status)).map((r) => r.company));
  let added = 0;
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.company)) continue;
    const c = cityOf(r.location);
    if (!c) continue;
    seen.add(r.company);
    let status = "pending", error = null;
    if (contacted.has(r.company)) { status = "skipped"; error = "Already applied via a job posting"; }
    else if (AGENCY.test(trLower(r.company))) { status = "skipped"; error = "Recruitment agency / confidential posting"; }
    added += insertCompany.run({ company: r.company.trim(), ...c, job_title: r.title, status, error, domain: null, source: "jobs" }).changes;
  }
  return added;
}

// Startups that aren't necessarily hiring: YC companies in Türkiye and the
// Collective Spark portfolio. Most Turkish VC sites render client-side, so
// these two are what's readable over plain HTTP. Runs at most once a day.
// ponytail: two hard-coded sources; add a VC here when its page lists plain links.
const hostOf = (u) => rootDomain(new URL(u).hostname);
let lastStartupSeed = 0;
async function seedStartups() {
  if (Date.now() - lastStartupSeed < 24 * 3600e3) return 0;
  lastStartupSeed = Date.now();
  const found = [];
  try {
    const page = await request("https://www.ycombinator.com/companies", { timeout: 20000 });
    const key = (page.body.match(/"key":"([^"]+)"/) || [])[1];
    const res = await request(`https://45bwzj1sgc-dsn.algolia.net/1/indexes/*/queries?x-algolia-application-id=45BWZJ1SGC&x-algolia-api-key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ indexName: "YCCompany_production", params: "hitsPerPage=200&facetFilters=%5B%5B%22regions%3ATurkey%22%5D%5D" }] }),
    });
    for (const h of JSON.parse(res.body).results[0].hits) {
      if (h.status === "Active" && h.website) found.push({ company: h.name, domain: hostOf(h.website), city: cityOf(h.all_locations), source: "yc" });
    }
  } catch (e) { console.error("[Outreach] YC seed failed:", e.message); }
  try {
    const page = await request("https://www.collectivespark.com/portfolio", { timeout: 20000 });
    const SKIP = /facebook|twitter|x\.com|linkedin|instagram|youtube|medium|github|google|apple\.com|wordpress|wix|cloudflare|gstatic|w3\.org|schema\.org|vimeo|collectivespark/;
    for (const m of page.body.matchAll(/href=["'](https?:\/\/[^"'#?]+)/gi)) {
      const d = hostOf(m[1]);
      if (!SKIP.test(d)) found.push({ company: d.split(".")[0].replace(/^./, (c) => c.toUpperCase()), domain: d, city: null, source: "collectivespark" });
    }
  } catch (e) { console.error("[Outreach] Collective Spark seed failed:", e.message); }

  let added = 0;
  for (const f of found) {
    if (db.prepare("SELECT 1 FROM outreach WHERE domain = ?").get(f.domain)) continue;
    added += insertCompany.run({ company: f.company, ...(f.city || { city: "Türkiye", city_rank: 7 }), job_title: null,
      status: "pending", error: null, domain: f.domain, source: f.source }).changes;
  }
  if (added) console.log(`[Outreach] +${added} startups (YC / Collective Spark)`);
  return added;
}

// ─── Website + email discovery ────────────────────────────────────────────────
const LEGAL = /(?<![\p{L}\p{N}])(a\.?ş\.?|anonim|şirketi|ltd\.?|limited|şti\.?|inc\.?|corp\.?|llc|gmbh|bilişim|bilgi|teknolojileri|teknoloji|yazılım|hizmetleri|ticaret|sanayi|san\.?|tic\.?|ve|turkey|türkiye|group|grup|technologies|technology|tech|software|solutions|consulting|danışmanlık|systems|sistemleri|labs|digital|dijital|global|international|company)(?![\p{L}\p{N}])/giu;
const trLower = (s) => (s || "").toLocaleLowerCase("tr").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
const coreName = (company) => company.replace(LEGAL, " ").replace(/[^\p{L}\p{N}& ]/gu, " ").replace(/\s+/g, " ").trim();
const rootDomain = (host) => host.replace(/^www\./, "").toLowerCase();

async function lookupDomain(company) {
  const q = coreName(company) || company;
  const res = await request(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`, { timeout: 10000 });
  if (res.status !== 200) return null;
  const first = trLower(q).split(" ")[0];
  const hit = JSON.parse(res.body).find((s) => trLower(s.name).includes(first) || trLower(s.domain).includes(first.replace(/[^a-z0-9]/g, "")));
  return hit ? hit.domain : null;
}

// When Clearbit doesn't know them: acme.com, acme.com.tr, acme.io, … and the
// two-word form (acmesoft.com). inspectSite still has to find the name on the page.
function guessDomains(company) {
  const words = trLower(coreName(company)).split(" ").map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean);
  const slugs = [...new Set([words[0], words.slice(0, 2).join("")])].filter((x) => x && x.length >= 3);
  return slugs.flatMap((sl) => ["com", "com.tr", "io", "ai", "co"].map((tld) => `${sl}.${tld}`));
}

// Cloudflare hides addresses as <a data-cfemail="hex">.
function decodeCfEmail(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function extractEmails(html) {
  const found = new Set();
  const text = decodeEntities(html).replace(/%40|\[at\]|\(at\)/gi, "@");
  for (const m of text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) found.add(m[0].toLowerCase().replace(/\.$/, ""));
  for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) found.add(decodeCfEmail(m[1]).toLowerCase());
  return [...found].filter((e) => !/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e));
}

// Lower rank wins: HR > founders/CEO > named people > info@. Only addresses on
// the company's own domain, published on its own site.
const PREFIX_RANK = [
  [/^(ik|insankaynaklari|hr|humanresources|kariyer|career|careers|jobs|job|is|isbasvuru|basvuru|recruitment|recruiting|talent|hiring|joinus|join|people)$/, 1],
  [/^(ceo|cto|founder|founders|kurucu|genelmudur|gm)$/, 2],
  [/^(info|bilgi|iletisim|contact|hello|merhaba|hi|team|office|ofis|hey)([._-][a-z]{2,3})?$/, 4], // info, info-uk, info.tr
];
// Departments that won't forward a job enquiry — matched anywhere in the local part.
const USELESS = /eeo|support|destek|help|yardim|sales|satis|press|basin|media|medya|marketing|pazarlama|reply|privacy|kvkk|gdpr|legal|hukuk|muhasebe|account|financ|finans|fatura|invoice|billing|abuse|webmaster|admin|postmaster|partner|investor|yatirimci|iliski|relation|security|siparis|order|musteri|customer|bayi|dealer|ihracat|export|teklif|quote|rfq|satinalma|purchas|procure|tedarik|servis|service|teknik|compliance|etik|ethic|ihbar|whistle|test|example|ornek|domain|e-?mail|newsletter|bulten/;
const USELESS_SHORT = /^(ir|it|cs|ad|dpo|noc|mail|name|adiniz)([._-]|$)/;
// A person: firstname, firstname.lastname, f.lastname — letters only.
const PERSON = /^[a-z]{2,}([._-][a-z]{1,})?$/;

function rankEmail(email, domain) {
  const [local, host] = email.split("@");
  if (!host || !(host === domain || host.endsWith("." + domain) || domain.endsWith("." + host))) return null;
  for (const [re, rank] of PREFIX_RANK) if (re.test(local)) return rank;
  if (USELESS.test(local) || USELESS_SHORT.test(local)) return null;
  // solid@solidict.com is the company's own inbox, not a person.
  const brand = domain.split(".")[0].replace(/[^a-z0-9]/g, "");
  if (brand.includes(local.replace(/[^a-z0-9]/g, "")) || local.replace(/[^a-z0-9]/g, "").includes(brand)) return 4;
  return PERSON.test(local) ? 3 : null;
}

// Agencies show up as normal companies; their own site description gives them away.
const AGENCY_ABOUT = /recruitment agenc|recruiting agenc|staffing|headhunt|executive search|talent acquisition partner|ise alim ajans|insan kaynaklari danismanlik|personel temin/;
function rankEmails(emails, domain) {
  return [...new Set(emails)]
    .map((e) => ({ e, r: rankEmail(e, domain) }))
    .filter((x) => x.r !== null)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.e);
}
const pickEmail = (emails, domain) => rankEmails(emails, domain)[0] || null;

const ATS = /lever\.co|greenhouse\.io|workable\.com|kariyer\.net|ashbyhq\.com|teamtailor|recruitee|breezy\.hr|bamboohr|personio|smartrecruiters|linkedin\.com\/company\/[^"']+\/jobs/;
const SUBPAGE = /iletisim|contact|kariyer|career|jobs|insan-kaynaklari|bize-katil|join|hakkimizda|about|ekip|team|kurucu|founder/i;

async function getPage(url) {
  try {
    const res = await request(url, { timeout: 12000, headers: { Accept: "text/html", "Accept-Language": "tr,en;q=0.8" } });
    return res.status >= 200 && res.status < 300 ? res.body : null;
  } catch (e) { return null; }
}

async function inspectSite(company, domain, { trusted = false } = {}) {
  let base = `https://${domain}`;
  let home = await getPage(base) || await getPage((base = `https://www.${domain}`));
  if (!home) return { error: "Website didn't load" };

  // Clearbit and guessed domains can be a namesake — the page must name the
  // company: its first two meaningful words ("Turgut Reis", not just "Turgut").
  const pageText = trLower(stripHTML(home) + " " + home.slice(0, 3000));
  const words = trLower(coreName(company)).split(" ").filter((w) => w.length >= 3).slice(0, 2);
  if (!trusted && words.some((w) => !pageText.includes(w))) {
    return { error: `${domain} doesn't mention "${coreName(company)}" — maybe the wrong site` };
  }

  const about = decodeEntities((home.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1] || "").trim().slice(0, 300);
  const title = stripHTML((home.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").slice(0, 200);
  const links = [...home.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  let careers_url = links.find((h) => ATS.test(h)) || null;

  const subpages = new Set();
  for (const h of links) {
    if (!SUBPAGE.test(h)) continue;
    try {
      const u = new URL(h, base);
      if (rootDomain(u.hostname).endsWith(domain)) subpages.add(u.toString());
    } catch (e) { /* bad href */ }
  }
  for (const p of ["/iletisim", "/contact", "/kariyer", "/careers"]) if (subpages.size < 3) subpages.add(base + p);

  const where = new Map(); // email → first page it appeared on
  // Türkiye signal from any page (contact pages carry the office address).
  let inTurkey = /\.tr$/.test(domain) || siteLang(home) === "tr";
  const collect = (html, url) => {
    for (const e of extractEmails(html)) if (!where.has(e)) where.set(e, url);
    if (!inTurkey && cityOf(stripHTML(html))) inTurkey = true;
  };
  collect(home, base);
  for (const url of [...subpages].slice(0, 6)) {
    const page = await getPage(url);
    if (!page) continue;
    if (!careers_url && /kariyer|career|jobs|insan-kaynaklari|bize-katil|join/i.test(url)) careers_url = url;
    collect(page, url);
  }
  // Only addresses whose domain actually receives mail.
  const ranked = [];
  for (const e of rankEmails([...where.keys()], domain)) if (await hasMx(e.split("@")[1])) ranked.push(e);
  return {
    website: base, about, title, careers_url, lang: siteLang(home), inTurkey,
    email: ranked[0] || null, emails_found: ranked.join(",") || null, email_source: ranked[0] ? where.get(ranked[0]) : null,
    text: stripHTML(home).slice(0, 2500),
  };
}

const mxCache = new Map();
async function hasMx(domain) {
  if (!mxCache.has(domain)) {
    mxCache.set(domain, require("dns").promises.resolveMx(domain).then((r) => r.length > 0, () => false));
  }
  return mxCache.get(domain);
}

// Clearbit's answer first, then guesses; the first site that loads and names the company wins.
async function findSite(row) {
  const candidates = row.domain ? [row.domain] : [await lookupDomain(row.company).catch(() => null), ...guessDomains(row.company)];
  let firstError = null;
  for (const domain of [...new Set(candidates.filter(Boolean))]) {
    const site = await inspectSite(row.company, domain, { trusted: Boolean(row.domain) });
    // Looked-up domains must show they're in Türkiye (Turkish text, a Turkish
    // city on any page, or .tr) — otherwise it's usually a namesake abroad.
    // Domains from YC / portfolio lists are already known to be right.
    if (!site.error && !row.domain && !site.inTurkey) site.error = `${domain} shows no sign of Türkiye — probably a namesake`;
    if (!site.error) return { domain, ...site };
    firstError = firstError || site.error;
  }
  return { error: firstError || "No website found" };
}

// English site (lang="en…" and barely any Turkish letters) → English email.
function siteLang(html) {
  const declared = ((html.match(/<html[^>]*\slang=["']?([a-z]{2})/i) || [])[1] || "").toLowerCase();
  if (declared === "tr") return "tr";
  const trChars = (stripHTML(html).match(/[şğıİçöüŞĞÇÖÜ]/g) || []).length;
  return trChars > 20 ? "tr" : "en";
}

// ─── Draft ────────────────────────────────────────────────────────────────────
// row: { company, city, job_title, lang, email, kind, referred_by, subject }
function draftFor(row) {
  const name = coreName(row.company) || row.company;
  const toPerson = row.email && rankEmail(row.email, row.email.split("@")[1]) <= 3 && !PREFIX_RANK[0][0].test(row.email.split("@")[0]);
  const local = row.city === "İstanbul" || row.city === "Türkiye";
  const sig = [NAME, PHONE, GMAIL_USER, LINKEDIN].filter(Boolean).join("\n");

  // A week later, same thread, three lines.
  if (row.kind === "bump") {
    const subject = /^re:/i.test(row.subject || "") ? row.subject : `Re: ${row.subject || "Junior Full Stack Developer"}`;
    return row.lang === "en" ? { subject, body:
`Hi,

I wanted to bring my email from last week back to the top of your inbox in case it got buried. If there's any junior full-stack opening, I'd be glad to talk. My CVs are attached again.

Best regards,
${sig.replace(NAME, NAME_EN)}` } : { subject, body:
`Merhaba,

Geçen hafta junior full stack developer pozisyonları için gönderdiğim e-postayı, yoğunlukta gözden kaçmış olabileceği için tekrar hatırlatmak istedim. Uygun bir fırsat olursa görüşmekten memnuniyet duyarım; CV'lerim yine ekte.

Saygılarımla,
${sig}` };
  }

  if (row.lang === "en") {
    const posting = row.job_title ? `I recently saw your "${row.job_title}" posting and noticed your engineering team is growing.` : "";
    const hook = row.kind === "redirect"
      ? `${row.referred_by || `The ${name} team`} suggested I get in touch with you.`
      : row.kind === "followup"
      ? "I reached out a couple of months ago about junior full-stack roles and wanted to check in again in case anything has opened up."
      : posting || "I've been following what your team is building.";
    const where = local ? "I'm based in Istanbul." : `I'm based in Istanbul and open to relocating to ${row.city} or working remotely/hybrid.`;
    return {
      subject: `Junior Full Stack Developer – ${NAME_EN}`,
      body:
`${toPerson ? "Hi," : `Hi ${name} team,`}

I'm ${NAME_EN}, a Computing graduate from Atlantic Technological University in Ireland. ${where} ${hook}

During my 6-month internship at CBE I built management dashboards and REST APIs for live systems with C#/.NET, ASP.NET Core, Blazor and SQL. In my own projects I've built full-stack apps with React, Vue.js, Node.js and TypeScript.

I'd love to know whether there's a junior full-stack developer role on your team I could be considered for. Even if nothing is open right now, I've attached my CV (English and Turkish) for future openings.

Thank you for your time.

Best regards,
${sig.replace(NAME, NAME_EN)}`,
    };
  }

  const hook = row.kind === "redirect"
    ? `${row.referred_by || `${name} ekibi`} beni size yönlendirdi.`
    : row.kind === "followup"
    ? "Birkaç ay önce junior full stack developer pozisyonları için size yazmıştım; ekibinizde yeni bir fırsat oluştuysa tekrar değerlendirilmek isterim."
    : row.job_title
    ? `Yakın zamanda "${row.job_title}" ilanınızı gördüm; ekibinizin yazılım tarafında büyüdüğünü fark ettim.`
    : "Yaptığınız işi yakından takip ediyorum.";
  const where = local
    ? "İstanbul'da yaşıyorum."
    : `İstanbul'da yaşıyorum; ${row.city} için taşınmaya ya da uzaktan/hibrit çalışmaya açığım.`;
  return {
    subject: `Junior Full Stack Developer – ${NAME}`,
    body:
`${toPerson ? "Merhaba," : `Merhaba ${name} ekibi,`}

Ben ${NAME}; İrlanda'daki Atlantic Technological University'den Bilgisayar Mühendisliği mezunuyum. ${where} ${hook}

CBE'deki 6 aylık stajımda C#/.NET, ASP.NET Core, Blazor ve SQL ile canlı sistemler için yönetim panelleri ve REST API'ler geliştirdim. Kişisel projelerimde React, Vue.js, Node.js ve TypeScript ile full stack uygulamalar geliştirdim.

Ekibinizde junior full stack developer olarak değerlendirilebileceğim bir pozisyon olup olmadığını öğrenmek isterim. Şu an açık bir pozisyon yoksa bile ileride değerlendirilmek üzere Türkçe ve İngilizce CV'mi ekte paylaşıyorum.

Vakit ayırdığınız için teşekkür ederim.

Saygılarımla,
${sig}`,
  };
}

// ─── Discovery run ────────────────────────────────────────────────────────────
let discovering = false;
async function discover(limit = 25) {
  if (discovering) return { busy: true };
  discovering = true;
  const counts = { seeded: 0, checked: 0, drafts: 0 };
  try {
    counts.seeded = seedFromJobs() + await seedStartups();
    const rows = db.prepare("SELECT * FROM outreach WHERE status = 'pending' ORDER BY source = 'jobs', city_rank, id LIMIT ?").all(limit);
    const update = db.prepare(`UPDATE outreach SET domain=@domain, website=@website, about=@about, email=@email,
      careers_url=@careers_url, emails_found=@emails_found, email_source=@email_source, lang=@lang,
      status=@status, subject=@subject, body=@body, error=@error, checked_at=datetime('now') WHERE id=@id`);
    for (const row of rows) {
      const out = { id: row.id, domain: row.domain, website: null, about: null, email: null, careers_url: null, emails_found: null,
        email_source: null, lang: "tr", subject: null, body: null, error: null, status: "no_site" };
      try {
        const site = AGENCY.test(trLower(row.company)) ? { error: "skip" } : await findSite(row);
        const { text, title, ...fields } = site;
        Object.assign(out, fields);
        {
          if (site.error === "skip") { out.status = "skipped"; out.error = "Recruitment agency / confidential posting"; }
          else if (site.error) out.status = "no_site";
          else if (AGENCY_ABOUT.test(trLower(`${site.about} ${title}`))) { out.status = "skipped"; out.error = "Recruitment agency (from their site)"; }
          else if (!site.email) { out.status = "no_email"; out.error = site.careers_url ? "Apply via careers page" : "No usable email on the site"; }
          else {
            // Another company already got (or will get) this address — don't double up.
            const dup = db.prepare("SELECT company FROM outreach WHERE email = ? AND id != ?").get(site.email, row.id);
            if (dup) { out.status = "skipped"; out.error = `Same email as ${dup.company}`; }
            else {
              out.status = "draft";
              Object.assign(out, draftFor({ ...row, ...out }));
              counts.drafts++;
            }
          }
        }
      } catch (e) {
        out.error = e.message;
      }
      update.run(out);
      counts.checked++;
      await sleep(800);
    }
    console.log(`[Outreach] discovery: +${counts.seeded} companies, checked ${counts.checked}, ${counts.drafts} new drafts`);
    return counts;
  } finally {
    discovering = false;
  }
}

// ─── Sending ──────────────────────────────────────────────────────────────────
let transport = null;
const getTransport = () => transport || (transport = require("nodemailer").createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
}));

const sentToday = () => db.prepare(
  "SELECT COUNT(*) n FROM outreach_sends WHERE date(sent_at, '+3 hours') = date('now', '+3 hours')"
).get().n;

async function sendMail(to, subject, text, { inReplyTo } = {}) {
  return getTransport().sendMail({
    from: { name: NAME, address: GMAIL_USER },
    to, subject, text,
    attachments: CVS,
    ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {}),
  });
}

let authFailed = false;
// One email per call, so the cron spreads them across the working day.
// Redirects jump the queue — someone at the company is expecting them.
async function sendNext({ alert } = {}) {
  if (!configured() || authFailed || sentToday() >= DAILY_CAP) return null;
  const row = db.prepare(`SELECT * FROM outreach WHERE status = 'approved'
    ORDER BY kind = 'redirect' DESC, city_rank, id LIMIT 1`).get();
  if (!row) return null;
  // Never the same inbox from two company rows within a month (a row's own
  // timing — bump, follow-up — is decided by queueFollowups).
  const recent = db.prepare("SELECT 1 FROM outreach_sends WHERE email = ? AND outreach_id != ? AND sent_at > datetime('now', '-30 days')").get(row.email, row.id);
  if (recent) {
    db.prepare("UPDATE outreach SET status='skipped', error='Address emailed in the last 30 days' WHERE id=?").run(row.id);
    return null;
  }
  try {
    const prev = row.kind === "bump" ? db.prepare("SELECT message_id FROM outreach_sends WHERE outreach_id = ? ORDER BY id DESC LIMIT 1").get(row.id) : null;
    const info = await sendMail(row.email, row.subject, row.body, { inReplyTo: prev?.message_id });
    db.transaction(() => {
      db.prepare("INSERT INTO outreach_sends (outreach_id, email, kind, message_id) VALUES (?, ?, ?, ?)").run(row.id, row.email, row.kind, info.messageId || null);
      db.prepare("UPDATE outreach SET status='sent', sent_at=datetime('now'), contact_count=contact_count+1, error=NULL WHERE id=?").run(row.id);
    })();
    console.log(`[Outreach] sent (${row.kind}) → ${row.company} <${row.email}>`);
    return row;
  } catch (e) {
    if (e.code === "EAUTH") {
      authFailed = true; // stop until restart — retrying a bad password gets the account locked
      if (alert) await alert("<b>Outreach stopped:</b> Gmail rejected the login. Check GMAIL_USER / GMAIL_APP_PASSWORD in .env and restart.");
    } else {
      db.prepare("UPDATE outreach SET status='failed', error=? WHERE id=?").run(e.message.slice(0, 300), row.id);
    }
    console.error(`[Outreach] send failed (${row.company}): ${e.message}`);
    return null;
  }
}

// 1. No reply a week after the first email → short nudge in the same thread,
//    queued automatically (you already approved this company).
// 2. No reply for RECONTACT_DAYS, or they said "not right now" → follow-up
//    draft back in Review. MAX_CONTACTS caps the total.
function queueFollowups() {
  const bumps = db.prepare(`SELECT * FROM outreach WHERE status = 'sent' AND kind = 'first' AND contact_count = 1
    AND replied_at IS NULL AND sent_at < datetime('now', ?)`).all(`-${BUMP_DAYS} days`);
  for (const r of bumps) {
    const d = draftFor({ ...r, kind: "bump" });
    db.prepare("UPDATE outreach SET status='approved', kind='bump', subject=?, body=?, error=? WHERE id=? AND status='sent'")
      .run(d.subject, d.body, `Reminder: no reply since ${r.sent_at.slice(0, 10)}`, r.id);
  }
  const due = db.prepare(`SELECT * FROM outreach WHERE contact_count < ? AND (
      (status = 'sent' AND kind != 'first' AND sent_at < datetime('now', @gap)) OR
      (status = 'replied' AND reply_class = 'later' AND replied_at < datetime('now', @gap)))`)
    .all(MAX_CONTACTS, { gap: `-${RECONTACT_DAYS} days` });
  for (const r of due) {
    const d = draftFor({ ...r, kind: "followup" });
    const why = r.status === "replied" ? `They said "not right now" on ${r.replied_at.slice(0, 10)}` : `No reply since ${r.sent_at.slice(0, 10)}`;
    db.prepare("UPDATE outreach SET status='draft', kind='followup', subject=?, body=?, error=? WHERE id=? AND status IN ('sent','replied')")
      .run(d.subject, d.body, `Follow-up #${r.contact_count}: ${why}`, r.id);
  }
  if (bumps.length || due.length) console.log(`[Outreach] ${bumps.length} reminders queued, ${due.length} follow-ups ready for review`);
  return bumps.length + due.length;
}

// ─── Reading replies ──────────────────────────────────────────────────────────
// Only the new part of a reply — drop the quoted email we sent.
function freshText(text) {
  const lines = [];
  for (const line of (text || "").split(/\r?\n/)) {
    if (/^\s*>/.test(line)) continue;
    if (/^(on .+wrote:|.+tarihinde.+(yazdı|şunu yazdı):?|-{2,}\s*(original message|orijinal ileti|forwarded)|from:\s|kimden:\s|gönderen:\s)/i.test(line.trim())) break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

const isAutoReply = (headers, subject) =>
  /^(auto-replied|auto-generated)/i.test(headers.get("auto-submitted") || "") ||
  headers.has("x-autoreply") || headers.has("x-autorespond") ||
  /auto_reply|bulk|junk/i.test(headers.get("precedence") || "") ||
  /otomatik (yanıt|cevap)|automatic reply|auto(matic)?[- ]?reply|out of (the )?office|ofis dışında|izindeyim/i.test(subject || "");

// "please write to ahmet@x.com instead" → ahmet@x.com. The address must sit next
// to a send/forward/contact phrase, so a signature's own address doesn't count.
const REDIRECT_HINT = /send|forward|reach|contact|write|email|e-mail|apply|address|instead|wrong|direct|gönder|ilet|yönlendir|ulaş|yaz|başvur|adres|iletişim|ilgili/i;
function findRedirect(text, exclude) {
  const lines = text.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
      const email = m[0].toLowerCase().replace(/\.$/, "");
      if (exclude.has(email) || /no-?reply|mailer-daemon/.test(email)) continue;
      const near = [lines[i - 1], lines[i], lines[i + 1]].join(" ");
      if (REDIRECT_HINT.test(near.replace(email, ""))) return email;
    }
  }
  return null;
}
const APPLY_LINK = /https?:\/\/\S*(kariyer|career|jobs|apply|basvur|lever\.co|greenhouse\.io|workable|linkedin\.com\/jobs)\S*/i;

// What a human reply means. Checked in this order: a call/interview beats
// "not right now", which beats a plain no.
// ponytail: keyword rules; change it by hand in the UI when it guesses wrong.
const INTERESTED = /görüşme|mülakat|mulakat|interview|toplantı|tanışmak|telefon|arayabilir|call|chat|meet|müsait|available|uygun (bir )?zaman|case study|test case|teknik test|assignment|ödev|davet|invite|schedule|takvim|calendly/i;
const LATER = /şu an(da)?|şimdilik|ileride|ilerleyen|gelecekte|havuz|kaydettik|kayıtlarımıza|dosyalarımızda|değerlendirmeye alacağız|at the moment|right now|currently|for now|in the future|future (openings|roles|opportunities)|keep (your cv|you in mind|it on file)|on file|talent pool/i;
const NO = /maalesef|olumsuz|uygun değil|değerlendiremiyoruz|unfortunately|not (a )?fit|not hiring|no (open )?positions?|decided not|won't be|will not be moving|regret/i;
function replyClass(text) {
  if (INTERESTED.test(text)) return "interested";
  if (LATER.test(text)) return "later";
  if (NO.test(text)) return "no";
  return "unknown";
}

// Decides what one inbox message means for one outreach row.
// Returns { type: 'redirect'|'reply'|'ignore', email?, link?, snippet }
function classifyReply({ text, subject, headers, from, row, knownEmails }) {
  const fresh = freshText(text);
  const exclude = new Set([from, GMAIL_USER, process.env.USER_EMAIL, ...knownEmails].filter(Boolean).map((e) => e.toLowerCase()));
  const email = findRedirect(fresh, exclude);
  const snippet = fresh.replace(/\s+/g, " ").slice(0, 500);
  if (email) return { type: "redirect", email, snippet };
  if (isAutoReply(headers, subject)) return { type: "ignore", snippet };
  return { type: "reply", link: (fresh.match(APPLY_LINK) || [])[0] || null, snippet, cls: replyClass(fresh) };
}

// ─── Reply + bounce detection (IMAP) ──────────────────────────────────────────
let checking = false;
async function checkReplies({ alert } = {}) {
  if (!configured() || checking) return { skipped: true };
  const first = db.prepare("SELECT MIN(sent_at) t FROM outreach_sends").get().t;
  if (!first) return { replies: 0, bounces: 0, redirects: 0 };
  checking = true;
  const { ImapFlow } = require("imapflow");
  const { simpleParser } = require("mailparser");
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: GMAIL_USER, pass: GMAIL_PASS }, logger: false });
  const counts = { replies: 0, bounces: 0, redirects: 0 };
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const sends = db.prepare("SELECT s.email, s.message_id, s.outreach_id FROM outreach_sends s").all();
      const rowById = (id) => db.prepare("SELECT * FROM outreach WHERE id = ?").get(id);
      const byAddr = new Map(sends.map((s) => [s.email, s.outreach_id]));
      const byMsgId = new Map(sends.filter((s) => s.message_id).map((s) => [s.message_id, s.outreach_id]));
      const byDomain = new Map();
      for (const s of sends) {
        const d = s.email.split("@")[1];
        if (!FREEMAIL.test(d)) byDomain.set(d, s.outreach_id); // never match "anyone at gmail.com"
      }
      const seen = db.prepare("SELECT 1 FROM outreach_seen WHERE message_id = ?");
      const markSeen = db.prepare("INSERT OR IGNORE INTO outreach_seen (message_id) VALUES (?)");
      const since = new Date(first.replace(" ", "T") + "Z");

      for await (const msg of client.fetch({ since }, { envelope: true, source: true })) {
        const key = msg.envelope.messageId || `uid:${msg.uid}`;
        if (seen.get(key)) continue;
        const from = (msg.envelope.from?.[0]?.address || "").toLowerCase();
        const fromName = msg.envelope.from?.[0]?.name || "";
        const subject = msg.envelope.subject || "";

        if (/mailer-daemon|postmaster/.test(from)) {
          const src = msg.source.toString().toLowerCase();
          const hit = sends.find((s) => src.includes(s.email));
          if (hit && db.prepare("UPDATE outreach SET status='bounced', error=? WHERE id=? AND status='sent' AND email=?")
            .run("Bounced: " + subject, hit.outreach_id, hit.email).changes) counts.bounces++;
          markSeen.run(key);
          continue;
        }

        const parsed = await simpleParser(msg.source);
        const refs = [parsed.inReplyTo, ...[].concat(parsed.references || [])].filter(Boolean);
        const host = from.split("@")[1] || "";
        const id = refs.map((r) => byMsgId.get(r)).find(Boolean) || byAddr.get(from)
          || byDomain.get(host) || [...byDomain.entries()].find(([d]) => host.endsWith("." + d))?.[1];
        markSeen.run(key);
        if (!id) continue;

        const row = rowById(id);
        const knownEmails = sends.filter((s) => s.outreach_id === id).map((s) => s.email);
        const r = classifyReply({ text: parsed.text, subject, headers: parsed.headers, from, row, knownEmails });

        if (r.type === "redirect") {
          // Auto-approved: the company itself named this address.
          const referred_by = fromName && !/@/.test(fromName) && !isAutoReply(parsed.headers, subject) ? fromName : null;
          const d = draftFor({ ...row, email: r.email, kind: "redirect", referred_by });
          db.prepare(`UPDATE outreach SET email=?, kind='redirect', referred_by=?, subject=?, body=?, status='approved',
            replied_at=COALESCE(replied_at, datetime('now')), reply_subject=?, reply_text=?, error=? WHERE id=?`)
            .run(r.email, referred_by, d.subject, d.body, subject, r.snippet, `Redirected to ${r.email} by ${from}`, id);
          counts.redirects++;
          if (alert) await alert(`<b>↪ ${esc(row.company)} redirected you</b>\nTo: ${esc(r.email)} (queued, sends next)\n<i>${esc(r.snippet.slice(0, 300))}</i>`);
        } else if (r.type === "reply") {
          db.prepare(`UPDATE outreach SET status='replied', replied_at=datetime('now'), reply_subject=?, reply_text=?, reply_class=?,
            careers_url=COALESCE(?, careers_url), error=? WHERE id=?`)
            .run(subject, r.snippet, r.cls, r.link, r.link ? "They pointed you to an application link" : null, id);
          counts.replies++;
          const label = { interested: "🔥 Interested", later: "⏳ Not right now", no: "✕ No", unknown: "📬 Reply" }[r.cls];
          if (alert) await alert(`<b>${label}: ${esc(row.company)}</b>\n${esc(subject)}\n<i>${esc(r.snippet.slice(0, 300))}</i>${r.link ? `\nApply link: ${esc(r.link)}` : ""}`);
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.error(`[Outreach] reply check failed: ${e.message}`);
    counts.error = e.message;
  } finally {
    checking = false;
    try { await client.logout(); } catch (e) {}
  }
  return counts;
}
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ─── Scheduling ───────────────────────────────────────────────────────────────
function startOutreach({ alert }) {
  const cron = require("node-cron");
  const tz = { timezone: "Europe/Istanbul" };
  const jobs = [
    cron.schedule("20 * * * *", () => {
      queueFollowups();
      discover().catch((e) => console.error("[Outreach] discovery:", e.message));
    }, tz),
    // Every 15 min in Istanbul office hours, with jitter so it doesn't look scripted.
    cron.schedule("*/15 10-16 * * 1-5", async () => {
      await sleep(Math.random() * 8 * 60 * 1000);
      await sendNext({ alert });
    }, tz),
    cron.schedule("*/30 * * * *", () => checkReplies({ alert }), tz),
  ];
  console.log(`[Outreach] scheduled (${configured() ? `sending as ${GMAIL_USER}, ${DAILY_CAP}/day` : "sending OFF — set GMAIL_USER and GMAIL_APP_PASSWORD"})`);
  return () => jobs.forEach((j) => j.stop());
}

// ─── API ──────────────────────────────────────────────────────────────────────
const router = express.Router();

router.get("/stats", (req, res) => {
  const byStatus = Object.fromEntries(db.prepare("SELECT status, COUNT(*) n FROM outreach GROUP BY status").all().map((r) => [r.status, r.n]));
  const byCity = db.prepare(`
    SELECT city, MIN(city_rank) rank, COUNT(*) companies,
      SUM(email IS NOT NULL) emails,
      SUM(contact_count > 0) sent,
      SUM(replied_at IS NOT NULL) replied
    FROM outreach GROUP BY city ORDER BY rank, companies DESC
  `).all();
  // Emails sent per day, and replies received per day.
  const daily = db.prepare(`
    SELECT day, SUM(sent) sent, SUM(replied) replied FROM (
      SELECT date(sent_at, '+3 hours') day, 1 sent, 0 replied FROM outreach_sends WHERE sent_at > datetime('now', '-14 days')
      UNION ALL
      SELECT date(replied_at, '+3 hours'), 0, 1 FROM outreach WHERE replied_at > datetime('now', '-14 days')
    ) GROUP BY day ORDER BY day
  `).all();
  const totals = db.prepare(`SELECT
      (SELECT COUNT(*) FROM outreach_sends) emails_sent,
      SUM(contact_count > 0) companies_contacted,
      SUM(replied_at IS NOT NULL) replied,
      SUM(kind = 'redirect') redirects,
      SUM(kind = 'followup' AND status = 'draft') followups_due,
      SUM(reply_class = 'interested') interested,
      SUM(reply_class = 'later') later,
      SUM(reply_class = 'no') no
    FROM outreach`).get();
  res.json({
    byStatus, byCity, daily, totals,
    sentToday: sentToday(), dailyCap: DAILY_CAP,
    configured: configured(), authFailed, sender: GMAIL_USER || null,
    cvFound: CVS.every((c) => fs.existsSync(c.path)), discovering,
  });
});

const LISTS = {
  review: "status = 'draft'",
  queue: "status = 'approved'",
  sent: "status IN ('sent','bounced','failed')",
  replied: "replied_at IS NOT NULL",
  manual: "status = 'no_email'",
  other: "status IN ('pending','no_site','skipped')",
};
router.get("/list", (req, res) => {
  const where = LISTS[req.query.list] || LISTS.review;
  const order = req.query.list === "replied" ? "replied_at DESC" : req.query.list === "sent" ? "sent_at DESC" : "kind = 'redirect' DESC, city_rank, id";
  res.json(db.prepare(`SELECT * FROM outreach WHERE ${where} ORDER BY ${order} LIMIT 300`).all());
});

router.put("/:id", (req, res) => {
  const { subject, body, email } = req.body;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Invalid email" });
  db.prepare("UPDATE outreach SET subject = COALESCE(?, subject), body = COALESCE(?, body), email = COALESCE(?, email) WHERE id = ? AND status IN ('draft','approved')")
    .run(subject ?? null, body ?? null, email ?? null, req.params.id);
  res.json({ success: true });
});

// Allowed moves only — a sent email can never be put back in the queue.
const MOVES = { approved: ["draft"], draft: ["approved", "skipped"], skipped: ["draft", "approved", "pending", "no_site", "no_email"], pending: ["skipped"], replied: ["sent", "bounced"], sent: ["replied"] };
function moveRows(ids, status) {
  if (!MOVES[status] || !Array.isArray(ids)) return null;
  const from = MOVES[status].map(() => "?").join(",");
  const stmt = db.prepare(`UPDATE outreach SET status = ?, replied_at = CASE WHEN ? = 'replied' THEN COALESCE(replied_at, datetime('now')) ELSE replied_at END
    WHERE id = ? AND status IN (${from}) ${status === "approved" ? "AND email IS NOT NULL AND body IS NOT NULL" : ""}`);
  let changed = 0;
  for (const id of ids) changed += stmt.run(status, status, id, ...MOVES[status]).changes;
  return changed;
}
router.post("/status", (req, res) => {
  const changed = moveRows(req.body.ids, req.body.status);
  if (changed === null) return res.status(400).json({ error: "Invalid move" });
  res.json({ changed });
});

// Fix the reply class by hand; "later" makes them come back after RECONTACT_DAYS.
router.post("/:id/class", (req, res) => {
  if (!["interested", "later", "no", "unknown"].includes(req.body.cls)) return res.status(400).json({ error: "Invalid class" });
  db.prepare("UPDATE outreach SET reply_class = ? WHERE id = ? AND replied_at IS NOT NULL").run(req.body.cls, req.params.id);
  res.json({ success: true });
});

// Hand-entered email for a no_email / skipped company → becomes a draft.
router.post("/:id/email", (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Invalid email" });
  const row = db.prepare("SELECT * FROM outreach WHERE id = ? AND status IN ('pending','no_site','no_email','skipped','draft')").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const d = draftFor({ ...row, email });
  db.prepare("UPDATE outreach SET email=?, subject=?, body=?, status='draft', error=NULL WHERE id=?").run(email, d.subject, d.body, row.id);
  res.json({ success: true });
});

// Rewrite the draft in the other language (throws away manual edits).
router.post("/:id/lang", (req, res) => {
  const lang = req.body.lang === "en" ? "en" : "tr";
  const row = db.prepare("SELECT * FROM outreach WHERE id = ? AND status IN ('draft','approved') AND body IS NOT NULL").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  const d = draftFor({ ...row, lang });
  db.prepare("UPDATE outreach SET lang=?, subject=?, body=? WHERE id=?").run(lang, d.subject, d.body, row.id);
  res.json({ success: true, ...d });
});

router.post("/discover", (req, res) => {
  res.json({ started: !discovering });
  discover(parseInt(req.body.limit) || 25).catch((e) => console.error("[Outreach] discovery:", e.message));
});

router.post("/check-replies", async (req, res) => res.json(await checkReplies()));

// Sends one copy to yourself — proves login + attachment work before real sends.
router.post("/test", async (req, res) => {
  if (!configured()) return res.status(400).json({ error: "Set GMAIL_USER and GMAIL_APP_PASSWORD in .env, then restart" });
  const row = db.prepare("SELECT * FROM outreach WHERE body IS NOT NULL ORDER BY city_rank, id LIMIT 1").get();
  const d = row ? { subject: row.subject, body: row.body } : draftFor({ company: "Örnek Teknoloji", city: "İstanbul", job_title: "Full Stack Developer" });
  try {
    await sendMail(GMAIL_USER, "[TEST] " + d.subject, d.body);
    res.json({ success: true, to: GMAIL_USER });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Plain-text summary for Telegram /outreach.
function summary() {
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    review: n("SELECT COUNT(*) n FROM outreach WHERE status = 'draft'"),
    queue: n("SELECT COUNT(*) n FROM outreach WHERE status = 'approved'"),
    sentToday: sentToday(), cap: DAILY_CAP,
    emailsSent: n("SELECT COUNT(*) n FROM outreach_sends"),
    companies: n("SELECT COUNT(*) n FROM outreach WHERE contact_count > 0"),
    replied: n("SELECT COUNT(*) n FROM outreach WHERE replied_at IS NOT NULL"),
    interested: n("SELECT COUNT(*) n FROM outreach WHERE reply_class = 'interested'"),
    toLookUp: n("SELECT COUNT(*) n FROM outreach WHERE status = 'pending'"),
  };
}
const nextDrafts = (limit = 5) => db.prepare("SELECT * FROM outreach WHERE status = 'draft' ORDER BY kind = 'redirect' DESC, city_rank, id LIMIT ?").all(limit);

module.exports = { draftFor, router, startOutreach, discover, checkReplies, sendNext, queueFollowups, summary, nextDrafts, moveRows };

// ─── Self-check: node outreach.js --check ─────────────────────────────────────
if (require.main === module && process.argv.includes("--check")) {
  const assert = require("assert");
  assert.deepStrictEqual(cityOf("Kadıköy, İstanbul, Türkiye"), { city: "İstanbul", city_rank: 1 });
  assert.deepStrictEqual(cityOf("Ankara, Turkey"), { city: "Ankara", city_rank: 2 });
  assert.strictEqual(cityOf("Dublin, Ireland"), null);
  assert.strictEqual(coreName("ARD Grup Bilişim Teknolojileri A.Ş."), "ARD");
  assert.strictEqual(decodeCfEmail("422b29023a6c212d"), "ik@x.co");
  const html = `<a href="mailto:ahmet.yilmaz@acme.com.tr">x</a> info@acme.com.tr <span>ik@acme.com.tr</span> logo@2x.png support@gmail.com`;
  const emails = extractEmails(html);
  assert.strictEqual(pickEmail(emails, "acme.com.tr"), "ik@acme.com.tr");            // HR beats info
  assert.strictEqual(pickEmail(["info@gmail.com"], "acme.com.tr"), null);           // other domain
  assert.ok(["Randstad Türkiye", "Gizli Şirket", "Kariyer.net"].every((n) => AGENCY.test(trLower(n))));
  assert.ok(!AGENCY.test(trLower("Akbank")) && !AGENCY.test(trLower("Kocaeli Yazılım")));
  // Named people are allowed now, ranked between HR and info@; departments are not.
  assert.deepStrictEqual(rankEmails(["info@acme.com", "ahmet.yilmaz@acme.com", "ceo@acme.com", "ik@acme.com", "satis@acme.com", "noreply@acme.com"], "acme.com"),
    ["ik@acme.com", "ceo@acme.com", "ahmet.yilmaz@acme.com", "info@acme.com"]);
  assert.strictEqual(siteLang('<html lang="en"><body>We build software</body></html>'), "en");
  assert.strictEqual(siteLang('<html lang="tr"><body>Yazılım</body></html>'), "tr");
  const en = draftFor({ company: "Dataroid", city: "İstanbul", lang: "en", email: "mert@dataroid.com" });
  assert.ok(en.body.startsWith("Hi,\n") && en.body.includes("English and Turkish"));
  const d = draftFor({ company: "AKTech Yazılım A.Ş.", city: "Ankara", job_title: "Full Stack Developer" });
  assert.ok(d.body.startsWith("Merhaba AKTech ekibi") && d.body.includes("Ankara için taşınmaya"));
  // Department / brand inboxes are never treated as a person.
  assert.strictEqual(rankEmail("ir.team@siemens.com", "siemens.com"), null);
  assert.strictEqual(rankEmail("yatirimciiliskileri@ronesans.com", "ronesans.com"), null);
  assert.strictEqual(rankEmail("account@svs.com.tr", "svs.com.tr"), null);
  assert.strictEqual(rankEmail("solid@solidict.com", "solidict.com"), 4);
  assert.strictEqual(rankEmail("mert@dataroid.com", "dataroid.com"), 3);
  assert.strictEqual(rankEmail("info-uk@bgts.com", "bgts.com"), 4);

  // Replies: quoted text is dropped, redirects found, signatures ignored, auto-replies skipped.
  const H = (o = {}) => new Map(Object.entries(o));
  const quoted = "Merhaba Ulaş,\nBaşvurunuzu lütfen ik@acme.com adresine gönderin.\n\nAyşe Kaya\nayse@acme.com\n\n7 Eki 2026 Sal, 10:12 tarihinde Ulaş <me@example.com> şunu yazdı:\n> Merhaba info@acme.com";
  const r1 = classifyReply({ text: quoted, subject: "Re: Junior", headers: H(), from: "ayse@acme.com", knownEmails: ["info@acme.com"] });
  assert.deepStrictEqual([r1.type, r1.email], ["redirect", "ik@acme.com"]);
  const r2 = classifyReply({ text: "Thanks, we'll keep your CV on file.\n\nJohn Smith\nCTO\njohn@acme.com\n+90 555", subject: "Re: Junior", headers: H(), from: "john@acme.com", knownEmails: [] });
  assert.strictEqual(r2.type, "reply");
  const r3 = classifyReply({ text: "I am out of office until Monday.", subject: "Otomatik yanıt: Junior", headers: H({ "auto-submitted": "auto-replied" }), from: "info@acme.com", knownEmails: [] });
  assert.strictEqual(r3.type, "ignore");
  const r4 = classifyReply({ text: "Out of office. For job applications please email careers@acme.com", subject: "Automatic reply", headers: H(), from: "info@acme.com", knownEmails: ["info@acme.com"] });
  assert.deepStrictEqual([r4.type, r4.email], ["redirect", "careers@acme.com"]);
  const r5 = classifyReply({ text: "Hi Ulas, the right person is our CTO, you can reach him at\nmehmet.demir@gmail.com", subject: "Re", headers: H(), from: "info@acme.com", knownEmails: [] });
  assert.strictEqual(r5.email, "mehmet.demir@gmail.com");
  const r6 = classifyReply({ text: "Please apply here: https://acme.com/kariyer/junior-dev", subject: "Re", headers: H(), from: "info@acme.com", knownEmails: [] });
  assert.deepStrictEqual([r6.type, r6.link], ["reply", "https://acme.com/kariyer/junior-dev"]);
  const ref = draftFor({ company: "Acme", city: "İstanbul", lang: "tr", email: "ik@acme.com", kind: "redirect", referred_by: "Ayşe Kaya" });
  assert.ok(ref.body.includes("Ayşe Kaya beni size yönlendirdi"));
  // Domain guesses, reply classes, reminder draft.
  assert.deepStrictEqual(guessDomains("Nuevo Softwarehouse Ltd. Şti.").slice(0, 3), ["nuevo.com", "nuevo.com.tr", "nuevo.io"]);
  assert.ok(guessDomains("Nuevo Softwarehouse").includes("nuevosoftwarehouse.com"));
  assert.strictEqual(replyClass("Merhaba, CV'nizi inceledik, bu hafta kısa bir görüşme yapabilir miyiz?"), "interested");
  assert.strictEqual(replyClass("Maalesef şu an açık pozisyonumuz yok, CV'nizi havuzumuza kaydettik."), "later");
  assert.strictEqual(replyClass("Unfortunately we have decided not to move forward."), "no");
  assert.strictEqual(replyClass("Teşekkürler."), "unknown");
  const bump = draftFor({ company: "Acme", lang: "tr", kind: "bump", subject: "Junior Full Stack Developer – Test" });
  assert.ok(bump.subject.startsWith("Re: Junior") && bump.body.includes("tekrar hatırlatmak"));
  console.log("outreach self-check OK");
  process.exit(0);
}
