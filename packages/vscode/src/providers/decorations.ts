import * as vscode from 'vscode';
import { isPastDate, parseTags } from '@taskpaper/core';
import { getOutline, tabSizeFor } from '../outline';
import { focusState } from './focusState';

/** Manages editor decorations that grammars cannot express (strikethrough, dimming, overdue). */
export class DecorationManager implements vscode.Disposable {
  private readonly done: vscode.TextEditorDecorationType;
  private readonly project: vscode.TextEditorDecorationType;
  private readonly overdue: vscode.TextEditorDecorationType;
  private readonly dim: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    this.done = vscode.window.createTextEditorDecorationType({
      textDecoration: 'line-through',
      opacity: '0.55',
    });
    this.project = vscode.window.createTextEditorDecorationType({
      fontWeight: 'bold',
    });
    this.overdue = vscode.window.createTextEditorDecorationType({
      color: new vscode.ThemeColor('editorError.foreground'),
      fontWeight: 'bold',
    });
    this.dim = vscode.window.createTextEditorDecorationType({
      opacity: '0.3',
    });

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((e) => e && this.scheduleUpdate(e)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === e.document) {
          this.scheduleUpdate(editor);
        }
      }),
      focusState.onDidChange((uri) => {
        const editor = vscode.window.visibleTextEditors.find(
          (ed) => ed.document.uri.toString() === uri.toString(),
        );
        if (editor) {
          this.update(editor);
        }
      }),
    );

    this.updateAllVisible();
  }

  private scheduleUpdate(editor: vscode.TextEditor): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.update(editor), 120);
  }

  updateAllVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.update(editor);
    }
  }

  update(editor: vscode.TextEditor): void {
    if (editor.document.languageId !== 'taskpaper') {
      return;
    }
    const config = vscode.workspace.getConfiguration('taskpaper');
    const strike = config.get<boolean>('strikeDoneItems', true);
    const dimOnFilter = config.get<boolean>('dimNonMatchingOnFilter', true);

    const outline = getOutline(editor.document, tabSizeFor(editor.document));
    const doneRanges: vscode.Range[] = [];
    const projectRanges: vscode.Range[] = [];
    const overdueRanges: vscode.Range[] = [];

    for (const item of outline.items) {
      const lineText = editor.document.lineAt(item.line).text;
      const indentLen = lineText.length - lineText.trimStart().length;
      const contentRange = new vscode.Range(item.line, indentLen, item.line, lineText.length);

      if (item.kind === 'project') {
        projectRanges.push(contentRange);
      }

      const isDone = item.tags.has('done');
      if (strike && isDone) {
        doneRanges.push(contentRange);
      }

      if (!isDone) {
        const due = item.tags.get('due');
        if (due) {
          if (isPastDate(due)) {
            for (const tag of parseTags(lineText)) {
              if (tag.name === 'due') {
                overdueRanges.push(new vscode.Range(item.line, tag.start, item.line, tag.end));
              }
            }
          }
        }
      }
    }

    editor.setDecorations(this.done, doneRanges);
    editor.setDecorations(this.project, projectRanges);
    editor.setDecorations(this.overdue, overdueRanges);

    // Focus / filter dimming.
    const visible = focusState.visibleLines(editor.document.uri);
    if (visible && dimOnFilter) {
      const dimRanges: vscode.Range[] = [];
      for (let line = 0; line < editor.document.lineCount; line++) {
        if (!visible.has(line) && editor.document.lineAt(line).text.trim().length > 0) {
          dimRanges.push(editor.document.lineAt(line).range);
        }
      }
      editor.setDecorations(this.dim, dimRanges);
    } else {
      editor.setDecorations(this.dim, []);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.done.dispose();
    this.project.dispose();
    this.overdue.dispose();
    this.dim.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
