'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { LocalStore } = require('../src/core/store.cjs');
const { Settings } = require('../src/main/settings.cjs');
const { DEFAULT_REGION_SHORTCUT } = require('../src/main/region-shortcut.cjs');
const { NotesStore } = require('../src/main/notes.cjs');

// Exercise real IPC handlers with an isolated database, inert Electron lifecycle,
// mock confirmation dialogs and an injected AI class. No desktop or network starts.
function fixture(t, options = {}) {
  // Imported modules execute in the host realm, so keep its network blocked even
  // while the isolated IPC realm exercises user-approved calls to the mock client.
  const denyNetwork = () => { throw new Error('Network is forbidden in IPC integration tests.'); };
  t.mock.method(globalThis, 'fetch', denyNetwork);
  for (const name of ['node:http', 'node:https']) {
    const transport = require(name);
    t.mock.method(transport, 'request', denyNetwork);
    t.mock.method(transport, 'get', denyNetwork);
  }
  const root = fs.mkdtempSync(path.join(__dirname, '.tmp-main-library-'));
  const store = new LocalStore(root); const calls = []; const groupingCalls = []; const noteAICalls = []; const dialogs = []; const osActions = []; const events = [];
  const settings = new Settings(root, { decryptString: () => 'mock-only', isEncryptionAvailable: () => true, encryptString: () => Buffer.from('opaque-fixture') });
  settings.value = { ...settings.value, cloudEnabled: true, aiSearchEnabled: true, aiSearchConsentVersion: 1, duplicateAnalysisEnabled: true, duplicateAnalysisConsentVersion: 1, screenshotAnalysisEnabled: true, screenshotAnalysisConsentVersion: 1, apiKeyEncrypted: 'opaque-fixture', ...options.settings };
  if (options.settings?.model !== undefined) settings.value.aiProfiles.deepseek.model = options.settings.model;
  const callbacks = new Map();
  const electron = {
    app: { setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on(name, callback) { callbacks.set(name, callback); }, getVersion: () => 'test', setPath() {}, getPath: () => root, quit() {} },
    protocol: { registerSchemesAsPrivileged() {} },
    globalShortcut: options.globalShortcut,
    dialog: { async showMessageBox(_window, value) { dialogs.push(value); return { response: options.approve === false ? 0 : 1 }; } },
    shell: { async openPath(filename) { osActions.push(filename); return ''; }, async openExternal(url) { osActions.push(url); } },
  };
  const filename = path.join(__dirname, '../src/main/main.cjs'); const localRequire = createRequire(filename);
  class MockDeepSeek {
    constructor(value) { this.provider = value.provider || 'deepseek'; this.model = value.model; }
    async organize(record, opts) {
      calls.push({ record, opts });
      if (options.organize) return options.organize(record, opts);
      return { schemaVersion: 2, title: '模拟整理', summary: '本地模拟摘要', evidence: [], points: [], uncertainties: [], topicSuggestions: [] };
    }
    async classifyBatch(records, opts) {
      groupingCalls.push({ records, opts });
      if (options.classifyBatch) return options.classifyBatch(records, opts);
      return { schemaVersion: 1, groups: [{ name: '共同主题', reason: '本批记录具有相同的主题', records: records.map(({ id, version }) => ({ id, version })) }], unassigned: [], usage: { totalTokens: 20 } };
    }
    async requestJson(system, payload, opts) {
      noteAICalls.push({ system, payload, opts });
      if (options.noteAI) return options.noteAI(payload, opts);
      return { value: { text: '本地模拟生成内容' } };
    }
  }
  let cloudPermissions;
  const context = vm.createContext({
    require(name) { if (name === 'electron') return electron; if (name === '../core/ai-client.cjs') return { createAIClient: options => new MockDeepSeek(options) }; if (name === '../core/deepseek.cjs') return { DeepSeekClient: MockDeepSeek }; if (name === './cloud-permissions.cjs') return cloudPermissions; if (name === './semantic-service.cjs') return { createSemanticService() { throw new Error('not started in integration test'); } }; return localRequire(name); },
    __dirname: path.dirname(filename), process: { platform: 'win32', env: options.networkDisabled ? { INMOMENT_DISABLE_NETWORK: '1' } : {}, execPath: process.execPath },
    Buffer, URL, Response, AbortController, Promise, console, fetch: denyNetwork,
  });
  // Evaluate the unchanged permission module in the same process/environment as
  // main.cjs; a host import would incorrectly read the outer CI network lock.
  const permissionModule = { exports: {} };
  vm.runInContext('(function(module, exports) {\n' + fs.readFileSync(path.join(path.dirname(filename), 'cloud-permissions.cjs'), 'utf8') + '\n})', context)(permissionModule, permissionModule.exports);
  cloudPermissions = permissionModule.exports;
  vm.runInContext(fs.readFileSync(filename, 'utf8') + '\n globalThis.integration = { invoke, publicRecord, bootstrap, captureShortcutInput, cancelShortcutCapture, startShortcut() { return capabilities.regionScreenshot = regionShortcut.start(settings.public().regionScreenshotShortcut); }, init(deps) { store=deps.store; notes=deps.notes; noteAI=new NoteAI({ notes, prepareRequest:prepareNoteAI }); settings=deps.settings; controller=deps.controller; autoTitles=deps.autoTitles; libraryAI=deps.libraryAI; semantic=deps.semantic; offlineASR={cleanupRecordJobs:deps.cleanupRecordJobs,capabilities:()=>({available:false})}; mainWindow=deps.mainWindow; uiDialogs=deps.uiDialogs; } };', context);
  const controller = { snapshot: () => ({ active: false }), emitState() {}, refreshTrigger: async () => {}, removeStagedAudio() {}, session: {} };
  const autoTitles = { run: async () => {}, cancel() {}, cancelAll() {} };
  const mainWindow = { isDestroyed: () => false, isMinimized: () => false, isFocused: () => true, show() {}, focus() {}, webContents: { send(_channel, message) { events.push(message); } } };
  const libraryAI = options.libraryAI || { clearCache() {}, async search() { throw new Error('unexpected mock task'); } };
  const uiDialogs = { async showMessageBox(value) { dialogs.push(value); return { response: options.approve === false ? 0 : 1 }; } };
  context.integration.init({ store, notes: new NotesStore(store), settings, controller, autoTitles, libraryAI, mainWindow, uiDialogs, semantic: options.semantic, cleanupRecordJobs: options.cleanupRecordJobs || (() => ({ ok: true })) });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function record(id = 'one', { audio = true } = {}) {
    store.createDraft({ id }); if (audio) store.addSegment(id, { id: `${id}-segment`, bytes: Buffer.from('synthetic audio'), transcript: '保存灵感发生时的理由' }); return store.complete(id);
  }
  return { root, store, settings, calls, groupingCalls, noteAICalls, dialogs, osActions, events, controller, mainWindow, quit: callbacks.get('will-quit'), ...context.integration, record };
}

