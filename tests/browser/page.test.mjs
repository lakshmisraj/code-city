// The hosted page in a real browser: it draws the example city with no errors.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "site");

// Serves site/ the way Netlify does, without the functions (so no sign-in and no Ask).
function serveSite() {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.join(SITE, rel);
    if (!file.startsWith(SITE + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("the page draws the example city in a browser, with no errors", { timeout: 90000 }, async t => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch (e) { return t.skip("playwright isn't installed (npm install)"); }
  const server = await serveSite();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => +document.getElementById("sFiles").textContent.replace(/\D/g, "") > 0, null, { timeout: 60000 });
    for (const id of ["commitsBtn", "mapBtn", "sysBtn"]) await page.evaluate(id => document.getElementById(id).click(), id);   // a few panels open and close
    await page.waitForTimeout(500);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
