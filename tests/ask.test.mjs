import { test, mock } from "node:test";
import assert from "node:assert";
const FN = new URL("../netlify/functions/ask.mjs", import.meta.url).href;   // the function under test
let reply, lastInput, badKey = false, rejectThinking = false, calls = [], models = [], busyTimes = 0, slowTimes = 0, cutTimes = 0, aborted = 0;
mock.module("@google/genai", { namedExports: { GoogleGenAI: class { constructor() { this.models = { generateContent: async a => { models.push(a.model); if (badKey) throw Object.assign(new Error("API key not valid. Please pass a valid API key."), { status: 400 }); if (busyTimes > 0) { busyTimes--; throw Object.assign(new Error("This model is currently experiencing high demand."), { status: 503 }); } if (slowTimes > 0) { slowTimes--; await new Promise((r, j) => { const t = setTimeout(r, 400); a.config.abortSignal.addEventListener('abort', () => { aborted++; clearTimeout(t); j(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })); }); }); } if (cutTimes > 0) { cutTimes--; return { text: '{"answer": "cut', candidates: [{ finishReason: 'MAX_TOKENS' }] }; } calls.push(a.config.thinkingConfig && a.config.thinkingConfig.thinkingLevel.toLowerCase()); if (rejectThinking && a.config.thinkingConfig) throw Object.assign(new Error("thinking_level is not supported for this model"), { status: 400 }); lastInput = { input: a.contents, system_instruction: a.config.systemInstruction, schema: a.config.responseJsonSchema, generation_config: { thinking_level: a.config.thinkingConfig && a.config.thinkingConfig.thinkingLevel } }; return { text: JSON.stringify(reply), usageMetadata: { candidatesTokenCount: 5 } }; } }; this.interactions = { create: async a => { calls.push(a.generation_config.thinking_level); if (rejectThinking && a.generation_config.thinking_level) throw Object.assign(new Error("thinking_level is not supported for this model"), { status: 400 }); lastInput = a; return { output_text: JSON.stringify(reply) }; } }; } } } });
const counts = new Map();
mock.module("@netlify/blobs", { namedExports: { getStore: () => ({
  getWithMetadata: async k => counts.has(k) ? { data: { n: counts.get(k) }, etag: "e" } : null,
  setJSON: async (k, v) => { counts.set(k, v.n); return { modified: true }; } }) } });
globalThis.fetch = async () => new Response(JSON.stringify({ id: 7, login: "t" }), { status: 200 });
process.env.GEMINI_API_KEY = "x"; process.env.ASK_HEDGE_MS = "100"; process.env.ASK_RETRY_MS = "20";
process.env.ASK_EXPLAIN_MODELS = "strong-model,gemini-3.5-flash-lite";   // explanations try these first
const { default: handler, mainAreas } = await import(FN);
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
test("Beginner's explain asks in plain words and keeps the file's explanation and links", async () => {
  reply = { summary: "S", files: [{ path: "a.js", explanation: "It gets things ready.", links: [{ path: "b.js", how: "Uses it." }] }] };
  const [st, out] = await call({ mode: "explain", question: "x?", repo: "r", files, plain: true, code: [{ path: "a.js", text: "a\nb", imports: [] }] });
  assert.equal(st, 200);
  assert.equal(out.files[0].explanation, "It gets things ready.");
  assert.equal(out.files[0].blocks, undefined);
  assert.match(lastInput.system_instruction, /never coded/);
  assert.doesNotMatch(lastInput.input, /=== block/);
});
test("Beginner's explain of one function also picks its lines to look at, kept inside it", async () => {
  reply = { summary: "S", files: [{ path: "a.js", explanation: "It adds up.", links: [], lines: [{ line: 3, note: "Starts the count." }, { line: 1, note: "Outside." }, { line: 9, note: "Past the end." }] }] };
  const [st, out] = await call({ mode: "explain", question: "Explain only lines 2–4 of a.js", repo: "r", files, plain: true, range: { from: 2, to: 4 },
    code: [{ path: "a.js", text: "a\nb\nc\nd\ne", imports: [] }] });
  assert.equal(st, 200);
  assert.deepEqual(out.files[0].parts, [{ line: 3, name: "", note: "Starts the count." }]);
  assert.match(lastInput.system_instruction, /lines within those lines that matter/);
  assert.match(lastInput.system_instruction, /as few or as many as the code has/);
  assert.doesNotMatch(lastInput.system_instruction, /up to \d+ lines/, "no fixed count of lines");
});

