/**
 * Calendar model — pure date placement of a document's tasks onto a month
 * grid + agenda list, shared by the calendar views.
 *
 * ONE-day semantics: every task occupies at most one calendar day:
 *
 *   - @due(date)            → role 'due' on that date
 *   - @start + @due         → the due date only (@start alone places nothing)
 *   - @today without @due   → a virtual occurrence on today's date
 *   - @today with @due      → the due date once (no duplicate)
 *   - @done(date)           → role 'completed' on the done date, only when
 *                             opts.showCompleted; a done item never also
 *                             appears as due/today
 *
 * All date math is LOCAL time (parseDate already treats bare dates as local
 * midnight — never Date.parse's UTC).
 */
import { parseDate } from './dates';
import { Item, Outline } from './model';
import { ancestorProjectPath } from './archive';

export type CalendarRole = 'due' | 'today' | 'completed';

export interface CalendarOccurrence {
  /** 0-based line of the source item. */
  line: number;
  /** The item's display text with its tags stripped. */
  text: string;
  /** Ancestor projects joined ' / ' (outermost first), or undefined at top level. */
  projectPath: string | undefined;
  role: CalendarRole;
  /** YYYY-MM-DD (local). */
  date: string;
}

export interface CalendarDay {
  /** YYYY-MM-DD (local). */
  date: string;
  /** False for the leading/trailing days padding the grid to full weeks. */
  inMonth: boolean;
  occurrences: CalendarOccurrence[];
}

export interface CalendarModel {
  /** The anchor month, YYYY-MM. */
  month: string;
  /** Full-week rows (7 cells each) covering the anchor month. */
  weeks: CalendarDay[][];
  /** Incomplete tasks due strictly before today, by date then line. */
  overdue: CalendarOccurrence[];
  /** In-month dates that have occurrences, ascending (overdue excluded —
   *  the agenda renders those as their own section). */
  agenda: Array<{ date: string; occurrences: CalendarOccurrence[] }>;
}

export interface CalendarOptions {
  showCompleted: boolean;
  /** First day of the week: 0 = Sunday, 1 = Monday, … */
  weekStart: number;
}

/** Strip trailing @tag(...)s from a display text (same shape the sidebar uses). */
function stripTags(displayText: string): string {
  return displayText.replace(/\s*@[A-Za-z0-9._-]+(\([^)]*\))?/g, '').trim();
}

/** Format a local Date as YYYY-MM-DD. */
function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Resolve a tag value to a local YYYY-MM-DD, or null when unparsable. */
function tagDate(value: string | undefined, now: Date): string | null {
  if (!value) {
    return null;
  }
  const ts = parseDate(value, now);
  return Number.isNaN(ts) ? null : isoDate(new Date(ts));
}

/** The single calendar occurrence a task produces, or null. */
function occurrenceFor(
  item: Item,
  todayStr: string,
  showCompleted: boolean,
  now: Date,
): CalendarOccurrence | null {
  if (item.kind !== 'task') {
    return null;
  }
  const base = {
    line: item.line,
    text: stripTags(item.displayText),
    projectPath: ancestorProjectPath(item),
  };
  if (item.tags.has('done')) {
    // A done item never also appears as due/today.
    const date = showCompleted ? tagDate(item.tags.get('done'), now) : null;
    return date ? { ...base, role: 'completed', date } : null;
  }
  const due = tagDate(item.tags.get('due'), now);
  if (due) {
    return { ...base, role: 'due', date: due };
  }
  if (item.tags.has('today')) {
    return { ...base, role: 'today', date: todayStr };
  }
  return null;
}

/**
 * Build the calendar model for one month.
 *
 * `monthAnchor` is YYYY-MM; `today` drives the virtual @today placement, the
 * overdue boundary (local midnight), and natural-language dates like
 * @due(tomorrow).
 */
export function calendarModel(
  outline: Outline,
  monthAnchor: string,
  opts: CalendarOptions,
  today: Date,
): CalendarModel {
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const todayStr = isoDate(todayMidnight);

  const byDate = new Map<string, CalendarOccurrence[]>();
  const overdue: CalendarOccurrence[] = [];
  for (const item of outline.items) {
    const occ = occurrenceFor(item, todayStr, opts.showCompleted, todayMidnight);
    if (!occ) {
      continue;
    }
    let list = byDate.get(occ.date);
    if (!list) {
      list = [];
      byDate.set(occ.date, list);
    }
    list.push(occ); // outline order = line order
    if (occ.role === 'due' && occ.date < todayStr) {
      overdue.push(occ);
    }
  }
  // YYYY-MM-DD compares correctly as a string.
  overdue.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.line - b.line));

  // Full-week grid covering the anchor month.
  const [year, month] = monthAnchor.split('-').map(Number);
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const leading = (first.getDay() - opts.weekStart + 7) % 7;
  const cells = Math.ceil((leading + daysInMonth) / 7) * 7;
  const weeks: CalendarDay[][] = [];
  let week: CalendarDay[] = [];
  for (let i = 0; i < cells; i++) {
    const d = new Date(year, month - 1, 1 + i - leading);
    const date = isoDate(d);
    week.push({
      date,
      inMonth: d.getMonth() === month - 1 && d.getFullYear() === year,
      occurrences: byDate.get(date) ?? [],
    });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }

  // Agenda: ascending in-month dates that have (non-overdue) occurrences.
  const overdueSet = new Set(overdue);
  const agenda: Array<{ date: string; occurrences: CalendarOccurrence[] }> = [];
  for (const date of [...byDate.keys()].sort()) {
    if (!date.startsWith(monthAnchor + '-')) {
      continue;
    }
    const occurrences = byDate.get(date)!.filter((o) => !overdueSet.has(o));
    if (occurrences.length > 0) {
      agenda.push({ date, occurrences });
    }
  }

  return { month: monthAnchor, weeks, overdue, agenda };
}
