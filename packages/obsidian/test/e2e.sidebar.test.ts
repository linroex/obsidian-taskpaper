/**
 * E2E tests for the sidebar's TaskPaper-3 interactions: hoist (Alt+click /
 * context menu), project drag-reorder (HTML5 DnD events on the rows), and
 * dragging an editor item by its handle onto a sidebar project.
 *
 * The REAL TaskPaperSidebarView renders into a jsdom DOM (the 'obsidian'
 * module is aliased to test/stubs/obsidian.ts), wired to a REAL EditorView
 * mounted with the production extension stack via the e2e harness. A minimal
 * fake plugin/lastActiveView stands in for the Obsidian app around them.
 *
 * jsdom limits:
 *  - No DataTransfer: the DnD handlers keep the drag source in view state and
 *    guard every dataTransfer access, so plain MouseEvents drive them.
 *  - document.elementFromPoint always returns null: the handle-drag session
 *    takes an injectable hit-test hook (host.elementFromPoint), which these
 *    tests supply; production uses the document default.
 *  - Zero layout rects: rows report height 0, so clientY 0 means "top half"
 *    (drop before) and any positive clientY means "bottom half" (drop after).
 */
import { docText, hiddenLineNumbers, mountEditor, press, RecordingHost } from './e2eHarness';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { Menu, TFile, WorkspaceLeaf } from 'obsidian';
import { filterDecoField, filterSpecField } from '../src/editor/filter';
import { DRAG_ASSIGN_ABORT_NOTICE } from '../src/editor/handles';
import { TaskPaperSidebarView } from '../src/sidebar';
import type TaskPaperPlugin from '../src/main';
import type { TaskPaperView } from '../src/view';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL: ${name}${extra ? '  -> ' + extra : ''}`);
  }
}

function setEq(a: Set<number>, b: Set<number>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

/** 1-based line numbers carrying the dim LINE decoration (hide:false filters). */
function dimLineNumbers(view: EditorView): Set<number> {
  const dims = new Set<number>();
  view.state.field(filterDecoField).between(0, view.state.doc.length, (from, to) => {
    if (from === to) {
      dims.add(view.state.doc.lineAt(from).number);
    }
  });
  return dims;
}

// Home(1) / Errands(2) / -buy milk(3) / -pick up(4) / Work(5) / -gamma(6) /
// -delta(7) / Inbox(8)   (1-based; 0-based lines are one less)
const DOC = [
  'Home:',
  '\tErrands:',
  '\t\t- buy milk',
  '\t\t- pick up package',
  'Work:',
  '\t- gamma',
  '\t- delta',
  'Inbox:',
].join('\n');

/** Mount a real editor + the real sidebar view around a minimal fake plugin. */
function mountSidebar(
  doc: string,
  hostOverrides: Partial<RecordingHost> = {},
  settingsOverrides: Record<string, unknown> = {},
) {
  const mounted = mountEditor(doc, hostOverrides);
  const leaf = new WorkspaceLeaf();
  const fakeView = {
    editor: mounted.view,
    file: new TFile(),
    leaf,
    focusedLine: null as number | null,
    sidebarSelection: [],
  } as unknown as TaskPaperView;
  const plugin = {
    settings: {
      globalSearches: [],
      includeTags: '',
      excludeTags: '',
      filterHidesInsteadOfDims: true,
      ...settingsOverrides,
    },
    lastActiveView: fakeView,
    refreshSidebar: () => sidebar.render(true),
    refreshSidebarSoon: () => {},
    saveSettings: async () => {},
  } as unknown as TaskPaperPlugin;
  const sidebar = new TaskPaperSidebarView(leaf, plugin);
  sidebar.render(true);
  return {
    sidebar,
    view: fakeView,
    editor: mounted.view,
    host: mounted.host,
    rows: () => Array.from(sidebar.contentEl.querySelectorAll<HTMLElement>('.tp-sb-project')),
    cleanup: mounted.cleanup,
  };
}

function mouse(type: string, opts: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...opts });
}

// --- sidebar renders the projects with data-line + draggable ---
{
  const fx = mountSidebar(DOC);
  const rows = fx.rows();
  check('four project rows render', rows.length === 4, String(rows.length));
  check(
    'rows carry data-line (drop targets for editor drags)',
    rows.map((r) => r.getAttribute('data-line')).join(',') === '0,1,4,7',
    rows.map((r) => r.getAttribute('data-line')).join(','),
  );
  check('rows are draggable', rows.every((r) => r.getAttribute('draggable') === 'true'));
  fx.cleanup();
}

// --- Alt+click a project row hoists it: contents + ancestors, own line hidden ---
{
  const fx = mountSidebar(DOC);
  const errands = fx.rows()[1]; // nested project Errands (line 1)
  errands.dispatchEvent(mouse('click', { altKey: true }));
  check(
    'alt-click hoist hides everything except ancestors + descendants',
    setEq(hiddenLineNumbers(fx.editor), new Set([2, 5, 6, 7, 8])),
    [...hiddenLineNumbers(fx.editor)].join(','),
  );
  check("the hoisted project's own line is hidden", hiddenLineNumbers(fx.editor).has(2));
  check('ancestor (Home) stays visible', !hiddenLineNumbers(fx.editor).has(1));
  check(
    'the selection is a hoist of that project',
    fx.view.sidebarSelection.length === 1 &&
      fx.view.sidebarSelection[0].kind === 'hoist' &&
      fx.view.sidebarSelection[0].line === 1,
    JSON.stringify(fx.view.sidebarSelection),
  );
  check('focusedLine tracks the hoisted project', fx.view.focusedLine === 1);
  check('the re-rendered row is marked hoisted', fx.rows()[1].classList.contains('is-hoisted'));

  // Alt+click again un-hoists (toggle).
  fx.rows()[1].dispatchEvent(mouse('click', { altKey: true }));
  check('alt-clicking again clears the hoist', hiddenLineNumbers(fx.editor).size === 0);
  check('selection cleared after the toggle', fx.view.sidebarSelection.length === 0);
  fx.cleanup();
}

// --- plain click still focuses (hoist rides only on Alt) ---
{
  const fx = mountSidebar(DOC);
  fx.rows()[2].dispatchEvent(mouse('click')); // Work (line 4)
  check(
    'plain click focuses the whole subtree including the project line',
    setEq(hiddenLineNumbers(fx.editor), new Set([1, 2, 3, 4, 8])),
    [...hiddenLineNumbers(fx.editor)].join(','),
  );
  check(
    'plain click selects kind=project',
    fx.view.sidebarSelection.length === 1 && fx.view.sidebarSelection[0].kind === 'project',
  );
  fx.cleanup();
}

// --- the context-menu entry 「Hoist（只顯示內容）」 hoists too; Escape clears ---
{
  const fx = mountSidebar(DOC);
  const before = Menu.created.length;
  fx.rows()[1].dispatchEvent(mouse('contextmenu'));
  check('right-click on a project row opens a menu', Menu.created.length === before + 1);
  const menu = Menu.created[Menu.created.length - 1];
  const item = menu.items.find((i) => i.title === 'Hoist（只顯示內容）');
  check('the menu has the hoist entry', item !== undefined);
  item?.callback?.();
  check(
    'menu hoist filters exactly like alt-click',
    setEq(hiddenLineNumbers(fx.editor), new Set([2, 5, 6, 7, 8])),
    [...hiddenLineNumbers(fx.editor)].join(','),
  );

  // Escape in the editor clears the filter; the stale hoist selection is
  // dropped on the next sidebar render.
  check('escape keydown is handled', press(fx.editor, 'Escape'));
  check('escape cleared the hoist filter', hiddenLineNumbers(fx.editor).size === 0);
  fx.sidebar.render(true);
  check('the hoist selection is dropped after escape', fx.view.sidebarSelection.length === 0);
  fx.cleanup();
}

// --- 顯示全部 clears an active hoist ---
{
  const fx = mountSidebar(DOC);
  fx.rows()[1].dispatchEvent(mouse('click', { altKey: true }));
  check('hoist active before 顯示全部', hiddenLineNumbers(fx.editor).size > 0);
  fx.sidebar.contentEl.querySelector<HTMLElement>('.tp-sb-clear')!.click();
  check('顯示全部 clears the hoist', hiddenLineNumbers(fx.editor).size === 0);
  check('and the selection', fx.view.sidebarSelection.length === 0);
  fx.cleanup();
}

// --- drag-reorder: drop a project BEFORE another (top half) ---
{
  const fx = mountSidebar(DOC);
  const [home, , work] = fx.rows();
  work.dispatchEvent(mouse('dragstart'));
  check('dragging marks the source row', work.classList.contains('tp-sb-dragging'));
  home.dispatchEvent(mouse('dragover', { clientY: 0 }));
  check(
    'dragover shows the before-indicator on the target',
    home.classList.contains('tp-sb-drop-before') && !home.classList.contains('tp-sb-drop-after'),
  );
  home.dispatchEvent(mouse('drop', { clientY: 0 }));
  check(
    'dropping moves the whole subtree before the target project',
    docText(fx.editor) ===
      ['Work:', '\t- gamma', '\t- delta', 'Home:', '\tErrands:', '\t\t- buy milk', '\t\t- pick up package', 'Inbox:'].join('\n'),
    JSON.stringify(docText(fx.editor)),
  );
  check('no indicator remains after the drop', fx.sidebar.contentEl.querySelector('.tp-sb-drop-before, .tp-sb-drop-after') === null);
  fx.cleanup();
}

// --- drag-reorder: drop AFTER a project (bottom half) skips its subtree ---
{
  const fx = mountSidebar(DOC);
  const [home, , work] = fx.rows();
  home.dispatchEvent(mouse('dragstart'));
  work.dispatchEvent(mouse('dragover', { clientY: 10 }));
  check(
    'bottom-half dragover shows the after-indicator',
    work.classList.contains('tp-sb-drop-after'),
  );
  work.dispatchEvent(mouse('drop', { clientY: 10 }));
  check(
    'dropping after the target lands past its whole subtree',
    docText(fx.editor) ===
      ['Work:', '\t- gamma', '\t- delta', 'Home:', '\tErrands:', '\t\t- buy milk', '\t\t- pick up package', 'Inbox:'].join('\n'),
    JSON.stringify(docText(fx.editor)),
  );
  fx.cleanup();
}

// --- drag-reorder: a nested project dropped between roots re-indents ---
{
  const fx = mountSidebar(DOC);
  const rows = fx.rows();
  rows[1].dispatchEvent(mouse('dragstart')); // Errands (nested under Home)
  rows[3].dispatchEvent(mouse('dragover', { clientY: 0 })); // Inbox (root)
  rows[3].dispatchEvent(mouse('drop', { clientY: 0 }));
  check(
    'a nested project dragged before a root re-indents to root level',
    docText(fx.editor) ===
      ['Home:', 'Work:', '\t- gamma', '\t- delta', 'Errands:', '\t- buy milk', '\t- pick up package', 'Inbox:'].join('\n'),
    JSON.stringify(docText(fx.editor)),
  );
  fx.cleanup();
}

// --- drag-reorder: dropping a row on itself / without a dragstart is inert ---
{
  const fx = mountSidebar(DOC);
  const rows = fx.rows();
  rows[0].dispatchEvent(mouse('dragstart'));
  rows[0].dispatchEvent(mouse('dragover', { clientY: 0 }));
  check('dragover over the source row shows no indicator', !rows[0].classList.contains('tp-sb-drop-before'));
  rows[0].dispatchEvent(mouse('drop', { clientY: 0 }));
  check('dropping a row onto itself changes nothing', docText(fx.editor) === DOC);
  rows[2].dispatchEvent(mouse('drop', { clientY: 0 })); // no drag in progress now
  check('a drop without a drag in progress changes nothing', docText(fx.editor) === DOC);
  fx.cleanup();
}

// --- dragging an editor item by its handle onto a sidebar project row ---
{
  // The injectable hit-test: pointer at y >= 100 "hovers" whatever row the
  // test points it at (jsdom's document.elementFromPoint returns null).
  let hover: Element | null = null;
  const fx = mountSidebar(DOC, { elementFromPoint: (_x, y) => (y >= 100 ? hover : null) });
  const inboxRow = fx.rows()[3];
  hover = inboxRow;

  const handle = fx.editor.dom.querySelector<HTMLElement>('.tp-handle[data-line="1"]'); // Errands
  check('the Errands handle renders', handle !== null);
  handle!.dispatchEvent(mouse('mousedown', { clientY: 0 }));
  window.dispatchEvent(mouse('mousemove', { clientX: 10, clientY: 150 }));
  check('the hovered sidebar row highlights', inboxRow.classList.contains('tp-sb-drop-into'));
  check(
    'the in-editor drop indicator hides while over the sidebar',
    fx.editor.dom.querySelector('.tp-drop-indicator') === null,
  );
  window.dispatchEvent(mouse('mouseup'));
  check(
    'dropping on the row moves the branch into that project',
    docText(fx.editor) ===
      ['Home:', 'Work:', '\t- gamma', '\t- delta', 'Inbox:', '\tErrands:', '\t\t- buy milk', '\t\t- pick up package'].join('\n'),
    JSON.stringify(docText(fx.editor)),
  );
  check('the highlight clears after the drop', !inboxRow.classList.contains('tp-sb-drop-into'));
  fx.cleanup();
}

// --- Escape still cancels a handle drag over the sidebar ---
{
  let hover: Element | null = null;
  const fx = mountSidebar(DOC, { elementFromPoint: (_x, y) => (y >= 100 ? hover : null) });
  const workRow = fx.rows()[2];
  hover = workRow;

  const handle = fx.editor.dom.querySelector<HTMLElement>('.tp-handle[data-line="1"]')!;
  handle.dispatchEvent(mouse('mousedown', { clientY: 0 }));
  window.dispatchEvent(mouse('mousemove', { clientX: 10, clientY: 150 }));
  check('row highlighted mid-drag', workRow.classList.contains('tp-sb-drop-into'));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  check('escape removes the highlight', !workRow.classList.contains('tp-sb-drop-into'));
  window.dispatchEvent(mouse('mouseup'));
  check('the cancelled drag leaves the document unchanged', docText(fx.editor) === DOC);
  fx.cleanup();
}

// ---------------------------------------------------------------------------
// Tag drag-to-assign: editor handle drags dropped on sidebar tag rows
// ---------------------------------------------------------------------------

// alpha(2) carries duplicate @priority tags; gamma(6) already has the value.
const TAG_DOC = [
  'Home:',
  '\t- alpha @priority(low) @priority(low)',
  '\t\t- child of alpha',
  '\t- beta',
  'Work:',
  '\t- gamma @priority(high)',
  '\t- delta @flag',
].join('\n');

/** Sidebar + the injectable hit-test: y >= 100 "hovers" the `hover` element. */
function mountTagFixture() {
  let hover: Element | null = null;
  const fx = mountSidebar(TAG_DOC, { elementFromPoint: (_x, y) => (y >= 100 ? hover : null) });
  return {
    ...fx,
    setHover: (el: Element | null) => (hover = el),
    tagRow: (name: string) =>
      fx.sidebar.contentEl.querySelector<HTMLElement>(`.tp-sb-tag[data-tag-name="${name}"]`)!,
    valueRow: (name: string, value: string) =>
      fx.sidebar.contentEl.querySelector<HTMLElement>(
        `.tp-sb-tag-value[data-tag-name="${name}"][data-tag-value="${value}"]`,
      )!,
    handle: (line: number) =>
      fx.editor.dom.querySelector<HTMLElement>(`.tp-handle[data-line="${line}"]`)!,
    lines: () => docText(fx.editor).split('\n'),
  };
}

// --- tag rows render with data-tag-name / data-tag-value ---
{
  const fx = mountTagFixture();
  check('tag name rows carry data-tag-name', fx.tagRow('priority') !== null && fx.tagRow('flag') !== null);
  check(
    'value rows carry data-tag-name + data-tag-value',
    fx.valueRow('priority', 'low') !== null && fx.valueRow('priority', 'high') !== null,
  );
  check(
    'a value-less tag renders no value rows',
    fx.sidebar.contentEl.querySelector('.tp-sb-tag-value[data-tag-name="flag"]') === null,
  );
  fx.cleanup();
}

// --- dragging an item onto a VALUE row sets @tag(value) on that line only ---
{
  const fx = mountTagFixture();
  const row = fx.valueRow('priority', 'high');
  fx.handle(3).dispatchEvent(mouse('mousedown', { clientY: 0 })); // beta
  // First hover a project row, then the value row: the highlights swap.
  fx.setHover(fx.rows()[1]);
  window.dispatchEvent(mouse('mousemove', { clientX: 10, clientY: 150 }));
  check('a project row still highlights as a move target', fx.rows()[1].classList.contains('tp-sb-drop-into'));
  fx.setHover(row);
  window.dispatchEvent(mouse('mousemove', { clientX: 10, clientY: 150 }));
  check('the value row highlights as an assign target', row.classList.contains('tp-sb-drop-assign'));
  check('the project highlight cleared on leaving it', !fx.rows()[1].classList.contains('tp-sb-drop-into'));
  check('the value row never gets the project drop class', !row.classList.contains('tp-sb-drop-into'));
  check(
    'the in-editor drop indicator hides over a tag row',
    fx.editor.dom.querySelector('.tp-drop-indicator') === null,
  );
  window.dispatchEvent(mouse('mouseup'));
  check('the dropped line gains @priority(high)', fx.lines()[3] === '\t- beta @priority(high)', fx.lines()[3]);
  check(
    'no other line changed and nothing moved',
    fx.lines().length === 7 && fx.lines()[2] === '\t\t- child of alpha' && fx.lines()[5] === '\t- gamma @priority(high)',
    docText(fx.editor),
  );
  check('the assign highlight clears after the drop', !row.classList.contains('tp-sb-drop-assign'));
  check('a successful assign shows no notice', fx.host.notices.length === 0);
  fx.cleanup();
}

// --- dropping onto a tag NAME row adds the bare tag (skip when present) ---
{
  const fx = mountTagFixture();
  const row = fx.tagRow('priority');
  fx.setHover(row);
  fx.handle(6).dispatchEvent(mouse('mousedown', { clientY: 0 })); // delta
  window.dispatchEvent(mouse('mousemove', { clientX: 10, clientY: 150 }));
  check('the name row highlights as an assign target', row.classList.contains('tp-sb-drop-assign'));
  window.dispatchEvent(mouse('mouseup'));
  check('the bare tag lands after existing tags', fx.lines()[6] === '\t- delta @flag @priority', fx.lines()[6]);

  // gamma already carries @priority — a name drop leaves its value alone.
  fx.handle(5).dispatchEvent(mouse('mousedown', { clientY: 0 }));
  window.dispatchEvent(mouse('mousemove', { clientX: 10, clientY: 150 }));
  window.dispatchEvent(mouse('mouseup'));
  check('an already-tagged line is skipped (value kept)', fx.lines()[5] === '\t- gamma @priority(high)', fx.lines()[5]);
  fx.cleanup();
}

// --- dropping onto the @done row runs the full toggle-done pipeline ---
// (Completing is more than a tag write: a @repeat task must spawn its
// successor exactly like the dash click and the command do.)
{
  let hover: Element | null = null;
  const DONE_DOC = ['Home:', '\t- pay rent @due(2026-07-01) @repeat(1m)', '\t- old @done(2026-07-01)'].join('\n');
  const fx = mountSidebar(DONE_DOC, { elementFromPoint: (_x, y) => (y >= 100 ? hover : null) });
  const row = fx.sidebar.contentEl.querySelector<HTMLElement>('.tp-sb-tag[data-tag-name="done"]')!;
  check('the @done tag row renders as a drop target', row !== null);
  hover = row;
  fx.editor.dom.querySelector<HTMLElement>('.tp-handle[data-line="1"]')!
    .dispatchEvent(mouse('mousedown', { clientY: 0 }));
  window.dispatchEvent(mouse('mousemove', { clientX: 10, clientY: 150 }));
  window.dispatchEvent(mouse('mouseup'));
  const lines = docText(fx.editor).split('\n');
  check(
    'the dropped @repeat task completes with the settings stamp',
    lines[1] === '\t- pay rent @due(2026-07-01) @repeat(1m) @done(2026-01-02)',
    lines[1],
  );
  check(
    'the recurrence spawns its successor, same as every other done gesture',
    lines[2] === '\t- pay rent @due(2026-08-01) @repeat(1m)',
    lines[2],
  );
  fx.cleanup();
}

// --- @done drop with MIXED done/undone roots toggles only the undone ---
// (A plain toggle would UN-complete the already-done root; the drop filters
// the drag roots down to the not-yet-done ones before the pipeline runs.)
{
  let hover: Element | null = null;
  const MIX_DOC = ['Home:', '\t- open one', '\t- finished @done(2026-07-01)'].join('\n');
  const fx = mountSidebar(MIX_DOC, { elementFromPoint: (_x, y) => (y >= 100 ? hover : null) });
  const row = fx.sidebar.contentEl.querySelector<HTMLElement>('.tp-sb-tag[data-tag-name="done"]')!;
  hover = row;
  // Multi-select BOTH roots, then drag one of them onto the @done row.
  const doc = fx.editor.state.doc;
  fx.editor.dispatch({
    selection: EditorSelection.create([
      EditorSelection.cursor(doc.line(2).from),
      EditorSelection.cursor(doc.line(3).from),
    ]),
  });
  fx.editor.dom
    .querySelector<HTMLElement>('.tp-handle[data-line="1"]')!
    .dispatchEvent(mouse('mousedown', { clientY: 0 }));
  window.dispatchEvent(mouse('mousemove', { clientX: 10, clientY: 150 }));
  window.dispatchEvent(mouse('mouseup'));
  const lines = docText(fx.editor).split('\n');
  check('the undone root completes with the stamp', lines[1] === '\t- open one @done(2026-01-02)', lines[1]);
  check(
    'the already-done root keeps its original @done (never un-completed)',
    lines[2] === '\t- finished @done(2026-07-01)',
    lines[2],
  );
  check('a mixed drop shows no notice', fx.host.notices.length === 0, fx.host.notices.join('|'));
  fx.cleanup();
}

// --- duplicate same-name tags collapse to one on drop ---
{
  const fx = mountTagFixture();
  fx.setHover(fx.valueRow('priority', 'high'));
  fx.handle(1).dispatchEvent(mouse('mousedown', { clientY: 0 })); // alpha (dup @priority)
  window.dispatchEvent(mouse('mousemove', { clientX: 10, clientY: 150 }));
  window.dispatchEvent(mouse('mouseup'));
  check('duplicate tags collapse to the one new value', fx.lines()[1] === '\t- alpha @priority(high)', fx.lines()[1]);
  fx.cleanup();
}

// --- multi-select drag assigns to every selected ROOT, never descendants ---
{
  const fx = mountTagFixture();
  const doc = fx.editor.state.doc;
  // Two ranges: alpha + its child, and a cursor on beta.
  fx.editor.dispatch({
    selection: EditorSelection.create([
      EditorSelection.range(doc.line(2).from, doc.line(3).to),
      EditorSelection.cursor(doc.line(4).from),
    ]),
  });
  fx.setHover(fx.valueRow('priority', 'high'));
  fx.handle(1).dispatchEvent(mouse('mousedown', { clientY: 0 })); // alpha, inside the selection
  window.dispatchEvent(mouse('mousemove', { clientX: 10, clientY: 150 }));
  window.dispatchEvent(mouse('mouseup'));
  check('every selected root is tagged (alpha)', fx.lines()[1] === '\t- alpha @priority(high)', fx.lines()[1]);
  check('every selected root is tagged (beta)', fx.lines()[3] === '\t- beta @priority(high)', fx.lines()[3]);
  check('a selected child is never retagged', fx.lines()[2] === '\t\t- child of alpha', fx.lines()[2]);
  check('unselected lines stay untouched', fx.lines()[6] === '\t- delta @flag');
  fx.cleanup();
}

// --- a document change mid-drag aborts the assignment with a notice ---
{
  const fx = mountTagFixture();
  const row = fx.valueRow('priority', 'high');
  fx.setHover(row);
  fx.handle(3).dispatchEvent(mouse('mousedown', { clientY: 0 })); // beta
  window.dispatchEvent(mouse('mousemove', { clientX: 10, clientY: 150 }));
  check('assign target highlighted before the edit', row.classList.contains('tp-sb-drop-assign'));
  fx.editor.dispatch({ changes: { from: 0, to: 0, insert: 'X' } }); // concurrent edit
  check('the doc change aborts with the zh-TW notice', fx.host.notices.includes(DRAG_ASSIGN_ABORT_NOTICE), fx.host.notices.join('|'));
  check('the abort clears the highlight', !row.classList.contains('tp-sb-drop-assign'));
  window.dispatchEvent(mouse('mouseup'));
  check('no tag was applied to the changed document', docText(fx.editor) === 'X' + TAG_DOC, docText(fx.editor));
  check('exactly one abort notice', fx.host.notices.length === 1);
  fx.cleanup();
}

// --- a doc change mid-drag over a PROJECT row aborts SILENTLY ---
// (Only tag-assign drags warn — project drops recompute from the fresh
// document anyway, so their abort must not spam a notice.)
{
  const fx = mountTagFixture();
  const projRow = fx.rows()[1]; // Work
  fx.setHover(projRow);
  fx.handle(3).dispatchEvent(mouse('mousedown', { clientY: 0 })); // beta
  window.dispatchEvent(mouse('mousemove', { clientX: 10, clientY: 150 }));
  check('project row highlighted before the edit', projRow.classList.contains('tp-sb-drop-into'));
  fx.editor.dispatch({ changes: { from: 0, to: 0, insert: 'X' } }); // concurrent edit
  check('a project-drop abort shows NO notice', fx.host.notices.length === 0, fx.host.notices.join('|'));
  check('the abort clears the project highlight', !projRow.classList.contains('tp-sb-drop-into'));
  window.dispatchEvent(mouse('mouseup'));
  check('no move is committed after the silent abort', docText(fx.editor) === 'X' + TAG_DOC, docText(fx.editor));
  fx.cleanup();
}

// --- Escape cancels an assign drag silently ---
{
  const fx = mountTagFixture();
  const row = fx.tagRow('flag');
  fx.setHover(row);
  fx.handle(3).dispatchEvent(mouse('mousedown', { clientY: 0 }));
  window.dispatchEvent(mouse('mousemove', { clientX: 10, clientY: 150 }));
  check('tag row highlighted mid-drag', row.classList.contains('tp-sb-drop-assign'));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  check('escape removes the assign highlight', !row.classList.contains('tp-sb-drop-assign'));
  window.dispatchEvent(mouse('mouseup'));
  check('the cancelled assign changes nothing', docText(fx.editor) === TAG_DOC);
  check('a cancelled assign shows no notice', fx.host.notices.length === 0);
  fx.cleanup();
}

// ---------------------------------------------------------------------------
// Settings-driven behavior: dim mode, include/exclude tags
// ---------------------------------------------------------------------------

// --- filterHidesInsteadOfDims: false — sidebar filters DIM instead of hide ---
{
  const fx = mountSidebar(TAG_DOC, {}, { filterHidesInsteadOfDims: false });
  fx.sidebar.contentEl
    .querySelector<HTMLElement>('.tp-sb-tag[data-tag-name="flag"]')!
    .dispatchEvent(mouse('click'));
  const spec = fx.editor.state.field(filterSpecField);
  check(
    'the sidebar tag click carries hide:false',
    spec !== null && spec.mode === 'query' && spec.hide === false,
    JSON.stringify(spec),
  );
  // No block-replace (hide) decorations exist — dim mode only adds line marks.
  let hideBlocks = 0;
  fx.editor.state.field(filterDecoField).between(0, fx.editor.state.doc.length, (from, to) => {
    if (to > from) {
      hideBlocks++;
    }
  });
  check('nothing is hidden in dim mode', hideBlocks === 0, String(hideBlocks));
  // Only delta (@flag) and its ancestor Work stay undimmed.
  check(
    'every non-matching line is dimmed',
    setEq(dimLineNumbers(fx.editor), new Set([1, 2, 3, 4, 6])),
    [...dimLineNumbers(fx.editor)].join(','),
  );
  check(
    'the tp-dim class reaches the rendered lines',
    fx.editor.dom.querySelectorAll('.cm-line.tp-dim').length === 5,
    String(fx.editor.dom.querySelectorAll('.cm-line.tp-dim').length),
  );
  fx.cleanup();
}

// --- Ctrl/Cmd multi-select composes union within kinds, intersect across ---
{
  const MULTI_DOC = ['Home:', '\t- h1 @a', 'Work:', '\t- w1 @a', '\t- w2 @b', '\t- w3'].join('\n');
  const fx = mountSidebar(MULTI_DOC);
  const tagRow = (name: string) =>
    fx.sidebar.contentEl.querySelector<HTMLElement>(`.tp-sb-tag[data-tag-name="${name}"]`)!;
  fx.rows()[1].dispatchEvent(mouse('click', { ctrlKey: true })); // Work (line 2)
  tagRow('a').dispatchEvent(mouse('click', { ctrlKey: true }));
  tagRow('b').dispatchEvent(mouse('click', { ctrlKey: true }));
  const spec = fx.editor.state.field(filterSpecField);
  check(
    'project + two tags compose (project//*) intersect (tag union tag)',
    spec !== null &&
      spec.mode === 'query' &&
      spec.query === '(((@id = 2 and project)//*)) intersect ((@a) union (@b))',
    JSON.stringify(spec),
  );
  check(
    'only Work descendants tagged @a or @b stay visible',
    setEq(hiddenLineNumbers(fx.editor), new Set([1, 2, 6])),
    [...hiddenLineNumbers(fx.editor)].join(','),
  );
  check('the selection holds all three rows', fx.view.sidebarSelection.length === 3, JSON.stringify(fx.view.sidebarSelection));
  check(
    'every selected row highlights after the re-render',
    fx.rows()[1].classList.contains('is-focused') &&
      tagRow('a').classList.contains('is-focused') &&
      tagRow('b').classList.contains('is-focused'),
  );

  // Ctrl-clicking a selected row removes just that row from the composition.
  tagRow('b').dispatchEvent(mouse('click', { ctrlKey: true }));
  const spec2 = fx.editor.state.field(filterSpecField);
  check(
    'ctrl-click on a selected row narrows the composed query',
    spec2 !== null &&
      spec2.mode === 'query' &&
      spec2.query === '(((@id = 2 and project)//*)) intersect ((@a))',
    JSON.stringify(spec2),
  );
  check(
    'the narrowed filter hides the @b task again',
    setEq(hiddenLineNumbers(fx.editor), new Set([1, 2, 5, 6])),
    [...hiddenLineNumbers(fx.editor)].join(','),
  );
  fx.cleanup();
}

// --- includeTags / excludeTags drive which tag rows render ---
{
  const doc = ['Home:', '\t- a @flag', '\t- s @search(not @done)'].join('\n');
  const fx = mountSidebar(doc, {}, { includeTags: '@due', excludeTags: 'search' });
  const names = () =>
    Array.from(fx.sidebar.contentEl.querySelectorAll<HTMLElement>('.tp-sb-tag')).map((el) =>
      el.getAttribute('data-tag-name'),
    );
  check('an included tag renders even when absent from the document', names().includes('due'), names().join(','));
  const dueRow = fx.sidebar.contentEl.querySelector<HTMLElement>('.tp-sb-tag[data-tag-name="due"]')!;
  check(
    'the included-but-absent tag shows count 0',
    dueRow.querySelector('.tp-sb-count')?.textContent === '0',
    dueRow.querySelector('.tp-sb-count')?.textContent ?? '(none)',
  );
  check('the default-excluded @search tag never renders', !names().includes('search'), names().join(','));
  check('found + included tags render sorted alphabetically', names().join(',') === 'due,flag', names().join(','));
  fx.cleanup();
}
{
  const fx = mountSidebar('- a @flag', {}, { includeTags: 'flag due', excludeTags: '@flag' });
  const names = Array.from(
    fx.sidebar.contentEl.querySelectorAll<HTMLElement>('.tp-sb-tag'),
  ).map((el) => el.getAttribute('data-tag-name'));
  check('excludeTags wins over includeTags', names.join(',') === 'due', names.join(','));
  fx.cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
