import { tagMap } from './tags';

export type ItemKind = 'project' | 'task' | 'note';

export interface Item {
  /** 0-based line index in the document. */
  line: number;
  kind: ItemKind;
  /** Visual indent width with tabs expanded (used for nesting comparisons). */
  indent: number;
  /** Depth in the outline tree (0 = top level). */
  level: number;
  /** Full original line text. */
  raw: string;
  /** Line text with leading indentation removed. */
  text: string;
  /** The item's text value: `text` minus the leading `- ` marker and trailing `:`. */
  displayText: string;
  /** name -> value map of tags on this line ('' when a tag has no value). */
  tags: Map<string, string>;
  parent: Item | null;
  children: Item[];
  /** Last document line belonging to this item's subtree (for folding / focus). */
  subtreeEnd: number;
}

export interface Outline {
  items: Item[];
  roots: Item[];
  lineCount: number;
}

const LEADING_WS = /^[\t ]*/;

/** Determine the kind of a single line, ignoring indentation. */
export function lineKind(text: string): ItemKind | 'blank' {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 'blank';
  }
  if (/^-\s+/.test(trimmed) || trimmed === '-') {
    return 'task';
  }
  // A project ends with a colon, optionally followed only by trailing tags.
  if (/:(\s+@[A-Za-z0-9._-]+(\([^)]*\))?)*\s*$/.test(text)) {
    return 'project';
  }
  return 'note';
}

/** Expand leading whitespace to a visual column width. */
function indentWidth(leading: string, tabSize: number): number {
  let width = 0;
  for (const ch of leading) {
    if (ch === '\t') {
      width += tabSize - (width % tabSize);
    } else {
      width += 1;
    }
  }
  return width;
}

function displayTextFor(kind: ItemKind, text: string): string {
  if (kind === 'task') {
    return text.replace(/^-\s+/, '').replace(/^-$/, '');
  }
  if (kind === 'project') {
    // Strip the trailing colon (and any trailing tags stay as part of the text).
    return text.replace(/:(\s*(@[A-Za-z0-9._-]+(\([^)]*\))?\s*)*)$/, '$1').trimEnd();
  }
  return text;
}

/** Build the outline tree from an array of lines. */
export function buildOutline(lines: string[], tabSize: number): Outline {
  const items: Item[] = [];
  const roots: Item[] = [];
  const stack: Item[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const kind = lineKind(raw);
    if (kind === 'blank') {
      continue;
    }
    const leading = LEADING_WS.exec(raw)?.[0] ?? '';
    const indent = indentWidth(leading, tabSize);
    const text = raw.slice(leading.length);

    const item: Item = {
      line: i,
      kind,
      indent,
      level: 0,
      raw,
      text,
      displayText: displayTextFor(kind, text),
      tags: tagMap(text),
      parent: null,
      children: [],
      subtreeEnd: i,
    };

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    if (parent) {
      item.parent = parent;
      item.level = parent.level + 1;
      parent.children.push(item);
    } else {
      roots.push(item);
    }
    items.push(item);
    stack.push(item);
  }

  computeSubtreeEnds(items, lines.length);
  return { items, roots, lineCount: lines.length };
}

/** For each item, find the last line of its subtree, trimming trailing blank lines. */
function computeSubtreeEnds(items: Item[], lineCount: number): void {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let end = lineCount - 1;
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].indent <= item.indent) {
        end = items[j].line - 1;
        break;
      }
    }
    item.subtreeEnd = Math.max(item.line, end);
  }
}

/** Find the deepest item whose subtree contains the given line. */
export function itemAtLine(outline: Outline, line: number): Item | undefined {
  let best: Item | undefined;
  for (const item of outline.items) {
    if (item.line <= line && line <= item.subtreeEnd) {
      if (!best || item.level > best.level) {
        best = item;
      }
    }
  }
  return best;
}

/** Walk up from an item collecting it and all its ancestors. */
export function withAncestors(item: Item): Item[] {
  const chain: Item[] = [];
  let cur: Item | null = item;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent;
  }
  return chain;
}
