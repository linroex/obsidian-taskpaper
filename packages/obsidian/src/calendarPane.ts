import { Notice, setIcon } from 'obsidian';
import type { EditorState } from '@codemirror/state';
import {
  addTag,
  calendarModel,
  CalendarModel,
  CalendarOccurrence,
  isoDate,
  isoMonth,
  isoWeekLabel,
  removeTag,
  setTagValue,
  stripTags,
} from '@taskpaper/core';
import { outlineOf } from './editor/outline';

/** Weekday glyph by Date#getDay() index. */
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** Shift a YYYY-MM anchor by n months. */
function shiftMonth(anchor: string, n: number): string {
  const [y, m] = anchor.split('-').map(Number);
  return isoMonth(new Date(y, m - 1 + n, 1));
}

/** What the embedded calendar needs from its owner (the TaskPaper view). */
export interface CalendarHost {
  /** The source document's current editor state. */
  state(): EditorState;
  /** Move the editor to a 0-based line (the pane has already verified it). */
  jumpToLine(line: number): void;
  /** First day of the week: 1 = Monday, 0 = Sunday (user setting). */
  weekStart(): number;
  /** Whether the month grid shows ISO week labels (W627). */
  showWeekNumbers(): boolean;
  /** Replace one line's text as a single undoable transaction (drag-reschedule). */
  setLineText(line: number, text: string): void;
}

/**
 * The calendar pane embedded INSIDE the TaskPaper view (editor ⇄ calendar
 * toggle in the same tab): a month grid or an agenda list over the
 * document's dated tasks.
 */
export class CalendarPane {
  /** 月曆格 (grid) ⇄ 列表 (agenda) — kept for the pane's lifetime. */
  private mode: 'month' | 'agenda' = 'month';
  private showCompleted = false;
  /** YYYY-MM being displayed; defaults to today's month on first render. */
  private monthAnchor: string | null = null;
  /** Injectable clock, so tests can pin "today". */
  now: () => Date = () => new Date();
  /** Signature of the last render, to avoid needless DOM rebuilds. */
  private renderedSignature: string | null = null;
  private midnightTimer: number | null = null;
  private active = false;
  /** The occurrence being dragged to another date, while a drag is live. */
  private dragOcc: CalendarOccurrence | null = null;
  /** Document snapshot at dragstart — a changed doc rejects the drop. */
  private dragDoc: unknown = null;

  constructor(
    private containerEl: HTMLElement,
    private host: CalendarHost,
  ) {}

