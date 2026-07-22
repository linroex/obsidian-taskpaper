/**
 * E2E tests for the REAL TaskPaperView (src/view.ts) under jsdom: the view is
 * constructed against the stub WorkspaceLeaf/TextFileView ('obsidian' aliased
 * to test/stubs/obsidian.ts) and opened through its production onOpen() path —
 * searchbar, editor (full production extension stack) and embedded calendar
 * are all built by view code, not by the test.
 *
 * Covered:
 *  - the searchbar input applies valid queries and REJECTS invalid ones,
 *    keeping the previous filter + marking the input (tp-query-error)
 *  - Escape inside the searchbar clears the filter
 *  - setViewData (external modify) replaces the document, resets focus and
 *    filter, and never routes through the editor's save path
 *
 * jsdom limits: measureIndentUnit() measures 0 and retries via rAF (harmless
 * under the stubbed rAF); the calendar pane stays inactive in editor mode.
 */
import { clickEl, docText, hiddenLineNumbers } from './e2eHarness';
import { WorkspaceLeaf } from 'obsidian';
import { filterSpecField } from '../src/editor/filter';
import { filterHelpSections, filterHelpTitle } from '../src/filterHelp';
import { DEFAULT_SETTINGS } from '../src/settings';
import { TaskPaperView } from '../src/view';
import type TaskPaperPlugin from '../src/main';

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

/** A recording fake plugin around the stub App the View base class provides. */
interface FakePlugin {
  settings: typeof DEFAULT_SETTINGS;
  refreshes: number;
  epochBumps: number;
  lastActiveView: unknown;
  calendarEpoch: number;
  commands: Record<string, never>;
  refreshSidebar(): void;
  refreshSidebarSoon(): void;
  bumpCalendarEpoch(): void;
  saveSettings(): Promise<void>;
}

