'use strict';

// Isolated desktop acceptance tests. The Windows clipboard and OS browser stay untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { _electron } = require(process.env.INMOMENT_PLAYWRIGHT || 'playwright');
const { LocalStore } = require('../src/core/store.cjs');
const { wavHeader } = require('../src/main/wav-writer.cjs');
const { checkButtonStates, checkButtonCorners, buttonBackgrounds, buttonTints, normalizeButtonBackground } = require('./ui-audit-button-states.cjs');
const root = path.resolve(__dirname, '..');
const executable = process.env.INMOMENT_SMOKE_EXECUTABLE;
const applicationRoot = executable ? path.join(path.dirname(executable), 'resources', 'app') : root;
const output = path.join(root, '.local', 'notes-review');
fs.mkdirSync(output, { recursive: true });
const runDir = fs.mkdtempSync(path.join(output, 'run-'));
const dataDir = path.join(runDir, 'data');
const env = {
  ...process.env,
  INMOMENT_DATA_DIR: dataDir,
  INMOMENT_ASR_DIR: path.join(runDir, 'disabled-asr'),
  INMOMENT_DISABLE_NETWORK: '1',
  INMOMENT_SMOKE: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const report = { checks: [], geometry: [], errors: [], screenshots: [], syntheticOnly: true };
let application, page;

async function launch() {
  application = await _electron.launch({ executablePath: executable || require('electron'), args: executable ? [] : [root], cwd: root, env, timeout: 25000 });
  await application.firstWindow();
  page = null;
  for (let attempt = 0; !page && attempt < 100; attempt++) {
    page = application.windows().find(window => window.url().includes('/renderer/'));
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'The isolated app did not open its editor window');
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route(/^https?:\/\//u, route => { report.errors.push('Unexpected network request: ' + route.request().url()); return route.abort(); });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/')).show());
  await page.waitForLoadState('load');
  await page.waitForFunction(() => typeof state !== 'undefined' && state.settings.networkDisabled && !state.loading);
  await page.locator('#notes-view').waitFor();
}

async function resize(width, height, zoom) {
  const bounds = await application.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/renderer/'));
    window.unmaximize();
    window.setMinimumSize(640, 480);
    window.setContentSize(size.width, size.height);
    window.webContents.setZoomFactor(size.zoom);
    return window.getContentBounds();
  }, { width, height, zoom });
  await page.waitForFunction(size => Math.abs(innerWidth - size.width / size.zoom) < 1.1, { ...bounds, zoom });
}

function readBody(editor = page.locator('#note-body')) {
  return editor.evaluate(field => window.InMomentNoteDocument.value(field));
}

async function waitForNote(id) {
  await page.waitForFunction(id => notesView.opened?.id === id, id);
}

async function waitSaved() {
  await page.waitForFunction(() => document.querySelector('#note-status').textContent === '已保存');
}

async function capture(filename) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const png = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/renderer/'));
    return (await window.capturePage()).toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(runDir, filename), Buffer.from(png, 'base64'));
}

async function noteListState(clickSelector) {
  return page.evaluate(selector => {
    if (selector) document.querySelector(selector).click();
    const pane = document.querySelector('.notes-navigator');
    const { x, y, width, height } = pane.getBoundingClientRect();
    const { clipPath, transform } = getComputedStyle(pane);
    return { x, y, width, height, clipPath, transform, animations: pane.getAnimations().length };
  }, clickSelector);
}

function assertNoteListVisible(pane) {
  assert.ok(pane.width > 0 && pane.height > 0, JSON.stringify(pane));
  assert.equal(pane.clipPath, 'none');
  assert.equal(pane.transform, 'none');
  assert.equal(pane.animations, 0);
}

async function auditNoteListDefault() {
  const initial = await noteListState();
  assertNoteListVisible(initial);
  assert.equal(await page.locator('[data-library-group-id="all"]').getAttribute('aria-pressed'), 'true');
  await page.waitForFunction(() => {
    const group = document.querySelector('#primary-group-sidebar').getBoundingClientRect();
    const list = document.querySelector('.notes-navigator').getBoundingClientRect();
    return Math.abs(group.right - list.x) <= 1 && !document.querySelector('.app-content').getAnimations().length;
  });
  const settled = await noteListState();
  for (const group of ['uncategorized', 'all']) {
    const selector = `[data-library-group-id="${group}"]`;
    assert.deepEqual(await noteListState(selector), settled);
    assert.equal(await page.locator(selector).getAttribute('aria-pressed'), 'true');
  }
  report.geometry.push({ filename: 'notes-welcome-100', notesList: settled });
  report.checks.push('all notes opens by default and group selection updates the list without animating or moving its pane');
}

async function auditSharedShell() {
  for (const [width, height, zoom] of [[1260, 840, 1], [1120, 740, 1.25], [900, 680, 1.5]]) {
    await resize(width, height, zoom);
    let expected;
    for (const view of ['notes', 'chat', 'settings', 'notes']) {
      await page.locator(`.icon-rail [data-view="${view}"]`).click();
      await page.locator(`#${view}-view`).waitFor();
      await page.mouse.move(8, 8);
      await page.waitForFunction(view => {
        const rail = document.querySelector('.icon-rail');
        const current = rail.querySelector(`[data-view="${view}"][aria-current="page"]`);
        return current && getComputedStyle(current).backgroundColor !== 'rgba(0, 0, 0, 0)' &&
          !document.documentElement.dataset.uiTransitionKind && !rail.getAnimations({ subtree: true }).length;
      }, view);
      const geometry = await page.evaluate(() => {
        const round = value => Math.round(value * 100) / 100;
        const measure = selector => {
          const node = document.querySelector(selector);
          const { x, y, width, height } = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            x: round(x), y: round(y), width: round(width), height: round(height),
            background: style.backgroundColor, rightBorder: style.borderRightWidth,
            bottomBorder: style.borderBottomWidth, borderColor: style.borderBottomColor,
            clip: style.backgroundClip, radius: style.borderTopLeftRadius,
          };
        };
        return {
          rail: measure('.icon-rail'), titlebar: measure('.app-titlebar'), shell: measure('.app-shell'), content: measure('.app-content'),
          brand: measure('.rail-brand img'), title: measure('.app-title-brand'),
          notes: measure('#open-notes'), chat: measure('#open-chat'),
          help: measure('#open-guide'), settings: measure('.rail-settings'),
        };
      });
      const { rail, titlebar, shell, content, brand } = geometry;
      assert.ok(Math.abs(titlebar.height - 46) < .1);
      assert.equal(rail.width, titlebar.height);
      assert.equal(titlebar.x, rail.width);
      assert.equal(brand.y + brand.height / 2, titlebar.height / 2);
      assert.equal(content.x, rail.width);
      assert.equal(content.y, titlebar.height);
      assert.equal(content.radius, '16px');
      assert.equal(shell.background, 'rgb(239, 242, 240)');
      assert.equal(geometry.settings.y - (geometry.help.y + geometry.help.height), 6);
      for (const key of ['rail', 'titlebar', 'notes', 'chat', 'help', 'settings']) {
        const item = geometry[key];
        assert.equal(normalizeButtonBackground(item.background), key === view ? buttonBackgrounds.pressed : buttonBackgrounds.idle, `${key} background in ${view} at zoom ${zoom}`);
        const control = key !== 'rail' && key !== 'titlebar';
        assert.ok(Math.abs(parseFloat(item.rightBorder) - (control ? 4 : 0)) < .6);
        assert.ok(Math.abs(parseFloat(item.bottomBorder) - (control ? 4 : 0)) < .6);
        if (control) {
          assert.equal(item.width, 44);
          assert.equal(item.height, 44);
          assert.equal(item.clip, 'padding-box');
          assert.equal(item.borderColor, 'rgba(0, 0, 0, 0)');
          assert.equal(item.radius, '16px');
          const visibleWidth = item.width - 2 * parseFloat(item.rightBorder);
          const visibleRadius = parseFloat(item.radius) - parseFloat(item.rightBorder);
          assert.ok(Math.abs(visibleWidth - 36) <= 1.2);
          assert.ok(Math.abs(visibleRadius - 12) <= .6);
          assert.ok(visibleWidth > 2 * visibleRadius);
        }
        delete item.background;
      }
      if (!expected) expected = geometry;
      else assert.deepEqual(geometry, expected, `Shell moved after switching to ${view} at zoom ${zoom}`);
      if (view === 'chat') {
        const chatHistory = await page.locator('#chat-view .chat-history').evaluate(element => {
          const { x, width } = element.getBoundingClientRect();
          const notebookWidth = (Math.min(232, Math.max(136, innerWidth * .12)) + 24) * 8 / 7;
          return { x, width, notebookWidth };
        });
        assert.ok(Math.abs(chatHistory.x - content.x) <= 1);
        assert.ok(Math.abs(chatHistory.width - chatHistory.notebookWidth) <= 1);
        report.geometry.push({ filename: `chat-sidebar-${zoom * 100}`, ...chatHistory });
      }
      if (zoom === 1) {
        const filename = `shell-${view}-100.png`;
        if (!report.screenshots.includes(filename)) {
          await capture(filename);
          report.screenshots.push(filename);
          (report.buttonCorners ||= []).push(await checkButtonCorners(page, view));
        }
        if (view === 'settings') {
          report.geometry.push(await checkButtonStates(page, '#settings-nav-capture', { current: true }));
          report.geometry.push(await checkButtonStates(page, '#settings-nav-ai'));
        }
        if (view === 'chat') {
          report.geometry.push(await checkButtonStates(page, '#open-chat', { current: true, icon: true }));
          report.geometry.push(await checkButtonStates(page, '#open-notes', { icon: true }));
        }
      }
    }
    report.geometry.push({ filename: `shell-${zoom * 100}`, ...expected });
  }
  await resize(1260, 840, 1);
  await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/renderer/'));
    if (window.isMaximized()) return;
    await new Promise(resolve => {
      window.once('maximize', resolve);
      window.maximize();
    });
  });
  await page.waitForFunction(() => navigator.windowControlsOverlay?.visible);
  const maximized = await page.evaluate(() => {
    const header = document.querySelector('.app-titlebar').getBoundingClientRect();
    const rail = document.querySelector('.icon-rail').getBoundingClientRect();
    const caption = navigator.windowControlsOverlay.getTitlebarAreaRect();
    return { height: header.height, width: rail.width, captionHeight: caption.height, captionButtonWidth: (innerWidth - caption.width) / 3, viewport: { width: innerWidth, height: innerHeight } };
  });
  assert.ok(Math.abs(maximized.height - maximized.width) < .1);
  assert.ok(maximized.captionHeight > 0 && maximized.captionHeight <= maximized.height);
  assert.ok(Math.abs(maximized.captionHeight - maximized.captionButtonWidth) <= 2, JSON.stringify(maximized));
  report.geometry.push({ filename: 'shell-maximized', ...maximized });
  await capture('shell-maximized.png');
  report.screenshots.push('shell-maximized.png');
  await resize(1260, 840, 1);
  await page.mouse.move(8, 8);
  assert.equal(await page.locator('#start-recording').count(), 0);
  report.geometry.push(await checkButtonStates(page, '#open-notes', { current: true, icon: true }));
  report.geometry.push(await checkButtonStates(page, '#open-guide', { icon: true }));
  report.checks.push('Shared shell stays fixed at all tested zooms, selected navigation icons stay Filled after hover and keyboard focus, and momentary help retains its Regular/Filled feedback');
}

