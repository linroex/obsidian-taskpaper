import * as vscode from 'vscode';

/**
 * Tracks an active focus/filter per document. When a filter is active,
 * `visibleLines` holds the set of line numbers that match (plus their ancestors);
 * decorations dim everything else and commands fold non-matching regions.
 */
class FocusState {
  private readonly byUri = new Map<string, Set<number>>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  isActive(uri: vscode.Uri): boolean {
    return this.byUri.has(uri.toString());
  }

  visibleLines(uri: vscode.Uri): Set<number> | undefined {
    return this.byUri.get(uri.toString());
  }

  set(uri: vscode.Uri, lines: Set<number>): void {
    this.byUri.set(uri.toString(), lines);
    this.emitter.fire(uri);
  }

  clear(uri: vscode.Uri): void {
    if (this.byUri.delete(uri.toString())) {
      this.emitter.fire(uri);
    }
  }
}

export const focusState = new FocusState();
