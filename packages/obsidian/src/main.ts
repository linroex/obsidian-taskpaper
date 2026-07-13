import { Notice, Plugin, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { documentCounts, markdownToTaskPaper } from '@taskpaper/core';
import { TaskPaperView, VIEW_TYPE_TASKPAPER } from './view';
import { TaskPaperSidebarView, VIEW_TYPE_SIDEBAR } from './sidebar';
import { TaskPaperCommands } from './commands';
import { outlineOf } from './editor/outline';
import { TaskpaperLinesCache } from './calendarSources';
import { DEFAULT_SETTINGS, TaskPaperSettings, TaskPaperSettingTab } from './settings';

export default class TaskPaperPlugin extends Plugin {
  settings!: TaskPaperSettings;
  commands!: TaskPaperCommands;
  /** The most recently active TaskPaper editor (drives the sidebar). */
  lastActiveView: TaskPaperView | null = null;
  private statusEl: HTMLElement | null = null;
  private refreshTimer: number | null = null;
  /** Bumps on any .taskpaper content change — the vault-scope calendar's
   *  render/drag staleness token. */
  calendarEpoch = 0;
  /** Closed-file line cache for the vault-wide calendar scope. */
  private calendarLinesCache = new TaskpaperLinesCache(
    async (path) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      return file instanceof TFile ? this.app.vault.cachedRead(file) : '';
    },
    () => this.refreshCalendarsSoon(),
  );
  private calendarTimer: number | null = null;

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

    // File-explorer context menu: create a .taskpaper in a folder, or convert
    // a markdown note into one (headings → projects, checkboxes → tasks).
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((mi) =>
            mi
              .setTitle('新增 TaskPaper 檔案')
              .setIcon('list-checks')
              .onClick(() => this.createTaskPaperFile(file)),
          );
        } else if (file instanceof TFile && file.extension === 'md') {
          menu.addItem((mi) =>
            mi
              .setTitle('轉換為 TaskPaper')
              .setIcon('list-checks')
              .onClick(() => this.convertNoteToTaskPaper(file)),
          );
        }
      }),
    );
    // Vault-scope calendars: any .taskpaper change (or a rename away from
    // .taskpaper) invalidates the line cache and refreshes active calendars.
    const calendarVaultEvent = (file: TAbstractFile, oldPath?: string) => {
      const isTaskpaper =
        (file instanceof TFile && file.extension === 'taskpaper') ||
        oldPath?.endsWith('.taskpaper') === true;
      if (!isTaskpaper) {
        return;
      }
      this.calendarLinesCache.invalidate(file.path);
      if (oldPath) {
        this.calendarLinesCache.invalidate(oldPath);
      }
      this.calendarEpoch++;
      this.refreshCalendarsSoon();
    };
    // 'modify' of a file open in a TaskPaper view is its own debounced
    // autosave echoing back — onDocChanged already bumped the epoch at the
    // keystroke, and a second bump here would spuriously refuse a calendar
    // drag started in between. Only the (closed-file) cache needs dropping.
    const modifyEvent = (file: TAbstractFile) => {
      const openHere =
        file instanceof TFile &&
        file.extension === 'taskpaper' &&
        this.app.workspace
          .getLeavesOfType(VIEW_TYPE_TASKPAPER)
          .some((leaf) => leaf.view instanceof TaskPaperView && leaf.view.file?.path === file.path);
      if (openHere) {
        this.calendarLinesCache.invalidate(file.path);
        return;
      }
      calendarVaultEvent(file);
    };
    this.registerEvent(this.app.vault.on('create', (file) => calendarVaultEvent(file)));
    this.registerEvent(this.app.vault.on('modify', (file) => modifyEvent(file)));
    this.registerEvent(this.app.vault.on('delete', (file) => calendarVaultEvent(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => calendarVaultEvent(file, oldPath)));

    this.addSettingTab(new TaskPaperSettingTab(this.app, this));
    this.applyBodyClasses();
    this.registerCommands();
  }

  onunload(): void {
    document.body.removeClass('taskpaper-no-strike');
    if (this.calendarTimer !== null) {
      window.clearTimeout(this.calendarTimer);
      this.calendarTimer = null;
    }
  }

  /** Any open editor's change makes vault-scope calendar data stale. */
  bumpCalendarEpoch(): void {
    this.calendarEpoch++;
  }

  /** Cached lines of a (closed) file — null while a background read runs. */
  calendarLines(file: TFile): string[] | null {
    return this.calendarLinesCache.lines(file.path, `${file.stat.mtime}:${file.stat.size}`);
  }

  /** Debounced calendar-only refresh for vault file events. */
  private refreshCalendarsSoon(): void {
    if (this.calendarTimer !== null) {
      window.clearTimeout(this.calendarTimer);
    }
    this.calendarTimer = window.setTimeout(() => {
      this.calendarTimer = null;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKPAPER)) {
        const view = leaf.view;
        if (view instanceof TaskPaperView) {
          view.refreshCalendar();
        }
      }
    }, 500);
  }

  activeView(): TaskPaperView | null {
    return this.app.workspace.getActiveViewOfType(TaskPaperView);
  }

  /** Re-render any open sidebar/calendar panels + the status bar (called after edits). */
  refreshSidebar(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR)) {
      const view = leaf.view;
      if (view instanceof TaskPaperSidebarView) {
        view.render(true);
      }
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKPAPER)) {
      const view = leaf.view;
      if (view instanceof TaskPaperView) {
        view.refreshCalendar();
      }
    }
    this.updateStatusBar();
  }

  /** Debounced refresh for high-frequency sources (typing). On a 10k+ line
   *  document a full sidebar DOM rebuild per keystroke is the bottleneck. */
  refreshSidebarSoon(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshSidebar();
    }, 250);
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
    cmd('toggle-tag', 'Tag with…', (v) => this.commands.toggleTag(v));
    cmd('copy-displayed', 'Copy displayed', (v) => this.commands.copyDisplayed(v));
    cmd('select-branch', 'Select branch', (v) => this.commands.selectBranch(v));
    cmd('expand-selection', 'Expand selection', (v) => this.commands.expandSelection(v));
    cmd('contract-selection', 'Contract selection', (v) => this.commands.contractSelection(v));
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
    cmd('filter', 'Filter…', (v) => v.openSearchbar());
    cmd('begin-editor-search', 'Begin editor search', (v) => v.openSearchbar());
    cmd('clear-filter', 'Clear filter', (v) => this.commands.clearFilter(v));
    cmd('go-to-project', 'Go to project…', (v) => this.commands.goToProject(v));
    cmd('go-to-search', 'Go to search…', (v) => this.commands.goToSearch(v));
    cmd('go-to-anything', 'Go to anything…', (v) => this.commands.goToAnything(v));
    cmd('go-to-tag', 'Go to tag…', (v) => this.commands.goToTag(v));
    cmd('fold-all', 'Fold all', (v) => this.commands.foldAll(v));
    cmd('unfold-all', 'Unfold all', (v) => this.commands.unfoldAll(v));
    cmd('collapse-items', 'Collapse items', (v) => this.commands.collapseItems(v));
    cmd('expand-items', 'Expand items', (v) => this.commands.expandItems(v));
    cmd('expand-items-completely', 'Expand items completely', (v) =>
      this.commands.expandItemsCompletely(v),
    );
    cmd('collapse-items-completely', 'Collapse items completely', (v) =>
      this.commands.collapseItemsCompletely(v),
    );
    cmd('collapse-all-by-level', 'Collapse all by level', (v) =>
      this.commands.collapseAllByLevel(v),
    );
    cmd('expand-all-by-level', 'Expand all by level', (v) => this.commands.expandAllByLevel(v));
    cmd('save-search', 'Save search…', (v) => this.commands.saveSearch(v));
    cmd('move-up', 'Move item up', (v) => this.commands.moveUp(v));
    cmd('move-down', 'Move item down', (v) => this.commands.moveDown(v));
    cmd('indent', 'Indent item', (v) => this.commands.indent(v));
    cmd('outdent', 'Outdent item', (v) => this.commands.outdent(v));
    cmd('move-item-only-up', 'Move item only up', (v) => this.commands.moveOnlyUp(v));
    cmd('move-item-only-down', 'Move item only down', (v) => this.commands.moveOnlyDown(v));
    cmd('move-item-only-right', 'Move item only right', (v) => this.commands.indentOnly(v));
    cmd('move-item-only-left', 'Move item only left', (v) => this.commands.outdentOnly(v));

    this.addCommand({
      id: 'open-sidebar',
      name: 'Open sidebar (projects & tags)',
      callback: () => this.activateSidebar(),
    });
    // Quick capture works from anywhere — no TaskPaper view required.
    this.addCommand({
      id: 'quick-capture',
      name: '快速新增任務',
      callback: () => this.commands.quickCapture(),
    });
    cmd('toggle-calendar-view', 'Toggle calendar view', (v) => v.toggleCalendarMode());
    // Compatibility alias: 'open-calendar' predates the in-tab calendar mode;
    // existing user hotkeys keep working.
    cmd('open-calendar', 'Open calendar', (v) => v.setViewMode('calendar'));
  }

  /** Create an untitled .taskpaper file in the folder and open it. */
  private async createTaskPaperFile(folder: TFolder): Promise<void> {
    const base = folder.path === '/' ? '' : `${folder.path}/`;
    let path = `${base}未命名.taskpaper`;
    for (let n = 1; this.app.vault.getAbstractFileByPath(path) !== null; n++) {
      path = `${base}未命名 ${n}.taskpaper`;
    }
    const file = await this.app.vault.create(path, '');
    await this.app.workspace.getLeaf('tab').openFile(file);
  }

  /** Convert a markdown note in place: transform the content, then rename
   *  the extension (fileManager.renameFile keeps links pointing at it). */
  private async convertNoteToTaskPaper(file: TFile): Promise<void> {
    const target = file.path.replace(/\.md$/, '.taskpaper');
    if (this.app.vault.getAbstractFileByPath(target) !== null) {
      new Notice(`已存在同名檔案：${target}`);
      return;
    }
    await this.app.vault.process(file, (content) =>
      markdownToTaskPaper(content.split('\n')).join('\n'),
    );
    await this.app.fileManager.renameFile(file, target);
    const renamed = this.app.vault.getAbstractFileByPath(target);
    if (renamed instanceof TFile) {
      await this.app.workspace.getLeaf('tab').openFile(renamed);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.sidebarCollapsed = [...this.settings.sidebarCollapsed];
    // Deep-copy the array so edits never mutate the shared DEFAULT_SETTINGS.
    this.settings.globalSearches = this.settings.globalSearches.map((s) => ({ ...s }));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
