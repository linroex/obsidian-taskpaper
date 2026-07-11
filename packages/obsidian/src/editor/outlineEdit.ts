import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { OutlineEdit } from '@taskpaper/core';

type Op = (lines: string[], line: number, tabSize: number) => OutlineEdit | null;

/** Apply a core outline operation (move/indent) to the editor, updating the cursor. */
export function applyOutlineOp(view: EditorView, op: Op): boolean {
  const state = view.state;
  const lines: string[] = [];
  for (let i = 1; i <= state.doc.lines; i++) {
    lines.push(state.doc.line(i).text);
  }
  const curLine = state.doc.lineAt(state.selection.main.head);
  const col = state.selection.main.head - curLine.from;

  const result = op(lines, curLine.number - 1, 4);
  if (!result) {
    return false;
  }

  const br = state.lineBreak;
  const text = result.lines.join(br);
  let offset = 0;
  for (let i = 0; i < result.cursorLine; i++) {
    offset += result.lines[i].length + br.length;
  }
  const target = offset + Math.min(col, (result.lines[result.cursorLine] ?? '').length);

  view.dispatch({
    changes: { from: 0, to: state.doc.length, insert: text },
    selection: EditorSelection.cursor(target),
    scrollIntoView: true,
  });
  return true;
}
