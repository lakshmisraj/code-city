import { test, mock } from "node:test";
import assert from "node:assert";
const FN = new URL("../netlify/functions/ask.mjs", import.meta.url).href;   // the function under test
let gemini = 0;
mock.module("@google/genai", { namedExports: { GoogleGenAI: class { constructor() { this.models = { generateContent: async () => { gemini++; return { text: JSON.stringify({ answer: "A" + gemini, files: [{ path: "a.js", why: "w" }] }), usageMetadata: {} }; } }; } } } });
mock.module("@netlify/blobs", { namedExports: { getStore: () => { throw new Error("no blobs here"); } } });
globalThis.fetch = async () => new Response(JSON.stringify({ id: 7, login: "t" }), { status: 200 });
process.env.GEMINI_API_KEY = "x"; process.env.ASK_LOCAL = "1";
const { default: handler } = await import(FN);
const call = async body => { const r = await handler(new Request("http://x/", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) })); return [r.status, await r.json()]; };
const files = [{ path: "a.js", lines: 10 }];
test("the same question about the same code is answered from the saved copy", async () => {
  const [s1, a1] = await call({ question: "Where is X?", repo: "r", files, digest: "D" });
  const [s2, a2] = await call({ question: "  where is   x? ", repo: "r", files, digest: "D" });
  assert.equal(s1, 200); assert.equal(s2, 200);
  assert.equal(gemini, 1);
  assert.equal(a2.answer, a1.answer); assert.equal(a2.cached, true); assert.equal(a1.cached, undefined);
});
test("different code is a different request", async () => {
  await call({ question: "Where is X?", repo: "r", files: [{ path: "a.js", lines: 11 }], digest: "D" });
  await call({ question: "Where is X?", repo: "r", files, digest: "D2" });
  assert.equal(gemini, 3);
});
test("a saved answer still needs a sign-in", async () => {
  const r = await handler(new Request("http://x/", { method: "POST", body: JSON.stringify({ question: "Where is X?", repo: "r", files, digest: "D" }) }));
  assert.equal(r.status, 401);
});
