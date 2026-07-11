/**
 * Parse a TaskPaper date value to a timestamp (ms).
 *
 * Implements the documented TaskPaper 3 date syntax
 * (https://guide.taskpaper.com/reference/dates/) by hand — no dependencies:
 *
 *   - ISO dates:      2026-07-08, 2026-07-08 14:30(:45), 2026-07-08T14:30
 *   - Year / month:   2026 → 2026-01-01,  2026-07 → 2026-07-01
 *   - Keywords:       today, now, tomorrow, yesterday, next/last week,
 *                     next/last/this month, next/last/this year
 *   - Weekdays:       friday, next fri, last monday, this wed
 *   - Month names:    june, next june, last jun, june 3, nov 26
 *   - Times:          9am, 6 am, 3:15 pm, 16:15 — alone (= today at that
 *                     time) or after any date: tomorrow 9am, nov 26 3:15
 *   - Duration math:  trailing +/- offsets, chainable:
 *                     today + 24h, nov 26 3:15 +1day, -6 hours, 2 days 6 hours
 *                     units: m/min/minutes, h/hours, d/days, w/weeks,
 *                     months, y/years (singular/plural/compact)
 *
 * Bare dates are interpreted in the **local** timezone, not UTC — otherwise
 * `@due(2026-07-08)` would land at 08:00 in UTC+8 and comparisons like
 * `@due <= today` would exclude items due today.
 *
 * Returns NaN when the value cannot be parsed.
 */
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];
const WEEKDAY_ABBR: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  tues: 2,
  wed: 3,
  weds: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  fri: 5,
  sat: 6,
};
const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

/** Duration-unit spellings, all mapping to a canonical unit. `m` = minutes. */
const UNIT_ALIASES: Record<string, string> = {
  m: 'min',
  min: 'min',
  mins: 'min',
  minute: 'min',
  minutes: 'min',
  h: 'hour',
  hr: 'hour',
  hrs: 'hour',
  hour: 'hour',
  hours: 'hour',
  d: 'day',
  day: 'day',
  days: 'day',
  w: 'week',
  wk: 'week',
  wks: 'week',
  week: 'week',
  weeks: 'week',
  mo: 'month',
  month: 'month',
  months: 'month',
  y: 'year',
  yr: 'year',
  yrs: 'year',
  year: 'year',
  years: 'year',
};
const UNIT_MS: Record<string, number> = {
  min: MINUTE,
  hour: HOUR,
  day: DAY,
  week: 7 * DAY,
};
// Longest-first so e.g. `months` isn't split as `m` + leftover.
const UNIT_PATTERN = Object.keys(UNIT_ALIASES)
  .sort((a, b) => b.length - a.length)
  .join('|');

