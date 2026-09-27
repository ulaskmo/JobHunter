// ─── Job Scoring Engine ───────────────────────────────────────────────────────
//
// Score is 0–100 in the DB, shown as 0.0–10.0. Each job lands in a tier band,
// then "fit" (stack, level, AI) places it inside the band:
//
//   S  8.0–10.0  Ireland/Turkey (remote or on-site) + stack match,
//                or any Turkey/remote role at a top Turkish company
//   A  6.0–7.9   Remote anywhere (not US-restricted), cyber security,
//                or Ireland/Turkey without a stack match
//   B  4.0–5.9   On-site in UK/Europe/Canada/Singapore/Gulf/ANZ/Japan
//
// HIDDEN: US-only (citizenship, clearance, green card, US-located), on-site
// elsewhere, senior/lead/manager titles, non-software titles.
// Requiring 5+ years demotes one tier.

const LOCATIONS = {
  ireland: [
    "ireland", "dublin", "cork", "galway", "limerick", "sligo",
    "waterford", "belfast", "mayo", "athlone", "kilkenny", "wexford"
  ],
  turkey: [
    "turkey", "türkiye", "turkiye", "türkçe",
    "istanbul", "i̇stanbul", "ıstanbul", "istambul",
    "ankara", "izmir", "i̇zmir", "bursa", "antalya", "adana",
    "kocaeli", "gebze", "eskişehir", "eskisehir", "konya", "kayseri",
    "gaziantep", "mersin", "diyarbakir", "diyarbakır",
    "sakarya", "samsun", "trabzon", "denizli",
    "teknopark", "teknokent", "itü", "odtü", "bilkent",
    "levent", "maslak", "kadıköy", "kadikoy", "şişli", "sisli",
    "ataşehir", "atasehir", "beşiktaş", "besiktas",
  ],
  uk: [
    "united kingdom", "london", "manchester", "birmingham",
    "edinburgh", "glasgow", "bristol", "leeds", "liverpool", "cambridge",
    "oxford", "england", "scotland", "wales", "northern ireland"
  ],
  europe: [
    "germany", "berlin", "munich", "hamburg", "frankfurt",
    "netherlands", "amsterdam", "rotterdam", "den haag",
    "france", "paris", "lyon", "spain", "barcelona", "madrid",
    "portugal", "lisbon", "porto", "sweden", "stockholm",
    "denmark", "copenhagen", "norway", "oslo", "finland", "helsinki",
    "poland", "warsaw", "krakow", "czech", "prague",
    "austria", "vienna", "switzerland", "zurich", "geneva",
    "belgium", "brussels", "italy", "milan", "rome", "luxembourg",
    "estonia", "tallinn", "latvia", "riga", "lithuania", "vilnius",
    "romania", "bucharest", "hungary", "budapest", "greece", "athens",
    "cyprus", "limassol", "malta", "iceland",
    "europe",
  ],
  usa: [
    "united states", "usa", "new york", "san francisco",
    "los angeles", "chicago", "seattle", "boston", "austin", "denver",
    "miami", "atlanta", "portland", "california", "texas", "washington"
  ],
  canada: [
    "canada", "toronto", "vancouver", "montreal", "montréal", "ottawa",
    "calgary", "edmonton", "waterloo", "ontario", "british columbia", "quebec",
  ],
  singapore: ["singapore"],
  gulf: [
    "united arab emirates", "uae", "dubai", "abu dhabi", "sharjah", "ajman",
    "qatar", "doha", "saudi arabia", "riyadh", "jeddah", "bahrain", "manama",
    "kuwait", "sultanate of oman", "muscat",
  ],
  anz: ["australia", "sydney", "melbourne", "brisbane", "perth", "new zealand", "auckland", "wellington"],
  asia: ["japan", "tokyo", "hong kong", "south korea", "seoul"],
  remote: [
    "remote", "work from home", "wfh", "distributed", "anywhere",
    "fully remote", "remote-first", "hybrid remote", "work from anywhere",
    "uzaktan", "hibrit", "evden çalışma", "evden calisma"
  ],
  // Countries to EXCLUDE (in-office only)
  excluded: [
    "colombia", "bogota", "medellin", "india", "bangalore", "mumbai",
    "hyderabad", "pune", "chennai", "delhi", "philippines", "manila",
    "cebu", "nigeria", "lagos", "pakistan", "karachi", "lahore",
    "bangladesh", "dhaka", "vietnam", "hanoi", "indonesia", "jakarta",
    "kenya", "nairobi", "egypt", "cairo", "mexico", "guadalajara",
    "argentina", "buenos aires", "brazil", "sao paulo",
    "south africa", "cape town", "china", "beijing", "shanghai",
    "malaysia", "kuala lumpur", "thailand", "bangkok",
    "costa rica", "peru", "lima", "chile", "santiago",
    "ghana", "ethiopia", "uganda", "tanzania", "morocco"
  ]
};

