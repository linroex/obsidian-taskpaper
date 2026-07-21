import { App, PluginSettingTab, Setting } from 'obsidian';
import type { CalendarScope } from './calendarSources';
import type { GlobalSearch } from './sidebarLogic';
import type TaskPaperPlugin from './main';
import { t, type TranslationKey } from './i18n';

export interface TaskPaperSettings {
  doneIncludesTime: boolean;
  archiveProjectName: string;
  /** Record each archived item's original project path as @project(...) (TaskPaper's "Add project tag when archiving"). */
  addProjectTagWhenArchiving: boolean;
  /** Strip all tags except @done and @project from archived lines (TaskPaper's "Remove extra tags when archiving"). */
  removeExtraTagsWhenArchiving: boolean;
  strikeDoneItems: boolean;
  filterHidesInsteadOfDims: boolean;
  /** First day of the calendar week: 1 = Monday, 0 = Sunday. */
  calendarWeekStart: number;
  /** Collapsed sidebar rows ("project:<path>" / "tag:<name>"), persisted. */
  sidebarCollapsed: string[];
  /** Show ISO week labels (W627) in the calendar's month grid. */
  calendarShowWeekNumbers: boolean;
  /** Saved searches shown in the sidebar for every document (TaskPaper's searches.taskpaper). */
  globalSearches: GlobalSearch[];
  /** Tags always shown in the sidebar even at count 0 — space/comma separated, '@' optional. Empty = show all found tags. */
  includeTags: string;
  /** Tags never shown in the sidebar — space/comma separated, '@' optional. */
  excludeTags: string;
  /** Vault path of the file Quick Capture appends to. */
  inboxFile: string;
  /** Project path ('Work/收件匣') Quick Capture inserts under; empty = document end. */
  inboxProject: string;
  /** Calendar scope: the view's own file, or every .taskpaper file in the vault. */
  calendarScope: CalendarScope;
}

export const DEFAULT_SETTINGS: TaskPaperSettings = {
  doneIncludesTime: false,
  archiveProjectName: 'Archive',
  addProjectTagWhenArchiving: true,
  removeExtraTagsWhenArchiving: false,
  strikeDoneItems: true,
  filterHidesInsteadOfDims: true,
  calendarWeekStart: 1,
  sidebarCollapsed: [],
  calendarShowWeekNumbers: true,
  globalSearches: [
    { name: 'Today', query: '@today' },
    { name: 'Not Done', query: 'not @done' },
  ],
  includeTags: '',
  excludeTags: 'search',
  inboxFile: 'Inbox.taskpaper',
  inboxProject: '',
  calendarScope: 'file',
};

/** Localized defaults for a new vault; saved names remain user-editable data. */
export function localizedDefaultSearches(language?: string): GlobalSearch[] {
  return [
    { name: t('defaultTodaySearch', language), query: '@today' },
    { name: t('defaultNotDoneSearch', language), query: 'not @done' },
  ];
}

