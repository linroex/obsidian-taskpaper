/**
 * Copy Displayed (original Edit > Copy Displayed): copies the lines the
 * editor is currently showing — with an active hide-filter/focus that is
 * only the visible lines; with no filter (or a dim-only filter, where every
 * line is still on screen) it is the whole document.
 */
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { filterDecoField } from './filter';

/** 1-based line numbers covered by the filter's hidden (block) runs. */
function hiddenFilterLines(state: EditorState): Set<number> {
  const hidden = new Set<number>();
  const deco = state.field(filterDecoField, false);
  if (!deco) {
    return hidden;
  }
  deco.between(0, state.doc.length, (from, to, value) => {
    // Dim mode uses zero-length line decorations — only block replace
    // decorations actually hide lines.
    if (!(value as Decoration).spec.block) {
      return;
    }
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(Math.max(from, to - 1)).number;
    for (let n = first; n <= last; n++) {
      hidden.add(n);
    }
  });
  return hidden;
}

/** The displayed document text: every line not hidden by the active filter. */
export function visibleDocText(state: EditorState): string {
  const hidden = hiddenFilterLines(state);
  const out: string[] = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    if (!hidden.has(n)) {
      out.push(state.doc.line(n).text);
    }
  }
  return out.join(state.lineBreak);
}

/** Write text to the system clipboard, falling back to a hidden textarea +
 *  execCommand('copy') where the async clipboard API is unavailable. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea fallback
  }
  // Fallback: hidden textarea + execCommand. Restore focus and always remove
  // the textarea, even when copying throws.
  const previous = document.activeElement;
  const ta = document.createElement('textarea');
  try {
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    if (previous instanceof HTMLElement) {
      previous.focus();
    }
  }
}

/** Copy the currently visible lines as TaskPaper text. */
export function copyDisplayed(view: EditorView): Promise<boolean> {
  return copyTextToClipboard(visibleDocText(view.state));
}
