/** A named query shown in the sidebar's Searches section for every document. */
export interface GlobalSearch {
  name: string;
  query: string;
}

/** One selected sidebar row. Projects (and hoists — Alt+click, showing only a
 *  project's contents) select by line; tags/searches by query. */
export type SidebarSelectionItem =
  | { kind: 'project'; line: number; name: string }
  | { kind: 'hoist'; line: number; name: string }
  | { kind: 'tag' | 'search'; query: string };

function sameSelection(a: SidebarSelectionItem, b: SidebarSelectionItem): boolean {
  if (a.kind === 'project' || a.kind === 'hoist') {
    return b.kind === a.kind && a.line === b.line;
  }
  if (b.kind === 'project' || b.kind === 'hoist') {
    return false;
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
  /** A single hoisted project: only its contents (not the project line itself). */
  | { type: 'hoist'; line: number }
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
  if (selection.length === 1 && selection[0].kind === 'hoist') {
    return { type: 'hoist', line: selection[0].line };
  }
  const groups: string[] = [];
  for (const kind of ['project', 'tag', 'search'] as const) {
    const parts = selection
      // A hoist mixed into a multi-selection scopes like a project — its
      // descendants (`//*`) intersect the other kinds.
      .filter((s) => s.kind === kind || (kind === 'project' && s.kind === 'hoist'))
      // Projects match EXACTLY by line (@id) — name matching is substring-
      // based and would confuse duplicate/prefix/unnamed projects. Stale
      // lines are validated against the outline before composing.
      .map((s) =>
        s.kind === 'project' || s.kind === 'hoist' ? `(@id = ${s.line} and project)//*` : s.query,
      );
    if (parts.length > 0) {
      groups.push(parts.map((p) => `(${p})`).join(' union '));
    }
  }
  return { type: 'query', query: groups.map((g) => `(${g})`).join(' intersect ') };
}

/**
 * Drop selected projects (and hoists) whose stored line no longer resolves to
 * a project with the same name — document edits shift lines, and a stale line
 * would focus (or query) the wrong item. `projectNameAt` maps line → cleaned
 * project name, or undefined when that line is not a project.
 */
export function validateSelection(
  selection: SidebarSelectionItem[],
  projectNameAt: (line: number) => string | undefined,
): SidebarSelectionItem[] {
  const valid = selection.filter(
    (s) => (s.kind !== 'project' && s.kind !== 'hoist') || projectNameAt(s.line) === s.name,
  );
  return valid.length === selection.length ? selection : valid;
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
