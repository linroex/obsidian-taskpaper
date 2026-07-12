/**
 * jsdom harness for real-EditorView E2E tests: mounts the SAME extension
 * stack production uses (createEditorExtensions), dispatches real DOM
 * events, and offers query helpers over the document/DOM.
 *
 * The jsdom globals must exist before @codemirror/view loads — hence the
 * './jsdomGlobals' import is first.
 */
import './jsdomGlobals';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createEditorExtensions, EditorHost } from '../src/editor/setup';
import { filterDecoField } from '../src/editor/filter';
import type { LinkKind } from '../src/editor/links';

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/** An EditorHost that records every callback, for assertions. */
export interface RecordingHost extends EditorHost {
  /** Every focus line passed to setFocusedLine (null = cleared). */
  focusLines: (number | null)[];
  /** How many times refresh() (sidebar refresh) ran. */
  refreshes: number;
  /** How many times updateSearchbar() ran (one per filter effect). */
  searchbarUpdates: number;
  /** Every document text passed to onDocChanged. */
  docChanges: string[];
  /** Every link opened. */
  openedLinks: { href: string; kind: LinkKind }[];
  /** Every wikilink opened (link text before `|`, e.g. `Note#h`). */
  openedWikilinks: string[];
  /** How many times saveNow() ran (Mod-S / blur). */
  saves: number;
}

export interface MountedEditor {
  view: EditorView;
  host: RecordingHost;
  cleanup(): void;
}

/** Mount a real EditorView with the production extension stack under jsdom. */
export function mountEditor(
  docText: string,
  hostOverrides: Partial<RecordingHost> = {},
): MountedEditor {
  const host: RecordingHost = {
    focusLines: [],
    refreshes: 0,
    searchbarUpdates: 0,
    docChanges: [],
    openedLinks: [],
    openedWikilinks: [],
    saves: 0,
    hide: () => true,
    doneStamp: () => '2026-01-02',
    setFocusedLine(line) {
      this.focusLines.push(line);
    },
    refresh() {
      this.refreshes++;
    },
    updateSearchbar() {
      this.searchbarUpdates++;
    },
    applyingExternalData: () => false,
    onDocChanged(doc) {
      this.docChanges.push(doc);
    },
    openLink(href, kind) {
      this.openedLinks.push({ href, kind });
    },
    // Default: nothing resolves — tests that need resolved wikilinks override.
    resolveWikilink: () => false,
    openWikilink(linktext) {
      this.openedWikilinks.push(linktext);
    },
    saveNow() {
      this.saves++;
    },
    ...hostOverrides,
  };

  const view = new EditorView({
    state: EditorState.create({ doc: docText, extensions: createEditorExtensions(host) }),
    parent: document.body,
  });

  return {
    view,
    host,
    cleanup: () => {
      view.destroy();
      view.dom.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Event helpers (real DOM events, bubbling like the browser's)
// ---------------------------------------------------------------------------

function mouseInit(opts: MouseEventInit = {}): MouseEventInit {
  return { bubbles: true, cancelable: true, view: window, button: 0, ...opts };
}

/** Dispatch a full mousedown→mouseup→click gesture on an element. */
export function clickEl(el: Element, opts: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent('mousedown', mouseInit(opts)));
  el.dispatchEvent(new MouseEvent('mouseup', mouseInit(opts)));
  el.dispatchEvent(new MouseEvent('click', mouseInit(opts)));
}

/** Dispatch a mousedown on the DOM element rendering document position `pos`. */
export function mousedownAt(view: EditorView, pos: number, opts: MouseEventInit = {}): void {
  const { node } = view.domAtPos(pos);
  const el = node instanceof HTMLElement ? node : node.parentElement;
  if (!el) {
    throw new Error(`no element at pos ${pos}`);
  }
  el.dispatchEvent(new MouseEvent('mousedown', mouseInit(opts)));
}

export interface KeyMods {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ' ': 32,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

/**
 * Dispatch a real keydown through view.contentDOM (where CM's keymaps
 * listen). Returns true when some binding handled it (defaultPrevented).
 */
export function press(view: EditorView, key: string, mods: KeyMods = {}): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    keyCode: KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0),
    bubbles: true,
    cancelable: true,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
  } as KeyboardEventInit);
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * Type text like a user: each character first goes through keydown (so
 * keymaps can intercept), then — as the browser would on an unhandled key —
 * is inserted at the selection. jsdom cannot synthesize the contenteditable
 * beforeinput/MutationObserver pipeline CM normally reads, so the insertion
 * step is a dispatch; the keymap path stays fully real.
 */
export function type(view: EditorView, text: string): void {
  for (const ch of text) {
    if (ch === '\n') {
      if (!press(view, 'Enter')) {
        view.dispatch(view.state.replaceSelection('\n'), { userEvent: 'input.type' });
      }
      continue;
    }
    if (!press(view, ch)) {
      view.dispatch(view.state.replaceSelection(ch), { userEvent: 'input.type' });
    }
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** The current document text. */
export function docText(view: EditorView): string {
  return view.state.doc.toString();
}

/** 1-based line numbers hidden by the active filter's block decorations. */
export function hiddenLineNumbers(view: EditorView): Set<number> {
  const hidden = new Set<number>();
  const deco = view.state.field(filterDecoField);
  deco.between(0, view.state.doc.length, (from, to) => {
    const first = view.state.doc.lineAt(from).number;
    const last = view.state.doc.lineAt(Math.max(from, to - 1)).number;
    for (let n = first; n <= last; n++) {
      hidden.add(n);
    }
  });
  return hidden;
}

/** All rendered DOM elements carrying the given decoration class. */
export function findMark(view: EditorView, cls: string): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll<HTMLElement>(`.${cls}`));
}
