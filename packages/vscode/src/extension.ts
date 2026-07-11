import * as vscode from 'vscode';
import { quoteQueryValue } from '@taskpaper/core';
import { TaskPaperFoldingProvider } from './providers/foldingProvider';
import { TaskPaperSymbolProvider } from './providers/symbolProvider';
import { TaskPaperCompletionProvider } from './providers/completionProvider';
import { DecorationManager } from './providers/decorations';
import { FilteredViewProvider, FILTER_SCHEME } from './filteredView';
import { toggleDone, toggleToday, toggleTag } from './commands/toggle';
import { newTask } from './commands/newItem';
import { archiveDone } from './commands/archive';
import { focus, clearFocus, goToProject, focusProjectAt, clearProjectFocus } from './commands/focus';
import { filter, applyFilterQuery } from './commands/filter';
import { focusState } from './providers/focusState';
import { moveUp, moveDown, indent, outdent } from './commands/outlineOps';
import { saveSearch } from './commands/saveSearch';
import { TaskPaperTreeProvider } from './providers/treeProvider';
import { TaskPaperStatusBar } from './providers/statusBar';

const LANG = 'taskpaper';
const selector: vscode.DocumentSelector = { language: LANG };

export function activate(context: vscode.ExtensionContext): void {
  const filteredView = new FilteredViewProvider();
  const decorations = new DecorationManager();
  const tree = new TaskPaperTreeProvider(context.subscriptions);
  const statusBar = new TaskPaperStatusBar();

  /** Apply a query from the tree — or clear it when that exact query is
   *  already active (same click-again-to-cancel gesture as project focus). */
  const toggleTreeFilter = async (uri: vscode.Uri, query: string, preserveFocus: boolean) => {
    // Decide BEFORE showing the document — switching editors resets activeFilter.
    const alreadyActive = tree.isActiveFilter(uri, query);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus });
    if (alreadyActive) {
      tree.activeFilter = null;
      tree.refresh();
      // Only drop the filter dimming — leave the user's folds alone.
      focusState.clear(editor.document.uri);
      return;
    }
    if (await applyFilterQuery(editor, query)) {
      tree.activeFilter = { uri: uri.toString(), query };
    }
    tree.refresh();
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('taskpaperOutline', tree),
    statusBar,

    vscode.commands.registerCommand(
      'taskpaper.revealLine',
      async (uri: vscode.Uri, line: number) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
      },
    ),

    vscode.commands.registerCommand(
      'taskpaper.filterTag',
      async (uri: vscode.Uri, name: string, value?: string) => {
        const query =
          value === undefined
            ? `@${name}`
            : `@${name} contains[l] ${quoteQueryValue(value)}`;
        await toggleTreeFilter(uri, query, true);
      },
    ),

    vscode.commands.registerCommand(
      'taskpaper.runSavedSearch',
      (uri: vscode.Uri, query: string) => toggleTreeFilter(uri, query, false),
    ),

    vscode.commands.registerCommand(
      'taskpaper.toggleProjectFocus',
      async (uri: vscode.Uri, line: number) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const already = tree.focused?.uri === uri.toString() && tree.focused?.line === line;
        if (already) {
          await clearProjectFocus();
          tree.focused = null;
        } else {
          await focusProjectAt(editor, line);
          tree.focused = { uri: uri.toString(), line };
        }
        tree.refresh();
      },
    ),

    registerEditorCommand('taskpaper.showToday', async (editor) => {
      await applyFilterQuery(editor, '@today');
    }),

    // Language providers.
    vscode.languages.registerFoldingRangeProvider(selector, new TaskPaperFoldingProvider()),
    vscode.languages.registerDocumentSymbolProvider(selector, new TaskPaperSymbolProvider()),
    vscode.languages.registerCompletionItemProvider(
      selector,
      new TaskPaperCompletionProvider(),
      '@',
      '(',
    ),

    // Filtered results virtual documents.
    vscode.workspace.registerTextDocumentContentProvider(FILTER_SCHEME, filteredView),
    vscode.languages.registerDocumentLinkProvider({ scheme: FILTER_SCHEME }, filteredView),
    filteredView,
    decorations,

    // Keep filtered views in sync with their source documents.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === LANG) {
        filteredView.refreshForSource(e.document.uri);
      }
    }),

    // Commands operating on the active editor.
    registerEditorCommand('taskpaper.toggleDone', toggleDone),
    registerEditorCommand('taskpaper.toggleToday', toggleToday),
    registerEditorCommand('taskpaper.toggleTag', toggleTag),
    registerEditorCommand('taskpaper.newTask', newTask),
    registerEditorCommand('taskpaper.archiveDone', archiveDone),
    registerEditorCommand('taskpaper.focus', focus),
    registerEditorCommand('taskpaper.clearFocus', async (editor) => {
      tree.focused = null;
      tree.activeFilter = null;
      tree.refresh();
      await clearFocus(editor);
    }),
    registerEditorCommand('taskpaper.goToProject', goToProject),
    registerEditorCommand('taskpaper.filter', filter),
    registerEditorCommand('taskpaper.saveSearch', saveSearch),
    registerEditorCommand('taskpaper.moveUp', moveUp),
    registerEditorCommand('taskpaper.moveDown', moveDown),
    registerEditorCommand('taskpaper.indent', indent),
    registerEditorCommand('taskpaper.outdent', outdent),

    // Fold helpers delegate to built-in folding commands.
    vscode.commands.registerCommand('taskpaper.foldLevel1', () =>
      vscode.commands.executeCommand('editor.foldLevel1'),
    ),
    vscode.commands.registerCommand('taskpaper.foldLevel2', () =>
      vscode.commands.executeCommand('editor.foldLevel2'),
    ),
    vscode.commands.registerCommand('taskpaper.unfoldAll', () =>
      vscode.commands.executeCommand('editor.unfoldAll'),
    ),
  );
}

export function deactivate(): void {
  // Disposables are cleaned up via context.subscriptions.
}

function registerEditorCommand(
  id: string,
  handler: (editor: vscode.TextEditor) => void | Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand(id, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== LANG) {
      vscode.window.showInformationMessage('This command only works in a TaskPaper document.');
      return;
    }
    await handler(editor);
  });
}
