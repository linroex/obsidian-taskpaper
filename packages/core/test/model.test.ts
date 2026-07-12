import { buildOutline } from '../src/model';
import { runQuery } from '../src/query/evaluator';
import { quoteQueryValue } from '../src/query/lexer';
import { addTag, removeTag, removeAllTags, hasTag, todayStamp, toggleDoneLine } from '../src/tags';
import { parseDate, resolveDateExpression } from '../src/dates';
import {
  moveItemUp,
  moveItemDown,
  moveItemOnlyUp,
  moveItemOnlyDown,
  indentItem,
  indentItemOnly,
  outdentItem,
  outdentItemOnly,
  setLineKind,
  groupItems,
  duplicateBranch,
  deleteBranch,
  moveBranchToProject,
  moveBranchesToProject,
  moveBranchBefore,
  moveBranchAfter,
} from '../src/outlineOps';
import { expandSelectionRange, selectBranchRange, selectedRootLines } from '../src/selection';
import { projectStats, documentCounts, rewriteSearchLine, savedSearches, tagNamesToValues } from '../src/analysis';
import { markdownToTaskPaper } from '../src/convert';
import {
  ancestorProjectPath,
  applyArchivePlan,
  archiveDone,
  planArchiveDone,
  stripExtraTags,
} from '../src/archive';
import {
  focusVisibleLines,
  focusOutTarget,
  hoistVisibleLines,
  projectsToFold,
  toggleFocusTarget,
} from '../src/focus';
import { calendarModel, CalendarOccurrence } from '../src/calendar';
import { advanceDate, parseRepeat, planToggleDone, REPEAT_NEEDS_DATE_NOTICE } from '../src/repeat';

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

const doc = `Inbox:
\t- Try the extension @today
\t- Read docs
Work:
\t- Ship release @due(2026-07-01) @flag
\t\t- Write changelog @done(2026-07-06)
\t\t- Tag the build
\t- Review PRs @today
Home:
\tErrands:
\t\t- Buy groceries @today
\t\t- Pick up package @done(2026-07-07)
\t- Water plants @done(2026-07-08)
`;
const lines = doc.split('\n');
const outline = buildOutline(lines, 4);

// --- structure ---
check('roots count', outline.roots.length === 3, `got ${outline.roots.length}`);
check('Inbox is project', outline.roots[0].kind === 'project' && outline.roots[0].displayText === 'Inbox');
const work = outline.roots[1];
check('Work has 2 children', work.children.length === 2, `got ${work.children.length}`);
const ship = work.children[0];
check('Ship has 2 subtasks', ship.children.length === 2, `got ${ship.children.length}`);
check('changelog is done task', ship.children[0].tags.has('done'));
const errands = outline.roots[2].children[0];
check('Errands nested project', errands.kind === 'project' && errands.displayText === 'Errands');
check('subtreeEnd of Ship covers subtasks', ship.subtreeEnd >= ship.children[1].line);

// --- query engine ---
function q(query: string): string[] {
  return [...runQuery(query, outline)].map((i) => i.displayText).sort();
}
check('@today matches 3', q('@today').length === 3, q('@today').join(' | '));
check('@done matches 3', q('@done').length === 3, q('@done').join(' | '));
check('not @done and task', q('not @done and task').every((t) => !t.includes('@done')));
check('text search groceries', q('groceries').length === 1, q('groceries').join(' | '));
check('type project count', q('project').length === 4, q('project').join(' | '));
check('boolean or', q('@flag or @today').length === 4, q('@flag or @today').join(' | '));
check('numeric compare absent ok', q('@priority > 0 [n]').length === 0);
check('path descendant', q('project "Work" // @today').length === 1, q('project "Work" // @today').join(' | '));
check('path child of Home', q('/ project "Home" / @done').length === 1, q('/ project "Home" / @done').join(' | '));
check('parens and not', q('task and not (@done or @today)').length >= 1);
check('beginswith', q('@text beginswith "Buy"').length === 1, q('@text beginswith "Buy"').join(' | '));
check('date compare due before today', q('@due <= today [d]').length === 1, q('@due <= today [d]').join(' | '));

// Local-timezone date handling: an item due exactly today must match.
const ty = new Date();
const todayStr = `${ty.getFullYear()}-${String(ty.getMonth() + 1).padStart(2, '0')}-${String(ty.getDate()).padStart(2, '0')}`;
const dueToday = buildOutline([`Work:`, `\t- ship @due(${todayStr})`], 4);
const qd = (query: string) => [...runQuery(query, dueToday)].length;
check('due today matches = today [d]', qd('@due = today [d]') === 1, String(qd('@due = today [d]')));
check('due today matches <= today [d]', qd('@due <= today [d]') === 1, String(qd('@due <= today [d]')));

// --- advanced queries: set operations, slices, [l] lists, @id ---
// line:  0            1            2                     3     4       5                  6                    7                        8                       9                        10
const advDoc = [
  'Inbox:',
  '\t- a1 @today',
  '\t- a2 @due(2020-01-01)',
  '\t- a3',
  'Work:',
  '\t- done parent @done',
  '\t\t- child of done',
  '\t\t\t- grandchild of done',
  '\t- open @priority(1,2)',
  '\t- open2 @priority(3)',
  '\t- open3 @today @done',
];
const adv = buildOutline(advDoc, 4);
// Strip trailing tags from display text so expectations stay short.
const qa = (query: string) => [...runQuery(query, adv)].map((i) => i.displayText.replace(/\s*@\S+/g, '')).sort();

// Set operations (lowest precedence, left-associative).
check('union with mod after relation', qa('@today union @due <[d] tomorrow').join(',') === 'a1,a2,open3', qa('@today union @due <[d] tomorrow').join(','));
check(
  'except drops done subtrees',
  qa('not @done except @done//*').join(',') === 'Inbox,Work,a1,a2,a3,open,open2',
  qa('not @done except @done//*').join(','),
);
check(
  'parenthesized path union then except',
  qa('(project Inbox//* union //@today) except //@done').join(',') === 'Inbox,a1,a2,a3',
  qa('(project Inbox//* union //@today) except //@done').join(','),
);
check('intersect', qa('@today intersect @done').join(',') === 'open3', qa('@today intersect @done').join(','));
check('set ops associate left', qa('@today union @due except @done').join(',') === 'a1,a2', qa('@today union @due except @done').join(','));
check('predicate parens still group', qa('task and not (@done or @today)').join(',') === 'a2,a3,child of done,grandchild of done,open,open2', qa('task and not (@done or @today)').join(','));
check('leading predicate paren backtracks', qa('(@today or @done) and task').join(',') === 'a1,done parent,open3', qa('(@today or @done) and task').join(','));

// Result slicing (JS Array.slice semantics; [N] picks the single Nth match).
check('slice first task', qa('task[0]').join(',') === 'a1', qa('task[0]').join(','));
check('slice negative index', qa('task[-1]').join(',') === 'open3', qa('task[-1]').join(','));
check('slice range', qa('task[0:2]').join(',') === 'a1,a2', qa('task[0:2]').join(','));
check('slice open start', qa('task[:2]').join(',') === 'a1,a2', qa('task[:2]').join(','));
check('slice open end', qa('task[6:]').join(',') === 'open,open2,open3', qa('task[6:]').join(','));
check('slice negative range', qa('task[-2:]').join(',') === 'open2,open3', qa('task[-2:]').join(','));
check('slice out of range empty', qa('task[99]').length === 0, qa('task[99]').join(','));
// Slices apply per evaluation context: the first not-done task of EACH project.
check(
  'per-context slice keeps one per project',
  qa('project *//task and not @done[0]').join(',') === 'a1,child of done',
  qa('project *//task and not @done[0]').join(','),
);
check('per-context slice example from guide', qa('project *//not @done[0]').join(',') === 'Inbox,Work', qa('project *//not @done[0]').join(','));

// [l] list modifier: BOTH sides are comma-separated lists (birch semantics) —
// `=` compares whole lists, `contains` is subset, ordering relations require
// every right element to be satisfied by some left element.
check('[l] contains element', qa('@priority contains[l] 1').join(',') === 'open', qa('@priority contains[l] 1').join(','));
check('[l] contains subset', qa('@priority contains[l] 2,1').join(',') === 'open', qa('@priority contains[l] 2,1').join(','));
check('[l] contains missing element fails', qa('@priority contains[l] 1,9').length === 0, qa('@priority contains[l] 1,9').join(','));
check('[l] whole-list equality', qa('@priority =[l] 1,2').join(',') === 'open', qa('@priority =[l] 1,2').join(','));
check('[l] partial list is not equal', qa('@priority =[l] 2').length === 0, qa('@priority =[l] 2').join(','));
check('[l] beginswith sequence', qa('@priority beginswith[l] 1').join(',') === 'open', qa('@priority beginswith[l] 1').join(','));
check('[l] endswith sequence', qa('@priority endswith[l] 2').join(',') === 'open', qa('@priority endswith[l] 2').join(','));
check('[ln] numeric per element', qa('@priority <[ln] 2').join(',') === 'open', qa('@priority <[ln] 2').join(','));
check('[ln] matches whole list too', qa('@priority =[ln] 3').join(',') === 'open2', qa('@priority =[ln] 3').join(','));
check('[l] no match', qa('@priority =[l] 9').length === 0, qa('@priority =[l] 9').join(','));

