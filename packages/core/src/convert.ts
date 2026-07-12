/**
 * Light Markdown → TaskPaper conversion for "轉換為 TaskPaper" on a note:
 *
 *  - `# Heading`      → `Heading:` (heading level − 1 tabs of indent, so a
 *                        note's heading structure becomes nested projects)
 *  - `- [ ] task`     → `- task`
 *  - `- [x] task`     → `- task @done`
 *  - `* item` / `+ item` → `- item`
 *  - leading spaces in list items normalize to tabs (4- or 2-space steps)
 *  - everything else passes through unchanged (it reads as notes)
 *
 * Deliberately conservative: no re-parenting of body text under headings, no
 * inline-markup rewriting — the result stays a faithful, readable outline.
 */
export function markdownToTaskPaper(lines: string[]): string[] {
  return lines.map((line) => {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim().replace(/\s*#+\s*$/, '');
      return '\t'.repeat(level - 1) + (title.endsWith(':') ? title : `${title}:`);
    }

    const list = /^([\t ]*)([-*+])\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line);
    if (list) {
      const indent = normalizeIndent(list[1]);
      const done = list[3] !== undefined && list[3].toLowerCase() === 'x';
      const body = list[4].trimEnd();
      return `${indent}- ${body}${done ? ' @done' : ''}`;
    }

    return line;
  });
}

/** Leading whitespace → tabs: existing tabs kept, 4 spaces = 1 tab when any
 *  4-space run exists, otherwise 2 spaces = 1 tab (common markdown styles). */
function normalizeIndent(ws: string): string {
  if (ws.length === 0 || !ws.includes(' ')) {
    return ws;
  }
  const tabs = (ws.match(/\t/g) ?? []).length;
  const spaces = ws.replace(/\t/g, '').length;
  const step = spaces % 4 === 0 && spaces > 0 ? 4 : 2;
  return '\t'.repeat(tabs + Math.floor(spaces / step));
}
