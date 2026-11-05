// Copies what the extension runs into vscode/server/, laid out like the installed Python package:
// codecity.py, with the page, the parser and the bundled ask server under codecity_assets/.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(HERE, "..");
const OUT = path.join(HERE, "server"), ASSETS = path.join(OUT, "codecity_assets");

// The ask server is bundled from the current ask.mjs every time, so the extension never ships a stale one.
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "--silent", "bundle:ask"], { cwd: ROOT, stdio: "inherit" });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(ASSETS, { recursive: true });
fs.copyFileSync(path.join(ROOT, "codecity.py"), path.join(OUT, "codecity.py"));
fs.copyFileSync(path.join(ROOT, "code-city.html"), path.join(ASSETS, "code-city.html"));
fs.cpSync(path.join(ROOT, "site", "vendor", "tree-sitter"), path.join(ASSETS, "site", "vendor", "tree-sitter"), { recursive: true });
for (const f of ["ask-server.mjs", "ask-server.mjs.LEGAL.txt"]) fs.copyFileSync(path.join(ROOT, "build", f), path.join(ASSETS, f));
fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(HERE, "LICENSE"));
fs.copyFileSync(path.join(ROOT, "NOTICE"), path.join(HERE, "NOTICE"));
console.log(`Prepared ${path.relative(ROOT, OUT)}/`);
