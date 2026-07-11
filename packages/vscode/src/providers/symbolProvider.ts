import * as vscode from 'vscode';
import { Item } from '@taskpaper/core';
import { getOutline, tabSizeFor } from '../outline';

/** Exposes projects and tasks to the Outline view and breadcrumbs. */
export class TaskPaperSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const outline = getOutline(document, tabSizeFor(document));
    return outline.roots.map((root) => this.toSymbol(document, root));
  }

  private toSymbol(document: vscode.TextDocument, item: Item): vscode.DocumentSymbol {
    const fullRange = new vscode.Range(
      item.line,
      0,
      item.subtreeEnd,
      document.lineAt(item.subtreeEnd).text.length,
    );
    const selectionRange = document.lineAt(item.line).range;
    const symbol = new vscode.DocumentSymbol(
      item.displayText || item.text || '(empty)',
      tagsDetail(item),
      kindFor(item),
      fullRange,
      selectionRange,
    );
    symbol.children = item.children.map((child) => this.toSymbol(document, child));
    return symbol;
  }
}

function kindFor(item: Item): vscode.SymbolKind {
  switch (item.kind) {
    case 'project':
      return vscode.SymbolKind.Namespace;
    case 'task':
      return item.tags.has('done') ? vscode.SymbolKind.Event : vscode.SymbolKind.Field;
    default:
      return vscode.SymbolKind.String;
  }
}

function tagsDetail(item: Item): string {
  if (item.tags.size === 0) {
    return '';
  }
  return [...item.tags.keys()].map((t) => `@${t}`).join(' ');
}