const KEYWORDS = {
  // Title-level AI/ML signals. Bonus only if TITLE matches — not if "ai/ml" is
  // mentioned somewhere in a long MongoDB description.
  ai_ml_title: [
    "machine learning", "ml engineer", "ai engineer", "ai developer",
    "data scientist", "nlp engineer", "computer vision",
    "deep learning", "llm engineer", "mlops",
    "yapay zeka", "makine öğrenmesi", "veri bilimci",
  ],
  skills: [
    "c#", "csharp", ".net", "blazor", "asp.net", "node.js", "nodejs",
    "typescript", "javascript", "react", "angular", "python", "java",
    "sql", "aws", "azure", "blockchain", "solidity", "express",
    "full stack", "fullstack", "full-stack", "backend", "back-end",
    "frontend", "front-end", "web developer", "software engineer",
    "software developer", "devops", "cloud", "api", "microservices"
  ],
  // Title must contain one of these for a junior bonus to apply.
  junior_title: [
    "junior", "jr.", "jr ", "entry-level", "entry level",
    "graduate", "new grad", "new-grad",
    "intern ", " intern", "trainee", "associate",
    "junior yazılım", "junior yazilim",
    "stajyer", "yeni mezun",
  ],
  // Additional body signals that reinforce junior intent — matched with word
  // boundaries so "intern" doesn't trigger on "international".
  junior_body: [
    "junior", "entry level", "entry-level", "new grad", "new-grad",
    "graduate program", "graduate scheme", "early career", "early-career",
    "0-1 year", "0-2 year", "1-2 year",
  ],
  // Hard exclusions — title must NOT contain these for the job to stay.
  senior_title: [
    "senior", "sr.", "snr", "snr.", "principal", "staff",
    "lead engineer", "lead developer", "lead software",
    "tech lead", "team lead", "engineering lead", "architect",
    "head of", " head,", "director", "vp ", "vp,", "vice president",
    "manager", "cto", "ceo", "distinguished", "fellow",
    // "II" / "2" is mid-level and allowed; III and up are senior.
    "engineer iii", "developer iii", "engineer iv", "developer iv",
    "software engineer 3", "software engineer iii",
    "kıdemli", "üst düzey",
  ],
  // Titles we can't use. `engineer` alone is ambiguous; we keep the software
  // whitelist elsewhere.
  software_title: [
    "software", "developer", "full stack", "fullstack", "full-stack",
    "frontend", "front-end", "front end", "backend", "back-end", "back end",
    "web developer", "web engineer", "mobile developer", "mobile engineer",
    "devops", "dev ops", "cloud engineer", "cloud developer",
    "data engineer", "data scientist", "data analyst",
    "machine learning", "ml engineer", "ai engineer",
    "python developer", "java developer", "javascript developer",
    ".net developer", "c# developer", "node developer", "node.js",
    "react developer", "angular developer", "typescript developer",
    "platform engineer", "sre", "site reliability",
    "qa engineer", "qa developer", "test engineer", "sdet",
    "automation engineer", "infrastructure engineer",
    "programmer", "coder",
    "it developer", "application developer", "applications developer",
    "systems developer", "solutions developer",
    "software engineer", "software developer",
    "junior developer", "junior engineer", "graduate developer",
    "graduate engineer", "trainee developer", "intern developer",
    "blockchain developer", "smart contract",
    "api developer", "microservices",
    // Turkish
    "yazılım", "yazilim", "geliştirici", "gelistirici",
    "yazılım mühendisi", "yazılım geliştirici",
    "yazılım uzmanı", "yazılım uzmani",
    "mobil geliştirici", "mobil gelistirici",
    "veri bilimci", "veri mühendisi", "veri muhendisi", "veri analisti",
    "yapay zeka", "makine öğrenmesi", "makine ogrenmesi",
    "bulut mühendisi", "bulut muhendisi",
    "sistem geliştirici", "sistem gelistirici",
    "stajyer yazılım", "stajyer yazilim",
    "junior yazılım", "junior yazilim",
    "programcı", "programci", "bilgisayar mühendisi", "bilgisayar muhendisi",
    "uygulama geliştirici", "uygulama gelistirici",
    // ERP / SAP
    "erp", "abap", "sap developer", "sap consultant", "sap danışmanı",
    "dynamics 365", "d365", "dynamics crm",
  ],
  non_software: [
    "validation engineer", "mechanical engineer", "electrical engineer",
    "civil engineer", "chemical engineer", "process engineer",
    "manufacturing engineer", "production engineer", "quality engineer",
    "structural engineer", "biomedical engineer", "environmental engineer",
    "hardware engineer", "rf engineer", "power engineer", "audio engineer",
    "sound engineer", "field engineer", "maintenance engineer",
    "reliability engineer", "safety engineer", "test engineer",
    "industrial engineer", "plant engineer", "project engineer",
    "sales engineer", "support engineer", "service engineer",
    "network engineer", "systems engineer", "security analyst",
    "nurse", "doctor", "accountant", "lawyer", "mechanic",
    "truck driver", "plumber", "electrician", "chef", "teacher",
    "sales representative", "sales manager", "marketing manager",
    "hr manager", "hr specialist", "recruiter", "talent acquisition",
    "receptionist", "cashier", "warehouse", "retail", "customer service",
    "administrative", "secretary", "dental", "pharmacist",
    "graphic designer", "ux designer", "ui designer", "product designer",
    "product manager", "project manager", "scrum master",
    "business analyst", "financial analyst", "supply chain",
    "procurement", "logistics", "operations manager",
    "content writer", "copywriter", "social media"
  ]
};