async function measure(filename) {
  const geometry = await page.evaluate(() => {
    const bounds = selector => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height, centerY: y + height / 2 };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      title: bounds('#note-title'), body: bounds('#note-body'),
      status: bounds('#note-status'), attach: bounds('#note-attach'), remove: bounds('#note-delete'),
      overflow: document.documentElement.scrollWidth > innerWidth || document.querySelector('.note-document').scrollWidth > document.querySelector('.note-document').clientWidth,
    };
  });
  assert.equal(geometry.overflow, false);
  assert.ok(Math.abs(geometry.title.x - geometry.body.x) <= 1);
  assert.ok(Math.abs(geometry.attach.centerY - geometry.remove.centerY) <= 1);
  report.geometry.push({ filename, ...geometry });
  await capture(filename + '.png');
  await page.evaluate(({ title, attach }) => {
    const overlay = document.createElement('div');
    overlay.id = 'notes-measurement-overlay';
    Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '15000', pointerEvents: 'none' });
    const vertical = document.createElement('span');
    Object.assign(vertical.style, { position: 'absolute', left: title.x + 'px', top: title.y + 'px', bottom: '0', borderLeft: '1px dashed #d25220' });
    const horizontal = document.createElement('span');
    Object.assign(horizontal.style, { position: 'absolute', left: title.x + 'px', right: '0', top: attach.centerY + 'px', borderTop: '1px dashed #d25220' });
    overlay.append(vertical, horizontal);
    document.body.append(overlay);
  }, geometry);
  await capture(filename + '-guides.png');
  await page.locator('#notes-measurement-overlay').evaluate(node => node.remove());
  report.screenshots.push(filename + '.png', filename + '-guides.png');
}

async function pasteFiles() {
  await page.locator('#note-body').evaluate(async target => {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 224;
    const context = canvas.getContext('2d');
    context.fillStyle = '#dbe9dc'; context.fillRect(0, 0, 480, 224);
    context.fillStyle = '#324c36'; context.font = 'bold 28px sans-serif';
    context.fillText('Synthetic note image', 24, 56);
    context.fillStyle = '#bf9863'; context.fillRect(24, 94, 320, 22);
    context.fillStyle = '#42694d'; context.fillRect(24, 126, 270, 22);
    const image = await new Promise(resolve => canvas.toBlob(resolve));
    const data = new DataTransfer();
    data.items.add(new File([image], '设计草图.png', { type: 'image/png' }));
    data.items.add(new File(['测试附件'], '产品调研说明.txt', { type: 'text/plain' }));
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector('#note-body .note-inline-media img')?.naturalWidth === 480);
  assert.equal(await page.locator('#note-body .note-inline-media').count(), 1);
  assert.equal(await page.locator('#note-attachments .note-attachment').count(), 1);
}

async function pasteVideo() {
  const filename = path.join(runDir, 'synthetic-video.webm');
  const generated = spawnSync(process.env.INMOMENT_FFMPEG || 'ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-t', '0.8', '-an', '-c:v', 'libvpx', '-b:v', '128k', filename,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr || String(generated.error));
  await page.locator('#note-body').evaluate((target, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(bytes)], '操作演示.webm', { type: 'video/webm' }));
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...fs.readFileSync(filename)]);
  await page.waitForFunction(() => document.querySelector('video.note-media')?.videoWidth === 320);
  await page.locator('video.note-media').evaluate(async video => {
    video.muted = true;
    await video.play();
  });
  await page.waitForFunction(() => document.querySelector('video.note-media')?.currentTime > 0.1);
  await page.locator('video.note-media').evaluate(video => video.pause());
}

function seedCapturedNotes() {
  const store = new LocalStore(dataDir);
  const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
  const pcm = Buffer.alloc(96000);
  const audio = Buffer.concat([wavHeader(pcm.length, 16000), pcm]);
  try {
    const topic = store.createTopic('验收分组');
    const source = { processName: '合成浏览器', title: '合成网页窗口', url: 'https://example.test/background' };
    const legacy = store.createDraft({ id: 'legacy-note', source, notes: '以前写的内容', topicIds: [topic.id] });
    for (const part of [1, 2]) store.addSegment(legacy.id, { id: 'part-' + part, bytes: audio, durationMs: 3000, transcript: '转写第 ' + part + ' 段' });
    store.addScreenshot(legacy.id, screenshot, { method: 'region' });
    store.addScreenshot(legacy.id, screenshot, { method: 'window' });
    store.complete(legacy.id);
    const audioOnly = store.createDraft({ id: 'audio-only-note', title: '只有录音的旧笔记' });
    store.addSegment(audioOnly.id, { id: 'only-part', bytes: audio, durationMs: 3000 });
    store.complete(audioOnly.id);
    return topic.id;
  } finally { store.close(); }
}

