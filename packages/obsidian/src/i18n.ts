import { getLanguage } from 'obsidian';

const en = {
  doneTimeName: 'Stamp @done with time',
  doneTimeDesc: 'Include the time (HH:mm) alongside the date when marking items done.',
  archiveName: 'Archive project name',
  archiveDesc: 'The project that "Archive Done Items" collects completed tasks into.',
  archiveProjectTagName: 'Add @project tag when archiving',
  archiveProjectTagDesc:
    'Record each item’s original full project path with @project(...) when archiving (for example, @project(2026 Goals / Work)).',
  archiveRemoveTagsName: 'Remove extra tags when archiving',
  archiveRemoveTagsDesc: 'Remove every tag except @done and @project when archiving.',
  strikeDoneName: 'Strike through done items',
  strikeDoneDesc: 'Show completed (@done) items and their descendants dimmed with a strikethrough.',
  filterHideName: 'Filter hides non-matching lines',
  filterHideDesc: 'Hide non-matching lines completely when filtering. Turn this off to dim them instead.',
  calendarWeekNumbersName: 'Calendar: Show week numbers',
  calendarWeekNumbersDesc: 'Show ISO week labels to the left of the month grid (for example, W627 means week 27 of 2026).',
  calendarWeekStartName: 'Calendar: First day of week',
  calendarWeekStartDesc: 'Choose which day starts the week in calendar view.',
  monday: 'Monday',
  sunday: 'Sunday',
  calendarScopeName: 'Calendar: Scope',
  calendarScopeDesc: 'Show scheduled items from this file or every .taskpaper file in the vault. You can also switch this from the calendar toolbar.',
  currentFile: 'Current file',
  allFiles: 'All files',
  inboxFileName: 'Quick capture: Inbox file',
  inboxFileDesc: 'The .taskpaper path where Quick Capture writes tasks, relative to the vault root. It is created automatically when missing.',
  inboxProjectName: 'Quick capture: Target project',
  inboxProjectDesc: 'The project path where tasks are added (for example, Work/Inbox). Leave blank to append at the end of the document; a missing project is created automatically.',
  inboxProjectPlaceholder: 'Work/Inbox',
  globalSearchesName: 'Global searches',
  globalSearchesDesc: 'These searches appear in the Searches section of every document sidebar.',
  searchNamePlaceholder: 'Name',
  searchQueryPlaceholder: 'Query (for example, @today)',
  delete: 'Delete',
  addSearch: 'Add search',
  sidebarTagsName: 'Sidebar tags',
  includeTagsName: 'Always shown tags',
  includeTagsDesc: 'Separate tags with spaces or commas; @ is optional. Leave blank to show every tag found in the document. Listed tags remain visible when their count is 0.',
  excludeTagsName: 'Excluded tags',
  excludeTagsDesc: 'Separate tags with spaces or commas; @ is optional. These tags never appear in the sidebar.',
  defaultTodaySearch: 'Today',
  defaultNotDoneSearch: 'Not Done',
} as const;

export type TranslationKey = keyof typeof en;

const zhTw: Record<TranslationKey, string> = {
  doneTimeName: '@done 加上完成時間',
  doneTimeDesc: '將項目標記為完成時，在日期後加上時間（HH:mm）。',
  archiveName: '封存專案名稱',
  archiveDesc: '「封存已完成項目」會將完成的任務集中到這個專案。',
  archiveProjectTagName: '封存時加上 @project 標籤',
  archiveProjectTagDesc:
    '封存時以 @project(...) 記錄項目原本所屬的完整專案路徑（例如 @project(2026 目標 / 工作)）。',
  archiveRemoveTagsName: '封存時移除多餘標籤',
  archiveRemoveTagsDesc: '封存時移除 @done 與 @project 以外的所有標籤。',
  strikeDoneName: '已完成項目加上刪除線',
  strikeDoneDesc: '以淡化和刪除線顯示已完成（@done）的項目及其子項目。',
  filterHideName: '篩選時隱藏不符合的行',
  filterHideDesc: '篩選時完全隱藏不符合的行；關閉後則改為淡化顯示。',
  calendarWeekNumbersName: '行事曆：顯示週數',
  calendarWeekNumbersDesc: '月曆格左側顯示 ISO 週數標籤（例如 W627 = 2026 年第 27 週）。',
  calendarWeekStartName: '行事曆：每週起始日',
  calendarWeekStartDesc: '行事曆檢視的一週從哪一天開始。',
  monday: '週一',
  sunday: '週日',
  calendarScopeName: '行事曆：範圍',
  calendarScopeDesc: '顯示本檔或儲存庫內所有 .taskpaper 檔案的排程項目（行事曆工具列可隨時切換）。',
  currentFile: '本檔',
  allFiles: '全部',
  inboxFileName: '快速新增：收件匣檔案',
  inboxFileDesc: '「快速新增任務」寫入的 .taskpaper 檔案路徑（相對於儲存庫根目錄），不存在時會自動建立。',
  inboxProjectName: '快速新增：目標專案',
  inboxProjectDesc: '任務加入的專案路徑（例如 工作/收件匣）。留空表示加到文件末尾；專案不存在時會自動建立。',
  inboxProjectPlaceholder: '工作/收件匣',
  globalSearchesName: '全域搜尋',
  globalSearchesDesc: '這些搜尋會顯示在每份文件側邊欄的「搜尋」區段。',
  searchNamePlaceholder: '名稱',
  searchQueryPlaceholder: '查詢（例如 @today）',
  delete: '刪除',
  addSearch: '新增搜尋',
  sidebarTagsName: '側邊欄標籤',
  includeTagsName: '一律顯示的標籤',
  includeTagsDesc: '以空白或逗號分隔（可加 @）。留空表示顯示文件中找到的所有標籤；列出的標籤即使數量為 0 也會顯示。',
  excludeTagsName: '排除的標籤',
  excludeTagsDesc: '以空白或逗號分隔（可加 @）。這些標籤永遠不會出現在側邊欄。',
  defaultTodaySearch: '今日',
  defaultNotDoneSearch: '未完成',
};

export type SupportedLocale = 'en' | 'zh-TW';

/** Chinese Obsidian locales use Traditional Chinese; all others fall back to English. */
export function supportedLocale(language?: string): SupportedLocale {
  let configured = language;
  if (configured === undefined) {
    try {
      configured = typeof getLanguage === 'function' ? getLanguage() : 'en';
    } catch {
      configured = 'en';
    }
  }
  return configured.toLowerCase() === 'zh' || configured.toLowerCase().startsWith('zh-')
    ? 'zh-TW'
    : 'en';
}

/** Translate UI copy using Obsidian's configured language. */
export function t(key: TranslationKey, language?: string): string {
  return supportedLocale(language) === 'zh-TW' ? zhTw[key] : en[key];
}
