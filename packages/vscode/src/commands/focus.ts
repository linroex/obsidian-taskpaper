import * as vscode from 'vscode';
import { itemAtLine, projectsToFold } from '@taskpaper/core';
import { getOutline, tabSizeFor } from '../outline';
import { focusState } from '../providers/focusState';

/** Focus a specific project by line: fold every other project so only it stays open. */
export async function focusProjectAt(editor: vscode.TextEditor, line: number): Promise<void> {
  const outline = getOutline(editor.document, tabSizeFor(editor.document));
  const foldLines = projectsToFold(outline, line);

  await vscode.commands.executeCommand('editor.unfoldAll');
  if (foldLines.length > 0) {
    await vscode.commands.executeCommand('editor.fold', { selectionLines: foldLines });
  }
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
}

/** Undo project focus (unfold everything). */
export async function clearProjectFocus(): Promise<void> {
  await vscode.commands.executeCommand('editor.unfoldAll');
}

/** Hoist the top-level project containing the cursor: fold and dim everything else. */
export async function focus(editor: vscode.TextEditor): Promise<void> {
  const outline = getOutline(editor.document, tabSizeFor(editor.document));
  const current = itemAtLine(outline, editor.selection.active.line);
  if (!current) {
    return;
  }
  // Walk up to the top-level ancestor.
  let root = current;
  while (root.parent) {
    root = root.parent;
  }

  const visible = new Set<number>();
  for (let ln = root.line; ln <= root.subtreeEnd; ln++) {
    visible.add(ln);
  }
  focusState.set(editor.document.uri, visible);

  const foldLines = outline.roots.filter((r) => r !== root).map((r) => r.line);
  await vscode.commands.executeCommand('editor.unfoldAll');
  if (foldLines.length > 0) {
    await vscode.commands.executeCommand('editor.fold', { selectionLines: foldLines });
  }
  editor.revealRange(
    new vscode.Range(root.line, 0, root.line, 0),
    vscode.TextEditorRevealType.AtTop,
  );
}

export async function clearFocus(editor: vscode.TextEditor): Promise<void> {
  focusState.clear(editor.document.uri);
  await vscode.commands.executeCommand('editor.unfoldAll');
}

/** Quick-pick jump to any project in the document. */
export async function goToProject(editor: vscode.TextEditor): Promise<void> {
  const outline = getOutline(editor.document, tabSizeFor(editor.document));
  const projects = outline.items.filter((i) => i.kind === 'project');
  if (projects.length === 0) {
    vscode.window.showInformationMessage('No projects in this document.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    projects.map((p) => ({
      label: '$(symbol-namespace) ' + '  '.repeat(p.level) + p.displayText,
      description: `line ${p.line + 1}`,
      line: p.line,
    })),
    { placeHolder: 'Go to project' },
  );
  if (!picked) {
    return;
  }
  const pos = new vscode.Position(picked.line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
}
