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
  // Linear sweep with a stack of open parents (a per-parent subtree scan
  // would be quadratic on deep outlines). Open parents form a chain with
  // levels 0..top.level, so the guide count is top.level + 1.
  const stack: { level: number; subtreeEnd: number }[] = [];
  let idx = 0;
  for (let ln = 0; ln < lineCount; ln++) {
    while (stack.length > 0 && stack[stack.length - 1].subtreeEnd < ln) {
      stack.pop();
    }
    if (stack.length > 0) {
      depths[ln] = stack[stack.length - 1].level + 1;
    }
    while (idx < outline.items.length && outline.items[idx].line === ln) {
      const item = outline.items[idx++];
      if (item.children.length > 0) {
        stack.push({ level: item.level, subtreeEnd: item.subtreeEnd });
      }
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
  // Depth computation is cheap (linear sweep); only the DECORATIONS are
  // limited to the viewport, keeping per-keystroke cost constant.
  const ranges = view.visibleRanges.length > 0 ? view.visibleRanges : [{ from: 0, to: state.doc.length }];
  let last = -1;
  for (const { from, to } of ranges) {
    const first = Math.max(state.doc.lineAt(from).number - 1, last + 1);
    const end = state.doc.lineAt(to).number - 1;
    for (let ln = first; ln <= end; ln++) {
      if (depths[ln] > 0) {
        builder.add(state.doc.line(ln + 1).from, state.doc.line(ln + 1).from, lineDeco(depths[ln]));
      }
      last = ln;
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
