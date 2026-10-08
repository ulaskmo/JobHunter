let currentList = "review";
let rows = [];
let editing = null;

const api = (url, body) => fetch(`/api/outreach${url}`, body === undefined ? {} : {
  method: url.match(/^\/\d+$/) ? "PUT" : "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}).then(async (r) => ({ ok: r.ok, ...(await r.json()) }));

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}
const sqliteDate = (s) => new Date(s.replace(" ", "T") + "Z");
const fmtDate = (s) => (s ? sqliteDate(s).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "");

// ─── Stats ────────────────────────────────────────────────────────────────────
async function loadStats() {
  const s = await api("/stats");
  const b = s.byStatus;
  const n = (k) => b[k] || 0;
  const t = s.totals;
  const sent = t.companies_contacted || 0;
  const total = Object.values(b).reduce((a, x) => a + x, 0);

  document.getElementById("n-review").textContent = n("draft");
  document.getElementById("n-queue").textContent = n("approved");
  document.getElementById("n-sent").textContent = n("sent") + n("bounced") + n("failed");
  document.getElementById("n-replied").textContent = t.replied || 0;
  document.getElementById("n-manual").textContent = n("no_email");
  document.getElementById("n-other").textContent = n("pending") + n("no_site") + n("skipped");

  document.getElementById("headerStats").innerHTML = [
    `${total} companies`, `${n("pending")} to look up`, `${sent} sent`,
    `<b class="chip-s">${t.replied || 0} replies</b>`,
  ].map((t) => `<span class="chip">${t}</span>`).join("");

  const state = !s.configured ? "⚠ sending off — Gmail not set in .env"
    : s.authFailed ? "⚠ Gmail login failed — fix .env and restart"
    : !s.cvFound ? "⚠ cv-tr.pdf missing"
    : `${s.sentToday}/${s.dailyCap} today · ${s.sender}`;
  const el = document.getElementById("sendState");
  el.textContent = state;
  el.classList.toggle("warn", state.startsWith("⚠"));

  const rate = sent ? Math.round(((t.replied || 0) / sent) * 100) : 0;
  document.getElementById("kpis").innerHTML = [
    ["Awaiting review", n("draft")],
    ["In queue", n("approved")],
    ["Companies emailed", sent],
    ["Emails sent", t.emails_sent || 0],
    ["Replies", t.replied || 0],
    ["Reply rate", rate + "%"],
    ["Interested", t.interested || 0],
    ["Not right now", t.later || 0],
    ["Redirected", t.redirects || 0],
    ["Bounced", n("bounced")],
  ].map(([k, v]) => `<div class="kpi"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");

  // 14 day columns, even on days nothing went out.
  const byDay = Object.fromEntries(s.daily.map((d) => [d.day, d]));
  const days = [...Array(14)].map((_, i) => {
    const d = new Date(Date.now() + 3 * 3600e3 - (13 - i) * 86400e3).toISOString().slice(0, 10);
    return { day: d, sent: byDay[d]?.sent || 0, replied: byDay[d]?.replied || 0 };
  });
  const max = Math.max(s.dailyCap, ...days.map((d) => d.sent));
  document.getElementById("bars").innerHTML = days.map((d) => `
    <div class="bar" title="${d.day}: ${d.sent} sent, ${d.replied} replied">
      <div class="col" style="height:${(d.sent / max) * 100}%"><div class="rep" style="height:${d.sent ? (d.replied / d.sent) * 100 : 0}%"></div></div>
      <span>${d.day.slice(8)}</span>
    </div>`).join("") + `<div class="legend"><i class="sw sent"></i>sent <i class="sw rep"></i>replied</div>`;

  document.getElementById("cities").innerHTML =
    `<tr><th>City</th><th>Companies</th><th>Emails</th><th>Sent</th><th>Replies</th></tr>` +
    s.byCity.map((c) => `<tr><td>${esc(c.city)}</td><td>${c.companies}</td><td>${c.emails}</td><td>${c.sent}</td><td>${c.replied}</td></tr>`).join("");
}

// ─── Lists ────────────────────────────────────────────────────────────────────
function setList(list) {
  currentList = list;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.list === list));
  document.getElementById("bulkBar").style.display = list === "review" ? "" : "none";
  document.getElementById("selectAll").checked = false;
  loadList();
}

async function loadList() {
  const el = document.getElementById("list");
  rows = await fetch(`/api/outreach/list?list=${currentList}`).then((r) => r.json());
  document.getElementById("listCount").textContent = rows.length;
  if (!rows.length) {
    el.innerHTML = `<div class="loading">${{
      review: "Nothing to review. New drafts appear as companies are looked up (every hour, or hit Find companies now).",
      queue: "Queue is empty. Approve drafts in Review.",
      sent: "Nothing sent yet.",
      replied: "No replies yet.",
      manual: "No careers-page-only companies.",
      other: "Nothing here.",
    }[currentList]}</div>`;
    return;
  }
  el.innerHTML = rows.map(card).join("");
}

function card(r) {
  const b = (cls, label, onclick, title = "") => `<button class="${cls}" title="${title}" onclick="event.stopPropagation();${onclick}">${label}</button>`;
  const site = r.website ? `<a href="${esc(r.website)}" target="_blank" rel="noopener">${esc(r.domain)}</a>` : "";
  const careers = r.careers_url ? `<a href="${esc(r.careers_url)}" target="_blank" rel="noopener">careers page</a>` : "";
  let actions = "", extra = "", pick = "";

  if (r.status === "draft") {
    pick = `<input type="checkbox" class="pick" value="${r.id}" onclick="event.stopPropagation()">`;
    actions = b("btn-info", "✎", `openEdit(${r.id})`, "Read / edit the email") + b("btn-apply", "Approve", `move([${r.id}],'approved')`) + b("btn-hide", "Skip", `move([${r.id}],'skipped')`);
  } else if (r.status === "approved") {
    actions = b("btn-info", "✎", `openEdit(${r.id})`) + b("btn-hide", "Unqueue", `move([${r.id}],'draft')`);
  } else if (r.status === "sent") {
    actions = b("btn-interview", "Mark replied", `move([${r.id}],'replied')`, "They replied to your main address");
  } else if (r.status === "no_email" || r.status === "no_site" || r.status === "skipped") {
    extra = `<div class="add-email"><input placeholder="paste an email (ik@…)" id="addr-${r.id}" onclick="event.stopPropagation()">${b("", "Add", `addEmail(${r.id})`)}</div>`;
    if (r.status === "skipped") actions = b("btn-hide", "Unskip", `move([${r.id}],'${r.email ? "draft" : "pending"}')`);
  }

  const when = [r.sent_at && `sent ${fmtDate(r.sent_at)}`, r.replied_at && `replied ${fmtDate(r.replied_at)}`].filter(Boolean).join(" · ");
  const kindTag = r.kind === "redirect" ? `<span class="tag tag-turkey">↪ redirected${r.referred_by ? " by " + esc(r.referred_by) : ""}</span>`
    : r.kind === "followup" && ["draft", "approved"].includes(r.status) ? `<span class="tag tag-remote">follow-up</span>` : "";
  const times = r.contact_count > 1 ? `<span class="tag">emailed ${r.contact_count}×</span>` : "";
  const reminder = r.kind === "bump" && r.status === "approved" ? `<span class="tag tag-remote">1-week reminder</span>` : "";
  const src = r.source && r.source !== "jobs" ? `<span class="tag tag-ai">${r.source === "yc" ? "Y Combinator" : "Collective Spark"}</span>` : "";
  const cls = r.replied_at && r.kind !== "redirect" ? `<select class="cls cls-${r.reply_class || "unknown"}" onclick="event.stopPropagation()" onchange="setClass(${r.id}, this.value)">
      ${[["interested", "🔥 Interested"], ["later", "⏳ Not right now"], ["no", "✕ No"], ["unknown", "📬 Unclear"]]
        .map(([v, l]) => `<option value="${v}" ${v === (r.reply_class || "unknown") ? "selected" : ""}>${l}</option>`).join("")}
    </select>` : "";
  const foundOn = r.email_source ? `<a href="${esc(r.email_source)}" target="_blank" rel="noopener" title="Page this address was found on">found here</a>` : "";
  const statusTag = ["sent", "bounced", "failed", "replied"].includes(r.status) ? `<span class="applied-status ost-${r.status}">${r.status}</span>` : "";
  return `
    <div class="job-card" ${r.body ? `onclick="openEdit(${r.id})"` : ""}>
      ${pick}
      <div class="job-info">
        <div class="job-title">${esc(r.company)}</div>
        <div class="job-meta">
          <span>${esc(r.city || "")}</span>
          ${r.email ? `<span>${esc(r.email)}${foundOn ? " · " + foundOn : ""}</span>` : ""}
          ${site ? `<span>${site}</span>` : ""}
          ${careers ? `<span>${careers}</span>` : ""}
          ${when ? `<span class="when">${when}</span>` : ""}
        </div>
        ${r.reply_subject ? `<div class="reply-line">↩ ${esc(r.reply_subject)}</div>` : ""}
        ${r.reply_text ? `<div class="reply-text">${esc(r.reply_text)}</div>` : ""}
        ${r.about ? `<div class="about">${esc(r.about)}</div>` : ""}
        <div class="job-tags">${cls}${kindTag}${reminder}${src}${times}${r.job_title ? `<span class="tag">posted: ${esc(r.job_title)}</span>` : ""}</div>
        ${r.error ? `<div class="filter-reason">${esc(r.error)}</div>` : ""}
        ${extra}
      </div>
      ${statusTag}
      <div class="job-actions">${actions}</div>
    </div>`;
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function move(ids, status, { undo = true } = {}) {
  const before = rows.filter((r) => ids.includes(r.id)).map((r) => r.status);
  const res = await api("/status", { ids, status });
  refresh();
  const label = { approved: "Approved", skipped: "Skipped", draft: "Back to review", replied: "Marked replied", pending: "Will be looked up again" }[status];
  if (undo && res.changed && before[0] && before.every((s) => s === before[0])) {
    showToast(`${label} ${res.changed}`, () => move(ids, before[0], { undo: false }));
  } else if (!res.changed) showToast("Nothing changed");
}

function toggleAll(on) { document.querySelectorAll(".pick").forEach((c) => (c.checked = on)); }
function bulk(status) {
  const ids = [...document.querySelectorAll(".pick:checked")].map((c) => Number(c.value));
  if (ids.length) move(ids, status);
}

async function addEmail(id) {
  const email = document.getElementById(`addr-${id}`).value;
  const res = await api(`/${id}/email`, { email });
  if (!res.ok) return showToast(res.error);
  showToast("Draft created, see Review");
  refresh();
}

function openEdit(id) {
  const r = rows.find((x) => x.id === id);
  if (!r || !r.body) return;
  editing = r;
  const locked = !["draft", "approved"].includes(r.status);
  document.getElementById("editTitle").textContent = r.company;
  document.getElementById("editMeta").textContent = [r.city, r.domain, r.lang === "en" ? "English" : "Türkçe", r.about].filter(Boolean).join(" · ");
  document.getElementById("foundEmails").innerHTML = (r.emails_found || "").split(",").filter(Boolean).map((e) => `<option value="${esc(e)}">`).join("");
  document.getElementById("langBtn").textContent = r.lang === "en" ? "Switch to Türkçe" : "Switch to English";
  for (const [f, v] of [["editEmail", r.email], ["editSubject", r.subject], ["editBody", r.body]]) {
    const el = document.getElementById(f);
    el.value = v || "";
    el.readOnly = locked;
  }
  document.querySelector("#editModal .detail-actions").style.display = locked ? "none" : "";
  document.getElementById("editModal").classList.add("active");
}
function closeEdit() { document.getElementById("editModal").classList.remove("active"); editing = null; }

async function saveEdit(approve) {
  const res = await api(`/${editing.id}`, {
    email: document.getElementById("editEmail").value.trim(),
    subject: document.getElementById("editSubject").value,
    body: document.getElementById("editBody").value,
  });
  if (!res.ok) return showToast(res.error);
  const id = editing.id;
  closeEdit();
  if (approve) move([id], "approved");
  else { showToast("Saved"); refresh(); }
}

async function setClass(id, cls) {
  await api(`/${id}/class`, { cls });
  showToast(cls === "later" ? "They'll come back to Review in 60 days" : "Saved");
  loadStats();
}

async function switchLang() {
  const lang = editing.lang === "en" ? "tr" : "en";
  const res = await api(`/${editing.id}/lang`, { lang });
  if (!res.ok) return showToast(res.error);
  Object.assign(editing, { lang, subject: res.subject, body: res.body });
  openEdit(editing.id);
}

async function discoverNow() {
  const res = await api("/discover", { limit: 25 });
  showToast(res.started ? "Looking up 25 companies… (~1 min)" : "Already running");
  setTimeout(refresh, 45000);
  setTimeout(refresh, 90000);
}
async function checkReplies() {
  showToast("Checking inbox…");
  const res = await api("/check-replies", {});
  showToast(res.skipped ? "Gmail not configured" : res.error ? `Failed: ${res.error}` : `${res.replies || 0} replies, ${res.redirects || 0} redirects, ${res.bounces || 0} bounces`);
  refresh();
}
async function sendTest() {
  const res = await api("/test", {});
  showToast(res.ok ? `Test sent to ${res.to}. Check that inbox` : res.error);
}

let toastTimer;
function showToast(text, onUndo) {
  const t = document.getElementById("toast");
  document.getElementById("toastText").textContent = text;
  const u = document.getElementById("toastUndo");
  u.style.display = onUndo ? "" : "none";
  u.onclick = () => { t.classList.remove("show"); onUndo(); };
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 6000);
}

function refresh() { loadStats(); loadList(); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeEdit(); });

setList("review");
loadStats();
setInterval(loadStats, 60000);
