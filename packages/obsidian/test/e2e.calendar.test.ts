/**
 * E2E tests for the calendar pane (embedded editor ⇄ calendar mode): the REAL
 * CalendarPane renders into a jsdom DOM (the 'obsidian' module is aliased to
 * test/stubs/obsidian.ts), wired through the REAL source-aware calendar host
 * (createCalendarHost) to a REAL EditorView mounted with the production
 * extension stack via the e2e harness. The pane's injectable clock pins
 * "today" to Sunday 2026-07-12 so date placement is deterministic.
 *
 * The vault-scope (F4) tests add extra .taskpaper files to the stub vault and
 * exercise the 本檔|全部 toggle, file badges, cross-file reschedules (open
 * editor + vault.process), the ambiguity guard and setting persistence.
 */
import { docText, mountEditor } from './e2eHarness';
import { App, Notice } from 'obsidian';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { CalendarPane } from '../src/calendarPane';
import { CalendarViewLike, createCalendarHost } from '../src/calendarHost';
import { TaskpaperLinesCache } from '../src/calendarSources';
import { DEFAULT_SETTINGS } from '../src/settings';

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

// "Today" is pinned to Sunday 2026-07-12.
const TODAY = new Date(2026, 6, 12);

const DOC = [
  'Work:',
  '\tRelease:',
  '\t\t- alpha @due(2026-07-15)', // line 2
  '\t- beta @today', // line 3: virtual occurrence on the 12th
  '\t- gone @due(2026-07-10)', // line 4: overdue
  '\t- finished @done(2026-07-08)', // line 5: only with 顯示已完成
  '- loose @due(2026-08-02)', // line 6: next month
].join('\n');

/** A mounted EditorView as the calendar host sees a TaskPaper view. */
function editorAdapter(path: string, view: EditorView, jumps?: number[]): CalendarViewLike {
  return {
    path,
    state: () => view.state,
    setLineText: (line, text) => {
      const doc = view.state.doc.line(line + 1);
      view.dispatch({ changes: { from: doc.from, to: doc.to, insert: text } });
    },
    jumpToLine: (line) => {
      jumps?.push(line);
      view.dispatch({
        selection: EditorSelection.cursor(view.state.doc.line(line + 1).from),
        scrollIntoView: true,
      });
    },
  };
}

/** Mount a real editor + the real calendar pane behind the real host. */
function mountCalendar(doc: string) {
  const mounted = mountEditor(doc);
  const root = document.body.createDiv();
  const jumps: number[] = [];
  const app = new App();
  const settings = { ...DEFAULT_SETTINGS, globalSearches: [] };
  const saved: string[] = [];
  /** Foreign TaskPaper views tests register (unsaved edits must win). */
  const extraOpen: CalendarViewLike[] = [];
  const own = editorAdapter('test.taskpaper', mounted.view, jumps);
  const cache = new TaskpaperLinesCache(
    async (path) => app.vault.contents.get(path) ?? '',
    () => calendar.render(true),
  );
  const calendar = new CalendarPane(
    root,
    createCalendarHost({
      vault: app.vault,
      own: () => own,
      openViews: () => [own, ...extraOpen],
      openFileView: async () => null,
      cachedLines: (file) => cache.lines(file.path, `${file.stat.mtime}:${file.stat.size}`),
      settings,
      saveSettings: () => {
        saved.push(settings.calendarScope);
      },
      epoch: () => 0,
      refresh: () => calendar.render(true),
    }),
  );
  calendar.now = () => TODAY;
  calendar.setActive(true);
  return {
    calendar,
    jumps,
    editor: mounted.view,
    root,
    vault: app.vault,
    settings,
    saved,
    extraOpen,
    cell: (date: string) => root.querySelector<HTMLElement>(`.tp-cal-day[data-date="${date}"]`),
    occs: (scope: HTMLElement = root) =>
      Array.from(scope.querySelectorAll<HTMLElement>('.tp-cal-occ')),
    button: (cls: string) => root.querySelector<HTMLElement>(`.${cls}`),
    scopeButton: (label: string) =>
      Array.from(root.querySelectorAll<HTMLElement>('.tp-cal-scope-btn')).find(
        (b) => b.textContent === label,
      ),
    cleanup: mounted.cleanup,
  };
}

type CalendarFixture = ReturnType<typeof mountCalendar>;

