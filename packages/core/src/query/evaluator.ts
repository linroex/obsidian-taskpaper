import { Item, Outline } from '../model';
import { parseDate } from '../dates';
import { Axis, parseQuery, Predicate, Query, Slice, Step } from './parser';

/** Parse and evaluate a query against an outline, returning the set of matching items. */
export function runQuery(input: string, outline: Outline): Set<Item> {
  const query = parseQuery(input);
  return evaluate(query, outline);
}

export function evaluate(query: Query, outline: Outline): Set<Item> {
  switch (query.t) {
    case 'path':
      return evaluatePath(query.steps, outline);
    case 'union': {
      const out = evaluate(query.a, outline);
      for (const it of evaluate(query.b, outline)) {
        out.add(it);
      }
      return out;
    }
    case 'intersect': {
      const b = evaluate(query.b, outline);
      return new Set([...evaluate(query.a, outline)].filter((it) => b.has(it)));
    }
    case 'except': {
      const b = evaluate(query.b, outline);
      return new Set([...evaluate(query.a, outline)].filter((it) => !b.has(it)));
    }
    case 'slice': {
      const ordered = [...evaluate(query.a, outline)].sort((x, y) => x.line - y.line);
      return new Set(applySlice(ordered, query.slice));
    }
  }
}

function evaluatePath(steps: Step[], outline: Outline): Set<Item> {
  if (steps.length === 0) {
    return new Set();
  }

  const first = steps[0];
  let context = applySlice(
    firstCandidates(first, outline).filter((it) => matchPred(first.pred, it)),
    first.slice,
  );

  for (let s = 1; s < steps.length; s++) {
    const step = steps[s];
    const next = new Set<Item>();
    for (const ctx of context) {
      // Slices apply to the matched set within each evaluation context, so
      // e.g. `project *//not @done[0]` keeps the first match per project.
      const matched: Item[] = [];
      for (const cand of axisNodes(effectiveAxis(step), ctx)) {
        if (matchPred(step.pred, cand)) {
          matched.push(cand);
        }
      }
      for (const it of applySlice(matched, step.slice)) {
        next.add(it);
      }
    }
    context = [...next];
  }

  return new Set(context);
}

function applySlice(items: Item[], slice: Slice | undefined): Item[] {
  if (!slice) {
    return items;
  }
  if (slice.index !== undefined) {
    const idx = slice.index < 0 ? items.length + slice.index : slice.index;
    return idx >= 0 && idx < items.length ? [items[idx]] : [];
  }
  return items.slice(slice.start ?? 0, slice.end);
}

function effectiveAxis(step: Step): Axis {
  if (step.axis) {
    return step.axis;
  }
  return step.sep === 'child' ? 'child' : 'descendant-or-self';
}

function firstCandidates(step: Step, outline: Outline): Item[] {
  const axis = step.axis;
  if (axis === 'child') {
    return outline.roots;
  }
  if (axis && axis !== 'descendant' && axis !== 'descendant-or-self') {
    // Axes like parent/ancestor from the virtual root are empty; fall back to all items.
    return outline.items;
  }
  // Default: `/` -> root children, `//` (or none) -> all items.
  return step.sep === 'child' ? outline.roots : outline.items;
}

function axisNodes(axis: Axis, item: Item): Item[] {
  switch (axis) {
    case 'self':
      return [item];
    case 'child':
      return item.children;
    case 'descendant':
      return descendants(item, false);
    case 'descendant-or-self':
      return descendants(item, true);
    case 'parent':
      return item.parent ? [item.parent] : [];
    case 'ancestor':
      return ancestors(item, false);
    case 'ancestor-or-self':
      return ancestors(item, true);
    case 'following-sibling':
      return siblings(item, 'after');
    case 'preceding-sibling':
      return siblings(item, 'before');
    default:
      return [];
  }
}

