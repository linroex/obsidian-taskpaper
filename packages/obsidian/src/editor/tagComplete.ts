import {
  autocompletion,
  Completion,
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import { Outline } from '@taskpaper/core';
import { outlineOf } from './outline';

/** Tags TaskPaper always offers, even in an empty document. */
export const DEFAULT_TAG_NAMES = ['done', 'today', 'due', 'start', 'search', 'priority', 'flag'];

/** All completable tag names: the document's own tags plus the defaults (pure; testable). */
export function collectTagNames(outline: Outline): string[] {
  const names = new Set<string>(DEFAULT_TAG_NAMES);
  for (const item of outline.items) {
    for (const name of item.tags.keys()) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Completion source: only active when the cursor sits right after an `@…`
 * token, so it never pops up during ordinary typing.
 */
export function tagCompletionSource(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/@[A-Za-z0-9._-]*/);
  if (!match) {
    return null;
  }
  // Only at a tag-token boundary: start of line or after whitespace — never
  // inside emails (user@host) or URLs.
  if (match.from > 0) {
    const before = context.state.sliceDoc(match.from - 1, match.from);
    if (!/[\s]/.test(before)) {
      return null;
    }
  }
  const options: Completion[] = collectTagNames(outlineOf(context.state)).map((name) => ({
    label: `@${name}`,
    type: 'keyword',
  }));
  return {
    from: match.from,
    options,
    validFor: /^@[A-Za-z0-9._-]*$/,
  };
}

/** The wired-up autocomplete extension for the editor. */
export const tagAutocomplete = autocompletion({
  override: [tagCompletionSource],
  activateOnTyping: true,
  icons: false,
});
