/**
 * Headless tests for the Obsidian editor behaviors that don't need a DOM:
 *  - the CodeMirror filter StateField (query + focus hiding, edit-mapping)
 *  - the sidebar render-guard signature (the two-click fix)
 *
 * CodeMirror state is pure, so we drive it with EditorState alone (no EditorView).
 */
import { EditorState } from '@codemirror/state';
import { filterExtension, filterDecoField, setFilterEffect } from '../src/editor/filter';
import { sidebarSignature } from '../src/sidebarLogic';

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
check('signature stable for same inputs', sidebarSignature('a.taskpaper', 100, 3) === sidebarSignature('a.taskpaper', 100, 3));
check('signature changes when focus changes', sidebarSignature('a.taskpaper', 100, 3) !== sidebarSignature('a.taskpaper', 100, null));
check('signature changes when doc length changes', sidebarSignature('a.taskpaper', 100, 3) !== sidebarSignature('a.taskpaper', 101, 3));
check('signature changes when file changes', sidebarSignature('a.taskpaper', 100, 3) !== sidebarSignature('b.taskpaper', 100, 3));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
