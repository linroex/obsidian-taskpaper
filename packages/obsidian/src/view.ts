import { Menu, setIcon, TextFileView, WorkspaceLeaf } from 'obsidian';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { parseQuery, stripTags, todayStamp } from '@taskpaper/core';
import { outlineOf } from './editor/outline';
import { filterSpecField, searchbarText, setFilterEffect } from './editor/filter';
import { createEditorExtensions } from './editor/setup';
import { CalendarPane } from './calendarPane';
import type { SidebarSelectionItem } from './sidebarLogic';
import type { LinkKind } from './editor/links';
import type TaskPaperPlugin from './main';

export const VIEW_TYPE_TASKPAPER = 'taskpaper-view';

/** A dedicated editor view for `.taskpaper` files, backed by a CodeMirror 6 EditorView. */
export class TaskPaperView extends TextFileView {
  editor!: EditorView;
  /** Line (0-based) of the project currently focused from the sidebar, if any. */
  focusedLine: number | null = null;
  /** The sidebar rows currently selected (Ctrl/Cmd+click multi-selects). */
  sidebarSelection: SidebarSelectionItem[] = [];
  private applyingExternalData = false;
  private searchbarEl!: HTMLElement;
  private searchInput!: HTMLInputElement;
  /** editor ⇄ calendar, toggled in place within the same tab. */
  viewMode: 'editor' | 'calendar' = 'editor';
  /** Editor share of the tab while in calendar mode (0 = calendar only). */
  private splitRatio = 0;
  private calendarEl!: HTMLElement;
  calendarPane!: CalendarPane;
  private calendarAction: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TaskPaperPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_TASKPAPER;
  }

  getDisplayText(): string {
    return this.file?.basename ?? 'TaskPaper';
  }

  getIcon(): string {
    return 'list-checks';
  }

  async onOpen(): Promise<void> {
    this.buildSearchbar();
    this.buildEditor();
    this.buildCalendar();
    this.plugin.lastActiveView = this;
    this.plugin.refreshSidebar();
    this.calendarAction = this.addAction('calendar-days', '切換行事曆檢視', () =>
      this.toggleCalendarMode(),
    );
    this.addAction('archive', 'Archive done items', () =>
      this.plugin.commands.archiveDone(this),
    );
  }

  async onClose(): Promise<void> {
    this.saveNow();
    this.calendarPane?.destroy();
    this.editor?.destroy();
  }

  /** The embedded calendar container (hidden while in editor mode). */
  private buildCalendar(): void {
    // Divider between editor and calendar: drag to size the split (up to a
    // full-tab calendar at 0); double-click resets to calendar-only.
    const divider = this.contentEl.createDiv({ cls: 'tp-cal-divider' });
    divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      divider.addClass('is-dragging');
      const total = this.contentEl.getBoundingClientRect();
      const onMove = (ev: MouseEvent) => {
        const ratio = Math.min(0.85, Math.max(0, (ev.clientY - total.top) / total.height));
        this.setSplitRatio(ratio < 0.05 ? 0 : ratio);
      };
      const onUp = () => {
        divider.removeClass('is-dragging');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    divider.addEventListener('dblclick', () => this.setSplitRatio(0));

    this.calendarEl = this.contentEl.createDiv({
      cls: 'taskpaper-calendar tp-cal-embedded',
      attr: { tabindex: '-1' },
    });
    this.calendarPane = new CalendarPane(this.calendarEl, {
      state: () => this.editor.state,
      weekStart: () => this.plugin.settings.calendarWeekStart,
      showWeekNumbers: () => this.plugin.settings.calendarShowWeekNumbers !== false,
      jumpToLine: (line) => {
        this.setViewMode('editor');
        this.editor.dispatch({
          selection: EditorSelection.cursor(this.editor.state.doc.line(line + 1).from),
          scrollIntoView: true,
        });
        this.editor.focus();
      },
    });
  }

  /** Toggle editor ⇄ calendar in the SAME tab (like markdown's reading mode). */
  toggleCalendarMode(): void {
    this.setViewMode(this.viewMode === 'editor' ? 'calendar' : 'editor');
  }

  setViewMode(mode: 'editor' | 'calendar'): void {
    if (mode === this.viewMode) {
      return;
    }
    this.viewMode = mode;
    this.contentEl.toggleClass('is-calendar-mode', mode === 'calendar');
    if (mode === 'calendar') {
      this.setSplitRatio(this.splitRatio); // restore the last split size
    }
    this.calendarPane.setActive(mode === 'calendar');
    if (mode === 'calendar') {
      // The hidden CodeMirror must not keep keyboard focus — typing would
      // still edit the document invisibly.
      this.editor.contentDOM.blur();
      this.calendarEl.focus();
    }
    if (this.calendarAction) {
      setIcon(this.calendarAction, mode === 'calendar' ? 'pencil' : 'calendar-days');
      this.calendarAction.setAttribute(
        'aria-label',
        mode === 'calendar' ? '切換編輯檢視' : '切換行事曆檢視',
      );
    }
    if (mode === 'editor') {
      this.editor.focus();
    }
  }

  /** Size the editor/calendar split (0 = full-tab calendar). */
  private setSplitRatio(ratio: number): void {
    this.splitRatio = ratio;
    this.contentEl.toggleClass('has-split', ratio > 0);
    this.contentEl.style.setProperty('--tp-split', String(ratio));
  }

  /** Re-render the embedded calendar when it is the active mode. */
  refreshCalendar(): void {
    if (this.viewMode === 'calendar') {
      this.calendarPane.render(true);
    }
  }

  /** The original app's searchbar, permanently visible above the editor
   *  (replacing the Filter header button): shows the live query for the
   *  active filter, is editable in place, and Escape/✕ clears the filter. */
  private buildSearchbar(): void {
    this.searchbarEl = this.contentEl.createDiv({ cls: 'tp-searchbar' });
    const icon = this.searchbarEl.createSpan({ cls: 'tp-searchbar-icon' });
    setIcon(icon, 'search');
    this.searchInput = this.searchbarEl.createEl('input', {
      cls: 'tp-searchbar-input',
      attr: { spellcheck: 'false', placeholder: '輸入查詢，例如 @today、not @done…' },
    });
    const close = this.searchbarEl.createSpan({ cls: 'tp-searchbar-close' });
    setIcon(close, 'x');
    close.onclick = () => this.clearSearchbar();

    this.searchInput.addEventListener('input', () => {
      const q = this.searchInput.value.trim();
      try {
        if (q) {
          parseQuery(q);
        }
        this.searchInput.removeClass('tp-query-error');
      } catch {
        this.searchInput.addClass('tp-query-error');
        return; // keep the previous filter while the query is invalid
      }
      this.focusedLine = null;
      this.sidebarSelection = [];
      this.editor.dispatch({
        effects: setFilterEffect.of(
          q
            ? { mode: 'query', query: q, hide: this.plugin.settings.filterHidesInsteadOfDims }
            : null,
        ),
      });
      this.plugin.refreshSidebar();
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.clearSearchbar();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.editor.focus();
      }
    });
  }

  /** Focus the searchbar's input (the 'Begin editor search' command). */
  openSearchbar(): void {
    this.updateSearchbar();
    this.searchInput.focus();
    this.searchInput.select();
  }

  /** Clear the active filter; the bar itself stays (it is always visible). */
  private clearSearchbar(): void {
    this.focusedLine = null;
    this.sidebarSelection = [];
    // Set the input directly — updateSearchbar() skips syncing while the
    // input is focused (e.g. Escape pressed inside it), which would leave
    // the old query text behind.
    this.searchInput.value = '';
    this.searchInput.removeClass('tp-query-error');
    this.editor.dispatch({ effects: setFilterEffect.of(null) });
    this.plugin.refreshSidebar();
    this.updateSearchbar();
    this.editor.focus();
  }

  /** Sync the searchbar's text with the active filter. */
  updateSearchbar(): void {
    if (!this.searchbarEl || !this.editor) {
      return;
    }
    const spec = this.editor.state.field(filterSpecField, false) ?? null;
    let projectName: string | null = null;
    if (spec && spec.mode === 'focus' && this.focusedLine !== null) {
      const item = outlineOf(this.editor.state).items.find((i) => i.line === this.focusedLine);
      projectName = item ? stripTags(item.displayText) : null;
    }
    const hoisted =
      this.sidebarSelection.length === 1 && this.sidebarSelection[0].kind === 'hoist';
    const text = searchbarText(spec, projectName, hoisted);
    // Don't fight the user's own typing.
    if (document.activeElement !== this.searchInput) {
      this.searchInput.value = text ?? '';
      this.searchInput.removeClass('tp-query-error');
    }
  }

  /**
   * Resolve a `./` or `../` path against the folder containing this file.
   * Returns an absolute OS path on desktop (FileSystemAdapter), or null when
   * that isn't available (e.g. mobile).
   */
  private resolveRelativePath(rel: string): string | null {
    const folder = this.file?.parent?.path ?? '';
    const parts = folder === '/' ? [] : folder.split('/').filter((p) => p.length > 0);
    for (const seg of rel.split('/')) {
      if (seg === '' || seg === '.') {
        continue;
      } else if (seg === '..') {
        parts.pop();
      } else {
        parts.push(seg);
      }
    }
    const vaultPath = parts.join('/');
    // Desktop's FileSystemAdapter can map a vault path to a full OS path.
    const adapter = this.app.vault.adapter as unknown as {
      getFullPath?: (normalizedPath: string) => string;
    };
    if (typeof adapter.getFullPath === 'function') {
      return adapter.getFullPath(vaultPath);
    }
    return null;
  }

  /** Open a clicked link: http/mailto/scheme via the browser/OS, files via the OS shell. */
  private openLink(href: string, kind: LinkKind): void {
    if (kind !== 'file' && kind !== 'path') {
      // Includes generic `scheme:` URIs (obsidian://, x-devonthink://, …),
      // which window.open hands to the OS / the registered app.
      window.open(href);
      return;
    }
    let path = href.replace(/^file:\/\//, '');
    if (href.startsWith('file://')) {
      // file:// URLs are percent-encoded (e.g. %20 for spaces) — decode before
      // handing the path to the OS shell.
      try {
        path = decodeURIComponent(path);
      } catch {
        // malformed escape — keep the raw text
      }
    }
    if (path.startsWith('~')) {
      const home = (globalThis as { process?: { env?: { HOME?: string } } }).process?.env?.HOME;
      if (home) {
        path = home + path.slice(1);
      }
    }
    if (/^\.\.?\//.test(path)) {
      const resolved = this.resolveRelativePath(path);
      if (resolved === null) {
        return; // no way to reach the OS filesystem here — fail quietly
      }
      path = resolved;
    }
    try {
      // Obsidian desktop exposes Electron; shell.openPath is the safe way to
      // open arbitrary files. Fall back to window.open elsewhere (mobile).
      const electron = (
        window as unknown as {
          require?: (m: string) => { shell?: { openPath(p: string): Promise<string> } };
        }
      ).require?.('electron');
      if (electron?.shell) {
        void electron.shell.openPath(path);
        return;
      }
    } catch {
      // fall through to window.open
    }
    window.open(`file://${path}`);
  }

  /** Persist the current editor content to disk immediately. */
  private saveNow(): void {
    if (this.editor) {
      this.data = this.editor.state.doc.toString();
    }
    void this.save();
  }

  private buildEditor(): void {
    this.contentEl.addClass('taskpaper-view');
    const extensions = createEditorExtensions({
      hide: () => this.plugin.settings.filterHidesInsteadOfDims,
      doneStamp: () => todayStamp(this.plugin.settings.doneIncludesTime),
      setFocusedLine: (line) => {
        this.focusedLine = line;
      },
      refresh: () => this.plugin.refreshSidebar(),
      updateSearchbar: () => this.updateSearchbar(),
      applyingExternalData: () => this.applyingExternalData,
      onDocChanged: (doc) => {
        this.data = doc;
        this.requestSave();
        // Debounced: a full sidebar rebuild per keystroke is too costly
        // on very large documents.
        this.plugin.refreshSidebarSoon();
      },
      openLink: (href, kind) => this.openLink(href, kind),
      saveNow: () => this.saveNow(),
    });

    this.editor = new EditorView({
      state: EditorState.create({ doc: this.data ?? '', extensions }),
      parent: this.contentEl,
    });
    this.registerDomEvent(this.editor.contentDOM, 'contextmenu', (e) => this.showEditorMenu(e));
    this.measureIndentUnit();
    // Fonts can finish loading after the first measurement; remeasure then.
    document.fonts?.ready.then(() => this.measureIndentUnit());
  }

  /** Right-click menu over the editor, acting on the clicked line (or the
   *  existing selection when the click lands inside it). */
  private showEditorMenu(e: MouseEvent): void {
    const pos = this.editor.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos === null) {
      // Not over text (padding, gutter…): keep the native menu and never run
      // line commands against a stale selection.
      return;
    }
    e.preventDefault();
    // Right-clicking inside ANY selection range keeps the whole (possibly
    // multi-range) selection so menu actions apply to all selected tasks.
    const inSelection = this.editor.state.selection.ranges.some(
      (r) => pos >= r.from && pos <= r.to,
    );
    if (!inSelection) {
      this.editor.dispatch({ selection: EditorSelection.cursor(pos) });
    }
    const cmds = this.plugin.commands;
    const menu = new Menu();
    menu.addItem((i) => i.setTitle('Toggle done').setIcon('check').onClick(() => cmds.toggleDone(this)));
    menu.addItem((i) => i.setTitle('Toggle today').setIcon('sun').onClick(() => cmds.toggleToday(this)));
    menu.addItem((i) => i.setTitle('Tag with…').setIcon('tag').onClick(() => cmds.toggleTag(this)));
    menu.addItem((i) => i.setTitle('Tag with due…').setIcon('calendar').onClick(() => cmds.tagWithDate(this, 'due')));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Focus project').setIcon('target').onClick(() => cmds.focus(this)));
    menu.addItem((i) => i.setTitle('Move to project…').setIcon('folder-input').onClick(() => cmds.moveToProject(this)));
    menu.addItem((i) => i.setTitle('Duplicate').setIcon('copy-plus').onClick(() => cmds.duplicate(this)));
    menu.addItem((i) => i.setTitle('Delete items').setIcon('trash').onClick(() => cmds.deleteItems(this)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Copy displayed').setIcon('clipboard-copy').onClick(() => cmds.copyDisplayed(this)));
    menu.addItem((i) => i.setTitle('Archive done items').setIcon('archive').onClick(() => cmds.archiveDone(this)));
    menu.showAtMouseEvent(e);
  }

  onResize(): void {
    // Zoom / theme / font changes all trigger a resize — keep the indent
    // unit in sync with the actual glyph widths.
    this.measureIndentUnit();
  }

  /** One indent level = the rendered width of "- " in the editor font, so a
   *  note's text aligns exactly under its parent task's title (original app
   *  behavior). Measured at runtime and fed to the CSS as --tp-indent. */
  private measureIndentUnit(attempt = 0): void {
    const probe = this.editor.contentDOM.createSpan({ text: '- ' });
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    if (width > 0) {
      this.contentEl.style.setProperty('--tp-indent', `${width}px`);
    } else if (attempt < 10) {
      // Not laid out yet (view still detached) — retry on the next frame.
      requestAnimationFrame(() => this.measureIndentUnit(attempt + 1));
    }
  }

  // ---- TextFileView bridge ----

  getViewData(): string {
    return this.editor ? this.editor.state.doc.toString() : this.data;
  }

  setViewData(data: string, _clear: boolean): void {
    this.data = data;
    if (!this.editor) {
      return;
    }
    this.focusedLine = null;
    this.applyingExternalData = true;
    this.editor.dispatch({
      changes: { from: 0, to: this.editor.state.doc.length, insert: data },
      effects: setFilterEffect.of(null),
    });
    this.applyingExternalData = false;
    // External reloads bypass onDocChanged — keep an active calendar current.
    this.refreshCalendar();
  }

  clear(): void {
    this.data = '';
    this.focusedLine = null;
    if (this.editor) {
      this.applyingExternalData = true;
      this.editor.dispatch({
        changes: { from: 0, to: this.editor.state.doc.length, insert: '' },
        effects: setFilterEffect.of(null),
      });
      this.applyingExternalData = false;
    }
  }
}
