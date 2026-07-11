import { ItemView, Menu, WorkspaceLeaf } from 'obsidian';
import { EditorSelection } from '@codemirror/state';
import {
  focusVisibleLines,
  hoistVisibleLines,
  moveBranchAfter,
  moveBranchBefore,
  projectStats,
  quoteQueryValue,
  rewriteSearchLine,
  SavedSearch,
  savedSearches,
  tagNamesToValues,
} from '@taskpaper/core';
import { outlineOf } from './editor/outline';
import { filterSpecField, setFilterEffect } from './editor/filter';
import { SaveSearchModal } from './modals';
import {
  composeSelection,
  GlobalSearch,
  isSelected,
  parseTagList,
  selectionSignature,
  settingsSignature,
  sidebarSignature,
  SidebarSelectionItem,
  toggleSelection,
  validateSelection,
  visibleTagCounts,
} from './sidebarLogic';

/** A project's display text minus its trailing tags — the selection's name key. */
function cleanProjectName(displayText: string): string {
  return displayText.replace(/\s*@[A-Za-z0-9._-]+(\([^)]*\))?/g, '').trim();
}
import type TaskPaperPlugin from './main';
import type { TaskPaperView } from './view';

export const VIEW_TYPE_SIDEBAR = 'taskpaper-sidebar';