// Escape regex special chars so keywords like "c#", ".net", "jr." work as
// literal matches when we embed them in a \b...\b pattern.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Substring helper — unchanged, used where word-boundary isn't helpful
// (location pieces like ", tr" or Turkish characters that \b mishandles).
function includesAny(text, list) {
  for (const kw of list) if (text.includes(kw)) return true;
  return false;
}

// Word-boundary match — "intern" won't match "international". For phrases we
// anchor at both ends so "2 years" still matches "needs 2 years experience".
function wordMatch(text, kw) {
  if (!kw) return false;
  const esc = escapeRegex(kw);
  // For keywords that start/end with a non-word char (c#, .net, jr.), skip \b
  // on the adjacent side because \b needs a word transition.
  const needsLeft = /^[\w]/.test(kw);
  const needsRight = /[\w]/.test(kw[kw.length - 1]);
  const pattern = (needsLeft ? "\\b" : "") + esc + (needsRight ? "\\b" : "");
  return new RegExp(pattern, "i").test(text);
}

function matchesAnyWord(text, list) {
  for (const kw of list) if (wordMatch(text, kw)) return true;
  return false;
}

function filterWords(text, list) {
  return list.filter((kw) => wordMatch(text, kw));
}

// Extract the largest "N+ years" or "N-M years" figure from free text. Used
// to demote listings that require many years of experience.
function maxYearsRequired(text) {
  let max = 0;
  const re = /\b(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?(?:years?|yrs?|yıl)\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
    if (max >= 15) break; // plenty
  }
  return max;
}

// Top Turkish companies whose ATS boards we poll directly (scrapers/boards.js).
const TR_COMPANIES = new Set([
  "trendyol", "insiderone", "peakgames", "dreamgames", "iyzico", "picus",
  "commencis", "dataroid", "ciceksepeti", "getmidas", "codeway", "agave",
  "biggergames", "goodjobgames", "loopgames", "obilet", "n11",
]);

