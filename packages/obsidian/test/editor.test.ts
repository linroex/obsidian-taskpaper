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
import { buildOutline, runQuery } from '@taskpaper/core';
import { filterExtension, filterDecoField, setFilterEffect } from '../src/editor/filter';
import { toggledTagFilter } from '../src/editor/tagClick';
import { findLinks, linkHref } from '../src/editor/links';
import { collectTagNames, tagCompletionSource } from '../src/editor/tagComplete';
import { backspaceUnindentDeletion, escapeClearsFilter } from '../src/editor/keymap';
import { handleLines, planHandleDrag } from '../src/editor/handles';
import { guideDepths, leadingTabs } from '../src/editor/guides';
import {
  linesToCollapseCompletely,
  linesToCollapseDeepestLevel,
  linesToExpandShallowestLevel,
} from '../src/editor/folding';
import {
  composeSelection,
  parseTagList,
  selectionSignature,
  settingsSignature,
  sidebarSignature,
  toggleSelection,
  validateSelection,
  visibleTagCounts,
} from '../src/sidebarLogic';

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

// --- a match brings its attached notes along ---
{
  const doc = [
    'Inbox:',            // 1
    '\t- a @today',      // 2  match
    '\t\tnote of a',     // 3  shown (attached note)
    '\t\t\tnested note', // 4  shown (note under note)
    '\t- b',             // 5  hidden
    '\t\tnote of b',     // 6  hidden (belongs to non-matching b)
  ].join('\n');
  const base = EditorState.create({ doc, extensions: [filterExtension] });
  const s = base.update({ effects: setFilterEffect.of({ mode: 'query', query: '@today', hide: true }) }).state;
  check('match keeps its note chain, not others', setEq(hiddenLines(s), new Set([5, 6])), [...hiddenLines(s)].join(','));
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
check(
  'signature changes when the active query changes',
  sidebarSignature('a.taskpaper', 100, null, SK, '@today') !== sidebarSignature('a.taskpaper', 100, null, SK, null),
);
check(
  'signature stable for same active query',
  sidebarSignature('a.taskpaper', 100, null, SK, '@today') === sidebarSignature('a.taskpaper', 100, null, SK, '@today'),
);
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
  // Alphabetical order, matching the original macOS sidebar.
  check('sorted alphabetically', withInclude.map(([n]) => n).join(',') === 'done,due,today');
}