async function auditCapturedNotes() {
  await application.close();
  application = null;
  const topicId = seedCapturedNotes();
  await launch();
  await resize(1260, 840, 1);
  const dialog = page.locator('#note-background-dialog');
  const openBackground = page.locator('#note-background');
  const legacy = page.locator('[data-note-id="record:legacy-note"]');
  await page.locator(`[data-library-group-id="${topicId}"]`).click();
  await page.waitForFunction(() => document.querySelectorAll('.note-list-item').length === 1);
  assert.equal(await legacy.locator('.note-list-title').textContent(), '无标题笔记');
  await legacy.click();
  await waitForNote(await legacy.getAttribute('data-note-id'));
  assert.equal(await readBody(), '转写第 1 段\n转写第 2 段\n\n以前写的内容');
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await page.locator('.note-background-source, #note-editor audio').count(), 0);
  assert.equal(await page.getByText('接着想', { exact: false }).count(), 0);
  await page.locator('#note-title').fill('编辑后的旧笔记');
  await page.locator('#note-body').fill('编辑后的正文');
  await waitSaved();
  await openBackground.focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor();
  assert.equal(await openBackground.getAttribute('aria-expanded'), 'true');
  await page.waitForFunction(() => document.activeElement.id === 'close-note-background');
  assert.equal(await dialog.getByRole('link').getAttribute('href'), 'https://example.test/background');
  assert.equal(await dialog.locator('audio').count(), 2);
  assert.equal(await dialog.locator('figure').count(), 2);
  await capture('note-background-100.png');
  report.screenshots.push('note-background-100.png');
  const preview = dialog.getByRole('button', { name: '查看选区截图原图', exact: true });
  await preview.click();
  await page.locator('.note-image-viewer .note-image-canvas img').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === '查看选区截图原图');
  await dialog.getByRole('button', { name: '播放第 1 段录音', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#note-background-dialog audio')?.currentTime > 0.05);
  await page.evaluate(() => { window.disposedPlayer = document.querySelector('#note-background-dialog audio'); });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement.id === 'note-background' && !window.disposedPlayer.isConnected && window.disposedPlayer.paused);
  await openBackground.click();
  const remove = dialog.getByRole('button', { name: '移除录音', exact: true });
  await remove.click();
  const confirmation = dialog.locator('.confirm-popover[data-popover-state=open]');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  assert.equal(await dialog.locator('audio').count(), 2);
  await remove.click();
  await confirmation.getByRole('button', { name: '移除录音', exact: true }).click();
  await dialog.locator('audio').first().waitFor({ state: 'detached' });
  assert.equal(await dialog.locator('figure').count(), 2);
  assert.equal(await readBody(), '编辑后的正文');
  await resize(900, 680, 1.5);
  const geometry = await dialog.evaluate(dialog => {
    const { x, y, width, height } = dialog.getBoundingClientRect();
    const content = dialog.querySelector('.note-background-content');
    return { viewport: [innerWidth, innerHeight], x, y, width, height, contentOverflow: content.scrollWidth > content.clientWidth };
  });
  assert.equal(geometry.contentOverflow, false);
  assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.x + geometry.width <= geometry.viewport[0] + 1 && geometry.y + geometry.height <= geometry.viewport[1] + 1);
  report.geometry.push({ filename: 'note-background-150', ...geometry });
  await capture('note-background-150.png');
  report.screenshots.push('note-background-150.png');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement.id === 'note-background');
  await resize(1260, 840, 1);
  await page.locator('[data-library-group-id="all"]').click();
  await page.locator('[data-note-id="record:audio-only-note"]').click();
  await openBackground.click();
  assert.equal(await remove.isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.locator('#note-body').fill('先写入正文，再移除录音。');
  await waitSaved();
  await openBackground.click();
  await remove.click();
  await confirmation.getByRole('button', { name: '移除录音', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement.id === 'note-title');
  assert.equal(await openBackground.isVisible(), false);
  report.checks.push('legacy note editing and group filter', 'background source and PNG viewer with keyboard focus', 'synthetic WAV playback and teardown', 'confirmed removal preserves body and screenshots, with audio-only guard and focus fallback');
}

async function auditTopicTree() {
  await resize(1260, 840, 1);
  const sidebar = page.locator('#primary-group-sidebar');
  const row = name => sidebar.locator('button.primary-group-item').filter({ has: page.locator('.primary-group-name', { hasText: new RegExp('^' + name + '$', 'u') }) });
  const topic = id => sidebar.locator(`[data-library-group-id="${id}"]`);
  const groupId = locator => locator.getAttribute('data-library-group-id');
  const choice = async action => {
    const menu = page.locator('.context-menu[data-popover-state="open"]');
    const node = await menu.elementHandle();
    await menu.locator(`[data-menu-id="${action}"]`).click();
    await page.waitForFunction(element => !element.isConnected, node);
  };
  const openMenu = async (locator, action) => { await locator.click({ button: 'right' }); await choice(action); };
  const openForm = async name => {
    await page.locator('#primary-group-name').fill(name);
    await page.locator('#save-primary-group').click();
    await row(name).waitFor();
    return groupId(row(name));
  };
  const awaitCreated = async name => {
    const id = await openForm(name);
    await sidebar.locator(`[data-library-group-id="${id}"][aria-pressed=true]`).waitFor();
    return id;
  };
  const createRoot = async name => { await sidebar.locator('#create-primary-group').click(); return awaitCreated(name); };
  const createChild = async (id, name) => { await openMenu(topic(id), 'child'); return awaitCreated(name); };
  const snapshot = () => page.evaluate(() => window.inmoment.invoke('app:bootstrap'));
  const note = id => page.evaluate(id => window.inmoment.invoke('notes:get', { id }), id);
  const createNote = async title => {
    await page.locator('#new-note').click();
    await page.locator('#note-title').fill(title);
    await page.locator('#note-body').fill('分组树验收正文');
    await waitSaved();
    return page.locator('.note-list-item[aria-current=true]').getAttribute('data-note-id');
  };

  const root = await createRoot('验收父分组');
  const child = await createChild(root, '验收子分组');
  const childNote = await createNote('验收子分组独立笔记');
  assert.deepEqual((await note(childNote)).topicIds, [child]);
  const other = await createRoot('验收移动目标');
  await topic(child).press('F2');
  await openForm('改名子分组');
  assert.equal(await groupId(row('改名子分组')), child);
  const search = sidebar.locator('#group-search');
  await search.fill('改名子');
  assert.equal(await topic(root).isVisible(), true);
  assert.equal(await topic(child).isVisible(), true);
  assert.equal(await topic(other).count(), 0);
  assert.equal(await topic('uncategorized').count(), 0);
  await search.fill('');
  assert.equal(await sidebar.locator('.topic-tree-row').last().getAttribute('data-topic-tree-row'), 'uncategorized');

  await openMenu(topic(root), 'copy');
  await topic('all').press('Shift+F10');
  await choice('paste');
  await row('验收父分组 副本').waitFor();
  const copyId = await groupId(row('验收父分组 副本'));
  const groupsAfterCopy = (await snapshot()).topics;
  const copiedChild = groupsAfterCopy.find(item => item.parentId === copyId && item.name === '改名子分组');
  assert.ok(copiedChild);
  const copiedNotes = await page.evaluate(topicId => window.inmoment.invoke('notes:list', { topicId }), copiedChild.id);
  assert.equal(copiedNotes.notes.length, 1);
  const copyNoteId = copiedNotes.notes[0].id;
  assert.notEqual(copyNoteId, childNote);
  assert.equal((await note(copyNoteId)).body, '分组树验收正文');

  await openMenu(topic(child), 'move');
  await page.locator(`[data-group-choice-id="${other}"]`).click();
  await page.waitForFunction(({ id, parent }) => state.topics.some(group => group.id === id && group.parentId === parent), { id: child, parent: other });
  await openMenu(topic(child), 'delete');
  await page.locator('[data-confirm-action=confirm]').click();
  await page.waitForFunction(id => !state.topics.some(group => group.id === id), child);
  assert.deepEqual((await note(childNote)).topicIds, [other]);
  assert.equal((await note(childNote)).body, '分组树验收正文');

  await openMenu(topic(copyId), 'delete-content');
  await page.locator('[data-confirm-action=confirm]').click();
  await page.waitForFunction(id => !state.topics.some(group => group.id === id), copyId);
  await assert.rejects(note(copyNoteId), /笔记已不存在/u);
  assert.equal((await note(childNote)).body, '分组树验收正文');

  const master = sidebar.locator('#group-select-all');
  await master.check();
  await sidebar.locator('#group-selection-count').filter({ hasText: '已选 ' + (await snapshot()).topics.length }).waitFor();
  assert.equal(await master.isChecked(), true);
  const selected = sidebar.locator('.topic-tree-check input:checked');
  assert.ok(await selected.count() >= 2);
  await page.waitForFunction(() => {
    const master = document.querySelector('#group-select-all');
    const checked = document.querySelector('.topic-tree-check input:checked');
    return checked && getComputedStyle(master, '::before').backgroundColor === getComputedStyle(checked, '::before').backgroundColor;
  });
  await capture('note-group-multiselect.png');
  report.screenshots.push('note-group-multiselect.png');
  await sidebar.locator('#group-select-mode').click();
  assert.equal(await master.isChecked(), false);
  await sidebar.locator('#group-select-mode').click();
  await sidebar.getByRole('checkbox', { name: '选择分组 验收父分组', exact: true }).check();
  await sidebar.getByRole('checkbox', { name: '选择分组 验收移动目标', exact: true }).check();
  await sidebar.locator('#group-selection-actions').click();
  await choice('merge');
  await page.locator(`[data-group-choice-id="${root}"]`).click();
  await page.waitForFunction(id => !state.topics.some(group => group.id === id), other);
  assert.deepEqual((await note(childNote)).topicIds, [root]);
  await sidebar.locator(`[data-library-group-id="${root}"][aria-pressed=true]`).waitFor();
  await topic('all').click();
  report.checks.push('nested group create, rename, search, subtree copy with independent notes, move, both deletion modes, select-all and batch merge');
}

async function auditNotebookGroups() {
  const sidebar = page.locator('#primary-group-sidebar');
  const create = sidebar.locator('#create-primary-group');
  const name = '资料归档与用户访谈长名称验收分组';
  await create.click();
  await page.locator('#primary-group-name').fill(name);
  await page.locator('#save-primary-group').click();
  const group = sidebar.locator('button[title="' + name + '"]');
  await group.locator('.primary-group-count').filter({ hasText: /^0$/u }).waitFor();
  await page.waitForFunction(name => document.querySelector('#primary-group-navigation [aria-pressed=true]')?.title === name, name);
  const topicId = await group.getAttribute('data-library-group-id');
  const snapshot = id => page.evaluate(id => window.inmoment.invoke('notes:get', { id }), id);
  const emptyHeading = await page.locator('.notes-welcome-heading').boundingBox();
  await page.locator('#new-note-from-empty').click();
  await page.locator('#note-title').fill('新建组内笔记');
  assert.ok(Math.abs((await page.locator('#note-title').boundingBox()).x - emptyHeading.x) <= 1);
  await page.locator('#note-body').fill('验收正文');
  await waitSaved();
  const current = page.locator('.note-list-item[aria-current=true]');
  const id = await current.getAttribute('data-note-id');
  const persisted = await page.evaluate(id => window.inmoment.invoke('notes:get', { id }), id);
  assert.deepEqual(persisted.topicIds, [topicId]);
  assert.equal(persisted.body, '验收正文');

  const geometry = await page.evaluate(() => {
    const box = selector => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    };
    const typography = selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return { fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight };
    };
    const previousListWidth = Math.min(232, Math.max(136, innerWidth * .12)) + 24;
    return {
      viewport: { width: innerWidth, height: innerHeight }, previousListWidth,
      titlebar: box('.app-titlebar'), group: box('#primary-group-sidebar'), list: box('.notes-navigator'), editor: box('.notes-content'),
      heading: box('.notebook-group-heading'), notesHeading: box('.notebook-column-title'),
      headingType: typography('.notebook-group-heading'), notesHeadingType: typography('.notebook-column-title'),
      search: box('.notebook-group-search'), notesSearch: box('.notes-search'),
      groupQuery: box('#group-search'), notesQuery: box('#notes-query'), select: box('#group-select-all'),
      add: box('#create-primary-group'), uncategorized: box('[data-library-group-id=uncategorized]'), settings: box('.rail-settings'),
      date: box('.note-list-date > span:first-child'), time: box('.note-list-date > span:last-child'),
    };
  });
  report.geometry.push({ filename: 'note-columns-100', ...geometry });
  assert.ok(Math.abs(geometry.list.width - geometry.group.width) <= 1);
  assert.ok(Math.abs(geometry.list.width - geometry.previousListWidth * 8 / 7) <= 1);
  assert.ok(Math.abs(geometry.group.y - geometry.list.y) <= 1);
  assert.ok(Math.abs(geometry.group.y + geometry.group.height - geometry.list.y - geometry.list.height) <= 1);
  assert.ok(Math.abs(geometry.titlebar.y + geometry.titlebar.height - geometry.list.y) <= 1);
  assert.ok(geometry.editor.width > geometry.group.width + geometry.list.width);
  assert.ok(Math.abs(geometry.group.x + geometry.group.width - geometry.list.x) <= 1);
  assert.ok(Math.abs(geometry.list.x + geometry.list.width - geometry.editor.x) <= 1);
  const centerY = box => box.y + box.height / 2;
  assert.ok(Math.abs(centerY(geometry.heading) - geometry.group.y - 24) <= 1);
  assert.ok(Math.abs(geometry.heading.x - geometry.group.x - 16) <= 1, JSON.stringify({ heading: geometry.heading, group: geometry.group }));
  assert.ok(geometry.heading.y + geometry.heading.height <= geometry.search.y);
  const columnOffset = geometry.list.x - geometry.group.x;
  for (const [groupBox, notesBox] of [[geometry.heading, geometry.notesHeading], [geometry.search, geometry.notesSearch], [geometry.groupQuery, geometry.notesQuery]]) {
    assert.ok(Math.abs(notesBox.x - groupBox.x - columnOffset) <= 1);
    for (const key of ['y', 'width', 'height']) assert.ok(Math.abs(notesBox[key] - groupBox[key]) <= 1);
  }
  assert.deepEqual(geometry.headingType, { fontSize: '18px', fontWeight: '400', lineHeight: '32px' });
  assert.deepEqual(geometry.notesHeadingType, geometry.headingType);
  assert.ok(geometry.search.y + geometry.search.height <= geometry.add.y);
  assert.ok(Math.abs(centerY(geometry.select) - centerY(geometry.add)) <= 1);
  assert.ok(geometry.select.x < geometry.add.x);
  assert.ok(Math.abs(geometry.search.x + geometry.search.width - geometry.add.x - geometry.add.width) <= 1);
  assert.ok(Math.abs(centerY(geometry.uncategorized) - centerY(geometry.settings)) <= 1);
  assert.equal(await page.locator('#open-primary-group-manager').isVisible(), false);
  assert.ok(geometry.date.x < geometry.time.x && Math.abs(geometry.date.y - geometry.time.y) <= 1);
  assert.equal(await page.locator('#organize-notes').isVisible(), false);
  await capture('note-columns-100.png');
  await page.evaluate(({ group, list, editor, heading, search, settings }) => {
    const guides = document.createElement('div');
    guides.id = 'note-column-guides';
    Object.assign(guides.style, { position: 'fixed', inset: '0', zIndex: 15000, pointerEvents: 'none' });
    for (const x of [group.x, list.x, editor.x, search.x, list.x + search.x - group.x]) {
      const guide = document.createElement('i');
      Object.assign(guide.style, { position: 'absolute', left: x + 'px', top: '0', bottom: '0', borderLeft: '1px dashed #d25220' });
      guides.append(guide);
    }
    for (const y of [group.y, heading.y + heading.height / 2, search.y, search.y + search.height, settings.y + settings.height / 2]) {
      const guide = document.createElement('i');
      Object.assign(guide.style, { position: 'absolute', top: y + 'px', left: '0', right: '0', borderTop: '1px dashed #247548' });
      guides.append(guide);
    }
    document.body.append(guides);
  }, geometry);
  await capture('note-columns-100-guides.png');
  await page.locator('#note-column-guides').evaluate(element => element.remove());
  report.screenshots.push('note-columns-100.png', 'note-columns-100-guides.png');
  report.checks.push('chat history, expanded groups and note list share one width, with aligned 18px regular-weight notebook labels and matching search fields');

  const fold = sidebar.locator('#fold-notebook-groups');
  report.geometry.push(await checkButtonStates(page, '#fold-notebook-groups'));
  report.geometry.push(await checkButtonStates(page, `[data-note-id="${id}"]`, { current: true }));
  const foldBox = await fold.boundingBox();
  assert.ok(foldBox.x > geometry.heading.x + geometry.heading.width);
  assert.ok(Math.abs(centerY(foldBox) - centerY(geometry.heading)) <= 1);
  const groupQuery = sidebar.locator('#group-search');
  await groupQuery.fill('资料归档');
  await page.locator('#notes-query').fill('新建');
  await fold.press('Space');
  await page.waitForFunction(() => {
    const width = selector => document.querySelector(selector).getBoundingClientRect().width;
    return Math.abs(width('#primary-group-sidebar') - width('.icon-rail')) <= 1;
  });
  assert.equal(await fold.getAttribute('aria-expanded'), 'false');
  report.geometry.push(await checkButtonStates(page, '#fold-notebook-groups'));
  assert.equal(await fold.getAttribute('aria-label'), '展开分组栏');
  assert.equal(await groupQuery.isVisible(), false);
  assert.equal(await current.getAttribute('data-note-id'), id);
  assert.equal(await page.locator('#notes-query').inputValue(), '新建');
  assert.equal(await readBody(), '验收正文');
  assert.ok(Math.abs((await page.locator('.notes-navigator').boundingBox()).width - geometry.list.width) <= 1);
  await capture('note-groups-folded-100.png');
  report.screenshots.push('note-groups-folded-100.png');
  await fold.press('Enter');
  await groupQuery.waitFor({ state: 'visible' });
  assert.equal(await fold.getAttribute('aria-expanded'), 'true');
  assert.equal(await fold.getAttribute('aria-label'), '收起分组栏');
  assert.equal(await fold.evaluate(element => document.activeElement === element), true);
  assert.equal(await groupQuery.inputValue(), '资料归档');
  assert.equal(await group.getAttribute('aria-pressed'), 'true');
  assert.ok(Math.abs((await sidebar.boundingBox()).width - geometry.group.width) <= 1);
  await groupQuery.fill('');
  await page.locator('#notes-query').fill('');
  await page.waitForFunction(() => !document.querySelector('#notes-more').disabled);
  report.checks.push('desktop groups fold to the action rail width and restore via keyboard, preserving the current note, note list width and both searches');

  const row = page.locator(`[data-note-id="${id}"]`);
  await row.click({ button: 'right' });
  const menu = page.locator('.context-menu[data-popover-state=open]');
  await menu.getByRole('menuitem', { name: '重命名' }).click();
  await page.waitForFunction(() => {
    const title = document.querySelector('#note-title');
    return document.activeElement === title && title.selectionStart === 0 && title.selectionEnd === title.value.length;
  });
  await page.locator('#note-title').fill('重命名验收笔记');
  await waitSaved();
  await row.getByText('重命名验收笔记', { exact: true }).waitFor();
  await row.press('Shift+F10');
  await menu.getByRole('menuitem', { name: '复制笔记' }).click();
  await group.locator('.primary-group-count').filter({ hasText: /^2$/u }).waitFor();
  const getGroupIds = () => page.evaluate(topicId => window.inmoment.invoke('notes:listIds', { topicId }), topicId);
  const copiedId = (await getGroupIds()).ids.find(item => item !== id);
  assert.ok(copiedId);
  await page.locator('#notes-select-toggle').click();
  assert.equal(await page.locator('#notes-selection-count').textContent(), '已选 0 条');
  await page.locator('#notes-select-all').click();
  await page.waitForFunction(() => document.querySelector('#notes-selection-count').textContent === '已选 2 条');
  await page.locator(`input[data-note-choice-id="${id}"]`).click();
  assert.equal(await page.locator('#notes-select-all').evaluate(input => input.indeterminate), true);
  await page.locator('#notes-selection-actions').click();
  await menu.getByRole('menuitem', { name: '删除笔记' }).click();
  await page.locator('.confirm-popover[data-popover-state=open]').getByRole('button', { name: '删除笔记', exact: true }).click();
  await page.locator(`[data-note-id="${copiedId}"]`).waitFor({ state: 'detached' });
  assert.deepEqual((await getGroupIds()).ids, [id]);
  await page.locator('#notes-select-toggle').click();
  report.checks.push('mouse and keyboard note menus, title rename and selection, independent same-group copy, master and partial selection, confirmed bulk deletion');

  await page.evaluate(({ topicId, name }) => {
    window.auditNotesInvoke = notesView.invoke;
    window.auditNoteGroupingInputs = [];
    notesView.invoke = (method, params) => {
      if (method !== 'notes:suggestGroups') return window.auditNotesInvoke(method, params);
      window.auditNoteGroupingInputs.push(params);
      const id = params.noteIds?.[0] || 'record:audio-only-note';
      return Promise.resolve({ runId: 'test-note-grouping', groups: [{ key: 'topic:' + topicId, name, existing: true, notes: [{ id, title: '测试分组建议' }] }], unassigned: [] });
    };
  }, { topicId, name });
  const groupingDialog = page.locator('#notes-grouping-dialog');
  await row.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'AI 整理' }).click();
  await groupingDialog.getByText('测试分组建议').waitFor();
  await groupingDialog.locator('#close-notes-grouping').click();
  await groupingDialog.waitFor({ state: 'hidden' });
  await sidebar.locator('[data-library-group-id="uncategorized"]').click();
  await page.locator('#organize-notes').click();
  await groupingDialog.getByText('测试分组建议').waitFor();
  await groupingDialog.locator('#close-notes-grouping').click();
  await groupingDialog.waitFor({ state: 'hidden' });
  const groupingInputs = await page.evaluate(() => {
    notesView.invoke = window.auditNotesInvoke;
    return window.auditNoteGroupingInputs;
  });
  assert.deepEqual(groupingInputs, [{ noteIds: [id] }, { uncategorized: true }]);
  report.checks.push('single-note AI organize and uncategorized-only classification use exact scopes and show a review with mock suggestions');
  await current.waitFor({ state: 'detached' });
  assert.equal(await page.locator(`[data-note-id="${id}"]`).count(), 0);
  await page.locator('[data-note-id="record:audio-only-note"]').click();
  await page.locator('#note-group').click();
  await page.locator(`[data-group-choice-id="${topicId}"]`).click();
  await group.locator('.primary-group-count').filter({ hasText: /^2$/u }).waitFor();
  assert.deepEqual((await snapshot('record:audio-only-note')).topicIds, []);
  await group.click();
  await page.locator(`[data-note-id="${id}"]`).waitFor();
  const groupCopy = (await getGroupIds()).ids.find(item => item !== id);
  assert.ok(groupCopy && groupCopy !== 'record:audio-only-note');
  assert.deepEqual((await snapshot(groupCopy)).topicIds, [topicId]);
  await page.locator(`[data-note-id="${groupCopy}"]`).waitFor();

  await fold.press('Space');
  await resize(900, 680, 1.5);
  const drawer = page.locator('#toggle-group-sidebar');
  assert.equal(await sidebar.isVisible(), false);
  await drawer.click();
  await groupQuery.waitFor({ state: 'visible' });
  assert.equal(await fold.isVisible(), false);
  await page.waitForFunction(() => document.activeElement.getAttribute('aria-pressed') === 'true');
  assert.equal(await drawer.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  await sidebar.waitFor({ state: 'hidden' });
  assert.equal(await drawer.getAttribute('aria-expanded'), 'false');
  assert.equal(await drawer.evaluate(element => document.activeElement === element), true);
  await drawer.click();
  await sidebar.locator('[data-library-group-id="all"]').click();
  await sidebar.waitFor({ state: 'hidden' });
  await page.locator('[data-note-id="record:legacy-note"]').waitFor();
  await resize(1260, 840, 1);
  assert.equal(await fold.getAttribute('aria-expanded'), 'false');
  await fold.press('Space');
  await groupQuery.waitFor({ state: 'visible' });
  report.checks.push('equal widened notebook columns, label aligned with the corner, search before group actions, pinned uncategorized aligned with settings, grouped creation from the paper state, independent copy, accurate counts, and drawer navigation at 150%');
}

