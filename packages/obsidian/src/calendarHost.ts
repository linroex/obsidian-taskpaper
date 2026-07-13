/**
 * The source-aware calendar host: feeds the CalendarPane occurrences from the
 * view's own editor or (in vault scope) every .taskpaper file, and re-locates
 * an occurrence's line when the pane opens or reschedules it. All scope
 * branching lives here — the pane itself stays scope-free.
 *
 * Line trust model: the own document is live, so an occurrence's recorded
 * line is checked in place (exact fingerprint match, as before). Foreign
 * documents may have drifted since the model was built (stale cache, edits
 * elsewhere), so their lines are re-located purely by fingerprint — exactly
 * one candidate proceeds, 0 or >1 refuse with a Notice.
 */
import { Notice, TFile, Vault } from 'obsidian';
import type { EditorState } from '@codemirror/state';
import { docLines } from './editor/outlineEdit';
import type { CalendarHost } from './calendarPane';
import {
  CalendarScope,
  CalendarSourceDoc,
  fingerprintLines,
  lineFingerprint,
  rescheduledLine,
  SourcedOccurrence,
  sourcedCalendarModel,
} from './calendarSources';
import type { TaskPaperSettings } from './settings';

const STALE_OPEN = '文件已變更，找不到該項目——行事曆已重新整理。';
const STALE_RESCHEDULE = '文件已變更，未改期——行事曆已重新整理。';
const AMBIGUOUS_OPEN = '檔案中有多個相同項目，無法定位。';
const AMBIGUOUS_RESCHEDULE = '檔案中有多個相同項目，未改期。';

/** The slice of a TaskPaper view the host drives (own file or a foreign one). */
export interface CalendarViewLike {
  path: string;
  state(): EditorState;
  /** Replace one line's text as a single undoable transaction. */
  setLineText(line: number, text: string): void;
  /** Reveal the editor and move the cursor to a 0-based line. */
  jumpToLine(line: number): void;
}

/** What createCalendarHost needs from the owning view + plugin. */
export interface CalendarHostContext {
  vault: Vault;
  /** The pane's own view. */
  own(): CalendarViewLike;
  /** Every open TaskPaper view (their unsaved edits beat the disk copy). */
  openViews(): CalendarViewLike[];
  /** Open a file in a TaskPaper view and resolve once its editor is ready. */
  openFileView(path: string): Promise<CalendarViewLike | null>;
  /** Cached lines of a closed file (null while a background read is pending). */
  cachedLines(file: TFile): string[] | null;
  settings: Pick<
    TaskPaperSettings,
    'calendarScope' | 'calendarWeekStart' | 'calendarShowWeekNumbers'
  >;
  saveSettings(): void;
  /** Plugin-wide change counter — bumps on any .taskpaper content change. */
  epoch(): number;
  /** Re-render the active calendar (after async loads/rewrites). */
  refresh(): void;
}

