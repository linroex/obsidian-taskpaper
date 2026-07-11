import * as vscode from 'vscode';
import { Item, runQuery, withAncestors } from '@taskpaper/core';
import { getOutline, tabSizeFor } from '../outline';
import { focusState } from '../providers/focusState';
import { FilteredViewProvider } from '../filteredView';

/**
 * Prompt for a query, dim non-matching lines in place, and open a live results
 * view listing the matches with click-to-jump links.
 */
export async function filter(editor: vscode.TextEditor): Promise<void> {
  const query = await vscode.window.showInputBox({
    prompt: 'TaskPaper query',
    placeHolder: 'e.g.  @today   |   not @done and project   |   @due <= today [d]',
    value: '@today',
  });
  if (query === undefined) {
    return;
  }
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    focusState.clear(editor.document.uri);
    return;
  }
  await applyFilterQuery(editor, trimmed);
}

/** Apply a query: dim non-matching lines in place and open the live results view. */
export async function applyFilterQuery(
  editor: vscode.TextEditor,
  query: string,
): Promise<void> {
  const outline = getOutline(editor.document, tabSizeFor(editor.document));
  let matches: Set<Item>;
  try {
    matches = runQuery(query, outline);
  } catch (err) {
    vscode.window.showErrorMessage(`Query error: ${(err as Error).message}`);
    return;
  }

  // In-place dim: keep matches and their ancestors visible.
  const visible = new Set<number>();
  for (const m of matches) {
    for (const item of withAncestors(m)) {
      visible.add(item.line);
    }
  }
  focusState.set(editor.document.uri, visible);

  // Live results view.
  const uri = FilteredViewProvider.makeUri(editor.document.uri, query);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, 'taskpaper');
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
    preserveFocus: false,
  });
}
