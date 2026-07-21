import { App, Modal } from 'obsidian';
import { normalizeCaptureText } from '@taskpaper/core';

/**
 * Quick-capture prompt: a single line of text destined for the inbox file.
 * Shows the target (file › project) and a live preview of the normalized
 * line (`- ` prefix, natural-language dates in @at/@due/@start/@defer resolved).
 * Enter submits, Escape cancels. Natural dates in @at/@due/@start/@defer are
 * normalized by the shared capture planner before insertion.
 */
export class CaptureModal extends Modal {
  constructor(
    app: App,
    private targetFile: string,
    private targetProject: string,
    private onSubmit: (taskLine: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '快速新增任務' });

    const input = contentEl.createEl('input', { type: 'text' });
    input.placeholder = '買牛奶 @due(tomorrow)';
    input.addClass('tp-capture-input');
    input.style.width = '100%';

    contentEl.createDiv({
      cls: 'tp-capture-target',
      text: this.targetProject
        ? `→ ${this.targetFile} › ${this.targetProject}`
        : `→ ${this.targetFile}`,
    });
    const preview = contentEl.createDiv({ cls: 'tp-capture-preview' });

    const update = () => preview.setText(normalizeCaptureText(input.value));
    input.addEventListener('input', update);
    update();
    window.setTimeout(() => input.focus(), 0);

    const submit = () => {
      const line = normalizeCaptureText(input.value);
      if (line.length === 0) {
        return;
      }
      this.onSubmit(line);
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
    const ok = buttons.createEl('button', { text: '加入', cls: 'mod-cta' });
    ok.addEventListener('click', submit);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
