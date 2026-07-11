import * as vscode from 'vscode';
import { formatTag } from '@taskpaper/core';
import { getOutline, tabSizeFor } from '../outline';

/** Prompt for a query + name and store it as an `@search` item under a Searches project. */
export async function saveSearch(editor: vscode.TextEditor): Promise<void> {
  const query = await vscode.window.showInputBox({
    prompt: 'Query to save as a search',
    placeHolder: '@today and not @done',
    value: '@today',
  });
  if (!query || query.trim().length === 0) {
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: 'Name for this search',
    value: query.trim(),
  });
  if (name === undefined) {
    return;
  }

  const doc = editor.document;
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const outline = getOutline(doc, tabSizeFor(doc));
  const searchesProject = outline.roots.find(
    (r) => r.kind === 'project' && r.displayText.trim() === 'Searches',
  );
  const entry = `\t- ${name.trim()} ${formatTag('search', query.trim())}`;

  const edit = new vscode.WorkspaceEdit();
  if (searchesProject) {
    if (searchesProject.subtreeEnd + 1 < doc.lineCount) {
      edit.insert(doc.uri, new vscode.Position(searchesProject.subtreeEnd + 1, 0), `${entry}${eol}`);
    } else {
      edit.insert(doc.uri, doc.lineAt(searchesProject.subtreeEnd).range.end, `${eol}${entry}`);
    }
  } else {
    const last = doc.lineAt(doc.lineCount - 1);
    const lead = last.text.trim().length > 0 ? eol : '';
    edit.insert(doc.uri, last.range.end, `${lead}${eol}Searches:${eol}${entry}`);
  }
  await vscode.workspace.applyEdit(edit);
}
