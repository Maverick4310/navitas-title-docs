// navitas-title-docs — 2026-10 (Vendor Title Upload)
//
// The page a vendor opens from a "Titling documents needed" email. It shows the deal, what each
// vehicle still needs, takes the vendor's files and shows each document's check result.
//
// The vendor's browser only ever talks to this service. This service signs in to Salesforce as
// its own integration user (OAuth client credentials, permission set Title_Vendor_Upload_API) and:
//   1. checks the link's token with GET /services/apexrest/titlevendor/?token=…
//   2. saves each file as a ContentVersion (standard REST, no 6 MB Apex limit)
//   3. hands the file to POST /services/apexrest/titlevendor/, which links it to the deal and runs
//      the same title package check and filing as a rep's upload (CreditAppOcrController)
//   4. relays GET /titlevendor/?token=…&file=… so the page can poll the check result.
// Salesforce decides everything (expiry, cancellation, which uploads belong to the link); this
// service only relays, checks file types and sizes, and rate-limits. Tokens are never logged.
//
// Env: SF_LOGIN_URL (https://navitascredit.my.salesforce.com), SF_CLIENT_ID, SF_CLIENT_SECRET,
//      SF_API_VERSION (default 62.0), PORT.
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SF_LOGIN_URL = (process.env.SF_LOGIN_URL || "").replace(/\/$/, "");
const SF_API_VERSION = process.env.SF_API_VERSION || "62.0";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TOKEN = /^[0-9a-f]{64}$/;
const FILE_ID = /^069[0-9A-Za-z]{12}([0-9A-Za-z]{3})?$/;

// ── File types: by content, not by name ──────────────────────────────
export function sniffType(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf.subarray(0, 4).toString("latin1") === "%PDF") return { ext: "pdf", mime: "application/pdf" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString("latin1") === "PNG") return { ext: "png", mime: "image/png" };
  return null;
}

// A safe file name for Salesforce: no path, no control characters, the right extension.
export function cleanName(original, ext) {
  let base = path.basename(String(original || "upload")).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ").trim();
  base = base.replace(/\.(pdf|jpe?g|png)$/i, "").replace(/\s+/g, " ").trim().slice(0, 120) || "upload";
  return `${base}.${ext}`;
}

export const mask = (t) => (t ? "…" + String(t).slice(-6) : "");

// ── Rate limits (per IP, in memory; one instance) ────────────────────
const buckets = new Map();
export function allow(key, limit, windowMs, now = Date.now()) {
  const b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return true;
  }
  b.count++;
  return b.count <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.start > 15 * 60 * 1000) buckets.delete(k);
}, 5 * 60 * 1000).unref();

// ── Salesforce ───────────────────────────────────────────────────────
let session = null; // { accessToken, instanceUrl, at }

async function signIn() {
  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SF_CLIENT_ID || "",
      client_secret: process.env.SF_CLIENT_SECRET || "",
    }),
  });
  if (!res.ok) throw new Error(`Salesforce sign-in failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  session = { accessToken: j.access_token, instanceUrl: j.instance_url, at: Date.now() };
  console.log("salesforce: signed in", session.instanceUrl);
  return session;
}

// One retry after a fresh sign-in when the session has expired.
async function sf(pathAndQuery, init = {}, retry = true) {
  const s = session || (await signIn());
  const res = await fetch(`${s.instanceUrl}${pathAndQuery}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${s.accessToken}` },
  });
  if (res.status === 401 && retry) {
    session = null;
    return sf(pathAndQuery, init, false);
  }
  return res;
}

async function relay(res, sfRes) {
  const text = await sfRes.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { ok: false, code: "server", message: "Something went wrong on our side. Please try again in a few minutes." };
    console.error("salesforce: non-JSON reply", sfRes.status, text.slice(0, 200));
  }
  res.status(sfRes.status >= 500 ? 502 : sfRes.status).json(body);
}

const linkUrl = (token, file) =>
  `/services/apexrest/titlevendor/?token=${encodeURIComponent(token)}` + (file ? `&file=${encodeURIComponent(file)}` : "");

// Base64 JSON insert: Node's FormData sends every Blob as a file part, and Salesforce refuses a
// multipart request with more than one. Files are capped at 25 MB, well inside the JSON limit.
async function saveFile(buf, name) {
  const r = await sf(`/services/data/v${SF_API_VERSION}/sobjects/ContentVersion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Title: name.replace(/\.[^.]+$/, ""), PathOnClient: name, VersionData: buf.toString("base64") }),
  });
  if (!r.ok) throw new Error(`ContentVersion insert failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  const { id } = await r.json();
  const q = await sf(
    `/services/data/v${SF_API_VERSION}/query?q=${encodeURIComponent(`SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${id}'`)}`
  );
  const j = await q.json();
  const docId = j.records && j.records[0] && j.records[0].ContentDocumentId;
  if (!docId) throw new Error("ContentDocumentId not found for " + id);
  return docId;
}

// ── App ──────────────────────────────────────────────────────────────
export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000",
    "Cache-Control": req.path.startsWith("/api/") ? "no-store" : "public, max-age=300",
  });
  next();
});
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

const tooMany = (res) =>
  res.status(429).json({ ok: false, code: "busy", message: "Too many requests. Please wait a minute and try again." });
const badLink = (res) => res.status(404).json({ ok: false, code: "unknown", message: "This link is not valid." });

app.get("/api/link", async (req, res) => {
  const { token, file } = req.query;
  if (!allow("get:" + req.ip, 240, 60 * 1000)) return tooMany(res);
  if (!TOKEN.test(String(token || ""))) return badLink(res);
  if (file && !FILE_ID.test(String(file))) return res.status(400).json({ ok: false, code: "file", message: "Unknown upload." });
  try {
    await relay(res, await sf(linkUrl(token, file)));
  } catch (e) {
    console.error("link: failed", mask(token), e.message);
    res.status(502).json({ ok: false, code: "server", message: "Something went wrong on our side. Please try again in a few minutes." });
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 4 } });

app.post("/api/upload", (req, res) => {
  if (!allow("up:" + req.ip, 40, 10 * 60 * 1000)) return tooMany(res);
  upload.single("file")(req, res, async (err) => {
    const token = req.body && req.body.token;
    if (err) {
      const big = err.code === "LIMIT_FILE_SIZE";
      return res.status(400).json({ ok: false, code: big ? "size" : "file", message: big ? "That file is over 25 MB. Please split it or scan at a lower resolution." : "The file could not be read." });
    }
    if (!TOKEN.test(String(token || ""))) return badLink(res);
    if (!req.file) return res.status(400).json({ ok: false, code: "file", message: "Choose a file to upload." });
    const type = sniffType(req.file.buffer);
    if (!type) return res.status(400).json({ ok: false, code: "type", message: "Only PDF, JPG and PNG files can be uploaded." });
    try {
      // The link must still be open before anything is saved.
      const check = await sf(linkUrl(token));
      if (!check.ok) return relay(res, check);
      const name = cleanName(req.file.originalname, type.ext);
      const fileId = await saveFile(req.file.buffer, name);
      const r = await sf("/services/apexrest/titlevendor/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, fileId, fileName: name }),
      });
      console.log("upload:", mask(token), name, req.file.size, "bytes →", r.status);
      return relay(res, r);
    } catch (e) {
      console.error("upload: failed", mask(token), e.message);
      return res.status(502).json({ ok: false, code: "server", message: "The file was not saved. Please try again in a few minutes." });
    }
  });
});

if (process.env.NODE_ENV !== "test") {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log("navitas-title-docs listening on", port));
}
