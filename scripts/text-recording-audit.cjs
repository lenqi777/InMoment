'use strict';

// Exercise the production Electron renderer, IPC and file storage in a fresh
// local profile. The speech recognizer receives only generated PCM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalStore } = require('../src/core/store.cjs');
const { wavHeader } = require('../src/main/wav-writer.cjs');
const playwright = process.env.INMOMENT_PLAYWRIGHT || 'C:/Program Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1104-2876-0_26.1104.2876.0_x64__3k8sg7r9htsxt/dependencies/node/node_modules/playwright';
const { _electron } = require(playwright);

const root = path.resolve(__dirname, '..');
const packaged = process.env.INMOMENT_SMOKE_EXECUTABLE;
const applicationRoot = packaged ? path.join(path.dirname(packaged), 'resources', 'app') : root;
const output = path.join(root, '.local', 'unified-recording-audit');
fs.mkdirSync(output, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(output, 'synthetic-data-'));
const report = { dataDir, checks: [], layout: [], errors: [], externalRequests: [] };
const draftIds = ['synthetic-text-draft', 'synthetic-both-draft', 'synthetic-audio-draft'];
const savedId = 'synthetic-old-record';
const originalText = '合成语音识别结果，用于检查保存前的编辑。';

function seed() {
  const store = new LocalStore(dataDir);
  try {
    const pcm = Buffer.alloc(32000);
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 12) * 1000), i * 2);
    const bytes = Buffer.concat([wavHeader(pcm.length, 16000), pcm]);
    for (const id of draftIds) {
      const draft = store.createDraft({ id, title: '待核对的合成草稿', keepAudio: false });
      store.addSegment(draft.id, { id: draft.id + '-1', bytes, durationMs: 1000 }, store.draftToken(draft.id));
    }
    const old = store.createDraft({ id: savedId, title: '有录音的旧灵感', source: { processName: 'Synthetic Browser', url: 'https://example.test/background' } });
    store.addSegment(old.id, { id: old.id + '-1', bytes, durationMs: 1000, transcript: '已有录音的文字' }, store.draftToken(old.id));
    store.addScreenshot(old.id, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64'), { method: 'region' }, store.draftToken(old.id));
    store.complete(old.id);
  } finally { store.close(); }
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ captureScreenshots: false, inputEnabled: false, cloudEnabled: false, autoTitleEnabled: false }));
}

async function readNote(page, id) {
  return page.evaluate(id => window.inmoment.invoke('notes:get', { id: `record:${id}` }), id);
}

async function capture(application, name, filename) {
  const base64 = await application.evaluate(async ({ BrowserWindow }, name) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(name));
    return (await window.capturePage()).toPNG().toString('base64');
  }, name);
  fs.writeFileSync(path.join(output, filename), Buffer.from(base64, 'base64'));
}

