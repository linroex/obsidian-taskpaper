import * as vscode from 'vscode';
import { filterContextItems, Item, runQuery } from '@taskpaper/core';
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

/** Apply a query: dim non-matching lines in place and open the live results
 *  view. Returns false when the query failed to parse (nothing applied). */
export async function applyFilterQuery(
  editor: vscode.TextEditor,
  query: string,
): Promise<boolean> {
  const outline = getOutline(editor.document, tabSizeFor(editor.document));
  let matches: Set<Item>;
  try {
    matches = runQuery(query, outline);
  } catch (err) {
    vscode.window.showErrorMessage(`Query error: ${(err as Error).message}`);
    return false;
  }

  // In-place dim: keep each match and its shared filter context visible.
  const visible = new Set<number>();
  for (const m of matches) {
    for (const item of filterContextItems(m)) {
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
  return true;
}
