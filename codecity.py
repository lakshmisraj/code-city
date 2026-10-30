#!/usr/bin/env python3
"""Code City: turn a git repo into a 3D city.

  python3 codecity.py serve                  open the app; paste any public repo URL
  python3 codecity.py export pallets/flask   write flask.json to drop into the published page
  python3 codecity.py build                  write site/index.html for static hosting (Netlify)

Needs only Python 3.8+ and git. Public repos are cloned into ~/.cache/code-city.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "code-city")

# Keep in sync with EXT / SPECIAL / SKIP_DIRS in code-city.html. Never add "env": .env files hold secrets, and
# exported cities carry each file's first lines (and get shared); the page can also send them to Gemini.
CODE_EXT = set("""ts tsx mts cts js jsx mjs cjs vue svelte py ipynb go rs java scala kt kts c h cc cpp hpp cxx cs rb php
swift css scss sass less html htm sql sh bash zsh ps1 md mdx rst txt json yml yaml toml ini xml gradle lock
dart lua ex exs hs ml r jl zig elm clj""".split())
SPECIAL = {"dockerfile", "makefile", "gemfile", "rakefile", "procfile"}
SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".next", ".nuxt", "out", "coverage", "venv", ".venv", "env",
             "__pycache__", "target", "vendor", ".idea", ".vscode", ".turbo", ".cache", "Pods", "DerivedData", ".gradle"}
MAX_FILES, MAX_BYTES, MAX_COMMITS, PREVIEW_LINES = 4000, 600 * 1024, 1500, 80
NB_MAX_BYTES = 25 * 1024 * 1024

FN_RE = re.compile(r"\b(?:function|def|func|fn|fun)\b|=>|\bclass\b|\b(?:public|private|protected|static)\s+[\w<>\[\],\s]+\s+\w+\s*\(")
TODO_RE = re.compile(r"\b(TODO|FIXME|HACK|XXX)\b")
REPO_RE = re.compile(r"^(?:https?://)?(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org)/([\w.-]+)/([\w.-]+?)(?:\.git)?/?$")
SHORT_RE = re.compile(r"^([\w-]+)/([\w.-]+)$")
build_lock = threading.Lock()


def is_code(path):
    parts = path.split("/")
    if any(p in SKIP_DIRS for p in parts[:-1]):
        return False
    base = parts[-1].lower()
    return base in SPECIAL or ("." in base and base.rsplit(".", 1)[1] in CODE_EXT)


def git(repo, *args, timeout=600):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    # A folder's own .git/config can name programs for git to run (fsmonitor, hooks); never run them.
    r = subprocess.run(["git", "-C", repo, "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", *args],
                       capture_output=True, timeout=timeout, env=env)
    if r.returncode:
        raise RuntimeError(r.stderr.decode("utf-8", "replace").strip() or "git failed")
    return r.stdout.decode("utf-8", "replace")


def resolve(src, from_page=False):
    """Return (local path, display name) for a local folder, a repo URL or owner/name."""
    src = src.strip()
    local = os.path.expanduser(src)
    if os.path.isdir(local):
        path, home = os.path.realpath(local), os.path.realpath(os.path.expanduser("~"))
        # From the page, only folders inside your home folder, and not hidden ones like ~/.ssh.
        rel = os.path.relpath(path, home)
        if from_page and (rel == os.curdir or rel.startswith(os.pardir) or any(part.startswith(".") for part in rel.split(os.sep))):
            raise ValueError("Open a project folder inside your home folder (not a hidden one).")
        return path, os.path.basename(path)
    m = REPO_RE.match(src)
    if m:
        host, owner, name = m.groups()
    else:
        m = SHORT_RE.match(src)
        if not m:
            raise ValueError("Paste a public repo URL like https://github.com/pallets/flask, or owner/name.")
        host, (owner, name) = "github.com", m.groups()
    dest = os.path.join(CACHE, f"{host}__{owner}__{name}")
    if os.path.isdir(os.path.join(dest, ".git")):
        try:
            git(dest, "pull", "--ff-only", "--quiet", timeout=120)
        except (RuntimeError, subprocess.TimeoutExpired):
            pass  # offline or diverged: use the cached copy
    else:
        os.makedirs(CACHE, exist_ok=True)
        print(f"  cloning {host}/{owner}/{name} ...", file=sys.stderr)
        r = subprocess.run(["git", "clone", "--quiet", "--no-tags", f"https://{host}/{owner}/{name}.git", dest],
                           capture_output=True, timeout=900, env=dict(os.environ, GIT_TERMINAL_PROMPT="0"))
        if r.returncode:
            raise RuntimeError(f"Could not clone {owner}/{name}. Check the name and that the repo is public.")
    return dest, f"{owner}/{name}"


def notebook_code(text):
    """A notebook's code cells joined like a "# %%" script, or the raw text if it isn't valid JSON."""
    try:
        nb = json.loads(text)
        cells = nb.get("cells") or [c for w in nb.get("worksheets", []) for c in w.get("cells", [])]  # nbformat 4, or 3
        parts = []
        for c in cells:
            if c.get("cell_type") != "code":
                continue
            src = c.get("source", c.get("input", []))
            src = "".join(src) if isinstance(src, list) else str(src)
            parts.append(f"# %% [cell {len(parts) + 1}]\n" + src.rstrip("\n"))
        return "\n\n".join(parts)
    except (ValueError, AttributeError, TypeError):
        return text


def analyze(repo, paths, with_source):
    files = []
    for p in paths:
        if not is_code(p):
            continue
        full = os.path.join(repo, p)
        is_nb = p.lower().endswith(".ipynb")
        try:
            # Notebooks are mostly saved outputs, so they get a higher limit; only their code cells count.
            if os.path.getsize(full) > (NB_MAX_BYTES if is_nb else MAX_BYTES):
                continue
            with open(full, "rb") as fh:
                raw = fh.read()
        except OSError:
            continue
        if b"\0" in raw[:8000]:
            continue
        text = raw.decode("utf-8", "replace")
        if is_nb:
            text = notebook_code(text)
        lines = text.split("\n")
        count = len(lines) - (1 if len(lines) > 1 and text.endswith("\n") else 0)   # a final newline ends the last line
        todos = [{"line": i + 1, "text": l.strip()[:140]} for i, l in enumerate(lines) if TODO_RE.search(l)][:50]
        f = {"path": p, "lines": count, "funcs": len(FN_RE.findall(text)), "todos": todos}
        if with_source:
            f["text"] = "\n".join(lines[:PREVIEW_LINES])
        files.append(f)
        if len(files) >= MAX_FILES:
            break
    return files


def apply_commit(lines, churn, commit):
    for path, add, dele, status, *n in commit["c"]:
        churn[path] = churn.get(path, 0) + (n[0] if n else 1)
        if status == "D":
            lines.pop(path, None)
        elif status == "A" or path not in lines:
            lines[path] = max(1, add)
        else:
            lines[path] = max(1, lines[path] + add - dele)


def history(repo):
    """The main line of history oldest first, with per-file line deltas. Renames count as delete + add.
    Only first parents are followed, and a merge counts as one change against the line it joined, so files
    deleted on the main line can't come back from an older side-branch commit replayed after the delete."""
    common = ["log", "--reverse", "--first-parent", "-m", "--no-renames"]
    # %ct: when the commit landed (rebased commits keep their old author date).
    nums = git(repo, *common, "--numstat", "--format=%x01%H%x02%ct%x02%an%x02%s")
    stats = git(repo, *common, "--name-status", "--format=%x01%H")
    status = {}
    for chunk in stats.split("\x01")[1:]:
        rows = chunk.strip("\n").split("\n")
        status[rows[0]] = {path: s[:1] for s, _, path in (r.partition("\t") for r in rows[1:] if r)}
    commits = []
    for chunk in nums.split("\x01")[1:]:
        rows = chunk.strip("\n").split("\n")
        h, t, a, m = (rows[0].split("\x02") + ["", "", ""])[:4]
        st = status.get(h, {})
        changes = []
        for r in rows[1:]:
            parts = r.split("\t")
            if len(parts) != 3 or not is_code(parts[2]):
                continue
            add, dele, path = parts
            changes.append([path, int(add) if add.isdigit() else 0, int(dele) if dele.isdigit() else 0, st.get(path, "M")])
        if changes:
            commits.append({"h": h[:8], "t": int(t or 0), "a": a[:40], "m": m[:120], "c": changes})
    total = len(commits)
    if total > MAX_COMMITS:
        commits = squash(commits, -(-total // MAX_COMMITS))
    return {"base": {}, "baseChurn": {}, "commits": commits, "total": total}


def squash(commits, k):
    """Merge every k commits into one step so long histories still replay from the first commit.
    A change row's 5th field is how many commits touched that file in the step."""
    lines, steps = {}, []
    for i in range(0, len(commits), k):
        group = commits[i:i + k]
        before = dict(lines)
        touched = {}
        for c in group:
            apply_commit(lines, {}, c)
            for row in c["c"]:
                touched[row[0]] = touched.get(row[0], 0) + 1
        changes = []
        for path, n in touched.items():
            was, now = before.get(path), lines.get(path)
            if was is None and now is None:   # added and deleted within the step: still counts towards its churn
                changes.append([path, 0, 0, "D", n])
                continue
            if now is None:
                changes.append([path, 0, was, "D", n])
            elif was is None:
                changes.append([path, now, 0, "A", n])
            else:
                changes.append([path, max(0, now - was), max(0, was - now), "M", n])
        authors = [c["a"] for c in group]
        steps.append({"h": group[-1]["h"], "t": group[-1]["t"], "a": max(set(authors), key=authors.count),
                      "m": group[-1]["m"] + (f"  (+{len(group) - 1} more commits)" if len(group) > 1 else ""),
                      "c": changes})
    return steps


def build_city(src, with_source=True, from_page=False):
    with build_lock:
        repo, name = resolve(src, from_page)
        is_git = os.path.isdir(os.path.join(repo, ".git"))
        if is_git:
            paths = [p for p in git(repo, "ls-files", "-z").split("\0") if p]
        else:
            paths = []
            for root, dirs, names in os.walk(repo):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                paths += [os.path.relpath(os.path.join(root, n), repo).replace(os.sep, "/") for n in names]
        files = analyze(repo, sorted(paths), with_source)
        hist = history(repo) if is_git else None
        if hist:
            # Files that exist today but are left out of the city (too big, binary, past the file limit) are left out
            # of the history too, or their buildings would rise during the replay and vanish at today.
            shown = {f["path"] for f in files}
            left_out = {p for p in paths if is_code(p) and p not in shown}
            for c in hist["commits"]:
                c["c"] = [row for row in c["c"] if row[0] not in left_out]
            hist["commits"] = [c for c in hist["commits"] if c["c"]]
        return {"name": name, "source": "git" if is_git else "folder", "files": files, "history": hist}


FAVICON = ("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E"
           "%3Crect width=%2232%22 height=%2232%22 rx=%226%22 fill=%22%230b1020%22/%3E"
           "%3Crect x=%225%22 y=%2214%22 width=%226%22 height=%2214%22 fill=%22%235b8def%22/%3E"
           "%3Crect x=%2213%22 y=%225%22 width=%227%22 height=%2223%22 fill=%22%23f2a541%22/%3E"
           "%3Crect x=%2222%22 y=%2210%22 width=%225%22 height=%2218%22 fill=%22%234fb38a%22/%3E%3C/svg%3E")


def page():
    """code-city.html is written as a page body (that's how the claude.ai artifact takes it); wrap it in a full document."""
    with open(os.path.join(HERE, "code-city.html"), encoding="utf-8") as fh:
        body = fh.read()
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
            '<meta name="description" content="Turn a code repo into a 3D night city: replay its git history and find change hotspots.">'
            f'<link rel="icon" href="{FAVICON}">'
            '<style>:root{padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}</style>'
            '</head><body>' + body + "</body></html>").encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Refuse requests that arrive under another hostname (DNS rebinding).
        if self.headers.get("Host", "").split(":")[0] not in ("localhost", "127.0.0.1"):
            return self.reply(403, "text/plain", b"Forbidden")
        url = urlparse(self.path)
        if url.path in ("/", "/index.html"):
            return self.reply(200, "text/html; charset=utf-8", page())
        if url.path == "/api/repo":
            # Only the app's own page may ask: other websites can make a browser send GET requests here, but they
            # can't add this header without a CORS preflight, which this server never approves.
            if self.headers.get("X-Code-City") != "1" or self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
                return self.reply(403, "application/json", b'{"error": "Requests must come from the Code City page."}')
            src = parse_qs(url.query).get("src", [""])[0]
            try:
                body = json.dumps(build_city(src, from_page=True), separators=(",", ":")).encode("utf-8")
                return self.reply(200, "application/json", body)
            except (ValueError, RuntimeError, subprocess.TimeoutExpired) as e:
                msg = "That took too long. Try a smaller repo." if isinstance(e, subprocess.TimeoutExpired) else str(e)
                return self.reply(400, "application/json", json.dumps({"error": msg}).encode("utf-8"))
        self.reply(404, "text/plain", b"Not found")

    def reply(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("  " + fmt % args + "\n")


def main():
    ap = argparse.ArgumentParser(description="Code City: see a repo as a 3D city.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="run the app locally")
    s.add_argument("--port", type=int, default=8787)
    s.add_argument("--no-open", action="store_true", help="don't open a browser tab")
    e = sub.add_parser("export", help="write a city JSON file")
    e.add_argument("src", help="repo URL, owner/name, or local folder")
    e.add_argument("-o", "--out")
    e.add_argument("--no-source", action="store_true", help="leave out file previews (smaller file)")
    sub.add_parser("build", help="write site/index.html for static hosting")
    args = ap.parse_args()

    if args.cmd == "build":
        os.makedirs(os.path.join(HERE, "site"), exist_ok=True)
        with open(os.path.join(HERE, "site", "index.html"), "wb") as fh:
            fh.write(page())
        print("Wrote site/index.html")
        return

    if args.cmd == "export":
        city = build_city(args.src, with_source=not args.no_source)
        out = args.out or re.sub(r"[^\w.-]+", "-", city["name"].split("/")[-1]) + ".json"
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(city, fh, separators=(",", ":"))
        h = city["history"]
        print(f"Wrote {out}: {len(city['files'])} files, {len(h['commits']) if h else 0} commits")
        return

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}/"
    print(f"Code City is running at {url}  (Ctrl+C to stop)")
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
