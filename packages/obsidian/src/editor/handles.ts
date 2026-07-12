import { RangeSetBuilder, Text } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { foldEffect, unfoldEffect } from '@codemirror/language';
import {
  buildOutline,
  focusVisibleLines,
  itemAtLine,
  moveBranchAfter,
  moveBranchBefore,
  moveBranchToProject,
  Outline,
} from '@taskpaper/core';
import { setFilterEffect } from './filter';
import { foldedRangeAtLine, subtreeFoldRange } from './folding';
import { docLines } from './outlineEdit';
import { outlineOf, visibleItems, OUTLINE_TAB_SIZE } from './outline';

// ---------------------------------------------------------------------------
// Pure logic (testable)
// ---------------------------------------------------------------------------

/** Lines (0-based) that get a handle: items with children (pure; testable). */
export function handleLines(outline: Outline): number[] {
  return outline.items.filter((i) => i.children.length > 0).map((i) => i.line);
}

export interface HandleDragPlan {
  /** Line (0-based, in the ORIGINAL document) the subtree is inserted before —
   *  where the drop indicator is drawn. May equal the line count (end). */
  indicatorLine: number;
  /** The resulting document lines. */
  lines: string[];
  /** Where the dragged item's first line lands (0-based). */
  cursorLine: number;
}

/**
 * Compute the result of dragging the handle on `itemLine` to drop before or
 * after the item at `targetLine` — ANYWHERE in the document, re-indented to
 * the drop target's level (cross-project moves included). Returns null when
 * the drop is a no-op or lands inside the dragged branch. (Pure; testable.)
 */
export function planFreeDrag(
  lines: string[],
  itemLine: number,
  targetLine: number,
  dropAfter: boolean,
  tabSize: number,
): HandleDragPlan | null {
  const outline = buildOutline(lines, tabSize);
  const item = outline.items.find((i) => i.line === itemLine);
  const target =
    outline.items.find((i) => i.line === targetLine) ?? itemAtLine(outline, targetLine);
  if (!item || !target) {
    return null;
  }
  if (target.line >= item.line && target.line <= item.subtreeEnd) {
    return null; // inside the dragged branch
  }
  const edit = dropAfter
    ? moveBranchAfter(lines, item.line, target.line, tabSize)
    : moveBranchBefore(lines, item.line, target.line, tabSize);
  if (!edit) {
    return null;
  }
  return {
    indicatorLine: dropAfter ? target.subtreeEnd + 1 : target.line,
    lines: edit.lines,
    cursorLine: edit.cursorLine,
  };
}


// ---------------------------------------------------------------------------
// View glue
// ---------------------------------------------------------------------------

class HandleWidget extends WidgetType {
  constructor(
    readonly line: number,
    readonly leaf: boolean,
  ) {
    super();
  }
  eq(other: HandleWidget): boolean {
    return other.line === this.line && other.leaf === this.leaf;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = this.leaf ? 'tp-handle tp-handle-leaf' : 'tp-handle';
    span.setAttribute('data-line', String(this.line));
    span.setAttribute('aria-hidden', 'true');
    span.title = '點一下摺疊/展開，拖曳移動整個分支';
    return span;
  }
  override ignoreEvent(): boolean {
    return false; // let our domEventHandlers see mousedown on the handle
  }
}

function buildHandleDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const outline = outlineOf(view.state);
  // Viewport-only, like the highlight plugin — full-doc rebuilds are too
  // costly per keystroke on huge files.
  const parents = new Set(handleLines(outline));
  // EVERY item gets a drag handle; leaves reveal theirs on hover only.
  for (const item of visibleItems(view, outline)) {
    const lineNo = item.line;
    const line = view.state.doc.line(lineNo + 1);
    const indent = /^[\t ]*/.exec(line.text)?.[0].length ?? 0;
    builder.add(
      line.from + indent,
      line.from + indent,
      Decoration.widget({ widget: new HandleWidget(lineNo, !parents.has(lineNo)), side: -1 }),
    );
  }
  return builder.finish();
}

/** Toggle the fold of the subtree under `lineNo` (0-based). */
function toggleHandleFold(view: EditorView, lineNo: number): void {
  const existing = foldedRangeAtLine(view.state, lineNo);
  if (existing) {
    view.dispatch({ effects: unfoldEffect.of(existing) });
    return;
  }
  const range = subtreeFoldRange(view.state, lineNo);
  if (range) {
    view.dispatch({ effects: foldEffect.of(range) });
  }
}


