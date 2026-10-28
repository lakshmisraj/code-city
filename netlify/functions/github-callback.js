// Step 2 of "Sign in with GitHub": GitHub sends the visitor back here with a one-time code,
// which is swapped for a token using the app's secret. The token is handed to the page through
// this site's own localStorage (same origin), so it never appears in a URL or a log.
const { cookie, readCookies, safeReturn, page } = require("../lib/oauth");

exports.handler = async event => {
  const q = event.queryStringParameters || {};
  const jar = readCookies(event.headers.cookie);
  const clear = [cookie("cc_oauth_state", "", 0), cookie("cc_oauth_return", "", 0)];
  const back = safeReturn(decodeURIComponent(jar.cc_oauth_return || "/"));

  if (q.error) return handOff(clear, back, null, "GitHub sign-in was cancelled.");
  if (!q.code || !q.state || q.state !== jar.cc_oauth_state) return handOff(clear, back, null, "That sign-in link expired. Please try again.");

  let data;
  try {
    const r = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code: q.code }),
    });
    data = await r.json();
  } catch (e) {
    return handOff(clear, back, null, "Couldn't reach GitHub to finish signing in. Please try again.");
  }
  if (!data || !data.access_token) return handOff(clear, back, null, "GitHub didn't finish the sign-in. Please try again.");
  return handOff(clear, back, data.access_token, null);
};

function handOff(cookies, back, token, error) {
  const js = v => JSON.stringify(v).replace(/</g, "\\u003c");
  const res = page(200, "Signing in…", `<script>
try {
  ${token ? `localStorage.setItem("codecity.githubOAuth", ${js(token)});` : ""}
  ${error ? `sessionStorage.setItem("codecity.signinError", ${js(error)});` : ""}
} catch (e) {}
location.replace(${js(back)});
</script>`);
  res.multiValueHeaders = { "Set-Cookie": cookies };
  res.headers["Referrer-Policy"] = "no-referrer";
  return res;
}