test('note AI click uses the saved source and configured screenshot consent, while selected actions send only selected text', async t => {
  const fx = fixture(t, { settings: { directAIEnabled: false } });
  const record = 'note-ai-ipc';
  const id = `record:${record}`;
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write('IHDR', 12);
  png.writeUInt32BE(100, 16);
  png.writeUInt32BE(100, 20);
  fx.store.createDraft({ id: record, notes: '第一段。\n第二段。', source: { url: 'https://example.test/source' } });
  fx.store.addScreenshot(record, png, { method: 'region' });
  fx.store.complete(record);

  const { note, summary } = await fx.invoke('notes:aiSummary', { id });
  assert.equal(summary.body, '本地模拟生成内容');
  assert.equal(note.body, '第一段。\n第二段。');
  assert.equal((await fx.invoke('notes:get', { id })).summaries[0].id, summary.id);
  assert.equal(fx.noteAICalls[0].opts.image.base64, png.toString('base64'));
  assert.equal(fx.noteAICalls[0].payload.source.url, 'https://example.test/source');

  assert.equal((await fx.invoke('notes:aiSummary', { id, selection: '第一段' })).text, summary.body);
  assert.equal((await fx.invoke('notes:aiRewrite', { id, selection: '第二段', instruction: '更明确' })).text, summary.body);
  assert.deepEqual(fx.noteAICalls[1].payload, { selection: '第一段' });
  assert.deepEqual(fx.noteAICalls[2].payload, { selection: '第二段', instruction: '更明确' });
  assert.equal(fx.noteAICalls[1].opts.image, null);
  assert.equal(fx.noteAICalls[2].opts.image, null);
  assert.equal(fx.dialogs.length, 0);
});

test('note AI refuses disabled cloud requests and reports unsupported saved screenshot models before dispatch', async t => {
  const offline = fixture(t, { networkDisabled: true });
  const note = await offline.invoke('notes:create');
  await offline.invoke('notes:update', { id: note.id, title: '示例', body: '完整内容' });
  await assert.rejects(offline.invoke('notes:aiSummary', { id: note.id }), /测试模式/u);
  assert.equal(offline.noteAICalls.length, 0);
  const configured = fixture(t, { settings: { modelMode: 'manual', model: 'deepseek-v4-pro' } });
  const id = 'unsupported-image';
  configured.store.createDraft({ id, notes: '笔记文字' });
  configured.store.addScreenshot(id, Buffer.alloc(24));
  configured.store.complete(id);
  await assert.rejects(configured.invoke('notes:aiSummary', { id: `record:${id}` }), /当前模型不支持截图理解/u);
  assert.equal(configured.noteAICalls.length, 0);
});

test('note selection context is opt-in, is disclosed before approval and is withdrawn immediately', async t => {
  const inFlight = Promise.withResolvers();
  let delay = false;
  const fx = fixture(t, { noteAI: () => delay ? inFlight.promise : { value: { text: '片段结果' } } });
  const { id } = await fx.invoke('notes:create');
  const before = '在情感化设计', selection = '中可靠客观的获得用户的情感信息很重要', after = '。';
  await fx.invoke('notes:update', { id, title: '合成笔记', body: before + selection + after });
  const params = { id, selection, start: before.length, end: before.length + selection.length, instruction: '写得简洁' };
  await fx.invoke('notes:aiRewrite', params);
  assert.deepEqual(fx.noteAICalls[0].payload, { selection, instruction: params.instruction });
  assert.equal(fx.settings.public().noteSelectionContextEnabled, false);

  const approved = await fx.invoke('settings:save', { noteSelectionContextEnabled: true });
  assert.equal(approved.noteSelectionContextConsentVersion, 1);
  assert.match(fx.dialogs[0].detail, /前文和后文各最多 900 个字符/u);
  await fx.invoke('notes:aiRewrite', params);
  assert.deepEqual(fx.noteAICalls[1].payload, { selection, instruction: params.instruction, before, after });
  assert.equal(fx.noteAICalls[1].opts.image, null);

  delay = true;
  const pending = fx.invoke('notes:aiRewrite', params);
  const cancelled = assert.rejects(pending, /已取消/u);
  const revoked = await fx.invoke('settings:save', { noteSelectionContextEnabled: false });
  assert.equal(revoked.noteSelectionContextConsentVersion, 0);
  assert.equal(fx.noteAICalls[2].opts.signal.aborted, true);
  inFlight.resolve({ value: { text: '旧稿' } });
  await cancelled;
  await fx.invoke('notes:aiRewrite', params);
  assert.deepEqual(fx.noteAICalls[3].payload, { selection, instruction: params.instruction });
});

