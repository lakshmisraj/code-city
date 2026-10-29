# Code City

**Live:** https://code-city-view.netlify.app

See a codebase as a 3D city at night. Each file is a building: height is lines of code, width is number of functions, and folders are raised districts. TODO / FIXME comments burn on the rooftops.

- **Play history**: watch the city grow commit by commit, from the first file to today. New files flash and rise, and deleted files are demolished in a cloud of dust.
- **Change heat**: color buildings by how many commits touched them. Hot files are where bugs tend to live and where refactoring pays off.

### Words used on the site

| Word | Meaning |
|---|---|
| Building | One file. Height is lines of code, width is the number of functions. |
| District | A folder, raised one step for each level of nesting. |
| Fire | A TODO, FIXME or HACK comment on that file's roof. |
| Change heat | How many commits touched a file, from dark blue (rarely) to orange-red (constantly). |
| Hotspot | A file in the repo's top tenth for how often it changes (at least 2 changes). The PR view and the PR bot flag these. The **Hotspots** list ranks by *commits × lines* instead, so big files that keep changing come first. |

## On the hosted site

Paste any public GitHub repo and press Build. The site reads it straight from GitHub's API:

1. Today's files show right away (about 4 requests).
2. You pick which stretch of history to replay by dragging the two ends of a slider, from the first commit to today. If the stretch ends before today, one extra request carries the city on to today, so the timeline always finishes at the current code. The panel shows how many commits that is, the dates, and how many GitHub requests it will cost.
3. Each commit costs one request. If the range doesn't fit in what you have left, it loads as coarser steps (GitHub's compare between evenly spaced commits), so you still get the whole range.

Without signing in, GitHub allows **60 requests an hour** per network. **Sign in with GitHub**, or paste a GitHub token (a fine-grained token with public repository access only), to get **5,000 an hour**, enough for every commit of most repos. A pasted token is only sent to api.github.com and is kept in the browser only if you tick "Remember on this device"; Ask and Tour use the sign-in, never a pasted token.

The timeline follows the default branch's main line: each merge is one step for the branch it brought in, and commits are placed by the date they landed (the committer date), so rebased work shows up where it was merged. Files left out of the city (too big, or past the 4,000-file limit) are left out of the history too. A load can be stopped with **Cancel**; starting another load stops the one before.

Building heights are estimated from file size until you click a building, which loads its real source. Loading all time from the first commit replays real line counts.

### Folders, hotspots, pull requests and links

- **Folders**: click a district (or its name) to open the folder. Everything outside it dims, and the panel shows its size, the folders inside and its biggest files. The path at the top of a file's or folder's panel links to each parent folder.

- **Hotspots** ranks files by *commits × lines* (see the table above): big files that keep changing, where bugs tend to cluster and refactoring pays off first. Click a row to fly to the building.
- **Show a pull request**: enter a PR number or paste its URL. Its files light up (blue changed, green new, red deleted), everything else dims, and the panel flags the ones that are hotspots (top tenth for changes).
- **Copy link** copies a link that reopens the same view, for example
  `https://code-city-view.netlify.app/?repo=sindresorhus/ky&range=2026-06-01..now&mode=heat&panel=hotspots&pr=12&file=source/core/Ky.ts`.
  `range` is two dates (`start` and `now` also work); older links with `1w`, `1m`, `3m`, `1y` or `all` still open.
  A link loads its history by itself only when that costs 60 GitHub requests or fewer; otherwise it opens the history panel with that range picked.

### Ask the city

Type a question such as "where is authentication handled?". Gemini reads the city's file list (names and sizes, not the code), answers in a few sentences, and the files it points to light up. The page then pulls the source of the top three files (from GitHub, or the preview a city file carries) and Gemini explains how that code works: what each file does, its key parts with line numbers, and the other files it connects to. Each connection is marked **imports** when the code's import lines show it, or **inferred** when it's Gemini's reading.

