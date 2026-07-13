/**
 * Minimal 'obsidian' module stub for headless/jsdom tests. The e2e bundle
 * aliases `obsidian` to this file so plugin code that imports it can run
 * under node + jsdom. Everything is deliberately dumb but functional:
 * DOM-based where Obsidian is DOM-based, recording where Obsidian shows UI
 * (Menu keeps its items, Notice keeps its messages, modals store callbacks
 * and expose .open()).
 *
 * Obsidian also augments HTMLElement.prototype (createDiv/createEl/empty/
 * addClass/…); call installDomHelpers(window) once a jsdom window exists so
 * that plugin DOM code works too.
 */

// ---------------------------------------------------------------------------
// HTMLElement prototype helpers (Obsidian's global DOM augmentation)
// ---------------------------------------------------------------------------

interface DomElementInfo {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  href?: string;
}

function applyInfo(el: HTMLElement, info?: DomElementInfo | string): void {
  if (typeof info === 'string') {
    el.className = info;
    return;
  }
  if (!info) {
    return;
  }
  if (info.cls) {
    const classes = Array.isArray(info.cls) ? info.cls : info.cls.split(/\s+/);
    el.classList.add(...classes.filter((c) => c.length > 0));
  }
  if (info.text !== undefined) {
    el.textContent = info.text;
  }
  if (info.title !== undefined) {
    el.title = info.title;
  }
  if (info.attr) {
    for (const [k, v] of Object.entries(info.attr)) {
      if (v !== null) {
        el.setAttribute(k, String(v));
      }
    }
  }
  const input = el as HTMLInputElement;
  if (info.type !== undefined) {
    input.type = info.type;
  }
  if (info.value !== undefined) {
    input.value = info.value;
  }
  if (info.placeholder !== undefined) {
    input.placeholder = info.placeholder;
  }
  if (info.href !== undefined) {
    (el as unknown as HTMLAnchorElement).href = info.href;
  }
}

/** Install Obsidian's HTMLElement helpers onto a (jsdom) window. */
export function installDomHelpers(win: { HTMLElement: typeof HTMLElement }): void {
  const proto = win.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.createEl = function (
    this: HTMLElement,
    tag: string,
    info?: DomElementInfo | string,
    callback?: (el: HTMLElement) => void,
  ): HTMLElement {
    const el = this.ownerDocument.createElement(tag);
    applyInfo(el, info);
    this.appendChild(el);
    callback?.(el);
    return el;
  };
  proto.createDiv = function (
    this: HTMLElement & { createEl(t: string, i?: unknown, c?: unknown): HTMLElement },
    info?: DomElementInfo | string,
    callback?: (el: HTMLElement) => void,
  ): HTMLElement {
    return this.createEl('div', info, callback);
  };
  proto.createSpan = function (
    this: HTMLElement & { createEl(t: string, i?: unknown, c?: unknown): HTMLElement },
    info?: DomElementInfo | string,
    callback?: (el: HTMLElement) => void,
  ): HTMLElement {
    return this.createEl('span', info, callback);
  };
  proto.empty = function (this: HTMLElement): void {
    while (this.firstChild) {
      this.removeChild(this.firstChild);
    }
  };
  proto.setText = function (this: HTMLElement, text: string): void {
    this.textContent = text;
  };
  proto.addClass = function (this: HTMLElement, ...classes: string[]): void {
    this.classList.add(...classes);
  };
  proto.removeClass = function (this: HTMLElement, ...classes: string[]): void {
    this.classList.remove(...classes);
  };
  proto.toggleClass = function (this: HTMLElement, classes: string | string[], value: boolean): void {
    for (const cls of Array.isArray(classes) ? classes : [classes]) {
      this.classList.toggle(cls, value);
    }
  };
  proto.detach = function (this: HTMLElement): void {
    this.remove();
  };
  proto.setAttr = function (
    this: HTMLElement,
    name: string,
    value: string | number | boolean | null,
  ): void {
    if (value === null) {
      this.removeAttribute(name);
    } else {
      this.setAttribute(name, String(value));
    }
  };
}

// ---------------------------------------------------------------------------
// Icons / notices
// ---------------------------------------------------------------------------

export function setIcon(el: HTMLElement, icon: string): void {
  el.setAttribute('data-icon', icon);
}

