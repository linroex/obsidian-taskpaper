/**
 * E2E tests for the Obsidian editor: a REAL EditorView mounted under jsdom
 * with the exact production extension stack (createEditorExtensions), driven
 * by real DOM events (MouseEvent/KeyboardEvent), asserting on the resulting
 * document text, decorations, and host callbacks.
 *
 * jsdom limits (each noted at the affected test):
 *  - No layout, so anything that needs posAtCoords (drag-moving a handle to
 *    a *different* line, clicking plain text to place the cursor) cannot
 *    resolve a position — those paths are covered headlessly via their pure
 *    planners (planFreeDrag) in editor.test.ts. Here we cover the closest
 *    DOM-event-driven path: the click (mousedown+mouseup, no move) gesture.
 *  - No contenteditable input pipeline (beforeinput + MutationObserver), so
 *    type() sends real keydowns and falls back to a dispatch for plain
 *    characters — the keymap path stays fully real.
 */
import {
  clickEl,
  docText,
  findMark,
  hiddenLineNumbers,
  mountEditor,
  press,
  type,
} from './e2eHarness';
import { foldedRanges } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { advanceDate, todayStamp } from '@taskpaper/core';
import { App, Menu, Notice, setIcon, TFile } from 'obsidian';
import * as Obsidian from 'obsidian';
import { filterSpecField, setFilterEffect } from '../src/editor/filter';
import { refreshLinks } from '../src/editor/links';
import { outlineKeyBindings } from '../src/editor/setup';
import {
  DEFAULT_SETTINGS,
  localizedDefaultSearches,
  TaskPaperSettingTab,
} from '../src/settings';

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

function foldCount(view: EditorView): number {
  let n = 0;
  foldedRanges(view.state).between(0, view.state.doc.length, () => {
    n++;
  });
  return n;
}

function activeQuery(view: EditorView): string | null {
  const spec = view.state.field(filterSpecField, false) ?? null;
  return spec && spec.mode === 'query' ? spec.query : null;
}