test('notebook IPC edits and deletes legacy records through their canonical saved files', async t => {
  const cleaned = [], invalidated = [];
  const fx = fixture(t, { cleanupRecordJobs: id => { cleaned.push(id); return { ok: true }; }, semantic: { invalidate(id) { invalidated.push(id); } } });
  const record = fx.record('legacy-inspiration');
  const noteId = `record:${record.id}`;
  const audio = record.segments[0].path;
  assert.equal((await fx.invoke('notes:list')).notes[0].id, noteId);
  const note = await fx.invoke('notes:get', { id: noteId });
  assert.equal(note.body, '保存灵感发生时的理由');
  const updated = await fx.invoke('notes:update', { id: noteId, title: '可编辑的笔记', body: '新的正文' });
  assert.equal(updated.body, '新的正文');
  assert.equal((await fx.invoke('records:get', { id: record.id })).transcript, '新的正文');
  assert.equal(invalidated[0], record.id);
  assert.equal(fs.existsSync(audio), true);
  const deleted = await fx.invoke('notes:delete', { id: noteId });
  assert.equal(deleted.cleanupPending, false);
  assert.equal(fx.store.getRecord(record.id), null);
  assert.equal(fs.existsSync(audio), false);
  assert.deepEqual(cleaned, [record.id]);
  assert.equal(fx.calls.length, 0);
});

test('removing saved note audio requires body text and keeps the capture image and source', async t => {
  const cleaned = [];
  const fx = fixture(t, { cleanupRecordJobs: id => { cleaned.push(id); return { ok: true }; } });
  const id = 'saved-note-audio', noteId = `record:${id}`;
  fx.store.createDraft({ id, source: { url: 'https://example.test/' } });
  fx.store.addSegment(id, { bytes: Buffer.alloc(50), durationMs: 1 });
  fx.store.addScreenshot(id, Buffer.alloc(24), { method: 'region' });
  const record = fx.store.complete(id);
  const [audio] = record.segments, [screenshot] = record.screenshots;
  await assert.rejects(fx.invoke('notes:removeAudio', { id: noteId }), /先填写并保存/u);
  assert.equal(fs.existsSync(audio.path), true);
  await fx.invoke('notes:update', { id: noteId, title: '', body: '保留的正文' });
  const note = await fx.invoke('notes:removeAudio', { id: noteId });
  assert.equal(note.body, '保留的正文');
  assert.equal(note.background.audioSegments.length, 0);
  assert.equal(note.background.screenshots[0].id, screenshot.id);
  assert.equal(note.background.url, 'https://example.test/');
  assert.equal(fs.existsSync(audio.path), false);
  assert.equal(fs.existsSync(screenshot.path), true);
  assert.deepEqual(cleaned, [id]);
  assert.equal(fx.calls.length, 0);
});

test('key capture previews actual input, waits for release and only persists the shortcut', async t => {
  const registered = new Map();
  const fx = fixture(t, { globalShortcut: {
    register(shortcut, callback) {
      if (shortcut === 'Ctrl+Alt+F8') return false;
      registered.set(shortcut, callback); return true;
    },
    unregister(shortcut) { registered.delete(shortcut); },
  } });
  const arm = id => fx.invoke('settings:shortcutCapture', { active: true, captureId: id }, fx.mainWindow);
  const key = (type, key, code = key, mods = {}) => fx.captureShortcutInput({ type, key, code, ...mods });
  const last = () => fx.events.findLast(event => event.type === 'regionShortcutCapture');
  fx.startShortcut();
  await assert.rejects(fx.invoke('settings:shortcutCapture', { active: true, captureId: 1 }), /主窗口/u);
  assert.equal(await arm(1), true);
  registered.get(DEFAULT_REGION_SHORTCUT)();
  registered.get(DEFAULT_REGION_SHORTCUT)();
  assert.equal(last().candidate, DEFAULT_REGION_SHORTCUT);
  assert.equal(last().done, false);
  key('keyUp', 'F9');
  assert.equal(last().shortcut, DEFAULT_REGION_SHORTCUT);
  assert.equal(last().done, true);
  assert.equal(fs.existsSync(fx.settings.path), false);

  await arm(2);
  key('keyDown', 'Control', 'ControlLeft', { control: true });
  assert.equal(last().id, 1);
  key('keyDown', 'F7');
  assert.match(last().error, /修饰键/u);
  key('keyDown', 'F8', 'F8', { control: true, alt: true });
  assert.equal(last().candidate, 'Ctrl+Alt+F8');
  key('keyUp', 'F8');
  assert.match(last().error, /占用/u);
  assert.equal(registered.has(DEFAULT_REGION_SHORTCUT), true);
  await fx.invoke('settings:shortcutCapture', { active: false, captureId: 2 }, fx.mainWindow);
  assert.equal(last().done, true);

  await arm(3);
  key('keyDown', '!', 'Digit1', { control: true, shift: true });
  key('keyDown', '!', 'Digit1', { control: true, shift: true, isAutoRepeat: true });
  assert.equal(last().candidate, 'Ctrl+Shift+1');
  key('keyUp', 'Control', 'ControlLeft');
  assert.equal(fx.settings.public().regionScreenshotShortcut, DEFAULT_REGION_SHORTCUT);
  key('keyUp', '!', 'Digit1');
  assert.equal(last().shortcut, 'Ctrl+Shift+1');
  assert.equal(JSON.parse(fs.readFileSync(fx.settings.path)).regionScreenshotShortcut, 'Ctrl+Shift+1');
  assert.equal(fx.settings.public().thresholdMs, 550);
  assert.deepEqual([...registered.keys()], ['Ctrl+Shift+1']);

  await arm(4);
  key('keyDown', 'F7', 'F7', { control: true });
  fx.cancelShortcutCapture();
  key('keyUp', 'F7');
  assert.equal(fx.settings.public().regionScreenshotShortcut, 'Ctrl+Shift+1');
});

