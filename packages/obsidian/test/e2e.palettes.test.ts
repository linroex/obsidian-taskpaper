/**
 * E2E tests for the TaskPaper 3 palettes (Go to anything… / Go to tag…) and
 * the tag-value autocomplete: a REAL EditorView mounted under jsdom with the
 * production extension stack, plus the 'obsidian' stub's FuzzySuggestModal
 * (which stores callbacks and exposes chooseItemWithText) standing in for
 * the real palette UI. The action layer (applyPaletteEntry) is exercised
 * exactly as the commands wire it: entries from goToAnythingEntries /
 * goToTagEntries, applied through a plugin-ish PaletteHost.
 */
import { docText, hiddenLineNumbers, mountEditor } from './e2eHarness';
import { CompletionContext, insertCompletionText } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { App } from 'obsidian';
import { resolveDateExpression } from '@taskpaper/core';
import { filterSpecField } from '../src/editor/filter';
import { outlineOf } from '../src/editor/outline';
import { tagCompletionSource } from '../src/editor/tagComplete';
import { PaletteSuggestModal } from '../src/modals';
import {
  applyPaletteEntry,
  goToAnythingEntries,
  goToTagEntries,
  PaletteEntry,
  PaletteHost,
} from '../src/paletteEntries';
import type { MountedEditor } from './e2eHarness';

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

function activeQuery(view: EditorView): string | null {
  const spec = view.state.field(filterSpecField, false) ?? null;
  return spec && spec.mode === 'query' ? spec.query : null;
}

// Inbox(1) / -alpha @today(2) / -beta @waiting(bob)(3) / Work(4) /
// -gamma @priority(1)(5) / -delta @priority(2)(6) / Searches(7) / -Hot(8)
const DOC = [
  'Inbox:',
  '\t- alpha @today',
  '\t- beta @waiting(bob)',
  'Work:',
  '\t- gamma @priority(1)',
  '\t- delta @priority(2)',
  'Searches:',
  '\t- Hot @search(@today)',
].join('\n');

const GLOBAL_SEARCHES = [{ name: 'Waiting', query: '@waiting' }];

/** Open a palette exactly as the commands do: entries → stub modal → apply. */
function openPalette(
  mounted: MountedEditor,
  entries: PaletteEntry[],
  placeholder: string,
): PaletteSuggestModal {
  const host: PaletteHost = mounted.host; // the RecordingHost is a PaletteHost
  const modal = new PaletteSuggestModal(
    new App(),
    entries,
    (entry) => applyPaletteEntry(mounted.view, host, entry),
    placeholder,
  );
  modal.open();
  return modal;
}

function openGoToAnything(mounted: MountedEditor): PaletteSuggestModal {
  return openPalette(
    mounted,
    goToAnythingEntries(outlineOf(mounted.view.state), GLOBAL_SEARCHES),
    'Go to anything',
  );
}

// --- Go to anything: the palette lists every group ---
{
  const mounted = mountEditor(DOC);
  const modal = openGoToAnything(mounted);
  check('the palette modal opens', modal.isOpen);
  const texts = modal.getItems().map((e) => modal.getItemText(e));
  check(
    'the palette lists projects, searches (global + document), and tags with values',
    texts.includes('Project: Work') &&
      texts.includes('Search: Waiting（全域） — @waiting') &&
      texts.includes('Search: Hot — @today') &&
      texts.includes('Tag: @today') &&
      texts.includes('Tag: @priority(1)'),
    texts.join(' | '),
  );
  modal.close();
  mounted.cleanup();
}

// --- Go to anything (a): choosing a project moves the cursor to its line ---
{
  const mounted = mountEditor(DOC);
  const modal = openGoToAnything(mounted);
  modal.chooseItemWithText('Project: Work');
  const line4 = mounted.view.state.doc.line(4);
  check(
    'choosing a project moves the cursor to its line',
    mounted.view.state.selection.main.head === line4.from &&
      mounted.view.state.selection.main.empty,
    String(mounted.view.state.selection.main.head),
  );
  check('choosing a project applies no filter', hiddenLineNumbers(mounted.view).size === 0);
  mounted.cleanup();
}

