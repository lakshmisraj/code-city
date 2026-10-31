# Code City for a team

A guide for whoever is setting Code City up for a team: which pieces to use, how each one reaches your code, and what leaves your machines.

## Pick the pieces

| You want | Use | Who sets it up |
|---|---|---|
| Newcomers to find their way around a repo | `code-city .` on their machine, or the hosted site for public repos | Each developer, in a minute |
| The city next to the code | The VS Code extension | Each developer |
| Reviewers to see what a pull request touches | The PR summary bot | Once per repo |
| An architecture page in your docs or wiki | **Download as Markdown** in Code structure | Anyone, whenever the code changes a lot |
| A link from your README | The badge below | Once per repo |

## On each developer's machine

    pipx install code-city
    code-city .

The city is read by a server on their own computer, so this works for private code and nothing is uploaded. For Ask, the workflows tour and explanations, each developer uses their own Gemini key (`export GEMINI_API_KEY=...`, Node 18+ needed). The terminal says whether Ask is on.

In VS Code, the Code City extension does the same for the open workspace (**Code City: Open the City**), and the Gemini key goes in VS Code's secret storage (**Code City: Set Gemini API Key**).

## On the hosted site

[code-city-view.netlify.app](https://code-city-view.netlify.app) opens any public GitHub repo. For a private repo, each person pastes a fine-grained token (under **Repo**, then **Add a token**):

1. [Create a fine-grained token](https://github.com/settings/personal-access-tokens/new).
2. **Repository access**: Only select repositories, and pick the ones to view.
3. **Permissions**: Contents: Read-only (Metadata: Read-only is added with it).

The token can't change anything, is only ever sent to api.github.com, and stays in that browser (and only if "Remember on this device" is ticked). A private repo's files cost one GitHub request each, so a large repo uses a good part of the 5,000 an hour.

Ask on the hosted site sends a private repo's file names, a digest of it and the code being explained to Code City's server and to Google's Gemini, and asks first. If that isn't acceptable for your code, use `code-city` with your own key instead, or don't use Ask.

## Pull request summaries

The [Code City PR summary](https://github.com/lakshmisraj/code-city-pr-summary) action comments on each pull request with the hotspots it touches, changed code without tests, who knows those files, and a link to see the change in Code City. Add `.github/workflows/code-city.yml`:

```yaml
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

It runs inside your GitHub Actions, reads only the repo's git history and sends nothing elsewhere. Settings such as `quiet` and `history-days` go in `.codecity.yml`; see the action's README. Pin it to a commit (as this repo does) if your policy asks for that.

## An architecture page

Open the repo in Code City, wait for **Code structure** to finish reading, optionally take the workflows tour, and press **Download as Markdown**. Commit the file (for example as `docs/architecture.md`) or paste it into your wiki. Everything in it is read from the code except the workflows, which are marked as Gemini's reading. Make a new one when the structure changes; it's quick.

## A README badge

For a public repo, a badge that opens it in Code City:

```markdown
[![See it in Code City](https://img.shields.io/badge/see%20it%20in-Code%20City-f2a541)](https://code-city-view.netlify.app/?repo=OWNER/NAME)
```

Replace `OWNER/NAME`. Add `&range=start..now` to load its whole history when it opens; that happens by itself only when it costs 60 GitHub requests or fewer (one per commit), and otherwise the visitor picks a range.

## What leaves your machines

| Piece | Reads | Sends |
|---|---|---|
| `code-city`, the VS Code extension | Your folder, on your machine | Nothing, unless you use Ask: then Gemini gets what you ask about, on your key |
| Hosted site | GitHub's API (with your token for private repos) | Nothing to Code City, unless you use Ask |
| Hosted site's Ask | What the page sends it | File names, a repo digest and the code you ask about, to Code City's server and Gemini |
| PR summary bot | Your repo's history, in your Actions | One comment on the PR |