test('settings IPC replaces screenshot shortcuts atomically, with rollback on conflicts and write failures', async t => {
  const registered = new Map();
  const occupied = new Set(['Ctrl+Alt+F8']);
  const registry = {
    register(shortcut, listener) {
      if (occupied.has(shortcut)) return false;
      registered.set(shortcut, listener);
      return true;
    },
    unregister(shortcut) { registered.delete(shortcut); },
  };
  const fx = fixture(t, { globalShortcut: registry });
  assert.equal(fx.startShortcut().available, true);
  const initialListener = registered.get(DEFAULT_REGION_SHORTCUT);
  await assert.rejects(fx.invoke('settings:save', { regionScreenshotShortcut: 'Ctrl+Alt+F8', thresholdMs: 2100 }), { code: 'REGION_SHORTCUT' });
  assert.equal(registered.get(DEFAULT_REGION_SHORTCUT), initialListener);
  assert.equal(fx.settings.public().thresholdMs, 550);
  assert.equal(fs.existsSync(fx.settings.path), false);
  assert.equal(fx.bootstrap().capabilities.regionScreenshot.shortcut, DEFAULT_REGION_SHORTCUT);

  const persist = t.mock.method(fx.settings, 'persist', () => { throw new Error('disk write failed'); });
  await assert.rejects(fx.invoke('settings:save', { regionScreenshotShortcut: 'Alt+Shift+F7' }), /disk write failed/u);
  assert.deepEqual([...registered.keys()], [DEFAULT_REGION_SHORTCUT]);
  assert.equal(registered.get(DEFAULT_REGION_SHORTCUT), initialListener);
  persist.mock.restore();
  await fx.invoke('settings:save', { regionScreenshotShortcut: 'shift + alt + f7' });
  assert.deepEqual([...registered.keys()], ['Alt+Shift+F7']);
  assert.equal(fx.bootstrap().capabilities.regionScreenshot.shortcut, 'Alt+Shift+F7');
  assert.equal(JSON.parse(fs.readFileSync(fx.settings.path)).regionScreenshotShortcut, 'Alt+Shift+F7');

  occupied.add(DEFAULT_REGION_SHORTCUT);
  await assert.rejects(fx.invoke('settings:reset'), { code: 'REGION_SHORTCUT' });
  assert.deepEqual([...registered.keys()], ['Alt+Shift+F7']);
  assert.equal(fx.settings.public().regionScreenshotShortcut, 'Alt+Shift+F7');
  occupied.delete(DEFAULT_REGION_SHORTCUT);
  await fx.invoke('settings:reset');
  assert.deepEqual([...registered.keys()], [DEFAULT_REGION_SHORTCUT]);
  assert.equal(fx.settings.public().regionScreenshotShortcut, DEFAULT_REGION_SHORTCUT);
  fx.quit();
  assert.equal(registered.size, 0);
});

test('a screenshot shortcut occupied at startup is visible and other settings still save', async t => {
  let attempts = 0;
  const fx = fixture(t, { globalShortcut: { register() { attempts++; return false; } } });
  assert.match(fx.startShortcut().error, /占用/u);
  await fx.invoke('settings:save', { thresholdMs: 710, regionScreenshotShortcut: DEFAULT_REGION_SHORTCUT });
  assert.equal(attempts, 1);
  assert.equal(fx.settings.public().thresholdMs, 710);
  assert.equal(fx.bootstrap().capabilities.regionScreenshot.available, false);
});

test('isolated development network lock rejects approved IPC calls before even the mock client', async t => {
  const fx = fixture(t, { networkDisabled: true }); fx.record();
  await assert.rejects(fx.invoke('records:organize', { id: 'one' }), /测试模式/);
  await assert.rejects(fx.invoke('records:aiSearch', { query: '灵感' }), /测试模式/);
  assert.equal(fx.calls.length, 0); assert.equal(fx.dialogs.length, 0);
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /Network is forbidden/);
  assert.throws(() => require('node:https').get('https://example.invalid/'), /Network is forbidden/);
});

test('background projections keep legacy screenshots separate and only open the saved web address', async t => {
  const fx = fixture(t);
  fx.store.createDraft({ id: 'context', source: { processName: 'Browser', title: 'Product research', url: 'https://example.test/research', hwnd: '5', pid: 1 } });
  fx.store.addScreenshot('context', Buffer.from('background'));
  fx.store.addScreenshot('context', Buffer.from('crop'), { method: 'region' });
  fx.store.complete('context');
  const record = await fx.invoke('records:get', { id: 'context' });
  assert.equal(record.context.canFocus, true);
  assert.equal(record.context.url, 'https://example.test/research');
  assert.deepEqual(Array.from(record.screenshots, item => item.role), ['background', 'region']);
  assert.equal(record.screenshot.role, 'region');
  assert.ok(record.screenshots.every(item => item.url.startsWith('inmoment-media://') && !Object.hasOwn(item, 'path')));
  await fx.invoke('records:openSourceUrl', { id: 'context', url: 'https://foreign.test/' });
  fx.store.createDraft({ id: 'unsafe', source: { url: 'file:///C:/test.exe' } });
  await assert.rejects(fx.invoke('records:openSourceUrl', { id: 'unsafe' }), /没有可打开的网址/u);
  assert.deepEqual(fx.osActions, ['https://example.test/research']);
});
test('IPC rejects new AI scopes before any dialog or injected model when settings are disabled', async t => {
  const fx = fixture(t, { settings: { cloudEnabled: false } }); fx.record();
  await assert.rejects(fx.invoke('records:organize', { id: 'one' }), /总开关/);
  await assert.rejects(fx.invoke('records:aiSearch', { query: '灵感' }), /总开关/);
  assert.equal(fx.dialogs.length, 0); assert.equal(fx.calls.length, 0);
});
test('cancelling one-request consent leaves originals and never invokes even the mock model', async t => {
  const fx = fixture(t, { approve: false }); fx.record();
  const result = await fx.invoke('records:organize', { id: 'one' });
  assert.equal(result.cancelled, true); assert.equal(fx.calls.length, 0); assert.equal(fx.store.getRecord('one').organization, null);
});
test('an existing screenshot is not sent unless the current request explicitly selects it', async t => {
  const fx = fixture(t);
  fx.store.createDraft({ id: 'one' }); fx.store.addSegment('one', { bytes: Buffer.from('synthetic audio'), transcript: '灵感记录' }); fx.store.addScreenshot('one', Buffer.from('not read when unselected')); fx.store.complete('one');
  await fx.invoke('records:organize', { id: 'one' }); assert.equal(fx.calls.length, 1); assert.equal(fx.calls[0].opts.image, undefined);
  fx.settings.value.screenshotAnalysisEnabled = false;
  await assert.rejects(fx.invoke('records:organize', { id: 'one', includeScreenshot: true }), /确认/);
  assert.equal(fx.calls.length, 1);
});
test('screenshot-only records retain written expressions through public data and AI text evidence', async t => {
  const fx = fixture(t); fx.record('one', { audio: false });
  const edited = await fx.invoke('records:update', { id: 'one', transcript: '这里写下后来补充的联想' });
  assert.equal(edited.transcript, '这里写下后来补充的联想'); assert.equal(edited.audioSegments.length, 0);
  await fx.invoke('records:organize', { id: 'one' });
  assert.equal(fx.calls[0].record.segments[0].sourceType, 'written-note'); assert.equal(fx.calls[0].record.segments[0].transcript, edited.transcript);
});
test('an invalid segment cannot partly save title or notes through IPC', async t => {
  const fx = fixture(t); const record = fx.record();
  await assert.rejects(fx.invoke('records:update', { id: 'one', title: 'must not commit', expectedVersion: record.version, transcriptSegments: [{ id: 'missing-segment', text: 'bad' }] }), /unknown/i);
  assert.equal(fx.store.getRecord('one').title, ''); assert.equal(fx.store.getRecord('one').version, record.version);
});
test('public groups and bootstraps expose media URLs instead of local attachment paths', async t => {
  const fx = fixture(t); const left = fx.record('left'), right = fx.record('right');
  const candidate = fx.store.saveDuplicateSuggestions([{ leftId: left.id, rightId: right.id, leftVersion: left.version, rightVersion: right.version, reason: '相同想法', leftQuote: '灵感', rightQuote: '灵感' }])[0];
  const group = await fx.invoke('duplicates:decide', { id: candidate.id, decision: 'group' });
  assert.equal(group.records.length, 2); assert.equal(JSON.stringify(group).includes(fx.root), false);
  assert.match(group.records[0].audioSegments[0].url, /^inmoment-media:/);
  assert.equal(JSON.stringify(fx.bootstrap().groups).includes(fx.root), false);
  assert.equal(typeof group.name, 'string');
  const renamed = await fx.invoke('groups:rename', { id: group.id, name: '我的阅读联想' });
  assert.equal(renamed.name, '我的阅读联想');
  assert.equal(fx.bootstrap().groups[0].name, '我的阅读联想');
  assert.equal(JSON.stringify(renamed).includes(fx.root), false);
  assert.equal(fx.calls.length, 0);
});