// --- settings follow Obsidian's language, with English fallback ---
{
  const setLanguage = (Obsidian as unknown as {
    __setLanguageForTests(language: string): void;
  }).__setLanguageForTests;
  const renderSettings = (language: string): TaskPaperSettingTab => {
    setLanguage(language);
    const plugin = {
      settings: {
        ...DEFAULT_SETTINGS,
        sidebarCollapsed: [],
        globalSearches: localizedDefaultSearches(language),
      },
      saveSettings: async () => {},
      applyBodyClasses: () => {},
      refreshSidebar: () => {},
    };
    const tab = new TaskPaperSettingTab(new App(), plugin as never);
    tab.display();
    return tab;
  };

  const chineseTab = renderSettings('zh-TW');
  const chineseText = chineseTab.containerEl.textContent ?? '';
  for (const title of [
    '@done 加上完成時間',
    '封存專案名稱',
    '已完成項目加上刪除線',
    '篩選時隱藏不符合的行',
    '行事曆：顯示週數',
    '快速新增：收件匣檔案',
    '全域搜尋',
    '側邊欄標籤',
  ]) {
    check(`settings title is localized to Chinese: ${title}`, chineseText.includes(title));
  }
  check(
    'English settings copy is absent in Chinese',
    !/Stamp @done|Archive project name|Strike through done|Filter hides|Searches section|vault root/i.test(chineseText),
  );
  const inputValues = Array.from(
    chineseTab.containerEl.querySelectorAll<HTMLInputElement>('input'),
  ).map((input) => input.value);
  check(
    'new-vault global-search names are localized to Chinese',
    inputValues.includes('今日') && inputValues.includes('未完成'),
  );
  check(
    'the zh locale also selects Chinese',
    (renderSettings('zh').containerEl.textContent ?? '').includes('@done 加上完成時間'),
  );

  const englishText = renderSettings('en').containerEl.textContent ?? '';
  check(
    'English settings render when Obsidian uses English',
    englishText.includes('Stamp @done with time') &&
      englishText.includes('Archive project name') &&
      englishText.includes('Global searches') &&
      englishText.includes('Sidebar tags'),
  );
  check(
    'unsupported Obsidian languages fall back to English',
    (renderSettings('fr').containerEl.textContent ?? '').includes('Stamp @done with time'),
  );
  setLanguage('en');
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

function renderedLines(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-line'));
}

// --- clicking a task's leading dash toggles @done in the document ---
{
  const { view, host, cleanup } = mountEditor(DOC);
  const dashes = findMark(view, 'tp-task-dash');
  check('a dash mark renders per task', dashes.length === 4, String(dashes.length));

  clickEl(dashes[0]); // the dash of "- alpha"
  check(
    'dash click stamps @done on that line (dropping @today, by design)',
    view.state.doc.line(2).text === '\t- alpha @done(2026-01-02)',
    view.state.doc.line(2).text,
  );
  check('other lines untouched', view.state.doc.line(3).text === '\t- beta @waiting(bob)');
  check(
    'doc change reached the host (updateListener wired)',
    host.docChanges.length === 1 && host.docChanges[0] === docText(view),
  );

  clickEl(findMark(view, 'tp-task-dash')[0]); // DOM was rebuilt — re-query
  check(
    'clicking again removes @done',
    view.state.doc.line(2).text === '\t- alpha',
    view.state.doc.line(2).text,
  );
  cleanup();
}

// --- a completed task visually owns every nested task and note ---
{
  const { view, cleanup } = mountEditor([
    '- parent',
    '\t- child @due(2020-01-01)',
    '\t\tchild note',
    '\t\t- grandchild',
    '- sibling',
    '\tsibling note',
  ].join('\n'));

  check('unfinished subtree initially has no done styling', findMark(view, 'tp-done').length === 0);
  check(
    'unfinished child due date is initially overdue',
    findMark(view, 'tp-tag-overdue').length === 2,
  );

  clickEl(findMark(view, 'tp-task-dash')[0]);
  let lines = renderedLines(view);
  check(
    'completing a task styles the parent, nested tasks, and note',
    lines.slice(0, 4).every((line) => line.classList.contains('tp-done')),
  );
  check(
    'completion styling stops at the next sibling branch',
    lines.slice(4).every((line) => !line.classList.contains('tp-done')),
  );
  check(
    'an inherited-done note retains its note styling',
    lines[2].classList.contains('tp-note') && lines[2].classList.contains('tp-done'),
  );
  check('dates inside a completed subtree are not marked overdue', findMark(view, 'tp-tag-overdue').length === 0);

  view.dispatch({
    effects: setFilterEffect.of({ mode: 'query', query: '@done', hide: true }),
  });
  check(
    'done styling survives a filter that displays the completed task subtree',
    findMark(view, 'tp-done').length === 4 && setEq(hiddenLineNumbers(view), new Set([5, 6])),
  );

  view.dispatch({ effects: setFilterEffect.of(null) });
  clickEl(findMark(view, 'tp-handle')[0]);
  check(
    'folding a completed task leaves its visible parent styled done',
    findMark(view, 'tp-done').length === 1 && foldCount(view) === 1,
  );
  clickEl(findMark(view, 'tp-handle')[0]);
  check(
    'unfolding restores done styling on the whole subtree',
    findMark(view, 'tp-done').length === 4 && foldCount(view) === 0,
  );

  clickEl(findMark(view, 'tp-task-dash')[0]);
  lines = renderedLines(view);
  check(
    'uncompleting the parent clears inherited styling and restores overdue state',
    lines.every((line) => !line.classList.contains('tp-done')) &&
      findMark(view, 'tp-tag-overdue').length === 2,
  );
  cleanup();
}

// --- clicking a @tag mark filters; clicking again clears ---
{
  const { view, host, cleanup } = mountEditor(DOC);
  const tag = view.dom.querySelector<HTMLElement>('.tp-tag[data-tag="today"]');
  check('the @today mark renders', tag !== null);

  clickEl(tag!);
  check('tag click filters to the match + ancestors', setEq(hiddenLineNumbers(view), new Set([3, 4, 5, 6])), [...hiddenLineNumbers(view)].join(','));
  check('the active filter is the tag query', activeQuery(view) === '@today', String(activeQuery(view)));
  check('tag click clears the focused line', host.focusLines.length === 1 && host.focusLines[0] === null);
  check('tag click refreshes the sidebar', host.refreshes === 1);
  check('the filter effect synced the searchbar', host.searchbarUpdates === 1);

  clickEl(view.dom.querySelector<HTMLElement>('.tp-tag[data-tag="today"]')!);
  check('clicking the same tag again clears the filter', hiddenLineNumbers(view).size === 0, [...hiddenLineNumbers(view)].join(','));
  check('no filter is active after the second click', activeQuery(view) === null);
  cleanup();
}

// --- clicking a tag VALUE mark filters by tag + value ---
// (Production builds `@tag = value` — toggledTagFilter quotes multi-word
// values; the exact literal forms are covered headlessly in editor.test.ts.)
{
  const { view, cleanup } = mountEditor(DOC);
  const value = view.dom.querySelector<HTMLElement>('.tp-tag-value[data-tag-value="bob"]');
  check('the (bob) value mark renders', value !== null);

  clickEl(value!);
  check('value click filters by tag + value', activeQuery(view) === '@waiting contains[l] "bob"', String(activeQuery(view)));
  check(
    'only the matching branch stays visible',
    setEq(hiddenLineNumbers(view), new Set([2, 4, 5, 6])),
    [...hiddenLineNumbers(view)].join(','),
  );

  clickEl(view.dom.querySelector<HTMLElement>('.tp-tag-value[data-tag-value="bob"]')!);
  check('clicking the same value again clears the filter', activeQuery(view) === null);
  cleanup();
}

// --- clicking a handle dot folds the subtree; clicking again unfolds ---
// (A real drag-move needs posAtCoords/layout, impossible under jsdom; the
// drag planner is covered headlessly. The click gesture — mousedown, then
// mouseup bubbling to window with no movement — is the real production path.)
{
  const { view, cleanup } = mountEditor(DOC);
  const handles = findMark(view, 'tp-handle');
  // EVERY item now carries a drag handle (leaves reveal theirs on hover);
  // parents keep the always-visible dot, leaves get tp-handle-leaf.
  check('every item renders a handle', handles.length === 6, String(handles.length));
  check(
    'leaf handles carry the hover-only class, parents do not',
    handles[0].classList.contains('tp-handle-leaf') === false &&
      handles[1].classList.contains('tp-handle-leaf') === true,
  );
  check('handle knows its line', handles[0].getAttribute('data-line') === '0');

  clickEl(handles[0]); // Inbox's handle
  check('handle click folds the subtree', foldCount(view) === 1, String(foldCount(view)));

  clickEl(findMark(view, 'tp-handle')[0]);
  check('clicking again unfolds', foldCount(view) === 0, String(foldCount(view)));
  cleanup();
}

// --- Alt-clicking a project's handle focuses it ---
{
  const { view, host, cleanup } = mountEditor(DOC);
  clickEl(findMark(view, 'tp-handle')[0], { altKey: true });
  check(
    'alt-click on a project handle focuses its subtree',
    setEq(hiddenLineNumbers(view), new Set([4, 5, 6])),
    [...hiddenLineNumbers(view)].join(','),
  );
  check('the focused line reached the host', host.focusLines.length === 1 && host.focusLines[0] === 0);
  cleanup();
}

// --- Escape keydown clears an active filter ---
{
  const { view, host, cleanup } = mountEditor(DOC);
  check('escape with no filter falls through', !press(view, 'Escape'));

  clickEl(view.dom.querySelector<HTMLElement>('.tp-tag[data-tag="today"]')!);
  check('filter active before escape', hiddenLineNumbers(view).size > 0);

  check('escape keydown is handled', press(view, 'Escape'));
  check('escape cleared the filter', hiddenLineNumbers(view).size === 0 && activeQuery(view) === null);
  check('escape cleared the focused line', host.focusLines[host.focusLines.length - 1] === null);
  check('escape refreshed the sidebar', host.refreshes === 2);
  cleanup();
}

// --- Backspace at marker start: deletes '- ' first, then unindents ---
{
  const { view, cleanup } = mountEditor('Inbox:\n\t- task one');
  const line2 = view.state.doc.line(2);
  view.dispatch({ selection: { anchor: line2.from + 3 } }); // right after "\t- "

  press(view, 'Backspace');
  check('backspace stage 1 deletes the task marker', view.state.doc.line(2).text === '\ttask one', view.state.doc.line(2).text);

  press(view, 'Backspace');
  check('backspace stage 2 removes one indent level', view.state.doc.line(2).text === 'task one', view.state.doc.line(2).text);

  press(view, 'Backspace');
  check('backspace at the margin joins lines (default binding)', docText(view) === 'Inbox:task one', docText(view));
  cleanup();
}

// --- Enter on a task line continues with '- '; Alt-Enter does not ---
{
  const { view, cleanup } = mountEditor('\t- alpha');
  view.dispatch({ selection: { anchor: view.state.doc.length } });

  press(view, 'Enter');
  check('enter continues the task list', docText(view) === '\t- alpha\n\t- ', JSON.stringify(docText(view)));
  check('cursor sits after the new marker', view.state.selection.main.head === view.state.doc.length);

  type(view, 'beta');
  check('typing lands on the new task', docText(view) === '\t- alpha\n\t- beta', JSON.stringify(docText(view)));

  press(view, 'Enter', { alt: true });
  check(
    'alt-enter inserts a plain newline (indent kept, no marker)',
    docText(view) === '\t- alpha\n\t- beta\n\t',
    JSON.stringify(docText(view)),
  );

  // Enter on an emptied task ends the list (marker cleared).
  cleanup();
}

// --- Enter can create and edit a task while a query filter is active ---
{
  const { view, cleanup } = mountEditor('Inbox:\n\t- alpha @today\n\t- hidden');
  view.dispatch({
    effects: setFilterEffect.of({ mode: 'query', query: '@today', hide: true }),
    selection: { anchor: view.state.doc.line(2).to },
  });

  press(view, 'Enter');
  check(
    'filtered Enter creates a task on the next line',
    view.state.doc.line(3).text === '\t- ',
    JSON.stringify(docText(view)),
  );
  check(
    'new filtered task stays visible while the cursor is on it',
    !hiddenLineNumbers(view).has(3),
    [...hiddenLineNumbers(view)].join(','),
  );

  type(view, 'beta');
  check(
    'typing into the new filtered task keeps it visible',
    view.state.doc.line(3).text === '\t- beta' && !hiddenLineNumbers(view).has(3),
    JSON.stringify(docText(view)),
  );

  // The user's freshly created task must survive the cursor leaving it —
  // work done under a filter stays on screen for the whole filter session.
  view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
  check(
    'an unfinished non-match stays visible after the cursor leaves',
    !hiddenLineNumbers(view).has(3),
    [...hiddenLineNumbers(view)].join(','),
  );

  // Re-applying the filter starts a fresh session: unmatched leftovers hide.
  view.dispatch({
    effects: setFilterEffect.of({ mode: 'query', query: '@today', hide: true }),
  });
  check(
    'a re-applied filter hides the unmatched leftover',
    hiddenLineNumbers(view).has(3),
    [...hiddenLineNumbers(view)].join(','),
  );
  cleanup();
}

// --- Enter at the end of a NOTE stays visible while a query filter is active ---
{
  const { view, cleanup } = mountEditor(
    ['Inbox:', '\t- alpha @today', '\t\tnote of alpha', '\t- hidden'].join('\n'),
  );
  view.dispatch({
    effects: setFilterEffect.of({ mode: 'query', query: '@today', hide: true }),
    selection: { anchor: view.state.doc.line(3).to },
  });

  press(view, 'Enter');
  check(
    'filtered Enter on a note keeps the note indent on the new line',
    view.state.doc.line(4).text === '\t\t',
    JSON.stringify(docText(view)),
  );
  check(
    'cursor sits on the new note line, not swallowed by the filter',
    view.state.doc.lineAt(view.state.selection.main.head).number === 4 &&
      !hiddenLineNumbers(view).has(4),
    [...hiddenLineNumbers(view)].join(','),
  );

  type(view, 'second line');
  check(
    'typing continues the note under the active filter',
    view.state.doc.line(4).text === '\t\tsecond line' && !hiddenLineNumbers(view).has(4),
    JSON.stringify(docText(view)),
  );

  // The continuation is an attached note of the matching task, so it stays
  // visible even after the cursor leaves it.
  view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
  check(
    'the note continuation stays visible after the cursor leaves',
    !hiddenLineNumbers(view).has(4),
    [...hiddenLineNumbers(view)].join(','),
  );
  cleanup();
}

// --- Enter mid-note splits it without the tail disappearing under the filter ---
{
  const { view, cleanup } = mountEditor(
    ['Inbox:', '\t- alpha @today', '\t\tfirst second'].join('\n'),
  );
  const noteLine = view.state.doc.line(3);
  view.dispatch({
    effects: setFilterEffect.of({ mode: 'query', query: '@today', hide: true }),
    selection: { anchor: noteLine.from + '\t\tfirst'.length },
  });

  press(view, 'Enter');
  check(
    'filtered mid-note Enter splits the note keeping the indent',
    docText(view) === ['Inbox:', '\t- alpha @today', '\t\tfirst', '\t\t second'].join('\n'),
    JSON.stringify(docText(view)),
  );
  check(
    'both note halves stay visible under the filter',
    !hiddenLineNumbers(view).has(3) && !hiddenLineNumbers(view).has(4),
    [...hiddenLineNumbers(view)].join(','),
  );
  cleanup();
}

// --- without a filter, Enter on a note still uses the default newline ---
{
  const { view, cleanup } = mountEditor('\t- alpha\n\t\tnote');
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  press(view, 'Enter');
  check(
    'unfiltered Enter on a note keeps default behavior',
    docText(view) === '\t- alpha\n\t\tnote\n\t\t',
    JSON.stringify(docText(view)),
  );
  cleanup();
}

// --- Enter also creates a visible task inside a project-focus filter ---
{
  const { view, cleanup } = mountEditor(
    ['Inbox:', '\t- alpha', 'Work:', '\t- hidden'].join('\n'),
  );
  view.dispatch({
    effects: setFilterEffect.of({ mode: 'focus', visible: new Set([0, 1]), hide: true }),
    selection: { anchor: view.state.doc.line(2).to },
  });

  press(view, 'Enter');
  check(
    'focus-filter Enter creates a new task in the visible project',
    view.state.doc.line(3).text === '\t- ' && !hiddenLineNumbers(view).has(3),
    JSON.stringify(docText(view)),
  );
  check(
    'focus-filter insertion keeps the outside project hidden',
    hiddenLineNumbers(view).has(4) && hiddenLineNumbers(view).has(5),
    [...hiddenLineNumbers(view)].join(','),
  );
  cleanup();
}

// --- Enter at the end of a task with children appends a direct sub-task ---
{
  const { view, cleanup } = mountEditor(
    ['Inbox:', '\t- parent @today', '\t\t- existing child', '\t- sibling'].join('\n'),
  );
  view.dispatch({
    effects: setFilterEffect.of({ mode: 'query', query: '@today', hide: true }),
    selection: { anchor: view.state.doc.line(2).to },
  });

  press(view, 'Enter');
  check(
    'enter on a parent appends after its existing subtree',
    docText(view) ===
      ['Inbox:', '\t- parent @today', '\t\t- existing child', '\t\t- ', '\t- sibling'].join('\n'),
    JSON.stringify(docText(view)),
  );
  check(
    'the appended task uses the direct-child indentation',
    view.state.doc.line(4).text === '\t\t- ',
    JSON.stringify(view.state.doc.line(4).text),
  );
  check(
    'the appended sub-task remains visible in the active filter',
    !hiddenLineNumbers(view).has(4),
    [...hiddenLineNumbers(view)].join(','),
  );
  check(
    'cursor lands after the appended sub-task marker',
    view.state.selection.main.head === view.state.doc.line(4).to,
  );
  type(view, 'new child');
  check(
    'the appended sub-task remains editable under the active filter',
    view.state.doc.line(4).text === '\t\t- new child' && !hiddenLineNumbers(view).has(4),
    JSON.stringify(view.state.doc.line(4).text),
  );
  view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
  check(
    'sub-task stays visible after the temporary reveal ends because its parent matches',
    !hiddenLineNumbers(view).has(4),
    [...hiddenLineNumbers(view)].join(','),
  );
  cleanup();
}

// --- appended sub-task is only temporary when the parent is context, not a match ---
{
  const { view, cleanup } = mountEditor(
    ['Inbox:', '\t- parent', '\t\t- matching child @today', '\t- outside'].join('\n'),
  );
  view.dispatch({
    effects: setFilterEffect.of({ mode: 'query', query: '@today', hide: true }),
    selection: { anchor: view.state.doc.line(2).to },
  });

  press(view, 'Enter');
  check(
    'new child of a context-only parent is visible while editing',
    view.state.doc.line(4).text === '\t\t- ' && !hiddenLineNumbers(view).has(4),
    [...hiddenLineNumbers(view)].join(','),
  );

  view.dispatch({ selection: { anchor: view.state.doc.line(3).to } });
  check(
    'non-matching child stays visible after leaving it (sticky reveal)',
    !hiddenLineNumbers(view).has(4),
    [...hiddenLineNumbers(view)].join(','),
  );
  cleanup();
}

// --- append after nested descendants, before separators, preserving spaces ---
{
  const { view, cleanup } = mountEditor(
    ['- parent', '  - child', '    - grandchild', '', '- sibling'].join('\n'),
  );
  view.dispatch({ selection: { anchor: view.state.doc.line(1).to } });

  press(view, 'Enter');
  check(
    'parent Enter appends after every nested descendant and before the blank separator',
    docText(view) ===
      ['- parent', '  - child', '    - grandchild', '  - ', '', '- sibling'].join('\n'),
    JSON.stringify(docText(view)),
  );
  check(
    'new child preserves the existing space indentation',
    view.state.doc.line(4).text === '  - ' &&
      view.state.selection.main.head === view.state.doc.line(4).to,
    JSON.stringify(view.state.doc.line(4).text),
  );
  cleanup();
}
{
  const { view, cleanup } = mountEditor('- alpha\n- ');
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  press(view, 'Enter');
  check('enter on an empty task ends the list', docText(view) === '- alpha\n', JSON.stringify(docText(view)));
  cleanup();
}

// --- Enter/Alt-Enter non-happy branches: selections and non-task lines ---
{
  // A non-empty selection on a task line falls PAST the continue-task binding
  // to the default newline: the selection is replaced, no '- ' marker added.
  const { view, cleanup } = mountEditor('\t- alpha beta');
  view.dispatch({ selection: { anchor: 3, head: 8 } }); // "alpha" selected
  press(view, 'Enter');
  check(
    'enter with a selection replaces it without a new marker',
    docText(view) === '\t- \n\tbeta',
    JSON.stringify(docText(view)),
  );
  check('cursor lands after the kept indent', view.state.selection.main.head === 5);
  cleanup();
}
{
  // Enter at the end of a project line is a plain newline — no continuation.
  const { view, cleanup } = mountEditor('Work:\n\t- a');
  view.dispatch({ selection: { anchor: 5 } }); // end of "Work:"
  press(view, 'Enter');
  check(
    'enter on a project line inserts a plain newline',
    docText(view) === 'Work:\n\n\t- a',
    JSON.stringify(docText(view)),
  );
  cleanup();
}
{
  // On an INDENTED project line the new line keeps the indentation.
  const { view, cleanup } = mountEditor('A:\n\tSub:\n\t- x');
  view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
  press(view, 'Enter');
  check(
    'enter on an indented project keeps the indent, adds no marker',
    docText(view) === 'A:\n\tSub:\n\t\n\t- x',
    JSON.stringify(docText(view)),
  );
  cleanup();
}
{
  // Alt-Enter with a selection replaces it with newline + current indent.
  const { view, cleanup } = mountEditor('\t- alpha beta');
  view.dispatch({ selection: { anchor: 3, head: 9 } }); // "alpha " selected
  press(view, 'Enter', { alt: true });
  check(
    'alt-enter with a selection replaces it with newline + indent',
    docText(view) === '\t- \n\tbeta',
    JSON.stringify(docText(view)),
  );
  check('alt-enter cursor sits after the inserted indent', view.state.selection.main.head === 5);
  cleanup();
}

// --- platform-aware shortcuts move + indent the WHOLE branch ---
{
  const bindings = new Map(outlineKeyBindings.map((binding) => [binding.key, binding.mac]));
  check(
    'Windows/Linux move shortcuts avoid Alt+Arrow',
    bindings.get('Mod-Shift-ArrowUp') === 'Alt-ArrowUp' &&
      bindings.get('Mod-Shift-ArrowDown') === 'Alt-ArrowDown',
  );
  check(
    'Windows/Linux indent shortcuts avoid Alt+Arrow while Mac keeps Option',
    bindings.get('Mod-Shift-ArrowRight') === 'Alt-Shift-ArrowRight' &&
      bindings.get('Mod-Shift-ArrowLeft') === 'Alt-Shift-ArrowLeft',
  );
}
{
  const doc = ['A:', '\t- a1', '\t\t- a2', '\t- a3'].join('\n');
  const { view, cleanup } = mountEditor(doc);
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 3 } }); // on a1

  check('ctrl-shift-down is handled on Windows/Linux', press(view, 'ArrowDown', { ctrl: true, shift: true }));
  check(
    'ctrl-shift-down moves a1 AND its child below a3',
    docText(view) === ['A:', '\t- a3', '\t- a1', '\t\t- a2'].join('\n'),
    JSON.stringify(docText(view)),
  );
  check(
    'the cursor follows the moved branch',
    view.state.doc.lineAt(view.state.selection.main.head).number === 3,
    String(view.state.doc.lineAt(view.state.selection.main.head).number),
  );

  press(view, 'ArrowUp', { ctrl: true, shift: true });
  check('ctrl-shift-up moves the branch back', docText(view) === doc, JSON.stringify(docText(view)));

  // Edge no-ops: at the document's very top and bottom nothing changes.
  view.dispatch({ selection: { anchor: 0 } }); // on A: (first root, first line)
  press(view, 'ArrowUp', { ctrl: true, shift: true });
  check('ctrl-shift-up at the top is a no-op', docText(view) === doc, JSON.stringify(docText(view)));
  view.dispatch({ selection: { anchor: view.state.doc.line(4).from } }); // a3: last sibling, last line
  press(view, 'ArrowDown', { ctrl: true, shift: true });
  check('ctrl-shift-down at the bottom is a no-op', docText(view) === doc, JSON.stringify(docText(view)));

  // With no sibling in that direction (A: is the only root) the key is
  // consumed as a no-op — falling through to defaultKeymap's moveLineDown
  // would move the single LINE and tear the project away from its subtree.
  view.dispatch({ selection: { anchor: 0 } });
  press(view, 'ArrowDown', { ctrl: true, shift: true });
  check(
    'ctrl-shift-down with no next sibling is a no-op, never a single-line move',
    docText(view) === doc,
    JSON.stringify(docText(view)),
  );
  cleanup();
}
{
  // Ctrl-Shift-Right indents the whole branch; Ctrl-Shift-Left undoes it.
  const doc = ['A:', '\t- a1', '\t\t- a2', '\t- a3'].join('\n');
  const { view, cleanup } = mountEditor(doc);
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 3 } }); // on a1
  check('ctrl-shift-right is handled', press(view, 'ArrowRight', { ctrl: true, shift: true }));
  check(
    'ctrl-shift-right indents a1 and its child one level',
    docText(view) === ['A:', '\t\t- a1', '\t\t\t- a2', '\t- a3'].join('\n'),
    JSON.stringify(docText(view)),
  );
  press(view, 'ArrowLeft', { ctrl: true, shift: true });
  check('ctrl-shift-left outdents the branch back', docText(view) === doc, JSON.stringify(docText(view)));

  // Outdenting a line already at the margin never touches the document
  // (the key falls through to a selection command, not an edit).
  view.dispatch({ selection: { anchor: 0 } });
  press(view, 'ArrowLeft', { ctrl: true, shift: true });
  check('ctrl-shift-left at the margin leaves the document alone', docText(view) === doc, JSON.stringify(docText(view)));
  cleanup();
}

