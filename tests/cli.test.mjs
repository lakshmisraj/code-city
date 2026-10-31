// The code-city command on a throwaway repo: it opens the folder it was given, and nothing else outside your home.
import { test, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "codecity.py");
let repo, proc, base;
const api = (p, headers = { "X-Code-City": "1" }) => fetch(base + p, { headers });

before(async () => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-city-repo-")));   // outside your home folder
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.py"), "import util\ndef main():\n    util.go()  # TODO tidy\n");
  fs.writeFileSync(path.join(repo, "src", "util.py"), "def go():\n    pass\n");
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "first");
  proc = spawn("python3", [CLI, repo, "--no-open", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  base = await new Promise((resolve, reject) => {
    let out = "";
    proc.stdout.on("data", d => { out += d; const m = /running at (http:\/\/localhost:\d+)\//.exec(out); if (m) resolve(m[1]); });
    proc.on("exit", code => reject(new Error(`code-city exited (${code}): ${out}`)));
  });
});
after(() => { if (proc) proc.kill(); if (repo) fs.rmSync(repo, { recursive: true, force: true }); });

test("it serves the page", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>Code City<\/title>/);
});
test("the page learns which folder to open", async () => {
  assert.deepEqual(await (await api("/api/start")).json(), { src: repo });
});
test("that folder is read, with its history", async () => {
  const city = await (await api("/api/repo?src=" + encodeURIComponent(repo))).json();
  assert.equal(city.name, path.basename(repo));
  assert.deepEqual(city.files.map(f => f.path), ["src/app.py", "src/util.py"]);
  assert.equal(city.history.commits.length, 1);
});
test("other folders outside your home are still refused", async () => {
  const r = await api("/api/repo?src=" + encodeURIComponent(path.dirname(repo)));
  assert.equal(r.status, 400);
});
test("other websites can't ask", async () => {
  assert.equal((await api("/api/start", {})).status, 403);
});
test("a name that's neither a folder nor a repo is refused", () => {
  const r = spawnSync("python3", [CLI, path.join(repo, "missing"), "--no-open"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /isn't a folder, a repo URL or owner\/name/);
});
test("--version", () => {
  assert.match(execFileSync("python3", [CLI, "--version"], { encoding: "utf8" }), /^code-city \d+\.\d+\.\d+/);
});

// Ask with your own key: requests go through to the site's own ask.mjs (here with a dummy key, so they stop
// before Gemini), with no sign-in, and only from the page.
test("with GEMINI_API_KEY set, Ask runs locally with no sign-in", { timeout: 30000 }, async () => {
  const p = spawn("python3", [CLI, repo, "--no-open", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GEMINI_API_KEY: "dummy" } });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = "";
      p.stdout.on("data", d => { out += d; const m = /running at (http:\/\/localhost:\d+)\/[\s\S]*Ask is (on|off)/.exec(out); if (m) m[2] === "on" ? resolve(m[1]) : reject(new Error(out)); });
      p.on("exit", code => reject(new Error(`code-city exited (${code}): ${out}`)));
    });
    const ask = url + "/.netlify/functions/ask";
    assert.deepEqual(await (await fetch(ask)).json(), { enabled: true, open: true });
    const r = await fetch(ask, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "explain", files: [], code: [] }) });
    assert.equal(r.status, 400, "reached ask.mjs, which refuses an explain with no code");
    assert.match((await r.json()).error, /no (code|files)/i);
    const other = await fetch(ask, { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" }, body: "{}" });
    assert.equal(other.status, 403);
  } finally { p.kill(); }
});

test("new files that aren't committed yet are in the city, ignored ones aren't", async () => {
  fs.writeFileSync(path.join(repo, "src", "new.py"), "def fresh():\n    pass\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "secret.py\n");
  fs.writeFileSync(path.join(repo, "src", "secret.py"), "KEY = 1\n");
  const city = await (await api("/api/repo?src=" + encodeURIComponent(repo))).json();
  const paths = city.files.map(f => f.path);
  assert.ok(paths.includes("src/new.py"));
  assert.ok(!paths.includes("src/secret.py"));
});

test("a repo with no commits yet shows its files, with no history", () => {
  const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-city-fresh-")));
  try {
    fs.writeFileSync(path.join(fresh, "a.py"), "print(1)\n");
    execFileSync("git", ["-C", fresh, "init", "-q"]);
    const out = execFileSync("python3", ["-c", "import json, sys, codecity; c = codecity.build_city(sys.argv[1]); print(json.dumps([[f['path'] for f in c['files']], c['history']]))", fresh], { cwd: ROOT, encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), [["a.py"], null]);
  } finally { fs.rmSync(fresh, { recursive: true, force: true }); }
});
