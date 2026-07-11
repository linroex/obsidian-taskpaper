import { isPastDate, parseDate } from './dates';
import { Item, Outline } from './model';

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
      item.displayText.replace(/\s*@[A-Za-z0-9._-]+(\([^)]*\))?/g, '').trim() || query;
    out.push({ name, query, line: item.line });
  }
  return out;
}
