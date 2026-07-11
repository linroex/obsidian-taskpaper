import { Notice } from 'obsidian';
import { ChangeSpec, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { foldAll, foldEffect, unfoldAll } from '@codemirror/language';
import {
  addTag,
  deleteBranch,
  duplicateBranch,
  focusOutTarget,
  focusVisibleLines,
  formatTag,
  groupItems,
  hasTag,
  indentItem,
  Item,
  ItemKind,
  itemAtLine,
  moveBranchToProject,
  moveItemDown,
  moveItemUp,
  outdentItem,
  removeAllTags,
  removeTag,
  setLineKind,
  setTagValue,
  todayStamp,
} from '@taskpaper/core';
import { outlineOf } from './editor/outline';
import { setFilterEffect } from './editor/filter';
import { applyOutlineOp, dispatchOutlineEdit, docLines } from './editor/outlineEdit';
import { DateModal, QueryModal, ProjectSuggestModal, SaveSearchModal, TextPromptModal } from './modals';
import type TaskPaperPlugin from './main';
import { TaskPaperView } from './view';

export class TaskPaperCommands {
  constructor(private plugin: TaskPaperPlugin) {}

  private get settings() {
    return this.plugin.settings;
  }

  toggleDone(view: TaskPaperView): void {
    const stamp = todayStamp(this.settings.doneIncludesTime);
    this.applyToSelectedLines(view.editor, (text) =>
      hasTag(text, 'done')
        ? removeTag(text, 'done')
        : addTag(removeTag(text, 'today'), 'done', stamp),
    );
  }

  toggleToday(view: TaskPaperView): void {
    this.applyToSelectedLines(view.editor, (text) =>
      hasTag(text, 'today') ? removeTag(text, 'today') : addTag(text, 'today'),
    );
  }

  toggleTag(view: TaskPaperView): void {
    const modal = new QueryModal(this.plugin.app, 'flag', (input) => {
      if (!input) {
        return;
      }
      const match = /^@?([A-Za-z0-9._-]+)(?:\((.*)\))?$/.exec(input.trim());
      if (!match) {
        new Notice(`"${input}" is not a valid tag.`);
        return;
      }
      const name = match[1];
      const value = match[2];
      this.applyToSelectedLines(view.editor, (text) =>
        hasTag(text, name) ? removeTag(text, name) : addTag(text, name, value),
      );
    });
    modal.open();
  }

  newTask(view: TaskPaperView): void {
    const state = view.editor.state;
    const line = state.doc.lineAt(state.selection.main.head);
    const indent = /^[\t ]*/.exec(line.text)?.[0] ?? '';
    const insert = `\n${indent}- `;
    view.editor.dispatch({
      changes: { from: line.to, insert },
      selection: EditorSelection.cursor(line.to + insert.length),
      scrollIntoView: true,
    });
    view.editor.focus();
  }

  /** Insert a new project line after the current one, at the same indent, cursor before the ':'. */
  newProject(view: TaskPaperView): void {
    const state = view.editor.state;
    const line = state.doc.lineAt(state.selection.main.head);
    const indent = /^[\t ]*/.exec(line.text)?.[0] ?? '';
    const insert = `\n${indent}:`;
    view.editor.dispatch({
      changes: { from: line.to, insert },
      selection: EditorSelection.cursor(line.to + insert.length - 1),
      scrollIntoView: true,
    });
    view.editor.focus();
  }

  /** Insert a new note line after the current one, indented one level as its child. */
  newNote(view: TaskPaperView): void {
    const state = view.editor.state;
    const line = state.doc.lineAt(state.selection.main.head);
    const indent = /^[\t ]*/.exec(line.text)?.[0] ?? '';
    const insert = `\n${indent}\t`;
    view.editor.dispatch({
      changes: { from: line.to, insert },
      selection: EditorSelection.cursor(line.to + insert.length),
      scrollIntoView: true,
    });
    view.editor.focus();
  }

  /** Convert each selected line to the given kind, preserving indentation and tags. */
  formatAs(view: TaskPaperView, kind: ItemKind): void {
    this.applyToSelectedLines(view.editor, (text) => setLineKind(text, kind));
  }

  /** Wrap the selected items in a new project named via a prompt. */
  group(view: TaskPaperView): void {
    new TextPromptModal(this.plugin.app, 'Group', '專案名稱', (name) => {
      const state = view.editor.state;
      const [start, end] = selectedLineRange(state);
      const result = groupItems(docLines(state), start, end, name, 4);
      if (result) {
        dispatchOutlineEdit(view.editor, result);
        view.editor.focus();
      }
    }).open();
  }

  /** Duplicate the current item's entire branch immediately after it. */
  duplicate(view: TaskPaperView): void {
    applyOutlineOp(view.editor, duplicateBranch);
  }

  /** Delete the selected item(s) including their subtrees. */
  deleteItems(view: TaskPaperView): void {
    const state = view.editor.state;
    const [start, end] = selectedLineRange(state);
    const result = deleteBranch(docLines(state), start, end, 4);
    if (result) {
      dispatchOutlineEdit(view.editor, result);
    }
  }

  /** Move the current branch to the end of a picked project, as its direct child. */
  moveToProject(view: TaskPaperView): void {
    const state = view.editor.state;
    const outline = outlineOf(state);
    const curLine = state.doc.lineAt(state.selection.main.head).number - 1;
    const item = itemAtLine(outline, curLine);
    if (!item) {
      return;
    }
    const projects = outline.items.filter(
      (p) => p.kind === 'project' && (p.line < item.line || p.line > item.subtreeEnd),
    );
    if (projects.length === 0) {
      new Notice('No projects in this document.');
      return;
    }
    new ProjectSuggestModal(
      this.plugin.app,
      projects,
      (target: Item) => {
        const result = moveBranchToProject(docLines(view.editor.state), item.line, target.line, 4);
        if (result) {
          dispatchOutlineEdit(view.editor, result);
          view.editor.focus();
        }
      },
      'Move to project',
    ).open();
  }

  /** Prompt for a natural-language date and set @due(date)/@start(date) on selected lines. */
  tagWithDate(view: TaskPaperView, name: 'due' | 'start'): void {
    const title = name === 'due' ? 'Tag with due' : 'Tag with start';
    new DateModal(this.plugin.app, title, (iso) => {
      this.applyToSelectedLines(view.editor, (text) => setTagValue(text, name, iso));
    }).open();
  }

  /** Prompt for a natural-language date and insert the resolved ISO date at the cursor. */
  insertDate(view: TaskPaperView): void {
    new DateModal(this.plugin.app, 'Insert date', (iso) => {
      const range = view.editor.state.selection.main;
      view.editor.dispatch({
        changes: { from: range.from, to: range.to, insert: iso },
        selection: EditorSelection.cursor(range.from + iso.length),
        scrollIntoView: true,
      });
      view.editor.focus();
    }).open();
  }

  /** Strip every @tag from the selected lines. */
  removeTags(view: TaskPaperView): void {
    this.applyToSelectedLines(view.editor, (text) => removeAllTags(text));
  }

  /** Step the sidebar focus up one level (ancestor project), or clear it at top level. */
  focusOut(view: TaskPaperView): void {
    if (view.focusedLine === null) {
      return;
    }
    const outline = outlineOf(view.editor.state);
    const parentLine = focusOutTarget(outline, view.focusedLine);
    if (parentLine === null) {
      this.clearFocus(view);
      return;
    }
    view.focusedLine = parentLine;
    view.editor.dispatch({
      effects: setFilterEffect.of({
        mode: 'focus',
        visible: focusVisibleLines(outline, parentLine),
        hide: this.settings.filterHidesInsteadOfDims,
      }),
      selection: EditorSelection.cursor(view.editor.state.doc.line(parentLine + 1).from),
      scrollIntoView: true,
    });
    this.plugin.refreshSidebar();
  }

  focus(view: TaskPaperView): void {
    const state = view.editor.state;
    const outline = outlineOf(state);
    const curLine = state.doc.lineAt(state.selection.main.head).number - 1;
    const current = itemAtLine(outline, curLine);
    if (!current) {
      return;
    }
    let root = current;
    while (root.parent) {
      root = root.parent;
    }
    unfoldAll(view.editor);
    const effects = [];
    for (const r of outline.roots) {
      if (r === root || r.subtreeEnd <= r.line) {
        continue;
      }
      const from = state.doc.line(r.line + 1).to;
      const to = state.doc.line(r.subtreeEnd + 1).to;
      effects.push(foldEffect.of({ from, to }));
    }
    if (effects.length > 0) {
      view.editor.dispatch({ effects });
    }
  }

  clearFocus(view: TaskPaperView): void {
    view.focusedLine = null;
    unfoldAll(view.editor);
    view.editor.dispatch({ effects: setFilterEffect.of(null) });
    this.plugin.refreshSidebar();
  }

  filter(view: TaskPaperView): void {
    const modal = new QueryModal(this.plugin.app, '@today', (query) => {
      view.focusedLine = null;
      view.editor.dispatch({
        effects: setFilterEffect.of(
          query ? { mode: 'query', query, hide: this.settings.filterHidesInsteadOfDims } : null,
        ),
      });
      this.plugin.refreshSidebar();
    });
    modal.open();
  }

  clearFilter(view: TaskPaperView): void {
    view.focusedLine = null;
    view.editor.dispatch({ effects: setFilterEffect.of(null) });
    this.plugin.refreshSidebar();
  }

  goToProject(view: TaskPaperView): void {
    const state = view.editor.state;
    const outline = outlineOf(state);
    const projects = outline.items.filter((i) => i.kind === 'project');
    if (projects.length === 0) {
      new Notice('No projects in this document.');
      return;
    }
    new ProjectSuggestModal(this.plugin.app, projects, (item: Item) => {
      const pos = state.doc.line(item.line + 1).from;
      view.editor.dispatch({
        selection: EditorSelection.cursor(pos),
        scrollIntoView: true,
      });
      view.editor.focus();
    }).open();
  }

  moveUp(view: TaskPaperView): void {
    applyOutlineOp(view.editor, moveItemUp);
  }
  moveDown(view: TaskPaperView): void {
    applyOutlineOp(view.editor, moveItemDown);
  }
  indent(view: TaskPaperView): void {
    applyOutlineOp(view.editor, indentItem);
  }
  outdent(view: TaskPaperView): void {
    applyOutlineOp(view.editor, outdentItem);
  }

  saveSearch(view: TaskPaperView): void {
    new SaveSearchModal(this.plugin.app, (name, query) => {
      const state = view.editor.state;
      const outline = outlineOf(state);
      const br = state.lineBreak;
      const entry = `\t- ${name} ${formatTag('search', query)}`;
      const searches = outline.roots.find(
        (r) => r.kind === 'project' && r.displayText.trim() === 'Searches',
      );
      if (searches) {
        const pos =
          searches.subtreeEnd + 1 < state.doc.lines
            ? state.doc.line(searches.subtreeEnd + 2).from
            : state.doc.line(searches.subtreeEnd + 1).to;
        const insert =
          searches.subtreeEnd + 1 < state.doc.lines ? `${entry}${br}` : `${br}${entry}`;
        view.editor.dispatch({ changes: { from: pos, insert } });
      } else {
        const last = state.doc.line(state.doc.lines);
        const lead = last.text.trim().length > 0 ? br : '';
        view.editor.dispatch({
          changes: { from: last.to, insert: `${lead}${br}Searches:${br}${entry}` },
        });
      }
    }).open();
  }

  foldAll(view: TaskPaperView): void {
    foldAll(view.editor);
  }

  unfoldAll(view: TaskPaperView): void {
    unfoldAll(view.editor);
  }

  archiveDone(view: TaskPaperView): void {
    const state = view.editor.state;
    const outline = outlineOf(state);
    const archiveName = this.settings.archiveProjectName;
    const nl = state.lineBreak;

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
      new Notice('No @done items to archive.');
      return;
    }

    const blocks: string[] = [];
    for (const root of roots) {
      const projectName = enclosingProjectName(root, archiveName);
      const lines: string[] = [];
      for (let ln = root.line; ln <= root.subtreeEnd; ln++) {
        const item = outline.items.find((i) => i.line === ln);
        const text = state.doc.line(ln + 1).text;
        if (!item) {
          lines.push(text.trim().length === 0 ? '' : '\t'.repeat(root.level + 1) + text.trim());
          continue;
        }
        let body = item.text;
        if (ln === root.line && projectName && !item.tags.has('project')) {
          body = addTag(body, 'project', projectName);
        }
        const newLevel = 1 + (item.level - root.level);
        lines.push('\t'.repeat(newLevel) + body);
      }
      blocks.push(lines.join(nl));
    }

    const changes: ChangeSpec[] = [];
    for (const root of roots) {
      const from = state.doc.line(root.line + 1).from;
      const to =
        root.subtreeEnd + 1 < state.doc.lines
          ? state.doc.line(root.subtreeEnd + 2).from
          : state.doc.line(root.subtreeEnd + 1).to;
      changes.push({ from, to, insert: '' });
    }

    const archivedText = blocks.join(nl) + nl;
    if (archiveProject) {
      if (archiveProject.subtreeEnd + 1 < state.doc.lines) {
        const pos = state.doc.line(archiveProject.subtreeEnd + 2).from;
        changes.push({ from: pos, insert: archivedText });
      } else {
        const pos = state.doc.line(archiveProject.subtreeEnd + 1).to;
        changes.push({ from: pos, insert: nl + archivedText });
      }
    } else {
      const lastLine = state.doc.line(state.doc.lines);
      const lead = lastLine.text.trim().length > 0 ? nl : '';
      changes.push({
        from: lastLine.to,
        insert: `${lead}${nl}${archiveName}:${nl}${archivedText}`,
      });
    }

    view.editor.dispatch({ changes });
  }

  private applyToSelectedLines(
    editor: EditorView,
    transform: (text: string) => string | null,
  ): void {
    const state = editor.state;
    const seen = new Set<number>();
    const changes: ChangeSpec[] = [];
    for (const range of state.selection.ranges) {
      const startLine = state.doc.lineAt(range.from).number;
      const endLine = state.doc.lineAt(range.to).number;
      for (let n = startLine; n <= endLine; n++) {
        if (seen.has(n)) {
          continue;
        }
        seen.add(n);
        const line = state.doc.line(n);
        if (line.text.trim().length === 0) {
          continue;
        }
        const next = transform(line.text);
        if (next !== null && next !== line.text) {
          changes.push({ from: line.from, to: line.to, insert: next });
        }
      }
    }
    if (changes.length > 0) {
      editor.dispatch({ changes });
    }
  }
}

/** Smallest [first, last] 0-based line range covering every selection range. */
function selectedLineRange(state: EditorState): [number, number] {
  let start = Infinity;
  let end = -1;
  for (const range of state.selection.ranges) {
    start = Math.min(start, state.doc.lineAt(range.from).number - 1);
    end = Math.max(end, state.doc.lineAt(range.to).number - 1);
  }
  return [start, end];
}

function isWithin(item: Item, ancestor: Item): boolean {
  if (item === ancestor) {
    return true;
  }
  for (let a = item.parent; a; a = a.parent) {
    if (a === ancestor) {
      return true;
    }
  }
  return false;
}

function enclosingProjectName(item: Item, archiveName: string): string | undefined {
  for (let a = item.parent; a; a = a.parent) {
    if (a.kind === 'project') {
      const name = a.displayText.trim();
      return name === archiveName ? undefined : name;
    }
  }
  return undefined;
}