// Slice on a parenthesized expression applies to the whole result in document order.
check('slice on parenthesized union', qa('(@today union @due)[0]').join(',') === 'a1', qa('(@today union @due)[0]').join(','));
check('slice range on parenthesized expr', qa('(project Inbox//task)[1:]').join(',') === 'a2,a3', qa('(project Inbox//task)[1:]').join(','));

// @id: items have no persisted id, so it is the 0-based line number as a string.
check('@id equality', qa('@id = 1').join(',') === 'a1', qa('@id = 1').join(','));
check('@id numeric compare', qa('@id <[n] 3').join(',') === 'Inbox,a1,a2', qa('@id <[n] 3').join(','));
check('@id present on all items', qa('@id').length === adv.items.length, String(qa('@id').length));

// --- markdown → taskpaper conversion (file-menu 轉換) ---
{
  const md = [
    '# 專案甲',
    'intro text',
    '- [ ] open task',
    '- [x] finished task',
    '  - [ ] nested (2-space)',
    '* star item',
    '## 子專案',
    '    - [X] four-space nested done',
    'plain note',
  ];
  const tp = markdownToTaskPaper(md);
  check('h1 becomes a root project', tp[0] === '專案甲:', tp[0]);
  check('body text passes through', tp[1] === 'intro text');
  check('unchecked box becomes a task', tp[2] === '- open task', tp[2]);
  check('checked box gains @done', tp[3] === '- finished task @done', tp[3]);
  check('2-space nesting becomes a tab', tp[4] === '\t- nested (2-space)', JSON.stringify(tp[4]));
  check('star items normalize to dashes', tp[5] === '- star item', tp[5]);
  check('h2 becomes a nested project', tp[6] === '\t子專案:', JSON.stringify(tp[6]));
  // The doc mixes 2- and 4-space indents, so the document-wide step is 2:
  // 4 spaces = depth 2. (Uniform-step conversion keeps hierarchy consistent.)
  check('4-space line in a 2-space doc is depth 2', tp[7] === '\t\t- four-space nested done @done', JSON.stringify(tp[7]));
  check('plain lines stay notes', tp[8] === 'plain note');
  check('heading with trailing colon not doubled', markdownToTaskPaper(['# A:'])[0] === 'A:');
  check('closing-hash headings are trimmed', markdownToTaskPaper(['## B ##'])[0] === '\tB:');

  // The indent step is decided per DOCUMENT — a 2-space-nested list keeps
  // its hierarchy even at depths whose spaces happen to divide by 4.
  const deep = markdownToTaskPaper(['- a', '  - b', '    - c', '      - d']);
  check(
    '2-space nesting stays consistent at every depth',
    deep.join('|') === '- a|\t- b|\t\t- c|\t\t\t- d',
    JSON.stringify(deep),
  );
  // Fenced code blocks pass through untouched.
  const fenced = markdownToTaskPaper(['```', '# install deps', '- run npm i', '```', '# Real heading']);
  check('fence content is never rewritten', fenced[1] === '# install deps' && fenced[2] === '- run npm i', JSON.stringify(fenced));
  check('lines after the fence convert again', fenced[4] === 'Real heading:', fenced[4]);
}

// --- selectedRootLines: covering fallback is opt-in ---
{
  const o = buildOutline(['A:', '\t- a1', '', '\t- a2'], 4);
  check(
    'blank-line range falls back to the covering branch when allowed',
    selectedRootLines(o, [[2, 2]], true).join(',') === '1',
    selectedRootLines(o, [[2, 2]], true).join(','),
  );
  check(
    'blank-line range contributes nothing when fallback is off (Duplicate)',
    selectedRootLines(o, [[2, 2]], false).length === 0,
  );
  check('direct items ignore the flag', selectedRootLines(o, [[1, 1]], false).join(',') === '1');
}

// --- tag helpers ---
check('addTag done', addTag('- foo', 'done', '2026-07-08') === '- foo @done(2026-07-08)');
check('addTag idempotent value replace', addTag('- foo @done(2026-01-01)', 'done', '2026-07-08') === '- foo @done(2026-07-08)');
check('removeTag', removeTag('- foo @today @flag', 'today') === '- foo @flag');
check('removeTag with value', removeTag('- foo @done(2026-07-08)', 'done') === '- foo');
check(
  'removeTag preserves nested indentation',
  removeTag('\t\t- Write changelog @done(2026-07-06)', 'done') === '\t\t- Write changelog',
  removeTag('\t\t- Write changelog @done(2026-07-06)', 'done'),
);
check(
  'removeTag preserves intentional internal spaces',
  removeTag('\t- foo   bar @today', 'today') === '\t- foo   bar',
  removeTag('\t- foo   bar @today', 'today'),
);
check('hasTag', hasTag('- foo @today', 'today') && !hasTag('- foo @today', 'done'));
check('todayStamp format', /^\d{4}-\d{2}-\d{2}$/.test(todayStamp(false)));
check('escaped parens in value', (() => {
  const l = buildOutline(['- x @note(a \\) b)'], 4);
  return l.items[0].tags.get('note') === 'a ) b';
})());

// --- edge: spaces instead of tabs ---
const spaceDoc = buildOutline(['Proj:', '    - child', '        - grand'], 4);
check('space indent nests', spaceDoc.roots[0].children[0].children.length === 1, 'depth');

// --- edge: task ending with colon stays a task ---
const tricky = buildOutline(['- not a project:'], 4);
check('dash-colon is task', tricky.items[0].kind === 'task');

// --- natural-language dates (relative to a fixed Thursday 2026-07-09) ---
const ref = new Date(2026, 6, 9); // Thu
const iso = (e: string) => resolveDateExpression(e, ref);
check('nl today', iso('today') === '2026-07-09', String(iso('today')));
check('nl tomorrow', iso('tomorrow') === '2026-07-10');
check('nl +1 week', iso('+1 week') === '2026-07-16', String(iso('+1 week')));
check('nl 3 days', iso('3 days') === '2026-07-12', String(iso('3 days')));
check('nl next friday', iso('next friday') === '2026-07-10', String(iso('next friday')));
check('nl friday (bare = coming)', iso('friday') === '2026-07-10');
check('nl next thursday skips today', iso('next thursday') === '2026-07-16', String(iso('next thursday')));
check('nl last monday', iso('last monday') === '2026-07-06', String(iso('last monday')));
check('nl garbage -> null', iso('blorp') === null);
check('parseDate query use', !Number.isNaN(parseDate('next week', ref)));

// `now` = the wall-clock moment (original semantics); `today` = local midnight.
{
  const refNow = new Date(2026, 6, 9, 14, 30);
  check('now keeps the time of day', parseDate('now', refNow) === refNow.getTime());
  check('now + 2h offsets from the moment', parseDate('now + 2h', refNow) === new Date(2026, 6, 9, 16, 30).getTime());
  check('today stays at midnight', parseDate('today', refNow) === new Date(2026, 6, 9).getTime());
}

// Invalid components are rejected, not silently normalized by Date.
check('invalid day 2026-02-31 -> null', iso('2026-02-31') === null, String(iso('2026-02-31')));
check('invalid month 2026-13 -> null', iso('2026-13') === null, String(iso('2026-13')));
check('invalid month day nov 32 -> null', iso('nov 32') === null, String(iso('nov 32')));
// Date.parse fallback only accepts explicit ISO-with-timezone / RFC 2822.
check('garbage with a year -> NaN', Number.isNaN(parseDate('hello 2026', ref)));
check('iso with timezone still parses', !Number.isNaN(parseDate('2026-07-09T12:00:00Z', ref)));
check('rfc 2822 still parses', !Number.isNaN(parseDate('Thu, 09 Jul 2026 12:00:00 GMT', ref)));

// --- TaskPaper 3 date syntax parity (same fixed Thu 2026-07-09 reference) ---
// Sanity: plain `today` still resolves at LOCAL midnight.
check('today is local midnight ts', parseDate('today', ref) === new Date(2026, 6, 9).getTime());
check('iso date is local midnight ts', parseDate('2026-07-09', ref) === new Date(2026, 6, 9).getTime());

