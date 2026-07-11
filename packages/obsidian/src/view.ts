import { TextFileView, WorkspaceLeaf } from 'obsidian';
import { EditorState, Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { codeFolding, foldGutter, indentUnit } from '@codemirror/language';
import { indentItem, moveItemDown, moveItemUp, outdentItem } from '@taskpaper/core';
import { highlightPlugin } from './editor/highlight';
import { taskpaperFolding } from './editor/folding';
import { filterExtension, setFilterEffect } from './editor/filter';
import { taskpaperKeymap } from './editor/keymap';
import { applyOutlineOp } from './editor/outlineEdit';
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
