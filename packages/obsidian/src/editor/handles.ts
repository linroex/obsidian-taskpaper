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
  hasTag,
  itemAtLine,
  moveBranchAfter,
  moveBranchBefore,
  moveBranchToProject,
  planAssignTag,
  selectedRootLines,
  Outline,
} from '@taskpaper/core';
import { toggleDoneAtLines } from './toggleDone';
import { setFilterEffect } from './filter';
import { foldedRangeAtLine, subtreeFoldRange } from './folding';
import { docLines } from './outlineEdit';
import { outlineOf, visibleItems, OUTLINE_TAB_SIZE } from './outline';
import { selectedLineRanges } from './selection';

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
  if (!item) {
    return null;
  }
  // Clamp hovers over blank space to the nearest item (above the first item
  // drops BEFORE it; past the last drops AFTER) — a null here would make the
  // indicator vanish and the drop silently do nothing.
  let target =
    outline.items.find((i) => i.line === targetLine) ?? itemAtLine(outline, targetLine);
  let after = dropAfter;
  if (!target) {
    target = outline.items.find((i) => i.line >= targetLine);
    if (target) {
      after = false;
    } else {
      target = outline.items[outline.items.length - 1];
      after = true;
    }
  }
  if (!target) {
    return null;
  }
  if (target.line >= item.line && target.line <= item.subtreeEnd) {
    return null; // inside the dragged branch
  }
  const edit = after
    ? moveBranchAfter(lines, item.line, target.line, tabSize)
    : moveBranchBefore(lines, item.line, target.line, tabSize);
  if (!edit) {
    return null;
  }
  return {
    indicatorLine: after ? target.subtreeEnd + 1 : target.line,
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

/** CSS class marking the sidebar tag name/value row hovered during a drag. */
const SIDEBAR_ASSIGN_CLASS = 'tp-sb-drop-assign';

/** Shown when a tag drop is aborted because the document changed mid-drag. */
export const DRAG_ASSIGN_ABORT_NOTICE = '文件已變更，取消拖曳指派';

/**
 * A live drag session started from a handle. Tracks the pointer, shows a drop
 * indicator, and on mouseup either commits the move (real drag) or reports a
 * plain click. Dragging over a sidebar project row (original TaskPaper 3:
 * drag items onto sidebar projects) highlights it and drops the branch INTO
 * that project; a sidebar tag name/value row instead assigns that tag to
 * every dragged root. Escape cancels the whole gesture.
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
  /** The document at DRAG START — tag drops apply the captured roots and must
   *  abort (with a notice) when the document is no longer this snapshot. */
  private readonly startDoc: Text;
  /** The root lines the drag carries: every selected root when the dragged
   *  item is one of them (multi-select drag), else just the item's own line.
   *  Snapshot at drag start; descendants are never retagged. */
  private readonly dragRoots: number[];
  /** The sidebar project/tag row currently hovered (drop target), if any. */
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
    /** Shows a user-facing warning (a Notice in production). */
    private notify: (message: string) => void,
    /** The @done stamp per settings — a drop on the @done tag row must run
     *  the full toggle-done pipeline (repeat spawn, @today removal). */
    private doneStamp: () => string,
    /** Hit-test hook (injectable for tests — jsdom's elementFromPoint returns null). */
    private hitTest: (x: number, y: number) => Element | null = (x, y) =>
      document.elementFromPoint(x, y),
  ) {
    this.startY = startEvent.clientY;
    this.planDoc = view.state.doc;
    this.startDoc = view.state.doc;
    const roots = selectedRootLines(outlineOf(view.state), selectedLineRanges(view.state), false);
    this.dragRoots = roots.includes(itemLine) ? roots : [itemLine];
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);
    window.addEventListener('keydown', this.onKey, true);
  }

  /** Abort the gesture (view destroyed, or the document changed mid-drag). */
  cancel(): void {
    this.finish(false);
  }

  /** The document changed mid-drag: the captured roots may no longer match.
   *  A tag assignment in progress aborts loudly; other drags cancel silently
   *  (project drops recompute from the fresh document anyway). */
  docChanged(): void {
    if (this.moved && this.sidebarTarget?.hasAttribute('data-tag-name')) {
      this.notify(DRAG_ASSIGN_ABORT_NOTICE);
    }
    this.finish(false);
  }

  private update(e: MouseEvent): void {
    if (Math.abs(e.clientY - this.startY) > 3) {
      this.moved = true;
    }
    if (!this.moved) {
      return;
    }
    // Outside the editor the pointer may sit on a sidebar project or tag
    // row — then the row is the drop target and the in-editor indicator hides.
    const hit = this.hitTest(e.clientX, e.clientY);
    const row =
      (hit?.closest?.('.tp-sb-project, .tp-sb-tag, .tp-sb-tag-value') as HTMLElement | null) ??
      null;
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
      // lineBlockAt() returns DOCUMENT coordinates; the mouse event is in
      // SCREEN coordinates — documentTop converts between them.
      const block = this.view.lineBlockAt(pos);
      const screenTop = block.top + this.view.documentTop;
      dropAfter = block.height > 0 ? e.clientY > screenTop + block.height / 2 : true;
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
    this.sidebarTarget?.classList.remove(SIDEBAR_DROP_CLASS, SIDEBAR_ASSIGN_CLASS);
    this.sidebarTarget = row;
    // Distinct highlight per target type: tag rows assign, project rows move.
    row?.classList.add(row.hasAttribute('data-tag-name') ? SIDEBAR_ASSIGN_CLASS : SIDEBAR_DROP_CLASS);
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
    if (target?.hasAttribute('data-tag-name')) {
      this.assignTag(target);
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

  /** Dropped on a sidebar tag row: assign the tag to every dragged root —
   *  value rows set `@name(value)`, name rows add the bare `@name`. Tag-only
   *  mutation, applied as per-line changes in ONE transaction. STRICTER than
   *  project drops: the roots were captured at drag start, so a document that
   *  changed since then aborts instead of retagging the wrong lines. */
  private assignTag(target: HTMLElement): void {
    const name = target.getAttribute('data-tag-name');
    if (!name) {
      return;
    }
    if (!this.view.state.doc.eq(this.startDoc)) {
      this.notify(DRAG_ASSIGN_ABORT_NOTICE);
      return;
    }
    if (name === 'done') {
      // Completing is more than a tag write (repeat spawn, @today removal):
      // route through the same pipeline as the dash click and the command.
      // Only not-yet-done roots — a toggle would UN-complete the others.
      const lines = docLines(this.view.state);
      const undone = this.dragRoots.filter((l) => !hasTag(lines[l] ?? '', 'done'));
      if (undone.length > 0) {
        toggleDoneAtLines(this.view, undone, this.doneStamp(), this.notify);
      }
      return;
    }
    const changes = planAssignTag(
      docLines(this.view.state),
      this.dragRoots,
      name,
      target.getAttribute('data-tag-value'),
    );
    if (changes.length === 0) {
      return;
    }
    const doc = this.view.state.doc;
    this.view.dispatch({
      changes: changes.map((c) => {
        const line = doc.line(c.line + 1);
        return { from: line.from, to: line.to, insert: c.text };
      }),
    });
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
  /** Show a user-facing warning (a Notice in production). */
  notify(message: string): void;
  /** The @done stamp to apply (already formatted per settings). */
  doneStamp(): string;
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
          this.activeDrag.docChanged();
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
            (message) => opts.notify(message),
            () => opts.doneStamp(),
            opts.elementFromPoint,
          );
          return true;
        },
      },
    },
  );
}