/** Obsidian's path normalization: forward slashes, no leading `./`, trimmed. */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '');
}

export class Notice {
  static messages: string[] = [];
  constructor(message: string) {
    Notice.messages.push(message);
  }
}

// ---------------------------------------------------------------------------
// App / workspace / files
// ---------------------------------------------------------------------------

export class TFolder {
  constructor(public path = '/') {}
}

export class TFile {
  parent: TFolder | null = new TFolder();
  /** Freshness key for caches (create/process keep it current). */
  stat = { mtime: 0, size: 0 };
  constructor(
    public path = 'test.taskpaper',
    public basename = 'test',
    public extension = 'taskpaper',
  ) {}
}

export class MetadataCache {
  /** linkpath → file mappings tests register; everything else is unresolved. */
  files = new Map<string, TFile>();
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  getFirstLinkpathDest(linkpath: string, _sourcePath: string): TFile | null {
    return this.files.get(linkpath) ?? null;
  }

  on(name: string, cb: (...args: unknown[]) => void): { name: string; cb: unknown } {
    const list = this.handlers.get(name) ?? [];
    list.push(cb);
    this.handlers.set(name, list);
    return { name, cb };
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(name) ?? []) {
      cb(...args);
    }
  }
}

export class Workspace {
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  leaves: WorkspaceLeaf[] = [];
  /** Every openLinkText call, for assertions. */
  openedLinkTexts: { linktext: string; sourcePath: string }[] = [];

  on(name: string, cb: (...args: unknown[]) => void): { name: string; cb: unknown } {
    const list = this.handlers.get(name) ?? [];
    list.push(cb);
    this.handlers.set(name, list);
    return { name, cb };
  }
  trigger(name: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(name) ?? []) {
      cb(...args);
    }
  }
  getActiveViewOfType<T>(_type: new (...args: never[]) => T): T | null {
    return null;
  }
  getLeavesOfType(_type: string): WorkspaceLeaf[] {
    return this.leaves;
  }
  getRightLeaf(_split: boolean): WorkspaceLeaf | null {
    return new WorkspaceLeaf();
  }
  getLeaf(_type?: unknown): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf();
    this.leaves.push(leaf);
    return leaf;
  }
  revealLeaf(_leaf: WorkspaceLeaf): void {}
  async openLinkText(linktext: string, sourcePath: string): Promise<void> {
    this.openedLinkTexts.push({ linktext, sourcePath });
  }
}

export class Vault {
  adapter: Record<string, unknown> = {};
  /** In-memory file tree: path -> TFile/TFolder, path -> content. */
  files = new Map<string, TFile>();
  folders = new Map<string, TFolder>();
  contents = new Map<string, string>();
  /** Recorded create/createFolder calls, in order. */
  created: string[] = [];
  createdFolders: string[] = [];
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  private mtime = 1;

  on(name: string, cb: (...args: unknown[]) => void): { name: string; cb: unknown } {
    const list = this.handlers.get(name) ?? [];
    list.push(cb);
    this.handlers.set(name, list);
    return { name, cb };
  }
  trigger(name: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(name) ?? []) {
      cb(...args);
    }
  }
  getAbstractFileByPath(path: string): TFile | TFolder | null {
    return this.files.get(path) ?? this.folders.get(path) ?? null;
  }
  getFiles(): TFile[] {
    return [...this.files.values()];
  }
  async cachedRead(file: TFile): Promise<string> {
    return this.contents.get(file.path) ?? '';
  }
  async create(path: string, data: string): Promise<TFile> {
    const base = path.split('/').pop() ?? path;
    const file = new TFile(path, base.replace(/\.[^.]+$/, ''), base.split('.').pop() ?? '');
    file.stat = { mtime: this.mtime++, size: data.length };
    this.files.set(path, file);
    this.contents.set(path, data);
    this.created.push(path);
    return file;
  }
  async createFolder(path: string): Promise<TFolder> {
    const folder = new TFolder(path);
    this.folders.set(path, folder);
    this.createdFolders.push(path);
    return folder;
  }
  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const next = fn(this.contents.get(file.path) ?? '');
    this.contents.set(file.path, next);
    file.stat = { mtime: this.mtime++, size: next.length };
    this.trigger('modify', file);
    return next;
  }
}

