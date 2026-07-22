/**
 * Localized reference content for the filter query language, rendered by
 * FilterHelpModal (the "?" at the right end of the searchbar). Pure data so
 * tests can assert the copy without a DOM.
 */
import { supportedLocale } from './i18n';

export interface FilterHelpRow {
  code: string;
  desc: string;
}

export interface FilterHelpSection {
  title: string;
  rows: FilterHelpRow[];
}

const ZH: FilterHelpSection[] = [
  {
    title: '基本',
    rows: [
      { code: '@today', desc: '有 @today 標籤的項目' },
      { code: 'not @done', desc: '沒有 @done 標籤的項目' },
      { code: '買菜', desc: '內文包含「買菜」（不分大小寫；含空白時用引號："買 菜"）' },
      { code: 'task / project / note', desc: '依項目類型篩選；* 表示任何項目' },
      { code: '@today not @done', desc: '並列即「而且」（and 可省略）' },
    ],
  },
  {
    title: '標籤值比較',
    rows: [
      { code: '@waiting = bob', desc: '標籤值等於 bob（= != < > <= >=）' },
      { code: '@priority >[n] 1', desc: '[n]：以數字比較' },
      { code: '@due <=[d] today', desc: '[d]：以日期比較（今天以前，含今天）' },
      { code: '@start >[d] today', desc: '開始日在今天 00:00 之後' },
      { code: '@assignee contains bo', desc: '也有 beginswith、endswith、matches（正規表達式）' },
      {
        code: '@due <= today [d]',
        desc: '修飾詞可放關係後（<=[d]）或值後（... [d]）；[s] 區分大小寫、[l] 逗號列表',
      },
    ],
  },
  {
    title: '日期寫法（搭配 [d]）',
    rows: [
      { code: 'today / tomorrow / yesterday', desc: '解析為當天 00:00' },
      { code: 'now', desc: '現在時刻（標籤值含時間時適用）' },
      { code: 'next monday', desc: '星期幾、next／last week 等' },
      { code: '"today + 3 days"', desc: '相對運算式（含空白要加引號）' },
      { code: '2026-08-01 18:00', desc: 'ISO 日期，可帶時間' },
    ],
  },
  {
    title: '組合與集合',
    rows: [
      { code: '(@today or @flagged) and not @done', desc: 'and／or／not 與括號' },
      { code: '@today union @flagged', desc: '聯集；還有 intersect（交集）、except（差集）' },
    ],
  },
  {
    title: '路徑與進階',
    rows: [
      { code: 'project 工作//@today', desc: '「工作」專案底下所有 @today' },
      { code: '/task', desc: '/ 只找直接子項；// 找所有後代' },
      { code: 'level = 1', desc: '內建屬性：text、type、line、level' },
      { code: '@today[0]', desc: '切片：第一個符合項；[0:3] 前三個；[-1] 最後一個' },
      { code: 'ancestor::@goal', desc: '軸向：parent、ancestor、following-sibling…' },
    ],
  },
];

const EN: FilterHelpSection[] = [
  {
    title: 'Basics',
    rows: [
      { code: '@today', desc: 'Items carrying the @today tag' },
      { code: 'not @done', desc: 'Items without the @done tag' },
      { code: 'groceries', desc: 'Text search (case-insensitive; quote phrases: "buy milk")' },
      { code: 'task / project / note', desc: 'Filter by item type; * matches any item' },
      { code: '@today not @done', desc: 'Juxtaposition means AND (the word is optional)' },
    ],
  },
  {
    title: 'Tag value comparisons',
    rows: [
      { code: '@waiting = bob', desc: 'Tag value equals bob (= != < > <= >=)' },
      { code: '@priority >[n] 1', desc: '[n]: compare as numbers' },
      { code: '@due <=[d] today', desc: '[d]: compare as dates (due today or earlier)' },
      { code: '@start >[d] today', desc: 'Start date after today 00:00' },
      { code: '@assignee contains bo', desc: 'Also beginswith, endswith, matches (regex)' },
      {
        code: '@due <= today [d]',
        desc: 'Modifiers go after the relation (<=[d]) or after the value (... [d]); [s] case-sensitive, [l] comma lists',
      },
    ],
  },
  {
    title: 'Date expressions (with [d])',
    rows: [
      { code: 'today / tomorrow / yesterday', desc: 'Resolve to local midnight' },
      { code: 'now', desc: 'The current moment (for tag values with times)' },
      { code: 'next monday', desc: 'Weekdays, next/last week, and friends' },
      { code: '"today + 3 days"', desc: 'Relative expressions (quote when they contain spaces)' },
      { code: '2026-08-01 18:00', desc: 'ISO dates, optionally with a time' },
    ],
  },
  {
    title: 'Combining and set operations',
    rows: [
      { code: '(@today or @flagged) and not @done', desc: 'and / or / not with parentheses' },
      { code: '@today union @flagged', desc: 'Union; also intersect and except' },
    ],
  },
  {
    title: 'Paths and advanced',
    rows: [
      { code: 'project Work//@today', desc: 'Every @today under the Work project' },
      { code: '/task', desc: '/ direct children; // all descendants' },
      { code: 'level = 1', desc: 'Built-in attributes: text, type, line, level' },
      { code: '@today[0]', desc: 'Slices: first match; [0:3] first three; [-1] last' },
      { code: 'ancestor::@goal', desc: 'Axes: parent, ancestor, following-sibling…' },
    ],
  },
];

/** The help sections in the user's Obsidian language (zh-TW or English). */
export function filterHelpSections(language?: string): FilterHelpSection[] {
  return supportedLocale(language) === 'zh-TW' ? ZH : EN;
}

/** The modal heading, matching the searchbar's language. */
export function filterHelpTitle(language?: string): string {
  return supportedLocale(language) === 'zh-TW' ? '篩選語法說明' : 'Filter syntax';
}
