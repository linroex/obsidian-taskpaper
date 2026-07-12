import { EditorState, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { buildOutline, Item, Outline } from '@taskpaper/core';

/** The plugin's fixed outline tab size (also EditorState.tabSize in setup). */
export const OUTLINE_TAB_SIZE = 4;

const cache = new WeakMap<Text, Outline>();

/** Build (and cache) a TaskPaper outline for a CodeMirror document. */
export function outlineOf(state: EditorState): Outline {
  const doc = state.doc;
  const cached = cache.get(doc);
  if (cached) {
    return cached;
  }
  const lines: string[] = [];
  for (let i = 1; i <= doc.lines; i++) {
    lines.push(doc.line(i).text);
  }
  const outline = buildOutline(lines, OUTLINE_TAB_SIZE);
  cache.set(doc, outline);
  return outline;
}


/** Per-outline line→item index, cached so viewport rebuilds stay O(viewport). */
const itemIndexCache = new WeakMap<Outline, Map<number, Item>>();
function itemsByLine(outline: Outline): Map<number, Item> {
  let map = itemIndexCache.get(outline);
  if (!map) {
    map = new Map(outline.items.map((i) => [i.line, i]));
    itemIndexCache.set(outline, map);
  }
  return map;
}

/** Items whose lines intersect the view's visible ranges, in document order
 *  (the whole document when the view has no layout yet, e.g. headless). */
export function visibleItems(view: EditorView, outline: Outline): Item[] {
  const byLine = itemsByLine(outline);
  const ranges = view.visibleRanges;
  if (ranges.length === 0) {
    return outline.items;
  }
  const out: Item[] = [];
  const seen = new Set<number>();
  for (const { from, to } of ranges) {
    const first = view.state.doc.lineAt(from).number - 1;
    const last = view.state.doc.lineAt(to).number - 1;
    for (let ln = first; ln <= last; ln++) {
      const item = byLine.get(ln);
      if (item && !seen.has(ln)) {
        seen.add(ln);
        out.push(item);
      }
    }
  }
  return out;
}