// `+1day`, `- 3 weeks`, `24h` — sign optional (inherited from previous item).
const OFFSET_RE = new RegExp(`^\\s*([+-])?\\s*(\\d+)\\s*(${UNIT_PATTERN})(?![a-z])`);
// `9am`, `6 am`, `3:15 pm`, `16:15`, `14:30:45`. Requires a colon or am/pm so
// a bare number is never mistaken for a time.
const TIME_RE = /^(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?\s*(am|pm)?(?![a-z0-9])/;
// Day-of-month after a month name: a small number NOT starting a time
// (`nov 26 3:15` → 26 is the day, 3:15 the time) or a duration (`june 3 days`).
const MONTH_DAY_RE = new RegExp(
  `^\\s+(\\d{1,2})(?![:\\d])(?!\\s*(?:am|pm)(?![a-z]))(?!\\s*(?:${UNIT_PATTERN})(?![a-z]))`,
);

function midnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Build a local Date and reject inputs the Date constructor would silently
 *  normalize (2026-02-31 → Mar 3, month 13 → next January, nov 32 → Dec 2). */
function makeValidDate(
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
): Date | null {
  const d = new Date(year, month, day, hours, minutes, seconds);
  return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day ? d : null;
}

function weekdayIndex(word: string): number | undefined {
  const full = WEEKDAYS.indexOf(word);
  if (full >= 0) {
    return full;
  }
  return word in WEEKDAY_ABBR ? WEEKDAY_ABBR[word] : undefined;
}

function weekdayFrom(now: Date, target: number, qualifier: string): Date {
  const cur = now.getDay();
  let delta = (target - cur + 7) % 7;
  if (qualifier === 'last') {
    delta = delta === 0 ? -7 : delta - 7;
  } else if (qualifier === 'this') {
    // Nearest occurrence this week (may be in the past).
    delta = delta > 3 ? delta - 7 : delta;
  } else if (delta === 0) {
    // Bare weekday or "next": the coming occurrence, never today.
    delta = 7;
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta);
}

/** `june` → this calendar year; `next june` / `last june` step past/behind now. */
function monthFrom(now: Date, month: number, qualifier: string): Date {
  let year = now.getFullYear();
  if (qualifier === 'next' && month <= now.getMonth()) {
    year++;
  } else if (qualifier === 'last' && month >= now.getMonth()) {
    year--;
  }
  return new Date(year, month, 1);
}

/** Calendar month arithmetic with end-of-month clamping (Jan 31 +1mo → Feb 28). */
function addMonths(d: Date, n: number): Date {
  const day = d.getDate();
  const shifted = new Date(
    d.getFullYear(),
    d.getMonth() + n,
    1,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  );
  const lastDay = new Date(shifted.getFullYear(), shifted.getMonth() + 1, 0).getDate();
  shifted.setDate(Math.min(day, lastDay));
  return shifted;
}

/**
 * Parse a full date expression to a local Date, or null when the input does
 * not match the grammar (callers may then fall back to `Date.parse`).
 */
function parseExpression(input: string, now: Date): Date | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) {
    return null;
  }
  let i = 0;
  const eat = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(s.slice(i));
    if (m) {
      i += m[0].length;
    }
    return m;
  };
  const peek = (re: RegExp): boolean => re.test(s.slice(i));

  // Optional "in" prefix for pure offsets: "in 2 weeks".
  if (peek(/^in\s+[+-]?\d/)) {
    eat(/^in\s+/);
  }

  let cur: Date | null = null;
  let matchedBase = false;
  let m: RegExpExecArray | null;

  if ((m = eat(/^(today|now|tomorrow|yesterday)(?![a-z])/))) {
    const shift = m[1] === 'tomorrow' ? 1 : m[1] === 'yesterday' ? -1 : 0;
    cur = new Date(now.getFullYear(), now.getMonth(), now.getDate() + shift);
    matchedBase = true;
  } else if ((m = eat(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](\d{1,2}):(\d{2})(?::(\d{2}))?)?(?!\d)/))) {
    // Full ISO date, optionally with a time — always local, never UTC.
    cur = makeValidDate(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      m[4] ? Number(m[4]) : 0,
      m[5] ? Number(m[5]) : 0,
      m[6] ? Number(m[6]) : 0,
    );
    if (!cur || (m[4] && Number(m[4]) > 23) || (m[5] && Number(m[5]) > 59) || (m[6] && Number(m[6]) > 59)) {
      return null;
    }
    matchedBase = true;
  } else if ((m = eat(/^(\d{4})-(\d{1,2})(?![\d-])/))) {
    cur = makeValidDate(Number(m[1]), Number(m[2]) - 1, 1); // month start
    if (!cur) {
      return null;
    }
    matchedBase = true;
  } else if (peek(OFFSET_RE)) {
    // Pure duration offset ("+1 week", "3 days"): base is today's midnight;
    // the offset loop below consumes the items.
  } else if (peek(/^\d{1,2}:\d{2}/) || peek(/^\d{1,2}\s?[ap]m(?![a-z])/)) {
    // A time alone means today at that time (applied below).
    cur = midnight(now);
    matchedBase = true;
  } else if ((m = eat(/^(\d{4})(?![\d:])/))) {
    cur = new Date(Number(m[1]), 0, 1); // bare year → Jan 1
    matchedBase = true;
  } else {
    const qm = eat(/^(next|last|this)\s+/);
    const qualifier = qm ? qm[1] : '';
    const wm = eat(/^([a-z]+)(?![a-z])/);
    if (wm) {
      const word = wm[1];
      const wd = weekdayIndex(word);
      if (wd !== undefined) {
        cur = weekdayFrom(now, wd, qualifier);
        matchedBase = true;
      } else if (word in MONTHS) {
        cur = monthFrom(now, MONTHS[word], qualifier);
        const dm = eat(MONTH_DAY_RE);
        if (dm) {
          cur = makeValidDate(cur.getFullYear(), cur.getMonth(), Number(dm[1]));
          if (!cur) {
            return null; // e.g. "nov 32", "feb 30"
          }
        }
        matchedBase = true;
      } else if (qualifier && (word === 'week' || word === 'month' || word === 'year')) {
        const base = midnight(now);
        const step = qualifier === 'next' ? 1 : qualifier === 'last' ? -1 : 0;
        if (word === 'week') {
          cur = new Date(base.getFullYear(), base.getMonth(), base.getDate() + step * 7);
        } else if (word === 'month') {
          cur = new Date(base.getFullYear(), base.getMonth() + step, 1);
        } else {
          cur = new Date(base.getFullYear() + step, 0, 1);
        }
        matchedBase = true;
      } else {
        return null;
      }
    } else if (qm) {
      return null; // qualifier with nothing it applies to ("next 5")
    }
  }

  // Optional time-of-day after a date base: "tomorrow 9am", "nov 26 3:15".
  if (matchedBase && cur && peek(/^ \d/)) {
    const save = i;
    eat(/^ /);
    const tm = eat(TIME_RE);
    if (tm && (tm[2] !== undefined || tm[4] !== undefined)) {
      const applied = applyTime(cur, tm);
      if (!applied) {
        return null;
      }
      cur = applied;
    } else {
      i = save; // not a time — leave for the offset loop / trailing check
    }
  } else if (matchedBase && cur && i === 0) {
    // Base was a standalone time (cursor untouched): consume it now.
    const tm = eat(TIME_RE);
    if (!tm || (tm[2] === undefined && tm[4] === undefined)) {
      return null;
    }
    const applied = applyTime(cur, tm);
    if (!applied) {
      return null;
    }
    cur = applied;
  }

  // Trailing duration offsets, chainable; unsigned items inherit the sign of
  // the previous item ("-2 days 6 hours" subtracts both).
  let sign = 1;
  let sawOffset = false;
  while ((m = eat(OFFSET_RE))) {
    if (m[1]) {
      sign = m[1] === '-' ? -1 : 1;
    }
    const n = sign * Number(m[2]);
    const unit = UNIT_ALIASES[m[3]];
    if (!cur) {
      cur = midnight(now);
    }
    if (unit === 'month') {
      cur = addMonths(cur, n);
    } else if (unit === 'year') {
      cur = addMonths(cur, n * 12);
    } else if (unit === 'day' || unit === 'week') {
      // Calendar arithmetic, not fixed milliseconds — "+1 day" must keep the
      // wall-clock time across DST transitions.
      const days = unit === 'week' ? n * 7 : n;
      cur = new Date(
        cur.getFullYear(),
        cur.getMonth(),
        cur.getDate() + days,
        cur.getHours(),
        cur.getMinutes(),
        cur.getSeconds(),
      );
    } else {
      cur = new Date(cur.getTime() + n * UNIT_MS[unit]);
    }
    sawOffset = true;
  }

  eat(/^\s+/);
  if (i !== s.length || cur === null || (!matchedBase && !sawOffset)) {
    return null;
  }
  return cur;
}

