// "Ask the city": answer a question about a repo by pointing at the files that matter.
// Claude sees the repo's file list (paths, sizes, languages), not file contents, and returns a short answer
// plus the files to light up. Asking needs a GitHub sign-in, checked with GitHub here, so the site's Claude
// budget can't be spent anonymously. Needs ANTHROPIC_API_KEY in the site's environment variables.
// GET tells the page whether asking is set up.
const Anthropic = require("@anthropic-ai/sdk").default;
const { betaZodOutputFormat } = require("@anthropic-ai/sdk/helpers/beta/zod");
const { z } = require("zod");

const MAX_QUESTION = 300, MAX_FILES = 2500, MAX_ANSWER_FILES = 12;
const LOW_PRIORITY = /\.(md|mdx|rst|txt|json|ya?ml|toml|ini|xml|lock|env|gradle)$/i;   // dropped first when a repo is too big

const Answer = z.object({
  answer: z.string(),
  files: z.array(z.object({ path: z.string(), why: z.string() })),
});

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
  const enabled = !!process.env.ANTHROPIC_API_KEY;
  if (event.httpMethod === "GET") return json(200, { enabled });
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  if (!enabled) return json(503, { error: "Ask the city isn't set up on this site yet." });

  const token = String(event.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { error: "Sign in with GitHub to ask questions." });
  const who = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "code-city" },
  }).catch(() => null);
  if (!who || !who.ok) return json(401, { error: "Your GitHub sign-in has expired. Sign in again to ask questions." });

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

  const client = new Anthropic({ timeout: 9000, maxRetries: 0 });   // stay inside the function's time limit
  let res;
  try {
    res = await client.beta.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(Answer) },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          // The file list goes first and is cached, so more questions about the same repo are cheaper.
          { type: "text", text: `Repository: ${repo}\nFiles${files.length < total ? ` (${files.length} of ${total}, code first)` : ""}:\n${fileList(files)}`, cache_control: { type: "ephemeral" } },
          { type: "text", text: `Question: ${question}` },
        ],
      }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json(429, { error: "Lots of questions right now. Try again in a minute." });
    if (e instanceof Anthropic.APIConnectionTimeoutError) return json(504, { error: "That took too long to answer. Try a narrower question." });
    if (e instanceof Anthropic.APIError) return json(502, { error: "Claude couldn't answer just now. Try again in a moment." });
    throw e;
  }
  if (res.stop_reason === "refusal") return json(200, { answer: "Claude couldn't help with that question. Try asking about the code in another way.", files: [] });
  const out = res.parsed_output;
  if (!out) return json(502, { error: "Claude's answer came back in an unexpected shape. Try again." });
  const known = new Set(files.map(f => f.path));
  return json(200, { answer: out.answer, files: out.files.filter(f => known.has(f.path)).slice(0, MAX_ANSWER_FILES) });
};

exports.fileList = fileList;   // for tests
