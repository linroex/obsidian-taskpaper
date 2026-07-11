import { Plugin, WorkspaceLeaf } from 'obsidian';
import { documentCounts } from '@taskpaper/core';
import { TaskPaperView, VIEW_TYPE_TASKPAPER } from './view';
import { TaskPaperSidebarView, VIEW_TYPE_SIDEBAR } from './sidebar';
import { TaskPaperCommands } from './commands';
import { outlineOf } from './editor/outline';
import { DEFAULT_SETTINGS, TaskPaperSettings, TaskPaperSettingTab } from './settings';

export default class TaskPaperPlugin extends Plugin {
  settings!: TaskPaperSettings;
  commands!: TaskPaperCommands;
  /** The most recently active TaskPaper editor (drives the sidebar). */
  lastActiveView: TaskPaperView | null = null;
  private statusEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.commands = new TaskPaperCommands(this);

    this.registerView(VIEW_TYPE_TASKPAPER, (leaf: WorkspaceLeaf) => new TaskPaperView(leaf, this));
    this.registerView(
      VIEW_TYPE_SIDEBAR,
      (leaf: WorkspaceLeaf) => new TaskPaperSidebarView(leaf, this),
    );
    try {
      this.registerExtensions(['taskpaper'], VIEW_TYPE_TASKPAPER);
    } catch (e) {
      console.warn('TaskPaper: could not register the .taskpaper extension', e);
    }

    this.statusEl = this.addStatusBarItem();

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const view = this.app.workspace.getActiveViewOfType(TaskPaperView);
        if (view) {
          this.lastActiveView = view;
        }
        this.updateStatusBar();
      }),
    );

    this.addRibbonIcon('list-checks', 'TaskPaper sidebar', () => this.activateSidebar());
    this.addSettingTab(new TaskPaperSettingTab(this.app, this));
    this.applyBodyClasses();
    this.registerCommands();
  }

  onunload(): void {
    document.body.removeClass('taskpaper-no-strike');
  }

  activeView(): TaskPaperView | null {
    return this.app.workspace.getActiveViewOfType(TaskPaperView);
  }

  /** Re-render any open sidebar panels + the status bar (called after edits). */
  refreshSidebar(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR)) {
      const view = leaf.view;
      if (view instanceof TaskPaperSidebarView) {
        view.render(true);
      }
    }
    this.updateStatusBar();
  }

  updateStatusBar(): void {
    if (!this.statusEl) {
      return;
    }
    const active = this.app.workspace.getActiveViewOfType(TaskPaperView);
    if (!active || !active.editor) {
      this.statusEl.setText('');
      return;
    }
    const c = documentCounts(outlineOf(active.editor.state));
    const parts = [`${c.today} today`];
    if (c.overdue > 0) {
      parts.push(`${c.overdue} overdue`);
    }
    parts.push(`${c.remaining} left`);
    this.statusEl.setText('✓ ' + parts.join(' · '));
  }

  async activateSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_SIDEBAR, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  applyBodyClasses(): void {
    document.body.toggleClass('taskpaper-no-strike', !this.settings.strikeDoneItems);
  }

  private registerCommands(): void {
    const cmd = (id: string, name: string, fn: (view: TaskPaperView) => void) =>
      this.addCommand({
        id,
        name,
        checkCallback: (checking: boolean) => {
          const view = this.activeView();
          if (!view) {
            return false;
          }
          if (!checking) {
            fn(view);
          }
          return true;
        },
      });

    cmd('toggle-done', 'Toggle done', (v) => this.commands.toggleDone(v));
    cmd('toggle-today', 'Toggle today', (v) => this.commands.toggleToday(v));
    cmd('toggle-tag', 'Toggle tag…', (v) => this.commands.toggleTag(v));
    cmd('new-task', 'New task', (v) => this.commands.newTask(v));
    cmd('new-project', 'New project', (v) => this.commands.newProject(v));
    cmd('new-note', 'New note', (v) => this.commands.newNote(v));
    cmd('format-as-project', 'Format as project', (v) => this.commands.formatAs(v, 'project'));
    cmd('format-as-task', 'Format as task', (v) => this.commands.formatAs(v, 'task'));
    cmd('format-as-note', 'Format as note', (v) => this.commands.formatAs(v, 'note'));
    cmd('group', 'Group', (v) => this.commands.group(v));
    cmd('duplicate', 'Duplicate', (v) => this.commands.duplicate(v));
    cmd('delete-items', 'Delete items', (v) => this.commands.deleteItems(v));
    cmd('move-to-project', 'Move to project…', (v) => this.commands.moveToProject(v));
    cmd('tag-with-due', 'Tag with due…', (v) => this.commands.tagWithDate(v, 'due'));
    cmd('tag-with-start', 'Tag with start…', (v) => this.commands.tagWithDate(v, 'start'));
    cmd('insert-date', 'Insert date…', (v) => this.commands.insertDate(v));
    cmd('remove-tags', 'Remove tags', (v) => this.commands.removeTags(v));
    cmd('archive-done', 'Archive done items', (v) => this.commands.archiveDone(v));
    cmd('focus', 'Focus project', (v) => this.commands.focus(v));
    cmd('focus-out', 'Focus out', (v) => this.commands.focusOut(v));
    cmd('clear-focus', 'Clear focus / filter', (v) => this.commands.clearFocus(v));
    cmd('filter', 'Filter…', (v) => this.commands.filter(v));
    cmd('clear-filter', 'Clear filter', (v) => this.commands.clearFilter(v));
    cmd('go-to-project', 'Go to project…', (v) => this.commands.goToProject(v));
    cmd('fold-all', 'Fold all', (v) => this.commands.foldAll(v));
    cmd('unfold-all', 'Unfold all', (v) => this.commands.unfoldAll(v));
    cmd('save-search', 'Save search…', (v) => this.commands.saveSearch(v));
    cmd('move-up', 'Move item up', (v) => this.commands.moveUp(v));
    cmd('move-down', 'Move item down', (v) => this.commands.moveDown(v));
    cmd('indent', 'Indent item', (v) => this.commands.indent(v));
    cmd('outdent', 'Outdent item', (v) => this.commands.outdent(v));

    this.addCommand({
      id: 'open-sidebar',
      name: 'Open sidebar (projects & tags)',
      callback: () => this.activateSidebar(),
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
