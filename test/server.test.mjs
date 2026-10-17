// 2026-10 (Vendor Title Upload) File checks, rate limit and the routes that never reach Salesforce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffType, cleanName, allow, mask, app } from "../server.js";

test("file types are read from the content, not the name", () => {
  assert.equal(sniffType(Buffer.from("%PDF-1.7 x")).ext, "pdf");
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).ext, "jpg");
  assert.equal(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])).ext, "png");
  assert.equal(sniffType(Buffer.from("MZ executable")), null);
});

test("file names lose paths and odd characters and get the real extension", () => {
  assert.equal(cleanName("../../etc/passwd", "pdf"), "passwd.pdf");
  assert.equal(cleanName("Title <front>.PDF", "pdf"), "Title front.pdf");
  assert.equal(cleanName("scan.png", "jpg"), "scan.jpg");
});

test("rate limit allows up to the limit in a window", () => {
  const k = "t" + Math.random();
  for (let i = 0; i < 3; i++) assert.equal(allow(k, 3, 1000, 1000), true);
  assert.equal(allow(k, 3, 1000, 1500), false);
  assert.equal(allow(k, 3, 1000, 2600), true);
});

test("tokens are masked in logs", () => {
  assert.equal(mask("a".repeat(58) + "abcdef"), "…abcdef");
});

test("bad tokens are refused without calling Salesforce", async () => {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    let r = await fetch(`http://127.0.0.1:${port}/api/link?token=nope`);
    assert.equal(r.status, 404);
    r = await fetch(`http://127.0.0.1:${port}/api/link?token=${"a".repeat(64)}&file=xyz`);
    assert.equal(r.status, 400);
    const form = new FormData();
    form.append("token", "bad");
    form.append("file", new Blob(["%PDF-1.4"]), "a.pdf");
    r = await fetch(`http://127.0.0.1:${port}/api/upload`, { method: "POST", body: form });
    assert.equal(r.status, 404);
    r = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  } finally {
    server.close();
  }
});

test("slot uploads accept only the known document types", async () => {
  const { SLOT_TYPES } = await import("../server.js");
  assert.ok(SLOT_TYPES.has("POA - Buyer"));
  assert.ok(!SLOT_TYPES.has("Title Package"));
});
