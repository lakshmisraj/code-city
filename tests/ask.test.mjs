import { test, mock } from "node:test";
import assert from "node:assert";
const FN = new URL("../netlify/functions/ask.mjs", import.meta.url).href;   // the function under test
let reply, lastInput, rejectThinking = false, calls = [], models = [], busyTimes = 0, slowTimes = 0, cutTimes = 0, aborted = 0;
mock.module("@google/genai", { namedExports: { GoogleGenAI: class { constructor() { this.models = { generateContent: async a => { models.push(a.model); if (busyTimes > 0) { busyTimes--; throw Object.assign(new Error("This model is currently experiencing high demand."), { status: 503 }); } if (slowTimes > 0) { slowTimes--; await new Promise((r, j) => { const t = setTimeout(r, 400); a.config.abortSignal.addEventListener('abort', () => { aborted++; clearTimeout(t); j(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })); }); }); } if (cutTimes > 0) { cutTimes--; return { text: '{"answer": "cut', candidates: [{ finishReason: 'MAX_TOKENS' }] }; } calls.push(a.config.thinkingConfig && a.config.thinkingConfig.thinkingLevel.toLowerCase()); if (rejectThinking && a.config.thinkingConfig) throw Object.assign(new Error("thinking_level is not supported for this model"), { status: 400 }); lastInput = { input: a.contents, system_instruction: a.config.systemInstruction, generation_config: { thinking_level: a.config.thinkingConfig && a.config.thinkingConfig.thinkingLevel } }; return { text: JSON.stringify(reply), usageMetadata: { candidatesTokenCount: 5 } }; } }; this.interactions = { create: async a => { calls.push(a.generation_config.thinking_level); if (rejectThinking && a.generation_config.thinking_level) throw Object.assign(new Error("thinking_level is not supported for this model"), { status: 400 }); lastInput = a; return { output_text: JSON.stringify(reply) }; } }; } } } });
const counts = new Map();
mock.module("@netlify/blobs", { namedExports: { getStore: () => ({
  getWithMetadata: async k => counts.has(k) ? { data: { n: counts.get(k) }, etag: "e" } : null,
  setJSON: async (k, v) => { counts.set(k, v.n); return { modified: true }; } }) } });
