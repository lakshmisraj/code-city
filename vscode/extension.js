// Code City for VS Code: the workspace as a 3D city in an editor panel.
//
// Runs Code City's local server (server/codecity.py, the same as `code-city .`) on the workspace folder with your
// Python, and shows its page in a webview. The page's Open in editor buttons send a file and line here; Show This
// File in the City sends the active file to the page. With a Gemini key set (kept in VS Code's secret storage),
// Ask, tours and explanations run on this machine, using VS Code's own Node.
const vscode = require("vscode");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const KEY_SECRET = "codeCity.geminiApiKey";
let city = null;   // { root, url, proc, panel } while a city is open
let log;

function activate(context) {
  log = vscode.window.createOutputChannel("Code City");
  context.subscriptions.push(log,
    vscode.commands.registerCommand("codeCity.open", () => openCity(context)),
    vscode.commands.registerCommand("codeCity.reveal", uri => revealFile(uri)),
    vscode.commands.registerCommand("codeCity.setGeminiKey", () => setKey(context)),
    vscode.commands.registerCommand("codeCity.clearGeminiKey", async () => {
      await context.secrets.delete(KEY_SECRET);
      vscode.window.showInformationMessage("Code City: Gemini key removed. Reopen the city to turn Ask off.");
    }),
    { dispose: closeCity });
  return { cityForTests: () => city && { root: city.root, url: city.url, panel: city.panel } };   // read by test/suite.js
}

function deactivate() { closeCity(); }

// Python 3.8+: the codeCity.pythonPath setting, else python3 or python from PATH.
function findPython() {
  const set = vscode.workspace.getConfiguration("codeCity").get("pythonPath");
  for (const py of set ? [set] : ["python3", "python"]) {
    const r = spawnSync(py, ["-c", "import sys; print(sys.version_info >= (3, 8))"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "True") return py;
  }
  return null;
}

async function pickFolder() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length <= 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({ placeHolder: "Which folder should Code City show?" });
}

async function openCity(context) {
  const folder = await pickFolder();
  if (!folder) { vscode.window.showWarningMessage("Code City: open a folder first."); return; }
  const root = folder.uri.fsPath;
  if (city && city.root === root) { city.panel.reveal(); return; }
  closeCity();
  const py = findPython();
  if (!py) {
    const pick = await vscode.window.showErrorMessage("Code City needs Python 3.8 or newer. Install it, or set codeCity.pythonPath.", "Get Python", "Open Settings");
    if (pick === "Get Python") vscode.env.openExternal(vscode.Uri.parse("https://www.python.org/downloads/"));
    if (pick === "Open Settings") vscode.commands.executeCommand("workbench.action.openSettings", "codeCity.pythonPath");
    return;
  }
  let started;
  try { started = await startServer(context, py, root); }
  catch (e) { log.show(true); vscode.window.showErrorMessage(`Code City couldn't start: ${e.message}`); return; }
  const panel = vscode.window.createWebviewPanel("codeCity", `City · ${folder.name}`, vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true });
  city = { root, url: started.url, proc: started.proc, panel };
  vscode.commands.executeCommand("setContext", "codeCity.open", true);
  const page = await vscode.env.asExternalUri(vscode.Uri.parse(`${started.url}?host=vscode`));
  panel.webview.html = webviewHtml(page.toString(true));
  panel.webview.onDidReceiveMessage(msg => onMessage(root, msg));
  panel.onDidDispose(() => { if (city && city.panel === panel) closeCity(); });
}

function startServer(context, py, root) {
  return context.secrets.get(KEY_SECRET).then(key => new Promise((resolve, reject) => {
    const script = path.join(context.extensionPath, "server", "codecity.py");
    // ELECTRON_RUN_AS_NODE makes VS Code's own executable run as Node for the ask server (CODE_CITY_NODE).
    const env = { ...process.env, GEMINI_API_KEY: key || "", CODE_CITY_NODE: process.execPath, ELECTRON_RUN_AS_NODE: "1" };
    const proc = spawn(py, [script, root, "--no-open", "--port", "0"], { env });
    let out = "", done = false;
    const finish = (err, url) => { if (done) return; done = true; err ? reject(err) : resolve({ url, proc }); };
    proc.stdout.on("data", d => {
      log.append(String(d)); out += d;
      const m = /running at (http:\/\/localhost:\d+\/)/.exec(out);
      if (m) finish(null, m[1]);
    });
    proc.stderr.on("data", d => log.append(String(d)));
    proc.on("error", e => finish(e));
    proc.on("exit", code => { finish(new Error(`its server stopped (exit ${code}); see the Code City output`)); if (city && city.proc === proc) closeCity(); });
    setTimeout(() => finish(new Error("its server didn't start within 30 seconds")), 30000);
  }));
}

