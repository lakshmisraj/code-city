# tree-sitter (vendored)

Used by Code City's function-level links. Loaded only when a repo's functions are read.

- `tree-sitter.js`, `tree-sitter.wasm`: web-tree-sitter 0.20.8 (npm), MIT (LICENSE-web-tree-sitter).
- `tree-sitter-{python,javascript,typescript,tsx,go}.wasm`: from tree-sitter-wasms 0.1.13 (npm), built with
  tree-sitter-cli 0.20.8, so they match web-tree-sitter 0.20.8. The package is Unlicense
  (LICENSE-tree-sitter-wasms); each grammar is MIT-licensed by its tree-sitter authors.

To update, replace all of them together: the grammars must be built for the same tree-sitter version.
