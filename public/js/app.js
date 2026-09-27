let currentPage = 0;
let currentView = "new"; // new | saved | hidden | filtered
const PAGE_SIZE = 50;
let searchTimeout = null;

const fmtScore = (score) => (score / 10).toFixed(1);
const tierOf = (job) => (["S", "A", "B"].includes(job.rating) ? job.rating : job.score >= 80 ? "S" : job.score >= 60 ? "A" : "B");

// ─── Load Stats ───────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();
    const s = data.stats;
    document.getElementById("statTotal").textContent = `${s.total} total`;
    document.getElementById("statS").textContent = `${s.priority_count} S tier`;
    document.getElementById("statNew").textContent = `${s.new_count} new`;
    document.getElementById("statApplied").textContent = `${s.applied_count} applied`;
    document.getElementById("statInterview").textContent = `${s.interview_count} interview`;
    document.getElementById("countNew").textContent = s.new_count;
    document.getElementById("countSaved").textContent = s.saved_count;
    document.getElementById("countHidden").textContent = s.hidden_count;
    document.getElementById("countFiltered").textContent = s.filtered_count;

    // Source dropdown follows whatever is actually in the DB.
    const sel = document.getElementById("sourceFilter");
    if (sel.options.length === 1) {
      for (const { source } of data.sources) sel.add(new Option(source, source));
    }
  } catch (e) {
    console.error("Failed to load stats:", e);
  }
}

// ─── Left panel: Opportunities / Saved / Hidden ───────────────────────────────
function setView(view) {
  currentView = view;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  loadJobs(0);
}

