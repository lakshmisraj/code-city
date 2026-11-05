import { test, mock } from "node:test";
import assert from "node:assert";
const FN = new URL("../netlify/functions/visit.mjs", import.meta.url).href;   // the function under test
const blobs = new Map();
let races = 0, login = "lakshmisraj", ghOk = true;
mock.module("@netlify/blobs", { namedExports: { getStore: () => ({
  getWithMetadata: async k => blobs.has(k) ? { data: JSON.parse(blobs.get(k)), etag: "e" } : null,
  get: async k => blobs.has(k) ? JSON.parse(blobs.get(k)) : null,
  setJSON: async (k, v) => { if (races > 0) { races--; return { modified: false }; } blobs.set(k, JSON.stringify(v)); return { modified: true }; },
}) } });
globalThis.fetch = async () => new Response(JSON.stringify({ login }), { status: ghOk ? 200 : 401 });
const { default: handler } = await import(FN);
const today = new Date().toISOString().slice(0, 10), todayKey = `day/${today}`;
const post = (body, headers = {}, geo) => handler(new Request("http://x/", { method: "POST", headers, body: JSON.stringify(body) }), geo ? { geo: { country: { code: geo } } } : {});
const get = token => handler(new Request("http://x/", token ? { headers: { authorization: "Bearer " + token } } : {}));

test("counts page loads, first visits, links, sources and countries", async () => {
  blobs.clear();
  assert.equal((await post({ first: true, ref: "Sam", from: "www.instagram.com" }, {}, "US")).status, 204);
  await post({ first: false, ref: "sam" }, {}, "US");
  const d = JSON.parse(blobs.get(todayKey));
  assert.equal(d.views, 2); assert.equal(d.visitors, 1);
  assert.deepEqual(d.refs, { sam: 2 }); assert.deepEqual(d.from, { "instagram.com": 1 }); assert.deepEqual(d.countries, { US: 2 });
});
test("keeps nothing but the counts it knows about", async () => {
  blobs.clear();
  await post({ first: true, ref: "<script>", from: "not a host/?repo=secret", repo: "acme/secret", file: "a.py", ip: "1.2.3.4" });
  const raw = blobs.get(todayKey);
  assert.doesNotMatch(raw, /secret|script|a\.py|1\.2\.3\.4/);
  assert.deepEqual(JSON.parse(raw), { views: 1, visitors: 1, refs: {}, from: {}, countries: {} });
});
test("only a real true counts as a first visit", async () => {
  blobs.clear();
  await post({ first: "yes" });
  assert.equal(JSON.parse(blobs.get(todayKey)).visitors, 0);
});
test("another site can't count visits, and a huge request is refused", async () => {
  blobs.clear();
  assert.equal((await post({ first: true }, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({ first: true, x: "y".repeat(600) })).status, 413);
  assert.equal(blobs.size, 0);
});
test("names can't grow the record without limit", async () => {
  blobs.clear();
  for (let i = 0; i < 205; i++) await post({ ref: "r" + i });
  const refs = JSON.parse(blobs.get(todayKey)).refs;
  assert.equal(Object.keys(refs).length, 201); assert.equal(refs.other, 5);
});
test("two visits at once are both counted", async () => {
  blobs.clear();
  await post({});
  races = 2;
  await post({});
  assert.equal(JSON.parse(blobs.get(todayKey)).views, 2);
});
test("bad JSON is refused", async () => {
  const r = await handler(new Request("http://x/", { method: "POST", body: "{" }), {});
  assert.equal(r.status, 400);
});
test("the stats need a sign-in by the owner", async () => {
  blobs.clear(); await post({ first: true });
  assert.equal((await get()).status, 401);
  ghOk = false; assert.equal((await get("t")).status, 401); ghOk = true;
  login = "someone-else"; assert.equal((await get("t")).status, 403); login = "LakshmiSRaj";
  const r = await get("t"); assert.equal(r.status, 200);
  const { days } = await r.json();
  assert.equal(days.length, 1); assert.equal(days[0].day, today); assert.equal(days[0].visitors, 1);
  login = "lakshmisraj";
});
