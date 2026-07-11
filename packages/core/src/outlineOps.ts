import { buildOutline, Item } from './model';

export interface OutlineEdit {
  lines: string[];
  /** Where the cursor should land afterwards (0-based line). */
  cursorLine: number;
}

function itemAt(lines: string[], line: number, tabSize: number): { item?: Item; roots: Item[] } {
  const outline = buildOutline(lines, tabSize);
  return { item: outline.items.find((i) => i.line === line), roots: outline.roots };
}

function siblingsOf(item: Item, roots: Item[]): Item[] {
  return item.parent ? item.parent.children : roots;
}

/** Move an item (and its subtree) above its previous sibling. */
export function moveItemUp(lines: string[], line: number, tabSize: number): OutlineEdit | null {
  const { item, roots } = itemAt(lines, line, tabSize);
  if (!item) {
    return null;
  }
  const siblings = siblingsOf(item, roots);
  const idx = siblings.indexOf(item);
  if (idx <= 0) {
    return null;
  }
  const prev = siblings[idx - 1];
  const block = lines.slice(item.line, item.subtreeEnd + 1);
  const next = lines.slice();
  next.splice(item.line, block.length);
  next.splice(prev.line, 0, ...block);
  return { lines: next, cursorLine: prev.line + (line - item.line) };
}

/** Move an item (and its subtree) below its next sibling. */
export function moveItemDown(lines: string[], line: number, tabSize: number): OutlineEdit | null {
  const { item, roots } = itemAt(lines, line, tabSize);
  if (!item) {
    return null;
  }
  const siblings = siblingsOf(item, roots);
  const idx = siblings.indexOf(item);
  if (idx < 0 || idx >= siblings.length - 1) {
    return null;
  }
  const nextSib = siblings[idx + 1];
  const block = lines.slice(item.line, item.subtreeEnd + 1);
  const out = lines.slice();
  out.splice(item.line, block.length);
  const nextEndAfter = nextSib.subtreeEnd - block.length;
  out.splice(nextEndAfter + 1, 0, ...block);
  return { lines: out, cursorLine: nextEndAfter + 1 + (line - item.line) };
}

/** Indent an item and its subtree one level (prepend a tab). */
export function indentItem(lines: string[], line: number, tabSize: number): OutlineEdit | null {
  const { item } = itemAt(lines, line, tabSize);
  if (!item) {
    return null;
  }
  const out = lines.slice();
  for (let i = item.line; i <= item.subtreeEnd; i++) {
    if (out[i].trim().length > 0) {
      out[i] = '\t' + out[i];
    }
  }
  return { lines: out, cursorLine: line };
}

/** Outdent an item and its subtree one level (remove one tab, or up to tabSize spaces). */
export function outdentItem(lines: string[], line: number, tabSize: number): OutlineEdit | null {
  const { item } = itemAt(lines, line, tabSize);
  if (!item) {
    return null;
  }
  const first = lines[item.line];
  if (!first.startsWith('\t') && !first.startsWith(' ')) {
    return null; // already at the left margin
  }
  const out = lines.slice();
  for (let i = item.line; i <= item.subtreeEnd; i++) {
    const l = out[i];
    if (l.trim().length === 0) {
      continue;
    }
    if (l.startsWith('\t')) {
      out[i] = l.slice(1);
    } else {
      const spaces = (/^ */.exec(l)?.[0].length ?? 0);
      out[i] = l.slice(Math.min(spaces, tabSize));
    }
  }
  return { lines: out, cursorLine: line };
}
