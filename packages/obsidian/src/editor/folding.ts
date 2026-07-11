import { foldService } from '@codemirror/language';
import { outlineOf } from './outline';

/** Fold an item's subtree (the indented block beneath a project or task). */
export const taskpaperFolding = foldService.of((state, lineStart, lineEnd) => {
  const outline = outlineOf(state);
  const lineNo = state.doc.lineAt(lineStart).number; // 1-based
  const item = outline.items.find((i) => i.line + 1 === lineNo);
  if (!item || item.subtreeEnd <= item.line) {
    return null;
  }
  const endLine = state.doc.line(item.subtreeEnd + 1);
  return { from: lineEnd, to: endLine.to };
});