// Core stack from the user's preferences — drives S-tier eligibility and fit.
const CORE_STACK = [
  "c#", ".net", "asp.net", "blazor", "sql", "typescript", "javascript",
  "python", "java", "aws", "node.js", "react",
];

const CYBER_TITLE = [
  "security engineer", "cyber security", "cybersecurity", "security analyst",
  "soc analyst", "penetration tester", "pentester", "appsec",
  "application security", "devsecops", "information security",
  "security operations", "incident response", "vulnerability",
  "threat intelligence", "siber güvenlik", "bilgi güvenliği",
];

const MID_TITLE = [
  "mid", "mid-level", "mid level", "intermediate", "engineer ii",
  "developer ii", "software engineer 2", "engineer 2", "developer 2",
];

// Remote only if the listing itself says so — not because "remote" appears
// somewhere in a long description.
const REMOTE_PHRASES = [
  "fully remote", "100% remote", "remote-first", "remote first",
  "work from anywhere", "remote position", "remote role", "this role is remote",
  "tamamen uzaktan", "uzaktan çalışma",
];
const REMOTE_ONLY_SOURCES = new Set(["remoteok", "remotive", "jobicy", "weworkremotely"]);
const REMOTE_OPEN = ["anywhere", "worldwide", "global", "emea", "europe", "international"];

const US_STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
const US_LOCATION_RE = new RegExp(`(,\\s*(${US_STATES})\\b)|\\b(united states|usa|u\\.s\\.a?\\.?|us)\\b|\\b(new york|san francisco|seattle|boston|austin|chicago|los angeles|denver|atlanta|miami|bay area)\\b`, "i");

// Things you can't satisfy — hide the job outright.
const US_ONLY_TEXT = [
  /\b(u\.?s\.?|united states|american) citizen(s|ship)?\b/i,
  /\bsecurity clearance\b|\b(ts\/sci|top secret|secret clearance|public trust clearance)\b/i,
  /\bgreen card\b/i,
  /\b(authori[sz]ed|eligible|legally able) to work in the (u\.?s\.?a?|united states)\b/i,
  /\b(reside|live|be located|be based|located) (in|within) the (u\.?s\.?a?|united states|contiguous)\b/i,
  /\b(us|u\.s\.|usa|united states)[- ](only|based candidates|residents? only)\b/i,
  /\b(north america|americas|us time ?zones?)[- ]only\b/i,
  /\bitar\b|\bus persons?\b/i,
];
const NO_SPONSOR_RE = /\b(no|not|unable to|cannot|can't|will not|won't|do not|does not) (provide |offer )?(visa |work permit )?sponsor/i;