// --- Go to anything (b): choosing a search applies its query filter ---
{
  const mounted = mountEditor(DOC);
  openGoToAnything(mounted).chooseItemWithText('Search: Hot — @today');
  check('the search query becomes the active filter', activeQuery(mounted.view) === '@today');
  check(
    'the document search hides non-matching lines',
    setEq(hiddenLineNumbers(mounted.view), new Set([3, 4, 5, 6, 7, 8])),
    [...hiddenLineNumbers(mounted.view)].join(','),
  );
  check(
    'the palette cleared the focused line',
    mounted.host.focusLines.length === 1 && mounted.host.focusLines[0] === null,
  );
  check('the palette refreshed the sidebar', mounted.host.refreshes === 1);
  mounted.cleanup();
}
{
  const mounted = mountEditor(DOC);
  openGoToAnything(mounted).chooseItemWithText('Search: Waiting（全域） — @waiting');
  check(
    'a global search hides non-matching lines too',
    activeQuery(mounted.view) === '@waiting' &&
      setEq(hiddenLineNumbers(mounted.view), new Set([2, 4, 5, 6, 7, 8])),
    [...hiddenLineNumbers(mounted.view)].join(','),
  );
  mounted.cleanup();
}

// --- Go to anything (c): choosing a tag value applies the value filter ---
{
  const mounted = mountEditor(DOC);
  openGoToAnything(mounted).chooseItemWithText('Tag: @priority(1)');
  check(
    'choosing a tag value applies the contains[l] filter',
    activeQuery(mounted.view) === '@priority contains[l] "1"',
    String(activeQuery(mounted.view)),
  );
  check(
    'only the matching branch stays visible',
    setEq(hiddenLineNumbers(mounted.view), new Set([1, 2, 3, 6, 7, 8])),
    [...hiddenLineNumbers(mounted.view)].join(','),
  );
  mounted.cleanup();
}

// --- Go to tag: tags only; choosing one filters the document ---
{
  const mounted = mountEditor(DOC);
  const modal = openPalette(
    mounted,
    goToTagEntries(outlineOf(mounted.view.state)),
    'Go to tag',
  );
  const texts = modal.getItems().map((e) => modal.getItemText(e));
  check(
    'go to tag lists only tags and their values',
    modal.getItems().every((e) => e.kind === 'tag') &&
      texts.includes('@today') &&
      texts.includes('@waiting(bob)'),
    texts.join(' | '),
  );
  modal.chooseItemWithText('@today');
  check('choosing a tag applies its filter', activeQuery(mounted.view) === '@today');
  check(
    'the tag filter hides non-matching lines',
    setEq(hiddenLineNumbers(mounted.view), new Set([3, 4, 5, 6, 7, 8])),
    [...hiddenLineNumbers(mounted.view)].join(','),
  );
  mounted.cleanup();
}

// --- tag-value autocomplete: inside @priority( a real editor offers the
// --- document's distinct values for that tag ---
{
  const mounted = mountEditor(DOC + '\n\t- epsilon @priority(');
  const pos = mounted.view.state.doc.length;
  const result = tagCompletionSource(new CompletionContext(mounted.view.state, pos, false));
  const labels = result?.options.map((o) => o.label) ?? [];
  check(
    'inside @priority( the document\'s values complete',
    result !== null && result.from === pos && labels.includes('1') && labels.includes('2'),
    labels.join(','),
  );
  check('no foreign values leak in', !labels.includes('bob') && !labels.includes('today'));
  mounted.cleanup();
}

// --- tag-value autocomplete: the @due date suggestion inserts its ISO date ---
{
  const mounted = mountEditor('- pay rent @due(');
  const pos = mounted.view.state.doc.length;
  const result = tagCompletionSource(new CompletionContext(mounted.view.state, pos, false));
  const tomorrow = result?.options.find((o) => o.label === 'tomorrow');
  check('@due( offers the natural-language dates', tomorrow !== undefined);

  // Apply the completion the way @codemirror/autocomplete does for string applies.
  mounted.view.dispatch(
    insertCompletionText(mounted.view.state, String(tomorrow!.apply), result!.from, pos),
  );
  check(
    'applying "tomorrow" inserts the resolved ISO date',
    docText(mounted.view) === `- pay rent @due(${resolveDateExpression('tomorrow')}`,
    docText(mounted.view),
  );
  mounted.cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
