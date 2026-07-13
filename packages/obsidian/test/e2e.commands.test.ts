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
import { clickEl, docText, findMark, hiddenLineNumbers, mountEditor, press } from './e2eHarness';
import { foldedRanges } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { todayStamp } from '@taskpaper/core';
import { App, Notice } from 'obsidian';
import { TaskPaperCommands } from '../src/commands';
import { setFilterEffect } from '../src/editor/filter';
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
function commandsFor(
  view: EditorView,
  settingsOverrides: Partial<typeof DEFAULT_SETTINGS> = {},
): { commands: TaskPaperCommands; fakeView: TaskPaperView } {
  const plugin = {
    app: new App(),
    settings: { ...DEFAULT_SETTINGS, globalSearches: [], ...settingsOverrides },
    refreshSidebar() {},
  } as unknown as TaskPaperPlugin;
  const fakeView = { editor: view, focusedLine: null, sidebarSelection: [] } as unknown as TaskPaperView;
  return { commands: new TaskPaperCommands(plugin), fakeView };
}

/** Re-stub the async clipboard API with a capturing writeText. */
function stubClipboard(): string[] {
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
  return captured;
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

  // --- Format As: note -> project preserves indent and moves trailing tags after ':' ---
  {
    const doc = ['Work:', '\tsome note', '\tfoo @flag'].join('\n');
    const { view, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    view.dispatch({ selection: { anchor: lineFrom(view, 2), head: lineTo(view, 3) } });

    commands.formatAs(fakeView, 'project');
    check(
      'format-as-project turns a plain note into a project line',
      view.state.doc.line(2).text === '\tsome note:',
      view.state.doc.line(2).text,
    );
    check(
      "format-as-project inserts the ':' BEFORE the trailing tags",
      view.state.doc.line(3).text === '\tfoo: @flag',
      view.state.doc.line(3).text,
    );
    check('the unselected line is untouched', view.state.doc.line(1).text === 'Work:');

    commands.formatAs(fakeView, 'note');
    check(
      "converting back to a note drops the ':' and keeps the tags",
      view.state.doc.line(2).text === '\tsome note' && view.state.doc.line(3).text === '\tfoo @flag',
      docText(view),
    );
    cleanup();
  }

  // --- Copy Displayed: dim filter copies the FULL doc; focus-hide copies the branch ---
  {
    const captured = stubClipboard();
    const { view, cleanup } = mountEditor(DOC);
    const { commands, fakeView } = commandsFor(view);

    // A dim filter (hide:false) keeps every line on screen — full copy.
    view.dispatch({ effects: setFilterEffect.of({ mode: 'query', query: '@today', hide: false }) });
    check('a dim filter dims the non-matching lines', findMark(view, 'tp-dim').length === 4, String(findMark(view, 'tp-dim').length));
    commands.copyDisplayed(fakeView);
    await tick();
    check('a dim-only filter still copies the whole document', captured[0] === DOC, JSON.stringify(captured[0]));

    // Focus mode with hide semantics: only the focused branch is copied.
    view.dispatch({
      effects: setFilterEffect.of(null),
      selection: { anchor: lineFrom(view, 5) + 3 }, // inside "- gamma"
    });
    commands.focus(fakeView);
    check('focus records the project line on the view', fakeView.focusedLine === 3);
    commands.copyDisplayed(fakeView);
    await tick();
    check(
      'under focus-hide only the visible branch is copied',
      captured[1] === 'Work:\n\t- gamma\n\t- delta @waiting(ann)',
      JSON.stringify(captured[1]),
    );
    cleanup();
  }

  // --- toggle-done: disjoint multi-cursor toggles each line once, one undo ---
  {
    const stamp = todayStamp(false);
    const doc = ['- a', '- skip', '- b'].join('\n');
    const { view, host, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    // Two cursors on line 1 (same line — must dedupe) plus one on line 3.
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(lineFrom(view, 1)),
        EditorSelection.cursor(lineTo(view, 1)),
        EditorSelection.cursor(lineFrom(view, 3)),
      ]),
    });

    const changesBefore = host.docChanges.length;
    commands.toggleDone(fakeView);
    check(
      'disjoint cursors toggle both lines, each exactly once',
      view.state.doc.line(1).text === `- a @done(${stamp})` &&
        view.state.doc.line(3).text === `- b @done(${stamp})`,
      docText(view),
    );
    check('the untouched middle line stays untouched', view.state.doc.line(2).text === '- skip');
    check(
      'the multi-cursor toggle is ONE transaction',
      host.docChanges.length === changesBefore + 1,
      String(host.docChanges.length - changesBefore),
    );
    press(view, 'z', { ctrl: true });
    check('a single undo reverts every toggled line', docText(view) === doc, JSON.stringify(docText(view)));
    cleanup();
  }

  // --- toggle-done on a blank-only selection dispatches nothing ---
  {
    const { view, host, cleanup } = mountEditor('- a\n\n- b');
    const { commands, fakeView } = commandsFor(view);
    view.dispatch({ selection: { anchor: lineFrom(view, 2) } }); // on the blank line

    const changesBefore = host.docChanges.length;
    commands.toggleDone(fakeView);
    check('toggle-done on a blank line dispatches nothing', host.docChanges.length === changesBefore);
    check('the document is unchanged', docText(view) === '- a\n\n- b');
    cleanup();
  }

  // --- new-task / new-project / new-note insert after the cursor line at its indent ---
  {
    const doc = ['Work:', '\t- a', '\t- b'].join('\n');
    {
      const { view, cleanup } = mountEditor(doc);
      const { commands, fakeView } = commandsFor(view);
      view.dispatch({ selection: { anchor: lineFrom(view, 2) + 3 } }); // inside "- a"
      commands.newTask(fakeView);
      check(
        'new-task inserts a "- " line after the cursor line at the same indent',
        docText(view) === ['Work:', '\t- a', '\t- ', '\t- b'].join('\n'),
        JSON.stringify(docText(view)),
      );
      check(
        'new-task parks the cursor after the dash',
        sel(view)[0] === lineTo(view, 3) && sel(view)[0] === sel(view)[1],
        sel(view).join('..'),
      );
      cleanup();
    }
    {
      const { view, cleanup } = mountEditor(doc);
      const { commands, fakeView } = commandsFor(view);
      view.dispatch({ selection: { anchor: lineFrom(view, 2) + 3 } });
      commands.newProject(fakeView);
      check(
        'new-project inserts a bare ":" line at the same indent',
        docText(view) === ['Work:', '\t- a', '\t:', '\t- b'].join('\n'),
        JSON.stringify(docText(view)),
      );
      check(
        "new-project parks the cursor BEFORE the ':' for naming",
        sel(view)[0] === lineTo(view, 3) - 1 && sel(view)[0] === sel(view)[1],
        sel(view).join('..'),
      );
      cleanup();
    }
    {
      const { view, cleanup } = mountEditor(doc);
      const { commands, fakeView } = commandsFor(view);
      view.dispatch({ selection: { anchor: lineFrom(view, 2) + 3 } });
      commands.newNote(fakeView);
      check(
        'new-note inserts a child note line one level deeper',
        docText(view) === ['Work:', '\t- a', '\t\t', '\t- b'].join('\n'),
        JSON.stringify(docText(view)),
      );
      check(
        'new-note parks the cursor at the end of the indent',
        sel(view)[0] === lineTo(view, 3) && sel(view)[0] === sel(view)[1],
        sel(view).join('..'),
      );
      cleanup();
    }
  }

  // --- delete-items / duplicate over a disjoint selection = single undo units ---
  {
    const doc = ['A:', '\t- a1', '\t\t- a2', 'B:', '\t- b1', '\t- b2'].join('\n');
    {
      const { view, host, cleanup } = mountEditor(doc);
      const { commands, fakeView } = commandsFor(view);
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(lineFrom(view, 2) + 2), // on "- a1"
          EditorSelection.cursor(lineFrom(view, 5) + 2), // on "- b1"
        ]),
      });
      const changesBefore = host.docChanges.length;
      commands.deleteItems(fakeView);
      check(
        'delete-items removes both branches, preserving the gap between them',
        docText(view) === ['A:', 'B:', '\t- b2'].join('\n'),
        JSON.stringify(docText(view)),
      );
      check('the disjoint delete is ONE transaction', host.docChanges.length === changesBefore + 1);
      press(view, 'z', { ctrl: true });
      check('a single undo restores both deleted branches', docText(view) === doc, JSON.stringify(docText(view)));
      cleanup();
    }
    {
      const { view, host, cleanup } = mountEditor(doc);
      const { commands, fakeView } = commandsFor(view);
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(lineFrom(view, 2) + 2),
          EditorSelection.cursor(lineFrom(view, 5) + 2),
        ]),
      });
      const changesBefore = host.docChanges.length;
      commands.duplicate(fakeView);
      check(
        'duplicate copies each selected branch after itself (bottom-up)',
        docText(view) ===
          ['A:', '\t- a1', '\t\t- a2', '\t- a1', '\t\t- a2', 'B:', '\t- b1', '\t- b1', '\t- b2'].join('\n'),
        JSON.stringify(docText(view)),
      );
      check('the multi-root duplicate is ONE transaction', host.docChanges.length === changesBefore + 1);
      press(view, 'z', { ctrl: true });
      check('a single undo removes both duplicates', docText(view) === doc, JSON.stringify(docText(view)));
      cleanup();
    }
  }

  // --- stale-doc guard: Tag with… refuses to apply after the doc changed ---
  {
    const doc = ['Inbox:', '\t- alpha'].join('\n');
    const { view, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    view.dispatch({ selection: { anchor: lineFrom(view, 2) } });

    commands.toggleTag(fakeView);
    clickEl(document.querySelector<HTMLElement>('.tp-tag-multi-row[data-tag="today"]')!);
    // The document drifts while the modal is open (sync, another pane, …).
    view.dispatch({ changes: { from: 0, insert: 'X' } });
    const notices = Notice.messages.length;
    document.querySelector<HTMLButtonElement>('.modal-button-container .mod-cta')!.click();
    check(
      'the stale-doc guard shows the localized notice',
      Notice.messages.slice(notices).includes('文件已變更，標籤未套用——請重新執行。'),
      Notice.messages.slice(notices).join(' / '),
    );
    check(
      'no tag is applied to the drifted document',
      docText(view) === 'XInbox:\n\t- alpha',
      JSON.stringify(docText(view)),
    );
    cleanup();
  }

  // --- move-to-project: only project inside the selection -> nothing to move to ---
  {
    const { view, cleanup } = mountEditor('A:\n\t- x');
    const { commands, fakeView } = commandsFor(view);
    view.dispatch({ selection: { anchor: 0 } }); // on "A:" — the only project
    const notices = Notice.messages.length;
    commands.moveToProject(fakeView);
    check(
      'move-to-project with no target project outside the selection notices',
      Notice.messages.slice(notices).includes('No projects in this document.'),
      Notice.messages.slice(notices).join(' / '),
    );
    check('no modal opens and the document is untouched', docText(view) === 'A:\n\t- x');
    cleanup();
  }

  // --- repeat + archive interplay: the done original archives, the successor stays ---
  {
    const stamp = todayStamp(false);
    const doc = ['Home:', '\t- x @due(2026-07-01) @repeat(1w)'].join('\n');
    const { view, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    view.dispatch({ selection: { anchor: lineFrom(view, 2) } });

    commands.toggleDone(fakeView); // stamps @done + spawns the successor
    commands.archiveDone(fakeView);
    check(
      'archive-done moves ONLY the completed original into the new Archive',
      docText(view) ===
        [
          'Home:',
          '\t- x @due(2026-07-08) @repeat(1w)',
          '',
          'Archive:',
          `\t- x @due(2026-07-01) @repeat(1w) @done(${stamp}) @project(Home)`,
        ].join('\n'),
      JSON.stringify(docText(view)),
    );
    cleanup();
  }

  // --- archive-done settings matrix ---
  {
    // (a) defaults: items land at the TOP of the existing Archive, tagged @project(path).
    const doc = [
      'Work:',
      '\t- ship @done(2026-01-05)',
      '\t\t- child note',
      '\t- keep',
      'Archive:',
      '\t- old @done(2025-12-01)',
    ].join('\n');
    const { view, host, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    const changesBefore = host.docChanges.length;
    commands.archiveDone(fakeView);
    check(
      'archived branch lands at the TOP of Archive with @project(path)',
      docText(view) ===
        [
          'Work:',
          '\t- keep',
          'Archive:',
          '\t- ship @done(2026-01-05) @project(Work)',
          '\t\t- child note',
          '\t- old @done(2025-12-01)',
        ].join('\n'),
      JSON.stringify(docText(view)),
    );
    check('the archive mutation is ONE transaction', host.docChanges.length === changesBefore + 1);
    press(view, 'z', { ctrl: true });
    check('a single undo restores the pre-archive document', docText(view) === doc, JSON.stringify(docText(view)));
    cleanup();
  }
  {
    // (b) removeExtraTagsWhenArchiving strips everything but @done/@project.
    const doc = ['Work:', '\t- x @flag @done(2026-01-05) @today', 'Archive:'].join('\n');
    const { view, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view, { removeExtraTagsWhenArchiving: true });
    commands.archiveDone(fakeView);
    check(
      'removeExtraTagsWhenArchiving keeps only @done and @project',
      docText(view) === ['Work:', 'Archive:', '\t- x @done(2026-01-05) @project(Work)'].join('\n'),
      JSON.stringify(docText(view)),
    );
    cleanup();
  }
  {
    // (c) custom archiveProjectName + addProjectTagWhenArchiving off.
    const doc = ['Done:', '\t- old', 'Work:', '\t- x @done(2026-01-05)'].join('\n');
    const { view, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view, {
      archiveProjectName: 'Done',
      addProjectTagWhenArchiving: false,
    });
    commands.archiveDone(fakeView);
    check(
      'a custom archive name is honored and no @project tag is added',
      docText(view) === ['Done:', '\t- x @done(2026-01-05)', '\t- old', 'Work:'].join('\n'),
      JSON.stringify(docText(view)),
    );
    cleanup();
  }
  {
    // (d) no Archive project: it is created at the document end, blank-separated.
    const doc = ['Work:', '\t- a @done(2026-01-01)', '\t- b'].join('\n');
    const { view, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    commands.archiveDone(fakeView);
    check(
      'without an Archive project one is appended at the end',
      docText(view) === ['Work:', '\t- b', '', 'Archive:', '\t- a @done(2026-01-01) @project(Work)'].join('\n'),
      JSON.stringify(docText(view)),
    );
    cleanup();
  }
  {
    // (e) an all-done document hits the whole-doc-replace guard without corruption.
    const doc = ['- a @done(2026-01-01)', '- b @done(2026-01-02)'].join('\n');
    const { view, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    commands.archiveDone(fakeView);
    check(
      'archiving an all-done document replaces it wholesale, uncorrupted',
      docText(view) === ['Archive:', '\t- a @done(2026-01-01)', '\t- b @done(2026-01-02)'].join('\n'),
      JSON.stringify(docText(view)),
    );
    press(view, 'z', { ctrl: true });
    check('one undo restores the all-done document', docText(view) === doc, JSON.stringify(docText(view)));
    cleanup();
  }
  {
    // (f) nothing to archive: a Notice, no dispatch.
    const { view, host, cleanup } = mountEditor('Work:\n\t- open');
    const { commands, fakeView } = commandsFor(view);
    const changesBefore = host.docChanges.length;
    const notices = Notice.messages.length;
    commands.archiveDone(fakeView);
    check(
      'no @done items -> the empty-state notice',
      Notice.messages.slice(notices).includes('No @done items to archive.'),
      Notice.messages.slice(notices).join(' / '),
    );
    check('nothing is dispatched', host.docChanges.length === changesBefore && docText(view) === 'Work:\n\t- open');
    cleanup();
  }

  // --- smoke batch: toggle-today / remove-tags / fold-all / save-search ---
  {
    const { view, cleanup } = mountEditor('- a\n- b @today');
    const { commands, fakeView } = commandsFor(view);
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    commands.toggleToday(fakeView);
    check(
      'toggle-today toggles PER LINE: adds where missing, removes where present',
      docText(view) === '- a @today\n- b',
      JSON.stringify(docText(view)),
    );
    commands.toggleToday(fakeView);
    check('toggling again restores the original lines', docText(view) === '- a\n- b @today');
    cleanup();
  }
  {
    const { view, cleanup } = mountEditor('\t- x @due(2026-01-01) @flag(v) @done(2026-01-02)');
    const { commands, fakeView } = commandsFor(view);
    view.dispatch({ selection: { anchor: 2 } });
    commands.removeTags(fakeView);
    check(
      'remove-tags strips every tag and preserves the indent',
      docText(view) === '\t- x',
      JSON.stringify(docText(view)),
    );
    cleanup();
  }
  {
    const { view, cleanup } = mountEditor(['A:', '\t- b', '\t\t- c', 'B:', '\t- d'].join('\n'));
    const { commands, fakeView } = commandsFor(view);
    check('no folds initially', foldCount(view) === 0);
    commands.foldAll(fakeView);
    check('fold-all folds every top-level foldable item', foldCount(view) === 2, String(foldCount(view)));
    commands.unfoldAll(fakeView);
    check('unfold-all removes every fold', foldCount(view) === 0, String(foldCount(view)));
    cleanup();
  }
  {
    // save-search: appended under an existing Searches: project…
    const doc = ['Searches:', '\t- old @search(@done)', 'Work:', '\t- a'].join('\n');
    const { view, cleanup } = mountEditor(doc);
    const { commands, fakeView } = commandsFor(view);
    commands.saveSearch(fakeView);
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="text"]'));
    check('the save-search modal offers query + name inputs', inputs.length === 2, String(inputs.length));
    inputs[0].value = '@flag'; // query
    inputs[1].value = 'urgent'; // name
    document.querySelector<HTMLButtonElement>('.modal-button-container .mod-cta')!.click();
    check(
      'save-search appends the entry under the existing Searches: project',
      docText(view) === ['Searches:', '\t- old @search(@done)', '\t- urgent @search(@flag)', 'Work:', '\t- a'].join('\n'),
      JSON.stringify(docText(view)),
    );
    cleanup();
  }
  {
    // …and creates Searches: at the end of the document when absent.
    const { view, cleanup } = mountEditor('Work:\n\t- a');
    const { commands, fakeView } = commandsFor(view);
    commands.saveSearch(fakeView);
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="text"]'));
    inputs[0].value = '@flag';
    inputs[1].value = 'urgent';
    document.querySelector<HTMLButtonElement>('.modal-button-container .mod-cta')!.click();
    check(
      'save-search creates a Searches: project at the document end',
      docText(view) === ['Work:', '\t- a', '', 'Searches:', '\t- urgent @search(@flag)'].join('\n'),
      JSON.stringify(docText(view)),
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
