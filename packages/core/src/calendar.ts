import { stripTags } from './tags';
/**
 * Calendar model — pure date placement of a document's tasks onto a month
 * grid + agenda list, shared by the calendar views.
 *
 * Calendar placement semantics:
 *
 *   - @at(date/time)        → role 'at' on the scheduled date, with time
 *   - @due(date)            → role 'due' on the deadline date
 *   - @at + @due            → both dates; same-day roles merge into one row
 *   - @start + @due         → the due date only (@start alone places nothing)
 *   - @today without @at/due → a virtual occurrence on today's date
 *   - @done(date)           → role 'completed' on the done date, only when
 *                             opts.showCompleted; completion replaces every
 *                             active occurrence
 *
 * All date math is LOCAL time (parseDate already treats bare dates as local
 * midnight — never Date.parse's UTC).
 */
import { parseDate } from './dates';
import { Item, Outline } from './model';
import { ancestorProjectPath } from './archive';

export type CalendarRole = 'at' | 'due' | 'today' | 'completed';

export interface CalendarOccurrence {
  /** 0-based line of the source item. */
  line: number;
  /** The item's display text with its tags stripped. */
  text: string;
  /** Ancestor projects joined ' / ' (outermost first), or undefined at top level. */
  projectPath: string | undefined;
  /** Primary role, retained for consumers that only need one role. */
  role: CalendarRole;
  /** Every role represented by this row (same-day @at + @due are merged). */
  roles: CalendarRole[];
  /** YYYY-MM-DD (local). */
  date: string;
  /** HH:mm for an @at value with an explicit time, otherwise undefined. */
  time?: string;
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

/** Format a local Date as YYYY-MM. */
export function isoMonth(d: Date): string {
  return isoDate(d).slice(0, 7);
}

export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface ResolvedCalendarDate {
  date: string;
  time?: string;
}

/** A clock without a date changes meaning every day, so @at(15:30) is invalid. */
const TIME_ONLY = /^\s*(?:\d{1,2}(?::\d{2})(?::\d{2})?\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))(?:\s|$)/i;

/** Whether the source expression explicitly carries a wall-clock time. */
const EXPLICIT_TIME =
  /(?:^|[\sT])\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm))?(?=$|\s|Z|[+-]\d{2}:?\d{2})|\b\d{1,2}\s*(?:am|pm)\b|\bnow\b/i;

/** Resolve a tag value to a local date and optional explicit time. */
function tagDate(
  value: string | undefined,
  now: Date,
  rejectTimeOnly = false,
): ResolvedCalendarDate | null {
  if (!value) {
    return null;
  }
  if (rejectTimeOnly && TIME_ONLY.test(value)) {
    return null;
  }
  const ts = parseDate(value, now);
  if (Number.isNaN(ts)) {
    return null;
  }
  const resolved = new Date(ts);
  const time = EXPLICIT_TIME.test(value)
    ? `${String(resolved.getHours()).padStart(2, '0')}:${String(resolved.getMinutes()).padStart(2, '0')}`
    : undefined;
  return { date: isoDate(resolved), time };
}

/** Calendar-safe title: tags removed and Markdown links reduced to labels. */
export function calendarDisplayText(text: string): string {
  return stripTags(text).replace(
    /!?\[([^\[\]\n]+)\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)*)\)/g,
    '$1',
  );
}

/** The calendar occurrences a task produces (zero, one, or scheduled + due). */
function occurrencesFor(
  item: Item,
  todayStr: string,
  showCompleted: boolean,
  now: Date,
): CalendarOccurrence[] {
  if (item.kind !== 'task') {
    return [];
  }
  const base = {
    line: item.line,
    text: calendarDisplayText(item.displayText),
    projectPath: ancestorProjectPath(item),
  };
  if (item.tags.has('done')) {
    // A done item never also appears as at/due/today.
    const done = showCompleted ? tagDate(item.tags.get('done'), now) : null;
    return done
      ? [{ ...base, role: 'completed', roles: ['completed'], date: done.date }]
      : [];
  }

  const occurrences: CalendarOccurrence[] = [];
  const scheduled = tagDate(item.tags.get('at'), now, true);
  if (scheduled) {
    occurrences.push({
      ...base,
      role: 'at',
      roles: ['at'],
      date: scheduled.date,
      time: scheduled.time,
    });
  }

  const due = tagDate(item.tags.get('due'), now);
  if (due) {
    const sameDay = occurrences.find((occ) => occ.date === due.date);
    if (sameDay) {
      sameDay.roles.push('due');
    } else {
      occurrences.push({ ...base, role: 'due', roles: ['due'], date: due.date });
    }
  }

  if (occurrences.length === 0 && item.tags.has('today')) {
    occurrences.push({ ...base, role: 'today', roles: ['today'], date: todayStr });
  }
  return occurrences;
}

/** Timed @at occurrences sort first, then untimed rows retain outline order. */
export function compareCalendarOccurrences(
  a: CalendarOccurrence,
  b: CalendarOccurrence,
): number {
  if (a.time !== b.time) {
    if (a.time === undefined) return 1;
    if (b.time === undefined) return -1;
    return a.time < b.time ? -1 : 1;
  }
  return a.line - b.line;
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
    for (const occ of occurrencesFor(item, todayStr, opts.showCompleted, today)) {
      let list = byDate.get(occ.date);
      if (!list) {
        list = [];
        byDate.set(occ.date, list);
      }
      list.push(occ);
      if (occ.roles.includes('due') && occ.date < todayStr) {
        overdue.push(occ);
      }
    }
  }
  for (const list of byDate.values()) {
    list.sort(compareCalendarOccurrences);
  }
  // YYYY-MM-DD compares correctly as a string.
  overdue.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : compareCalendarOccurrences(a, b),
  );

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


/**
 * ISO-8601 week of a YYYY-MM-DD date (Monday-based, week 1 contains Jan 4),
 * as the user's compact label: last digit of the ISO week-year + zero-padded
 * week number — 2026 week 1 → "W601".
 */
export function isoWeekLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  // Shift to the Thursday of this week (ISO weeks belong to the year of
  // their Thursday), then count weeks from that year's Jan 1.
  const thursday = new Date(y, m - 1, d - ((day.getDay() + 6) % 7) + 3);
  const weekYear = thursday.getFullYear();
  const jan1 = new Date(weekYear, 0, 1);
  // The week's Thursday always lies inside the ISO week-year, so the week
  // number is just which 7-day slice of that year the Thursday falls in
  // (the first Thursday has ordinal 1..7 → week 1).
  const ordinal = Math.round((thursday.getTime() - jan1.getTime()) / 86400000) + 1;
  const week = Math.ceil(ordinal / 7);
  return `W${weekYear % 10}${String(week).padStart(2, '0')}`;
}