// Times — alone (= today at that time) and combined with dates.
check('time 9am', iso('9am') === '2026-07-09 09:00', String(iso('9am')));
check('time 6 am (space)', iso('6 am') === '2026-07-09 06:00', String(iso('6 am')));
check('time 3:15 pm', iso('3:15 pm') === '2026-07-09 15:15', String(iso('3:15 pm')));
check('time 16:15 (24h)', iso('16:15') === '2026-07-09 16:15', String(iso('16:15')));
check('time 12am is midnight -> date only', iso('12am') === '2026-07-09', String(iso('12am')));
check('time 12pm is noon', iso('12pm') === '2026-07-09 12:00', String(iso('12pm')));
check('tomorrow 9am', iso('tomorrow 9am') === '2026-07-10 09:00', String(iso('tomorrow 9am')));
check('iso date + time', iso('2026-07-20 14:30') === '2026-07-20 14:30', String(iso('2026-07-20 14:30')));
check('weekday + time', iso('next friday 8:30am') === '2026-07-10 08:30', String(iso('next friday 8:30am')));
check('bad hour 13pm -> null', iso('13pm') === null);
check('bad minutes 9:75 -> null', iso('9:75') === null);
check('time ts is local', parseDate('16:15', ref) === new Date(2026, 6, 9, 16, 15).getTime());

// Month names — full and 3-letter, with next/last/this and optional day.
check('month bare = this year', iso('june') === '2026-06-01', String(iso('june')));
check('month next (past month -> next year)', iso('next june') === '2027-06-01', String(iso('next june')));
check('month last', iso('last june') === '2026-06-01', String(iso('last june')));
check('month this', iso('this june') === '2026-06-01', String(iso('this june')));
check('month next (future month -> this year)', iso('next nov') === '2026-11-01', String(iso('next nov')));
check('month last (future month -> prev year)', iso('last nov') === '2025-11-01', String(iso('last nov')));
check('month next of current month -> next year', iso('next july') === '2027-07-01', String(iso('next july')));
check('month + day', iso('june 3') === '2026-06-03', String(iso('june 3')));
check('month next + day', iso('next june 3') === '2027-06-03', String(iso('next june 3')));
check('month abbr + day', iso('nov 26') === '2026-11-26', String(iso('nov 26')));
check('month full name', iso('November') === '2026-11-01', String(iso('November')));
check('month + day + time', iso('nov 26 3:15') === '2026-11-26 03:15', String(iso('nov 26 3:15')));

// Year and year-month.
check('bare year', iso('2026') === '2026-01-01', String(iso('2026')));
check('bare year other', iso('2030') === '2030-01-01', String(iso('2030')));
check('year-month', iso('2026-01') === '2026-01-01', String(iso('2026-01')));
check('year-month mid', iso('2027-03') === '2027-03-01', String(iso('2027-03')));

// Duration offsets / date math.
check('today + 24h', iso('today + 24h') === '2026-07-10', String(iso('today + 24h')));
check('today + 24h == tomorrow', parseDate('today + 24h', ref) === parseDate('tomorrow', ref));
check('month day time +1day', iso('nov 26 3:15 +1day') === '2026-11-27 03:15', String(iso('nov 26 3:15 +1day')));
check('bare -6 hours', iso('-6 hours') === '2026-07-08 18:00', String(iso('-6 hours')));
check('chained 2 days 6 hours', iso('2 days 6 hours') === '2026-07-11 06:00', String(iso('2 days 6 hours')));
check('chain inherits minus sign', iso('-2 days 6 hours') === '2026-07-06 18:00', String(iso('-2 days 6 hours')));
check('compact +2d', iso('+2d') === '2026-07-11', String(iso('+2d')));
check('compact 1day', iso('1day') === '2026-07-10', String(iso('1day')));
check('compact 30m is minutes', iso('30m') === '2026-07-09 00:30', String(iso('30m')));
check('45min', iso('45min') === '2026-07-09 00:45', String(iso('45min')));
check('month unit calendar math', iso('today +1 month') === '2026-08-09', String(iso('today +1 month')));
check('month math clamps eom', iso('2026-01-31 +1 month') === '2026-02-28', String(iso('2026-01-31 +1 month')));
check('year unit', iso('today - 1 year') === '2025-07-09', String(iso('today - 1 year')));
check('in 2 weeks still works', iso('in 2 weeks') === '2026-07-23', String(iso('in 2 weeks')));
check('offset on iso date', iso('2026-07-01 +1 week') === '2026-07-08', String(iso('2026-07-01 +1 week')));
check('next month = month start', iso('next month') === '2026-08-01', String(iso('next month')));
check('last year = jan 1 prev', iso('last year') === '2025-01-01', String(iso('last year')));
check('dangling qualifier -> null', iso('next 5') === null, String(iso('next 5')));
check('trailing junk -> null', iso('today banana') === null, String(iso('today banana')));

// Case-insensitivity.
check('case NEXT JUNE 3', iso('NEXT JUNE 3') === '2027-06-03', String(iso('NEXT JUNE 3')));
check('case Tomorrow 9AM', iso('Tomorrow 9AM') === '2026-07-10 09:00', String(iso('Tomorrow 9AM')));
check('case Nov 26 3:15 PM', iso('Nov 26 3:15 PM') === '2026-11-26 15:15', String(iso('Nov 26 3:15 PM')));

// Date math inside an actual query. The dueToday outline (above) has @due set
// to the real current date, so expressions are relative to real "now".
check('query due <= "today + 24h"', qd('@due <= "today + 24h" [d]') === 1, String(qd('@due <= "today + 24h" [d]')));
check('query due <= "today - 24h" excludes', qd('@due <= "today - 24h" [d]') === 0);
check('query due > "yesterday 11pm"', qd('@due > "yesterday 11pm" [d]') === 1);
check('query due < "2 weeks"', qd('@due < "2 weeks" [d]') === 1);

// --- outline operations ---
const ol = ['A:', '\t- one', '\t- two', '\t\t- two-child', '\t- three'];
const down = moveItemDown(ol, 1, 4); // move "- one" below "- two" (+ its child)
check('moveDown swaps sibling block', down !== null && down.lines[1] === '\t- two' && down.lines[3] === '\t- one', JSON.stringify(down?.lines));
const up = moveItemUp(ol, 4, 4); // move "- three" above "- two"
check('moveUp swaps sibling block', up !== null && up.lines[1] === '\t- one' && up.lines[2] === '\t- three', JSON.stringify(up?.lines));
const ind = indentItem(ol, 2, 4); // indent "- two" (and child)
check('indent adds tab to subtree', ind !== null && ind.lines[2] === '\t\t- two' && ind.lines[3] === '\t\t\t- two-child', JSON.stringify(ind?.lines));
const out = outdentItem(ol, 3, 4); // outdent "- two-child"
check('outdent removes one tab', out !== null && out.lines[3] === '\t- two-child', JSON.stringify(out?.lines));
check('moveUp first child returns null', moveItemUp(ol, 1, 4) === null);
check('outdent at margin returns null', outdentItem(ol, 0, 4) === null);

// --- single-item moves (only the item line moves; its subtree stays) ---
const mo = [
  'A:',
  '\t- prev',
  '\t\t- prevchild',
  '\t- item',
  '\t\t- child1',
  '\t\t- child2',
  '\t- next',
  '\t\t- nextchild',
];
const moUp = moveItemOnlyUp(mo, 3, 4);
check(
  'moveItemOnlyUp moves the line above the previous sibling',
  moUp !== null && moUp.lines[1] === '\t- item' && moUp.lines[2] === '\t- prev' && moUp.cursorLine === 1,
  JSON.stringify(moUp?.lines),
);
check(
  'moveItemOnlyUp does NOT drag the children',
  moUp !== null && moUp.lines[4] === '\t\t- child1' && moUp.lines[5] === '\t\t- child2',
  JSON.stringify(moUp?.lines),
);
check('moveItemOnlyUp keeps the line count', moUp !== null && moUp.lines.length === mo.length);
const moDown = moveItemOnlyDown(mo, 3, 4);
check(
  'moveItemOnlyDown moves the line below the next sibling branch',
  moDown !== null && moDown.lines[7] === '\t- item' && moDown.cursorLine === 7,
  JSON.stringify(moDown?.lines),
);
check(
  'moveItemOnlyDown leaves the children in place',
  moDown !== null && moDown.lines[3] === '\t\t- child1' && moDown.lines[4] === '\t\t- child2',
  JSON.stringify(moDown?.lines),
);
check('moveItemOnlyUp at first sibling returns null', moveItemOnlyUp(mo, 1, 4) === null);
check('moveItemOnlyDown at last sibling returns null', moveItemOnlyDown(mo, 6, 4) === null);
const moIndent = indentItemOnly(mo, 3, 4);
check(
  'indentItemOnly indents just the item line',
  moIndent !== null && moIndent.lines[3] === '\t\t- item' && moIndent.lines[4] === '\t\t- child1',
  JSON.stringify(moIndent?.lines),
);
const moOutdent = outdentItemOnly(mo, 3, 4);
check(
  'outdentItemOnly outdents just the item line',
  moOutdent !== null && moOutdent.lines[3] === '- item' && moOutdent.lines[4] === '\t\t- child1',
  JSON.stringify(moOutdent?.lines),
);
check('outdentItemOnly at margin returns null', outdentItemOnly(mo, 0, 4) === null);
check(
  'outdentItemOnly trims up to tabSize spaces',
  outdentItemOnly(['A:', '      - spaced'], 1, 4)?.lines[1] === '  - spaced',
);

