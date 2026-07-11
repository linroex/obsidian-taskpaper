import { foldedRanges, foldService } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { outlineOf } from './outline';

/** Fold an item's subtree (the indented block beneath a project or task). */
export const taskpaperFolding = foldService.of((state, lineStart, lineEnd) => {
  const outline = outlineOf(state);
  const lineNo = state.doc.lineAt(lineStart).number; // 1-based
  const item = outline.items.find((i) => i.line + 1 === lineNo);
  if (!item || item.subtreeEnd <= item.line) {
    return null;
  }
  const endLine = state.doc.line(item.subtreeEnd + 1);
  return { from: lineEnd, to: endLine.to };
});

/** The foldable range of the subtree under `lineNo` (0-based), or null if childless. */
export function subtreeFoldRange(
  state: EditorState,
  lineNo: number,
): { from: number; to: number } | null {
  const item = outlineOf(state).items.find((i) => i.line === lineNo);
  if (!item || item.subtreeEnd <= item.line) {
    return null;
  }
  return {
    from: state.doc.line(lineNo + 1).to,
    to: state.doc.line(item.subtreeEnd + 1).to,
  };
}

/** The already-folded range that starts at the end of `lineNo` (0-based), if any. */
export function foldedRangeAtLine(
  state: EditorState,
  lineNo: number,
): { from: number; to: number } | null {
  const lineEnd = state.doc.line(lineNo + 1).to;
  let existing: { from: number; to: number } | null = null;
  foldedRanges(state).between(lineEnd, lineEnd, (from, to) => {
    if (from === lineEnd) {
      existing = { from, to };
    }
  });
  return existing;
}

// ---------------------------------------------------------------------------
// Collapse/expand all by level (original Shift-Cmd-9 / Shift-Cmd-0)
// ---------------------------------------------------------------------------

/** The slice of an outline item the by-level computation needs (pure; testable). */
export interface LevelFoldItem {
  /** 0-based document line. */
  line: number;
  /** Outline nesting level (0 = root). */
  level: number;
  /** Last 0-based line of the item's subtree. */
  subtreeEnd: number;
}

function foldableOf(items: readonly LevelFoldItem[]): LevelFoldItem[] {
  return items.filter((i) => i.subtreeEnd > i.line);
}

function hasFoldedAncestor(
  item: LevelFoldItem,
  foldable: readonly LevelFoldItem[],
  foldedLines: ReadonlySet<number>,
): boolean {
  return foldable.some(
    (f) => foldedLines.has(f.line) && f.line < item.line && item.line <= f.subtreeEnd,
  );
}

/**
 * "Collapse all by level": each press folds every visible item at the deepest
 * outline level that still shows expanded children. Returns the 0-based lines
 * to fold — empty when everything is already collapsed. (Pure; testable.)
 */
export function linesToCollapseDeepestLevel(
  items: readonly LevelFoldItem[],
  foldedLines: ReadonlySet<number>,
): number[] {
  const foldable = foldableOf(items);
  const candidates = foldable.filter(
    (i) => !foldedLines.has(i.line) && !hasFoldedAncestor(i, foldable, foldedLines),
  );
  if (candidates.length === 0) {
    return [];
  }
  const deepest = Math.max(...candidates.map((i) => i.level));
  return candidates.filter((i) => i.level === deepest).map((i) => i.line);
}

/**
 * "Expand all by level": each press unfolds every folded item at the
 * shallowest currently-folded outline level. Returns the 0-based lines to
 * unfold — empty when nothing is folded. (Pure; testable.)
 */
export function linesToExpandShallowestLevel(
  items: readonly LevelFoldItem[],
  foldedLines: ReadonlySet<number>,
): number[] {
  const folded = foldableOf(items).filter((i) => foldedLines.has(i.line));
  if (folded.length === 0) {
    return [];
  }
  const shallowest = Math.min(...folded.map((i) => i.level));
  return folded.filter((i) => i.level === shallowest).map((i) => i.line);
}