test('local IPC applies unclassified/topic union without widening the selected dates', async t => {
  const fx = fixture(t); const topic = fx.store.createTopic('产品');
  for (const [id, createdAt, topicIds] of [['selected', 100, [topic.id]], ['unclassified', 150, []], ['outside', 200, []]]) {
    fx.store.createDraft({ id, createdAt, topicIds, notes: '共同灵感' }); fx.store.complete(id);
  }
  const filters = { from: 100, to: 200, topicIds: [topic.id], uncategorized: true };
  const listed = await fx.invoke('records:list', { filters });
  assert.deepEqual(Array.from(listed.records, item => item.id), ['unclassified', 'selected']);
  assert.equal(listed.total, 2);
  const searched = await fx.invoke('records:search', { query: '共同灵感', filters });
  assert.equal(searched.total, 2);
  assert.equal(fx.dialogs.length, 0);
  assert.equal(fx.calls.length, 0);
  await assert.rejects(fx.invoke('records:list', { filters: { uncategorized: 'true' } }), /未分类/);
});

test('media IPC ignores renderer paths and resolves only the selected saved record original or directory', async t => {
  const fx = fixture(t); const record = fx.record();
  const result = await fx.invoke('media:open-original', { id: record.id, path: 'arbitrary-untrusted-path.exe' });
  assert.equal(result.opened, true); assert.equal(result.kind, 'audio');
  assert.equal(fx.osActions[0], record.segments[0].path);
  const folder = await fx.invoke('media:reveal-record', { id: record.id, path: 'untrusted-folder' });
  assert.equal(folder.revealed, true);
  assert.equal(fx.osActions[1], fx.store.directory(record.id, 'saved'));
  assert.equal(JSON.stringify([result, folder]).includes(fx.root), false);
  assert.equal(fx.calls.length, 0);
  await assert.rejects(fx.invoke('media:open-original', { id: '../outside' }), /identifier/);
  assert.equal(fx.osActions.length, 2);
});

test('organize supplies existing groups but never creates or assigns suggestions without a second user action', async t => {
  const fx = fixture(t); fx.record();
  const topic = fx.store.createTopic('已有分组');
  fx.store.setRecordTopics('one', [topic.id]);
  const before = fx.store.getRecord('one').topics.map(item => item.id);
  await fx.invoke('records:organize', { id: 'one' });
  assert.deepEqual(Array.from(fx.calls[0].record.availableTopics), ['已有分组']);
  assert.deepEqual(fx.store.listTopics().map(item => item.id), [topic.id]);
  assert.deepEqual(fx.store.getRecord('one').topics.map(item => item.id), before);
});

test('group assignment through IPC refuses an outdated content version and preserves existing memberships', async t => {
  const fx = fixture(t); const original = fx.record(); const before = fx.store.createTopic('原有分组'); const suggested = fx.store.createTopic('旧建议');
  fx.store.setRecordTopics(original.id, [before.id]); fx.store.updateRecord(original.id, { notes: '分类确认期间补充的新想法' });
  await assert.rejects(fx.invoke('records:setTopics', { id: original.id, topicIds: [suggested.id], expectedVersion: original.version }), /changed|stale/i);
  assert.deepEqual(fx.store.getRecord(original.id).topics.map(topic => topic.id), [before.id]);
  assert.equal(fx.calls.length, 0);
});

