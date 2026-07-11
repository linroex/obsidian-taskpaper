/** A named query shown in the sidebar's Searches section for every document. */
export interface GlobalSearch {
  name: string;
  query: string;
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
): string {
  if (filePath === null) {
    return 'empty';
  }
  return `${filePath}|${docLength}|${focusedLine ?? '-'}|${activeQuery ?? '-'}|${settingsKey}`;
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
