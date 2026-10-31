// Inside VS Code: Code City: Open the City starts the local server on the workspace and opens the city beside
// the editor; the server answers; closing the panel stops the server.
const assert = require("assert");
const vscode = require("vscode");

const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(check, what, ms = 60000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(250)) { const v = await check(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}`);
}

exports.run = async function run() {
  const ext = vscode.extensions.all.find(e => e.packageJSON.name === "code-city" && e.extensionPath.endsWith("vscode"));
  assert.ok(ext, "the extension is loaded");
  const api = await ext.activate();
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;

  await vscode.commands.executeCommand("codeCity.open");
  const city = await until(() => api.cityForTests(), "the city to open");
  assert.equal(city.root, root);
  assert.equal(city.panel.title, `City · ${vscode.workspace.workspaceFolders[0].name}`);
  const tab = vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.input instanceof vscode.TabInputWebview && /codeCity/.test(t.input.viewType));
  assert.ok(tab, "the city is open in a tab");

  // the local server answers, and reads this workspace
  const page = await fetch(city.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Code City/);
  const start = await (await fetch(new URL("/api/start", city.url), { headers: { "X-Code-City": "1" } })).json();
  assert.equal(start.src, root);
  const repo = await (await fetch(new URL(`/api/repo?src=${encodeURIComponent(root)}`, city.url), { headers: { "X-Code-City": "1" } })).json();
  assert.deepEqual(repo.files.map(f => f.path).sort(), ["main.py", "util.py"]);

  // closing the city stops its server
  city.panel.dispose();
  await until(() => !api.cityForTests(), "the city to close");
  await until(async () => { try { await fetch(city.url); return false; } catch (e) { return true; } }, "the server to stop", 15000);
  console.log("Code City opened in VS Code, its server answered for the workspace, and closing it stopped the server.");
};
