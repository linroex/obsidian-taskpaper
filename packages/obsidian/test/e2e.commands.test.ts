/**
 * E2E tests for the TaskPaper editor COMMANDS: a real EditorView mounted
 * under jsdom (same harness/extension stack as e2e.test.ts), driven through
 * TaskPaperCommands itself — constructed around a minimal fake plugin/view —
 * so every test exercises the exact code the command palette dispatches.
 *
 * Covered here (per feature, as required):
 *  - Copy Displayed: only the visible lines reach the (stubbed) clipboard
 *    while a filter hides lines; the whole document with no filter.
 *  - Select Branch / Expand Selection / Contract Selection on a real view.
 *  - Collapse Items Completely folds nested descendants (foldedRanges).
 *  - Single-item moves (up/down/right/left) leave the subtree in place.
 *  - The Tag with… multi-select modal applies all staged toggles at once
 *    (its DOM is driven directly: row clicks, typed input, apply button).
 */
import { clickEl, docText, hiddenLineNumbers, mountEditor } from './e2eHarness';
import { foldedRanges } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { todayStamp } from '@taskpaper/core';
import { App, Notice } from 'obsidian';
import { TaskPaperCommands } from '../src/commands';
import { DEFAULT_SETTINGS } from '../src/settings';
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

function foldCount(view: EditorView): number {
  let n = 0;
  foldedRanges(view.state).between(0, view.state.doc.length, () => {
    n++;
  });
  return n;
}

/** TaskPaperCommands wired to a minimal fake plugin + view around a real EditorView. */
function commandsFor(view: EditorView): { commands: TaskPaperCommands; fakeView: TaskPaperView } {
  const plugin = {
    app: new App(),
    settings: { ...DEFAULT_SETTINGS, globalSearches: [] },
    refreshSidebar() {},
  } as unknown as TaskPaperPlugin;
  const fakeView = { editor: view, focusedLine: null, sidebarSelection: [] } as unknown as TaskPaperView;
  return { commands: new TaskPaperCommands(plugin), fakeView };
}

/** The main selection as [from, to] offsets. */
function sel(view: EditorView): [number, number] {
  return [view.state.selection.main.from, view.state.selection.main.to];
}

