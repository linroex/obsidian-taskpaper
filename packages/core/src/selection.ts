/**
 * Pure selection-range computation for the editor's Select Branch /
 * Expand Selection / Contract Selection commands (original TaskPaper 3
 * Edit > Selection menu). Positions are 0-based {line, col} pairs so the
 * caller can translate to/from its own document offsets.
 */
import { buildOutline, Item, itemAtLine } from './model';

/** A selection expressed as 0-based line/column endpoints (start <= end). */
export interface SelectionRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/** Characters that make up a "word" for the word-expansion step. */
const WORD_CHAR = /[A-Za-z0-9_]/;

function fullLines(lines: string[], startLine: number, endLine: number): SelectionRange {
  return { startLine, startCol: 0, endLine, endCol: lines[endLine]?.length ?? 0 };
}

/** The deepest item whose branch covers the whole [startLine, endLine] span. */
function coveringItem(lines: string[], tabSize: number, startLine: number, endLine: number): Item | null {
  const outline = buildOutline(lines, tabSize);
  let item = itemAtLine(outline, startLine) ?? null;
  while (item && item.subtreeEnd < endLine) {
    item = item.parent;
  }
  return item;
}

/**
 * The whole branch (item line + subtree lines) of the item covering the
 * selection — original Edit > Selection > Select Branch. Returns null when
 * no item covers the selection (e.g. an empty document).
 */
export function selectBranchRange(
  lines: string[],
  tabSize: number,
  startLine: number,
  endLine: number,
): SelectionRange | null {
  const item = coveringItem(lines, tabSize, startLine, endLine);
  if (!item) {
    return null;
  }
  return fullLines(lines, item.line, item.subtreeEnd);
}

/**
 * One step of Expand Selection — original Edit > Selection > Expand.
 * The steps, in order (each returns the first range strictly larger than
 * the current selection):
 *
 *   1. empty cursor       → the word under the cursor
 *   2. partial line(s)    → the full line(s) of the selection
 *   3. full line(s)       → the covering item's whole branch
 *   4. a whole branch     → the parent item's branch (repeats upward)
 *   5. a root branch      → the whole document
 *
 * Returns null when the whole document is already selected.
 */
export function expandSelectionRange(
  lines: string[],
  tabSize: number,
  sel: SelectionRange,
): SelectionRange | null {
  const { startLine, startCol, endLine, endCol } = sel;

  // 1. Cursor → word (skipped when the cursor is not on a word character).
  if (startLine === endLine && startCol === endCol) {
    const text = lines[startLine] ?? '';
    let s = startCol;
    let e = startCol;
    while (s > 0 && WORD_CHAR.test(text[s - 1])) {
      s--;
    }
    while (e < text.length && WORD_CHAR.test(text[e])) {
      e++;
    }
    if (e > s) {
      return { startLine, startCol: s, endLine, endCol: e };
    }
  }

  // 2. Anything short of full lines → the full line(s) of the span.
  if (startCol > 0 || endCol < (lines[endLine]?.length ?? 0)) {
    return fullLines(lines, startLine, endLine);
  }

  // 3/4. Full lines → the smallest branch strictly larger than the selection,
  // walking up through the ancestors.
  let item = coveringItem(lines, tabSize, startLine, endLine);
  while (item) {
    if (item.line < startLine || item.subtreeEnd > endLine) {
      return fullLines(lines, item.line, item.subtreeEnd);
    }
    item = item.parent;
  }

  // 5. The whole document (null when it is already selected).
  const lastLine = lines.length - 1;
  if (startLine === 0 && endLine >= lastLine) {
    return null;
  }
  return fullLines(lines, 0, lastLine);
}