function scoreJob(job) {
  const title = (job.title || "").toLowerCase();
  const location = (job.location || "").split("\n")[0].trim();
  const locLower = location.toLowerCase();
  const desc = (job.description || "").toLowerCase();
  const tags = (job.tags || "").toLowerCase();
  const text = `${title} ${job.company || ""} ${locLower} ${desc} ${tags}`.toLowerCase();
  const hide = (why) => ({ score: 0, rating: "-", breakdown: `✕ ${why}`, is_remote: 0, hidden: true, filter_reason: why });

  // ─── Step 1: Is this a role we want at all? ────────────────────────────────
  const isCyber = matchesAnyWord(title, CYBER_TITLE);
  if (!isCyber && matchesAnyWord(title, KEYWORDS.non_software)) return hide("Not a software role");
  if (!isCyber && !matchesAnyWord(title, KEYWORDS.software_title)) return hide("Title doesn't match software roles");
  if (matchesAnyWord(title, KEYWORDS.senior_title)) return hide(`Senior/lead title ("${job.title}")`);

  // ─── Step 2: Where is it, and can the user apply? ──────────────────────────
  // Location comes from the location field + title; the description is only a
  // fallback when the listing has no location.
  const locText = location ? `${title} ${locLower} ${tags}` : text;
  const company = (job.company || "").toLowerCase().replace(/\s+/g, "");
  const isTRCompany = TR_COMPANIES.has(company);

  const isRemote =
    REMOTE_ONLY_SOURCES.has(job.source) ||
    (job.source === "linkedin" && job.is_remote === 1) ||
    includesAny(`${title} ${locLower} ${tags}`, LOCATIONS.remote) ||
    locLower === "telecommute" ||
    includesAny(desc, REMOTE_PHRASES);
  const isIreland = includesAny(locText, LOCATIONS.ireland);
  const isTurkey = includesAny(locText, LOCATIONS.turkey);
  const isAbroadOK = ["uk", "europe", "canada", "singapore", "gulf", "anz", "asia"]
    .some((k) => includesAny(locText, LOCATIONS[k]));
  const isUSLoc = US_LOCATION_RE.test(location) && !isIreland && !isTurkey && !isAbroadOK
    && !includesAny(locLower, REMOTE_OPEN);
  const isExcluded = includesAny(locText, LOCATIONS.excluded) && !isIreland && !isTurkey && !isAbroadOK;
  const isHome = isIreland || isTurkey;

  for (const re of US_ONLY_TEXT) if (re.test(text)) return hide("US citizenship/clearance/work authorization required");
  if (isUSLoc) return hide(`US-based (${location})`);
  if (isExcluded) return hide(`Excluded location (${location})`);
  if (!isHome && !isRemote && !isAbroadOK && !(isTRCompany && !location)) return hide(`On-site outside target countries (${location || "unknown"})`);
  if (!isHome && !isRemote && NO_SPONSOR_RE.test(text)) return hide("On-site abroad, no visa sponsorship");

  // ─── Step 3: Tier ──────────────────────────────────────────────────────────
  // LinkedIn cards arrive with a placeholder "Title at Company - Location"
  // until enrichment fetches the real text — then the stack is unknown, not absent.
  const hasDesc = desc.length >= 300 && !desc.startsWith(`${title} at `);
  const stack = filterWords(`${title} ${desc} ${tags}`, CORE_STACK);
  const isAI = matchesAnyWord(title, KEYWORDS.ai_ml_title);
  const lines = [];
  let tier;
  if (isTRCompany && (isTurkey || isRemote || !location)) {
    tier = "S"; lines.push(`Tier S · top Turkish company (${job.company})`);
  } else if (isHome && (stack.length || isAI || !hasDesc)) {
    tier = "S"; lines.push(`Tier S · ${isIreland ? "Ireland" : "Turkey"}${isRemote ? " (remote)" : ""}${hasDesc || stack.length ? " + your stack" : " · stack unknown (no description yet)"}`);
  } else if (isHome) {
    tier = "A"; lines.push(`Tier A · ${isIreland ? "Ireland" : "Turkey"}, no stack match`);
  } else if (isCyber) {
    tier = "A"; lines.push(`Tier A · cyber security${isRemote ? " (remote)" : ""}`);
  } else if (isRemote) {
    tier = "A"; lines.push("Tier A · remote");
  } else {
    tier = "B"; lines.push(`Tier B · on-site abroad (${location})`);
  }

  const yearsReq = maxYearsRequired(text);
  if (yearsReq >= 5) {
    const demoted = { S: "A", A: "B", B: "B" }[tier];
    lines.push(`− Asks for ${yearsReq}+ years → ${tier === demoted ? "bottom of tier" : `demoted ${tier}→${demoted}`}`);
    tier = demoted;
  }

  // ─── Step 4: Fit inside the tier (0..1) ────────────────────────────────────
  let fit = 0;
  // Unknown stack counts as one match (neutral), not zero.
  const stackPts = Math.min(Math.max(stack.length, hasDesc ? 0 : 1) / 3, 1) * 0.4;
  fit += stackPts;
  if (stack.length) lines.push(`+${(stackPts * 2).toFixed(1)} stack: ${stack.slice(0, 6).join(", ")}`);

  let levelPts = 0.1, levelWhy = "level not stated";
  if (matchesAnyWord(title, KEYWORDS.junior_title)) { levelPts = 0.3; levelWhy = "junior / new grad title"; }
  else if (matchesAnyWord(title, MID_TITLE)) { levelPts = 0.25; levelWhy = "mid-level title"; }
  else if (matchesAnyWord(text, KEYWORDS.junior_body) && yearsReq <= 2) { levelPts = 0.2; levelWhy = "junior-friendly description"; }
  fit += levelPts;
  lines.push(`+${(levelPts * 2).toFixed(1)} ${levelWhy}`);

  if (isAI) { fit += 0.2; lines.push("+0.4 AI/ML role"); }
  if (isRemote && isHome) { fit += 0.1; lines.push("+0.2 remote in Ireland/Turkey"); }
  else if (job.is_easy_apply) { fit += 0.05; lines.push("+0.1 Easy Apply"); }
  if (yearsReq >= 3 && yearsReq < 5) { fit -= 0.1; lines.push(`−0.2 asks for ${yearsReq} years`); }
  if (yearsReq >= 5) fit = Math.min(fit, 0.2);

  fit = Math.max(0, Math.min(1, fit));
  const low = { S: 80, A: 60, B: 40 }[tier];
  const score = Math.min(tier === "S" ? 100 : low + 19, low + Math.round(fit * 20));

  return { score, rating: tier, breakdown: lines.join("\n"), is_remote: isRemote ? 1 : 0, hidden: false, filter_reason: null };
}