test('bulk group IPC merges and deletes only selected groups without models or original deletion', async t => {
  const fx = fixture(t); const record = fx.record(); const a = fx.store.createTopic('甲组'), b = fx.store.createTopic('乙组'), other = fx.store.createTopic('其他组');
  fx.store.setRecordTopics(record.id, [a.id, b.id, other.id]); const audio = fs.readFileSync(record.segments[0].path);
  const merged = await fx.invoke('topics:mergeMany', { topicIds: [a.id, b.id], targetId: b.id }); assert.equal(merged.topic.id, b.id); assert.equal(merged.topic.name, '乙组');
  assert.deepEqual(fx.store.getRecord(record.id).topics.map(topic => topic.id).sort(), [b.id, other.id].sort());
  await assert.rejects(fx.invoke('topics:deleteMany', { topicIds: [b.id, 'missing'] }), /unavailable/); assert.equal(fx.store.listTopics().length, 2);
  await fx.invoke('topics:deleteMany', { topicIds: [b.id, other.id] }); assert.equal(fx.store.listTopics().length, 0); assert.deepEqual(fx.store.getRecord(record.id).topics, []); assert.deepEqual(fs.readFileSync(record.segments[0].path), audio);
  assert.equal(fx.calls.length, 0); assert.equal(fx.dialogs.length, 0); assert.equal(fx.events.filter(event => event.type === 'recordsChanged').length, 2);
});
test('group subtree copy and content deletion use independent notes and retain shared original memberships', async t => {
  const fx = fixture(t);
  const root = await fx.invoke('topics:create', { name: '验收组' });
  const child = await fx.invoke('topics:create', { name: '子组', parentId: root.id });
  const outside = await fx.invoke('topics:create', { name: '其他组' });
  const own = await fx.invoke('notes:create', { topicId: child.id, title: '独有', body: '独有正文' });
  const shared = fx.record('shared-group-note');
  fx.store.setRecordTopics(shared.id, [child.id, outside.id]);

  const copy = await fx.invoke('topics:copyTree', { topicIds: [root.id, child.id], parentId: outside.id });
  assert.equal(copy.count, 2);
  const [copyRoot] = copy.groupIds;
  const copyChild = fx.store.listTopics().find(group => group.parentId === copyRoot);
  const copyNotes = (await fx.invoke('notes:list', { topicId: copyChild.id })).notes;
  assert.equal(copyNotes.length, 2);
  assert.notEqual(copyNotes.find(note => note.title === '独有').id, own.id);
  assert.ok(copyNotes.every(note => note.id !== `record:${shared.id}`));

  const removed = await fx.invoke('topics:deleteWithNotes', { topicIds: [root.id] });
  assert.deepEqual(Array.from(removed.deletedNotes), [own.id]);
  await assert.rejects(fx.invoke('notes:get', { id: own.id }), /笔记已不存在/u);
  assert.deepEqual(fx.store.getRecord(shared.id).topics.map(topic => topic.id), [outside.id]);
  assert.equal((await fx.invoke('notes:list', { topicId: copyChild.id })).notes.length, 2);
  assert.equal(fx.calls.length, 0);
});

test('final IPC search mapping drops a stale record even if an injected service returns it', async t => {
  let fx;
  const libraryAI = { async search() { const original = fx.store.getRecord('one'); fx.store.updateRecord('one', { notes: 'new version' }); return { results: [{ id: 'one', version: original.version, reason: '旧依据', quote: '灵感' }], coverage: { scopeCount: 1, examinedCount: 1 } }; } };
  fx = fixture(t, { libraryAI }); fx.record();
  const result = await fx.invoke('records:aiSearch', { query: '灵感' }); assert.equal(result.records.length, 0);
});
test('changing the local key aborts an in-flight search before a second stage can use its old client', async t => {
  let signal; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const libraryAI = { clearCache() {}, search(options) { signal = options.signal; started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('mock cancelled')), { once: true })); } };
  const fx = fixture(t, { libraryAI }); fx.record();
  const searching = fx.invoke('records:aiSearch', { query: '灵感' }); const rejected = assert.rejects(searching, /mock cancelled/);
  await ready; await fx.invoke('settings:save', { apiKey: 'mock-replacement-only' });
  await rejected; assert.equal(signal.aborted, true);
});

