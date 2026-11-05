# Code City for VS Code

See the folder you're working in as a 3D city at night: each file is a building (height is lines of code), folders are districts, and TODOs burn on the rooftops. Find where the code starts, which files everything depends on, how its workflows run, and how it grew, then jump straight to the file.

## Use it

1. **Code City: Open the City** (Command Palette). The city opens beside your editor, with **Code structure** first.
2. Click a building, then **Open in editor**. Code windows have an **Editor** button that opens the file at the line you're on.
3. **Code City: Show This File in the City**, from the Command Palette, the editor tab's menu or the Explorer's right-click menu, flies to the current file's building.

Everything Code City reads stays on your machine: it runs a small server on your computer and nothing is uploaded.

## Ask, tours and explanations

Run **Code City: Set Gemini API Key** with your own [Gemini key](https://aistudio.google.com/apikey). It's kept in VS Code's secret storage, and Ask, the workflows tour, Explain and Explain this commit then work from this machine. Gemini sees what you ask about: file names, a digest of the repo, and the code of files you ask it to explain.

## Needs

- Python 3.8 or newer (set `codeCity.pythonPath` if it isn't `python3` on your PATH)
- git, for history

## Building the extension

From this folder: `npm install`, then `npm run package` writes `codecitydev-<version>.vsix` (it first copies Code City's server, page and the bundled ask server into `server/`). Install it with `code --install-extension codecitydev-0.1.0.vsix`.
