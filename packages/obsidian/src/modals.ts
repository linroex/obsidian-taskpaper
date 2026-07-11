import { App, FuzzySuggestModal, Modal, Notice } from 'obsidian';
import { Item, parseQuery, resolveDateExpression } from '@taskpaper/core';
import type { PaletteEntry } from './paletteEntries';

/** Prompts for a TaskPaper query. Calls onSubmit(query) or onSubmit(null) to clear. */
export class QueryModal extends Modal {
  constructor(
    app: App,
    private initial: string,
    private onSubmit: (query: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'TaskPaper filter' });

    const input = contentEl.createEl('input', { type: 'text' });
    input.value = this.initial;
    input.placeholder = '@today   |   not @done and task   |   @due <= today [d]';
    input.addClass('tp-query-input');
    input.style.width = '100%';

    // Live validation (TaskPaper 3: a malformed search highlights red).
    // Empty input stays valid — submitting it clears the filter.
    const errorEl = contentEl.createDiv({ cls: 'tp-query-error-msg' });
    const validate = () => {
      const value = input.value.trim();
      let message = '';
      if (value.length > 0) {
        try {
          parseQuery(value);
        } catch (e) {
          message = `查詢語法錯誤：${e instanceof Error ? e.message : String(e)}`;
        }
      }
      input.toggleClass('tp-query-error', message.length > 0);
      errorEl.setText(message);
    };
    input.addEventListener('input', validate);
    validate();

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit(input.value);
      } else if (e.key === 'Escape') {
        this.close();
      }
    });

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const filterBtn = buttons.createEl('button', { text: 'Filter', cls: 'mod-cta' });
    filterBtn.addEventListener('click', () => this.submit(input.value));
    const clearBtn = buttons.createEl('button', { text: 'Clear filter' });
    clearBtn.addEventListener('click', () => {
      this.onSubmit(null);
      this.close();
    });
  }

  private submit(value: string): void {
    const trimmed = value.trim();
    this.onSubmit(trimmed.length > 0 ? trimmed : null);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Optional prefill for SaveSearchModal (used when editing an existing search). */
export interface SaveSearchInitial {
  title?: string;
  name?: string;
  query?: string;
}

/** Prompts for a query + name to store as a saved search. */
export class SaveSearchModal extends Modal {
  constructor(
    app: App,
    private onSubmit: (name: string, query: string) => void,
    private initial?: SaveSearchInitial,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.initial?.title ?? 'Save search' });

    contentEl.createEl('label', { text: 'Query', cls: 'tp-field-label' });
    const query = contentEl.createEl('input', { type: 'text' });
    query.value = this.initial?.query ?? '@today and not @done';
    query.style.width = '100%';

    contentEl.createEl('label', { text: 'Name', cls: 'tp-field-label' });
    const name = contentEl.createEl('input', { type: 'text' });
    name.value = this.initial?.name ?? '';
    name.style.width = '100%';

    window.setTimeout(() => query.focus(), 0);
    const submit = () => {
      const q = query.value.trim();
      if (q.length === 0) {
        return;
      }
      this.onSubmit(name.value.trim() || q, q);
      this.close();
    };
    for (const el of [query, name]) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
    }

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = buttons.createEl('button', { text: 'Save', cls: 'mod-cta' });
    ok.addEventListener('click', submit);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Prompts for a single line of text (e.g. the name of a new group project). */
export class TextPromptModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private placeholder: string,
    private onSubmit: (value: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.title });

    const input = contentEl.createEl('input', { type: 'text' });
    input.placeholder = this.placeholder;
    input.style.width = '100%';
    window.setTimeout(() => input.focus(), 0);

    const submit = () => {
      const value = input.value.trim();
      if (value.length === 0) {
        return;
      }
      this.onSubmit(value);
      this.close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        this.close();
      }
    });

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = buttons.createEl('button', { text: 'OK', cls: 'mod-cta' });
    ok.addEventListener('click', submit);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Prompts for a natural-language date ("tomorrow", "next fri", "2026-07-20"),
 * previewing the resolved ISO date live; submits the ISO string.
 */
export class DateModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private onSubmit: (isoDate: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.title });

    const input = contentEl.createEl('input', { type: 'text' });
    input.placeholder = 'tomorrow, next fri, 2026-07-20';
    input.style.width = '100%';
    const preview = contentEl.createDiv({ cls: 'tp-date-preview' });

    const resolved = (): string | null => {
      const expr = input.value.trim();
      return expr.length > 0 ? resolveDateExpression(expr) : null;
    };
    const update = () => {
      const iso = resolved();
      preview.setText(
        iso ? `→ ${iso}` : input.value.trim().length > 0 ? '（無法解析的日期）' : '',
      );
    };
    input.addEventListener('input', update);
    update();
    window.setTimeout(() => input.focus(), 0);

    const submit = () => {
      const iso = resolved();
      if (!iso) {
        return;
      }
      this.onSubmit(iso);
      this.close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        this.close();
      }
    });

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = buttons.createEl('button', { text: 'OK', cls: 'mod-cta' });
    ok.addEventListener('click', submit);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** A tag staged in the Tag with… modal ('' / undefined value = bare @name). */
export interface StagedTag {
  name: string;
  value?: string;
}

const TAG_INPUT_RE = /^@?([A-Za-z0-9._-]+)(?:\((.*)\))?$/;

