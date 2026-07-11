import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { isPastDate, parseTags } from '@taskpaper/core';
import { outlineOf } from './outline';

const projectLine = Decoration.line({ class: 'tp-project' });
const doneLine = Decoration.line({ class: 'tp-done' });
const noteLine = Decoration.line({ class: 'tp-note' });

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const outline = outlineOf(view.state);

  for (const item of outline.items) {
    const line = view.state.doc.line(item.line + 1);
    const done = item.tags.has('done');

    if (item.kind === 'project') {
      builder.add(line.from, line.from, projectLine);
    } else if (done) {
      builder.add(line.from, line.from, doneLine);
    } else if (item.kind === 'note') {
      builder.add(line.from, line.from, noteLine);
    }

    for (const tag of parseTags(line.text)) {
      let cls = 'tp-tag';
      if (tag.name === 'done') {
        cls += ' tp-tag-done';
      } else if (tag.name === 'today') {
        cls += ' tp-tag-today';
      } else if (tag.name === 'due') {
        cls += ' tp-tag-due';
        if (!done && tag.value && isPastDate(tag.value)) {
          cls += ' tp-tag-overdue';
        }
      }
      builder.add(
        line.from + tag.start,
        line.from + tag.end,
        Decoration.mark({ class: cls, attributes: { 'data-tag': tag.name } }),
      );
    }
  }

  return builder.finish();
}

/** Syntax highlighting for TaskPaper, driven by the shared outline model. */
export const highlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
