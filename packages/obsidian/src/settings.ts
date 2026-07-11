import { App, PluginSettingTab, Setting } from 'obsidian';
import type TaskPaperPlugin from './main';

export interface TaskPaperSettings {
  doneIncludesTime: boolean;
  archiveProjectName: string;
  strikeDoneItems: boolean;
  filterHidesInsteadOfDims: boolean;
}

export const DEFAULT_SETTINGS: TaskPaperSettings = {
  doneIncludesTime: false,
  archiveProjectName: 'Archive',
  strikeDoneItems: true,
  filterHidesInsteadOfDims: true,
};

export class TaskPaperSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TaskPaperPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Stamp @done with time')
      .setDesc('Include the time (HH:mm) alongside the date when marking items done.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.doneIncludesTime).onChange(async (v) => {
          this.plugin.settings.doneIncludesTime = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Archive project name')
      .setDesc('The project that "Archive Done Items" collects completed tasks into.')
      .addText((t) =>
        t.setValue(this.plugin.settings.archiveProjectName).onChange(async (v) => {
          this.plugin.settings.archiveProjectName = v.trim() || 'Archive';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Strike through done items')
      .setDesc('Show completed (@done) items dimmed with a strikethrough.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.strikeDoneItems).onChange(async (v) => {
          this.plugin.settings.strikeDoneItems = v;
          await this.plugin.saveSettings();
          this.plugin.applyBodyClasses();
        }),
      );

    new Setting(containerEl)
      .setName('Filter hides non-matching lines')
      .setDesc('When filtering, hide non-matching lines entirely. Turn off to dim them instead.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.filterHidesInsteadOfDims).onChange(async (v) => {
          this.plugin.settings.filterHidesInsteadOfDims = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
