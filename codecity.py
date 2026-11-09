#!/usr/bin/env python3
"""Code City: turn a git repo into a 3D city.

  code-city .                    open this folder's city in the browser (any folder, private code included)
  code-city pallets/flask        clone a public repo and open its city
  code-city                      open the app; paste a repo URL or a folder there
  code-city export owner/repo    write repo.json to drop into the published page
  code-city build                build code-city.html and site/index.html from src/, in a checkout

Installed with `pipx install code-city`, or run from a checkout as `python3 codecity.py ...`.
Needs only Python 3.8+ and git. Public repos are cloned into ~/.cache/code-city.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import errno
import getpass
import secrets
import shutil
import threading
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

__version__ = "0.1.1"

HERE = os.path.dirname(os.path.abspath(__file__))
# In a checkout the page sits next to this file; an installed copy carries it in codecity_assets/.
ASSETS = HERE if os.path.isfile(os.path.join(HERE, "code-city.html")) else os.path.join(HERE, "codecity_assets")
START = None   # what the command line asked to open; the page asks for it once it's up (see /api/start)
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "code-city")

# Keep in sync with EXT / SPECIAL / SKIP_DIRS in src/app.js. Never add "env": .env files hold secrets, and
# exported cities carry each file's first lines (and get shared); the page can also send them to Gemini.
CODE_EXT = set("""ts tsx mts cts js jsx mjs cjs vue svelte py ipynb go rs java scala kt kts c h cc cpp hpp cxx cs rb php
swift css scss sass less html htm sql sh bash zsh ps1 md mdx rst txt json yml yaml toml ini xml gradle lock
dart lua ex exs hs ml r jl zig elm clj""".split())
SPECIAL = {"dockerfile", "makefile", "gemfile", "rakefile", "procfile", "go.mod"}
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


# The product's own code, and what's around it (tests, stories, mocks, docs, examples, generated code, migrations).
# Keep both in step with SOURCE_FILE and MINOR_FILE in src/app.js.
SOURCE_RE = re.compile(r"\.(m?[jt]sx?|cjs|py|go|rs|java|kts?|swift|rb|php|c|cc|cpp|h|hpp|cs|scala|vue|svelte|exs?|dart|lua|sh)$", re.I)
MINOR_RE = re.compile(r"(^|/)(tests?|spec|__tests__|__mocks__|mocks?|fixtures?|examples?|docs?|stories|storybook|benchmarks?|e2e|generated|__generated__|migrations?)/"
                      r"|\.(test|spec|stories|story|d)\.[cm]?[jt]sx?$|_test\.go$|\.generated\.", re.I)


def split_parts(paths, weight, share, most):
    """A repo's parts by folder: one per top folder, and a part holding more than `share` of the whole is split by its
    subfolders (through a folder with only one), until none is or there would be more than `most`. Same as splitParts
    in src/app.js."""
    total = sum(weight(p) for p in paths)

    def kids(prefix, items):
        out = {}
        for p in items:
            rest = p[len(prefix):]
            k = prefix + rest[:rest.index("/") + 1] if "/" in rest else prefix
            out.setdefault(k, []).append(p)
        return out

    parts = kids("", paths)
    split = True
    while split:
        split = False
        for k, items in sorted(((k, v) for k, v in parts.items() if sum(map(weight, v)) > total * share), key=lambda kv: -sum(map(weight, kv[1]))):
            prefix, sub = k, kids(k, items)
            while len(sub) == 1 and prefix not in sub:   # down through single subfolders
                prefix = next(iter(sub))
                sub = kids(prefix, items)
            if len(sub) < 2 or len(parts) - 1 + len(sub) > most:
                continue
            del parts[k]
            parts.update(sub)
            split = True
            break
    return parts


def pick_order(paths, room=None):
    """The order to read a big repo's files in, so the city's room goes to a fair share of each part (by how much of
    the product's own code is there), not just the first files alphabetically, which could leave a monorepo's main
    packages out. Within a part: its own code first, then tests and the like, then the rest; shallower files first.
    Same as pickFiles in src/app.js."""
    room = room or MAX_FILES
    if len(paths) <= room:
        return list(paths)
    rank = lambda p: 2 if not SOURCE_RE.search(p) else 1 if MINOR_RE.search(p) else 0
    weight = lambda p: 1 if rank(p) == 0 else 0.2
    key = lambda p: (rank(p), p.count("/"), p)
    total = sum(map(weight, paths))
    first = []
    for items in split_parts(paths, weight, 0.1, 60).values():   # each part's share of the room, and a few files from every part
        first += sorted(items, key=key)[:max(min(len(items), 5), int(room * sum(map(weight, items)) / total))]
    chosen = set(first)
    return sorted(first, key=key) + [p for p in sorted(paths, key=key) if p not in chosen]


def analyze(repo, paths, with_source):
    """The city's files, read in pick_order until the city is full; returns them in path order, and how many code files there are."""
    files, root = [], os.path.realpath(repo)
    code = [p for p in paths if is_code(p)]
    for p in pick_order(code):
        full = os.path.join(repo, p)
        # A symlink could point out of the repo (a cloned repo's x.txt -> ~/.ssh/id_rsa); its text would be shown and
        # could be sent to Gemini. Only files really inside the repo are read.
        if os.path.islink(full) or not os.path.realpath(full).startswith(root + os.sep):
            continue
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
    at = {p: i for i, p in enumerate(code)}
    files.sort(key=lambda f: at[f["path"]])
    return files, len(code)


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


def has_commits(repo):
    try:
        git(repo, "rev-parse", "--verify", "--quiet", "HEAD")
        return True
    except RuntimeError:
        return False


def build_city(src, with_source=True, from_page=False):
    with build_lock:
        repo, name = resolve(src, from_page)
        is_git = os.path.isdir(os.path.join(repo, ".git"))
        if is_git:
            # Files git tracks plus new ones it doesn't yet (but not ignored ones), so uncommitted work shows too.
            paths = sorted({p for p in git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0") if p})
        else:
            paths = []
            for root, dirs, names in os.walk(repo):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                paths += [os.path.relpath(os.path.join(root, n), repo).replace(os.sep, "/") for n in names]
        files, code_files = analyze(repo, sorted(paths), with_source)
        hist = history(repo) if is_git and has_commits(repo) else None   # a brand-new repo: today's files, no history
        if hist:
            # Files that exist today but are left out of the city (too big, binary, past the file limit) are left out
            # of the history too, or their buildings would rise during the replay and vanish at today.
            shown = {f["path"] for f in files}
            left_out = {p for p in paths if is_code(p) and p not in shown}
            for c in hist["commits"]:
                c["c"] = [row for row in c["c"] if row[0] not in left_out]
            hist["commits"] = [c for c in hist["commits"] if c["c"]]
        city = {"name": name, "source": "git" if is_git else "folder", "files": files, "history": hist}
        if code_files > len(files):
            city["codeFiles"] = code_files   # the page says the city shows only some of them
        return city


FAVICON = ("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E"
           "%3Crect width=%2232%22 height=%2232%22 rx=%226%22 fill=%22%230b1020%22/%3E"
           "%3Crect x=%225%22 y=%2214%22 width=%226%22 height=%2214%22 fill=%22%235b8def%22/%3E"
           "%3Crect x=%2213%22 y=%225%22 width=%227%22 height=%2223%22 fill=%22%23f2a541%22/%3E"
           "%3Crect x=%2222%22 y=%2210%22 width=%225%22 height=%2218%22 fill=%22%234fb38a%22/%3E%3C/svg%3E")


# The page is edited as src/page.html, src/style.css and src/app.js. `code-city build` puts them together into
# code-city.html, one page body (that's how the claude.ai artifact and the installed package take it), and
# site/index.html. In a checkout the server reads src/ on every load, so a reload shows edits.
SRC = os.path.join(HERE, "src")
STYLE_MARK, APP_MARK = "/* src/style.css */", "// src/app.js"


def assembled():
    """src/page.html with src/style.css and src/app.js put in their places: the page body."""
    def read(name):
        with open(os.path.join(SRC, name), encoding="utf-8") as fh:
            return fh.read()
    shell = read("page.html")
    assert STYLE_MARK in shell and APP_MARK in shell, "src/page.html lost its style or app placeholder"
    return shell.replace(STYLE_MARK, read("style.css").rstrip("\n"), 1).replace(APP_MARK, read("app.js").rstrip("\n"), 1)


LOCK_MARK = "const LOCKED_FOR = null, SITE_URLS = {};"
AUDIENCES = ("beginner", "advanced", "manager")


def locked(html, audience, sites=""):
    """The page set to one version only (Beginner, Advanced or Manager), for a site that is just that version.
    sites ("advanced=https://…,manager=https://…") are the other versions' addresses, linked from the Guide."""
    urls = dict(kv.split("=", 1) for kv in sites.split(",") if "=" in kv)
    urls = {k.strip(): v.strip() for k, v in urls.items() if k.strip() in AUDIENCES and v.strip().startswith("https://")}
    mark = LOCK_MARK.encode()
    assert html.count(mark) == 1, "src/app.js lost its LOCKED_FOR line"
    return html.replace(mark, f"const LOCKED_FOR = {json.dumps(audience)}, SITE_URLS = {json.dumps(urls)};".encode(), 1)


def page():
    """The page body (from src/ in a checkout, else the built code-city.html), wrapped in a full document."""
    if os.path.isfile(os.path.join(SRC, "page.html")):
        body = assembled()
    else:
        with open(os.path.join(ASSETS, "code-city.html"), encoding="utf-8") as fh:
            body = fh.read()
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
            '<meta name="description" content="Turn a code repo into a 3D night city: replay its git history and find change hotspots.">'
            f'<link rel="icon" href="{FAVICON}">'
            '<style>:root{padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}</style>'
            '</head><body>' + body + "</body></html>").encode("utf-8")


# Ask, tours and explanations with your own Gemini key: local/ask-server.mjs runs the site's own ask.mjs under
# Node, and this server passes the page's requests through to it. Off unless GEMINI_API_KEY is set.
ASK = None   # {"port", "secret"} once it's running
ASK_NO_KEY = "Set GEMINI_API_KEY before running code-city to use Ask here (it needs Node 18+). Get a free key at https://aistudio.google.com/apikey"


def ask_script():
    """The ask server to run: the bundled copy in an installed code-city, or the source in a checkout."""
    bundled = os.path.join(ASSETS, "ask-server.mjs")
    if ASSETS != HERE and os.path.isfile(bundled):
        return bundled
    source = os.path.join(HERE, "local", "ask-server.mjs")
    if os.path.isfile(source) and os.path.isdir(os.path.join(HERE, "node_modules", "@google", "genai")):
        return source
    return None


def ask_for_key():
    """At a terminal with no key set, offer to take one for this run. It stays in this process's memory, never in a file."""
    if os.environ.get("GEMINI_API_KEY") or not (sys.stdin.isatty() and sys.stdout.isatty()):
        return   # already set, or nobody to ask: the VS Code extension, a script, CI
    if not (os.environ.get("CODE_CITY_NODE") or shutil.which("node")) or not ask_script():
        return   # a key couldn't turn Ask on, and start_ask says why
    print("Ask, tours and explanations need a Gemini key, free at https://aistudio.google.com/apikey", flush=True)
    try:
        key = getpass.getpass("Paste your key (hidden, used for this run only), or press Enter to skip: ").strip()
    except EOFError:
        return
    if key:
        os.environ["GEMINI_API_KEY"] = key


def start_ask():
    """Start the ask server if there's a key, Node and the script; returns a line for the terminal."""
    global ASK
    if not os.environ.get("GEMINI_API_KEY"):
        return "Ask is off: " + ASK_NO_KEY
    # CODE_CITY_NODE: a Node to use instead of the one on PATH (the VS Code extension passes its own)
    node, script = os.environ.get("CODE_CITY_NODE") or shutil.which("node"), ask_script()
    if not node:
        return "Ask is off: it needs Node 18+ (https://nodejs.org), and GEMINI_API_KEY is set."
    if not script:
        return "Ask is off: run `npm install` in this checkout first."
    secret = secrets.token_hex(24)
    proc = subprocess.Popen([node, script], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            env=dict(os.environ, ASK_SECRET=secret), text=True)
    line = [None]
    reader = threading.Thread(target=lambda: line.__setitem__(0, proc.stdout.readline()), daemon=True)
    reader.start()
    reader.join(30)   # loading the Gemini packages can take a while on a busy machine
    m = re.match(r"ready (\d+)", line[0] or "")
    if not m:
        proc.kill()
        return "Ask is off: its server didn't start (see the error above)."
    ASK = {"port": int(m.group(1)), "secret": secret, "proc": proc}
    return "Ask is on, with your Gemini key."


def ask_forward(method, query, body):
    """Pass one request to the ask server; returns (status, body)."""
    req = urllib.request.Request(f"http://127.0.0.1:{ASK['port']}/{'?' + query if query else ''}", data=body, method=method,
                                 headers={"X-Ask-Secret": ASK["secret"], "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, OSError):
        return 502, b'{"error": "Code City\'s ask server stopped. Restart code-city."}'


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.headers.get("Host", "").split(":")[0] not in ("localhost", "127.0.0.1"):
            return self.reply(403, "text/plain", b"Forbidden")
        url = urlparse(self.path)
        if url.path != "/.netlify/functions/ask":
            return self.reply(404, "text/plain", b"Not found")
        # Only the app's own page may spend your key: other websites can't add X-Code-City without a CORS preflight,
        # which this server never approves (and browsers that send Sec-Fetch-Site say where a request came from).
        if self.headers.get("X-Code-City") != "1" or self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
            return self.reply(403, "application/json", b'{"error": "Requests must come from the Code City page."}')
        if not ASK:
            return self.reply(503, "application/json", json.dumps({"error": ASK_NO_KEY}).encode("utf-8"))
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = -1
        if size < 0 or size > 2 * 1024 * 1024:
            return self.reply(413, "application/json", b'{"error": "That request is too big."}')
        status, body = ask_forward("POST", url.query, self.rfile.read(size))
        return self.reply(status, "application/json", body)

    def do_GET(self):
        # Refuse requests that arrive under another hostname (DNS rebinding).
        if self.headers.get("Host", "").split(":")[0] not in ("localhost", "127.0.0.1"):
            return self.reply(403, "text/plain", b"Forbidden")
        url = urlparse(self.path)
        if url.path == "/.netlify/functions/ask":   # is Ask on? (the page asks once it loads)
            if not ASK:
                return self.reply(200, "application/json", b'{"enabled": false}')
            if url.query and (self.headers.get("X-Code-City") != "1" or self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none")):
                return self.reply(403, "application/json", b'{"error": "Requests must come from the Code City page."}')
            status, body = ask_forward("GET", url.query, None)
            return self.reply(status, "application/json", body)
        if url.path in ("/", "/index.html"):
            return self.reply(200, "text/html; charset=utf-8", page())
        if url.path.startswith("/vendor/tree-sitter/"):
            # The parser behind function-level links. Only plain file names from that one folder.
            name = url.path.rsplit("/", 1)[1]
            fpath = os.path.join(ASSETS, "site", "vendor", "tree-sitter", name)
            if re.fullmatch(r"[\w.-]+\.(js|wasm)", name) and os.path.isfile(fpath):
                with open(fpath, "rb") as fh:
                    return self.reply(200, "application/wasm" if name.endswith(".wasm") else "text/javascript", fh.read())
        if url.path in ("/api/repo", "/api/start"):
            # Only the app's own page may ask: other websites can make a browser send GET requests here, but they
            # can't add this header without a CORS preflight, which this server never approves.
            if self.headers.get("X-Code-City") != "1" or self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
                return self.reply(403, "application/json", b'{"error": "Requests must come from the Code City page."}')
        if url.path == "/api/start":
            return self.reply(200, "application/json", json.dumps({"src": START}).encode("utf-8"))
        if url.path == "/api/repo":
            src = parse_qs(url.query).get("src", [""])[0]
            try:
                # The folder named on the command line may be anywhere: you typed it. Others must be in your home folder.
                body = json.dumps(build_city(src, from_page=src != START), separators=(",", ":")).encode("utf-8")
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


def main(argv=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    # `code-city .` and `code-city owner/name` are short for `code-city serve ...`; plain `code-city` opens the app.
    if not argv or (argv[0] not in ("serve", "export", "build") and argv[0] not in ("-h", "--help", "--version")):
        argv = ["serve", *argv]
    ap = argparse.ArgumentParser(prog="code-city", description="Code City: see a repo as a 3D city.",
                                 epilog="Run `code-city .` in a project folder to see it as a city.")
    ap.add_argument("--version", action="version", version=f"code-city {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="open the app locally (the default command)")
    s.add_argument("src", nargs="?", help="a folder, a repo URL or owner/name to open straight away")
    s.add_argument("--port", type=int, default=8787, help="port to listen on (another free one if it's taken)")
    s.add_argument("--no-open", action="store_true", help="don't open a browser tab")
    e = sub.add_parser("export", help="write a city JSON file")
    e.add_argument("src", help="repo URL, owner/name, or local folder")
    e.add_argument("-o", "--out")
    e.add_argument("--no-source", action="store_true", help="leave out file previews (smaller file)")
    b = sub.add_parser("build", help="put src/ together into code-city.html and site/index.html (from a checkout)")
    b.add_argument("--for", dest="audience", choices=AUDIENCES, help="make site/index.html only this version (each Netlify site does)")
    b.add_argument("--sites", default="", help="the other versions' addresses for the Guide: advanced=https://…,manager=https://…")
    args = ap.parse_args(argv)

    if args.cmd == "build":
        with open(os.path.join(HERE, "code-city.html"), "w", encoding="utf-8", newline="") as fh:
            fh.write(assembled())
        os.makedirs(os.path.join(HERE, "site"), exist_ok=True)
        with open(os.path.join(HERE, "site", "index.html"), "wb") as fh:
            fh.write(locked(page(), args.audience, args.sites) if args.audience else page())
        print("Wrote code-city.html and site/index.html from src/" + (f", site/index.html as the {args.audience.title()} site" if args.audience else ""))
        return

    if args.cmd == "export":
        city = build_city(args.src, with_source=not args.no_source)
        out = args.out or re.sub(r"[^\w.-]+", "-", city["name"].split("/")[-1]) + ".json"
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(city, fh, separators=(",", ":"))
        h = city["history"]
        print(f"Wrote {out}: {len(city['files'])} files, {len(h['commits']) if h else 0} commits")
        return

    global START
    if args.src:   # checked before the key prompt, so a mistyped name fails straight away
        local = os.path.expanduser(args.src)
        if os.path.isdir(local):
            START = os.path.realpath(local)
        elif REPO_RE.match(args.src.strip()) or SHORT_RE.match(args.src.strip()):
            START = args.src.strip()
        else:
            ap.exit(2, f"code-city: {args.src} isn't a folder, a repo URL or owner/name\n")
    try:
        ask_for_key()
    except KeyboardInterrupt:
        print()
        return
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)   # that port is taken: any free one
    url = f"http://localhost:{server.server_address[1]}/"
    print(f"Code City is running at {url}{f'  showing {START}' if START else ''}  (Ctrl+C to stop)", flush=True)
    print("  " + start_ask(), flush=True)
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
