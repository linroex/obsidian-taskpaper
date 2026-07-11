import { Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { parseTags } from '@taskpaper/core';

export type LinkKind = 'url' | 'www' | 'email' | 'file' | 'path' | 'scheme';

export interface LinkRange {
  /** Start offset within the line. */
  start: number;
  /** End offset (exclusive) within the line. */
  end: number;
  kind: LinkKind;
  /** The matched text. */
  text: string;
}

// One alternative per link kind; order matters (url/file/www before the
// generic scheme so they keep their specific kinds, paths last).
//  - scheme: two+ chars before the `:` so `C:\` (drive letters) never match,
//    and it must start with a letter so times (`16:15`) never match.
//  - path: `/`, `~/`, `./` and `../` prefixes, with `\ `-escaped spaces.
const LINK_RE =
  /(https?:\/\/[^\s]+)|(file:\/\/[^\s]+)|(www\.[^\s]+)|([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})|([A-Za-z][A-Za-z0-9+.-]+:[^\s]+)|((?:\.\.?|~)?\/(?:\\ |[^\s])+)/g;

/** Characters that end a sentence and shouldn't be swallowed into a link. */
const TRAILING = /[.,;:!?'"”』」)>\]]+$/;

/** Find every clickable link in a single line of text (pure; testable). */
export function findLinks(lineText: string): LinkRange[] {
  const links: LinkRange[] = [];
  // Tag ranges, so a generic `scheme:path` never swallows a tag value
  // (`@z(note:abc)` stays a clickable tag, not a link).
  let tagRanges: { start: number; end: number }[] | null = null;
  const insideTag = (from: number, to: number): boolean => {
    tagRanges ??= parseTags(lineText).map((t) => ({ start: t.start, end: t.end }));
    return tagRanges.some((t) => from >= t.start && to <= t.end);
  };
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(lineText))) {
    // Links must start a token: at line start or after whitespace/opening bracket.
    const before = m.index === 0 ? '' : lineText[m.index - 1];
    if (before && !/[\s(<["'「『]/.test(before)) {
      continue;
    }
    let text = m[0];
    // Trim trailing punctuation; keep a `)` only when balanced by a `(` inside.
    const trimmed = text.replace(TRAILING, '');
    if (trimmed.length < text.length) {
      let keep = trimmed;
      const cut = text.slice(trimmed.length);
      for (const ch of cut) {
        if (ch === ')' && (keep.split('(').length - 1) > (keep.split(')').length - 1)) {
          keep += ch;
        } else {
          break;
        }
      }
      text = keep;
    }
    if (text.length === 0) {
      continue;
    }
    const kind: LinkKind = m[1]
      ? 'url'
      : m[2]
        ? 'file'
        : m[3]
          ? 'www'
          : m[4]
            ? 'email'
            : m[5]
              ? 'scheme'
              : 'path';
    // A bare `/` or `~/` isn't a path.
    if (kind === 'path' && text.replace(/^(?:\.\.?|~)/, '').length < 2) {
      continue;
    }
    // Generic schemes inside a tag (`@x(...)`) belong to the tag, not a link.
    if (kind === 'scheme' && insideTag(m.index, m.index + text.length)) {
      continue;
    }
    links.push({ start: m.index, end: m.index + text.length, kind, text });
  }
  return links;
}

/** The href a link opens as (pure; testable). */
export function linkHref(link: Pick<LinkRange, 'kind' | 'text'>): string {
  switch (link.kind) {
    case 'www':
      return `https://${link.text}`;
    case 'email':
      return `mailto:${link.text}`;
    case 'path':
      // Backslash-escaped spaces (`./my\ file.txt`) are unescaped before opening.
      return `file://${link.text.replace(/\\ /g, ' ')}`;
    default:
      return link.text;
  }
}

function buildLinkDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (let i = 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i);
    for (const link of findLinks(line.text)) {
      builder.add(
        line.from + link.start,
        line.from + link.end,
        Decoration.mark({
          class: 'tp-link',
          attributes: { 'data-href': linkHref(link), 'data-kind': link.kind },
        }),
      );
    }
  }
  return builder.finish();
}

const linkDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLinkDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildLinkDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Detect + underline links in item text; clicking one opens it via `open`. */
export function linkExtension(open: (href: string, kind: LinkKind) => void): Extension {
  return [
    linkDecorations,
    EditorView.domEventHandlers({
      click(event) {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const linkEl = target?.closest('.tp-link');
        const href = linkEl?.getAttribute('data-href');
        if (!href) {
          return false;
        }
        event.preventDefault();
        open(href, (linkEl?.getAttribute('data-kind') as LinkKind) ?? 'url');
        return true;
      },
    }),
  ];
}
