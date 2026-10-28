# Code City

**Live:** https://code-city-lakshmi.netlify.app

See a codebase as a 3D city at night. Each file is a building: height is lines of code, width is number of functions, and folders are raised districts. TODO / FIXME comments burn on the rooftops.

- **Play history**: watch the city grow commit by commit, from the first file to today. New files flash and rise, and deleted files are demolished in a cloud of dust.
- **Change heat**: color buildings by how many commits touched them. Hot files are where bugs tend to live and where refactoring pays off.

## On the hosted site

Paste any public GitHub repo and press Build. The site reads it straight from GitHub's API:

1. Today's files show right away (about 4 requests).
2. You pick which stretch of history to replay by dragging the two ends of a slider, from the first commit to today. If the stretch ends before today, one extra request carries the city on to today, so the timeline always finishes at the current code. The panel shows how many commits that is, the dates, and how many GitHub requests it will cost.
3. Each commit costs one request. If the range doesn't fit in what you have left, it loads as coarser steps (GitHub's compare between evenly spaced commits), so you still get the whole range.

Without signing in, GitHub allows **60 requests an hour** per network. Add a GitHub token (a fine-grained token with public repository access only) to get **5,000 an hour**, enough for every commit of most repos. The token is only sent to api.github.com and is kept in the browser only if you tick "Remember on this device".

Building heights are estimated from file size until you click a building, which loads its real source. Loading all time from the first commit replays real line counts.

### Hotspots, pull requests and links

- **Hotspots** ranks files by *commits × lines*: big files that keep changing, where bugs tend to cluster and refactoring pays off first. Click a row to fly to the building.
- **Show a pull request**: enter a PR number or paste its URL. Its files light up (blue changed, green new, red deleted), everything else dims, and the panel flags the ones that are hotspots.
- **Copy link** copies a link that reopens the same view, for example
  `https://code-city-lakshmi.netlify.app/?repo=sindresorhus/ky&range=2026-06-01..now&mode=heat&panel=hotspots&pr=12&file=source/core/Ky.ts`.
  `range` is two dates (`start` and `now` also work); older links with `1w`, `1m`, `3m`, `1y` or `all` still open.
  A link loads its history by itself only when that costs 60 GitHub requests or fewer; otherwise it opens the history panel with that range picked.

### Ask the city

Type a question such as "where is authentication handled?". Gemini reads the city's file list (names and sizes, not the code), answers in a few sentences, and the files it points to light up. Asking needs a GitHub sign-in, so the site's Gemini budget can't be spent anonymously.

Site owner setup: create a Gemini API key in Google AI Studio, add it as `GEMINI_API_KEY` to the site's environment variables (marked secret) and redeploy. Until then the Ask box stays hidden. It runs `netlify/functions/ask.js` with `gemini-3.8-flash` at low thinking.

### Sign in with GitHub (site owner setup)

Sign-in runs through two Netlify Functions in `netlify/functions/`. It asks GitHub for no scopes: the token only identifies the visitor, which raises their limit to 5,000 requests an hour. The token reaches the page through the site's own storage, never through a URL. Until it's set up, the button stays hidden and the paste-a-token box still works.

1. On GitHub: Settings → Developer settings → OAuth Apps → New OAuth App.
   - Homepage URL: `https://code-city-lakshmi.netlify.app`
   - Authorization callback URL: `https://code-city-lakshmi.netlify.app/.netlify/functions/github-callback`
2. In Netlify: Site configuration → Environment variables, add `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (mark the secret as secret), then redeploy.

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
| `code-city.html` | The whole app: Three.js scene, treemap layout, timelapse, heat map, hotspots, PR view |
| `codecity.py` | Local server, repo exporter (git log → city JSON) and site builder |
| `site/` | What Netlify serves. Rebuild `site/index.html` with `python3 codecity.py build` after editing `code-city.html`. Pushing to `main` deploys it. |