/** A sidebar panel listing the active document's projects and tags for quick navigation/filtering. */
export class TaskPaperSidebarView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TaskPaperPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_SIDEBAR;
  }

  getDisplayText(): string {
    return 'TaskPaper';
  }

  getIcon(): string {
    return 'list-checks';
  }

  /** The view + content signature last rendered, to avoid needless DOM rebuilds. */
  private renderedSignature: string | null = null;

  async onOpen(): Promise<void> {
    this.render(true);
    // Re-render only when the active file actually changes — NOT on every focus
    // change. Rebuilding the DOM on focus-in would destroy the element mid-click
    // and swallow the first click.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.render()));
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  render(force = false): void {
    const view = this.plugin.lastActiveView;
    const settingsKey = settingsSignature(this.plugin.settings);
    // The active query filter (from any source: sidebar, editor tag click,
    // Filter… command) — the single source of truth for row highlighting.
    const spec = view?.editor ? (view.editor.state.field(filterSpecField, false) ?? null) : null;
    const activeQuery = spec && spec.mode === 'query' ? spec.query : null;

    // When the editor's filter no longer matches what the selection composes
    // to (Escape, Filter…, editor tag click, …), the selection is stale — drop
    // it so highlights never lie. Project rows are additionally validated
    // against the outline: edits shift lines, and a stale line must never be
    // focused or queried.
    if (view && view.editor && view.sidebarSelection.length > 0) {
      const outline = outlineOf(view.editor.state);
      const validated = validateSelection(view.sidebarSelection, (line) => {
        const item = outline.items.find((i) => i.line === line);
        return item?.kind === 'project' ? cleanProjectName(item.displayText) : undefined;
      });
      const dropped = validated !== view.sidebarSelection;
      view.sidebarSelection = validated;
      const composed = composeSelection(view.sidebarSelection);
      const matches =
        composed.type === 'none'
          ? spec === null
          : composed.type === 'focus' || composed.type === 'hoist'
            ? spec?.mode === 'focus' && view.focusedLine === composed.line
            : spec?.mode === 'query' && spec.query === composed.query;
      if (!matches) {
        view.sidebarSelection = [];
      }
      // Validation dropped a stale project/hoist while its line-based filter
      // is still applied: the hidden set now targets the wrong lines. Clear
      // it outside this render pass.
      if (dropped && spec?.mode === 'focus') {
        window.setTimeout(() => this.clearFocus(view), 0);
      }
    }
    const selection = view?.sidebarSelection ?? [];

    const signature =
      view && view.editor
        ? sidebarSignature(
            view.file?.path ?? '?',
            view.editor.state.doc.length,
            view.focusedLine,
            settingsKey,
            activeQuery,
            selectionSignature(selection),
          )
        : sidebarSignature(null, 0, null, settingsKey);
    if (!force && signature === this.renderedSignature) {
      return;
    }
    this.renderedSignature = signature;

    const container = this.contentEl;
    container.empty();
    container.addClass('taskpaper-sidebar');

    if (!view || !view.editor) {
      container.createDiv({ cls: 'tp-sb-empty', text: '開啟一個 .taskpaper 檔案' });
      return;
    }

    const outline = outlineOf(view.editor.state);

    const toolbar = container.createDiv({ cls: 'tp-sb-toolbar' });
    const clearBtn = toolbar.createEl('button', { text: '顯示全部', cls: 'tp-sb-clear' });
    clearBtn.onclick = () => this.clearFocus(view);

    // Searches section: global searches (from settings) first, then the document's own @search items.
    const globalSearches = this.plugin.settings.globalSearches.filter((s) => s.query.trim() !== '');
    const searches = savedSearches(outline);
    const searchSection = container.createDiv({ cls: 'tp-sb-section' });
    const searchHeading = searchSection.createDiv({ cls: 'tp-sb-heading', text: 'Searches' });
    // TaskPaper parity: right-click the "Searches" heading to create a new search.
    searchHeading.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((mi) =>
        mi
          .setTitle('新增搜尋')
          .setIcon('plus')
          .onClick(() => this.plugin.commands.saveSearch(view)),
      );
      menu.showAtMouseEvent(e);
    });
    // Click = single select (again = clear); Ctrl/Cmd+click = multi-select.
    const select = (item: SidebarSelectionItem, e: MouseEvent) => {
      const multi = e.ctrlKey || e.metaKey;
      // A plain click on the row of an externally applied filter clears it.
      if (
        !multi &&
        selection.length === 0 &&
        item.kind !== 'project' &&
        item.kind !== 'hoist' &&
        activeQuery === item.query
      ) {
        this.clearFocus(view);
        return;
      }
      view.sidebarSelection = toggleSelection(selection, item, multi);
      this.applySelection(view);
    };
    const isRowSelected = (item: SidebarSelectionItem): boolean =>
      isSelected(selection, item) ||
      (selection.length === 0 &&
        item.kind !== 'project' &&
        item.kind !== 'hoist' &&
        activeQuery === item.query);
    const addSearch = (name: string, query: string, global: boolean): HTMLElement => {
      const el = searchSection.createDiv({
        cls: global ? 'tp-sb-item tp-sb-search tp-sb-search-global' : 'tp-sb-item tp-sb-search',
      });
      const selItem: SidebarSelectionItem = { kind: 'search', query };
      if (isRowSelected(selItem)) {
        el.addClass('is-focused');
      }
      el.createSpan({ cls: 'tp-sb-search-name', text: name });
      if (global) {
        el.createSpan({ cls: 'tp-sb-global-badge', text: '全域' });
      }
      el.setAttr('title', query);
      el.onclick = (e) => select(selItem, e);
      return el;
    };
    for (const s of globalSearches) {
      const el = addSearch(s.name.trim() || s.query, s.query, true);
      el.addEventListener('contextmenu', (e) => this.showGlobalSearchMenu(e, s));
    }
    for (const s of searches) {
      const el = addSearch(s.name, s.query, false);
      el.addEventListener('contextmenu', (e) => this.showDocumentSearchMenu(e, view, s));
    }

    // Projects section.
    const stats = projectStats(outline);
    const projSection = container.createDiv({ cls: 'tp-sb-section' });
    projSection.createDiv({ cls: 'tp-sb-heading', text: 'Projects' });
    const projects = outline.items.filter((i) => i.kind === 'project');
    if (projects.length === 0) {
      projSection.createDiv({ cls: 'tp-sb-empty', text: '（無專案）' });
    }
    for (const p of projects) {
      const el = projSection.createDiv({
        cls: 'tp-sb-item tp-sb-project',
        // data-line lets editor handle drags hit-test their drop target;
        // draggable enables the original sidebar's drag-reorder.
        attr: { 'data-line': p.line, draggable: 'true' },
      });
      el.style.paddingLeft = `${8 + p.level * 14}px`;
      const name = cleanProjectName(p.displayText);
      const selItem: SidebarSelectionItem = { kind: 'project', line: p.line, name };
      const hoistItem: SidebarSelectionItem = { kind: 'hoist', line: p.line, name };
      if (isSelected(selection, selItem) || view.focusedLine === p.line) {
        el.addClass('is-focused');
      }
      if (isSelected(selection, hoistItem)) {
        el.addClass('is-hoisted');
      }
      el.createSpan({ text: p.displayText || '(未命名)' });
      const remaining = stats.get(p)?.remaining ?? 0;
      if (remaining > 0) {
        el.createSpan({ cls: 'tp-sb-count', text: String(remaining) });
      }
      // Original: double-click hoists. Our single click already toggles focus,
      // so hoist rides on Alt/Option+click (and the context menu below).
      el.onclick = (e) => {
        if (e.altKey) {
          this.hoistProject(view, hoistItem);
        } else {
          select(selItem, e);
        }
      };
      el.addEventListener('contextmenu', (e) => this.showProjectMenu(e, view, hoistItem));
      this.registerProjectDrag(el, view, p.line);
    }

    // Tags section.
    const counts = new Map<string, number>();
    for (const item of outline.items) {
      for (const name of item.tags.keys()) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const tagSection = container.createDiv({ cls: 'tp-sb-section' });
    tagSection.createDiv({ cls: 'tp-sb-heading', text: 'Tags' });
    const sorted = visibleTagCounts(
      counts,
      parseTagList(this.plugin.settings.includeTags),
      parseTagList(this.plugin.settings.excludeTags),
    );
    if (sorted.length === 0) {
      tagSection.createDiv({ cls: 'tp-sb-empty', text: '（無標籤）' });
    }
    const namesToValues = tagNamesToValues(outline);
    for (const [name, count] of sorted) {
      const el = tagSection.createDiv({ cls: 'tp-sb-item tp-sb-tag' });
      const tagItem: SidebarSelectionItem = { kind: 'tag', query: `@${name}` };
      if (isRowSelected(tagItem)) {
        el.addClass('is-focused');
      }
      el.createSpan({ cls: 'tp-sb-tag-name', text: `@${name}` });
      el.createSpan({ cls: 'tp-sb-tag-count', text: String(count) });
      el.onclick = (e) => select(tagItem, e);
      // Each distinct value is a child row (original sidebar); clicking it
      // filters with `@tag contains[l] "value"` — exactly the original query.
      for (const value of namesToValues.get(name) ?? []) {
        const valueItem: SidebarSelectionItem = {
          kind: 'tag',
          query: `@${name} contains[l] ${quoteQueryValue(value)}`,
        };
        const vel = tagSection.createDiv({ cls: 'tp-sb-item tp-sb-tag-value' });
        if (isRowSelected(valueItem)) {
          vel.addClass('is-focused');
        }
        vel.createSpan({ text: value });
        vel.onclick = (e) => select(valueItem, e);
      }
    }
  }

  /** Dispatch the filter the current selection composes to. */
  private applySelection(view: TaskPaperView): void {
    const composed = composeSelection(view.sidebarSelection);
    const hide = this.plugin.settings.filterHidesInsteadOfDims;
    if (composed.type === 'none') {
      view.focusedLine = null;
      view.editor.dispatch({ effects: setFilterEffect.of(null) });
    } else if (composed.type === 'focus' || composed.type === 'hoist') {
      if (composed.line + 1 > view.editor.state.doc.lines) {
        // Stale line (document shrank since selection) — bail out safely.
        view.sidebarSelection = [];
        view.focusedLine = null;
        view.editor.dispatch({ effects: setFilterEffect.of(null) });
        this.plugin.refreshSidebar();
        return;
      }
      const outline = outlineOf(view.editor.state);
      view.focusedLine = composed.line;
      // A hoisted project's own line is hidden — park the cursor on its
      // first content line instead.
      const cursorLine = Math.min(
        composed.line + (composed.type === 'hoist' ? 2 : 1),
        view.editor.state.doc.lines,
      );
      view.editor.dispatch({
        effects: setFilterEffect.of({
          mode: 'focus',
          visible:
            composed.type === 'hoist'
              ? hoistVisibleLines(outline, composed.line)
              : focusVisibleLines(outline, composed.line),
          hide,
        }),
        selection: EditorSelection.cursor(view.editor.state.doc.line(cursorLine).from),
        scrollIntoView: true,
      });
    } else {
      view.focusedLine = null;
      view.editor.dispatch({
        effects: setFilterEffect.of({ mode: 'query', query: composed.query, hide }),
      });
    }
    this.app.workspace.revealLeaf(view.leaf);
    this.plugin.refreshSidebar();
  }

  /** Hoist a project (original: double-click): show only its CONTENTS —
   *  descendants plus ancestor context, the project line itself hidden.
   *  Alt+clicking the already hoisted row un-hoists (toggle). */
  private hoistProject(view: TaskPaperView, item: SidebarSelectionItem): void {
    view.sidebarSelection = toggleSelection(view.sidebarSelection, item, false);
    this.applySelection(view);
  }

  /** Context menu for a project row: Hoist（只顯示內容）. */
  private showProjectMenu(e: MouseEvent, view: TaskPaperView, item: SidebarSelectionItem): void {
    e.preventDefault();
    const menu = new Menu();
    menu.addItem((mi) =>
      mi
        .setTitle('Hoist（只顯示內容）')
        .setIcon('zoom-in')
        .onClick(() => this.hoistProject(view, item)),
    );
    menu.showAtMouseEvent(e);
  }

  // ---- sidebar project drag-reorder (original: drag projects to reorder) ----

  /** Line (0-based) of the project row a drag started from, while dragging. */
  private dragSourceLine: number | null = null;
  /** The document as it was at dragstart — the drop is rejected if it changed
   *  (line-based moves would otherwise hit an unrelated branch). */
  private dragSourceDoc: unknown = null;

  /** Whether the pointer sits in the lower half of the row (drop AFTER it). */
  private static dropsAfter(row: HTMLElement, e: DragEvent): boolean {
    const rect = row.getBoundingClientRect();
    return e.clientY > rect.top + rect.height / 2;
  }

  private clearDropMarks(): void {
    for (const marked of Array.from(
      this.contentEl.querySelectorAll('.tp-sb-drop-before, .tp-sb-drop-after'),
    )) {
      marked.classList.remove('tp-sb-drop-before', 'tp-sb-drop-after');
    }
  }

  /** Wire the HTML5 DnD handlers that let project rows reorder the document. */
  private registerProjectDrag(el: HTMLElement, view: TaskPaperView, line: number): void {
    el.addEventListener('dragstart', (e: DragEvent) => {
      this.dragSourceLine = line;
      this.dragSourceDoc = view.editor.state.doc;
      el.addClass('tp-sb-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(line));
      }
    });
    el.addEventListener('dragend', () => {
      this.dragSourceLine = null;
      el.removeClass('tp-sb-dragging');
      this.clearDropMarks();
    });
    el.addEventListener('dragover', (e: DragEvent) => {
      if (this.dragSourceLine === null || this.dragSourceLine === line) {
        // Dragging back over the source row: drop any indicator left on the
        // previously hovered target.
        this.clearDropMarks();
        return;
      }
      e.preventDefault(); // marks the row as a valid drop target
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
      this.clearDropMarks();
      el.addClass(
        TaskPaperSidebarView.dropsAfter(el, e) ? 'tp-sb-drop-after' : 'tp-sb-drop-before',
      );
    });
    el.addEventListener('dragleave', () => {
      el.removeClass('tp-sb-drop-before', 'tp-sb-drop-after');
    });
    el.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      this.clearDropMarks();
      const source = this.dragSourceLine;
      const sourceDoc = this.dragSourceDoc;
      this.dragSourceLine = null;
      this.dragSourceDoc = null;
      if (source === null || source === line) {
        return;
      }
      if (sourceDoc !== null && view.editor.state.doc !== sourceDoc) {
        return; // the document changed mid-drag — lines no longer match
      }
      this.dropProject(view, source, line, TaskPaperSidebarView.dropsAfter(el, e));
    });
  }

  /** Move the dragged project's whole subtree before/after the target project. */
  private dropProject(
    view: TaskPaperView,
    sourceLine: number,
    targetLine: number,
    after: boolean,
  ): void {
    const doc = view.editor.state.doc;
    const lines: string[] = [];
    for (let i = 1; i <= doc.lines; i++) {
      lines.push(doc.line(i).text);
    }
    const edit = after
      ? moveBranchAfter(lines, sourceLine, targetLine, 4)
      : moveBranchBefore(lines, sourceLine, targetLine, 4);
    if (!edit) {
      return;
    }
    const br = view.editor.state.lineBreak;
    let anchor = 0;
    for (let i = 0; i < edit.cursorLine; i++) {
      anchor += edit.lines[i].length + br.length;
    }
    view.editor.dispatch({
      changes: { from: 0, to: doc.length, insert: edit.lines.join(br) },
      selection: EditorSelection.cursor(anchor),
      scrollIntoView: true,
    });
    this.plugin.refreshSidebar();
  }

  /** Context menu for a global search (stored in the plugin settings): 編輯 / 刪除. */
  private showGlobalSearchMenu(e: MouseEvent, search: GlobalSearch): void {
    e.preventDefault();
    const menu = new Menu();
    menu.addItem((mi) =>
      mi
        .setTitle('編輯')
        .setIcon('pencil')
        .onClick(() => {
          new SaveSearchModal(
            this.app,
            async (name, query) => {
              search.name = name;
              search.query = query;
              await this.plugin.saveSettings();
              this.plugin.refreshSidebar();
            },
            { title: '編輯搜尋', name: search.name, query: search.query },
          ).open();
        }),
    );
    menu.addItem((mi) =>
      mi
        .setTitle('刪除')
        .setIcon('trash')
        .onClick(async () => {
          const index = this.plugin.settings.globalSearches.indexOf(search);
          if (index >= 0) {
            this.plugin.settings.globalSearches.splice(index, 1);
          }
          await this.plugin.saveSettings();
          this.plugin.refreshSidebar();
        }),
    );
    menu.showAtMouseEvent(e);
  }

  /** Context menu for one of the document's @search items: 編輯搜尋 / 刪除搜尋. */
  private showDocumentSearchMenu(e: MouseEvent, view: TaskPaperView, search: SavedSearch): void {
    e.preventDefault();
    const menu = new Menu();
    menu.addItem((mi) =>
      mi
        .setTitle('編輯搜尋')
        .setIcon('pencil')
        .onClick(() => {
          new SaveSearchModal(
            this.app,
            (name, query) => {
              const doc = view.editor.state.doc;
              if (search.line + 1 > doc.lines) {
                return;
              }
              const line = doc.line(search.line + 1);
              view.editor.dispatch({
                changes: { from: line.from, to: line.to, insert: rewriteSearchLine(line.text, name, query) },
              });
            },
            { title: '編輯搜尋', name: search.name, query: search.query },
          ).open();
        }),
    );
    menu.addItem((mi) =>
      mi
        .setTitle('刪除搜尋')
        .setIcon('trash')
        .onClick(() => {
          const doc = view.editor.state.doc;
          if (search.line + 1 > doc.lines) {
            return;
          }
          const line = doc.line(search.line + 1);
          const isLast = search.line + 1 >= doc.lines;
          // Deleting the last line eats the PRECEDING newline instead of the
          // (nonexistent) following one, so no empty trailing line remains.
          const from = isLast && search.line > 0 ? doc.line(search.line).to : line.from;
          const to = isLast ? line.to : doc.line(search.line + 2).from;
          view.editor.dispatch({ changes: { from, to, insert: '' } });
        }),
    );
    menu.showAtMouseEvent(e);
  }

  private clearFocus(view: TaskPaperView): void {
    view.sidebarSelection = [];
    view.focusedLine = null;
    view.editor.dispatch({ effects: setFilterEffect.of(null) });
    this.plugin.refreshSidebar();
  }
}
