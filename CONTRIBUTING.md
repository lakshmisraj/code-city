# Working on Code City

Code City is one web page (written as `src/page.html`, `src/style.css` and `src/app.js`), a small Python tool (`codecity.py`) and a few Netlify Functions. There is no bundler and no framework: you edit `src/`, rebuild, and reload.

## Set up

Needs Node 22+, Python 3.8+ and git.

    git clone https://github.com/lakshmisraj/code-city.git
    cd code-city
    npm install                         # the functions' packages, and Playwright for the browser test
    npx playwright install chromium     # once: the browser the page test runs in

## Run it

Pick the one that matches what you're changing:

| You're changing | Run | Then open |
|---|---|---|
| The page, with public repos or a local folder | `python3 codecity.py serve` | http://localhost:8787 (opens by itself) |
| The page with sign-in, Ask, tours or explanations | `npm run dev` (needs `.env`, see the README's Dev server section) | the link it prints, with its one-time key |
| The command-line tool | `python3 codecity.py .` (`GEMINI_API_KEY=… ` in front for Ask) | opens by itself |

Both servers read `src/` on every load, so a reload shows your edits. The dev server also rebuilds `site/index.html` for you.

## The build

Netlify serves `site/`. `python3 codecity.py build` (or `npm run build`) puts `src/` together into `code-city.html`, the page as one file (the installed package and the claude.ai artifact use it), and wraps that in a document skeleton as `site/index.html`. **Commit them with your `src/` change**: the tests fail when either is out of date. Never edit `code-city.html` or `site/index.html` by hand.

## The package

`pyproject.toml` builds the `code-city` package: `codecity.py`, the page and the parser, plus `local/ask-server.mjs` bundled with `ask.mjs` and its packages (`hatch_build.py` runs `npm run bundle:ask` when npm is there). To try a build (`pyproject-build` rather than `python3 -m build`: the repo's `build/` folder, where the ask server is bundled, would be taken for the build tool):

    python3 -m pip install build && pyproject-build
    pipx install dist/code_city-*.whl --force

## Releasing

A version tag publishes everything: `.github/workflows/release.yml` builds the package and publishes it to PyPI, and builds the VS Code extension and publishes it to the Marketplace.

1. Set the same version in `codecity.py` (`__version__`) and `vscode/package.json` (`version`), and commit.
2. `git tag v0.2.0 && git push origin v0.2.0`. The workflow stops if the tag and the two versions don't match.

One-time setup, by whoever owns the accounts:

- **PyPI** (no token needed): on pypi.org, under your account's Publishing, add a pending trusted publisher for project `code-city`: owner `lakshmisraj`, repository `code-city`, workflow `release.yml`, environment `pypi`. In the GitHub repo, create an environment named `pypi` (Settings › Environments); requiring a reviewer there makes each release wait for your approval.
- **VS Code Marketplace**: create a publisher at marketplace.visualstudio.com/manage, and put its ID in `vscode/package.json` (`publisher`; `lakshmisraj` is a placeholder). Make an Azure DevOps personal access token with the Marketplace › Manage scope for all accessible organizations, and add it as the repository secret `VSCE_PAT`. Until it's set, the workflow builds the extension and skips publishing.

## The VS Code extension

`vscode/` is the extension: `extension.js`, plain JavaScript with no build step. `npm run package` there copies `codecity.py`, the page, the parser and the bundled ask server into `vscode/server/` and writes a `.vsix`. To try your changes, open `vscode/` in VS Code and press F5 (after `npm run prepare-server` once), or install the `.vsix`.

## Tests

    npm test

It runs everything in `tests/`:

- `ask.test.mjs`, `ask-cache.test.mjs`: the Ask function (`netlify/functions/ask.mjs`) with Gemini and Netlify Blobs mocked. No key is needed and nothing is called.
- `page.test.mjs`: `site/index.html` matches the build, the page's script parses, and the page draws the example city in headless Chromium without errors.
- `e2e.test.mjs`: `code-city <folder>` opens that city in headless Chromium and Download as Markdown gives its overview (slow without a GPU: about a minute).
- `vscode.test.mjs`: the VS Code extension against a stand-in for the `vscode` API (it serves the city, opens only files inside the workspace, and stops its server).
- `browser/private-repo.test.mjs`: a private repo on the hosted page with a pasted token, against a stand-in GitHub: files come through the API, and the token goes only to api.github.com.
- `vscode-page.test.mjs`: the page framed like the extension's webview: a reveal message opens the file's building and Open in editor messages the parent.
- `cli.test.mjs`: the `code-city` command on a small throwaway repo, including Ask with your own key (with a dummy key, so Gemini is never called).
- `browser/features.test.mjs`: the site tour (first visit in the local app; on the hosted site every signed-out visit, and once per GitHub account), the language key and Hotspots, explaining selected lines (and that pointing to a key part leaves the explanation in place), and recording. Ask, GitHub and sign-in are stand-ins answered by the test.

The extension in a real VS Code: `npm run test:vscode` in `vscode/`. It downloads a separate copy of VS Code into `vscode/.vscode-test/` the first time (about 330 MB), opens it for a few seconds on a small repo, runs Open the City, checks the local server answers for the workspace, and closes it. It isn't part of `npm test` or CI (Linux CI would need a virtual display).

GitHub Actions runs `npm test` on every push and pull request (`.github/workflows/test.yml`).

When you change what Ask sends or returns, add a test next to the others in `ask.test.mjs`: each one sets the mocked Gemini `reply` and checks what the function kept.

## Where things are in the page

`src/app.js` is long, so search by section comment (`// ---------- name ----------`). The main ones:

- **City**: `buildCity`, `layout`, building and district meshes, labels.
- **History**: `loadHistory`, `stateAt`, `viewAt`, the history bar (`scrub`), playback and video.
- **Side panels**: `openSide` / `renderSide`, one `render…` per panel (Commits, Code structure, Hotspots, Ask, Tour, Trace).
- **Windows**: `panes`, `paneHtml`, `renderViewer`; code, explanation and diff windows.
- **Reading code**: the import parser, the tree-sitter call index (`callIdx`).
- **Ask**: `ASK_URL` and the fetches to it; the server side is `netlify/functions/ask.mjs`.

## Style

- Match the code around you: short functions, one-line comments that say *why*, plain words in the UI.
- UI text talks to the reader ("Load history", "This commit isn't in the loaded history"), without jargon.
- No new dependencies in the page. Scripts load only from cdnjs or jsdelivr, pinned with an integrity hash (see the Content-Security-Policy in `netlify.toml`).
- Never send a token or code anywhere except GitHub and Code City's own functions.

## Sending a change

1. Branch from `dev`.
2. Make the change, run `npm run build` if you touched `src/`, and run `npm test`.
3. Open a pull request into `dev`. `main` is what Netlify deploys.
