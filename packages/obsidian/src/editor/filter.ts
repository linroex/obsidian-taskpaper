import { EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { attachedNotes, runQuery, withAncestors } from '@taskpaper/core';
import { outlineOf } from './outline';

export type FilterSpec =
  | {
      /** Filter by a query; recomputed live as the document is edited. */
      mode: 'query';
      query: string;
      /** true = hide non-matching lines entirely; false = dim them. */
      hide: boolean;
    }
  | {
      /** Focus an explicit set of lines (e.g. a project's subtree). */
      mode: 'focus';
      visible: Set<number>;
      hide: boolean;
    };

/** Dispatch with a spec to apply a filter, or `null` to clear it. */
export const setFilterEffect = StateEffect.define<FilterSpec | null>();

/**
 * What the searchbar should display for the active filter: the query text,
 * a readable `project "Name"` for line-based focus, or null when no filter
 * is active (bar hidden). (Pure; testable.)
 */
export function searchbarText(
  spec: FilterSpec | null,
  focusedProjectName: string | null,
): string | null {
  if (!spec) {
    return null;
  }
  if (spec.mode === 'query') {
    return spec.query;
  }
  return focusedProjectName ? `project "${focusedProjectName}"` : '';
}

const dimLine = Decoration.line({ class: 'tp-dim' });
const hideBlock = Decoration.replace({ block: true });

/** Holds the active filter spec (null when no filter is active). */
export const filterSpecField = StateField.define<FilterSpec | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFilterEffect)) {
        return e.value;
      }
    }
    return value;
  },
});

/** Decorations that hide/dim non-matching lines; recomputed on filter or edit. */
export const filterDecoField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    const hadEffect = tr.effects.some((e) => e.is(setFilterEffect));
    const spec = tr.state.field(filterSpecField);
    if (hadEffect) {
      return spec ? buildFilterDeco(tr.state, spec) : Decoration.none;
    }
    // Query filters recompute on edit; focus filters keep their positions (mapped).
    if (tr.docChanged && spec && spec.mode === 'query') {
      return buildFilterDeco(tr.state, spec);
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The two fields, in dependency order (spec before deco). */
export const filterExtension = [filterSpecField, filterDecoField];

export function isFilterActive(state: EditorState): boolean {
  return state.field(filterSpecField, false) != null;
}

function buildFilterDeco(state: EditorState, spec: FilterSpec): DecorationSet {
  let visible: Set<number>;
  if (spec.mode === 'focus') {
    visible = spec.visible;
  } else {
    try {
      const matches = runQuery(spec.query, outlineOf(state));
      visible = new Set<number>();
      for (const m of matches) {
        for (const a of withAncestors(m)) {
          visible.add(a.line); // 0-based
        }
        // A match brings its attached notes along (they belong to the item).
        for (const n of attachedNotes(m)) {
          visible.add(n.line);
        }
      }
    } catch {
      return Decoration.none;
    }
  }

  const builder = new RangeSetBuilder<Decoration>();
  const total = state.doc.lines;

  if (spec.hide) {
    let runStart = -1; // 1-based line where the current hidden run begins
    const flush = (fromLine: number, toLine: number) => {
      const from = state.doc.line(fromLine).from;
      const to =
        toLine < total ? state.doc.line(toLine + 1).from : state.doc.line(toLine).to;
      builder.add(from, to, hideBlock);
    };
    for (let ln = 1; ln <= total; ln++) {
      if (!visible.has(ln - 1)) {
        if (runStart === -1) {
          runStart = ln;
        }
      } else if (runStart !== -1) {
        flush(runStart, ln - 1);
        runStart = -1;
      }
    }
    if (runStart !== -1) {
      flush(runStart, total);
    }
  } else {
    for (let ln = 1; ln <= total; ln++) {
      if (!visible.has(ln - 1)) {
        const from = state.doc.line(ln).from;
        builder.add(from, from, dimLine);
      }
    }
  }

  return builder.finish();
}