// --- selection ranges (Select Branch / Expand Selection) ---
const selDoc = [
  'Inbox:',
  '\t- alpha @today',
  'Work:',
  '\t- ship',
  '\t\t- childA',
  '\t\t- childB',
  '\t- review',
];
const rangeEq = (
  r: { startLine: number; startCol: number; endLine: number; endCol: number } | null,
  e: [number, number, number, number],
) => r !== null && r.startLine === e[0] && r.startCol === e[1] && r.endLine === e[2] && r.endCol === e[3];

check('selectBranch on a leaf is its own line', rangeEq(selectBranchRange(selDoc, 4, 4, 4), [4, 0, 4, 10]));
check('selectBranch covers the subtree', rangeEq(selectBranchRange(selDoc, 4, 3, 3), [3, 0, 5, 10]));
check(
  'selectBranch climbs until the span is covered',
  rangeEq(selectBranchRange(selDoc, 4, 3, 6), [2, 0, 6, 9]),
);
check('selectBranch on an empty doc returns null', selectBranchRange([''], 4, 0, 0) === null);

const selAt = (sl: number, sc: number, el: number, ec: number) =>
  expandSelectionRange(selDoc, 4, { startLine: sl, startCol: sc, endLine: el, endCol: ec });
check('expand: cursor -> word', rangeEq(selAt(3, 5, 3, 5), [3, 3, 3, 7]));
check('expand: cursor on non-word -> full line', rangeEq(selAt(1, 0, 1, 0), [1, 0, 1, 15]));
check('expand: word -> full line', rangeEq(selAt(3, 3, 3, 7), [3, 0, 3, 7]));
check('expand: line -> branch', rangeEq(selAt(3, 0, 3, 7), [3, 0, 5, 10]));
check('expand: branch -> parent branch', rangeEq(selAt(3, 0, 5, 10), [2, 0, 6, 9]));
check('expand: root branch -> whole document', rangeEq(selAt(2, 0, 6, 9), [0, 0, 6, 9]));
check('expand: whole document -> null', selAt(0, 0, 6, 9) === null);

// --- format conversions ---
check('task -> project', setLineKind('\t- buy milk', 'project') === '\tbuy milk:');
check('project -> task', setLineKind('\tErrands:', 'task') === '\t- Errands');
check('note -> task', setLineKind('\t\tsome note', 'task') === '\t\t- some note');
check('task -> note', setLineKind('- buy milk', 'note') === 'buy milk');
check('project -> note', setLineKind('Errands:', 'note') === 'Errands');
check(
  'task -> project keeps trailing tags after colon',
  setLineKind('\t- Ship @due(2026-07-20) @flag', 'project') === '\tShip: @due(2026-07-20) @flag',
  setLineKind('\t- Ship @due(2026-07-20) @flag', 'project'),
);
check(
  'project -> task keeps trailing tags',
  setLineKind('Work: @flag', 'task') === '- Work @flag',
  setLineKind('Work: @flag', 'task'),
);
check(
  'task -> project with escaped paren in tag value',
  setLineKind('- Ship @x(a\\)b)', 'project') === 'Ship: @x(a\\)b)',
  setLineKind('- Ship @x(a\\)b)', 'project'),
);
check('format is idempotent (task)', setLineKind('- x', 'task') === '- x');
check('format is idempotent (project)', setLineKind('X:', 'project') === 'X:');
check('format blank untouched', setLineKind('   ', 'task') === '   ');

// --- group ---
const grp = groupItems(['A:', '\t- one', '\t- two', '\t\t- two-child', '\t- three'], 1, 2, 'Sub', 4);
check(
  'group inserts project at min indent and indents subtrees',
  grp !== null &&
    grp.lines.join('|') === 'A:|\tSub:|\t\t- one|\t\t- two|\t\t\t- two-child|\t- three',
  JSON.stringify(grp?.lines),
);
check('group cursor on new project line before colon', grp !== null && grp.cursorLine === 1 && grp.cursorCol === 4);
check('group with no items returns null', groupItems(['', ''], 0, 1, 'X', 4) === null);

// --- duplicate branch ---
const dup = duplicateBranch(['A:', '\t- one', '\t\t- one-child', '\t- two'], 1, 4);
check(
  'duplicate copies whole branch after itself',
  dup !== null &&
    dup.lines.join('|') === 'A:|\t- one|\t\t- one-child|\t- one|\t\t- one-child|\t- two',
  JSON.stringify(dup?.lines),
);
check('duplicate cursor on the copy', dup !== null && dup.cursorLine === 3);
const dupChild = duplicateBranch(['A:', '\t- one', '\t\t- one-child', '\t- two'], 2, 4);
check(
  'duplicate from a child line copies just that item',
  dupChild !== null && dupChild.lines[3] === '\t\t- one-child' && dupChild.cursorLine === 3,
  JSON.stringify(dupChild?.lines),
);

// --- delete branch ---
const del = deleteBranch(['A:', '\t- one', '\t\t- one-child', '\t- two'], 1, 1, 4);
check(
  'delete removes item and its subtree',
  del !== null && del.lines.join('|') === 'A:|\t- two',
  JSON.stringify(del?.lines),
);
const delMulti = deleteBranch(['A:', '\t- one', '\t\t- one-child', '\t- two', 'B:'], 1, 3, 4);
check(
  'delete spans multi-line selection with subtrees',
  delMulti !== null && delMulti.lines.join('|') === 'A:|B:',
  JSON.stringify(delMulti?.lines),
);
check('delete on blank-only selection returns null', deleteBranch(['A:', ''], 1, 1, 4) === null);

// --- move branch to project ---
const mvDoc = ['One:', '\t- a', '\t\t- a-child', 'Two:', '\t- b'];
const mvFwd = moveBranchToProject(mvDoc, 1, 3, 4); // move "- a" branch into later project Two
check(
  'move branch to a later project (end, re-indented)',
  mvFwd !== null && mvFwd.lines.join('|') === 'One:|Two:|\t- b|\t- a|\t\t- a-child',
  JSON.stringify(mvFwd?.lines),
);
check('move forward cursor on moved line', mvFwd !== null && mvFwd.cursorLine === 3);
const mvBack = moveBranchToProject(mvDoc, 4, 0, 4); // move "- b" into earlier project One
check(
  'move branch to an earlier project',
  mvBack !== null && mvBack.lines.join('|') === 'One:|\t- a|\t\t- a-child|\t- b|Two:',
  JSON.stringify(mvBack?.lines),
);
const mvDeep = moveBranchToProject(['One:', '\t- a', '\t\t- a-child', 'Two:', '\t- b'], 2, 0, 4);
check(
  'move a nested item up to its ancestor project re-indents as direct child',
  mvDeep !== null && mvDeep.lines.join('|') === 'One:|\t- a|\t- a-child|Two:|\t- b',
  JSON.stringify(mvDeep?.lines),
);
// Space-indented target: new indentation follows the project's ACTUAL leading
// whitespace (4 spaces here), not tabs derived from its structural level.
const mvSpaces = moveBranchToProject(['Root:', '    Sub:', '- x'], 2, 1, 4);
check(
  'move into a space-indented project uses its actual whitespace',
  mvSpaces !== null && mvSpaces.lines.join('|') === 'Root:|    Sub:|    \t- x',
  JSON.stringify(mvSpaces?.lines),
);
check('move into own subtree returns null', moveBranchToProject(['One:', '\tTwo:', '\t\t- x'], 0, 1, 4) === null);

