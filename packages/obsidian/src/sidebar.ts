import { ItemView, Menu, WorkspaceLeaf } from 'obsidian';
import { EditorSelection } from '@codemirror/state';
import {
  focusVisibleLines,
  Item,
  projectStats,
  rewriteSearchLine,
  SavedSearch,
  savedSearches,
  tagNamesToValues,
  toggleFocusTarget,
} from '@taskpaper/core';
import { outlineOf } from './editor/outline';
import { setFilterEffect } from './editor/filter';
import { SaveSearchModal } from './modals';
import { GlobalSearch, parseTagList, settingsSignature, sidebarSignature, visibleTagCounts } from './sidebarLogic';
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
    const signature =
      view && view.editor
        ? sidebarSignature(view.file?.path ?? '?', view.editor.state.doc.length, view.focusedLine, settingsKey)
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
    const addSearch = (name: string, query: string, global: boolean): HTMLElement => {
      const el = searchSection.createDiv({
        cls: global ? 'tp-sb-item tp-sb-search tp-sb-search-global' : 'tp-sb-item tp-sb-search',
      });
      el.createSpan({ cls: 'tp-sb-search-name', text: name });
      if (global) {
        el.createSpan({ cls: 'tp-sb-global-badge', text: '全域' });
      }
      el.setAttr('title', query);
      el.onclick = () => {
        view.editor.dispatch({
          effects: setFilterEffect.of({
            mode: 'query',
            query,
            hide: this.plugin.settings.filterHidesInsteadOfDims,
          }),
        });
        this.app.workspace.revealLeaf(view.leaf);
      };
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
      const el = projSection.createDiv({ cls: 'tp-sb-item tp-sb-project' });
      el.style.paddingLeft = `${8 + p.level * 14}px`;
      if (view.focusedLine === p.line) {
        el.addClass('is-focused');
      }
      el.createSpan({ text: p.displayText || '(未命名)' });
      const remaining = stats.get(p)?.remaining ?? 0;
      if (remaining > 0) {
        el.createSpan({ cls: 'tp-sb-count', text: String(remaining) });
      }
      el.onclick = () => this.toggleFocus(view, p);
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
    const applyQuery = (query: string) => {
      view.focusedLine = null;
      view.editor.dispatch({
        effects: setFilterEffect.of({
          mode: 'query',
          query,
          hide: this.plugin.settings.filterHidesInsteadOfDims,
        }),
      });
      this.app.workspace.revealLeaf(view.leaf);
      this.plugin.refreshSidebar();
    };
    const namesToValues = tagNamesToValues(outline);
    for (const [name, count] of sorted) {
      const el = tagSection.createDiv({ cls: 'tp-sb-item tp-sb-tag' });
      el.createSpan({ cls: 'tp-sb-tag-name', text: `@${name}` });
      el.createSpan({ cls: 'tp-sb-tag-count', text: String(count) });
      el.onclick = () => applyQuery(`@${name}`);
      // Each distinct value is a child row (original sidebar); clicking it
      // filters with `@tag contains[l] "value"` — exactly the original query.
      for (const value of namesToValues.get(name) ?? []) {
        const vel = tagSection.createDiv({ cls: 'tp-sb-item tp-sb-tag-value' });
        vel.createSpan({ text: value });
        vel.onclick = () => applyQuery(`@${name} contains[l] "${value.replace(/"/g, '\\"')}"`);
      }
    }
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

  /** Clicking a project focuses it; clicking the focused project again shows everything. */
  private toggleFocus(view: TaskPaperView, project: Item): void {
    if (toggleFocusTarget(view.focusedLine, project.line) === null) {
      this.clearFocus(view);
      return;
    }
    const visible = focusVisibleLines(outlineOf(view.editor.state), project.line);
    view.focusedLine = project.line;
    view.editor.dispatch({
      effects: setFilterEffect.of({
        mode: 'focus',
        visible,
        hide: this.plugin.settings.filterHidesInsteadOfDims,
      }),
      selection: EditorSelection.cursor(view.editor.state.doc.line(project.line + 1).from),
      scrollIntoView: true,
    });
    this.app.workspace.revealLeaf(view.leaf);
    view.editor.focus();
    this.plugin.refreshSidebar();
  }

  private clearFocus(view: TaskPaperView): void {
    view.focusedLine = null;
    view.editor.dispatch({ effects: setFilterEffect.of(null) });
    this.plugin.refreshSidebar();
  }
}
