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
- **Highlighting**: bold projects, colored tags, and a red highlight for an overdue
  `@due(date)` on an unfinished task. A task with `@done` dims and strikes through its
  entire subtree, including nested tasks and notes.
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
- **Natural-language dates**: `@at` / `@due` / query dates accept `today`, `tomorrow`, `next friday`,
  `+1 week`, `3 days`, weekday names — resolved to real dates (e.g. `@due <= "next friday" [d]`).
- **Outline editing**: move an item + its subtree with `Alt+↑/↓`, indent/outdent with
  `Alt+Shift+→/←`.
- **Status bar**: shows today / overdue / remaining task counts for the active file.
- **Links**: bare URLs, `[label](url)` markdown links, and `[[wikilinks]]` (with
  `[[Note|alias]]` / `[[Note#heading]]`) render live-preview style — syntax hides until the
  cursor touches it. Unresolved wikilinks are dimmed; clicking them never creates a note.
- **Calendar view** (in-tab toggle): month grid + agenda of scheduled `@at`, deadline `@due`,
  and virtual `@today` items with drag-to-reschedule. `@at(2026-07-15 09:30)` displays and
  sorts by time; a task with different `@at` / `@due` dates appears on both days, while
  same-day roles merge. `@at` must include a date, so a clock-only value such as
  `@at(15:30)` is ignored. Markdown links display their label instead of raw link syntax.
  The 「本檔 | 全部」scope switch aggregates every `.taskpaper` file in the vault (foreign
  items carry a file badge; clicking opens the file at the line).
- **Quick capture** (「快速新增任務」, works anywhere in Obsidian): one-line modal that
  appends a task to your inbox file — `@due(tomorrow)`-style dates resolve as you type,
  the inbox file/project is configurable and auto-created.
- **Tag drag-to-assign**: drag an item's handle onto a sidebar tag value row to set
  `@tag(value)` on it (a tag name row adds the bare tag) — reclassify a reading list by
  dragging books between `@想看` / `@想買` values without touching the text.
- **Recurring tasks**: `@repeat(1w)` and friends — see 重複任務 below.
- **Settings localization**: follows Obsidian's configured interface language;
  Traditional Chinese and English are included, with English as the fallback.

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

## 重複任務 @repeat

在任務上加 `@repeat(<n><單位>)` 即可建立重複任務，單位為 `d`（天）、`w`（週）、
`m`（月）、`y`（年），例如 `@repeat(1w)`、`@repeat(10d)`、`@repeat(3m)`。
格式不合法（`0w`、`-1d`、`1.5w`、`foo`）視為不重複。

- **只在「切換完成」時觸發**：點擊任務的破折號、Toggle Done 指令、右鍵選單都會觸發；
  手動輸入 `@done` 不會產生下一次。
- **嚴格週期**：下一次的日期從既有的 `@at` / `@due` / `@start` / `@defer` 值往後推進，
  與完成當天無關。例如 `- 澆花 @due(2026-07-01) @repeat(1w)` 完成後產生
  `- 澆花 @due(2026-07-08) @repeat(1w)`。
- 月／年推進採日曆計算，月底自動夾住：1/31 +1m → 2/28（閏年 2/29）；2024-02-29 +1y → 2025-02-28。
- 只有 `@today`（無日期標籤）時：下一次改為 `@due(今天 + 週期)` 並移除 `@today`。
- 完全沒有日期依據（無 `@at` / `@due` / `@start` / `@defer` / `@today`）：照常標記完成，
  但不產生下一次，並顯示提示「@repeat 需要 @at、@due 或 @start 日期才能產生下一次」。
- 下一次會插在完成項目**整個子樹之後**、相同縮排（子項目屬於已完成的那一次）。
- 完成與產生下一次在**同一筆編輯**內：一次 Cmd+Z 會同時還原兩者。
  取消完成（再點一次）不會移除已產生的下一次；若再次完成，只要下一行已是相同的
  下一次項目就不會重複產生。

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

| 設定 | 預設值 | 說明 |
| --- | --- | --- |
| @done 加上完成時間 | 關 | 將項目標記為完成時，在日期後加上 `HH:mm` |
| 封存專案名稱 | `Archive` | 「封存已完成項目」收集完成任務的專案 |
| 已完成項目加上刪除線 | 開 | 淡化並加上刪除線，包括完成任務的子項目 |
| 篩選時隱藏不符合的行 | 開 | 完全隱藏不符合的行；關閉後則改為淡化 |
| 行事曆：每週起始日 | 週一 | 一週從週一或週日開始 |
| 行事曆：顯示週數 | 開 | 在月曆格左側顯示 `W627` 格式的 ISO 週數 |
| 行事曆：範圍 | 本檔 | 彙整目前檔案或儲存庫內所有 `.taskpaper` 檔案 |
| 快速新增：收件匣檔案／目標專案 | `Inbox.taskpaper` | 「快速新增任務」寫入的位置 |

## License

MIT
