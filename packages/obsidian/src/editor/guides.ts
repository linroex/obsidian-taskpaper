import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

/** Number of leading tabs on a line — each becomes a guide column. (Pure; testable.) */
export function leadingTabs(lineText: string): number {
  return /^\t*/.exec(lineText)![0].length;
}

const guideMark = Decoration.mark({ class: 'tp-guide' });

/**
 * Vertical guide lines, one per outline level: every leading tab renders a
 * thin line at its left edge (via CSS background, so layout is untouched).
 * Consecutive indented lines connect into the original app's child guides.
 */
function buildGuides(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const tabs = leadingTabs(line.text);
      for (let i = 0; i < tabs; i++) {
        builder.add(line.from + i, line.from + i + 1, guideMark);
      }
      pos = line.to + 1;
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
