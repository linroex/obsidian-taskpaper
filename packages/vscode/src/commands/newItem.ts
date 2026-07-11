import * as vscode from 'vscode';
import { lineKind } from '@taskpaper/core';

/** Insert a new task line below the current line, matching indentation. */
export async function newTask(editor: vscode.TextEditor): Promise<void> {
  const pos = editor.selection.active;
  const line = editor.document.lineAt(pos.line);
  const leading = /^[\t ]*/.exec(line.text)?.[0] ?? '';
  // Under a project, nest the new task one level deeper.
  const indent = lineKind(line.text) === 'project' ? leading + '\t' : leading;
  await editor.insertSnippet(
    new vscode.SnippetString(`\n${indent}- $0`),
    line.range.end,
  );
}
