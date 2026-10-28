// Shared helpers for the two sign-in functions.

// Short-lived, HTTP-only cookies scoped to the functions, used only during the sign-in round trip.
function cookie(name, value, maxAge = 600) {
  return `${name}=${value}; Path=/.netlify/functions; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookies(header) {
  const out = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Only return to a page on this site, never to another host.
function safeReturn(path) {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") ? path : "/";
}

function page(statusCode, message, extra = "") {
  const text = String(message).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Code City</title>
<body style="background:#0b1020;color:#e6e9f2;font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
<p>${text} <a href="/" style="color:#f2a541">Back to Code City</a></p>${extra}</body>`,
  };
}

module.exports = { cookie, readCookies, safeReturn, page };