// --- clicking a link opens it through the host ---
{
  const { view, host, cleanup } = mountEditor('- read https://example.com/spec');
  const link = findMark(view, 'tp-link');
  check('the link mark renders', link.length === 1 && link[0].getAttribute('data-href') === 'https://example.com/spec');

  clickEl(link[0]);
  check(
    'link click opens through the host',
    host.openedLinks.length === 1 &&
      host.openedLinks[0].href === 'https://example.com/spec' &&
      host.openedLinks[0].kind === 'url',
    JSON.stringify(host.openedLinks),
  );
  cleanup();
}

// --- wikilinks: live preview, resolved/unresolved classes, click routing ---
{
  // Resolution + opening wired through the obsidian stub, the way view.ts
  // wires the production host (metadataCache / workspace.openLinkText).
  const app = new App();
  app.metadataCache.files.set('Note', new TFile('Note.md', 'Note', 'md'));
  const { view, host, cleanup } = mountEditor('- read [[Note]] and [[Missing]]', {
    resolveWikilink: (linkpath) =>
      app.metadataCache.getFirstLinkpathDest(linkpath, 'test.taskpaper') !== null,
    openWikilink: (linktext) => void app.workspace.openLinkText(linktext, 'test.taskpaper'),
  });

  const marks = findMark(view, 'tp-wikilink');
  check('both wikilinks render marks', marks.length === 2, String(marks.length));
  check(
    'the resolved link carries data-href, no unresolved class',
    marks[0].getAttribute('data-href') === 'Note' && !marks[0].classList.contains('tp-link-unresolved'),
  );
  check(
    'the unresolved link is classed and carries no href',
    marks[1].classList.contains('tp-link-unresolved') && marks[1].getAttribute('data-href') === null,
  );
  check(
    'brackets are hidden while the cursor is outside',
    view.contentDOM.textContent === '- read Note and Missing',
    JSON.stringify(view.contentDOM.textContent),
  );

  clickEl(marks[0]);
  check(
    'clicking the resolved link records openLinkText in the stub',
    app.workspace.openedLinkTexts.length === 1 &&
      app.workspace.openedLinkTexts[0].linktext === 'Note' &&
      app.workspace.openedLinkTexts[0].sourcePath === 'test.taskpaper',
    JSON.stringify(app.workspace.openedLinkTexts),
  );

  clickEl(findMark(view, 'tp-link-unresolved')[0]);
  check(
    'clicking the unresolved link is a no-op',
    app.workspace.openedLinkTexts.length === 1 && host.openedLinks.length === 0,
  );

  view.dispatch({ selection: { anchor: 9 } }); // inside [[Note]]
  check(
    'the raw syntax shows while the cursor is inside',
    view.contentDOM.textContent === '- read [[Note]] and Missing',
    JSON.stringify(view.contentDOM.textContent),
  );
  cleanup();
}