/** Drag the occurrence containing `occText` onto the `toDate` month cell. */
function dragTo(fx: CalendarFixture, occText: string, toDate: string): void {
  const occ = Array.from(fx.root.querySelectorAll<HTMLElement>('.tp-cal-occ')).find((el) =>
    el.textContent?.includes(occText),
  )!;
  occ.dispatchEvent(new window.Event('dragstart', { bubbles: true }));
  const cell = fx.cell(toDate)!;
  cell.dispatchEvent(new window.Event('dragover', { bubbles: true }));
  cell.dispatchEvent(new window.Event('drop', { bubbles: true }));
}

/** Let queued async work (cachedRead fills, vault.process) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function textOf(occ: HTMLElement): string {
  return occ.querySelector('.tp-cal-occ-text')?.textContent ?? '';
}

// --- month grid renders occurrences on the right cells ---
{
  const fx = mountCalendar(DOC);
  check('month label shows the anchor month', fx.root.textContent!.includes('2026年7月'));
  check(
    'weekday header starts Monday (一) after the week-number column',
    fx.root.querySelector('.tp-cal-weekday:not(.tp-cal-weeknum-head)')?.textContent === '一',
  );
  // ISO week labels: last year digit + zero-padded week (2026-07-12 週 = W628 起算列).
  const weekLabels = Array.from(fx.root.querySelectorAll('.tp-cal-weeknum')).map((el) => el.textContent);
  check('every week row carries a W-label', weekLabels.length === 5 && weekLabels.every((w) => /^W6\d{2}$/.test(w ?? '')), weekLabels.join(','));
  check('first July 2026 row is ISO week 27', weekLabels[0] === 'W627', String(weekLabels[0]));
  check('grid has 5 week rows of cells', fx.root.querySelectorAll('.tp-cal-day').length === 35);

  const due = fx.cell('2026-07-15')!;
  check('due task renders on its date cell', fx.occs(due).map(textOf).join(',') === 'alpha');
  check(
    'the due dot carries the due role',
    due.querySelector('.tp-cal-dot-due') !== null,
  );
  const today = fx.cell('2026-07-12')!;
  check('today cell is highlighted', today.classList.contains('is-today'));
  check('@today renders as a virtual occurrence on today', fx.occs(today).map(textOf).join(',') === 'beta');
  check('the virtual occurrence gets the today dot', today.querySelector('.tp-cal-dot-today') !== null);
  const overdue = fx.cell('2026-07-10')!;
  check('overdue task still sits on its own day', fx.occs(overdue).map(textOf).join(',') === 'gone');
  check('overdue dot on a past-due day', overdue.querySelector('.tp-cal-dot-overdue') !== null);
  check(
    'completed occurrences are hidden by default',
    !fx.occs().some((o) => textOf(o) === 'finished'),
  );
  check('out-of-month cells are dimmed', fx.cell('2026-06-29')!.classList.contains('is-outside'));
  fx.cleanup();
}

// --- month navigation changes the rendered month ---
{
  const fx = mountCalendar(DOC);
  fx.button('tp-cal-next')!.click();
  check('next › moves to August', fx.root.textContent!.includes('2026年8月'));
  const aug = fx.cell('2026-08-02');
  check(
    'the August-due task now sits in-month',
    aug !== null && aug.classList.contains('is-outside') === false &&
      fx.occs(aug!).map(textOf).join(',') === 'loose',
  );
  fx.button('tp-cal-prev')!.click();
  fx.button('tp-cal-prev')!.click();
  check('‹ prev twice lands on June', fx.root.textContent!.includes('2026年6月'));
  fx.button('tp-cal-today-btn')!.click();
  check("今天 returns to today's month", fx.root.textContent!.includes('2026年7月'));
  check('the today cell is highlighted again', fx.cell('2026-07-12')!.classList.contains('is-today'));
  fx.cleanup();
}

// --- agenda mode: 逾期 section + ascending date sections with labels ---
{
  const fx = mountCalendar(DOC);
  fx.button('tp-cal-mode')!.click();
  check('toggle switches to the agenda list', fx.root.querySelector('.tp-cal-agenda') !== null);
  check('the month grid is gone in agenda mode', fx.root.querySelector('.tp-cal-grid') === null);

  const overdueSection = fx.root.querySelector<HTMLElement>('.tp-cal-overdue');
  check('逾期 section renders when overdue exists', overdueSection !== null);
  check(
    '逾期 heading',
    overdueSection!.querySelector('.tp-cal-section-heading')!.textContent === '逾期',
  );
  check(
    'the overdue task is grouped under 逾期',
    fx.occs(overdueSection!).map(textOf).join(',') === 'gone',
  );
  check(
    'the overdue breadcrumb carries date + project path',
    overdueSection!.querySelector('.tp-cal-occ-path')!.textContent === '7月10日 · Work',
  );

  const headings = Array.from(fx.root.querySelectorAll('.tp-cal-section-heading')).map(
    (h) => h.textContent,
  );
  check(
    'date sections ascend with 今天 label and weekday',
    headings.join('|') === '逾期|7月12日 · 週日 · 今天|7月15日 · 週三',
    headings.join('|'),
  );
  const todaySection = fx.root.querySelectorAll<HTMLElement>('.tp-cal-section')[1];
  check(
    'agenda rows show the muted project breadcrumb',
    fx.occs(todaySection).map(textOf).join(',') === 'beta' &&
      todaySection.querySelector('.tp-cal-occ-path')!.textContent === 'Work',
  );

  fx.button('tp-cal-mode')!.click();
  check('toggling back restores the grid', fx.root.querySelector('.tp-cal-grid') !== null);
  fx.cleanup();
}

// --- clicking an occurrence moves the editor selection to its line ---
{
  const fx = mountCalendar(DOC);
  const alpha = fx.occs(fx.cell('2026-07-15')!)[0];
  alpha.click();
  const line = fx.editor.state.doc.lineAt(fx.editor.state.selection.main.head);
  check('click moves the cursor to the item line (0-based 2)', line.number === 3, String(line.number));
  check('the cursor parks at the line start', fx.editor.state.selection.main.head === line.from);
  fx.cleanup();
}

// --- a stale occurrence shows a Notice and does not move the cursor ---
{
  const fx = mountCalendar(DOC);
  const alpha = fx.occs(fx.cell('2026-07-15')!)[0];
  // Rewrite the item's text underneath the rendered calendar (no re-render).
  const from = fx.editor.state.doc.toString().indexOf('alpha');
  fx.editor.dispatch({ changes: { from, to: from + 5, insert: 'renamed' } });
  const before = fx.editor.state.selection.main.head;
  const notices = Notice.messages.length;
  alpha.click();
  check('a stale click raises a Notice', Notice.messages.length === notices + 1);
  check('the Notice explains in Chinese', Notice.messages[Notice.messages.length - 1].includes('文件已變更'));
  check('the selection did not move', fx.editor.state.selection.main.head === before);
  check('the document is untouched', docText(fx.editor).includes('renamed'));
  fx.cleanup();
}

// --- 顯示已完成 toggle adds/removes completed occurrences ---
{
  const fx = mountCalendar(DOC);
  check('completed hidden before the toggle', fx.cell('2026-07-08') !== null && fx.occs(fx.cell('2026-07-08')!).length === 0);
  fx.button('tp-cal-done-toggle')!.click();
  const cell = fx.cell('2026-07-08')!;
  check('toggle shows the completed occurrence on its done date', fx.occs(cell).map(textOf).join(',') === 'finished');
  check('completed occurrences use the faint dot', cell.querySelector('.tp-cal-dot-completed') !== null);
  check('the toggle button is marked active', fx.button('tp-cal-done-toggle')!.classList.contains('is-active'));
  fx.button('tp-cal-done-toggle')!.click();
  check('toggling again removes it', fx.occs(fx.cell('2026-07-08')!).length === 0);
  fx.cleanup();
}

// --- render guard: identical state skips the rebuild, edits invalidate it ---
{
  const fx = mountCalendar(DOC);
  const gridBefore = fx.root.querySelector('.tp-cal-grid');
  fx.calendar.render();
  check('an unforced re-render with the same signature keeps the DOM', fx.root.querySelector('.tp-cal-grid') === gridBefore);
  fx.editor.dispatch({ changes: { from: 0, insert: '- new @due(2026-07-20)\n' } });
  fx.calendar.render();
  check(
    'a document edit invalidates the guard and re-renders',
    fx.occs(fx.cell('2026-07-20')!).map(textOf).join(',') === 'new',
  );
  fx.cleanup();
}

// --- inactive panes skip rendering entirely (hidden = zero work) ---
{
  const mounted = mountEditor('- x @due(2026-07-15)');
  const root = document.body.createDiv();
  const pane = new CalendarPane(
    root,
    createCalendarHost({
      vault: new App().vault,
      own: () => editorAdapter('test.taskpaper', mounted.view),
      openViews: () => [],
      openFileView: async () => null,
      cachedLines: () => null,
      settings: { ...DEFAULT_SETTINGS, globalSearches: [] },
      saveSettings: () => {},
      epoch: () => 0,
      refresh: () => {},
    }),
  );
  pane.now = () => TODAY;
  pane.render(true);
  check('inactive pane renders nothing', root.querySelector('.tp-cal-grid') === null);
  pane.setActive(true);
  check('activation renders the grid', root.querySelector('.tp-cal-grid') !== null);
  pane.setActive(false);
  mounted.cleanup();
}

// --- drag an occurrence to another day rewrites its date ---
{
  const fx = mountCalendar(DOC);
  const drag = (occText: string, toDate: string) => {
    const occ = Array.from(fx.root.querySelectorAll<HTMLElement>('.tp-cal-occ')).find(
      (el) => el.textContent?.includes(occText),
    )!;
    occ.dispatchEvent(new window.Event('dragstart', { bubbles: true }));
    const cell = fx.cell(toDate)!;
    cell.dispatchEvent(new window.Event('dragover', { bubbles: true }));
    cell.dispatchEvent(new window.Event('drop', { bubbles: true }));
  };

  drag('alpha', '2026-07-20');
  check(
    'dragging a due task to another day rewrites @due',
    docText(fx.editor).includes('- alpha @due(2026-07-20)'),
    docText(fx.editor).split('\n')[2],
  );
  check(
    'the calendar re-renders with the moved occurrence',
    fx.occs(fx.cell('2026-07-20')!).some((o) => o.textContent?.includes('alpha')),
  );

  drag('beta', '2026-07-21');
  check(
    'dragging a virtual @today item converts it to @due',
    docText(fx.editor).includes('- beta @due(2026-07-21)') && !docText(fx.editor).includes('@today'),
    docText(fx.editor).split('\n')[3],
  );
  fx.cleanup();
}

// --- a document edit between dragstart and drop rejects the reschedule ---
{
  const fx = mountCalendar(DOC);
  const occ = Array.from(fx.root.querySelectorAll<HTMLElement>('.tp-cal-occ')).find(
    (el) => el.textContent?.includes('alpha'),
  )!;
  occ.dispatchEvent(new window.Event('dragstart', { bubbles: true }));
  fx.editor.dispatch({ changes: { from: 0, insert: '- sneaky\n' } }); // doc drifts mid-drag
  const before = docText(fx.editor);
  const cell = fx.cell('2026-07-20')!;
  cell.dispatchEvent(new window.Event('dragover', { bubbles: true }));
  cell.dispatchEvent(new window.Event('drop', { bubbles: true }));
  check('a drifted document rejects the drop', docText(fx.editor) === before);
  check('the rejection shows a notice', Notice.messages[Notice.messages.length - 1]?.includes('未改期') === true, String(Notice.messages[Notice.messages.length - 1]));
  fx.cleanup();
}

// ---------------------------------------------------------------------------
// F4 — vault-wide scope (「全部」)
// ---------------------------------------------------------------------------

async function vaultScopeTests(): Promise<void> {
  // --- the scope toggle shows foreign occurrences with dim file badges ---
  {
    const fx = mountCalendar(DOC);
    await fx.vault.create('other.taskpaper', 'Errands:\n\t- foreign task @due(2026-07-15)\n');
    check('the toolbar renders the 本檔|全部 toggle', fx.scopeButton('本檔') !== undefined && fx.scopeButton('全部') !== undefined);
    check('本檔 starts active (default scope)', fx.scopeButton('本檔')!.classList.contains('is-active'));

    fx.scopeButton('全部')!.click();
    await settle(); // the background cachedRead fills, then the pane re-renders
    const due = fx.cell('2026-07-15')!;
    check(
      'vault scope shows the foreign occurrence beside the own one (path-sorted)',
      fx.occs(due).map(textOf).join(',') === 'foreign task,alpha',
      fx.occs(due).map(textOf).join(','),
    );
    check(
      'the foreign month-cell entry carries a dim basename badge',
      fx.occs(due)[0].querySelector('.tp-cal-occ-badge')?.textContent === 'other',
    );
    check('own-file occurrences get no badge', fx.occs(due)[1].querySelector('.tp-cal-occ-badge') === null);
    check('全部 is marked active after the toggle', fx.scopeButton('全部')!.classList.contains('is-active'));
    check(
      'the choice persists to settings.calendarScope',
      fx.settings.calendarScope === 'vault' && fx.saved.length === 1,
    );

    fx.button('tp-cal-mode')!.click();
    check(
      'agenda rows carry the badge too',
      Array.from(fx.root.querySelectorAll('.tp-cal-agenda .tp-cal-occ-badge')).some(
        (b) => b.textContent === 'other',
      ),
    );
    fx.button('tp-cal-mode')!.click();

    fx.scopeButton('本檔')!.click();
    check(
      'toggling back to 本檔 hides foreign occurrences',
      fx.occs(fx.cell('2026-07-15')!).map(textOf).join(',') === 'alpha',
    );
    check(
      'the file scope persists as well',
      fx.settings.calendarScope === 'file' && fx.saved.length === 2,
    );
    fx.cleanup();
  }

  // --- cross-file drag-reschedule rewrites the closed file via vault.process ---
  {
    const fx = mountCalendar(DOC);
    await fx.vault.create('other.taskpaper', '- foreign @due(2026-07-15)\n');
    fx.scopeButton('全部')!.click();
    await settle();
    dragTo(fx, 'foreign', '2026-07-20');
    await settle();
    check(
      'the drop rewrites the foreign file through vault.process',
      fx.vault.contents.get('other.taskpaper') === '- foreign @due(2026-07-20)\n',
      JSON.stringify(fx.vault.contents.get('other.taskpaper')),
    );
    check('the own document is untouched', !docText(fx.editor).includes('foreign'));
    check(
      'after the cache refill the occurrence sits on the new day',
      fx.occs(fx.cell('2026-07-20')!).some((o) => o.textContent?.includes('foreign')),
    );
    fx.cleanup();
  }

  // --- duplicate identical lines in the foreign file: ambiguous, refuse ---
  {
    const fx = mountCalendar(DOC);
    await fx.vault.create('dup.taskpaper', '- dup @due(2026-07-15)\n- dup @due(2026-07-15)\n');
    fx.scopeButton('全部')!.click();
    await settle();
    const before = fx.vault.contents.get('dup.taskpaper');
    const notices = Notice.messages.length;
    dragTo(fx, 'dup', '2026-07-20');
    await settle();
    check('an ambiguous fingerprint leaves the file unchanged', fx.vault.contents.get('dup.taskpaper') === before);
    check(
      'the refusal shows a zh-TW Notice',
      Notice.messages.slice(notices).some((m) => m.includes('多個相同項目')),
      Notice.messages.slice(notices).join(' / '),
    );
    fx.cleanup();
  }

  // --- an open view's unsaved edits win over stale disk content ---
  {
    const fx = mountCalendar(DOC);
    await fx.vault.create('open.taskpaper', '- stale disk @due(2026-07-16)\n');
    const other = mountEditor('- live edit @due(2026-07-17)\n');
    fx.extraOpen.push(editorAdapter('open.taskpaper', other.view));
    fx.scopeButton('全部')!.click();
    await settle();
    check(
      'the open editor content wins over the disk copy',
      fx.occs(fx.cell('2026-07-17')!).map(textOf).join(',') === 'live edit',
    );
    check('the stale disk occurrence never appears', fx.occs(fx.cell('2026-07-16')!).length === 0);
    check(
      'open-view occurrences still carry the basename badge',
      fx.occs(fx.cell('2026-07-17')!)[0].querySelector('.tp-cal-occ-badge')?.textContent === 'open',
    );

    // Rescheduling a file with an open view dispatches into that editor.
    dragTo(fx, 'live edit', '2026-07-21');
    await settle();
    check(
      'the reschedule lands in the open editor',
      docText(other.view) === '- live edit @due(2026-07-21)\n',
      JSON.stringify(docText(other.view)),
    );
    check(
      'the vault copy stays untouched until that view saves',
      fx.vault.contents.get('open.taskpaper') === '- stale disk @due(2026-07-16)\n',
    );
    other.cleanup();
    fx.cleanup();
  }
}

void vaultScopeTests().then(
  () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