globalThis.fetch = async () => new Response(JSON.stringify({ id: 7, login: "t" }), { status: 200 });
process.env.GEMINI_API_KEY = "x"; process.env.ASK_HEDGE_MS = "100"; process.env.ASK_RETRY_MS = "20";
process.env.ASK_EXPLAIN_MODELS = "strong-model,gemini-3.5-flash-lite";   // explanations try these first
const { default: handler } = await import(FN);
const call = async body => { const r = await handler(new Request("http://x/", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) })); return [r.status, await r.json()]; };
const files = [{ path: "a.js", lines: 10 }, { path: "b.js", lines: 5 }, { path: "c/d.js", lines: 3 }];
test("explain keeps only real files, lines and links", async () => {
  reply = { summary: "S", files: [
    { path: "a.js", explanation: "E", parts: [{ line: 2, name: "f", note: "n" }, { line: 99, name: "bad", note: "x" }], links: [{ path: "b.js", how: "imports" }, { path: "nope.js", how: "x" }, { path: "a.js", how: "self" }] },
    { path: "zzz.js", explanation: "made up", parts: [], links: [] }] };
  const [st, out] = await call({ mode: "explain", question: "", repo: "r", files, code: [{ path: "a.js", text: "x\ny\nz", imports: ["b.js", 5] }] });
  assert.equal(st, 200);
  assert.deepEqual(out.files.map(f => f.path), ["a.js"]);
  assert.deepEqual(out.files[0].parts.map(p => p.line), [2]);
  assert.deepEqual(out.files[0].links.map(l => l.path), ["b.js"]);
  assert.match(lastInput.input, /--- a\.js ---\nImports these files in the repo: b\.js\n1\| x\n2\| y/);
  assert.match(lastInput.input, /Question: What does this code do/);
});
test("explain with no code is refused", async () => {
  const [st] = await call({ mode: "explain", files, code: [] });
  assert.equal(st, 400);
});
test("explain counts separately from asks", async () => {
  assert.ok([...counts.keys()].some(k => k.includes("/explain/")));
  assert.ok(![...counts.keys()].some(k => /^user\/7\/\d/.test(k)));
});
test("tour returns workflows of real files, with feeds between them", async () => {
  reply = { title: "T", overview: "O", workflows: [
    { name: "Start", summary: "S", steps: [{ path: "a.js", title: "t", narration: "n" }, { path: "nope.js", title: "x", narration: "x" }, { path: "b.js", title: "t2", narration: "n2" }], feeds: ["Serve", "Ghost", "Start"] },
    { name: "Serve", summary: "S2", steps: [{ path: "b.js", title: "t", narration: "n" }, { path: "c/d.js", title: "t", narration: "n" }], feeds: [] },
    { name: "Empty", summary: "x", steps: [{ path: "zzz", title: "t", narration: "n" }], feeds: [] }] };
  const [st, out] = await call({ mode: "tour", files, digest: "README: hello" });
  assert.equal(st, 200);
  assert.deepEqual(out.workflows.map(w => w.name), ["Start", "Serve"]);
  assert.deepEqual(out.workflows[0].steps.map(s => s.path), ["a.js", "b.js"]);
  assert.deepEqual(out.workflows[0].feeds, ["Serve"]);
  assert.equal(out.overview, "O");
  assert.match(lastInput.input, /What the code itself shows[^\n]*\nREADME: hello/);
  assert.match(lastInput.system_instruction, /workflows/);
});
test("workflows that walk mostly the same files become one, and feeds follow it", async () => {
  const st = (...ps) => ps.map(path => ({ path, title: "t", narration: "n" }));
  reply = { title: "T", overview: "O", workflows: [
    { name: "Start", summary: "S", steps: st("a.js", "b.js"), feeds: ["Serve again"] },
    { name: "Serve", summary: "S2", steps: st("b.js", "c/d.js"), feeds: ["Start"] },
    { name: "Serve again", summary: "S3", steps: st("b.js", "c/d.js", "a.js"), feeds: ["Start"] },
    { name: "Other", summary: "S4", steps: st("e.js", "b.js", "f.js"), feeds: ["Start", "Serve"] }] };
  const [code, out] = await call({ mode: "tour", files: [...files, { path: "e.js", lines: 2 }, { path: "f.js", lines: 2 }], question: "fold" });
  assert.equal(code, 200);
  // Serve again has all of Start's files, so Start folds into it, the longer, in Start's place; then Serve's
  // files are all in it too, so Serve folds in on the next pass. Other shares one file of three, so it stays.
  assert.deepEqual(out.workflows.map(w => w.name), ["Serve again", "Other"]);
  assert.deepEqual(out.workflows[0].merged, ["Start", "Serve"]);
  assert.deepEqual(out.workflows[1].merged, []);
  assert.deepEqual(out.workflows[1].feeds, ["Serve again"], "feeds to folded workflows name the one they joined, once");
  assert.deepEqual(out.workflows[0].feeds, [], "never feeds itself");
});
test("an Advanced tour (every) keeps every workflow, overlapping or not, up to five", async () => {
  const st = (...ps) => ps.map(path => ({ path, title: "t", narration: "n" }));
  reply = { title: "T", overview: "O", workflows: [
    { name: "Start", summary: "S", steps: st("a.js", "b.js"), feeds: [] },
    { name: "Start again", summary: "S2", steps: st("a.js", "b.js", "c/d.js"), feeds: [] }] };
  const [code, out] = await call({ mode: "tour", files, question: "every", every: true });
  assert.equal(code, 200);
  assert.deepEqual(out.workflows.map(w => w.name), ["Start", "Start again"], "nothing folds");
  assert.match(lastInput.system_instruction, /two to 5 things/);
  assert.doesNotMatch(lastInput.system_instruction, /Don't tell the same walk twice/);
  await call({ mode: "tour", files, question: "every-not" });
  assert.match(lastInput.system_instruction, /two to 4 things[\s\S]*Don't tell the same walk twice/);
});
test("lines keeps real line numbers of files that were sent", async () => {
  reply = { steps: [{ path: "a.js", lines: [{ line: 2, note: "n" }, { line: 9, note: "past the end" }] }, { path: "zz.js", lines: [{ line: 1, note: "x" }] }] };
  const [st, out] = await call({ mode: "lines", question: "Start", files, code: [{ path: "a.js", text: "x\ny\nz" }] });
  assert.equal(st, 200);
  assert.deepEqual(out.steps, [{ path: "a.js", lines: [{ line: 2, note: "n" }] }]);
  assert.match(lastInput.input, /Workflow: Start/);
});
test("the digest never reaches explain", async () => {
  reply = { summary: "S", files: [] };
  await call({ mode: "explain", files, digest: "SECRET-DIGEST", code: [{ path: "a.js", text: "x" }] });
  assert.doesNotMatch(lastInput.input, /SECRET-DIGEST/);
});
test("plain ask still works", async () => {
  reply = { answer: "A", files: [{ path: "b.js", why: "w" }] };
  const [st, out] = await call({ question: "q", files });
  assert.equal(st, 200); assert.equal(out.files[0].path, "b.js");
});

test("asks with low thinking, and retries without it if the model refuses", async () => {
  reply = { answer: "A", files: [] };
  calls = []; await call({ question: "q", files });
  assert.deepEqual(calls, ["minimal"]);
  rejectThinking = true; calls = [];
  const [st] = await call({ question: "q", files });
  assert.equal(st, 200); assert.deepEqual(calls, ["minimal", "low", undefined]);
  rejectThinking = false;
});

test("a busy reply moves straight on to the next model", async () => {
  reply = { answer: "A", files: [] };
  busyTimes = 2; models = [];
  const [st, out] = await call({ question: "q", files });
  assert.equal(st, 200); assert.equal(out.answer, "A");
  assert.equal(models.length, 3); assert.equal(new Set(models).size, 3, "three different models");
});
test("a slow request gets a second copy that answers first", async () => {
  reply = { answer: "B", files: [] };
  slowTimes = 1; models = [];
  const t0 = Date.now(); const [st] = await call({ question: "q", files });
  assert.equal(st, 200); assert.ok(Date.now() - t0 < 380, "the second copy answered before the slow one");
  assert.equal(models.length, 2);
});
test("still busy after every try gives a clear busy message", async () => {
  busyTimes = 99; models = [];
  const [st, out] = await call({ question: "q", files });
  assert.equal(st, 503); assert.match(out.error, /busy/); assert.equal(models.length, 4);
  busyTimes = 0;
});
test("the model that answered is asked first next time", async () => {
  reply = { answer: "C", files: [] };
  busyTimes = 1; models = [];
  await call({ question: "q", files });
  const winner = models[1];
  models = [];
  await call({ question: "q", files });
  assert.deepEqual(models, [winner]);
});

test("a slow losing request is cancelled once another answers", async () => {
  reply = { answer: "W", files: [] };
  slowTimes = 1; aborted = 0; models = [];
  const [st] = await call({ question: "q", files });
  assert.equal(st, 200);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(aborted, 1, "the slow request was aborted");
});
test("a cut-off reply moves on to another model", async () => {
  reply = { answer: "Z", files: [] };
  cutTimes = 1; models = [];
  const [st, out] = await call({ question: "q", files });
  assert.equal(st, 200); assert.equal(out.answer, "Z"); assert.equal(models.length, 2);
});
test("a failed call refunds its count", async () => {
  busyTimes = 99;
  const before = JSON.stringify([...counts]);
  const [st] = await call({ question: "q", files });
  assert.equal(st, 503);
  assert.equal(JSON.stringify([...counts]), before.replace(/(\d+)\]/g, "$1]"), "counts back where they were");
  busyTimes = 0;
});
test("ask output is capped and deduped", async () => {
  reply = { answer: "x".repeat(5000), files: [{ path: "a.js", why: "y".repeat(500) }, { path: "a.js", why: "dup" }] };
  const [st, out] = await call({ question: "q", files });
  assert.equal(st, 200); assert.equal(out.answer.length, 1500); assert.equal(out.files.length, 1); assert.equal(out.files[0].why.length, 200);
});
test("the model list needs a sign-in", async () => {
  const r = await handler(new Request("http://x/?models", { method: "GET" }));
  assert.equal(r.status, 401);
});
test("change explains a commit's diffs, keeping only sent files and lines the diff shows", async () => {
  reply = { summary: "S", files: [
    { path: "a.js", change: "C", lines: [{ line: 11, note: "added" }, { line: 99, note: "not in the diff" }, { line: 10, note: "kept" }] },
    { path: "zzz.js", change: "made up", lines: [] }] };
  const patch = "@@ -10,2 +10,3 @@\n      10 | keep\n-       | old\n+     11 | new\n+     12 | new2";
  const [st, out] = await call({ mode: "change", question: "Fix the thing", repo: "r", files, change: [{ path: "a.js", status: "modified", patch }] });
  assert.equal(st, 200);
  assert.deepEqual(out.files.map(f => f.path), ["a.js"]);
  assert.deepEqual(out.files[0].lines.map(l => l.line), [11, 10]);
  assert.match(lastInput.input, /Commit message: Fix the thing/);
  assert.match(lastInput.input, /--- a\.js \(modified\) ---/);
  assert.match(lastInput.system_instruction, /commit/);
});
test("change with no diff is refused", async () => {
  const [st] = await call({ mode: "change", files, change: [] });
  assert.equal(st, 400);
});
test("explanations ask their own models first; questions keep the usual ones", async () => {
  reply = { summary: "S", files: [{ path: "a.js", explanation: "E", parts: [], links: [] }] }; models = [];
  await call({ mode: "explain", question: "x?", repo: "r", files, code: [{ path: "a.js", text: "x", imports: [] }] });
  assert.equal(models[0], "strong-model");
  reply = { answer: "A", files: [] }; models = [];
  await call({ question: "where is x?", files });
  assert.notEqual(models[0], "strong-model");
});
