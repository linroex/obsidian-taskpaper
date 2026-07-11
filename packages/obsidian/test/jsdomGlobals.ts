/**
 * Boots a jsdom window and installs the globals CodeMirror 6 needs, BEFORE
 * any @codemirror module body runs (@codemirror/view captures `document` /
 * `navigator` at import time for browser detection). Import this module
 * FIRST from the e2e entry point — esbuild executes module bodies in import
 * order, and this file deliberately has no CodeMirror imports.
 *
 * jsdom has no layout engine, so the measuring APIs CM6 relies on are
 * patched to return zero-rects: Range#getClientRects/getBoundingClientRect
 * (text measurement), Element#getClientRects, and document.elementFromPoint
 * (posAtCoords probing). ResizeObserver and requestAnimationFrame are
 * stubbed — rAF as setTimeout, so CM's async measure cycle never blocks the
 * synchronous test run.
 */
import { JSDOM } from 'jsdom';
import { installDomHelpers } from './stubs/obsidian';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://taskpaper.test/',
});
const win = dom.window;

// ---- layout patches (jsdom cannot measure; zero-rects keep CM6 happy) ----

function zeroRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function rectList(): DOMRectList {
  const rect = zeroRect();
  const list = [rect] as unknown as DOMRectList & { item(i: number): DOMRect | null };
  list.item = (i: number) => (i === 0 ? rect : null);
  return list;
}

win.Range.prototype.getBoundingClientRect = zeroRect;
win.Range.prototype.getClientRects = rectList;
win.Element.prototype.getBoundingClientRect = zeroRect;
win.Element.prototype.getClientRects = rectList;
win.document.elementFromPoint = () => null;

// jsdom lacks these entirely.
(win as unknown as Record<string, unknown>).ResizeObserver = class ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
win.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0)) as unknown as typeof win.requestAnimationFrame;
win.cancelAnimationFrame = ((handle: number) =>
  clearTimeout(handle)) as unknown as typeof win.cancelAnimationFrame;

// Obsidian augments HTMLElement.prototype (createDiv/empty/addClass/…).
installDomHelpers(win as unknown as { HTMLElement: typeof HTMLElement });

// ---- copy everything CM6 (and plugin code) references bare into node ----

const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame,
  cancelAnimationFrame: win.cancelAnimationFrame,
  MutationObserver: win.MutationObserver,
  ResizeObserver: (win as unknown as Record<string, unknown>).ResizeObserver,
  Node: win.Node,
  Text: win.Text,
  Element: win.Element,
  HTMLElement: win.HTMLElement,
  HTMLInputElement: win.HTMLInputElement,
  Document: win.Document,
  DocumentFragment: win.DocumentFragment,
  Range: win.Range,
  Selection: win.Selection,
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  UIEvent: win.UIEvent,
  InputEvent: win.InputEvent,
  FocusEvent: win.FocusEvent,
  MouseEvent: win.MouseEvent,
  KeyboardEvent: win.KeyboardEvent,
  DOMParser: win.DOMParser,
};

for (const [name, value] of Object.entries(globals)) {
  // defineProperty, because node ships some of these (navigator) as
  // read-only accessors that plain assignment cannot replace.
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
