// The hosted page's usage counts: what leaves the browser is a feature's name and a number, once a day per
// feature for "people", and nothing at all when the browser asks not to be tracked.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "site");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

// The page at its real address (the counts are sent only from codecitydev.com), served from site/, with the
// visit function replaced by a recorder.
async function open(browser, { dnt = false, init = "" } = {}) {
  const posts = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(`try { localStorage.setItem("codecity.siteTour.here", "1"); sessionStorage.setItem("codecity.siteTourClosed", "1"); localStorage.setItem("codecity.for", "advanced"); } catch (e) {} ${init}`);
  if (dnt) await page.addInitScript(() => Object.defineProperty(navigator, "doNotTrack", { get: () => "1" }));
  await page.route("https://codecitydev.com/**", route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === "/.netlify/functions/visit") { posts.push(JSON.parse(req.postData() || "{}")); return route.fulfill({ status: 204 }); }
    if (url.pathname.startsWith("/.netlify/")) return route.fulfill({ status: 404 });
    const file = path.join(SITE, decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html");
    if (!file.startsWith(SITE + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
    return route.fulfill({ status: 200, contentType: types[path.extname(file)] || "application/octet-stream", body: fs.readFileSync(file) });
  });
  await page.goto("https://codecitydev.com/");
  await page.waitForFunction(() => +document.getElementById("sFiles").textContent.replace(/\D/g, "") > 0, null, { timeout: 60000 });
  const click = id => page.evaluate(id => document.getElementById(id).click(), id);
  const flush = async () => { await page.evaluate(() => dispatchEvent(new Event("pagehide"))); await page.waitForTimeout(200); };
  return { page, posts, click, flush };
}

test("a browser that came before says so, and feature uses are sent by name only", { timeout: 90000 }, async t => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch (e) { return t.skip("playwright isn't installed (npm install)"); }
  const browser = await chromium.launch();
  try {
    const { posts, click, flush } = await open(browser, { init: `try { localStorage.setItem("codecity.visitDay", "2020-01-01"); localStorage.setItem("codecity.visitDays", "2"); } catch (e) {}` });
    await flush();
    const load = posts.find(p => "first" in p);
    assert.equal(load.first, true); assert.equal(load.returning, true); assert.equal(load.days, 3);

    posts.length = 0;
    await click("mapBtn"); await click("commitsBtn"); await click("mapBtn");
    await flush();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].use, { map_open: 2, history_open: 1 });
    assert.deepEqual([...posts[0].people].sort(), ["history_open", "map_open"]);
    assert.deepEqual(Object.keys(posts[0]).sort(), ["people", "use"]);   // nothing else leaves

    posts.length = 0;   // the same features again the same day: more uses, no more people
    await click("commitsBtn");
    await flush();
    assert.deepEqual(posts[0].use, { history_open: 1 }); assert.deepEqual(posts[0].people, []);
  } finally { await browser.close(); }
});

test("a first visit isn't marked as a return, and Do Not Track sends nothing", { timeout: 90000 }, async t => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch (e) { return t.skip("playwright isn't installed (npm install)"); }
  const browser = await chromium.launch();
  try {
    const fresh = await open(browser);
    await fresh.flush();
    const load = fresh.posts.find(p => "first" in p);
    assert.equal(load.first, true); assert.equal(load.returning, false); assert.equal(load.days, 1);

    const dnt = await open(browser, { dnt: true });
    await dnt.click("mapBtn"); await dnt.flush();
    assert.deepEqual(dnt.posts, []);
  } finally { await browser.close(); }
});
