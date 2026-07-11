/**
 * Pure logic behind the "Go to anything…" / "Go to tag…" palettes (original
 * TaskPaper 3 Palette > Go to Anything / Go to Tag): collect the entries a
 * document offers, and apply the chosen one to an editor. No 'obsidian'
 * imports — the modal itself is thin glue in modals.ts, so this whole layer
 * runs headlessly in tests.
 */
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { Outline, quoteQueryValue, savedSearches, tagNamesToValues } from '@taskpaper/core';
import { setFilterEffect } from './editor/filter';
import { outlineOf } from './editor/outline';
import type { GlobalSearch } from './sidebarLogic';

/** One row of a palette: jump to a project line, or apply a query filter. */
export type PaletteEntry =
  | { kind: 'project'; text: string; line: number; name: string }
  | { kind: 'search'; text: string; query: string }
  | { kind: 'tag'; text: string; query: string };

/** Every project in the document, prefixed with its palette group. */
export function projectEntries(outline: Outline, prefix = ''): PaletteEntry[] {
  return outline.items
    .filter((i) => i.kind === 'project')
    .map((p) => ({
      kind: 'project' as const,
      text: `${prefix}${p.displayText}`,
      line: p.line,
      name: p.displayText,
    }));
}

/** All saved searches: global (settings) first, then the document's @search items. */
export function searchEntries(
  outline: Outline,
  globalSearches: GlobalSearch[],
  prefix = '',
): PaletteEntry[] {
  const global = globalSearches
    .filter((s) => s.query.trim() !== '')
    .map((s) => ({
      kind: 'search' as const,
      text: `${prefix}${s.name.trim() || s.query}（全域） — ${s.query}`,
      query: s.query,
    }));
  const doc = savedSearches(outline).map((s) => ({
    kind: 'search' as const,
    text: `${prefix}${s.name} — ${s.query}`,
    query: s.query,
  }));
  return [...global, ...doc];
}

/**
 * Every tag, each followed by its distinct values: @name filters `@name`;
 * a value row filters `@name contains[l] "value"` — the sidebar's queries.
 */
export function tagEntries(outline: Outline, prefix = ''): PaletteEntry[] {
  const namesToValues = tagNamesToValues(outline);
  const names = new Set<string>();
  for (const item of outline.items) {
    for (const name of item.tags.keys()) {
      names.add(name);
    }
  }
  const entries: PaletteEntry[] = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    entries.push({ kind: 'tag', text: `${prefix}@${name}`, query: `@${name}` });
    for (const value of namesToValues.get(name) ?? []) {
      entries.push({
        kind: 'tag',
        text: `${prefix}@${name}(${value})`,
        query: `@${name} contains[l] ${quoteQueryValue(value)}`,
      });
    }
  }
  return entries;
}

/**
 * The "Go to anything…" list: all projects, then all saved searches, then
 * all tags with their values — each row prefixed with its group (matching
 * the sidebar's section headings) so groups stay fuzzy-searchable.
 */
export function goToAnythingEntries(
  outline: Outline,
  globalSearches: GlobalSearch[],
): PaletteEntry[] {
  return [
    ...projectEntries(outline, 'Project: '),
    ...searchEntries(outline, globalSearches, 'Search: '),
    ...tagEntries(outline, 'Tag: '),
  ];
}

/** The "Go to tag…" list: tags and their values only, unprefixed. */
export function goToTagEntries(outline: Outline): PaletteEntry[] {
  return tagEntries(outline);
}

/** What applying a palette entry needs from its owning view/plugin. */
export interface PaletteHost {
  /** Whether filters hide (true) or dim (false) non-matching lines. */
  hide(): boolean;
  /** Record the focused project line (0-based), or clear it with null. */
  setFocusedLine(line: number | null): void;
  /** Refresh filter-dependent UI (the sidebar / status bar). */
  refresh(): void;
}

/**
 * Perform the chosen entry's action — the same thing the sidebar click
 * would do: projects move the cursor to their line; searches and tags
 * apply their query filter.
 */
export function applyPaletteEntry(view: EditorView, host: PaletteHost, entry: PaletteEntry): void {
  if (entry.kind === 'project') {
    // Re-resolve against the CURRENT outline — edits since the palette opened
    // can shift lines, and a length check alone would jump somewhere random.
    const outline = outlineOf(view.state);
    const target =
      outline.items.find(
        (i) => i.line === entry.line && i.kind === 'project' && i.displayText === entry.name,
      ) ?? outline.items.find((i) => i.kind === 'project' && i.displayText === entry.name);
    if (!target) {
      return; // the project no longer exists
    }
    view.dispatch({
      selection: EditorSelection.cursor(view.state.doc.line(target.line + 1).from),
      scrollIntoView: true,
    });
    view.focus();
    return;
  }
  host.setFocusedLine(null);
  view.dispatch({
    effects: setFilterEffect.of({ mode: 'query', query: entry.query, hide: host.hide() }),
  });
  host.refresh();
}
