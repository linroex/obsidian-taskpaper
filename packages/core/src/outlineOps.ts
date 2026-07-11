import { buildOutline, Item, ItemKind, itemAtLine, lineKind } from './model';

export interface OutlineEdit {
  lines: string[];
  /** Where the cursor should land afterwards (0-based line). */
  cursorLine: number;
  /** Optional column for the cursor; when absent the caller keeps its own column. */
  cursorCol?: number;
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

// ---------------------------------------------------------------------------
// Single-item moves (original TaskPaper 3 distinguishes 'Move' from 'Move
// Branch'): only the item's OWN line relocates among its siblings' lines —
// its former subtree stays exactly where it is, re-parenting to whatever
// item now precedes it at a shallower indent.
// ---------------------------------------------------------------------------

/** Move ONLY the item's line above its previous sibling's line; children stay put. */
export function moveItemOnlyUp(lines: string[], line: number, tabSize: number): OutlineEdit | null {
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
  const out = lines.slice();
  out.splice(item.line, 1);
  out.splice(prev.line, 0, lines[item.line]);
  return { lines: out, cursorLine: prev.line };
}

/** Move ONLY the item's line below its next sibling's branch; children stay put. */
export function moveItemOnlyDown(lines: string[], line: number, tabSize: number): OutlineEdit | null {
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
  const out = lines.slice();
  out.splice(item.line, 1);
  // Removing the single item line shifts the next sibling's subtree up by one,
  // so inserting AT the original subtreeEnd index lands just after it.
  out.splice(nextSib.subtreeEnd, 0, lines[item.line]);
  return { lines: out, cursorLine: nextSib.subtreeEnd };
}

/** Indent ONLY the item's line one level (prepend a tab); children stay put. */
export function indentItemOnly(lines: string[], line: number, tabSize: number): OutlineEdit | null {
  const { item } = itemAt(lines, line, tabSize);
  if (!item) {
    return null;
  }
  const out = lines.slice();
  out[item.line] = '\t' + out[item.line];
  return { lines: out, cursorLine: line };
}

/** Outdent ONLY the item's line one level (remove one tab, or up to tabSize spaces). */
export function outdentItemOnly(lines: string[], line: number, tabSize: number): OutlineEdit | null {
  const { item } = itemAt(lines, line, tabSize);
  if (!item) {
    return null;
  }
  const text = lines[item.line];
  if (!text.startsWith('\t') && !text.startsWith(' ')) {
    return null; // already at the left margin
  }
  const out = lines.slice();
  if (text.startsWith('\t')) {
    out[item.line] = text.slice(1);
  } else {
    const spaces = /^ */.exec(text)?.[0].length ?? 0;
    out[item.line] = text.slice(Math.min(spaces, tabSize));
  }
  return { lines: out, cursorLine: line };
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

/** Trailing run of tags (with leading spaces) at the end of a line body.
 * Tag values may contain escaped parens (`@x(a\)b)`), same as TAG_RE. */
const TRAILING_TAGS_RE = /((?:\s+@[A-Za-z0-9._-]+(?:\((?:\\.|[^)\\])*\))?)*)\s*$/;

/**
 * Convert a single line to the given kind in place — task = `- ` prefix,
 * project = trailing `:` (before any trailing tags), note = bare text —
 * preserving indentation and tags. Blank lines are returned untouched.
 */
export function setLineKind(lineText: string, kind: ItemKind): string {
  const cur = lineKind(lineText);
  if (cur === 'blank' || cur === kind) {
    return lineText;
  }
  const indent = /^[\t ]*/.exec(lineText)?.[0] ?? '';
  let body = lineText.slice(indent.length);
  if (cur === 'task') {
    body = body.replace(/^-\s+/, '').replace(/^-$/, '');
  } else if (cur === 'project') {
    body = body.replace(/:(\s*(@[A-Za-z0-9._-]+(\((?:\\.|[^)\\])*\))?\s*)*)$/, '$1').trimEnd();
  }
  if (kind === 'task') {
    return `${indent}- ${body}`;
  }
  if (kind === 'project') {
    const m = TRAILING_TAGS_RE.exec(body);
    const cut = m ? m.index : body.length;
    if (body.slice(0, cut).endsWith(':')) {
      return indent + body;
    }
    return `${indent}${body.slice(0, cut)}:${body.slice(cut)}`;
  }
  return indent + body;
}

/**
 * Wrap the items whose lines fall inside [startLine, endLine] in a new project:
 * the project line is inserted at the selection's minimum indent level and every
 * selected item (with its subtree) is indented one level under it.
 */
export function groupItems(
  lines: string[],
  startLine: number,
  endLine: number,
  name: string,
  tabSize: number,
): OutlineEdit | null {
  const outline = buildOutline(lines, tabSize);
  const selected = outline.items.filter((i) => i.line >= startLine && i.line <= endLine);
  if (selected.length === 0) {
    return null;
  }
  const start = selected[0].line;
  let end = endLine;
  let minIndent = Infinity;
  let lead = '';
  for (const it of selected) {
    end = Math.max(end, it.subtreeEnd);
    if (it.indent < minIndent) {
      minIndent = it.indent;
      lead = /^[\t ]*/.exec(it.raw)?.[0] ?? '';
    }
  }
  const out = lines.slice();
  for (let i = start; i <= end; i++) {
    if (out[i].trim().length > 0) {
      out[i] = '\t' + out[i];
    }
  }
  out.splice(start, 0, `${lead}${name}:`);
  return { lines: out, cursorLine: start, cursorCol: lead.length + name.length };
}