async function noteAIGeometry() {
  return page.evaluate(() => {
    const bounds = element => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
      return { left, top, right, bottom, width, height, centerY: (top + bottom) / 2 };
    };
    const root = document.querySelector('#notes-view');
    const body = root.querySelector('#note-body');
    const noteDocument = root.querySelector('.note-document');
    const panel = root.querySelector('#note-ai-inline');
    const marks = [...document.querySelectorAll('.note-selection-highlight > i')].filter(mark => mark.getClientRects().length);
    const accentSample = document.createElement('i');
    Object.assign(accentSample.style, { position: 'fixed', backgroundColor: 'var(--color-accent-soft)' });
    root.append(accentSample);
    const accentSoft = getComputedStyle(accentSample).backgroundColor;
    accentSample.remove();
    const editor = window.InMomentNoteDocument;
    const anchoredSelection = notesView.selectionGeometry.selection;
    const selection = editor.rangeInside(body, anchoredSelection?.range) ? anchoredSelection : editor.selectionOf(body);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      body: bounds(body),
      attachments: bounds(root.querySelector('#note-attachments-section')),
      documentScrollTop: noteDocument.scrollTop,
      documentHeight: noteDocument.scrollHeight,
      bodyHeight: body.scrollHeight,
      selection: selection ? [selection.start, selection.end] : null,
      panel: bounds(panel),
      position: getComputedStyle(panel).position,
      panelColor: getComputedStyle(panel).backgroundColor,
      accentSoft,
      marks: marks.map(mark => ({ ...bounds(mark), color: getComputedStyle(mark).backgroundColor })),
      input: bounds(root.querySelector('#note-ai-instruction')),
      submit: bounds(root.querySelector('#note-ai-submit')),
      accept: bounds(root.querySelector('#note-ai-accept')),
      dismiss: bounds(root.querySelector('#note-ai-dismiss')),
    };
  });
}

function assertNoteLayout(actual, before, scrollDelta = 0) {
  assert.equal(actual.documentScrollTop - before.documentScrollTop, scrollDelta);
  for (const key of ['documentHeight', 'bodyHeight']) {
    assert.equal(actual[key], before[key], 'The selection controls changed the note ' + key);
  }
  for (const key of ['body', 'attachments']) {
    const rectangle = { ...actual[key] };
    if (rectangle.height) {
      for (const coordinate of ['top', 'bottom', 'centerY']) rectangle[coordinate] += scrollDelta;
    }
    for (const [coordinate, value] of Object.entries(rectangle)) {
      assert.ok(Math.abs(value - before[key][coordinate]) <= .1, 'The selection controls changed the note ' + key + ' ' + coordinate);
    }
  }
}

