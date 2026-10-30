// "Sign out": tells GitHub to revoke the visitor's sign-in token, so a copy left behind (a shared computer, an
// old browser profile) stops working. The page clears its own copy either way.
//
// POST with the token in Authorization. Uses GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, the same as sign-in;
// only this OAuth App's own tokens can be revoked this way.
exports.handler = async event => {
  const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  const id = process.env.GITHUB_CLIENT_ID, secret = process.env.GITHUB_CLIENT_SECRET;
  const token = String((event.headers || {}).authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!id || !secret || !token) return json(200, { revoked: false });
  const r = await fetch(`https://api.github.com/applications/${encodeURIComponent(id)}/token`, {
    method: "DELETE",
    headers: { Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"), Accept: "application/vnd.github+json", "User-Agent": "code-city", "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: token }),
    signal: AbortSignal.timeout(4000),
  }).catch(() => null);
  return json(200, { revoked: !!(r && r.status === 204) });
};
