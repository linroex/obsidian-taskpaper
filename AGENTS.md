# Repository instructions

## Obsidian deployment

After completing any change that affects the Obsidian plugin (including changes
to shared core code bundled by it), run the relevant tests and production build,
then deploy the built plugin to the user's active vault without waiting for a
separate request.

- Vault: `/Users/linroex/Documents/Karls Notebook`
- Plugin directory: `/Users/linroex/Documents/Karls Notebook/.obsidian/plugins/taskpaper`
- Build command: `npm run build --workspace=packages/obsidian`
- Deploy `packages/obsidian/main.js`, `packages/obsidian/manifest.json`, and
  `packages/obsidian/styles.css` to the plugin directory.
- Preserve the vault plugin directory's `data.json` and any other user data.
- Verify the deployed files match the build artifacts, and report that Obsidian
  needs to reload the plugin/app before testing.
- When running in a remote/web session that cannot reach the local vault path,
  do not attempt to deploy. Instead, build as usual and send the built
  `main.js`, `manifest.json`, and `styles.css` to the user to download (so they
  can drop them into the plugin directory themselves), then note that the plugin
  needs reloading.

## Matching original TaskPaper behavior

When a change concerns how the editor should BEHAVE (outline moves, folding,
filtering/search, indentation, selection, keyboard commands, etc.), cross-check
against the original TaskPaper open-source code rather than guessing — the goal
is parity with the real app. Do not claim parity ("mirrors TaskPaper") without
having actually read the relevant source.

- Repo: `jessegrosjean/TaskPaper` (shared source for license holders; public on
  GitHub). Its model layer is also at `jessegrosjean/birch-outline` /
  `jessegrosjean/BirchOutline`.
- The editor command logic lives in
  `BirchEditor/birch-editor.js/src/outline-editor.coffee` (e.g.
  `_moveBranchesInDirection`, `getPreviousDisplayedItem`/`getNextDisplayedItem`)
  and `outline-editor-commands.coffee`; the authoritative expected behavior is
  encoded in `BirchEditor/birch-editor.js/test/outline-editor-spec.coffee` —
  use the specs to confirm edge cases.
- GitHub code search needs auth via the web UI; use the GitHub MCP
  `search_code` tool (e.g. `repo:jessegrosjean/TaskPaper <symbol>`) and fetch
  raw files from `raw.githubusercontent.com` to read them.

## Git workflow

After each feature or bug fix is complete, tested, built, and deployed when
applicable, commit it without waiting for the user to verify it manually. Keep
separate completed features in separate commits.
