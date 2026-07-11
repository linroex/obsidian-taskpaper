import * as vscode from 'vscode';
import { addTag, Item } from '@taskpaper/core';
import { getOutline, tabSizeFor } from '../outline';

/**
 * Move every @done item (and its subtree) into a top-level Archive project,
 * tagging each with its originating project for provenance — mirroring the
 * native app's "Archive Done Items" command. Applied as a single undoable edit.
 */
export async function archiveDone(editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  const outline = getOutline(document, tabSizeFor(document));
  const archiveName = vscode.workspace
    .getConfiguration('taskpaper')
    .get<string>('archiveProjectName', 'Archive');

  const archiveProject = outline.roots.find(
    (r) => r.kind === 'project' && r.displayText.trim() === archiveName,
  );

  const doneSet = new Set(outline.items.filter((i) => i.tags.has('done')));
  // Keep only the topmost done items (a done ancestor already carries its subtree).
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
    vscode.window.showInformationMessage('No @done items to archive.');
    return;
  }

  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const blocks: string[] = [];

  for (const root of roots) {
    const projectName = enclosingProjectName(root, archiveName);
    const lines: string[] = [];
    for (let ln = root.line; ln <= root.subtreeEnd; ln++) {
      const item = outline.items.find((i) => i.line === ln);
      const text = document.lineAt(ln).text;
      if (!item) {
        // Blank or unparsed line inside the subtree: keep as-is (trimmed of indent).
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
    blocks.push(lines.join(eol));
  }

  const edit = new vscode.WorkspaceEdit();

  // Remove originals (full lines including their line breaks).
  for (const root of roots) {
    const start = new vscode.Position(root.line, 0);
    const end =
      root.subtreeEnd + 1 < document.lineCount
        ? new vscode.Position(root.subtreeEnd + 1, 0)
        : document.lineAt(root.subtreeEnd).range.end;
    edit.delete(document.uri, new vscode.Range(start, end));
  }

  const archivedText = blocks.join(eol) + eol;

  if (archiveProject) {
    const insertPos =
      archiveProject.subtreeEnd + 1 < document.lineCount
        ? new vscode.Position(archiveProject.subtreeEnd + 1, 0)
        : document.lineAt(archiveProject.subtreeEnd).range.end;
    const prefix =
      archiveProject.subtreeEnd + 1 < document.lineCount ? '' : eol;
    edit.insert(document.uri, insertPos, prefix + archivedText);
  } else {
    const lastLine = document.lineAt(document.lineCount - 1);
    const needsLead = lastLine.text.trim().length > 0 ? eol : '';
    edit.insert(
      document.uri,
      lastLine.range.end,
      `${needsLead}${eol}${archiveName}:${eol}${archivedText}`,
    );
  }

  await vscode.workspace.applyEdit(edit);
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
