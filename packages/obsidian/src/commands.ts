import { normalizePath, Notice, TFile, TFolder } from 'obsidian';
import { ChangeSpec, EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { foldAll, foldEffect, foldedRanges, unfoldAll, unfoldEffect } from '@codemirror/language';
import {
  addTag,
  deleteBranch,
  duplicateBranch,
  focusOutTarget,
  focusVisibleLines,
  formatTag,
  groupItems,
  hasTag,
  indentItem,
  indentItemOnly,
  Item,
  ItemKind,
  itemAtLine,
  moveBranchesToProject,
  moveItemDown,
  moveItemOnlyDown,
  moveItemOnlyUp,
  moveItemUp,
  outdentItem,
  outdentItemOnly,
  planArchiveDone,
  planCapture,
  removeAllTags,
  removeTag,
  savedSearches,
  selectedRootLines,
  setLineKind,
  setTagValue,
  todayStamp,
} from '@taskpaper/core';
import { outlineOf, OUTLINE_TAB_SIZE } from './editor/outline';
import { setFilterEffect } from './editor/filter';
import {
  foldedRangeAtLine,
  linesToCollapseCompletely,
  linesToCollapseDeepestLevel,
  linesToExpandShallowestLevel,
  subtreeFoldRange,
} from './editor/folding';
import { applyOutlineOp, dispatchOutlineEdit, docLines } from './editor/outlineEdit';
import { copyDisplayed } from './editor/copyDisplayed';
import { contractSelection, expandSelection, selectBranch } from './editor/selection';
import { toggleDoneSelection } from './editor/toggleDone';
import { collectTagNames } from './editor/tagComplete';
import {
  DateModal,
  PaletteSuggestModal,
  ProjectSuggestModal,
  QueryModal,
  SaveSearchModal,
  SearchEntry,
  SearchSuggestModal,
  StagedTag,
  TagMultiSelectModal,
  TextPromptModal,
} from './modals';
import {
  applyPaletteEntry,
  goToAnythingEntries,
  goToTagEntries,
  PaletteHost,
} from './paletteEntries';
import { CaptureModal } from './captureModal';
import type TaskPaperPlugin from './main';
import { TaskPaperView, VIEW_TYPE_TASKPAPER } from './view';

const NOTICE_NO_PROJECTS = 'No projects in this document.';

export class TaskPaperCommands {
  constructor(private plugin: TaskPaperPlugin) {}

  private get settings() {
    return this.plugin.settings;
  }

  toggleDone(view: TaskPaperView): void {
    const stamp = todayStamp(this.settings.doneIncludesTime);
    toggleDoneSelection(view.editor, stamp, (message) => new Notice(message));
  }

  toggleToday(view: TaskPaperView): void {
    this.applyToSelectedLines(view.editor, (text) =>
      hasTag(text, 'today') ? removeTag(text, 'today') : addTag(text, 'today'),
    );
  }

  /** Tag with… — multi-select over the known tags (document tags + defaults);
   *  every staged toggle is applied to the selected lines at once. Plain
   *  single-tag typing still works: type `@name(value)` and press Enter. */
  toggleTag(view: TaskPaperView): void {
    const names = collectTagNames(outlineOf(view.editor.state));
    // Snapshot the document — if it changes while the modal is open (sync,
    // another pane), applying line-based toggles would tag unrelated lines.
    const docAtOpen = view.editor.state.doc;
    new TagMultiSelectModal(this.plugin.app, names, (tags) => {
      if (view.editor.state.doc !== docAtOpen) {
        new Notice('文件已變更，標籤未套用——請重新執行。');
        return;
      }
      applyTagToggles(view.editor, tags);
      view.editor.focus();
    }).open();
  }

  newTask(view: TaskPaperView): void {
    const state = view.editor.state;
    const line = state.doc.lineAt(state.selection.main.head);
    const indent = /^[\t ]*/.exec(line.text)?.[0] ?? '';
    const insert = `\n${indent}- `;
    view.editor.dispatch({
      changes: { from: line.to, insert },
      selection: EditorSelection.cursor(line.to + insert.length),
      scrollIntoView: true,
    });
    view.editor.focus();
  }

  /** Insert a new project line after the current one, at the same indent, cursor before the ':'. */
  newProject(view: TaskPaperView): void {
    const state = view.editor.state;
    const line = state.doc.lineAt(state.selection.main.head);
    const indent = /^[\t ]*/.exec(line.text)?.[0] ?? '';
    const insert = `\n${indent}:`;
    view.editor.dispatch({
      changes: { from: line.to, insert },
      selection: EditorSelection.cursor(line.to + insert.length - 1),
      scrollIntoView: true,
    });
    view.editor.focus();
  }

  /** Insert a new note line after the current one, indented one level as its child. */
  newNote(view: TaskPaperView): void {
    const state = view.editor.state;
    const line = state.doc.lineAt(state.selection.main.head);
    const indent = /^[\t ]*/.exec(line.text)?.[0] ?? '';
    const insert = `\n${indent}\t`;
    view.editor.dispatch({
      changes: { from: line.to, insert },
      selection: EditorSelection.cursor(line.to + insert.length),
      scrollIntoView: true,
    });
    view.editor.focus();
  }

  /** Convert each selected line to the given kind, preserving indentation and tags. */
  formatAs(view: TaskPaperView, kind: ItemKind): void {
    this.applyToSelectedLines(view.editor, (text) => setLineKind(text, kind));
  }

  /** Wrap the selected items in a new project named via a prompt. */
  group(view: TaskPaperView): void {
    new TextPromptModal(this.plugin.app, 'Group', '專案名稱', (name) => {
      const state = view.editor.state;
      const [start, end] = selectedLineRange(state);
      const result = groupItems(docLines(state), start, end, name, OUTLINE_TAB_SIZE);
      if (result) {
        dispatchOutlineEdit(view.editor, result);
        view.editor.focus();
      }
    }).open();
  }

  /** Duplicate every selected item's branch immediately after it (processed
   *  bottom-up so earlier lines stay stable). */
  duplicate(view: TaskPaperView): void {
    const state = view.editor.state;
    const roots = selectedRootLines(outlineOf(state), selectedLineRanges(state), false);
    if (roots.length === 0) {
      applyOutlineOp(view.editor, duplicateBranch);
      return;
    }
    let lines = docLines(state);
    let cursorLine = 0;
    for (const line of [...roots].reverse()) {
      const step = duplicateBranch(lines, line, OUTLINE_TAB_SIZE);
      if (step) {
        lines = step.lines;
        cursorLine = step.cursorLine;
      }
    }
    dispatchOutlineEdit(view.editor, { lines, cursorLine });
  }

  /** Delete the selected item(s) including their subtrees — every selection
   *  range separately (multi-cursor selections don't delete the gap between). */
  deleteItems(view: TaskPaperView): void {
    const state = view.editor.state;
    let lines = docLines(state);
    let result = null;
    for (const [start, end] of selectedLineRanges(state).reverse()) {
      const step = deleteBranch(lines, start, end, OUTLINE_TAB_SIZE);
      if (step) {
        lines = step.lines;
        result = step;
      }
    }
    if (result) {
      dispatchOutlineEdit(view.editor, { lines, cursorLine: result.cursorLine });
    }
  }

  /** Move every selected branch to the end of a picked project, as its
   *  direct children (multi-cursor selections move each branch). */
  moveToProject(view: TaskPaperView): void {
    const state = view.editor.state;
    const outline = outlineOf(state);
    const itemLines = selectedRootLines(outline, selectedLineRanges(state));
    if (itemLines.length === 0) {
      return;
    }
    const inSelection = (p: Item): boolean =>
      itemLines.some((ln) => {
        const it = outline.items.find((i) => i.line === ln);
        return it !== undefined && p.line >= it.line && p.line <= it.subtreeEnd;
      });
    const projects = outline.items.filter((p) => p.kind === 'project' && !inSelection(p));
    if (projects.length === 0) {
      new Notice(NOTICE_NO_PROJECTS);
      return;
    }
    const docAtOpen = state.doc;
    new ProjectSuggestModal(
      this.plugin.app,
      projects,
      (target: Item) => {
        if (view.editor.state.doc !== docAtOpen) {
          new Notice('文件已變更，未移動——請重新執行。');
          return;
        }
        const result = moveBranchesToProject(
          docLines(view.editor.state),
          itemLines,
          target.line,
          4,
        );
        if (result) {
          dispatchOutlineEdit(view.editor, result);
          view.editor.focus();
        }
      },
      'Move to project',
    ).open();
  }

  /** Prompt for a natural-language date and set @due(date)/@start(date) on selected lines. */
  tagWithDate(view: TaskPaperView, name: 'due' | 'start'): void {
    const title = name === 'due' ? 'Tag with due' : 'Tag with start';
    new DateModal(this.plugin.app, title, (iso) => {
      this.applyToSelectedLines(view.editor, (text) => setTagValue(text, name, iso));
    }).open();
  }

  /** Prompt for a natural-language date and insert the resolved ISO date at the cursor. */
  insertDate(view: TaskPaperView): void {
    new DateModal(this.plugin.app, 'Insert date', (iso) => {
      const range = view.editor.state.selection.main;
      view.editor.dispatch({
        changes: { from: range.from, to: range.to, insert: iso },
        selection: EditorSelection.cursor(range.from + iso.length),
        scrollIntoView: true,
      });
      view.editor.focus();
    }).open();
  }

  /** Strip every @tag from the selected lines. */
  removeTags(view: TaskPaperView): void {
    this.applyToSelectedLines(view.editor, (text) => removeAllTags(text));
  }

  /** Copy the currently visible lines (after any filter/focus) as TaskPaper
   *  text (original Edit > Copy Displayed). */
  copyDisplayed(view: TaskPaperView): void {
    void copyDisplayed(view.editor).then((ok) => {
      new Notice(ok ? '已複製顯示中的項目。' : '無法複製到剪貼簿。');
    });
  }

  /** Expand the selection to the current item's whole branch. */
  selectBranch(view: TaskPaperView): void {
    selectBranch(view.editor);
  }

  /** Stepwise selection growth: word → line → branch → parent's branch → document. */
  expandSelection(view: TaskPaperView): void {
    expandSelection(view.editor);
  }

  /** Undo the last Expand Selection step. */
  contractSelection(view: TaskPaperView): void {
    contractSelection(view.editor);
  }

  /** Step the sidebar focus up one level (ancestor project), or clear it at top level. */
  focusOut(view: TaskPaperView): void {
    if (view.focusedLine === null) {
      return;
    }
    const outline = outlineOf(view.editor.state);
    const parentLine = focusOutTarget(outline, view.focusedLine);
    if (parentLine === null) {
      this.clearFocus(view);
      return;
    }
    view.focusedLine = parentLine;
    view.editor.dispatch({
      effects: setFilterEffect.of({
        mode: 'focus',
        visible: focusVisibleLines(outline, parentLine),
        hide: this.settings.filterHidesInsteadOfDims,
      }),
      selection: EditorSelection.cursor(view.editor.state.doc.line(parentLine + 1).from),
      scrollIntoView: true,
    });
    this.plugin.refreshSidebar();
  }

  /** Focus the nearest enclosing project of the cursor — same hide-filter
   *  semantics as clicking the project in the sidebar (original: Focus In). */
  focus(view: TaskPaperView): void {
    const state = view.editor.state;
    const outline = outlineOf(state);
    const curLine = state.doc.lineAt(state.selection.main.head).number - 1;
    let current = itemAtLine(outline, curLine);
    while (current && current.kind !== 'project') {
      current = current.parent ?? undefined;
    }
    if (!current) {
      return;
    }
    view.focusedLine = current.line;
    view.editor.dispatch({
      effects: setFilterEffect.of({
        mode: 'focus',
        visible: focusVisibleLines(outline, current.line),
        hide: this.settings.filterHidesInsteadOfDims,
      }),
    });
    this.plugin.refreshSidebar();
  }

  clearFocus(view: TaskPaperView): void {
    view.focusedLine = null;
    unfoldAll(view.editor);
    view.editor.dispatch({ effects: setFilterEffect.of(null) });
    this.plugin.refreshSidebar();
  }

  filter(view: TaskPaperView): void {
    const modal = new QueryModal(this.plugin.app, '@today', (query) => {
      view.focusedLine = null;
      view.editor.dispatch({
        effects: setFilterEffect.of(
          query ? { mode: 'query', query, hide: this.settings.filterHidesInsteadOfDims } : null,
        ),
      });
      this.plugin.refreshSidebar();
    });
    modal.open();
  }

  clearFilter(view: TaskPaperView): void {
    view.focusedLine = null;
    view.editor.dispatch({ effects: setFilterEffect.of(null) });
    this.plugin.refreshSidebar();
  }

  goToProject(view: TaskPaperView): void {
    const state = view.editor.state;
    const outline = outlineOf(state);
    const projects = outline.items.filter((i) => i.kind === 'project');
    if (projects.length === 0) {
      new Notice(NOTICE_NO_PROJECTS);
      return;
    }
    new ProjectSuggestModal(this.plugin.app, projects, (item: Item) => {
      const pos = state.doc.line(item.line + 1).from;
      view.editor.dispatch({
        selection: EditorSelection.cursor(pos),
        scrollIntoView: true,
      });
      view.editor.focus();
    }).open();
  }

  /** One fuzzy palette over everything: projects, saved searches, tags and
   *  their values (original Palette > Go to Anything, Cmd-P). */
  goToAnything(view: TaskPaperView): void {
    const entries = goToAnythingEntries(
      outlineOf(view.editor.state),
      this.settings.globalSearches,
    );
    if (entries.length === 0) {
      new Notice('Nothing to go to.');
      return;
    }
    new PaletteSuggestModal(
      this.plugin.app,
      entries,
      (entry) => applyPaletteEntry(view.editor, this.paletteHost(view), entry),
      'Go to anything',
    ).open();
  }

  /** Fuzzy palette of tags + values only (original Palette > Go to Tag). */
  goToTag(view: TaskPaperView): void {
    const entries = goToTagEntries(outlineOf(view.editor.state));
    if (entries.length === 0) {
      new Notice('No tags in this document.');
      return;
    }
    new PaletteSuggestModal(
      this.plugin.app,
      entries,
      (entry) => applyPaletteEntry(view.editor, this.paletteHost(view), entry),
      'Go to tag',
    ).open();
  }

  /** The host applyPaletteEntry acts through — the view + plugin callbacks. */
  private paletteHost(view: TaskPaperView): PaletteHost {
    return {
      hide: () => this.settings.filterHidesInsteadOfDims,
      setFocusedLine: (line) => {
        view.focusedLine = line;
      },
      refresh: () => this.plugin.refreshSidebar(),
    };
  }

  moveUp(view: TaskPaperView): void {
    applyOutlineOp(view.editor, moveItemUp);
  }
  moveDown(view: TaskPaperView): void {
    applyOutlineOp(view.editor, moveItemDown);
  }
  indent(view: TaskPaperView): void {
    applyOutlineOp(view.editor, indentItem);
  }
  outdent(view: TaskPaperView): void {
    applyOutlineOp(view.editor, outdentItem);
  }

  // Single-item moves (original 'Move' vs 'Move Branch'): only the item's
  // line relocates — its former subtree stays where it is.
  moveOnlyUp(view: TaskPaperView): void {
    applyOutlineOp(view.editor, moveItemOnlyUp);
  }
  moveOnlyDown(view: TaskPaperView): void {
    applyOutlineOp(view.editor, moveItemOnlyDown);
  }
  indentOnly(view: TaskPaperView): void {
    applyOutlineOp(view.editor, indentItemOnly);
  }
  outdentOnly(view: TaskPaperView): void {
    applyOutlineOp(view.editor, outdentItemOnly);
  }

  saveSearch(view: TaskPaperView): void {
    new SaveSearchModal(this.plugin.app, (name, query) => {
      const state = view.editor.state;
      const outline = outlineOf(state);
      const br = state.lineBreak;
      const entry = `\t- ${name} ${formatTag('search', query)}`;
      const searches = outline.roots.find(
        (r) => r.kind === 'project' && r.displayText.trim() === 'Searches',
      );
      if (searches) {
        const pos =
          searches.subtreeEnd + 1 < state.doc.lines
            ? state.doc.line(searches.subtreeEnd + 2).from
            : state.doc.line(searches.subtreeEnd + 1).to;
        const insert =
          searches.subtreeEnd + 1 < state.doc.lines ? `${entry}${br}` : `${br}${entry}`;
        view.editor.dispatch({ changes: { from: pos, insert } });
      } else {
        const last = state.doc.line(state.doc.lines);
        const lead = last.text.trim().length > 0 ? br : '';
        view.editor.dispatch({
          changes: { from: last.to, insert: `${lead}${br}Searches:${br}${entry}` },
        });
      }
    }).open();
  }

  foldAll(view: TaskPaperView): void {
    foldAll(view.editor);
  }

  unfoldAll(view: TaskPaperView): void {
    unfoldAll(view.editor);
  }

  /** Fold the selected item's subtree (original Outline > Collapse items). */
  collapseItems(view: TaskPaperView): void {
    const item = this.selectedItem(view);
    if (!item || foldedRangeAtLine(view.editor.state, item.line)) {
      return;
    }
    const range = subtreeFoldRange(view.editor.state, item.line);
    if (range) {
      view.editor.dispatch({ effects: foldEffect.of(range) });
    }
  }

  /** Unfold the selected item's subtree (original Outline > Expand items). */
  expandItems(view: TaskPaperView): void {
    const item = this.selectedItem(view);
    const existing = item && foldedRangeAtLine(view.editor.state, item.line);
    if (existing) {
      view.editor.dispatch({ effects: unfoldEffect.of(existing) });
    }
  }

  /** Unfold the selected item and every descendant (original Expand items completely). */
  expandItemsCompletely(view: TaskPaperView): void {
    const item = this.selectedItem(view);
    if (!item) {
      return;
    }
    const state = view.editor.state;
    const start = state.doc.line(item.line + 1).from;
    const end = state.doc.line(item.subtreeEnd + 1).to;
    const effects: StateEffect<unknown>[] = [];
    foldedRanges(state).between(start, end, (from, to) => {
      effects.push(unfoldEffect.of({ from, to }));
    });
    if (effects.length > 0) {
      view.editor.dispatch({ effects });
    }
  }

  /** Fold the selected item AND every foldable descendant, so expanding one
   *  level later still shows collapsed children (original Collapse items
   *  completely — the complement of expandItemsCompletely). */
  collapseItemsCompletely(view: TaskPaperView): void {
    const item = this.selectedItem(view);
    if (!item) {
      return;
    }
    const state = view.editor.state;
    const effects: StateEffect<unknown>[] = [];
    for (const line of linesToCollapseCompletely(outlineOf(state).items, item.line)) {
      if (foldedRangeAtLine(state, line)) {
        continue;
      }
      const range = subtreeFoldRange(state, line);
      if (range) {
        effects.push(foldEffect.of(range));
      }
    }
    if (effects.length > 0) {
      view.editor.dispatch({ effects });
    }
  }

  /** Fold every item at the deepest expanded level (original Shift-Cmd-9). */
  collapseAllByLevel(view: TaskPaperView): void {
    const state = view.editor.state;
    const outline = outlineOf(state);
    const lines = linesToCollapseDeepestLevel(outline.items, this.foldedItemLines(state));
    const effects = [];
    for (const line of lines) {
      const range = subtreeFoldRange(state, line);
      if (range) {
        effects.push(foldEffect.of(range));
      }
    }
    if (effects.length > 0) {
      view.editor.dispatch({ effects });
    }
  }

  /** Unfold every item at the shallowest folded level (original Shift-Cmd-0). */
  expandAllByLevel(view: TaskPaperView): void {
    const state = view.editor.state;
    const outline = outlineOf(state);
    const lines = linesToExpandShallowestLevel(outline.items, this.foldedItemLines(state));
    const effects = [];
    for (const line of lines) {
      const existing = foldedRangeAtLine(state, line);
      if (existing) {
        effects.push(unfoldEffect.of(existing));
      }
    }
    if (effects.length > 0) {
      view.editor.dispatch({ effects });
    }
  }

  /** The item under the primary cursor, if any. */
  private selectedItem(view: TaskPaperView): Item | undefined {
    const state = view.editor.state;
    const curLine = state.doc.lineAt(state.selection.main.head).number - 1;
    return itemAtLine(outlineOf(state), curLine);
  }

  /** Lines (0-based) whose subtree fold is currently collapsed. */
  private foldedItemLines(state: EditorState): Set<number> {
    const folded = new Set<number>();
    foldedRanges(state).between(0, state.doc.length, (from) => {
      folded.add(state.doc.lineAt(from).number - 1);
    });
    return folded;
  }

  archiveDone(view: TaskPaperView): void {
    const state = view.editor.state;
    const nl = state.lineBreak;
    const plan = planArchiveDone(docLines(state), 4, {
      archiveName: this.settings.archiveProjectName,
      addProjectTag: this.settings.addProjectTagWhenArchiving,
      removeExtraTags: this.settings.removeExtraTagsWhenArchiving,
    });
    if (!plan) {
      new Notice('No @done items to archive.');
      return;
    }

    // The whole document is being archived — replace it outright.
    const [first] = plan.removals;
    if (plan.removals.length === 1 && first[0] === 0 && first[1] === state.doc.lines) {
      view.editor.dispatch({
        changes: { from: 0, to: state.doc.length, insert: plan.insertLines.join(nl) },
      });
      return;
    }

    const changes: ChangeSpec[] = plan.removals.map(([start, end]) => ({
      // A removal reaching the document end also eats the preceding newline,
      // so no trailing blank line is left behind.
      from: end < state.doc.lines ? state.doc.line(start + 1).from : state.doc.line(start).to,
      to: end < state.doc.lines ? state.doc.line(end + 1).from : state.doc.line(end).to,
      insert: '',
    }));
    if (plan.insertAt < state.doc.lines) {
      changes.push({
        from: state.doc.line(plan.insertAt + 1).from,
        insert: plan.insertLines.join(nl) + nl,
      });
    } else {
      changes.push({
        from: state.doc.line(state.doc.lines).to,
        insert: nl + plan.insertLines.join(nl),
      });
    }
    view.editor.dispatch({ changes });
  }

  /** Captures run one at a time — parallel first-captures would race the
   *  check-then-create in ensureInboxFile and could drop a task. */
  private captureQueue: Promise<void> = Promise.resolve();

  /** 快速新增任務 — prompt for one line and append it to the inbox file. */
  quickCapture(): void {
    const file = normalizePath(this.settings.inboxFile.trim() || 'Inbox.taskpaper');
    const project = this.settings.inboxProject.trim();
    new CaptureModal(this.plugin.app, file, project, (taskLine) => {
      void this.captureToInbox(file, project, taskLine);
    }).open();
  }

  captureToInbox(path: string, project: string, taskLine: string): Promise<void> {
    this.captureQueue = this.captureQueue.then(
      () => this.doCapture(path, project, taskLine),
      () => this.doCapture(path, project, taskLine),
    );
    this.captureQueue = this.captureQueue.catch((err) => {
      new Notice(`無法加入 ${path}：${err instanceof Error ? err.message : String(err)}`);
    });
    return this.captureQueue;
  }

  /** A TaskPaper view with the inbox open may hold unsaved edits — captures
   *  must dispatch into that editor instead of racing vault.process. */
  private openInboxEditor(path: string): EditorView | null {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TASKPAPER)) {
      const view = leaf.view;
      if (view instanceof TaskPaperView && view.file?.path === path && view.editor) {
        return view.editor;
      }
    }
    return null;
  }

  private async doCapture(path: string, project: string, taskLine: string): Promise<void> {
    let editor = this.openInboxEditor(path);
    if (!editor) {
      const file = await this.ensureInboxFile(path);
      if (!file) {
        return;
      }
      // A view may have opened the inbox while we were creating it — re-check
      // so we never process the vault copy behind a live editor's back.
      editor = this.openInboxEditor(path);
      if (!editor) {
        await this.plugin.app.vault.process(file, (data) => {
          // Re-plan on the fresh content INSIDE the callback (process may rerun it).
          const lines = data.split('\n');
          const plan = planCapture(lines, taskLine, project, OUTLINE_TAB_SIZE);
          lines.splice(plan.insertLine, 0, ...plan.insertText.split('\n'));
          return lines.join('\n');
        });
        new Notice(`已加入 ${path}`);
        return;
      }
    }
    this.captureIntoEditor(editor, taskLine, project);
    new Notice(`已加入 ${path}`);
  }

  private captureIntoEditor(editor: EditorView, taskLine: string, project: string): void {
    const lines = docLines(editor.state);
    const plan = planCapture(lines, taskLine, project, OUTLINE_TAB_SIZE);
    const doc = editor.state.doc;
    if (plan.insertLine < lines.length) {
      editor.dispatch({
        changes: { from: doc.line(plan.insertLine + 1).from, insert: plan.insertText + '\n' },
      });
    } else {
      editor.dispatch({ changes: { from: doc.length, insert: '\n' + plan.insertText } });
    }
  }

  /** The inbox TFile, created (with any missing parent folders) when absent. */
  private async ensureInboxFile(path: string): Promise<TFile | null> {
    const vault = this.plugin.app.vault;
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      return existing;
    }
    if (existing !== null) {
      new Notice(`無法寫入 ${path}：該路徑是資料夾`);
      return null;
    }
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      const found = vault.getAbstractFileByPath(folder);
      if (found === null) {
        await vault.createFolder(folder);
      } else if (!(found instanceof TFolder)) {
        new Notice(`無法建立 ${path}：${folder} 已是檔案`);
        return null;
      }
    }
    return vault.create(path, '');
  }

  /** Quick-pick over all saved searches (global first, then the document's) and apply one. */
  goToSearch(view: TaskPaperView): void {
    const entries: SearchEntry[] = [
      ...this.settings.globalSearches
        .filter((s) => s.query.trim() !== '')
        .map((s) => ({ name: s.name.trim() || s.query, query: s.query, global: true })),
      ...savedSearches(outlineOf(view.editor.state)).map((s) => ({
        name: s.name,
        query: s.query,
        global: false,
      })),
    ];
    if (entries.length === 0) {
      new Notice('No saved searches.');
      return;
    }
    new SearchSuggestModal(this.plugin.app, entries, (entry) => {
      view.editor.dispatch({
        effects: setFilterEffect.of({
          mode: 'query',
          query: entry.query,
          hide: this.settings.filterHidesInsteadOfDims,
        }),
      });
      this.plugin.refreshSidebar();
    }).open();
  }

  private applyToSelectedLines(
    editor: EditorView,
    transform: (text: string) => string | null,
  ): void {
    applyToSelectedLines(editor, transform);
  }
}

