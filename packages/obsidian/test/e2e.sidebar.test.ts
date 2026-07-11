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
import { Menu, TFile, WorkspaceLeaf } from 'obsidian';
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
function mountSidebar(doc: string, hostOverrides: Partial<RecordingHost> = {}) {
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
