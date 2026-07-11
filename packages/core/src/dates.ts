/**
 * Parse a TaskPaper date value to a timestamp (ms).
 *
 * Bare `YYYY-MM-DD` (and `YYYY-MM-DD HH:mm`) values are interpreted in the
 * **local** timezone, not UTC — otherwise `@due(2026-07-08)` would land at
 * 08:00 in UTC+8 and comparisons like `@due <= today` would exclude items due
 * today. Keywords `today` / `now` / `tomorrow` / `yesterday` are also supported.
 *
 * Returns NaN when the value cannot be parsed.
 */
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
const UNIT_DAYS: Record<string, number> = {
  d: 1,
  day: 1,
  days: 1,
  w: 7,
  week: 7,
  weeks: 7,
};

function midnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function weekdayIndex(word: string): number | undefined {
  const w = word.toLowerCase();
  const full = WEEKDAYS.indexOf(w);
  if (full >= 0) {
    return full;
  }
  return w in WEEKDAY_ABBR ? WEEKDAY_ABBR[w] : undefined;
}

export function parseDate(value: string, now: Date = new Date()): number {
  const v = value.trim().toLowerCase();
  const base = midnight(now);

  if (v === 'today' || v === 'now') {
    return base;
  }
  if (v === 'tomorrow') {
    return base + DAY;
  }
  if (v === 'yesterday') {
    return base - DAY;
  }
  if (v === 'next week') {
    return base + 7 * DAY;
  }
  if (v === 'last week') {
    return base - 7 * DAY;
  }

  // YYYY-MM-DD  or  YYYY-MM-DD[ T]HH:mm(:ss) — construct in local time.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (iso) {
    const [, y, mo, d, h, mi, s] = iso;
    return new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      h ? Number(h) : 0,
      mi ? Number(mi) : 0,
      s ? Number(s) : 0,
    ).getTime();
  }

  // Relative offsets: "+1 week", "-3 days", "in 2 weeks", "2d".
  const off = /^(?:in\s+)?([+-]?\d+)\s*(d|day|days|w|week|weeks)$/.exec(v);
  if (off) {
    return base + Number(off[1]) * UNIT_DAYS[off[2]] * DAY;
  }

  // Weekdays: "friday", "next friday", "last mon", "this wed".
  const wd = /^(next|last|this)?\s*([a-z]+)$/.exec(v);
  if (wd) {
    const idx = weekdayIndex(wd[2]);
    if (idx !== undefined) {
      return weekdayFrom(now, idx, wd[1] ?? '');
    }
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? NaN : parsed;
}

function weekdayFrom(now: Date, target: number, qualifier: string): number {
  const base = midnight(now);
  const cur = new Date(base).getDay();
  let delta = (target - cur + 7) % 7;
  if (qualifier === 'last') {
    delta = delta === 0 ? -7 : delta - 7;
  } else if (qualifier === 'this') {
    // Nearest occurrence this week (may be in the past).
    delta = delta > 3 ? delta - 7 : delta;
  } else {
    // Bare weekday or "next": the coming occurrence, never today.
    if (delta === 0) {
      delta = 7;
    }
  }
  return base + delta * DAY;
}

/**
 * Resolve a date expression (ISO, relative, or natural-language) to an ISO
 * `YYYY-MM-DD` string, or null if it can't be parsed. Used to expand
 * completions like "next friday" into a concrete date at insert time.
 */
export function resolveDateExpression(expr: string, now: Date = new Date()): string | null {
  const ts = parseDate(expr, now);
  if (Number.isNaN(ts)) {
    return null;
  }
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
