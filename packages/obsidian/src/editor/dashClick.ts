import { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { toggleDoneLine } from '@taskpaper/core';

export interface DashClickOptions {
  /** The @done stamp to apply (already formatted per settings). */
  stamp(): string;
}

/**
 * Clicking a task's leading dash toggles @done — the original app attaches a
 * `button://toggledone` link to that syntax run. Mousedown so the click
 * doesn't also move the cursor.
 */
export function dashClickExtension(opts: DashClickOptions): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target || event.button !== 0 || !target.closest('.tp-task-dash')) {
        return false;
      }
      const pos = view.posAtDOM(target);
      const line = view.state.doc.lineAt(pos);
      const next = toggleDoneLine(line.text, opts.stamp());
      if (next === line.text) {
        return false;
      }
      event.preventDefault();
      view.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
      return true;
    },
  });
}
