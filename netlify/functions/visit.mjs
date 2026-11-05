// The site's own small analytics. POST counts one page load; GET returns the counts to the site's owner.
//
// What's kept, per day, in Netlify Blobs: how many page loads, how many browsers came for the first time that
// day, the site they came from (host only), the ?ref= of a shared link, and the country Netlify reports. No IP
// addresses, cookies, repo names, file names or GitHub accounts. A browser that sends Do Not Track or Global
// Privacy Control isn't counted (the page checks).
//
// Reading needs a GitHub sign-in by one of ANALYTICS_ADMINS (comma-separated logins; lakshmisraj by default).
import { getStore } from "@netlify/blobs";

const ADMINS = new Set((process.env.ANALYTICS_ADMINS || "lakshmisraj").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
const STATS_DAYS = 90, MAX_KEYS = 200, MAX_BODY = 500;
const REF_RE = /^[\w-]{1,30}$/, HOST_RE = /^[a-z0-9.-]{1,80}$/, COUNTRY_RE = /^[A-Z]{2}$/;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const dayOf = t => new Date(t).toISOString().slice(0, 10);

// One more in a day's count for this key. Past MAX_KEYS new names go into "other", so nobody can fill the record up.
function tally(map, key) {
  if (!key) return;
  const k = map[key] != null || Object.keys(map).length < MAX_KEYS ? key : "other";
  map[k] = (map[k] || 0) + 1;
}

// Adds a visit to today's record. The etag check means two visits at the same moment can't both read the old count.
async function record(store, day, visit) {
  const key = `day/${day}`;
  for (let tries = 0; tries < 8; tries++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const d = (cur && cur.data) || { views: 0, visitors: 0, refs: {}, from: {}, countries: {} };
    d.views++;
    if (visit.first) d.visitors++;
    tally(d.refs, visit.ref); tally(d.from, visit.from); tally(d.countries, visit.country);
    const res = await store.setJSON(key, d, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res.modified) return true;
  }
  return false;   // very busy: this one visit goes uncounted, which is better than slowing the page
}

async function count(req, context) {
  if (req.headers.get("sec-fetch-site") && req.headers.get("sec-fetch-site") !== "same-origin") return json(403, { error: "Only this site's page counts visits." });
  const text = await req.text();
  if (text.length > MAX_BODY) return json(413, { error: "Too long." });
  let body;
  try { body = JSON.parse(text || "{}"); } catch (e) { return json(400, { error: "That wasn't valid JSON." }); }
  const ref = typeof body.ref === "string" && REF_RE.test(body.ref) ? body.ref.toLowerCase() : null;
  const from = typeof body.from === "string" && HOST_RE.test(body.from) ? body.from.replace(/^www\./, "") : null;
  const code = context && context.geo && context.geo.country && context.geo.country.code;
  const country = typeof code === "string" && COUNTRY_RE.test(code) ? code : null;
  try { await record(getStore({ name: "visits", consistency: "strong" }), dayOf(Date.now()), { first: body.first === true, ref, from, country }); }
  catch (e) { console.log(`visit: couldn't count: ${e && e.message}`); }   // the page never waits on or shows this
  return new Response(null, { status: 204 });
}

async function stats(req) {
  const token = String(req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { error: "Sign in with GitHub to see the stats." });
  const who = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "code-city" }, signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!who) return json(503, { error: "Couldn't check your GitHub sign-in just now. Try again in a moment." });
  if (!who.ok) return json(401, { error: "Your GitHub sign-in has expired. Sign in again." });
  const user = await who.json().catch(() => null);
  if (!user || !ADMINS.has(String(user.login).toLowerCase())) return json(403, { error: "These stats are only for the site's owner." });
  const store = getStore({ name: "visits", consistency: "strong" }), now = Date.now();
  const names = Array.from({ length: STATS_DAYS }, (_, k) => dayOf(now - k * 864e5));
  const days = (await Promise.all(names.map(async day => { const d = await store.get(`day/${day}`, { type: "json" }); return d ? { day, ...d } : null; }))).filter(Boolean);
  return json(200, { days });
}

export default async (req, context) => {
  if (req.method === "POST") return count(req, context);
  if (req.method === "GET") return stats(req);
  return json(405, { error: "Use GET or POST." });
};
