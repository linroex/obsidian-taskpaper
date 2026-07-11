# TaskPaper for Editors — monorepo

Plain-text task management in the [TaskPaper](https://www.taskpaper.com) format (projects,
tasks, notes, tags, indentation), delivered for two editors from one shared core.

## Packages

| Package | What it is |
| --- | --- |
| [`packages/core`](packages/core) | `@taskpaper/core` — the portable, editor-agnostic logic: outline model, tag utilities, and the full item-path **query engine** (lexer → parser → evaluator). No platform dependencies; consumed as TypeScript source. |
| [`packages/vscode`](packages/vscode) | VSCode extension — TextMate grammar, folding, decorations (done strikethrough, overdue), completion, outline, commands, and a filtered results view. |
| [`packages/obsidian`](packages/obsidian) | Obsidian plugin — a dedicated CodeMirror 6 editor for `.taskpaper` files with highlighting, folding, commands, and **true inline filtering** (hides non-matching lines). |

Both front-ends reuse the same `@taskpaper/core` model and query engine, so a query like
`project "Work" // @today` or `@due <= today [d]` behaves identically in each.

## Develop

```bash
npm install                 # sets up the workspace (npm workspaces)
npm run test                # core query/model tests (no GUI)
npm run compile             # type-check every package
npm run build               # bundle the vscode + obsidian packages
npm run package:vscode      # produce a .vsix
```

Per-package instructions live in each package's README.

## License

MIT
