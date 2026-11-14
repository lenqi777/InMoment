'use strict';

// Real UI, synthetic library, isolated settings and disabled network. This audit
// never activates capture, microphone input, a speech model or a cloud model.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { LocalStore } = require('../src/core/store.cjs');
const { checkboxInk } = require('./ui-raster-geometry.cjs');
const { inspectControlReachability } = require('./ui-audit-reachability.cjs');

function playwright() {
  const candidates = [process.env.INMOMENT_PLAYWRIGHT, 'playwright', path.join(path.dirname(process.execPath), '..', 'node_modules', 'playwright')].filter(Boolean);
  for (const candidate of candidates) { try { return require(candidate); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; } }
  throw new Error('Playwright is required for UI audit. Set INMOMENT_PLAYWRIGHT to the installed Playwright package path.');
}
const { _electron } = playwright();
const root = path.resolve(__dirname, '..');
const buttonStatesFinal = process.argv.includes('--button-states-final');
const buttonStatesOnly = process.argv.includes('--button-states') || buttonStatesFinal;
const detailToolsOnly = process.argv.includes('--detail-tools');
const backgroundOnly = process.argv.includes('--background');
const visualPolishSidebar = process.argv.includes('--visual-polish-sidebar');
const visualPolishOnly = process.argv.includes('--visual-polish') || visualPolishSidebar;
const reviewDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
const output = path.resolve(root, process.env.INMOMENT_UI_AUDIT_OUTPUT || '.local/ui-review-' + reviewDate + (buttonStatesOnly ? '-r5' + (buttonStatesFinal ? '/final' : '') : visualPolishOnly ? '-r4' + (visualPolishSidebar ? '/sidebar-final' : '') : detailToolsOnly ? '-r3' : ''));
assert.ok(output.startsWith(root + path.sep), 'UI audit output must remain inside the project.');
fs.mkdirSync(output, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(output, 'synthetic-data-'));
const auditStarted=Date.now();
const findings = [], measurements = [], screenshots = [], errors = [];
let application, page;
let executableReceipt = null;

