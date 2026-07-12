import { EditorState, Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { codeFolding, indentUnit } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { indentItem, moveItemDown, moveItemUp, outdentItem } from '@taskpaper/core';
import { highlightPlugin } from './highlight';
import { taskpaperFolding } from './folding';
import { filterExtension, setFilterEffect } from './filter';
import { escapeClearsFilter, taskpaperKeymap } from './keymap';
import { applyOutlineOp } from './outlineEdit';
import { tagClickExtension } from './tagClick';
import { dashClickExtension } from './dashClick';
import { indentGuides } from './guides';
import { linkExtension, LinkKind } from './links';
import { tagAutocomplete } from './tagComplete';
import { itemHandles } from './handles';

/**
 * Everything the production extension stack needs from its owning view —
 * settings getters plus the callbacks TaskPaperView used to close over.
 * Extracted so E2E tests can mount the exact stack that ships.
 */
export interface EditorHost {
  /** Whether filters hide (true) or dim (false) non-matching lines. */
  hide(): boolean;
  /** The @done stamp to apply (already formatted per settings). */
  doneStamp(): string;
  /** Show a user-facing warning (a Notice in production). */
  notify(message: string): void;
  /** Record the focused project line (0-based), or clear it with null. */
  setFocusedLine(line: number | null): void;
  /** Refresh filter-dependent UI (the sidebar / status bar). */
  refresh(): void;
  /** Sync the searchbar's text with the active filter. */
  updateSearchbar(): void;
  /** True while setViewData()/clear() is applying external content. */
  applyingExternalData(): boolean;
  /** The document changed through the editor — mirror it and schedule a save. */
  onDocChanged(doc: string): void;
  /** Open a clicked link (http/mailto/scheme/file). */
  openLink(href: string, kind: LinkKind): void;
  /** Whether a [[wikilink]]'s note path resolves to an existing note. */
  resolveWikilink(linkpath: string): boolean;
  /** Open a clicked resolved [[wikilink]] (link text before `|`, e.g. `Note#h`). */
  openWikilink(linktext: string): void;
  /** Persist the current editor content immediately (Cmd-S, blur). */
  saveNow(): void;
  /** Hit-test hook for handle drags over the sidebar (tests inject one —
   *  jsdom's document.elementFromPoint always returns null). */
  elementFromPoint?(x: number, y: number): Element | null;
}

/**
 * The production CodeMirror extension stack for a TaskPaper editor, exactly
 * as TaskPaperView mounts it (same extensions, same order — including the
 * final Escape keymap, which must stay LAST so the search panel's and
 * autocomplete's own Escape bindings win while they are open).
 */
export function createEditorExtensions(host: EditorHost): Extension[] {
  return [
    history(),
    drawSelection(),
    // Cmd/Alt+click adds cursors/ranges — bulk right-click actions then
    // operate on every selected task.
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(4),
    indentUnit.of('\t'),
    // No fold gutter — the item handle dots toggle folds, like the original.
    codeFolding(),
    taskpaperFolding,
    highlightPlugin,
    indentGuides,
    filterExtension,
    itemHandles({
      hide: () => host.hide(),
      onFocus: (line) => {
        host.setFocusedLine(line);
        host.refresh();
      },
      notify: (message) => host.notify(message),
      elementFromPoint: host.elementFromPoint?.bind(host),
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
      hide: () => host.hide(),
      onToggle: () => {
        host.setFocusedLine(null);
        host.refresh();
      },
    }),
    dashClickExtension({
      stamp: () => host.doneStamp(),
      notify: (message) => host.notify(message),
    }),
    linkExtension((href, kind) => host.openLink(href, kind), {
      resolve: (linkpath) => host.resolveWikilink(linkpath),
      open: (linktext) => host.openWikilink(linktext),
    }),
    EditorView.lineWrapping,
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          host.saveNow();
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
        host.saveNow();
        return false;
      },
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !host.applyingExternalData()) {
        host.onDocChanged(update.state.doc.toString());
      }
      // Any filter change (sidebar, tag click, commands, Escape) syncs the bar.
      if (update.transactions.some((tr) => tr.effects.some((e) => e.is(setFilterEffect)))) {
        host.updateSearchbar();
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
          host.setFocusedLine(null);
          v.dispatch({ effects: setFilterEffect.of(null) });
          host.refresh();
          return true;
        },
      },
    ]),
  ];
}
