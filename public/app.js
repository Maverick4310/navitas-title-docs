// 2026-10 (Vendor Title Upload) Vendor upload page. Every value from the server is written with
// textContent (never innerHTML). Each file uploads on its own request, then its check result is
// polled until it finishes; the checklist reloads after each finished check.
const token = new URLSearchParams(location.search).get("token") || "";
const $ = (id) => document.getElementById(id);

const POLL_MS = 4000;
const POLL_MAX = 75; // about 5 minutes

const STATUS = {
  Checking: { text: "Reading your file…", cls: "info", spin: true },
  Passed: { text: "Looks good", cls: "ok" },
  Review: { text: "Needs a closer look", cls: "review" },
  Failed: { text: "Problem: please fix", cls: "problem" },
  "Not Checked": { text: "Received: we will review it by hand", cls: "info" },
  Error: { text: "Received: we will review it by hand", cls: "info" },
};
const DOC_LABEL = {
  "Title/MSO Front": "Title or MSO (front)",
  "Title/MSO Back": "Title or MSO (back) / reassignment",
  "Guaranty of Title": "Guaranty of Title",
  "Lien Release": "Lien release",
  "Invoice / Bill of Sale": "Invoice or bill of sale",
  "Driver's License": "Driver's license",
  "Proof of Insurance": "Proof of insurance",
  "POA - Buyer": "Buyer power of attorney",
  "POA - Seller": "Seller power of attorney",
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function chip(status) {
  const s = STATUS[status] || { text: status || "Received", cls: "info" };
  const c = el("span", "chip chip--" + s.cls);
  if (s.spin) c.append(el("span", "spinner spinner--small"));
  c.append(document.createTextNode(s.text));
  return c;
}

function show(id) {
  for (const s of ["loading", "closed", "ready"]) $(s).classList.toggle("hidden", s !== id);
}

function closed(message, title) {
  $("closed-title").textContent = title || "This link is not available";
  $("closed-message").textContent = message || "Ask your Navitas contact for a new link.";
  show("closed");
}

async function api(url, init) {
  const r = await fetch(url, init);
  let body = {};
  try { body = await r.json(); } catch { body = { ok: false, message: "Something went wrong. Please try again." }; }
  return { status: r.status, body };
}

// ── Deal and checklist ───────────────────────────────────────────────
let context = null;

async function loadContext(first) {
  const { status, body } = await api(`/api/link?token=${encodeURIComponent(token)}`);
  if (!body.ok) {
    if (first || status === 410) closed(body.message, String(body.message || "").startsWith("Every") ? "All documents are in" : undefined);
    return;
  }
  context = body;
  renderDeal();
  renderVehicles(body.vehicles || []);
  if (first) {
    for (const u of body.uploads || []) addUpload({ name: u.fileName, fileId: u.fileId, status: u.status, at: u.at });
  }
  show("ready");
}

function renderDeal() {
  const c = context;
  $("deal-title").textContent = "Titling documents for " + (c.customer || "your customer");
  const bits = [];
  if (c.deal) bits.push("Deal " + c.deal);
  if (c.vendor) bits.push("Vendor: " + c.vendor);
  if (c.expiresAt) bits.push("Link open until " + new Date(c.expiresAt).toLocaleDateString(undefined, { month: "long", day: "numeric" }));
  $("deal-meta").textContent = bits.join(" · ");
  $("contact").textContent = "Questions? Contact " + (c.contactName || "Navitas Credit LLC") + (c.contactEmail ? " at " + c.contactEmail : "") + ".";
}

function renderVehicles(vehicles) {
  const box = $("vehicles");
  box.replaceChildren();
  if (!vehicles.length) {
    box.append(el("p", "muted small", "The vehicles on this deal are being set up. Your documents will be filed as soon as they are."));
    return;
  }
  for (const v of vehicles) {
    const card = el("div", "vehicle");
    card.append(el("p", "vehicle__label", v.label));
    const ul = el("ul", "need");
    for (const i of v.checklist || []) {
      const li = el("li");
      li.append(el("span", "mark " + (i.ok ? "is-ok" : "is-missing"), i.ok ? "✓" : "○"));
      li.append(el("span", i.ok ? "" : "is-missing", i.label + (i.ok ? "" : " (needed)")));
      ul.append(li);
    }
    card.append(ul);
    box.append(card);
  }
}

// ── Uploads ──────────────────────────────────────────────────────────
function addUpload({ name, fileId, status, at }) {
  const li = el("li", "upload");
  const head = el("div", "upload__head");
  const title = el("span", "upload__name", name || "Upload");
  const state = el("span");
  head.append(title, state);
  li.append(head);
  const bar = el("div", "bar");
  const fill = el("span");
  bar.append(fill);
  const summary = el("p", "upload__summary");
  const docs = el("ul", "docs hidden");
  li.append(bar, summary, docs);
  $("uploads").prepend(li);
  const view = { li, state, bar, fill, summary, docs, fileId, polls: 0 };
  if (at) summary.textContent = "Uploaded " + new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (fileId) {
    bar.classList.add("hidden");
    setStatus(view, status || "Checking");
    if (!status || status === "Checking") poll(view);
    else refresh(view, false);
  }
  return view;
}

function setStatus(view, status) {
  view.state.replaceChildren(chip(status));
}

function uploadOne(file) {
  const view = addUpload({ name: file.name });
  view.state.replaceChildren(el("span", "chip chip--info", "Uploading…"));
  const form = new FormData();
  form.append("token", token);
  form.append("file", file);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) view.fill.style.width = Math.round((e.loaded / e.total) * 100) + "%"; };
  xhr.onload = () => {
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch { body = { ok: false, message: "The file was not saved. Please try again." }; }
    view.bar.classList.add("hidden");
    if (!body.ok) {
      view.state.replaceChildren(el("span", "chip chip--problem", "Not uploaded"));
      view.summary.textContent = body.message || "The file was not saved. Please try again.";
      if (xhr.status === 410) loadContext(false);
      return;
    }
    view.fileId = body.fileId;
    setStatus(view, "Checking");
    view.summary.textContent = "Received. Reading each document, usually under a minute.";
    poll(view);
  };
  xhr.onerror = () => {
    view.bar.classList.add("hidden");
    view.state.replaceChildren(el("span", "chip chip--problem", "Not uploaded"));
    view.summary.textContent = "The connection dropped. Please try again.";
  };
  xhr.send(form);
}

