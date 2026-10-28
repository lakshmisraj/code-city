#!/usr/bin/env python3
"""Code City PR summary: comment on a pull request with the hotspots and owners of the files it touches.

Runs inside GitHub Actions (see action.yml). Needs the repo checked out with full history
(actions/checkout with fetch-depth: 0) and a token that can write pull request comments.
Set DRY_RUN=1 to print the comment instead of posting it.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

MARKER = "<!-- code-city-pr-summary -->"   # finds our earlier comment so pushes update it instead of adding more
MAX_ROWS = 15


def git(*args):
    r = subprocess.run(["git", "-c", "core.quotepath=off", *args], capture_output=True, text=True,
                       cwd=os.environ.get("GITHUB_WORKSPACE", "."), errors="replace")
    if r.returncode:
        raise RuntimeError(f"git {' '.join(args[:2])} failed: {r.stderr.strip()[:300]}")
    return r.stdout


def changed_files(base, head):
    """[(status, path, old_path)] for the PR, measured from where it branched off."""
    out = []
    for line in git("diff", "--name-status", "-M", f"{base}...{head}").splitlines():
        parts = line.split("\t")
        status = parts[0][:1]
        if status == "R" and len(parts) == 3:
            out.append(("R", parts[2], parts[1]))
        elif len(parts) >= 2:
            out.append((status, parts[1], None))
    return out


def history(ref, days):
    """Per file: how many commits touched it, and who made them, over the last `days` days."""
    churn, authors = {}, {}
    author = None
    for line in git("log", f"--since={days} days ago", "--no-merges", "--format=%x01%aN", "--name-only", ref).splitlines():
        if line.startswith("\x01"):
            author = line[1:].strip()
        elif line.strip():
            churn[line] = churn.get(line, 0) + 1
            authors.setdefault(line, {})
            authors[line][author] = authors[line].get(author, 0) + 1
    return churn, authors


def hot_threshold(churn):
    """A file is a hotspot when its change count is in the top tenth of the repo's files (at least 2 changes)."""
    counts = sorted(churn.values(), reverse=True)
    return max(2, counts[len(counts) // 10]) if counts else float("inf")


def build_comment(repo, number, files, churn, authors, days, site):
    hot_at = hot_threshold(churn)
    rows = []
    for status, path, old in files:
        known_as = old or path   # a renamed file's history is under its old name
        c = churn.get(known_as, 0)
        who = authors.get(known_as, {})
        top = max(who.items(), key=lambda kv: kv[1])[0] if who else None
        rows.append({"status": status, "path": path, "old": old, "churn": c, "hot": c >= hot_at,
                     "owner": top, "solo": len(who) == 1 and c >= 2})
    rows.sort(key=lambda r: (not r["hot"], -r["churn"], r["path"]))

    hot = [r for r in rows if r["hot"]]
    solo = [r for r in rows if r["solo"]]
    label = {"A": "new", "D": "deleted", "R": "renamed", "M": "changed"}
    period = "last year" if days == 365 else f"last {days} days"
    lines = [MARKER, f"### 🏙 Code City: this PR touches {len(rows)} file{'s' if len(rows) != 1 else ''}", ""]
    if hot:
        lines.append(f"⚠️ **{len(hot)} hotspot{'s' if len(hot) != 1 else ''}**: files that change more often than nine in ten others. Bugs tend to cluster in them, so review these closely.")
    else:
        lines.append("✅ No hotspots: none of these files is among the repo's most often changed.")
    for r in solo[:3]:
        lines.append(f"👤 Only **{r['owner']}** has changed `{r['path']}` in the {period}. They may be the best reviewer for it.")
    lines += ["", f"| | File | Commits ({period}) | Changed most by |", "|---|---|---|---|"]
    for r in rows[:MAX_ROWS]:
        flag = "🔥" if r["hot"] else ""
        name = f"`{r['path']}`" + (f" (was `{r['old']}`)" if r["old"] else "")
        lines.append(f"| {flag} {label.get(r['status'], 'changed')} | {name} | {r['churn']} | {r['owner'] or '–'} |")
    if len(rows) > MAX_ROWS:
        lines.append(f"| | …and {len(rows) - MAX_ROWS} more | | |")
    lines += ["", f"[**Open this PR in Code City →**]({site.rstrip('/')}/?repo={repo}&pr={number}&mode=heat)",
              "", "<sub>Counts come from git history; names are as they appear in commits.</sub>"]
    return "\n".join(lines)


def github(method, url, token, body=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "code-city-action"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


def post(repo, number, body, token):
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    comments = github("GET", f"{api}/repos/{repo}/issues/{number}/comments?per_page=100", token)
    mine = next((c for c in comments if MARKER in (c.get("body") or "")), None)
    if mine:
        github("PATCH", f"{api}/repos/{repo}/issues/comments/{mine['id']}", token, {"body": body})
        print(f"Updated Code City comment on #{number}")
    else:
        github("POST", f"{api}/repos/{repo}/issues/{number}/comments", token, {"body": body})
        print(f"Posted Code City comment on #{number}")


def main():
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as fh:
        event = json.load(fh)
    pr = event.get("pull_request")
    if not pr:
        print("Code City: not a pull request event, nothing to do.")
        return
    repo, number = os.environ["GITHUB_REPOSITORY"], pr["number"]
    base, head = pr["base"]["sha"], pr["head"]["sha"]
    days = int(os.environ.get("CODE_CITY_DAYS") or 365)
    site = os.environ.get("CODE_CITY_SITE") or "https://code-city-lakshmi.netlify.app"
    try:
        files = changed_files(base, head)
    except RuntimeError as e:
        print(f"::warning::Code City needs the full git history. Add `fetch-depth: 0` to actions/checkout. ({e})")
        return
    if not files:
        print("Code City: this PR changes no files.")
        return
    churn, authors = history(base, days)
    body = build_comment(repo, number, files, churn, authors, days, site)
    if os.environ.get("DRY_RUN"):
        print(body)
        return
    try:
        post(repo, number, body, os.environ["GITHUB_TOKEN"])
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):
            # Pull requests from forks get a read-only token, so they can't be commented on.
            print(f"::warning::Code City couldn't comment on this PR (HTTP {e.code}). PRs from forks can't be commented on with the default token; make sure the workflow has `pull-requests: write`.")
            return
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as e:   # never fail someone's CI because of a summary comment
        print(f"::warning::Code City summary skipped: {e}")
        sys.exit(0)
