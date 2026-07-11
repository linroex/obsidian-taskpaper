import { TextFileView, WorkspaceLeaf } from 'obsidian';
import { EditorState, Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { codeFolding, foldGutter, indentUnit } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { indentItem, moveItemDown, moveItemUp, outdentItem, todayStamp } from '@taskpaper/core';
import { highlightPlugin } from './editor/highlight';
import { taskpaperFolding } from './editor/folding';
import { filterExtension, setFilterEffect } from './editor/filter';
import { escapeClearsFilter, taskpaperKeymap } from './editor/keymap';
import { applyOutlineOp } from './editor/outlineEdit';
import { tagClickExtension } from './editor/tagClick';
import { dashClickExtension } from './editor/dashClick';
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
  private applyingExternalData = false;

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
    this.buildEditor();
    this.plugin.lastActiveView = this;
    this.plugin.refreshSidebar();
    this.addAction('filter', 'Filter', () => this.plugin.commands.filter(this));
    this.addAction('x-circle', 'Clear filter / focus', () =>
      this.plugin.commands.clearFocus(this),
    );
    this.addAction('archive', 'Archive done items', () =>
      this.plugin.commands.archiveDone(this),
    );
  }

  async onClose(): Promise<void> {
    this.saveNow();
    this.editor?.destroy();
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
      codeFolding(),
      foldGutter(),
      taskpaperFolding,
      highlightPlugin,
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
