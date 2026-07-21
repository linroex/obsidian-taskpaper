/**
 * Vault-wide calendar aggregation — a layer OVER core's single-outline
 * calendarModel. Each source document is modeled separately and the results
 * are merged, with every occurrence tagged by its source identity
 * {path, line, fingerprint} so the host can re-locate lines later.
 *
 * Pure module: no 'obsidian' imports, so it is unit-testable headless.
 */
import {
  addTag,
  buildOutline,
  calendarModel,
  CalendarOccurrence,
  CalendarOptions,
  CalendarRole,
  removeTag,
  setTagValue,
  stripTags,
} from '@taskpaper/core';
import { OUTLINE_TAB_SIZE } from './editor/outline';

/** Which documents feed the calendar: the view's own file, or every .taskpaper file. */
export type CalendarScope = 'file' | 'vault';

/** Where an occurrence came from — enough to find its line again later. */
export interface OccurrenceSource {
  path: string;
  /** 0-based line at model time (the document may have drifted since). */
  line: number;
  /** Tag-stripped line text minus marker — the re-location key. */
  fingerprint: string;
}

export interface SourcedOccurrence extends CalendarOccurrence {
  source: OccurrenceSource;
  /** File basename shown as a dim badge — set only for foreign documents. */
  badge?: string;
}

/** One document feeding the aggregated model. */
export interface CalendarSourceDoc {
  path: string;
  lines: string[];
  /** Basename badge for the doc's occurrences (omit for the pane's own file). */
  badge?: string;
}

export interface SourcedCalendarDay {
  date: string;
  inMonth: boolean;
  occurrences: SourcedOccurrence[];
}

export interface SourcedCalendarModel {
  month: string;
  weeks: SourcedCalendarDay[][];
  overdue: SourcedOccurrence[];
  agenda: Array<{ date: string; occurrences: SourcedOccurrence[] }>;
}

/** The staleness-guard fingerprint of a raw line (tag-stripped, marker
 *  removed). An untitled dated task strips to nothing — fall back to the
 *  trimmed raw text so it never shares the blank lines' empty fingerprint. */
export function lineFingerprint(line: string): string {
  return stripTags(line.replace(/^[\t ]*(?:-\s*)?/, '')) || line.trim();
}

/** All 0-based lines whose fingerprint matches — callers refuse on 0 or >1.
 *  An empty fingerprint matches nothing (blank lines are never targets). */
export function fingerprintLines(lines: string[], fingerprint: string): number[] {
  if (fingerprint.length === 0) {
    return [];
  }
  const found: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lineFingerprint(lines[i]) === fingerprint) {
      found.push(i);
    }
  }
  return found;
}

/**
 * Rewrite the date tags represented by a dragged occurrence. @today becomes a
 * dated @due; merged same-day @at + @due rows move both, preserving @at time.
 */
export function rescheduledLine(
  lineText: string,
  roleOrRoles: CalendarRole | CalendarRole[],
  date: string,
  time?: string,
): string {
  const roles = Array.isArray(roleOrRoles) ? roleOrRoles : [roleOrRoles];
  let out = lineText;
  for (const role of roles) {
    if (role === 'today') {
      out = addTag(removeTag(out, 'today'), 'due', date);
    } else if (role === 'completed') {
      out = setTagValue(out, 'done', date);
    } else if (role === 'at') {
      out = setTagValue(out, 'at', time ? `${date} ${time}` : date);
    } else {
      out = setTagValue(out, 'due', date);
    }
  }
  return out;
}

/** Ordering that keeps DOM identity stable across renders: path, then line. */
function byPathLine(a: SourcedOccurrence, b: SourcedOccurrence): number {
  return a.source.path < b.source.path
    ? -1
    : a.source.path > b.source.path
      ? 1
      : a.source.line - b.source.line;
}

/** Timed scheduled items first; otherwise retain the stable path/line order. */
function byCalendarOrder(a: SourcedOccurrence, b: SourcedOccurrence): number {
  if (a.time !== b.time) {
    if (a.time === undefined) return 1;
    if (b.time === undefined) return -1;
    if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  }
  return byPathLine(a, b);
}

/**
 * Build the merged month model over several documents. Every document shares
 * the same grid (same anchor/weekStart/today), so cells merge index-wise.
 * Explicitly timed @at occurrences sort first; other rows retain path/line
 * order. Overdue rows sort by date before that same per-day ordering.
 */