// --- move SEVERAL branches to a project (multi-select right-click) ---
{
  const doc = ['A:', '\t- a1', '\t\t- kid', '\t- a2', 'B:', '\t- b1', 'Target:'];
  const mv = moveBranchesToProject(doc, [1, 5], 6, 4);
  check(
    'moves multiple branches keeping document order',
    mv !== null && mv.lines.join('|') === 'A:|\t- a2|B:|Target:|\t- a1|\t\t- kid|\t- b1',
    JSON.stringify(mv?.lines),
  );
  const nested = moveBranchesToProject(doc, [1, 2], 6, 4);
  check(
    'nested roots dedupe to the outer branch',
    nested !== null && nested.lines.filter((l) => l.includes('kid')).length === 1,
    JSON.stringify(nested?.lines),
  );
  check('moving into own subtree is skipped', moveBranchesToProject(['P:', '\t- x'], [0], 0, 4) === null);
}
check('move to non-project returns null', moveBranchToProject(mvDoc, 4, 1, 4) === null);

// --- move branch before/after (sidebar project drag-reorder) ---
{
  // One(0) / -a(1) / -a-child(2) / Two(3) / -b(4) / Three(5)
  const dnd = ['One:', '\t- a', '\t\t- a-child', 'Two:', '\t- b', 'Three:'];
  const before = moveBranchBefore(dnd, 3, 0, 4); // drag Two above One
  check(
    'moveBranchBefore drags a later project (with subtree) above an earlier one',
    before !== null && before.lines.join('|') === 'Two:|\t- b|One:|\t- a|\t\t- a-child|Three:',
    JSON.stringify(before?.lines),
  );
  check('moveBranchBefore cursor lands on the moved line', before !== null && before.cursorLine === 0);
  const after = moveBranchAfter(dnd, 0, 3, 4); // drag One below Two (after its subtree)
  check(
    'moveBranchAfter drops the whole subtree after the target subtree',
    after !== null && after.lines.join('|') === 'Two:|\t- b|One:|\t- a|\t\t- a-child|Three:',
    JSON.stringify(after?.lines),
  );
  check('moveBranchAfter cursor lands on the moved line', after !== null && after.cursorLine === 2);
  const afterUp = moveBranchAfter(dnd, 5, 0, 4); // drag Three up, after One's subtree
  check(
    'moveBranchAfter dragging up lands between the subtrees',
    afterUp !== null && afterUp.lines.join('|') === 'One:|\t- a|\t\t- a-child|Three:|Two:|\t- b',
    JSON.stringify(afterUp?.lines),
  );
  // Adjacent drops that change nothing are no-ops.
  check('moveBranchBefore onto the next sibling is a no-op', moveBranchBefore(dnd, 0, 3, 4) === null);
  check('moveBranchAfter onto the previous sibling is a no-op', moveBranchAfter(dnd, 3, 0, 4) === null);
  check('moveBranchBefore onto itself is a no-op', moveBranchBefore(dnd, 0, 0, 4) === null);
  // Nested project dragged between roots re-indents to the target's level.
  const nested = ['Home:', '\tErrands:', '\t\t- buy', 'Work:'];
  const outdented = moveBranchBefore(nested, 1, 3, 4); // Errands → root, before Work
  check(
    'moveBranchBefore re-indents a nested project to the target root level',
    outdented !== null && outdented.lines.join('|') === 'Home:|Errands:|\t- buy|Work:',
    JSON.stringify(outdented?.lines),
  );
  const indented = moveBranchBefore(['Solo:', 'Home:', '\tErrands:'], 0, 2, 4); // root → nested
  check(
    'moveBranchBefore re-indents a root project dropped at a nested level',
    indented !== null && indented.lines.join('|') === 'Home:|\tSolo:|\tErrands:',
    JSON.stringify(indented?.lines),
  );
  check('moveBranchBefore into own subtree returns null', moveBranchBefore(nested, 0, 1, 4) === null);
  check('moveBranchAfter into own subtree returns null', moveBranchAfter(nested, 0, 2, 4) === null);
  check('moveBranchBefore with a stale source line returns null', moveBranchBefore(dnd, 99, 0, 4) === null);
  check('moveBranchBefore with a stale target line returns null', moveBranchBefore(dnd, 0, 99, 4) === null);
}

// --- removeAllTags ---
// --- tag values map (sidebar value rows) + dash toggle ---
{
  const tvOutline = buildOutline(
    ['P:', '\t- a @priority(10)', '\t- b @priority(1,2)', '\t- c @flag', '\t- d @priority(2)'],
    4,
  );
  const tv = tagNamesToValues(tvOutline);
  check(
    'tagNamesToValues splits commas and dedupes',
    (tv.get('priority') ?? []).join(',') === '1,10,2',
    (tv.get('priority') ?? []).join(','),
  );
  check('valueless tag yields empty list', (tv.get('flag') ?? ['x']).length === 0);
  // The exact query the sidebar value rows run (same as the original app).
  const hits = [...runQuery('@priority contains[l] "10"', tvOutline)].map((i) => i.displayText);
  check('sidebar value query matches', hits.length === 1 && hits[0].startsWith('a'), hits.join('|'));
  // quoteQueryValue escapes backslashes and quotes so any value round-trips.
  check('quoteQueryValue escapes specials', quoteQueryValue('a\\b"c') === '"a\\\\b\\"c"', quoteQueryValue('a\\b"c'));
  // In the document a literal backslash is escaped: @note(a\\b) → value 'a\b'.
  const bsOutline = buildOutline(['P:', '\t- z @note(a\\\\b)'], 4);
  const bsHits = [...runQuery(`@note contains[l] ${quoteQueryValue('a\\b')}`, bsOutline)];
  check('backslash value round-trips through query', bsHits.length === 1, String(bsHits.length));
}
check(
  'toggleDoneLine stamps and drops @today',
  toggleDoneLine('\t- x @today', '2026-07-11') === '\t- x @done(2026-07-11)',
  toggleDoneLine('\t- x @today', '2026-07-11'),
);
check('toggleDoneLine removes when done', toggleDoneLine('\t- x @done(2026-07-11)', '2026-07-11') === '\t- x');

check('removeAllTags strips every tag', removeAllTags('- foo @today @flag') === '- foo');
check(
  'removeAllTags handles values and keeps indent',
  removeAllTags('\t\t- Ship @due(2026-07-20) @done(2026-07-06 10:00)') === '\t\t- Ship',
  removeAllTags('\t\t- Ship @due(2026-07-20) @done(2026-07-06 10:00)'),
);
check('removeAllTags keeps project colon', removeAllTags('Work: @flag') === 'Work:');
check('removeAllTags no-op without tags', removeAllTags('\t- plain') === '\t- plain');

// --- analysis ---
const stats = projectStats(outline);
const workStat = [...stats.entries()].find(([p]) => p.displayText === 'Work')?.[1];
check('projectStats Work remaining', !!workStat && workStat.total === 4 && workStat.remaining === 3, JSON.stringify(workStat));
const dc = documentCounts(outline);
check('documentCounts today=3', dc.today === 3, JSON.stringify(dc));
check('documentCounts done=3', dc.done === 3, JSON.stringify(dc));
const searchDoc = buildOutline(['Searches:', '\t- Hot @search(@today and not @done)'], 4);
const ss = savedSearches(searchDoc);
check('savedSearches parses', ss.length === 1 && ss[0].name === 'Hot' && ss[0].query === '@today and not @done', JSON.stringify(ss));

// --- saved-search line rewrite ---
check(
  'rewriteSearchLine keeps indent + task marker',
  rewriteSearchLine('\t- Old name @search(@done)', 'Hot', '@today and not @done') ===
    '\t- Hot @search(@today and not @done)',
  rewriteSearchLine('\t- Old name @search(@done)', 'Hot', '@today and not @done'),
);
check(
  'rewriteSearchLine on a note line has no marker',
  rewriteSearchLine('\tHot @search(x)', 'Cold', 'y') === '\tCold @search(y)',
  rewriteSearchLine('\tHot @search(x)', 'Cold', 'y'),
);
check(
  'rewriteSearchLine escapes parens in the query',
  rewriteSearchLine('- s @search(a)', 's', 'not (@done or @today)') === '- s @search(not \\(@done or @today\\))',
  rewriteSearchLine('- s @search(a)', 's', 'not (@done or @today)'),
);
check(
  'rewriteSearchLine drops stale extra tags',
  rewriteSearchLine('\t- Old @flag @search(a)', 'New', 'b') === '\t- New @search(b)',
  rewriteSearchLine('\t- Old @flag @search(a)', 'New', 'b'),
);

