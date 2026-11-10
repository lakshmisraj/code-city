// The page stays responsive on a big repo. A synthetic repo of 3,000 files (several packages, real imports and
// functions) opens in the local app, and the time the page spends running its own code is measured while it reads
// the code, when the Workflows tour opens, when a part's workflows are found and written, and when more are found.
// Each of the freezes fixed so far would fail it: the tour panel redrawing in a loop, the merge map trying every
// order of the workflows, the whole city recomputed every frame. It measures the page's own code (Chrome's
// profiler), not its long tasks: test machines have no graphics card, so drawing is done in software there, which
// would swamp the measure; long tasks are reported too, for a run on a machine with one.
// Gemini is a stand-in answered by the test, so nothing leaves this machine.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILES = 3000;
const BUSY_SHARE = 0.25;   // the page's own code may run at most this share of any stretch
const ANSWER_MS = 15000;   // a page that doesn't answer for this long has frozen: fail now, not at the test's timeout
const inTime = (what, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: the page didn't answer for ${ANSWER_MS / 1000} s (frozen)`)), ANSWER_MS))]);

function bigRepo() {   // packages of modules; each file imports a neighbour and defines functions that call each other
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-city-speed-")));
  const packs = [["web", "tsx", 0.4], ["server", "ts", 0.35], ["worker", "py", 0.15], ["cli", "py", 0.1]];
  for (const [pack, ext, share] of packs) {
    const n = Math.round(FILES * share);
    for (let i = 0; i < n; i++) {
      const mod = `m${i % 12}`, dir = path.join(repo, "packages", pack, "src", mod);
      fs.mkdirSync(dir, { recursive: true });
      const prev = `f${Math.max(0, i - 12)}`;
      const body = ext === "py"
        ? `from .${prev} import run_${Math.max(0, i - 12)}\n\n\ndef run_${i}(x):\n    return helper_${i}(run_${Math.max(0, i - 12)}(x))\n\n\ndef helper_${i}(x):\n    return x + ${i}\n`
        : `import { run${Math.max(0, i - 12)} } from "./${prev}";\n\nexport function run${i}(x: number) {\n  return helper${i}(run${Math.max(0, i - 12)}(x));\n}\n\nfunction helper${i}(x: number) {\n  return x + ${i};\n}\n`;
      fs.writeFileSync(path.join(dir, `f${i}.${ext}`), body);
    }
  }
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "first");
  return repo;
}

test("a big repo keeps the page responsive: reading it, the tour, and a part's workflows", { timeout: 600000 }, async t => {
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch (e) { return t.skip("playwright isn't installed (npm install)"); }
  const repo = bigRepo();
  const env = { ...process.env }; delete env.GEMINI_API_KEY;
  const srv = spawn("python3", [path.join(ROOT, "codecity.py"), repo, "--no-open", "--port", "0"], { stdio: ["ignore", "pipe", "inherit"], env });
  const browser = await chromium.launch();
  try {
    const base = await new Promise((resolve, reject) => { let o = ""; srv.stdout.on("data", d => { o += d; const m = /running at (http:\/\/localhost:\d+)\//.exec(o); if (m) resolve(m[1]); }); srv.on("exit", c => reject(new Error(`code-city exited (${c})`))); });
    // A small window: test browsers have no graphics card, so drawing is done in software and a big window would
    // measure that, not the page's own work, which is what this test is about.
    const page = await browser.newPage({ viewport: { width: 900, height: 560 } }), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.addInitScript(() => {
      try { localStorage.setItem("codecity.siteTour.here", "1"); localStorage.setItem("codecity.startHint", "1"); sessionStorage.setItem("codecity.siteTourClosed", "1"); } catch (e) { /* no storage */ }
      window.__long = []; new PerformanceObserver(l => l.getEntries().forEach(e => window.__long.push([e.startTime, e.duration]))).observe({ type: "longtask", buffered: true });
    });
    // Gemini, answered here: a part has twelve workflows, written in batches
    await page.route("**/.netlify/functions/ask*", async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { enabled: true, open: true } });
      const b = JSON.parse(route.request().postData()), ps = b.files.map(f => f.path);
      if (b.stage === "outline" && b.part) {
        const inPart = ps.filter(p => p.startsWith(b.part)), more = (b.existing || []).length ? 3 : 0;
        return route.fulfill({ json: { workflows: Array.from({ length: 12 }, (_, k) => ({ name: `${b.part} flow ${k + more}`, feature: "Does a thing.", summary: "", merged: [], feeds: k ? [`${b.part} flow ${k - 1 + more}`] : [],
          steps: inPart.slice((k + more) * 5, (k + more) * 5 + 5).map(p => ({ path: p, title: "Step", narration: "", change: "" })) })) } });
      }
      if (b.stage === "narrate" && b.workflows) return route.fulfill({ json: { workflows: b.workflows.map(w => ({ name: w.name, summary: "How it works.", steps: w.steps.map(st => ({ path: st.path, narration: "It does this.", change: "change it" })) })) } });
      return route.fulfill({ json: { steps: [] } });
    });
    await page.goto(`${base}/?for=beginner`);
    await page.waitForFunction(n => +document.getElementById("sFiles").textContent.replace(/,/g, "").split(" ")[0] > n, FILES * 0.9, { timeout: 240000, polling: 500 });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
    const stretch = async (label, act, ms) => {
      const t0 = await inTime(label, page.evaluate(() => performance.now()));
      await cdp.send("Profiler.start");
      await inTime(label, act());
      await page.waitForTimeout(ms);
      const t1 = await inTime(label, page.evaluate(() => performance.now()));
      const { profile } = await inTime(label, cdp.send("Profiler.stop"));
      // the page's own code: every sample but idle, garbage collection and the browser's native work (drawing)
      const byId = new Map(profile.nodes.map(n => [n.id, n])), top = {};
      let busy = 0;
      profile.samples.forEach((id, i) => { const f = byId.get(id).callFrame; if (/^\((idle|program|garbage collector|root)\)$/.test(f.functionName)) return;
        const d = (profile.timeDeltas[i] || 0) / 1000; busy += d; const k = `${f.functionName || "(anon)"}:${f.lineNumber + 1}`; top[k] = (top[k] || 0) + d; });
      const long = await page.evaluate(([a, b]) => window.__long.filter(([at]) => at >= a && at < b), [t0, t1]);
      const worst = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${Math.round(v)} ms`).join(", ");
      t.diagnostic(`${label}: own code ran ${Math.round(busy)} of ${Math.round(t1 - t0)} ms (most: ${worst || "none"}); ${long.length} long tasks, longest ${Math.round(Math.max(0, ...long.map(x => x[1])))} ms`);
      assert.ok(busy < (t1 - t0) * BUSY_SHARE, `${label}: the page's own code ran ${Math.round(busy)} of ${Math.round(t1 - t0)} ms (most: ${worst})`);
    };
    await stretch("reading the repo", async () => {}, 8000);
    await stretch("opening the Workflows tour", () => page.evaluate(() => document.getElementById("tourBtn2").click()), 3000);
    assert.ok(await page.$("#sideBody .part-chip"), "the tour opens on the parts of the code");
    await stretch("a part's workflows, found and written", () => page.click("#sideBody .part-chip"), 6000);
    assert.ok((await page.$$("#sideBody .wf-card")).length >= 12, "the part's workflows are listed");
    const more = await page.$("#sideBody [data-refind]");
    if (more) await stretch("finding more workflows", () => more.click(), 4000);
    assert.deepEqual(errors, [], "no errors on the page");
  } finally {
    await browser.close(); srv.kill();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