/** CSS class marking the sidebar project row hovered during a handle drag. */
const SIDEBAR_DROP_CLASS = 'tp-sb-drop-into';

/**
 * A live drag session started from a handle. Tracks the pointer, shows a drop
 * indicator, and on mouseup either commits the move (real drag) or reports a
 * plain click. Dragging over a sidebar project row (original TaskPaper 3:
 * drag items onto sidebar projects) highlights it and drops the branch INTO
 * that project. Escape cancels the whole gesture.
 */
class HandleDrag {
  private indicator: HTMLElement | null = null;
  private plan: HandleDragPlan | null = null;
  private moved = false;
  private done = false;
  private readonly startY: number;
  /** Document the current plan was computed against — a plan is only
   *  committed while the document is still identical (edits between the last
   *  mousemove and mouseup would otherwise be overwritten). */
  private planDoc: Text;
  /** The sidebar project row currently hovered (drop target), if any. */
  private sidebarTarget: HTMLElement | null = null;

  private readonly onMove = (e: MouseEvent) => this.update(e);
  private readonly onUp = () => this.finish(true);
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.finish(false);
    }
  };

  constructor(
    private view: EditorView,
    private itemLine: number,
    startEvent: MouseEvent,
    /** Called once when the gesture ends without having dragged (= a click). */
    private onClick: () => void,
    /** Hit-test hook (injectable for tests — jsdom's elementFromPoint returns null). */
    private hitTest: (x: number, y: number) => Element | null = (x, y) =>
      document.elementFromPoint(x, y),
  ) {
    this.startY = startEvent.clientY;
    this.planDoc = view.state.doc;
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);
    window.addEventListener('keydown', this.onKey, true);
  }

  /** Abort the gesture (view destroyed, or the document changed mid-drag). */
  cancel(): void {
    this.finish(false);
  }

  private update(e: MouseEvent): void {
    if (Math.abs(e.clientY - this.startY) > 3) {
      this.moved = true;
    }
    if (!this.moved) {
      return;
    }
    // Outside the editor the pointer may sit on a sidebar project row — then
    // the row is the drop target and the in-editor indicator hides.
    const hit = this.hitTest(e.clientX, e.clientY);
    const row = (hit?.closest?.('.tp-sb-project') as HTMLElement | null) ?? null;
    this.setSidebarTarget(row);
    if (row) {
      this.plan = null;
      this.drawIndicator();
      return;
    }
    const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    const hoverLine = this.view.state.doc.lineAt(pos).number - 1;
    // Upper half of the hovered line drops BEFORE it, lower half AFTER —
    // anywhere in the document (cross-project; re-indents to the target).
    let dropAfter = true;
    try {
      const block = this.view.lineBlockAt(pos);
      dropAfter = block.height > 0 ? e.clientY > block.top + block.height / 2 : true;
    } catch {
      // headless layout — keep the default
    }
    this.plan = planFreeDrag(docLines(this.view.state), this.itemLine, hoverLine, dropAfter, OUTLINE_TAB_SIZE);
    this.planDoc = this.view.state.doc;
    this.drawIndicator();
  }

  private setSidebarTarget(row: HTMLElement | null): void {
    if (this.sidebarTarget === row) {
      return;
    }
    this.sidebarTarget?.classList.remove(SIDEBAR_DROP_CLASS);
    this.sidebarTarget = row;
    row?.classList.add(SIDEBAR_DROP_CLASS);
  }

  private drawIndicator(): void {
    if (!this.plan) {
      this.indicator?.remove();
      this.indicator = null;
      return;
    }
    if (!this.indicator) {
      this.indicator = document.createElement('div');
      this.indicator.className = 'tp-drop-indicator';
      this.view.scrollDOM.appendChild(this.indicator);
    }
    const doc = this.view.state.doc;
    const atEnd = this.plan.indicatorLine >= doc.lines;
    const pos = atEnd ? doc.line(doc.lines).to : doc.line(this.plan.indicatorLine + 1).from;
    const coords = this.view.coordsAtPos(pos);
    if (!coords) {
      return;
    }
    const rect = this.view.scrollDOM.getBoundingClientRect();
    const y = (atEnd ? coords.bottom : coords.top) - rect.top + this.view.scrollDOM.scrollTop;
    this.indicator.style.top = `${y}px`;
  }

  private finish(commit: boolean): void {
    if (this.done) {
      return;
    }
    this.done = true;
    window.removeEventListener('mousemove', this.onMove);
    window.removeEventListener('mouseup', this.onUp);
    window.removeEventListener('keydown', this.onKey, true);
    this.indicator?.remove();
    this.indicator = null;
    const target = this.sidebarTarget;
    this.setSidebarTarget(null);
    if (!commit) {
      return; // cancelled with Escape — the following mouseup is inert
    }
    if (!this.moved) {
      this.onClick();
      return;
    }
    if (target) {
      // Dropped on a sidebar project row: move the branch INTO that project.
      // Computed fresh from the current document, so no staleness guard needed.
      const projectLine = Number(target.getAttribute('data-line'));
      if (Number.isNaN(projectLine)) {
        return;
      }
      const edit = moveBranchToProject(docLines(this.view.state), this.itemLine, projectLine, OUTLINE_TAB_SIZE);
      if (edit) {
        this.commitLines(edit.lines, edit.cursorLine);
      }
      return;
    }
    if (this.plan && this.view.state.doc.eq(this.planDoc)) {
      this.commitLines(this.plan.lines, this.plan.cursorLine);
    }
  }

  /** Replace the whole document with `lines`, cursor at the start of `cursorLine`. */
  private commitLines(lines: string[], cursorLine: number): void {
    const state = this.view.state;
    const br = state.lineBreak;
    let anchor = 0;
    for (let i = 0; i < cursorLine; i++) {
      anchor += lines[i].length + br.length;
    }
    this.view.dispatch({
      changes: { from: 0, to: state.doc.length, insert: lines.join(br) },
      selection: { anchor },
      scrollIntoView: true,
    });
  }
}