function lineFrom(view: EditorView, n: number): number {
  return view.state.doc.line(n).from;
}
function lineTo(view: EditorView, n: number): number {
  return view.state.doc.line(n).to;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Inbox(1) / -alpha @today(2) / -beta @waiting(bob)(3) / Work(4) / -gamma(5) / -delta(6)
const DOC = [
  'Inbox:',
  '\t- alpha @today',
  '\t- beta @waiting(bob)',
  'Work:',
  '\t- gamma',
  '\t- delta @waiting(ann)',
].join('\n');

async function main(): Promise<void> {
  // --- Copy Displayed: the stubbed clipboard captures only the visible lines ---
  {
    const captured: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: (text: string) => {
          captured.push(text);
          return Promise.resolve();
        },
      },
      configurable: true,
    });

    const { view, cleanup } = mountEditor(DOC);
    const { commands, fakeView } = commandsFor(view);

    commands.copyDisplayed(fakeView);
    await tick();
    check('with no filter, Copy Displayed copies the whole document', captured[0] === DOC, JSON.stringify(captured[0]));
    check('copy success shows the localized notice', Notice.messages.includes('已複製顯示中的項目。'));

    clickEl(view.dom.querySelector<HTMLElement>('.tp-tag[data-tag="today"]')!);
    check('the @today filter hides the other lines', hiddenLineNumbers(view).size === 4);
    commands.copyDisplayed(fakeView);
    await tick();
    check(
      'with an active filter, only the VISIBLE lines are copied',
      captured[1] === 'Inbox:\n\t- alpha @today',
      JSON.stringify(captured[1]),
    );
    cleanup();
  }

  // --- Copy Displayed: clipboard unavailable -> fallback fails gracefully ---
  {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const { view, cleanup } = mountEditor('- a');
    const { commands, fakeView } = commandsFor(view);
    commands.copyDisplayed(fakeView);
    await tick();
    check(
      'without any clipboard API the failure notice shows (no throw)',
      Notice.messages.includes('無法複製到剪貼簿。'),
    );
    cleanup();
  }

  // --- Select Branch / Expand Selection / Contract Selection ---
  {
    const doc = [
      'Inbox:', //            1
      '\t- alpha @today', //  2
      'Work:', //             3
      '\t- ship', //          4
      '\t\t- childA', //      5
      '\t\t- childB', //      6
      '\t- review', //        7
    ].join('\n');
    const { view, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);

    // Cursor inside the word "ship" on line 4.
    const cursor = lineFrom(view, 4) + 5;
    view.dispatch({ selection: { anchor: cursor } });

    commands.selectBranch(fakeView);
    check(
      'Select Branch selects the item line + its whole subtree',
      sel(view)[0] === lineFrom(view, 4) && sel(view)[1] === lineTo(view, 6),
      sel(view).join('..'),
    );

    // Expand: word -> line -> branch -> parent branch -> document.
    view.dispatch({ selection: { anchor: cursor } });
    commands.expandSelection(fakeView);
    check(
      'expand 1: cursor grows to the word under it',
      sel(view)[0] === lineFrom(view, 4) + 3 && sel(view)[1] === lineFrom(view, 4) + 7,
      sel(view).join('..'),
    );
    commands.expandSelection(fakeView);
    check(
      'expand 2: word grows to the full line',
      sel(view)[0] === lineFrom(view, 4) && sel(view)[1] === lineTo(view, 4),
      sel(view).join('..'),
    );
    commands.expandSelection(fakeView);
    check(
      'expand 3: line grows to the item branch',
      sel(view)[0] === lineFrom(view, 4) && sel(view)[1] === lineTo(view, 6),
      sel(view).join('..'),
    );
    commands.expandSelection(fakeView);
    check(
      "expand 4: branch grows to the parent's branch",
      sel(view)[0] === lineFrom(view, 3) && sel(view)[1] === lineTo(view, 7),
      sel(view).join('..'),
    );
    commands.expandSelection(fakeView);
    check(
      'expand 5: root branch grows to the whole document',
      sel(view)[0] === 0 && sel(view)[1] === view.state.doc.length,
      sel(view).join('..'),
    );
    const whole = sel(view);
    commands.expandSelection(fakeView);
    check('expanding past the document is a no-op', sel(view)[0] === whole[0] && sel(view)[1] === whole[1]);

    // Contract: each step restores the previous selection, back to the cursor.
    commands.contractSelection(fakeView);
    check(
      "contract 1: back to the parent's branch",
      sel(view)[0] === lineFrom(view, 3) && sel(view)[1] === lineTo(view, 7),
      sel(view).join('..'),
    );
    commands.contractSelection(fakeView);
    check(
      'contract 2: back to the item branch',
      sel(view)[0] === lineFrom(view, 4) && sel(view)[1] === lineTo(view, 6),
      sel(view).join('..'),
    );
    commands.contractSelection(fakeView);
    check(
      'contract 3: back to the full line',
      sel(view)[0] === lineFrom(view, 4) && sel(view)[1] === lineTo(view, 4),
      sel(view).join('..'),
    );
    commands.contractSelection(fakeView);
    check(
      'contract 4: back to the word',
      sel(view)[0] === lineFrom(view, 4) + 3 && sel(view)[1] === lineFrom(view, 4) + 7,
      sel(view).join('..'),
    );
    commands.contractSelection(fakeView);
    check('contract 5: back to the original cursor', sel(view)[0] === cursor && sel(view)[1] === cursor);
    commands.contractSelection(fakeView);
    check('contracting past the history is a no-op', sel(view)[0] === cursor && sel(view)[1] === cursor);

    // A manual selection change invalidates the expand history.
    commands.expandSelection(fakeView); // word again
    view.dispatch({ selection: { anchor: lineFrom(view, 2) } });
    const manual = sel(view);
    commands.contractSelection(fakeView);
    check(
      'contract after a manual selection change does nothing (stale history)',
      sel(view)[0] === manual[0] && sel(view)[1] === manual[1],
    );
    cleanup();
  }

  // --- Collapse Items Completely folds the item AND nested descendants ---
  {
    const doc = ['A:', '\t- b', '\t\t- c', '\t\t\t- d', '\t- e', 'B:', '\t- f'].join('\n');
    const { view, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    view.dispatch({ selection: { anchor: 0 } }); // cursor on "A:"

    commands.collapseItemsCompletely(fakeView);
    check(
      'collapse completely folds the item and every foldable descendant',
      foldCount(view) === 3,
      String(foldCount(view)),
    );

    // Expanding one level shows children that are still collapsed.
    commands.expandItems(fakeView);
    check(
      'expanding one level leaves the descendants collapsed',
      foldCount(view) === 2,
      String(foldCount(view)),
    );
    check('the sibling project stays untouched', docText(view) === doc);
    cleanup();
  }

  // --- single-item moves: only the item line relocates; its subtree stays ---
  {
    const doc = ['A:', '\t- prev', '\t- item', '\t\t- child', '\t- next'].join('\n');
    const { view, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    view.dispatch({ selection: { anchor: lineFrom(view, 3) + 3 } }); // on "- item"

    commands.moveOnlyUp(fakeView);
    check(
      'Move item only up relocates the line, leaving its child behind',
      docText(view) === ['A:', '\t- item', '\t- prev', '\t\t- child', '\t- next'].join('\n'),
      JSON.stringify(docText(view)),
    );
    check('the cursor follows the moved line', view.state.doc.lineAt(sel(view)[0]).number === 2);

    commands.moveOnlyDown(fakeView); // below prev's branch (which now holds child)
    check(
      'Move item only down skips over the whole next-sibling branch',
      docText(view) === ['A:', '\t- prev', '\t\t- child', '\t- item', '\t- next'].join('\n'),
      JSON.stringify(docText(view)),
    );

    commands.moveOnlyDown(fakeView);
    check(
      'Move item only down again lands after the last sibling',
      docText(view) === ['A:', '\t- prev', '\t\t- child', '\t- next', '\t- item'].join('\n'),
      JSON.stringify(docText(view)),
    );

    const atEnd = docText(view);
    commands.moveOnlyDown(fakeView);
    check('moving the last sibling down is a no-op', docText(view) === atEnd);
    cleanup();
  }
  {
    const doc = ['A:', '\t- prev', '\t- item', '\t\t- child', '\t- next'].join('\n');
    const { view, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    view.dispatch({ selection: { anchor: lineFrom(view, 3) + 3 } });

    commands.indentOnly(fakeView);
    check(
      'Move item only right indents just the item line',
      docText(view) === ['A:', '\t- prev', '\t\t- item', '\t\t- child', '\t- next'].join('\n'),
      JSON.stringify(docText(view)),
    );

    commands.outdentOnly(fakeView);
    commands.outdentOnly(fakeView);
    check(
      'Move item only left outdents just the item line',
      docText(view) === ['A:', '\t- prev', '- item', '\t\t- child', '\t- next'].join('\n'),
      JSON.stringify(docText(view)),
    );

    view.dispatch({ selection: { anchor: 0 } }); // on "A:", already at the margin
    const before = docText(view);
    commands.outdentOnly(fakeView);
    check('outdenting at the margin is a no-op', docText(view) === before);
    cleanup();
  }

  // --- Toggle done: the command spawns @repeat successors in one transaction ---
  {
    const stamp = todayStamp(false); // DEFAULT_SETTINGS.doneIncludesTime is false
    const doc = [
      'Home:',
      '\t- water plants @due(2026-07-01) @repeat(1w)',
      '\t\t- refill the can',
      '\t- no anchor @repeat(1w)',
    ].join('\n');
    const { view, host, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    view.dispatch({ selection: { anchor: lineFrom(view, 2) } });

    const changesBefore = host.docChanges.length;
    commands.toggleDone(fakeView);
    check(
      'toggle-done command stamps @done through the shared plan',
      view.state.doc.line(2).text === `\t- water plants @due(2026-07-01) @repeat(1w) @done(${stamp})`,
      view.state.doc.line(2).text,
    );
    check(
      'toggle-done command spawns the successor after the subtree',
      view.state.doc.line(4).text === '\t- water plants @due(2026-07-08) @repeat(1w)',
      view.state.doc.line(4).text,
    );
    check(
      'the command path applies done + spawn as ONE transaction',
      host.docChanges.length === changesBefore + 1,
      String(host.docChanges.length - changesBefore),
    );

    // No date anchor: the task completes, nothing spawns, a Notice warns.
    view.dispatch({ selection: { anchor: lineFrom(view, 5) } });
    commands.toggleDone(fakeView);
    check(
      'toggle-done on a no-anchor @repeat task still completes it',
      view.state.doc.line(5).text === `\t- no anchor @repeat(1w) @done(${stamp})`,
      view.state.doc.line(5).text,
    );
    check('no successor spawns without a date anchor', view.state.doc.lines === 5);
    check(
      'the no-anchor warning shows as a Notice',
      Notice.messages.includes('@repeat 需要 @due 或 @start 日期才能產生下一次'),
    );
    cleanup();
  }

  // --- Toggle done: multi-select plans every line against one snapshot ---
  {
    const stamp = todayStamp(false);
    const doc = [
      '- a @due(2026-07-01) @repeat(1w)',
      '- b @due(2026-07-02) @repeat(1d)',
      '- c plain',
    ].join('\n');
    const { view, host, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    view.dispatch({ selection: { anchor: 0, head: lineTo(view, 3) } });

    const changesBefore = host.docChanges.length;
    commands.toggleDone(fakeView);
    check(
      'multi-select toggle completes every selected line',
      view.state.doc.line(1).text === `- a @due(2026-07-01) @repeat(1w) @done(${stamp})` &&
        view.state.doc.line(3).text === `- b @due(2026-07-02) @repeat(1d) @done(${stamp})` &&
        view.state.doc.line(5).text === `- c plain @done(${stamp})`,
      docText(view),
    );
    check(
      'multi-select toggle spawns each successor in place',
      view.state.doc.line(2).text === '- a @due(2026-07-08) @repeat(1w)' &&
        view.state.doc.line(4).text === '- b @due(2026-07-03) @repeat(1d)',
      docText(view),
    );
    check(
      'the whole multi-select toggle is ONE transaction',
      host.docChanges.length === changesBefore + 1 && view.state.doc.lines === 5,
      String(host.docChanges.length - changesBefore),
    );
    cleanup();
  }

  // --- Tag with…: the multi-select modal applies all staged toggles at once ---
  {
    const doc = ['Inbox:', '\t- alpha', '\t- beta @flag'].join('\n');
    const { view, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    // Select both task lines.
    view.dispatch({ selection: { anchor: lineFrom(view, 2), head: lineTo(view, 3) } });

    commands.toggleTag(fakeView);
    const row = (name: string) =>
      document.querySelector<HTMLElement>(`.tp-tag-multi-row[data-tag="${name}"]`);
    check('the modal lists the document tags', row('flag') !== null);
    check('the modal lists the default tags too', row('today') !== null && row('due') !== null);

    clickEl(row('flag')!);
    check('clicking a row stages it without closing', row('flag')!.className.includes('is-staged'));
    clickEl(row('today')!);
    clickEl(row('due')!);
    clickEl(row('due')!); // toggle off again — must NOT be applied
    check('clicking a staged row un-stages it', !row('due')!.className.includes('is-staged'));

    // Plain typing still works: a custom @name(value) staged via Enter.
    const input = document.querySelector<HTMLInputElement>('.tp-tag-multi-input')!;
    input.value = '@prio(1)';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    check('Enter stages the typed custom tag', row('prio')?.className.includes('is-staged') === true);
    check('the input clears after staging', input.value === '');

    document.querySelector<HTMLButtonElement>('.modal-button-container .mod-cta')!.click();
    check('the modal closes on apply', document.querySelector('.tp-tag-multi-list') === null);
    check(
      'all staged toggles apply to every selected line at once',
      view.state.doc.line(2).text === '\t- alpha @flag @today @prio(1)',
      view.state.doc.line(2).text,
    );
    check(
      'a line that already had a staged tag loses it (toggle semantics)',
      view.state.doc.line(3).text === '\t- beta @today @prio(1)',
      view.state.doc.line(3).text,
    );

    // Mod-Enter: stages whatever is typed, then applies everything.
    view.dispatch({ selection: { anchor: lineFrom(view, 2) } });
    commands.toggleTag(fakeView);
    const input2 = document.querySelector<HTMLInputElement>('.tp-tag-multi-input')!;
    input2.value = 'urgent';
    input2.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    check('the Mod-Enter confirm closes the modal', document.querySelector('.tp-tag-multi-list') === null);
    check(
      'Mod-Enter applies the typed tag in one step',
      view.state.doc.line(2).text === '\t- alpha @flag @today @prio(1) @urgent',
      view.state.doc.line(2).text,
    );
    cleanup();
  }
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