export class App {
  workspace = new Workspace();
  vault = new Vault();
  metadataCache = new MetadataCache();
}

export class WorkspaceLeaf {
  view: unknown = null;
  /** Files opened in this leaf, for assertions (no view is mounted). */
  openedFiles: TFile[] = [];
  async setViewState(_state: unknown): Promise<void> {}
  async openFile(file: TFile): Promise<void> {
    this.openedFiles.push(file);
  }
}

// ---------------------------------------------------------------------------
// Components / views
// ---------------------------------------------------------------------------

export class Component {
  load(): void {}
  onload(): void {}
  unload(): void {}
  onunload(): void {}
  registerEvent(_ref: unknown): void {}
  registerDomEvent(el: EventTarget, name: string, cb: (e: Event) => void): void {
    el.addEventListener(name, cb);
  }
}

export class View extends Component {
  app = new App();
  containerEl: HTMLElement;

  constructor(public leaf: WorkspaceLeaf) {
    super();
    this.containerEl = document.createElement('div');
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
  getViewType(): string {
    return 'view';
  }
  getDisplayText(): string {
    return '';
  }
  getIcon(): string {
    return 'document';
  }
  onResize(): void {}
}

export class ItemView extends View {
  contentEl: HTMLElement;
  actions: { icon: string; title: string; callback: () => void }[] = [];

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.contentEl = document.createElement('div');
    this.containerEl.appendChild(this.contentEl);
  }
  addAction(icon: string, title: string, callback: () => void): HTMLElement {
    this.actions.push({ icon, title, callback });
    const el = document.createElement('a');
    el.setAttribute('data-icon', icon);
    el.title = title;
    el.addEventListener('click', callback);
    return el;
  }
}

export class FileView extends ItemView {
  file: TFile | null = null;
}

export class TextFileView extends FileView {
  data = '';
  saved: string[] = [];

  requestSave(): void {
    this.saved.push(this.getViewData());
  }
  async save(): Promise<void> {
    this.saved.push(this.getViewData());
  }
  getViewData(): string {
    return this.data;
  }
  setViewData(data: string, _clear: boolean): void {
    this.data = data;
  }
  clear(): void {
    this.data = '';
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export class MenuItem {
  title = '';
  icon = '';
  callback: (() => void) | null = null;

  setTitle(title: string): this {
    this.title = title;
    return this;
  }
  setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }
  onClick(callback: () => void): this {
    this.callback = callback;
    return this;
  }
}

export class Menu {
  /** Every Menu ever constructed — lets tests reach menus plugin code
   *  creates internally (e.g. context menus). */
  static created: Menu[] = [];
  items: MenuItem[] = [];
  shownAt: MouseEvent | null = null;

  constructor() {
    Menu.created.push(this);
  }