export function sourcedCalendarModel(
  docs: CalendarSourceDoc[],
  monthAnchor: string,
  opts: CalendarOptions,
  today: Date,
): SourcedCalendarModel {
  const tagged = docs.map((doc) => {
    const model = calendarModel(buildOutline(doc.lines, OUTLINE_TAB_SIZE), monthAnchor, opts, today);
    // One occurrence object can appear in weeks AND overdue/agenda — tag via
    // a map so the sourced wrapper keeps that shared identity.
    const wrapped = new Map<CalendarOccurrence, SourcedOccurrence>();
    const wrap = (occ: CalendarOccurrence): SourcedOccurrence => {
      let sourced = wrapped.get(occ);
      if (!sourced) {
        sourced = {
          ...occ,
          // Display text may remove Markdown link syntax; source identity must
          // continue to use the original line representation.
          source: {
            path: doc.path,
            line: occ.line,
            fingerprint: lineFingerprint(doc.lines[occ.line] ?? ''),
          },
          badge: doc.badge,
        };
        wrapped.set(occ, sourced);
      }
      return sourced;
    };
    return { model, wrap };
  });

  const first = tagged[0].model;
  const weeks: SourcedCalendarDay[][] = first.weeks.map((week, w) =>
    week.map((day, d) => ({
      date: day.date,
      inMonth: day.inMonth,
      occurrences: tagged
        .flatMap(({ model, wrap }) => model.weeks[w][d].occurrences.map(wrap))
        .sort(byCalendarOrder),
    })),
  );

  const overdue = tagged
    .flatMap(({ model, wrap }) => model.overdue.map(wrap))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byCalendarOrder(a, b)));

  const agendaByDate = new Map<string, SourcedOccurrence[]>();
  for (const { model, wrap } of tagged) {
    for (const entry of model.agenda) {
      let list = agendaByDate.get(entry.date);
      if (!list) {
        list = [];
        agendaByDate.set(entry.date, list);
      }
      list.push(...entry.occurrences.map(wrap));
    }
  }
  const agenda = [...agendaByDate.keys()]
    .sort()
    .map((date) => ({ date, occurrences: agendaByDate.get(date)!.sort(byCalendarOrder) }));

  return { month: first.month, weeks, overdue, agenda };
}

/**
 * Per-file line cache for closed documents, keyed path + a caller-provided
 * freshness key (mtime:size). Reads are async; `lines` returns what is cached
 * NOW and kicks one background read on a miss — `onLoaded` fires after each
 * fill so the owner can refresh any active calendar.
 */
export class TaskpaperLinesCache {
  private entries = new Map<string, { key: string; lines: string[] }>();
  private pending = new Set<string>();
  /** Bumped by invalidate/clear so an in-flight read of the OLD content can't
   *  repopulate the cache after the file changed underneath it. */
  private generation = new Map<string, number>();

  constructor(
    private read: (path: string) => Promise<string>,
    private onLoaded: () => void,
  ) {}

  lines(path: string, key: string): string[] | null {
    const entry = this.entries.get(path);
    if (entry && entry.key === key) {
      return entry.lines;
    }
    if (!this.pending.has(path)) {
      this.pending.add(path);
      const gen = this.generation.get(path) ?? 0;
      this.read(path).then(
        (data) => {
          this.pending.delete(path);
          if ((this.generation.get(path) ?? 0) !== gen) {
            // Invalidated mid-read: drop the possibly-stale content, but
            // still notify so the next render re-requests (and re-reads) —
            // otherwise the file would stay missing until something else
            // happens to refresh.
            this.onLoaded();
            return;
          }
          this.entries.set(path, { key, lines: data.split('\n') });
          this.onLoaded();
        },
        () => {
          this.pending.delete(path);
        },
      );
    }
    return null;
  }

  /** Drop one path (vault modify/delete, and both ends of a rename). */
  invalidate(path: string): void {
    this.entries.delete(path);
    this.generation.set(path, (this.generation.get(path) ?? 0) + 1);
  }

  clear(): void {
    this.entries.clear();
    for (const [path, gen] of this.generation) {
      this.generation.set(path, gen + 1);
    }
    for (const path of this.pending) {
      this.generation.set(path, (this.generation.get(path) ?? 0) + 1);
    }
  }
}
