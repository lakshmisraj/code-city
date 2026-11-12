// The site's own small analytics. POST counts one page load; GET returns the counts to the site's owner.
//
// What's kept, per day, in Netlify Blobs: how many page loads, how many browsers came for the first time that
// day (and how many of those had been before, and how many days they have come in all), the site they came from
// (host only), the ?ref= of a shared link, the country Netlify reports, and which features were used: for each
// feature's name, how many browsers used it that day and how many times in all. No IP addresses, cookies, repo
// names, file names, questions or GitHub accounts. A browser that sends Do Not Track or Global Privacy Control
// isn't counted (the page checks).
//
// Reading needs a GitHub sign-in by one of ANALYTICS_ADMINS (comma-separated logins; lakshmisraj by default).
import { getStore } from "@netlify/blobs";

const ADMINS = new Set((process.env.ANALYTICS_ADMINS || "lakshmisraj").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
const STATS_DAYS = 90, MAX_KEYS = 200, MAX_BODY = 1500, MAX_USES = 100;
const REF_RE = /^[\w-]{1,30}$/, HOST_RE = /^[a-z0-9.-]{1,80}$/, COUNTRY_RE = /^[A-Z]{2}$/;

// The features the page counts. Anything else sent is ignored, so the record can only ever hold these names.
const FEATURES = new Set([
  "repo_loaded", "folder_opened", "export_opened", "shared_link_opened", "level_beginner", "level_advanced", "level_manager",
  "tour_start", "tour_part", "tour_find_more", "workflow_open", "tour_step", "workflow_done", "tour_done", "tour_save",
  "ask_question", "explain_file", "explain_lines", "code_view", "search_used",
  "map_open", "history_open", "report_open", "heat_colours", "language_colours", "share_link", "signin_click",
]);
// How many days a browser has come, in groups.
const visitBucket = n => n <= 1 ? "1" : n <= 3 ? "2-3" : n <= 7 ? "4-7" : "8+";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const dayOf = t => new Date(t).toISOString().slice(0, 10);

// One more in a day's count for this key. Past MAX_KEYS new names go into "other", so nobody can fill the record up.
function tally(map, key) {
  if (!key) return;
  const k = map[key] != null || Object.keys(map).length < MAX_KEYS ? key : "other";
  map[k] = (map[k] || 0) + 1;
}

// Adds a visit, or a batch of feature uses, to today's record. The etag check means two visits at the same moment
// can't both read the old count.
async function record(store, day, visit) {
  const key = `day/${day}`;
  for (let tries = 0; tries < 8; tries++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const d = (cur && cur.data) || {};
    for (const k of ["refs", "from", "countries", "visits", "people", "uses"]) d[k] = d[k] || {};
    d.views = d.views || 0; d.visitors = d.visitors || 0; d.returning = d.returning || 0;
    if (visit.load) {
      d.views++;
      if (visit.first) { d.visitors++; if (visit.returning) d.returning++; if (visit.days) tally(d.visits, visitBucket(visit.days)); }
      tally(d.refs, visit.ref); tally(d.from, visit.from); tally(d.countries, visit.country);
    }
    for (const name of visit.people || []) d.people[name] = (d.people[name] || 0) + 1;
    for (const [name, n] of Object.entries(visit.use || {})) d.uses[name] = (d.uses[name] || 0) + n;
    const res = await store.setJSON(key, d, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res.modified) return true;
  }
  return false;   // very busy: this one goes uncounted, which is better than slowing the page
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
  // A post with feature uses in it counts those and not a page load; any other post is a page load
  const events = body.use !== undefined || body.people !== undefined;
  const use = {};
  if (body.use && typeof body.use === "object" && !Array.isArray(body.use)) for (const [name, n] of Object.entries(body.use)) if (FEATURES.has(name) && Number.isInteger(n) && n > 0) use[name] = Math.min(n, MAX_USES);
  const people = Array.isArray(body.people) ? [...new Set(body.people.filter(name => FEATURES.has(name)))] : [];
  const days = Number.isInteger(body.days) && body.days > 0 && body.days < 100000 ? body.days : 0;
  try { await record(getStore({ name: "visits", consistency: "strong" }), dayOf(Date.now()), events ? { use, people } : { load: true, first: body.first === true, returning: body.returning === true, days, ref, from, country }); }
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