test('new direct consent skips per-request prompts but legacy consent cannot gain it implicitly', async t => {
  const old = fixture(t, { approve: false, settings: { directAIEnabled: true, directAIConsentVersion: 0 } }); old.record();
  const cancelled = await old.invoke('records:organize', { id: 'one' }); assert.equal(cancelled.cancelled, true); assert.equal(old.calls.length, 0);
  const direct = fixture(t, { approve: false, settings: { directAIEnabled: true, directAIConsentVersion: 1 } }); direct.record();
  await direct.invoke('records:organize', { id: 'one' }); assert.equal(direct.calls.length, 1); assert.equal(direct.dialogs.length, 0);
});
test('direct consent automatically attaches only the saved screenshot when its separate permission is valid', async t => {
  function png() { const value = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(value); value.write('IHDR', 12); value.writeUInt32BE(2, 16); value.writeUInt32BE(2, 20); return value; }
  for (const enabled of [true, false]) {
    const fx = fixture(t, { settings: { directAIEnabled: true, directAIConsentVersion: 1, screenshotAnalysisEnabled: enabled } });
    fx.store.createDraft({ id: 'one' }); fx.store.addSegment('one', { bytes: Buffer.from('synthetic'), transcript: '测试文字' }); fx.store.addScreenshot('one', png()); fx.store.complete('one');
    await fx.invoke('records:organize', { id: 'one', includeScreenshot: !enabled });
    assert.equal(Boolean(fx.calls[0].opts.image), enabled); assert.equal(fx.dialogs.length, 0);
    assert.equal(fx.calls[0].record.segments[0].bytes, undefined);
  }
});
test('screenshot permission or model failures remain visible rather than silently changing the upload scope', async t => {
  for (const fields of [{ screenshotAnalysisConsentVersion: 0 }, { modelMode: 'manual', model: 'deepseek-pro' }]) {
    const fx = fixture(t, { settings: { directAIEnabled: true, directAIConsentVersion: 1, ...fields } });
    fx.store.createDraft({ id: 'one', notes: '截图相关的灵感' }); fx.store.addScreenshot('one', Buffer.alloc(24)); fx.store.complete('one');
    await assert.rejects(fx.invoke('records:organize', { id: 'one' }), /确认|不支持截图|未启用截图理解/); assert.equal(fx.calls.length, 0);
  }
});
test('saving new direct permission requires explicit settings confirmation and cannot forge its version', async t => {
  const denied = fixture(t, { approve: false });
  const original = fs.existsSync(denied.settings.path) ? fs.readFileSync(denied.settings.path) : null;
  const result = await denied.invoke('settings:save', { directAIEnabled: true, directAIConsentVersion: 1 });
  assert.equal(result.cancelled, true); assert.equal(denied.settings.public().directAIEnabled, false);
  assert.equal(fs.existsSync(denied.settings.path), original !== null); assert.equal(denied.calls.length, 0);
  const accepted = fixture(t);
  await accepted.invoke('settings:save', { directAIEnabled: true });
  assert.equal(accepted.settings.public().directAIConsentVersion, 1); assert.match(accepted.dialogs[0].detail, /不再逐次/); assert.equal(accepted.calls.length, 0);
});
test('batch IPC only summarizes frozen supplied records and requires a separate action to classify', async t => {
  const fx = fixture(t, { settings: { directAIEnabled: true, directAIConsentVersion: 1, screenshotAnalysisEnabled: false } });
  const topic = fx.store.createTopic('原主题');
  for (const id of ['one', 'two', 'outside']) fx.record(id);
  fx.store.setRecordTopics('one', [topic.id]);
  const result = await fx.invoke('library:batchOrganize', { recordIds: ['two', 'one', 'two'], expectedVersions: { one: fx.store.getRecord('one').version, two: fx.store.getRecord('two').version } });
  assert.equal(result.total, 2); assert.deepEqual(fx.calls.map(item => item.record.id), ['two', 'one']);
  assert.equal(fx.store.getRecord('outside').organization, null); assert.deepEqual(fx.store.getRecord('one').topics.map(item => item.id), [topic.id]);
  assert.equal(fx.dialogs.length, 0); assert.equal(fx.events.filter(event => event.type === 'batchOrganizeProgress' && event.status === 'success').length, 2);
  assert.equal(JSON.stringify(result).includes(fx.root), false);
  assert.equal(fx.groupingCalls.length, 1); assert.deepEqual(Array.from(fx.groupingCalls[0].records, item => item.id), ['two', 'one']);
  assert.equal(result.grouping.status, 'done'); assert.equal(result.grouping.groupCount, 1);
  assert.deepEqual(fx.store.getRecord('two').organization.topicSuggestions, ['共同主题']);
  assert.deepEqual(fx.store.listTopics().map(item => item.name), ['原主题']);
});
test('batch cancellation aborts its active request and reports all later records unprocessed', async t => {
  let started, signal;
  const ready = new Promise(resolve => { started = resolve; });
  const fx = fixture(t, { settings: { directAIEnabled: true, directAIConsentVersion: 1, screenshotAnalysisEnabled: false }, organize(_record, options) { signal = options.signal; started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('mock cancelled')), { once: true })); } });
  fx.record('one'); fx.record('two');
  const run = fx.invoke('library:batchOrganize', { recordIds: ['one', 'two'] }); await ready;
  await fx.invoke('library:cancel', { kind: 'batchOrganize' }); const result = await run;
  assert.equal(signal.aborted, true); assert.equal(result.cancelled, true); assert.equal(result.items.length, 2); assert.equal(result.items[1].status, 'not-processed');
  assert.equal(fx.calls.length, 1); assert.equal(fx.store.getRecord('one').organization, null);
  assert.equal(fx.groupingCalls.length, 0);
});

test('batch consent covers both per-note summaries and the one shared taxonomy request', async t => {
  const fx = fixture(t, { settings: { screenshotAnalysisEnabled: false } }); fx.record('one'); fx.record('two');
  const result = await fx.invoke('library:batchOrganize', { recordIds: ['one', 'two'] });
  assert.equal(fx.dialogs.length, 1); assert.match(fx.dialogs[0].detail, /最多 3 次请求/);
  assert.match(fx.dialogs[0].detail, /统一比较/); assert.match(fx.dialogs[0].detail, /96,000/);
  assert.equal(fx.calls.length, 2); assert.equal(fx.groupingCalls.length, 1); assert.equal(result.grouping.status, 'done');
  assert.ok(fx.calls.every(call => call.opts.deferGrouping === true));
  assert.equal(fx.groupingCalls[0].opts.approved, true); assert.equal(fx.store.listTopics().length, 0);
});

test('declining batch authorization performs neither summaries nor shared grouping', async t => {
  const fx = fixture(t, { approve: false, settings: { screenshotAnalysisEnabled: false } }); fx.record('one');
  const result = await fx.invoke('library:batchOrganize', { recordIds: ['one'] });
  assert.equal(result.cancelled, true); assert.equal(fx.calls.length, 0); assert.equal(fx.groupingCalls.length, 0);
  assert.equal(fx.store.getRecord('one').organization, null);
});

test('a shared classification error preserves summaries and original memberships without per-record fallback', async t => {
  const fx = fixture(t, { settings: { directAIEnabled: true, directAIConsentVersion: 1, screenshotAnalysisEnabled: false },
    organize: async () => ({ schemaVersion: 2, title: '模拟整理', summary: '已保存的摘要', topicSuggestions: ['过细的单篇主题'] }),
    classifyBatch: async () => { throw new Error('mock taxonomy failed'); },
  });
  fx.record('one'); fx.record('two'); const topic = fx.store.createTopic('原有分类'); fx.store.setRecordTopics('one', [topic.id]);
  const result = await fx.invoke('library:batchOrganize', { recordIds: ['one', 'two'] });
  assert.equal(result.grouping.status, 'failed'); assert.match(result.grouping.error, /摘要已保留/);
  assert.ok(result.items.every(item => !item.topicSuggestions.length));
  assert.equal(fx.store.getRecord('one').organization.summary, '已保存的摘要'); assert.deepEqual(fx.store.getRecord('one').organization.topicSuggestions, []);
  assert.deepEqual(fx.store.getRecord('one').topics.map(item => item.id), [topic.id]); assert.equal(fx.store.listTopics().length, 1);
});