test("explain keeps a file whose path Gemini wrote short", async () => {
  reply = { summary: "S", files: [{ path: "./CardTest.jsx", explanation: "Draws a card.", links: [] }] };
  const [st, out] = await call({ mode: "explain", question: "x?", repo: "r", files, plain: true,
    code: [{ path: "src/pages/CardTest.jsx", text: "function Card() {}", imports: [] }] });
  assert.equal(st, 200);
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].path, "src/pages/CardTest.jsx");
  assert.equal(out.files[0].explanation, "Draws a card.");
});
test("explain with no code is refused", async () => {
  const [st] = await call({ mode: "explain", files, code: [] });
  assert.equal(st, 400);
});
test("explain counts separately from asks", async () => {
  assert.ok([...counts.keys()].some(k => k.includes("/explain/")));
  assert.ok(![...counts.keys()].some(k => /^user\/7\/\d/.test(k)));
});
test("Beginner's tour isn't folded down to a single workflow", async () => {
  reply = { title: "T", story: "s", overview: "O", workflows: [
    { name: "Sign in", feature: "f", summary: "S", steps: [{ path: "a.js", title: "t", narration: "n", change: "  add a  sign-in provider " }, { path: "b.js", title: "t", narration: "n" }], feeds: [] },
    { name: "Sign out", feature: "f", summary: "S", steps: [{ path: "a.js", title: "t", narration: "n" }, { path: "b.js", title: "t", narration: "n" }], feeds: [] }] };
  const [st, out] = await call({ mode: "tour", files, digest: "README: two", plain: true });
  assert.equal(st, 200);
  assert.deepEqual(out.workflows.map(w => w.name), ["Sign in", "Sign out"]);   // they overlap fully, but folding would leave one
  assert.equal(out.workflows[0].steps[0].change, "add a sign-in provider");   // the "you'd come here to" line, tidied
  assert.equal(out.workflows[0].steps[1].change, "");
  const [, other] = await call({ mode: "tour", files, digest: "README: two again" });
  assert.equal(other.workflows.length, 1);   // Advanced and Manager still fold them
});
test("tour returns workflows of real files, with feeds between them", async () => {
  reply = { title: "T", story: "People open it and it shows them their code.", overview: "O", workflows: [
    { name: "Start", feature: "Lets people start it.", summary: "S", steps: [{ path: "a.js", title: "t", narration: "n" }, { path: "nope.js", title: "x", narration: "x" }, { path: "b.js", title: "t2", narration: "n2" }], feeds: ["Serve", "Ghost", "Start"] },
    { name: "Serve", summary: "S2", steps: [{ path: "b.js", title: "t", narration: "n" }, { path: "c/d.js", title: "t", narration: "n" }], feeds: [] },
    { name: "Empty", summary: "x", steps: [{ path: "zzz", title: "t", narration: "n" }], feeds: [] }] };
  const [st, out] = await call({ mode: "tour", files, digest: "README: hello", plain: true });
  assert.equal(st, 200);
  assert.deepEqual(out.workflows.map(w => w.name), ["Start", "Serve"]);
  assert.deepEqual(out.workflows[0].steps.map(s => s.path), ["a.js", "b.js"]);
  assert.deepEqual(out.workflows[0].feeds, ["Serve"]);
  assert.deepEqual(out.workflows.map(w => w.feature), ["Lets people start it.", ""]);   // plain English beside the technical summary
  assert.equal(out.overview, "O");
  assert.equal(out.story, "People open it and it shows them their code.");   // the whole system in simple English
  assert.match(lastInput.system_instruction, /never coded[\s\S]*Be descriptive/);   // every line of a Beginner tour in plain words
  assert.match(lastInput.system_instruction, /end to end in simple English/);
  assert.match(lastInput.input, /What the code itself shows[^\n]*\nREADME: hello/);
  assert.match(lastInput.system_instruction, /workflows/);
  assert.match(lastInput.system_instruction, /plain English on what it lets people do/);
});
test("a Beginner tour is asked to cover every main area of the product, tests and docs aside", async () => {
  const many = [{ path: "src/a/x.js", lines: 500 }, { path: "src/a/y.js", lines: 300 }, { path: "src/b/z.js", lines: 400 }, { path: "src/main.js", lines: 50 },
    { path: "cli/run.py", lines: 200 }, { path: "tests/t.py", lines: 900 }, { path: "docs/d.md", lines: 300 }, { path: "tiny/q.js", lines: 5 },
    { path: "site/vendor/lib.js", lines: 9000 }, { path: "site/index.html", lines: 6000 }, { path: "package-lock.json", lines: 2000 },
    { path: "ext/extension.js", lines: 20 }, { path: "ext/package.json", lines: 30 }];   // small, but a project of its own
  // only source code counts: vendored code, markup and data are left out, as are tests, docs and a folder under 3%;
  // src/ holds most of what's left, so it splits a level down
  assert.deepEqual(mainAreas(many).map(a => a.name), ["src/a/", "src/b/", "cli/", "src/", "ext/"]);
  reply = { title: "T", overview: "O", workflows: [{ name: "Start", summary: "S", steps: [{ path: "cli/run.py", title: "t", narration: "n" }], feeds: [] }] };
  const [st] = await call({ mode: "tour", files: many, digest: "README: areas", plain: true });   // Beginner
  assert.equal(st, 200);
  assert.match(lastInput.input, /Main areas of the product, by lines of source code \(each should appear in at least one workflow's steps\): src\/a\/ 800 lines, src\/b\/ 400 lines, cli\/ 200 lines, src\/ 50 lines, ext\/ 20 lines/);
  assert.match(lastInput.system_instruction, /must cover the whole product[\s\S]*checklist/);
  assert.match(lastInput.system_instruction, /must not sound the same twice/);   // the narration varies from step to step
  await call({ mode: "tour", files: many, digest: "README: areas, advanced", every: true });   // Advanced and Manager: the tour as when the sites split
  assert.doesNotMatch(lastInput.input, /Main areas of the product/);
  assert.doesNotMatch(lastInput.system_instruction, /must cover the whole product|must not sound the same twice/);
  assert.match(lastInput.system_instruction, /here the request lands in/);
});
test("lines to look at aren't capped: every line picked, in every step's file, on every site", async () => {
  const before = new Map(counts);
  counts.clear();   // a fresh allowance for these calls; the counts are put back at the end
  const many = Array.from({ length: 40 }, (_, k) => ({ line: k + 1, note: `n${k}` }));
  const text = Array.from({ length: 40 }, (_, k) => `x${k}`).join("\n");
  const code = Array.from({ length: 6 }, (_, k) => ({ path: `f${k}.js`, text }));
  reply = { steps: code.map(c => ({ path: c.path, lines: many })) };
  const [st, out] = await call({ mode: "lines", question: "Uncapped", files, code });   // Advanced and Manager, which used to stop at four files
  assert.equal(st, 200);
  assert.equal(out.steps.length, 6);
  assert.equal(out.steps[0].lines.length, 40);
  assert.equal(lastInput.schema.properties.steps.items.properties.lines.maxItems, undefined);
  reply = { summary: "S", files: [{ path: "a.js", explanation: "E", links: [], lines: many }] };
  const [st2, out2] = await call({ mode: "explain", question: "Uncapped range", repo: "r", files, plain: true, range: { from: 1, to: 40 }, code: [{ path: "a.js", text, imports: [] }] });
  assert.equal(st2, 200);
  assert.equal(out2.files[0].parts.length, 40);
  counts.clear(); for (const [k, v] of before) counts.set(k, v);
});
test("every kind of answer is told not to repeat itself across its parts", async () => {
  const patch = "@@ -1,1 +1,2 @@\n       1 | keep\n+      2 | new";
  const asks = [
    [{ mode: "explain", question: "rep 1", repo: "r", files, code: [{ path: "a.js", text: "x", imports: [] }] }, /covers only what is particular to that file/],
    [{ mode: "explain", question: "rep 2", repo: "r", files, plain: true, code: [{ path: "a.js", text: "x", imports: [] }] }, /covers only what is particular to that file/],
    [{ mode: "explain", question: "rep 3", repo: "r", files, plain: true, range: { from: 1, to: 1 }, code: [{ path: "a.js", text: "x", imports: [] }] }, /A note on a part, a line or a link adds a detail/],
    [{ mode: "tour", files, digest: "README: rep plain", plain: true }, /never retell them/],
    [{ mode: "tour", files, digest: "README: rep", every: true }, /never retelling the summary or an earlier step/],
    [{ mode: "lines", question: "Rep", files, code: [{ path: "a.js", text: "x" }] }, /no two notes say the same thing/],
    [{ mode: "change", question: "Rep", repo: "r", files, change: [{ path: "a.js", status: "modified", patch }] }, /leaves each file's details to that file/],
  ];
  const before = new Map(counts);   // these calls mustn't use up the daily limit the later tests count on
  counts.clear();   // a fresh allowance for these calls; the counts are put back at the end
  for (const [body, own] of asks) {
    reply = { summary: "S", files: [], steps: [], title: "T", overview: "O", workflows: [] };
    lastInput = null;
    await call(body);
    assert.ok(lastInput, `${body.mode} reached Gemini`);
    assert.match(lastInput.system_instruction, own, `${body.mode}: its own rule`);
    if (body.mode !== "lines") assert.match(lastInput.system_instruction, /Never restate in one part what another already says/, `${body.mode}: the shared rule`);
    assert.doesNotMatch(lastInput.system_instruction, /Where it fits, end with one short pointer/, "a what-next pointer at most once, not in every part");
  }
  counts.clear(); for (const [k, v] of before) counts.set(k, v);
});
test("a key Gemini rejects says so, and that trying again won't help", async () => {
  badKey = true;
  try {
    const [st, out] = await call({ question: "where is the key?", files });
    assert.equal(st, 502);
    assert.match(out.error, /didn't accept this site's API key[\s\S]*Trying again won't help/);
  } finally { badKey = false; }
});
test("only a Beginner tour (plain) comes in plain English", async () => {
  reply = { title: "T", story: "A story.", overview: "O", workflows: [{ name: "Start", feature: "F", summary: "S", steps: [{ path: "a.js", title: "t", narration: "n" }], feeds: [] }] };
  for (const extra of [{}, { every: true, plain: true }]) {
    const [st, out] = await call({ mode: "tour", files, digest: "README: plain " + JSON.stringify(extra), ...extra });
    assert.equal(st, 200);
    assert.equal(out.story, undefined);
    assert.equal(out.workflows[0].feature, undefined);
    assert.doesNotMatch(lastInput.system_instruction, /end to end in simple English|plain English on what it lets people do/);
  }
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
test("an Advanced tour (every) keeps every workflow, overlapping or not, with no cap", async () => {
  const st = (...ps) => ps.map(path => ({ path, title: "t", narration: "n" }));
  reply = { title: "T", overview: "O", workflows: [
    { name: "Start", summary: "S", steps: st("a.js", "b.js"), feeds: [] },
    { name: "Start again", summary: "S2", steps: st("a.js", "b.js", "c/d.js"), feeds: [] }] };
  const [code, out] = await call({ mode: "tour", files, question: "every", every: true });
  assert.equal(code, 200);
  assert.deepEqual(out.workflows.map(w => w.name), ["Start", "Start again"], "nothing folds");
  assert.match(lastInput.system_instruction, /as many as it really has/);
  assert.doesNotMatch(lastInput.system_instruction, /two to \d+ things/);
  assert.doesNotMatch(lastInput.system_instruction, /Don't tell the same walk twice/);
  await call({ mode: "tour", files, question: "every-not" });
  assert.match(lastInput.system_instruction, /as many as it really has[\s\S]*Don't tell the same walk twice/);
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
test("a line Gemini picks twice in a file is shown once", async () => {
  const before = new Map(counts);
  counts.clear();   // a fresh allowance for these calls; the counts are put back at the end
  reply = { steps: [{ path: "a.js", lines: [{ line: 2, note: "one" }, { line: 2, note: "again" }, { line: 3, note: "two" }] }] };
  const [st, out] = await call({ mode: "lines", question: "Twice", files, code: [{ path: "a.js", text: "x\ny\nz" }] });
  assert.equal(st, 200);
  assert.deepEqual(out.steps[0].lines.map(l => l.line), [2, 3]);
  counts.clear(); for (const [k, v] of before) counts.set(k, v);
});
test("a tour keeps as many workflows as Gemini finds", async () => {
  const before = new Map(counts);
  counts.clear();   // a fresh allowance for these calls; the counts are put back at the end
  const st = (...ps) => ps.map(path => ({ path, title: "t", narration: "n" }));
  reply = { title: "T", overview: "O", workflows: Array.from({ length: 9 }, (_, k) => ({ name: `Flow ${k}`, summary: "S", steps: st(k % 2 ? "a.js" : "b.js", "c/d.js"), feeds: [] })) };
  const [code, out] = await call({ mode: "tour", files, question: "nine flows", every: true });
  assert.equal(code, 200);
  assert.equal(out.workflows.length, 9);
  assert.doesNotMatch(lastInput.system_instruction, /"workflows":\{"type":"array","maxItems"/);
  counts.clear(); for (const [k, v] of before) counts.set(k, v);
});

// Beginner's tour in stages: the outline (every workflow, no narration), more workflows for areas it missed, then
// each workflow's narration on its own.
const many10 = Array.from({ length: 12 }, (_, k) => ({ path: `src/f${k}.js`, lines: 50 }));
const stp = (...ps) => ps.map(path => ({ path, title: "t" }));
const fresh = async f => { const before = new Map(counts); counts.clear(); try { await f(); } finally { counts.clear(); for (const [k, v] of before) counts.set(k, v); } };
test("the outline lists every workflow and its steps, with no narration, and folds only nearly the same walk", () => fresh(async () => {
  const ten = Array.from({ length: 10 }, (_, k) => `src/f${k}.js`);
  reply = { title: "T", story: "S", overview: "O", workflows: [
    { name: "Long", feature: "f", steps: stp(...ten), feeds: ["Shares a lot"] },
    { name: "Shares a lot", feature: "f", steps: stp("src/f0.js", "src/f1.js", "src/f2.js", "src/f11.js"), feeds: [] },   // 3 of its 4 files in Long: a different walk
    { name: "Same walk", feature: "f", steps: stp(...ten.slice(0, 9), "src/f11.js"), feeds: [] }] };   // 9 of Long's 10 files: nearly the same
  const [st, out] = await call({ mode: "tour", stage: "outline", plain: true, files: many10, digest: "README: outline" });
  assert.equal(st, 200);
  assert.deepEqual(out.workflows.map(w => w.name), ["Long", "Shares a lot"]);
  assert.equal(out.workflows[0].steps.length, 10, "ten steps kept");
  assert.deepEqual(out.workflows[0].merged, ["Same walk"]);
  assert.equal(out.workflows[0].steps[0].narration, "");
  assert.equal(out.story, "S");
  assert.match(lastInput.system_instruction, /Don't write narration/);
  assert.match(lastInput.system_instruction, /must cover the whole product/);
  assert.doesNotMatch(lastInput.system_instruction, /"narration"/);
}));
test("an outline for the areas a tour missed returns only new workflows, and none is fine", () => fresh(async () => {
  reply = { workflows: [{ name: "The CLI", feature: "f", steps: stp("src/f3.js", "src/f4.js"), feeds: ["Long", "Ghost"] }] };
  const [st, out] = await call({ mode: "tour", stage: "outline", plain: true, files: many10, digest: "README: gap", missing: ["cli/", "ext/"], existing: ["Long", "Shares a lot"] });
  assert.equal(st, 200);
  assert.deepEqual(out.workflows.map(w => w.name), ["The CLI"]);
  assert.deepEqual(out.workflows[0].feeds, ["Long"], "it may feed a workflow already in the tour");
  assert.equal(out.title, undefined);
  assert.match(lastInput.input, /Workflows already in the tour: Long; Shares a lot\nAreas the tour still misses: cli\/, ext\//);
  assert.doesNotMatch(lastInput.input, /Main areas of the product/);
  assert.match(lastInput.system_instruction, /Areas the tour still misses/);
  reply = { workflows: [] };
  const [st2, out2] = await call({ mode: "tour", stage: "outline", plain: true, files: many10, digest: "README: gap none", missing: ["cli/"], existing: ["Long"] });
  assert.equal(st2, 200); assert.deepEqual(out2.workflows, []);
}));
test("narration writes one workflow's words, step by step in the order asked", () => fresh(async () => {
  reply = { summary: "How it works.", steps: [{ path: "src/f2.js", narration: "Second.", change: "fix  two" }, { path: "src/f1.js", narration: "First.", change: "fix one" }] };
  const [st, out] = await call({ mode: "tour", stage: "narrate", plain: true, files: many10, digest: "README: narrate", others: ["Saving"],
    workflow: { name: "Start", feature: "Starts it.", steps: [{ path: "src/f1.js", title: "One" }, { path: "src/f2.js", title: "Two" }, { path: "nope.js", title: "Gone" }] } });
  assert.equal(st, 200);
  assert.equal(out.summary, "How it works.");
  assert.deepEqual(out.steps.map(s => [s.path, s.narration, s.change]), [["src/f1.js", "First.", "fix one"], ["src/f2.js", "Second.", "fix two"]]);
  assert.match(lastInput.input, /Workflows in this tour: Start; Saving\n\nWorkflow to narrate: Start\nFeature: Starts it\.\nSteps:\n1\. src\/f1\.js: One\n2\. src\/f2\.js: Two\n/);
  assert.match(lastInput.system_instruction, /narrating one workflow/);
  const [bad] = await call({ mode: "tour", stage: "narrate", plain: true, files: many10, workflow: { name: "X", steps: [{ path: "nope.js", title: "t" }] } });
  assert.equal(bad, 400);
}));
test("a tour's narrations have their own allowance, so one tour doesn't use up the hour", () => fresh(async () => {
  reply = { summary: "S", steps: [{ path: "src/f1.js", narration: "n", change: "c" }] };
  for (let k = 0; k < 25; k++) {
    const [st] = await call({ mode: "tour", stage: "narrate", plain: true, files: many10, digest: `README: allowance ${k}`, workflow: { name: `W${k}`, feature: "f", steps: [{ path: "src/f1.js", title: "t" }] } });
    assert.equal(st, 200, `narration ${k + 1}`);
  }
  reply = { answer: "A", files: [] };
  const [ask] = await call({ question: "still free to ask?", files: many10 });
  assert.equal(ask, 200, "questions keep their own allowance");
}));
