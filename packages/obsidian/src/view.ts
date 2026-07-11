import { setIcon, TextFileView, WorkspaceLeaf } from 'obsidian';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { parseQuery, todayStamp } from '@taskpaper/core';
import { outlineOf } from './editor/outline';
import { filterSpecField, searchbarText, setFilterEffect } from './editor/filter';
import { createEditorExtensions } from './editor/setup';
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
    this.plugin.lastActiveView = this;
    this.plugin.refreshSidebar();
    this.addAction('archive', 'Archive done items', () =>
      this.plugin.commands.archiveDone(this),
    );
  }

  async onClose(): Promise<void> {
    this.saveNow();
    this.editor?.destroy();
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
      projectName = item ? item.displayText.replace(/\s*@[A-Za-z0-9._-]+(\([^)]*\))?/g, '').trim() : null;
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
    this.measureIndentUnit();
    // Fonts can finish loading after the first measurement; remeasure then.
    document.fonts?.ready.then(() => this.measureIndentUnit());
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