test('cancellation during shared classification aborts the request and retains completed summaries only', async t => {
  let started, signal; const ready = new Promise(resolve => { started = resolve; });
  const fx = fixture(t, { settings: { directAIEnabled: true, directAIConsentVersion: 1, screenshotAnalysisEnabled: false }, classifyBatch(_records, options) {
    signal = options.signal; started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('mock shared cancellation')), { once: true }));
  } });
  fx.record('one'); fx.record('two');
  const running = fx.invoke('library:batchOrganize', { recordIds: ['one', 'two'] }); await ready;
  await fx.invoke('library:cancel', { kind: 'batchOrganize' }); const result = await running;
  assert.equal(result.cancelled, true); assert.equal(result.grouping.status, 'cancelled'); assert.equal(signal.aborted, true);
  assert.equal(fx.calls.length, 2); assert.equal(fx.groupingCalls.length, 1);
  assert.ok(['one', 'two'].every(id => fx.store.getRecord(id).organization?.summary === '本地模拟摘要'));
  assert.equal(fx.store.listTopics().length, 0);
});

test('enabling screenshot sharing during a text-only batch cannot widen its frozen upload scope', async t => {
  let fx;
  fx = fixture(t, { settings: { directAIEnabled: true, directAIConsentVersion: 1, screenshotAnalysisEnabled: false }, async organize(record) {
    if (record.id === 'one') await fx.invoke('settings:save', { screenshotAnalysisEnabled: true });
    return { schemaVersion: 2, title: '模拟标题', summary: '本次仅发送文字', topicSuggestions: [] };
  } });
  for (const id of ['one', 'two']) {
    fx.store.createDraft({ id }); fx.store.addSegment(id, { bytes: Buffer.from('synthetic audio'), transcript: '文字灵感' });
    // Deliberately unreadable as an image: text-only requests must not inspect these bytes.
    fx.store.addScreenshot(id, Buffer.from('synthetic image excluded from frozen batch')); fx.store.complete(id);
  }
  const result = await fx.invoke('library:batchOrganize', { recordIds: ['one', 'two'] });
  assert.equal(fx.settings.public().screenshotAnalysisEnabled, true); assert.equal(fx.calls.length, 2);
  assert.ok(fx.calls.every(call => call.opts.image === undefined)); assert.equal(result.inputBytes.image, 0);
  assert.equal(result.grouping.status, 'done'); assert.equal(fx.groupingCalls.length, 1);
});
test('description search dates override old UI date filters and preserve the selected topic boundary', async t => {
  let passed;
  const fx = fixture(t, { settings: { directAIEnabled: true, directAIConsentVersion: 1 }, libraryAI: { async search(options) { passed = options; return { results: [], coverage: { scopeCount: 1, examinedCount: 0 } }; } } });
  const topic = fx.store.createTopic('工作'); const now = Date.now();
  fx.store.createDraft({ id: 'one', createdAt: now, notes: '灵感', topicIds: [topic.id] }); fx.store.complete('one');
  const result = await fx.invoke('records:aiSearch', { query: '最近一年关于工具的灵感', filters: { from: 1, to: 2, topicIds: [topic.id] } });
  assert.deepEqual(Array.from(passed.filters.topicIds), [topic.id]); assert.ok(passed.filters.from > 2); assert.equal(result.timeInterpretation.source, 'description'); assert.equal(fx.dialogs.length, 0);
});
test('semantic installation always requires this-click confirmation and never uses cloud consent as download approval', async t => {
  const installs = [];
  const semantic = { status: () => ({ installed: false }), async install(options) { installs.push(options); return { installed: true }; } };
  const denied = fixture(t, { semantic, approve: false, settings: { directAIEnabled: true, directAIConsentVersion: 1 } });
  assert.equal((await denied.invoke('semantic:install')).cancelled, true); assert.equal(installs.length, 0);
  const allowed = fixture(t, { semantic }); await allowed.invoke('semantic:install'); assert.equal(installs.length, 1); assert.equal(installs[0].approved, true); assert.equal(allowed.calls.length, 0);
});
test('semantic cancellation IPC waits for local cleanup before acknowledging a safe retry', async t => {
  let finish, settled = false;
  const cleanup = new Promise(resolve => { finish = resolve; });
  const fx = fixture(t, { semantic: { async cancel() { await cleanup; return { cancelled: true }; } } });
  const request = fx.invoke('semantic:cancel').then(result => { settled = true; return result; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false);
  finish(); assert.equal((await request).cancelled, true); assert.equal(fx.calls.length, 0);
});

test('waveform IPC reads only owned synthetic WAV audio on demand and cleanup revokes future access',async t=>{
  const fx=fixture(t),{wavHeader}=require('../src/main/wav-writer.cjs'),pcm=Buffer.alloc(1600*2);for(let i=0;i<1600;i++)pcm.writeInt16LE(i<800?0:16384,i*2);const bytes=Buffer.concat([wavHeader(pcm.length,16000),pcm]);
  for(const id of ['wave-saved','wave-draft']){fx.store.createDraft({id});fx.store.addSegment(id,{id:id+'-audio',bytes,durationMs:999});if(id==='wave-saved')fx.store.complete(id);}
  const saved=await fx.invoke('records:waveform',{id:'wave-saved',segmentId:'wave-saved-audio',path:'C:/untrusted/not-used.wav'});assert.equal(saved.durationMs,100);assert.equal(saved.peaks.length,256);assert.ok(saved.peaks.slice(0,128).every(n=>n===0));assert.ok(saved.peaks.slice(128).every(n=>n===.5));assert.equal(saved.path,undefined);
  await assert.rejects(()=>fx.invoke('records:waveform',{id:'wave-saved',segmentId:'wave-draft-audio'}),/已不可用/u);assert.equal((await fx.invoke('records:waveform',{id:'wave-draft',segmentId:'wave-draft-audio'})).durationMs,100);
  await fx.invoke('draft:discard',{id:'wave-draft'});await assert.rejects(()=>fx.invoke('records:waveform',{id:'wave-draft',segmentId:'wave-draft-audio'}),/已不可用/u);
  await fx.invoke('records:delete',{id:'wave-saved'});await assert.rejects(()=>fx.invoke('records:waveform',{id:'wave-saved',segmentId:'wave-saved-audio'}),/已不可用/u);assert.equal(fx.calls.length,0);
});
