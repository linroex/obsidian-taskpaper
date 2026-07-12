import * as vscode from 'vscode';
import { archiveDone as coreArchiveDone } from '@taskpaper/core';
import { tabSizeFor } from '../outline';

/**
 * Move every @done item (and its subtree) into a top-level Archive project,
 * tagging each with its originating project for provenance — a thin adapter
 * over the shared core implementation (same semantics as the Obsidian
 * plugin: archived items insert at the TOP of the Archive project).
 * Applied as a single undoable edit.
 */
export async function archiveDone(editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  const archiveName = vscode.workspace
    .getConfiguration('taskpaper')
    .get<string>('archiveProjectName', 'Archive');

  const lines: string[] = [];
  for (let i = 0; i < document.lineCount; i++) {
    lines.push(document.lineAt(i).text);
  }
  const result = coreArchiveDone(lines, tabSizeFor(document), { archiveName });
  if (!result) {
    vscode.window.showInformationMessage('No @done items to archive.');
    return;
  }

  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const fullRange = new vscode.Range(
    new vscode.Position(0, 0),
    document.lineAt(document.lineCount - 1).range.end,
  );
  await editor.edit((edit) => {
    edit.replace(fullRange, result.join(eol));
  });
}
