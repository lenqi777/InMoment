'use strict';

// Isolated Electron regression audit. The recorder is mocked at the view boundary;
// transcription is a synthetic string and no model, microphone or network is used.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const { LocalStore } = require('../src/core/store.cjs');
const { checkButtonStates, checkButtonCorners, checkButtonRow } = require('./ui-audit-button-states.cjs');
const submitBackgrounds = { idle: 'rgb(234, 244, 237)', hover: 'rgb(226, 239, 230)', pressed: 'rgb(226, 239, 230)' };
function playwright() {
  for (const candidate of [process.env.INMOMENT_PLAYWRIGHT, 'playwright', path.join(path.dirname(process.execPath), '../node_modules/playwright')].filter(Boolean)) {
    try { return require(candidate); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  throw new Error('Set INMOMENT_PLAYWRIGHT to the installed Playwright package.');
}
const { _electron } = playwright();
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, process.env.INMOMENT_CHAT_COMPOSER_AUDIT_OUTPUT || '.local/chat-composer-fix-20261108');
assert.ok(output.startsWith(root + path.sep), 'Audit output must remain inside the workspace.');
fs.mkdirSync(output, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(output, 'synthetic-audit-'));
const report = { syntheticOnly: true, microphoneActivations: 0, modelRuns: 0, realAPICalls: 0, desktopCaptures: 0, dataDir, checks: [], findings: [], measurements: [], screenshots: [], rendererErrors: [] };
let application;
function check(label, passed, detail) { report.checks.push({ label, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); if (!passed) report.findings.push(label); }
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
function syntheticPng() {
  const width = 360, height = 220, rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const rgb = y < 40 ? [37, 109, 73] : (Math.floor(x / 40) + Math.floor(y / 40)) % 2 ? [234, 244, 237] : [255, 255, 255]; for (let c = 0; c < 3; c++) rows[y * (width * 3 + 1) + 1 + x * 3 + c] = rgb[c]; }
  const chunk = (kind, bytes) => { const name = Buffer.from(kind), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes]))); return Buffer.concat([length, name, bytes, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function seed() {
  const store = new LocalStore(dataDir);
  try { for (let index = 0; index < 32; index++) { const draft = store.createDraft({ title: '合成灵感 ' + (index + 1), notes: '这是一条只用于引用选择和输入回归检查的合成灵感。' }); store.complete(draft.id); } }
  finally { store.close(); }
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ inputEnabled: false, captureScreenshots: false, cloudEnabled: false, autoTitleEnabled: false, aiSearchEnabled: false, keyboardTrigger: 'none', apiKeyEncrypted: '' }));
}
async function findPage(fragment) {
  for (let count = 0; count < 100; count++) { const page = application.windows().find(item => item.url().includes(fragment)); if (page) return page; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Test window did not load: ' + fragment);
}
async function capture(page, filename, guides = false) {
  if (guides) await page.evaluate(() => {
    const layer = document.createElement('div'); layer.id = 'composer-audit-guides'; layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    for (const [selector, color] of [['.chat-composer', '#e11d48'], ['.chat-input', '#0284c7'], ['.chat-composer-tools', '#8b5cf6'], ['.chat-add-button', '#d97706'], ['.chat-send', '#059669']]) {
      const el = document.querySelector(selector); if (!el || !el.getClientRects().length) continue; const r = el.getBoundingClientRect(), box = document.createElement('div');
      box.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border:1px solid ${color};box-sizing:border-box`;
      const line = document.createElement('div'); line.style.cssText = `position:absolute;left:0;right:0;top:50%;border-top:1px dashed ${color}`; box.append(line); layer.append(box);
    }
    document.body.append(layer);
  });
  const bytes = await application.evaluate(async ({ BrowserWindow }, url) => (await BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === url).capturePage()).toPNG().toString('base64'), page.url());
  fs.writeFileSync(path.join(output, filename), Buffer.from(bytes, 'base64')); report.screenshots.push(filename);
  if (guides) await page.evaluate(() => document.querySelector('#composer-audit-guides').remove());
}
async function flush(page) { await page.evaluate(() => chatView.flush()); await page.waitForTimeout(40); }
async function candidate(page, value) { await page.evaluate(async candidate => { await inmoment.invoke('chat:update', { id: chatView.currentId, candidate }); chatView.handleEvent({ type: 'chatVoice', id: chatView.currentId, status: 'ready' }); }, value); await page.waitForTimeout(60); }
async function verifySendIcon(page, label) {
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  const send = page.getByRole('button', { name: '发送', exact: true });
  const options = { icon: true, foreground: 'rgb(16, 39, 25)', backgrounds: submitBackgrounds };
  await input.fill('  ');
  check(label + ': whitespace does not enable send', await send.isDisabled());
  report.measurements.push(await checkButtonStates(page, '.chat-send', { ...options, disabled: true }));
  await send.screenshot({ path: path.join(output, label + '-send-outline.png') });
  report.screenshots.push(label + '-send-outline.png');
  await input.fill('用于核对发送按钮。');
  await input.blur();
  check(label + ': text enables send after leaving the input', await send.isEnabled());
  report.measurements.push(await checkButtonStates(page, '.chat-send', { ...options, filledAtRest: true }));
  await send.screenshot({ path: path.join(output, label + '-send-filled.png') });
  report.screenshots.push(label + '-send-filled.png');
  await input.fill('');
  check(label + ': clearing the draft disables send again', await send.isDisabled());
  report.measurements.push(await checkButtonStates(page, '.chat-send', { ...options, disabled: true }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await input.fill('减少动态效果');
  const iconMasks = button => [...button.querySelectorAll('.ui-action-icon > span')].map(layer => {
    const { transitionDuration, clipPath } = getComputedStyle(layer);
    return { transitionDuration, clipPath };
  });
  const filled = await send.evaluate(iconMasks);
  await input.fill('');
  const outline = await send.evaluate(iconMasks);
  check(label + ': reduced motion switches both icon layers immediately',
    [...filled, ...outline].every(layer => layer.transitionDuration === '0s') &&
    filled[1].clipPath === 'inset(0px)' && outline[0].clipPath === 'inset(0px)' &&
    filled[0].clipPath !== 'inset(0px)' && outline[1].clipPath !== 'inset(0px)', { filled, outline });
  await page.emulateMedia({ reducedMotion: null });
  await flush(page);
}
async function installRecorderMock(page) {
  await page.evaluate(() => {
    const view = chatView, original = view.invoke.bind(view);
    window.composerQA = { original, recording: false, nextCandidate: '第一次录音转写候选', calls: 0, delayNextInput: false, delayed: false, imageCopies: [], textCopies: [] };
    view.invoke = async (method, params) => {
      const qa = composerQA;
      if (method === 'image:recognize') {
        const header = new DataView(params.bytes.buffer, params.bytes.byteOffset, params.bytes.byteLength);
        const bounds = { x: 10, y: 12, width: 68, height: 22 };
        return { width: header.getUint32(16), height: header.getUint32(20), text: '测试文字',
          blocks: [{ lines: [{ text: '测试文字', words: [{ text: '测试文字', bounds }] }] }] };
      }
      if (method === 'image:copyText') { qa.textCopies.push(params.text); return true; }
      if (method === 'image:copyEdited') { qa.imageCopies.push(params.bytes.byteLength); return true; }
      if (method === 'chat:record') {
        qa.calls++;
        qa.recording = true;
        view.handleEvent({ type: 'chatVoice', id: view.currentId, status: 'recording' });
        return { state: 'recording' };
      }
      if (method === 'chat:voiceStop' && qa.recording) {
        qa.calls++;
        qa.recording = false;
        view.handleEvent({ type: 'chatVoice', id: view.currentId, status: 'transcribing' });
        await original('chat:update', { id: view.currentId, candidate: qa.nextCandidate });
        view.handleEvent({ type: 'chatVoice', id: view.currentId, status: 'ready' }); return { state: 'ready' };
      }
      if (method === 'chat:update' && params.input !== undefined && qa.delayNextInput) {
        qa.delayNextInput = false; qa.delayed = true;
        await new Promise(resolve => { qa.releaseInput = resolve; });
      }
      return original(method, params);
    };
  });
}
async function regression(page, label) {
  await installRecorderMock(page);
  const input = page.locator('.chat-input'), voice = page.locator('.chat-composer [aria-label="语音输入"]');
  await input.fill(''); await flush(page);
  await voice.click(); await page.locator('.chat-composer [aria-label="结束录音并转成文字"]').click();
  await page.waitForFunction(() => chatView.voiceStatus === 'ready');
  check(label + ': microphone button becomes available after transcription', await voice.isEnabled());
  const before = await page.evaluate(() => structuredClone(chatView.chat));
  await page.evaluate(() => chatView.voiceButton.focus());
  await page.keyboard.press('Tab');
  check(label + ': Tab after microphone pause adopts transcription', await input.inputValue() === '第一次录音转写候选');
  check(label + ': Tab adoption focuses input and enables send', await page.evaluate(() => document.activeElement === chatView.input && !chatView.sendButton.disabled));
  await flush(page); await page.locator('.chat-heading h2').click();
  check(label + ': adopted transcription survives click and blur', await input.inputValue() === '第一次录音转写候选');
  await page.evaluate(chat => chatView.handleEvent({ type: 'chatChanged', chat }), before);
  check(label + ': stale input echo cannot erase adopted transcription', await input.inputValue() === '第一次录音转写候选');
  await input.fill(''); await flush(page); await candidate(page, '输入框内 Tab 候选'); await input.focus(); await page.keyboard.press('Tab');
  check(label + ': textarea Tab also adopts visible candidate', await input.inputValue() === '输入框内 Tab 候选');
  await input.fill(''); await flush(page); await candidate(page, '反向导航候选'); await voice.focus(); await page.keyboard.press('Shift+Tab');
  check(label + ': Shift+Tab preserves normal navigation', await input.inputValue() === '' && await page.evaluate(() => document.activeElement !== chatView.input));
  await input.focus(); await input.dispatchEvent('compositionstart'); await page.keyboard.press('Tab');
  check(label + ': Tab during IME composition does not adopt', await input.inputValue() === ''); await input.dispatchEvent('compositionend');
  await candidate(page, '重复的转写候选'); await page.locator('.chat-ghost').click();
  check(label + ': clicking visible candidate focuses the input and preserves the candidate', await page.evaluate(() => document.activeElement === chatView.input && chatView.ghostText.textContent === '重复的转写候选'));
  await page.evaluate(() => { composerQA.nextCandidate = '重复的转写候选'; }); await voice.click();
  check(label + ': recording hides the previous candidate', await page.evaluate(() => chatView.ghost.hidden));
  await page.locator('.chat-composer [aria-label="结束录音并转成文字"]').click();
  await page.waitForFunction(() => chatView.voiceStatus === 'ready');
  check(label + ': a new recording with same text restores candidate', await page.evaluate(() => !chatView.ghost.hidden && chatView.chat.candidate === '重复的转写候选'));
  await input.fill('用户已经输入的问题'); await flush(page); await page.evaluate(() => { composerQA.nextCandidate = '新到的识别结果'; });
  await voice.click(); await page.locator('.chat-composer [aria-label="结束录音并转成文字"]').click(); await page.waitForFunction(() => chatView.voiceStatus === 'ready');
  check(label + ': a new candidate preserves typed input', await input.inputValue() === '用户已经输入的问题');
  await input.fill(''); check(label + ': deleting to empty shows new candidate', await page.evaluate(() => !chatView.ghost.hidden && chatView.ghostText.textContent === '新到的识别结果')); await flush(page);
  await page.evaluate(() => { composerQA.delayNextInput = true; composerQA.delayed = false; }); await input.fill('较早的草稿');
  await page.waitForFunction(() => composerQA.delayed); await input.fill('较新的草稿保持在输入框'); await page.evaluate(() => composerQA.releaseInput()); await flush(page);
  check(label + ': delayed composer response preserves newer input', await input.inputValue() === '较新的草稿保持在输入框');
  check(label + ': latest typed draft reaches local service', await page.evaluate(async () => (await inmoment.invoke('chat:get', { id: chatView.currentId })).input === '较新的草稿保持在输入框'));
  await page.evaluate(() => { const old = structuredClone(chatView.chat); old.context.audioDraftId = 'synthetic-old-audio'; chatView.handleEvent({ type: 'chatChanged', chat: old }); });
  check(label + ': removed old audio action is absent from entire DOM', await page.evaluate(() => ![...chatView.root.querySelectorAll('button')].some(item => /使用刚才的录音/u.test(item.textContent))));
  await capture(page, label + '-adopted.png');
}
async function attachments(page, label, png) {
  const add = page.getByRole('button', { name: '添加内容', exact: true }); await add.click();
  await page.locator('.context-menu[data-popover-state="open"]').waitFor();
  await page.waitForTimeout(200);
  const labels = await page.locator('.context-menu[data-popover-state="open"] [data-menu-id]').evaluateAll(items => Object.fromEntries(items.map(item => [item.dataset.menuId, item.dataset.optionLabel])));
  check(label + ': plus menu exposes image, note reference and note save actions', labels.image === '添加文件或图片' && labels.inspiration === '引用笔记' && labels.whole === '存为笔记' && labels.summarize === '整理为笔记');
  await capture(page, label + '-plus-menu.png');
  (report.buttonCorners ||= []).push(await checkButtonCorners(page, label + ' chat menu'));
  const chooserPromise = page.waitForEvent('filechooser'); await page.locator('.context-menu [data-menu-id="image"]').click(); const chooser = await chooserPromise; await chooser.setFiles({ name: 'synthetic-preview.png', mimeType: 'image/png', buffer: png });
  await page.locator('.chat-attachments .chat-image-open').waitFor(); check(label + ': image thumbnail is a keyboard-accessible button', await page.locator('.chat-attachments .chat-image-open').evaluate(el => el.tagName === 'BUTTON' && Boolean(el.getAttribute('aria-label'))));
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  const draft = await input.inputValue();
  await input.fill('');
  const send = page.getByRole('button', { name: '发送', exact: true });
  check(label + ': image alone counts as sendable content', await send.isEnabled() && await send.getAttribute('data-has-send-content') === 'true');
  await input.fill(draft);
  await flush(page);
  await page.locator('.chat-attachments .chat-image-open').click(); await page.locator('.note-image-viewer[open]').waitFor(); await page.locator('.note-image-viewer .note-image-canvas img').evaluate(el => el.decode()); check(label + ': mouse opens full image preview', await page.locator('.note-image-viewer .note-image-canvas img').evaluate(el => el.naturalWidth === 360));
  const preview = page.locator('.note-image-viewer');
  const zoomValue = () => preview.locator('.note-image-scale').textContent().then(parseFloat);
  const scale = await zoomValue(); await page.getByRole('button', { name: '放大图片', exact: true }).click();
  check(label + ': preview zoom button changes image scale', await zoomValue() > scale);
  await page.getByRole('button', { name: '适应窗口', exact: true }).click(); check(label + ': fit returns preview to fit mode', await zoomValue() === scale);
  await capture(page, label + '-preview-mouse.png');
  await preview.locator('[data-action=extract]').click();
  await preview.locator('[data-action=copy-all]').click();
  check(label + ': chat image reads and copies OCR in the shared viewer', await page.evaluate(() => composerQA.textCopies.at(-1) === '测试文字'));
  check(label + ': chat image cannot insert OCR into a note', !await preview.locator('[data-action=insert-below]').isVisible());
  await preview.locator('[data-action=close-result]').click();
  await preview.locator('[data-action=edit]').click();
  const editor = preview.locator('.note-image-editor');
  check(label + ': chat image editing has no replacement action', await editor.getByRole('button', { name: '替换笔记中的图片', exact: true }).count() === 0);
  await editor.getByRole('button', { name: '向右旋转', exact: true }).click();
  await editor.getByRole('button', { name: '复制编辑后的图片', exact: true }).click();
  await page.waitForFunction(() => composerQA.imageCopies.length === 1);
  await preview.locator('[data-action=close]').click();
  const discard = page.getByRole('button', { name: '放弃修改', exact: true });
  await discard.click();
  await page.waitForTimeout(180);
  check(label + ': Escape closes preview and restores thumbnail focus', await page.locator('.note-image-viewer[open]').count() === 0 && await page.evaluate(() => document.activeElement.classList.contains('chat-image-open')));
  await page.keyboard.press('Enter'); await page.locator('.note-image-viewer[open]').waitFor(); check(label + ': Enter opens thumbnail preview', await page.locator('.note-image-viewer[open]').isVisible()); await page.keyboard.press('Escape'); await page.waitForTimeout(180);
  await add.click(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight');
  const referencePanel = page.locator('.chat-reference-panel:popover-open');
  const search = referencePanel.getByRole('searchbox', { name: '搜索可引用笔记' });
  const clear = referencePanel.getByRole('button', { name: '清空搜索' });
  await search.fill('合成灵感 32');
  const result = referencePanel.getByRole('button', { name: '合成灵感 32', exact: true });
  await result.waitFor();
  await page.keyboard.press('Tab');
  check(label + ': populated reference search has one keyboard-accessible clear button', await clear.count() === 1 && await clear.evaluate(el => document.activeElement === el));
  await page.keyboard.press('Enter');
  await referencePanel.getByRole('button', { name: '合成灵感 1', exact: true }).waitFor();
  check(label + ': clearing reference search restores results and focus', await search.inputValue() === '' && await search.evaluate(el => document.activeElement === el) && await clear.count() === 0);
  await result.click();
  check(label + ': plus menu reference selection adds a chip', await page.locator('.chat-reference-chip').count() === 1);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '移除笔记引用', exact: true }).click(); check(label + ': reference can be removed', await page.locator('.chat-reference-chip').count() === 0);
  await page.evaluate(() => { const pending = structuredClone(chatView.chat); pending.pending = true; chatView.handleEvent({ type: 'chatChanged', chat: pending }); });
  await page.waitForFunction(() => chatView.addButton.disabled);
  report.measurements.push(await checkButtonStates(page, '.chat-add-button', { disabled: true }));
  check(label + ': pending disables plus menu without hover change', true);
  await page.evaluate(async () => chatView.setChat(await inmoment.invoke('chat:get', { id: chatView.currentId })));
}
async function geometry(page, label) {
  const measurements = await page.evaluate(label => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const composer = document.querySelector('.chat-composer'), tools = document.querySelector('.chat-composer-tools'), plus = document.querySelector('.chat-add-button'), mic = chatView.voiceButton, send = chatView.sendButton;
    const boxes = { composer: rect(composer), tools: rect(tools), plus: rect(plus), mic: rect(mic), send: rect(send), input: rect(chatView.input), leftTools: rect(tools.querySelector('.chat-composer-left')), rightTools: rect(tools.querySelector('.chat-composer-right')) };
    const clustersFit = boxes.leftTools.right <= boxes.rightTools.x + .5 && boxes.rightTools.right <= boxes.tools.right + .5;
    return { label, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, boxes, clustersFit, documentOverflow: document.documentElement.scrollWidth > innerWidth + 1, composerInside: boxes.composer.x >= 0 && boxes.composer.right <= innerWidth + 1 && boxes.composer.bottom <= innerHeight + 1, sendDisabled: send.disabled };
  }, label); report.measurements.push(measurements);
  check(label + ': composer and toolbar clusters fit without overlap', measurements.composerInside && measurements.clustersFit && !measurements.documentOverflow, measurements);
  const rightTools = '.chat-composer-right';
  const tools = ['.chat-voice-button', '.chat-screenshot-button'];
  const send = await checkButtonRow(page, rightTools, [...tools, '.chat-send'], { radius: 12 });
  check(label + ': send uses an accessible sparkle with no visible text',
    await page.getByRole('button', { name: '发送', exact: true }).evaluate(button => button.dataset.uiIcon === 'sparkle' && button.textContent === ''));
  const left = await checkButtonRow(page, '.chat-composer-left', ['.chat-add-button', '.chat-model-button'], { radius: 12 });
  await page.evaluate(() => {
    const pending = structuredClone(chatView.chat);
    pending.pending = true;
    chatView.handleEvent({ type: 'chatChanged', chat: pending });
  });
  try {
    const stop = await checkButtonRow(page, rightTools, [...tools, '.chat-stop'], { radius: 12 });
    const slot = ({ row, buttons }) => {
      const { x, y, width, height } = buttons.at(-1).rect;
      return [x - row.x, y - row.y, width, height];
    };
    const sendSlot = slot(send);
    check(label + ': icon-only send and stop share the same circular slot',
      await page.getByRole('button', { name: '停止回复', exact: true }).textContent() === '' &&
      slot(stop).every((value, index) => Math.abs(value - sendSlot[index]) <= .5) &&
      Math.abs(stop.row.right - send.row.right) <= .5, { left, send, stop });
  } finally {
    await page.evaluate(async () => chatView.setChat(await inmoment.invoke('chat:get', { id: chatView.currentId })));
  }
}
async function previewGeometry(page, label) {
  const measurement = await page.evaluate(label => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    return { label, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, dialog: rect(document.querySelector('.note-image-viewer[open]')), image: rect(document.querySelector('.note-image-viewer .note-image-canvas img')), close: rect(document.querySelector('.note-image-viewer [data-action="close"]')) };
  }, label); report.measurements.push(measurement);
  const inside = box => box.x >= -1 && box.y >= -1 && box.right <= measurement.viewport.width + 1 && box.bottom <= measurement.viewport.height + 1;
  check(label + ': full preview and close control fit viewport', inside(measurement.dialog) && inside(measurement.image) && inside(measurement.close), measurement);
}
(async () => {
  seed(); const env = { ...process.env, INMOMENT_DATA_DIR: dataDir, INMOMENT_ASR_DIR: path.join(dataDir, 'disabled-asr'), INMOMENT_DISABLE_NETWORK: '1', INMOMENT_SMOKE: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const packaged = process.env.INMOMENT_SMOKE_EXECUTABLE;
  report.executable = packaged ? path.resolve(packaged) : require('electron');
  application = await _electron.launch({ executablePath: report.executable, args: packaged ? [] : [root], cwd: packaged ? path.dirname(report.executable) : root, env, timeout: 30000 }); await application.firstWindow(); const main = await findPage('/renderer/');
  main.setDefaultTimeout(8000);
  report.version = (await main.evaluate(() => window.inmoment.invoke('app:bootstrap'))).version;
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/renderer/')); window.show(); window.focus(); });
  for (const page of application.windows()) { page.on('pageerror', error => report.rendererErrors.push(error.message)); await page.route(/^https?:\/\//u, route => { report.rendererErrors.push('Blocked external request'); route.abort(); }); }
  await main.waitForFunction(() => typeof state !== 'undefined' && state.settings?.networkDisabled && !state.loading);
  await main.locator('[data-view="chat"]').click(); await main.waitForFunction(() => window.chatView?.currentId);
  report.measurements.push(await checkButtonStates(main, '.chat-history-new'));
  await verifySendIcon(main, 'main');
  await regression(main, 'main'); await attachments(main, 'main', syntheticPng());
  for (const size of [{ width: 1440, height: 900, zoom: 1 }, { width: 800, height: 720, zoom: 1.5 }]) {
    await application.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/renderer/')); window.setMinimumSize(640, 480); window.setContentSize(size.width, size.height); window.webContents.setZoomFactor(size.zoom); }, size); await main.waitForTimeout(220);
    const label = 'main-' + size.width + '-' + size.zoom; await geometry(main, label); await capture(main, label + '.png'); await capture(main, label + '-overlay.png', true);
    await main.locator('.chat-attachments .chat-image-open').click(); await main.locator('.note-image-viewer[open]').waitFor(); await main.waitForTimeout(250); await previewGeometry(main, label + '-preview'); await capture(main, label + '-preview.png'); await main.keyboard.press('Escape'); await main.waitForTimeout(180);
  }
  await main.getByRole('button', { name: '移除图片 1', exact: true }).click(); check('main: removing thumbnail removes image attachment', await main.locator('.chat-attachments .chat-image-open').count() === 0);
  const id = await main.evaluate(async () => (await inmoment.invoke('chat:create')).id); await main.evaluate(id => inmoment.invoke('chat:openFloating', { id }), id); const floating = await findPage('/chat/'); floating.on('pageerror', error => report.rendererErrors.push(error.message)); await floating.waitForFunction(() => window.chatView?.currentId);
  floating.setDefaultTimeout(8000);
  report.measurements.push(await checkButtonStates(floating, '.chat-screenshot-button', { tone: 'green' }));
  report.measurements.push(await checkButtonStates(floating, '.chat-voice-button', { tone: 'green' }));
  await verifySendIcon(floating, 'floating');
  await regression(floating, 'floating'); await attachments(floating, 'floating', syntheticPng());
  report.measurements.push(await checkButtonStates(floating, '.chat-save', { tone: 'green', icon: true, foreground: 'rgb(37, 109, 73)' }));
  for (const size of [{ width: 520, height: 680, zoom: 1 }, { width: 386, height: 530, zoom: 1.2 }, { width: 360, height: 480, zoom: 1.5 }, { width: 560, height: 700, zoom: 2 }]) {
    await application.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/chat/')); window.setMinimumSize(320, 400); window.setContentSize(size.width, size.height); window.webContents.setZoomFactor(size.zoom); }, size); await floating.waitForTimeout(220);
    const label = 'floating-' + size.width + '-' + size.zoom; await geometry(floating, label); await capture(floating, label + '.png'); await capture(floating, label + '-overlay.png', true);
    await floating.locator('.chat-attachments .chat-image-open').click(); await floating.locator('.note-image-viewer[open]').waitFor(); await floating.waitForTimeout(250); await previewGeometry(floating, label + '-preview'); await capture(floating, label + '-preview.png'); await floating.keyboard.press('Escape'); await floating.waitForTimeout(180);
  }
  await floating.getByRole('button', { name: '移除图片 1', exact: true }).click(); check('floating: removing thumbnail removes image attachment', await floating.locator('.chat-attachments .chat-image-open').count() === 0);
  await floating.locator('.chat-save').click();
  await floating.locator('.chat-save[aria-pressed="true"]:disabled').waitFor();
  report.measurements.push(await checkButtonStates(floating, '.chat-save', { current: true, disabled: true, tone: 'green', icon: true, foreground: 'rgb(37, 109, 73)' }));
  check('no renderer errors', report.rendererErrors.length === 0, report.rendererErrors);
  if (report.findings.length) process.exitCode = 1;
})().catch(error => { report.findings.push(error.message); report.failure = error.stack; process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, checks: report.checks.length, findings: report.findings, measurements: report.measurements.length, screenshots: report.screenshots.length }));
  if (application) { try { await application.evaluate(({ app }) => app.exit(0)); } catch {} try { await application.close(); } catch {} }
});
