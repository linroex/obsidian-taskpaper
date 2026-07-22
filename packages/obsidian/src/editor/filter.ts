import {
  EditorSelection,
  EditorState,
  MapMode,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
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

/**
 * A hide filter renders non-matching lines as zero-height blocks, so two
 * VISIBLE lines can be document-separated by hidden ones: Backspace at the
 * start of a visible line would join it into a hidden line, a selection
 * between visually adjacent lines silently spans (and deletes) everything
 * hidden in between, and forward-Delete at a line end pulls a hidden line up.
 * Trim user-initiated edits (typing, deleting, pasting, drag-drop) so they
 * only ever remove visible text; the separator newlines on both sides of a
 * hidden run are protected too, keeping hidden content on its own lines.
 * Programmatic operations (archive, outline moves, undo) pass through.
 */
const protectHiddenEdits = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) {
    return tr;
  }
  if (!tr.isUserEvent('delete') && !tr.isUserEvent('input') && !tr.isUserEvent('move')) {
    return tr;
  }
  const spec = tr.startState.field(filterSpecField, false);
  if (!spec || !spec.hide) {
    return tr;
  }
  // Hidden runs, each extended one position left to cover the newline that
  // separates it from the visible line above.
  const hidden: { from: number; to: number }[] = [];
  tr.startState.field(filterDecoField).between(0, tr.startState.doc.length, (from, to) => {
    if (to > from) {
      hidden.push({ from: Math.max(0, from - 1), to });
    }
  });
  if (hidden.length === 0) {
    return tr;
  }

  let touched = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (toA > fromA && hidden.some((h) => fromA < h.to && toA > h.from)) {
      touched = true;
    }
  });
  if (!touched) {
    return tr;
  }

  const changes: { from: number; to?: number; insert?: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (inserted.length > 0) {
      changes.push({ from: fromA, insert: inserted.toString() });
    }
    let pos = fromA;
    for (const h of hidden) {
      if (h.to <= pos || h.from >= toA) {
        continue;
      }
      if (h.from > pos) {
        changes.push({ from: pos, to: h.from });
      }
      pos = Math.max(pos, h.to);
    }
    if (pos < toA) {
      changes.push({ from: pos, to: toA });
    }
  });
  if (changes.length === 0) {
    return []; // the whole edit targeted hidden text — cancel it
  }

  const changeSet = tr.startState.changes(changes);
  const cursor = changeSet.mapPos(tr.startState.selection.main.from, 1);
  const userEvent = tr.annotation(Transaction.userEvent);
  return {
    changes,
    selection: EditorSelection.cursor(cursor),
    effects: tr.effects,
    annotations: userEvent ? Transaction.userEvent.of(userEvent) : undefined,
    scrollIntoView: true,
  };
});

/**
 * Cursor motion treats hidden runs as atomic, so arrow keys hop across them
 * instead of parking the cursor (and subsequent typing) inside invisible
 * text. Each run is extended one position left over its separator newline:
 * atomic skipping only moves positions strictly INSIDE a range, so without
 * the extension the cursor could stop at a hidden line's start and type into
 * it. Deletion is NOT left to the atomic-range machinery — it would delete a
 * whole hidden run in one keypress; protectHiddenEdits above trims those
 * edits instead (the two use the same extended spans, so they agree).
 * Dim-mode line decorations are zero-length and never produce atoms.
 */
const hiddenAtomicRanges = EditorView.atomicRanges.of((view) => {
  const builder = new RangeSetBuilder<Decoration>();
  view.state.field(filterDecoField).between(0, view.state.doc.length, (from, to) => {
    if (to > from) {
      builder.add(Math.max(0, from - 1), to, hideBlock);
    }
  });
  return builder.finish();
});

/** The fields, in dependency order (spec and temporary reveal before deco). */
export const filterExtension = [
  filterSpecField,
  revealedTaskField,
  filterDecoField,
  protectHiddenEdits,
  hiddenAtomicRanges,
];

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