/** Apply a line transform to every non-blank line touched by the selection. */
export function applyToSelectedLines(
  editor: EditorView,
  transform: (text: string) => string | null,
): void {
  const state = editor.state;
  const seen = new Set<number>();
  const changes: ChangeSpec[] = [];
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number;
    const endLine = state.doc.lineAt(range.to).number;
    for (let n = startLine; n <= endLine; n++) {
      if (seen.has(n)) {
        continue;
      }
      seen.add(n);
      const line = state.doc.line(n);
      if (line.text.trim().length === 0) {
        continue;
      }
      const next = transform(line.text);
      if (next !== null && next !== line.text) {
        changes.push({ from: line.from, to: line.to, insert: next });
      }
    }
  }
  if (changes.length > 0) {
    editor.dispatch({ changes });
  }
}

/** Toggle every staged tag on the selected lines at once: a line that has
 *  the tag loses it, a line that lacks it gains it (with the staged value). */
export function applyTagToggles(editor: EditorView, tags: StagedTag[]): void {
  if (tags.length === 0) {
    return;
  }
  applyToSelectedLines(editor, (text) =>
    tags.reduce(
      (acc, t) => (hasTag(acc, t.name) ? removeTag(acc, t.name) : addTag(acc, t.name, t.value)),
      text,
    ),
  );
}

/** Smallest [first, last] 0-based line range covering every selection range. */
function selectedLineRange(state: EditorState): [number, number] {
  let start = Infinity;
  let end = -1;
  for (const range of state.selection.ranges) {
    start = Math.min(start, state.doc.lineAt(range.from).number - 1);
    end = Math.max(end, state.doc.lineAt(range.to).number - 1);
  }
  return [start, end];
}

/** Every selection range as a merged, ascending list of 0-based line spans —
 *  multi-cursor selections operate on each span, not the min..max hull. */
function selectedLineRanges(state: EditorState): Array<[number, number]> {
  const spans = state.selection.ranges
    .map((r): [number, number] => [
      state.doc.lineAt(r.from).number - 1,
      state.doc.lineAt(r.to).number - 1,
    ])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], span[1]);
    } else {
      merged.push([span[0], span[1]]);
    }
  }
  return merged;
}