export function createCalendarHost(ctx: CalendarHostContext): CalendarHost {
  const scope = (): CalendarScope => (ctx.settings.calendarScope === 'vault' ? 'vault' : 'file');

  /** Vault-scope documents beyond the own file: open views win over disk. */
  const foreignDocs = (): CalendarSourceDoc[] => {
    const ownPath = ctx.own().path;
    const open = new Map(ctx.openViews().map((v) => [v.path, v]));
    const docs: CalendarSourceDoc[] = [];
    for (const file of ctx.vault.getFiles()) {
      if (file.extension !== 'taskpaper' || file.path === ownPath) {
        continue;
      }
      const view = open.get(file.path);
      const lines = view ? docLines(view.state()) : ctx.cachedLines(file);
      if (lines) {
        docs.push({ path: file.path, lines, badge: file.basename });
      }
    }
    return docs;
  };

  /** The own-file staleness guard (recorded line must still match exactly). */
  const ownLine = (occ: SourcedOccurrence): number | null => {
    const doc = ctx.own().state().doc;
    const stale =
      occ.source.line + 1 > doc.lines ||
      lineFingerprint(doc.line(occ.source.line + 1).text) !== occ.source.fingerprint;
    return stale ? null : occ.source.line;
  };

  /** Re-locate a foreign occurrence purely by fingerprint. */
  const foreignLine = (lines: string[], occ: SourcedOccurrence): number | 'missing' | 'ambiguous' => {
    const candidates = fingerprintLines(lines, occ.source.fingerprint);
    if (candidates.length === 1) {
      return candidates[0];
    }
    return candidates.length === 0 ? 'missing' : 'ambiguous';
  };

  const jumpInto = (view: CalendarViewLike, occ: SourcedOccurrence): void => {
    const where = foreignLine(docLines(view.state()), occ);
    if (where === 'missing') {
      new Notice(STALE_OPEN);
      ctx.refresh();
      return;
    }
    if (where === 'ambiguous') {
      new Notice(AMBIGUOUS_OPEN);
      return;
    }
    view.jumpToLine(where);
  };

  return {
    getOccurrences(monthAnchor, opts, today) {
      const own = ctx.own();
      const docs: CalendarSourceDoc[] = [{ path: own.path, lines: docLines(own.state()) }];
      if (scope() === 'vault') {
        docs.push(...foreignDocs());
      }
      return sourcedCalendarModel(docs, monthAnchor, opts, today);
    },

    version() {
      const length = ctx.own().state().doc.length;
      return scope() === 'file' ? String(length) : `${length}|${ctx.epoch()}`;
    },

    changeToken() {
      return scope() === 'file' ? ctx.own().state().doc : ctx.epoch();
    },

    weekStart: () => ctx.settings.calendarWeekStart,
    showWeekNumbers: () => ctx.settings.calendarShowWeekNumbers !== false,
    scope,
    setScope(next) {
      ctx.settings.calendarScope = next;
      ctx.saveSettings();
    },

    openOccurrence(occ) {
      const own = ctx.own();
      if (occ.source.path === own.path) {
        const line = ownLine(occ);
        if (line === null) {
          new Notice(STALE_OPEN);
          ctx.refresh();
          return;
        }
        own.jumpToLine(line);
        return;
      }
      const view = ctx.openViews().find((v) => v.path === occ.source.path);
      if (view) {
        jumpInto(view, occ);
        return;
      }
      void ctx.openFileView(occ.source.path).then((opened) => {
        if (!opened) {
          new Notice(`無法開啟 ${occ.source.path}`);
          return;
        }
        jumpInto(opened, occ);
      });
    },

    rescheduleOccurrence(occ, date) {
      const own = ctx.own();
      if (occ.source.path === own.path) {
        const line = ownLine(occ);
        if (line === null) {
          new Notice(STALE_RESCHEDULE);
          ctx.refresh();
          return;
        }
        const doc = own.state().doc;
        own.setLineText(line, rescheduledLine(doc.line(line + 1).text, occ.role, date));
        return;
      }
      const view = ctx.openViews().find((v) => v.path === occ.source.path);
      if (view) {
        const lines = docLines(view.state());
        const where = foreignLine(lines, occ);
        if (typeof where !== 'number') {
          new Notice(where === 'missing' ? STALE_RESCHEDULE : AMBIGUOUS_RESCHEDULE);
        } else {
          view.setLineText(where, rescheduledLine(lines[where], occ.role, date));
        }
        ctx.refresh();
        return;
      }
      const file = ctx.vault.getAbstractFileByPath(occ.source.path);
      if (!(file instanceof TFile)) {
        new Notice(STALE_RESCHEDULE);
        ctx.refresh();
        return;
      }
      void ctx.vault
        .process(file, (data) => {
          // Re-locate on the fresh content INSIDE the callback (process may
          // rerun it) — the cached model can be arbitrarily stale.
          const lines = data.split('\n');
          const where = foreignLine(lines, occ);
          if (typeof where !== 'number') {
            new Notice(where === 'missing' ? STALE_RESCHEDULE : AMBIGUOUS_RESCHEDULE);
            return data;
          }
          lines[where] = rescheduledLine(lines[where], occ.role, date);
          return lines.join('\n');
        })
        .then(() => ctx.refresh());
    },
  };
}
