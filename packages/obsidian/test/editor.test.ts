/**
 * Headless tests for the Obsidian editor behaviors that don't need a DOM:
 *  - the CodeMirror filter StateField (query + focus hiding, edit-mapping)
 *  - the sidebar render-guard signature (the two-click fix)
 *  - the pure logic behind the editor interactions (tag click, links,
 *    autocomplete, backspace un-indent, handle drag)
 *
 * CodeMirror state is pure, so we drive it with EditorState alone (no EditorView).
 */
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { buildOutline } from '@taskpaper/core';
import { filterExtension, filterDecoField, setFilterEffect } from '../src/editor/filter';
import { toggledTagFilter } from '../src/editor/tagClick';
import { findLinks, linkHref } from '../src/editor/links';
import { collectTagNames, tagCompletionSource } from '../src/editor/tagComplete';
import { backspaceUnindentDeletion } from '../src/editor/keymap';
import { handleLines, planHandleDrag } from '../src/editor/handles';
import { parseTagList, settingsSignature, sidebarSignature, visibleTagCounts } from '../src/sidebarLogic';

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

// Inbox(1) / -a @today(2) / -b(3) / Work(4) / -c(5)
const DOC = ['Inbox:', '\t- a @today', '\t- b', 'Work:', '\t- c'].join('\n');

function hiddenLines(state: EditorState): Set<number> {
  const hidden = new Set<number>();
  const deco = state.field(filterDecoField);
  deco.between(0, state.doc.length, (from, to) => {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(Math.max(from, to - 1)).number;
    for (let n = first; n <= last; n++) {
      hidden.add(n);
    }
  });
  return hidden;
}

function withFilter(spec: Parameters<typeof setFilterEffect.of>[0]): EditorState {
  const base = EditorState.create({ doc: DOC, extensions: [filterExtension] });
  return base.update({ effects: setFilterEffect.of(spec) }).state;
}

