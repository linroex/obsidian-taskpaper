import * as vscode from 'vscode';
import {
  indentItem,
  moveItemDown,
  moveItemUp,
  outdentItem,
  OutlineEdit,
} from '@taskpaper/core';
import { tabSizeFor } from '../outline';

type Op = (lines: string[], line: number, tabSize: number) => OutlineEdit | null;

async function apply(editor: vscode.TextEditor, op: Op): Promise<void> {
  const doc = editor.document;
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const lines = doc.getText().split(/\r?\n/);
  const active = editor.selection.active;
  const result = op(lines, active.line, tabSizeFor(doc));
  if (!result) {
    return;
  }
  const fullRange = new vscode.Range(
    0,
    0,
    doc.lineCount - 1,
    doc.lineAt(doc.lineCount - 1).text.length,
  );
  await editor.edit((b) => b.replace(fullRange, result.lines.join(eol)));
  const newText = result.lines[result.cursorLine] ?? '';
  const pos = new vscode.Position(result.cursorLine, Math.min(active.character, newText.length));
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos));
}

export const moveUp = (e: vscode.TextEditor) => apply(e, moveItemUp);
export const moveDown = (e: vscode.TextEditor) => apply(e, moveItemDown);
export const indent = (e: vscode.TextEditor) => apply(e, indentItem);
export const outdent = (e: vscode.TextEditor) => apply(e, outdentItem);
