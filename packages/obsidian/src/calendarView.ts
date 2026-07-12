import { ItemView, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
import { EditorSelection } from '@codemirror/state';
import { calendarModel, CalendarModel, CalendarOccurrence, removeAllTags } from '@taskpaper/core';
import { outlineOf } from './editor/outline';
import type TaskPaperPlugin from './main';
import type { TaskPaperView } from './view';

export const VIEW_TYPE_CALENDAR = 'taskpaper-calendar';

/** Weekday glyph by Date#getDay() index. */
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** Format a local Date as YYYY-MM-DD. */
function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Format a local Date as YYYY-MM. */
function isoMonth(d: Date): string {
  return isoDate(d).slice(0, 7);
}

/** Shift a YYYY-MM anchor by n months. */
function shiftMonth(anchor: string, n: number): string {
  const [y, m] = anchor.split('-').map(Number);
  return isoMonth(new Date(y, m - 1 + n, 1));
}

/**
 * A main-workspace calendar over the active document's dated tasks: a month
 * grid or an agenda list, fed from plugin.lastActiveView like the sidebar.
 */
export class TaskPaperCalendarView extends ItemView {
  /** 月曆格 (grid) ⇄ 列表 (agenda) — kept on the instance for the view's lifetime. */
  private mode: 'month' | 'agenda' = 'month';
  private showCompleted = false;
  /** YYYY-MM being displayed; defaults to today's month on first render. */
  private monthAnchor: string | null = null;
  /** First day of the week (1 = Monday, matching the 一二三四五六日 header). */
  private weekStart = 1;
  /** Injectable clock, so tests can pin "today". */
  now: () => Date = () => new Date();
  /** The view + content signature last rendered, to avoid needless DOM rebuilds. */
  private renderedSignature: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: TaskPaperPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_CALENDAR;
  }

  getDisplayText(): string {
    return 'TaskPaper 行事曆';
  }

  getIcon(): string {
    return 'calendar-days';
  }

  private midnightTimer: number | null = null;

  async onOpen(): Promise<void> {
    this.render(true);
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.render()));
    this.scheduleMidnightRefresh();
  }

  async onClose(): Promise<void> {
    if (this.midnightTimer !== null) {
      window.clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
    this.contentEl.empty();
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
    const view = this.plugin.lastActiveView;
    const today = this.now();
    if (this.monthAnchor === null) {
      this.monthAnchor = isoMonth(today);
    }
    const signature =
      view && view.editor
        ? [
            view.file?.path ?? '?',
            view.editor.state.doc.length,
            this.monthAnchor,
            this.mode,
            this.showCompleted,
            isoDate(today),
          ].join('|')
        : `empty|${this.mode}`;
    if (!force && signature === this.renderedSignature) {
      return;
    }
    this.renderedSignature = signature;

    const container = this.contentEl;
    container.empty();
    container.addClass('taskpaper-calendar');

    if (!view || !view.editor) {
      container.createDiv({ cls: 'tp-cal-empty', text: '開啟一個 .taskpaper 檔案' });
      return;
    }

    const model = calendarModel(
      outlineOf(view.editor.state),
      this.monthAnchor,
      { showCompleted: this.showCompleted, weekStart: this.weekStart },
      today,
    );
    const todayStr = isoDate(today);

    this.renderToolbar(container, view);
    if (this.mode === 'month') {
      this.renderMonthGrid(container, view, model, todayStr);
    } else {
      this.renderAgenda(container, view, model, todayStr);
    }
  }

  /** Header (source file) + toolbar: ‹ 今天 › · month · mode toggle · 顯示已完成. */
  private renderToolbar(container: HTMLElement, view: TaskPaperView): void {
    const header = container.createDiv({ cls: 'tp-cal-header' });
    header.createDiv({ cls: 'tp-cal-file', text: view.file?.basename ?? 'TaskPaper' });

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
    view: TaskPaperView,
    occ: CalendarOccurrence,
    todayStr: string,
    breadcrumb: string | undefined,
  ): void {
    const el = parent.createDiv({ cls: 'tp-cal-occ', attr: { 'data-line': occ.line } });
    el.createSpan({ cls: `tp-cal-dot ${this.roleClass(occ, todayStr)}` });
    el.createSpan({ cls: 'tp-cal-occ-text', text: occ.text || '(空白項目)' });
    if (breadcrumb) {
      el.createSpan({ cls: 'tp-cal-occ-path', text: breadcrumb });
    }
    el.setAttr('title', occ.projectPath ? `${occ.text} — ${occ.projectPath}` : occ.text);
    el.onclick = () => this.openOccurrence(view, occ);
  }

  private renderMonthGrid(
    container: HTMLElement,
    view: TaskPaperView,
    model: CalendarModel,
    todayStr: string,
  ): void {
    const grid = container.createDiv({ cls: 'tp-cal-grid' });
    for (let i = 0; i < 7; i++) {
      grid.createDiv({ cls: 'tp-cal-weekday', text: WEEKDAYS[(this.weekStart + i) % 7] });
    }
    const maxShown = 3;
    for (const week of model.weeks) {
      for (const day of week) {
        let cls = 'tp-cal-day';
        if (!day.inMonth) {
          cls += ' is-outside';
        }
        if (day.date === todayStr) {
          cls += ' is-today';
        }
        const cell = grid.createDiv({ cls, attr: { 'data-date': day.date } });
        cell.createDiv({ cls: 'tp-cal-day-num', text: String(Number(day.date.slice(8))) });
        for (const occ of day.occurrences.slice(0, maxShown)) {
          this.renderOccurrence(cell, view, occ, todayStr, undefined);
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

  private renderAgenda(
    container: HTMLElement,
    view: TaskPaperView,
    model: CalendarModel,
    todayStr: string,
  ): void {
    const list = container.createDiv({ cls: 'tp-cal-agenda' });
    if (model.overdue.length > 0) {
      const section = list.createDiv({ cls: 'tp-cal-section tp-cal-overdue' });
      section.createDiv({ cls: 'tp-cal-section-heading', text: '逾期' });
      for (const occ of model.overdue) {
        const [, m, d] = occ.date.split('-').map(Number);
        const when = `${m}月${d}日`;
        this.renderOccurrence(
          section,
          view,
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
      const section = list.createDiv({ cls: 'tp-cal-section' });
      section.createDiv({
        cls: 'tp-cal-section-heading',
        text: this.dateHeading(entry.date, todayStr),
      });
      for (const occ of entry.occurrences) {
        this.renderOccurrence(section, view, occ, todayStr, occ.projectPath);
      }
    }
  }

  /** Jump to the occurrence's source line — unless the document has drifted. */
  private openOccurrence(view: TaskPaperView, occ: CalendarOccurrence): void {
    const doc = view.editor.state.doc;
    // Staleness guard: rebuild the line's tag-stripped fingerprint and require
    // EXACT equality — a substring check could accept a different task whose
    // title merely contains the old one, and empty titles bypassed it.
    const fingerprint = (line: string): string =>
      removeAllTags(line).replace(/^[\t ]*(?:-\s*)?/, '').trim();
    const stale =
      occ.line + 1 > doc.lines ||
      fingerprint(doc.line(occ.line + 1).text) !== occ.text.trim();
    if (stale) {
      new Notice('文件已變更，找不到該項目——行事曆已重新整理。');
      this.render(true);
      return;
    }
    this.app.workspace.revealLeaf(view.leaf);
    view.editor.dispatch({
      selection: EditorSelection.cursor(doc.line(occ.line + 1).from),
      scrollIntoView: true,
    });
    view.editor.focus();
  }
}
