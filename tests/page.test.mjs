// The page: site/index.html is the build of code-city.html, and its script parses. (tests/browser/ draws it.)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");

test("site/index.html is up to date with code-city.html", () => {
  const r = spawnSync("python3", ["-c", "import sys, codecity; sys.stdout.buffer.write(codecity.page())"], { cwd: ROOT, maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, String(r.stderr));
  assert.ok(r.stdout.equals(fs.readFileSync(path.join(SITE, "index.html"))), "run: python3 codecity.py build");
});

test("the page's script parses", () => {
  const html = fs.readFileSync(path.join(ROOT, "code-city.html"), "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
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
