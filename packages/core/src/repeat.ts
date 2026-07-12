/**
 * Recurring tasks: `@repeat(<n><unit>)` with unit d/w/m/y (e.g. `1w`, `10d`).
 *
 * Recurrence is STRICT — the next occurrence advances from the existing date
 * anchors (`@due`/`@start`/`@defer`), not from the completion date. It fires
 * only through the toggle-done paths (planToggleDone); typing `@done` by hand
 * never spawns anything.
 */
import { buildOutline, Outline } from './model';
import { addTag, hasTag, parseTags, removeTag, todayStamp, toggleDoneLine } from './tags';
import { resolveDateExpression } from './dates';

export type RepeatUnit = 'd' | 'w' | 'm' | 'y';

export interface RepeatInterval {
  n: number;
  unit: RepeatUnit;
}

// A positive integer plus a unit — decimals, zero, negatives and other
// spellings are all treated as non-recurring.
const REPEAT_VALUE_RE = /^([1-9][0-9]*)([dwmy])$/;

/** The first valid `@repeat(<n><unit>)` on a line, or null when there is none. */
export function parseRepeat(lineText: string): RepeatInterval | null {
  for (const tag of parseTags(lineText)) {
    if (tag.name !== 'repeat' || tag.value === undefined) {
      continue;
    }
    const m = REPEAT_VALUE_RE.exec(tag.value.trim());
    if (m) {
      return { n: Number(m[1]), unit: m[2] as RepeatUnit };
    }
  }
  return null;
}

// In the date-offset grammar `m` means minutes — months are spelled `mo`.
const UNIT_WORDS: Record<RepeatUnit, string> = { d: 'd', w: 'w', m: 'mo', y: 'y' };

/**
 * Advance an ISO date (`YYYY-MM-DD`, optionally ` HH:mm`) by n units.
 * Month/year math is calendar-aware with end-of-month clamping
 * (Jan 31 +1m → Feb 28; 2024-02-29 +1y → 2025-02-28). Returns the input
 * unchanged when it cannot be parsed.
 */
export function advanceDate(iso: string, n: number, unit: RepeatUnit): string {
  return resolveDateExpression(`${iso} +${n}${UNIT_WORDS[unit]}`) ?? iso;
}

export interface LineChange {
  /** 0-based line index in the original snapshot. */
  line: number;
  text: string;
}

export interface LineInsert {
  /** Insert as a new line after this 0-based line of the original snapshot. */
  afterLine: number;
  text: string;
}

export interface ToggleDonePlan {
  changes: LineChange[];
  inserts: LineInsert[];
  /** User-facing warnings (deduplicated) for the editor layer to show. */
  notices: string[];
}

export interface ToggleDoneOptions {
  /** The @done stamp to apply (already formatted per settings). */
  stamp: string;
  tabSize?: number;
  /** "Today" for the bare-@today → @due conversion (defaults to now). */
  now?: Date;
}

export const REPEAT_NEEDS_DATE_NOTICE = '@repeat 需要 @due 或 @start 日期才能產生下一次';

const ANCHOR_TAGS = ['due', 'start', 'defer'] as const;

/**
 * Plan toggling @done on a set of lines against ONE document snapshot.
 * Lines transitioning to done that carry a valid @repeat and a date anchor
 * also spawn their successor line after the completed item's entire subtree
 * (same indentation). The caller applies changes + inserts in a single
 * transaction, so one undo reverts both.
 */
export function planToggleDone(
  lines: string[],
  lineNumbers: number[],
  opts: ToggleDoneOptions,
): ToggleDonePlan {
  const now = opts.now ?? new Date();
  const outline = buildOutline(lines, opts.tabSize ?? 4);
  const changes: LineChange[] = [];
  const inserts: LineInsert[] = [];
  const notices: string[] = [];
  const seen = new Set<number>();

  for (const line of [...lineNumbers].sort((a, b) => a - b)) {
    if (seen.has(line) || line < 0 || line >= lines.length) {
      continue;
    }
    seen.add(line);
    const text = lines[line];
    if (text.trim().length === 0) {
      continue;
    }
    const next = toggleDoneLine(text, opts.stamp);
    if (next !== text) {
      changes.push({ line, text: next });
    }
    // Only the not-done → done transition of a valid @repeat spawns.
    const rep = hasTag(text, 'done') ? null : parseRepeat(text);
    if (!rep) {
      continue;
    }
    const successor = successorLine(text, rep, now);
    if (successor === null) {
      if (!notices.includes(REPEAT_NEEDS_DATE_NOTICE)) {
        notices.push(REPEAT_NEEDS_DATE_NOTICE);
      }
      continue;
    }
    const afterLine = subtreeLastLine(outline, lines, line);
    // Dedupe guard: an identical successor already immediately follows the
    // subtree (un-done → re-done), or is already planned by this very plan.
    if (lines[afterLine + 1] === successor) {
      continue;
    }
    if (inserts.some((i) => i.afterLine === afterLine && i.text === successor)) {
      continue;
    }
    inserts.push({ afterLine, text: successor });
  }
  return { changes, inserts, notices };
}

/**
 * The next occurrence for a completed line: every date-valued anchor tag
 * advanced by the interval from its own old value; bare @today converts to
 * `@due(today + interval)`. Null when the line has no date anchor at all.
 */
function successorLine(text: string, rep: RepeatInterval, now: Date): string | null {
  let succ = text;
  let anchored = false;
  // Every date-valued anchor OCCURRENCE advances in place — duplicates too,
  // and unparseable ones stay untouched. Right-to-left keeps offsets valid.
  for (const tag of [...parseTags(text)].reverse()) {
    if (!(ANCHOR_TAGS as readonly string[]).includes(tag.name) || !tag.value) {
      continue;
    }
    const resolved = resolveDateExpression(tag.value, now);
    if (resolved === null) {
      continue;
    }
    const advanced = advanceDate(resolved, rep.n, rep.unit);
    succ = `${succ.slice(0, tag.start)}@${tag.name}(${advanced})${succ.slice(tag.end)}`;
    anchored = true;
  }
  if (hasTag(text, 'today')) {
    succ = removeTag(succ, 'today');
    if (!anchored) {
      succ = addTag(succ, 'due', advanceDate(todayStamp(false, now), rep.n, rep.unit));
      anchored = true;
    }
  }
  return anchored ? succ : null;
}

/** The last non-blank line of an item's subtree — where the successor goes after. */
function subtreeLastLine(outline: Outline, lines: string[], line: number): number {
  const item = outline.items.find((i) => i.line === line);
  let end = item ? item.subtreeEnd : line;
  while (end > line && lines[end].trim().length === 0) {
    end--;
  }
  return end;
}
