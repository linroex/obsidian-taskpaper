/**
 * The one shared done-toggle path: the toggle-done command, the context menu
 * and the dash click all route through here, so @repeat successors always
 * spawn in the SAME transaction as the @done stamp (one undo reverts both).
 */
import { ChangeSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { planToggleDone } from '@taskpaper/core';
import { OUTLINE_TAB_SIZE } from './outline';
import { docLines } from './outlineEdit';

/**
 * Toggle @done on the given 0-based lines against the current document,
 * applying every change and @repeat successor insert in one dispatch.
 * Returns true when the document changed.
 */
export function toggleDoneAtLines(
  editor: EditorView,
  lineNumbers: number[],
  stamp: string,
  notify: (message: string) => void,
): boolean {
  const state = editor.state;
  const plan = planToggleDone(docLines(state), lineNumbers, { stamp, tabSize: OUTLINE_TAB_SIZE });
  const changes: ChangeSpec[] = plan.changes.map((c) => {
    const line = state.doc.line(c.line + 1);
    return { from: line.from, to: line.to, insert: c.text };
  });
  for (const ins of plan.inserts) {
    changes.push({
      from: state.doc.line(ins.afterLine + 1).to,
      insert: state.lineBreak + ins.text,
    });
  }
  for (const message of plan.notices) {
    notify(message);
  }
  if (changes.length === 0) {
    return false;
  }
  editor.dispatch({ changes });
  return true;
}

/** Toggle @done on every non-blank line touched by the selection. */
export function toggleDoneSelection(
  editor: EditorView,
  stamp: string,
  notify: (message: string) => void,
): void {
  const state = editor.state;
  const lines: number[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number;
    const endLine = state.doc.lineAt(range.to).number;
    for (let n = startLine; n <= endLine; n++) {
      if (!seen.has(n)) {
        seen.add(n);
        lines.push(n - 1);
      }
    }
  }
  toggleDoneAtLines(editor, lines, stamp, notify);
}
