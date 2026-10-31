// A private GitHub repo on the hosted page, with a pasted read-only token: files come through the API with the
// token (raw.githubusercontent.com can't take one), and the token goes nowhere but api.github.com. GitHub is a
// stand-in here: every request to it is answered by the test, so the made-up token never leaves this machine.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "site");
const TOKEN = "github_pat_TEST_ONLY_not_a_real_token";
const FILES = {
  "main.py": "from shop import cart\n\nif __name__ == \"__main__\":\n    cart.total([1])\n",
  "shop/__init__.py": "",
  "shop/cart.py": "def total(items):\n    return sum(items)\n",
};

test("a private repo opens with a pasted token, reading files through the API", { timeout: 400000 }, async t => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch (e) { return t.skip("playwright isn't installed (npm install)"); }
  const server = http.createServer((req, res) => {
    const file = path.join(SITE, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html");
    if (!file.startsWith(SITE + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".wasm") ? "application/wasm" : "text/javascript" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  // Not localhost, or the page would read repos through code-city's local server instead of GitHub.
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP codecity.test 127.0.0.1"] });
  const seen = { contents: [], raw: [], tokens: new Set() };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(120000);   // headless Chromium compiles the city's shaders in software, slowly
    await page.route("https://raw.githubusercontent.com/**", route => { seen.raw.push(route.request().url()); return route.fulfill({ status: 404, body: "" }); });
    await page.route("https://api.github.com/**", route => {
      const req = route.request(), url = new URL(req.url()), auth = req.headers().authorization;
      if (auth) seen.tokens.add(auth);
      const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, accept", "Access-Control-Allow-Methods": "GET" } });
      if (url.pathname === "/rate_limit") return json({ resources: { core: { remaining: 4999, limit: 5000, reset: 0 } } });
      if (auth !== `Bearer ${TOKEN}`) return json({ message: "Not Found" }, 404);   // private: invisible without the token
      if (url.pathname === "/repos/acme/secret") return json({ default_branch: "main", private: true });
      if (url.pathname === "/repos/acme/secret/git/trees/main") return json({ sha: "t1", tree: Object.entries(FILES).map(([p, text]) => ({ path: p, type: "blob", size: Math.max(1, text.length) })) });
      if (url.pathname === "/repos/acme/secret/commits") return json([]);
      const m = /^\/repos\/acme\/secret\/contents\/(.+)$/.exec(url.pathname);
      if (m) {
        const p = decodeURIComponent(m[1]);
        seen.contents.push({ path: p, accept: req.headers().accept });
        return p in FILES ? route.fulfill({ status: 200, contentType: "text/plain", headers: { "Access-Control-Allow-Origin": "*" }, body: FILES[p] }) : json({ message: "Not Found" }, 404);
      }
      return json({ message: "Not Found" }, 404);
    });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`http://codecity.test:${server.address().port}/`);
    await page.waitForFunction(() => +document.getElementById("sFiles").textContent.replace(/\D/g, "") > 0);   // the example city
    await page.evaluate(token => {
      document.getElementById("tokenBox").open = true;
      const input = document.getElementById("ghToken");
      input.value = token; input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("repoInput").value = "acme/secret";
      [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Build").click();
    }, TOKEN);
    await page.waitForFunction(() => document.getElementById("sideSub").textContent.startsWith("acme/secret"));
    await page.waitForFunction(() => /Starts here|No clear entry point/.test(document.getElementById("sideBody").textContent));   // the code was read
    assert.ok(seen.contents.some(c => c.path === "shop/cart.py"), "files were read through the API");
    assert.ok(seen.contents.every(c => c.accept === "application/vnd.github.raw"));
    assert.deepEqual(seen.raw, [], "nothing was asked of raw.githubusercontent.com");
    assert.deepEqual([...seen.tokens], [`Bearer ${TOKEN}`], "the token only went to api.github.com");
    assert.match(await page.evaluate(() => document.getElementById("sideBody").textContent), /main\.py/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
