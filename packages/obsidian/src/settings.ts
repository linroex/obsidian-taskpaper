import { App, PluginSettingTab, Setting } from 'obsidian';
import type { GlobalSearch } from './sidebarLogic';
import type TaskPaperPlugin from './main';

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
      .setName('封存時加上 @project 標籤')
      .setDesc('封存時以 @project(...) 記錄項目原本所屬的完整專案路徑（例如 @project(2026 Goals / Work)）。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.addProjectTagWhenArchiving).onChange(async (v) => {
          this.plugin.settings.addProjectTagWhenArchiving = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('封存時移除多餘標籤')
      .setDesc('封存時移除 @done 與 @project 以外的所有標籤。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.removeExtraTagsWhenArchiving).onChange(async (v) => {
          this.plugin.settings.removeExtraTagsWhenArchiving = v;
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

    new Setting(containerEl)
      .setName('行事曆：顯示週數')
      .setDesc('月曆格左側顯示 ISO 週數標籤（例如 W627 = 2026 年第 27 週）。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.calendarShowWeekNumbers).onChange(async (v) => {
          this.plugin.settings.calendarShowWeekNumbers = v;
          await this.plugin.saveSettings();
          this.plugin.refreshSidebar();
        }),
      );

    new Setting(containerEl)
      .setName('行事曆：每週起始日')
      .setDesc('行事曆檢視的一週從哪一天開始。')
      .addDropdown((d) =>
        d
          .addOption('1', '週一')
          .addOption('0', '週日')
          .setValue(String(this.plugin.settings.calendarWeekStart))
          .onChange(async (v) => {
            this.plugin.settings.calendarWeekStart = Number(v);
            await this.plugin.saveSettings();
            this.plugin.refreshSidebar();
          }),
      );

    this.displayGlobalSearches(containerEl);
    this.displayTagLists(containerEl);
  }

  /** 全域搜尋 — 顯示在所有文件側邊欄的儲存搜尋（對應 TaskPaper 的 searches.taskpaper）。 */
  private displayGlobalSearches(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('全域搜尋')
      .setDesc('這些搜尋會顯示在每份文件的側邊欄 Searches 區段。')
      .setHeading();

    this.plugin.settings.globalSearches.forEach((search, index) => {
      new Setting(containerEl)
        .setClass('tp-setting-global-search')
        .addText((t) =>
          t
            .setPlaceholder('名稱')
            .setValue(search.name)
            .onChange(async (v) => {
              search.name = v;
              await this.plugin.saveSettings();
              this.plugin.refreshSidebar();
            }),
        )
        .addText((t) =>
          t
            .setPlaceholder('查詢（例如 @today）')
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
            .setTooltip('刪除')
            .onClick(async () => {
              this.plugin.settings.globalSearches.splice(index, 1);
              await this.plugin.saveSettings();
              this.plugin.refreshSidebar();
              this.display();
            }),
        );
    });

    new Setting(containerEl).addButton((b) =>
      b.setButtonText('新增搜尋').onClick(async () => {
        this.plugin.settings.globalSearches.push({ name: '', query: '' });
        await this.plugin.saveSettings();
        this.plugin.refreshSidebar();
        this.display();
      }),
    );
  }

  /** 標籤顯示清單 — 對應 TaskPaper 的 tags.taskpaper（Include Tags / Exclude Tags）。 */
  private displayTagLists(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('側邊欄標籤').setHeading();

    new Setting(containerEl)
      .setName('一律顯示的標籤')
      .setDesc('以空白或逗號分隔（可加 @）。留空表示顯示文件中找到的所有標籤；列出的標籤即使數量為 0 也會顯示。')
      .addText((t) =>
        t
          .setPlaceholder('@due @start @today @done')
          .setValue(this.plugin.settings.includeTags)
          .onChange(async (v) => {
            this.plugin.settings.includeTags = v;
            await this.plugin.saveSettings();
            this.plugin.refreshSidebar();
          }),
      );

    new Setting(containerEl)
      .setName('排除的標籤')
      .setDesc('以空白或逗號分隔（可加 @）。這些標籤永遠不會出現在側邊欄。')
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