Asking needs **Sign in with GitHub** (a pasted token isn't enough, because it is only ever sent to GitHub), so the site's Gemini budget can't be spent anonymously. Each GitHub account gets 20 questions or tours an hour plus 20 code explanations, and the whole site 300 Gemini calls a day (set `ASK_PER_HOUR` and `ASK_PER_DAY` to change them); the counts are kept in Netlify Blobs.

**Explain this code** in a file's panel (or **Explain** on a code viewer pane) explains one file, and **Explain this folder** a folder's three biggest files. With explanations already open, a new one is added below them instead of replacing them. Gemini reads at most 24,000 characters of each file and says when it only saw the start.

Explanations form a chain: **Follow** on any connected file explains it next, as a new step below the ones before ("followed from app.py"), and opens both files side by side in the code viewer, so you can trace a request from file to file. The trail at the top jumps between steps, thicker arcs mark the path the chain took, and a chain holds up to 8 steps.

### Connections between files

Arcs over the city show which files import which, read from the code's import lines (JavaScript and TypeScript, Python, Go, Ruby, Java and Kotlin, C and C++, CSS, Rust and PHP), never guessed. They show one file at a time: the file whose panel is open, the row you point at in a list, the explained files, or the tour stop. Sparks travel along each arc: orange from a file to what it imports, blue from the files that use it. A file's panel lists its **Imports**, and **Find the files that use this** reads the whole repo's imports once to list its **Used by** (one GitHub download per source file). Turn arcs off with **Show connections between files**.

### Code viewer

**View code** (in a file's panel, next to any explained file, or Shift-click a building) opens the file's full source in the code viewer, where up to six files sit side by side. **View … side by side** buttons open several at once: an explanation's files and their connections, a file with its imports or the files that use it, or a folder's biggest files. Clicking a key part's line number in an explanation opens that file at that line. The viewer sits beside the explanation panel, or below it on narrower screens, so the two never cover each other.

Site owner setup: create a Gemini API key in Google AI Studio, add it as `GEMINI_API_KEY` to the site's environment variables (marked secret) and redeploy. Until then the Ask box stays hidden. It runs `netlify/functions/ask.mjs` with `gemini-3.5-flash-lite`, Google's fastest model, so answers arrive within Netlify's 10-second function limit.

### Guided tours

Like asking, tours need Sign in with GitHub and count towards the same hourly limit. Press **Tour** next to the Ask box for a functionality tour: what the software does, one feature per stop ("Signing in", "Routing a request"), in the order a user or a request meets them. Type a topic first ("how checkout works") to focus it. Gemini plans four to eight stops, each with the file that does most of the work and up to four files it works with; the camera flies from building to building while the panel narrates each one, and arcs show each stop's imports. Step through with Back / Next, jump to any stop, or press Auto-play.

### Timelapse video

**Record video** in the timeline bar replays the history from the first commit and saves it as a 1280×720 video (MP4 where the browser supports it, otherwise WebM), with the repo name, date and commit message drawn in.

### PR summary bot (GitHub Action)

The bot that comments on pull requests with hotspots, missing tests, who to ask, and a link to the PR in Code City lives in its own repo: **[lakshmisraj/code-city-pr-summary](https://github.com/lakshmisraj/code-city-pr-summary)**. Setup and `.codecity.yml` settings are documented there. In short:

```yaml
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: lakshmisraj/code-city-pr-summary@v1
```

### Sign in with GitHub (site owner setup)

Sign-in runs through two Netlify Functions in `netlify/functions/`. It asks GitHub for no scopes: the token only identifies the visitor, which raises their limit to 5,000 requests an hour. The token reaches the page through the site's own storage, never through a URL. Until it's set up, the button stays hidden and the paste-a-token box still works.

1. On GitHub: Settings → Developer settings → OAuth Apps → New OAuth App.
   - Homepage URL: `https://code-city-view.netlify.app`
   - Authorization callback URL: `https://code-city-view.netlify.app/.netlify/functions/github-callback`
2. In Netlify: Site configuration → Environment variables, add `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (mark the secret as secret), then redeploy.

## Run it locally

Needs Python 3.8+ and git. No other installs.

    python3 codecity.py serve

Opens http://localhost:8787. Paste any public GitHub, GitLab or Bitbucket URL (or `owner/name`, or the path of a project folder inside your home folder) and press Build. Repos are cloned into `~/.cache/code-city`.

The local server only answers its own page: other websites can't make it clone or read anything, and it never runs programs that a folder's own git settings name (hooks, fsmonitor). `python3 codecity.py export` can read any folder.

## Troubleshooting

- **"GitHub allows 60 requests an hour…"**: your network has used its unauthenticated GitHub requests. Sign in with GitHub (or paste a token) for 5,000 an hour, or wait for the reset time shown.
- **No Ask box**: the site owner hasn't set `GEMINI_API_KEY` yet (see Ask the city).
- **"You've asked 20 questions this hour"**: the per-account limit; it resets on the hour.
- **The PR bot didn't comment on a fork's PR**: forks get a read-only token, so the action logs a warning instead. See the [action's README](https://github.com/lakshmisraj/code-city-pr-summary#set-it-up).
- **A history load is taking too long**: press Cancel, then drag the slider's ends closer together.

## Export a repo for the hosted site

To show a repo's full history on the hosted site, export it and drag the JSON onto the page:

    python3 codecity.py export owner/repo              # writes repo.json
    python3 codecity.py export owner/repo --no-source  # smaller, without file previews

The timelapse follows the main line of history (first parents), with each merge shown as one step for the branch it brought in, so files deleted on the main line never reappear. Histories longer than 1,500 commits are merged into 1,500 steps, so the timelapse still starts from the first commit. The hosted site bundles Flask and Express in `site/presets/`; type `pallets/flask` or `expressjs/express` to load them.

## Project layout

| Path | What it is |
|---|---|
| `code-city.html` | The whole app: Three.js scene, treemap layout, timelapse, heat map, hotspots, PR view |
| `codecity.py` | Local server, repo exporter (git log → city JSON) and site builder |
| `site/` | What Netlify serves. Rebuild `site/index.html` with `python3 codecity.py build` after editing `code-city.html`. Pushing to `main` deploys it. |

## License

MIT. See [LICENSE](LICENSE).