// --- wikilink alias display; coexists with md links and tags; embeds skipped ---
{
  const { view, cleanup } = mountEditor('- [[Note|別名]] [md](https://a.io) @due(2100-01-01)', {
    resolveWikilink: () => true,
  });
  const wiki = findMark(view, 'tp-wikilink');
  check('an aliased wikilink shows only the alias', wiki.length === 1 && wiki[0].textContent === '別名', wiki[0]?.textContent ?? '');
  check('the adjacent markdown link still renders', findMark(view, 'tp-link').some((el) => el.textContent === 'md'));
  check('the adjacent tag still renders', findMark(view, 'tp-tag').some((el) => el.getAttribute('data-tag') === 'due'));
  cleanup();
}
{
  const { view, cleanup } = mountEditor('- ![[Note]]', { resolveWikilink: () => true });
  check(
    'an embed is untouched (no mark, raw text)',
    findMark(view, 'tp-wikilink').length === 0 && (view.contentDOM.textContent ?? '').includes('![[Note]]'),
    JSON.stringify(view.contentDOM.textContent),
  );
  cleanup();
}

// --- wikilink resolution updates when the vault's link index changes ---
{
  const app = new App();
  const { view, cleanup } = mountEditor('- read [[Later]]', {
    resolveWikilink: (linkpath) =>
      app.metadataCache.getFirstLinkpathDest(linkpath, 'test.taskpaper') !== null,
  });
  check('the note is unresolved at first', findMark(view, 'tp-link-unresolved').length === 1);

  // The note gets created: view.ts listens for metadataCache 'resolved' and
  // dispatches refreshLinks — simulate that exact wiring.
  app.metadataCache.files.set('Later', new TFile('Later.md', 'Later', 'md'));
  app.metadataCache.on('resolved', () => view.dispatch({ effects: refreshLinks.of(null) }));
  app.metadataCache.trigger('resolved');
  check(
    'the link re-resolves after the metadata refresh effect',
    findMark(view, 'tp-link-unresolved').length === 0 &&
      findMark(view, 'tp-wikilink')[0]?.getAttribute('data-href') === 'Later',
  );
  cleanup();
}

