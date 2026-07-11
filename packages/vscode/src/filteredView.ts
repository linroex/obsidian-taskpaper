import * as vscode from 'vscode';
import { Item, runQuery, withAncestors } from '@taskpaper/core';
import { getOutline, tabSizeFor } from './outline';

export const FILTER_SCHEME = 'taskpaper-filter';

interface FilterMeta {
  sourceUri: vscode.Uri;
  query: string;
  /** For each rendered line, the source document line it maps to (or -1). */
  lineMap: number[];
}

/**
 * Renders a read-only view of the items matching a query, preserving hierarchy
 * and ancestor context, and mapping each result line back to its source line.
 */
export class FilteredViewProvider
  implements vscode.TextDocumentContentProvider, vscode.DocumentLinkProvider
{
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly meta = new Map<string, FilterMeta>();

  /** Build the virtual document URI encoding source + query. */
  static makeUri(sourceUri: vscode.Uri, query: string): vscode.Uri {
    const params = new URLSearchParams({ src: sourceUri.toString(), q: query });
    return vscode.Uri.parse(
      `${FILTER_SCHEME}:Filter — ${sanitize(query)}.taskpaper?${params.toString()}`,
    );
  }

  refreshForSource(sourceUri: vscode.Uri): void {
    for (const [key, meta] of this.meta) {
      if (meta.sourceUri.toString() === sourceUri.toString()) {
        this.emitter.fire(vscode.Uri.parse(key));
      }
    }
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const src = params.get('src');
    const query = params.get('q') ?? '';
    if (!src) {
      return '# Invalid filter view';
    }
    const sourceUri = vscode.Uri.parse(src);

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(sourceUri);
    } catch {
      return `# Source document is not open\n${src}`;
    }

    const outline = getOutline(document, tabSizeFor(document));
    let matches: Set<Item>;
    try {
      matches = runQuery(query, outline);
    } catch (err) {
      this.meta.set(uri.toString(), { sourceUri, query, lineMap: [] });
      return `# Query error\n${(err as Error).message}`;
    }

    // Include ancestors of every match so hierarchy/context is preserved.
    const include = new Set<Item>();
    for (const m of matches) {
      for (const item of withAncestors(m)) {
        include.add(item);
      }
    }

    const ordered = outline.items.filter((i) => include.has(i));
    const lineMap: number[] = [];
    const out: string[] = [];

    if (ordered.length === 0) {
      out.push(`No items match:  ${query}`);
      lineMap.push(-1);
    } else {
      for (const item of ordered) {
        out.push('\t'.repeat(item.level) + item.text);
        lineMap.push(item.line);
      }
    }

    this.meta.set(uri.toString(), { sourceUri, query, lineMap });
    return out.join('\n');
  }

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const meta = this.meta.get(document.uri.toString());
    if (!meta) {
      return [];
    }
    const links: vscode.DocumentLink[] = [];
    for (let line = 0; line < meta.lineMap.length; line++) {
      const srcLine = meta.lineMap[line];
      if (srcLine < 0) {
        continue;
      }
      const range = document.lineAt(line).range;
      const target = meta.sourceUri.with({ fragment: `L${srcLine + 1}` });
      const link = new vscode.DocumentLink(range, target);
      link.tooltip = 'Go to source line';
      links.push(link);
    }
    return links;
  }

  dispose(): void {
    this.emitter.dispose();
    this.meta.clear();
  }
}

function sanitize(query: string): string {
  return query.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 40) || 'all';
}
