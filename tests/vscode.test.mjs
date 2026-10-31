// The VS Code extension, against a stand-in for the vscode API: it serves the workspace's city into a webview,
// opens files the page asks for (only inside the workspace), shows the active file in the city, and stops its
// server when the panel closes.
import { test, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let repo, ext, vs, commands, context;

function fakeVscode() {
  const calls = { shown: [], posted: [], context: {}, messages: [] };
  const panel = {
    webview: { html: "", onDidReceiveMessage(fn) { panel.onMessage = fn; }, postMessage(m) { calls.posted.push(m); return Promise.resolve(true); } },
    onDidDispose(fn) { panel.onDispose = fn; }, reveal() {}, dispose() { panel.disposed = true; if (panel.onDispose) panel.onDispose(); },
  };
  class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
  class Range { constructor(start, end) { Object.assign(this, { start, end }); } }
  return {
    calls, panel, Position, Range,
    ViewColumn: { One: 1, Beside: -2 },
    Uri: { parse: s => ({ toString: () => s, scheme: s.split(":")[0] }), file: p => ({ fsPath: p, scheme: "file" }) },
    env: { asExternalUri: async u => u, openExternal() {} },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: async (id, k, v) => { if (id === "setContext") calls.context[k] = v; } },
    window: {
      createOutputChannel: () => ({ append() {}, show() {}, dispose() {} }),
      createWebviewPanel: (id, title) => { panel.title = title; return panel; },
      showTextDocument: async (doc, opts) => { calls.shown.push({ file: doc.file, line: opts.selection.start.line }); },
      showInformationMessage: async m => { calls.messages.push(m); }, showWarningMessage: async m => { calls.messages.push(m); }, showErrorMessage: async m => { calls.messages.push(m); },
      activeTextEditor: null,
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: () => "" }),
      openTextDocument: async uri => { if (!fs.existsSync(uri.fsPath)) throw new Error("missing"); return { file: uri.fsPath, lineCount: fs.readFileSync(uri.fsPath, "utf8").split("\n").length }; },
    },
  };
}

before(() => {
  execFileSync(process.execPath, [path.join(ROOT, "vscode", "scripts", "prepare-server.mjs")], { stdio: "ignore" });
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-city-vscode-")));
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.py"), "import util\n\ndef main():\n    util.go()\n");
  fs.writeFileSync(path.join(repo, "src", "util.py"), "def go():\n    pass\n");
  execFileSync("git", ["-C", repo, "init", "-q"]);
  vs = fakeVscode();
  vs.workspace.workspaceFolders = [{ uri: { fsPath: repo }, name: "shop" }];
  commands = new Map();
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === "vscode" ? vs : load.call(this, request, ...rest); };
  ext = createRequire(import.meta.url)("../vscode/extension.js");
  context = { subscriptions: [], extensionPath: path.join(ROOT, "vscode"), secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } };
  ext.activate(context);
});
after(() => { ext && ext.deactivate(); if (repo) fs.rmSync(repo, { recursive: true, force: true }); });

let pageUrl;
test("Open the City serves the workspace's city into a panel", { timeout: 40000 }, async () => {
  await commands.get("codeCity.open")();
  assert.equal(vs.panel.title, "City · shop");
  assert.equal(vs.calls.context["codeCity.open"], true);
  pageUrl = /<iframe id="city" src="([^"]+)"/.exec(vs.panel.webview.html)[1];
  assert.match(pageUrl, /^http:\/\/localhost:\d+\/\?host=vscode$/);
  assert.match(vs.panel.webview.html, /frame-src http:\/\/localhost:\d+;/);
  assert.equal((await fetch(pageUrl)).status, 200);
  const start = await (await fetch(new URL("/api/start", pageUrl), { headers: { "X-Code-City": "1" } })).json();
  assert.equal(start.src, repo);
});
test("Open in editor opens the file at its line", async () => {
  await vs.panel.onMessage({ codeCity: "open", path: "src/app.py", line: 3 });
  assert.deepEqual(vs.calls.shown.pop(), { file: path.join(repo, "src", "app.py"), line: 2 });
});
test("nothing outside the workspace is opened", async () => {
  await vs.panel.onMessage({ codeCity: "open", path: "../../etc/hosts", line: 1 });
  await vs.panel.onMessage({ codeCity: "open", path: "/etc/hosts", line: 1 });
  assert.equal(vs.calls.shown.length, 0);
});
test("Show This File in the City sends the active file's path", () => {
  vs.window.activeTextEditor = { document: { uri: { fsPath: path.join(repo, "src", "util.py"), scheme: "file" } } };
  commands.get("codeCity.reveal")();
  assert.deepEqual(vs.calls.posted.pop(), { codeCity: "reveal", path: "src/util.py" });
});
test("closing the panel stops the server", async () => {
  vs.panel.dispose();
  assert.equal(vs.calls.context["codeCity.open"], false);
  await new Promise(r => setTimeout(r, 300));
  await assert.rejects(fetch(pageUrl));
});
