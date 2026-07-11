import { EditorState, Text } from '@codemirror/state';
import { buildOutline, Outline } from '@taskpaper/core';

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
  const outline = buildOutline(lines, 4);
  cache.set(doc, outline);
  return outline;
}
