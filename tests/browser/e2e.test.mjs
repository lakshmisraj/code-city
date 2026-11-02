// A developer's path end to end: `code-city <folder>` opens that folder's city in the browser, and Download as
// Markdown gives its overview.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("code-city <folder> opens its city, and the overview downloads as Markdown", { timeout: 400000 }, async t => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch (e) { return t.skip("playwright isn't installed (npm install)"); }
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-city-e2e-")));
  fs.mkdirSync(path.join(repo, "shop"));
  fs.writeFileSync(path.join(repo, "main.py"), "from shop import cart\n\ndef main():\n    cart.total([1, 2])\n\nif __name__ == \"__main__\":\n    main()\n");
  fs.writeFileSync(path.join(repo, "shop", "__init__.py"), "");
  fs.writeFileSync(path.join(repo, "shop", "cart.py"), "from shop import prices\n\ndef total(items):\n    return sum(prices.price(i) for i in items)\n");
  fs.writeFileSync(path.join(repo, "shop", "prices.py"), "def price(item):\n    return item * 2  # TODO real prices\n");
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "first");

  const server = spawn("python3", [path.join(ROOT, "codecity.py"), repo, "--no-open", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GEMINI_API_KEY: "" } });
  const browser = await chromium.launch();
  try {
    const url = await new Promise((resolve, reject) => {
      let out = "";
      server.stdout.on("data", d => { out += d; const m = /running at (http:\/\/localhost:\d+\/)/.exec(out); if (m) resolve(m[1]); });
      server.on("exit", code => reject(new Error(`code-city exited (${code}): ${out}`)));
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    await page.addInitScript(() => { try { localStorage.setItem("codecity.siteTour.here", "1"); sessionStorage.setItem("codecity.siteTourClosed", "1"); localStorage.setItem("codecity.for", "advanced"); } catch (e) {} });   // the site tour would cover the page
    // Headless Chromium has no GPU and compiles the city's shaders in software, which holds the page up for a while.
    page.setDefaultTimeout(120000);
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(name => document.getElementById("repoName").textContent.startsWith(name), path.basename(repo));
    await page.evaluate(() => document.getElementById("mapBtn").click());   // the page starts with just the city
    await page.waitForFunction(name => document.getElementById("sideSub").textContent.startsWith(name), path.basename(repo));
    await page.locator("[data-map-md]").waitFor();   // shows once the imports are read
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("[data-map-md]").click()]);
    assert.equal(download.suggestedFilename(), `${path.basename(repo)}-overview.md`);
    const md = fs.readFileSync(await download.path(), "utf8");
    assert.match(md, new RegExp(`^# ${path.basename(repo)}: how it's built`));
    assert.match(md, /## Where it starts\n\n- \[`main\.py`\]\(main\.py\)/);
    assert.doesNotMatch(md, /## Most-used files/, "Code structure no longer lists the most-used files");
    assert.doesNotMatch(md, /## Workflows/, "no tour was taken");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