function isPriorityJob(job) {
  return job.score >= 80;
}

module.exports = { scoreJob, isPriorityJob, LOCATIONS, KEYWORDS, TR_COMPANIES };

// Self-check: node scorer.js
if (require.main === module) {
  const assert = require("assert");
  const j = (o) => scoreJob({ source: "linkedin", title: "Software Engineer", company: "Acme", location: "", description: "", tags: "", ...o });
  assert.strictEqual(j({ title: "Junior .NET Developer", location: "Dublin, Ireland", description: "C#, SQL, Azure" }).rating, "S");
  assert.strictEqual(j({ title: "Backend Developer", location: "Istanbul, Türkiye", company: "trendyol" }).rating, "S");
  const longNoStack = "We build embedded firmware for industrial devices. ".repeat(8);
  assert.strictEqual(j({ title: "Junior Developer", location: "Istanbul", description: longNoStack }).rating, "A"); // no stack
  assert.strictEqual(j({ title: "Junior Developer", location: "Istanbul" }).rating, "S"); // stack unknown
  assert.strictEqual(j({ title: "Security Analyst", location: "Remote" }).rating, "A");
  assert.strictEqual(j({ title: "Software Developer", location: "Remote - Worldwide" }).rating, "A");
  assert.strictEqual(j({ title: "Software Developer", location: "Toronto, ON, Canada" }).rating, "B");
  assert.strictEqual(j({ title: "Software Developer", location: "Dubai, United Arab Emirates" }).rating, "B");
  assert.strictEqual(j({ title: "Software Engineer II", location: "Singapore" }).rating, "B");
  assert.ok(j({ title: "Software Engineer", location: "Austin, TX", is_remote: 1 }).hidden);
  assert.ok(j({ title: "Software Engineer", location: "Remote", description: "Must be a U.S. citizen" }).hidden);
  assert.ok(j({ title: "Software Engineer", location: "Remote", description: "active security clearance" }).hidden);
  assert.ok(j({ title: "Software Engineer", location: "Paris", description: "we offer remote flexibility" }).rating === "B");
  assert.ok(j({ title: "Software Engineer", location: "Bangalore, India", is_remote: 1 }).hidden);
  assert.ok(j({ title: "Senior Software Engineer", location: "Dublin" }).hidden);
  assert.ok(j({ title: "AI Engineer | REMOTE (North America only)", location: "Remote" }).hidden);
  assert.ok(j({ title: "Software Engineer", location: "London", description: "We do not offer visa sponsorship" }).hidden);
  const s = j({ title: "Junior AI Engineer", location: "Dublin, Ireland", description: "python aws typescript" });
  assert.ok(s.score >= 95, s.score);
  assert.strictEqual(j({ title: "Software Engineer", location: "Dublin", description: "python, 6+ years experience" }).rating, "A");
  console.log("scorer self-check ok");
}