function closeCity() {
  if (!city) return;
  const { proc, panel } = city;
  city = null;
  vscode.commands.executeCommand("setContext", "codeCity.open", false);
  if (proc && proc.exitCode === null) proc.kill();
  try { panel.dispose(); } catch (e) { /* already closed */ }
}

// The page runs in an iframe from Code City's local server. This frame passes Open in editor messages from the
// page up to the extension, and Show This File messages from the extension down to the page.
function webviewHtml(src) {
  const nonce = crypto.randomBytes(16).toString("base64"), origin = new URL(src).origin;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<style>html, body, iframe { margin: 0; padding: 0; width: 100%; height: 100%; border: 0; overflow: hidden; background: #0b1020; }</style></head>
<body><iframe id="city" src="${src}" allow="clipboard-write"></iframe>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi(), frame = document.getElementById("city"), origin = ${JSON.stringify(origin)};
  window.addEventListener("message", e => {
    const d = e.data;
    if (!d || typeof d.codeCity !== "string") return;
    if (e.source === frame.contentWindow) { if (d.codeCity === "open" || d.codeCity === "setKey") vscode.postMessage(d); }
    else if (d.codeCity === "reveal") frame.contentWindow.postMessage(d, origin);
  });
</script></body></html>`;
}

// Open in editor: a path inside the workspace folder, and a line (1-based, 0 for none).
async function onMessage(root, msg) {
  if (msg && msg.codeCity === "setKey") return vscode.commands.executeCommand("codeCity.setGeminiKey");   // the page's "Add your key"
  if (!msg || msg.codeCity !== "open" || typeof msg.path !== "string") return;
  const file = path.resolve(root, ...msg.path.split("/"));
  if (file !== root && !file.startsWith(root + path.sep)) return;   // nothing outside the workspace folder
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const line = Math.max(0, (Number.isInteger(msg.line) ? msg.line : 0) - 1);
    const at = new vscode.Position(Math.min(line, Math.max(0, doc.lineCount - 1)), 0);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(at, at) });
  } catch (e) { vscode.window.showWarningMessage(`Code City: couldn't open ${msg.path}.`); }
}

// Show This File in the City: the active editor's file (or the one right-clicked in the explorer).
function revealFile(uri) {
  if (!city) { vscode.window.showInformationMessage("Code City: open the city first (Code City: Open the City)."); return; }
  const target = uri && uri.fsPath ? uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
  if (!target || target.scheme !== "file") return;
  const rel = path.relative(city.root, target.fsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) { vscode.window.showInformationMessage("Code City: that file isn't in the folder the city shows."); return; }
  city.panel.reveal(undefined, true);
  city.panel.webview.postMessage({ codeCity: "reveal", path: rel.split(path.sep).join("/") });
}

const KEY_PAGE = "https://aistudio.google.com/apikey";   // where to get a free Gemini key
async function setKey(context) {
  const paste = "Paste my key", get = "Get a free key";
  const how = await vscode.window.showInformationMessage("Code City: Ask, tours and explanations use your own Gemini API key. It's free from Google AI Studio.", paste, get);
  if (!how) return;
  if (how === get) await vscode.env.openExternal(vscode.Uri.parse(KEY_PAGE));
  const key = await vscode.window.showInputBox({
    title: "Gemini API key for Code City",
    prompt: "Used for Ask, tours and explanations, from this machine. Kept in VS Code's secret storage. Get one free at aistudio.google.com/apikey.",
    password: true, ignoreFocusOut: true,
  });
  if (!key) return;
  await context.secrets.store(KEY_SECRET, key.trim());
  const reopen = city ? "Reopen the city" : null;
  const pick = await vscode.window.showInformationMessage("Code City: Gemini key saved. Ask turns on the next time the city opens.", ...(reopen ? [reopen] : []));
  if (pick === reopen) { closeCity(); openCity(context); }
}

module.exports = { activate, deactivate, webviewHtml };
