import { EditorView, KeyBinding } from '@codemirror/view';
import { lineKind } from '@taskpaper/core';

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
    view.dispatch({
      changes: { from: sel.head, insert },
      selection: { anchor: sel.head + insert.length },
      scrollIntoView: true,
    });
    return true;
  },
};

export const taskpaperKeymap: KeyBinding[] = [continueTask];