function assertVisibleSelection(geometry, selectionRange, minLines = 1) {
  assert.deepEqual(geometry.selection, selectionRange, 'The source selection was changed');
  assert.ok(geometry.marks.length >= minLines, 'The source selection is no longer highlighted');
  for (const mark of geometry.marks) {
    assert.equal(mark.color, geometry.accentSoft);
    assert.ok(mark.left >= geometry.body.left - 1 && mark.right <= geometry.body.right + 1);
    assert.ok(mark.top >= geometry.body.top - 1 && mark.bottom <= geometry.body.bottom + 1);
  }
}

function assertAnchoredPanel(geometry) {
  assert.equal(geometry.position, 'fixed');
  assert.equal(geometry.panelColor, 'rgb(255, 255, 255)');
  const { panel, viewport, marks, body } = geometry;
  const lastLine = marks.at(-1);
  assert.ok(panel.left >= 0 && panel.top >= 0 && panel.right <= viewport.width + 1 && panel.bottom <= viewport.height + 1);
  assert.ok(panel.top >= lastLine.bottom && panel.top - lastLine.bottom <= 12, 'The capsule should open immediately below the last selected line');
  if (lastLine.right - panel.width >= body.left + 8) {
    assert.ok(Math.abs(panel.right - lastLine.right) <= 2, 'The capsule should align to the right edge of the last selected line');
  }
}

async function captureNoteAIGuides(filename, geometry, controls) {
  await capture(filename + '.png');
  await page.evaluate(({ geometry, controls }) => {
    const overlay = document.createElement('div');
    overlay.id = 'notes-ai-measurement-overlay';
    Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '15000', pointerEvents: 'none' });
    const guide = ({ left, top, width, height }, border) => {
      const element = document.createElement('div');
      Object.assign(element.style, { position: 'absolute', left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px', border });
      overlay.append(element);
    };
    for (const mark of geometry.marks) guide(mark, '1px dashed #d25220');
    guide(geometry.panel, '1px dashed #256d49');
    for (const key of controls) guide(geometry[key], '1px dashed #376b98');
    if (controls.length) {
      guide({ left: geometry.panel.left, top: geometry[controls[0]].centerY, width: geometry.panel.width, height: 0 }, '1px dashed #d25220');
    }
    document.body.append(overlay);
  }, { geometry, controls });
  await capture(filename + '-guides.png');
  await page.locator('#notes-ai-measurement-overlay').evaluate(node => node.remove());
  report.screenshots.push(filename + '.png', filename + '-guides.png');
}

async function assertAttachmentCorner(remove) {
  assert.equal(await remove.getAttribute('data-ui-icon'), 'close');
  const position = await remove.evaluate(button => {
    const attachment = button.closest('.note-attachment, .note-summary-attachment');
    const entry = attachment.getBoundingClientRect();
    const label = attachment.querySelector('.note-summary-title, .note-file-size').getBoundingClientRect();
    const control = button.getBoundingClientRect();
    return {
      right: entry.right - control.right, top: control.top - entry.top,
      width: control.width, height: control.height, labelGap: control.left - label.right,
      entry: entry.toJSON(), label: label.toJSON(), control: { ...control.toJSON(), centerY: (control.top + control.bottom) / 2 },
    };
  });
  assert.ok(position.right >= -1 && position.right <= 8 && position.top >= -1 && position.top <= 8);
  assert.ok(position.width <= 32 && position.height <= 32);
  assert.ok(position.labelGap >= 3, 'The corner button overlaps attachment text');
  return position;
}

