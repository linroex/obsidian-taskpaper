/**
 * Light Markdown → TaskPaper conversion for "轉換為 TaskPaper" on a note:
 *
 *  - `# Heading`      → `Heading:` (heading level − 1 tabs of indent, so a
 *                        note's heading structure becomes nested projects)
 *  - `- [ ] task`     → `- task`
 *  - `- [x] task`     → `- task @done`
 *  - `* item` / `+ item` → `- item`
 *  - leading spaces in list items normalize to tabs, using ONE step for the
 *    whole document (4 when every space-indent is a multiple of 4, else 2)
 *  - fenced code blocks (``` … ```) pass through completely untouched
 *  - everything else passes through unchanged (it reads as notes)
 *
 * Deliberately conservative: no re-parenting of body text under headings, no
 * inline-markup rewriting — the result stays a faithful, readable outline.
 */
export function markdownToTaskPaper(lines: string[]): string[] {
  const step = detectIndentStep(lines);
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) {
      return line; // code blocks are content, not outline structure
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim().replace(/\s*#+\s*$/, '');
      return '\t'.repeat(level - 1) + (title.endsWith(':') ? title : `${title}:`);
    }

    const list = /^([\t ]*)([-*+])\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line);
    if (list) {
      const indent = normalizeIndent(list[1], step);
      const done = list[3] !== undefined && list[3].toLowerCase() === 'x';
      const body = list[4].trimEnd();
      return `${indent}- ${body}${done ? ' @done' : ''}`;
    }

    return line;
  });
}

/**
 * The document's space-indent unit: 4 only when EVERY space-indented list
 * line uses a multiple of 4 — one inconsistent line means 2 (the common
 * Markdown style). A single per-document step keeps hierarchy intact;
 * deciding per line scrambled 2-space-nested lists.
 */
function detectIndentStep(lines: string[]): number {
  let sawSpaces = false;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const list = /^([\t ]*)[-*+]\s+/.exec(line);
    if (!list) {
      continue;
    }
    const spaces = list[1].replace(/\t/g, '').length;
    if (spaces > 0) {
      sawSpaces = true;
      if (spaces % 4 !== 0) {
        return 2;
      }
    }
  }
  return sawSpaces ? 4 : 2;
}

/** Leading whitespace → tabs: existing tabs kept, spaces divided by `step`. */
function normalizeIndent(ws: string, step: number): string {
  if (ws.length === 0 || !ws.includes(' ')) {
    return ws;
  }
  const tabs = (ws.match(/\t/g) ?? []).length;
  const spaces = ws.replace(/\t/g, '').length;
  return '\t'.repeat(tabs + Math.floor(spaces / step));
}