// --- archive: ancestor project path + tag stripping ---
const pathDoc = buildOutline(['2026 Goals:', '\tWork:', '\t\t- ship @done', 'Archive:'], 4);
const shipItem = pathDoc.items.find((i) => i.displayText.startsWith('ship'))!;
check(
  'ancestorProjectPath joins all ancestor projects',
  ancestorProjectPath(shipItem, 'Archive') === '2026 Goals / Work',
  String(ancestorProjectPath(shipItem, 'Archive')),
);
check('ancestorProjectPath top level -> undefined', ancestorProjectPath(pathDoc.roots[0], 'Archive') === undefined);
const inArchive = buildOutline(['Archive:', '\t- x @done'], 4).items[1];
check('ancestorProjectPath excludes the archive project', ancestorProjectPath(inArchive, 'Archive') === undefined);
check(
  'stripExtraTags keeps only listed tags',
  stripExtraTags('\t- a @flag @done(2026-07-01) @due(x) @project(P)', ['done', 'project']) ===
    '\t- a @done(2026-07-01) @project(P)',
  stripExtraTags('\t- a @flag @done(2026-07-01) @due(x) @project(P)', ['done', 'project']),
);
check('stripExtraTags no-op when nothing extra', stripExtraTags('- a @done', ['done', 'project']) === '- a @done');

// --- archive: done items move to the TOP of the Archive project ---
const archDoc = [
  '2026 Goals:',
  '\tWork:',
  '\t\t- ship @done(2026-07-01) @flag',
  '\t\t\t- follow-up note',
  '\t\t- keep',
  'Archive:',
  '\t- old @done @project(Old)',
];
const archPlan = planArchiveDone(archDoc, 4)!;
check('archive plan removes the done subtree', JSON.stringify(archPlan.removals) === '[[2,4]]', JSON.stringify(archPlan.removals));
check('archive plan inserts right after the Archive line', archPlan.insertAt === 6, String(archPlan.insertAt));
const archived = archiveDone(archDoc, 4);
check(
  'archive inserts above existing archived items, with full @project path',
  archived !== null &&
    archived.join('|') ===
      '2026 Goals:|\tWork:|\t\t- keep|Archive:|\t- ship @done(2026-07-01) @flag @project(2026 Goals / Work)|\t\t- follow-up note|\t- old @done @project(Old)',
  JSON.stringify(archived),
);
check(
  'applyArchivePlan matches archiveDone',
  JSON.stringify(applyArchivePlan(archDoc, archPlan)) === JSON.stringify(archived),
);
const midArch = archiveDone(['Archive:', '\t- old @done', 'Inbox:', '\t- a @done', '\t- b'], 4);
check(
  'archive project mid-document still gets new items first',
  midArch !== null && midArch.join('|') === 'Archive:|\t- a @done @project(Inbox)|\t- old @done|Inbox:|\t- b',
  JSON.stringify(midArch),
);
const multiArch = archiveDone(['A:', '\t- one @done', '\t- two @done', 'Archive:', '\t- older @done'], 4);
check(
  'items archived together keep document order, above older ones',
  multiArch !== null &&
    multiArch.join('|') === 'A:|Archive:|\t- one @done @project(A)|\t- two @done @project(A)|\t- older @done',
  JSON.stringify(multiArch),
);
const freshArch = archiveDone(['Inbox:', '\t- a @done', '\t- b'], 4);
check(
  'archive project created at document end when missing',
  freshArch !== null && freshArch.join('|') === 'Inbox:|\t- b||Archive:|\t- a @done @project(Inbox)',
  JSON.stringify(freshArch),
);
// Trailing whitespace-only lines are separators — they stay in place and are
// never dragged into the Archive as stray indented blank lines.
const sepArch = archiveDone(
  ['TKS:', '\t- 123', '\t- Sony @done', '\t', 'Archive:', '\t- old @done @project(Log)'],
  4,
);
check(
  'trailing whitespace line stays out of the archive',
  sepArch !== null &&
    sepArch.join('|') ===
      'TKS:|\t- 123|\t|Archive:|\t- Sony @done @project(TKS)|\t- old @done @project(Log)',
  JSON.stringify(sepArch),
);
const sepArchNested = archiveDone(['W:', '\t- a @done', '\t\thttps://x', '\t\t', 'Archive:'], 4);
check(
  'nested trailing whitespace also stays out',
  sepArchNested !== null &&
    sepArchNested.join('|') === 'W:|\t\t|Archive:|\t- a @done @project(W)|\t\thttps://x',
  JSON.stringify(sepArchNested),
);

const noTagArch = archiveDone(['Work:', '\t- x @done', 'Archive:'], 4, { addProjectTag: false });
check(
  'addProjectTag=false omits @project',
  noTagArch !== null && noTagArch.join('|') === 'Work:|Archive:|\t- x @done',
  JSON.stringify(noTagArch),
);
const strippedArch = archiveDone(
  ['Work:', '\t- x @done(2026-07-01) @flag @due(2026-08-01)', 'Archive:'],
  4,
  { removeExtraTags: true },
);
check(
  'removeExtraTags strips all but @done/@project',
  strippedArch !== null && strippedArch[2] === '\t- x @done(2026-07-01) @project(Work)',
  JSON.stringify(strippedArch),
);
const keepProjArch = archiveDone(['Work:', '\t- x @done @project(Original)', 'Archive:'], 4);
check(
  'an existing @project value is preserved',
  keepProjArch !== null && keepProjArch[2] === '\t- x @done @project(Original)',
  JSON.stringify(keepProjArch),
);
const nestedArch = archiveDone(['W:', '\t- p @done', '\t\t- c @done', 'Archive:'], 4);
check(
  'done child of a done parent is archived once, with its parent',
  nestedArch !== null && nestedArch.join('|') === 'W:|Archive:|\t- p @done @project(W)|\t\t- c @done',
  JSON.stringify(nestedArch),
);
check('already-archived items are not re-archived', archiveDone(['A:', '\t- x', 'Archive:', '\t- y @done'], 4) === null);
check(
  'adjacent done subtrees coalesce into one removal',
  JSON.stringify(planArchiveDone(['A:', '\t- one @done', '\t- two @done', 'Archive:'], 4)!.removals) === '[[1,3]]',
  JSON.stringify(planArchiveDone(['A:', '\t- one @done', '\t- two @done', 'Archive:'], 4)!.removals),
);
const endArch = archiveDone(['Archive:', '\t- old @done', 'A:', '\t- z @done'], 4);
check(
  'archiving the last line leaves no trailing blank',
  endArch !== null && endArch.join('|') === 'Archive:|\t- z @done @project(A)|\t- old @done|A:',
  JSON.stringify(endArch),
);
const wholeArch = archiveDone(['- a @done', '- b @done'], 4);
check(
  'archiving an all-done document yields just the Archive project',
  wholeArch !== null && wholeArch.join('|') === 'Archive:|\t- a @done|\t- b @done',
  JSON.stringify(wholeArch),
);
const customArch = archiveDone(['A:', '\t- x @done', '完成:'], 4, { archiveName: '完成' });
check(
  'custom archive project name',
  customArch !== null && customArch.join('|') === 'A:|完成:|\t- x @done @project(A)',
  JSON.stringify(customArch),
);

// --- focus behaviors ---
// doc: Inbox(0) / -a today(1) / -b(2) / Work(3) / -c(4) / -c2(5) nested
const focusDoc = buildOutline(['Inbox:', '\t- a @today', '\t- b', 'Work:', '\t- c', '\t\t- c2'], 4);
const inboxLine = 0;
const workLine = 3;
check(
  'focusVisibleLines = subtree of Inbox',
  setEq(focusVisibleLines(focusDoc, inboxLine), new Set([0, 1, 2])),
  [...focusVisibleLines(focusDoc, inboxLine)].join(','),
);
check(
  'focusVisibleLines = subtree of Work (incl nested)',
  setEq(focusVisibleLines(focusDoc, workLine), new Set([3, 4, 5])),
  [...focusVisibleLines(focusDoc, workLine)].join(','),
);
// hoist = descendants + ancestors, but NOT the hoisted line itself.
check(
  'hoistVisibleLines(Work) shows only its contents',
  setEq(hoistVisibleLines(focusDoc, workLine), new Set([4, 5])),
  [...hoistVisibleLines(focusDoc, workLine)].join(','),
);
// Home(0) > Errands(1) > -buy(2); hoisting Errands keeps ancestor Home visible.
const hoistDoc = buildOutline(['Home:', '\tErrands:', '\t\t- buy', 'Work:'], 4);
check(
  'hoistVisibleLines of a nested project = descendants + ancestors, own line hidden',
  setEq(hoistVisibleLines(hoistDoc, 1), new Set([0, 2])),
  [...hoistVisibleLines(hoistDoc, 1)].join(','),
);
check(
  'hoistVisibleLines of a childless project is just its ancestors',
  setEq(hoistVisibleLines(hoistDoc, 3), new Set([])),
  [...hoistVisibleLines(hoistDoc, 3)].join(','),
);
check(
  'hoistVisibleLines of a missing line is empty',
  hoistVisibleLines(buildOutline([], 4), 5).size === 0,
);
check(
  'projectsToFold(Inbox) folds Work only',
  JSON.stringify(projectsToFold(focusDoc, inboxLine)) === JSON.stringify([workLine]),
  JSON.stringify(projectsToFold(focusDoc, inboxLine)),
);
// focusOutTarget: Home(8) > Errands(9) in the main doc — stepping out of Errands focuses Home.
const errandsLine = errands.line;
check('focusOutTarget nested -> ancestor project', focusOutTarget(outline, errandsLine) === outline.roots[2].line, String(focusOutTarget(outline, errandsLine)));
check('focusOutTarget top-level -> null (clear focus)', focusOutTarget(outline, outline.roots[2].line) === null);
check('toggle same clears', toggleFocusTarget(3, 3) === null);
check('toggle different focuses', toggleFocusTarget(3, 0) === 0);
check('toggle from none focuses', toggleFocusTarget(null, 3) === 3);

