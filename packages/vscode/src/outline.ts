import * as vscode from 'vscode';
import { buildOutline, Outline } from '@taskpaper/core';

interface CacheEntry {
  version: number;
  tabSize: number;
  outline: Outline;
}

const cache = new WeakMap<vscode.TextDocument, CacheEntry>();

/** Return a cached outline for a document, re-parsing only when it changes. */
export function getOutline(document: vscode.TextDocument, tabSize: number): Outline {
  const cached = cache.get(document);
  if (cached && cached.version === document.version && cached.tabSize === tabSize) {
    return cached.outline;
  }
  const lines: string[] = [];
  for (let i = 0; i < document.lineCount; i++) {
    lines.push(document.lineAt(i).text);
  }
  const outline = buildOutline(lines, tabSize);
  cache.set(document, { version: document.version, tabSize, outline });
  return outline;
}

/** Effective tab size for a document's editor (falls back to 4). */
export function tabSizeFor(document: vscode.TextDocument): number {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
  const size = editor?.options.tabSize;
  return typeof size === 'number' && size > 0 ? size : 4;
}
