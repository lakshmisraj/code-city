// Ask on a developer's own machine: runs netlify/functions/ask.mjs, the same code as the site, with their own
// Gemini key and no sign-in. `code-city` (codecity.py) starts it when GEMINI_API_KEY is set and Node is installed,
// and passes requests for /.netlify/functions/ask through to it.
//
// It listens on 127.0.0.1 on a free port and prints "ready <port>". Only requests carrying ASK_SECRET (which
// codecity.py makes up each run) are answered, so other programs on the machine can't spend the key.
// The installed `code-city` carries this file bundled with ask.mjs and its packages (npm run bundle:ask).
import http from "node:http";

const SECRET = process.env.ASK_SECRET;
if (!SECRET || !process.env.GEMINI_API_KEY) { console.error("ask-server: needs ASK_SECRET and GEMINI_API_KEY"); process.exit(2); }
process.env.ASK_OPEN = "1";   // set before ask.mjs loads: it reads its settings once
const { default: ask } = await import("../netlify/functions/ask.mjs");

const readBody = req => new Promise((resolve, reject) => { const parts = []; req.on("data", c => parts.push(c)); req.on("end", () => resolve(Buffer.concat(parts).toString("utf8"))); req.on("error", reject); });

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers["x-ask-secret"] !== SECRET) { res.writeHead(403); return res.end(); }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const r = await ask(new Request(new URL(req.url, "http://127.0.0.1"), { method: req.method, headers: { "content-type": "application/json" }, body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Ask hit an error; see the terminal running code-city." }));
  }
});
server.listen(0, "127.0.0.1", () => console.log(`ready ${server.address().port}`));
process.stdin.on("end", () => process.exit(0));   // codecity.py holds our stdin open; when it exits, so do we
process.stdin.resume();
