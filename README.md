# Code City

**Live:** https://code-city-lakshmi.netlify.app

See a codebase as a 3D city at night. Each file is a building: height is lines of code, width is number of functions, and folders are raised districts. TODO / FIXME comments burn on the rooftops.

- **Play history**: watch the city grow commit by commit, from the first file to today. New files flash and rise, and deleted files are demolished in a cloud of dust.
- **Change heat**: color buildings by how many commits touched them. Hot files are where bugs tend to live and where refactoring pays off.
- **Walk the streets**: WASD to move, mouse to look, Shift to run, Space to jump (you can land on roofs), click to inspect.

## On the hosted site

Paste any public GitHub repo and press Build. The site reads it straight from GitHub's API:

1. Today's files show right away (about 4 requests).
2. You pick how much history to replay: 1 week, 1 month, 3 months, 1 year, all time, or a number of commits. The panel shows how many commits that is, the dates, and how many GitHub requests it will cost.
3. Each commit costs one request. If the range doesn't fit in what you have left, it loads as coarser steps (GitHub's compare between evenly spaced commits), so you still get the whole range.

Without signing in, GitHub allows **60 requests an hour** per network. Add a GitHub token (a fine-grained token with public repository access only) to get **5,000 an hour**, enough for every commit of most repos. The token is only sent to api.github.com and is kept in the browser only if you tick "Remember on this device".

Building heights are estimated from file size until you click a building, which loads its real source. Loading all time from the first commit replays real line counts.

## Run it locally

Needs Python 3.8+ and git. No other installs.

    python3 codecity.py serve

Opens http://localhost:8787. Paste any public GitHub, GitLab or Bitbucket URL (or `owner/name`, or a local folder path) and press Build. Repos are cloned into `~/.cache/code-city`.

## Export a repo for the hosted site

To show a repo's full history on the hosted site, export it and drag the JSON onto the page:

    python3 codecity.py export owner/repo              # writes repo.json
    python3 codecity.py export owner/repo --no-source  # smaller, without file previews

Histories longer than 1,500 commits are merged into 1,500 steps, so the timelapse still starts from the first commit. The hosted site bundles Flask and Express in `site/presets/`; type `pallets/flask` or `expressjs/express` to load them.

## Project layout

| Path | What it is |
|---|---|
| `code-city.html` | The whole app: Three.js scene, treemap layout, timelapse, heat map, walk mode |
| `codecity.py` | Local server, repo exporter (git log → city JSON) and site builder |
| `site/` | What Netlify serves. Rebuild `site/index.html` with `python3 codecity.py build` after editing `code-city.html`. Pushing to `main` deploys it. |