  addItem(cb: (item: MenuItem) => void): this {
    const item = new MenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(event: MouseEvent): this {
    this.shownAt = event;
    return this;
  }
  hide(): this {
    return this;
  }
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

export class Modal {
  containerEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  isOpen = false;

  constructor(public app: App) {
    this.containerEl = document.createElement('div');
    this.titleEl = document.createElement('div');
    this.contentEl = document.createElement('div');
    this.containerEl.append(this.titleEl, this.contentEl);
  }
  open(): void {
    this.isOpen = true;
    document.body.appendChild(this.containerEl);
    this.onOpen();
  }
  close(): void {
    this.isOpen = false;
    this.onClose();
    this.containerEl.remove();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class SuggestModal<T> extends Modal {
  inputEl: HTMLInputElement;
  emptyStateText = '';

  constructor(app: App) {
    super(app);
    this.inputEl = document.createElement('input');
    this.contentEl.appendChild(this.inputEl);
  }
  setPlaceholder(placeholder: string): void {
    this.inputEl.placeholder = placeholder;
  }
  getSuggestions(_query: string): T[] | Promise<T[]> {
    return [];
  }
  renderSuggestion(_value: T, _el: HTMLElement): void {}
  onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
}

export interface FuzzyMatch<T> {
  item: T;
  match: { score: number; matches: unknown[] };
}

export class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  getItems(): T[] {
    return [];
  }
  getItemText(_item: T): string {
    return '';
  }
  onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
  override renderSuggestion(match: FuzzyMatch<T>, el: HTMLElement): void {
    el.textContent = this.getItemText(match.item);
  }
  override onChooseSuggestion(match: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseItem(match.item, evt);
  }
  /** Test helper: pick the item whose text matches, as if clicked. */
  chooseItemWithText(text: string): void {
    const item = this.getItems().find((i) => this.getItemText(i) === text);
    if (item !== undefined) {
      this.onChooseItem(item, new MouseEvent('click'));
    }
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export class Plugin extends Component {
  app = new App();
  settingTabs: PluginSettingTab[] = [];
  commands: unknown[] = [];
  private data: unknown = null;

  registerView(_type: string, _factory: (leaf: WorkspaceLeaf) => View): void {}
  registerExtensions(_exts: string[], _type: string): void {}
  addStatusBarItem(): HTMLElement {
    return document.createElement('div');
  }
  addRibbonIcon(icon: string, title: string, _cb: (e: MouseEvent) => void): HTMLElement {
    const el = document.createElement('div');
    el.setAttribute('data-icon', icon);
    el.title = title;
    return el;
  }
  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }
  addCommand(command: unknown): void {
    this.commands.push(command);
  }
  async loadData(): Promise<unknown> {
    return this.data;
  }
  async saveData(data: unknown): Promise<void> {
    this.data = data;
  }
}

export class PluginSettingTab {
  containerEl: HTMLElement;

  constructor(
    public app: App,
    public plugin: Plugin,
  ) {
    this.containerEl = document.createElement('div');
  }
  display(): void {}
  hide(): void {}
}

class ValueComponent<T> {
  onChangeCb: ((value: T) => unknown) | null = null;

  onChange(cb: (value: T) => unknown): this {
    this.onChangeCb = cb;
    return this;
  }
}

export class TextComponent extends ValueComponent<string> {
  inputEl: HTMLInputElement;

  constructor(containerEl: HTMLElement) {
    super();
    this.inputEl = containerEl.ownerDocument.createElement('input');
    containerEl.appendChild(this.inputEl);
    this.inputEl.addEventListener('input', () => void this.onChangeCb?.(this.inputEl.value));
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }
}

export class ToggleComponent extends ValueComponent<boolean> {
  value = false;

  setValue(value: boolean): this {
    this.value = value;
    return this;
  }
  getValue(): boolean {
    return this.value;
  }
}

export class ButtonComponent {
  buttonEl: HTMLButtonElement;

  constructor(containerEl: HTMLElement) {
    this.buttonEl = containerEl.ownerDocument.createElement('button');
    containerEl.appendChild(this.buttonEl);
  }
  setButtonText(text: string): this {
    this.buttonEl.textContent = text;
    return this;
  }
  setIcon(icon: string): this {
    this.buttonEl.setAttribute('data-icon', icon);
    return this;
  }
  setTooltip(tooltip: string): this {
    this.buttonEl.title = tooltip;
    return this;
  }
  onClick(cb: (e: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener('click', (e) => void cb(e));
    return this;
  }
}

export class ExtraButtonComponent extends ButtonComponent {}

export class Setting {
  settingEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    const doc = containerEl.ownerDocument;
    this.settingEl = doc.createElement('div');
    this.nameEl = doc.createElement('div');
    this.descEl = doc.createElement('div');
    this.controlEl = doc.createElement('div');
    this.settingEl.append(this.nameEl, this.descEl, this.controlEl);
    containerEl.appendChild(this.settingEl);
  }
  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }
  setDesc(desc: string): this {
    this.descEl.textContent = desc;
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.classList.add(cls);
    return this;
  }
  setHeading(): this {
    this.settingEl.classList.add('setting-item-heading');
    return this;
  }
  addText(cb: (text: TextComponent) => unknown): this {
    cb(new TextComponent(this.controlEl));
    return this;
  }
  addToggle(cb: (toggle: ToggleComponent) => unknown): this {
    cb(new ToggleComponent());
    return this;
  }
  addButton(cb: (button: ButtonComponent) => unknown): this {
    cb(new ButtonComponent(this.controlEl));
    return this;
  }
  addExtraButton(cb: (button: ExtraButtonComponent) => unknown): this {
    cb(new ExtraButtonComponent(this.controlEl));
    return this;
  }
}
