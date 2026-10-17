// 2026-10 (Vendor Title Upload) Vendor upload page. Every value from the server is written with
// textContent (never innerHTML).
// 2026-10 (Vendor Slots) Two ways to upload: the whole package (read and filed for you), or one
// document per slot. Slots are the documents this deal needs, from the same rules as the title
// sheet; each shows the latest result of what was sent through this link. The titling state's
// rules are shown below them.
const token = new URLSearchParams(location.search).get("token") || "";
const $ = (id) => document.getElementById(id);

const POLL_MS = 4000;
const POLL_MAX = 75; // about 5 minutes

// A check that could not run is the reviewer's job, never the vendor's: no technical text.
const MANUAL = "We could not read this automatically. Your Navitas contact will review it.";
const STATUS = {
  Checking: { text: "Reading your file…", cls: "info", spin: true },
  Passed: { text: "Looks good", cls: "ok" },
  Review: { text: "Needs a closer look", cls: "review" },
  Failed: { text: "Problem: please fix", cls: "problem" },
  "Not Checked": { text: "Received", cls: "info", manual: true },
  Error: { text: "Received", cls: "info", manual: true },
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
const summaryFor = (status, summary) => ((STATUS[status] || {}).manual ? MANUAL : summary || "");

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

// ── Deal, slots and rules ────────────────────────────────────────────
let context = null;
const busySlots = new Set(); // slot keys with an upload or check in flight

async function loadContext(first) {
  const { status, body } = await api(`/api/link?token=${encodeURIComponent(token)}`);
  if (!body.ok) {
    if (first || status === 410) closed(body.message, String(body.message || "").startsWith("Every") ? "All documents are in" : undefined);
    return;
  }
  context = body;
  renderDeal();
  renderSlots(body.slots);
  renderRules(body.stateRules || []);
  if (first) {
    for (const u of body.uploads || []) {
      if (u.fileName && !u.slot) addUpload({ name: u.fileName, fileId: u.fileId, status: u.status, at: u.at });
    }
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

function renderSlots(slots) {
  const box = $("slots");
  if (!slots) return;
  box.replaceChildren();
  const vehicles = slots.vehicles || [];
  if (!vehicles.length) {
    box.append(el("p", "muted small", "The vehicles on this deal are being set up. Use the package upload above in the meantime."));
    return;
  }
  if ((slots.deal || []).length) box.append(group("For the whole deal", null, slots.deal));
  for (const v of vehicles) box.append(group(v.label, v.sheetId, v.slots || []));
}

function group(title, sheetId, items) {
  const g = el("div", "slot-group");
  g.append(el("p", "slot-group__title", title));
  const ul = el("ul", "slots");
  for (const s of items) ul.append(slotRow(s, sheetId));
  g.append(ul);
  return g;
}

function slotRow(slot, sheetId) {
  const key = slot.type + "|" + (sheetId || "deal");
  const li = el("li", "slot" + (slot.ok ? " slot--ok" : ""));
  const head = el("div", "slot__head");
  const name = el("span", "slot__name");
  name.append(el("span", "mark " + (slot.ok ? "is-ok" : "is-missing"), slot.ok ? "✓" : "○"), document.createTextNode(slot.label));
  head.append(name);

  const right = el("div", "slot__right");
  const latest = slot.latest;
  if (busySlots.has(key)) right.append(chip("Checking"));
  else if (latest) right.append(chip(latest.status));
  else right.append(el("span", "chip chip--" + (slot.ok ? "ok" : "need"), slot.ok ? "Received" : "Needed"));

  const input = el("input");
  input.type = "file";
  input.accept = "application/pdf,image/jpeg,image/png";
  input.className = "visually-hidden";
  const btn = el("button", "btn" + (slot.ok ? "" : " btn--primary"), slot.ok || latest ? "Replace" : "Upload");
  btn.type = "button";
  btn.disabled = busySlots.has(key);
  right.append(btn, input);
  head.append(right);
  li.append(head);

  // A power of attorney must be notarized before it can be filed.
  let notarized = null;
  let electronic = null;
  if (slot.type.startsWith("POA")) {
    const opts = el("div", "slot__opts");
    notarized = checkbox("It is notarized");
    electronic = checkbox("Notarized online (e.g. DocuSign)");
    opts.append(notarized.label, electronic.label);
    li.append(opts);
  }

  const note = el("p", "slot__note");
  if (latest) {
    const text = summaryFor(latest.status, latest.summary);
    note.textContent = (latest.fileName ? latest.fileName + (text ? ": " : "") : "") + text;
  }
  const bar = el("div", "bar hidden");
  const fill = el("span");
  bar.append(fill);
  li.append(bar, note);

  btn.addEventListener("click", () => {
    if (notarized && !notarized.input.checked) {
      note.textContent = "Tick “It is notarized” first: we can only accept notarized powers of attorney.";
      note.classList.add("is-warn");
      return;
    }
    input.click();
  });
  input.addEventListener("change", () => {
    const f = input.files[0];
    input.value = "";
    if (!f) return;
    uploadSlot(f, slot, sheetId, key, { notarized: !!(notarized && notarized.input.checked), electronic: !!(electronic && electronic.input.checked) }, { btn, note, bar, fill, right });
  });
  return li;
}

function checkbox(text) {
  const label = el("label", "check");
  const input = el("input");
  input.type = "checkbox";
  label.append(input, el("span", "", text));
  return { label, input };
}

// ── Rules ────────────────────────────────────────────────────────────
function renderRules(states) {
  const box = $("rules-body");
  box.replaceChildren();
  $("rules").classList.toggle("hidden", !states.length);
  for (const st of states) {
    const d = el("details", "rule");
    if (states.length === 1) d.open = true;
    d.append(el("summary", "rule__title", st.name + (st.guessed ? " (the customer's state; your Navitas contact confirms the titling state)" : "")));
    if (st.notary) d.append(el("p", "rule__notary", st.notary));
    for (const sec of st.sections || []) {
      d.append(el("p", "rule__section", sec.title));
      const ul = el("ul", "rule__items");
      for (const t of sec.items || []) ul.append(el("li", "", t));
      d.append(ul);
    }
    box.append(d);
  }
}

// ── Uploads ──────────────────────────────────────────────────────────
function send(file, fields, onProgress) {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append("token", token);
    for (const [k, v] of Object.entries(fields || {})) if (v !== undefined && v !== null) form.append(k, String(v));
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { body = { ok: false, message: "The file was not saved. Please try again." }; }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => resolve({ status: 0, body: { ok: false, message: "The connection dropped. Please try again." } });
    xhr.send(form);
  });
}

async function uploadSlot(file, slot, sheetId, key, poa, view) {
  busySlots.add(key);
  view.btn.disabled = true;
  view.note.classList.remove("is-warn");
  view.note.textContent = "Uploading " + file.name + "…";
  view.bar.classList.remove("hidden");
  const { status, body } = await send(file, { slotType: slot.type, sheetId: sheetId || "", ...poa }, (p) => { view.fill.style.width = p + "%"; });
  view.bar.classList.add("hidden");
  if (!body.ok) {
    busySlots.delete(key);
    view.btn.disabled = false;
    view.note.textContent = body.message || "The file was not saved. Please try again.";
    view.note.classList.add("is-warn");
    if (status === 410) loadContext(false);
    return;
  }
  view.right.replaceChildren(chip("Checking"));
  view.note.textContent = "Received. Reading it now, usually under a minute.";
  await waitForCheck(body.fileId);
  busySlots.delete(key);
  loadContext(false);
}

async function waitForCheck(fileId) {
  for (let i = 0; i < POLL_MAX; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const { body } = await api(`/api/link?token=${encodeURIComponent(token)}&file=${encodeURIComponent(fileId)}`);
    if (body.ok && body.status !== "Checking") return body;
  }
  return null;
}

function addUpload({ name, fileId, status, at }) {
  const li = el("li", "upload");
  const head = el("div", "upload__head");
  const state = el("span");
  head.append(el("span", "upload__name", name || "Upload"), state);
  const bar = el("div", "bar");
  const fill = el("span");
  bar.append(fill);
  const summary = el("p", "upload__summary");
  const docs = el("ul", "docs hidden");
  li.append(head, bar, summary, docs);
  $("uploads").prepend(li);
  const view = { state, bar, fill, summary, docs, fileId };
  if (at) summary.textContent = "Uploaded " + new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (fileId) {
    bar.classList.add("hidden");
    state.replaceChildren(chip(status || "Checking"));
    if (!status || status === "Checking") followPackage(view);
    else showPackage(view, false);
  }
  return view;
}

async function uploadPackage(file) {
  const view = addUpload({ name: file.name });
  view.state.replaceChildren(el("span", "chip chip--info", "Uploading…"));
  const { status, body } = await send(file, {}, (p) => { view.fill.style.width = p + "%"; });
  view.bar.classList.add("hidden");
  if (!body.ok) {
    view.state.replaceChildren(el("span", "chip chip--problem", "Not uploaded"));
    view.summary.textContent = body.message || "The file was not saved. Please try again.";
    if (status === 410) loadContext(false);
    return;
  }
  view.fileId = body.fileId;
  view.state.replaceChildren(chip("Checking"));
  view.summary.textContent = "Received. Reading each document, usually under a minute.";
  followPackage(view);
}

async function followPackage(view) {
  const done = await waitForCheck(view.fileId);
  if (done) {
    paintPackage(view, done);
    loadContext(false);
  } else {
    view.summary.textContent = "Still reading. You can close this page: we will review the file either way.";
  }
}

async function showPackage(view) {
  const { body } = await api(`/api/link?token=${encodeURIComponent(token)}&file=${encodeURIComponent(view.fileId)}`);
  if (body.ok) paintPackage(view, body);
}

function paintPackage(view, body) {
  view.state.replaceChildren(chip(body.status));
  view.summary.textContent = summaryFor(body.status, body.summary);
  view.docs.replaceChildren();
  for (const d of body.documents || []) {
    const li = el("li", "doc");
    li.append(el("span", "doc__type", (DOC_LABEL[d.type] || d.type) + (d.pages ? " · page " + d.pages : "")));
    li.append(chip(d.status));
    const text = summaryFor(d.status, d.summary);
    if (text && d.status !== "Passed") li.append(el("span", "doc__note", text));
    view.docs.append(li);
  }
  view.docs.classList.toggle("hidden", !(body.documents || []).length);
}

// ── Package drop zone ────────────────────────────────────────────────
const drop = $("drop");
const input = $("file");
const take = (files) => { for (const f of files) uploadPackage(f); };
drop.addEventListener("click", () => input.click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
input.addEventListener("change", () => { take([...input.files]); input.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("is-over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("is-over"); take([...e.dataTransfer.files]); });

if (!/^[0-9a-f]{64}$/.test(token)) closed("This link is not complete. Open it again from your email.");
else loadContext(true);