async function loadJobs(page = 0) {
  currentPage = page;
  const params = new URLSearchParams({
    status: currentView,
    source: document.getElementById("sourceFilter").value,
    location: document.getElementById("locationFilter").value,
    priority: document.getElementById("priorityFilter").value,
    // Saved/Hidden are lists you curate — don't let the date filter hide them.
    time: currentView === "new" ? document.getElementById("timeFilter").value : "all",
    sort: document.getElementById("sortFilter").value,
    search: document.getElementById("searchInput").value,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const list = document.getElementById("jobsList");
  list.innerHTML = '<div class="loading">Loading...</div>';

  try {
    const res = await fetch(`/api/jobs?${params}`);
    const data = await res.json();
    document.getElementById("leftCount").textContent = data.total;

    if (data.jobs.length === 0) {
      const empty = {
        new: "No jobs found. Try adjusting filters or scan for new jobs.",
        saved: "Nothing saved yet.",
        hidden: "Nothing hidden. Jobs you hide land here so you can bring them back.",
        filtered: "Nothing filtered out by the rules.",
      }[currentView];
      list.innerHTML = `<div class="loading">${empty}</div>`;
      document.getElementById("pagination").innerHTML = "";
      return;
    }

    list.innerHTML = data.jobs.map((job) => renderJobCard(job, false)).join("");
    renderPagination(data.total, page);
  } catch (e) {
    list.innerHTML = '<div class="loading">Error loading jobs.</div>';
  }
}

// ─── Right panel: Applied / Interview ─────────────────────────────────────────
async function loadApplied() {
  const sort = document.getElementById("appliedSort").value;
  const list = document.getElementById("appliedList");

  try {
    const [applied, interview] = await Promise.all(
      ["applied", "interview"].map((status) =>
        fetch(`/api/jobs?${new URLSearchParams({ status, sort, limit: 200 })}`).then((r) => r.json())
      )
    );
    const all = [...interview.jobs, ...applied.jobs];
    document.getElementById("rightCount").textContent = applied.total + interview.total;

    list.innerHTML = all.length
      ? all.map((job) => renderJobCard(job, true)).join("")
      : '<div class="loading">No applications yet.</div>';
  } catch (e) {
    list.innerHTML = '<div class="loading">Error loading applied jobs.</div>';
  }
}

// ─── Render Job Card ──────────────────────────────────────────────────────────
function renderTags(job) {
  let tags = "";
  const loc = `${job.title} ${job.location}`.toLowerCase();
  const text = `${job.title} ${job.location} ${job.description} ${job.tags || ""}`.toLowerCase();
  if (job.is_remote) tags += '<span class="tag tag-remote">Remote</span>';
  if (/machine learning|ai engineer|artificial intelligence|deep learning|mlops|data scien/.test(job.title.toLowerCase()))
    tags += '<span class="tag tag-ai">AI/ML</span>';
  if (/secur|soc analyst|pentest/.test(job.title.toLowerCase())) tags += '<span class="tag tag-cyber">Cyber</span>';
  if (/junior|entry.level|graduate|new grad|intern|trainee/.test(text)) tags += '<span class="tag tag-junior">Junior</span>';
  if (/ireland|dublin|cork|galway|limerick|sligo/.test(loc)) tags += '<span class="tag tag-ireland">Ireland</span>';
  if (/istanbul|turkey|türkiye|ankara|izmir/.test(loc)) tags += '<span class="tag tag-turkey">Turkey</span>';
  if (/canada|toronto|vancouver|montreal|singapore|emirates|dubai|abu dhabi|qatar|saudi|australia|new zealand/.test(loc))
    tags += '<span class="tag tag-abroad">Abroad</span>';
  else if (/london|united kingdom|germany|berlin|netherlands|amsterdam|france|paris|spain|portugal|sweden|denmark|norway|poland|switzerland|europe/.test(loc))
    tags += '<span class="tag tag-europe">Europe</span>';
  if (job.is_easy_apply) tags += '<span class="tag tag-easy">Easy Apply</span>';
  tags += `<span class="tag tag-source">${escapeHtml(job.source)}</span>`;
  return tags;
}

// Buttons change with where the job currently lives.
function actionButtons(job) {
  const b = (cls, label, onclick, title = "") =>
    `<button class="${cls}" title="${title}" onclick="event.stopPropagation();${onclick}">${label}</button>`;
  const info = b("btn-info", "i", `showDetail(${job.id})`, "Details");
  const show = b("btn-show", "Show", `openPosting(${job.id})`, "Open the original posting");
  const applied = b("btn-apply", "Applied", `updateStatus(${job.id},'applied')`, "Mark as applied");
  if (job.filter_reason && job.status === "new")
    return info + show + b("btn-save", "Rescue", `updateStatus(${job.id},'saved')`, "Move to Saved — rules won't touch it again");
  if (job.status === "hidden") return info + show + b("btn-save", "Unhide", `updateStatus(${job.id},'new')`);
  if (job.status === "saved")
    return info + show + applied + b("btn-hide", "Unsave", `updateStatus(${job.id},'new')`) + b("btn-hide", "Hide", `updateStatus(${job.id},'hidden')`);
  return info + show + applied + b("btn-save", "Save", `updateStatus(${job.id},'saved')`) + b("btn-hide", "Hide", `updateStatus(${job.id},'hidden')`);
}

function renderJobCard(job, isAppliedPanel) {
  const tier = tierOf(job);
  const tags = renderTags(job);

  if (isAppliedPanel) {
    const statusLabel = job.status === "interview" ? "Interview" : "Applied";
    const appliedDate = job.applied_at ? sqliteDate(job.applied_at).toLocaleDateString() : "";
    return `
      <div class="job-card tier-${tier}">
        <div class="job-info">
          <div class="job-title">${escapeHtml(job.title)}</div>
          <div class="job-meta">
            <span>${escapeHtml(job.company || "")}</span>
            <span>${escapeHtml(job.location || "")}</span>
          </div>
          ${appliedDate ? `<div class="applied-date">APPLIED ${appliedDate}</div>` : ""}
        </div>
        <span class="applied-status status-${job.status}">${statusLabel}</span>
        <div class="job-actions"><button class="btn-info" title="Details" onclick="showDetail(${job.id})">i</button></div>
      </div>
    `;
  }

  const ruled = job.filter_reason && job.status === "new";
  const badge = ruled
    ? `<div class="job-rating rating-X"><span class="num">✕</span><span class="tier">RULE</span></div>`
    : `<div class="job-rating rating-${tier}"><span class="num">${fmtScore(job.score)}</span><span class="tier">TIER ${tier}</span></div>`;
  return `
    <div class="job-card tier-${ruled ? "X" : tier}">
      ${badge}
      <div class="job-info">
        <div class="job-title">${escapeHtml(job.title)}</div>
        <div class="job-meta">
          <span>${escapeHtml(job.company || "Unknown")}</span>
          <span>${escapeHtml(job.location || "Unknown")}</span>
          <span class="when">${postedLabel(job)}</span>
        </div>
        ${ruled ? `<div class="filter-reason">✕ ${escapeHtml(job.filter_reason)}</div>` : ""}
        <div class="job-tags">${tags}</div>
      </div>
      <div class="job-actions">${actionButtons(job)}</div>
    </div>
  `;
}

function renderPagination(total, current) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) { document.getElementById("pagination").innerHTML = ""; return; }
  let html = "";
  for (let i = 0; i < totalPages && i < 20; i++) {
    html += `<button class="${i === current ? "active" : ""}" onclick="loadJobs(${i})">${i + 1}</button>`;
  }
  document.getElementById("pagination").innerHTML = html;
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function openPosting(id) {
  const win = window.open("", "_blank"); // open synchronously so popup blockers allow it
  const job = await fetch(`/api/jobs/${id}`).then((r) => r.json());
  if (win) win.location = job.url;
}

async function updateStatus(id, status, { undoable = true } = {}) {
  let previous = null;
  try {
    if (undoable) previous = (await fetch(`/api/jobs/${id}`).then((r) => r.json())).status;
    await fetch(`/api/jobs/${id}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    closeModal();
    refreshAll();
    if (previous && previous !== status) {
      const label = { applied: "Marked applied", saved: previous === "new" && currentView === "filtered" ? "Rescued to Saved" : "Saved", hidden: "Hidden", new: "Moved back to opportunities", interview: "Marked interview", rejected: "Marked rejected" }[status];
      showToast(label, () => updateStatus(id, previous, { undoable: false }));
    }
  } catch (e) {
    console.error("Failed to update:", e);
  }
}

let toastTimer = null;
function showToast(text, onUndo) {
  const toast = document.getElementById("toast");
  document.getElementById("toastText").textContent = text;
  document.getElementById("toastUndo").onclick = () => { toast.classList.remove("show"); onUndo(); };
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 6000);
}

function refreshAll() {
  loadJobs(currentPage);
  loadApplied();
  loadStats();
}

// ─── Job Detail Modal ─────────────────────────────────────────────────────────
async function showDetail(id) {
  try {
    const job = await fetch(`/api/jobs/${id}`).then((r) => r.json());
    const tier = tierOf(job);
    const btn = (cls, label, status) => `<button class="${cls}" onclick="updateStatus(${job.id},'${status}')">${label}</button>`;
    const statusButtons = job.filter_reason && job.status === "new"
      ? btn("btn-save", "Rescue to Saved", "saved")
      : {
      new: btn("btn-apply", "Applied", "applied") + btn("btn-save", "Save", "saved") + btn("btn-hide", "Hide", "hidden"),
      saved: btn("btn-apply", "Applied", "applied") + btn("btn-hide", "Unsave", "new") + btn("btn-hide", "Hide", "hidden"),
      hidden: btn("btn-save", "Unhide", "new"),
      applied: btn("btn-interview", "Interview", "interview") + btn("btn-reject", "Rejected", "rejected") + btn("btn-hide", "Undo applied", "new"),
      interview: btn("btn-reject", "Rejected", "rejected") + btn("btn-apply", "Back to applied", "applied"),
      rejected: btn("btn-apply", "Back to applied", "applied"),
    }[job.status] || "";

    document.getElementById("modalBody").innerHTML = `
      <h2>${escapeHtml(job.title)}</h2>
      <div class="detail-company">${escapeHtml(job.company || "Unknown")}</div>
      <div class="detail-head">
        <div class="job-rating rating-${tier}"><span class="num">${fmtScore(job.score)}</span><span class="tier">TIER ${tier}</span></div>
        <div class="detail-meta">
          <b>LOCATION</b>${escapeHtml(job.location || "N/A")}<br>
          ${job.experience_level ? `<b>LEVEL</b>${escapeHtml(job.experience_level)}<br>` : ""}
          ${job.salary ? `<b>SALARY</b>${escapeHtml(job.salary)}<br>` : ""}
          <b>POSTED</b>${job.posted_date ? new Date(job.posted_date).toLocaleDateString() : "unknown"} · ${postedLabel(job)}<br>
          <b>SOURCE</b>${escapeHtml(job.source)} · <b>STATUS</b>${escapeHtml(job.status)}
        </div>
      </div>
      <div class="section-label">Why this score</div>
      <div class="detail-breakdown">${escapeHtml(job.score_breakdown || "No details")}</div>
      ${job.description && !job.description.startsWith(job.title + " at ")
        ? `<div class="section-label">Description</div><div class="detail-desc">${escapeHtml(job.description)}</div>`
        : `<div class="section-label">Description</div><div class="detail-desc">Not fetched yet — hit Show to read it on the original posting.</div>`}
      <div class="detail-actions">
        <button class="btn-show" onclick="openPosting(${job.id})">Show posting</button>
        ${statusButtons}
      </div>
    `;
    document.getElementById("jobModal").classList.add("active");
  } catch (e) {
    console.error("Failed to load detail:", e);
  }
}

function closeModal() { document.getElementById("jobModal").classList.remove("active"); }

// ─── Scrape ───────────────────────────────────────────────────────────────────
async function triggerScrape() {
  const btn = document.getElementById("scrapeBtn");
  btn.textContent = "Scanning...";
  btn.classList.add("loading");
  try {
    await fetch("/api/scrape", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    setTimeout(refreshAll, 5000);
    setTimeout(() => { refreshAll(); btn.textContent = "Scan Now"; btn.classList.remove("loading"); }, 60000);
  } catch (e) {
    btn.textContent = "Scan Failed";
    btn.classList.remove("loading");
  }
}

function debounceSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => loadJobs(0), 300);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// "posted 3d ago" from the real posting date; "found …" when the source has none.
function postedLabel(job) {
  if (job.posted_date) return `posted ${timeAgo(job.posted_date)}`;
  return `found ${timeAgo(sqliteDate(job.scraped_at))}`;
}

// SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
const sqliteDate = (s) => new Date(s.replace(" ", "T") + "Z");

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  if (!Number.isFinite(hours)) return "";
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

// ─── Init ─────────────────────────────────────────────────────────────────────
loadStats();
loadJobs(0);
loadApplied();
setInterval(loadStats, 120000);
