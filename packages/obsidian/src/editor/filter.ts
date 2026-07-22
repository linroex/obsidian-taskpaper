import {
  EditorState,
  MapMode,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { filterContextItems, runQuery } from '@taskpaper/core';
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
 * Temporarily keep one newly-created line (task or note) visible while it is
 * being edited. The value is a document offset on the new line, in the
 * post-change document.
 */
export const revealNewTaskEffect = StateEffect.define<number>();

/**
 * What the searchbar should display for the active filter: the query text,
 * a readable `project "Name"` for line-based focus (`project "Name"//*` when
 * the project is hoisted — only its contents shown), or null when no filter
 * is active (bar hidden). (Pure; testable.)
 */
export function searchbarText(
  spec: FilterSpec | null,
  focusedProjectName: string | null,
  hoisted = false,
): string | null {
  if (!spec) {
    return null;
  }
  if (spec.mode === 'query') {
    return spec.query;
  }
  if (!focusedProjectName) {
    return '';
  }
  return hoisted ? `project "${focusedProjectName}"//*` : `project "${focusedProjectName}"`;
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

/**
 * Query filters normally hide a blank task immediately because it cannot match
 * yet. Remember every line the user created under the current filter so their
 * work stays on screen for the whole filter session — a freshly typed item
 * that does not (yet) match the query must not vanish the moment the cursor
 * leaves it. The set resets when the filter changes; positions deleted from
 * the document drop out on their own.
 */
const revealedTaskField = StateField.define<readonly number[]>({
  create() {
    return [];
  },
  update(value, tr) {
    let next: readonly number[] = value;
    if (tr.docChanged && value.length > 0) {
      const mapped: number[] = [];
      for (const pos of value) {
        const m = tr.changes.mapPos(pos, -1, MapMode.TrackDel);
        if (m !== null) {
          mapped.push(m);
        }
      }
      next = mapped;
    }

    for (const e of tr.effects) {
      if (e.is(setFilterEffect)) {
        next = [];
      }
      if (e.is(revealNewTaskEffect)) {
        next = [...next, e.value];
      }
    }

    const spec = tr.state.field(filterSpecField);
    if (!spec || spec.mode !== 'query') {
      // Keep the empty-array identity stable so the deco field sees no change.
      return value.length === 0 ? value : [];
    }
    return next;
  },
});

/** Decorations that hide/dim non-matching lines; recomputed on filter or edit. */
export const filterDecoField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    const hadEffect = tr.effects.some((e) => e.is(setFilterEffect));
    const revealedTaskChanged =
      tr.startState.field(revealedTaskField) !== tr.state.field(revealedTaskField);
    const spec = tr.state.field(filterSpecField);
    if (hadEffect || revealedTaskChanged) {
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

/** The fields, in dependency order (spec and temporary reveal before deco). */
export const filterExtension = [filterSpecField, revealedTaskField, filterDecoField];

export function isFilterActive(state: EditorState): boolean {
  return state.field(filterSpecField, false) != null;
}

function buildFilterDeco(state: EditorState, spec: FilterSpec): DecorationSet {
  let visible: Set<number>;
  if (spec.mode === 'focus') {
    visible = new Set(spec.visible);
  } else {
    try {
      const matches = runQuery(spec.query, outlineOf(state));
      visible = new Set<number>();
      for (const m of matches) {
        for (const item of filterContextItems(m)) {
          visible.add(item.line); // 0-based
        }
      }
    } catch {
      return Decoration.none;
    }
  }

  for (const revealed of state.field(revealedTaskField)) {
    visible.add(state.doc.lineAt(Math.min(revealed, state.doc.length)).number - 1);
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
