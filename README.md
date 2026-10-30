# Code City

**Live:** https://code-city-view.netlify.app

Code City helps you understand a codebase quickly: where it starts, which files the rest depends on, how its workflows run and join, and how it grew. It draws the repo as a 3D city at night. Each file is a building (height is lines of code, width is number of functions), folders are raised districts, and TODO / FIXME comments burn on the rooftops.

### Try it

The top bar names the repo on screen, its size, and holds **Ask**. The icons down the left open the tools: **Repo** (open a repo or folder, show a pull request), **Understand** (how it's built, the workflows tour), **Find** (a file), **Display** (colours, connections, Hotspots), the **Guide** (how Code City works: reading the city, the tools, moving around), and your **GitHub account**. Click an icon again to fold the panel away, and drag its edge to resize it. The panels on the right fold (») and resize the same way. On a phone one panel shows at a time.

1. Paste a public GitHub repo (for example `pallets/flask`) and press **Build**.
2. Read **How this repo is built**, which opens on its own: what the project is, where execution starts, and its core files, all read from the code. Point at a file to see what it connects to.
3. Click a building to see its outline, imports and the files that use it; **View code** and **Explain this code** go deeper.
4. Signed in with GitHub, press **Workflows tour** (under Understand) for the main workflows and where they meet, or ask a question in the top bar.
5. Load some history and the history bar opens: press **Play history** on it to watch the city grow, commit by commit.

### Words used on the site

| Word | Meaning |
|---|---|
| Building | One file. Height is lines of code, width is the number of functions. |
| District | A folder, raised one step for each level of nesting. |
| Fire | A TODO, FIXME or HACK comment on that file's roof. |
| Entry point | Where execution starts: a file the project declares (package.json `main`/`bin`, pyproject scripts…), one named like an entry point (`main.py`, `cmd/x/main.go`…), or one no other file imports. |
| Core | The files most of the product imports (tests, docs and examples aren't counted). |
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

### How this repo is built

Opens by itself when a repo loads (and from **How it's built** under Understand). It shows the README's first sentence, the entry points with why each counts, and the core files with how many files use them, and lights them up in the city (entry points brightest). It needs no AI and no sign-in: it's read from the code's import lines, once per city (one GitHub download per source file, up to 2,000). **Show the workflows (tour)** goes on to the AI tour.

### History

The history bar opens when you load history from the history panel (▾ hides it, ^ in the bottom-left corner brings it back). On it, **Play history** plays the city's growth; you can also scrub to any commit, change the speed, or record a video.

### Folders, hotspots, pull requests and links

- **Find a file**: matches light up in mint (not the orange used for imports and answers) and a dropdown lists them, best match first; arrow keys and Enter, or a click, open one.
- **Color by Imports**: colours each file by how many files import it, from dark (none) to bright (the core modules). The first time, it reads every source file's imports (one GitHub download each, once per city).
- **Folders**: click a district (or its name) to open the folder. Everything outside it dims, and the panel shows its size, the folders inside and its biggest files. The path at the top of a file's or folder's panel links to each parent folder.

- **Hotspots** ranks files by *commits × lines* (see the table above): big files that keep changing, where bugs tend to cluster and refactoring pays off first. Click a row to fly to the building.
- **Show a pull request** (under Repo): enter a PR number or paste its URL. Its files light up (blue changed, green new, red deleted), everything else dims, and the panel flags the ones that are hotspots (top tenth for changes).
- **Copy link** copies a link that reopens the same view, for example
  `https://code-city-view.netlify.app/?repo=sindresorhus/ky&range=2026-06-01..now&mode=heat&panel=hotspots&pr=12&file=source/core/Ky.ts`.
  `range` is two dates (`start` and `now` also work); older links with `1w`, `1m`, `3m`, `1y` or `all` still open.
  A link loads its history by itself only when that costs 60 GitHub requests or fewer; otherwise it opens the history panel with that range picked.

### Ask the city

Type a question such as "where is authentication handled?". Before asking, the page reads the repo itself: the README's opening, the project manifests (`package.json`, `pyproject.toml`, `go.mod`…), which files import which, the most-imported files and likely entry points, and the top-level functions and classes of the files that matter most (for repos of up to 600 source files; one GitHub download per file, done once per city). Gemini answers from that and the file list in a few sentences, naming the functions involved, and the files it points to light up. The page then pulls the source of the top three files (from GitHub, or the preview a city file carries) and Gemini explains how that code works: what each file does, its key parts with line numbers, and the other files it connects to. Each connection is marked **imports** when the code's import lines show it, or **inferred** when it's Gemini's reading.

Asking needs **Sign in with GitHub** (a pasted token isn't enough, because it is only ever sent to GitHub), so the site's Gemini budget can't be spent anonymously. Each GitHub account gets 20 questions or tours an hour, plus 20 code explanations and 20 important-line readings, and at most 80 calls a day; the whole site gets 300 a day (set `ASK_PER_HOUR`, `ASK_PER_USER_DAY` and `ASK_PER_DAY` to change them). Calls that fail don't count. The counts are kept in Netlify Blobs. Signing out also revokes the sign-in token with GitHub.

After an answer, **Explain the code of the top files** reads their code. **Explain this code** in a file's panel (or **Explain** on a code window) explains one file, and **Explain this folder** a folder's three biggest files. With explanations already open, a new one is added below them instead of replacing them. Gemini reads at most 24,000 characters of each file and says when it only saw the start.

Explanations form a chain: **Follow** on any connected file explains it next, as a new step below the ones before ("followed from app.py"), and opens both files side by side in the code viewer with the lines that connect them marked: the import line that brings in the other file, and each line that uses what it imports. A strip above each file lists them ("↔ ctx.py: imported on L33; used on L87, L101…"); click one to jump to it. When no import line links the two, lines that mention the other file are marked instead. This way you can trace a request from file to file. The trail at the top jumps between steps, thicker arcs mark the path the chain took, and a chain holds up to 8 steps.

### Connections between files

Arcs over the city show which files import which, read from the code's import lines (JavaScript and TypeScript, Python, Go, Ruby, Java and Kotlin, C and C++, CSS, Rust and PHP), never guessed. They show one file at a time: the file whose panel is open, the row you point at in a list, the explained files, or the tour stop. Sparks travel along each arc: orange from a file to what it imports, blue from the files that use it. A file's panel lists its **Imports**, and **Find the files that use this** reads the whole repo's imports once to list its **Used by** (one GitHub download per source file). Turn arcs off with **Show connections between files**.

### Windows

**View code** (in a file's panel, next to any explained file, an outline entry, or Shift-click a building) opens the file's full source in its own window. **Explain this code** opens just the explanation, with **View code** to add the code to the same window: code on the left, explanation on the right, at equal widths (stacked on narrow screens). If the code is already open, the explanation joins its window. **Follow** opens the followed file next to the one it came from, with the lines that connect the two marked. Explanations of several files at once get a window of their own.

Drag a window by its title bar and resize it from its corner. **–** puts it away in its tab and **✕** closes it. A strip of tabs, one per window, brings any window back; files that share a name show enough of their folders to tell apart, and **▾** folds the strip. New windows never move or close the ones already open, and the side panels stay open beside them. The guide at the bottom can be closed, and steps aside while windows are open. Files and web addresses named in any description are links.

If you leave the page (signing in with GitHub, the back button, a reload), its windows, explanations and Ask answer come back when the same repo loads again within half an hour.

### Guided tours

Like asking, tours need Sign in with GitHub and count towards the same hourly limit. Press **Workflows tour** under Understand (or type a topic in Ask first, such as "how checkout works"). Using the same reading of the repo, Gemini splits the software into its main workflows ("Starting the app", "Handling a request"), each an ordered walk through files that follows real imports where it can.

- **Overview: how the workflows merge.** The map draws every workflow at once, one colour each, and lights brightest the files workflows share. The panel explains how they fit together, lists each workflow with the ones it leads to, and lists the files where workflows meet.
- **One workflow.** Open a workflow to step through it. Each step has its clickable file name (opens the file's panel; **View** opens its code), what happens there, its **important lines** (Gemini reads the code of the workflow's first four files when you open it), and the **hand-off** line where it imports the next step's file, found from the code. A hand-off with no import line behind it is marked *inferred*. Click any line number to see it in the code viewer.
- **Open this workflow's files** opens one code window per step, tiled; as you step through, the current step's window comes to the front at its important line.
- **Back / Next** step through, **Auto-play** runs through every workflow, and **All workflows** returns to the overview.

### Timelapse video

**Record video** in the timeline bar replays the history from the first commit and saves it as a 1280×720 video (MP4 where the browser supports it, otherwise WebM), with the repo name, date and commit message drawn in.

### PR summary bot (GitHub Action)

The bot that comments on pull requests with hotspots, missing tests, who to ask, and a link to the PR in Code City lives in its own repo: **[lakshmisraj/code-city-pr-summary](https://github.com/lakshmisraj/code-city-pr-summary)**. Setup and `.codecity.yml` settings are documented there. In short:

```yaml
# .github/workflows/code-city.yml
name: Code City PR summary
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  summary:
    runs-on: ubuntu-latest
    steps:
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

## Dev server

For working on the site itself: the dev copy of the page, signed in with GitHub on every load, and the dev copy of the Ask function (so Ask, tours and explanations run your changes before they're deployed).

1. Copy `.env.example` to `.env` (git ignores it) and fill in:
   - `GITHUB_TOKEN`: a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with no extra permissions. It only tells Code City who you are.
   - `GEMINI_API_KEY`: your Gemini key, for Ask. Leave it empty to run without Ask.
2. Make it private: `chmod 600 .env` (the server refuses to start otherwise).
3. Run `node dev-server.mjs` and open the link it prints (http://codecity.localhost:8813/?key=…). The key is new on every run and keeps other programs on your machine from reading the signed-in page.

It rebuilds the page whenever `code-city.html` changes, so a reload shows edits. It only listens on this machine, only answers `codecity.localhost`, and only gives the signed-in page and Ask to the browser that opened its link, so nothing else on the network or the machine, and no other website, can read the token or spend questions through it. Question limits and timing notes need Netlify Blobs, so they're off here. Needs Node 18+ and Python 3.

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
| `code-city.html` | The whole app: Three.js scene, treemap layout, timelapse, heat map, hotspots, PR view, import parser, "How this repo is built", windows |
| `codecity.py` | Local server, repo exporter (git log → city JSON) and site builder |
| `dev-server.mjs` | Dev server: the dev page signed in from `.env`, with `netlify/functions/ask.mjs` run locally |
| `netlify/functions/` | Server code on Netlify: `ask.mjs` (Ask, tours, explanations, important lines via Gemini), `github-login.js` / `github-callback.js` (Sign in with GitHub) and `github-signout.js` (revokes the token on sign-out) |
| `site/` | What Netlify serves. Rebuild `site/index.html` with `python3 codecity.py build` after editing `code-city.html`. Pushing to `main` deploys it. |

## License

MIT. See [LICENSE](LICENSE).
