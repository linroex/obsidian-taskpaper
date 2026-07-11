import * as vscode from 'vscode';
import { documentCounts } from '@taskpaper/core';
import { getOutline, tabSizeFor } from '../outline';

/** Status-bar item showing today's and overdue task counts for the active document. */
export class TaskPaperStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'taskpaper.showToday';
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.activeTextEditor?.document === e.document) {
          this.schedule();
        }
      }),
    );
    this.update();
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.update(), 200);
  }

  update(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'taskpaper') {
      this.item.hide();
      return;
    }
    const c = documentCounts(getOutline(editor.document, tabSizeFor(editor.document)));
    this.item.text =
      `$(checklist) ${c.today} today` + (c.overdue > 0 ? `  $(warning) ${c.overdue} overdue` : '');
    this.item.tooltip =
      `${c.remaining} remaining · ${c.today} today · ${c.overdue} overdue · ${c.done} done\n` +
      'Click to show @today';
    this.item.show();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.item.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
