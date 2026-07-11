import { App, FuzzySuggestModal, Modal } from 'obsidian';
import { Item, resolveDateExpression } from '@taskpaper/core';

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

/** Prompts for a query + name to store as a saved search. */
export class SaveSearchModal extends Modal {
  constructor(
    app: App,
    private onSubmit: (name: string, query: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Save search' });

    contentEl.createEl('label', { text: 'Query', cls: 'tp-field-label' });
    const query = contentEl.createEl('input', { type: 'text' });
    query.value = '@today and not @done';
    query.style.width = '100%';

    contentEl.createEl('label', { text: 'Name', cls: 'tp-field-label' });
    const name = contentEl.createEl('input', { type: 'text' });
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