export interface HandleOptions {
  /** Whether a handle-triggered focus hides (true) or dims (false) non-matches. */
  hide(): boolean;
  /** Called after Alt-clicking a project's handle focused it. */
  onFocus(line: number): void;
  /** Hit-test hook for drags over the sidebar (injectable for tests;
   *  defaults to document.elementFromPoint, which jsdom cannot provide). */
  elementFromPoint?(x: number, y: number): Element | null;
}

/**
 * Handle dot at the start of items with children: click folds, drag moves,
 * Alt(Option)-click on a project focuses it (TaskPaper 3: "Option-Click a
 * project's handle to focus").
 */
export function itemHandles(opts: HandleOptions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      /** The live drag session, so destroy()/edits can abort it (no window-
       *  listener leak, no stale plan committing over newer edits). */
      activeDrag: HandleDrag | null = null;
      constructor(view: EditorView) {
        this.decorations = buildHandleDecorations(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged && this.activeDrag) {
          this.activeDrag.cancel();
          this.activeDrag = null;
        }
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildHandleDecorations(update.view);
        }
      }
      destroy() {
        this.activeDrag?.cancel();
        this.activeDrag = null;
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event, view) {
          const target = event.target instanceof HTMLElement ? event.target : null;
          if (!target || event.button !== 0 || !target.classList.contains('tp-handle')) {
            return false;
          }
          const line = Number(target.getAttribute('data-line'));
          if (Number.isNaN(line)) {
            return false;
          }
          if (event.altKey) {
            const outline = outlineOf(view.state);
            const item = outline.items.find((i) => i.line === line);
            if (item?.kind === 'project') {
              event.preventDefault();
              view.dispatch({
                effects: setFilterEffect.of({
                  mode: 'focus',
                  visible: focusVisibleLines(outline, line),
                  hide: opts.hide(),
                }),
              });
              opts.onFocus(line);
              return true;
            }
            // Alt on a non-project handle: fall through to the plain gesture.
          }
          event.preventDefault();
          this.activeDrag?.cancel();
          this.activeDrag = new HandleDrag(
            view,
            line,
            event,
            () => toggleHandleFold(view, line),
            opts.elementFromPoint,
          );
          return true;
        },
      },
    },
  );
}
