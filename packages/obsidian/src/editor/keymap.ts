import { EditorState } from '@codemirror/state';
import { EditorView, KeyBinding } from '@codemirror/view';
import { lineKind } from '@taskpaper/core';
import { filterSpecField, isFilterActive, revealNewTaskEffect } from './filter';
import { OUTLINE_TAB_SIZE } from './outline';

/**
 * Whether Escape should clear the active filter/focus (TaskPaper 3: Escape
 * ends the editor search). False lets Escape fall through to other bindings.
 * (Pure; testable.)
 */
export function escapeClearsFilter(state: EditorState): boolean {
  return isFilterActive(state);
}

/** Enter on a task line continues the list with a new `- ` item at the same indent. */
const continueTask: KeyBinding = {
  key: 'Enter',
  run(view: EditorView): boolean {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty) {
      return false;
    }
    const line = state.doc.lineAt(sel.head);
    if (lineKind(line.text) !== 'task') {
      return false;
    }
    const indent = /^[\t ]*/.exec(line.text)?.[0] ?? '';
    const body = line.text.slice(indent.length).replace(/^-\s*/, '');

    // Empty task: pressing Enter ends the list (clear the marker).
    if (body.trim().length === 0) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: indent },
        selection: { anchor: line.from + indent.length },
      });
      return true;
    }

    const insert = `\n${indent}- `;
    const filter = state.field(filterSpecField, false);
    view.dispatch({
      changes: { from: sel.head, insert },
      selection: { anchor: sel.head + insert.length },
      // A blank task does not match a query yet. Keep its new line rendered
      // until the cursor leaves so typing can continue under an active filter.
      effects: filter?.mode === 'query' ? revealNewTaskEffect.of(sel.head + 1) : undefined,
      scrollIntoView: true,
    });
    return true;
  },
};

/**
 * If Backspace at column `col` should do outline-aware deletion instead of
 * deleting one character, return the range to remove (offsets within the
 * line); otherwise null. Two stages: with the `- ` task marker right before
 * the cursor, Backspace deletes the MARKER first (task → note); with only
 * indentation before the cursor it removes one indent level. (Pure; testable.)
 */
export function backspaceUnindentDeletion(
  lineText: string,
  col: number,
  tabSize: number,
): { from: number; to: number } | null {
  const before = lineText.slice(0, col);
  if (!/^[\t ]*(?:- ?)?$/.test(before)) {
    return null;
  }
  const indent = /^[\t ]*/.exec(before)?.[0] ?? '';
  // Stage 1: the `- ` marker sits before the cursor — delete it, keep the
  // indent. Only a REAL marker counts: `- ` complete, or a lone `-` at the
  // end of the line / before whitespace (`-foo` is plain text, not a task).
  if (before.length > indent.length) {
    const isMarker =
      before.endsWith('- ') ||
      col >= lineText.length ||
      lineText[col] === ' ' ||
      lineText[col] === '\t';
    if (!isMarker) {
      return null; // plain text dash — let Backspace delete one character
    }
    return { from: indent.length, to: before.length };
  }
  if (indent.length === 0) {
    return null; // already at the left margin — let Backspace join lines
  }
  // Stage 2: remove one level — a single tab, or up to tabSize trailing spaces.
  if (indent.endsWith('\t')) {
    return { from: indent.length - 1, to: indent.length };
  }
  const spaces = /[ ]*$/.exec(indent)?.[0].length ?? 0;
  return { from: indent.length - Math.min(spaces, tabSize), to: indent.length };
}

/** Backspace at the start of an item's text removes one indent level. */
const backspaceUnindent: KeyBinding = {
  key: 'Backspace',
  run(view: EditorView): boolean {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty) {
      return false;
    }
    const line = state.doc.lineAt(sel.head);
    const del = backspaceUnindentDeletion(line.text, sel.head - line.from, OUTLINE_TAB_SIZE);
    if (!del) {
      return false;
    }
    view.dispatch({
      changes: { from: line.from + del.from, to: line.from + del.to },
      scrollIntoView: true,
    });
    return true;
  },
};

/**
 * Option-Enter inserts a plain newline without auto-formatting (TaskPaper 3:
 * "Press Option-Return to avoid auto-formatting"). We keep the current line's
 * indentation — the item stays at its outline level, consistent with the
 * plain-Enter handler above — but never add a `- ` task marker.
 */
const plainNewline: KeyBinding = {
  key: 'Alt-Enter',
  run(view: EditorView): boolean {
    const { state } = view;
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.from);
    const indent = /^[\t ]*/.exec(line.text)?.[0] ?? '';
    const insert = `\n${indent}`;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + insert.length },
      scrollIntoView: true,
    });
    return true;
  },
};

export const taskpaperKeymap: KeyBinding[] = [continueTask, plainNewline, backspaceUnindent];
