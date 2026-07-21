import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { isPastDate, Item, parseTags } from '@taskpaper/core';
import { outlineOf, visibleItems } from './outline';

const projectLine = Decoration.line({ class: 'tp-project' });
const doneLine = Decoration.line({ class: 'tp-done' });
const noteLine = Decoration.line({ class: 'tp-note' });
const doneProjectLine = Decoration.line({ class: 'tp-project tp-done' });
const doneNoteLine = Decoration.line({ class: 'tp-note tp-done' });

/** A completed task owns the visual completion state of its whole subtree. */
export function isVisuallyDone(item: Item): boolean {
  let current: Item | null = item;
  while (current) {
    if (current.tags.has('done') && (current === item || current.kind === 'task')) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

// Only the visible ranges are decorated (rebuilt on viewportChanged) — a
// full-document rebuild costs ~17ms per keystroke on a 50k-line file.
function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const outline = outlineOf(view.state);

  for (const item of visibleItems(view, outline)) {
    const line = view.state.doc.line(item.line + 1);
    const done = isVisuallyDone(item);

    if (item.kind === 'project') {
      builder.add(line.from, line.from, done ? doneProjectLine : projectLine);
    } else if (item.kind === 'note') {
      builder.add(line.from, line.from, done ? doneNoteLine : noteLine);
    } else if (done) {
      builder.add(line.from, line.from, doneLine);
    }

    // The task's leading dash is a button: clicking it toggles @done
    // (original TaskPaper attaches button://toggledone to this run).
    if (item.kind === 'task') {
      const indent = /^[\t ]*/.exec(line.text)?.[0].length ?? 0;
      if (line.text[indent] === '-') {
        builder.add(
          line.from + indent,
          line.from + indent + 1,
          Decoration.mark({ class: 'tp-task-dash' }),
        );
      }
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
      } else if (tag.name === 'at') {
        cls += ' tp-tag-at';
      }
      // Two marks per valued tag (TaskPaper 3): clicking the `@name` part
      // searches the tag, clicking the `(value)` part searches tag + value.
      const nameEnd = tag.start + 1 + tag.name.length;
      if (tag.value !== undefined && nameEnd < tag.end) {
        builder.add(
          line.from + tag.start,
          line.from + nameEnd,
          Decoration.mark({ class: cls, attributes: { 'data-tag': tag.name } }),
        );
        builder.add(
          line.from + nameEnd,
          line.from + tag.end,
          Decoration.mark({
            class: cls + ' tp-tag-value',
            attributes: { 'data-tag': tag.name, 'data-tag-value': tag.value },
          }),
        );
      } else {
        builder.add(
          line.from + tag.start,
          line.from + tag.end,
          Decoration.mark({ class: cls, attributes: { 'data-tag': tag.name } }),
        );
      }
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
