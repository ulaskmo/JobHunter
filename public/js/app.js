let currentPage = 0;
const PAGE_SIZE = 50;
let searchTimeout = null;

// ─── Load Stats ───────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();
    const s = data.stats;
    document.getElementById("statTotal").textContent = `${s.total} total`;
    document.getElementById("statNew").textContent = `${s.new_count} new`;
    document.getElementById("statApplied").textContent = `${s.applied_count} applied`;
    document.getElementById("statInterview").textContent = `${s.interview_count} interview`;
  } catch (e) {
    console.error("Failed to load stats:", e);
  }
}

// ─── Load Jobs (Left Panel) ───────────────────────────────────────────────────
async function loadJobs(page = 0) {
  currentPage = page;
  const params = new URLSearchParams({
    status: "new",
    source: document.getElementById("sourceFilter").value,
    location: document.getElementById("locationFilter").value,
    priority: document.getElementById("priorityFilter").value,
    time: document.getElementById("timeFilter").value,
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
      list.innerHTML = '<div class="loading">No jobs found. Try adjusting filters or scan for new jobs.</div>';
      document.getElementById("pagination").innerHTML = "";
      return;
    }

    list.innerHTML = data.jobs.map((job) => renderJobCard(job, false)).join("");
    renderPagination(data.total, page);
  } catch (e) {
    list.innerHTML = '<div class="loading">Error loading jobs.</div>';
  }
}

// ─── Load Applied (Right Panel) ───────────────────────────────────────────────
async function loadApplied() {
  const sort = document.getElementById("appliedSort").value;
  const params = new URLSearchParams({
    status: "applied",
    sort: sort,
    limit: 200,
    offset: 0,
  });

  const list = document.getElementById("appliedList");

  try {
    const res = await fetch(`/api/jobs?${params}`);
    const data = await res.json();
    document.getElementById("rightCount").textContent = data.total;

    // Also load interview status jobs
    const intRes = await fetch(`/api/jobs?status=interview&limit=200`);
    const intData = await intRes.json();
    const allApplied = [...intData.jobs, ...data.jobs];

    if (allApplied.length === 0) {
      list.innerHTML = '<div class="loading">No applications yet.<br>Apply to jobs from the left panel!</div>';
      return;
    }

    list.innerHTML = allApplied.map((job) => renderJobCard(job, true)).join("");
  } catch (e) {
    list.innerHTML = '<div class="loading">Error loading applied jobs.</div>';
  }
}

// ─── Render Job Card ──────────────────────────────────────────────────────────
function renderJobCard(job, isAppliedPanel) {
  const ratingClass = job.score >= 70 ? "rating-high" : job.score >= 50 ? "rating-medium" : "rating-low";
  const rating = job.rating || "+";

  // Build tags
  let tags = "";
  const textLower = `${job.title} ${job.location} ${job.description} ${job.tags || ""}`.toLowerCase();
  if (job.is_remote) tags += '<span class="tag tag-remote">Remote</span>';
  if (textLower.match(/machine learning|ai engineer|artificial intelligence|deep learning|mlops|data scien/))
    tags += '<span class="tag tag-ai">AI/ML</span>';
  if (textLower.match(/junior|entry.level|graduate|intern|trainee/))
    tags += '<span class="tag tag-junior">Junior</span>';
  if (textLower.match(/ireland|dublin|cork|galway|sligo/))
    tags += '<span class="tag tag-ireland">Ireland</span>';
  if (textLower.match(/istanbul|turkey|türkiye/))
    tags += '<span class="tag tag-turkey">Turkey</span>';
  if (textLower.match(/london|uk|germany|berlin|netherlands|france|europe|spain|portugal|sweden|denmark|norway|poland|switzerland/))
    tags += '<span class="tag tag-europe">Europe</span>';
  if (job.is_easy_apply) tags += '<span class="tag tag-easy">Easy Apply</span>';
  tags += `<span class="tag tag-source">${job.source}</span>`;

  if (isAppliedPanel) {
    const statusClass = job.status === "interview" ? "status-interview" : "status-applied";
    const statusLabel = job.status === "interview" ? "Interview" : "Applied";
    const appliedDate = job.applied_at ? new Date(job.applied_at).toLocaleDateString() : "";
    return `
      <div class="job-card" onclick="showDetail(${job.id})">
        <div class="job-info">
          <div class="job-title">${escapeHtml(job.title)}</div>
          <div class="job-meta">
            <span>${escapeHtml(job.company || "")}</span>
            <span>${escapeHtml(job.location || "")}</span>
          </div>
          <div class="job-tags">${tags}</div>
          ${appliedDate ? `<div class="applied-date">Applied ${appliedDate}</div>` : ""}
        </div>
        <span class="applied-status ${statusClass}">${statusLabel}</span>
      </div>
    `;
  }

  const company = job.company || "Unknown";
  const location = job.location || "Unknown";
  // Prefer the job's real posting date; fall back to when we scraped it.
  const timeAgo = getTimeAgo(job.posted_date || job.scraped_at);

  return `
    <div class="job-card" onclick="showDetail(${job.id})">
      <div class="job-rating ${ratingClass}">${escapeHtml(rating)}</div>
      <div class="job-info">
        <div class="job-title">${escapeHtml(job.title)}</div>
        <div class="job-meta">
          <span>${escapeHtml(company)}</span>
          <span>${escapeHtml(location)}</span>
          <span>${timeAgo}</span>
        </div>
        <div class="job-tags">${tags}</div>
      </div>
      <div class="job-actions">
        <button class="btn-apply" onclick="event.stopPropagation();markApplied(${job.id})">Apply</button>
        <button class="btn-save" onclick="event.stopPropagation();updateStatus(${job.id},'saved')">Save</button>
        <button class="btn-hide" onclick="event.stopPropagation();updateStatus(${job.id},'hidden')">Hide</button>
      </div>
    </div>
  `;
}

