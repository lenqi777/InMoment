'use strict';

// Additional real-window regression coverage for long composers, Tab adoption,
// clipping and window growth. Synthetic data only; never requests a microphone,
// desktop capture, speech model, API key or cloud request.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalStore } = require('../src/core/store.cjs');
const { inspectControlReachability } = require('./ui-audit-reachability.cjs');
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, process.env.INMOMENT_SYSTEM_AUDIT_OUTPUT || '.local/system-ui-audit-20261108/supplement');
if (!output.startsWith(root + path.sep)) throw new Error('Audit output must stay inside the workspace.');
fs.mkdirSync(output, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(output, 'synthetic-data-'));
const playwrightPath = process.env.INMOMENT_PLAYWRIGHT || 'C:/Program Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1104-2876-0_26.1104.2876.0_x64__3k8sg7r9htsxt/dependencies/node/node_modules/playwright';
const { _electron } = require(playwrightPath);
const checks = [], findings = [], measurements = [], screenshots = [], errors = [];
const image = { mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V8AAAAASUVORK5CYII=' };
const longFeedback = '合成失败反馈：请检查设置后重试。'.repeat(40), longSelectedText = '这是用于验收的长引用文字。'.repeat(90);
let application, page, processHandle;
let executableReceipt;
function sourceHash() { const hash = crypto.createHash('sha256'); for (const filename of ['src/shared/chat-view.js', 'src/shared/chat-view.css', 'src/overlay/app.js', 'src/overlay/styles.css', 'src/main/main.cjs']) hash.update(fs.readFileSync(path.join(root, filename))); return hash.digest('hex'); }
const startedHash = sourceHash();
function check(name, condition, detail = {}) { checks.push({ name, pass: Boolean(condition), detail }); if (!condition) findings.push({ rule: name, detail }); }
async function settle(surface) { await surface.waitForTimeout(180); await surface.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function capture(surface, filename) {
  const url = surface.url();
  const bytes = await application.evaluate(async ({ BrowserWindow }, url) => (await BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url).capturePage()).toPNG().toString('base64'), url);
  fs.writeFileSync(path.join(output, filename), Buffer.from(bytes, 'base64')); screenshots.push(filename);
}
async function resize(surface, width, height, zoom = 1) {
  await application.evaluate(({ BrowserWindow }, value) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === value.url); window.unmaximize(); window.setMinimumSize(value.floating ? 360 : 640, value.floating ? 440 : 480); window.setContentSize(value.width, value.height); window.webContents.setZoomFactor(value.zoom); }, { url: surface.url(), width, height, zoom, floating: surface !== page });
  await settle(surface);
  // Windows DIP/device-pixel conversion can round a native setter by 1–2 DIP.
  // Validate renderer geometry against observed native content bounds, retaining
  // requested/actual sizes; the later 1s/3s stability test still detects drift.
  const native = await application.evaluate(({ BrowserWindow }, url) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url); return { bounds: window.getContentBounds(), zoom: window.webContents.getZoomFactor() }; }, surface.url());
  const expectedWidth = native.bounds.width / native.zoom;
  try { await surface.waitForFunction(width => Math.abs(innerWidth - width) <= 1, expectedWidth, { timeout: 5000 }); }
  catch (error) { const viewport = await surface.evaluate(() => ({ width: innerWidth, height: innerHeight })); throw new Error('Renderer/native width disagreement: ' + JSON.stringify({ requested: { width, height, zoom }, native, viewport }) + '; ' + error.message); }
  const viewport = await surface.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  measurements.push({ name: (surface === page ? 'main' : 'floating') + ' requested/actual resize', requested: { width, height, zoom }, native, viewport });
  check('native requested width settles within Windows rounding', Math.abs(native.bounds.width - width) <= 2, { requestedWidth: width, native, viewport });
}
async function composerUpdate(surface, fields) {
  await surface.evaluate(async fields => { const view = window.chatView; await view.flush(); await window.inmoment.invoke('chat:update', { id: view.currentId, ...fields }); }, fields);
  await settle(surface);
}
async function verifyScrollableText(surface, selector, name, expectedLength) {
  const locator = surface.locator(selector);
  await locator.evaluate(element => element.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  const area = await locator.evaluate(element => { const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return { length: element.textContent.length, top: rect.top, bottom: rect.bottom, width: rect.width, x: rect.left + Math.min(rect.width / 2, 20), y: Math.max(1, Math.min(innerHeight - 1, rect.top + Math.min(rect.height / 2, 20))), height: element.clientHeight, total: element.scrollHeight, overflow: style.overflowY }; });
  check(name + ' retained text has readable scroll area', area.length === expectedLength && area.height > 12 && (area.total <= area.height + 1 || ['auto', 'scroll'].includes(area.overflow)), { ...area, expectedLength });
  await surface.mouse.move(area.x, area.y); await surface.mouse.wheel(0, 100000); await settle(surface);
  const end = await locator.evaluate(element => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }));
  check(name + ' wheel reveals final text', Math.abs(end.top - end.max) <= 2, end);
  await surface.mouse.wheel(0, -100000); await settle(surface);
  check(name + ' wheel returns to first text', await locator.evaluate(element => element.scrollTop <= 1));
  measurements.push({ name, area, end });
}
async function layout(surface, name, content, combined = false) {
  await composerUpdate(surface, { input: '', candidate: '', images: combined ? [image, image] : [], selectedText: combined ? longSelectedText : '' });
  await surface.locator('.chat-input').fill(content);
  await surface.evaluate(error => { const view = window.chatView; view.chat.error = error; view.render(); }, combined ? longFeedback : '');
  await settle(surface);
  const result = await surface.evaluate(() => {
    const view = window.chatView, input = view.input, r = input.getBoundingClientRect(), composer = view.composer.getBoundingClientRect();
    return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, valueLength: input.value.length, input: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, clientHeight: input.clientHeight, scrollHeight: input.scrollHeight, scrollWidth: input.scrollWidth, clientWidth: input.clientWidth, fontSize: parseFloat(getComputedStyle(input).fontSize), lineHeight: parseFloat(getComputedStyle(input).lineHeight) }, composer: { top: composer.top, bottom: composer.bottom, height: composer.height }, bodyWidth: document.body.scrollWidth };
  });
  const reachable = await surface.evaluate(inspectControlReachability);
  measurements.push({ name, ...result, reachability: reachable });
  check(name + ' input retained', result.valueLength === content.length, { actual: result.valueLength, expected: content.length });
  check(name + ' no hidden controls', reachable.failures.length === 0, reachable.failures);
  check(name + ' input has usable height', result.input.height >= 30, result.input);
  check(name + ' input font remains readable', result.input.fontSize >= 14, result.input);
  check(name + ' no horizontal text clipping', result.input.scrollWidth <= result.input.clientWidth + 1, result.input);
  if (combined) { await verifyScrollableText(surface, '.chat-feedback>span', name + ' long feedback', longFeedback.length); await verifyScrollableText(surface, '.chat-attachment-text p', name + ' long quote', longSelectedText.length); }
  if (content.length >= 2000) {
    await surface.locator('.chat-input').focus(); await surface.keyboard.press('Control+End');
    await settle(surface);
    const end = await surface.locator('.chat-input').evaluate(input => ({ position: input.selectionEnd, top: input.scrollTop, height: input.clientHeight, total: input.scrollHeight, lineHeight: parseFloat(getComputedStyle(input).lineHeight), padding: parseFloat(getComputedStyle(input).paddingBottom) }));
    check(name + ' last caret line reachable', end.position === content.length && end.top + end.height >= end.total - end.lineHeight - end.padding - 1, end);
    await capture(surface, name.replace(/[^a-z0-9-]/giu, '-') + '-caret-end.png');
    await surface.keyboard.press('Control+Home');
    await settle(surface);
    const start = await surface.locator('.chat-input').evaluate(input => ({ position: input.selectionStart, top: input.scrollTop, lineHeight: parseFloat(getComputedStyle(input).lineHeight), padding: parseFloat(getComputedStyle(input).paddingTop) }));
    check(name + ' first caret line reachable', start.position === 0 && start.top < start.lineHeight / 2 + start.padding, start);
    await capture(surface, name.replace(/[^a-z0-9-]/giu, '-') + '-caret-home.png');
    const inputBounds = await surface.locator('.chat-input').boundingBox();
    await surface.mouse.move(inputBounds.x + inputBounds.width / 2, inputBounds.y + Math.min(inputBounds.height / 2, 20));
    await surface.mouse.wheel(0, 100000); await settle(surface);
    const wheelEnd = await surface.locator('.chat-input').evaluate(input => ({ top: input.scrollTop, max: input.scrollHeight - input.clientHeight }));
    check(name + ' internal wheel reaches last line', Math.abs(wheelEnd.top - wheelEnd.max) <= 2, wheelEnd);
    await surface.mouse.wheel(0, -100000); await settle(surface);
    const wheelStart = await surface.locator('.chat-input').evaluate(input => ({ top: input.scrollTop }));
    check(name + ' internal wheel reaches first line', wheelStart.top <= 1, wheelStart);
  }
  if (combined || content.length === 2000) await capture(surface, name.replace(/[^a-z0-9-]/giu, '-') + '.png');
  return result;
}
async function stableWindow(surface, name) {
  const read = () => application.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url).getContentBounds(), surface.url());
  const before = await read(), startRequests = await surface.evaluate(() => window.__systemAuditResizeRequests?.length || 0);
  await surface.waitForTimeout(1000); const at1s = await read();
  await surface.waitForTimeout(2000); const at3s = await read(), newRequests = await surface.evaluate(start => (window.__systemAuditResizeRequests || []).slice(start), startRequests);
  measurements.push({ name: name + ' native stability', before, at1s, at3s, newRequests });
  check(name + ' native bounds settle at 1s and 3s', [at1s, at3s].every(bounds => ['x', 'y', 'width', 'height'].every(key => Math.abs(bounds[key] - before[key]) <= 1)), { before, at1s, at3s });
  check(name + ' no resize feedback loop at the limit', newRequests.length <= 2, { requests: newRequests.length, newRequests });
}
async function keyboard(surface, label) {
  await composerUpdate(surface, { input: '', candidate: '用于实际按键验收的录音转写', images: [], selectedText: '' });
  await surface.evaluate(() => { const view = window.chatView; view.chat.error = ''; view.render(); view.handleEvent({ type: 'chatVoice', id: view.currentId, status: 'ready' }); view.voiceButton.focus(); });
  await surface.keyboard.press('Tab'); await settle(surface);
  let state = await surface.evaluate(() => ({ value: chatView.input.value, focus: document.activeElement === chatView.input, candidate: chatView.chat.candidate }));
  check(label + ' Tab adopts from voice focus', state.value === '用于实际按键验收的录音转写' && state.focus, state);
  await surface.keyboard.press('Tab');
  check(label + ' adopted-context Tab remains in input', await surface.evaluate(() => document.activeElement === chatView.input));
  await surface.keyboard.press('Shift+Tab');
  check(label + ' Shift+Tab preserves reverse navigation', await surface.evaluate(() => document.activeElement !== chatView.input));
  await surface.locator('.chat-input').click();
  check(label + ' click retains adopted text', await surface.locator('.chat-input').inputValue() === '用于实际按键验收的录音转写');
  await surface.locator('.chat-input').fill(''); await composerUpdate(surface, { candidate: '组合输入时不采用这段候选' });
  await surface.evaluate(() => { chatView.input.focus(); chatView.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
  await surface.keyboard.press('Tab');
  check(label + ' IME Tab does not adopt', await surface.locator('.chat-input').inputValue() === '');
  await surface.evaluate(() => chatView.input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await surface.evaluate(() => chatView.addButton.focus()); await surface.locator('.chat-add-button').click();
  await surface.keyboard.press('Tab');
  check(label + ' menu Tab is not trapped by transcript input', await surface.evaluate(() => document.activeElement !== chatView.input));
  await surface.keyboard.press('Escape');
  if (surface === page) await surface.evaluate(async () => { await chatView.open(); chatView.input.focus(); });
  else {
    // Register the new floating session with the native coordinator as a real UI
    // transition would; changing only the renderer bypasses resize ownership.
    const id = await page.evaluate(async () => { const chat = await inmoment.invoke('chat:create'); await inmoment.invoke('chat:openFloating', { id: chat.id }); return chat.id; });
    await surface.waitForFunction(id => window.chatView?.currentId === id, id);
    await surface.evaluate(() => chatView.input.focus());
  }
  await surface.keyboard.press('Tab');
  check(label + ' ordinary fresh-chat Tab navigates normally', await surface.evaluate(() => document.activeElement !== chatView.input));
  const longCandidate = '这是长转写候选。'.repeat(250).slice(0, 2000);
  await composerUpdate(surface, { input: '', candidate: longCandidate });
  await surface.evaluate(() => { chatView.handleEvent({ type: 'chatVoice', id: chatView.currentId, status: 'ready' }); chatView.voiceButton.focus(); });
  await surface.keyboard.press('Tab'); await settle(surface);
  check(label + ' 2000-character candidate adopted without truncation', await surface.locator('.chat-input').inputValue() === longCandidate);
}
async function mainUtilityCoverage() {
  check('recording guide has one visible rail entry', await page.locator('#open-guide').count() === 1 && await page.locator('#open-guide').isVisible());
  await page.locator('#open-guide').click(); await page.locator('#guide-dialog').waitFor({ state: 'visible' }); await settle(page);
  const guide = await page.evaluate(inspectControlReachability); measurements.push({ name: 'recording guide reachability', ...guide });
  check('recording guide actions reachable', guide.failures.length === 0, guide.failures); await capture(page, 'recording-guide.png');
  await page.keyboard.press('Escape'); await page.locator('#guide-dialog').waitFor({ state: 'hidden' });
  check('recording guide Escape restores help focus', await page.evaluate(() => document.activeElement.id === 'open-guide'));
  await page.locator('[data-view="settings"]').click(); await settle(page);
  for (const position of ['top', 'middle', 'bottom']) {
    await page.evaluate(position => { const body = document.querySelector('.settings-scroll-body'); body.scrollTop = position === 'top' ? 0 : position === 'middle' ? (body.scrollHeight - body.clientHeight) / 2 : body.scrollHeight; document.querySelector('#settings-result').textContent = '用于验证底部反馈不会遮挡设置表单的合成长说明。'.repeat(16); }, position);
    await settle(page);
    const footer = await page.evaluate(() => { const body = document.querySelector('.settings-scroll-body').getBoundingClientRect(), footer = document.querySelector('.settings-footer').getBoundingClientRect(), button = document.querySelector('.settings-footer button'), box = button.getBoundingClientRect(), hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2); return { bodyBottom: body.bottom, footerTop: footer.top, footerBottom: footer.bottom, viewportHeight: innerHeight, buttonBottom: box.bottom, hit: hit === button || button.contains(hit) }; });
    measurements.push({ name: 'settings footer ' + position, ...footer });
    check('settings footer ' + position + ' stays separate and clickable', footer.bodyBottom <= footer.footerTop + 1 && footer.footerBottom <= footer.viewportHeight + 1 && footer.buttonBottom <= footer.viewportHeight + 1 && footer.hit, footer);
  }
  await capture(page, 'settings-long-feedback-bottom.png');
  await page.locator('#api-key').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#settings-result').textContent.includes('设置已保存'));
  const settings = await page.evaluate(() => inmoment.invoke('settings:get'));
  check('settings Enter submit works without enabling capture or cloud', !settings.inputEnabled && !settings.captureScreenshots && !settings.cloudEnabled);
}

function report() {
  const value = { scope: 'whole-system-supplement', executableReceipt, syntheticOnly: true, dataDir, sourceHashAtStart: startedHash, sourceHashAtEnd: sourceHash(), modelRuns: 0, apiCalls: 0, microphoneActivations: 0, desktopCaptures: 0, checks, findings, errors, measurements, screenshots };
  fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify(value, null, 2) + '\n');
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><title>InMoment 整体补充验收</title><style>body{max-width:1200px;margin:32px auto;font:15px/1.7 Segoe UI,Microsoft YaHei,sans-serif;color:#171a1d}img{max-width:100%;display:block;border:1px solid #dee2e6}section{margin:32px 0}</style><h1>整体补充验收</h1><p>使用隔离合成数据。检查 ' + checks.length + ' 项，发现 ' + findings.length + ' 项。</p><p><a href="audit.json">完整测量与未通过项</a></p>' + screenshots.map(filename => '<section><h2>' + escape(filename) + '</h2><img src="' + escape(filename) + '"></section>').join(''));
}

(async () => {
  const store = new LocalStore(dataDir); try { const topics = Array.from({ length: 8 }, (_, i) => store.createTopic('合成分组 ' + (i + 1))); for (let i = 0; i < 40; i++) { const id = 'system-ui-note-' + i; store.createDraft({ id, title: i === 1 ? '很长的灵感标题'.repeat(18) : '合成灵感 ' + (i + 1), notes: '用于整体界面验收的文字。'.repeat(i === 0 ? 100 : 3), topicIds: [topics[i % topics.length].id] }); store.complete(id); } } finally { store.close(); }
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ inputEnabled: false, captureScreenshots: false, cloudEnabled: false, autoTitleEnabled: false, keyboardTrigger: 'none', apiKeyEncrypted: '' }));
  const env = { ...process.env, INMOMENT_DATA_DIR: dataDir, INMOMENT_ASR_DIR: path.join(dataDir, 'disabled-asr'), INMOMENT_DISABLE_NETWORK: '1', INMOMENT_SMOKE: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  let executablePath = require('electron'), args = [root];
  if (process.env.INMOMENT_AUDIT_APP) { executablePath = path.resolve(process.env.INMOMENT_AUDIT_APP); if (!executablePath.startsWith(path.join(root, 'dist') + path.sep) || path.basename(executablePath) !== 'InMoment.exe' || !fs.statSync(executablePath).isFile()) throw new Error('Packaged audit app must be the verified InMoment.exe in the workspace dist directory.'); args = []; }
  executableReceipt = { executablePath, packaged: Boolean(process.env.INMOMENT_AUDIT_APP), args };
  application = await _electron.launch({ executablePath, args, cwd: root, env, timeout: 30000 }); processHandle = application.process();
  await application.firstWindow(); page = application.windows().find(item => item.url().includes('/renderer/')) || await application.waitForEvent('window', { predicate: item => item.url().includes('/renderer/') });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/')).show());
  page.on('pageerror', error => errors.push(error.message)); await page.route(/^https?:\/\//u, route => { errors.push('Unexpected external request'); route.abort(); });
  await page.waitForFunction(() => window.inmoment); const boot = await page.evaluate(() => window.inmoment.invoke('app:bootstrap'));
  executableReceipt.version = boot.version;
  check('isolated runtime capture and cloud disabled', boot.settings.networkDisabled && !boot.settings.inputEnabled && !boot.settings.captureScreenshots && !boot.settings.cloudEnabled, { version: boot.version });
  await mainUtilityCoverage();
  await page.locator('#open-chat,[data-view="chat"]').first().click(); await page.waitForFunction(() => window.chatView?.currentId);
  await keyboard(page, 'main');
  const cases = [
    { name: 'main-1440-100', width: 1440, height: 900, zoom: 1 },
    { name: 'main-800-100', width: 800, height: 720, zoom: 1 },
    { name: 'main-1440-125', width: 1440, height: 900, zoom: 1.25 },
    { name: 'main-1440-150', width: 1440, height: 900, zoom: 1.5 },
  ];
  const mark = text => { const start = '开始标记START ', end = ' 结束标记END'; return start + text.slice(0, 2000 - start.length - end.length) + end; };
  const chinese = mark('这是用于检查输入框增长和内部滚动的合成文字。'.repeat(100)), latin = mark('a'.repeat(2000)), lines = mark(Array.from({ length: 100 }, (_, i) => '合成段落 ' + i + '：' + '输入文字'.repeat(6)).join('\n'));
  for (const size of cases) { await resize(page, size.width, size.height, size.zoom); await layout(page, size.name + '-empty', ''); const short = await layout(page, size.name + '-short', '一个简短的想法'); if (size.zoom === 1 && size.width === 1440) await layout(page, size.name + '-200', chinese.slice(0, 200)); const long = await layout(page, size.name + '-2000', chinese); check(size.name + ' long input does not shrink font', long.input.fontSize === short.input.fontSize, { short: short.input.fontSize, long: long.input.fontSize }); await layout(page, size.name + '-combined', lines, true); }
  await page.evaluate(async () => { await chatView.flush(); await inmoment.invoke('chat:openFloating', { id: chatView.currentId }); });
  const floating = application.windows().find(item => item.url().includes('/chat/')); if (!floating) throw new Error('Floating chat did not open.'); await floating.waitForFunction(() => window.chatView?.currentId); floating.on('pageerror', error => errors.push(error.message));
  await keyboard(floating, 'floating');
  await floating.evaluate(() => { window.__systemAuditResizeRequests = []; const original = chatView.invoke; chatView.invoke = function(method, params) { if (method === 'chat:resize') window.__systemAuditResizeRequests.push({ at: performance.now(), height: params.height }); return original.call(this, method, params); }; });
  for (const size of [{ name: 'floating-520-100', width: 520, height: 440, zoom: 1 }, { name: 'floating-360-100', width: 360, height: 440, zoom: 1 }, { name: 'floating-520-150', width: 520, height: 440, zoom: 1.5 }, { name: 'floating-360-150', width: 360, height: 440, zoom: 1.5 }]) {
    // Clear the previous extreme before setting a short window; otherwise its
    // legitimate pending growth would erase the short→long baseline.
    await composerUpdate(floating, { input: '', candidate: '', images: [], selectedText: '' });
    await floating.evaluate(() => { chatView.chat.error = ''; chatView.render(); }); await settle(floating);
    await resize(floating, size.width, size.height, size.zoom); await layout(floating, size.name + '-empty', ''); const short = await layout(floating, size.name + '-short', '一个简短的想法');
    const before = await application.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url).getContentBounds(), floating.url());
    measurements.push({ name: size.name + ' short-content native baseline', requestedHeight: size.height, before });
    const long = await layout(floating, size.name + '-2000', chinese); check(size.name + ' long input does not shrink font', long.input.fontSize === short.input.fontSize, { short: short.input.fontSize, long: long.input.fontSize }); await layout(floating, size.name + '-latin-2000', latin); await layout(floating, size.name + '-combined', lines, true);
    const native = await application.evaluate(({ BrowserWindow, screen }, url) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url), display = screen.getDisplayMatching(window.getBounds()); return { bounds: window.getContentBounds(), work: display.workArea, displayScaleFactor: display.scaleFactor }; }, floating.url());
    measurements.push({ name: size.name + ' native adaptive bounds', before, ...native });
    check(size.name + ' window remains within work area', native.bounds.y >= native.work.y && native.bounds.y + native.bounds.height <= native.work.y + native.work.height + 1, native);
    check(size.name + ' grows before using a bounded scroll area', before.height >= native.work.height - 32 || native.bounds.height > before.height, { before, ...native });
    await stableWindow(floating, size.name);
  }
  check('no renderer errors or external requests', errors.length === 0, errors);
  check('source frozen during supplement', sourceHash() === startedHash, { startedHash, finishedHash: sourceHash() });
  report(); console.log(JSON.stringify({ output, checks: checks.length, measurements: measurements.length, findings: findings.length, firstFindings: findings.slice(0, 6) })); if (findings.length) process.exitCode = 1;
})().catch(error => { findings.push({ rule: 'supplement-execution', detail: error.stack }); report(); console.error(error.message); process.exitCode = 1; }).finally(async () => { if (application) { await Promise.race([application.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]); if (processHandle?.exitCode === null) processHandle.kill(); } });
