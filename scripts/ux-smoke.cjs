'use strict';

// Real renderer and IPC against an isolated, synthetic-only library. No model,
// recording, screenshot capture, user settings or user database is used.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { LocalStore } = require('../src/core/store.cjs');
const { checkBatchResultsLayout } = require('./batch-results-layout-check.cjs');
const { checkGroupManagementLayout } = require('./group-management-layout-check.cjs');
const { _electron } = require(process.env.INMOMENT_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.local'), { recursive: true });
const dataDir = fs.mkdtempSync(path.join(root, '.local', 'ux-smoke-'));
const outputDir = path.join(root, 'test-results', 'ux');
fs.mkdirSync(outputDir, { recursive: true });

function silentWav() {
  const bytes = Buffer.alloc(44 + 32000);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(32000, 40); return bytes;
}

function seedLibrary() {
  const store = new LocalStore(dataDir);
  try {
    const topics = ['信息管理', '求职作品集', '思考回溯', '分类体验', '日常生活', '视觉设计', '检索体验', '用于检查超长主题名换行与缩放时可读性的模拟主题名称'].map(name => store.createTopic(name));
    const records = [];
    for (let index = 0; index < 48; index += 1) {
      const id = `ux-record-${String(index + 1).padStart(2, '0')}`;
      const label = ['收藏时留下为什么觉得有用', '先记录，再慢慢选择主题', '自由发散以后回到原任务', '作品集展示决策和取舍'][index % 4];
      const title = index < 2 ? '超长标题可读性检查：' + '保留灵感发生的原因以及当时正在解决的问题，'.repeat(8) : `${label} · 模拟 ${index + 1}`;
      const transcript = `这是一条合成灵感，用于界面验证：${label}。不要只保存链接，也留下当时正在解决什么、看到什么以及为什么产生了这个联想。记录 ${index + 1} 的内容和附件必须保持独立。`;
      store.createDraft({ id, title, notes: transcript, task: index % 3 ? '研究产品设计与灵感找回' : '', createdAt: Date.now() - index * 86400000, topicIds: index % 5 === 0 ? [] : [...new Set([topics[0].id, topics[index % topics.length].id])], parentId: index === 13 ? 'ux-record-01' : null, source: { processName: 'SyntheticBrowser', title: '用于布局检查的模拟来源窗口', url: 'https://example.com/' + 'long-visible-source-context/'.repeat(8) } });
      store.addSegment(id, { id: id + '-audio', bytes: silentWav(), transcript, durationMs: 1000 });
      if (index < 4) store.addScreenshot(id, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6KyEAAAAASUVORK5CYII=', 'base64'), { width: 1, height: 1, synthetic: true });
      const record = store.complete(id);
      if (index % 3 === 0) store.saveOrganization(id, { schemaVersion: 2, summary: label + '。把个人联想与触发它的信息放在一起，方便以后重新理解。', evidence: [{ segmentId: id + '-audio', quote: '不要只保存链接' }], points: [], uncertainties: ['这是一条合成测试记录，不代表真实用户需求。'], topicSuggestions: ['信息管理', '新的模拟分组'] });
      store.setJob(id, 'transcribe', 'completed'); store.setJob(id, 'title', 'completed');
      records.push(record);
    }
    const groups = [];
    for (let index = 0; index < 6; index += 1) {
      const left = records[index * 2], right = records[index * 2 + 1];
      const candidate = store.saveDuplicateSuggestions([{ leftId: left.id, rightId: right.id, leftVersion: left.version, rightVersion: right.version, reason: '合成对照：留下当时的联想', leftQuote: '不要只保存链接', rightQuote: '不要只保存链接' }])[0];
      const group = store.decideDuplicate(candidate.id, 'group');
      groups.push(store.renameGroup ? store.renameGroup(group.id, `测试分组 ${index + 1}：${index % 2 ? '整理与分类' : '保留思考情境'}`) : group);
    }
    store.saveDuplicateSuggestions([{ leftId: records[20].id, rightId: records[21].id, leftVersion: records[20].version, rightVersion: records[21].version, reason: '待确认的合成相似候选', leftQuote: '不要只保存链接', rightQuote: '不要只保存链接' }]);
    store.createDraft({ id: 'ux-pending-draft', title: '未完成的合成记录', source: { processName: 'SyntheticBrowser', title: '草稿布局检查' } });
    store.addSegment('ux-pending-draft', { bytes: silentWav(), transcript: '尚未完成的合成表达。', durationMs: 1000 });
    return { recordIds: records.map(record => record.id), groupIds: groups.map(group => group.id), topicIds: topics.map(topic => topic.id) };
  } finally { store.close(); }
}

function originalAttachments(directory = dataDir) {
  const hashes = new Map();
  function visit(current) { for (const entry of fs.readdirSync(current, { withFileTypes: true })) { const filename = path.join(current, entry.name); if (entry.isDirectory()) visit(filename); else if (entry.name.endsWith('.wav')) hashes.set(entry.name, createHash('sha256').update(fs.readFileSync(filename)).digest('hex')); } }
  visit(directory); return hashes;
}

async function waitFor(read, accepts, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  do { const result = await read(); if (accepts(result)) return result; await new Promise(resolve => setTimeout(resolve, 75)); } while (Date.now() < deadline);
  throw new Error('Timed out: ' + label);
}

async function checkRows(page, selector, label) {
  const result = await page.locator(selector).evaluateAll(cards => cards.map(card => {
    const heading = card.querySelector('h3') || card.querySelector('.draft-open');
    const rect = card.getBoundingClientRect(); const textRect = heading?.getBoundingClientRect();
    return { id: card.getAttribute('data-record-id'), x: rect.x, y: rect.y, width: rect.width, height: rect.height, hiddenTitle: Boolean(textRect && (textRect.bottom > rect.bottom + 1 || textRect.top < rect.top - 1)), shrink: getComputedStyle(card).flexShrink };
  }));
  assert.ok(result.length > 0, label + ': records must be present');
  assert.ok(result.every(item => !item.hiddenTitle && item.height >= 50), label + ': every card must retain its title and readable height: ' + JSON.stringify(result));
  const lines = await page.locator(selector).evaluateAll(cards => cards.flatMap(card => [...card.querySelectorAll('h3,.card-preview')].filter(item => item.getBoundingClientRect().height).map(item => ({ height:item.getBoundingClientRect().height, line:Number.parseFloat(getComputedStyle(item).lineHeight), whiteSpace:getComputedStyle(item).whiteSpace }))));
  assert.ok(lines.every(item => item.whiteSpace === 'nowrap' && item.height <= item.line + 1), label + ': title and brief each occupy one line');
  for (let left = 0; left < result.length; left += 1) for (let right = left + 1; right < result.length; right += 1) {
    const a = result[left], b = result[right];
    const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    assert.ok(overlapX <= 1 || overlapY <= 1, label + ': cards must not cover each other: ' + a.id + '/' + b.id);
  }
  return result;
}

async function checkOverflow(page, label) {
  const sizes = await page.evaluate(() => {
    const clipped = [];
    for (const element of document.querySelectorAll('.workspace,.page-view:not(.hidden),.collection-body,.record-list,.record-detail,.page-heading,.collection-toolbar,.search-box,.library-filters')) {
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height && (rect.right > innerWidth + 2 || rect.left < -2)) clipped.push({ element: element.id || element.className, left: Math.round(rect.left), right: Math.round(rect.right) });
    }
    return { width: innerWidth, height: innerHeight, scale: devicePixelRatio, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth, clipped };
  });
  assert.ok(sizes.scroll <= sizes.width + 2 && sizes.body <= sizes.width + 2, label + ': no page-level horizontal overflow: ' + JSON.stringify(sizes));
  assert.equal(sizes.clipped.length, 0, label + ': key panes must fit the visible viewport: ' + JSON.stringify(sizes));
  return sizes;
}

let application;
async function captureOwnWindow(filename) {
  await new Promise(resolve => setTimeout(resolve, 220));
  // Electron's complete compositor image avoids Playwright viewport clipping
  // when the BrowserWindow zoom differs from the display's scale factor.
  const png = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/'));
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    return (await window.capturePage()).toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(outputDir, filename), Buffer.from(png, 'base64'));
}
(async () => {
  const fixture = seedLibrary();
  const attachmentHashes = originalAttachments();
  const settingsPath = path.join(dataDir, 'settings.json');
  const settingsText = JSON.stringify({ inputEnabled: false, captureScreenshots: false, cloudEnabled: false, autoTitleEnabled: false, aiSearchEnabled: false, duplicateAnalysisEnabled: false, keyboardTrigger: 'F9', thresholdMs: 1650, apiKeyEncrypted: '' }, null, 2);
  fs.writeFileSync(settingsPath, settingsText);
  const env = { ...process.env, INMOMENT_DATA_DIR: dataDir, INMOMENT_ASR_DIR: path.join(dataDir, 'disabled-asr'), INMOMENT_DISABLE_NETWORK: '1', INMOMENT_SMOKE: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const portable = process.env.INMOMENT_SMOKE_EXECUTABLE;
  application = await _electron.launch({ executablePath: portable || require('electron'), args: portable ? [] : [root], cwd: root, env, timeout: 30000 });
  await application.firstWindow();
  await application.evaluate(({ BrowserWindow, shell }) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/')).show();
    globalThis.__uxShell = [];
    shell.openPath = async filename => { globalThis.__uxShell.push({ type: 'open', filename }); return ''; };
    shell.showItemInFolder = filename => { globalThis.__uxShell.push({ type: 'reveal', filename }); };
  });
  const page = application.windows().find(window => window.url().includes('/renderer/')) || await application.waitForEvent('window', { predicate: window => window.url().includes('/renderer/') });
  const semanticStatus = await page.evaluate(() => window.inmoment.invoke('semantic:status'));
  if (portable && fs.existsSync(path.join(path.dirname(portable), 'offline-semantic'))) {
    assert.equal(semanticStatus.installed, true, 'portable model must be available without another download');
    assert.equal(path.resolve(semanticStatus.modelDirectory), path.resolve(path.dirname(portable), 'offline-semantic'));
  }
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const nav = id => page.locator('#primary-group-navigation [data-library-group-id="' + id + '"]');
  const detail = page.locator('#record-detail');
  async function allCards() {
    while (await page.locator('#load-more').isVisible()) {
      const before = await page.locator('#record-list .record-card').count();
      await page.locator('#load-more').click();
      await waitFor(() => page.locator('#record-list .record-card').count(), count => count > before, 'group pagination');
    }
  }
  async function openGroup(id) {
    const toggle = page.locator('#toggle-group-sidebar');
    if (!await nav(id).isVisible() && await toggle.isVisible()) await toggle.click();
    await nav(id).click();
    await waitFor(() => page.locator('body').getAttribute('class'), value => !String(value).split(/\s/u).includes('record-detail-open'), 'group grid');
    await allCards();
  }
  async function openRecord(id) {
    await page.locator('#record-list [data-record-open-id="' + id + '"]').click();
    await detail.locator('[data-action="rename-record"]').waitFor();
  }
  async function answer(label) {
    await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
    await page.locator('#confirm-actions').getByRole('button', { name: label, exact: true }).click();
    await waitFor(() => page.locator('#confirm-dialog').evaluate(item => item.open), value => !value, 'app confirmation close');
  }
  await nav('uncategorized').waitFor();
  const boot = await page.evaluate(() => window.inmoment.invoke('app:bootstrap'));
  assert.equal(boot.recordCount, 48); assert.equal(boot.groups.length, 6); assert.equal(boot.topics.length, 8); assert.equal(boot.settings.networkDisabled, true);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), settingsText);
  const unclassified = await page.evaluate(() => window.inmoment.invoke('records:list', { filters: { uncategorized: true } }));
  await waitFor(() => page.locator('#record-list .record-card').count(), count => count === unclassified.total, 'default unclassified');
  assert.equal(await nav('uncategorized').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#primary-group-navigation [data-library-group-id]').count(), 9);
  const navRects = await page.locator('#primary-group-navigation [data-library-group-id]').evaluateAll(items => items.map(item => { const rect = item.getBoundingClientRect(); return { x: rect.x, y: rect.y }; }));
  assert.ok(navRects.every((rect, i) => i === 0 || rect.y > navRects[i - 1].y), 'groups form one vertical list');
  await captureOwnWindow('default-unclassified.png');
  await openGroup(fixture.topicIds[0]);
  const scoped = await page.evaluate(id => window.inmoment.invoke('records:list', { filters: { topicIds: [id] } }), fixture.topicIds[0]);
  assert.equal(await page.locator('#record-list .record-card').count(), scoped.total);
  assert.ok(scoped.total > 30, 'large synthetic group covers list compression regression');
  const measurements = [];
  for (const size of [{ width: 1320, height: 900, zoom: 1 }, { width: 1000, height: 700, zoom: 1 }, { width: 1600, height: 900, zoom: 1 }, { width: 2560, height: 1400, zoom: 1 }, { width: 1100, height: 760, zoom: 1.25 }, { width: 1320, height: 900, zoom: 1.5 }]) {
    await application.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/')); window.setContentSize(size.width, size.height); window.webContents.setZoomFactor(size.zoom); }, size);
    await page.waitForTimeout(160);
    const gridRows = await checkRows(page, '#record-list .record-card', 'grid ' + JSON.stringify(size));
    const gridViewport = await checkOverflow(page, 'grid ' + JSON.stringify(size));
    await captureOwnWindow('grid-' + size.width + 'x' + size.height + '-' + size.zoom + '.png');
    await openRecord(fixture.recordIds[1]);
    await page.waitForTimeout(80);
    const listRows = await checkRows(page, '#record-list .record-card', 'list ' + JSON.stringify(size));
    const detailViewport = await checkOverflow(page, 'detail ' + JSON.stringify(size));
    const fullHeight = await page.locator('#record-column').evaluate(element => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: innerHeight }; });
    assert.ok(Math.abs(fullHeight.top) < 1 && Math.abs(fullHeight.bottom - fullHeight.height) < 2, 'record column spans the entire window');
    assert.ok(Math.max(...listRows.map(row => row.height)) - Math.min(...listRows.map(row => row.height)) < 2, 'one and two line titles share the same record-row height');
    const titleOnly = await page.locator('#record-column .record-open').evaluateAll(items => items.map(item => { const rect=item.getBoundingClientRect(), title=item.querySelector('h3').getBoundingClientRect();return { height:rect.height, centered:Math.abs((title.top+title.bottom-rect.top-rect.bottom)/2)<1, visible:[...item.children].filter(child=>child.getBoundingClientRect().height).map(child=>child.tagName), color:getComputedStyle(item.querySelector('h3')).color }; }));
    assert.ok(titleOnly.every(item=>item.height>=50 && item.height<=52 && item.centered && item.visible.length===1 && item.visible[0]==='H3'), 'narrow rows contain only the centered title: '+JSON.stringify(titleOnly));
    assert.ok(titleOnly.every(item=>{const rgb=item.color.match(/\d+/g).map(Number);return Math.max(...rgb.slice(0,3))-Math.min(...rgb.slice(0,3))<8;}),'record titles use neutral dark text');
    const widths = await page.evaluate(() => {
      const rail = document.querySelector('.icon-rail') || document.querySelector('.sidebar');
      const groups = document.querySelector('.library-sidebar');
      const list = document.querySelector('#record-list'); const detail = document.querySelector('#record-detail');
      const width = item => item ? item.getBoundingClientRect().width : 0;
      return { rail: width(rail), groups: width(groups), list: width(list), detail: width(detail), window: innerWidth };
    });
    if (widths.window >= 1000) {
      assert.ok(widths.groups > 0 && Math.abs(widths.groups - widths.list) <= 2, 'group and record columns have equal widths: ' + JSON.stringify(widths));
      const ratio = (widths.rail + widths.groups + widths.list) / widths.window;
      assert.ok(ratio >= 0.24 && ratio <= 0.34, 'navigation occupies about one quarter to one third: ' + JSON.stringify(widths));
      assert.ok(widths.detail > widths.groups * 2, 'detail receives the main reading area');
    }
    assert.equal(await detail.locator('.record-text-panel').count(), 1);
    const order = await detail.evaluate(root => { const selectors = ['.record-text-panel', '.record-screenshot-section', '.record-audio-section']; return selectors.map(selector => root.querySelector(selector)?.getBoundingClientRect().top); });
    assert.ok(order.every(Number.isFinite) && order[0] < order[1] && order[1] < order[2], 'text, screenshot and original audio retain the requested order');
    await captureOwnWindow('detail-' + size.width + 'x' + size.height + '-' + size.zoom + '.png');
    measurements.push({ ...size, gridViewport, detailViewport, gridCards: gridRows.length, listCards: listRows.length, widths });
    await page.locator('#back-to-group-home').click();
    await waitFor(() => page.locator('body').getAttribute('class'), value => !String(value).includes('record-detail-open'), 'return from detail to grid');
  }
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/')); window.setContentSize(1320, 900); window.webContents.setZoomFactor(1); });
  await openGroup('uncategorized');
  const swipeId = fixture.recordIds[10];
  const swipeCard = page.locator('#record-list [data-record-id="' + swipeId + '"]');
  assert.equal(await swipeCard.locator('.card-delete').isVisible(), false, 'destructive actions are tucked away');
  await swipeCard.locator('.record-actions-toggle').click();
  await page.locator('.context-menu [data-menu-id="group"]').waitFor();
  assert.equal(await swipeCard.evaluate(item=>item.classList.contains('actions-open')),false,'grid cards use a menu without sliding');
  await captureOwnWindow('grid-action-menu.png');
  await page.locator('.context-menu [data-menu-id="group"]').click();
  await page.locator('.group-picker-search').fill('信息');
  assert.equal(await page.locator('.group-picker-option').count(), 1, 'group picker searches existing groups');
  await page.locator('.group-picker-search').evaluate(input => { input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',isComposing:true,bubbles:true})); });
  assert.equal(await page.locator('.group-picker').count(), 1, 'confirming Chinese IME text never adopts a group');
  assert.equal(await page.locator('.group-picker-search').evaluate(input => document.activeElement === input), true, 'IME arrows stay in the text field');
  await captureOwnWindow('group-picker.png');
  await page.locator('.group-picker-search').press('ArrowDown'); await page.keyboard.press('Enter');
  await waitFor(() => page.evaluate(id => window.inmoment.invoke('records:get', { id }), swipeId), record => record.topicIds.includes(fixture.topicIds[0]), 'swipe add-to-group saves the chosen group');
  assert.equal(await nav('uncategorized').getAttribute('aria-pressed'), 'true', 'group assignment does not navigate');
  await page.locator('#toggle-record-selection').click(); await page.locator('#select-visible-records').click();
  assert.equal(await page.locator('#record-list input[data-record-select-id]:checked').count(), await page.locator('#record-list .record-card').count());
  await captureOwnWindow('multi-select.png');
  await page.locator('#toggle-record-selection').click();
  await openRecord(fixture.recordIds[0]);
  const listSwipeCard = page.locator('#record-list [data-record-id="'+fixture.recordIds[0]+'"]');
  const swipeBox = await listSwipeCard.locator('.record-open').boundingBox();
  await page.mouse.move(swipeBox.x+swipeBox.width-38,swipeBox.y+26);await page.mouse.down();await page.mouse.move(swipeBox.x+20,swipeBox.y+27,{steps:8});await page.mouse.up();
  await waitFor(()=>listSwipeCard.getAttribute('class'),value=>value.includes('actions-open'),'left swipe reveals actions in the narrow list');
  assert.equal(await page.locator('#record-detail h2').first().isVisible(),true,'left swipe preserves current detail');
  await captureOwnWindow('left-swipe-actions.png');
  await page.locator('#breadcrumb-current').click();
  assert.equal(await detail.locator('.job-status').count(), 0);
  assert.equal(await detail.locator('.text-panel-header h3').textContent(), '思考摘要');
  await detail.locator('[data-action="show-original"]').click();
  assert.equal(await detail.locator('.text-panel-header h3').textContent(), '语音文本');
  assert.match(await detail.locator('.original-transcript').first().textContent(), /合成灵感/);
  await detail.locator('[data-action="show-summary"]').click();
  assert.equal(await detail.locator('.text-panel-header h3').textContent(), '思考摘要');
  assert.equal(await detail.locator('.record-text-panel').count(), 1, 'summary replaces the visible text panel without adding another section');
  const audioDuration = await detail.locator('audio').first().evaluate(async audio => { if (audio.readyState < 1) await new Promise((resolve, reject) => { audio.addEventListener('loadedmetadata', resolve, { once: true }); audio.addEventListener('error', reject, { once: true }); }); return audio.duration; });
  assert.equal(audioDuration, 1);
  await detail.locator('[data-action="rename-record"]').click();
  await detail.locator('.inline-title-editor input').fill('手动修改的灵感标题');
  await detail.locator('.inline-title-editor').getByRole('button', { name: '保存标题', exact: true }).click();
  await waitFor(() => page.evaluate(id => window.inmoment.invoke('records:get', { id }), fixture.recordIds[0]), record => record.editableTitle === '手动修改的灵感标题', 'inline title rename');
  assert.equal((await page.evaluate(id => window.inmoment.invoke('records:get', { id }), fixture.recordIds[0])).organizationStale, false, 'renaming a title does not invalidate an unchanged summary');
  await captureOwnWindow('summary-and-rename.png');
  // Organization suggestions are pre-seeded synthetic results. No model is called.
  const newSuggestion = detail.locator('[data-topic-suggestion-name="新的模拟分组"]');
  await newSuggestion.click();
  await answer('取消');
  assert.equal((await page.evaluate(() => window.inmoment.invoke('app:bootstrap'))).topics.length, 8);
  await newSuggestion.click();
  await answer('创建并归入');
  const created = await waitFor(() => page.evaluate(() => window.inmoment.invoke('app:bootstrap')), value => value.topics.length === 9, 'explicitly create suggested group');
  const suggested = created.topics.find(topic => topic.name === '新的模拟分组');
  assert.ok(suggested);
  assert.equal(await nav('uncategorized').getAttribute('aria-pressed'), 'true', 'adopting a group preserves the reading location');
  assert.equal(await detail.isVisible(), true);
  assert.equal(await page.locator('#record-list [data-record-id="' + fixture.recordIds[0] + '"]').count(), 1, 'temporary projection preserves the current item without duplicating storage');
  const changed = await page.evaluate(id => window.inmoment.invoke('records:get', { id }), fixture.recordIds[0]);
  assert.ok(changed.topicIds.includes(suggested.id));
  assert.equal(changed.audioSegments[0].transcript.includes('合成灵感'), true, 'summary and classification never overwrite original transcript');
  assert.equal(created.recordCount, 48); assert.equal(created.groups.length, 6);
  await openRecord(fixture.recordIds[5]);
  assert.equal(await page.locator('#record-list [data-record-id="' + fixture.recordIds[0] + '"]').count(), 0, 'leaving the item clears its temporary projection');
  await openGroup(suggested.id);
  assert.equal(await page.locator('#record-list .record-card').count(), 1);
  await page.locator('#ai-search').click();
  await page.locator('#ai-search-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#ai-search-scope').inputValue(), 'all');
  await page.locator('#ai-search-description').fill('最近一年与做菜有关的灵感');
  await page.locator('#submit-ai-search').click();
  assert.match(await page.locator('#ai-search-error').textContent(), /设置|开启/u, 'unavailable AI search has an actionable visible error');
  await page.locator('#close-ai-search').click();
  await page.locator('#batch-organize').click();
  await waitFor(() => page.locator('#batch-status').textContent(), text => /失败|禁用|设置|开启/u.test(text), 'batch respects disabled real API');
  assert.equal((await page.evaluate(() => window.inmoment.invoke('app:bootstrap'))).recordCount, 48);
  const simulated = await page.evaluate(async ids => Promise.all(ids.map(id => window.inmoment.invoke('records:get', { id }))), fixture.recordIds.slice(0, 3));
  const stressRecords = await page.evaluate(async ids=>Promise.all(ids.map(id=>window.inmoment.invoke('records:get',{id}))),fixture.recordIds.slice(0,20));
  await page.evaluate(records=>{state.batchResultItems=records.map((record,index)=>({id:record.id,title:record.title,version:record.version,status:index<18?'success':'failed',error:index<18?undefined:'合成失败结果，用于验证未完成列表也能显示。',record:{...record,organization:{summary:'用于检查大量分组时标题、摘要和调整按钮可见的合成内容。'}},topicSuggestions:index<18?['旧结果布局回归组 '+(index+1)]:[]}));initializeBatchChoices();renderBatchResults();document.querySelector('#batch-results-status').textContent='布局回归：18 个分组与 2 条未完成，不调用模型。';document.querySelector('#batch-results-dialog').showModal();},stressRecords);
  for(const size of [{width:1320,height:900,zoom:1},{width:1000,height:700,zoom:1},{width:1100,height:760,zoom:1.25},{width:1320,height:900,zoom:1.5}]) {
    await application.evaluate(({BrowserWindow},size)=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('/renderer/'));window.setContentSize(size.width,size.height);window.webContents.setZoomFactor(size.zoom);},size);
    await page.waitForTimeout(100);await checkBatchResultsLayout(page,{expectedGroups:19,expectedRows:20,label:'18 groups with failures '+JSON.stringify(size)});
    if(size.zoom===1.5)await captureOwnWindow('batch-many-groups.png');
  }
  await page.locator('#close-batch-results').click();
  await application.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('/renderer/'));window.setContentSize(1320,900);window.webContents.setZoomFactor(1);});
  await page.evaluate(({ records, first, second }) => {
    state.batchResultItems = records.map((record, index) => ({ id:record.id, title:record.title, version:record.version, status:'success', record:{...record,organization:{summary:'一段用于检查界面显示的模拟摘要。'.repeat(12)}},topicSuggestions:[index === 2 ? second : first] })); initializeBatchChoices(); renderBatchResults(); document.querySelector('#batch-results-status').textContent='仅展示本次 3 条的模拟分组建议。'; document.querySelector('#batch-results-dialog').showModal();
  }, { records:simulated, first:'信息管理', second:'求职作品集' });
  assert.equal(await page.locator('.batch-result-group[data-batch-group-name="信息管理"] [data-batch-record-id]').count(), 2);
  const batchLines = await page.locator('.batch-result-heading,.batch-summary').evaluateAll(items => items.map(item => ({height:item.getBoundingClientRect().height,line:parseFloat(getComputedStyle(item).lineHeight),space:getComputedStyle(item).whiteSpace})));
  assert.ok(batchLines.every(item => item.space === 'nowrap' && item.height <= item.line + 1), 'grouped result titles and briefs each occupy one line');
  await captureOwnWindow('batch-grouped.png');
  const batchItem = id => page.locator('[data-batch-record-id="' + id + '"]');
  await batchItem(fixture.recordIds[0]).locator('.batch-result-menu').click();
  await page.locator('.context-menu [data-menu-id="cancel"]').click();
  assert.equal(await page.locator('.batch-result-group[data-batch-group-name="暂不分组"] [data-batch-record-id="' + fixture.recordIds[0] + '"]').count(), 1, 'canceling leaves a visible unassigned suggestion');
  await batchItem(fixture.recordIds[1]).locator('.batch-result-menu').click();
  await captureOwnWindow('batch-adjust-menu.png');
  await page.locator('.context-menu [data-menu-id="change"]').click();
  await page.locator('.group-picker-search').fill('求职');
  assert.equal(await page.locator('.group-picker').evaluate(item => item.closest('dialog')?.id), 'batch-results-dialog', 'picker remains interactive within the modal top layer');
  const pickerRect = await page.locator('.group-picker').boundingBox(); const viewport = await page.evaluate(() => ({width:innerWidth,height:innerHeight}));
  assert.ok(pickerRect.x >= 0 && pickerRect.y >= 0 && pickerRect.x + pickerRect.width <= viewport.width + 1 && pickerRect.y + pickerRect.height <= viewport.height + 1);
  await captureOwnWindow('batch-group-picker.png');
  await page.locator('.group-picker-option').click();
  assert.equal(await page.locator('.batch-result-group[data-batch-group-name="求职作品集"] [data-batch-record-id]').count(), 2, 'changing a suggestion moves its row to the chosen group');
  assert.deepEqual((await page.evaluate(id => window.inmoment.invoke('records:get',{id}), fixture.recordIds[1])).topicIds, simulated[1].topicIds, 'review choices do not write groups before confirmation');
  await batchItem(fixture.recordIds[1]).locator('.batch-result-menu').click(); await page.locator('.context-menu [data-menu-id="change"]').click();
  await page.keyboard.press('Escape'); assert.equal(await page.locator('.group-picker').count(), 0); assert.equal(await page.locator('#batch-results-dialog').evaluate(item=>item.open), true, 'Escape closes only the small floating picker');
  for (const size of [{width:1000,height:700,zoom:1.25},{width:1320,height:900,zoom:1.5}]) {
    await application.evaluate(({BrowserWindow},size)=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('/renderer/'));window.setContentSize(size.width,size.height);window.webContents.setZoomFactor(size.zoom);},size);
    await page.waitForTimeout(140); await batchItem(fixture.recordIds[1]).locator('.batch-result-menu').click(); await page.locator('.context-menu [data-menu-id="change"]').click();
    const rect = await page.locator('.group-picker').boundingBox(), bounds=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.width<=bounds.width+1&&rect.y+rect.height<=bounds.height+1,'floating group picker fits small scaled windows');
    await page.locator('.group-picker-search').fill('不存在的模拟分组'); assert.equal(await page.locator('.group-picker-option').count(),0); assert.match(await page.locator('.popover-empty').textContent(),/没有匹配/);
    await page.keyboard.press('Escape');
  }
  await application.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('/renderer/'));window.setContentSize(1320,900);window.webContents.setZoomFactor(1);});
  await page.locator('#close-batch-results').click();
  await page.locator('[data-view="duplicates"]').click();
  await waitFor(() => page.locator('#cloud-status').textContent(), text => /模型|测试/u.test(text), 'cloud does not run a real model in the test');
  const syntheticGraph = {
    nodes: fixture.recordIds.slice(0, 12).map((id, index) => ({ id, title: ['阅读中的联想', '保留当时的任务', '做菜时想到的搭配'][index % 3] + ' ' + (index + 1) })),
    edges: Array.from({ length: 9 }, (_, index) => ({ source: fixture.recordIds[Math.floor(index / 3) * 4 + index % 3], target: fixture.recordIds[Math.floor(index / 3) * 4 + index % 3 + 1], weight: .9 })),
    communities: Array.from({ length: 3 }, (_, index) => ({ id: 'synthetic-' + index, members: fixture.recordIds.slice(index * 4, index * 4 + 4), isolated: false })), coverage: { totalCount: 48, displayedCount: 12, hasMore: true },
  };
  await page.evaluate(graph => window.InMomentCloud.render(graph), syntheticGraph);
  assert.equal(await page.locator('#thought-cloud-root [data-cloud-id]').count(), 12);
  const cloudBefore = await page.locator('#thought-cloud-root svg').getAttribute('viewBox');
  const cloudBox = await page.locator('#thought-cloud-root').boundingBox();
  await page.mouse.move(cloudBox.x + cloudBox.width / 2, cloudBox.y + cloudBox.height / 2); await page.mouse.wheel(0, -250);
  await waitFor(() => page.locator('#thought-cloud-root svg').getAttribute('viewBox'), value => value !== cloudBefore, 'cloud wheel zoom');
  await page.locator('#cloud-reset').click();
  const beforePan = await page.locator('#thought-cloud-root svg').getAttribute('viewBox');
  await page.mouse.move(cloudBox.x + 18, cloudBox.y + 18); await page.mouse.down();
  await page.mouse.move(cloudBox.x + 98, cloudBox.y + 58, { steps: 5 }); await page.mouse.up();
  await waitFor(() => page.locator('#thought-cloud-root svg').getAttribute('viewBox'), value => value !== beforePan, 'cloud empty-area drag pan');
  await page.locator('#cloud-reset').click();
  await page.locator('#thought-cloud-root [data-cloud-id] .cloud-node-dot').first().click();
  await page.locator('#cloud-selection').waitFor({ state: 'visible' });
  await checkOverflow(page, 'synthetic cloud'); await captureOwnWindow('inspiration-cloud.png');
  const selectedView = await page.locator('#thought-cloud-root svg').getAttribute('viewBox');
  await page.mouse.click(cloudBox.x+18,cloudBox.y+18);
  await page.locator('#cloud-selection').waitFor({state:'hidden'});
  assert.equal(await page.locator('#thought-cloud-root svg').getAttribute('viewBox'),selectedView,'blank click deselects without resetting the viewport');
  assert.ok((await page.locator('#thought-cloud-root [data-cloud-id]').evaluateAll(items=>items.map(item=>item.style.opacity))).every(value=>value==='1'),'blank click restores all node emphasis');
  await page.locator('#thought-cloud-root [data-cloud-id] .cloud-node-dot').first().click();
  await page.locator('#cloud-selection').getByRole('button', { name: '打开这条灵感', exact: true }).click();
  await detail.locator('[data-action="rename-record"]').waitFor();
  await openRecord(fixture.recordIds[0]);
  assert.equal(await detail.locator('[data-action="open-original"]').count(), 0, 'record file actions expose only the containing folder');
  await detail.locator('[data-action="reveal-record"]').click();
  const opened = await application.evaluate(() => globalThis.__uxShell);
  assert.equal(opened.length, 1);
  assert.ok(opened.every(item => item.filename.startsWith(dataDir)), 'file actions stay within synthetic record attachments');
  assert.equal(opened[0].type, 'open');
  assert.equal(fs.statSync(opened[0].filename).isDirectory(), true);
  await page.locator('#back-to-group-home').click();
  await page.locator('#record-list .record-actions-toggle').first().click();
  await page.locator('.context-menu [data-menu-id="delete"]').click();
  assert.equal(await page.locator('#confirm-dialog').evaluate(item=>item.open),false,'delete confirmation never opens the modal dialog');
  await captureOwnWindow('delete-popover.png');
  const confirmationMessage=await page.locator('.confirm-popover .popover-message').textContent();
  await page.locator('.confirm-popover .popover-message').evaluate(item=>{item.textContent='用于检查长标题时删除按钮仍可访问的合成灵感'.repeat(28);});
  await application.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('/renderer/'));window.setContentSize(1000,700);window.webContents.setZoomFactor(1.5);});
  await page.waitForTimeout(120);
  const confirmBounds=await page.locator('.confirm-popover').evaluate(panel=>{const box=panel.getBoundingClientRect(),button=panel.querySelector('[data-confirm-action="confirm"]').getBoundingClientRect();return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,buttonBottom:button.bottom,width:innerWidth,height:innerHeight};});
  assert.ok(confirmBounds.left>=0&&confirmBounds.right<=confirmBounds.width&&confirmBounds.top>=0&&confirmBounds.bottom<=confirmBounds.height&&confirmBounds.buttonBottom<=confirmBounds.bottom,'long titles keep deletion controls inside small scaled windows: '+JSON.stringify(confirmBounds));
  await page.locator('.confirm-popover .popover-message').evaluate((item,text)=>{item.textContent=text;},confirmationMessage);
  await application.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('/renderer/'));window.setContentSize(1320,900);window.webContents.setZoomFactor(1);});
  await page.locator('.confirm-popover [data-confirm-action="cancel"]').click();
  await waitFor(() => page.evaluate(() => document.activeElement?.closest('#record-list') !== null), Boolean, 'cancel delete restores grid focus');
  assert.equal(await page.locator('#record-list .record-card').count(), 1);
  // Complete an unclassified draft, then immediately navigate to settings.
  await page.locator('[data-view="drafts"]').click();
  await page.locator('.draft-open').click();
  await page.locator('#draft-detail').getByRole('button', { name: '完成记录', exact: true }).click();
  await waitFor(() => page.evaluate(() => window.inmoment.invoke('app:bootstrap')), value => value.recordCount === 49, 'saved draft');
  await page.locator('[data-view="settings"]').click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#settings-view').isVisible(), true, 'background completion does not steal the newer page');
  assert.equal(await page.locator('#threshold-input').isVisible(), false);
  if (semanticStatus.installed) {
    await waitFor(() => page.locator('#semantic-status').textContent(), text => /已就绪/u.test(text), 'bundled semantic component status');
    assert.equal(await page.locator('#semantic-install').isVisible(), false, 'standard package does not ask users to install its bundled model');
  }
  await captureOwnWindow('settings.png');
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.deepEqual(originalAttachments(), attachmentHashes, 'all original WAV bytes remain intact');
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), settingsText);
  await openGroup(fixture.topicIds[0]);
  await page.locator('#toggle-record-selection').click();
  for (const id of fixture.recordIds.slice(13, 15)) await page.locator('[data-record-select-id="' + id + '"]').check();
  const beforeBulkGroups=await page.evaluate(async ids=>Promise.all(ids.map(id=>window.inmoment.invoke('records:get',{id}))),fixture.recordIds.slice(13,15));
  await page.locator('#add-selected-records').click();await page.locator('.group-picker-search').fill('分类体验');
  await captureOwnWindow('multi-add-group.png');await page.locator('.group-picker-option').click();
  await waitFor(()=>page.evaluate(async ids=>Promise.all(ids.map(id=>window.inmoment.invoke('records:get',{id}))),fixture.recordIds.slice(13,15)),records=>records.every(record=>record.topicIds.includes(fixture.topicIds[3])),'multi-selection adds chosen notes to a group');
  const afterBulkGroups=await page.evaluate(async ids=>Promise.all(ids.map(id=>window.inmoment.invoke('records:get',{id}))),fixture.recordIds.slice(13,15));
  assert.ok(afterBulkGroups.every((record,index)=>beforeBulkGroups[index].topicIds.every(id=>record.topicIds.includes(id))),'bulk assignment preserves existing memberships');
  if(await page.locator('#toggle-record-selection').textContent()==='选择')await page.locator('#toggle-record-selection').click();
  for(const id of fixture.recordIds.slice(13,15))await page.locator('[data-record-select-id="'+id+'"]').check();
  await page.locator('#delete-selected-records').click(); await page.locator('.confirm-popover [data-confirm-action="cancel"]').click();
  assert.equal((await page.evaluate(() => window.inmoment.invoke('app:bootstrap'))).recordCount, 49, 'canceling multi-delete preserves all records');
  await page.locator('#delete-selected-records').click(); await page.locator('.confirm-popover [data-confirm-action="confirm"]').click();
  await waitFor(() => page.evaluate(() => window.inmoment.invoke('app:bootstrap')), value => value.recordCount === 47, 'one confirmation deletes only two checked synthetic records');
  for (const id of fixture.recordIds.slice(13, 15)) assert.equal(await page.evaluate(id=>window.inmoment.invoke('records:get',{id}),id),null);
  assert.ok(await page.evaluate(id=>window.inmoment.invoke('records:get',{id}),fixture.recordIds[3]),'unselected records remain');
  // Group-management changes are isolated fixture operations; originals and
  // unrelated memberships must survive both atomic merge and multi-delete.
  const groupRecordIds=fixture.recordIds.slice(30,33);
  const groupOriginals=await page.evaluate(async ids=>Promise.all(ids.map(id=>window.inmoment.invoke('records:get',{id}))),groupRecordIds);
  const temporaryGroups=await page.evaluate(async()=>{const result=[];for(let index=0;index<5;index++)result.push(await window.inmoment.invoke('topics:create',{name:'分组多选验证 '+(index+1)}));return result;});
  await page.evaluate(async({records,groups})=>{const additions=[[0,1],[1,2],[4]];for(let index=0;index<records.length;index++)await window.inmoment.invoke('records:setTopics',{id:records[index].id,topicIds:[...new Set([...records[index].topicIds,...additions[index].map(i=>groups[i].id)])]});},{records:groupOriginals,groups:temporaryGroups});
  await waitFor(()=>page.locator('[data-topic-manage-id]').count(),count=>count===14,'manager receives newly seeded topics');
  await page.locator('#open-primary-group-manager').click();
  assert.equal(await page.locator('#group-management-dialog select').count(),0,'group manager never uses per-row merge dropdowns');
  await page.locator('#merge-topic-groups').click();
  for(const group of temporaryGroups.slice(0,3))await page.locator('[data-topic-select-id="'+group.id+'"]').check();
  for(const size of [{width:1320,height:900,zoom:1},{width:1000,height:700,zoom:1},{width:1100,height:760,zoom:1.25},{width:1320,height:900,zoom:1.5}]) {
    await application.evaluate(({BrowserWindow},size)=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('/renderer/'));window.setContentSize(size.width,size.height);window.webContents.setZoomFactor(size.zoom);},size);
    await page.waitForTimeout(100);await checkGroupManagementLayout(page,{expectedRows:14,label:'multi-group manager '+JSON.stringify(size)});
  }
  await application.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('/renderer/'));window.setContentSize(1320,900);window.webContents.setZoomFactor(1);});
  await captureOwnWindow('group-multi-select.png');
  await page.locator('#apply-topic-selection').click();
  assert.equal(await page.locator('.group-picker-option').count(),3,'merge chooses a retained name only among selected groups');
  await page.locator('.group-picker-option[data-group-choice-id="'+temporaryGroups[0].id+'"]').click();
  await page.locator('.confirm-popover [data-confirm-action="cancel"]').click();
  assert.equal((await page.evaluate(()=>window.inmoment.invoke('app:bootstrap'))).topics.length,14,'cancelled merge keeps every group');
  await page.locator('#apply-topic-selection').click();await page.locator('.group-picker-search').fill('分组多选验证 1');
  await captureOwnWindow('group-merge-picker.png');await page.locator('.group-picker-option').click();
  await page.locator('.confirm-popover [data-confirm-action="confirm"]').click();
  await waitFor(()=>page.locator('[data-topic-manage-id]').count(),count=>count===12,'three groups merge atomically into one');
  const mergedRecords=await page.evaluate(async ids=>Promise.all(ids.map(id=>window.inmoment.invoke('records:get',{id}))),groupRecordIds);
  assert.ok(mergedRecords.slice(0,2).every(record=>record.topicIds.includes(temporaryGroups[0].id)&&!record.topicIds.includes(temporaryGroups[1].id)&&!record.topicIds.includes(temporaryGroups[2].id)),'merged memberships use the selected target without duplicates');
  await page.locator('#delete-topic-groups').click();
  for(const group of [temporaryGroups[0],temporaryGroups[3],temporaryGroups[4]])await page.locator('[data-topic-select-id="'+group.id+'"]').check();
  await page.locator('#apply-topic-selection').click();await captureOwnWindow('group-delete-confirm.png');await page.locator('.confirm-popover [data-confirm-action="cancel"]').click();
  assert.equal((await page.evaluate(()=>window.inmoment.invoke('app:bootstrap'))).topics.length,12,'cancelled deletion keeps selected groups');
  await page.locator('#apply-topic-selection').click();await page.locator('.confirm-popover [data-confirm-action="confirm"]').click();
  await waitFor(()=>page.locator('[data-topic-manage-id]').count(),count=>count===9,'multi-delete removes only the three selected groups');
  for(let index=0;index<groupRecordIds.length;index++) { const current=await page.evaluate(id=>window.inmoment.invoke('records:get',{id}),groupRecordIds[index]);assert.deepEqual([...current.topicIds].sort(),[...groupOriginals[index].topicIds].sort(),'unrelated group memberships remain');assert.equal(current.transcript,groupOriginals[index].transcript,'group operations preserve original text'); }
  assert.equal((await page.evaluate(()=>window.inmoment.invoke('app:bootstrap'))).recordCount,47,'group deletion never deletes notes');
  await page.locator('#close-group-management').click();
  await application.close(); application = null;
  application = await _electron.launch({ executablePath: portable || require('electron'), args: portable ? [] : [root], cwd: root, env, timeout: 30000 });
  await application.firstWindow();
  const reopenedPage = application.windows().find(window => window.url().includes('/renderer/')) || await application.waitForEvent('window', { predicate: window => window.url().includes('/renderer/') });
  const reopened = await reopenedPage.evaluate(() => window.inmoment.invoke('app:bootstrap'));
  assert.equal(reopened.recordCount, 47); assert.equal(reopened.groups.length, 6); assert.equal(reopened.topics.length, 9);
  assert.equal((await reopenedPage.evaluate(id => window.inmoment.invoke('records:get', { id }), fixture.recordIds[0])).editableTitle, '手动修改的灵感标题');
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), settingsText);
  fs.writeFileSync(path.join(outputDir, 'measurements.json'), JSON.stringify({ syntheticOnly: true, realAPICalls: 0, recordCount: 47, intentionalTestDeletions: 2, existingSimilarityGroups: 6, groups: 9, originalWavFiles: attachmentHashes.size, originalsUnchangedBeforeDeletion: true, restartPreserved: true, measurements }, null, 2));
  console.log('UX desktop passed: full-height uniform record rows, equal navigation widths, classification without jumping, scoped batch/search dialogs, synthetic cloud interactions, safe file actions and restart preservation; layout ' + JSON.stringify(measurements));
})().catch(async error => {
  console.error(error.stack);
  if (application) {
    try {
      await captureOwnWindow('failure.png');
      const page = application.windows().find(window => window.url().includes('/renderer/'));
      console.error(JSON.stringify(await page.evaluate(() => ({ focus: { tag: document.activeElement?.tagName, id: document.activeElement?.id, className: document.activeElement?.className }, view: typeof state === 'undefined' ? '' : state.view, context: typeof state === 'undefined' ? null : state.detailContext, selected: typeof state === 'undefined' ? '' : state.selectedId }))));
    } catch {}
  }
  process.exitCode = 1;
}).finally(async () => { if (application) await application.close(); });
