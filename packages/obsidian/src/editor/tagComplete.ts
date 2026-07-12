import {
  autocompletion,
  Completion,
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import { Outline, resolveDateExpression, tagNamesToValues } from '@taskpaper/core';
import { outlineOf } from './outline';

/** Tags TaskPaper always offers, even in an empty document. */
const DEFAULT_TAG_NAMES = ['done', 'today', 'due', 'start', 'search', 'priority', 'flag'];

/** Tags whose values are dates — they also offer natural-language suggestions. */
const DATE_TAG_NAMES = ['due', 'start', 'defer'];

/** Natural-language date expressions offered inside a date tag's parentheses. */
const DATE_SUGGESTIONS = ['today', 'tomorrow', 'next week'];

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
 * Completions for a tag VALUE: the distinct values already used for that tag
 * across the document, plus — for date tags (@due/@start/@defer) — a few
 * natural-language dates that insert their resolved ISO form (pure; testable).
 */
export function collectTagValueCompletions(outline: Outline, name: string): Completion[] {
  const options: Completion[] = (tagNamesToValues(outline).get(name) ?? []).map((value) => ({
    label: value,
    type: 'text',
  }));
  if (DATE_TAG_NAMES.includes(name)) {
    for (const expr of DATE_SUGGESTIONS) {
      const iso = resolveDateExpression(expr);
      if (iso && !options.some((o) => o.label === expr)) {
        // Picking "tomorrow" inserts the resolved ISO date, not the word.
        options.push({ label: expr, detail: iso, apply: iso, type: 'constant' });
      }
    }
  }
  return options;
}

/**
 * Value completion: only active when the cursor sits inside a tag's
 * parentheses — right after `@name(`, or after a comma in a multi-value tag
 * (`@priority(1,`). Plain parentheses, strings, and emails never match: the
 * `@name(` must sit at a tag-token boundary (start of line or whitespace).
 */
function tagValueCompletion(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  // Value segment allows escaped parens, same as TAG_RE (`@note(a\\)b`).
  const open = /(?:^|\s)@([A-Za-z0-9._-]+)\(((?:\\.|[^()\\])*)$/.exec(before);
  if (!open) {
    return null;
  }
  // The value segment being typed: everything after the last comma.
  const segment = open[2].slice(open[2].lastIndexOf(',') + 1);
  const typed = segment.replace(/^\s+/, '');
  const options = collectTagValueCompletions(outlineOf(context.state), open[1]);
  if (options.length === 0) {
    return null;
  }
  return {
    from: context.pos - typed.length,
    options,
    validFor: /^(?:\\.|[^(),\\])*$/,
  };
}

/**
 * Completion source: tag values inside `@name(…)`, otherwise tag names when
 * the cursor sits right after an `@…` token — never during ordinary typing.
 */
export function tagCompletionSource(context: CompletionContext): CompletionResult | null {
  const value = tagValueCompletion(context);
  if (value) {
    return value;
  }
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
