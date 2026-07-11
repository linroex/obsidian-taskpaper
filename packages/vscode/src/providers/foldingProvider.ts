import * as vscode from 'vscode';
import { getOutline, tabSizeFor } from '../outline';

/** Indentation-based folding: each item folds the lines of its subtree. */
export class TaskPaperFoldingProvider implements vscode.FoldingRangeProvider {
  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
    const outline = getOutline(document, tabSizeFor(document));
    const ranges: vscode.FoldingRange[] = [];
    for (const item of outline.items) {
      if (item.subtreeEnd > item.line) {
        ranges.push(new vscode.FoldingRange(item.line, item.subtreeEnd));
      }
    }
    return ranges;
  }
}