// --- calendar model ---
// Fixed clock: Sunday 2026-07-12 (2026-07-01 is a Wednesday).
{
  const calToday = new Date(2026, 6, 12);
  const calDoc = [
    'Work:',
    '\tRelease:',
    '\t\t- ship it @due(2026-07-15)',                       // 2
    '\t\t- prep @start(2026-07-10) @due(2026-07-20)',       // 3: due date only
    '\t\t- warm up @start(2026-07-14)',                     // 4: @start alone → omitted
    '\t- review now @today',                                // 5: virtual today
    '\t- urgent @today @due(2026-07-18)',                   // 6: due wins, once
    '\t- shipped @done(2026-07-10) @due(2026-07-05)',       // 7: completed only
    '\t- late @due(2026-07-11)',                            // 8: overdue (yesterday)
    '\t- edge @due(2026-07-12)',                            // 9: due today, NOT overdue
    '\t- old @due(2026-06-30)',                             // 10: overdue, out of month
    '\t- garbled @due(banana)',                             // 11: unparsable → skipped
    '\t- soon @due(tomorrow)',                              // 12: NL → 2026-07-13
    '\t- next month @due(2026-08-01)',                      // 13: on grid, not in agenda
    '- loose @due(2026-07-15)',                             // 14: no project path
    'Notes about @due(2026-07-15)',                         // 15: note → ignored
    'Deadline @due(2026-07-16):',                           // 16: project → ignored
  ].join('\n');
  const calOutline = buildOutline(calDoc.split('\n'), 4);
  const model = calendarModel(
    calOutline,
    '2026-07',
    { showCompleted: true, weekStart: 0 },
    calToday,
  );
  const all: CalendarOccurrence[] = [];
  for (const week of model.weeks) {
    for (const day of week) {
      all.push(...day.occurrences);
    }
  }
  const at = (date: string) =>
    model.weeks.flat().find((d) => d.date === date)?.occurrences ?? [];
  const linesAt = (date: string) => at(date).map((o) => o.line).join(',');

  check('cal: month echoed', model.month === '2026-07');
  check('cal: due lands on its date', linesAt('2026-07-15') === '2,14', linesAt('2026-07-15'));
  check('cal: start+due → due date only', linesAt('2026-07-20') === '3', linesAt('2026-07-20'));
  check('cal: @start alone places nothing', !all.some((o) => o.line === 4));
  check(
    'cal: @today without due → virtual occurrence today',
    at('2026-07-12').some((o) => o.line === 5 && o.role === 'today'),
    linesAt('2026-07-12'),
  );
  check(
    'cal: @today with due → the due date once, role due',
    linesAt('2026-07-18') === '6' && at('2026-07-18')[0].role === 'due' &&
      all.filter((o) => o.line === 6).length === 1,
  );
  check(
    'cal: done → completed on the done date',
    linesAt('2026-07-10') === '7' && at('2026-07-10')[0].role === 'completed',
  );
  check('cal: a done item never appears as due', !at('2026-07-05').some((o) => o.line === 7));
  check('cal: unparsable due is skipped', !all.some((o) => o.line === 11));
  check(
    'cal: NL @due(tomorrow) resolves against the injected today',
    linesAt('2026-07-13') === '12',
    linesAt('2026-07-13'),
  );
  check('cal: note/project @due are ignored', !all.some((o) => o.line === 15 || o.line === 16));
  check(
    'cal: text is stripped of tags',
    at('2026-07-15')[0].text === 'ship it',
    at('2026-07-15')[0].text,
  );
  check(
    'cal: projectPath joins ancestor projects',
    at('2026-07-15')[0].projectPath === 'Work / Release',
    String(at('2026-07-15')[0].projectPath),
  );
  check('cal: top-level task has no projectPath', at('2026-07-15')[1].projectPath === undefined);

  // Overdue: strictly before today's local midnight, sorted date then line.
  check(
    'cal: overdue = due yesterday and earlier, date-then-line order',
    model.overdue.map((o) => o.line).join(',') === '10,8',
    model.overdue.map((o) => o.line).join(','),
  );
  check('cal: due today is not overdue', !model.overdue.some((o) => o.line === 9));
  check('cal: overdue items still appear on their day cell', linesAt('2026-07-11') === '8');

  // Grid shape (July 2026, weekStart 0 = Sunday).
  check('cal: 5 week rows', model.weeks.length === 5, String(model.weeks.length));
  check('cal: rows are 7 wide', model.weeks.every((w) => w.length === 7));
  check(
    'cal: grid starts Sunday 06-28, padded out-of-month',
    model.weeks[0][0].date === '2026-06-28' && !model.weeks[0][0].inMonth,
    model.weeks[0][0].date,
  );
  check(
    'cal: grid ends Saturday 08-01, padded out-of-month',
    model.weeks[4][6].date === '2026-08-01' && !model.weeks[4][6].inMonth,
    model.weeks[4][6].date,
  );
  check('cal: July 1 is in-month', at('2026-07-01') !== undefined && model.weeks[0][3].inMonth);
  check(
    'cal: padding days still carry occurrences',
    linesAt('2026-08-01') === '13' && linesAt('2026-06-30') === '10',
  );

  // Agenda: ascending in-month dates with occurrences; overdue excluded.
  check(
    'cal: agenda dates ascend within the month',
    model.agenda.map((a) => a.date).join(',') ===
      '2026-07-10,2026-07-12,2026-07-13,2026-07-15,2026-07-18,2026-07-20',
    model.agenda.map((a) => a.date).join(','),
  );
  check(
    'cal: agenda excludes overdue occurrences',
    !model.agenda.some((a) => a.occurrences.some((o) => o.line === 8 || o.line === 10)),
  );
  check(
    'cal: agenda excludes out-of-month dates',
    !model.agenda.some((a) => a.date === '2026-08-01'),
  );
  check(
    'cal: due-today sits in the agenda, not overdue',
    model.agenda.find((a) => a.date === '2026-07-12')!.occurrences.some((o) => o.line === 9),
  );

  // showCompleted off: the done item disappears entirely.
  const hidden = calendarModel(
    calOutline,
    '2026-07',
    { showCompleted: false, weekStart: 0 },
    calToday,
  );
  check(
    'cal: showCompleted=false drops completed occurrences',
    !hidden.weeks.flat().some((d) => d.occurrences.some((o) => o.role === 'completed')),
  );

  // weekStart 1 (Monday) re-pads the same month.
  const mon = calendarModel(calOutline, '2026-07', { showCompleted: true, weekStart: 1 }, calToday);
  check(
    'cal: weekStart=1 grid starts Monday 06-29',
    mon.weeks[0][0].date === '2026-06-29',
    mon.weeks[0][0].date,
  );
  check(
    'cal: weekStart=1 grid ends Sunday 08-02',
    mon.weeks.length === 5 && mon.weeks[4][6].date === '2026-08-02',
    mon.weeks[4][6].date,
  );
}

