// Code City's dev server: the dev copy of the site, signed in as you, with the dev copy of the Ask function.
//
//   node dev-server.mjs        then open http://codecity.localhost:8813
//
// Reads GITHUB_TOKEN and GEMINI_API_KEY from .env (copy .env.example; git ignores .env). The page is signed in
// with the token on every load, and /.netlify/functions/ask runs netlify/functions/ask.mjs here, so changes to
// it are tried before they're deployed. Question limits and timing notes live in Netlify Blobs, which only
// exists on Netlify, so they're off here.
//
// It only listens on this machine (127.0.0.1) and only answers requests addressed to codecity.localhost, so
// nothing on the network, and no other website (even through DNS rebinding), can read the page holding the
// token or spend questions through it. Like Jupyter, it prints a link with a one-time key at start: only a
// browser that opened it (and so holds its cookie) gets the signed-in page or can ask, so other programs on this
// machine can't read the token from it. Needs Node 18+ and Python 3 (to rebuild the page); nothing to install.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(ROOT, "site");
const PORT = +process.env.PORT || 8813;
const HOST = `codecity.localhost:${PORT}`;   // a plain "localhost" would put the page in local-app mode
const ENV_FILE = process.env.ENV_FILE || path.join(ROOT, ".env");
const KEY = crypto.randomBytes(24).toString("hex");   // this run's key: in the link printed below, then a cookie
const hasKey = req => (req.headers.cookie || "").split(/;\s*/).includes("cc_dev=" + KEY);

// .env: KEY=value lines, # comments, optional quotes. Values already in the environment win.
function loadEnv(file) {
  if (!fs.existsSync(file)) { console.error(`No ${path.relative(ROOT, file) || file} file. Copy .env.example to .env and fill it in.`); process.exit(1); }
  if (process.platform !== "win32" && fs.statSync(file).mode & 0o077) {
    console.error(`${file} can be read by other users on this machine. Run: chmod 600 "${file}"`); process.exit(1);
  }
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}
loadEnv(ENV_FILE);
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error("GITHUB_TOKEN is empty in .env: the dev page signs in with it."); process.exit(1); }
process.env.ASK_LOCAL = "1";
const ask = process.env.GEMINI_API_KEY ? (await import(pathToFileURL(path.join(ROOT, "netlify/functions/ask.mjs")).href)).default : null;

// site/index.html is built from code-city.html; rebuild it whenever the source is newer.
function freshPage() {
  const src = path.join(ROOT, "code-city.html"), out = path.join(SITE, "index.html");
  if (!fs.existsSync(out) || fs.statSync(src).mtimeMs > fs.statSync(out).mtimeMs) {
    const r = spawnSync("python3", ["codecity.py", "build"], { cwd: ROOT, encoding: "utf8" });
    if (r.status !== 0) console.error("Couldn't rebuild site/index.html:", r.stderr || r.error);
  }
  // Signed in before the page's own script runs: it reads the sign-in from this browser's storage.
  const signin = `<script>try { localStorage.setItem("codecity.githubOAuth", ${JSON.stringify(TOKEN).replace(/</g, "\\u003c")}); } catch (e) {}</script>`;
  return fs.readFileSync(out, "utf8").replace(/<head>/i, m => m + signin);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".wasm": "application/wasm", ".md": "text/plain; charset=utf-8" };
// The same Content-Security-Policy as the live site (from netlify.toml), so anything it would block shows up here first.
const CSP = (/Content-Security-Policy\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8")) || [])[1];
function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(CSP && type.startsWith("text/html") ? { "Content-Security-Policy": CSP } : {}) });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const readBody = req => new Promise((resolve, reject) => { const parts = []; req.on("data", c => parts.push(c)); req.on("end", () => resolve(Buffer.concat(parts).toString("utf8"))); req.on("error", reject); });

http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== HOST) return send(res, 421, { error: `Open http://${HOST}` });   // stops DNS rebinding
    const url = new URL(req.url, `http://${HOST}`);
    if (url.searchParams.get("key") === KEY) {   // the printed link: remember this browser, then drop the key from the address
      url.searchParams.delete("key");
      res.writeHead(302, { Location: url.pathname + url.search, "Set-Cookie": `cc_dev=${KEY}; Path=/; HttpOnly; SameSite=Strict`, "Cache-Control": "no-store" });
      return res.end();
    }
    if (url.pathname === "/.netlify/functions/github-signout") return send(res, 200, { revoked: false });   // the .env token stays yours
    if (url.pathname === "/.netlify/functions/github-login") {
      if (url.searchParams.has("check")) return send(res, 200, { enabled: true });
      res.writeHead(302, { Location: "/" }); return res.end();   // already signed in, from .env
    }
    if (url.pathname === "/.netlify/functions/ask") {
      if (!ask) return req.method === "GET" ? send(res, 200, { enabled: false }) : send(res, 503, { error: "Add GEMINI_API_KEY to .env to use Ask on the dev server." });
      // only this page may spend questions: other sites can't make same-origin requests
      if (req.method !== "GET" && (!hasKey(req) || !["same-origin", "none", undefined].includes(req.headers["sec-fetch-site"]))) return send(res, 403, { error: "Only the dev page can ask. Open the link the dev server printed." });
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const r = await ask(new Request(url, { method: req.method, headers: req.headers, body }));
      res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (!hasKey(req)) return send(res, 401, "Open the link the dev server printed in its terminal (it has this run's key).", "text/plain; charset=utf-8");
      return send(res, 200, freshPage(), TYPES[".html"]);
    }
    const file = path.join(SITE, decodeURIComponent(url.pathname));
    if (!file.startsWith(SITE + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, "Not found", "text/plain");
    send(res, 200, fs.readFileSync(file), TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "The dev server hit an error; see its terminal." });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Code City dev: http://${HOST}/?key=${KEY}`);
  console.log(`  open that link (it has this run's key); signed in from .env${ask ? ", Ask runs netlify/functions/ask.mjs here" : "; add GEMINI_API_KEY to .env for Ask"}`);
});