/** Mount the REAL TaskPaperView with `doc` as its file data. */
function mountView(doc: string, settingsOverrides: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const plugin: FakePlugin = {
    settings: { ...DEFAULT_SETTINGS, globalSearches: [], ...settingsOverrides },
    refreshes: 0,
    epochBumps: 0,
    lastActiveView: null,
    calendarEpoch: 0,
    commands: {},
    refreshSidebar() {
      this.refreshes++;
    },
    refreshSidebarSoon() {},
    bumpCalendarEpoch() {
      this.epochBumps++;
    },
    async saveSettings() {},
  };
  const view = new TaskPaperView(new WorkspaceLeaf(), plugin as unknown as TaskPaperPlugin);
  document.body.appendChild(view.containerEl);
  view.data = doc; // what Obsidian would have loaded from disk
  void view.onOpen(); // synchronous up to its (nonexistent) first await
  const input = view.contentEl.querySelector<HTMLInputElement>('.tp-searchbar-input')!;
  return {
    view,
    plugin,
    input,
    setSearch(text: string) {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    cleanup() {
      void view.onClose();
      view.containerEl.remove();
    },
  };
}

function activeSpec(view: TaskPaperView) {
  return view.editor.state.field(filterSpecField, false) ?? null;
}

// Inbox(1) / -alpha @today(2) / -beta @waiting(bob)(3) / Work(4) / -gamma(5)
const DOC = ['Inbox:', '\t- alpha @today', '\t- beta @waiting(bob)', 'Work:', '\t- gamma'].join('\n');

// --- onOpen builds the production surface ---
{
  const fx = mountView(DOC);
  check('onOpen mounts the searchbar input', fx.input !== null);
  check('onOpen mounts the editor with the file data', docText(fx.view.editor) === DOC);
  check('the view registers itself as the last active view', fx.plugin.lastActiveView === fx.view);
  check('getViewData reads the live editor', fx.view.getViewData() === DOC);
  fx.cleanup();
}

// --- searchbar: a valid query filters; an INVALID one keeps the prior filter ---
{
  const fx = mountView(DOC);

  fx.setSearch('@today');
  let spec = activeSpec(fx.view);
  check(
    'a valid query applies a hide filter (per settings)',
    spec !== null && spec.mode === 'query' && spec.query === '@today' && spec.hide === true,
    JSON.stringify(spec),
  );
  check(
    'the filter hides the non-matching lines',
    setEq(hiddenLineNumbers(fx.view.editor), new Set([3, 4, 5])),
    [...hiddenLineNumbers(fx.view.editor)].join(','),
  );
  check('a valid query carries no error class', !fx.input.classList.contains('tp-query-error'));
  const refreshesAfterValid = fx.plugin.refreshes;

  // Malformed query: the input is marked, the PREVIOUS filter stays applied.
  fx.setSearch('@today and');
  check('a malformed query marks the input', fx.input.classList.contains('tp-query-error'));
  spec = activeSpec(fx.view);
  check(
    'the previous filter survives the malformed query',
    spec !== null && spec.mode === 'query' && spec.query === '@today',
    JSON.stringify(spec),
  );
  check(
    'the previous decorations stay in place',
    setEq(hiddenLineNumbers(fx.view.editor), new Set([3, 4, 5])),
    [...hiddenLineNumbers(fx.view.editor)].join(','),
  );
  check('a rejected query never refreshes the sidebar', fx.plugin.refreshes === refreshesAfterValid);

  // Fixing the query clears the error and replaces the filter.
  fx.setSearch('@waiting');
  check('a corrected query clears the error class', !fx.input.classList.contains('tp-query-error'));
  spec = activeSpec(fx.view);
  check('the corrected query replaces the filter', spec !== null && spec.mode === 'query' && spec.query === '@waiting', JSON.stringify(spec));
  check(
    'the new filter re-hides accordingly',
    setEq(hiddenLineNumbers(fx.view.editor), new Set([2, 4, 5])),
    [...hiddenLineNumbers(fx.view.editor)].join(','),
  );

  // Emptying the input clears the filter entirely.
  fx.setSearch('');
  check('an emptied input clears the filter', activeSpec(fx.view) === null);
  check('nothing stays hidden after clearing', hiddenLineNumbers(fx.view.editor).size === 0);
  fx.cleanup();
}

// --- searchbar: Escape clears the filter and the input ---
{
  const fx = mountView(DOC);
  fx.setSearch('@today');
  check('filter active before escape', hiddenLineNumbers(fx.view.editor).size > 0);
  fx.input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  check('escape in the searchbar clears the filter', activeSpec(fx.view) === null);
  check('escape empties the input', fx.input.value === '');
  check('escape leaves no error class behind', !fx.input.classList.contains('tp-query-error'));
  check('nothing stays hidden', hiddenLineNumbers(fx.view.editor).size === 0);
  fx.cleanup();
}

// --- setViewData (external modify) resets focus + filter safely ---
{
  const fx = mountView(DOC);
  // Arrange an active filter AND a focused project — the classic stale state.
  fx.setSearch('@today');
  const handle = fx.view.editor.dom.querySelector<HTMLElement>('.tp-handle[data-line="0"]')!;
  clickEl(handle, { altKey: true }); // alt-click the Inbox handle = focus it
  check('focus is active before the external modify', fx.view.focusedLine === 0);
  const spec = activeSpec(fx.view);
  check('a focus filter is applied before the modify', spec !== null && spec.mode === 'focus');
  check(
    'the focus hides the other project',
    setEq(hiddenLineNumbers(fx.view.editor), new Set([4, 5])),
    [...hiddenLineNumbers(fx.view.editor)].join(','),
  );

  const bumpsBefore = fx.plugin.epochBumps;
  const NEW = 'Replaced:\n\t- r1';
  fx.view.setViewData(NEW, false);

  check('the document is replaced', docText(fx.view.editor) === NEW, JSON.stringify(docText(fx.view.editor)));
  check('getViewData returns the new content', fx.view.getViewData() === NEW);
  check('focusedLine resets to null', fx.view.focusedLine === null);
  check('the filter spec is cleared', activeSpec(fx.view) === null);
  check('no stale decorations remain', hiddenLineNumbers(fx.view.editor).size === 0, [...hiddenLineNumbers(fx.view.editor)].join(','));
  check('the searchbar input syncs to empty', fx.input.value === '', JSON.stringify(fx.input.value));
  check('the calendar epoch bumps for the external change', fx.plugin.epochBumps === bumpsBefore + 1);
  check(
    'the external apply never routes through the editor save path',
    fx.view.saved.length === 0,
    String(fx.view.saved.length),
  );

  // The applyingExternalData latch released: a real user edit saves again.
  fx.view.editor.dispatch({ changes: { from: 0, to: 0, insert: 'X' } });
  check('a user edit after the reload schedules a save', fx.view.saved.length === 1 && fx.view.data === 'X' + NEW, String(fx.view.saved.length));
  fx.cleanup();
}

// --- clear() (file deleted/unloaded) empties the editor and the filter ---
{
  const fx = mountView(DOC);
  fx.setSearch('@today');
  fx.view.clear();
  check('clear() empties the document', docText(fx.view.editor) === '');
  check('clear() resets focusedLine', fx.view.focusedLine === null);
  check('clear() drops the filter', activeSpec(fx.view) === null);
  fx.cleanup();
}

// --- the searchbar "?" opens the filter syntax guide ---
{
  const fx = mountView(DOC);
  const help = fx.view.contentEl.querySelector<HTMLElement>('.tp-searchbar-help');
  check('searchbar renders the help button', help !== null);

  help?.click();
  const tables = document.querySelectorAll('.tp-filter-help-table');
  check('clicking ? opens the syntax guide with sections', tables.length >= 4, String(tables.length));
  const codes = Array.from(document.querySelectorAll('.tp-filter-help-table code')).map(
    (el) => el.textContent ?? '',
  );
  check(
    'the guide documents [d] date comparisons',
    codes.some((c) => c.includes('<=[d] today')),
    codes.join(' | '),
  );
  document.querySelectorAll('.tp-filter-help').forEach((el) => el.parentElement?.remove());
  fx.cleanup();
}

// --- the guide's copy is localized (pure content check) ---
{
  const zh = filterHelpSections('zh-TW');
  const en = filterHelpSections('en');
  check('zh guide has sections', zh.length >= 4 && zh[0].title === '基本');
  check('en guide has sections', en.length >= 4 && en[0].title === 'Basics');
  check('zh and en cover the same number of sections', zh.length === en.length);
  check(
    'every row carries an example and a description',
    [...zh, ...en].every((s) => s.rows.every((r) => r.code.length > 0 && r.desc.length > 0)),
  );
  check(
    'titles are localized',
    filterHelpTitle('zh-TW') === '篩選語法說明' && filterHelpTitle('en') === 'Filter syntax',
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
