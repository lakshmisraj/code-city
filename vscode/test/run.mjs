// Runs the extension inside a real VS Code (a copy downloaded into .vscode-test/, separate from yours) on a
// small git repo, through test/suite.js. `npm run test:vscode`; it opens a VS Code window for a few seconds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [path.join(HERE, "scripts", "prepare-server.mjs")], { stdio: "inherit" });   // server/ as it would ship

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-city-vscode-")));
fs.writeFileSync(path.join(repo, "main.py"), "from util import helper\n\nif __name__ == \"__main__\":\n    helper()\n");
fs.writeFileSync(path.join(repo, "util.py"), "def helper():\n    return 1\n");
const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
git("init", "-q"); git("add", "-A"); git("commit", "-qm", "first");

try {
  // newer macOS builds name the program Code, where the runner still expects Electron
  let exe = await downloadAndUnzipVSCode();
  if (!fs.existsSync(exe) && fs.existsSync(path.join(path.dirname(exe), "Code"))) exe = path.join(path.dirname(exe), "Code");
  await runTests({
    vscodeExecutablePath: exe,
    extensionDevelopmentPath: HERE,
    extensionTestsPath: path.join(HERE, "test", "suite.js"),
    launchArgs: [repo, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes"],
  });
} catch (e) {
  console.error("The VS Code test failed:", e.message || e);
  process.exitCode = 1;
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}
