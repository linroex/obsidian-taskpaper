/**
 * Tag parsing and formatting for the TaskPaper format.
 *
 * A tag is `@name` optionally followed by a parenthesised value: `@name(value)`.
 * The value may contain escaped characters (`\)` etc.).
 */
// Type-only import — repeat.ts imports back from this module at runtime.
import type { LineChange } from './repeat';

/** Global matcher for tags within a line. Group 1 = name, group 2 = raw value (or undefined). */
export const TAG_RE = /@([A-Za-z0-9._-]+)(?:\(((?:\\.|[^)\\])*)\))?/g;

export interface ParsedTag {
  name: string;
  value: string | undefined;
  /** Start offset of the `@` within the line. */
  start: number;
  /** End offset (exclusive) within the line. */
  end: number;
}

/** Parse every tag occurrence in a single line of text. */
export function parseTags(lineText: string): ParsedTag[] {
  const tags: ParsedTag[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(lineText))) {
    tags.push({
      name: m[1],
      value: m[2] === undefined ? undefined : unescapeValue(m[2]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return tags;
}

/** Build a name -> value map for a line (value is '' when the tag has no parentheses). */
export function tagMap(lineText: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of parseTags(lineText)) {
    map.set(t.name, t.value ?? '');
  }
  return map;
}

export function hasTag(lineText: string, name: string): boolean {
  return parseTags(lineText).some((t) => t.name === name);
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** Today as `YYYY-MM-DD`, optionally with ` HH:mm`. */
export function todayStamp(includeTime: boolean, now: Date = new Date()): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (!includeTime) {
    return date;
  }
  return `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function unescapeValue(raw: string): string {
  return raw.replace(/\\(.)/g, '$1');
}

/** Escape a value so it can be placed inside `@name(...)`. */
export function escapeValue(value: string): string {
  return value.replace(/([()\\])/g, '\\$1');
}

/** Render a tag as text: `@name` or `@name(value)`. */
export function formatTag(name: string, value?: string): string {
  if (value === undefined || value === '') {
    return `@${name}`;
  }
  return `@${name}(${escapeValue(value)})`;
}

/**
 * Add a tag to a line's text (before any trailing whitespace). If the tag is
 * already present it is left untouched. Returns the new line text.
 */
export function addTag(lineText: string, name: string, value?: string): string {
  if (parseTags(lineText).some((t) => t.name === name)) {
    return setTagValue(lineText, name, value);
  }
  const trailing = lineText.match(/\s*$/)?.[0] ?? '';
  const core = trailing ? lineText.slice(0, lineText.length - trailing.length) : lineText;
  const sep = core.length === 0 || /\s$/.test(core) ? '' : ' ';
  return `${core}${sep}${formatTag(name, value)}${trailing}`;
}

/** Remove every occurrence of a tag from a line, tidying up whitespace. */
export function removeTag(lineText: string, name: string): string {
  // Preserve leading indentation exactly; only operate on the body so that
  // nesting (tabs) and any intentional internal spacing are never disturbed.
  const indent = /^[\t ]*/.exec(lineText)?.[0] ?? '';
  const body = lineText
    .slice(indent.length)
    .replace(new RegExp(`\\s*@${escapeRegExp(name)}(?:\\((?:\\\\.|[^)\\\\])*\\))?`, 'g'), '')
    .replace(/^ +| +$/g, ''); // trim spaces only left at the ends by the removal
  return indent + body;
}

/** Strip every @tag from a line, tidying up whitespace but preserving indentation. */
export function removeAllTags(lineText: string): string {
  const indent = /^[\t ]*/.exec(lineText)?.[0] ?? '';
  const body = lineText
    .slice(indent.length)
    .replace(/\s*@[A-Za-z0-9._-]+(?:\((?:\\.|[^)\\])*\))?/g, '')
    .replace(/^ +| +$/g, '');
  return indent + body;
}

/** Display text minus its tags — for names, breadcrumbs and fingerprints. */
export function stripTags(text: string): string {
  return text.replace(/\s*@[A-Za-z0-9._-]+(\((?:\\.|[^)\\])*\))?/g, '').trim();
}

/** Toggle @done on a line: remove it if present, else stamp it (dropping @today). */
export function toggleDoneLine(lineText: string, stamp: string): string {
  return hasTag(lineText, 'done')
    ? removeTag(lineText, 'done')
    : addTag(removeTag(lineText, 'today'), 'done', stamp);
}

/** Replace the value of an existing tag (adds it if missing). */
export function setTagValue(lineText: string, name: string, value?: string): string {
  const tags = parseTags(lineText);
  const existing = tags.find((t) => t.name === name);
  if (!existing) {
    return addTag(lineText, name, value);
  }
  const before = lineText.slice(0, existing.start);
  const after = lineText.slice(existing.end);
  return `${before}${formatTag(name, value)}${after}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Plan assigning a tag to a set of root lines (sidebar drag-to-assign).
 * `value === null` adds the bare tag — lines that already carry it keep
 * their existing value; otherwise the value is set/replaced in place
 * (setTagValue). Duplicate same-name tags on a touched line collapse to
 * exactly one. Tag-only mutation: item positions never change.
 */
export function planAssignTag(
  lines: string[],
  rootLines: number[],
  name: string,
  value: string | null,
): LineChange[] {
  const changes: LineChange[] = [];
  const seen = new Set<number>();
  for (const line of [...rootLines].sort((a, b) => a - b)) {
    if (seen.has(line) || line < 0 || line >= lines.length) {
      continue;
    }
    seen.add(line);
    const text = lines[line];
    if (text.trim().length === 0) {
      continue;
    }
    const next = assignTagLine(text, name, value);
    if (next !== text) {
      changes.push({ line, text: next });
    }
  }
  return changes;
}

/** One line's assignment: duplicates collapse to the first occurrence, which
 *  then keeps (bare drop) or takes (value drop) the value, in place. */
function assignTagLine(text: string, name: string, value: string | null): string {
  // Right-to-left removal keeps the earlier occurrences' offsets valid.
  const dups = parseTags(text).filter((t) => t.name === name).slice(1);
  let out = text;
  for (const t of dups.reverse()) {
    const eatBefore = t.start > 0 && out[t.start - 1] === ' ';
    const start = eatBefore ? t.start - 1 : t.start;
    const end = !eatBefore && out[t.end] === ' ' ? t.end + 1 : t.end;
    out = out.slice(0, start) + out.slice(end);
  }
  if (value === null) {
    return hasTag(out, name) ? out : addTag(out, name);
  }
  return setTagValue(out, name, value);
}
