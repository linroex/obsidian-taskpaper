# TaskPaper for Obsidian

Edit [TaskPaper](https://www.taskpaper.com)-format files (`.taskpaper`) inside Obsidian, in a
dedicated CodeMirror 6 editor with syntax highlighting, folding, a full item-path query
language, and **true inline filtering** that hides non-matching lines.

Shares its outline model and query engine with the sibling
[VSCode extension](../vscode) via the `@taskpaper/core` package.

## The format

```taskpaper
Project:
	- A task @tag @tag(value)
	- A done task @done(2026-07-08)
		- A nested subtask
	A note is any line that is not a project or task.
```

- **Project** — a line ending with `:`
- **Task** — a line starting with `- `
- **Note** — anything else
- **Tag** — `@name` or `@name(value)`
- **Hierarchy** — indent with **Tab** to nest

## Features

- A dedicated editor view for `.taskpaper` files (not markdown — no collisions with `-` lists
  or `#` headings).
- **Highlighting**: bold projects, dimmed strikethrough `@done` items, colored tags, and a
  red highlight for an overdue `@due(date)` on an unfinished task.
- **Folding** any project or task's subtree.
- **True inline filter**: run a query and the non-matching lines are genuinely hidden (matches
  and their ancestor projects stay visible). Toggle to "dim instead of hide" in settings.
- **Commands** (Command Palette; bind your own hotkeys in Settings → Hotkeys):
  Toggle Done, Toggle Today, Toggle Tag…, New Task, Archive Done Items, Focus Project,
  Clear Focus/Filter, Filter…, Clear Filter, Go to Project…, Fold All, Unfold All.
- Header buttons for Filter, Clear, and Archive.
- **Sidebar** (ribbon icon / "Open sidebar"): **Searches** (saved `@search` queries — click to
  run), **Projects** (click to focus, with a remaining-count badge), and **Tags** (click to filter).
- **Saved searches**: "Save search…" stores a query as an `@search(...)` item under a `Searches:`
  project; it then appears in the sidebar.
- **Natural-language dates**: `@due` / query dates accept `today`, `tomorrow`, `next friday`,
  `+1 week`, `3 days`, weekday names — resolved to real dates (e.g. `@due <= "next friday" [d]`).
- **Outline editing**: move an item + its subtree with `Alt+↑/↓`, indent/outdent with
  `Alt+Shift+→/←`.
- **Status bar**: shows today / overdue / remaining task counts for the active file.

## Query language

The **Filter…** command accepts TaskPaper item-path queries:

- **Tags**: `@today`, `@done`, `@priority`
- **Comparisons**: `@priority = 1`, `@priority > 1 [n]`, `@due <= today [d]`,
  `@text contains milk`, `@name matches "^ab"`
  (relations `= != < > <= >= contains beginswith endswith matches`; modifiers `[s]` case,
  `[n]` numeric, `[d]` date)
- **Types**: `project`, `task`, `note`, `item`
- **Booleans**: `and`, `or`, `not` (also `&`, `|`, `!`) with parentheses
- **Text search**: a bare word searches item text
- **Paths & axes**: `/` (child), `//` (descendant), and `ancestor:: descendant:: parent::
  child:: self::` (plus `*-or-self` / `*-sibling`), e.g. `project "Work" // @today`

## Install (development)

From the monorepo root:

```bash
npm install
npm run build --workspace=packages/obsidian   # produces packages/obsidian/main.js
```

Then copy `main.js`, `manifest.json`, and `styles.css` into a vault:

```bash
VAULT=/path/to/your/vault
mkdir -p "$VAULT/.obsidian/plugins/taskpaper"
cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/taskpaper/"
```

Enable **TaskPaper** under Settings → Community plugins, then open any `.taskpaper` file
(there's a `sample.taskpaper` here to try). Use `npm run dev` for a watch build.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Stamp @done with time | off | Include `HH:mm` with the date when marking done |
| Archive project name | `Archive` | Project that Archive Done Items collects into |
| Strike through done items | on | Dim + strike completed items |
| Filter hides non-matching lines | on | Hide (vs. dim) non-matches when filtering |

## License

MIT