function wav(seconds = 3) {
  const buffer = Buffer.alloc(44 + 32000 * seconds);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40); return buffer;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function png() {
  const width = 960, height = 540;
  const rows = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y += 1) {
    rows[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const color = y < 42 ? [242, 244, 246] : x > 140 && x < 820 && y > 112 && y < 154 ? [230, 241, 233] : x > 140 && x < 760 && y > 200 && y < 420 && y % 40 < 8 ? [230, 232, 235] : [255, 255, 255];
      for (let c = 0; c < 3; c += 1) rows[y * (width * 3 + 1) + 1 + x * 3 + c] = color[c];
    }
  }
  const chunk = (type, data) => { const tag = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([tag, data]))); return Buffer.concat([length, tag, data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function seed() {
  const store = new LocalStore(dataDir);
  try {
    const topics = ['阅读与思考', '产品设计', '日常生活', '语音交互', '界面与体验', '待验证的想法', '长期项目', '用于检验单行省略与缩放的超长分组名称'].map(name => store.createTopic(name));
    const descriptions = [
      ['把录音和当时的想法放在一起', '回顾一段录音时，我想一边回听，一边看自己当时说了什么。播放器和语音文本放在一起，就不需要在页面上下反复找。'],
      ['收藏时，顺手留住吸引我的原因', '收藏文章的时候，也想留下为什么觉得它有用。这条记录保留了当时的声音、语音文本和来源截图。'],
      ['从家里的食材开始找菜谱', '先看冰箱里还有什么，再决定今天做什么菜。把自己调整用量的经验一起留住。'],
      ['用自己的话找回模糊的印象', '有时只记得大概情境，记不起原来的关键词。可以先描述那段印象，再找回相关的记录。'],
    ];
    const ids = [];
    for (let index = 0; index < 48; index += 1) {
      const id = 'ui-audit-note-' + String(index + 1).padStart(2, '0');
      const [baseTitle, description] = descriptions[index % descriptions.length];
      const title = index === 1 ? '很长的灵感标题：' + '保持单行列表，同时在详情中完整阅读。'.repeat(8) : baseTitle + (index > 3 ? ' ' + (index + 1) : '');
      const transcript = index === 0 ? (description + '\n\n').repeat(16) : description;
      const url = backgroundOnly && index === 0 ? 'https://example.com/ui-audit/' + 'long-path-'.repeat(55) : 'https://example.com/ui-audit';
      store.createDraft({ id, title, createdAt: Date.now() - index * 3600000, source: { processName: 'SyntheticReader', title: '阅读与思考 · 界面验证资料', url }, topicIds: index % 5 && index !== 1 ? [topics[index % topics.length].id, topics[0].id] : [] });
      store.addSegment(id, { id: id + '-segment-1', bytes: wav(3), durationMs: 3000, transcript });
      if (index === 0) store.addSegment(id, { id: id + '-segment-2', bytes: wav(2), durationMs: 2000, transcript: '第二段补充：不同段落的原文与音频仍应保持对应。' });
      if (index < 3) store.addScreenshot(id, png(), { width: 960, height: 540, synthetic: true });
      if (backgroundOnly && index === 0) store.addScreenshot(id, png(), { method: 'region', width: 960, height: 540, synthetic: true });
      store.complete(id);
      if (index % 2 === 0) store.saveOrganization(id, { schemaVersion: 2, summary: description, evidence: [{ segmentId: id + '-segment-1', quote: description.slice(0, 15) }], points: [], uncertainties: [], topicSuggestions: index === 0 ? ['阅读与思考', '新的产品想法', '语音交互', '界面与体验', '日常生活', '长期工作计划', '交互细节', '以后再想'] : ['阅读与思考', '语音交互'] });
      store.setJob(id, 'transcribe', 'completed'); store.setJob(id, 'title', 'completed'); ids.push(id);
    }
    store.createDraft({ id: 'ui-audit-text-only', title: '没有录音和截图的文字记录', notes: '文字记录也应保持完整的阅读结构，不显示空的录音容器或截图分割线。' }); store.complete('ui-audit-text-only');
    store.createDraft({ id: 'ui-audit-draft', title: '还没保存的一个想法' }); store.addSegment('ui-audit-draft', { bytes: wav(2), durationMs: 2000, transcript: '这段是用于检查草稿页面的合成文字。' });
    return { ids, topics };
  } finally { store.close(); }
}
function attachmentHashes() {
  const result = {};
  const visit = directory => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) { const filename = path.join(directory, item.name); if (item.isDirectory()) visit(filename); else if (/\.(wav|png)$/u.test(item.name)) result[path.relative(dataDir, filename)] = createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); } };
  visit(dataDir); return result;
}
function check(ok, rule, detail) { if (!ok) findings.push({ rule, detail }); }
async function settle() { await page.waitForTimeout(100); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function resize(size) {
  await application.evaluate(async ({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/renderer/'));
    if (window.isMaximized()) await new Promise(resolve => { const timer = setTimeout(resolve, 1500); window.once('unmaximize', () => { clearTimeout(timer); resolve(); }); window.unmaximize(); });
    window.setMinimumSize(640, 480); window.setContentSize(size.width, size.height); window.webContents.setZoomFactor(size.zoom || 1);
  }, size);
  const native = await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/renderer/')); return { maximized: window.isMaximized(), bounds: window.getContentBounds(), zoom:window.webContents.getZoomFactor() }; });
  // Windows rounds native DIP setters through physical pixels. Inspect the
  // actual renderer viewport, while still bounding the setter's round trip.
  await page.waitForFunction(value => Math.abs(innerWidth-value.bounds.width/value.zoom)<=1&&Math.abs(innerHeight-value.bounds.height/value.zoom)<=1,native);
  check(!native.maximized && Math.abs(native.bounds.width - size.width) <= 2 && Math.abs(native.bounds.height - size.height) <= 2, 'native-window-resize', { requested: size, native }); await settle();
}
async function capture(filename, title, overlay = false, motion = false, immediate = false) {
  if (!immediate) { if (!motion && !overlay) await finishMotion(); else await settle(); }
  const image = await application.evaluate(async ({ BrowserWindow }, overlay) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes(overlay ? '/overlay/' : '/renderer/')); return (await window.capturePage()).toPNG().toString('base64'); }, overlay);
  fs.writeFileSync(path.join(output, filename), Buffer.from(image, 'base64')); screenshots.push({ filename, title });
}
async function finishMotion() {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity);
    for (const animation of finite) if (animation.playState === 'paused') { if (Number(animation.currentTime) >= animation.effect.getComputedTiming().endTime) animation.finish(); else animation.play(); }
    await Promise.allSettled(finite.map(animation => animation.finished));
    await window.InMomentMotion?.activeTransition?.finished?.catch(() => {});
  });
  await settle();
}
async function motionFrame(filename, title, { required = true } = {}) {
  await page.evaluate(async () => { await window.InMomentMotion?.activeTransition?.ready?.catch(() => {}); });
  const result = await page.evaluate(async () => {
    const animations = document.getAnimations().filter(animation => {
      const target = animation.effect?.target; const timing = animation.effect?.getTiming();
      if (!target || target.closest?.('.ui-action-icon') || !timing || timing.iterations === Infinity || !Number.isFinite(Number(timing.duration)) || Number(timing.duration) <= 0 || animation.playState === 'finished') return false;
      return animation.effect.getKeyframes().some(frame => ['transform', 'translate', 'scale', 'opacity', 'height', 'clipPath'].some(property => frame[property] !== undefined));
    });
    const geometry = animations.filter(animation => animation.effect.getKeyframes().some(frame => ['transform', 'translate', 'scale', 'width', 'height'].some(property => frame[property] !== undefined)));
    const recordTransition = /^record-(open|close)$/u.test(document.documentElement.dataset.uiTransitionKind || '');
    const commonTime = recordTransition ? 140 : Math.max(0, ...(geometry.length ? geometry : animations).map(animation => Number(animation.effect.getTiming().duration))) / 2;
    window.__uiAuditPausedMotion = animations;
    // All layers share one physical instant. Short fades may already be over,
    // while delayed layers may not have started at the geometric midpoint.
    for (const animation of animations) { animation.pause(); animation.currentTime = commonTime; }
    await new Promise(resolve => requestAnimationFrame(resolve));
    return { transitionKind: document.documentElement.dataset.uiTransitionKind || null, commonTime, animations: animations.map(animation => {
      const style = getComputedStyle(animation.effect.target, animation.effect.pseudoElement || undefined);
      return { target: animation.effect.target.id || animation.effect.target.className || animation.effect.target.tagName, marker: animation.effect.target.dataset?.uiMotion || null, pseudo: animation.effect.pseudoElement || null, duration: animation.effect.getTiming().duration, delay: animation.effect.getTiming().delay, currentTime: animation.currentTime, progress: animation.effect.getComputedTiming().progress, computed: { width: style.width, height: style.height, transform: style.transform, opacity: style.opacity }, keyframes: animation.effect.getKeyframes() };
    }), focus: { id: document.activeElement?.id || null, connected: document.activeElement?.isConnected || false } };
  });
  measurements.push({ label: 'motion ' + title, ...result });
  if (required) check(result.animations.some(animation => animation.progress > 0 && animation.progress < 1), 'motion-middle-frame', { title, ...result });
  if (/^record-(open|close)$/u.test(result.transitionKind || '')) {
    const geometry = result.animations.find(animation => animation.pseudo === '::view-transition-group(inmoment-record)');
    const ends = geometry?.keyframes.map(frame => parseFloat(frame.width)).filter(Number.isFinite) || [];
    check(geometry && parseFloat(geometry.computed.width) > Math.min(...ends) && parseFloat(geometry.computed.width) < Math.max(...ends), 'record-geometry-is-intermediate', geometry);
    if (result.transitionKind === 'record-open') {
      await page.evaluate(async () => { window.__uiAuditPausedMotion.forEach(animation => { animation.currentTime = 20; }); await new Promise(resolve => requestAnimationFrame(resolve)); });
      await capture('record-open-early.png', '从卡片位置展开 · 同一次转场 20 ms', false, true, true);
      await page.evaluate(async time => { window.__uiAuditPausedMotion.forEach(animation => { animation.currentTime = time; }); await new Promise(resolve => requestAnimationFrame(resolve)); }, result.commonTime);
    }
  }
  await capture(filename, title, false, true);
  if (result.transitionKind === 'record-open') check(!fs.readFileSync(path.join(output, 'record-open-early.png')).equals(fs.readFileSync(path.join(output, filename))), 'native-transition-capture-changes-with-time', { earlyMs: 20, middleMs: result.commonTime, sameUnderlyingDOM: true });
  await page.evaluate(async () => { const animations = window.__uiAuditPausedMotion || []; delete window.__uiAuditPausedMotion; animations.forEach(animation => { if (Number(animation.currentTime) >= animation.effect.getComputedTiming().endTime) animation.finish(); else animation.play(); }); await Promise.allSettled(animations.map(animation => animation.finished)); await window.InMomentMotion?.activeTransition?.finished?.catch(() => {}); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  return result;
}
async function iconCatalog() {
  const catalog = path.join(output, 'icon-catalog.html');
  if (!fs.existsSync(catalog)) {
    const manifest=require('../src/assets/ui-icons/manifest.json'),uri=filename=>require('node:url').pathToFileURL(path.join(root,filename)).href;
    const rows=Object.entries(manifest.assets).map(([name,asset])=>'<tr><th>'+name+'</th>'+['regular','filled'].map(state=>'<td>'+[16,20].map(size=>'<img width="'+size+'" height="'+size+'" alt="'+name+' '+state+' '+size+'px" src="'+uri('src/assets/ui-icons/'+asset[state].filename)+'">').join('')+'</td>').join('')+'<td><button class="button secondary compact" data-ui-icon="'+name+'">'+name+'</button></td></tr>').join('');
    fs.writeFileSync(catalog,'<!doctype html><meta charset="utf-8"><title>官方图标两态对照</title><link rel="stylesheet" href="'+uri('src/shared/ui-tokens.css')+'"><link rel="stylesheet" href="'+uri('src/shared/ui-controls.css')+'"><style>body{padding:24px;font:14px Segoe UI,Microsoft YaHei,sans-serif;background:white}table{border-collapse:collapse;width:100%}td,th{border:1px solid #dee2e6;padding:12px;text-align:left}img{margin-right:16px}</style><h1>官方图标 Regular / Filled</h1><table>'+rows+'</table><script src="'+uri('src/shared/ui-icons.js')+'"></script>');
  }
  const result = await application.evaluate(async ({ BrowserWindow }, filename) => {
    const window = new BrowserWindow({ width: 1100, height: 900, show: false, frame: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    try {
      await window.loadFile(filename);
      const assets = await window.webContents.executeJavaScript('Promise.all([...document.images].map(image => image.decode().catch(() => {}))).then(() => ({count:document.images.length,failed:[...document.images].filter(image=>!image.naturalWidth).map(image=>image.alt),height:document.documentElement.scrollHeight,viewport:innerHeight}))');
      const pages = [];
      for (let top = 0; top < assets.height; top += Math.max(100, assets.viewport - 100)) {
        await window.webContents.executeJavaScript('window.scrollTo(0,' + top + ');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        pages.push((await window.capturePage()).toPNG().toString('base64'));
      }
      return { ...assets, pages };
    } finally { window.destroy(); }
  }, catalog);
  result.pages.forEach((png, index) => { const filename = 'icon-catalog-sheet-' + (index + 1) + '.png'; fs.writeFileSync(path.join(output, filename), Buffer.from(png, 'base64')); screenshots.push({ filename, title: '官方图标 Regular / Filled 对照 ' + (index + 1) }); });
  delete result.pages; measurements.push({ label: 'independent icon pairs', ...result }); check(result.count >= 120 && !result.failed.length, 'icon-pairs-load', result);
}
async function auditTitlebar(mode) {
  await application.evaluate(({ BrowserWindow }, mode) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/renderer/'));
    if (mode === 'maximized') window.maximize(); else { window.unmaximize(); window.setContentSize(1440, 900); }
    window.webContents.setZoomFactor(1);
  }, mode);
  await page.waitForTimeout(200); await settle();
  const dom = await page.locator('.app-titlebar').evaluate(header => {
    const rail = document.querySelector('.icon-rail');
    const content = document.querySelector('.app-content');
    return {
      height: header.getBoundingClientRect().height,
      railWidth: rail.getBoundingClientRect().width,
      contentTop: content.getBoundingClientRect().top,
      radius: getComputedStyle(content).borderTopLeftRadius,
      shellColor: getComputedStyle(header.parentElement).backgroundColor,
      viewportWidth: innerWidth,
    };
  });
  const image = await application.evaluate(async ({ BrowserWindow }, dom) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/renderer/'));
    const shot = await window.capturePage(), png = shot.toPNG(), bitmap = shot.toBitmap();
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20), scale = width / dom.viewportWidth;
    if (bitmap.length !== width * height * 4) throw new Error('Titlebar bitmap dimensions do not match the captured PNG.');
    const sample = (x, y) => {
      const at = (Math.floor(y * scale) * width + Math.floor(x * scale)) * 4;
      return [bitmap[at + 2], bitmap[at + 1], bitmap[at]];
    };
    const samples = [.15, .4, .65, .9].flatMap(fraction => [dom.railWidth - 1, dom.railWidth, dom.railWidth + 1].map(x => sample(x, dom.height * fraction)));
    const logical = shot.getSize();
    const crop = shot.crop({ x: 0, y: 0, width: Math.min(logical.width, 340), height: Math.min(logical.height, 112) });
    return { width, height, scale, nativeMaximized: window.isMaximized(), samples, crop: crop.toPNG().toString('base64') };
  }, dom);
  const filename = 'titlebar-' + mode + '.png';
  fs.writeFileSync(path.join(output, filename), Buffer.from(image.crop, 'base64'));
  screenshots.push({ filename, title: '主窗口外壳 · ' + (mode === 'maximized' ? '最大化' : '普通窗口') });
  delete image.crop;
  const config = require('../src/main/window-ui.cjs').mainChrome.titleBarOverlay;
  const result = { label: 'titlebar ' + mode, dom, ...image, configuredOverlayHeight: config.height };
  measurements.push(result);
  const rgb = dom.shellColor.match(/\d+/gu).map(Number);
  check(image.nativeMaximized === (mode === 'maximized') && config.height <= dom.height && dom.height === dom.railWidth &&
    dom.contentTop === dom.height && dom.radius === '16px' &&
    image.samples.every(sample => sample.every((value, channel) => Math.abs(value - rgb[channel]) <= 2)), 'shared-shell-corner-pixels', result);
}
async function auditIconMotion() {
  const button = page.locator('#batch-organize'); const samples = {};
  const read = () => button.evaluate(element => {
    const root = element.querySelector(':scope > .ui-action-icon'), outline = root?.querySelector('.ui-icon-outline'), solid = root?.querySelector('.ui-icon-solid');
    const style = solid && getComputedStyle(solid), clip = style?.clipPath || '';
    const outlineStyle = outline && getComputedStyle(outline);
    const outlineParts = outlineStyle?.clipPath?.startsWith('inset(') ? outlineStyle.clipPath.slice(6, -1).split(/\s+/u) : [];
    return { text: element.textContent.trim(), iconCount: element.querySelectorAll(':scope > .ui-action-icon').length, outlineMask: outlineStyle?.maskImage, outlineClip: outlineStyle?.clipPath, outlineBottom: outlineParts.length ? parseFloat(outlineParts[2] || outlineParts[0]) : null, outlineOpacity: Number(outlineStyle?.opacity), solidMask: style?.maskImage, clip, top: clip.startsWith('inset(') ? parseFloat(clip.slice(6)) : null, transition: style?.transitionDuration, focused: element.matches(':focus-visible'), disabled: element.disabled };
  });
  const finish = () => button.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); await new Promise(resolve => requestAnimationFrame(resolve)); });
  await page.mouse.move(20, 20); await button.evaluate(element => element.blur()); await finish(); samples.rest = await read();
  await button.hover();
  const hasMidpoint = await button.evaluate(async element => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const animation = element.querySelector('.ui-icon-solid')?.getAnimations().find(item => item.effect?.getTiming().duration > 0);
    if (!animation) return false;
    const iconAnimations = [...element.querySelectorAll('.ui-action-icon>span')].flatMap(layer => layer.getAnimations()); iconAnimations.forEach(item => item.pause());
    let low = 0, high = Number(animation.effect.getTiming().duration);
    for (let step = 0; step < 9; step += 1) {
      const time = (low + high) / 2; iconAnimations.forEach(item => { item.currentTime = time; }); await new Promise(resolve => requestAnimationFrame(resolve));
      const top = parseFloat(getComputedStyle(element.querySelector('.ui-icon-solid')).clipPath.slice(6));
      if (top > 50) low = Number(animation.currentTime); else high = Number(animation.currentTime);
    }
    return true;
  });
  samples.mid = await read(); await capture('icon-fill-midpoint.png', '图标填充 · 动画中间帧', false, true);
  await button.evaluate(element => [...element.querySelectorAll('.ui-action-icon>span')].flatMap(layer => layer.getAnimations()).forEach(animation => animation.play())); await finish(); samples.hover = await read(); await capture('icon-fill-hover.png', '图标填充 · 悬停完成');
  await page.mouse.move(20, 20); await finish(); samples.leave = await read();
  await page.keyboard.press('Tab'); await button.focus(); await finish(); samples.focus = await read(); await capture('icon-fill-keyboard.png', '图标填充 · 键盘焦点');
  await button.evaluate(element => element.blur()); await finish(); samples.blur = await read();
  await button.evaluate(element => { element.disabled = true; }); await button.hover({ force: true }); await finish(); samples.disabled = await read(); await button.evaluate(element => { element.disabled = false; });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.mouse.move(20, 20); await settle(); await button.hover(); await settle(); samples.reduced = await read(); await capture('icon-fill-reduced-motion.png', '图标填充 · 减少动态效果');
  await page.mouse.move(20, 20); await page.emulateMedia({ reducedMotion: 'no-preference' }); await finish();
  const labelBefore = (await button.textContent()).trim();
  await button.evaluate(element => { element.textContent = '正在整理…'; }); await page.waitForFunction(() => document.querySelector('#batch-organize .ui-action-icon'));
  samples.busy = await read();
  await button.evaluate((element, label) => { element.textContent = label; }, labelBefore); await page.waitForFunction(() => document.querySelector('#batch-organize .ui-action-icon')); samples.restored = await read();
  measurements.push({ label: 'icon motion and hydration', hasMidpoint, samples });
  check(samples.rest.top >= 99 && hasMidpoint && samples.mid.top > 0 && samples.mid.top < 100 && samples.hover.top === 0 && samples.leave.top >= 99 && samples.focus.focused && samples.focus.top === 0 && samples.blur.top >= 99 && samples.disabled.top >= 99 && samples.reduced.top === 0 && samples.reduced.transition.split(',').every(value => parseFloat(value) === 0), 'icon-bottom-up-states', samples);
  check(samples.hover.outlineOpacity <= .01 || /inset\(100%|inset\([^)]*100%/u.test(samples.hover.outlineClip || ''), 'regular-icon-exits-before-filled-end', samples.hover);
  check(samples.mid.outlineBottom !== null && Math.abs(samples.mid.top + samples.mid.outlineBottom - 100) <= 1 && samples.leave.outlineBottom === 0 && samples.disabled.outlineBottom === 0, 'regular-filled-complementary-wipe', { mid: samples.mid, leave: samples.leave, disabled: samples.disabled });
  check(samples.busy.text === '正在整理…' && samples.busy.iconCount === 1 && samples.restored.text === labelBefore && samples.restored.iconCount === 1, 'icon-hydration-keeps-button-text', { labelBefore, busy: samples.busy, restored: samples.restored });
}
async function auditDatePopover() {
  const trigger = page.locator('#library-filter-trigger'), menu = page.locator('.library-filter-popover');
  await trigger.click(); await menu.waitFor({ state: 'visible' }); await motionFrame('filter-enter-mid.png', '集中筛选 · 展开中间帧'); await inspect('combined filters'); await capture('combined-filter-popover.png', '筛选 · 时间、关键词与 AI 入口');
  await menu.locator('[data-filter-range="30"]').click(); await page.locator('#filter-popup-keyword').fill('尚未应用的条件');
  check(await page.locator('#date-range').inputValue() === 'all' && await page.locator('#search-input').inputValue() === '', 'filter-draft-does-not-apply', {});
  await page.locator('#filter-popup-cancel').click(); await motionFrame('filter-exit-mid.png', '集中筛选 · 收起中间帧'); await menu.waitFor({ state: 'detached' });
  check(await trigger.getAttribute('aria-expanded') === 'false' && await page.locator('#date-range').inputValue() === 'all', 'filter-cancel-keeps-value', {});
  await trigger.click(); await menu.waitFor({ state: 'visible' }); await finishMotion(); await trigger.click(); await menu.waitFor({ state: 'detached' }); check(await trigger.getAttribute('aria-expanded') === 'false', 'filter-trigger-toggle-closes', {});
  await trigger.click(); await menu.waitFor({ state: 'visible' }); await finishMotion(); await menu.locator('[data-filter-range="30"]').click(); await page.locator('#filter-popup-apply').click(); await menu.waitFor({ state: 'detached' }); await settle();
  check(await page.locator('#date-range').inputValue() === '30' && (await trigger.textContent()).includes('最近 30 天'), 'filter-popup-applies-choice', {});
  await trigger.click(); await menu.waitFor({ state: 'visible' }); await finishMotion(); await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' }); check(await page.locator('#date-range').inputValue() === '30', 'filter-popup-escape-keeps-value', {});
  await trigger.click(); await menu.waitFor({ state: 'visible' }); await finishMotion(); await page.locator('#collection-heading').click(); await menu.waitFor({ state: 'detached' }); check(await page.locator('#date-range').inputValue() === '30', 'filter-popup-outside-keeps-value', {});
  await trigger.click(); await menu.waitFor({ state: 'visible' }); await finishMotion(); await menu.locator('[data-filter-range="all"]').click(); await page.locator('#filter-popup-apply').click(); await menu.waitFor({ state: 'detached' }); await settle();
}
async function auditSuggestionPopover() {
  const record = page.locator('#record-detail'), more = record.locator('#more-topic-suggestions');
  const suggestions = await record.locator('[data-topic-suggestion-name]').evaluateAll(items => items.map(element => ({ name: element.getAttribute('data-topic-suggestion-name'), icon: element.getAttribute('data-ui-icon'), text: element.textContent.trim() })));
  check(suggestions.length === 2 && suggestions[0].icon === 'folder-in' && suggestions[1].icon === 'folder-plus' && suggestions.every(item => item.text === item.name), 'group-suggestion-icons-and-collapse', suggestions);
  const before = await page.evaluate(() => ({ selectedId: state.selectedId, group: state.libraryGroupId }));
  await more.click(); await page.locator('.group-picker').waitFor({ state: 'visible' }); await motionFrame('suggestions-enter-mid.png', '分组建议 · 展开中间帧'); await inspect('all grouping suggestions');
  check(await page.locator('.group-picker-option').count() === 8, 'all-suggestions-in-picker', {});
  await page.locator('.group-picker-search').fill('交互');
  check(await page.locator('.group-picker-option').count() === 2, 'suggestion-picker-search', {});
  await capture('group-suggestions-search.png', '更多分组建议 · 就近搜索'); await page.keyboard.press('Escape'); await motionFrame('suggestions-exit-mid.png', '分组建议 · 收起中间帧'); await page.locator('.group-picker').waitFor({ state: 'detached' });
  const after = await page.evaluate(() => ({ selectedId: state.selectedId, group: state.libraryGroupId }));
  check(JSON.stringify(before) === JSON.stringify(after), 'dismissed-suggestions-keep-location', { before, after });
  const surfaces = await record.evaluate(detail => [...detail.querySelectorAll('.voice-note,.record-audio-section,.audio-segment,.detail-context')].map(element => {
    const style = getComputedStyle(element); return { name: element.className, background: style.backgroundColor, borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], shadow: style.boxShadow };
  }));
  measurements.push({ label: 'flat recording and source surfaces', surfaces });
  check(surfaces.every(item => ['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'].includes(item.background) && item.borders.every(width => parseFloat(width) === 0) && item.shadow === 'none'), 'flat-recording-source-surfaces', surfaces);
}
async function auditMotionFlows(fixture) {
  await resize({ width: 1440, height: 900, zoom: 1 }); await home(); await finishMotion();
  const id = fixture.ids[0];
  async function delayRead() {
    await page.evaluate(id => {
      window.__uiAuditOriginalInvoke = invoke;
      invoke = async (method, params = {}) => {
        const result = await window.__uiAuditOriginalInvoke(method, params);
        if (method === 'records:get' && params.id === id) return new Promise(resolve => { window.__uiAuditReleaseRead = () => resolve(result); });
        return result;
      };
    }, id);
  }
  async function releaseRead() {
    await page.evaluate(() => { window.__uiAuditReleaseRead?.(); if (window.__uiAuditOriginalInvoke) invoke = window.__uiAuditOriginalInvoke; delete window.__uiAuditReleaseRead; delete window.__uiAuditOriginalInvoke; });
  }
  await delayRead();
  try {
    await page.locator('[data-record-open-id="' + id + '"]').click(); await page.waitForFunction(() => typeof window.__uiAuditReleaseRead === 'function');
    await capture('record-delayed-read.png', '记录读取稍晚 · 等待本地资料', false, true);
    await page.locator('[data-view="settings"]').click({ timeout: 3000 }); await releaseRead(); await finishMotion();
    check(await page.evaluate(() => state.view === 'settings'), 'late-record-read-keeps-new-view', {});
  } finally { await releaseRead(); }
  await page.locator('[data-library-group-id="uncategorized"]').click(); await finishMotion();
  const origin = await page.locator('[data-record-id="' + id + '"]').boundingBox();
  await delayRead();
  try {
    await page.locator('[data-record-open-id="' + id + '"]').click(); await page.waitForFunction(() => typeof window.__uiAuditReleaseRead === 'function');
    const enter = await motionFrame('record-open-mid.png', '从卡片位置展开 · 中间帧');
    check(enter.transitionKind === 'record-open', 'record-origin-transition', { origin, kind: enter.transitionKind });
    await releaseRead(); await page.locator('#record-detail [data-action="rename-record"]').waitFor(); await motionFrame('record-read-content-mid.png', '本地资料读到后 · 内容进入中间帧');
    await capture('record-open-complete.png', '从卡片展开 · 详情终态');
  } finally { await releaseRead(); }
  await page.locator('#back-to-group-home').click(); const returned = await motionFrame('record-return-mid.png', '返回原卡片 · 中间帧');
  check(returned.transitionKind === 'record-close', 'record-return-transition', returned.transitionKind);
  await page.locator('[data-record-open-id="' + id + '"]').waitFor({ state: 'visible' });
  const back = await page.evaluate(() => ({ home: state.libraryMode === 'home', selected: state.selectedId, focusHidden: Boolean(document.activeElement?.closest('.hidden')), focusConnected: Boolean(document.activeElement?.isConnected) }));
  check(back.home && back.selected === null && !back.focusHidden && back.focusConnected, 'record-return-final-state', back);
  await page.evaluate(id => { document.querySelector('[data-record-open-id="' + id + '"]').click(); document.querySelector('[data-view="settings"]').click(); }, id); await finishMotion();
  check(await page.evaluate(() => state.view === 'settings' && !document.documentElement.dataset.uiTransitionKind), 'rapid-record-navigation-finishes-cleanly', {});
  await page.locator('[data-library-group-id="uncategorized"]').click(); await finishMotion();
  await page.locator('#toggle-record-selection').click(); await motionFrame('selection-enter-mid.png', '多选工具栏 · 展开中间帧');
  const toolbar = await page.locator('.record-selection-toolbar').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, controls: [...element.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width).map(button => ({ text: button.textContent.trim(), alignment: getComputedStyle(button).textAlign, height: button.getBoundingClientRect().height })) }));
  check(['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'].includes(toolbar.background) && toolbar.controls.every(item => item.alignment === 'center' && item.height >= 31), 'compact-transparent-selection-toolbar', toolbar);
  await page.locator('#toggle-record-selection').click(); await motionFrame('selection-exit-mid.png', '多选工具栏 · 收起中间帧');
  await page.evaluate(() => { for (let count = 0; count < 4; count += 1) document.querySelector('#toggle-record-selection').click(); }); await finishMotion();
  const rapidSelection = await page.evaluate(() => ({ active: recordSelection.enabled, toolbarMode: document.querySelector('.record-selection-toolbar').getAttribute('data-selection-active'), actionsHidden: ['add-selected-records', 'delete-selected-records'].every(id => document.getElementById(id).classList.contains('hidden')), leftovers: document.querySelectorAll('.ui-motion-snapshot,.ui-motion-collapse-slot').length, focusHidden: Boolean(document.activeElement?.closest('.hidden')) }));
  check(!rapidSelection.active && rapidSelection.toolbarMode === 'false' && rapidSelection.actionsHidden && !rapidSelection.leftovers && !rapidSelection.focusHidden, 'rapid-selection-toggle-cleans-visuals', rapidSelection);
  await openRecord(id); await finishMotion();
  await page.locator('#record-detail [data-action="rename-record"]').click(); await motionFrame('title-edit-enter-mid.png', '标题编辑 · 展开中间帧');
  const titleActions=await page.locator('#record-detail .record-inline-actions').first().evaluate(element=>[...element.querySelectorAll('button')].filter(button=>getComputedStyle(button).display!=='none').map(button=>({label:button.getAttribute('aria-label'),icon:button.getAttribute('data-ui-icon'),semantic:button.className,color:getComputedStyle(button).color,width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height})));
  check(titleActions.length===2&&titleActions[0].label==='保存标题'&&titleActions[0].icon==='check'&&titleActions[0].semantic.includes('ui-confirm')&&titleActions[1].label==='取消重命名'&&titleActions[1].icon==='close'&&titleActions[1].semantic.includes('ui-cancel')&&titleActions.every(action=>Math.abs(action.width-32)<1&&Math.abs(action.height-32)<1)&&['rgb(37, 109, 73)','rgb(29, 87, 59)'].includes(titleActions[0].color)&&['rgb(180, 35, 24)','rgb(146, 29, 21)'].includes(titleActions[1].color),'title-edit-icon-actions',titleActions);
  await page.locator('#record-detail [aria-label="取消重命名"]').click(); await motionFrame('title-edit-exit-mid.png', '标题编辑 · 收起中间帧');
  await page.locator('#record-detail [data-action="show-original"]').click(); await motionFrame('transcript-tab-mid.png', '语音文本切换 · 中间帧');
  await page.locator('#record-detail [data-action="show-summary"]').click(); await motionFrame('summary-tab-mid.png', '思考摘要切换 · 中间帧');
  const evidence = page.locator('#record-detail [data-disclosure="summary-evidence"]');
  await evidence.locator('summary').click(); await motionFrame('evidence-enter-mid.png', '总结依据 · 展开中间帧');
  await evidence.locator('summary').click(); await motionFrame('evidence-exit-mid.png', '总结依据 · 收起中间帧');
  check(await evidence.evaluate(element => !element.open), 'details-close-final-state', {});
  await home(); await finishMotion();
  await resize({ width: 800, height: 720, zoom: 1 });
  await page.locator('#toggle-group-sidebar').click(); await motionFrame('sidebar-enter-mid.png', '分组侧栏 · 展开中间帧');
  check(await page.locator('body').evaluate(element => element.classList.contains('group-sidebar-open')), 'sidebar-open-state', {});
  await page.locator('#close-group-sidebar').click(); await motionFrame('sidebar-exit-mid.png', '分组侧栏 · 收起中间帧');
  check(await page.locator('body').evaluate(element => !element.classList.contains('group-sidebar-open')), 'sidebar-close-state', {});
  await page.evaluate(() => { document.querySelector('#toggle-group-sidebar').click(); document.querySelector('#close-group-sidebar').click(); document.querySelector('#toggle-group-sidebar').click(); }); await finishMotion();
  const sidebarRace = await page.evaluate(() => ({ open: document.body.classList.contains('group-sidebar-open'), ghosts: document.querySelectorAll('.ui-motion-snapshot,.ui-motion-scrim').length }));
  check(sidebarRace.open && sidebarRace.ghosts === 0, 'sidebar-rapid-reopen-cleans-ghosts', sidebarRace);
  await page.locator('#close-group-sidebar').click(); await finishMotion();
  await resize({ width: 1440, height: 900, zoom: 1 });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await openRecord(id); await finishMotion();
  const reduced = await page.evaluate(() => ({ detail: state.libraryMode === 'detail', transitions: document.getAnimations().filter(animation => animation.effect?.pseudoElement?.includes('view-transition')).length, marker: document.documentElement.dataset.uiTransitionKind || null }));
  check(reduced.detail && reduced.transitions === 0 && !reduced.marker, 'reduced-motion-keeps-navigation-usable', reduced);
  await home(); await page.emulateMedia({ reducedMotion: 'no-preference' }); await finishMotion();
}
async function inspect(label) {
  await finishMotion();
  const result = await page.evaluate(() => {
    const visible = element => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || element.closest('.hidden') || element.closest('dialog:not([open])') || element.closest('[popover]') && !element.closest('[popover]').matches(':popover-open')) return false; for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false; return true; };
    const red = color => { const c = color.match(/[\d.]+/gu)?.map(Number) || []; return c[0] > 120 && c[0] > c[1] * 1.4 && c[0] > c[2] * 1.3; };
    const panes = [...document.querySelectorAll('.workspace,.page-view:not(.hidden),#record-column,.collection-toolbar,.library-filters,dialog[open],:popover-open')].filter(visible).map(element => { const rect = element.getBoundingClientRect(); return { name: element.id || element.className, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, scrollWidth: element.scrollWidth, width: element.clientWidth }; });
    const controls = [...document.querySelectorAll('button,input:not([type=checkbox]):not([type=range]),select')].filter(visible).map(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element), label = element.getAttribute('aria-label') || element.textContent.trim() || element.id;
      const target = element.matches('input') && element.closest('label.search-box,label.cloud-search') || element;
      const targetRect = target.getBoundingClientRect();
      const iconOnly = !element.textContent.trim() || /^[×✎←…＋−]$/u.test(element.textContent.trim());
      const ellipsis = element.matches('.record-open,.primary-group-navigation button,.nav-item,.group-picker-option') || getComputedStyle(element).textOverflow === 'ellipsis';
      const range = document.createRange(); range.selectNodeContents(element); const text = range.getBoundingClientRect();
      return { id: element.id || element.className, label: label.slice(0, 70), height: targetRect.height, width: targetRect.width, font: parseFloat(style.fontSize), iconOnly, named: Boolean(label), ellipsis, clipped: !ellipsis && text.width > 0 && (text.left < rect.left - 1 || text.right > rect.right + 1 || text.top < rect.top - 1 || text.bottom > rect.bottom + 1), danger: /删除/.test(label) && !/关闭|取消/.test(label), isRed: red(style.color) || red(style.backgroundColor) };
    });
    const ai = [...document.querySelectorAll('#ai-search,#batch-organize,#submit-ai-search,[data-action="organize-record"]')].filter(visible).map(element => {
      const root = element.querySelector(':scope > .ui-action-icon'); const outline = root?.querySelector('.ui-icon-outline'); const solid = root?.querySelector('.ui-icon-solid'); const icon = outline && getComputedStyle(outline);
      return { id: element.id || element.getAttribute('data-action'), attribute: element.getAttribute('data-ui-icon'), count: element.querySelectorAll(':scope > .ui-action-icon').length, decorative: root?.getAttribute('aria-hidden'), layers: Boolean(outline && solid), mask: icon?.maskImage || icon?.webkitMaskImage, width: root?.getBoundingClientRect().width, text: element.textContent.trim() };
    });
    const icons = [...document.querySelectorAll('[data-ui-icon]')].filter(visible).filter(element => !element.classList.contains('ui-action-icon')).map(element => {
      const root = element.querySelector(':scope > .ui-action-icon'), outline = root?.querySelector('.ui-icon-outline'); const icon = getComputedStyle(outline || element, outline ? undefined : '::before');
      return { name: element.getAttribute('data-ui-icon'), mask: icon.maskImage || icon.webkitMaskImage, hydrated: Boolean(root), actionable: element.matches('button,a,[role=button]') };
    });
    const gridCards = [...document.querySelectorAll('#record-grid-host #record-list .record-card')].filter(visible).map(element => {
      const rect = element.getBoundingClientRect(), title = element.querySelector('h3')?.getBoundingClientRect();
      return { id: element.getAttribute('data-record-id'), row: Math.round(rect.top), height: rect.height, titleTop: title ? title.top - rect.top : null, titleBottom: title?.bottom, bottom: rect.bottom };
    });
    const emptyDividers = [...document.querySelectorAll('.detail-inner section,.detail-inner details,.detail-inner>div')].filter(visible).filter(element => { const style = getComputedStyle(element); return (parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderBottomWidth) > 0) && !element.textContent.trim() && !element.querySelector('audio,img,input,textarea'); }).map(element => element.className);
    return { label: '', viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, panes, controls, ai, icons, gridCards, emptyDividers };
  });
  result.label = label; measurements.push(result);
  const reachability = await page.evaluate(inspectControlReachability);
  measurements.push({ label: 'reachability ' + label, ...reachability });
  for (const control of reachability.failures) check(false, 'control-not-reachable', { screen: label, scope: reachability.scope, ...control });
  check(result.documentWidth <= result.viewport.width + 1 && result.bodyWidth <= result.viewport.width + 1, 'viewport-overflow', { label, width: result.viewport.width, document: result.documentWidth, body: result.bodyWidth });
  for (const pane of result.panes) check(pane.left >= -1 && pane.right <= result.viewport.width + 1, 'pane-width', { label, ...pane });
  for (const control of result.controls) {
    check(control.height >= 31 && control.width >= 23, 'control-target', { screen: label, ...control });
    check(control.font >= 12 || control.iconOnly, 'control-font', { screen: label, ...control });
    if (control.iconOnly) check(control.named, 'control-accessible-name', { screen: label, ...control });
    check(!control.clipped, 'control-label-clipping', { screen: label, ...control });
    if (control.danger) check(control.isRed, 'danger-red', { screen: label, ...control });
  }
  for (const ai of result.ai) check(ai.attribute === 'sparkle' && ai.count === 1 && ai.decorative === 'true' && ai.layers && ai.mask && ai.mask !== 'none' && ai.width >= 14 && ai.text.length > 0, 'ai-icon-inside-button', { label, ...ai });
  for (const icon of result.icons) check(icon.mask && icon.mask !== 'none' && (!icon.actionable || icon.hydrated), 'icon-mask-defined', { label, ...icon });
  const gridRows = new Map();
  for (const card of result.gridCards) {
    if (!gridRows.has(card.row)) gridRows.set(card.row, []); gridRows.get(card.row).push(card);
    check(card.titleTop !== null && card.titleBottom <= card.bottom, 'grid-title-visible', { label, card });
  }
  for (const cards of gridRows.values()) check(Math.max(...cards.map(card => card.titleTop)) - Math.min(...cards.map(card => card.titleTop)) <= 1, 'grid-title-alignment', { label, cards });
  check(!result.emptyDividers.length, 'empty-divider', { label, classes: result.emptyDividers });
  return result;
}
async function openRecord(id) {
  const button = page.locator('[data-record-open-id="' + id + '"]'); await button.click();
  await page.locator('#record-detail [data-action="rename-record"]').waitFor(); await finishMotion();
}
async function home() {
  if (await page.locator('#back-to-group-home').isVisible()) await page.locator('#back-to-group-home').click();
  if (!(await page.locator('#inbox-view').isVisible())) await page.locator('[data-view="inbox"]').click({ force: true });
  await finishMotion();
}
async function spacingReview(label) {
  await finishMotion();
  const result = await page.evaluate(() => {
    const rect = element => { if (!element) return null; const box=element.getBoundingClientRect();return {left:box.left,top:box.top,right:box.right,bottom:box.bottom,width:box.width,height:box.height,cx:(box.left+box.right)/2,cy:(box.top+box.bottom)/2}; };
    const visible = element => { const box=element.getBoundingClientRect();return box.width>0 && box.height>0 && getComputedStyle(element).visibility!=='hidden' && !element.closest('.hidden,dialog:not([open]),.ui-motion-snapshot'); };
    const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
    const baseline = element => { if(!element)return null; const box=rect(element),style=getComputedStyle(element);context.font=style.font;const text=context.measureText('记录Ag123');const ascent=text.fontBoundingBoxAscent || text.actualBoundingBoxAscent,descent=text.fontBoundingBoxDescent || text.actualBoundingBoxDescent;return box.top+(box.height-ascent-descent)/2+ascent; };
    const textBox = element => { const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),boxes=[];let node;while(node=walker.nextNode()){if(!node.textContent.trim() || node.parentElement.closest('.ui-action-icon'))continue;const range=document.createRange();range.selectNodeContents(node);for(const box of range.getClientRects())if(box.width&&box.height)boxes.push(box);}return boxes.length?{left:Math.min(...boxes.map(box=>box.left)),right:Math.max(...boxes.map(box=>box.right)),top:Math.min(...boxes.map(box=>box.top)),bottom:Math.max(...boxes.map(box=>box.bottom))}:null; };
    const master=document.querySelector('#select-visible-records'),column=document.querySelector('#record-column'),header=document.querySelector('#record-column-header'),toggle=document.querySelector('#toggle-record-selection');
    const rows=[...document.querySelectorAll('#record-column #record-list .record-card')].map(card=>{const title=card.querySelector('h3'),checkbox=card.querySelector('.record-selection');return {id:card.getAttribute('data-record-id'),row:rect(card),title:rect(title),checkbox:visible(checkbox)?rect(checkbox):null,baseline:baseline(title)};});
    const iconText=[...document.querySelectorAll('button[data-ui-icon],a[data-ui-icon],summary[data-ui-icon]')].filter(visible).map(button=>{const icon=button.querySelector(':scope>.ui-action-icon'),text=textBox(button);if(!icon || !text)return null;const box=rect(icon),gap=box.right<=text.left+.5?text.left-box.right:text.right<=box.left+.5?box.left-text.right:null;return {id:button.id || button.getAttribute('data-action') || button.className,icon:button.getAttribute('data-ui-icon'),gap,fieldDisclosure:button.id==='ai-provider-trigger',styleGap:getComputedStyle(button).columnGap,button:rect(button),iconBox:box,text};}).filter(Boolean);
    const filter=document.querySelector('#library-filter-trigger'),organize=document.querySelector('#batch-organize'),group=document.querySelector('#add-selected-records'),remove=document.querySelector('#delete-selected-records');
    return {label:'',viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},mode:state.libraryMode,selection:recordSelection.enabled,selectedId:state.selectedId,count:recordSelection.ids.size,master:{...rect(master),type:master.type,checked:master.checked,mixed:master.indeterminate,aria:master.getAttribute('aria-checked'),glyph:{width:getComputedStyle(master,'::before').width,height:getComputedStyle(master,'::before').height}},toggle:{...rect(toggle),text:toggle.textContent,icon:toggle.getAttribute('data-ui-icon'),decorativeCount:toggle.querySelectorAll('.ui-action-icon').length,baseline:baseline(toggle)},column:visible(column)?rect(column):null,header:visible(header)?rect(header):null,search:rect(document.querySelector('#search-input').closest('.search-box')),searchInput:rect(document.querySelector('#search-input')),heading:rect(document.querySelector('#collection-heading')),back:rect(document.querySelector('#back-to-group-home')),filter:{...rect(filter),baseline:baseline(filter)},organize:{...rect(organize),baseline:baseline(organize)},actions:[group,remove].filter(visible).map(element=>({id:element.id,...rect(element),baseline:baseline(element)})),rows,iconText};
  });
  result.label=label;measurements.push(result);
  check(result.master.type==='checkbox' && result.toggle.icon===null && result.toggle.decorativeCount===0,'selection-entry-checkbox-and-text',result);
  for(const item of result.iconText) check(item.fieldDisclosure ? parseFloat(item.styleGap)>=8 : item.gap!==null && Math.abs(item.gap-8)<=1,'icon-text-spacing',{label,...item});
  if(result.column) {
    check(Math.abs(result.master.cx-result.back.cx)<=1 && Math.abs(result.search.left-result.column.left-8)<=1 && Math.abs(result.column.right-result.search.right-8)<=1,'sidebar-header-common-starts',result);
    check(Math.abs(result.searchInput.left-result.heading.left)<=1 && Math.abs(result.search.height-36)<=1,'sidebar-search-text-start',result);
    check(Math.abs(result.filter.width-result.organize.width)<=1 && Math.abs(result.filter.cy-result.organize.cy)<=1 && Math.abs(result.filter.baseline-result.organize.baseline)<=1,'sidebar-filter-organize-alignment',result);
    for(const row of result.rows) {
      check(Math.abs(row.title.cy-row.row.cy)<=1,'record-title-centered',{label,row});
      if(row.checkbox)check(Math.abs(row.checkbox.cx-result.master.cx)<=1 && Math.abs(row.checkbox.cy-row.row.cy)<=1 && Math.abs(row.title.left-result.heading.left)<=1,'selection-row-common-start',{label,row,master:result.master,heading:result.heading});
      else check(Math.abs(row.title.left-result.column.left-16)<=1,'record-default-text-start',{label,row,column:result.column});
    }
    if(result.actions.length===2)check(Math.abs(result.actions[0].width-result.actions[1].width)<=1 && Math.abs(result.actions[0].cy-result.actions[1].cy)<=1 && Math.abs(result.actions[0].baseline-result.actions[1].baseline)<=1,'selection-actions-aligned',result.actions);
  }
  await inspect(label);return result;
}
async function captureGuides(filename,label,review) {
  await page.evaluate(review=>{const host=document.createElement('div');host.id='ui-audit-guides';Object.assign(host.style,{position:'fixed',inset:'0',pointerEvents:'none',zIndex:'2147483647'});const line=(axis,value,start,end,color)=>{const element=document.createElement('div');Object.assign(element.style,{position:'fixed',background:color,opacity:'.6',left:(axis==='x'?value:start)+'px',top:(axis==='x'?start:value)+'px',width:(axis==='x'?1:end-start)+'px',height:(axis==='x'?end-start:1)+'px'});host.append(element);};if(review.column){for(const x of [review.column.left,review.column.right,review.heading.left,review.master.cx])line('x',x,0,innerHeight,'#d8328c');for(const row of review.rows.filter(item=>item.row.top>=0 && item.row.bottom<=innerHeight).slice(0,4)){line('y',row.row.cy,review.column.left,review.column.right,'#078a86');line('y',row.baseline,review.column.left,review.column.right,'#cf7a1b');}}for(const item of review.iconText.filter(item=>item.button.top>=0 && item.button.bottom<=innerHeight).slice(0,10))line('y',item.iconBox.cy,item.button.left,item.button.right,'#1f89b5');document.body.append(host);},review);
  await capture(filename,label,false,true);await page.locator('#ui-audit-guides').evaluate(element=>element.remove());
}
async function checkboxRaster(filename,label) {
  await finishMotion();const boxes=await page.evaluate(()=>{const elements=[document.querySelector('#select-visible-records'),...[...document.querySelectorAll('#record-list .record-selection')].filter(element=>element.getClientRects().length).slice(0,3)];return {viewport:innerWidth,boxes:elements.map(element=>{const box=element.getBoundingClientRect();return{id:element.id || element.getAttribute('data-record-select-id'),left:box.left,top:box.top,right:box.right,bottom:box.bottom,cx:(box.left+box.right)/2,cy:(box.top+box.bottom)/2};})};});
  const raster=await application.evaluate(async({BrowserWindow})=>{const image=await BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('/renderer/')).capturePage(),png=image.toPNG();return{png:png.toString('base64'),bitmap:image.toBitmap().toString('base64'),width:png.readUInt32BE(16),height:png.readUInt32BE(20)};});fs.writeFileSync(path.join(output,filename),Buffer.from(raster.png,'base64'));screenshots.push({filename,title:label});
  const bitmap=Buffer.from(raster.bitmap,'base64'),scale=raster.width/boxes.viewport;
  for(const box of boxes.boxes){box.ink=checkboxInk({data:bitmap,width:raster.width,height:raster.height,format:'bgra'},box,scale);check(box.ink && Math.abs(box.ink.width-16)<=1 && Math.abs(box.ink.height-16)<=1 && Math.abs(box.ink.centerX-box.cx)<=1 && Math.abs(box.ink.centerY-box.cy)<=1,'checkbox-ink-in-hit-frame',{label,box,scale});}
  if(boxes.boxes.length>1)check(Math.abs(boxes.boxes[0].cx-boxes.boxes[1].cx)<=1,'master-and-first-record-checkbox-align',{label,boxes:boxes.boxes.slice(0,2)});
  measurements.push({label:'checkbox raster '+label,pixelsPerCSS:scale,boxes:boxes.boxes});
}
async function selectionState() { return page.evaluate(()=>{const master=document.querySelector('#select-visible-records');return{enabled:recordSelection.enabled,count:recordSelection.ids.size,total:document.querySelectorAll('#record-list .record-card').length,checked:master.checked,mixed:master.indeterminate,aria:master.getAttribute('aria-checked'),selectedId:state.selectedId,mode:state.libraryMode};}); }
async function exerciseSelection(mode,name) {
  const initial=await selectionState();check(!initial.enabled && !initial.count && !initial.checked && !initial.mixed,'selection-default-state',{mode,name,initial});
  await page.locator('#toggle-record-selection').click();let state=await selectionState();check(state.enabled && !state.count && state.selectedId===initial.selectedId && state.mode===initial.mode,'selection-text-enters-empty',{mode,name,state});
  await page.locator('#toggle-record-selection').click();const target=await page.locator('.record-selection-checkbox-target').boundingBox();await page.mouse.click(target.x+2,target.y+target.height/2);await finishMotion();state=await selectionState();check(state.enabled && state.checked && !state.mixed && state.count===state.total && state.count>1,'master-hit-enters-all',{mode,name,state});
  const review=await spacingReview(mode+' all '+name);await checkboxRaster(mode+'-all-'+name+'.png',mode+' master all / '+name);await captureGuides(mode+'-all-guides-'+name+'.png',mode+' baseline guides / '+name,review);
  await page.locator('#record-list .record-selection').first().uncheck();await finishMotion();state=await selectionState();check(state.mixed && !state.checked && state.aria==='mixed' && state.count===state.total-1 && state.selectedId===initial.selectedId && state.mode===initial.mode,'row-checkbox-mixed-without-opening',{mode,name,state});
  await checkboxRaster(mode+'-mixed-'+name+'.png',mode+' master mixed / '+name);await page.locator('#select-visible-records').click();state=await selectionState();check(state.checked && !state.mixed && state.count===state.total,'mixed-master-selects-all',{mode,name,state});
  await page.locator('#select-visible-records').focus();await page.keyboard.press('Space');state=await selectionState();check(state.enabled && !state.checked && !state.mixed && state.count===0,'master-space-clears-selection',{mode,name,state});
  await page.locator('#toggle-record-selection').click();state=await selectionState();check(!state.enabled && state.count===0 && !state.checked && !state.mixed,'selection-done-clears',{mode,name,state});
}
async function auditVisualPolish(fixture) {
  if(visualPolishSidebar){
    const sizes=[{width:1024,height:768,zoom:1},{width:1440,height:900,zoom:1.5},{width:1024,height:768,zoom:1.5}];
    for(const size of sizes){const name=size.width+'-'+size.zoom;await resize(size);await home();await openRecord(fixture.ids[0]);const review=await spacingReview('final compact detail '+name);await capture('detail-summary-'+name+'.png','最终窄栏默认 / '+name);await captureGuides('detail-summary-guides-'+name+'.png','最终窄栏基线 / '+name,review);await exerciseSelection('detail',name);}
    measurements.push({label:'final renderer source',stylesheetSHA256:createHash('sha256').update(fs.readFileSync(path.join(root,'src/renderer/styles.css'))).digest('hex')});
    return;
  }
  const sizes=[{width:1440,height:900,zoom:1},{width:1280,height:800,zoom:1},{width:1024,height:768,zoom:1},{width:800,height:720,zoom:1},{width:1440,height:900,zoom:1.25},{width:1440,height:900,zoom:1.5},{width:1024,height:768,zoom:1.5}];
  for(const size of sizes){const name=size.width+'-'+size.zoom;await resize(size);await home();await spacingReview('home default '+name);await capture('home-default-'+name+'.png','主页默认 / '+name);await exerciseSelection('home',name);await openRecord(fixture.ids[0]);let review=await spacingReview('detail summary '+name);await capture('detail-summary-'+name+'.png','摘要详情 / '+name);await captureGuides('detail-summary-guides-'+name+'.png','详情基线 / '+name,review);await exerciseSelection('detail',name);await page.locator('#record-detail [data-action="show-original"]').click();await spacingReview('detail original '+name);await capture('detail-original-'+name+'.png','原始语音文本 / '+name);await page.locator('#record-detail [data-action="show-summary"]').click();await finishMotion();
    await page.locator('#select-visible-records').click();await page.locator('#library-filter-trigger').click();await page.locator('.library-filter-popover').waitFor({state:'visible'});await spacingReview('filter popover '+name);await capture('filter-'+name+'.png','筛选浮框 / '+name);await page.locator('#filter-popup-keyword').fill('回顾');await page.locator('#filter-popup-apply').click();await page.locator('.library-filter-popover').waitFor({state:'detached'});await finishMotion();let state=await selectionState();check(!state.enabled && !state.count && !state.checked && !state.mixed,'filter-scope-resets-master',{size,state});await page.locator('#library-filter-trigger').click();await page.locator('#filter-popup-keyword').fill('');await page.locator('#filter-popup-apply').click();await page.locator('.library-filter-popover').waitFor({state:'detached'});await finishMotion();
  }
  await resize(sizes[0]);await home();await page.locator('#select-visible-records').click();await page.locator('[data-library-group-id="'+fixture.topics[0].id+'"]').click();await finishMotion();const groupState=await selectionState();check(!groupState.enabled && !groupState.checked && !groupState.mixed && !groupState.count,'group-scope-resets-master',groupState);await page.locator('[data-library-group-id="uncategorized"]').click();await finishMotion();
  await page.locator('#open-primary-group-manager').click();await spacingReview('group manager');await capture('groups.png','分组管理基线');await page.locator('#close-group-management').click();await finishMotion();
  const records=await page.evaluate(ids=>Promise.all(ids.map(id=>window.inmoment.invoke('records:get',{id}))),fixture.ids.slice(0,20));await page.evaluate(records=>{const names=['阅读与思考','产品设计','日常生活'];state.batchResultItems=records.map((record,index)=>({id:record.id,title:record.title,version:record.version,record,status:'success',topicSuggestions:[names[index%3]]}));initializeBatchChoices();renderBatchResults();document.querySelector('#batch-results-status').textContent='合成整理结果 · 20条 / 3个分组';document.querySelector('#batch-results-dialog').showModal();},records);
  for(const size of [sizes[0],sizes[3],sizes[5]]){await resize(size);await spacingReview('batch review '+size.width+'-'+size.zoom);await capture('batch-'+size.width+'-'+size.zoom+'.png','整理结果 / '+size.width+' / '+size.zoom);}await page.locator('#close-batch-results').click();await finishMotion();
  for(const size of [sizes[0],sizes[3],sizes[4],sizes[5]]){await resize(size);await page.locator('[data-view="settings"]').click();await finishMotion();await page.locator('#settings-nav-ai').click();await finishMotion();await page.locator('#api-key').scrollIntoViewIfNeeded();await spacingReview('settings '+size.width+'-'+size.zoom);await capture('settings-'+size.width+'-'+size.zoom+'.png','设置基线 / '+size.width+' / '+size.zoom);await page.locator('#ai-provider-trigger').click();await page.locator('.select-popover').waitFor({state:'visible'});await spacingReview('settings provider menu '+size.width+'-'+size.zoom);await capture('settings-provider-'+size.width+'-'+size.zoom+'.png','服务浮框基线 / '+size.width+' / '+size.zoom);await page.keyboard.press('Escape');await page.locator('.select-popover').waitFor({state:'detached'});}
  await resize(sizes[0]);
}
async function inspectDetailTools(label) {
  await finishMotion();
  const result = await page.evaluate(() => {
    const rect = element => { const box = element.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
    const shown = element => element && element.getClientRects().length && !element.closest('.hidden');
    const column = document.querySelector('#record-column'), detail = document.querySelector('#record-detail');
    const ids = ['collection-heading', 'back-to-group-home', 'record-count', 'search-input', 'library-filter-trigger', 'batch-organize', 'cancel-batch', 'batch-status', 'toggle-record-selection', 'select-visible-records', 'record-selection-count', 'add-selected-records', 'delete-selected-records'];
    const tools = ids.map(id => document.getElementById(id)).filter(shown).map(element => {
      const box = rect(element), hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      return { id: element.id, inColumn: column.contains(element), inDetail: detail.contains(element), ...box, text: element.textContent.trim().slice(0, 70), canClick: element.matches('button,input') && !element.disabled, unobscured: hit === element || element.contains(hit), instances: document.querySelectorAll('#' + element.id).length };
    });
    const list = document.querySelector('#record-list'); const heading = detail.querySelector('h2');
    return { label: '', mode: state.libraryMode, selectedId: state.selectedId, selectedCount: recordSelection.ids.size, viewport: { width: innerWidth, height: innerHeight }, mainContentTop: document.querySelector('.app-titlebar').getBoundingClientRect().bottom, column: rect(column), detail: rect(detail), title: heading ? rect(heading) : null, list: { ...rect(list), rowCount: list.querySelectorAll('.record-card').length, rowHeights: [...list.querySelectorAll('.record-card')].map(row => row.getBoundingClientRect().height) }, tools, mainListTools: [...document.querySelectorAll('#inbox-view .collection-toolbar,#inbox-view .library-filters,#inbox-view .record-selection-toolbar')].filter(shown).map(element => element.id || element.className) };
  });
  result.label = label; measurements.push(result);
  check(result.mode === 'detail' && result.column.width > 0 && result.column.height > 0 && result.tools.length >= 7, 'detail-tools-present-in-column', result);
  check(result.tools.every(tool => tool.inColumn && !tool.inDetail && tool.left >= result.column.left - 1 && tool.right <= result.column.right + 1 && tool.top >= result.column.top - 1 && tool.bottom <= result.column.bottom + 1), 'detail-tools-stay-in-column', result);
  check(result.tools.every(tool => tool.instances === 1 && (!tool.canClick || tool.unobscured)), 'detail-tools-unique-and-reachable', { label, tools: result.tools });
  check(result.mainListTools.length === 0 && result.detail.top <= result.mainContentTop + 32 && result.title && result.title.top < result.mainContentTop + 80, 'detail-starts-with-record-content', result);
  check(result.list.height >= 130 && result.list.rowHeights.every(height => height >= 44), 'sidebar-list-remains-readable', { label, list: result.list });
  await inspect(label); return result;
}
async function inspectAnchoredPanel(panelSelector, anchorSelector, label) {
  await finishMotion();
  const result = await page.evaluate(({ panelSelector, anchorSelector }) => {
    const box = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; };
    const panel = box(document.querySelector(panelSelector)), anchorElement = document.querySelector(anchorSelector), anchor = box(anchorElement);
    const gapX = Math.max(0, panel.left - anchor.right, anchor.left - panel.right), gapY = Math.max(0, panel.top - anchor.bottom, anchor.top - panel.bottom);
    return { panel, anchor, anchorInColumn: document.querySelector('#record-column').contains(anchorElement), distance: Math.hypot(gapX, gapY), viewport: { width: innerWidth, height: innerHeight } };
  }, { panelSelector, anchorSelector });
  measurements.push({ label, ...result });
  check(result.anchorInColumn && result.distance <= 20 && result.panel.left >= 0 && result.panel.right <= result.viewport.width + 1 && result.panel.top >= 0 && result.panel.bottom <= result.viewport.height + 1, 'sidebar-panel-anchored-and-contained', { label, ...result });
  await inspect(label);
}
async function auditDetailTools(fixture) {
  await page.evaluate(() => {
    window.__uiAuditToolsInvoke = invoke; window.__uiAuditToolsCalls = [];
    invoke = async function(method, params) {
      window.__uiAuditToolsCalls.push({ method, params });
      if (method === 'library:batchOrganize') return new Promise(resolve => { window.__uiAuditReleaseToolsBatch = () => resolve({ cancelled: true }); });
      if (method === 'library:cancel') return { cancelled: true };
      if (/^(records:(organize|aiSearch)|semantic:)/u.test(method)) throw new Error('The detail tools audit does not permit model requests.');
      return window.__uiAuditToolsInvoke(method, params);
    };
  });
  const sizes = [{ width: 1440, height: 900, zoom: 1 }, { width: 1024, height: 768, zoom: 1 }, { width: 800, height: 720, zoom: 1 }, { width: 1440, height: 900, zoom: 1.5 }, { width: 1024, height: 768, zoom: 1.5 }];
  for (const size of sizes) {
    const name = size.width + '-' + size.zoom;
    await resize(size); await home(); await openRecord(fixture.ids[0]);
    await inspectDetailTools('detail default ' + name); await capture('detail-default-' + name + '.png', '详情 · 列表工具固定在记录栏 / ' + name);
    await page.locator('#toggle-record-selection').click(); await inspectDetailTools('detail selecting ' + name); await capture('detail-selecting-' + name + '.png', '多选 · 工具留在记录栏 / ' + name);
    await page.locator('#select-visible-records').click(); const selected = await inspectDetailTools('detail select all ' + name);
    check(selected.selectedCount === selected.list.rowCount && selected.selectedCount > 1, 'sidebar-select-all-current-list', selected);
    await capture('detail-select-all-' + name + '.png', '全选 · 记录栏与详情 / ' + name);
    await page.locator('#add-selected-records').click(); await page.locator('.group-picker').waitFor({ state: 'visible' });
    await inspectAnchoredPanel('.group-picker', '#add-selected-records', 'sidebar group picker ' + name); await page.locator('.group-picker-search').fill('阅读');
    await capture('sidebar-group-picker-' + name + '.png', '添加到组 · 记录栏旁浮框 / ' + name); await page.keyboard.press('Escape'); await page.locator('.group-picker').waitFor({ state: 'detached' });
    await page.locator('#delete-selected-records').click(); await page.locator('.confirm-popover').waitFor({ state: 'visible' });
    await inspectAnchoredPanel('.confirm-popover', '#delete-selected-records', 'sidebar delete confirmation ' + name); await capture('sidebar-delete-confirm-' + name + '.png', '删除确认 · 记录栏旁浮框 / ' + name);
    await page.locator('.confirm-popover [data-confirm-action="cancel"]').click(); await page.locator('.confirm-popover').waitFor({ state: 'detached' });
    const afterCancel = await inspectDetailTools('detail selection after cancel ' + name); check(afterCancel.selectedCount === selected.selectedCount && afterCancel.selectedId === selected.selectedId, 'sidebar-cancel-preserves-selection-and-record', afterCancel);
    await page.locator('#toggle-record-selection').click(); await finishMotion();
    await page.locator('#library-filter-trigger').click(); await page.locator('.library-filter-popover').waitFor({ state: 'visible' });
    await inspectAnchoredPanel('.library-filter-popover', '#library-filter-trigger', 'sidebar filter ' + name); await capture('sidebar-filter-' + name + '.png', '筛选 · 从记录栏展开 / ' + name);
    await page.locator('#filter-popup-keyword').fill('把录音'); await page.locator('#filter-popup-apply').click(); await page.locator('.library-filter-popover').waitFor({ state: 'detached' }); await finishMotion();
    await inspectDetailTools('detail filtered ' + name); await capture('detail-filtered-' + name + '.png', '筛选后 · 详情保持阅读位置 / ' + name);
    await page.locator('#library-filter-trigger').click(); await page.locator('#filter-popup-keyword').fill(''); await page.locator('#filter-popup-apply').click(); await page.locator('.library-filter-popover').waitFor({ state: 'detached' }); await finishMotion();
    await page.locator('#batch-organize').click(); await page.locator('#cancel-batch').waitFor({ state: 'visible' });
    await inspectDetailTools('detail batch pending mock ' + name); await capture('sidebar-batch-pending-' + name + '.png', '整理中 · 合成等待状态 / ' + name);
    await page.locator('#cancel-batch').click(); await page.evaluate(() => window.__uiAuditReleaseToolsBatch?.()); await page.waitForFunction(() => !state.batchBusy); await finishMotion();
    await inspectDetailTools('detail batch cancelled ' + name); await home();
    const returned = await page.evaluate(() => ({ mode: state.libraryMode, selected: state.selectedId, selection: recordSelection.enabled, listHome: document.querySelector('#record-grid-host').contains(document.querySelector('#record-list')), toolsInColumn: ['search-input','library-filter-trigger','batch-organize','toggle-record-selection'].some(id => document.querySelector('#record-column').contains(document.getElementById(id))), collectionVisible: document.querySelector('.collection-toolbar').getClientRects().length > 0 }));
    check(returned.mode === 'home' && returned.selected === null && !returned.selection && returned.listHome && !returned.toolsInColumn && returned.collectionVisible, 'home-restores-collection-tools', { size, ...returned });
    await inspect('home restored ' + name); await capture('home-restored-' + name + '.png', '返回主页 · 网格工具恢复 / ' + name);
  }
  const calls = await page.evaluate(() => window.__uiAuditToolsCalls);
  check(!calls.some(call => /^(records:(delete|setTopics|organize|aiSearch)|topics:|semantic:)/u.test(call.method)), 'detail-tools-no-model-or-data-mutations', { methods: [...new Set(calls.map(call => call.method))] });
  await page.evaluate(() => { invoke = window.__uiAuditToolsInvoke; delete window.__uiAuditToolsInvoke; delete window.__uiAuditReleaseToolsBatch; });
}
async function auditImageZoom() {
  await page.locator('#record-detail .screenshot-thumbnail-button').click();
  const image = page.locator('.note-image-viewer[open] .note-image-canvas img');
  await image.waitFor({ state: 'visible' }); await finishMotion();
  const before = await image.evaluate(element => element.getBoundingClientRect().width);
  await page.locator('.note-image-viewer [data-action="zoom-in"]').click();
  const after = await image.evaluate(element => element.getBoundingClientRect().width);
  check(after > before, 'screenshot-discrete-zoom', { before, after });
  const wheel = await page.locator('.note-image-viewer .note-image-viewport').evaluate(viewport => {
    const image = document.querySelector('.note-image-viewer .note-image-canvas img'); const before = image.getBoundingClientRect().width;
    const rect = viewport.getBoundingClientRect(); viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, bubbles: true, cancelable: true }));
    return { before, after: image.getBoundingClientRect().width, animations: image.getAnimations().filter(animation => animation.playState !== 'finished').length };
  });
  check(wheel.after > wheel.before && wheel.animations === 0, 'screenshot-wheel-is-immediate', wheel);
  await page.locator('.note-image-viewer [data-action="zoom-out"]').click(); await page.waitForTimeout(40);
  const wheelInterrupt = await page.locator('.note-image-viewer .note-image-viewport').evaluate(viewport => {
    const image = document.querySelector('.note-image-viewer .note-image-canvas img'), before = image.getBoundingClientRect().width;
    const rect = viewport.getBoundingClientRect(); viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, bubbles: true, cancelable: true }));
    return { before, after: image.getBoundingClientRect().width, expected: before * Math.exp(.075), animations: image.getAnimations().filter(animation => animation.playState !== 'finished').length };
  });
  check(Math.abs(wheelInterrupt.after - wheelInterrupt.expected) <= 2 && wheelInterrupt.animations === 0, 'screenshot-wheel-continues-visible-size', wheelInterrupt);
  await page.locator('.note-image-viewer .note-image-viewport').evaluate(viewport => viewport.addEventListener('pointerdown', () => {
    const image = document.querySelector('.note-image-viewer .note-image-canvas img'); const before = image.getBoundingClientRect().width;
    queueMicrotask(() => { window.__uiAuditImagePan = { before, after: image.getBoundingClientRect().width }; });
  }, { capture: true, once: true }));
  await page.locator('.note-image-viewer [data-action="zoom-in"]').click(); const viewportBounds = await page.locator('.note-image-viewer .note-image-viewport').boundingBox();
  await page.mouse.move(viewportBounds.x + 50, viewportBounds.y + 50); await page.waitForTimeout(40); await page.mouse.down();
  const imagePan = await page.evaluate(() => window.__uiAuditImagePan); await page.mouse.move(viewportBounds.x + 70, viewportBounds.y + 60); await page.mouse.up();
  check(Math.abs(imagePan.before - imagePan.after) <= 1, 'screenshot-pan-start-keeps-visible-size', imagePan);
  await page.locator('.note-image-viewer [data-action="close"]').click(); await motionFrame('screenshot-dialog-exit-mid.png', '来源截图 · 收起中间帧');
  check(await image.count() === 0, 'screenshot-close-releases-source', {});
}
async function auditCloudZoom() {
  const svg = page.locator('#thought-cloud-root>svg');
  const before = await svg.evaluate(element => element.viewBox.baseVal.width);
  await page.locator('#cloud-zoom-in').click(); await page.waitForTimeout(45);
  const middle = await svg.evaluate(element => ({ width: element.viewBox.baseVal.width, marker: element.dataset.uiMotion || null }));
  await capture('cloud-zoom-mid.png', '灵感云 · 按钮放大中间帧', false, true, true);
  await page.waitForFunction(() => !document.querySelector('#thought-cloud-root>svg').dataset.uiMotion);
  const after = await svg.evaluate(element => element.viewBox.baseVal.width);
  measurements.push({ label: 'cloud discrete zoom', before, middle, after });
  check(middle.marker === 'graph-zoom' && before > middle.width && middle.width > after && after > 0, 'cloud-discrete-zoom-motion', { before, middle, after });
  const wheel = await svg.evaluate(element => {
    const before = element.viewBox.baseVal.width; element.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true, cancelable: true }));
    return { before, after: element.viewBox.baseVal.width, marker: element.dataset.uiMotion || null };
  });
  check(wheel.after < wheel.before && !wheel.marker, 'cloud-wheel-is-immediate', wheel);
  await page.locator('#cloud-zoom-in').click(); await page.waitForTimeout(40);
  const interrupted = await svg.evaluate(element => {
    const before = element.viewBox.baseVal.width; element.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true, cancelable: true }));
    return { before, after: element.viewBox.baseVal.width, expected: before / Math.exp(.075), marker: element.dataset.uiMotion || null };
  });
  check(Math.abs(interrupted.after - interrupted.expected) <= .01 && !interrupted.marker, 'cloud-wheel-continues-visible-view', interrupted);
  await svg.evaluate(element => element.addEventListener('pointerdown', () => {
    const before = element.getAttribute('viewBox'); queueMicrotask(() => { window.__uiAuditCloudPan = { before, after: element.getAttribute('viewBox') }; });
  }, { capture: true, once: true }));
  const bounds = await svg.boundingBox(); await page.mouse.move(bounds.x + 10, bounds.y + 10);
  await page.locator('#cloud-zoom-in').click(); await page.mouse.move(bounds.x + 10, bounds.y + 10); await page.waitForTimeout(40); await page.mouse.down();
  const pan = await page.evaluate(() => window.__uiAuditCloudPan); await page.mouse.move(bounds.x + 35, bounds.y + 20); await page.mouse.up();
  check(pan.before === pan.after, 'cloud-pan-start-keeps-visible-view', pan);
  await page.locator('#cloud-reset').click(); await page.waitForFunction(() => !document.querySelector('#thought-cloud-root>svg').dataset.uiMotion);
  await page.locator('#thought-cloud-root [data-cloud-id] .cloud-node-hit').first().click(); await motionFrame('cloud-selection-enter-mid.png', '灵感云 · 选择信息展开中间帧');
  await svg.evaluate(element => element.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await motionFrame('cloud-selection-exit-mid.png', '灵感云 · 选择信息收起中间帧');
  check(await page.locator('#cloud-selection').evaluate(element => element.classList.contains('hidden')), 'cloud-blank-click-restores-overview', {});
  await page.locator('#cloud-reset').click(); await page.waitForFunction(() => !document.querySelector('#thought-cloud-root>svg').dataset.uiMotion);
}
// Inspect the painted button border box as well as its icon/text. Crops use
// BrowserWindow.capturePage on this synthetic application window only.
function readButtonState(element) {
  const bounds = value => { const r=value.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,cx:(r.left+r.right)/2,cy:(r.top+r.bottom)/2}; };
  const style=getComputedStyle(element), textRects=[], walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node;
  while(node=walker.nextNode()){if(!node.textContent.trim()||node.parentElement.closest('.ui-action-icon,kbd,.nav-count'))continue;const range=document.createRange();range.selectNodeContents(node);for(const r of range.getClientRects())if(r.width&&r.height)textRects.push(r);}
  const text=textRects.length?{left:Math.min(...textRects.map(r=>r.left)),right:Math.max(...textRects.map(r=>r.right)),top:Math.min(...textRects.map(r=>r.top)),bottom:Math.max(...textRects.map(r=>r.bottom))}:null;
  const icons=[...element.querySelectorAll(':scope>.ui-action-icon')].map(bounds), content=text?[{...text,width:text.right-text.left,height:text.bottom-text.top},...icons]:icons;
  const union=content.length?{left:Math.min(...content.map(r=>r.left)),right:Math.max(...content.map(r=>r.right)),top:Math.min(...content.map(r=>r.top)),bottom:Math.max(...content.map(r=>r.bottom))}:null;
  const rect=bounds(element), parent=bounds(element.parentElement), header=document.querySelector('#record-column-header');
  const hit=document.elementFromPoint(rect.cx,rect.cy);
  return {id:element.id,tag:element.tagName,label:element.getAttribute('aria-label')||element.textContent.trim().replace(/\s+/gu,' ').slice(0,90),classes:element.className,icon:element.getAttribute('data-ui-icon'),rect,parent,text,content:union,background:style.backgroundColor,backgroundClip:style.backgroundClip,border:{top:style.borderTopWidth,right:style.borderRightWidth,bottom:style.borderBottomWidth,left:style.borderLeftWidth,color:style.borderColor},padding:{top:parseFloat(style.paddingTop),right:parseFloat(style.paddingRight),bottom:parseFloat(style.paddingBottom),left:parseFloat(style.paddingLeft)},align:style.alignItems,justify:style.justifyContent,textAlign:style.textAlign,outline:style.outlineStyle,focusMarker:style.backgroundImage.startsWith('linear-gradient')||style.textDecorationLine.includes('underline'),color:style.color,opacity:style.opacity,disabled:element.disabled===true||element.getAttribute('aria-disabled')==='true',hover:element.matches(':hover'),focusVisible:element.matches(':focus-visible'),pointerActive:element.matches(':active'),filter:style.filter,pressed:element.getAttribute('aria-pressed'),selected:element.getAttribute('aria-selected')||element.getAttribute('aria-checked'),expanded:element.getAttribute('aria-expanded'),active:element.classList.contains('active')||element.classList.contains('is-selected'),unobscured:hit===element||element.contains(hit),headerTop:header?.getBoundingClientRect().top??null,iconLayers:[...element.querySelectorAll('.ui-action-icon>span')].map(layer=>({className:layer.className,clipPath:getComputedStyle(layer).clipPath,transform:getComputedStyle(layer).transform}))};
}
async function captureButtonCrop(target,filename,overlay=false){
  const box=await target.boundingBox();if(!box)return;
  const image=await application.evaluate(async({BrowserWindow},{box,overlay})=>{const window=BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes(overlay?'/overlay/':'/renderer/'));const zoom=window.webContents.getZoomFactor(),bounds=window.getContentBounds();const x=Math.max(0,Math.floor((box.x-8)*zoom)),y=Math.max(0,Math.floor((box.y-8)*zoom)),right=Math.min(bounds.width,Math.ceil((box.x+box.width+8)*zoom)),bottom=Math.min(bounds.height,Math.ceil((box.y+box.height+8)*zoom));return(await window.capturePage({x,y,width:Math.max(1,right-x),height:Math.max(1,bottom-y)})).toPNG().toString('base64');},{box,overlay});
  fs.mkdirSync(path.join(output,'button-crops'),{recursive:true});fs.writeFileSync(path.join(output,'button-crops',filename),Buffer.from(image,'base64'));return 'button-crops/'+filename;
}
async function auditButtonScene(label,{surface=page,overlay=false,sample=true,only=null}={}){
  console.log('Button scene: '+label);
  if(!overlay)await finishMotion();else await surface.waitForTimeout(220);
  await surface.mouse.move(1,1);
  const inventory=await surface.evaluate(only=>{for(const element of document.querySelectorAll('[data-ui-audit-button]'))delete element.dataset.uiAuditButton;const seen=new Set(),scope=document.querySelector('.inmoment-popover:not([inert])')||[...document.querySelectorAll('dialog[open]')].at(-1)||document;return [...scope.querySelectorAll(only||'button,a[href],summary,[role="button"]')].filter(element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return element.matches("button,a[href],summary,[role=button]")&&element.namespaceURI==='http://www.w3.org/1999/xhtml'&&element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight+.5&&r.left>=0&&r.right<=innerWidth+.5&&s.visibility!=='hidden'&&!element.closest('.hidden,dialog:not([open]),.ui-motion-snapshot,[inert]')&&!element.classList.contains('group-sidebar-backdrop')&&element.getAttribute('aria-hidden')!=='true';}).map((element,index)=>{element.dataset.uiAuditButton=String(index);const family=element.id||[element.tagName,typeof element.className==='string'?element.className:'svg',element.getAttribute('data-action'),element.getAttribute('data-ui-icon')].join('|');const first=!seen.has(family);seen.add(family);return{token:String(index),family,first};});},only);
  const scene={label:'button states / '+label,viewport:await surface.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})),buttons:[],samples:[]};
  for(const item of inventory){const target=surface.locator('[data-ui-audit-button="'+item.token+'"]');const normal=await target.evaluate(readButtonState);scene.buttons.push(normal);
    check(normal.rect.height>=31&&normal.rect.width>=24,'button-hitframe-size',{scene:label,...normal});
    if(normal.icon&&!normal.text&&normal.content)check(Math.abs((normal.content.left+normal.content.right)/2-normal.rect.cx)<=1&&Math.abs((normal.content.top+normal.content.bottom)/2-normal.rect.cy)<=1,'icon-only-centered-in-background',{scene:label,...normal});
    if(normal.id==='back-to-group-home')check(normal.rect.top-(normal.headerTop??normal.parent.top)>=11.5,'back-background-top-clearance',{scene:label,...normal});
    if(normal.id==='toggle-record-selection'&&normal.text){check(Math.abs((normal.text.left+normal.text.right)/2-normal.rect.cx)<=1.5&&Math.abs((normal.text.top+normal.text.bottom)/2-normal.rect.cy)<=2,'selection-label-centered-in-background',{scene:label,...normal});check(!normal.icon,'selection-label-has-no-icon',{scene:label,...normal});}
    if(!sample||!item.first)continue;
    const key=label.replace(/[^a-z0-9-]/giu,'-')+'-'+item.token,states={normal:{...normal,image:await captureButtonCrop(target,key+'-default.png',overlay)}};
    if(!normal.disabled){
      await target.hover();await surface.waitForTimeout(200);states.hover={...await target.evaluate(readButtonState),image:await captureButtonCrop(target,key+'-hover.png',overlay)};
      if(normal.tag==='BUTTON'&&!String(normal.classes).includes('record-open')){await surface.mouse.down();await surface.waitForTimeout(30);states.down={...await target.evaluate(readButtonState),image:await captureButtonCrop(target,key+'-pressed.png',overlay)};await surface.mouse.move(1,1);await surface.mouse.up();await surface.evaluate(()=>getSelection()?.removeAllRanges());}
      await surface.mouse.move(1,1);await surface.evaluate(()=>document.addEventListener('keydown',event=>{event.preventDefault();event.stopImmediatePropagation();},{once:true,capture:true}));await surface.keyboard.press('Tab');await target.focus();await surface.waitForTimeout(200);states.focus={...await target.evaluate(readButtonState),image:await captureButtonCrop(target,key+'-focus.png',overlay)};
      check(states.focus.focusVisible&&states.focus.outline==='none'&&states.focus.focusMarker,'button-keyboard-focus-visible',{scene:label,id:normal.id,label:normal.label,focus:states.focus});
      for(const state of [states.hover,states.focus]){check(Math.abs(state.rect.width-normal.rect.width)<=1&&Math.abs(state.rect.height-normal.rect.height)<=1,'button-state-background-frame-stable',{scene:label,id:normal.id,normal:normal.rect,state:state.rect});if(normal.id==='toggle-record-selection'&&state.text)check(Math.abs((state.text.left+state.text.right)/2-state.rect.cx)<=1.5&&Math.abs((state.text.top+state.text.bottom)/2-state.rect.cy)<=2,'selection-state-label-centered',{scene:label,...state});}
      await target.evaluate(element=>element.blur());
    } else {
      await target.hover();await surface.waitForTimeout(200);states.hover={...await target.evaluate(readButtonState),image:await captureButtonCrop(target,key+'-disabled-hover.png',overlay)};
      check(states.hover.background===normal.background&&states.hover.color===normal.color&&JSON.stringify(states.hover.border)===JSON.stringify(normal.border)&&JSON.stringify(states.hover.iconLayers)===JSON.stringify(normal.iconLayers),'disabled-button-hover-static',{scene:label,id:normal.id,normal,hover:states.hover});
      await surface.mouse.move(1,1);
    }
    scene.samples.push({family:item.family,states});
  }
  measurements.push(scene);
  if(!overlay){const guide=await surface.evaluate(()=>{const guide=document.querySelector('#open-guide'),settings=document.querySelector('.rail-settings');const visible=[...document.querySelectorAll('#open-guide,#guide-button,[data-open-guide]')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height);return {count:visible.length,guide:guide?.getBoundingClientRect().toJSON(),settings:settings?.getBoundingClientRect().toJSON(),inRail:Boolean(guide?.closest('.icon-rail')),immediate:guide?.nextElementSibling===settings};});check(guide.count===1&&guide.inRail&&guide.immediate&&guide.guide.bottom<=guide.settings.top+1,'unique-help-above-settings',{scene:label,...guide});}
  await surface.evaluate(()=>{getSelection()?.removeAllRanges();document.activeElement?.blur?.();});await surface.mouse.move(1,1);await surface.waitForTimeout(200);await capture(label+'.png',label,overlay);return scene;
}
async function auditButtonStates(fixture){
  if(buttonStatesFinal){
    await resize({width:1440,height:900,zoom:1});await home();await openRecord(fixture.ids[0]);
    await auditButtonScene('final-summary',{only:'#record-detail summary'});
    await page.locator('#record-detail [data-disclosure="summary-evidence"]>summary').click();
    await auditButtonScene('final-summary-open',{only:'#record-detail [data-disclosure="summary-evidence"] summary,#record-detail .evidence'});
    await page.locator('#record-detail [data-disclosure="summary-evidence"]>summary').click();
    await resize({width:1024,height:768,zoom:1.5});await auditButtonScene('final-record-tools-narrow',{only:'#back-to-group-home,#toggle-record-selection'});
    await application.evaluate(({BrowserWindow})=>{const overlay=BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('/overlay/'));overlay.setSize(400,440);overlay.webContents.send('inmoment:event',{type:'session',session:{id:'ui-audit-overlay',state:'paused',mode:'manual',elapsedMs:23000,topicIds:[]}});overlay.showInactive();});
    const overlay=application.windows().find(item=>item.url().includes('/overlay/'));await overlay.waitForFunction(()=>document.body.dataset.mode==='card');await auditButtonScene('final-recording-paused',{surface:overlay,overlay:true,only:'#discard,#continue,#finish,#draft-topics-label'});
    await resize({width:1440,height:900,zoom:1});await page.locator('#open-guide').click();await auditButtonScene('final-guide');await page.locator('#guide-done').click();await finishMotion();
    await auditButtonScene('final-navigation-focus',{only:'.primary-group-item,.record-actions-toggle'});
    await page.locator('#record-list .record-actions-toggle').first().click();await page.locator('.context-menu [data-menu-id="group"]').click();await auditButtonScene('final-picker-focus');await page.keyboard.press('Escape');await finishMotion();
    const batchRecords=await page.evaluate(ids=>Promise.all(ids.map(id=>window.inmoment.invoke('records:get',{id}))),fixture.ids.slice(0,20));await page.evaluate(records=>{state.batchResultItems=records.map(record=>({id:record.id,title:record.title,version:record.version,record,status:'success',topicSuggestions:['阅读与思考']}));initializeBatchChoices();renderBatchResults();document.querySelector('#batch-results-dialog').showModal();},batchRecords);await auditButtonScene('final-batch-menu-center',{only:'.batch-result-menu'});await page.locator('#close-batch-results').click();await finishMotion();
    await page.evaluate(ids=>{const graph={nodes:ids.slice(0,12).map((id,index)=>({id,title:'合成灵感 '+(index+1)})),edges:Array.from({length:9},(_,index)=>({source:ids[Math.floor(index/3)*4+index%3],target:ids[Math.floor(index/3)*4+index%3+1],weight:.9})),communities:Array.from({length:3},(_,index)=>({id:'qa-cloud-'+index,members:ids.slice(index*4,index*4+4),isolated:false})),coverage:{totalCount:49,displayedCount:12,hasMore:true}};window.InMomentCloud.show=()=>window.InMomentCloud.render(graph);},fixture.ids);await page.locator('[data-view="duplicates"]').click();await auditButtonScene('final-cloud');await page.locator('[data-cloud-id="'+fixture.ids[0]+'"] .cloud-node-hit').click();await auditButtonScene('final-cloud-selected');
    await page.locator('[data-cloud-id="'+fixture.ids[0]+'"] .cloud-node-hit').hover();await capture('final-cloud-node-hover.png','云节点：真实圆形触发区');await page.keyboard.press('Tab');await page.locator('[data-cloud-id="'+fixture.ids[0]+'"]').focus();await capture('final-cloud-node-focus.png','云节点：键盘圆形焦点');
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('/overlay/')).webContents.send('inmoment:event',{type:'session',session:{id:'ui-audit-overlay',state:'processing',mode:'manual',elapsedMs:23000,topicIds:[]}}));await auditButtonScene('final-recording-processing',{surface:overlay,overlay:true});
    writeButtonStateGallery();return;
  }
  const sizes=[{width:1440,height:900,zoom:1},{width:800,height:720,zoom:1},{width:1440,height:900,zoom:1.25},{width:1024,height:768,zoom:1.5}];
  for(const size of sizes){const name=size.width+'-'+size.zoom;await resize(size);await home();await auditButtonScene('home-'+name,{sample:size===sizes[0]});await openRecord(fixture.ids[0]);await page.locator('#back-to-group-home').hover();await page.waitForTimeout(200);await capture('back-hover-'+name+'.png','返回按钮悬停背景 / '+name);await page.locator('#toggle-record-selection').hover();await page.waitForTimeout(200);await capture('selection-hover-'+name+'.png','选择文字悬停背景 / '+name);await auditButtonScene('detail-default-'+name,{sample:size===sizes[0]});await page.locator('#toggle-record-selection').click();await auditButtonScene('detail-empty-selection-'+name,{sample:size===sizes[0]});await page.locator('#select-visible-records').click();await auditButtonScene('detail-selected-'+name,{sample:size===sizes[0]});await page.locator('#toggle-record-selection').click();
    await page.locator('#back-to-group-home').hover();await page.waitForTimeout(200);await capture('back-hover-'+name+'.png','返回按钮悬停背景 / '+name);await page.locator('#toggle-record-selection').hover();await page.waitForTimeout(200);await capture('selection-hover-'+name+'.png','选择文字悬停背景 / '+name);
  }
  await resize(sizes[0]);await home();await openRecord(fixture.ids[0]);
  await page.locator('#record-detail [data-action="show-original"]').click();await auditButtonScene('original-text');
  await page.locator('#record-detail .audio-mute-button').first().click();await auditButtonScene('audio-muted');await page.locator('#record-detail .audio-mute-button').first().click();
  await page.locator('#record-detail .audio-speed-trigger').first().click();await auditButtonScene('audio-speed-menu');await page.keyboard.press('Escape');await finishMotion();
  await page.locator('#more-topic-suggestions').click();await auditButtonScene('suggestion-picker');await page.keyboard.press('Escape');await finishMotion();
  await page.locator('#record-detail [data-action="rename-record"]').click();await auditButtonScene('title-edit');await page.getByRole('button',{name:'取消重命名',exact:true}).click();
  await page.locator('#record-detail .record-screenshot-section').scrollIntoViewIfNeeded();await auditButtonScene('source-actions');
  const imageButton=page.locator('#record-detail .screenshot-thumbnail-button').first();if(await imageButton.count()){await imageButton.click();await auditButtonScene('screenshot-viewer');await page.locator('.note-image-viewer [data-action="close"]').click();}
  await home();await page.locator('#library-filter-trigger').click();await auditButtonScene('filter-popup');await page.locator('[data-filter-range="custom"]').click();await auditButtonScene('filter-custom-selected');await page.locator('#filter-popup-ai').click();await auditButtonScene('ai-search-dialog');await page.locator('#close-ai-search').click();
  await page.locator('#record-list .record-actions-toggle').first().click();await auditButtonScene('record-menu');await page.locator('.context-menu [data-menu-id="group"]').click();await auditButtonScene('record-group-picker');await page.keyboard.press('Escape');await finishMotion();
  await page.locator('#record-list .record-actions-toggle').first().click();await page.locator('.context-menu [data-menu-id="delete"]').click();await auditButtonScene('delete-confirmation');await page.locator('.confirm-popover [data-confirm-action="cancel"]').click();await finishMotion();
  await page.locator('#open-primary-group-manager').click();await auditButtonScene('group-manager');await page.locator('#merge-topic-groups').click();await auditButtonScene('group-manager-empty-selection');await page.locator('[data-topic-select-id="'+fixture.topics[1].id+'"]').check();await auditButtonScene('group-manager-selected');await page.locator('#cancel-topic-selection').click();await page.locator('#close-group-management').click();await finishMotion();
  const records=await page.evaluate(ids=>Promise.all(ids.map(id=>window.inmoment.invoke('records:get',{id}))),fixture.ids.slice(0,20));await page.evaluate(records=>{const names=['阅读与思考','产品设计','日常生活'];state.batchResultItems=records.map((record,index)=>({id:record.id,title:record.title,version:record.version,record,status:'success',topicSuggestions:[names[index%3]]}));initializeBatchChoices();renderBatchResults();document.querySelector('#batch-results-status').textContent='合成整理结果 · 20 条 / 3 个分组';document.querySelector('#batch-results-dialog').showModal();},records);await auditButtonScene('batch-results');await page.locator('.batch-result-menu').first().click();await auditButtonScene('batch-adjust-menu');await page.keyboard.press('Escape');await finishMotion();await page.locator('#close-batch-results').click();
  await page.locator('[data-view="settings"]').click();await page.locator('#settings-nav-ai').click();await finishMotion();await page.locator('#api-key').scrollIntoViewIfNeeded();await auditButtonScene('settings');await page.locator('#ai-provider-trigger').click();await auditButtonScene('provider-menu');await page.keyboard.press('Escape');await finishMotion();await page.locator('.manual-model-details>summary').click();await page.locator('#model-manual-enabled').check();await page.locator('#ai-model-presets').click();await auditButtonScene('model-menu');await page.keyboard.press('Escape');await finishMotion();
  await page.locator('.settings-actions').scrollIntoViewIfNeeded();await auditButtonScene('settings-bottom');await page.locator('#settings-nav-capture').click();await finishMotion();await page.locator('.timing-card>summary').click();await auditButtonScene('settings-advanced');await page.locator('.timing-card>summary').click();await page.locator('#open-guide').click();await auditButtonScene('guide');await page.locator('#guide-done').click();await finishMotion();
  await page.evaluate(ids=>{const graph={nodes:ids.slice(0,12).map((id,index)=>({id,title:'合成灵感 '+(index+1)})),edges:Array.from({length:9},(_,index)=>({source:ids[Math.floor(index/3)*4+index%3],target:ids[Math.floor(index/3)*4+index%3+1],weight:.9})),communities:Array.from({length:3},(_,index)=>({id:'qa-cloud-'+index,members:ids.slice(index*4,index*4+4),isolated:false})),coverage:{totalCount:49,displayedCount:12,hasMore:true}};window.InMomentCloud.show=()=>window.InMomentCloud.render(graph);},fixture.ids);await page.locator('[data-view="duplicates"]').click();await auditButtonScene('inspiration-cloud');await page.locator('[data-cloud-id="'+fixture.ids[0]+'"] .cloud-node-hit').click();await auditButtonScene('cloud-selected');
  await application.evaluate(({BrowserWindow})=>{const overlay=BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('/overlay/'));overlay.setSize(400,440);overlay.webContents.send('inmoment:event',{type:'session',session:{id:'ui-audit-overlay',state:'paused',mode:'manual',elapsedMs:23000,topicIds:[]}});overlay.showInactive();});const overlay=application.windows().find(item=>item.url().includes('/overlay/'));await overlay.waitForFunction(()=>document.body.dataset.mode==='card');await auditButtonScene('recording-paused',{surface:overlay,overlay:true});
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('/overlay/')).webContents.send('inmoment:event',{type:'session',session:{id:'ui-audit-overlay',state:'processing',mode:'manual',elapsedMs:23000,topicIds:[]}}));await auditButtonScene('recording-processing',{surface:overlay,overlay:true});
  writeButtonStateGallery();
}
function writeButtonStateGallery(){
  const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');const scenes=measurements.filter(item=>item.samples);fs.writeFileSync(path.join(output,'button-states.html'),'<!doctype html><meta charset="utf-8"><title>按钮状态对照</title><style>body{font:14px/1.6 Segoe UI,Microsoft YaHei,sans-serif;padding:24px;color:#171a1d}table{border-collapse:collapse;margin-bottom:32px}th,td{border:1px solid #dee2e6;padding:10px;max-width:380px}img{max-width:340px;height:auto;display:block}h2{margin-top:36px}</style><h1>实际按钮状态对照</h1><p>每张图包含真实按钮背景与周边 8 CSS px；截图来自隔离测试窗口。默认列也保留实际选中、按下或不可用状态。</p>'+scenes.map(scene=>'<h2>'+escape(scene.label)+'</h2><table><tr><th>控件</th><th>默认 / 当前状态</th><th>悬停</th><th>按下</th><th>键盘焦点</th></tr>'+scene.samples.map(sample=>'<tr><th>'+escape(sample.states.normal.label||sample.family)+(sample.states.normal.disabled?'（不可用）':'')+'</th>'+['normal','hover','down','focus'].map(state=>'<td>'+(sample.states[state]?.image?'<img src="'+sample.states[state].image+'">':'—')+'</td>').join('')+'</tr>').join('')+'</table>').join(''));
}
function writeReport() {
  const scope = backgroundOnly ? 'background' : buttonStatesOnly ? 'button-states' : visualPolishOnly ? 'visual-polish' : detailToolsOnly ? 'detail-tools' : 'full';
  const report = { scope, executableReceipt, elapsedMs:Date.now()-auditStarted, syntheticOnly: true, realAPICalls: 0, modelRuns: 0, microphoneActivations: 0, desktopCaptures: 0, dataDir, records: 49, groups: 8, findings, measurements, screenshots, rendererErrors: errors };
  fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify(report, null, 2));
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>InMoment UI 检查</title><style>body{max-width:1440px;margin:40px auto;padding:0 24px;font:15px/1.7 "Segoe UI","Microsoft YaHei",sans-serif;color:#171a1d;background:#fff}h1{font-size:28px}h2{font-size:18px;margin:32px 0 12px}img{display:block;width:100%;height:auto;border:1px solid #e4e7eb;border-radius:12px}a{color:#246a3e}p{color:#606870}</style><h1>InMoment UI 检查</h1><p>49 条合成灵感、8 个分组。检查结果：' + findings.length + ' 项待修正。录音、文字与截图均为测试素材。</p><p><a href="audit.json">查看测量结果</a></p>' + screenshots.map(item => '<section><h2>' + escape(item.title) + '</h2><a href="' + item.filename + '"><img src="' + item.filename + '" alt="' + escape(item.title) + '" loading="lazy"></a></section>').join('') + '</html>';
  fs.writeFileSync(path.join(output, 'index.html'), html);
}
async function auditBackground(fixture, sizes) {
  await openRecord(fixture.ids[0]);
  const detail = page.locator('#record-detail');
  const background = detail.locator('[data-disclosure="context"]');
  const section = detail.locator('.record-screenshot-section').filter({ has: page.getByRole('heading', { name: '选区截图', exact: true }) });
  check(await background.locator('h3').innerText() === '背景信息', 'background-heading', {});
  check(await background.locator('.detail-context').innerText() === 'SyntheticReader · 阅读与思考 · 界面验证资料', 'background-source-metadata', {});
  check(await detail.locator('.screenshot-thumbnail-button').count() === 2, 'independent-screenshot-groups', {});
  for (const size of sizes) {
    await resize(size);
    await background.locator('.background-url').scrollIntoViewIfNeeded();
    const geometry = await background.evaluate(element => {
      const rect = target => target.getBoundingClientRect().toJSON();
      const link = element.querySelector('.background-url');
      const label = link.querySelector('.background-url-text');
      return { section: rect(element), heading: rect(element.querySelector('h3')), source: rect(element.querySelector('.detail-context')), link: rect(link), label: rect(label), labelLineHeight: parseFloat(getComputedStyle(label).lineHeight), tooltipComplete: label.textContent === link.title, viewport: { width: innerWidth, height: innerHeight } };
    });
    measurements.push({ label: 'background groups', size, ...geometry });
    check(geometry.label.right <= geometry.link.right + 1 && geometry.link.left >= geometry.section.left - 1 && geometry.link.right <= geometry.section.right + 1 && geometry.label.height <= geometry.labelLineHeight * 2 + 1 && geometry.tooltipComplete, 'background-link-wrap', { size, ...geometry });
    check(Math.abs(geometry.heading.left - geometry.source.left) <= 1 && Math.abs(geometry.heading.left - geometry.link.left) <= 1, 'background-shared-left-edge', { size, ...geometry });
    const suffix = `${size.width}-${size.zoom}`;
    await capture(`background-${suffix}.png`, `背景信息 · ${size.width}px / ${size.zoom * 100}%`);
    await captureGuides(`background-guides-${suffix}.png`, '背景信息 · 起线与控件中心', { column: geometry.section, heading: geometry.heading, master: { cx: geometry.link.left }, rows: [], iconText: [{ button: geometry.link, iconBox: { cy: (geometry.link.top + geometry.link.bottom) / 2 } }] });
  }
  const screenshots = [];
  for (const [group, title] of [[section, '选区截图'], [background, '来源窗口截图']]) {
    const thumbnail = group.locator('.screenshot-thumbnail-button');
    await thumbnail.click();
    await page.waitForFunction(() => document.querySelector('.note-image-viewer .note-image-canvas img').naturalWidth === 960);
    check(await page.locator('#screenshot-viewer-title').innerText() === title, 'screenshot-viewer-role', { title });
    screenshots.push(await page.locator('.note-image-viewer .note-image-canvas img').getAttribute('src'));
    await page.locator('.note-image-viewer [data-action="close"]').click();
    await finishMotion();
    check(await thumbnail.evaluate(element => document.activeElement === element), 'screenshot-viewer-returns-focus', { title });
  }
  check(new Set(screenshots).size === 2, 'screenshot-viewer-resolves-selected-attachment', {});
}

(async () => {
  const fixture = seed();
  const originalHashes = attachmentHashes();
  const settingsText = JSON.stringify({ inputEnabled: false, captureScreenshots: false, cloudEnabled: false, autoTitleEnabled: false, aiSearchEnabled: false, duplicateAnalysisEnabled: false, keyboardTrigger: 'none', apiKeyEncrypted: '' }, null, 2);
  const settingsPath = path.join(dataDir, 'settings.json'); fs.writeFileSync(settingsPath, settingsText);
  const env = { ...process.env, INMOMENT_DATA_DIR: dataDir, INMOMENT_ASR_DIR: path.join(dataDir, 'disabled-asr'), INMOMENT_DISABLE_NETWORK: '1', INMOMENT_SMOKE: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const packagedExecutable = process.env.INMOMENT_SMOKE_EXECUTABLE ? path.resolve(process.env.INMOMENT_SMOKE_EXECUTABLE) : null;
  if (packagedExecutable && (!packagedExecutable.startsWith(path.join(root, 'dist') + path.sep) || path.basename(packagedExecutable) !== 'InMoment.exe' || !fs.statSync(packagedExecutable).isFile())) throw new Error('Packaged UI audit executable must be the verified InMoment.exe inside this workspace dist.');
  const executablePath = packagedExecutable || require('electron');
  executableReceipt = { executablePath, packaged: Boolean(packagedExecutable), launchArgs: packagedExecutable ? [] : [root] };
  application = await _electron.launch({ executablePath, args: executableReceipt.launchArgs, cwd: root, env, timeout: 30000 });
  await application.firstWindow();
  page = application.windows().find(item => item.url().includes('/renderer/')) || await application.waitForEvent('window', { predicate: item => item.url().includes('/renderer/') });
  page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack, after: measurements.at(-1)?.label || null }));
  await page.route(/^https?:\/\//u, route => { errors.push('Unexpected external request: ' + route.request().url()); route.abort(); });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/renderer/')).show());
  await page.locator('[data-record-open-id="' + fixture.ids[0] + '"]').waitFor();
  const boot = await page.evaluate(() => window.inmoment.invoke('app:bootstrap')); assert.equal(boot.settings.networkDisabled, true); assert.equal(boot.recordCount, 49);
  executableReceipt.version = boot.version;
  const sizes = [{ width: 1440, height: 900, zoom: 1 }, { width: 1280, height: 800, zoom: 1 }, { width: 1024, height: 768, zoom: 1 }, { width: 800, height: 720, zoom: 1 }, { width: 1440, height: 900, zoom: 1.25 }, { width: 1440, height: 900, zoom: 1.5 }];
  if (backgroundOnly) {
    await auditBackground(fixture, sizes);
  } else if (buttonStatesOnly) {
    await auditButtonStates(fixture);
  } else if (visualPolishOnly) {
    await auditVisualPolish(fixture);
  } else if (detailToolsOnly) {
    await auditDetailTools(fixture);
  } else {
  await auditTitlebar('normal'); await auditTitlebar('maximized'); await resize(sizes[0]);
  await iconCatalog(); await auditIconMotion(); await auditDatePopover(); await auditMotionFlows(fixture);
  for (const size of sizes) {
    await resize(size); await home(); await inspect('grid ' + JSON.stringify(size)); await capture('grid-' + size.width + '-' + size.zoom + '.png', '分组主页 ' + size.width + ' × ' + size.height + ' / ' + size.zoom * 100 + '%');
    await openRecord(fixture.ids[0]);
    const structure = await page.locator('#record-detail').evaluate(detail => ({ voiceCards: detail.querySelectorAll('.voice-note').length, audioInVoice: detail.querySelectorAll('.voice-note .audio-segment').length, textInVoice: Boolean(detail.querySelector('.voice-note .record-text-panel')), screenshotAfterVoice: Boolean(detail.querySelector('.record-screenshot-section') && (detail.querySelector('.voice-note')?.compareDocumentPosition(detail.querySelector('.record-screenshot-section')) & Node.DOCUMENT_POSITION_FOLLOWING)) }));
    check(structure.voiceCards === 1 && structure.audioInVoice === 2 && structure.textInVoice, 'voice-and-transcript-together', { size, ...structure });
    await inspect('detail ' + JSON.stringify(size)); await capture('detail-' + size.width + '-' + size.zoom + '.png', '录音与文字 ' + size.width + ' × ' + size.height + ' / ' + size.zoom * 100 + '%');
    const rows = await page.locator('#record-column .record-card h3').evaluateAll(items => items.map(item => ({ whiteSpace: getComputedStyle(item).whiteSpace, height: item.getBoundingClientRect().height, line: parseFloat(getComputedStyle(item).lineHeight) })));
    check(rows.every(item => item.whiteSpace === 'nowrap' && item.height <= item.line + 1), 'list-title-single-line', { size, rows });
  }
  await resize(sizes[0]);
  await home(); await page.locator('[data-library-group-id="' + fixture.topics[0].id + '"]').click();
  while (await page.locator('#load-more').isVisible()) { const before = await page.locator('#record-list .record-card').count(); await page.locator('#load-more').click(); await page.waitForFunction(count => document.querySelectorAll('#record-list .record-card').length > count, before); }
  check(await page.locator('#record-list .record-card').count() >= 30, 'large-group-record-count', {});
  await inspect('large group grid'); await capture('large-group-grid.png', '多记录分组 · 网格浏览');
  await openRecord(fixture.ids[2]); await inspect('large group detail'); await capture('large-group-list.png', '多记录分组 · 列表与详情');
  const compactRows = await page.locator('#record-column .record-card').evaluateAll(items => items.map(element => element.getBoundingClientRect().height));
  check(compactRows.every(height => height >= 44), 'record-rows-do-not-shrink', { count: compactRows.length, minHeight: Math.min(...compactRows) });
  await home(); await page.locator('[data-library-group-id="uncategorized"]').click(); await openRecord(fixture.ids[0]);
  await auditSuggestionPopover();
  await page.locator('#record-detail [data-action="show-original"]').click();
  const textBefore = await page.locator('#record-detail .text-panel-original').innerText();
  check(textBefore.includes('第二段补充'), 'all-transcript-segments', { hasSecondSegment: textBefore.includes('第二段补充') });
  await capture('detail-original-text.png', '原始语音文本 · 多段与长文');
  const play = page.locator('#record-detail .audio-play-button').first();
  if (await play.count()) {
    await play.click();
    await page.waitForFunction(() => { const audio = document.querySelector('#record-detail audio'); return audio && !audio.paused && audio.currentTime > 0; }, null, { timeout: 3000 });
    const playing = await page.locator('#record-detail audio').first().evaluate(audio => ({ paused: audio.paused, time: audio.currentTime, ready: audio.readyState }));
    check(!playing.paused && playing.time > 0, 'audio-play', playing);
    await play.click();
    const speed = page.locator('#record-detail .audio-speed-trigger').first(); await speed.click(); await page.locator('.select-popover').waitFor({ state: 'visible' }); await motionFrame('speed-enter-mid.png', '播放倍速 · 展开中间帧');
    await inspect('playback speed popover'); await capture('playback-speed-popover.png', '录音倍速 · 统一选择浮框');
    await speed.click(); await motionFrame('speed-exit-mid.png', '播放倍速 · 收起中间帧'); await page.locator('.select-popover').waitFor({ state: 'detached' });
    check(await speed.getAttribute('aria-expanded') === 'false', 'speed-trigger-toggle-closes', {});
    await speed.click(); await page.locator('.select-popover [data-menu-id="1.5"]').click(); await page.locator('.select-popover').waitFor({ state: 'detached' });
    check(await page.locator('#record-detail audio').first().evaluate(audio => audio.playbackRate) === 1.5, 'audio-speed', {});
    const slider = page.locator('#record-detail .audio-progress').first();
    await slider.evaluate(element => { element.value = Number(element.max) / 2; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); });
    check(await page.locator('#record-detail audio').first().evaluate(audio => audio.currentTime) > 0, 'audio-seek', {});
  } else check(false, 'audio-controls-present', {});
  await page.locator('#record-detail [data-action="show-summary"]').click();
  await page.locator('#record-detail .record-screenshot-section').scrollIntoViewIfNeeded(); await capture('detail-context.png', '来源截图 · 独立材料区');
  await auditImageZoom();
  await home(); await openRecord('ui-audit-text-only'); await inspect('text-only record');
  check(await page.locator('#record-detail .audio-segment').count() === 0, 'text-only-no-empty-player', {}); await capture('detail-text-only.png', '文字记录 · 无空录音区');
  await home();
  await page.locator('#record-list .record-actions-toggle').first().click(); await page.locator('.context-menu').waitFor({ state: 'visible' }); await motionFrame('record-menu-enter-mid.png', '记录操作菜单 · 展开中间帧'); await inspect('record menu'); await capture('record-menu.png', '记录操作 · 小浮框');
  await page.locator('.context-menu [data-menu-id="delete"]').click(); await motionFrame('record-menu-exit-mid.png', '记录操作菜单 · 收起中间帧'); await page.locator('.confirm-popover').waitFor({ state: 'visible' }); await motionFrame('confirm-enter-mid.png', '删除确认 · 展开中间帧'); await inspect('delete confirmation'); await capture('delete-confirmation.png', '删除确认 · 红色危险操作');
  await page.locator('.confirm-popover [data-confirm-action="cancel"]').click(); await motionFrame('confirm-exit-mid.png', '删除确认 · 收起中间帧'); await page.locator('.confirm-popover').waitFor({ state: 'detached' });
  await page.locator('#open-primary-group-manager').click(); await motionFrame('group-dialog-enter-mid.png', '分组管理 · 展开中间帧'); await inspect('group manager'); await capture('groups.png', '管理分组');
  await page.locator('#delete-topic-groups').click(); await motionFrame('group-selection-enter-mid.png', '分组多选 · 展开中间帧'); await page.locator('[data-topic-select-id="' + fixture.topics[1].id + '"]').check(); await inspect('group multi delete'); await capture('groups-selection.png', '分组多选 · 删除');
  await page.locator('#cancel-topic-selection').click(); await motionFrame('group-selection-exit-mid.png', '分组多选 · 收起中间帧'); await finishMotion(); await page.locator('#close-group-management').click(); await motionFrame('group-dialog-exit-mid.png', '分组管理 · 收起中间帧');
  await page.locator('#open-primary-group-manager').click(); await page.evaluate(() => { const dialog = document.querySelector('#group-management-dialog'); dialog.close(); dialog.showModal(); }); await finishMotion();
  const dialogRace = await page.evaluate(() => ({ open: document.querySelector('#group-management-dialog').open, ghosts: document.querySelectorAll('.ui-motion-snapshot,.ui-motion-scrim').length, focusHidden: Boolean(document.activeElement?.closest('.hidden')) }));
  check(dialogRace.open && dialogRace.ghosts === 0 && !dialogRace.focusHidden, 'dialog-rapid-reopen-cleans-ghosts', dialogRace); await page.locator('#close-group-management').click(); await finishMotion();
  const batchRecords = await page.evaluate(ids => Promise.all(ids.map(id => window.inmoment.invoke('records:get', { id }))), fixture.ids.slice(0, 20));
  await page.evaluate(records => {
    const destinations = ['阅读与思考', '产品设计', '日常生活'];
    state.batchResultItems = records.map((record, index) => ({ id: record.id, title: record.title, version: record.version, record, status: 'success', topicSuggestions: [destinations[index % destinations.length]] }));
    initializeBatchChoices(); renderBatchResults(); document.querySelector('#batch-results-status').textContent = '本次 20 条，按 3 个分组检查建议。'; document.querySelector('#batch-results-dialog').showModal();
  }, batchRecords);
  await motionFrame('batch-dialog-enter-mid.png', '整理结果 · 展开中间帧');
  for (const size of [sizes[0], sizes[3], sizes[5]]) {
    await resize(size); await inspect('grouped batch ' + JSON.stringify(size));
    const batchLayout = await page.locator('#batch-results-dialog').evaluate(dialog => {
      const list = dialog.querySelector('#batch-results-list'), footer = dialog.querySelector('.dialog-form-actions'), bounds = dialog.getBoundingClientRect(), footerBounds = footer.getBoundingClientRect();
      return { groups: list.querySelectorAll('.batch-result-group').length, rows: list.querySelectorAll('.batch-result-item').length, listHeight: list.clientHeight, listScrollHeight: list.scrollHeight, footerBottom: footerBounds.bottom, dialogBottom: bounds.bottom, viewportHeight: innerHeight, rowText: [...list.querySelectorAll('.batch-result-heading,.batch-summary')].map(element => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight), nowrap: getComputedStyle(element).whiteSpace === 'nowrap' })) };
    });
    check(batchLayout.groups === 3 && batchLayout.rows === 20 && batchLayout.listHeight >= 58 && batchLayout.footerBottom <= batchLayout.viewportHeight + 1 && batchLayout.footerBottom <= batchLayout.dialogBottom + 1 && batchLayout.rowText.every(item => item.nowrap && item.height <= item.line + 1), 'batch-groups-remain-readable', { size, ...batchLayout });
    await capture('batch-' + size.width + '-' + size.zoom + '.png', '整理结果 · 20 条灵感与 3 个分组 / ' + size.zoom * 100 + '%');
  }
  await page.locator('#close-batch-results').click(); await motionFrame('batch-dialog-exit-mid.png', '整理结果 · 收起中间帧'); await resize(sizes[0]);
  await page.locator('#library-filter-trigger').click(); await page.locator('.library-filter-popover').waitFor({ state: 'visible' }); await finishMotion(); await page.locator('#filter-popup-ai').click(); await page.locator('#ai-search-dialog').waitFor({ state: 'visible' }); await motionFrame('ai-dialog-enter-mid.png', 'AI 查找描述 · 展开中间帧'); await inspect('AI search'); await capture('ai-search.png', 'AI 查找 · 输入界面'); await page.locator('#close-ai-search').click(); await motionFrame('ai-dialog-exit-mid.png', 'AI 查找描述 · 收起中间帧');
  await page.locator('[data-view="drafts"]').click(); await motionFrame('draft-view-mid.png', '切换未保存记录 · 中间帧'); await page.locator('.draft-open').click(); await settle();
  await inspect('draft preview'); await capture('draft-preview.png', '未保存记录 · 草稿预览');
  await page.evaluate(ids => {
    const graph = { nodes: ids.slice(0, 12).map((id, index) => ({ id, title: ['阅读时留下联想', '日常生活中的想法', '改善记录体验'][Math.floor(index / 4)] + ' ' + (index % 4 + 1) })), edges: Array.from({ length: 9 }, (_, index) => ({ source: ids[Math.floor(index / 3) * 4 + index % 3], target: ids[Math.floor(index / 3) * 4 + index % 3 + 1], weight: .9 })), communities: Array.from({ length: 3 }, (_, index) => ({ id: 'ui-audit-cloud-' + index, members: ids.slice(index * 4, index * 4 + 4), isolated: false })), coverage: { totalCount: 49, displayedCount: 12, hasMore: true } };
    // UI-only fixture: the production show() would start local semantic indexing.
    // Replace it inside this isolated renderer so no model is ever invoked.
    window.InMomentCloud.show = () => window.InMomentCloud.render(graph);
  }, fixture.ids);
  await page.locator('[data-view="duplicates"]').click(); await settle();
  check(await page.locator('#thought-cloud-root [data-cloud-id]').count() === 12, 'synthetic-cloud-nodes', {});
  await auditCloudZoom();
  await inspect('synthetic inspiration cloud'); await capture('inspiration-cloud.png', '灵感云 · 合成节点与连线');
  await page.locator('[data-view="settings"]').click(); await motionFrame('settings-view-mid.png', '切换设置 · 中间帧'); await inspect('settings'); await capture('settings.png', '设置 · 统一表单与间距');
  await page.locator('.timing-card>summary').click(); await motionFrame('settings-details-enter-mid.png', '高级设置 · 展开中间帧'); await page.locator('.timing-card>summary').click(); await motionFrame('settings-details-exit-mid.png', '高级设置 · 收起中间帧');
  for (const size of [sizes[3], sizes[5]]) { await resize(size); await inspect('settings ' + JSON.stringify(size)); await capture('settings-' + size.width + '-' + size.zoom + '.png', '设置 ' + size.width + ' / ' + size.zoom * 100 + '%'); }
  await resize(sizes[0]);
  await application.evaluate(({ BrowserWindow }) => { const overlay = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/overlay/')); overlay.setSize(400, 440); overlay.webContents.send('inmoment:event', { type: 'session', session: { id: 'ui-audit-overlay', state: 'paused', mode: 'manual', elapsedMs: 23000, topicIds: [] } }); overlay.showInactive(); });
  const overlay = application.windows().find(item => item.url().includes('/overlay/'));
  await overlay.waitForFunction(() => document.body.dataset.mode === 'card');
  await overlay.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  const overlayChecks = await overlay.evaluate(() => {
    const bounds = element => { const rect = element.getBoundingClientRect(); return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }; };
    const panel = document.querySelector('.capture-panel'), content = document.querySelector('.card-content');
    return { panel: bounds(panel), content: bounds(content), contentOpacity: Number(getComputedStyle(content).opacity), panelOpacity: Number(getComputedStyle(panel).opacity), viewport: { width: innerWidth, height: innerHeight }, controls: [...document.querySelectorAll('#actions button')].filter(element => !element.classList.contains('hidden')).map(element => ({ id: element.id, ...bounds(element), color: getComputedStyle(element).color })) };
  });
  measurements.push({ label: 'paused recording overlay', ...overlayChecks });
  check(overlayChecks.controls.length === 3 && overlayChecks.contentOpacity === 1 && overlayChecks.panelOpacity === 1 && overlayChecks.controls.every(item => item.height >= 32 && item.right <= overlayChecks.viewport.width && item.bottom <= overlayChecks.viewport.height && item.bottom <= overlayChecks.panel.bottom && item.top >= overlayChecks.panel.top), 'overlay-targets-fit', overlayChecks);
  await capture('recording-overlay.png', '录音浮层 · 合成暂停状态', true);
  }
  const finalLibrary = await page.evaluate(() => window.inmoment.invoke('app:bootstrap'));
  const libraryInvariant = { label: 'synthetic library preserved', records: finalLibrary.recordCount, topics: finalLibrary.topics.map(topic => ({ id: topic.id, name: topic.name })), drafts: finalLibrary.drafts.length, settingsUnchanged: fs.readFileSync(settingsPath, 'utf8') === settingsText, sourceAttachments: Object.keys(originalHashes).length };
  measurements.push(libraryInvariant);
  check(libraryInvariant.records === 49 && libraryInvariant.drafts === 1 && JSON.stringify(libraryInvariant.topics.map(topic => topic.id).sort()) === JSON.stringify(fixture.topics.map(topic => topic.id).sort()), 'synthetic-library-preserved', libraryInvariant);
  assert.deepEqual(attachmentHashes(), originalHashes, 'UI audit preserves all synthetic source attachments.');
  libraryInvariant.sourceHashesUnchanged = true;
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), settingsText, 'UI audit must not save settings.');
  check(errors.length === 0, 'renderer-errors', errors);
  writeReport(); console.log(JSON.stringify({ output, measurements: measurements.length, screenshots: screenshots.length, findingCount: findings.length, rules: findings.reduce((counts, item) => ({ ...counts, [item.rule]: (counts[item.rule] || 0) + 1 }), {}), firstFindings: findings.slice(0, 12) }, null, 2));
  if (findings.length) process.exitCode = 1;
})().catch(async error => { console.error(error.stack); findings.push({ rule: 'audit-execution', detail: error.message }); try { if (application && page) await capture('audit-failure.png', '检查中断时的界面'); } catch {} writeReport(); process.exitCode = 1; }).finally(async () => {
  if (!application) return;
  if (findings.length) { await application.evaluate(({app}) => app.exit(1)).catch(() => {}); return; }
  const child = application.process(), exited = child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
  await application.evaluate(({app}) => app.quit()); let timer;
  try { await Promise.race([exited, new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('Normal app.quit did not exit within60seconds')), 60000); })]); }
  finally { clearTimeout(timer); }
});
