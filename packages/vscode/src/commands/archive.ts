import * as vscode from 'vscode';
import { planArchiveDone } from '@taskpaper/core';
import { tabSizeFor } from '../outline';

/**
 * Move every @done item (and its subtree) into a top-level Archive project —
 * a thin adapter over the shared core planner, so both platforms match the
 * NATIVE app's semantics: archived items insert at the TOP of the Archive
 * project, and each carries its FULL ancestor project path as
 * `@project(2026 Goals / Work)` (not just the nearest project name).
 *
 * Applied as minimal targeted edits (per-subtree deletes + one insert), so
 * the cursor, selection and fold state of untouched regions survive.
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
  const plan = planArchiveDone(lines, tabSizeFor(document), { archiveName });
  if (!plan) {
    vscode.window.showInformationMessage('No @done items to archive.');
    return;
  }

  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const lastLine = document.lineCount - 1;
  await editor.edit((edit) => {
    for (const [start, end] of plan.removals) {
      if (end <= lastLine) {
        edit.delete(new vscode.Range(start, 0, end, 0));
      } else {
        // Removal reaches EOF: eat the PRECEDING newline instead.
        const from =
          start > 0
            ? document.lineAt(start - 1).range.end
            : new vscode.Position(0, 0);
        edit.delete(new vscode.Range(from, document.lineAt(lastLine).range.end));
      }
    }
    if (plan.insertAt <= lastLine) {
      edit.insert(new vscode.Position(plan.insertAt, 0), plan.insertLines.join(eol) + eol);
    } else {
      edit.insert(document.lineAt(lastLine).range.end, eol + plan.insertLines.join(eol));
    }
  });
}