function setEq(a: Set<number>, b: Set<number>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

// --- query filter: @today keeps the match + its ancestor (Inbox), hides the rest ---
{
  const s = withFilter({ mode: 'query', query: '@today', hide: true });
  check('query @today hides lines 3,4,5', setEq(hiddenLines(s), new Set([3, 4, 5])), [...hiddenLines(s)].join(','));
}

// --- focus filter: only Inbox's subtree (lines 1-3) visible; 4,5 hidden ---
{
  const s = withFilter({ mode: 'focus', visible: new Set([0, 1, 2]), hide: true });
  check('focus Inbox hides Work (4,5)', setEq(hiddenLines(s), new Set([4, 5])), [...hiddenLines(s)].join(','));
}

// --- clearing the filter shows everything ---
{
  const s = withFilter(null);
  check('clear filter hides nothing', hiddenLines(s).size === 0, [...hiddenLines(s)].join(','));
}

// --- dim mode adds line decorations, not block-replaces (nothing "hidden" as a range run) ---
{
  const s = withFilter({ mode: 'query', query: '@today', hide: false });
  const deco = s.field(filterDecoField);
  let count = 0;
  deco.between(0, s.doc.length, () => {
    count++;
  });
  check('dim mode decorates non-matching lines', count === 3, `count=${count}`);
}

// --- focus survives an edit inside the visible region (decorations mapped, still hiding) ---
{
  const s = withFilter({ mode: 'focus', visible: new Set([0, 1, 2]), hide: true });
  const edited = s.update({ changes: { from: s.doc.line(2).to, insert: '!' } }).state;
  check('focus still hides after edit', hiddenLines(edited).size > 0, String(hiddenLines(edited).size));
}

// --- render-guard signature (two-click fix) ---
const SK = settingsSignature({
  globalSearches: [{ name: 'Today', query: '@today' }],
  includeTags: '',
  excludeTags: 'search',
});
check('signature stable for same inputs', sidebarSignature('a.taskpaper', 100, 3, SK) === sidebarSignature('a.taskpaper', 100, 3, SK));
check('signature changes when focus changes', sidebarSignature('a.taskpaper', 100, 3, SK) !== sidebarSignature('a.taskpaper', 100, null, SK));
check('signature changes when doc length changes', sidebarSignature('a.taskpaper', 100, 3, SK) !== sidebarSignature('a.taskpaper', 101, 3, SK));
check('signature changes when file changes', sidebarSignature('a.taskpaper', 100, 3, SK) !== sidebarSignature('b.taskpaper', 100, 3, SK));

// --- render-guard signature: settings component ---
{
  const other = settingsSignature({
    globalSearches: [{ name: 'Today', query: '@today union @due' }],
    includeTags: '',
    excludeTags: 'search',
  });
  check('signature changes when settings change', sidebarSignature('a.taskpaper', 100, 3, SK) !== sidebarSignature('a.taskpaper', 100, 3, other));
  check('settingsSignature stable for equal settings', SK === settingsSignature({ globalSearches: [{ name: 'Today', query: '@today' }], includeTags: '', excludeTags: 'search' }));
  check('settingsSignature changes with includeTags', SK !== settingsSignature({ globalSearches: [{ name: 'Today', query: '@today' }], includeTags: 'due', excludeTags: 'search' }));
  check('settingsSignature changes with excludeTags', SK !== settingsSignature({ globalSearches: [{ name: 'Today', query: '@today' }], includeTags: '', excludeTags: '' }));
  check('empty view signature ignores settings', sidebarSignature(null, 0, null, SK) === sidebarSignature(null, 0, null, other));
}

// --- tag list parsing (settings -> clean names) ---
{
  const eq = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  check('parseTagList splits spaces and commas, strips @', eq(parseTagList('@due @start, today'), ['due', 'start', 'today']));
  check('parseTagList handles empty string', parseTagList('').length === 0);
  check('parseTagList handles blank-ish input', parseTagList(' , ,, ').length === 0);
  check('parseTagList de-duplicates', eq(parseTagList('@done done, @done'), ['done']));
}

// --- tag include/exclude merging ---
{
  const found = new Map([['done', 5], ['today', 2], ['search', 1]]);
  const shown = visibleTagCounts(found, [], ['search']);
  check('excluded tags never shown', !shown.some(([n]) => n === 'search'));
  check('other found tags kept', shown.length === 2 && shown[0][0] === 'done' && shown[0][1] === 5);

  const withInclude = visibleTagCounts(found, ['due', 'today'], ['search']);
  const due = withInclude.find(([n]) => n === 'due');
  check('included tag shown with count 0', due !== undefined && due[1] === 0);
  check('included tag found in doc keeps its count', withInclude.find(([n]) => n === 'today')?.[1] === 2);
  check('exclude wins over include', visibleTagCounts(found, ['search'], ['search']).length === 2);
  check('sorted by count desc then name', withInclude.map(([n]) => n).join(',') === 'done,today,due');
}

// --- tag click: toggling the filter ---
{
  const set = toggledTagFilter(null, 'today', true);
  check(
    'tag click sets a query filter',
    set !== null && set.mode === 'query' && set.query === '@today' && set.hide === true,
  );
  check('clicking the active tag clears the filter', toggledTagFilter(set, 'today', true) === null);
  const other = toggledTagFilter(set, 'due', false);
  check(
    'clicking a different tag replaces the filter',
    other !== null && other.mode === 'query' && other.query === '@due' && other.hide === false,
  );
  check(
    'tag click replaces a focus filter instead of clearing',
    toggledTagFilter({ mode: 'focus', visible: new Set([0]), hide: true }, 'today', true)?.mode ===
      'query',
  );
}

// --- tag click filter applied to the document behaves like any query filter ---
{
  const s = withFilter(toggledTagFilter(null, 'today', true));
  check('tag click filter hides non-matching lines', setEq(hiddenLines(s), new Set([3, 4, 5])));
}

// --- links: detection ---
{
  const links = findLinks('- read https://example.com/a(1).');
  check(
    'url detected, trailing dot trimmed, balanced paren kept',
    links.length === 1 && links[0].kind === 'url' && links[0].text === 'https://example.com/a(1)',
  );
}
{
  const links = findLinks('- see www.example.com, then mail bob@example.com');
  check(
    'www + email detected with punctuation trimmed',
    links.length === 2 &&
      links[0].kind === 'www' &&
      links[0].text === 'www.example.com' &&
      links[1].kind === 'email' &&
      links[1].text === 'bob@example.com',
  );
}
{
  const links = findLinks('- specs in file:///tmp/spec.pdf and ~/notes/plan.md and /var/log/x.log');
  check(
    'file url + home path + absolute path detected',
    links.length === 3 &&
      links[0].kind === 'file' &&
      links[1].kind === 'path' &&
      links[1].text === '~/notes/plan.md' &&
      links[2].kind === 'path' &&
      links[2].text === '/var/log/x.log',
  );
}
{
  check('no link inside and/or or 4/5 @done', findLinks('- rate 4/5 and/or more @done').length === 0);
  check('a bare @tag is not an email', findLinks('- task @due(2026-01-01)').length === 0);
}

// --- links: hrefs ---
check('www opens as https', linkHref({ kind: 'www', text: 'www.a.com' }) === 'https://www.a.com');
check('email opens as mailto', linkHref({ kind: 'email', text: 'a@b.com' }) === 'mailto:a@b.com');
check('path opens as file url', linkHref({ kind: 'path', text: '/tmp/x' }) === 'file:///tmp/x');
check('url opens as-is', linkHref({ kind: 'url', text: 'https://a.com' }) === 'https://a.com');

// --- tag autocomplete ---
{
  const names = collectTagNames(buildOutline(['Inbox:', '\t- a @waiting(bob)'], 4));
  check(
    'completion names = document tags + defaults',
    names.includes('waiting') && names.includes('done') && names.includes('today'),
  );
  check('completion names are sorted + deduped', names.indexOf('done') < names.indexOf('waiting'));
}
{
  const doc = '- call bob @wai';
  const state = EditorState.create({ doc });
  const result = tagCompletionSource(new CompletionContext(state, doc.length, false));
  check(
    'typing @wai offers completions from @',
    result !== null && result.from === doc.indexOf('@') && result.options.some((o) => o.label === '@today'),
  );
  const none = tagCompletionSource(new CompletionContext(EditorState.create({ doc: '- plain' }), 7, false));
  check('no completions without an @ token', none === null);
  // @ inside an email/URL is not a tag-token boundary — no popup.
  const emailDoc = '- mail user@exa';
  const email = tagCompletionSource(new CompletionContext(EditorState.create({ doc: emailDoc }), emailDoc.length, false));
  check('no completions inside an email address', email === null);
  const solStart = tagCompletionSource(new CompletionContext(EditorState.create({ doc: '@to' }), 3, false));
  check('completions at start of line still fire', solStart !== null);
}

// --- backspace un-indents at the start of an item's text ---
{
  check(
    'backspace after tab indent removes the tab',
    JSON.stringify(backspaceUnindentDeletion('\t\t- task', 2, 4)) === JSON.stringify({ from: 1, to: 2 }),
  );
  check(
    'backspace after indent + marker removes one level',
    JSON.stringify(backspaceUnindentDeletion('\t- task', 3, 4)) === JSON.stringify({ from: 0, to: 1 }),
  );
  check(
    'backspace with space indent removes up to tabSize spaces',
    JSON.stringify(backspaceUnindentDeletion('      x', 6, 4)) === JSON.stringify({ from: 2, to: 6 }),
  );
  check('backspace mid-text falls through', backspaceUnindentDeletion('\t- task', 5, 4) === null);
  check('backspace at column 0 falls through', backspaceUnindentDeletion('\t- task', 0, 4) === null);
  check('backspace with no indent falls through', backspaceUnindentDeletion('- task', 2, 4) === null);
}

// --- item handles: which lines get one ---
{
  const outline = buildOutline(['A:', '\t- a1', '\t- a2', 'B:', '\t- b1', 'C:'], 4);
  check('handles on items with children only', handleLines(outline).join(',') === '0,3');
}

// --- item handles: drag plan ---
const DRAG_DOC = ['A:', '\t- a1', '\t- a2', 'B:', '\t- b1', 'C:'];
{
  const plan = planHandleDrag(DRAG_DOC, 0, 4, 4); // drag A down over B
  check(
    'dragging A over B moves the whole branch below B',
    plan !== null &&
      plan.lines.join('|') === 'B:|\t- b1|A:|\t- a1|\t- a2|C:' &&
      plan.indicatorLine === 5 &&
      plan.cursorLine === 2,
  );
}
{
  const plan = planHandleDrag(DRAG_DOC, 3, 0, 4); // drag B up over A
  check(
    'dragging B over A moves it above A',
    plan !== null && plan.lines.join('|') === 'B:|\t- b1|A:|\t- a1|\t- a2|C:' && plan.cursorLine === 0,
  );
}
{
  const plan = planHandleDrag(DRAG_DOC, 1, 2, 4); // drag a1 below its single-line sibling a2
  check(
    'single-line sibling accepts a downward drop',
    plan !== null && plan.lines.join('|') === 'A:|\t- a2|\t- a1|B:|\t- b1|C:',
  );
}
check('dropping on itself is a no-op', planHandleDrag(DRAG_DOC, 0, 1, 4) === null);
check(
  'hover clamps to the siblings region (a1 cannot leave A)',
  planHandleDrag(DRAG_DOC, 2, 5, 4) === null,
);
check('an only child cannot move', planHandleDrag(DRAG_DOC, 4, 0, 4) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