  /** Show/hide bookkeeping: renders on activation, times the midnight rollover. */
  setActive(active: boolean): void {
    this.active = active;
    if (active) {
      this.render(true);
      this.scheduleMidnightRefresh();
    } else if (this.midnightTimer !== null) {
      window.clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
  }

  destroy(): void {
    this.setActive(false);
    this.containerEl.empty();
  }

  /** Re-render right after local midnight (今天 highlight, @today items and
   *  overdue status all roll over), then reschedule for the next day. */
  private scheduleMidnightRefresh(): void {
    if (this.midnightTimer !== null) {
      window.clearTimeout(this.midnightTimer);
    }
    const now = this.now();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    this.midnightTimer = window.setTimeout(
      () => {
        this.midnightTimer = null;
        this.render(true);
        this.scheduleMidnightRefresh();
      },
      nextMidnight.getTime() - now.getTime() + 1000,
    );
  }

  render(force = false): void {
    if (!this.active) {
      return; // hidden pane — the next setActive(true) does a full render
    }
    const state = this.host.state();
    const today = this.now();
    if (this.monthAnchor === null) {
      this.monthAnchor = isoMonth(today);
    }
    const weekStart = this.host.weekStart();
    const weekNumbers = this.host.showWeekNumbers();
    const signature = [
      state.doc.length,
      this.monthAnchor,
      this.mode,
      this.showCompleted,
      weekStart,
      weekNumbers,
      isoDate(today),
    ].join('|');
    if (!force && signature === this.renderedSignature) {
      return;
    }
    this.renderedSignature = signature;

    const container = this.containerEl;
    container.empty();
    container.addClass('taskpaper-calendar');

    const model = calendarModel(
      outlineOf(state),
      this.monthAnchor,
      { showCompleted: this.showCompleted, weekStart },
      today,
    );
    const todayStr = isoDate(today);

    this.renderToolbar(container);
    if (this.mode === 'month') {
      this.renderMonthGrid(container, model, todayStr);
    } else {
      this.renderAgenda(container, model, todayStr);
    }
  }

  /** Toolbar: ‹ 今天 › · month · mode toggle · 顯示已完成. */
  private renderToolbar(container: HTMLElement): void {
    const header = container.createDiv({ cls: 'tp-cal-header' });
    const toolbar = header.createDiv({ cls: 'tp-cal-toolbar' });
    const navBtn = (cls: string, icon: string, label: string, onClick: () => void) => {
      const btn = toolbar.createEl('button', { cls: `tp-cal-btn ${cls}`, attr: { 'aria-label': label } });
      setIcon(btn, icon);
      btn.onclick = onClick;
      return btn;
    };
    navBtn('tp-cal-prev', 'chevron-left', '上個月', () => {
      this.monthAnchor = shiftMonth(this.monthAnchor!, -1);
      this.render();
    });
    const todayBtn = toolbar.createEl('button', { cls: 'tp-cal-btn tp-cal-today-btn', text: '今天' });
    todayBtn.onclick = () => {
      this.monthAnchor = isoMonth(this.now());
      this.render();
    };
    navBtn('tp-cal-next', 'chevron-right', '下個月', () => {
      this.monthAnchor = shiftMonth(this.monthAnchor!, 1);
      this.render();
    });

    const [y, m] = this.monthAnchor!.split('-').map(Number);
    toolbar.createSpan({ cls: 'tp-cal-month-label', text: `${y}年${m}月` });

    const right = toolbar.createDiv({ cls: 'tp-cal-toolbar-right' });
    const modeBtn = right.createEl('button', {
      cls: 'tp-cal-btn tp-cal-mode',
      attr: { 'aria-label': this.mode === 'month' ? '列表' : '月曆格' },
    });
    setIcon(modeBtn, this.mode === 'month' ? 'list' : 'calendar-days');
    modeBtn.onclick = () => {
      this.mode = this.mode === 'month' ? 'agenda' : 'month';
      this.render();
    };
    const doneBtn = right.createEl('button', {
      cls: this.showCompleted ? 'tp-cal-btn tp-cal-done-toggle is-active' : 'tp-cal-btn tp-cal-done-toggle',
      text: '顯示已完成',
    });
    doneBtn.onclick = () => {
      this.showCompleted = !this.showCompleted;
      this.render();
    };
  }

  /** The colored-dot class for an occurrence (overdue wins over plain due). */
  private roleClass(occ: CalendarOccurrence, todayStr: string): string {
    if (occ.role === 'due' && occ.date < todayStr) {
      return 'tp-cal-dot-overdue';
    }
    return `tp-cal-dot-${occ.role}`;
  }

  /** A clickable occurrence row: colored dot + tag-stripped title. */
  private renderOccurrence(
    parent: HTMLElement,
    occ: CalendarOccurrence,
    todayStr: string,
    breadcrumb: string | undefined,
  ): void {
    const el = parent.createDiv({
      cls: 'tp-cal-occ',
      attr: { 'data-line': occ.line, draggable: 'true' },
    });
    el.createSpan({ cls: `tp-cal-dot ${this.roleClass(occ, todayStr)}` });
    el.createSpan({ cls: 'tp-cal-occ-text', text: occ.text || '(空白項目)' });
    if (breadcrumb) {
      el.createSpan({ cls: 'tp-cal-occ-path', text: breadcrumb });
    }
    el.setAttr('title', occ.projectPath ? `${occ.text} — ${occ.projectPath}` : occ.text);
    el.onclick = () => this.openOccurrence(occ);
    el.addEventListener('dragstart', (e: DragEvent) => {
      this.dragOcc = occ;
      this.dragDoc = this.host.state().doc;
      el.addClass('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', occ.text);
      }
    });
    el.addEventListener('dragend', () => {
      this.dragOcc = null;
      this.dragDoc = null;
      el.removeClass('is-dragging');
      this.clearDropTargets();
    });
  }

  private clearDropTargets(): void {
    for (const marked of Array.from(this.containerEl.querySelectorAll('.tp-cal-drop'))) {
      marked.classList.remove('tp-cal-drop');
    }
  }

