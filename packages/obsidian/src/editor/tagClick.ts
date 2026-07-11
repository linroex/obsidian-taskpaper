import { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { FilterSpec, filterSpecField, setFilterEffect } from './filter';

/** Render a tag value as a query literal: bare when a single word, quoted otherwise. */
function queryValueLiteral(value: string): string {
  return /^\w+$/.test(value) ? value : `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * Compute the filter that results from clicking a tag (TaskPaper 3 behavior):
 * clicking a tag's name filters by the tag, clicking its value filters by
 * tag + value; clicking again while that exact filter is active clears it.
 */
export function toggledTagFilter(
  current: FilterSpec | null,
  tagName: string,
  hide: boolean,
  value?: string,
): FilterSpec | null {
  const query =
    value === undefined ? `@${tagName}` : `@${tagName} = ${queryValueLiteral(value)}`;
  if (current && current.mode === 'query' && current.query === query) {
    return null;
  }
  return { mode: 'query', query, hide };
}

export interface TagClickOptions {
  /** Whether the resulting filter hides (true) or dims (false) non-matches. */
  hide(): boolean;
  /** Called after the filter changed (e.g. to refresh the sidebar). */
  onToggle(): void;
}

/**
 * Clicking a rendered `@tag` toggles a filter for that tag. Uses mousedown so
 * the click doesn't also move the cursor into the tag; clicks anywhere else
 * are left to CodeMirror's normal handling.
 */
export function tagClickExtension(opts: TagClickOptions): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target || event.button !== 0) {
        return false;
      }
      // Emails contain an `@domain` that also parses as a tag — links win.
      if (target.closest('.tp-link')) {
        return false;
      }
      const tagEl = target.closest('.tp-tag');
      const name = tagEl?.getAttribute('data-tag');
      if (!name) {
        return false;
      }
      event.preventDefault();
      // The `(value)` part carries data-tag-value → search tag + value.
      const value = tagEl?.getAttribute('data-tag-value') ?? undefined;
      const current = view.state.field(filterSpecField, false) ?? null;
      view.dispatch({
        effects: setFilterEffect.of(toggledTagFilter(current, name, opts.hide(), value)),
      });
      opts.onToggle();
      return true;
    },
  });
}
