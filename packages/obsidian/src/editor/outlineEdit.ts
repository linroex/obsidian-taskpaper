import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { OutlineEdit } from '@taskpaper/core';

type Op = (lines: string[], line: number, tabSize: number) => OutlineEdit | null;

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

  const result = op(docLines(state), curLine.number - 1, 4);
  if (!result) {
    return false;
  }
  dispatchOutlineEdit(view, result, col);
  return true;
}
