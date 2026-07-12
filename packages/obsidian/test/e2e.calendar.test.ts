/**
 * E2E tests for the calendar pane (embedded editor ⇄ calendar mode): the REAL
 * CalendarPane renders into a jsdom DOM (the 'obsidian' module is aliased to
 * test/stubs/obsidian.ts), wired to a REAL EditorView mounted with the
 * production extension stack via the e2e harness. The pane's injectable clock
 * pins "today" to Sunday 2026-07-12 so date placement is deterministic.
 */
import { docText, mountEditor } from './e2eHarness';
import { Notice } from 'obsidian';
import { EditorSelection } from '@codemirror/state';
import { CalendarPane } from '../src/calendarPane';

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

/** Mount a real editor + the real calendar pane around a minimal host. */
function mountCalendar(doc: string) {
  const mounted = mountEditor(doc);
  const root = document.body.createDiv();
  const jumps: number[] = [];
  const calendar = new CalendarPane(root, {
    state: () => mounted.view.state,
    weekStart: () => 1,
    jumpToLine: (line) => {
      jumps.push(line);
      mounted.view.dispatch({
        selection: EditorSelection.cursor(mounted.view.state.doc.line(line + 1).from),
        scrollIntoView: true,
      });
    },
  });
  calendar.now = () => TODAY;
  calendar.setActive(true);
  return {
    calendar,
    jumps,
    editor: mounted.view,
    root,
    cell: (date: string) => root.querySelector<HTMLElement>(`.tp-cal-day[data-date="${date}"]`),
    occs: (scope: HTMLElement = root) =>
      Array.from(scope.querySelectorAll<HTMLElement>('.tp-cal-occ')),
    button: (cls: string) => root.querySelector<HTMLElement>(`.${cls}`),
    cleanup: mounted.cleanup,
  };
}

function textOf(occ: HTMLElement): string {
  return occ.querySelector('.tp-cal-occ-text')?.textContent ?? '';
}

// --- month grid renders occurrences on the right cells ---
{
  const fx = mountCalendar(DOC);
  check('month label shows the anchor month', fx.root.textContent!.includes('2026年7月'));
  check(
    'weekday header starts Monday (一)',
    fx.root.querySelector('.tp-cal-weekday')?.textContent === '一',
  );
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
  const pane = new CalendarPane(root, {
    state: () => mounted.view.state,
    weekStart: () => 1,
    jumpToLine: () => {},
  });
  pane.now = () => TODAY;
  pane.render(true);
  check('inactive pane renders nothing', root.querySelector('.tp-cal-grid') === null);
  pane.setActive(true);
  check('activation renders the grid', root.querySelector('.tp-cal-grid') !== null);
  pane.setActive(false);
  mounted.cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