// --- Mod-S (Ctrl on non-mac jsdom) saves immediately ---
{
  const { view, host, cleanup } = mountEditor(DOC);
  check('ctrl-s is handled', press(view, 's', { ctrl: true }));
  check('ctrl-s saved through the host', host.saves === 1);
  cleanup();
}

// --- dash click on a @repeat task: done + successor in ONE transaction ---
{
  const doc = [
    'Home:',
    '\t- water plants @due(2026-07-01) @repeat(1w)',
    '\t\t- refill the can',
    '\t- other',
  ].join('\n');
  const { view, host, cleanup } = mountEditor(doc);

  clickEl(findMark(view, 'tp-task-dash')[0]); // the dash of "- water plants"
  check(
    'repeat: dash click stamps @done on the line',
    view.state.doc.line(2).text === '\t- water plants @due(2026-07-01) @repeat(1w) @done(2026-01-02)',
    view.state.doc.line(2).text,
  );
  check(
    'repeat: successor spawns AFTER the whole subtree, date advanced',
    view.state.doc.line(4).text === '\t- water plants @due(2026-07-08) @repeat(1w)',
    view.state.doc.line(4).text,
  );
  check('repeat: children stay with the completed instance', view.state.doc.line(3).text === '\t\t- refill the can');
  check(
    'repeat: done + spawn arrive as ONE transaction',
    host.docChanges.length === 1 && view.state.doc.lines === 5,
    String(host.docChanges.length),
  );

  check('repeat: one Cmd-Z is handled', press(view, 'z', { ctrl: true }));
  check('repeat: a single undo reverts BOTH the stamp and the spawn', docText(view) === doc, JSON.stringify(docText(view)));

  // Un-done then re-done must not duplicate the successor (dedupe guard).
  clickEl(findMark(view, 'tp-task-dash')[0]); // done again -> spawn
  clickEl(findMark(view, 'tp-task-dash')[0]); // un-done (successor stays)
  check(
    'repeat: toggling done OFF keeps the successor and removes @done',
    view.state.doc.line(2).text === '\t- water plants @due(2026-07-01) @repeat(1w)' &&
      view.state.doc.line(4).text === '\t- water plants @due(2026-07-08) @repeat(1w)',
    view.state.doc.line(2).text,
  );
  clickEl(findMark(view, 'tp-task-dash')[0]); // re-done -> dedupe, no second spawn
  check(
    'repeat: re-done does not duplicate the successor',
    view.state.doc.lines === 5 &&
      view.state.doc.line(4).text === '\t- water plants @due(2026-07-08) @repeat(1w)' &&
      view.state.doc.line(5).text === '\t- other',
    docText(view),
  );
  check('repeat: no warning notices along the way', host.notices.length === 0, host.notices.join(' | '));
  cleanup();
}

