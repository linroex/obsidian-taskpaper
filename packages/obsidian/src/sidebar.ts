import { ItemView, WorkspaceLeaf } from 'obsidian';
import { EditorSelection } from '@codemirror/state';
import { focusVisibleLines, Item, projectStats, savedSearches, toggleFocusTarget } from '@taskpaper/core';
import { outlineOf } from './editor/outline';
import { setFilterEffect } from './editor/filter';
import { sidebarSignature } from './sidebarLogic';
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
    const signature =
      view && view.editor
        ? sidebarSignature(view.file?.path ?? '?', view.editor.state.doc.length, view.focusedLine)
        : sidebarSignature(null, 0, null);
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

    // Searches section.
    const searches = savedSearches(outline);
    if (searches.length > 0) {
      const searchSection = container.createDiv({ cls: 'tp-sb-section' });
      searchSection.createDiv({ cls: 'tp-sb-heading', text: 'Searches' });
      for (const s of searches) {
        const el = searchSection.createDiv({ cls: 'tp-sb-item tp-sb-search' });
        el.createSpan({ cls: 'tp-sb-search-name', text: s.name });
        el.setAttr('title', s.query);
        el.onclick = () => {
          view.editor.dispatch({
            effects: setFilterEffect.of({
              mode: 'query',
              query: s.query,
              hide: this.plugin.settings.filterHidesInsteadOfDims,
            }),
          });
          this.app.workspace.revealLeaf(view.leaf);
        };
      }
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
    if (counts.size === 0) {
      tagSection.createDiv({ cls: 'tp-sb-empty', text: '（無標籤）' });
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [name, count] of sorted) {
      const el = tagSection.createDiv({ cls: 'tp-sb-item tp-sb-tag' });
      el.createSpan({ cls: 'tp-sb-tag-name', text: `@${name}` });
      el.createSpan({ cls: 'tp-sb-tag-count', text: String(count) });
      el.onclick = () => {
        view.focusedLine = null;
        view.editor.dispatch({
          effects: setFilterEffect.of({
            mode: 'query',
            query: `@${name}`,
            hide: this.plugin.settings.filterHidesInsteadOfDims,
          }),
        });
        this.app.workspace.revealLeaf(view.leaf);
        this.plugin.refreshSidebar();
      };
    }
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
