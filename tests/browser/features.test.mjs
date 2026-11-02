// The newer parts of the page, in a real browser: the site tour and when it shows, the language key, explaining
// selected lines, and recording. Gemini, GitHub and sign-in are stand-ins answered by the test, so nothing leaves
// this machine and no key is needed.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE = path.join(ROOT, "site");
const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
const tourShown = page => page.evaluate(() => !document.getElementById("siteTour").hidden);

test("the local app: first-visit tour, language key, explaining selected lines, recording", { timeout: 600000 }, async t => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch (e) { return t.skip("playwright isn't installed (npm install)"); }
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-city-features-")));
  fs.mkdirSync(path.join(repo, "shop"));
  fs.writeFileSync(path.join(repo, "main.py"), "from shop import cart\n\n\ndef main():\n    print(cart.total([1, 2]))\n\n\nif __name__ == \"__main__\":\n    main()\n");
  fs.writeFileSync(path.join(repo, "shop", "__init__.py"), "");
  fs.writeFileSync(path.join(repo, "shop", "cart.py"), "def total(items):\n    return sum(items)\n");
  fs.writeFileSync(path.join(repo, "app.js"), "export const hello = () => 'hi';\n");
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "first");
  fs.appendFileSync(path.join(repo, "shop", "cart.py"), "\n\ndef count(items):\n    return len(items)\n");
  git("commit", "-qam", "second");

  const server = spawn("python3", [path.join(ROOT, "codecity.py"), repo, "--no-open", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GEMINI_API_KEY: "" } });
  const browser = await chromium.launch();
  try {
    const url = await new Promise((resolve, reject) => {
      let out = "";
      server.stdout.on("data", d => { out += d; const m = /running at (http:\/\/localhost:\d+\/)/.exec(out); if (m) resolve(m[1]); });
      server.on("exit", code => reject(new Error(`code-city exited (${code}): ${out}`)));
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { try { if (!localStorage.getItem("codecity.for")) localStorage.setItem("codecity.for", "advanced"); } catch (e) {} });   // every tool on screen
    const page = await context.newPage();
    page.setDefaultTimeout(120000);   // headless Chromium compiles the city's shaders in software, slowly
    const errors = [], asked = [];
    page.on("pageerror", e => errors.push(e.message));
    // Ask is a stand-in: on, needing no sign-in, and answering explanations with a fixed reply
    await page.route("**/.netlify/functions/ask*", route => {
      const req = route.request();
      if (req.method() !== "POST") return json(route, { enabled: true, open: true });
      const body = JSON.parse(req.postData()); asked.push(body);
      return json(route, { summary: "It starts the program.", files: [{ path: "main.py", explanation: "The entry point. ".repeat(40), links: [],
        parts: [3, 4, 5, 8, 9].map((line, i) => ({ line, name: `Part ${i + 1}`, note: "A part of the file, described at some length so the list scrolls." })) }] });
    });
    await page.goto(url);
    await page.waitForFunction(name => document.getElementById("repoName").textContent.startsWith(name), path.basename(repo));   // the page starts with just the city

    // The site tour: shown by itself on the first visit here (no sign-in in the local app), never again after
    await page.waitForFunction(() => !document.getElementById("siteTour").hidden);
    assert.equal(await page.textContent("#stTitle"), "Welcome to Code City");
    await page.click('#siteTour [data-st="next"]');
    assert.match(await page.textContent("#stCount"), /^2 of \d+$/);
    await page.click('#siteTour [data-st="back"]');
    assert.equal(await page.textContent("#stTitle"), "Welcome to Code City");
    await page.keyboard.press("Escape");
    assert.equal(await tourShown(page), false);
    await page.reload();
    await page.waitForFunction(name => document.getElementById("repoName").textContent.startsWith(name), path.basename(repo));   // the page starts with just the city
    await page.waitForTimeout(2500);
    assert.equal(await tourShown(page), false, "not again on a later visit");
    await page.click('.rail-btn[data-seg="guide"]');
    await page.click("#siteTourBtn");
    assert.equal(await tourShown(page), true, "the Guide starts it");
    await page.click('#siteTour [data-st="close"]');
    assert.equal(await tourShown(page), false);

    // The language key: a language lights its files and opens its counts; again clears it
    await page.click('.rail-btn[data-seg="display"]');
    await page.click('#legend [data-lang="py"]');
    await page.waitForFunction(() => document.getElementById("sideTitle").textContent === "Python");
    assert.ok(await page.evaluate(() => document.getElementById("side").classList.contains("compact")));
    assert.match(await page.textContent("#sideSub"), /^3 files · \d+ lines · \d+% of the code$/);
    await page.click('#legend [data-lang="py"]');
    assert.ok(await page.evaluate(() => document.getElementById("side").hidden), "clicking it again clears it");
    // ...and picking another colour closes Hotspots' list; Display has no Imports colour any more
    await page.click("#hotBtn");
    await page.waitForFunction(() => document.getElementById("sideTitle").textContent === "Hotspots");
    assert.equal(await page.$("#cImp"), null);
    await page.click("#cLang");
    assert.ok(await page.evaluate(() => document.getElementById("side").hidden));

    // Explaining selected lines: only those, marked, with the whole file one press away
    await page.evaluate(() => document.getElementById("mapBtn").click());   // Code structure, whichever left panel is open
    await page.click('#sideBody [data-path="main.py"]');
    await page.click('#dActions button:has-text("View code")');
    await page.locator('#viewerPanes .vl[data-l="9"]').waitFor();
    await page.evaluate(() => {
      const body = document.querySelector("#viewerPanes .pane-body");
      const a = body.querySelector('.vl[data-l="4"] span:last-child').firstChild, b = body.querySelector('.vl[data-l="5"] span:last-child').firstChild;
      const r = document.createRange(); r.setStart(a, 0); r.setEnd(b, b.length); getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    await page.click("#viewerPanes [data-pane-explain]");   // a real click: the selection has to survive it
    await page.locator("#viewerPanes .explain-range").waitFor();
    assert.match(await page.textContent("#viewerPanes .explain-range"), /^Lines 4–5/);
    assert.deepEqual(await page.$$eval("#viewerPanes .vl.picked", rows => rows.map(r => r.dataset.l)), ["4", "5"]);
    assert.match(asked.at(-1).question, /lines 4–5 of main\.py/);
    // pointing at a key part moves the code, and leaves the explanation where it was
    await page.locator("#viewerPanes .parts .lnum").first().waitFor();
    const part = page.locator('#viewerPanes .parts .lnum[data-line="8"]');
    await part.scrollIntoViewIfNeeded();   // where the reader has scrolled to; clicking must not move it
    const col = await page.$eval("#viewerPanes .explain-col", c => c.scrollTop);
    await part.click();
    assert.equal(await page.$eval("#viewerPanes .vl.hit", r => r.dataset.l), "8");
    assert.equal(await page.$eval("#viewerPanes .explain-col", c => c.scrollTop), col);
    await page.click("#viewerPanes [data-explain-full]");
    await page.waitForFunction(() => !document.querySelector("#viewerPanes .explain-range"));
    assert.equal(await page.$$eval("#viewerPanes .vl.picked", rows => rows.length), 0);
    assert.doesNotMatch(asked.at(-1).question, /lines 4–5/);

    // Recording: the menu offers both kinds; "what I do" records the city view where a tab can't be shared
    await page.click("#recBtn");
    assert.deepEqual(await page.$$eval("#ctxMenu button", b => b.map(x => x.textContent)), ["Record what I do", "Record the history replay"]);
    await page.evaluate(() => { navigator.mediaDevices.getDisplayMedia = async () => { throw new Error("no tab sharing here"); }; });
    await page.click('#ctxMenu [data-rec="live"]');
    await page.waitForFunction(() => document.getElementById("recBtn").textContent === "Stop recording");
    await page.waitForTimeout(1500);
    await page.click("#recBtn");
    await page.waitForFunction(() => document.getElementById("recBtn").textContent === "Download video");

    // The three versions: Beginner hides the expert tools; Manager opens the status report, from the folder's history
    const shown = id => page.evaluate(id => getComputedStyle(document.getElementById(id)).display !== "none", id);
    await page.selectOption("#forSel", "beginner");
    assert.equal(await shown("recBtn"), false); assert.equal(await shown("hotBtn"), false); assert.equal(await shown("reportBtn"), false);
    await page.selectOption("#forSel", "manager");
    await page.waitForFunction(() => document.getElementById("sideTitle").textContent === "Status report" && /Download report/.test(document.getElementById("sideBody").textContent));
    assert.match(await page.textContent("#sideBody"), /Commits\s*2[\s\S]*Who did the work\s*t\s*2 commits/i);
    assert.match(await page.textContent("#sideBody"), /shop\//, "the folder that changed");
    await page.reload();
    await page.waitForFunction(name => document.getElementById("repoName").textContent.startsWith(name), path.basename(repo));
    await page.waitForTimeout(1500);
    assert.equal(await page.inputValue("#forSel"), "manager", "remembered");
    assert.equal(await page.evaluate(() => document.body.classList.contains("side-open") || !document.body.classList.contains("seg-closed")), false, "the page starts with just the city");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.kill();
  }
});

test("on the hosted site the tour shows on every visit until sign-in, then once per account", { timeout: 600000 }, async t => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch (e) { return t.skip("playwright isn't installed (npm install)"); }
  const server = http.createServer((req, res) => {
    const file = path.join(SITE, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html");
    if (!file.startsWith(SITE + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".wasm") ? "application/wasm" : "text/javascript" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const url = `http://codecity.test:${server.address().port}/`;   // not localhost: the hosted site's rules
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP codecity.test 127.0.0.1"] });
  let login = "first-account";
  const open = async context => {
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    await page.route("**/.netlify/functions/github-login*", route => json(route, { enabled: true }));   // sign-in exists here
    await page.route("**/.netlify/functions/ask*", route => json(route, { enabled: false }));
    await page.route("https://api.github.com/**", route => new URL(route.request().url()).pathname === "/user" ? json(route, { login }) : json(route, {}));
    await page.goto(url);
    await page.waitForFunction(() => +document.getElementById("sFiles").textContent.replace(/\D/g, "") > 0);   // the example city
    await page.waitForTimeout(2500);   // the tour waits for the first panels to settle
    return page;
  };
  const reopen = async page => {   // a later visit: as long a wait as the first, since the tour waits for sign-in
    await page.reload();
    await page.waitForFunction(() => +document.getElementById("sFiles").textContent.replace(/\D/g, "") > 0);
    await page.waitForTimeout(2500);
  };
  const signedInAs = async (page, who) => {   // the tour waits for sign-in to learn the account, which is slow on a busy machine
    await page.waitForFunction(who => document.getElementById("ghLogin").textContent === "@" + who, who);
    await page.waitForTimeout(1500);   // it starts 900 ms after
  };
  try {
    // signed out: every visit, until closed for that visit
    const out = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const a = await open(out);
    assert.equal(await tourShown(a), true, "a signed-out visitor sees it");
    assert.ok(await a.$$eval("#siteTour [data-st]", () => true));
    await a.click('#siteTour [data-st="close"]');
    await reopen(a);
    assert.equal(await tourShown(a), false, "closed: not again in this visit");
    const b = await open(out);
    assert.equal(await tourShown(b), true, "a new visit shows it again");
    await out.close();

    // signed in: once per GitHub account
    const signedIn = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await signedIn.addInitScript(() => { try { if (!localStorage.getItem("codecity.githubOAuth")) localStorage.setItem("codecity.githubOAuth", "stand-in-token"); } catch (e) {} });
    const c = await open(signedIn); await signedInAs(c, "first-account");
    assert.equal(await tourShown(c), true, "the first sign-in sees it");
    await reopen(c); await signedInAs(c, "first-account");
    assert.equal(await tourShown(c), false, "not again for the same account");
    login = "second-account";
    await reopen(c); await signedInAs(c, "second-account");
    assert.equal(await tourShown(c), true, "another account sees it once too");
    await signedIn.close();
  } finally {
    await browser.close();
    server.close();
  }
});
