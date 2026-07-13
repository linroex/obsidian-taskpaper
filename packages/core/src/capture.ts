/**
 * Quick-capture planning: where to insert a captured task line into an inbox
 * document, creating the target project chain when it doesn't exist yet.
 */
import { buildOutline, Item, lineKind } from './model';
import { stripTags } from './tags';
import { resolveDateExpression } from './dates';

export interface CapturePlan {
  /**
   * Insert `insertText`'s lines BEFORE this original line index;
   * `lines.length` means append at the very end of the document.
   */
  insertLine: number;
  /** The line(s) to insert ('\n'-joined: any missing project lines + the task line). */
  insertText: string;
}

/** Projects one project-level below: walks past non-project items (tasks, notes). */
function childProjects(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    if (item.kind === 'project') {
      out.push(item);
    } else {
      out.push(...childProjects(item.children));
    }
  }
  return out;
}

/** The line just after an item's subtree, excluding its trailing blank separator lines. */
function afterSubtree(item: Item, lines: string[]): number {
  let end = item.subtreeEnd;
  while (end > item.line && lines[end].trim().length === 0) {
    end--;
  }
  return end + 1;
}

/** End-of-document insertion point: before the trailing run of blank lines,
 *  so a document ending in '\n' (a trailing '' element) keeps ending in '\n'. */
function documentEnd(lines: string[]): number {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim().length === 0) {
    end--;
  }
  return end;
}

/**
 * Plan inserting a captured task line into the document.
 *
 *  - Empty `projectPath` → append at the document end.
 *  - Otherwise the path ('收件匣' or 'Work/收件匣') is matched segment by
 *    segment against the nested project structure (tag-stripped names, first
 *    match in document order — an exact path disambiguates duplicate names).
 *    The task is inserted as the LAST direct child, after the project's
 *    entire subtree, indented one level deeper using tabs.
 *  - Missing segments are created: the plan reuses the deepest existing path
 *    prefix and adds the remaining project line(s) beneath it (at the
 *    document end when nothing matches), with the task nested inside.
 *
 * Trailing-newline behavior: insertions land before any trailing run of
 * blank lines, so splicing `insertText.split('\n')` at `insertLine` keeps
 * the document's trailing-newline convention exactly as it was.
 */
export function planCapture(
  lines: string[],
  taskText: string,
  projectPath: string,
  tabSize = 4,
): CapturePlan {
  const segments = projectPath
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) {
    return { insertLine: documentEnd(lines), insertText: taskText };
  }

  const outline = buildOutline(lines, tabSize);
  let candidates = childProjects(outline.roots);
  let matched: Item | null = null;
  let depth = 0;
  for (const segment of segments) {
    const next = candidates.find((p) => stripTags(p.displayText) === segment);
    if (!next) {
      break;
    }
    matched = next;
    depth++;
    candidates = childProjects(next.children);
  }

  if (matched && depth === segments.length) {
    return {
      insertLine: afterSubtree(matched, lines),
      insertText: childIndent(matched, lines) + taskText,
    };
  }

  // Create the missing tail of the path under the deepest existing prefix.
  const insertLine = matched ? afterSubtree(matched, lines) : documentEnd(lines);
  const base = matched ? childIndent(matched, lines) : '';
  const created: string[] = [];
  for (let i = depth; i < segments.length; i++) {
    created.push(base + '\t'.repeat(i - depth) + segments[i] + ':');
  }
  created.push(base + '\t'.repeat(segments.length - depth) + taskText);
  return { insertLine, insertText: created.join('\n') };
}

/**
 * The indentation for a new direct child of `project`: copy the last direct
 * child's ACTUAL leading whitespace (a space-indented document keeps its
 * convention, a deeper-than-level project keeps its offset). With no children
 * yet, the project's own indent plus one tab.
 */
function childIndent(project: Item, lines: string[]): string {
  const last = project.children[project.children.length - 1];
  const from = last ? lines[last.line] : null;
  if (from !== null) {
    return /^[\t ]*/.exec(from)?.[0] ?? '';
  }
  return (/^[\t ]*/.exec(lines[project.line])?.[0] ?? '') + '\t';
}

/**
 * Normalize quick-capture input into a document line: trim, prefix `- `
 * unless the text is already a task or project, and resolve natural-language
 * date values inside recognized date tags (@due/@start/@defer) to ISO dates.
 * Unresolvable date expressions are left as typed.
 */
export function normalizeCaptureText(text: string, now: Date = new Date()): string {
  let line = text.trim();
  if (line.length === 0) {
    return '';
  }
  // Project detection must be escape-aware: lineKind's project regex doesn't
  // understand `\)` inside tag values, but stripTags does — `X: @m(a \) b)`
  // stays a project, not a task.
  if (lineKind(line) === 'note' && !stripTags(line).trimEnd().endsWith(':')) {
    line = '- ' + line;
  }
  return line.replace(/(@(?:due|start|defer))\(([^)]*)\)/g, (full, name: string, value: string) => {
    const iso = resolveDateExpression(value.trim(), now);
    return iso ? `${name}(${iso})` : full;
  });
}
