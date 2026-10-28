// Step 1 of "Sign in with GitHub": send the visitor to GitHub's consent page.
// No scopes are requested: the token only identifies the visitor, which raises their
// API limit from 60 to 5,000 requests an hour. It can't read private code or change anything.
//
// Needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (from a GitHub OAuth App) in the site's
// environment variables. `?check=1` tells the page whether sign-in is set up.
const crypto = require("crypto");
const { cookie, safeReturn, page } = require("../lib/oauth");

exports.handler = async event => {
  const q = event.queryStringParameters || {};
  const id = process.env.GITHUB_CLIENT_ID, secret = process.env.GITHUB_CLIENT_SECRET;
  if (q.check !== undefined) {
    return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ enabled: !!(id && secret) }) };
  }
  if (!id || !secret) return page(503, "Sign in with GitHub isn't set up on this site yet.");

  const state = crypto.randomBytes(16).toString("hex");
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", id);
  authorize.searchParams.set("redirect_uri", `https://${event.headers.host}/.netlify/functions/github-callback`);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");
  return {
    statusCode: 302,
    headers: { Location: authorize.toString(), "Cache-Control": "no-store" },
    multiValueHeaders: { "Set-Cookie": [cookie("cc_oauth_state", state), cookie("cc_oauth_return", encodeURIComponent(safeReturn(q.return)))] },
    body: "",
  };
};
