import * as vscode from 'vscode';
import { projectStats, quoteQueryValue, savedSearches, tagNamesToValues } from '@taskpaper/core';
import { getOutline, tabSizeFor } from '../outline';

type Node =
  | { kind: 'section'; id: 'searches' | 'projects' | 'tags'; label: string }
  | { kind: 'search'; name: string; query: string; uri: vscode.Uri }
  | { kind: 'project'; label: string; remaining: number; line: number; uri: vscode.Uri }
  | { kind: 'tag'; name: string; count: number; values: string[]; uri: vscode.Uri }
  | { kind: 'tag-value'; name: string; value: string; uri: vscode.Uri };

/** Tree view listing the active document's projects and tags for quick navigation/filtering. */
export class TaskPaperTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private activeDoc: vscode.TextDocument | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** The project line currently focused (per document uri), for the indicator. */
  focused: { uri: string; line: number } | null = null;
  /** The query filter currently applied (per document uri), for row indicators + toggle. */
  activeFilter: { uri: string; query: string } | null = null;

  /** True when `query` is the active filter for `uri`. */
  isActiveFilter(uri: vscode.Uri, query: string): boolean {
    return this.activeFilter?.uri === uri.toString() && this.activeFilter?.query === query;
  }

  constructor(disposables: vscode.Disposable[]) {
    const track = (editor: vscode.TextEditor | undefined) => {
      if (editor && editor.document.languageId === 'taskpaper') {
        if (this.activeDoc !== editor.document) {
          this.focused = null;
          this.activeFilter = null;
        }
        this.activeDoc = editor.document;
        this.refresh();
      }
    };
    track(vscode.window.activeTextEditor);
    disposables.push(
      vscode.window.onDidChangeActiveTextEditor(track),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.activeDoc) {
          this.scheduleRefresh();
        }
      }),
    );
  }

  private scheduleRefresh(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.refresh(), 200);
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'section') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'taskpaperSection';
      return item;
    }
    if (node.kind === 'search') {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
      const active = this.isActiveFilter(node.uri, node.query);
      item.iconPath = new vscode.ThemeIcon(active ? 'target' : 'search');
      item.description = active ? `● ${node.query}` : node.query;
      item.tooltip = active ? 'Active — click to clear' : `Run search: ${node.query}`;
      item.command = {
        command: 'taskpaper.runSavedSearch',
        title: 'Run saved search',
        arguments: [node.uri, node.query],
      };
      return item;
    }
    if (node.kind === 'project') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      const isFocused =
        this.focused?.uri === node.uri.toString() && this.focused?.line === node.line;
      item.iconPath = new vscode.ThemeIcon(isFocused ? 'target' : 'symbol-namespace');
      const bits: string[] = [];
      if (isFocused) {
        bits.push('● focused');
      }
      if (node.remaining > 0) {
        bits.push(`${node.remaining}`);
      }
      item.description = bits.join('  ');
      item.tooltip = isFocused
        ? 'Focused — click to show all'
        : `${node.remaining} unfinished — click to focus`;
      item.command = {
        command: 'taskpaper.toggleProjectFocus',
        title: 'Toggle project focus',
        arguments: [node.uri, node.line],
      };
      return item;
    }
    if (node.kind === 'tag') {
      const item = new vscode.TreeItem(
        `@${node.name}`,
        node.values.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      const active = this.isActiveFilter(node.uri, `@${node.name}`);
      item.description = active ? `● ${node.count}` : String(node.count);
      item.iconPath = new vscode.ThemeIcon(active ? 'target' : 'tag');
      item.tooltip = active ? 'Active — click to clear' : `Filter by @${node.name}`;
      item.command = {
        command: 'taskpaper.filterTag',
        title: 'Filter by tag',
        arguments: [node.uri, node.name],
      };
      return item;
    }
    // tag value — clicking filters by tag + value (original sidebar rows).
    const item = new vscode.TreeItem(node.value, vscode.TreeItemCollapsibleState.None);
    const activeValue = this.isActiveFilter(node.uri, `@${node.name} contains[l] ${quoteQueryValue(node.value)}`);
    item.iconPath = new vscode.ThemeIcon(activeValue ? 'target' : 'symbol-constant');
    item.description = activeValue ? '●' : undefined;
    item.tooltip = activeValue
      ? 'Active — click to clear'
      : `Filter by @${node.name} contains[l] "${node.value}"`;
    item.command = {
      command: 'taskpaper.filterTag',
      title: 'Filter by tag value',
      arguments: [node.uri, node.name, node.value],
    };
    return item;
  }

  getChildren(element?: Node): Node[] {
    if (!this.activeDoc) {
      return [];
    }
    const doc = this.activeDoc;
    const outline = getOutline(doc, tabSizeFor(doc));

    if (!element) {
      const sections: Node[] = [];
      if (savedSearches(outline).length > 0) {
        sections.push({ kind: 'section', id: 'searches', label: 'Searches' });
      }
      sections.push({ kind: 'section', id: 'projects', label: 'Projects' });
      sections.push({ kind: 'section', id: 'tags', label: 'Tags' });
      return sections;
    }
    if (element.kind === 'tag') {
      return element.values.map((value) => ({
        kind: 'tag-value' as const,
        name: element.name,
        value,
        uri: element.uri,
      }));
    }
    if (element.kind !== 'section') {
      return [];
    }

    if (element.id === 'searches') {
      return savedSearches(outline).map((s) => ({
        kind: 'search' as const,
        name: s.name,
        query: s.query,
        uri: doc.uri,
      }));
    }

    if (element.id === 'projects') {
      const stats = projectStats(outline);
      return outline.items
        .filter((i) => i.kind === 'project')
        .map((p) => ({
          kind: 'project' as const,
          label: '  '.repeat(p.level) + (p.displayText || '(untitled)'),
          remaining: stats.get(p)?.remaining ?? 0,
          line: p.line,
          uri: doc.uri,
        }));
    }

    // tags with counts + their distinct values (alphabetical, like the original)
    const counts = new Map<string, number>();
    for (const item of outline.items) {
      for (const name of item.tags.keys()) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const namesToValues = tagNamesToValues(outline);
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({
        kind: 'tag' as const,
        name,
        count,
        values: namesToValues.get(name) ?? [],
        uri: doc.uri,
      }));
  }
}
