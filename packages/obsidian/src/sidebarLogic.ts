import { quoteQueryValue } from '@taskpaper/core';

/** A named query shown in the sidebar's Searches section for every document. */
export interface GlobalSearch {
  name: string;
  query: string;
}

/** One selected sidebar row. Projects select by line; tags/searches by query. */
export type SidebarSelectionItem =
  | { kind: 'project'; line: number; name: string }
  | { kind: 'tag' | 'search'; query: string };

function sameSelection(a: SidebarSelectionItem, b: SidebarSelectionItem): boolean {
  if (a.kind === 'project' || b.kind === 'project') {
    return a.kind === 'project' && b.kind === 'project' && a.line === b.line;
  }
  return a.kind === b.kind && a.query === b.query;
}

/** True when `item` is part of the current selection. */
export function isSelected(selection: SidebarSelectionItem[], item: SidebarSelectionItem): boolean {
  return selection.some((s) => sameSelection(s, item));
}

/**
 * Click semantics: a plain click replaces the selection (clicking the sole
 * selected row again clears it — the toggle gesture); Ctrl/Cmd+click adds or
 * removes the row from a multi-selection.
 */
export function toggleSelection(
  selection: SidebarSelectionItem[],
  item: SidebarSelectionItem,
  multi: boolean,
): SidebarSelectionItem[] {
  if (!multi) {
    return selection.length === 1 && sameSelection(selection[0], item) ? [] : [item];
  }
  return isSelected(selection, item)
    ? selection.filter((s) => !sameSelection(s, item))
    : [...selection, item];
}

export type ComposedFilter =
  | { type: 'none' }
  /** A single project keeps the precise line-based focus mode. */
  | { type: 'focus'; line: number }
  | { type: 'query'; query: string };

/**
 * Compose the selection into one filter. Rows of the SAME kind union
 * (any-of); different kinds intersect — so projects scope the tags/searches
 * selected with them (matching the original app's project+search behavior).
 */
export function composeSelection(selection: SidebarSelectionItem[]): ComposedFilter {
  if (selection.length === 0) {
    return { type: 'none' };
  }
  if (selection.length === 1 && selection[0].kind === 'project') {
    return { type: 'focus', line: selection[0].line };
  }
  const groups: string[] = [];
  for (const kind of ['project', 'tag', 'search'] as const) {
    const parts = selection
      .filter((s) => s.kind === kind)
      .map((s) => (s.kind === 'project' ? `project ${quoteQueryValue(s.name)}//*` : s.query));
    if (parts.length > 0) {
      groups.push(parts.map((p) => `(${p})`).join(' union '));
    }
  }
  return { type: 'query', query: groups.map((g) => `(${g})`).join(' intersect ') };
}

/** Stable signature component for the selection (for the render guard). */
export function selectionSignature(selection: SidebarSelectionItem[]): string {
  return JSON.stringify(selection);
}

/** The slice of plugin settings the sidebar's rendered DOM depends on. */
export interface SidebarSettings {
  globalSearches: GlobalSearch[];
  includeTags: string;
  excludeTags: string;
}

/**
 * A signature describing everything the sidebar's rendered DOM depends on.
 *
 * The sidebar re-renders only when this signature changes. Crucially it does
 * NOT depend on focus/leaf changes, so clicking from the editor into the
 * sidebar does not rebuild the DOM mid-click (which would swallow the click).
 * `settingsKey` folds in the sidebar-relevant settings (see settingsSignature)
 * so edits in the settings tab invalidate the guard too.
 */
export function sidebarSignature(
  filePath: string | null,
  docLength: number,
  focusedLine: number | null,
  settingsKey: string,
  activeQuery: string | null = null,
  selectionKey = '',
): string {
  if (filePath === null) {
    return 'empty';
  }
  return `${filePath}|${docLength}|${focusedLine ?? '-'}|${activeQuery ?? '-'}|${selectionKey}|${settingsKey}`;
}

/** Serializes the sidebar-relevant settings into a stable signature component. */
export function settingsSignature(settings: SidebarSettings): string {
  return JSON.stringify({
    globalSearches: settings.globalSearches,
    includeTags: settings.includeTags,
    excludeTags: settings.excludeTags,
  });
}

/**
 * Parses a user-entered tag list ("@due @start, today") into clean tag names:
 * split on spaces/commas, strip a leading '@', drop blanks, de-duplicate.
 */
export function parseTagList(raw: string): string[] {
  const names: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const name = part.replace(/^@/, '').trim();
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Applies the include/exclude tag settings to the tag counts found in the
 * document: excluded tags are never shown (even when included), and included
 * tags are always shown — with a count of 0 when absent from the document.
 * Sorted alphabetically, matching the original app's sidebar.
 */
export function visibleTagCounts(
  found: Map<string, number>,
  include: string[],
  exclude: string[],
): Array<[string, number]> {
  const merged = new Map<string, number>();
  for (const name of include) {
    merged.set(name, found.get(name) ?? 0);
  }
  for (const [name, count] of found) {
    merged.set(name, count);
  }
  for (const name of exclude) {
    merged.delete(name);
  }
  return [...merged.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