// --- sidebar multi-select: toggleSelection + composeSelection ---
{
  const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const proj = (line: number, name: string) => ({ kind: 'project' as const, line, name });
  const tag = (query: string) => ({ kind: 'tag' as const, query });
  const search = (query: string) => ({ kind: 'search' as const, query });

  // Plain click replaces; clicking the sole selected row clears.
  check('plain click selects', eqJson(toggleSelection([], tag('@a'), false), [tag('@a')]));
  check('plain click replaces', eqJson(toggleSelection([tag('@a')], tag('@b'), false), [tag('@b')]));
  check('plain click on sole selection clears', toggleSelection([tag('@a')], tag('@a'), false).length === 0);
  // Ctrl/Cmd+click adds and removes.
  check('ctrl-click adds', toggleSelection([tag('@a')], proj(0, 'W'), true).length === 2);
  check('ctrl-click removes', eqJson(toggleSelection([tag('@a'), tag('@b')], tag('@a'), true), [tag('@b')]));
  check('same query, different kind both selectable', toggleSelection([tag('@a')], search('@a'), true).length === 2);

  // Composition: none / single project focus / union within kind / intersect across kinds.
  check('empty selection composes to none', composeSelection([]).type === 'none');
  const single = composeSelection([proj(4, 'Work')]);
  check('single project keeps focus mode', single.type === 'focus' && single.line === 4);
  const twoTags = composeSelection([tag('@a'), tag('@b')]);
  check('two tags union', twoTags.type === 'query' && twoTags.query === '((@a) union (@b))', JSON.stringify(twoTags));
  const mixed = composeSelection([proj(0, 'Work'), tag('@today')]);
  check(
    'project + tag intersect (tag scoped to project)',
    mixed.type === 'query' && mixed.query === '(((@id = 0 and project)//*)) intersect ((@today))',
    JSON.stringify(mixed),
  );
  const three = composeSelection([proj(0, 'A'), proj(5, 'B'), search('not @done')]);
  check(
    'two projects union, search intersects',
    three.type === 'query' &&
      three.query ===
        '(((@id = 0 and project)//*) union ((@id = 5 and project)//*)) intersect ((not @done))',
    JSON.stringify(three),
  );
  // The composed queries actually run: @today inside Work only.
  const selOutline = buildOutline(
    ['Work:', '\t- w1 @today', '\t- w2', 'Home:', '\t- h1 @today'],
    4,
  );
  if (mixed.type === 'query') {
    const hits = [...runQuery(mixed.query, selOutline)];
    check('composed project+tag query hits only Work @today', hits.length === 1 && hits[0].displayText.startsWith('w1'), hits.map((i) => i.displayText).join('|'));
  }
  check('selectionSignature stable', selectionSignature([tag('@a')]) === selectionSignature([tag('@a')]));
  check('selectionSignature differs', selectionSignature([tag('@a')]) !== selectionSignature([]));

  // Exact @id matching: duplicate project names never collide.
  const dupOutline = buildOutline(['Work:', '\t- a @x', 'Work:', '\t- b @x'], 4);
  const dup = composeSelection([proj(2, 'Work'), tag('@x')]);
  if (dup.type === 'query') {
    const dupHits = [...runQuery(dup.query, dupOutline)].map((i) => i.displayText);
    check('duplicate-named projects select exactly by line', dupHits.length === 1 && dupHits[0].startsWith('b'), dupHits.join('|'));
  }

  // Stale project lines are dropped when they no longer resolve to the same project.
  const names = new Map([[0, 'Work'], [3, 'Home']]);
  const nameAt = (line: number) => names.get(line);
  check(
    'validateSelection keeps resolving projects',
    validateSelection([proj(0, 'Work'), tag('@a')], nameAt).length === 2,
  );
  check(
    'validateSelection drops shifted project lines',
    eqJson(validateSelection([proj(1, 'Work'), tag('@a')], nameAt), [tag('@a')]),
  );
  check(
    'validateSelection drops renamed projects',
    eqJson(validateSelection([proj(3, 'Work')], nameAt), []),
  );
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

// --- tag VALUE click: searches tag + value (TaskPaper 3) ---
{
  const set = toggledTagFilter(null, 'waiting', true, 'bob');
  check(
    'value click sets a tag+value query (bare word unquoted)',
    set !== null && set.mode === 'query' && set.query === '@waiting = bob',
  );
  check(
    'clicking the same value again clears the filter',
    toggledTagFilter(set, 'waiting', true, 'bob') === null,
  );
  const other = toggledTagFilter(set, 'waiting', true, 'ann');
  check(
    'clicking a different value replaces the filter',
    other !== null && other.mode === 'query' && other.query === '@waiting = ann',
  );
  check(
    'name click while a value filter is active replaces it',
    toggledTagFilter(set, 'waiting', true)?.query === '@waiting',
  );
  check(
    'value with spaces is quoted',
    toggledTagFilter(null, 'note', true, 'the value')?.query === '@note = "the value"',
  );
  check(
    'value with non-word chars is quoted',
    toggledTagFilter(null, 'due', true, '2026-01-01')?.query === '@due = "2026-01-01"',
  );
  check(
    'quotes and backslashes in the value are escaped',
    toggledTagFilter(null, 'x', true, 'a "b" \\c')?.query === '@x = "a \\"b\\" \\\\c"',
  );
}

// --- tag value filter applied to a document hides the non-matching lines ---
{
  const doc = ['P:', '\t- a @waiting(bob)', '\t- b @waiting(ann)'].join('\n');
  const base = EditorState.create({ doc, extensions: [filterExtension] });
  const spec = toggledTagFilter(null, 'waiting', true, 'bob');
  const s = base.update({ effects: setFilterEffect.of(spec) }).state;
  check('value filter keeps only the matching branch', setEq(hiddenLines(s), new Set([3])), [...hiddenLines(s)].join(','));
}

// --- Escape clears the filter (keymap-level pure decision) ---
{
  check('escape clears an active query filter', escapeClearsFilter(withFilter({ mode: 'query', query: '@today', hide: true })));
  check('escape clears an active focus filter', escapeClearsFilter(withFilter({ mode: 'focus', visible: new Set([0]), hide: true })));
  check('escape falls through with no filter', !escapeClearsFilter(withFilter(null)));
  const cleared = withFilter({ mode: 'query', query: '@today', hide: true }).update({
    effects: setFilterEffect.of(null),
  }).state;
  check('escape-dispatched null clears the filter', !escapeClearsFilter(cleared) && hiddenLines(cleared).size === 0);
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

// --- links: relative paths + escaped spaces ---
{
  const links = findLinks('- see ./notes/plan.md and ../archive/old.taskpaper');
  check(
    'relative ./ and ../ paths detected',
    links.length === 2 &&
      links[0].kind === 'path' &&
      links[0].text === './notes/plan.md' &&
      links[1].kind === 'path' &&
      links[1].text === '../archive/old.taskpaper',
  );
}
{
  const links = findLinks('- open ./my\\ file.txt now');
  check(
    'escaped spaces stay inside one path link',
    links.length === 1 && links[0].kind === 'path' && links[0].text === './my\\ file.txt',
  );
  check(
    'escaped spaces are unescaped in the href',
    linkHref({ kind: 'path', text: './my\\ file.txt' }) === 'file://./my file.txt',
  );
}

// --- links: generic scheme URIs ---
{
  const links = findLinks('- open obsidian://open?vault=x and x-devonthink-item://ABC-123');
  check(
    'generic scheme URIs detected',
    links.length === 2 &&
      links[0].kind === 'scheme' &&
      links[0].text === 'obsidian://open?vault=x' &&
      links[1].kind === 'scheme' &&
      links[1].text === 'x-devonthink-item://ABC-123',
  );
  check(
    'generic scheme opens as-is',
    linkHref({ kind: 'scheme', text: 'obsidian://open?vault=x' }) === 'obsidian://open?vault=x',
  );
}
{
  check('a time is not a scheme link', findLinks('- standup at 16:15 daily').length === 0);
  check(
    'a Windows drive letter is not a scheme link',
    findLinks('- see C:\\Users\\x and C:/other').length === 0,
  );
  check(
    'a scheme-looking tag value is not a link',
    findLinks('- item @ref(note:abc-123)').length === 0,
  );
  const mixed = findLinks('- read https://example.com then file:///tmp/a.txt');
  check(
    'http/file detection not regressed by the scheme alternative',
    mixed.length === 2 && mixed[0].kind === 'url' && mixed[1].kind === 'file',
  );
  const port = findLinks('- visit www.example.com:8080/x');
  check(
    'www with a port stays a www link',
    port.length === 1 && port[0].kind === 'www' && port[0].text === 'www.example.com:8080/x',
  );
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
  // Stage 1: the marker before the cursor is deleted first (task → note)…
  check(
    'backspace after indent + marker deletes the marker',
    JSON.stringify(backspaceUnindentDeletion('\t- task', 3, 4)) === JSON.stringify({ from: 1, to: 3 }),
    JSON.stringify(backspaceUnindentDeletion('\t- task', 3, 4)),
  );
  check(
    'backspace on marker without indent deletes the marker too',
    JSON.stringify(backspaceUnindentDeletion('- task', 2, 4)) === JSON.stringify({ from: 0, to: 2 }),
    JSON.stringify(backspaceUnindentDeletion('- task', 2, 4)),
  );
  // …stage 2: with only indentation left, Backspace un-indents.
  check(
    'backspace with space indent removes up to tabSize spaces',
    JSON.stringify(backspaceUnindentDeletion('      x', 6, 4)) === JSON.stringify({ from: 2, to: 6 }),
  );
  check('backspace mid-text falls through', backspaceUnindentDeletion('\t- task', 5, 4) === null);
  // `-foo` is plain text, not a marker — cursor after the dash deletes normally.
  check('backspace after plain-text dash falls through', backspaceUnindentDeletion('\t-foo', 2, 4) === null);
  check(
    'backspace after lone dash at EOL deletes it as a marker',
    JSON.stringify(backspaceUnindentDeletion('\t-', 2, 4)) === JSON.stringify({ from: 1, to: 2 }),
    JSON.stringify(backspaceUnindentDeletion('\t-', 2, 4)),
  );
  check('backspace at column 0 falls through', backspaceUnindentDeletion('\t- task', 0, 4) === null);
  check('backspace at margin with no marker falls through', backspaceUnindentDeletion('task', 0, 4) === null);
}

// --- indent guides: leading tabs + per-line guide depths ---
{
  check('leadingTabs counts tabs', leadingTabs('\t\t- x') === 2);
  check('leadingTabs stops at first non-tab', leadingTabs('\t  \t- x') === 1);
  check('leadingTabs zero for flush lines', leadingTabs('Project:') === 0);

  // Guides run from each parent through its whole subtree — including blank
  // rows inside it — and stop between root projects.
  const gDoc = ['A:', '\t- a1', '\t\t- a2', '\t', '\t- a3', '', 'B:', '\t- b1'];
  const depths = guideDepths(buildOutline(gDoc, 4), gDoc.length);
  check(
    'guide depths cover subtrees incl blank rows',
    depths.join(',') === '0,1,2,2,1,1,0,1',
    depths.join(','),
  );
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

// --- collapse/expand all by level (original Shift-Cmd-9 / Shift-Cmd-0) ---
{
  // A(0) > a1(1) > x(2), a2(1); B(0) > b1(1). Foldable: A, a1, B.
  const items = buildOutline(['A:', '\t- a1', '\t\t- x', '\t- a2', 'B:', '\t- b1'], 4).items;
  const none = new Set<number>();
  check(
    'first collapse folds the deepest expanded level',
    linesToCollapseDeepestLevel(items, none).join(',') === '1',
  );
  check(
    'second collapse folds the next level up',
    linesToCollapseDeepestLevel(items, new Set([1])).join(',') === '0,4',
  );
  check(
    'collapse with everything folded is a no-op',
    linesToCollapseDeepestLevel(items, new Set([0, 1, 4])).length === 0,
  );
  check(
    'items hidden inside a folded ancestor are not collapse candidates',
    linesToCollapseDeepestLevel(items, new Set([0])).join(',') === '4',
  );
  check(
    'first expand unfolds the shallowest folded level',
    linesToExpandShallowestLevel(items, new Set([0, 1, 4])).join(',') === '0,4',
  );
  check(
    'second expand unfolds the next level down',
    linesToExpandShallowestLevel(items, new Set([1])).join(',') === '1',
  );
  check(
    'expand with nothing folded is a no-op',
    linesToExpandShallowestLevel(items, none).length === 0,
  );
}

// --- collapse items completely (item + every foldable descendant) ---
{
  // A(0) > a1(1) > x(2) > y(3), a2(1); B(0) > b1(1). Foldable: A, a1, x, B.
  const items = buildOutline(
    ['A:', '\t- a1', '\t\t- x', '\t\t\t- y', '\t- a2', 'B:', '\t- b1'],
    4,
  ).items;
  check(
    'collapse completely folds the item and all foldable descendants',
    linesToCollapseCompletely(items, 0).join(',') === '0,1,2',
    linesToCollapseCompletely(items, 0).join(','),
  );
  check(
    'collapse completely on a mid item covers only its branch',
    linesToCollapseCompletely(items, 1).join(',') === '1,2',
  );
  check('collapse completely on a leaf is a no-op', linesToCollapseCompletely(items, 4).length === 0);
  check('collapse completely on a blank line is a no-op', linesToCollapseCompletely(items, 99).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