/**
 * "Tag with…" multi-select (original: Shift-Up/Down in the tag palette
 * selects several tags): lists the known tag names (document tags +
 * defaults) as checkbox rows. Interactions:
 *
 *  - clicking a row toggles that tag in the staged set (modal stays open)
 *  - typing filters the list; Enter with text stages the typed tag
 *    (custom `@name(value)` accepted) and clears the input
 *  - Enter with an EMPTY input, Mod-Enter, or the 套用 button applies every
 *    staged toggle to the selected lines at once and closes
 */
export class TagMultiSelectModal extends Modal {
  private staged = new Map<string, string | undefined>();
  private listEl!: HTMLElement;
  private input!: HTMLInputElement;

  constructor(
    app: App,
    private knownNames: string[],
    private onSubmit: (tags: StagedTag[]) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Tag with…' });
    contentEl.createDiv({
      cls: 'tp-tag-multi-hint',
      text: '點選切換標籤；輸入後按 Enter 加入自訂標籤；Enter（空白輸入）、Mod-Enter 或「套用」套用全部。',
    });

    this.input = contentEl.createEl('input', { type: 'text' });
    this.input.placeholder = 'flag   |   @priority(1)';
    this.input.addClass('tp-tag-multi-input');
    this.input.style.width = '100%';
    this.input.addEventListener('input', () => this.renderList());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.stageTyped();
        this.apply();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this.input.value.trim().length === 0) {
          this.apply();
        } else {
          this.stageTyped();
        }
      } else if (e.key === 'Escape') {
        this.close();
      }
    });
    window.setTimeout(() => this.input.focus(), 0);

    this.listEl = contentEl.createDiv({ cls: 'tp-tag-multi-list' });
    this.renderList();

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = buttons.createEl('button', { text: '套用', cls: 'mod-cta' });
    ok.addEventListener('click', () => this.apply());
    const cancel = buttons.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
  }

  /** Toggle a tag's presence in the staged set (staying open). */
  private toggle(name: string, value?: string): void {
    if (this.staged.has(name)) {
      this.staged.delete(name);
    } else {
      this.staged.set(name, value);
    }
    this.renderList();
  }

  /** Stage the tag typed in the input, if any (custom @name(value) accepted). */
  private stageTyped(): void {
    const raw = this.input.value.trim();
    if (raw.length === 0) {
      return;
    }
    const match = TAG_INPUT_RE.exec(raw);
    if (!match) {
      new Notice(`"${raw}" is not a valid tag.`);
      return;
    }
    this.input.value = '';
    this.toggle(match[1], match[2]);
  }

  private apply(): void {
    if (this.staged.size > 0) {
      this.onSubmit([...this.staged].map(([name, value]) => ({ name, value })));
    }
    this.close();
  }

  private renderList(): void {
    const filter = this.input.value.trim().replace(/^@/, '').toLowerCase();
    // Staged custom names appear in the list too, so they can be un-toggled.
    const names = [...new Set([...this.knownNames, ...this.staged.keys()])].sort();
    this.listEl.empty();
    for (const name of names) {
      if (filter.length > 0 && !name.toLowerCase().includes(filter)) {
        continue;
      }
      const staged = this.staged.has(name);
      const row = this.listEl.createDiv({
        cls: 'tp-tag-multi-row',
        attr: { 'data-tag': name },
      });
      row.toggleClass('is-staged', staged);
      row.createSpan({ cls: 'tp-tag-multi-check', text: staged ? '☑' : '☐' });
      const value = this.staged.get(name);
      row.createSpan({ text: value ? `@${name}(${value})` : `@${name}` });
      row.addEventListener('click', () => this.toggle(name));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** A saved search offered by the "Go to search…" quick-pick. */
export interface SearchEntry {
  name: string;
  query: string;
  /** True for searches from the plugin settings (shown in every document). */
  global: boolean;
}

/** Fuzzy quick-pick over all saved searches (global + document). */
export class SearchSuggestModal extends FuzzySuggestModal<SearchEntry> {
  constructor(
    app: App,
    private searches: SearchEntry[],
    private onChoose: (entry: SearchEntry) => void,
    placeholder = 'Go to search',
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): SearchEntry[] {
    return this.searches;
  }

  getItemText(entry: SearchEntry): string {
    return `${entry.name}${entry.global ? '（全域）' : ''} — ${entry.query}`;
  }

  onChooseItem(entry: SearchEntry): void {
    this.onChoose(entry);
  }
}

/**
 * Fuzzy quick-pick over palette entries (Go to anything… / Go to tag…) —
 * thin glue over FuzzySuggestModal; the entries and their actions live in
 * paletteEntries.ts.
 */
export class PaletteSuggestModal extends FuzzySuggestModal<PaletteEntry> {
  constructor(
    app: App,
    private entries: PaletteEntry[],
    private onChoose: (entry: PaletteEntry) => void,
    placeholder: string,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): PaletteEntry[] {
    return this.entries;
  }

  getItemText(entry: PaletteEntry): string {
    return entry.text;
  }

  onChooseItem(entry: PaletteEntry): void {
    this.onChoose(entry);
  }
}

/** Fuzzy quick-pick over the projects in a document. */
export class ProjectSuggestModal extends FuzzySuggestModal<Item> {
  constructor(
    app: App,
    private projects: Item[],
    private onChoose: (item: Item) => void,
    placeholder = 'Go to project',
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): Item[] {
    return this.projects;
  }

  getItemText(item: Item): string {
    return '  '.repeat(item.level) + item.displayText;
  }

  onChooseItem(item: Item): void {
    this.onChoose(item);
  }
}
