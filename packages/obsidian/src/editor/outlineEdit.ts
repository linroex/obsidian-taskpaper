import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { OutlineEdit } from '@taskpaper/core';
import { OUTLINE_TAB_SIZE } from './outline';
import { visibleLineSet } from './filter';

type Op = (lines: string[], line: number, tabSize: number) => OutlineEdit | null;

/** A move operation that reorders relative to the visible outline when a hide
 *  filter restricts what's on screen. */
type MoveOp = (
  lines: string[],
  line: number,
  tabSize: number,
  visible?: Set<number>,
) => OutlineEdit | null;

/** The document as an array of line strings. */
export function docLines(state: EditorState): string[] {
  const lines: string[] = [];
  for (let i = 1; i <= state.doc.lines; i++) {
    lines.push(state.doc.line(i).text);
  }
  return lines;
}

/** Replace the document with an outline edit's lines, placing the cursor. */
export function dispatchOutlineEdit(view: EditorView, result: OutlineEdit, col = 0): void {
  const state = view.state;
  const br = state.lineBreak;
  const text = result.lines.join(br);
  let offset = 0;
  for (let i = 0; i < result.cursorLine; i++) {
    offset += result.lines[i].length + br.length;
  }
  const lineLen = (result.lines[result.cursorLine] ?? '').length;
  const target = offset + Math.min(result.cursorCol ?? col, lineLen);

  view.dispatch({
    changes: { from: 0, to: state.doc.length, insert: text },
    selection: EditorSelection.cursor(target),
    scrollIntoView: true,
  });
}

/** Apply a core outline operation (move/indent) to the editor, updating the cursor. */
export function applyOutlineOp(view: EditorView, op: Op): boolean {
  const state = view.state;
  const curLine = state.doc.lineAt(state.selection.main.head);
  const col = state.selection.main.head - curLine.from;

  const result = op(docLines(state), curLine.number - 1, OUTLINE_TAB_SIZE);
  if (!result) {
    return false;
  }
  dispatchOutlineEdit(view, result, col);
  return true;
}

/**
 * Apply an outline MOVE, restricting it to the visible outline whenever a hide
 * filter is active — so alt+up/down steps over hidden siblings instead of
 * swapping with one (which would leave the on-screen order unchanged).
 */
export function applyMoveOp(view: EditorView, move: MoveOp): boolean {
  const visible = visibleLineSet(view.state) ?? undefined;
  return applyOutlineOp(view, (lines, line, tabSize) => move(lines, line, tabSize, visible));
}