async function auditNoteAI() {
  const original = '下周讨论项目。\n这里补上会议议程。';
  const selection = '下周讨论项目。';
  const replacement = '下周召开项目讨论会。';
  const parentId = 'record:legacy-note';
  const rewriteCases = [
    {
      name: 'sentence-fragment',
      original: '在情感化设计中可靠客观的获得用户的情感信息很重要，这关系到最终的设计效果。',
      selection: '中可靠客观的获得用户的情感信息很重要，这关系到最终的设计效果',
      response: '情感化设计中可靠客观地获取用户的情感信息，关系到最终的设计效果。',
      replacement: '中可靠客观地获取用户的情感信息，关系到最终的设计效果',
      expected: '在情感化设计中可靠客观地获取用户的情感信息，关系到最终的设计效果。',
    },
    {
      name: 'deepseek-recorded-output',
      original: '录音流程测试发现，截图框选松手后仍会弹出录音确认。改动是框选松手后直接开始就行，停止键位置维持原样。',
      selection: '直接开始就行',
      instruction: '改得简短正式，明确开始什么，替换后与原句前后接得上。',
      response: '框选松手后即可直接开始录音。',
      replacement: '即可直接开始录音',
      preview: '改动是框选松手后即可直接开始录音，停止键位置维持原样。',
      expected: '录音流程测试发现，截图框选松手后仍会弹出录音确认。改动是框选松手后即可直接开始录音，停止键位置维持原样。',
    },
    {
      name: 'surrounding-punctuation',
      original: '小结：这条建议还需要现场验证。',
      selection: '这条建议还需要现场验证',
      response: '：还是要在现场验证这条建议。',
      replacement: '还是要在现场验证这条建议',
      expected: '小结：还是要在现场验证这条建议。',
    },
    {
      name: 'original-repetition',
      original: '我们的设计我们的设计最重要！',
      selection: '我们的设计',
      selectionOccurrence: 'last',
      response: '我们的设计方案',
      replacement: '我们的设计方案',
      expected: '我们的设计我们的设计方案最重要！',
    },
  ];
  await assert.rejects(page.evaluate(id => window.inmoment.invoke('notes:aiSummary', { id }), parentId), /测试模式已禁用全部真实模型请求/u);
  await application.evaluate((_electron, { applicationRoot, dataDir, responses }) => {
    const path = process.mainModule.require('node:path');
    const { NoteAI } = process.mainModule.require(path.join(applicationRoot, 'src/main/note-ai.cjs'));
    const { Settings } = process.mainModule.require(path.join(applicationRoot, 'src/main/settings.cjs'));
    const { hasSelectionContextConsent } = process.mainModule.require(path.join(applicationRoot, 'src/main/cloud-permissions.cjs'));
    globalThis.noteAuditCalls = [];
    let additionAttempts = 0;
    NoteAI.prototype.prepare = function (_note, { hasSelectionRange }) {
      const includeSelectionContext = hasSelectionRange && hasSelectionContextConsent(new Settings(dataDir).public());
      return { image: null, includeSelectionContext, assertAllowed() {}, client: {
        async requestJson(system, input, { signal }) {
          globalThis.noteAuditCalls.push(input);
          if (input.instruction === '更正式' && !globalThis.finishRewriteFocusAudit) {
            await new Promise(resolve => { globalThis.finishRewriteFocusAudit = resolve; });
          } else if (input.instruction === '等编辑后返回') {
            await new Promise(resolve => { globalThis.finishLateNoteAudit = resolve; });
          } else {
            await new Promise(resolve => setTimeout(resolve, 40));
          }
          if (signal.aborted) throw new Error('Cancelled synthetic response');
          if (input.instruction === '再补充几条') {
            if (!system.includes('追加到原列表末尾')) throw new Error('Missing list-expansion instructions');
            const items = ['帮你看看这段', '根据截图帮你提炼需求或建议。', '根据截图帮你提炼需求或建议设计或文案有没有问题'];
            if (additionAttempts++ > 0) items.push('给出关键操作的验收步骤', '列出不同窗口尺寸下的边界情况');
            return { value: { items } };
          }
          const text = Object.hasOwn(input, 'body') ? '会议记录总结' : input.instruction ? responses[input.instruction] ?? '下周召开项目讨论会。' : '项目会议安排';
          return { value: { text } };
        },
      } };
    };
  }, { applicationRoot, dataDir, responses: Object.fromEntries(rewriteCases.map(({ name, instruction, response }) => [instruction ?? name, response])) });
  await page.locator('[data-note-id="record:legacy-note"]').click();
  const editor = page.locator('#note-body');
  await editor.fill(original);
  await page.locator('#note-ai-summary').click();
  const attachment = page.locator('#note-summaries .note-summary-link[data-summary-id]');
  await attachment.waitFor();
  const summaryId = await attachment.getAttribute('data-summary-id');
  const snapshot = id => page.evaluate(id => window.inmoment.invoke('notes:get', { id }), id);
  assert.equal((await snapshot(parentId)).body, original);
  assert.equal((await snapshot(summaryId)).body, '会议记录总结');
  const firstRequest = await application.evaluate(() => globalThis.noteAuditCalls[0]);
  assert.equal(firstRequest.body, original);
  assert.equal(firstRequest.source.url, 'https://example.test/background');
  assert.equal(firstRequest.source.windowTitle, '合成网页窗口');
  await attachment.click();
  await waitForNote(summaryId);
  assert.equal(await readBody(editor), '会议记录总结');
  await page.getByRole('button', { name: '返回原笔记', exact: true }).click();
  await waitForNote(parentId);
  assert.equal(await readBody(editor), original);
  report.checks.push('one-click full AI summary uses saved body and source and creates an editable note attachment');

  async function selectText(text, occurrence) {
    return editor.evaluate(async (field, { text, occurrence }) => {
      const notes = window.InMomentNoteDocument;
      const value = notes.value(field);
      const start = occurrence === 'last' ? value.lastIndexOf(text) : value.indexOf(text);
      if (start < 0) throw new Error('The selection fixture is missing');
      const end = start + text.length;
      notes.restore(field, notes.rangeAt(field, start, end));
      field.closest('.note-document').scrollTop = 0;
      // Flush the synthetic scroll before opening a menu that dismisses on scroll.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return [start, end];
    }, { text, occurrence });
  }

  async function waitForEditorSelection(range) {
    await page.waitForFunction(([start, end]) => {
      const field = document.activeElement;
      if (field.id !== 'note-body') return false;
      const selection = window.InMomentNoteDocument.selectionOf(field);
      return selection?.start === start && selection?.end === end;
    }, range);
  }

  const range = await selectText(selection);
  const before = await noteAIGeometry();
  await editor.click({ button: 'right', position: { x: 20, y: 12 } });
  const summarize = page.locator('[data-menu-id="ai-summary"]');
  const rewriteOption = page.locator('[data-menu-id="ai-rewrite"]');
  await summarize.waitFor();
  const menu = page.getByRole('menu', { name: '所选文字操作' });
  await menu.waitFor();
  (report.buttonCorners ||= []).push(await checkButtonCorners(page, 'note selection menu'));
  assert.deepEqual(await menu.locator('[data-menu-id]').evaluateAll(items => items.map(item => item.dataset.menuId)), ['ai-summary', 'ai-rewrite', 'copy', 'cut', 'paste']);
  assert.equal((await summarize.innerText()).trim(), '总结');
  assert.equal((await rewriteOption.innerText()).trim(), '改写');
  await page.locator('.note-selection-highlight > i').first().waitFor();
  const contextGeometry = await noteAIGeometry();
  assertVisibleSelection(contextGeometry, range);
  const options = menu.locator('[data-menu-id]');
  const transparent = 'rgba(0, 0, 0, 0)';
  const settleMenu = async () => {
    await page.waitForFunction(node => !node.getAnimations({ subtree: true }).some(animation => animation.playState === 'running'), await menu.elementHandle());
  };
  const optionGeometry = () => options.evaluateAll(items => items.map(item => {
    const style = getComputedStyle(item);
    return { id: item.dataset.menuId, rect: item.getBoundingClientRect().toJSON(), radius: style.borderRadius, background: style.backgroundColor };
  })).then(items => items.map(item => ({ ...item, background: normalizeButtonBackground(item.background) })));
  await page.mouse.move(1, 1);
  await settleMenu();
  const idleOptions = await optionGeometry();
  for (const option of idleOptions) {
    assert.equal(option.radius, '12px', option.id + ' needs rounded rectangle corners');
    assert.equal(option.background, transparent, option.id + ' needs a transparent idle background');
  }
  const menuGeometry = await menu.evaluate(node => ({
    ...node.getBoundingClientRect().toJSON(), radius: getComputedStyle(node).borderRadius, viewport: [innerWidth, innerHeight],
  }));
  assert.equal(menuGeometry.radius, '24px');
  assert.ok(menuGeometry.x >= 0 && menuGeometry.y >= 0 && menuGeometry.x + menuGeometry.width <= menuGeometry.viewport[0] + 1 && menuGeometry.y + menuGeometry.height <= menuGeometry.viewport[1] + 1);
  const rowGaps = idleOptions.slice(1).map((option, index) => option.rect.top - idleOptions[index].rect.bottom);
  assert.ok(Math.max(...rowGaps) - Math.min(...rowGaps) <= 1, 'Menu options need consistent spacing');
  report.geometry.push({ filename: 'notes-ai-context-100', ...menuGeometry, options: idleOptions });
  await capture('notes-ai-context-100.png');
  report.screenshots.push('notes-ai-context-100.png');
  report.geometry.push(await checkButtonStates(page, '[data-menu-id="ai-summary"]', { tone: 'green', icon: true, foreground: 'rgb(16, 39, 25)' }));
  await menu.evaluate(node => {
    node.style.outline = '1px dashed #1d573b';
    node.style.outlineOffset = '-1px';
    for (const row of node.querySelectorAll('[data-menu-id]')) row.style.boxShadow = 'inset 0 0 0 1px #376b98';
  });
  await capture('notes-ai-context-100-guides.png');
  await menu.evaluate(node => {
    node.style.removeProperty('outline');
    node.style.removeProperty('outline-offset');
    for (const row of node.querySelectorAll('[data-menu-id]')) row.style.removeProperty('box-shadow');
  });
  report.screenshots.push('notes-ai-context-100-guides.png');

  for (const [index, option] of (await options.all()).entries()) {
    await option.hover();
    await settleMenu();
    const hovered = await optionGeometry();
    assert.deepEqual(hovered, idleOptions.map((item, current) => ({
      ...item, background: current === index ? (item.id.startsWith('ai-') ? buttonTints.green.hover : buttonBackgrounds.hover) : transparent,
    })), idleOptions[index].id + ' should highlight only on hover without shifting');
    if (index === 0 || index === 3) {
      const filename = 'notes-ai-context-hover-' + idleOptions[index].id + '-100.png';
      await capture(filename);
      report.screenshots.push(filename);
    }
  }
  await page.mouse.move(1, 1);
  await page.keyboard.press('Home');
  await settleMenu();
  assert.deepEqual(await optionGeometry(), idleOptions);
  assert.deepEqual(await summarize.evaluate(element => {
    const style = getComputedStyle(element);
    return { focusVisible: element.matches(':focus-visible'), outline: style.outlineStyle, marker: style.backgroundImage.startsWith('linear-gradient') };
  }), { focusVisible: true, outline: 'none', marker: true });
  await capture('notes-ai-context-focus-100.png');
  report.screenshots.push('notes-ai-context-focus-100.png');
  report.checks.push('selection menu outer radius, transparent idle and keyboard focus, rounded rectangle hover and fixed geometry');
  await page.keyboard.press('Escape');
  await waitForEditorSelection(range);
  await page.keyboard.press('Shift+F10');
  await summarize.click();
  const result = page.locator('#note-ai-result');
  const rewritePreview = page.locator('#note-ai-preview');
  const previewReplacement = rewritePreview.locator('mark');
  const panel = page.locator('#note-ai-inline');
  const dismiss = page.locator('#note-ai-dismiss');
  await result.waitFor();
  assert.equal(await result.inputValue(), '项目会议安排');
  await result.press('Control+A');
  assert.equal(await result.evaluate(field => field.value.slice(field.selectionStart, field.selectionEnd)), '项目会议安排');
  assert.equal(await panel.evaluate(node => Boolean(node.closest('dialog'))), false);
  assert.equal(await readBody(editor), original);
  await page.waitForFunction(node => !node.getAnimations().some(animation => animation.playState === 'running'), await panel.elementHandle());
  const summaryGeometry = await noteAIGeometry();
  assertVisibleSelection(summaryGeometry, range);
  assertAnchoredPanel(summaryGeometry);
  assertNoteLayout(summaryGeometry, before);
  report.geometry.push({ filename: 'notes-ai-summary-100', ...summaryGeometry });
  await captureNoteAIGuides('notes-ai-summary-100', summaryGeometry, ['dismiss']);
  const request = await application.evaluate(() => globalThis.noteAuditCalls.at(-1));
  assert.deepEqual(request, { selection });
  assert.equal((await snapshot(parentId)).summaries.length, 1);
  await dismiss.click();
  await panel.waitFor({ state: 'hidden' });
  await waitForEditorSelection(range);
  report.checks.push('right-click and keyboard labels, preserved pale-green selection, anchored copyable summary, no note reflow, and restored selection');

  await resize(900, 680, 1.5);
  const longSelection = '这周先讨论项目计划，再核对关键排期和负责人，最后把会议议程与需要提前准备的项目资料全部整理出来。';
  const longOriginal = ['项目进度记录', longSelection + '后面的文字保持原位。', ...Array.from({ length: 35 }, (_, index) => `会议记录第 ${index + 1} 项，负责人和完成时间待更新。`)].join('\n');
  await editor.fill(longOriginal);
  const accept = page.locator('#note-ai-accept');
  const prompt = page.locator('#note-ai-instruction');
  const submit = page.getByRole('button', { name: '发送改写要求', exact: true });
  async function openRewrite(text = longSelection, occurrence) {
    const range = await selectText(text, occurrence);
    await page.keyboard.press('Shift+F10');
    await rewriteOption.click();
    await prompt.waitFor();
    return range;
  }
  const longRange = await selectText(longSelection);
  const longBefore = await noteAIGeometry();
  await openRewrite();
  assert.equal(await submit.isDisabled(), true);
  assert.deepEqual(await prompt.evaluate(field => {
    const style = getComputedStyle(field);
    const controls = [...field.form.querySelectorAll('input, textarea, button')].map(control => control.id);
    return { controls, singleLine: field.tagName === 'INPUT', focused: field === document.activeElement, border: style.borderTopWidth, outline: style.outlineStyle, shadow: style.boxShadow };
  }), { controls: ['note-ai-instruction', 'note-ai-submit'], singleLine: true, focused: true, border: '0px', outline: 'none', shadow: 'none' });
  await page.waitForFunction(node => !node.getAnimations().some(animation => animation.playState === 'running'), await panel.elementHandle());
  const promptGeometry = await noteAIGeometry();
  assertVisibleSelection(promptGeometry, longRange, 2);
  assertAnchoredPanel(promptGeometry);
  assertNoteLayout(promptGeometry, longBefore);
  assert.ok(promptGeometry.input.right <= promptGeometry.submit.left + 1);
  assert.ok(Math.abs(promptGeometry.input.centerY - promptGeometry.submit.centerY) <= 1);
  report.geometry.push({ filename: 'notes-ai-prompt-150', ...promptGeometry });
  await prompt.fill('更正式');
  await captureNoteAIGuides('notes-ai-prompt-150', promptGeometry, ['input', 'submit']);

  const scrollDelta = await editor.evaluate(field => {
    const scroller = field.closest('.note-document');
    const before = scroller.scrollTop;
    scroller.scrollTop += 20;
    return scroller.scrollTop - before;
  });
  assert.ok(scrollDelta > 10, 'The long note must scroll within the document pane');
  await page.waitForFunction(previousTop => {
    const panel = document.querySelector('#note-ai-inline');
    return Math.abs(panel.getBoundingClientRect().top - previousTop) > 10;
  }, promptGeometry.panel.top);
  const scrolled = await noteAIGeometry();
  assertVisibleSelection(scrolled, longRange, 2);
  assertAnchoredPanel(scrolled);
  assertNoteLayout(scrolled, longBefore, scrollDelta);
  assert.ok(Math.abs(scrolled.marks.at(-1).top - promptGeometry.marks.at(-1).top + scrollDelta) <= 2);
  assert.ok(Math.abs(scrolled.panel.top - promptGeometry.panel.top + scrollDelta) <= 2);
  assert.equal(await readBody(editor), longOriginal);
  await submit.click();
  await page.locator('#note-ai-inline[data-state=pending]').waitFor();
  await page.waitForFunction(() => !document.querySelector('#note-ai-form').contains(document.activeElement));
  assert.equal(await page.evaluate(() => document.activeElement.id), '');
  assert.equal(await page.locator('#note-ai-dismiss').evaluate(button => button.matches(':focus-visible')), false);
  await application.evaluate(async () => {
    for (let attempt = 0; attempt < 100 && !globalThis.finishRewriteFocusAudit; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    globalThis.finishRewriteFocusAudit();
  });
  await rewritePreview.waitFor();
  assert.equal(await previewReplacement.textContent(), replacement);
  assert.equal(await rewritePreview.evaluate(preview => preview.matches(':focus')), false);
  assert.deepEqual(await previewReplacement.evaluate(mark => ({
    color: getComputedStyle(mark).color,
    background: getComputedStyle(mark).backgroundColor,
    previewBackground: getComputedStyle(mark.closest('.note-ai-popover')).backgroundColor,
  })), { color: 'rgb(23, 26, 29)', background: 'rgb(234, 244, 237)', previewBackground: 'rgb(255, 255, 255)' });
  assert.equal(await readBody(editor), longOriginal);
  assert.deepEqual(await application.evaluate(() => globalThis.noteAuditCalls.at(-1)), { selection: longSelection, instruction: '更正式' });
  await page.waitForFunction(node => !node.getAnimations().some(animation => animation.playState === 'running'), await panel.elementHandle());
  const geometry = await noteAIGeometry();
  assertVisibleSelection(geometry, longRange, 2);
  assertAnchoredPanel(geometry);
  assertNoteLayout(geometry, longBefore, scrollDelta);
  assert.ok(Math.abs(geometry.accept.centerY - geometry.dismiss.centerY) <= 1);
  report.geometry.push({ filename: 'notes-ai-rewrite-150', ...geometry });
  await captureNoteAIGuides('notes-ai-rewrite-150', geometry, ['accept', 'dismiss']);
  report.checks.push('Rewrite stays unfocused while waiting and after result, with readable dark text on white and a pale green change highlight');
  const movePreview = page.getByRole('button', { name: '移动改写预览' });
  const handle = await movePreview.boundingBox();
  assert.ok(handle);
  const dragStart = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 25, dragStart.y + 56, { steps: 6 });
  await page.mouse.up();
  const moved = await noteAIGeometry();
  assert.ok(moved.panel.top > geometry.panel.top + 20);
  assert.ok(moved.panel.right <= moved.viewport.width + 1 && moved.panel.bottom <= moved.viewport.height + 1);
  assertVisibleSelection(moved, longRange, 2);
  assertNoteLayout(moved, longBefore, scrollDelta);
  report.geometry.push({ filename: 'notes-ai-rewrite-moved-150', ...moved });
  await captureNoteAIGuides('notes-ai-rewrite-moved-150', moved, ['accept', 'dismiss']);
  await movePreview.press('ArrowUp');
  const keyboardMoved = await noteAIGeometry();
  assert.ok(Math.abs(moved.panel.top - keyboardMoved.panel.top - 8) <= 1);
  await movePreview.click();
  const clickMoved = await noteAIGeometry();
  assert.ok(Math.abs(clickMoved.panel.top - keyboardMoved.panel.top) > 20);
  assertVisibleSelection(clickMoved, longRange, 2);
  assert.equal(await previewReplacement.textContent(), replacement);
  await dismiss.click();
  await panel.waitFor({ state: 'hidden' });
  await waitForEditorSelection(longRange);
  assert.equal(await readBody(editor), longOriginal);
  await openRewrite();
  await prompt.fill('更正式');
  await prompt.press('Enter');
  await rewritePreview.waitFor();
  await page.waitForFunction(node => !node.getAnimations().some(animation => animation.playState === 'running'), await panel.elementHandle());
  assertAnchoredPanel(await noteAIGeometry());
  await accept.click();
  const changed = longOriginal.slice(0, longRange[0]) + replacement + longOriginal.slice(longRange[1]);
  assert.equal(await readBody(editor), changed);
  await waitSaved();
  assert.equal((await snapshot(parentId)).body, changed);
  await editor.press('Control+z');
  assert.equal(await readBody(editor), longOriginal);
  await openRewrite();
  await prompt.fill('等编辑后返回');
  await submit.click();
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await application.evaluate(() => typeof globalThis.finishLateNoteAudit === 'function')) break;
    await page.waitForTimeout(25);
  }
  assert.equal(await application.evaluate(() => typeof globalThis.finishLateNoteAudit), 'function');
  const edited = longOriginal + '\n编辑中的新内容';
  await editor.fill(edited);
  await application.evaluate(() => globalThis.finishLateNoteAudit());
  await panel.waitFor({ state: 'hidden' });
  assert.ok(await accept.isHidden() || await accept.isDisabled());
  assert.equal(await readBody(editor), edited);
  report.checks.push('borderless one-line capsule, scrolling wrapped Chinese selection, reject, exact acceptance, undo, and stale result protection at 150%');
  report.checks.push('preview moves by drag, arrow keys and single click without changing selection or note geometry, and reopens at the original anchor');

  await waitSaved();
  const removeSummary = page.locator(`#note-summaries .note-summary-remove[data-attachment-id="${summaryId}"]`);
  await removeSummary.scrollIntoViewIfNeeded();
  await removeSummary.hover();
  await page.waitForFunction(button => !button.getAnimations({ subtree: true }).some(animation => animation.playState === 'running'), await removeSummary.elementHandle());
  const attachmentGeometry = await assertAttachmentCorner(removeSummary);
  report.geometry.push({ filename: 'notes-summary-attachment-150', ...attachmentGeometry });
  await captureNoteAIGuides('notes-summary-attachment-150', {
    marks: [attachmentGeometry.label], panel: attachmentGeometry.entry, control: attachmentGeometry.control,
  }, ['control']);
  await removeSummary.click();
  await attachment.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.confirm-popover[data-popover-state=open]').count(), 0);
  assert.equal((await snapshot(parentId)).summaries.length, 0);
  assert.equal((await snapshot(parentId)).body, edited);
  assert.equal(await readBody(editor), edited);
  await assert.rejects(snapshot(summaryId));
  await page.waitForFunction(() => document.activeElement.id === 'note-attach');
  report.checks.push('summary attachment corner button directly removes only the summary and restores focus');

  await resize(1260, 840, 1);
  const settingsTab = page.getByRole('button', { name: '偏好设置', exact: true });
  const notesTab = page.locator('#open-notes');
  const contextToggle = page.locator('#note-selection-context-enabled');
  const saveSettings = page.getByRole('button', { name: '保存设置', exact: true });
  const approval = page.locator('#confirm-dialog');
  const readSettings = () => page.evaluate(() => window.inmoment.invoke('settings:get'));
  const openAISettings = async () => {
    await settingsTab.click();
    await page.locator('#settings-nav-ai').click();
    await contextToggle.waitFor();
  };
  await openAISettings();
  assert.equal(await contextToggle.isChecked(), false);
  assert.equal((await readSettings()).noteSelectionContextEnabled, false);
  await contextToggle.press('Space');
  assert.equal(await contextToggle.isChecked(), true);
  await saveSettings.click();
  await approval.waitFor();
  assert.match(await approval.locator('#confirm-detail').textContent(), /900/u);
  await approval.getByRole('button', { name: '取消', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#settings-result').textContent.startsWith('已取消保存'));
  assert.equal((await readSettings()).noteSelectionContextEnabled, false);
  await saveSettings.click();
  await approval.getByRole('button', { name: '同意并保存 AI 设置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#settings-result').textContent === '设置已保存');
  assert.equal((await readSettings()).noteSelectionContextEnabled, true);
  assert.equal((await readSettings()).noteSelectionContextConsentVersion, 1);
  await notesTab.click();
  await page.locator('[data-note-id="record:legacy-note"]').click();

  const contextSelection = '重复出现的选段';
  const previousContext = `远处另一个${contextSelection}。\n${'前文🙂'.repeat(300)}甲`;
  const followingContext = `${'🦊后文'.repeat(300)}超过范围`;
  await editor.fill(previousContext + contextSelection + followingContext);
  await waitSaved();
  const contextParams = { id: parentId, selection: contextSelection, start: previousContext.length, end: previousContext.length + contextSelection.length };
  const contextWindow = { before: Array.from(previousContext).slice(-900).join(''), after: Array.from(followingContext).slice(0, 900).join('') };
  const callNoteAI = (method, params) => page.evaluate(({ method, params }) => window.inmoment.invoke(method, params), { method, params });
  await callNoteAI('notes:aiSummary', contextParams);
  const latestRequest = () => application.evaluate(() => globalThis.noteAuditCalls.at(-1));
  assert.deepEqual(await latestRequest(), { selection: contextSelection, ...contextWindow });
  const requestCount = () => application.evaluate(() => globalThis.noteAuditCalls.length);
  const countBeforeStale = await requestCount();
  await assert.rejects(callNoteAI('notes:aiRewrite', { ...contextParams, start: contextParams.start + 1, instruction: '测试失效的选区' }), /选中|选区/u);
  assert.equal(await requestCount(), countBeforeStale);
  await callNoteAI('notes:aiRewrite', { ...contextParams, instruction: '测试相邻文字' });
  assert.deepEqual(await latestRequest(), { selection: contextSelection, instruction: '测试相邻文字', ...contextWindow });
  report.checks.push('selection context defaults off, approval can be declined, opt-in sends at most 900 adjacent Unicode characters per side for the chosen occurrence');

  for (const fixture of rewriteCases) {
    await editor.fill(fixture.original);
    const [start, end] = await openRewrite(fixture.selection, fixture.selectionOccurrence);
    const before = fixture.original.slice(0, start);
    const after = fixture.original.slice(end);
    const instruction = fixture.instruction ?? fixture.name;
    await prompt.fill(instruction);
    await submit.click();
    await rewritePreview.waitFor();
    assert.equal(await rewritePreview.textContent(), fixture.preview ?? fixture.expected);
    assert.equal(await previewReplacement.textContent(), fixture.replacement);
    assert.equal(await readBody(editor), fixture.original);
    assert.deepEqual(await latestRequest(), { selection: fixture.selection, instruction, before, after });
    const geometry = await noteAIGeometry();
    assertVisibleSelection(geometry, [start, end]);
    if (fixture.name === 'sentence-fragment') {
      await captureNoteAIGuides('notes-ai-rewrite-sentence-fragment-100', geometry, ['accept', 'dismiss']);
    }
    await accept.click();
    const applied = await readBody(editor);
    assert.equal(applied, fixture.expected);
    assert.equal(applied.slice(0, start), before);
    assert.equal(applied.slice(start + fixture.replacement.length), after);
    await waitSaved();
    assert.equal((await snapshot(parentId)).body, fixture.expected);
    await editor.press('Control+z');
    assert.equal(await readBody(editor), fixture.original);
    await waitSaved();
    assert.equal((await snapshot(parentId)).body, fixture.original);
  }
  report.checks.push('exact partial-sentence rewrite previews the accepted result, removes repeated boundary text or punctuation, preserves intended original repetition, and undoes with Ctrl+Z');
  report.checks.push('replayed DeepSeek output joins its original sentence and removes the doubled phrase and extra full stop before a comma');

  await openAISettings();
  await contextToggle.press('Space');
  assert.equal(await contextToggle.isChecked(), false);
  await saveSettings.click();
  await page.waitForFunction(() => document.querySelector('#settings-result').textContent === '设置已保存');
  const disabled = await readSettings();
  assert.equal(disabled.noteSelectionContextEnabled, false);
  assert.equal(disabled.noteSelectionContextConsentVersion, 0);
  await notesTab.click();
  const { selection: repeatedSelection, original: repeatedOriginal } = rewriteCases.at(-1);
  const repeatedStart = repeatedOriginal.lastIndexOf(repeatedSelection);
  await callNoteAI('notes:aiSummary', { id: parentId, selection: repeatedSelection, start: repeatedStart, end: repeatedStart + repeatedSelection.length });
  assert.deepEqual(await latestRequest(), { selection: repeatedSelection });
  report.checks.push('turning off selection context stops sending neighboring text immediately');

  const originalList = ['- 解释这张图里某个区域的作用', '- 帮你梳理当前页面或项目内容', '- 帮你看看这段设计或文案有没有问题', '- 根据截图帮你提炼需求或建议'].join('\n');
  const afterList = '\n\n- 你想让我先关注的地方也可以直接指出来';
  const partialListSelection = '个区域的作用\n- 帮你梳理当前页面或项目内容\n- 帮你看看这段';
  const additions = '\n- 给出关键操作的验收步骤\n- 列出不同窗口尺寸下的边界情况';
  await editor.fill(originalList + afterList);
  const partialRange = await openRewrite(partialListSelection);
  await prompt.fill('再补充几条');
  await submit.click();
  await page.getByText('AI 生成的新条目不足，请重试或调整修改要求。').waitFor();
  assert.equal(await accept.isHidden(), true);
  assert.equal(await readBody(editor), originalList + afterList);
  assert.equal(await prompt.inputValue(), '再补充几条');
  await submit.click();
  await rewritePreview.waitFor();
  assert.equal(await previewReplacement.textContent(), additions);
  assert.equal(await page.locator('#note-ai-preview-label').textContent(), '高亮条目将追加到列表末尾');
  assert.deepEqual(await latestRequest(), { selection: partialListSelection, instruction: '再补充几条' });
  const additionsGeometry = await noteAIGeometry();
  assertVisibleSelection(additionsGeometry, partialRange, 2);
  await captureNoteAIGuides('notes-ai-expand-list-100', additionsGeometry, ['accept', 'dismiss']);
  await accept.click();
  assert.equal(await readBody(editor), originalList + additions + afterList);
  await waitSaved();
  assert.equal((await snapshot(parentId)).body, originalList + additions + afterList);
  await editor.press('Control+z');
  await waitSaved();
  assert.equal((await snapshot(parentId)).body, originalList + afterList);
  report.checks.push('a partial bullet-list selection appends genuinely new bullets without touching the original list, catches duplicate-only output, retries and undoes');
}

async function main() {
  await launch();
  await resize(1260, 840, 1);
  await auditNoteListDefault();
  await auditSharedShell();
  const welcomeTitle = page.getByRole('heading', { name: '写下第一句', exact: true });
  await welcomeTitle.waitFor();
  const mark = page.locator('.notes-welcome-mark');
  const markBox = await mark.boundingBox();
  const welcomeTitleBox = await welcomeTitle.boundingBox();
  assert.ok(markBox.height >= 36 && markBox.x + markBox.width < welcomeTitleBox.x);
  assert.ok(Math.abs(markBox.y + markBox.height / 2 - welcomeTitleBox.y - welcomeTitleBox.height / 2) <= 1);
  assert.deepEqual(await mark.evaluate(element => [...element.children].map(child => child.localName)), ['path', 'circle']);
  assert.equal(await mark.evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
  const recent = page.locator('#notes-recent');
  assert.equal(await recent.isVisible(), false);
  await capture('notes-welcome-100.png');
  report.screenshots.push('notes-welcome-100.png');
  const all = page.locator('[data-library-group-id="all"]');
  await page.locator('#new-note-from-empty').click();
  await page.waitForFunction(() => document.activeElement.id === 'note-title');
  assert.equal(await all.getAttribute('aria-pressed'), 'true');
  (report.buttonCorners ||= []).push(await checkButtonCorners(page, 'note editor'));
  await page.mouse.move(8, 8);
  report.geometry.push(await checkButtonStates(page, '[data-library-group-id="all"]', { current: true, icon: true }));
  report.geometry.push(await checkButtonStates(page, '[data-library-group-id="uncategorized"]', { icon: true }));
  const createNote = page.locator('#new-note');
  report.geometry.push(await checkButtonStates(page, '#new-note'));
  await page.locator('#note-body').fill('   ');
  await page.locator('#note-body').press('Control+s');
  assert.deepEqual((await page.evaluate(() => window.inmoment.invoke('notes:listIds'))).ids, []);
  await page.locator('[data-library-group-id="uncategorized"]').click();
  await page.locator('#note-editor').waitFor({ state: 'hidden' });
  assert.deepEqual((await page.evaluate(() => window.inmoment.invoke('notes:listIds'))).ids, []);
  await all.click();
  await createNote.click();
  await pasteFiles();
  const attachmentId = await page.locator('.note-list-item[aria-current=true]').getAttribute('data-note-id');
  const attachmentNote = await page.evaluate(id => window.inmoment.invoke('notes:get', { id }), attachmentId);
  assert.equal(attachmentNote.title, '');
  assert.equal(attachmentNote.body, '');
  assert.equal(attachmentNote.attachments.length, 2);
  await page.locator('#note-delete').click();
  await page.locator('.confirm-popover[data-popover-state=open]').getByRole('button', { name: '删除笔记', exact: true }).click();
  await page.locator('#note-editor').waitFor({ state: 'hidden' });
  report.checks.push('paper empty state opens a draft with the title focused, blank or whitespace note stays unsaved, first attachment creates one note');
  await page.locator('#new-note').click();
  await page.locator('#note-title').fill('周末的产品笔记');
  const body = '整理一下今天的想法。\n\n产品参考 https://example.test/notes?q=idea\n下次讨论时带上流程草图。';
  await page.locator('#note-body').fill(body + '\n<img src=x onerror="window.__noteMarkupRan=true">');
  await page.locator('#note-body').press('Control+s');
  await waitSaved();
  assert.equal(await page.locator('#note-links a').getAttribute('href'), 'https://example.test/notes?q=idea');
  assert.equal(await page.evaluate(() => window.__noteMarkupRan), undefined);
  assert.equal(await page.locator('#note-links img').count(), 0);
  await page.locator('#note-body').fill(body);
  await waitSaved();
  await pasteFiles();
  await pasteVideo();
  const firstId = await page.locator('[data-note-id][aria-current=true]').getAttribute('data-note-id');
  report.checks.push('autosave, URL linkification, inert markup, pasted image and file, pasted WebM playback');

  const explorerSource = path.join(runDir, '复制自资源管理器.pdf');
  fs.writeFileSync(explorerSource, '%PDF-1.4 synthetic fixture');
  await application.evaluate(({ clipboard }, uri) => {
    clipboard.read = async () => [{ types: ['text/uri-list'], getType: async () => new Blob([uri]) }];
  }, pathToFileURL(explorerSource).href);
  const copied = await page.evaluate(id => window.inmoment.invoke('notes:pasteFiles', { id }), firstId);
  assert.equal(copied.attachments.at(-1).name, '复制自资源管理器.pdf');
  fs.unlinkSync(explorerSource);
  report.checks.push('native copied-file format via isolated clipboard stub');

  await page.locator('#new-note').click();
  await page.locator('#note-title').fill('另一条笔记');
  await page.locator('#note-body').fill('重复切换测试，检查草稿绑定。');
  await page.locator(`[data-note-id="${firstId}"]`).click();
  await waitForNote(firstId);
  assert.equal(await readBody(), body);
  await page.locator('#notes-query').fill('另一条');
  await page.waitForFunction(() => document.querySelectorAll('.note-list-item').length === 1);
  assert.match(await page.locator('.note-list-title').textContent(), /另一条/u);
  await page.locator('#notes-query').fill('');
  await page.waitForFunction(() => document.querySelectorAll('.note-list-item').length === 2);
  await measure('notes-editor-100');

  await resize(1120, 740, 1.25);
  await measure('notes-editor-125');
  await resize(900, 680, 1.5);
  assert.equal(await page.locator('.notes-navigator').isVisible(), false);
  await measure('notes-editor-150');
  assertNoteListVisible(await noteListState('#note-back'));
  assert.equal(await page.evaluate(id => document.activeElement.dataset.noteId === id, firstId), true);
  await page.locator(`[data-note-id="${firstId}"]`).click();
  await page.locator('#note-title').waitFor();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assertNoteListVisible(await noteListState('#note-back'));
  await page.locator(`[data-note-id="${firstId}"]`).click();
  assert.equal(await page.evaluate(() => document.querySelectorAll('.ui-motion-snapshot').length), 0);
  report.checks.push('rapid editing and switching, search, and immediate narrow back with focus restoration in both motion settings');

  await application.close();
  await launch();
  await resize(1260, 840, 1);
  const recentAfterRestart = page.locator('#notes-recent');
  await recentAfterRestart.waitFor();
  assert.equal(await recentAfterRestart.getByRole('button').count(), 2);
  assertNoteListVisible(await noteListState());
  await page.waitForFunction(() => document.querySelectorAll('.note-list-item').length === 2);
  const recentNote = recentAfterRestart.locator(`[data-recent-note-id="${firstId}"]`);
  assert.match(await recentNote.locator('time').getAttribute('datetime'), /^\d{4}-\d{2}-\d{2}T/u);
  await capture('notes-welcome-recent-100.png');
  report.screenshots.push('notes-welcome-recent-100.png');
  (report.buttonCorners ||= []).push(await checkButtonCorners(page, 'notes welcome with recents'));
  await recentNote.click();
  await page.locator('#note-editor').waitFor();
  await waitForNote(firstId);
  assert.equal(await page.locator('[data-library-group-id="all"]').getAttribute('aria-pressed'), 'true');
  report.checks.push('tile-free welcome wordmark aligned to the title, empty recents hidden, saved recents available after restart and open their exact notes');
  assert.equal(await readBody(), body);
  assert.equal(await page.locator('#note-body .note-inline-media').count(), 2);
  assert.equal(await page.locator('#note-attachments .note-attachment').count(), 2);
  const fileId = copied.attachments.at(-1).id;
  const removeFile = page.locator(`#note-attachments .note-remove[data-attachment-id="${fileId}"]`);
  await assertAttachmentCorner(removeFile);
  await removeFile.click();
  await removeFile.waitFor({ state: 'detached' });
  const afterFile = await page.evaluate(id => window.inmoment.invoke('notes:get', { id }), firstId);
  assert.deepEqual(afterFile.attachments.map(item => item.id), copied.attachments.slice(0, -1).map(item => item.id));
  assert.equal(afterFile.body, body);
  assert.equal(await page.locator('.confirm-popover[data-popover-state=open]').count(), 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'notes-assets', fileId)), false);
  report.checks.push('regular attachment corner button removes only its target and file');
  await page.locator('#note-delete').click();
  await page.locator('.confirm-popover[data-popover-state=open]').getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.confirm-popover').waitFor({ state: 'detached' });
  assert.equal(await readBody(), body);
  await page.locator('#note-delete').click();
  await page.locator('.confirm-popover[data-popover-state=open]').getByRole('button', { name: '删除笔记', exact: true }).click();
  await page.locator(`[data-note-id="${firstId}"]`).waitFor({ state: 'detached' });
  assert.equal(fs.readdirSync(path.join(dataDir, 'notes-assets')).length, 0);
  report.checks.push('restart durability, delete cancellation, delete and asset cleanup');
  await auditCapturedNotes();
  await auditNotebookGroups();
  await auditTopicTree();
  await auditNoteAI();
  assert.deepEqual(report.errors, []);
}

main().catch(async error => {
  report.errors.push(error.stack || error.message);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(runDir, 'failure.png'), timeout: 3000 }).catch(() => {});
}).finally(async () => {
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ runDir, checks: report.checks, errors: report.errors }));
  if (application) await application.evaluate(({ app }, code) => app.exit(code), process.exitCode || 0).catch(() => {});
});
