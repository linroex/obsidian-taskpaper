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
import { filterSpecField } from '../src/editor/filter';
import { refreshLinks } from '../src/editor/links';

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

// Inbox(1) / -alpha @today(2) / -beta @waiting(bob)(3) / Work(4) / -gamma(5) / -delta(6)
const DOC = [
  'Inbox:',
  '\t- alpha @today',
  '\t- beta @waiting(bob)',
  'Work:',
  '\t- gamma',
  '\t- delta @waiting(ann)',
].join('\n');

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
{
  const { view, cleanup } = mountEditor('- alpha\n- ');
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  press(view, 'Enter');
  check('enter on an empty task ends the list', docText(view) === '- alpha\n', JSON.stringify(docText(view)));
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
    host.notices.length === 1 && host.notices[0] === '@repeat 需要 @due 或 @start 日期才能產生下一次',
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