function descendants(item: Item, includeSelf: boolean): Item[] {
  const out: Item[] = [];
  if (includeSelf) {
    out.push(item);
  }
  const walk = (node: Item) => {
    for (const child of node.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(item);
  return out;
}

function ancestors(item: Item, includeSelf: boolean): Item[] {
  const out: Item[] = [];
  if (includeSelf) {
    out.push(item);
  }
  let cur = item.parent;
  while (cur) {
    out.push(cur);
    cur = cur.parent;
  }
  return out;
}

function siblings(item: Item, which: 'before' | 'after'): Item[] {
  const list = item.parent ? item.parent.children : [];
  const idx = list.indexOf(item);
  if (idx < 0) {
    return [];
  }
  return which === 'before' ? list.slice(0, idx) : list.slice(idx + 1);
}

// ---- predicate matching ----

function matchPred(pred: Predicate, item: Item): boolean {
  switch (pred.t) {
    case 'or':
      return matchPred(pred.a, item) || matchPred(pred.b, item);
    case 'and':
      return matchPred(pred.a, item) && matchPred(pred.b, item);
    case 'not':
      return !matchPred(pred.a, item);
    case 'has':
      return hasAttr(item, pred.attr);
    case 'type':
      return pred.kind === 'item' || item.kind === pred.kind;
    case 'text':
      return item.displayText.toLowerCase().includes(pred.value.toLowerCase());
    case 'cmp':
      return compare(getAttr(item, pred.attr), pred.rel, pred.value, pred.mods);
  }
}

function hasAttr(item: Item, attr: string): boolean {
  const lower = attr.toLowerCase();
  if (lower === 'text' || lower === 'type' || lower === 'line' || lower === 'level' || lower === 'id') {
    return true;
  }
  return item.tags.has(attr);
}

function getAttr(item: Item, attr: string): string | undefined {
  const lower = attr.toLowerCase();
  switch (lower) {
    case 'text':
      return item.displayText;
    case 'type':
      return item.kind;
    case 'line':
      return String(item.line + 1);
    case 'level':
      return String(item.level);
    case 'id':
      // Items carry no persisted id, so @id is defined as the 0-based line
      // number rendered as a string — stable for the lifetime of the outline.
      return String(item.line);
    default:
      return item.tags.has(attr) ? item.tags.get(attr) : undefined;
  }
}

function compare(raw: string | undefined, rel: string, value: string, mods: string): boolean {
  if (raw === undefined) {
    return false;
  }

  // `[l]` treats BOTH sides as comma-separated lists (birch semantics); the
  // remaining modifiers apply to each element comparison.
  if (mods.includes('l')) {
    const rest = mods.replace(/l/g, '');
    const left = raw.split(',').map((s) => s.trim());
    const right = value.split(',').map((s) => s.trim());
    return compareLists(left, rel, right, rest);
  }

  if (mods.includes('n')) {
    return compareNumeric(parseFloat(raw), rel, parseFloat(value));
  }
  if (mods.includes('d')) {
    return compareNumeric(parseDate(raw), rel, parseDate(value));
  }

  const caseSensitive = mods.includes('s');
  let a = raw;
  let b = value;
  if (!caseSensitive) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }

  switch (rel) {
    case '=':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    case '>=':
      return a >= b;
    case 'contains':
      return a.includes(b);
    case 'beginswith':
      return a.startsWith(b);
    case 'endswith':
      return a.endsWith(b);
    case 'matches':
      try {
        return new RegExp(value, caseSensitive ? '' : 'i').test(raw);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

// List relations mirror birch-outline: `=`/`!=` compare whole lists, ordering
// relations require every right element to be satisfied by some left element,
// `contains` is subset, `beginswith`/`endswith` match the right sequence at
// the left list's start/end.
function compareLists(left: string[], rel: string, right: string[], mods: string): boolean {
  const eq = (a: string, b: string) => compare(a, '=', b, mods);
  switch (rel) {
    case '=':
      return left.length === right.length && left.every((a, i) => eq(a, right[i]));
    case '!=':
      return !(left.length === right.length && left.every((a, i) => eq(a, right[i])));
    case 'beginswith':
      return (
        left.length > 0 &&
        right.length > 0 &&
        right.length <= left.length &&
        right.every((b, i) => eq(left[i], b))
      );
    case 'endswith': {
      if (left.length === 0 || right.length === 0 || right.length > left.length) {
        return false;
      }
      const offset = left.length - right.length;
      return right.every((b, i) => eq(left[offset + i], b));
    }
    case 'contains':
      return (
        left.length > 0 &&
        right.length > 0 &&
        right.every((b) => left.some((a) => eq(a, b)))
      );
    default:
      // < > <= >= matches: every right element satisfied by some left element.
      return (
        left.length > 0 &&
        right.length > 0 &&
        right.every((b) => left.some((a) => compare(a, rel, b, mods)))
      );
  }
}

function compareNumeric(a: number, rel: string, b: number): boolean {
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return false;
  }
  switch (rel) {
    case '=':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    case '>=':
      return a >= b;
    case 'contains':
    case 'beginswith':
    case 'endswith':
    case 'matches':
      return a === b;
    default:
      return false;
  }
}