export class TaskPaperSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TaskPaperPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const text = (key: TranslationKey) => t(key);

    new Setting(containerEl)
      .setName(text('doneTimeName'))
      .setDesc(text('doneTimeDesc'))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.doneIncludesTime).onChange(async (v) => {
          this.plugin.settings.doneIncludesTime = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(text('archiveName'))
      .setDesc(text('archiveDesc'))
      .addText((t) =>
        t.setValue(this.plugin.settings.archiveProjectName).onChange(async (v) => {
          this.plugin.settings.archiveProjectName = v.trim() || 'Archive';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(text('archiveProjectTagName'))
      .setDesc(text('archiveProjectTagDesc'))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.addProjectTagWhenArchiving).onChange(async (v) => {
          this.plugin.settings.addProjectTagWhenArchiving = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(text('archiveRemoveTagsName'))
      .setDesc(text('archiveRemoveTagsDesc'))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.removeExtraTagsWhenArchiving).onChange(async (v) => {
          this.plugin.settings.removeExtraTagsWhenArchiving = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(text('strikeDoneName'))
      .setDesc(text('strikeDoneDesc'))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.strikeDoneItems).onChange(async (v) => {
          this.plugin.settings.strikeDoneItems = v;
          await this.plugin.saveSettings();
          this.plugin.applyBodyClasses();
        }),
      );

    new Setting(containerEl)
      .setName(text('filterHideName'))
      .setDesc(text('filterHideDesc'))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.filterHidesInsteadOfDims).onChange(async (v) => {
          this.plugin.settings.filterHidesInsteadOfDims = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(text('calendarWeekNumbersName'))
      .setDesc(text('calendarWeekNumbersDesc'))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.calendarShowWeekNumbers).onChange(async (v) => {
          this.plugin.settings.calendarShowWeekNumbers = v;
          await this.plugin.saveSettings();
          this.plugin.refreshSidebar();
        }),
      );

    new Setting(containerEl)
      .setName(text('calendarWeekStartName'))
      .setDesc(text('calendarWeekStartDesc'))
      .addDropdown((d) =>
        d
          .addOption('1', text('monday'))
          .addOption('0', text('sunday'))
          .setValue(String(this.plugin.settings.calendarWeekStart))
          .onChange(async (v) => {
            this.plugin.settings.calendarWeekStart = Number(v);
            await this.plugin.saveSettings();
            this.plugin.refreshSidebar();
          }),
      );

    new Setting(containerEl)
      .setName(text('calendarScopeName'))
      .setDesc(text('calendarScopeDesc'))
      .addDropdown((d) =>
        d
          .addOption('file', text('currentFile'))
          .addOption('vault', text('allFiles'))
          .setValue(this.plugin.settings.calendarScope)
          .onChange(async (v) => {
            this.plugin.settings.calendarScope = v === 'vault' ? 'vault' : 'file';
            await this.plugin.saveSettings();
            this.plugin.refreshSidebar();
          }),
      );

    new Setting(containerEl)
      .setName(text('inboxFileName'))
      .setDesc(text('inboxFileDesc'))
      .addText((t) =>
        t
          .setPlaceholder('Inbox.taskpaper')
          .setValue(this.plugin.settings.inboxFile)
          .onChange(async (v) => {
            this.plugin.settings.inboxFile = v.trim() || 'Inbox.taskpaper';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(text('inboxProjectName'))
      .setDesc(text('inboxProjectDesc'))
      .addText((t) =>
        t
          .setPlaceholder(text('inboxProjectPlaceholder'))
          .setValue(this.plugin.settings.inboxProject)
          .onChange(async (v) => {
            this.plugin.settings.inboxProject = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    this.displayGlobalSearches(containerEl);
    this.displayTagLists(containerEl);
  }

  /** 全域搜尋 — 顯示在所有文件側邊欄的儲存搜尋（對應 TaskPaper 的 searches.taskpaper）。 */
  private displayGlobalSearches(containerEl: HTMLElement): void {
    const text = (key: TranslationKey) => t(key);
    new Setting(containerEl)
      .setName(text('globalSearchesName'))
      .setDesc(text('globalSearchesDesc'))
      .setHeading();

    this.plugin.settings.globalSearches.forEach((search, index) => {
      new Setting(containerEl)
        .setClass('tp-setting-global-search')
        .addText((t) =>
          t
            .setPlaceholder(text('searchNamePlaceholder'))
            .setValue(search.name)
            .onChange(async (v) => {
              search.name = v;
              await this.plugin.saveSettings();
              this.plugin.refreshSidebar();
            }),
        )
        .addText((t) =>
          t
            .setPlaceholder(text('searchQueryPlaceholder'))
            .setValue(search.query)
            .onChange(async (v) => {
              search.query = v;
              await this.plugin.saveSettings();
              this.plugin.refreshSidebar();
            }),
        )
        .addExtraButton((b) =>
          b
            .setIcon('trash')
            .setTooltip(text('delete'))
            .onClick(async () => {
              this.plugin.settings.globalSearches.splice(index, 1);
              await this.plugin.saveSettings();
              this.plugin.refreshSidebar();
              this.display();
            }),
        );
    });

    new Setting(containerEl).addButton((b) =>
      b.setButtonText(text('addSearch')).onClick(async () => {
        this.plugin.settings.globalSearches.push({ name: '', query: '' });
        await this.plugin.saveSettings();
        this.plugin.refreshSidebar();
        this.display();
      }),
    );
  }

  /** 標籤顯示清單 — 對應 TaskPaper 的 tags.taskpaper（Include Tags / Exclude Tags）。 */
  private displayTagLists(containerEl: HTMLElement): void {
    const text = (key: TranslationKey) => t(key);
    new Setting(containerEl).setName(text('sidebarTagsName')).setHeading();

    new Setting(containerEl)
      .setName(text('includeTagsName'))
      .setDesc(text('includeTagsDesc'))
      .addText((t) =>
        t
          .setPlaceholder('@at @due @start @today @done')
          .setValue(this.plugin.settings.includeTags)
          .onChange(async (v) => {
            this.plugin.settings.includeTags = v;
            await this.plugin.saveSettings();
            this.plugin.refreshSidebar();
          }),
      );

    new Setting(containerEl)
      .setName(text('excludeTagsName'))
      .setDesc(text('excludeTagsDesc'))
      .addText((t) =>
        t
          .setPlaceholder('@search')
          .setValue(this.plugin.settings.excludeTags)
          .onChange(async (v) => {
            this.plugin.settings.excludeTags = v;
            await this.plugin.saveSettings();
            this.plugin.refreshSidebar();
          }),
      );
  }
}
