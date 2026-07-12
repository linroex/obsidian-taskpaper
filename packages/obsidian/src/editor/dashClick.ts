import { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { toggleDoneAtLines } from './toggleDone';

export interface DashClickOptions {
  /** The @done stamp to apply (already formatted per settings). */
  stamp(): string;
  /** Show a user-facing warning (a Notice in production). */
  notify(message: string): void;
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
      if (!toggleDoneAtLines(view, [line.number - 1], opts.stamp(), opts.notify)) {
        return false;
      }
      event.preventDefault();
      return true;
    },
  });
}