/** Duplicate an item's entire branch immediately after it (cursor on the copy). */
export function duplicateBranch(lines: string[], line: number, tabSize: number): OutlineEdit | null {
  const { item } = itemAt(lines, line, tabSize);
  if (!item) {
    return null;
  }
  const block = lines.slice(item.line, item.subtreeEnd + 1);
  const out = lines.slice();
  out.splice(item.subtreeEnd + 1, 0, ...block);
  return { lines: out, cursorLine: item.subtreeEnd + 1 + (line - item.line) };
}

/** Delete the items whose lines fall inside [startLine, endLine], including their subtrees. */
export function deleteBranch(
  lines: string[],
  startLine: number,
  endLine: number,
  tabSize: number,
): OutlineEdit | null {
  const outline = buildOutline(lines, tabSize);
  const selected = outline.items.filter((i) => i.line >= startLine && i.line <= endLine);
  if (selected.length === 0) {
    return null;
  }
  const start = selected[0].line;
  let end = endLine;
  for (const it of selected) {
    end = Math.max(end, it.subtreeEnd);
  }
  const out = lines.slice();
  out.splice(start, end - start + 1);
  return { lines: out, cursorLine: Math.max(0, Math.min(start, out.length - 1)), cursorCol: 0 };
}

/**
 * Move the branch at `line` to the end of the project at `projectLine`,
 * re-indented to be its direct child. Returns null when the target is not a
 * project or lies inside the branch being moved.
 */
export function moveBranchToProject(
  lines: string[],
  line: number,
  projectLine: number,
  tabSize: number,
): OutlineEdit | null {
  const outline = buildOutline(lines, tabSize);
  const item = outline.items.find((i) => i.line === line) ?? itemAtLine(outline, line);
  const project = outline.items.find((i) => i.line === projectLine);
  if (!item || !project || project.kind !== 'project') {
    return null;
  }
  if (project.line >= item.line && project.line <= item.subtreeEnd) {
    return null; // cannot move a branch into itself
  }
  const byLine = new Map(
    outline.items
      .filter((i) => i.line >= item.line && i.line <= item.subtreeEnd)
      .map((i) => [i.line, i] as const),
  );
  // Base the new indentation on the project's ACTUAL leading whitespace, not
  // its structural level — they differ under mixed/extra indentation.
  const baseIndent = (/^[\t ]*/.exec(lines[project.line])?.[0] ?? '') + '\t';
  const block: string[] = [];
  for (let ln = item.line; ln <= item.subtreeEnd; ln++) {
    const it = byLine.get(ln);
    block.push(it ? baseIndent + '\t'.repeat(it.level - item.level) + it.text : lines[ln]);
  }
  const out = lines.slice();
  out.splice(item.line, block.length);
  // The insertion point shifts up when the removed block sits before it
  // (target project after the source, or the source inside the target).
  const insertAt =
    item.line <= project.subtreeEnd ? project.subtreeEnd + 1 - block.length : project.subtreeEnd + 1;
  out.splice(insertAt, 0, ...block);
  return { lines: out, cursorLine: insertAt };
}

/**
 * Move the branch at `sourceLine` so it sits either directly BEFORE the item
 * at `targetLine` or directly AFTER that item's subtree, re-indented to the
 * target's level (so dragging a nested project between roots keeps the
 * outline valid). Returns null when either line resolves to no item, the
 * target lies inside the branch being moved, or the move is a no-op.
 */
function moveBranchNear(
  lines: string[],
  sourceLine: number,
  targetLine: number,
  tabSize: number,
  after: boolean,
): OutlineEdit | null {
  const outline = buildOutline(lines, tabSize);
  const item = outline.items.find((i) => i.line === sourceLine);
  const target = outline.items.find((i) => i.line === targetLine);
  if (!item || !target || item === target) {
    return null;
  }
  if (target.line >= item.line && target.line <= item.subtreeEnd) {
    return null; // cannot move a branch around a target inside itself
  }
  // Re-indent the block to the target's ACTUAL leading whitespace (its
  // structural level can differ under mixed/extra indentation).
  const baseIndent = /^[\t ]*/.exec(lines[target.line])?.[0] ?? '';
  const byLine = new Map(
    outline.items
      .filter((i) => i.line >= item.line && i.line <= item.subtreeEnd)
      .map((i) => [i.line, i] as const),
  );
  const block: string[] = [];
  for (let ln = item.line; ln <= item.subtreeEnd; ln++) {
    const it = byLine.get(ln);
    block.push(it ? baseIndent + '\t'.repeat(it.level - item.level) + it.text : lines[ln]);
  }
  const out = lines.slice();
  out.splice(item.line, block.length);
  // Insertion point in ORIGINAL coordinates; shift up when the removed block
  // sits before it.
  let insertAt = after ? target.subtreeEnd + 1 : target.line;
  if (item.line < insertAt) {
    insertAt -= block.length;
  }
  out.splice(insertAt, 0, ...block);
  // Adjacent drops (before the next sibling / after the previous one) with no
  // re-indent change the document not at all — report a no-op.
  if (out.length === lines.length && out.every((l, i) => l === lines[i])) {
    return null;
  }
  return { lines: out, cursorLine: insertAt };
}

/** Move the branch at `sourceLine` to directly before the item at `targetLine`. */
export function moveBranchBefore(
  lines: string[],
  sourceLine: number,
  targetLine: number,
  tabSize: number,
): OutlineEdit | null {
  return moveBranchNear(lines, sourceLine, targetLine, tabSize, false);
}

/** Move the branch at `sourceLine` to directly after the subtree of the item at `targetLine`. */
export function moveBranchAfter(
  lines: string[],
  sourceLine: number,
  targetLine: number,
  tabSize: number,
): OutlineEdit | null {
  return moveBranchNear(lines, sourceLine, targetLine, tabSize, true);
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
