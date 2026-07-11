import { itemAtLine, Item, Outline } from './model';

/** Resolve the project (or nearest item) targeted by a line. */
function targetAt(outline: Outline, line: number): Item | undefined {
  return (
    outline.items.find((i) => i.line === line && i.kind === 'project') ??
    itemAtLine(outline, line)
  );
}

/** The set of document lines belonging to a focused item's subtree (0-based, inclusive). */
export function focusVisibleLines(outline: Outline, line: number): Set<number> {
  const set = new Set<number>();
  const target = targetAt(outline, line);
  if (!target) {
    return set;
  }
  for (let ln = target.line; ln <= target.subtreeEnd; ln++) {
    set.add(ln);
  }
  return set;
}

/**
 * Lines of the other projects that should be folded to focus a target project —
 * every project that is neither the target, an ancestor of it, nor a descendant.
 */
export function projectsToFold(outline: Outline, line: number): number[] {
  const target = targetAt(outline, line);
  if (!target) {
    return [];
  }
  const ancestors = new Set<Item>();
  for (let a = target.parent; a; a = a.parent) {
    ancestors.add(a);
  }
  const isDescendant = (it: Item): boolean => {
    for (let a = it.parent; a; a = a.parent) {
      if (a === target) {
        return true;
      }
    }
    return false;
  };
  return outline.items
    .filter(
      (it) =>
        it.kind === 'project' &&
        it !== target &&
        !ancestors.has(it) &&
        !isDescendant(it) &&
        it.subtreeEnd > it.line,
    )
    .map((it) => it.line);
}

/**
 * Decide the next focus target when a project is clicked: clicking the already
 * focused project clears focus (returns null), otherwise focuses it.
 */
export function toggleFocusTarget(currentLine: number | null, clickedLine: number): number | null {
  return currentLine === clickedLine ? null : clickedLine;
}
