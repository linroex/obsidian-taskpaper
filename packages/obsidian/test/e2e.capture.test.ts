/**
 * E2E tests for Quick Capture (F2): the CaptureModal driven through
 * TaskPaperCommands.quickCapture with the stubbed vault/workspace.
 *
 * Covered:
 *  - modal target hint + live preview (auto `- ` prefix, @due(tomorrow) → ISO)
 *  - Enter creates the missing inbox file (parent folders recursively) and
 *    writes the normalized task
 *  - project path: the missing chain is created inside an existing file
 *  - open-view path: the edit is dispatched into the live editor and the
 *    vault copy stays untouched (unsaved-editor race avoided)
 *  - Escape cancels without writing anything
 */
import { docText, mountEditor } from './e2eHarness';
import { App, Notice, TFile, Vault, WorkspaceLeaf } from 'obsidian';
import { resolveDateExpression } from '@taskpaper/core';
import { TaskPaperCommands } from '../src/commands';
import { DEFAULT_SETTINGS } from '../src/settings';
import { TaskPaperView } from '../src/view';
import type TaskPaperPlugin from '../src/main';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL: ${name}${extra ? '  -> ' + extra : ''}`);
  }
}

/** A minimal fake plugin exposing the stub app + settings overrides. */
function pluginWith(overrides: Partial<typeof DEFAULT_SETTINGS>): {
  plugin: TaskPaperPlugin;
  app: App;
  vault: Vault;
} {
  const app = new App();
  const plugin = {
    app,
    settings: { ...DEFAULT_SETTINGS, globalSearches: [], ...overrides },
    refreshSidebar() {},
  } as unknown as TaskPaperPlugin;
  return { plugin, app, vault: app.vault };
}

function captureInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('.tp-capture-input');
}

function setInput(text: string): void {
  const input = captureInput()!;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressKey(key: string): void {
  captureInput()!.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

/** Let the queued async vault writes (createFolder/create/process) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function main(): Promise<void> {
  // --- missing file: folders created recursively, date resolved, content written ---
  {
    const { plugin, vault } = pluginWith({ inboxFile: 'GTD/Boxes/Inbox.taskpaper' });
    const commands = new TaskPaperCommands(plugin);
    commands.quickCapture();

    check('the capture modal mounts with its input', captureInput() !== null);
    check(
      'target hint omits › when no project is set',
      document.querySelector('.tp-capture-target')?.textContent === '→ GTD/Boxes/Inbox.taskpaper',
      document.querySelector('.tp-capture-target')?.textContent ?? '(none)',
    );

    const iso = resolveDateExpression('tomorrow')!;
    setInput('買牛奶 @due(tomorrow)');
    check(
      'live preview shows the normalized line with the resolved ISO date',
      document.querySelector('.tp-capture-preview')?.textContent === `- 買牛奶 @due(${iso})`,
      document.querySelector('.tp-capture-preview')?.textContent ?? '(none)',
    );

    pressKey('Enter');
    await settle();
    check('the modal closes on Enter', captureInput() === null);
    check(
      'missing parent folders are created segment by segment',
      JSON.stringify(vault.createdFolders) === '["GTD","GTD/Boxes"]',
      JSON.stringify(vault.createdFolders),
    );
    check(
      'the inbox file is created with the normalized task + trailing newline',
      vault.contents.get('GTD/Boxes/Inbox.taskpaper') === `- 買牛奶 @due(${iso})\n`,
      JSON.stringify(vault.contents.get('GTD/Boxes/Inbox.taskpaper')),
    );
    check('success shows the localized notice', Notice.messages.includes('已加入 GTD/Boxes/Inbox.taskpaper'));
  }

  // --- existing file on disk: the missing project chain is created inside it ---
  {
    const { plugin, vault } = pluginWith({
      inboxFile: 'Inbox.taskpaper',
      inboxProject: 'Work/收件匣',
    });
    await vault.create('Inbox.taskpaper', 'Other:\n\t- a\n');
    vault.created.length = 0;

    const commands = new TaskPaperCommands(plugin);
    commands.quickCapture();
    check(
      'target hint shows file › project',
      document.querySelector('.tp-capture-target')?.textContent === '→ Inbox.taskpaper › Work/收件匣',
      document.querySelector('.tp-capture-target')?.textContent ?? '(none)',
    );
    setInput('follow up');
    pressKey('Enter');
    await settle();
    check(
      'the missing project chain is created with the task nested inside',
      vault.contents.get('Inbox.taskpaper') === 'Other:\n\t- a\nWork:\n\t收件匣:\n\t\t- follow up\n',
      JSON.stringify(vault.contents.get('Inbox.taskpaper')),
    );
    check('no extra file/folder is created for an existing inbox', vault.created.length === 0 && vault.createdFolders.length === 0);
  }

  // --- open-view path: dispatch into the live editor, vault untouched ---
  {
    const { plugin, app, vault } = pluginWith({
      inboxFile: 'Inbox.taskpaper',
      inboxProject: 'Inbox',
    });
    // The on-disk copy is stale on purpose: the open editor must win.
    await vault.create('Inbox.taskpaper', 'stale');
    const { view, cleanup } = mountEditor('Inbox:\n\t- a\n');
    const tpView = Object.create(TaskPaperView.prototype) as TaskPaperView;
    tpView.file = new TFile('Inbox.taskpaper', 'Inbox', 'taskpaper');
    tpView.editor = view;
    const leaf = new WorkspaceLeaf();
    leaf.view = tpView;
    app.workspace.leaves.push(leaf);

    const commands = new TaskPaperCommands(plugin);
    commands.quickCapture();
    setInput('from editor');
    pressKey('Enter');
    await settle();
    check(
      'the task lands in the open editor as the last child of the project',
      docText(view) === 'Inbox:\n\t- a\n\t- from editor\n',
      JSON.stringify(docText(view)),
    );
    check(
      'the vault copy stays untouched until the view saves',
      vault.contents.get('Inbox.taskpaper') === 'stale',
      JSON.stringify(vault.contents.get('Inbox.taskpaper')),
    );
    check('the open-view path also shows the notice', Notice.messages.filter((m) => m === '已加入 Inbox.taskpaper').length >= 1);
    cleanup();
  }

  // --- a `./`-prefixed inbox setting still matches the open view (normalizePath) ---
  {
    const { plugin, app, vault } = pluginWith({ inboxFile: './Inbox.taskpaper' });
    await vault.create('Inbox.taskpaper', 'stale');
    const { view, cleanup } = mountEditor('- a\n');
    const tpView = Object.create(TaskPaperView.prototype) as TaskPaperView;
    tpView.file = new TFile('Inbox.taskpaper', 'Inbox', 'taskpaper');
    tpView.editor = view;
    const leaf = new WorkspaceLeaf();
    leaf.view = tpView;
    app.workspace.leaves.push(leaf);

    const commands = new TaskPaperCommands(plugin);
    commands.quickCapture();
    setInput('normalized');
    pressKey('Enter');
    await settle();
    check(
      'a ./-prefixed path is normalized before matching the open view',
      docText(view) === '- a\n- normalized\n' && vault.contents.get('Inbox.taskpaper') === 'stale',
      JSON.stringify(docText(view)),
    );
    cleanup();
  }

  // --- concurrent first captures serialize: both land, nothing is lost ---
  {
    const { plugin, vault } = pluginWith({ inboxFile: 'Fresh.taskpaper' });
    const commands = new TaskPaperCommands(plugin);
    // Two captures racing before the inbox exists (no await between them) —
    // the queue must serialize the check-then-create so neither drops.
    const both = Promise.all([
      commands.captureToInbox('Fresh.taskpaper', '', '- first'),
      commands.captureToInbox('Fresh.taskpaper', '', '- second'),
    ]);
    await both;
    await settle();
    const content = vault.contents.get('Fresh.taskpaper') ?? '';
    check(
      'concurrent captures both land in the new inbox',
      content.includes('- first') && content.includes('- second'),
      JSON.stringify(content),
    );
    check('the file was created exactly once', vault.created.length === 1, JSON.stringify(vault.created));
  }

  // --- Escape cancels without writing ---
  {
    const { plugin, vault } = pluginWith({ inboxFile: 'Cancel.taskpaper' });
    const notices = Notice.messages.length;
    const commands = new TaskPaperCommands(plugin);
    commands.quickCapture();
    setInput('never saved');
    pressKey('Escape');
    await settle();
    check('Escape closes the modal', captureInput() === null);
    check('nothing is written on cancel', vault.contents.size === 0 && vault.created.length === 0);
    check('no notice appears on cancel', Notice.messages.length === notices);
  }

  // --- empty input: Enter is a no-op, the modal stays open ---
  {
    const { plugin, vault } = pluginWith({ inboxFile: 'Empty.taskpaper' });
    const commands = new TaskPaperCommands(plugin);
    commands.quickCapture();
    setInput('   ');
    pressKey('Enter');
    await settle();
    check('blank input does not submit', captureInput() !== null);
    check('blank input writes nothing', vault.contents.size === 0);
    pressKey('Escape');
  }
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