function renderPagination(total, current) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) { document.getElementById("pagination").innerHTML = ""; return; }
  let html = "";
  for (let i = 0; i < totalPages && i < 10; i++) {
    html += `<button class="${i === current ? "active" : ""}" onclick="loadJobs(${i})">${i + 1}</button>`;
  }
  document.getElementById("pagination").innerHTML = html;
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function markApplied(id) {
  // Open the job link first, then mark as applied
  try {
    const res = await fetch(`/api/jobs/${id}`);
    const job = await res.json();
    window.open(job.url, "_blank");
  } catch (e) {}
  await updateStatus(id, "applied");
}

async function updateStatus(id, status) {
  try {
    await fetch(`/api/jobs/${id}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    loadJobs(currentPage);
    loadApplied();
    loadStats();
  } catch (e) {
    console.error("Failed to update:", e);
  }
}

// ─── Job Detail Modal ─────────────────────────────────────────────────────────
async function showDetail(id) {
  try {
    const res = await fetch(`/api/jobs/${id}`);
    const job = await res.json();
    const modal = document.getElementById("jobModal");
    const body = document.getElementById("modalBody");
    const ratingClass = job.score >= 70 ? "rating-high" : job.score >= 50 ? "rating-medium" : "rating-low";

    body.innerHTML = `
      <h2>${escapeHtml(job.title)}</h2>
      <div class="detail-company">${escapeHtml(job.company || "Unknown")}</div>
      <span class="detail-rating ${ratingClass}">${escapeHtml(job.rating || "+")}</span>
      <div class="detail-meta">
        Location: ${escapeHtml(job.location || "N/A")}<br>
        Source: ${job.source}<br>
        Status: ${job.status}<br>
        ${job.salary ? `Salary: ${escapeHtml(job.salary)}<br>` : ""}
        ${job.posted_date ? `Posted: ${new Date(job.posted_date).toLocaleDateString()}<br>` : ""}
        Found: ${new Date(job.scraped_at).toLocaleString()}
      </div>
      <div class="detail-breakdown"><strong>Match Breakdown:</strong>\n${escapeHtml(job.score_breakdown || "No details")}</div>
      ${job.description ? `<div class="detail-desc">${escapeHtml(job.description)}</div>` : ""}
      <div class="detail-actions">
        <a href="${escapeHtml(job.url)}" target="_blank">Open Job Posting</a>
        <button class="btn-apply" onclick="markApplied(${job.id});closeModal()">Apply & Mark</button>
        <button class="btn-save" onclick="updateStatus(${job.id},'saved');closeModal()">Save</button>
        <button class="btn-interview" onclick="updateStatus(${job.id},'interview');closeModal()">Interview</button>
        <button class="btn-hide" onclick="updateStatus(${job.id},'hidden');closeModal()">Hide</button>
      </div>
    `;
    modal.classList.add("active");
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
    setTimeout(() => { loadJobs(0); loadApplied(); loadStats(); }, 5000);
    setTimeout(() => { loadJobs(0); loadApplied(); loadStats(); btn.textContent = "Scan Now"; btn.classList.remove("loading"); }, 60000);
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

function getTimeAgo(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "Just now";
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
setInterval(() => { loadStats(); }, 120000);
