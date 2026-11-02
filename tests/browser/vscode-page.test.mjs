// The page inside VS Code (?host=vscode, in a frame from another origin, like the extension's webview): a "reveal"
// message from the frame's parent opens that file's building, and Open in editor sends the file to the parent.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("in VS Code, the page reveals files it's sent and hands files to the editor", { timeout: 400000 }, async t => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch (e) { return t.skip("playwright isn't installed (npm install)"); }
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-city-host-")));
  fs.mkdirSync(path.join(repo, "shop"));
  fs.writeFileSync(path.join(repo, "main.py"), "from shop import cart\n\ndef main():\n    cart.total([1])\n");
  fs.writeFileSync(path.join(repo, "shop", "cart.py"), "def total(items):\n    return sum(items)\n");
  execFileSync("git", ["-C", repo, "init", "-q"]);
  const server = spawn("python3", [path.join(ROOT, "codecity.py"), repo, "--no-open", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GEMINI_API_KEY: "" } });
  let host;
  const browser = await chromium.launch();
  try {
    const city = await new Promise((resolve, reject) => {
      let out = "";
      server.stdout.on("data", d => { out += d; const m = /running at (http:\/\/localhost:\d+\/)/.exec(out); if (m) resolve(m[1]); });
      server.on("exit", code => reject(new Error(`code-city exited (${code}): ${out}`)));
    });
    // The stand-in for the extension's webview: another origin, framing the page and keeping what it's sent.
    host = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<!doctype html><body style="margin:0">
      <iframe id="city" src="${city}?host=vscode" style="width:1200px;height:760px;border:0"></iframe>
      <script>window.got = []; addEventListener("message", e => { if (e.source === document.getElementById("city").contentWindow) got.push(e.data); });
      window.reveal = p => document.getElementById("city").contentWindow.postMessage({ codeCity: "reveal", path: p }, "*");</script></body>`); });
    await new Promise(r => host.listen(0, "127.0.0.1", r));
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
    await page.addInitScript(() => { try { localStorage.setItem("codecity.siteTour.here", "1"); sessionStorage.setItem("codecity.siteTourClosed", "1"); localStorage.setItem("codecity.for", "advanced"); } catch (e) {} });   // the site tour would cover the page
    // Headless Chromium has no GPU and compiles the city's shaders in software, which holds the page (and this
    // harness, in the same process) up for a while; nothing here should take long on a real machine.
    page.setDefaultTimeout(120000);
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${host.address().port}/`, { waitUntil: "domcontentloaded" });
    const frame = await (await page.waitForSelector("#city", { state: "attached" })).contentFrame();
    // The frame may still be blank when it's first found, so the checks allow for the page not being there yet.
    await frame.waitForFunction(name => (document.getElementById("sideSub") || {}).textContent?.startsWith(name), path.basename(repo));
    await page.evaluate(() => window.reveal("shop/cart.py"));
    await frame.waitForFunction(() => (document.getElementById("dName") || {}).textContent === "cart.py");
    assert.match(await frame.evaluate(() => location.search), /host=vscode/, "the page keeps ?host=vscode in its address");
    await frame.locator("[data-open-editor]").dispatchEvent("click");   // the drawer may still be sliding in
    await page.waitForFunction(() => window.got.length > 0);
    assert.deepEqual(await page.evaluate(() => window.got), [{ codeCity: "open", path: "shop/cart.py", line: 0 }]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.kill();
    if (host) host.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
