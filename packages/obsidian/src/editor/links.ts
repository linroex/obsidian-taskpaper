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
  /** Precomputed href (markdown links: the target, not the display text). */
  href?: string;
  /** Markdown-link part: 'label' = `[text]`, 'url' = `(target)` (dimmed). */
  md?: 'label' | 'url';
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

/** Markdown link syntax: `[text](target)` — target without spaces/parens. */
const MD_LINK_RE = /\[([^\[\]\n]+)\]\(([^()\s]+)\)/g;

/** Classify a markdown link's target the same way bare links are classified. */
function classifyTarget(target: string): LinkKind {
  if (/^https?:\/\//.test(target)) return 'url';
  if (/^file:\/\//.test(target)) return 'file';
  if (/^www\./.test(target)) return 'www';
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(target)) return 'email';
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(target)) return 'scheme';
  return 'path';
}

/** Find every clickable link in a single line of text (pure; testable). */
export function findLinks(lineText: string): LinkRange[] {
  const links: LinkRange[] = [];

  // Markdown links first — their spans suppress the raw-URL scan below so the
  // target inside the parens isn't emitted twice (overlapping marks would
  // break the decoration builder's ordering).
  const mdSpans: { start: number; end: number }[] = [];
  MD_LINK_RE.lastIndex = 0;
  let md: RegExpExecArray | null;
  while ((md = MD_LINK_RE.exec(lineText))) {
    const target = md[2];
    const kind = classifyTarget(target);
    const href = linkHref({ kind, text: target });
    const labelEnd = md.index + 1 + md[1].length + 1; // past `[text]`
    links.push({ start: md.index, end: labelEnd, kind, text: md[1], href, md: 'label' });
    links.push({ start: labelEnd, end: md.index + md[0].length, kind, text: target, href, md: 'url' });
    mdSpans.push({ start: md.index, end: md.index + md[0].length });
  }
  const insideMd = (from: number, to: number): boolean =>
    mdSpans.some((r) => from < r.end && to > r.start);
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
    // Anything inside a markdown link is already covered by its two marks.
    if (insideMd(m.index, m.index + text.length)) {
      continue;
    }
    links.push({ start: m.index, end: m.index + text.length, kind, text });
  }
  return links.sort((a, b) => a.start - b.start);
}

/** The href a link opens as (pure; testable). */
export function linkHref(link: Pick<LinkRange, 'kind' | 'text' | 'href'>): string {
  if (link.href !== undefined) {
    return link.href;
  }
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
  // Viewport-only, like the other decoration plugins.
  const ranges =
    view.visibleRanges.length > 0
      ? view.visibleRanges
      : [{ from: 0, to: view.state.doc.length }];
  let lastLine = 0;
  for (const { from, to } of ranges) {
    const first = Math.max(view.state.doc.lineAt(from).number, lastLine + 1);
    const last = view.state.doc.lineAt(to).number;
    for (let i = first; i <= last; i++) {
      const line = view.state.doc.line(i);
      for (const link of findLinks(line.text)) {
        builder.add(
          line.from + link.start,
          line.from + link.end,
          Decoration.mark({
            class: link.md === 'url' ? 'tp-link tp-link-md-url' : 'tp-link',
            attributes: { 'data-href': linkHref(link), 'data-kind': link.kind },
          }),
        );
      }
      lastLine = i;
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
