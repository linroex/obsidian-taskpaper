import { buildOutline } from '../src/model';
import { runQuery } from '../src/query/evaluator';
import { addTag, removeTag, hasTag, todayStamp } from '../src/tags';
import { parseDate, resolveDateExpression } from '../src/dates';
import { moveItemUp, moveItemDown, indentItem, outdentItem } from '../src/outlineOps';
import { projectStats, documentCounts, savedSearches } from '../src/analysis';
import { focusVisibleLines, projectsToFold, toggleFocusTarget } from '../src/focus';

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

// [l] list modifier: value is a comma-separated list, ANY element may match.
check('[l] contains element', qa('@priority contains[l] 1').join(',') === 'open', qa('@priority contains[l] 1').join(','));
check('[l] equals element', qa('@priority =[l] 2').join(',') === 'open', qa('@priority =[l] 2').join(','));
check('[ln] numeric per element', qa('@priority <[ln] 2').join(',') === 'open', qa('@priority <[ln] 2').join(','));
check('[ln] matches whole list too', qa('@priority =[ln] 3').join(',') === 'open2', qa('@priority =[ln] 3').join(','));
check('[l] no match', qa('@priority =[l] 9').length === 0, qa('@priority =[l] 9').join(','));

// @id: items have no persisted id, so it is the 0-based line number as a string.
check('@id equality', qa('@id = 1').join(',') === 'a1', qa('@id = 1').join(','));
check('@id numeric compare', qa('@id <[n] 3').join(',') === 'Inbox,a1,a2', qa('@id <[n] 3').join(','));
check('@id present on all items', qa('@id').length === adv.items.length, String(qa('@id').length));

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
check(
  'projectsToFold(Inbox) folds Work only',
  JSON.stringify(projectsToFold(focusDoc, inboxLine)) === JSON.stringify([workLine]),
  JSON.stringify(projectsToFold(focusDoc, inboxLine)),
);
check('toggle same clears', toggleFocusTarget(3, 3) === null);
check('toggle different focuses', toggleFocusTarget(3, 0) === 0);
check('toggle from none focuses', toggleFocusTarget(null, 3) === 3);

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
