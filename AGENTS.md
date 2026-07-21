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

## Git workflow

After each feature or bug fix is complete, tested, built, and deployed when
applicable, commit it without waiting for the user to verify it manually. Keep
separate completed features in separate commits.
