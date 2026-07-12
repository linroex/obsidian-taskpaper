/**
 * Select Branch / Expand Selection / Contract Selection on an EditorView
 * (original Edit > Selection). The pure range math lives in @taskpaper/core
 * (selectBranchRange / expandSelectionRange); this module translates between
 * document offsets and {line, col} pairs and keeps the per-view expand
 * history that Contract Selection unwinds.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { expandSelectionRange, selectBranchRange, SelectionRange } from '@taskpaper/core';
import { docLines } from './outlineEdit';

interface OffsetRange {
  anchor: number;
  head: number;
}

interface ExpandStep {
  before: OffsetRange;
  after: OffsetRange;
  /** The document the step was computed on — edits invalidate the step
   *  (offsets in a changed document would restore stale ranges). */
  doc: unknown;
}

/**
 * Per-view stack of expand steps. Contract Selection pops the last step and
 * restores its `before` range — but only while the current selection is still
 * the step's `after` (any manual selection or edit invalidates the history).
 */
const expandStacks = new WeakMap<EditorView, ExpandStep[]>();

/** The main selection as a 0-based {line, col} range. A selection ending at
 *  column 0 of a later line is normalized to end at the previous line's end,
 *  the way full-line selections are usually made. */
function currentSelRange(state: EditorState): SelectionRange {
  const main = state.selection.main;
  const fromLine = state.doc.lineAt(main.from);
  const toLine = state.doc.lineAt(main.to);
  let endLine = toLine.number - 1;
  let endCol = main.to - toLine.from;
  if (endCol === 0 && endLine > fromLine.number - 1) {
    endLine--;
    endCol = state.doc.line(endLine + 1).length;
  }
  return {
    startLine: fromLine.number - 1,
    startCol: main.from - fromLine.from,
    endLine,
    endCol,
  };
}

function toOffsets(state: EditorState, range: SelectionRange): OffsetRange {
  return {
    anchor: state.doc.line(range.startLine + 1).from + range.startCol,
    head: state.doc.line(range.endLine + 1).from + range.endCol,
  };
}

/** Every selection range as a merged, ascending list of 0-based line spans —
 *  multi-cursor selections operate on each span, not the min..max hull. */
export function selectedLineRanges(state: EditorState): Array<[number, number]> {
  const spans = state.selection.ranges
    .map((r): [number, number] => [
      state.doc.lineAt(r.from).number - 1,
      state.doc.lineAt(r.to).number - 1,
    ])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], span[1]);
    } else {
      merged.push([span[0], span[1]]);
    }
  }
  return merged;
}

function dispatchRange(view: EditorView, range: OffsetRange): void {
  view.dispatch({
    selection: EditorSelection.range(range.anchor, range.head),
    scrollIntoView: true,
  });
}

/** Select the covering item's whole branch (item + subtree lines). */
export function selectBranch(view: EditorView): boolean {
  const state = view.state;
  const cur = currentSelRange(state);
  const range = selectBranchRange(docLines(state), state.tabSize, cur.startLine, cur.endLine);
  if (!range) {
    return false;
  }
  dispatchRange(view, toOffsets(state, range));
  return true;
}

/** One step of Expand Selection (word → line → branch → … → document). */
export function expandSelection(view: EditorView): boolean {
  const state = view.state;
  const main = state.selection.main;
  const range = expandSelectionRange(docLines(state), state.tabSize, currentSelRange(state));
  if (!range) {
    return false;
  }
  const after = toOffsets(state, range);
  const stack = expandStacks.get(view) ?? [];
  stack.push({ before: { anchor: main.anchor, head: main.head }, after, doc: state.doc });
  expandStacks.set(view, stack);
  dispatchRange(view, after);
  return true;
}

/** Undo the last Expand Selection step (only while its result is still selected). */
export function contractSelection(view: EditorView): boolean {
  const stack = expandStacks.get(view) ?? [];
  const main = view.state.selection.main;
  const top = stack[stack.length - 1];
  if (!top || top.doc !== view.state.doc ||
      Math.min(top.after.anchor, top.after.head) !== main.from ||
      Math.max(top.after.anchor, top.after.head) !== main.to) {
    // The selection moved on since the last expand — the history is stale.
    expandStacks.delete(view);
    return false;
  }
  stack.pop();
  dispatchRange(view, top.before);
  return true;
}