/** Apply a TIME_RE match to a date's midnight; null when out of range. */
function applyTime(base: Date, tm: RegExpExecArray): Date | null {
  let hours = Number(tm[1]);
  const minutes = tm[2] ? Number(tm[2]) : 0;
  const seconds = tm[3] ? Number(tm[3]) : 0;
  const ampm = tm[4];
  if (ampm) {
    if (hours < 1 || hours > 12) {
      return null;
    }
    hours = (hours % 12) + (ampm === 'pm' ? 12 : 0);
  } else if (hours > 23) {
    return null;
  }
  if (minutes > 59 || seconds > 59) {
    return null;
  }
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), hours, minutes, seconds);
}

export function parseDate(value: string, now: Date = new Date()): number {
  const d = parseExpression(value, now);
  if (d) {
    return d.getTime();
  }
  // Fallback for formats outside the grammar, restricted to two explicitly
  // recognized shapes — V8's lenient Date.parse would otherwise accept
  // garbage like "hello 2026" as a real date:
  //   - ISO 8601 with timezone: 2026-07-08T12:00:00Z, 2026-07-08T12:00+08:00
  //   - RFC 2822:               Tue, 07 Jul 2026 12:00:00 GMT
  const isoTz = /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/i;
  const rfc2822 = /^[a-z]{3},?\s+\d{1,2}\s+[a-z]{3}\s+\d{4}\b/i;
  const t = value.trim();
  if (!isoTz.test(t) && !rfc2822.test(t)) {
    return NaN;
  }
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? NaN : parsed;
}

/**
 * Resolve a date expression (ISO, relative, or natural-language) to an ISO
 * string, or null if it can't be parsed. Used to expand completions like
 * "next friday" into a concrete date at insert time. Returns `YYYY-MM-DD`
 * when the resolved moment is local midnight, `YYYY-MM-DD HH:MM` when a
 * time-of-day is present (matching how TaskPaper writes times into tags).
 */
export function resolveDateExpression(expr: string, now: Date = new Date()): string | null {
  const ts = parseDate(expr, now);
  if (Number.isNaN(ts)) {
    return null;
  }
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (d.getHours() || d.getMinutes() || d.getSeconds()) {
    return `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return date;
}

/** True when a date value is strictly before today's local midnight. */
export function isPastDate(value: string, now: Date = new Date()): boolean {
  const ts = parseDate(value, now);
  if (Number.isNaN(ts)) {
    return false;
  }
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return ts < todayMidnight;
}
