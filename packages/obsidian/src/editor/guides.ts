import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { Outline } from '@taskpaper/core';
import { outlineOf } from './outline';

/** Number of leading tabs on a line. (Pure; testable.) */
export function leadingTabs(lineText: string): number {
  return /^\t*/.exec(lineText)![0].length;
}

/**
 * Guide-line count per document line: every parent with children draws a
 * guide at its level through lines `P.line+1 .. P.subtreeEnd`, so the line
 * runs unbroken through blank/whitespace rows inside the subtree.
 * (Pure; testable.)
 */
export function guideDepths(outline: Outline, lineCount: number): number[] {
  const depths: number[] = new Array(lineCount).fill(0);
  for (const item of outline.items) {
    if (item.children.length === 0) {
      continue;
    }
    const end = Math.min(item.subtreeEnd, lineCount - 1);
    for (let ln = item.line + 1; ln <= end; ln++) {
      depths[ln] = Math.max(depths[ln], item.level + 1);
    }
  }
  return depths;
}

// One cached line decoration per depth; the CSS draws `--tp-guides` vertical
// lines via a repeating gradient on the FULL line block, so consecutive rows
// connect seamlessly (an inline mark's background leaves gaps between rows).
const decoCache = new Map<number, Decoration>();
function lineDeco(depth: number): Decoration {
  let deco = decoCache.get(depth);
  if (!deco) {
    deco = Decoration.line({ attributes: { style: `--tp-guides:${depth}` } });
    decoCache.set(depth, deco);
  }
  return deco;
}

function buildGuides(view: EditorView): DecorationSet {
  const state = view.state;
  const depths = guideDepths(outlineOf(state), state.doc.lines);
  const builder = new RangeSetBuilder<Decoration>();
  for (let ln = 0; ln < depths.length; ln++) {
    if (depths[ln] > 0) {
      const from = state.doc.line(ln + 1).from;
      builder.add(from, from, lineDeco(depths[ln]));
    }
  }
  return builder.finish();
}

export const indentGuides = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildGuides(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildGuides(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