async function screenshot(application, page, zoom) {
  const layout = await page.evaluate(() => {
    const bounds = selector => {
      const { left, top, right, bottom, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    return { viewport: [innerWidth, innerHeight], panel: bounds('.capture-panel'), card: bounds('#card-content'), text: bounds('#draft-transcript'), finish: bounds('#finish') };
  });
  report.layout.push({ zoom, ...layout });
  assert.ok(layout.panel.right - layout.finish.right >= 8 && layout.panel.bottom - layout.finish.bottom >= 8);
  assert.ok(layout.text.left >= layout.panel.left && layout.text.right <= layout.panel.right);
  await capture(application, '/overlay/', 'review-' + Math.round(zoom * 100) + '.png');
  const selectors = ['.capture-panel', '#card-content', '#draft-transcript', '#finish'];
  await page.evaluate(selectors => {
    selectors.forEach((selector, index) => {
      const { left, top, right, bottom } = document.querySelector(selector).getBoundingClientRect();
      const measure = document.createElement('div');
      measure.className = 'audit-measurement-line';
      Object.assign(measure.style, {
        position: 'fixed', inset: `${top}px ${innerWidth - right}px ${innerHeight - bottom}px ${left}px`,
        border: '1px solid ' + ['#cb5555', '#596ac1', '#376b98', '#a33e86'][index], zIndex: '1000', pointerEvents: 'none',
      });
      document.body.append(measure);
    });
  }, selectors);
  try { await capture(application, '/overlay/', 'review-' + Math.round(zoom * 100) + '-measurements.png'); }
  finally { await page.evaluate(() => document.querySelectorAll('.audit-measurement-line').forEach(node => node.remove())); }
}

async function checkAskAIColor(application, overlay) {
  const ask = overlay.locator('#ask-ai');
  const visual = () => ask.evaluate(button => {
    const { width, height, x, y } = button.getBoundingClientRect();
    return { color: getComputedStyle(button).color, width, height, x, y };
  });
  await overlay.mouse.move(0, 0);
  const idle = await visual();
  assert.equal(idle.color, 'rgb(37, 109, 73)');
  await capture(application, '/overlay/', 'ask-ai-default.png');
  await ask.hover();
  await overlay.waitForTimeout(220);
  assert.deepEqual(await visual(), idle);
  await capture(application, '/overlay/', 'ask-ai-hover.png');
  await overlay.mouse.down();
  try {
    assert.equal(await ask.evaluate(button => button.matches(':active')), true);
    assert.deepEqual(await visual(), idle);
    await capture(application, '/overlay/', 'ask-ai-pressed.png');
  } finally {
    await overlay.mouse.move(0, 0);
    await overlay.mouse.up();
  }
  await overlay.keyboard.press('Tab');
  await ask.focus();
  assert.equal(await ask.evaluate(button => button.matches(':focus-visible')), true);
  assert.deepEqual(await visual(), idle);
  await capture(application, '/overlay/', 'ask-ai-keyboard-focus.png');
  report.checks.push({ askAIColor: idle.color, geometry: idle, states: ['default', 'hover', 'pressed', 'keyboard focus'] });
}

async function run() {
  seed();
  const env = { ...process.env, INMOMENT_SMOKE: '1', INMOMENT_DISABLE_NETWORK: '1', INMOMENT_ASR_DIR: path.join(dataDir, 'disabled-asr'), INMOMENT_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const application = await _electron.launch({ executablePath: packaged || require('electron'), args: packaged ? [] : [root], cwd: root, env, timeout: 30000 });
  try {
    await application.firstWindow();
    const locate = async part => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const page = application.windows().find(page => page.url().includes(part));
        if (page) return page;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Audit window failed to load: ' + part + ' ' + application.windows().map(page => page.url()).join(', '));
    };
    const main = await locate('/renderer/');
    const overlay = await locate('/overlay/');
    for (const page of [main, overlay]) {
      page.on('pageerror', error => report.errors.push(error.message));
      await page.route(/^https?:\/\//u, route => { report.externalRequests.push(route.request().url()); return route.abort(); });
    }
    await application.evaluate(({ BrowserWindow }, { filename, originalText, draftIds }) => {
      const { OfflineASR } = process.mainModule.require(filename);
      OfflineASR.prototype.transcribe = async function ({ id, segments }) {
        if (!draftIds.includes(id)) throw new Error('Unexpected audit transcription input');
        await new Promise(resolve => setTimeout(resolve, 80));
        return { segments: segments.map(segment => ({ id: segment.id, text: originalText })) };
      };
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/')).show();
    }, { filename: path.join(applicationRoot, 'src/main/offline-asr.cjs'), originalText, draftIds });

    await main.waitForFunction(id => typeof state !== 'undefined' && state.drafts.some(draft => draft.id === id), draftIds[0]);
    const recovery = main.locator('#open-drafts');
    assert.equal(await recovery.getAttribute('aria-label'), '恢复录音，3 条');
    await recovery.click();
    await main.locator('#drafts-view').waitFor();
    assert.equal(await main.locator('.draft-open').count(), draftIds.length);
    await main.locator('#open-notes').click();
    await main.locator('#notes-view').waitFor();
    await main.locator('#primary-group-navigation [data-library-group-id="all"]').click();
    const keepAudio = overlay.locator('#draft-keep-audio');
    const keepText = overlay.locator('#draft-keep-text');
    const body = overlay.locator('#draft-transcript');
    for (const [index, id] of draftIds.entries()) {
      const keepRecording = index > 0;
      const keepWords = index < 2;
      const review = await main.evaluate(id => window.inmoment.invoke('draft:finish', { id }), id);
      assert.equal(review.needsTextReview, true);
      await overlay.waitForFunction(text => document.querySelector('#draft-transcript').value === text, originalText);
      assert.equal(await keepAudio.isChecked(), false);
      assert.equal(await keepText.isChecked(), true);
      assert.equal(await keepText.isDisabled(), true);
      await assert.rejects(readNote(main, id), /笔记已不存在/u);
      assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/overlay/')).isFocusable()), true);
      if (keepRecording) {
        await keepAudio.check();
        await overlay.waitForFunction(() => !document.querySelector('#draft-keep-text').disabled);
      }
      if (keepWords) {
        await body.click();
        await overlay.keyboard.press('Control+A');
        await overlay.keyboard.insertText('核对后的笔记正文。');
      } else {
        await keepText.uncheck();
        await body.waitFor({ state: 'hidden' });
        assert.equal(await keepAudio.isDisabled(), true);
      }
      if (index === 1) {
        await checkAskAIColor(application, overlay);
        for (const zoom of [1, 1.25, 1.5]) {
          await application.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/overlay/')).webContents.setZoomFactor(zoom), zoom);
          await overlay.waitForTimeout(360);
          await screenshot(application, overlay, zoom);
        }
      }
      await overlay.getByRole('button', { name: '存为笔记', exact: true }).click();
      await main.waitForFunction(async id => Boolean(await window.inmoment.invoke('notes:get', { id: `record:${id}` }).catch(() => null)), id);
      const saved = await readNote(main, id);
      assert.equal(saved.body, keepWords ? '核对后的笔记正文。' : '');
      assert.equal(saved.background?.audioSegments.length || 0, keepRecording ? 1 : 0);
      assert.equal(fs.readdirSync(path.join(dataDir, 'records', id)).filter(file => file.endsWith('.wav')).length, keepRecording ? 1 : 0);
      report.checks.push({ retained: keepRecording && keepWords ? 'audio and text' : keepRecording ? 'audio' : 'text', body: Boolean(saved.body), audioFiles: keepRecording ? 1 : 0 });
    }
    await recovery.waitFor({ state: 'hidden' });
    assert.deepEqual(await main.evaluate(async () => (await window.inmoment.invoke('app:bootstrap')).drafts), []);
    report.checks.push({ recordingRecovery: 'old drafts discoverable and entry hidden after last saved note' });
    const old = await readNote(main, savedId);
    assert.equal(old.body, '已有录音的文字');
    assert.equal(old.background.url, 'https://example.test/background');
    assert.equal(old.background.audioSegments.length, 1);
    report.checks.push({ legacyNote: true, audioFiles: 1 });
    const oldNote = main.locator(`#notes-list [data-note-id="record:${savedId}"]`);
    await oldNote.click();
    const editor = main.locator('#note-editor');
    await editor.waitFor({ state: 'visible' });
    assert.equal(await main.locator('#note-body').inputValue(), '已有录音的文字');
    await main.locator('#note-body').fill('旧录音现在可以直接编辑。');
    await main.waitForFunction(async id => (await window.inmoment.invoke('notes:get', { id })).body === '旧录音现在可以直接编辑。', `record:${savedId}`);
    const backgroundButton = main.locator('#note-background');
    await backgroundButton.click();
    const background = main.locator('#note-background-dialog');
    await background.waitFor({ state: 'visible' });
    assert.match(await background.innerText(), /https:\/\/example\.test\/background/u);
    await main.waitForFunction(() => Boolean(document.querySelector('#note-background-dialog audio')?.duration > 0));
    assert.equal(await background.getByRole('img', { name: '选区截图' }).count(), 1);
    await capture(application, '/renderer/', 'legacy-note-background.png');
    await main.keyboard.press('Escape');
    await background.waitFor({ state: 'hidden' });
    assert.equal(await backgroundButton.evaluate(button => button === document.activeElement), true);
    report.checks.push({ legacyEditor: true, backgroundDialog: true, audioMetadata: true, focusRestored: true });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.externalRequests, []);
  } finally {
    // This audit has no pending writes once its assertions complete. Close the
    // isolated process without waiting for DevTools to detach from hidden windows.
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
  }
}

run().catch(error => {
  report.errors.push(error.stack);
  process.exitCode = 1;
}).finally(() => {
  fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, checks: report.checks.length, errors: report.errors }));
});
