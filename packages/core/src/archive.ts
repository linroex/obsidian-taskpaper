/**
 * Archiving of @done items — the pure line/outline transformation behind the
 * "Archive Done Items" command, matching the original TaskPaper 3 app:
 *
 *  - archived items are inserted at the TOP of the Archive project
 *    (the original does `archive.insertChildrenBefore(doneItems, archive.firstChild)`),
 *    so newly archived items go above previously archived ones; items archived
 *    in one run keep their document order within the inserted block;
 *  - each archived item gets a @project tag whose value is the FULL ancestor
 *    project path joined with ' / ' (e.g. `@project(2026 Goals / Work)`),
 *    excluding the Archive project itself;
 *  - optionally every tag except @done and @project is stripped.
 */
import { buildOutline, Item } from './model';
import { addTag, parseTags, removeTag } from './tags';

export interface ArchiveOptions {
  /** Name of the archive project (default 'Archive'). */
  archiveName?: string;
  /** Record the item's original project path as @project(...) (default true). */
  addProjectTag?: boolean;
  /** Strip all tags except @done and @project from archived lines (default false). */
  removeExtraTags?: boolean;
}

export interface ArchivePlan {
  /** [start, end) line ranges to delete, ascending, in original coordinates. */
  removals: Array<[number, number]>;
  /**
   * Insert `insertLines` before this original line index; `lines.length`
   * means append at the end of the document.
   */
  insertAt: number;
  /** The archived block (already indented one level under the Archive project). */
  insertLines: string[];
}

/** Tags kept on archived lines when `removeExtraTags` is on. */
export const ARCHIVE_KEPT_TAGS = ['done', 'project'] as const;

/** The ancestor project chain of an item joined with ' / ', outermost first. */
export function ancestorProjectPath(item: Item, excludeName?: string): string | undefined {
  const names: string[] = [];
  for (let a = item.parent; a; a = a.parent) {
    if (a.kind === 'project') {
      const name = a.displayText.trim();
      if (name !== excludeName) {
        names.unshift(name);
      }
    }
  }
  return names.length > 0 ? names.join(' / ') : undefined;
}

/** Remove every tag from a line except the given names, preserving indentation. */
export function stripExtraTags(lineText: string, keep: readonly string[]): string {
  let out = lineText;
  for (const tag of parseTags(lineText)) {
    if (!keep.includes(tag.name)) {
      out = removeTag(out, tag.name);
    }
  }
  return out;
}

/**
 * Plan moving every top-level @done branch into the Archive project.
 * Returns null when there is nothing to archive.
 */
export function planArchiveDone(
  lines: string[],
  tabSize: number,
  options: ArchiveOptions = {},
): ArchivePlan | null {
  const archiveName = options.archiveName ?? 'Archive';
  const addProjectTag_ = options.addProjectTag ?? true;
  const removeExtra = options.removeExtraTags ?? false;

  const outline = buildOutline(lines, tabSize);
  const archiveProject = outline.roots.find(
    (r) => r.kind === 'project' && r.displayText.trim() === archiveName,
  );

  const doneSet = new Set(outline.items.filter((i) => i.tags.has('done')));
  const roots = [...doneSet].filter((item) => {
    if (archiveProject && isWithin(item, archiveProject)) {
      return false;
    }
    for (let a = item.parent; a; a = a.parent) {
      if (doneSet.has(a)) {
        return false;
      }
    }
    return true;
  });
  if (roots.length === 0) {
    return null;
  }

  // A subtree's trailing whitespace-only lines are visual separators, not
  // content — they stay in place instead of being dragged into the Archive
  // (they'd otherwise pile up as stray indented blank lines there).
  const blockEnd = (root: Item): number => {
    let end = root.subtreeEnd;
    while (end > root.line && lines[end].trim().length === 0) {
      end--;
    }
    return end;
  };

  const itemsByLine = new Map(outline.items.map((i) => [i.line, i]));
  const block: string[] = [];
  for (const root of roots) {
    const projectPath = addProjectTag_ ? ancestorProjectPath(root, archiveName) : undefined;
    for (let ln = root.line; ln <= blockEnd(root); ln++) {
      const item = itemsByLine.get(ln);
      if (!item) {
        block.push(''); // only blank lines are not outline items
        continue;
      }
      let body = removeExtra ? stripExtraTags(item.text, ARCHIVE_KEPT_TAGS) : item.text;
      if (ln === root.line && projectPath && !item.tags.has('project')) {
        body = addTag(body, 'project', projectPath);
      }
      block.push('\t'.repeat(1 + (item.level - root.level)) + body);
    }
  }

  // Coalesce adjacent subtree ranges so consumers see disjoint, non-touching removals.
  const removals: Array<[number, number]> = [];
  for (const root of roots) {
    const last = removals[removals.length - 1];
    if (last && last[1] === root.line) {
      last[1] = blockEnd(root) + 1;
    } else {
      removals.push([root.line, blockEnd(root) + 1]);
    }
  }

  if (archiveProject) {
    // Insert immediately after the Archive project line — above existing children.
    return { removals, insertAt: archiveProject.line + 1, insertLines: block };
  }
  // No Archive project yet: create it at the end of the document, separated by
  // a blank line when the surviving document doesn't already end with one.
  let lastSurviving = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!removals.some(([start, end]) => start <= i && i < end)) {
      lastSurviving = i;
      break;
    }
  }
  const needsBlank = lastSurviving >= 0 && lines[lastSurviving].trim().length > 0;
  const insertLines = needsBlank ? ['', `${archiveName}:`, ...block] : [`${archiveName}:`, ...block];
  return { removals, insertAt: lines.length, insertLines };
}

/** Apply an archive plan to the original lines, returning the new document lines. */
export function applyArchivePlan(lines: string[], plan: ArchivePlan): string[] {
  const removed = new Set<number>();
  for (const [start, end] of plan.removals) {
    for (let i = start; i < end; i++) {
      removed.add(i);
    }
  }
  const out: string[] = [];
  for (let i = 0; i <= lines.length; i++) {
    if (i === plan.insertAt) {
      out.push(...plan.insertLines);
    }
    if (i < lines.length && !removed.has(i)) {
      out.push(lines[i]);
    }
  }
  return out;
}

/** Archive every @done branch; returns the new lines, or null when nothing to archive. */
export function archiveDone(
  lines: string[],
  tabSize: number,
  options: ArchiveOptions = {},
): string[] | null {
  const plan = planArchiveDone(lines, tabSize, options);
  return plan ? applyArchivePlan(lines, plan) : null;
}

function isWithin(item: Item, ancestor: Item): boolean {
  for (let a: Item | null = item; a; a = a.parent) {
    if (a === ancestor) {
      return true;
    }
  }
  return false;
}
