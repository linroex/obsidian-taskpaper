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
import { buildOutline, focusVisibleLines, Outline } from '@taskpaper/core';
import { setFilterEffect } from './filter';
import { foldedRangeAtLine, subtreeFoldRange } from './folding';
import { outlineOf } from './outline';

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
 * Compute the result of dragging the handle on `itemLine` until the pointer
 * hovers `hoverLine`: the branch moves among its siblings — dragging up drops
 * it above the hovered sibling, dragging down drops it below (with the whole
 * subtree). Returns null when the drop would be a no-op. (Pure; testable.)
 */
export function planHandleDrag(
  lines: string[],
  itemLine: number,
  hoverLine: number,
  tabSize: number,
): HandleDragPlan | null {
  const outline = buildOutline(lines, tabSize);
  const item = outline.items.find((i) => i.line === itemLine);
  if (!item) {
    return null;
  }
  const siblings = item.parent ? item.parent.children : outline.roots;
  if (siblings.length < 2) {
    return null;
  }

  // Clamp the pointer into the siblings' region, then find the hovered sibling.
  const first = siblings[0];
  const last = siblings[siblings.length - 1];
  const hover = Math.max(first.line, Math.min(last.subtreeEnd, hoverLine));
  let target = siblings[0];
  for (const s of siblings) {
    if (s.line <= hover) {
      target = s;
    }
  }
  if (target === item) {
    return null;
  }

  // Hovering a sibling above the item drops before it; below drops after it.
  let insertBefore = target.line < item.line ? target.line : target.subtreeEnd + 1;
  if (insertBefore === item.line || insertBefore === item.subtreeEnd + 1) {
    return null; // lands exactly where it already is
  }

  const block = lines.slice(item.line, item.subtreeEnd + 1);
  const out = lines.slice();
  out.splice(item.line, block.length);
  const indicatorLine = insertBefore;
  if (insertBefore > item.line) {
    insertBefore -= block.length;
  }
  out.splice(insertBefore, 0, ...block);
  return { indicatorLine, lines: out, cursorLine: insertBefore };
}

// ---------------------------------------------------------------------------
// View glue
// ---------------------------------------------------------------------------

class HandleWidget extends WidgetType {
  constructor(readonly line: number) {
    super();
  }
  eq(other: HandleWidget): boolean {
    return other.line === this.line;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'tp-handle';
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
  for (const lineNo of handleLines(outline)) {
    const line = view.state.doc.line(lineNo + 1);
    const indent = /^[\t ]*/.exec(line.text)?.[0].length ?? 0;
    builder.add(
      line.from + indent,
      line.from + indent,
      Decoration.widget({ widget: new HandleWidget(lineNo), side: -1 }),
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

function docLines(view: EditorView): string[] {
  const lines: string[] = [];
  for (let i = 1; i <= view.state.doc.lines; i++) {
    lines.push(view.state.doc.line(i).text);
  }
  return lines;
}

/**
 * A live drag session started from a handle. Tracks the pointer, shows a drop
 * indicator, and on mouseup either commits the move (real drag) or reports a
 * plain click. Escape cancels the whole gesture.
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
    const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    const hoverLine = this.view.state.doc.lineAt(pos).number - 1;
    this.plan = planHandleDrag(docLines(this.view), this.itemLine, hoverLine, 4);
    this.planDoc = this.view.state.doc;
    this.drawIndicator();
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
    if (!commit) {
      return; // cancelled with Escape — the following mouseup is inert
    }
    if (!this.moved) {
      this.onClick();
      return;
    }
    if (this.plan && this.view.state.doc.eq(this.planDoc)) {
      const state = this.view.state;
      const br = state.lineBreak;
      let anchor = 0;
      for (let i = 0; i < this.plan.cursorLine; i++) {
        anchor += this.plan.lines[i].length + br.length;
      }
      this.view.dispatch({
        changes: { from: 0, to: state.doc.length, insert: this.plan.lines.join(br) },
        selection: { anchor },
        scrollIntoView: true,
      });
    }
  }
}

export interface HandleOptions {
  /** Whether a handle-triggered focus hides (true) or dims (false) non-matches. */
  hide(): boolean;
  /** Called after Alt-clicking a project's handle focused it. */
  onFocus(line: number): void;
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
          this.activeDrag = new HandleDrag(view, line, event, () => toggleHandleFold(view, line));
          return true;
        },
      },
    },
  );
}