function poll(view) {
  setTimeout(async () => {
    const done = await refresh(view, true);
    if (!done && ++view.polls < POLL_MAX) poll(view);
    else if (!done) view.summary.textContent = "Still reading. You can close this page: we will review the file either way.";
  }, POLL_MS);
}

// Returns true once the check has finished.
async function refresh(view, reloadChecklist) {
  const { body } = await api(`/api/link?token=${encodeURIComponent(token)}&file=${encodeURIComponent(view.fileId)}`);
  if (!body.ok) return false;
  setStatus(view, body.status);
  if (body.status === "Checking") return false;
  view.summary.textContent = body.summary || "";
  view.docs.replaceChildren();
  for (const d of body.documents || []) {
    const li = el("li", "doc");
    li.append(el("span", "doc__type", (DOC_LABEL[d.type] || d.type) + (d.pages ? " · page " + d.pages : "")));
    li.append(chip(d.status));
    if (d.summary && d.status !== "Passed") li.append(el("span", "doc__note", d.summary));
    view.docs.append(li);
  }
  view.docs.classList.toggle("hidden", !(body.documents || []).length);
  if (body.vehicles) renderVehicles(body.vehicles);
  else if (reloadChecklist) loadContext(false);
  return true;
}

// ── Drop zone ────────────────────────────────────────────────────────
function take(files) {
  for (const f of files) uploadOne(f);
}
const drop = $("drop");
const input = $("file");
drop.addEventListener("click", () => input.click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
input.addEventListener("change", () => { take([...input.files]); input.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("is-over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("is-over"); take([...e.dataTransfer.files]); });

if (!/^[0-9a-f]{64}$/.test(token)) closed("This link is not complete. Open it again from your email.");
else loadContext(true);
