# Working on Code City

Code City is one HTML page (`code-city.html`), a small Python tool (`codecity.py`) and a few Netlify Functions. There is no bundler and no framework: you edit the page, rebuild, and reload.

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

Both servers read `code-city.html` on every load, so a reload shows your edits. The dev server also rebuilds `site/index.html` for you.

## The build

Netlify serves `site/`. `site/index.html` is `code-city.html` wrapped in a document skeleton by `python3 codecity.py build` (or `npm run build`). **Commit both files together**: the tests fail when `site/index.html` is out of date.

## The package

`pyproject.toml` builds the `code-city` package: `codecity.py`, the page and the parser, plus `local/ask-server.mjs` bundled with `ask.mjs` and its packages (`hatch_build.py` runs `npm run bundle:ask` when npm is there). To try a build:

    python3 -m pip install build && python3 -m build
    pipx install dist/code_city-*.whl --force

Bump `__version__` in `codecity.py` for a release.

## The VS Code extension

`vscode/` is the extension: `extension.js`, plain JavaScript with no build step. `npm run package` there copies `codecity.py`, the page, the parser and the bundled ask server into `vscode/server/` and writes a `.vsix`. To try your changes, open `vscode/` in VS Code and press F5 (after `npm run prepare-server` once), or install the `.vsix`.

## Tests

    npm test

It runs everything in `tests/`:

- `ask.test.mjs`, `ask-cache.test.mjs`: the Ask function (`netlify/functions/ask.mjs`) with Gemini and Netlify Blobs mocked. No key is needed and nothing is called.
- `page.test.mjs`: `site/index.html` matches the build, the page's script parses, and the page draws the example city in headless Chromium without errors.
- `e2e.test.mjs`: `code-city <folder>` opens that city in headless Chromium and Download as Markdown gives its overview (slow without a GPU: about a minute).
- `vscode.test.mjs`: the VS Code extension against a stand-in for the `vscode` API (it serves the city, opens only files inside the workspace, and stops its server).
- `vscode-page.test.mjs`: the page framed like the extension's webview: a reveal message opens the file's building and Open in editor messages the parent.
- `cli.test.mjs`: the `code-city` command on a small throwaway repo, including Ask with your own key (with a dummy key, so Gemini is never called).

GitHub Actions runs `npm test` on every push and pull request (`.github/workflows/test.yml`).

When you change what Ask sends or returns, add a test next to the others in `ask.test.mjs`: each one sets the mocked Gemini `reply` and checks what the function kept.

## Where things are in the page

`code-city.html` is long, so search by section comment (`// ---------- name ----------`). The main ones:

- **City**: `buildCity`, `layout`, building and district meshes, labels.
- **History**: `loadHistory`, `stateAt`, `viewAt`, the history bar (`scrub`), playback and video.
- **Side panels**: `openSide` / `renderSide`, one `render…` per panel (Commits, System map, Hotspots, Ask, Tour, Trace).
- **Windows**: `panes`, `paneHtml`, `renderViewer`; code, explanation and diff windows.
- **Reading code**: the import parser, the tree-sitter call index (`callIdx`), `importance`.
- **Ask**: `ASK_URL` and the fetches to it; the server side is `netlify/functions/ask.mjs`.

## Style

- Match the code around you: short functions, one-line comments that say *why*, plain words in the UI.
- UI text talks to the reader ("Load history", "This commit isn't in the loaded history"), without jargon.
- No new dependencies in the page. Scripts load only from cdnjs or jsdelivr, pinned with an integrity hash (see the Content-Security-Policy in `netlify.toml`).
- Never send a token or code anywhere except GitHub and Code City's own functions.

## Sending a change

1. Branch from `dev`.
2. Make the change, run `npm run build` if you touched `code-city.html`, and run `npm test`.
3. Open a pull request into `dev`. `main` is what Netlify deploys.