// --- dash click with @repeat but no date anchor: done, no spawn, a Notice ---
{
  const { view, host, cleanup } = mountEditor('- solo @repeat(1w)');
  clickEl(findMark(view, 'tp-task-dash')[0]);
  check(
    'repeat: a no-anchor task still completes',
    view.state.doc.line(1).text === '- solo @repeat(1w) @done(2026-01-02)',
    view.state.doc.line(1).text,
  );
  check('repeat: no successor without a date anchor', view.state.doc.lines === 1);
  check(
    'repeat: the no-anchor warning reaches the host notify (a Notice in production)',
    host.notices.length === 1 &&
      host.notices[0] === '@repeat 需要 @at、@due 或 @start 日期才能產生下一次',
    host.notices.join(' | '),
  );
  cleanup();
}

// --- dash click on a bare-@today @repeat task: @due(today + interval) ---
{
  const { view, cleanup } = mountEditor('- t @today @repeat(3d)');
  clickEl(findMark(view, 'tp-task-dash')[0]);
  const expectedDue = advanceDate(todayStamp(false), 3, 'd');
  check(
    'repeat: completing drops @today as usual',
    view.state.doc.line(1).text === '- t @repeat(3d) @done(2026-01-02)',
    view.state.doc.line(1).text,
  );
  check(
    'repeat: bare @today converts to @due(today + interval) on the successor',
    view.state.doc.line(2).text === `- t @repeat(3d) @due(${expectedDue})`,
    view.state.doc.line(2).text,
  );
  cleanup();
}

// --- the 'obsidian' stub: module alias + DOM prototype helpers work ---
{
  const el = document.body.createDiv({ cls: 'tp-probe' });
  check('HTMLElement.createDiv helper installed', el.parentElement === document.body && el.className === 'tp-probe');
  el.setText('x');
  el.addClass('a', 'b');
  el.removeClass('b');
  check('setText/addClass/removeClass helpers work', el.textContent === 'x' && el.className === 'tp-probe a');
  el.empty();
  check('empty() helper works', el.childNodes.length === 0);
  el.detach();

  setIcon(el, 'search');
  check('setIcon stub marks the element', el.getAttribute('data-icon') === 'search');

  const menu = new Menu();
  let clicked = false;
  menu.addItem((i) => i.setTitle('Do it').setIcon('plus').onClick(() => (clicked = true)));
  menu.showAtMouseEvent(new MouseEvent('contextmenu'));
  menu.items[0].callback?.();
  check('Menu stub records items and callbacks fire', menu.items.length === 1 && menu.items[0].title === 'Do it' && clicked);

  new Notice('hello');
  check('Notice stub records messages', Notice.messages.includes('hello'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
