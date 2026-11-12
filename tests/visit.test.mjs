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
  assert.deepEqual(JSON.parse(raw), { views: 1, visitors: 1, returning: 0, refs: {}, from: {}, countries: {}, visits: {}, people: {}, uses: {} });
});
test("only a real true counts as a first visit", async () => {
  blobs.clear();
  await post({ first: "yes" });
  assert.equal(JSON.parse(blobs.get(todayKey)).visitors, 0);
});
test("another site can't count visits, and a huge request is refused", async () => {
  blobs.clear();
  assert.equal((await post({ first: true }, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({ first: true, x: "y".repeat(1600) })).status, 413);
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

test("counts browsers that came back, and how many days they have come", async () => {
  blobs.clear();
  await post({ first: true, returning: false, days: 1 });
  await post({ first: true, returning: true, days: 3 });
  await post({ first: true, returning: true, days: 12 });
  await post({ first: false, returning: true, days: 5 });   // not a first load today: not counted again
  const d = JSON.parse(blobs.get(todayKey));
  assert.equal(d.visitors, 3); assert.equal(d.returning, 2);
  assert.deepEqual(d.visits, { "1": 1, "2-3": 1, "8+": 1 });
});
test("counts which features are used, by browsers and in all, and not as a page load", async () => {
  blobs.clear();
  await post({ first: true });
  await post({ use: { tour_start: 1, tour_step: 7 }, people: ["tour_start", "tour_step"] });
  await post({ use: { tour_step: 3 }, people: [] });   // the same browser again: more uses, no more people
  const d = JSON.parse(blobs.get(todayKey));
  assert.equal(d.views, 1);
  assert.deepEqual(d.people, { tour_start: 1, tour_step: 1 });
  assert.deepEqual(d.uses, { tour_start: 1, tour_step: 10 });
});
test("only the features it knows are kept, with sensible counts", async () => {
  blobs.clear();
  await post({ use: { tour_start: 2, "acme/secret": 5, ask_question: -1, code_view: 1.5, search_used: 9999 }, people: ["tour_start", "tour_start", "<b>x</b>", "a.py"] });
  const raw = blobs.get(todayKey), d = JSON.parse(raw);
  assert.doesNotMatch(raw, /secret|<b>|a\.py/);
  assert.deepEqual(d.uses, { tour_start: 2, search_used: 100 });
  assert.deepEqual(d.people, { tour_start: 1 });
  assert.equal(d.views, 0);
});
test("feature uses that aren't a list or a map are ignored", async () => {
  blobs.clear();
  await post({ use: ["tour_start"], people: "tour_start" });
  const d = JSON.parse(blobs.get(todayKey));
  assert.deepEqual(d.uses, {}); assert.deepEqual(d.people, {});
});
