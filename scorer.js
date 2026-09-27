// ─── Job Scoring Engine ───────────────────────────────────────────────────────
//
// PREFERENCES (from survey):
//
// S TIER (best):
//   - Remote + Ireland or Turkey/Istanbul
//   - In-office Ireland (might negotiate remote)
//   - In-office Turkey/Istanbul
//
// A TIER (great):
//   - Remote anywhere (USA, UK, Europe, or unspecified)
//
// EXCLUDED (auto-hide):
//   - In-office anywhere except Ireland or Turkey
//   - Countries not in: Ireland, Turkey, UK, Europe, USA (or Remote)
//   - Non-software/tech roles
//   - Senior / Staff / Principal / Lead / Manager titles (user is a junior)
//
// BONUS: Junior/Entry +++ | AI/ML +++ | Skills match ++

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
    "belgium", "brussels", "italy", "milan", "rome",
    "europe",
  ],
  usa: [
    "united states", "usa", "new york", "san francisco",
    "los angeles", "chicago", "seattle", "boston", "austin", "denver",
    "miami", "atlanta", "portland", "california", "texas", "washington"
  ],
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
    "singapore", "malaysia", "kuala lumpur", "thailand", "bangkok",
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
    "engineer iii", "engineer ii", "developer iii", "developer ii",
    "software engineer 3", "software engineer iii", "software engineer ii",
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

function scoreJob(job) {
  const text = `${job.title} ${job.company} ${job.location} ${job.description} ${job.tags || ""}`.toLowerCase();
  const title = (job.title || "").toLowerCase();

  // ─── Step 1: Hard exclusions ───────────────────────────────────────────────
  if (matchesAnyWord(title, KEYWORDS.non_software)) {
    return { score: 0, rating: "-", breakdown: "- Not a software role", is_remote: 0, hidden: true };
  }

  if (!matchesAnyWord(title, KEYWORDS.software_title)) {
    return { score: 0, rating: "-", breakdown: "- Title doesn't match software roles", is_remote: 0, hidden: true };
  }

  // Senior/Staff/Lead/Manager titles — user is a junior; these don't fit.
  // Hide them outright so they stop polluting the top of the list.
  const isSenior = matchesAnyWord(title, KEYWORDS.senior_title);
  if (isSenior) {
    return {
      score: 0,
      rating: "-",
      breakdown: `- Senior/staff/lead title ("${job.title}") — user targets junior roles`,
      is_remote: 0,
      hidden: true,
    };
  }

  // Location detection uses substring matching because the lists contain
  // fragments like "türkiye" where \b is unreliable with non-ASCII.
  const isRemote = includesAny(text, LOCATIONS.remote);
  const isIreland = includesAny(text, LOCATIONS.ireland);
  const isTurkey = includesAny(text, LOCATIONS.turkey);
  const isUK = includesAny(text, LOCATIONS.uk);
  const isEurope = includesAny(text, LOCATIONS.europe);
  const isUSA = includesAny(text, LOCATIONS.usa);
  const isExcludedCountry = includesAny(text, LOCATIONS.excluded);

  if (isExcludedCountry && !isRemote) {
    return { score: 0, rating: "-", breakdown: "- Excluded location (not remote)", is_remote: 0, hidden: true };
  }
  if (!isRemote && !(isIreland || isTurkey)) {
    return { score: 0, rating: "-", breakdown: "- In-office outside Ireland/Turkey", is_remote: 0, hidden: true };
  }

  // Demote (not hide) listings that require a lot of years. Companies will
  // sometimes phrase senior roles without "senior" in the title.
  const yearsReq = maxYearsRequired(text);
  const tooSeniorByYears = yearsReq >= 5;

  // ─── Step 2: Score ─────────────────────────────────────────────────────────
  const plusses = [];
  const minuses = [];
  const breakdown = [];

  // Location tier
  if (isRemote && (isIreland || isTurkey)) {
    plusses.push("+++", "+++");
    if (isIreland) breakdown.push("++++++ Remote + Ireland (S tier)");
    if (isTurkey) breakdown.push("++++++ Remote + Turkey (S tier)");
  } else if (isIreland) {
    plusses.push("+++");
    breakdown.push("+++  Ireland based (S tier - can negotiate remote)");
  } else if (isTurkey) {
    plusses.push("+++");
    breakdown.push("+++  Turkey/Istanbul (S tier)");
  } else if (isRemote) {
    plusses.push("++");
    breakdown.push("++   Remote position (A tier)");
    if (isUSA) { plusses.push("+"); breakdown.push("+    USA based"); }
    if (isUK) { plusses.push("+"); breakdown.push("+    UK based"); }
    if (isEurope) { plusses.push("+"); breakdown.push("+    Europe based"); }
  }

  // Junior bonus — require TITLE match OR clear junior signals in the body.
  // "intern" as a substring of "international" no longer counts.
  const juniorInTitle = matchesAnyWord(title, KEYWORDS.junior_title);
  const juniorInBody = matchesAnyWord(text, KEYWORDS.junior_body);
  if (juniorInTitle) {
    plusses.push("+++");
    breakdown.push("+++  Junior title");
  } else if (juniorInBody && yearsReq <= 2) {
    plusses.push("++");
    breakdown.push("++   Body signals junior-friendly");
  }

  // AI/ML bonus — title-only. Avoids false positives from any company that
  // happens to mention AI in their product description.
  if (matchesAnyWord(title, KEYWORDS.ai_ml_title)) {
    plusses.push("+++");
    breakdown.push("+++  AI/ML role");
  }

  // Skills — word-bounded now. Cap the count so the bonus stays sensible.
  const matchedSkills = filterWords(text, KEYWORDS.skills);
  if (matchedSkills.length >= 4) {
    plusses.push("++");
    breakdown.push(`++   Strong skills match (${matchedSkills.slice(0, 5).join(", ")})`);
  } else if (matchedSkills.length >= 1) {
    plusses.push("+");
    breakdown.push(`+    Skills match (${matchedSkills.slice(0, 4).join(", ")})`);
  }

  if (job.is_easy_apply) {
    plusses.push("+");
    breakdown.push("+    Easy Apply");
  }

  // Penalties
  if (tooSeniorByYears) {
    minuses.push(-15);
    breakdown.push(`-    Requires ${yearsReq}+ years experience`);
  }

  // Calculate: base 30, +5 per plus sign, cap 100, apply minuses last.
  let totalPlus = 0;
  for (const p of plusses) totalPlus += p.length;
  let score = Math.min(100, 30 + totalPlus * 5);
  for (const m of minuses) score += m;
  score = Math.max(0, Math.min(100, score));

  const rating = plusses.join("") || "+";

  return {
    score,
    rating,
    breakdown: breakdown.join("\n") || "+    Standard match",
    is_remote: isRemote ? 1 : 0,
    hidden: false,
  };
}

function isPriorityJob(job) {
  return job.score >= 70;
}

module.exports = { scoreJob, isPriorityJob, LOCATIONS, KEYWORDS };
