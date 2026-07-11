import * as vscode from 'vscode';
import { addTag, hasTag, removeTag, todayStamp } from '@taskpaper/core';

function selectedLines(editor: vscode.TextEditor): number[] {
  const set = new Set<number>();
  for (const sel of editor.selections) {
    for (let line = sel.start.line; line <= sel.end.line; line++) {
      set.add(line);
    }
  }
  return [...set].sort((a, b) => a - b);
}

async function applyToLines(
  editor: vscode.TextEditor,
  transform: (text: string) => string | null,
): Promise<void> {
  const lines = selectedLines(editor);
  await editor.edit((builder) => {
    for (const line of lines) {
      const doc = editor.document.lineAt(line);
      if (doc.text.trim().length === 0) {
        continue;
      }
      const next = transform(doc.text);
      if (next !== null && next !== doc.text) {
        builder.replace(doc.range, next);
      }
    }
  });
}

export async function toggleDone(editor: vscode.TextEditor): Promise<void> {
  const includeTime = vscode.workspace
    .getConfiguration('taskpaper')
    .get<boolean>('doneIncludesTime', false);
  const stamp = todayStamp(includeTime);
  await applyToLines(editor, (text) =>
    hasTag(text, 'done') ? removeTag(text, 'done') : addTag(removeTag(text, 'today'), 'done', stamp),
  );
}

export async function toggleToday(editor: vscode.TextEditor): Promise<void> {
  await applyToLines(editor, (text) =>
    hasTag(text, 'today') ? removeTag(text, 'today') : addTag(text, 'today'),
  );
}

export async function toggleTag(editor: vscode.TextEditor): Promise<void> {
  const input = await vscode.window.showInputBox({
    prompt: 'Tag to toggle (e.g. flag or priority(1))',
    placeHolder: 'flag',
  });
  if (!input) {
    return;
  }
  const match = /^@?([A-Za-z0-9._-]+)(?:\((.*)\))?$/.exec(input.trim());
  if (!match) {
    vscode.window.showWarningMessage(`"${input}" is not a valid tag name.`);
    return;
  }
  const name = match[1];
  const value = match[2];
  await applyToLines(editor, (text) =>
    hasTag(text, name) ? removeTag(text, name) : addTag(text, name, value),
  );
}
