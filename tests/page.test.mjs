// The page: code-city.html and site/index.html are the build of src/, and its script parses. (tests/browser/ draws it.)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");

test("code-city.html and site/index.html are up to date with src/", () => {
  const body = spawnSync("python3", ["-c", "import sys, codecity; sys.stdout.buffer.write(codecity.assembled().encode('utf-8'))"], { cwd: ROOT, maxBuffer: 64 << 20 });
  assert.equal(body.status, 0, String(body.stderr));
  assert.ok(body.stdout.equals(fs.readFileSync(path.join(ROOT, "code-city.html"))), "code-city.html is stale: run python3 codecity.py build");
  const r = spawnSync("python3", ["-c", "import sys, codecity; sys.stdout.buffer.write(codecity.page())"], { cwd: ROOT, maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, String(r.stderr));
  assert.ok(r.stdout.equals(fs.readFileSync(path.join(SITE, "index.html"))), "site/index.html is stale: run python3 codecity.py build");
});

test("each Netlify site's build is one version, linking only to the others' https addresses", () => {
  const r = spawnSync("python3", ["-c", "import sys, codecity; sys.stdout.buffer.write(codecity.locked(codecity.page(), 'manager', 'beginner=https://b.example/, advanced=https://a.example/,evil=https://x/,advanced2=http://no'))"], { cwd: ROOT, maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, String(r.stderr));
  const html = r.stdout.toString();
  assert.match(html, /const LOCKED_FOR = "manager", SITE_URLS = \{"beginner": "https:\/\/b\.example\/", "advanced": "https:\/\/a\.example\/"\};/);
  assert.doesNotMatch(html, /const LOCKED_FOR = null/);
  assert.match(fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8"), /command = "python3 codecity\.py build --for \\"\$\{CODECITY_FOR:-beginner\}\\"/, "the main site builds as Beginner");
});

test("the page's script parses", () => {
  const html = fs.readFileSync(path.join(ROOT, "src", "page.html"), "utf8");
  const scripts = [fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8"),   // the app, and any other inline script in the page
    ...[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(t => t.trim() !== "// src/app.js")];
  assert.ok(scripts.length > 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-city-"));
  try {
    scripts.forEach((s, i) => {
      const file = path.join(dir, `script${i}.mjs`);
      fs.writeFileSync(file, s);
      const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a workflow shows each line once: a file's lines at its first step, hand-offs not listed twice", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  const body = /\nfunction stepLines\(w, k\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  const stepLines = new Function(`${body}; return stepLines;`)();
  const a = [{ line: 3, note: "starts" }, { line: 9, note: "hands on" }];
  const w = { steps: [{ path: "a.js" }, { path: "b.js" }, { path: "a.js" }], lines: { byPath: new Map([["a.js", a], ["b.js", []]]) },
    handoff: new Map([[0, [{ line: 9, text: "import b" }, { line: 2, text: "import c" }]], [1, []], [2, []]]) };
  const first = stepLines(w, 0), again = stepLines(w, 2);
  assert.deepEqual(first.lines, a);
  assert.deepEqual(first.hand.map(h => h.line), [2], "line 9 is already a line to look at");
  assert.equal(first.handoff.length, 2, "the raw hand-off still says an import line leads on");
  assert.deepEqual(again.lines, [], "the second visit doesn't repeat them");
  assert.equal(again.shownAt, 0, "it points back to step 1");
  assert.equal(stepLines(w, 1).shownAt, -1);
});
