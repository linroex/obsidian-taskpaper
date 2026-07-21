# TaskPaper for VSCode

Plain-text task management in the [TaskPaper](https://www.taskpaper.com) format, for
Visual Studio Code. Write projects, tasks, notes and tags in an ordinary `.taskpaper`
file and get syntax highlighting, folding, completion, an outline, and a full item-path
query language for filtering.

This is an independent re-implementation of the TaskPaper *format and behaviors* (inspired
by Jesse Grosjean's macOS app), built natively on VSCode's editor — not a port of the app.

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

- **Syntax highlighting** for projects, tasks, notes, and tags, with special styling for
  `@done`, `@today`, and `@due`.
- **Done styling** — completed items are dimmed and struck through.
- **Overdue highlighting** — a past `@due(date)` on an unfinished task is flagged.
- **Folding** by indentation; fold a project to hide its contents.
- **Outline & breadcrumbs** — projects and tasks appear in the Outline view.
- **Sidebar** — a dedicated TaskPaper view in the Activity Bar with **Searches** (saved
  `@search` queries — click to run), **Projects** (click to jump, with a remaining-count badge),
  and **Tags** (click to filter).
- **Saved searches** — “Save Search…” stores a query as an `@search(...)` item under a
  `Searches:` project.
- **Natural-language dates** — `@at(` / `@due(` completion and query dates accept `today`, `tomorrow`,
  `next friday`, `+1 week`, `3 days`, weekday names.
- **Outline editing** — move an item + subtree with `Alt+↑/↓`, indent/outdent with
  `Alt+Shift+→/←`.
- **Status bar** — today / overdue counts for the active file; click to show `@today`.
- **Tag completion** — type `@` for known and in-document tags; value hints for
  `@at(`, `@due(`, `@start(`, and `@priority(`.
- **Commands** (Command Palette → “TaskPaper: …”):
  | Command | Default key | Description |
  | --- | --- | --- |
  | Toggle Done | `⌘D` / `Ctrl+D` | Add/remove `@done(today)` on selected lines |
  | Toggle Today | `⌘T` / `Ctrl+T` | Add/remove `@today` |
  | Toggle Tag… | — | Toggle an arbitrary tag |
  | New Task | — | Insert a task below, matching indent |
  | Archive Done Items | — | Move `@done` items into an `Archive:` project |
  | Focus Project | `⌘⇧O` | Hoist the current top-level project |
  | Clear Focus | — | Undo focus/filter dimming |
  | Filter… | `⌘⇧F` | Run a query; dim non-matches and open a results view |
  | Go to Project… | — | Quick-pick jump to a project |

## Query language

The **Filter** command accepts TaskPaper-style item-path queries:

- **Tags**: `@today`, `@done`, `@priority`
- **Comparisons**: `@priority = 1`, `@priority > 1 [n]`, `@due <= today [d]`,
  `@text contains milk`, `@name matches "^ab"`
  - Relations: `= != < > <= >= contains beginswith endswith matches`
  - Modifiers: `[s]` case-sensitive, `[n]` numeric, `[d]` date
- **Types**: `project`, `task`, `note`, `item`
- **Booleans**: `and`, `or`, `not` (also `&`, `|`, `!`), with parentheses
- **Text search**: a bare word searches item text — `groceries`
- **Paths & axes**: `/` (child), `//` (descendant), and
  `ancestor:: descendant:: parent:: child:: self::` and `*-or-self`/`*-sibling` variants,
  e.g. `project "Work" // @today`

Examples:

```
@today
not @done and task
@due <= today [d]
project "Home" // @done
priority @priority >= 2 [n]
```

## A note on filtering vs. the native app

VSCode's text editor has no API to *hide arbitrary non-matching lines inline* the way the
native TaskPaper app's live filter does. This extension therefore delivers filtering two
faithful ways in the normal editor:

1. **Focus** folds away everything outside the current project.
2. **Filter** dims non-matching lines in place *and* opens a live, read-only results view
   listing the matches (click a line to jump to its source).

A fully native-style inline live-filter would require a custom webview editor (losing
native text editing); that is a possible future enhancement.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `taskpaper.doneIncludesTime` | `false` | Stamp `@done` with date **and** time |
| `taskpaper.archiveProjectName` | `Archive` | Name of the archive project |
| `taskpaper.strikeDoneItems` | `true` | Strike through / dim done items |
| `taskpaper.dimNonMatchingOnFilter` | `true` | Dim non-matching lines during focus/filter |

## Development

```bash
npm install
npm run build      # bundle with esbuild
npm run compile    # type-check only
```

Press `F5` in VSCode to launch the Extension Development Host with `sample.taskpaper`.

## License

MIT
