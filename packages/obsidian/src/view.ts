import { setIcon, TextFileView, WorkspaceLeaf } from 'obsidian';
import { EditorState, Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { codeFolding, indentUnit } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import {
  indentItem,
  moveItemDown,
  moveItemUp,
  outdentItem,
  parseQuery,
  todayStamp,
} from '@taskpaper/core';
import { highlightPlugin } from './editor/highlight';
import { outlineOf } from './editor/outline';
import { taskpaperFolding } from './editor/folding';
import { filterExtension, filterSpecField, searchbarText, setFilterEffect } from './editor/filter';
import { escapeClearsFilter, taskpaperKeymap } from './editor/keymap';
import { applyOutlineOp } from './editor/outlineEdit';
import { tagClickExtension } from './editor/tagClick';
import { dashClickExtension } from './editor/dashClick';
import { indentGuides } from './editor/guides';
import type { SidebarSelectionItem } from './sidebarLogic';
import { linkExtension, LinkKind } from './editor/links';
import { tagAutocomplete } from './editor/tagComplete';
import { itemHandles } from './editor/handles';
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
    const text = searchbarText(spec, projectName);
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
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      EditorState.tabSize.of(4),
      indentUnit.of('\t'),
      // No fold gutter — the item handle dots toggle folds, like the original.
      codeFolding(),
      taskpaperFolding,
      highlightPlugin,
      indentGuides,
      filterExtension,
      itemHandles({
        hide: () => this.plugin.settings.filterHidesInsteadOfDims,
        onFocus: (line) => {
          this.focusedLine = line;
          this.plugin.refreshSidebar();
        },
      }),
      tagAutocomplete,
      search({ top: true }),
      // The search panel is user-facing UI — localize it like the rest.
      EditorState.phrases.of({
        Find: '尋找',
        Replace: '取代',
        next: '下一個',
        previous: '上一個',
        all: '全部',
        'match case': '區分大小寫',
        'by word': '整字比對',
        regexp: '正則表達式',
        replace: '取代',
        'replace all': '全部取代',
        close: '關閉',
      }),
      highlightSelectionMatches(),
      tagClickExtension({
        hide: () => this.plugin.settings.filterHidesInsteadOfDims,
        onToggle: () => {
          this.focusedLine = null;
          this.plugin.refreshSidebar();
        },
      }),
      dashClickExtension({
        stamp: () => todayStamp(this.plugin.settings.doneIncludesTime),
      }),
      linkExtension((href, kind) => this.openLink(href, kind)),
      EditorView.lineWrapping,
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            this.saveNow();
            return true;
          },
        },
        { key: 'Alt-ArrowUp', preventDefault: true, run: (v) => applyOutlineOp(v, moveItemUp) },
        { key: 'Alt-ArrowDown', preventDefault: true, run: (v) => applyOutlineOp(v, moveItemDown) },
        {
          key: 'Alt-Shift-ArrowRight',
          preventDefault: true,
          run: (v) => applyOutlineOp(v, indentItem),
        },
        {
          key: 'Alt-Shift-ArrowLeft',
          preventDefault: true,
          run: (v) => applyOutlineOp(v, outdentItem),
        },
        ...taskpaperKeymap,
        ...searchKeymap,
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.domEventHandlers({
        blur: () => {
          this.saveNow();
          return false;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !this.applyingExternalData) {
          this.data = update.state.doc.toString();
          this.requestSave();
          this.plugin.refreshSidebar();
        }
        // Any filter change (sidebar, tag click, commands, Escape) syncs the bar.
        if (update.transactions.some((tr) => tr.effects.some((e) => e.is(setFilterEffect)))) {
          this.updateSearchbar();
        }
      }),
      // LAST in the stack, so the search panel's and autocomplete's own
      // Escape bindings win while they are open (TaskPaper 3: Escape ends
      // the editor search — here it clears the active filter/focus).
      keymap.of([
        {
          key: 'Escape',
          run: (v) => {
            if (!escapeClearsFilter(v.state)) {
              return false;
            }
            this.focusedLine = null;
            v.dispatch({ effects: setFilterEffect.of(null) });
            this.plugin.refreshSidebar();
            return true;
          },
        },
      ]),
    ];

    this.editor = new EditorView({
      state: EditorState.create({ doc: this.data ?? '', extensions }),
      parent: this.contentEl,
    });
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
