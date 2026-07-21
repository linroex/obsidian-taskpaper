import * as vscode from 'vscode';
import { resolveDateExpression, todayStamp } from '@taskpaper/core';
import { getOutline, tabSizeFor } from '../outline';

const BUILTIN_TAGS = ['at', 'done', 'today', 'due', 'start', 'priority', 'flag', 'search'];

/** Completes tag names after `@` and offers value hints for known value tags. */
export class TaskPaperCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const prefix = document.lineAt(position.line).text.slice(0, position.character);

    // Value completion: @at( , @due( , @start( , @priority(
    const valueMatch = /@(at|due|start|priority)\($/.exec(prefix);
    if (valueMatch) {
      return valueCompletions(valueMatch[1]);
    }

    // Tag-name completion after `@`.
    const tagMatch = /@([A-Za-z0-9._-]*)$/.exec(prefix);
    if (!tagMatch) {
      return [];
    }

    const names = new Set<string>(BUILTIN_TAGS);
    const outline = getOutline(document, tabSizeFor(document));
    for (const item of outline.items) {
      for (const name of item.tags.keys()) {
        names.add(name);
      }
    }

    const replaceRange = new vscode.Range(
      position.line,
      position.character - tagMatch[1].length,
      position.line,
      position.character,
    );

    return [...names].sort().map((name) => {
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Keyword);
      item.detail = BUILTIN_TAGS.includes(name) ? 'TaskPaper tag' : 'tag in document';
      item.range = replaceRange;
      if (name === 'done') {
        item.insertText = new vscode.SnippetString(`done(\${1:${todayStamp(false)}})`);
      } else if (name === 'at' || name === 'due' || name === 'start') {
        item.insertText = new vscode.SnippetString(`${name}(\${1:${todayStamp(false)}})`);
      } else if (name === 'priority') {
        item.insertText = new vscode.SnippetString('priority(${1|1,2,3|})');
      } else {
        item.insertText = name;
      }
      return item;
    });
  }
}

function valueCompletions(tag: string): vscode.CompletionItem[] {
  if (tag === 'priority') {
    return ['1', '2', '3'].map((p) => {
      const item = new vscode.CompletionItem(p, vscode.CompletionItemKind.Value);
      item.detail = `priority ${p}`;
      return item;
    });
  }
  // at / due / start: offer natural-language date values, resolved on insert.
  const expressions = [
    'today',
    'tomorrow',
    '+1 week',
    '+2 weeks',
    'next monday',
    'next friday',
  ];
  return expressions
    .map((expr, i) => {
      const iso = resolveDateExpression(expr);
      if (!iso) {
        return undefined;
      }
      const item = new vscode.CompletionItem(iso, vscode.CompletionItemKind.Value);
      item.detail = expr;
      item.sortText = String(i).padStart(2, '0');
      item.filterText = `${iso} ${expr}`;
      return item;
    })
    .filter((x): x is vscode.CompletionItem => x !== undefined);
}
