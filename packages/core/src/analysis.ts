import { isPastDate, parseDate } from './dates';
import { Item, Outline } from './model';
import { formatTag, stripTags } from './tags';

export interface ProjectStat {
  remaining: number;
  total: number;
}

/** Count incomplete vs total tasks beneath each project. */
export function projectStats(outline: Outline): Map<Item, ProjectStat> {
  const map = new Map<Item, ProjectStat>();
  for (const project of outline.items) {
    if (project.kind !== 'project') {
      continue;
    }
    let total = 0;
    let done = 0;
    const stack = [...project.children];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.kind === 'task') {
        total++;
        if (node.tags.has('done')) {
          done++;
        }
      }
      stack.push(...node.children);
    }
    map.set(project, { remaining: total - done, total });
  }
  return map;
}

export interface DocumentCounts {
  remaining: number;
  done: number;
  today: number;
  overdue: number;
  dueToday: number;
}

/** Document-wide task counts for status bars and badges. */
export function documentCounts(outline: Outline, now: Date = new Date()): DocumentCounts {
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const counts: DocumentCounts = { remaining: 0, done: 0, today: 0, overdue: 0, dueToday: 0 };
  for (const item of outline.items) {
    if (item.kind !== 'task') {
      continue;
    }
    if (item.tags.has('done')) {
      counts.done++;
      continue;
    }
    counts.remaining++;
    if (item.tags.has('today')) {
      counts.today++;
    }
    const due = item.tags.get('due');
    if (due) {
      if (isPastDate(due, now)) {
        counts.overdue++;
      } else if (parseDate(due, now) === todayMidnight) {
        counts.dueToday++;
      }
    }
  }
  return counts;
}

/**
 * Distinct values per tag name across the outline — the original sidebar
 * lists each value as a child row under its tag. Multi-values are split on
 * commas (`@priority(1,2)` yields '1' and '2'); values sort alphabetically.
 */
export function tagNamesToValues(outline: Outline): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const item of outline.items) {
    for (const [name, value] of item.tags) {
      let set = sets.get(name);
      if (!set) {
        set = new Set();
        sets.set(name, set);
      }
      for (const part of (value ?? '').split(',')) {
        const v = part.trim();
        if (v) {
          set.add(v);
        }
      }
    }
  }
  const out = new Map<string, string[]>();
  for (const [name, set] of sets) {
    out.set(name, [...set].sort((a, b) => a.localeCompare(b)));
  }
  return out;
}

/**
 * How many items carry each distinct value of each tag (comma-split, like
 * tagNamesToValues) — the sidebar's value rows show these counts.
 */
export function tagValueCounts(outline: Outline): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const item of outline.items) {
    for (const [name, value] of item.tags) {
      let counts = out.get(name);
      if (!counts) {
        counts = new Map();
        out.set(name, counts);
      }
      const seen = new Set<string>();
      for (const part of (value ?? '').split(',')) {
        const v = part.trim();
        if (v && !seen.has(v)) {
          seen.add(v);
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
      }
    }
  }
  return out;
}

export interface SavedSearch {
  name: string;
  query: string;
  line: number;
}

/** Extract saved searches — items carrying an `@search(query)` tag. */
export function savedSearches(outline: Outline): SavedSearch[] {
  const out: SavedSearch[] = [];
  for (const item of outline.items) {
    const query = item.tags.get('search');
    if (query === undefined || query === '') {
      continue;
    }
    const name =
      stripTags(item.displayText) || query;
    out.push({ name, query, line: item.line });
  }
  return out;
}

/**
 * Rewrite a saved-search line in place with a new name and @search(query),
 * preserving its indentation and leading `- ` task marker (if any).
 */
export function rewriteSearchLine(lineText: string, name: string, query: string): string {
  const indent = /^[\t ]*/.exec(lineText)?.[0] ?? '';
  const body = lineText.slice(indent.length);
  const marker = /^-(\s|$)/.test(body) ? '- ' : '';
  return `${indent}${marker}${name} ${formatTag('search', query)}`;
}
