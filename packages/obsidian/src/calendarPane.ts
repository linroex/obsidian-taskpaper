import { Notice, setIcon } from 'obsidian';
import {
  CalendarOptions,
  CalendarRole,
  isoDate,
  isoMonth,
  isoWeekLabel,
} from '@taskpaper/core';
import type {
  CalendarScope,
  SourcedCalendarModel,
  SourcedOccurrence,
} from './calendarSources';

/** Weekday glyph by Date#getDay() index. */
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** Shift a YYYY-MM anchor by n months. */
function shiftMonth(anchor: string, n: number): string {
  const [y, m] = anchor.split('-').map(Number);
  return isoMonth(new Date(y, m - 1 + n, 1));
}

/**
 * What the embedded calendar needs from its owner. The host is source-aware
 * (see createCalendarHost): occurrences carry {path, line, fingerprint}
 * identity, and all staleness guards + Notices live host-side, so the pane
 * renders and delegates without scope conditionals.
 */
export interface CalendarHost {
  /** The merged month model over the current scope. */
  getOccurrences(monthAnchor: string, opts: CalendarOptions, today: Date): SourcedCalendarModel;
  /** Render-guard token: a different value invalidates the cached render. */
  version(): string;
  /** Drag-guard token: a drop is refused when it changed since dragstart. */
  changeToken(): unknown;
  /** First day of the week: 1 = Monday, 0 = Sunday (user setting). */
  weekStart(): number;
  /** Whether the month grid shows ISO week labels (W627). */
  showWeekNumbers(): boolean;
  /** 本檔 (own file) ⇄ 全部 (every .taskpaper file), persisted as a setting. */
  scope(): CalendarScope;
  setScope(scope: CalendarScope): void;
  /** Jump to an occurrence's source line (the host verifies it first). */
  openOccurrence(occ: SourcedOccurrence): void;
  /** Rewrite an occurrence's date tag (drag-reschedule). */
  rescheduleOccurrence(occ: SourcedOccurrence, date: string): void;
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
  private dragOcc: SourcedOccurrence | null = null;
  /** Change token at dragstart — a changed scope rejects the drop. */
  private dragToken: unknown = null;

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
    const today = this.now();
    if (this.monthAnchor === null) {
      this.monthAnchor = isoMonth(today);
    }
    const weekStart = this.host.weekStart();
    const weekNumbers = this.host.showWeekNumbers();
    const signature = [
      this.host.version(),
      this.host.scope(),
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

    // Rebuilding destroys the dragged element, so its dragend never fires —
    // clear the drag state here or a LATER unrelated drop could reschedule
    // the occurrence left behind.
    this.dragOcc = null;
    this.dragToken = null;

    const container = this.containerEl;
    container.empty();
    container.addClass('taskpaper-calendar');

    const model = this.host.getOccurrences(
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

  /** Toolbar: ‹ 今天 › · month · scope toggle · mode toggle · 顯示已完成. */
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
    // 本檔 | 全部 — segmented scope toggle, persisted by the host.
    const scopeWrap = right.createDiv({ cls: 'tp-cal-scope' });
    const scopeBtn = (label: string, value: CalendarScope) => {
      const active = this.host.scope() === value;
      const btn = scopeWrap.createEl('button', {
        cls: active ? 'tp-cal-btn tp-cal-scope-btn is-active' : 'tp-cal-btn tp-cal-scope-btn',
        text: label,
        attr: { 'data-scope': value },
      });
      btn.onclick = () => {
        if (this.host.scope() !== value) {
          this.host.setScope(value);
          this.render(true);
        }
      };
    };
    scopeBtn('本檔', 'file');
    scopeBtn('全部', 'vault');

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

  /** The colored-dot class for one role (overdue wins over plain due). */
  private roleClass(role: CalendarRole, occ: SourcedOccurrence, todayStr: string): string {
    if (role === 'due' && occ.date < todayStr) {
      return 'tp-cal-dot-overdue';
    }
    return `tp-cal-dot-${role}`;
  }

  /** A clickable occurrence row: role dots + optional time + plain title. */
  private renderOccurrence(
    parent: HTMLElement,
    occ: SourcedOccurrence,
    todayStr: string,
    breadcrumb: string | undefined,
  ): void {
    const el = parent.createDiv({
      cls: 'tp-cal-occ',
      attr: {
        'data-line': occ.line,
        'data-path': occ.source.path,
        'data-roles': occ.roles.join(','),
        draggable: 'true',
      },
    });
    for (const role of occ.roles) {
      el.createSpan({ cls: `tp-cal-dot ${this.roleClass(role, occ, todayStr)}` });
    }
    if (occ.time) {
      el.createSpan({ cls: 'tp-cal-occ-time', text: occ.time });
    }
    el.createSpan({ cls: 'tp-cal-occ-text', text: occ.text || '(空白項目)' });
    if (occ.badge) {
      el.createSpan({ cls: 'tp-cal-occ-badge', text: occ.badge });
    }
    if (breadcrumb) {
      el.createSpan({ cls: 'tp-cal-occ-path', text: breadcrumb });
    }
    const title = occ.time ? `${occ.time} ${occ.text}` : occ.text;
    el.setAttr('title', occ.projectPath ? `${title} — ${occ.projectPath}` : title);
    el.onclick = () => this.host.openOccurrence(occ);
    el.addEventListener('dragstart', (e: DragEvent) => {
      this.dragOcc = occ;
      this.dragToken = this.host.changeToken();
      el.addClass('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', occ.text);
      }
    });
    el.addEventListener('dragend', () => {
      this.dragOcc = null;
      this.dragToken = null;
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
      const token = this.dragToken;
      this.dragOcc = null;
      this.dragToken = null;
      if (!occ || occ.date === date) {
        return;
      }
      // Anything in scope changed mid-drag → the model behind the drag is
      // stale; refuse rather than rewrite a possibly different line.
      if (this.host.changeToken() !== token) {
        new Notice('文件已變更，未改期——行事曆已重新整理。');
        this.render(true);
        return;
      }
      this.host.rescheduleOccurrence(occ, date);
      this.render(true);
    });
  }

  private renderMonthGrid(container: HTMLElement, model: SourcedCalendarModel, todayStr: string): void {
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

  private renderAgenda(container: HTMLElement, model: SourcedCalendarModel, todayStr: string): void {
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
}
