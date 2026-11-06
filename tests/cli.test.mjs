// The code-city command on a throwaway repo: it opens the folder it was given, and nothing else outside your home.
import { test, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import net from "node:net";
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
    const r = await fetch(ask, { method: "POST", headers: { "Content-Type": "application/json", "X-Code-City": "1" }, body: JSON.stringify({ mode: "explain", files: [], code: [] }) });
    assert.equal(r.status, 400, "reached ask.mjs, which refuses an explain with no code");
    assert.match((await r.json()).error, /no (code|files)/i);
    const other = await fetch(ask, { method: "POST", headers: { "X-Code-City": "1", "Sec-Fetch-Site": "cross-site" }, body: "{}" });
    assert.equal(other.status, 403);
    const simple = await fetch(ask, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });   // what a form or no-cors fetch can send
    assert.equal(simple.status, 403);
    const raw = await new Promise((resolve, reject) => {   // fetch won't send a bad Content-Length, so write it by hand
      const u = new URL(ask), sock = net.connect(+u.port, "127.0.0.1", () => sock.end(`POST ${u.pathname} HTTP/1.1\r\nHost: localhost:${u.port}\r\nX-Code-City: 1\r\nContent-Length: -1\r\n\r\n`));
      let got = ""; sock.on("data", d => { got += d; }); sock.on("end", () => resolve(got)); sock.on("error", reject);
    });
    assert.match(raw, /^HTTP\/1\.\d 413/, "a bad Content-Length is refused");
  } finally { p.kill(); }
});

// The key prompt needs a real terminal, so this runs code-city in one, answers the prompt, and returns what it showed.
const IN_TERMINAL = `
import os, pty, re, select, signal, sys, time
cli, answer = sys.argv[1], sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.executable, [sys.executable, cli, "--no-open", "--port", "0"])
out, sent, end = b"", False, time.time() + 25
while time.time() < end and not re.search(rb"Ask is [^\\r\\n]*\\r?\\n", out):
    if select.select([fd], [], [], 0.5)[0]:
        try:
            got = os.read(fd, 4096)
        except OSError:
            break
        if not got:
            break
        out += got
    if not sent and b"press Enter to skip" in out:
        os.write(fd, answer.encode())
        sent = True
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
sys.stdout.write(out.decode())
`;
const atTerminal = (answer, env = {}) => {
  const clean = { ...process.env, ...env };
  if (!env.GEMINI_API_KEY) delete clean.GEMINI_API_KEY;
  return execFileSync("python3", ["-c", IN_TERMINAL, CLI, answer], { encoding: "utf8", env: clean, timeout: 30000 });
};
const PROMPT = /press Enter to skip/;
test("at a terminal with no key, it asks; the key turns Ask on and isn't shown", { timeout: 35000 }, () => {
  const out = atTerminal("dummy-pasted-key\n");
  assert.match(out, PROMPT);
  assert.match(out, /aistudio\.google\.com\/apikey/);
  assert.match(out, /Ask is on/);
  assert.doesNotMatch(out, /dummy-pasted-key/);
});
test("pressing Enter skips the key and the city still opens", { timeout: 35000 }, () => {
  const out = atTerminal("\n");
  assert.match(out, /running at http:\/\/localhost/);
  assert.match(out, /Ask is off/);
});
test("Ctrl+C at the prompt quits", { timeout: 35000 }, () => {
  const out = atTerminal("\x03");
  assert.match(out, PROMPT);
  assert.doesNotMatch(out, /running at/);
});
test("a key that's already set isn't asked for again", { timeout: 35000 }, () => {
  const out = atTerminal("\n", { GEMINI_API_KEY: "dummy" });
  assert.doesNotMatch(out, PROMPT);
  assert.match(out, /Ask is on/);
});
test("with no Node a key couldn't help, so it doesn't ask", { timeout: 35000 }, () => {
  const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  const clean = { ...process.env, PATH: "/nonexistent" }; delete clean.GEMINI_API_KEY; delete clean.CODE_CITY_NODE;
  const out = execFileSync(python, ["-c", IN_TERMINAL, CLI, "\n"], { encoding: "utf8", env: clean, timeout: 30000 });
  assert.doesNotMatch(out, PROMPT);
  assert.match(out, /Ask is off/);
});
test("with no terminal, as under VS Code, it doesn't ask", { timeout: 35000 }, async () => {
  const clean = { ...process.env }; delete clean.GEMINI_API_KEY;
  const p = spawn("python3", [CLI, "--no-open", "--port", "0"], { stdio: ["pipe", "pipe", "pipe"], env: clean });
  try {
    const out = await new Promise((resolve, reject) => {
      let got = "";
      p.stdout.on("data", d => { got += d; if (/Ask is off/.test(got)) resolve(got); });
      p.on("exit", code => reject(new Error(`code-city exited (${code}): ${got}`)));
    });
    assert.doesNotMatch(out, /need a Gemini key/);
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

test("a symlink pointing out of the repo isn't read", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-city-link-")));
  try {
    fs.mkdirSync(path.join(dir, "repo"));
    fs.writeFileSync(path.join(dir, "secret.txt"), "TOP SECRET\n");
    fs.writeFileSync(path.join(dir, "repo", "a.py"), "print(1)\n");
    fs.symlinkSync(path.join(dir, "secret.txt"), path.join(dir, "repo", "notes.txt"));
    const out = execFileSync("python3", ["-c", "import json, sys, codecity; print(json.dumps([f['path'] for f in codecity.build_city(sys.argv[1])['files']]))", path.join(dir, "repo")], { cwd: ROOT, encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), ["a.py"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
