// "Ask the city": answer a question about a repo by pointing at the files that matter, or (mode "tour")
// plan a guided tour: an ordered walk through the files that explain a topic.
// Gemini sees the repo's file list (paths and sizes), not file contents, and returns a short answer plus the
// files to light up. Asking needs a GitHub sign-in, checked with GitHub here, so the site's Gemini budget
// can't be spent anonymously, and each GitHub account gets a few asks an hour (plus a daily cap for the whole
// site) so one visitor can't run up the bill. Needs GEMINI_API_KEY in the site's environment variables;
// ASK_PER_HOUR and ASK_PER_DAY override the limits. GET tells the page whether asking is set up.
const { GoogleGenAI } = require("@google/genai");
const { connectLambda, getStore } = require("@netlify/blobs");

const MODEL = "gemini-3.5-flash-lite";   // Google's fastest model: answers well inside Netlify's 10 s limit
const MAX_QUESTION = 300, MAX_FILES = 2500, MAX_ANSWER_FILES = 12, MAX_TOUR_STOPS = 8;
const BUDGET_MS = 8500;   // Netlify stops the function at 10 s; always answer before that
const PER_HOUR = +process.env.ASK_PER_HOUR || 20, PER_DAY = +process.env.ASK_PER_DAY || 300;
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

const TOUR_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    steps: {
      type: "array",
      maxItems: MAX_TOUR_STOPS,
      items: {
        type: "object",
        properties: { path: { type: "string" }, title: { type: "string" }, narration: { type: "string" } },
        required: ["path", "title", "narration"],
      },
    },
  },
  required: ["title", "steps"],
};

const TOUR_SYSTEM = `You are a friendly guide giving a newcomer a tour of a codebase that is shown as a 3D city, one building per file.
You get the repository name, its file list grouped by folder (each file with its line count), and a topic.
Plan a walk of four to ${MAX_TOUR_STOPS} stops that explains the topic in a sensible order: start where a newcomer should start, then follow how the pieces connect.
For each stop give the file path exactly as it appears in the list (joined with its folder), a title of two to five words, and one or two sentences of narration saying what this file is for and how it leads to the next stop.
Give the tour a short title. You only see names and sizes, not the code, so say "likely" when you infer from names.`;

const DEFAULT_TOUR = "Give a newcomer an overview: where to start reading and how the main parts fit together.";

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

// Adds one to a counter in Netlify Blobs and returns the new count. The etag check means two asks at the
// same moment can't both read the old count; after a few lost races it counts anyway rather than fail.
async function bump(store, key) {
  for (let tries = 0; ; tries++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const n = ((cur && cur.data && cur.data.n) || 0) + 1;
    const res = await store.setJSON(key, { n }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res.modified || tries >= 3) return n;
  }
}
// Returns an error message when this ask would go over a limit, or null. Counts by GitHub account id.
async function overLimit(event, userId) {
  connectLambda(event);
  const store = getStore({ name: "ask-limits", consistency: "strong" });
  const now = new Date(), hour = now.toISOString().slice(0, 13), today = hour.slice(0, 10);
  if (await bump(store, `user/${userId}/${hour}`) > PER_HOUR) return `You've asked ${PER_HOUR} questions this hour. Try again after the hour turns over.`;
  if (await bump(store, `site/${today}`) > PER_DAY) return "Code City has answered all the questions it can today. Try again tomorrow.";
  return null;
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
  const user = await who.json().catch(() => null);
  if (!user || !user.id) return json(503, { error: "Couldn't check your GitHub sign-in just now. Try again in a moment." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "That request wasn't valid JSON." }); }
  const tour = body.mode === "tour";
  const question = (String(body.question || "").trim() || (tour ? DEFAULT_TOUR : "")).slice(0, MAX_QUESTION);
  const repo = String(body.repo || "this repository").slice(0, 120);
  let files = (Array.isArray(body.files) ? body.files : [])
    .filter(f => f && typeof f.path === "string" && f.path.length <= 300)
    .map(f => ({ path: f.path, lines: Math.max(0, Math.min(1e7, Math.round(+f.lines || 0))) }));
  if (!question) return json(400, { error: "Type a question first." });
  if (!files.length) return json(400, { error: "There are no files to ask about yet." });
  const total = files.length;
  if (files.length > MAX_FILES) files = [...files.filter(f => !LOW_PRIORITY.test(f.path)), ...files.filter(f => LOW_PRIORITY.test(f.path))].slice(0, MAX_FILES);

  // Only well-formed asks count towards the limits, and they're checked before Gemini is called.
  let over;
  try { over = await overLimit(event, user.id); }
  catch (e) { console.log(`ask: limit check failed: ${e && e.message}`); return json(503, { error: "Couldn't check the question limit just now. Try again in a moment." }); }
  if (over) return json(429, { error: over });

  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let reply;
  try {
    // The SDK doesn't reliably apply its timeout to this call, so race it against our own deadline.
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Deadline reached"), { name: "TimeoutError" })), Math.max(1000, left())); });
    const interaction = await Promise.race([client.interactions.create({
      model: MODEL,
      system_instruction: tour ? TOUR_SYSTEM : SYSTEM,
      // The file list goes first and the question last, so repeat questions about one repo share a prefix.
      input: `Repository: ${repo}\nFiles${files.length < total ? ` (${files.length} of ${total}, code first)` : ""}:\n${fileList(files)}\n\n${tour ? "Topic" : "Question"}: ${question}`,
      generation_config: { max_output_tokens: 4000 },
      response_format: { type: "text", mime_type: "application/json", schema: tour ? TOUR_SCHEMA : ANSWER_SCHEMA },
    }, { timeout_ms: Math.max(1000, left()) }), deadline]).finally(() => clearTimeout(timer));
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
  const known = new Set(files.map(f => f.path));
  if (tour) {
    if (!reply || !Array.isArray(reply.steps)) return json(502, { error: "Gemini's tour came back in an unexpected shape. Try again." });
    const steps = reply.steps.filter(st => st && known.has(st.path))
      .map(st => ({ path: st.path, title: String(st.title || "").slice(0, 80), narration: String(st.narration || "").slice(0, 400) }))
      .slice(0, MAX_TOUR_STOPS);
    if (!steps.length) return json(502, { error: "Gemini couldn't plan a tour for that. Try a different topic." });
    return json(200, { title: String(reply.title || "A tour of the city").slice(0, 100), steps });
  }
  if (!reply || typeof reply.answer !== "string" || !Array.isArray(reply.files)) return json(502, { error: "Gemini's answer came back in an unexpected shape. Try again." });
  return json(200, {
    answer: reply.answer,
    files: reply.files.filter(f => f && known.has(f.path)).map(f => ({ path: f.path, why: String(f.why || "") })).slice(0, MAX_ANSWER_FILES),
  });
};

exports.fileList = fileList;   // for tests