// --- recurring tasks: parseRepeat / advanceDate / planToggleDone ---
{
  // parseRepeat validity matrix.
  check('repeat: 1w parses', JSON.stringify(parseRepeat('- x @repeat(1w)')) === '{"n":1,"unit":"w"}');
  check('repeat: 10d parses', JSON.stringify(parseRepeat('- x @repeat(10d)')) === '{"n":10,"unit":"d"}');
  check('repeat: 3m parses', JSON.stringify(parseRepeat('- x @repeat(3m)')) === '{"n":3,"unit":"m"}');
  check('repeat: 1y parses', JSON.stringify(parseRepeat('- x @repeat(1y)')) === '{"n":1,"unit":"y"}');
  check('repeat: 0w is invalid', parseRepeat('- x @repeat(0w)') === null);
  check('repeat: -1d is invalid', parseRepeat('- x @repeat(-1d)') === null);
  check('repeat: 1.5w is invalid', parseRepeat('- x @repeat(1.5w)') === null);
  check('repeat: foo is invalid', parseRepeat('- x @repeat(foo)') === null);
  check('repeat: bare @repeat is invalid', parseRepeat('- x @repeat') === null);
  check('repeat: no tag at all', parseRepeat('- x @due(2026-07-01)') === null);
  check(
    'repeat: first VALID duplicate wins',
    JSON.stringify(parseRepeat('- x @repeat(0w) @repeat(2d) @repeat(1y)')) === '{"n":2,"unit":"d"}',
  );

  // advanceDate: calendar-aware, end-of-month clamped.
  check('advance: +1w', advanceDate('2026-07-01', 1, 'w') === '2026-07-08', advanceDate('2026-07-01', 1, 'w'));
  check('advance: +10d', advanceDate('2026-07-01', 10, 'd') === '2026-07-11', advanceDate('2026-07-01', 10, 'd'));
  check('advance: +3m', advanceDate('2026-07-15', 3, 'm') === '2026-10-15', advanceDate('2026-07-15', 3, 'm'));
  check('advance: +1y', advanceDate('2026-07-15', 1, 'y') === '2027-07-15', advanceDate('2026-07-15', 1, 'y'));
  check('advance: Jan 31 +1m clamps to Feb 28', advanceDate('2026-01-31', 1, 'm') === '2026-02-28', advanceDate('2026-01-31', 1, 'm'));
  check('advance: Jan 31 +1m in a leap year clamps to Feb 29', advanceDate('2024-01-31', 1, 'm') === '2024-02-29', advanceDate('2024-01-31', 1, 'm'));
  check('advance: leap day +1y clamps to Feb 28', advanceDate('2024-02-29', 1, 'y') === '2025-02-28', advanceDate('2024-02-29', 1, 'y'));
  check('advance: time of day survives', advanceDate('2026-07-01 09:30', 1, 'd') === '2026-07-02 09:30', advanceDate('2026-07-01 09:30', 1, 'd'));
  check('advance: unparseable input returned unchanged', advanceDate('nonsense', 1, 'd') === 'nonsense');

  const repOpts = { stamp: '2026-07-10', tabSize: 4, now: new Date(2026, 6, 10) };

  // Spawn lands after the completed item's ENTIRE subtree, same indentation.
  {
    const doc = [
      'Work:',
      '\t- water plants @due(2026-07-01) @repeat(1w)',
      '\t\t- refill the can',
      '\t- other',
    ];
    const plan = planToggleDone(doc, [1], repOpts);
    check('plan: completed line gets @done', plan.changes.length === 1 && plan.changes[0].line === 1 && plan.changes[0].text === '\t- water plants @due(2026-07-01) @repeat(1w) @done(2026-07-10)', JSON.stringify(plan.changes));
    check('plan: successor after the subtree, date advanced', plan.inserts.length === 1 && plan.inserts[0].afterLine === 2 && plan.inserts[0].text === '\t- water plants @due(2026-07-08) @repeat(1w)', JSON.stringify(plan.inserts));
    check('plan: no notices when anchored', plan.notices.length === 0);
  }

  // Every date anchor advances from its OWN value; @today is dropped.
  {
    const doc = ['- multi @start(2026-07-01) @due(2026-07-03) @today @repeat(2d)'];
    const plan = planToggleDone(doc, [0], repOpts);
    check(
      'plan: due and start both advance, @today dropped',
      plan.inserts[0]?.text === '- multi @start(2026-07-03) @due(2026-07-05) @repeat(2d)',
      JSON.stringify(plan.inserts),
    );
  }

  // Bare @today with no other anchor converts to @due(today + interval).
  {
    const doc = ['- t @today @repeat(3d)'];
    const plan = planToggleDone(doc, [0], repOpts);
    check('plan: @today line completes without @today', plan.changes[0].text === '- t @repeat(3d) @done(2026-07-10)', plan.changes[0].text);
    check('plan: @today converts to @due(today+interval)', plan.inserts[0]?.text === '- t @repeat(3d) @due(2026-07-13)', JSON.stringify(plan.inserts));
  }

  // No date anchor at all: done as usual, no spawn, one notice.
  {
    const doc = ['- solo @repeat(1w)', '- also @repeat(1w)'];
    const plan = planToggleDone(doc, [0, 1], repOpts);
    check('plan: no anchor still toggles done', plan.changes.length === 2);
    check('plan: no anchor spawns nothing', plan.inserts.length === 0);
    check('plan: the no-anchor notice (deduplicated)', plan.notices.length === 1 && plan.notices[0] === REPEAT_NEEDS_DATE_NOTICE, JSON.stringify(plan.notices));
  }

  // Unparseable anchor values don't count as anchors.
  {
    const plan = planToggleDone(['- x @due(nonsense) @repeat(1w)'], [0], repOpts);
    check('plan: unparseable @due is no anchor', plan.inserts.length === 0 && plan.notices.length === 1);
  }

  // Duplicate anchor tags: each occurrence advances from its own value;
  // unparseable duplicates stay untouched but don't block the valid one.
  {
    const plan = planToggleDone(['- x @due(nonsense) @due(2026-07-01) @repeat(1w)'], [0], repOpts);
    check(
      'plan: a valid duplicate anchor still spawns, in place',
      plan.inserts[0]?.text === '- x @due(nonsense) @due(2026-07-08) @repeat(1w)',
      JSON.stringify(plan.inserts),
    );
    const both = planToggleDone(['- x @due(2026-07-01) @due(2026-07-02) @repeat(1w)'], [0], repOpts);
    check(
      'plan: both duplicate anchors advance from their own values',
      both.inserts[0]?.text === '- x @due(2026-07-08) @due(2026-07-09) @repeat(1w)',
      JSON.stringify(both.inserts),
    );
  }

  // Toggling done OFF never spawns and never warns.
  {
    const plan = planToggleDone(['- x @due(2026-07-01) @repeat(1w) @done(2026-07-10)'], [0], repOpts);
    check('plan: un-done removes the stamp', plan.changes[0].text === '- x @due(2026-07-01) @repeat(1w)', plan.changes[0].text);
    check('plan: un-done spawns nothing', plan.inserts.length === 0 && plan.notices.length === 0);
  }

  // Dedupe guard: identical successor already immediately after the subtree.
  {
    const doc = ['- x @due(2026-07-01) @repeat(1w)', '- x @due(2026-07-08) @repeat(1w)'];
    const plan = planToggleDone(doc, [0], repOpts);
    check('plan: dedupe skips an existing successor', plan.changes.length === 1 && plan.inserts.length === 0, JSON.stringify(plan.inserts));
  }

  // Multi-select: every line planned against ONE snapshot.
  {
    const doc = [
      '- a @due(2026-07-01) @repeat(1w)',
      '\t- a child',
      '- b @due(2026-07-02) @repeat(1d)',
      '- done already @repeat(1w) @done(2026-07-01)',
    ];
    const plan = planToggleDone(doc, [0, 2, 3, 2], repOpts);
    check('plan: multi-select toggles each line once', plan.changes.length === 3, JSON.stringify(plan.changes.map((c) => c.line)));
    check(
      'plan: multi-select spawns per anchored to-done line',
      plan.inserts.length === 2 &&
        plan.inserts[0].afterLine === 1 &&
        plan.inserts[0].text === '- a @due(2026-07-08) @repeat(1w)' &&
        plan.inserts[1].afterLine === 2 &&
        plan.inserts[1].text === '- b @due(2026-07-03) @repeat(1d)',
      JSON.stringify(plan.inserts),
    );
  }

  // Trailing blank lines never separate the successor from the subtree.
  {
    const plan = planToggleDone(['- x @due(2026-07-01) @repeat(1w)', ''], [0], repOpts);
    check('plan: successor goes before a trailing blank line', plan.inserts[0]?.afterLine === 0, JSON.stringify(plan.inserts));
  }

  // Natural-language anchors resolve first, then advance.
  {
    const plan = planToggleDone(['- x @due(today) @repeat(1w)'], [0], repOpts);
    check('plan: natural-language @due resolves then advances', plan.inserts[0]?.text === '- x @due(2026-07-17) @repeat(1w)', JSON.stringify(plan.inserts));
  }

  // No @repeat: plain toggle, nothing else.
  {
    const plan = planToggleDone(['- plain @due(2026-07-01)'], [0], repOpts);
    check('plan: no @repeat means no spawn', plan.changes.length === 1 && plan.inserts.length === 0 && plan.notices.length === 0);
  }
}

function setEq(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const v of a) {
    if (!b.has(v)) {
      return false;
    }
  }
  return true;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