  /** Make a day cell / agenda section accept occurrence drops onto `date`. */
  private registerDropTarget(el: HTMLElement, date: string): void {
    el.addEventListener('dragover', (e: DragEvent) => {
      if (!this.dragOcc || this.dragOcc.date === date) {
        return;
      }
      e.preventDefault(); // marks a valid drop target
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
      this.clearDropTargets();
      el.addClass('tp-cal-drop');
    });
    el.addEventListener('dragleave', () => el.removeClass('tp-cal-drop'));
    el.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      this.clearDropTargets();
      const occ = this.dragOcc;
      const doc = this.dragDoc;
      this.dragOcc = null;
      this.dragDoc = null;
      if (occ && occ.date !== date) {
        this.rescheduleTo(occ, date, doc);
      }
    });
  }

  /** Rewrite the dragged occurrence's date tag — guarded like openOccurrence. */
  private rescheduleTo(occ: CalendarOccurrence, date: string, dragDoc: unknown): void {
    const state = this.host.state();
    const fingerprint = (line: string): string =>
      stripTags(line.replace(/^[\t ]*(?:-\s*)?/, ''));
    const stale =
      state.doc !== dragDoc ||
      occ.line + 1 > state.doc.lines ||
      fingerprint(state.doc.line(occ.line + 1).text) !== occ.text.trim();
    if (stale) {
      new Notice('文件已變更，未改期——行事曆已重新整理。');
      this.render(true);
      return;
    }
    const lineText = state.doc.line(occ.line + 1).text;
    // @today items become dated (@today is replaced, per the agreed design);
    // completed items move their @done date; everything else is @due.
    const next =
      occ.role === 'today'
        ? addTag(removeTag(lineText, 'today'), 'due', date)
        : setTagValue(lineText, occ.role === 'completed' ? 'done' : 'due', date);
    this.host.setLineText(occ.line, next);
    this.render(true);
  }

  private renderMonthGrid(container: HTMLElement, model: CalendarModel, todayStr: string): void {
    const weekStart = this.host.weekStart();
    const weekNumbers = this.host.showWeekNumbers();
    const grid = container.createDiv({
      cls: weekNumbers ? 'tp-cal-grid tp-cal-grid-weeks' : 'tp-cal-grid',
    });
    if (weekNumbers) {
      // Week-number column (W601 = ISO week 1 of 2026) before the weekday headers.
      grid.createDiv({ cls: 'tp-cal-weekday tp-cal-weeknum-head', text: 'W' });
    }
    for (let i = 0; i < 7; i++) {
      grid.createDiv({ cls: 'tp-cal-weekday', text: WEEKDAYS[(weekStart + i) % 7] });
    }
    const maxShown = 3;
    for (const week of model.weeks) {
      if (weekNumbers) {
        // ISO weeks are Monday-based: label the row by ITS Monday, or a
        // Sunday-start row would show the previous week's number for six
        // of its seven days.
        const monday =
          week.find((d) => {
            const [y, m, dd] = d.date.split('-').map(Number);
            return new Date(y, m - 1, dd).getDay() === 1;
          }) ?? week[0];
        grid.createDiv({ cls: 'tp-cal-weeknum', text: isoWeekLabel(monday.date) });
      }
      for (const day of week) {
        let cls = 'tp-cal-day';
        if (!day.inMonth) {
          cls += ' is-outside';
        }
        if (day.date === todayStr) {
          cls += ' is-today';
        }
        const cell = grid.createDiv({ cls, attr: { 'data-date': day.date } });
        this.registerDropTarget(cell, day.date);
        cell.createDiv({ cls: 'tp-cal-day-num', text: String(Number(day.date.slice(8))) });
        for (const occ of day.occurrences.slice(0, maxShown)) {
          this.renderOccurrence(cell, occ, todayStr, undefined);
        }
        if (day.occurrences.length > maxShown) {
          cell.createDiv({ cls: 'tp-cal-more', text: `+${day.occurrences.length - maxShown}` });
        }
      }
    }
  }

  /** 「7月14日 · 週二」-style section header, with 今天/明天 relative labels. */
  private dateHeading(date: string, todayStr: string): string {
    const [y, m, d] = date.split('-').map(Number);
    let heading = `${m}月${d}日 · 週${WEEKDAYS[new Date(y, m - 1, d).getDay()]}`;
    const today = this.now();
    const tomorrowStr = isoDate(
      new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1),
    );
    if (date === todayStr) {
      heading += ' · 今天';
    } else if (date === tomorrowStr) {
      heading += ' · 明天';
    }
    return heading;
  }

  private renderAgenda(container: HTMLElement, model: CalendarModel, todayStr: string): void {
    const list = container.createDiv({ cls: 'tp-cal-agenda' });
    if (model.overdue.length > 0) {
      const section = list.createDiv({ cls: 'tp-cal-section tp-cal-overdue' });
      section.createDiv({ cls: 'tp-cal-section-heading', text: '逾期' });
      for (const occ of model.overdue) {
        const [, m, d] = occ.date.split('-').map(Number);
        const when = `${m}月${d}日`;
        this.renderOccurrence(
          section,
          occ,
          todayStr,
          occ.projectPath ? `${when} · ${occ.projectPath}` : when,
        );
      }
    }
    if (model.agenda.length === 0 && model.overdue.length === 0) {
      list.createDiv({ cls: 'tp-cal-empty', text: '本月沒有排程項目' });
      return;
    }
    for (const entry of model.agenda) {
      const section = list.createDiv({ cls: 'tp-cal-section', attr: { 'data-date': entry.date } });
      this.registerDropTarget(section, entry.date);
      section.createDiv({
        cls: 'tp-cal-section-heading',
        text: this.dateHeading(entry.date, todayStr),
      });
      for (const occ of entry.occurrences) {
        this.renderOccurrence(section, occ, todayStr, occ.projectPath);
      }
    }
  }

  /** Jump to the occurrence's source line — unless the document has drifted. */
  private openOccurrence(occ: CalendarOccurrence): void {
    const doc = this.host.state().doc;
    // Staleness guard: rebuild the line's tag-stripped fingerprint and require
    // EXACT equality — a substring check could accept a different task whose
    // title merely contains the old one, and empty titles bypassed it.
    const fingerprint = (line: string): string =>
      stripTags(line.replace(/^[\t ]*(?:-\s*)?/, ''));
    const stale =
      occ.line + 1 > doc.lines ||
      fingerprint(doc.line(occ.line + 1).text) !== occ.text.trim();
    if (stale) {
      new Notice('文件已變更，找不到該項目——行事曆已重新整理。');
      this.render(true);
      return;
    }
    this.host.jumpToLine(occ.line);
  }
}
