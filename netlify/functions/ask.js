// "Ask the city": answer a question about a repo by pointing at the files that matter.
// Gemini sees the repo's file list (paths and sizes), not file contents, and returns a short answer plus the
// files to light up. Asking needs a GitHub sign-in, checked with GitHub here, so the site's Gemini budget
// can't be spent anonymously. Needs GEMINI_API_KEY in the site's environment variables.
// GET tells the page whether asking is set up.
const { GoogleGenAI } = require("@google/genai");

const MODEL = "gemini-3.8-flash";
const MAX_QUESTION = 300, MAX_FILES = 2500, MAX_ANSWER_FILES = 12;
const BUDGET_MS = 8500;   // Netlify stops the function at 10 s; always answer before that
const LOW_PRIORITY = /\.(md|mdx|rst|txt|json|ya?ml|toml|ini|xml|lock|env|gradle)$/i;   // dropped first when a repo is too big

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    files: {
      type: "array",
      maxItems: MAX_ANSWER_FILES,
      items: { type: "object", properties: { path: { type: "string" }, why: { type: "string" } }, required: ["path", "why"] },
    },
  },
  required: ["answer", "files"],
};

const SYSTEM = `You help developers find their way around a codebase that is shown to them as a 3D city, one building per file.
You get the repository name, its file list grouped by folder (each file with its line count), and a question.
Answer in two to four plain sentences. Then pick the files that best answer the question, most relevant first, at most ${MAX_ANSWER_FILES}, each with a reason under fifteen words.
Use paths exactly as they appear in the list, joined with their folder. You only see names and sizes, not the code, so say "likely" when you infer from names.
If nothing in the list answers the question, say so and return no files.`;

// Folder headers followed by file names keeps the list compact, which keeps the request fast.
function fileList(files) {
  const byDir = new Map();
  for (const f of files) {
    const i = f.path.lastIndexOf("/"), dir = i < 0 ? "." : f.path.slice(0, i), name = f.path.slice(i + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(`  ${name} ${f.lines}`);
  }
  return [...byDir].sort(([a], [b]) => a.localeCompare(b)).map(([dir, rows]) => `${dir}/\n${rows.join("\n")}`).join("\n");
}

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

exports.handler = async event => {
  const started = Date.now(), left = () => BUDGET_MS - (Date.now() - started);
  const enabled = !!process.env.GEMINI_API_KEY;
  if (event.httpMethod === "GET") return json(200, { enabled });
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!enabled) return json(503, { error: "Ask the city isn't set up on this site yet." });

  const token = String(event.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { error: "Sign in with GitHub to ask questions." });
  const who = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "code-city" },
    signal: AbortSignal.timeout(2000),
  }).catch(() => null);
  if (!who) { console.log("ask: GitHub check failed to respond"); return json(503, { error: "Couldn't check your GitHub sign-in just now. Try again in a moment." }); }
  if (!who.ok) return json(401, { error: "Your GitHub sign-in has expired. Sign in again to ask questions." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "That request wasn't valid JSON." }); }
  const question = String(body.question || "").trim().slice(0, MAX_QUESTION);
  const repo = String(body.repo || "this repository").slice(0, 120);
  let files = (Array.isArray(body.files) ? body.files : [])
    .filter(f => f && typeof f.path === "string" && f.path.length <= 300)
    .map(f => ({ path: f.path, lines: Math.max(0, Math.min(1e7, Math.round(+f.lines || 0))) }));
  if (!question) return json(400, { error: "Type a question first." });
  if (!files.length) return json(400, { error: "There are no files to ask about yet." });
  const total = files.length;
  if (files.length > MAX_FILES) files = [...files.filter(f => !LOW_PRIORITY.test(f.path)), ...files.filter(f => LOW_PRIORITY.test(f.path))].slice(0, MAX_FILES);

  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let reply;
  try {
    const interaction = await client.interactions.create({
      model: MODEL,
      system_instruction: SYSTEM,
      // The file list goes first and the question last, so repeat questions about one repo share a prefix.
      input: `Repository: ${repo}\nFiles${files.length < total ? ` (${files.length} of ${total}, code first)` : ""}:\n${fileList(files)}\n\nQuestion: ${question}`,
      generation_config: { thinking_level: "low", max_output_tokens: 4000 },
      response_format: { type: "text", mime_type: "application/json", schema: ANSWER_SCHEMA },
    }, { timeout_ms: Math.max(1000, left()) });
    console.log(`ask: ${files.length} files, answered in ${Date.now() - started} ms`);
    reply = JSON.parse(interaction.output_text || "");
  } catch (e) {
    console.log(`ask: failed after ${Date.now() - started} ms: ${e && e.name} status=${e && e.status} ${String(e && e.message).slice(0, 300)}`);
    if (e && (e.status === 429 || /RESOURCE_EXHAUSTED/.test(e.message))) return json(429, { error: "Lots of questions right now. Try again in a minute." });
    if (e && /timeout|timed out|abort/i.test(`${e.name} ${e.message}`)) return json(504, { error: "That took too long to answer. Try a narrower question." });
    // Google's own reason (e.g. "API key not valid", "model not found") helps fix setup problems; it never contains the key.
    const reason = String((e && e.message) || "").replace(/AIza[0-9A-Za-z_-]{20,}/g, "[key]").slice(0, 200);
    return json(502, { error: `Gemini couldn't answer just now${e && e.status ? ` (${e.status})` : ""}${reason ? `: ${reason}` : ""}` });
  }
  if (!reply || typeof reply.answer !== "string" || !Array.isArray(reply.files)) return json(502, { error: "Gemini's answer came back in an unexpected shape. Try again." });
  const known = new Set(files.map(f => f.path));
  return json(200, {
    answer: reply.answer,
    files: reply.files.filter(f => f && known.has(f.path)).map(f => ({ path: f.path, why: String(f.why || "") })).slice(0, MAX_ANSWER_FILES),
  });
};

exports.fileList = fileList;   // for tests
