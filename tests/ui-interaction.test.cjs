'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the production UI scripts against a small DOM/IPC boundary. These tests
// never start Electron, request a microphone, take screenshots, or call a model.
function createDOM() {
  const nodes = new Map();
  const created = [];
  function element(tag = 'div') {
    const value = {
      tag, textContent: '', className: '', value: '', disabled: false,
      isConnected: true, children: [], handlers: {}, attributes: {}, scrollHeight: 200,
      style: {}, open: false, clientWidth: 960, clientHeight: 540, naturalWidth: 0, naturalHeight: 0,
      paused: true, ended: false, pauseCount: 0, scrollLeft: 0, scrollTop: 0,
      append(child) { if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child); this.children.push(child); child.parentElement = this; const connect = item => { item.isConnected = true; item.children.forEach(connect); }; connect(child); },
      insertBefore(child, reference) { if (child === reference) return child; if (reference === null || reference === undefined) { this.append(child); return child; } if (reference.parentElement !== this) throw new Error('NotFoundError: reference is not a child'); if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child); this.children.splice(this.children.indexOf(reference), 0, child); child.parentElement = this; const connect = item => { item.isConnected = true; item.children.forEach(connect); }; connect(child); return child; },
      replaceChildren(...children) { const disconnect = item => { item.isConnected = false; item.children.forEach(disconnect); }; this.children.forEach(disconnect); this.children = []; children.forEach(child => this.append(child)); },
      setAttribute(key, content) { this.attributes[key] = String(content); if(key==='class')this.className=String(content); },
      getAttribute(key) { return this.attributes[key]; },
      removeAttribute(key) { delete this.attributes[key]; if (key === 'src') delete this.src; },
      showModal() { this.open = true; },
      close() { this.open = false; },
      addEventListener(name, listener) { (this.handlers[name] ||= []).push(listener); },
      play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; this.pauseCount += 1; },
      focus() { document.activeElement = this; },
      setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; },
      setPointerCapture() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: Number.parseInt(this.style.width || '960', 10), height: Number.parseInt(this.style.height || '540', 10) }; },
    };
    value.classList = {
      contains(name) { return value.className.split(/\s+/u).includes(name); },
      add(name) { if (!this.contains(name)) value.className = `${value.className} ${name}`.trim(); },
      remove(name) { value.className = value.className.split(/\s+/u).filter(item => item !== name).join(' '); },
      toggle(name, enabled) { if (enabled ?? !this.contains(name)) this.add(name); else this.remove(name); },
    };
    Object.defineProperty(value, 'id', {
      get() { return this._id; },
      set(id) { this._id = id; nodes.set(`#${id}`, this); },
    });
    created.push(value);
    return value;
  }
  const properties = {};
  const document = {
    handlers: {}, activeElement: null,
    body: { className: '', dataset: {} },
    documentElement: { style: { setProperty(key, value) { properties[key] = value; } } },
    createElement: element,
    createElementNS(_namespace, tag) { return element(tag); },
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
    querySelectorAll(selector) {
      if (selector === '.button') return created.filter(item => item.isConnected && item.classList.contains('button'));
      if (selector === '.nav-item') return created.filter(item => item.isConnected && item.classList.contains('nav-item'));
      if (selector === '[data-view]') return created.filter(item => item.isConnected && item.dataset?.view);
      if (selector.includes('#record-detail ') || selector.includes('#group-record-detail ')) return created.filter(item => item.isConnected && selector.split(',').some(part => { const [root, tag] = part.trim().split(' '); let ancestor = item.parentElement; while (ancestor && ancestor.id !== root.slice(1)) ancestor = ancestor.parentElement; return ancestor && item.tag === tag; }));
      return [];
    },
    addEventListener(name, listener) { (this.handlers[name] ||= []).push(listener); },
  };
  document.body = element('body'); document.body.dataset = {};
  const emit = (target, name, extra = {}) => Promise.all((target.handlers[name] || []).map(listener => listener({ target, currentTarget: target, preventDefault() {}, ...extra })));
  return { document, nodes, created, properties, element, emit };
}

function runUIScript(relativePath, globals) {
  const context = vm.createContext({ String, Number, Boolean, Array, JSON, Math, Date, ...globals });
  const filename = path.join(__dirname, '..', relativePath);
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context;
}

function overlayHarness() {
  const dom = createDOM();
  const calls = [];
  const frames = new Map();
  const timers = new Map();
  let listener;
  let clock = 0;
  let sequence = 0;
  const epoch = Date.parse('2026-10-16T10:00:00.000Z');
  class FixedDate extends Date { static now() { return epoch; } }
  runUIScript('src/overlay/app.js', {
    document: dom.document,
    window: { InMomentBrandMorph: { mount() { return { setState() {}, destroy() {} }; } }, getComputedStyle() { return { borderLeftWidth: '1px' }; }, inmoment: {
      subscribe(callback) { listener = callback; },
      invoke(method, params) { calls.push({ method, params }); return new Promise(() => {}); },
    } },
    Date: FixedDate,
    performance: { now: () => clock },
    setInterval() {},
    setTimeout(callback) { timers.set(++sequence, callback); return sequence; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  return {
    ...dom, calls, epoch, frames,
    event(value) { listener(value); },
    advance(milliseconds) {
      clock = milliseconds;
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(clock));
    },
    mode() { return dom.document.body.dataset.mode; },
    percent() { return dom.nodes.get('#hold-progress').getAttribute('aria-valuenow'); },
  };
}

test('right-hold preview compensates ISO timestamp delay, reaches half, and cancels without recording', () => {
  const ui = overlayHarness();
  ui.event({ type: 'holdProgress', phase: 'start', thresholdMs: 600, startedAt: new Date(ui.epoch - 100).toISOString() });
  assert.equal(ui.mode(), 'progress');
  assert.equal(ui.percent(), '17');
  ui.advance(200);
  assert.equal(ui.percent(), '50');
  ui.event({ type: 'holdProgress', phase: 'cancel' });
  assert.equal(ui.mode(), 'hidden');
  assert.equal(ui.frames.size, 0);
  assert.deepEqual(ui.calls.map(call => call.method), ['app:bootstrap']);
});

test('full progress waits for main-process completion before showing the recording capsule', () => {
  const ui = overlayHarness();
  ui.event({ type: 'holdProgress', phase: 'start', thresholdMs: 550 });
  ui.advance(550);
  assert.equal(ui.percent(), '100');
  assert.equal(ui.mode(), 'progress');
  ui.advance(900);
  assert.equal(ui.mode(), 'progress');
  ui.event({ type: 'holdProgress', phase: 'complete' });
  assert.equal(ui.mode(), 'capsule');
  assert.deepEqual(ui.calls.map(call => call.method), ['app:bootstrap']);
});

test('active recording or paused sessions survive delayed preview cancellation and hide after saving', () => {
  const ui = overlayHarness();
  ui.event({ type: 'holdProgress', phase: 'start', thresholdMs: 550 });
  ui.event({ type: 'session', session: { state: 'recording', mode: 'hold', active: true } });
  ui.event({ type: 'holdProgress', phase: 'cancel' });
  assert.equal(ui.mode(), 'capsule');
  ui.event({ type: 'session', session: { state: 'paused', mode: 'manual', active: true } });
  ui.event({ type: 'holdProgress', phase: 'cancel' });
  assert.equal(ui.mode(), 'card');
  assert.equal(ui.nodes.get('#capsule-logo').getAttribute('aria-label'), '继续录音');
  ui.event({ type: 'holdProgress', phase: 'complete' });
  ui.event({ type: 'session', session: { state: 'saved', active: false } });
  assert.equal(ui.mode(), 'hidden');
});

for (const triggerKey of ['F8', 'F9', 'F10']) {
  test(`${triggerKey} first-hold UI names the actual trigger and continued recording becomes hands-free`, () => {
    const ui = overlayHarness();
    ui.event({ type: 'holdProgress', phase: 'start', thresholdMs: 550, triggerKey });
    assert.match(ui.nodes.get('#hold-progress').getAttribute('aria-label'), new RegExp(triggerKey));
    ui.event({ type: 'session', session: { state: 'recording', mode: 'hold', active: true, triggerKey } });
    assert.match(ui.nodes.get('#recording-capsule').getAttribute('aria-label'), new RegExp(`松开 ${triggerKey}`));
    assert.equal(ui.nodes.get('#capsule-logo').disabled, false);
    ui.event({ type: 'session', session: { state: 'paused', mode: 'manual', active: true, triggerKey } });
    assert.equal(ui.nodes.get('#capsule-logo').getAttribute('aria-label'), '继续录音');
    ui.event({ type: 'session', session: { state: 'recording', mode: 'manual', active: true, triggerKey } });
    assert.match(ui.nodes.get('#recording-capsule').getAttribute('aria-label'), /点击暂停/u);
    assert.equal(ui.nodes.get('#capsule-logo').getAttribute('aria-label'), '暂停录音');
    assert.deepEqual(ui.calls.map(call => call.method), ['app:bootstrap']);
  });
}

async function rendererHarness(options = {}) {
  const dom = createDOM();
  for(const [id,view] of [['open-notes','notes'],['open-drafts','drafts'],['open-chat','chat']]) { const item=dom.document.querySelector('#'+id);item.id=id;item.tag='button';item.dataset={view};item.className='rail-button nav-item'; }
  // Mirror the static library shell so reparenting is tested against real ancestry.
  const shell = id => { const item = dom.document.querySelector('#' + id); item.id = id; return item; };
  const attach = (parent, ...ids) => ids.forEach(id => shell(parent).append(shell(id)));
  dom.document.body.append(shell('record-column')); dom.document.body.append(shell('inbox-view'));
  attach('record-column', 'record-column-header');
  attach('inbox-view', 'collection-toolbar', 'library-filters', 'library-feedback', 'record-feedback', 'collection-body', 'load-more');
  attach('collection-toolbar', 'back-to-group-home', 'collection-heading', 'record-count', 'search-input');
  attach('library-filters', 'library-filter-trigger', 'batch-organize', 'cancel-batch', 'batch-status', 'cancel-search');
  attach('library-filters', 'library-display-controls'); attach('library-display-controls', 'library-display-grid', 'library-display-list');
  attach('library-feedback', 'library-status', 'retry-library');
  attach('collection-body', 'record-grid-host', 'record-detail'); attach('record-grid-host', 'record-list');
  const calls = [];
  const openedNoteIds = [];
  const confirmations = [];
  const cloud = { shown: [], hidden: 0 };
  const menus = []; const pickers = []; const filterPanels = [];
  const images = { active: null, async close({ owner } = {}) {
    if (owner !== undefined && owner !== this.active?.owner) return true;
    const image = this.active; this.active = null; image?.onClose(); return true;
  }, open(image) { if (this.active) return false; this.active = image; return true; }, isOpen() { return Boolean(this.active); }, isDirty() { return false; } };
  let listener;
  const timers = new Map(); let timerId = 0;
  let savedSettings = { ...options.settings };
  const deletedRecordIds = new Set();
  const record = {
    id: 'fixture-record', title: '临时显示标题', editableTitle: '', task: '',
    createdAt: Date.parse('2026-10-16T10:00:00.000Z'), transcript: '第一段\n第二段', jobs: [], topicIds: [], version: 1,
    audioSegments: [{ id: 'fixture-segment-1', transcript: '第一段' }, { id: 'fixture-segment-2', transcript: '第二段' }],
    ...options.record,
  };
  const records = options.records || [record];
  const bootstrap = () => ({ records: records.filter(item => !deletedRecordIds.has(item.id)).slice(0, 30), recordHeaders: records.filter(item => !deletedRecordIds.has(item.id)), recordCount: records.filter(item => !deletedRecordIds.has(item.id)).length, drafts: options.drafts || [], topics: options.topics || [], duplicateSuggestions: options.duplicateSuggestions || [], groups: options.groups || [], settings: savedSettings, capabilities: {}, session: options.session || null });
  const context = runUIScript('src/renderer/app.js', {
    document: dom.document,
    window: { localStorage: options.localStorage, InMomentNoteImageViewer: images, InMomentAIProviders: require('../src/shared/ai-providers.js').PROVIDERS, InMomentConfirm: { async open(value) { confirmations.push(value); return options.confirm ? options.confirm(value) : true; } }, InMomentMenus: { async open(value) { menus.push(value); return options.menu ? options.menu(value) : null; } }, InMomentGroupPicker: { async open(value) { pickers.push(value); return options.groupPicker ? options.groupPicker(value) : null; } }, InMomentCloud: { show(value) { cloud.shown.push(value); }, hide() { cloud.hidden += 1; } }, InMomentDialogs: { open: false, async confirm(value) { confirmations.push(value); return options.confirm ? options.confirm(value) : true; }, remote(value) { calls.push({ method: 'test:remoteDialog', params: value }); }, cancelRemote(id) { calls.push({ method: 'test:cancelRemote', params: { id } }); } }, inmoment: {
      subscribe(callback) { listener = callback; },
      async invoke(method, params) {
        calls.push({ method, params });
        if (options.invokeHook) { const override = options.invokeHook(method, params); if (override !== undefined) return override; }
        if (method === 'app:bootstrap') return bootstrap();
        if (method === 'records:get') return [...records.filter(item => !deletedRecordIds.has(item.id)), ...(options.drafts || [])].find(item => item.id === params.id) || null;
        if (method === 'records:update') { const target=records.find(item=>item.id===params.id); if(Object.hasOwn(params,'title')){target.title=params.title;target.editableTitle=params.title;} if(Object.hasOwn(params,'transcript')){target.transcript=params.transcript;target.hasTranscriptOverride=true;} target.version=(target.version||1)+1;return target; }
        if (method === 'records:list' || method === 'records:search') { const filters = params.filters || {}; const current = records.filter(item => !deletedRecordIds.has(item.id)).filter(item => { const topicIds = item.topicIds || item.topics?.map(topic => topic.id) || []; const created = typeof item.createdAt === 'number' ? item.createdAt : Date.parse(item.createdAt); return (filters.from === undefined || created >= filters.from) && (filters.to === undefined || created < filters.to) && (!filters.topicIds?.length && !filters.uncategorized || filters.uncategorized && !topicIds.length || filters.topicIds?.some(id => topicIds.includes(id))); }); return { records: current.slice(params.offset || 0, (params.offset || 0) + (params.limit || 20)), total: current.length, scopeTotal: current.length, offset: params.offset || 0, limit: params.limit || 20 }; }
        if (method === 'records:delete') { deletedRecordIds.add(params.id); return { deleted: true }; }
        if (method === 'records:organize') return { cancelled: true };
        if (method === 'records:aiSearch') return { records: [record], total: 1, scopeTotal: records.length, candidateCount: 1, coverage: { examinedCount: 1 }, explanation: '模拟相关记录' };
        if (method === 'library:duplicates') return { suggestions: options.duplicateSuggestions || [], groups: options.groups || [], scopeTotal: records.length, candidateCount: records.length, coverage: { examinedCount: 2, examinedPairCount: 1 }, usage: { total_tokens: 50 } };
        if (method === 'image:readRecord') { if (options.readImageError) throw new Error(options.readImageError); return { mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }; }
        if (method === 'records:revealScreenshot') { if (options.revealError) throw new Error(options.revealError); return { revealed: true }; }
        if (method === 'settings:save') {
          const catalog = require('../src/shared/ai-providers.js').PROVIDERS, previousProvider = savedSettings.aiProvider || 'deepseek';
          const profiles = Object.fromEntries(Object.values(catalog).map(provider => [provider.id,{ model:savedSettings.aiProfiles?.[provider.id]?.model || (provider.id === previousProvider ? savedSettings.model : '') || provider.defaultModel, hasApiKey:Boolean(savedSettings.aiProfiles?.[provider.id]?.hasApiKey ?? (provider.id === previousProvider && savedSettings.hasApiKey)) }]));
          for (const [id,profile] of Object.entries(params.aiProfiles || {})) profiles[id] = { model:profile.model || profiles[id].model, hasApiKey:Boolean(profile.apiKey || profiles[id].hasApiKey) };
          const active = params.aiProvider || previousProvider; savedSettings = { ...savedSettings, ...params, aiProvider:active, aiProfiles:profiles, model:profiles[active].model, hasApiKey:profiles[active].hasApiKey }; return savedSettings;
        }
        if (method === 'settings:reset') {
          const result = options.resetResult ?? { thresholdMs: 550, previewDelayMs: 0, captureDelayMs: 0, menuDelayMs: 0, keyboardTrigger: 'none', inputEnabled: true, captureScreenshots: true, cloudEnabled: false, autoTitleEnabled: false, model: 'deepseek-flash', excludedApps: [], hasApiKey: savedSettings.hasApiKey };
          if (!result.cancelled) savedSettings = result;
          return result;
        }
        if (method === 'settings:get') return savedSettings;
        return {};
      },
    } },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout(id) { timers.delete(id); }, fixtureRecord: record,
  });
  context.window.InMomentFilters = { async open(value) { filterPanels.push(value); return options.filters ? options.filters(value) : null; }, close() {} };
  context.window.InMomentNotesView = class {
    show() {}
    hide() {}
    listItem() { return null; }
    async selectTopic(id) { this.topicId = id; }
    focusSearch() { context.document.querySelector('#notes-query').focus(); }
    shortcut() { return false; }
    open(id) { openedNoteIds.push(id); return options.openNote?.(id); }
  };
  if (!options.notebook) vm.runInContext("state.view = 'inbox'", context);
  // Settle initial bootstrap before selecting the fixture; no wall-clock waits.
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  if (options.select !== false) vm.runInContext("state.selectedId = fixtureRecord.id; state.libraryMode = 'detail'; updateLibraryLayout(); renderDetail(fixtureRecord);", context);
  return {
    ...dom, calls, record, records, timers, confirmations, cloud, menus, pickers, filterPanels, deletedRecordIds, openedNoteIds, images,
    run(source) { return vm.runInContext(source, context); },
    async flush() { for (let index = 0; index < 30; index += 1) await Promise.resolve(); },
    async event(event) { listener(event); for (let index = 0; index < 30; index += 1) await Promise.resolve(); },
    async input(selector, value) { const target = dom.nodes.get(selector); assert(target, selector); for (let ancestor = target; ancestor; ancestor = ancestor.parentElement) assert(!ancestor.classList.contains('hidden'), 'open the editor before changing ' + selector); target.value = value; await dom.emit(target, 'input'); },
    async edit() { const original = [...dom.created].reverse().find(item => item.isConnected && item.getAttribute('data-action') === 'show-original'); if (original) await dom.emit(original, 'click'); const target = [...dom.created].reverse().find(item => item.isConnected && item.tag === 'button' && item.getAttribute('data-action') === 'edit-record'); assert(target, 'edit action'); await dom.emit(target, 'click'); },
    async rename() { const target = [...dom.created].reverse().find(item => item.isConnected && item.getAttribute('data-action') === 'rename-record'); assert(target); await dom.emit(target, 'click'); },
    expand(kind) { const target = [...dom.created].reverse().find(item => item.isConnected && item.getAttribute('data-disclosure') === kind); assert(target, 'material ' + kind); if (target.tag === 'details') target.open = true; return target; },
    async click(text) {
      const target = [...dom.created].reverse().find(item => item.isConnected && item.tag === 'button' && item.textContent === text);
      assert(target, `button ${text}`); await dom.emit(target, 'click');
    },
    async suggest(name) { const target = [...dom.created].reverse().find(item => item.isConnected && item.getAttribute('data-topic-suggestion-name') === name); assert(target, 'group suggestion ' + name); await dom.emit(target, 'click'); },
    async clickLabel(label) { const target = [...dom.created].reverse().find(item => item.isConnected && item.tag === 'button' && item.getAttribute('aria-label') === label); assert(target, 'button label ' + label); await dom.emit(target, 'click'); },
    async clickSelector(selector) { const target = dom.nodes.get(selector); assert(target, selector); if (target.tag === 'input' && target.type === 'checkbox') { if (target.disabled) return; target.checked = !target.checked; target.indeterminate = false; await dom.emit(target,'click'); await dom.emit(target,'change'); } else await dom.emit(target, 'click'); },
    async submitSettings() { await dom.emit(dom.nodes.get('#settings-form'), 'submit', { submitter: dom.element('button') }); },
    async submitAISearch() { await dom.emit(dom.nodes.get('#ai-search-form'), 'submit'); },
    latestUpdate() { return calls.filter(call => call.method === 'records:update').at(-1)?.params; },
  };
}

test('the recording guide has one persistent help action directly above settings', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const rail = html.match(/<aside class="icon-rail"[\s\S]*?<\/aside>/u)?.[0];
  assert.ok(rail, 'the main rail is present');
  assert.equal((html.match(/id="open-guide"/gu) || []).length, 1);
  assert.match(rail, /id="open-guide"[^>]*class="rail-button [^"]*\brail-help\b[^"]*"[^>]*aria-label="录音说明"[^>]*data-ui-icon="help"[^>]*aria-controls="guide-dialog"[^>]*><\/button>\s*<button[^>]*rail-settings/u);
  assert.doesNotMatch(html, /guide-button/u);
  assert.match(html, /按住右键，等进度条填满/u);
  assert.match(html, /后续无需按住，点击左侧暂停图标暂停这一段/u);
});

test('main rail provides notes and chat with help and settings anchored at the bottom', () => {
  const html=fs.readFileSync(path.join(__dirname,'../src/renderer/index.html'),'utf8'),css=fs.readFileSync(path.join(__dirname,'../src/renderer/styles.css'),'utf8');
  const rail=html.match(/<aside class="icon-rail"[\s\S]*?<\/aside>/u)[0];
  assert.match(rail,/id="open-notes"[^>]*data-view="notes"[^>]*data-ui-icon="edit"/u);
  assert.match(rail,/id="open-drafts"[^>]*data-view="drafts"/u);
  assert.doesNotMatch(rail,/data-view="(?:inbox|duplicates)"|id="start-recording"|aria-label="手动录音"/u);
  assert.ok(rail.indexOf('id="open-notes"')<rail.indexOf('id="open-chat"'));
  assert.ok(rail.indexOf('id="open-chat"')<rail.indexOf('id="open-guide"'));
  assert.match(css,/\.icon-rail \{[^}]*gap:6px/u);
  assert.match(css,/\.rail-button\.rail-help\s*\{[^}]*margin-top:\s*auto/u);
});

test('notes open at startup and the notebook rail leaves chat through its preparation hook',async()=>{
  const ui=await rendererHarness({select:false,notebook:true});
  assert.equal(ui.run('state.view'),'notes');
  ui.run("chatView={currentId:'retained-chat',prepareToLeave:async()=>{globalThis.chatWasPrepared=true;}};showView('chat',{skipChatOpen:true});");
  await ui.clickSelector('#open-notes');
  assert.equal(ui.run('chatWasPrepared'),true);assert.equal(ui.run('state.view'),'notes');
  assert.equal(ui.nodes.get('#open-notes').getAttribute('aria-current'),'page');assert.equal(ui.document.body.classList.contains('chat-open'),false);
  assert.equal(ui.run('chatView.currentId'),'retained-chat');assert.equal(ui.calls.some(call=>['chat:close','chat:delete','draft:startManual'].includes(call.method)),false);
});

for (const view of ['drafts', 'duplicates', 'settings', 'chat']) {
  test(`switching from the open group drawer to ${view} releases its backdrop`, async () => {
    const ui = await rendererHarness({ select: false });
    ui.run("setGroupSidebar(true)"); assert.equal(ui.document.body.classList.contains('group-sidebar-open'), true);
    ui.run(`showView('${view}', { skipChatOpen: true })`);
    assert.equal(ui.run('state.view'), view); assert.equal(ui.document.body.classList.contains('group-sidebar-open'), false);
  });
}
test('refreshing the current page keeps its group drawer open', async () => {
  const ui = await rendererHarness({ select: false }); ui.run("setGroupSidebar(true);showView('inbox')");
  assert.equal(ui.document.body.classList.contains('group-sidebar-open'), true);
});
test('folding the desktop group column preserves searches and remains available after a page switch', async () => {
  const ui = await rendererHarness({ select: false, notebook: true });
  const button = ui.document.querySelector('#fold-notebook-groups');
  const groupQuery = ui.document.querySelector('#group-search');
  const noteQuery = ui.document.querySelector('#notes-query');
  ui.document.querySelector('#notebook-group-content').append(groupQuery);
  groupQuery.value = '资料';
  noteQuery.value = '笔记';
  groupQuery.focus();
  await ui.clickSelector('#fold-notebook-groups');
  assert.equal(ui.document.body.classList.contains('notebook-groups-collapsed'), true);
  assert.equal(ui.document.activeElement, button);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(button.getAttribute('aria-label'), '展开分组栏');
  ui.run("showView('settings');showView('notes')");
  assert.equal(ui.document.body.classList.contains('notebook-groups-collapsed'), true);
  await ui.clickSelector('#fold-notebook-groups');
  assert.equal(ui.document.body.classList.contains('notebook-groups-collapsed'), false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(button.getAttribute('aria-label'), '收起分组栏');
  assert.equal(groupQuery.value, '资料');
  assert.equal(noteQuery.value, '笔记');
});

test('the help action opens and closes the guide without capture or settings requests from any page', async () => {
  const ui = await rendererHarness();
  for (const view of ['inbox', 'settings', 'duplicates', 'drafts']) {
    ui.run(`showView('${view}')`); const before = ui.calls.length;
    await ui.clickSelector('#open-guide');
    assert.equal(ui.nodes.get('#guide-dialog').open, true);
    assert.equal(ui.nodes.get('#open-guide').getAttribute('aria-expanded'), 'true');
    await ui.clickSelector('#guide-done');
    assert.equal(ui.nodes.get('#guide-dialog').open, false);
    assert.equal(ui.nodes.get('#open-guide').getAttribute('aria-expanded'), 'false');
    assert.equal(ui.calls.length, before);
  }
  await ui.clickSelector('#open-guide'); await ui.clickSelector('#close-guide');
  assert.equal(ui.nodes.get('#open-guide').getAttribute('aria-expanded'), 'false');
  await ui.clickSelector('#open-guide'); const guide = ui.nodes.get('#guide-dialog'); guide.close(); await ui.emit(guide, 'close');
  assert.equal(ui.nodes.get('#open-guide').getAttribute('aria-expanded'), 'false', 'Escape/native close resets the trigger');
  await ui.clickSelector('#open-guide'); await ui.clickSelector('#close-guide'); await ui.clickSelector('#open-guide'); await ui.emit(guide, 'close');
  assert.equal(ui.nodes.get('#open-guide').getAttribute('aria-expanded'), 'true', 'a delayed close event keeps a reopened guide active');
  assert.equal(ui.nodes.has('#guide-button'), false, 'no hidden legacy guide action is bound');
  assert.equal(ui.nodes.has('#start-recording'), false, 'startup does not bind the removed recording action');
});

test('an empty collection retains its recording hint without adding a second guide action', async () => {
  const ui = await rendererHarness({ records: [], select: false });
  const empty = ui.nodes.get('#record-list').children[0];
  assert.ok(empty.children.some(item => item.textContent === '按住右键留下想法，无须先分类。'));
  assert.equal(empty.children.some(item => item.tag === 'button'), false);
  assert.equal(ui.created.some(item => item.textContent === '了解捕捉方式'), false);
});

test('a multi-segment record edits as one exact transcript without touching metadata or segment history', async () => {
  const ui = await rendererHarness();
  assert.equal(ui.nodes.get('#field-记录标题').value, '临时显示标题');
  await ui.edit();
  await ui.input('#record-transcript-input', ' 第一段的修订\n\n第二段的修订文字\n');
  await ui.clickLabel('保存语音文本');
  const update = ui.latestUpdate();
  assert.equal(Object.hasOwn(update, 'title'), false);
  assert.equal(update.transcript, ' 第一段的修订\n\n第二段的修订文字\n');
  assert.equal(Object.hasOwn(update, 'task'), false); assert.equal(Object.hasOwn(update, 'transcriptSegments'), false); assert.equal(update.expectedVersion, 1);
  assert.deepEqual(ui.record.audioSegments.map(s=>s.transcript), ['第一段','第二段']);
});

test('inline title and transcript actions carry confirmation and cancellation semantics without coloring ordinary closes',async()=>{
  const ui=await rendererHarness();await ui.rename();await ui.edit();
  for(const[label,semantic]of[['保存标题','ui-confirm'],['保存语音文本','ui-confirm'],['取消重命名','ui-cancel'],['取消语音文本编辑','ui-cancel']]){
    const control=[...ui.created].reverse().find(item=>item.isConnected&&item.getAttribute('aria-label')===label);
    assert.ok(control,label);assert.equal(control.classList.contains(semantic),true,label);assert.equal(control.classList.contains('hidden'),false,label);assert.equal(control.getAttribute('data-ui-icon'),semantic==='ui-confirm'?'check':'close');
  }
  for(const selector of ['#close-group-management','#close-guide'])assert.equal(ui.nodes.get(selector).classList.contains('ui-cancel'),false,selector);
  await ui.input('#field-记录标题','保留标题修改');await ui.input('#record-transcript-input','取消正文修改');await ui.clickLabel('取消语音文本编辑');
  assert.equal(ui.nodes.get('#field-记录标题').value,'保留标题修改');assert.equal(ui.run('state.detailDirty'),true);assert.equal(ui.confirmations.length,0);assert.equal(ui.calls.some(call=>call.method==='records:update'),false);
});

test('a deliberately edited manual title is included when saving', async () => {
  const ui = await rendererHarness();
  await ui.rename();
  await ui.input('#field-记录标题', '我填写的标题');
  await ui.clickLabel('保存标题');
  assert.equal(ui.latestUpdate().title, '我填写的标题');
});

test('title edits replace the heading in its row and reject only empty or whitespace titles',async()=>{
  const ui=await rendererHarness();await ui.rename();
  const row=ui.nodes.get('#record-detail').children[0].children.find(item=>item.classList.contains('record-title-row'));
  assert.equal(row.children.filter(item=>item.tag==='input').length,1);assert.equal(row.children.find(item=>item.tag==='h2').classList.contains('hidden'),true);
  assert.equal(ui.created.some(item=>item.isConnected&&item.classList.contains('inline-title-editor')),false);
  for(const value of ['', ' \t ']){await ui.input('#field-记录标题',value);await ui.clickLabel('保存标题');assert.equal(ui.calls.some(call=>call.method==='records:update'),false);assert.equal(ui.run('state.detailDirty'),true);}
  assert.equal(ui.created.some(item=>item.isConnected&&item.textContent==='标题不能为空'),true);
  await ui.input('#field-记录标题','。');await ui.clickLabel('保存标题');assert.equal(ui.latestUpdate().title,'。');assert.equal(ui.confirmations.length,0);
});

test('an explicit unchanged title save still checks its version and retains the field on conflict',async()=>{
  const ui=await rendererHarness({invokeHook(method){if(method==='records:update')throw new Error('记录已发生变化，请保留当前文字');}});await ui.rename();await ui.clickLabel('保存标题');
  assert.equal(ui.latestUpdate().title,'临时显示标题');assert.equal(ui.latestUpdate().expectedVersion,1);assert.equal(ui.nodes.get('#field-记录标题').classList.contains('hidden'),false);assert.equal(ui.nodes.get('#field-记录标题').value,'临时显示标题');assert.match(ui.nodes.get('#toast').textContent,/记录已发生变化/u);
});

test('two audio segments use one transcript field and save/reload exact newlines without changing history',async()=>{
  const ui=await rendererHarness();await ui.edit();const text='  第一行\n\n第二行  \n';
  assert.equal(ui.created.filter(item=>item.isConnected&&item.tag==='textarea'&&item.id==='record-transcript-input').length,1);
  assert.equal(ui.nodes.has('#field-当时正在做什么'),false);assert.equal(ui.nodes.has('#field-第1段表达'),false);
  await ui.input('#record-transcript-input',text);await ui.clickLabel('保存语音文本');
  assert.equal(ui.latestUpdate().transcript,text);assert.equal(ui.record.transcript,text);assert.equal(ui.record.hasTranscriptOverride,true);
  assert.deepEqual(ui.record.audioSegments.map(s=>s.transcript),['第一段','第二段']);
  const paragraph=ui.created.filter(item=>item.isConnected&&item.classList.contains('original-transcript')).at(-1);assert.equal(paragraph.textContent,text);
  await ui.edit();assert.equal(ui.nodes.get('#record-transcript-input').value,text);
});

test('an explicitly blank transcript remains blank even when notes and audio histories exist',async()=>{
  const ui=await rendererHarness({record:{notes:'不能作为空原文的回退'}});await ui.edit();await ui.input('#record-transcript-input','');await ui.clickLabel('保存语音文本');
  assert.equal(ui.record.transcript,'');assert.equal(ui.record.notes,'不能作为空原文的回退');assert.equal(ui.run('transcriptText(fixtureRecord)'), '');
  const paragraph=ui.created.filter(item=>item.isConnected&&item.classList.contains('original-transcript')).at(-1);assert.equal(paragraph.textContent,'');
});

test('saving original text keeps that text visible instead of switching back to an existing AI summary',async()=>{
  const ui=await rendererHarness({record:{organization:{summary:'已有摘要'}}});await ui.edit();await ui.input('#record-transcript-input','新原文\n\n保持换行');await ui.clickLabel('保存语音文本');
  const original=ui.created.filter(item=>item.isConnected&&item.classList.contains('text-panel-original')).at(-1),summary=ui.created.filter(item=>item.isConnected&&item.classList.contains('text-panel-summary')).at(-1);
  assert.equal(original.classList.contains('hidden'),false);assert.equal(summary.classList.contains('hidden'),true);assert.equal(ui.created.filter(item=>item.isConnected&&item.classList.contains('original-transcript')).at(-1).textContent,'新原文\n\n保持换行');
});

test('cancelling one inline editor preserves the other dirty field without confirmation',async()=>{
  const ui=await rendererHarness();await ui.edit();await ui.input('#record-transcript-input','尚未保存的原文');await ui.rename();await ui.input('#field-记录标题','待放弃的标题');await ui.clickLabel('取消重命名');
  assert.equal(ui.nodes.get('#record-transcript-input').value,'尚未保存的原文');assert.equal(ui.run('state.detailDirty'),true);assert.equal(ui.confirmations.length,0);
  await ui.clickLabel('取消语音文本编辑');assert.equal(ui.run('state.detailDirty'),false);assert.equal(ui.nodes.get('#record-transcript-input').value,'第一段\n第二段');assert.equal(ui.confirmations.length,0);
});

test('saving a title preserves dirty transcript text and advances its optimistic version',async()=>{
  const ui=await rendererHarness();await ui.edit();await ui.input('#record-transcript-input','另一处仍待保存');await ui.rename();await ui.input('#field-记录标题','新标题');await ui.clickLabel('保存标题');
  assert.equal(ui.nodes.get('#record-transcript-input').value,'另一处仍待保存');assert.equal(ui.run('state.detailDirty'),true);assert.equal(Object.hasOwn(ui.latestUpdate(),'transcript'),false);
  await ui.clickLabel('保存语音文本');assert.equal(ui.latestUpdate().expectedVersion,2);assert.equal(ui.latestUpdate().transcript,'另一处仍待保存');assert.equal(Object.hasOwn(ui.latestUpdate(),'task'),false);
});

test('simultaneous title and text saves serialize their expected versions without losing either edit',async()=>{
  const gate=deferred();let first=true;const ui=await rendererHarness({invokeHook(method,params){if(method!=='records:update')return;return(first?(first=false,gate.promise):Promise.resolve()).then(()=>({version:params.expectedVersion+1}));}});
  await ui.edit();await ui.input('#record-transcript-input','共同保存的原文');await ui.rename();await ui.input('#field-记录标题','共同保存的标题');
  const title=ui.clickLabel('保存标题');await ui.flush();const text=ui.clickLabel('保存语音文本');await ui.flush();assert.equal(ui.calls.filter(call=>call.method==='records:update').length,1);
  gate.resolve();await Promise.all([title,text]);const updates=ui.calls.filter(call=>call.method==='records:update');assert.equal(updates[0].params.expectedVersion,1);assert.equal(updates[1].params.expectedVersion,2);assert.equal(updates[1].params.transcript,'共同保存的原文');assert.equal(ui.run('state.detailDirty'),false);
});

for (const savedKind of ['title', 'transcript']) for (const openedKind of ['title', 'transcript']) {
  test(`a delayed ${savedKind} post-save refresh preserves a newly reopened ${openedKind} editor`, async () => {
    const gate = deferred(); let delay = false; let ui;
    ui = await rendererHarness({ invokeHook(method) { if (delay && method === 'app:bootstrap') return gate.promise; } });
    if (savedKind === 'title') { await ui.rename(); await ui.input('#field-记录标题', '已提交的标题'); }
    else { await ui.edit(); await ui.input('#record-transcript-input', ''); }
    delay = true;
    const saving = ui.clickLabel(savedKind === 'title' ? '保存标题' : '保存语音文本'); await ui.flush();
    if (openedKind === 'title') await ui.rename(); else await ui.edit();
    const input = ui.nodes.get(openedKind === 'title' ? '#field-记录标题' : '#record-transcript-input');
    await ui.input(openedKind === 'title' ? '#field-记录标题' : '#record-transcript-input', '刚刚打开后的输入');
    gate.resolve({ records: [ui.record], recordHeaders: [ui.record], recordCount: 1, drafts: [], topics: [], settings: {} });
    await saving; await ui.flush();
    assert.equal(input.isConnected, true); assert.equal(input.classList.contains('hidden'), false);
    assert.equal(input.value, '刚刚打开后的输入'); assert.equal(ui.run('state.editingId'), ui.record.id);
    assert.equal(ui.nodes.get(openedKind === 'title' ? '#field-记录标题' : '#record-transcript-input'), input);
  });
}

test('the transcript Escape action cancels only its text editor without confirmation',async()=>{
  const ui=await rendererHarness();await ui.rename();await ui.input('#field-记录标题','保留这个标题草稿');await ui.edit();await ui.input('#record-transcript-input','放弃这段修改');await ui.emit(ui.nodes.get('#record-transcript-input'),'keydown',{key:'Escape'});
  assert.equal(ui.nodes.get('#record-transcript-input').value,'第一段\n第二段');assert.equal(ui.nodes.get('#field-记录标题').value,'保留这个标题草稿');assert.equal(ui.run('state.detailDirty'),true);assert.equal(ui.confirmations.length,0);
});

test('an owned paused recording offers a direct return to its chat without deletion',async()=>{
  const ui=await rendererHarness({session:{id:'owned-draft',active:true,state:'paused',chatOwnerId:'retained-chat'}});
  const button=ui.nodes.get('#session-return-chat');assert.equal(button.classList.contains('hidden'),false);await ui.clickSelector('#session-return-chat');
  assert.deepEqual(ui.calls.filter(call=>call.method==='chat:openFloating').map(call=>call.params.id),['retained-chat']);assert.equal(ui.calls.some(call=>['draft:discard','chat:delete','chat:close'].includes(call.method)),false);
});

test('chat voice capture keeps session ownership but hides the unrelated manual-recording banner',async()=>{
  const ui=await rendererHarness({select:false});
  for(const status of ['preparing','recording','paused','error']){
    await ui.event({type:'session',session:{id:'voice-draft',state:status,active:true,mode:'manual',captureOrigin:'chatVoice',captureWindow:'main',chatOwnerId:'current-chat'}});
    assert.equal(ui.nodes.get('#session-banner').classList.contains('hidden'),true,status);assert.equal(ui.nodes.get('#session-return-chat').classList.contains('hidden'),true,status);assert.equal(ui.run('state.session.id'),'voice-draft');
  }
  await ui.event({type:'session',session:{id:'normal-draft',state:'recording',active:true,mode:'manual'}});assert.equal(ui.nodes.get('#session-banner').classList.contains('hidden'),false);
});

test('source focus feedback uses the temporary floating notification region',async()=>{
  const ui=await rendererHarness();await ui.event({type:'sourceFocusNotice',message:'原窗口已关闭，录音仍保留。',reason:'closed',durationMs:5000});
  const notice=ui.nodes.get('#toast');assert.equal(notice.textContent,'原窗口已关闭，录音仍保留。');assert.equal(notice.getAttribute('role'),'status');assert.equal(notice.classList.contains('hidden'),false);assert.equal(notice.classList.contains('persistent-error'),false);
  assert.notEqual(ui.nodes.get('#record-feedback').textContent,notice.textContent);[...ui.timers.values()].at(-1)();assert.equal(notice.classList.contains('hidden'),true);
});

test('organizing saves the unified transcript without submitting an untouched title', async () => {
  const ui = await rendererHarness();
  await ui.edit();
  await ui.input('#record-transcript-input', '第一段的新想法');
  await ui.click('AI 总结');
  const update = ui.latestUpdate();
  assert.equal(Object.hasOwn(update, 'title'), false);
  assert.equal(update.transcript,'第一段的新想法'); assert.equal(Object.hasOwn(update,'transcriptSegments'),false);
  assert.equal(ui.calls.filter(call => call.method === 'records:organize').length, 1);
});

test('timing settings show cumulative preview/confirmation times and take effect only on explicit save', async () => {
  const ui = await rendererHarness();
  await ui.input('#preview-delay-input', '1000');
  await ui.input('#threshold-input', '1500');
  await ui.input('#capture-delay-input', '300');
  await ui.input('#menu-delay-input', '400');
  await ui.input('#keyboard-trigger-input', 'F9');
  const timeline = ui.nodes.get('#timing-timeline').textContent;
  assert.match(timeline, /右键或 F9/u);
  assert.match(timeline, /1000 ms 显示进度条 → 2500 ms 确认触发/u);
  assert.match(timeline, /再等 300 ms 截图 → 截图处理后再等 400 ms 显示录音胶囊/u);
  assert.equal(ui.calls.filter(call => call.method === 'settings:save').length, 0);
  await ui.submitSettings();
  const save = ui.calls.find(call => call.method === 'settings:save').params;
  assert.equal(save.previewDelayMs, 1000); assert.equal(save.thresholdMs, 1500);
  assert.equal(save.captureDelayMs, 300); assert.equal(save.menuDelayMs, 400);
  assert.equal(save.keyboardTrigger, 'F9'); assert.equal(save.inputEnabled, true);
});

test('the screenshot recording shortcut shows the candidate, keeps an inline collision, and applies a successful change immediately', async () => {
  const ui = await rendererHarness({ invokeHook: method => method === 'settings:shortcutCapture' ? true : undefined });
  ui.run("showView('settings')");
  const field = ui.nodes.get('#region-shortcut-input');
  const value = ui.nodes.get('#region-shortcut-value');
  const feedback = ui.document.querySelector('#region-shortcut-error');
  const guide = ui.nodes.get('#region-shortcut-guide');
  assert.equal(value.textContent, 'Ctrl+Shift+F9');
  assert.equal(field.getAttribute('aria-pressed'), 'false');
  await ui.input('#threshold-input', '1600');
  field.focus();
  await ui.clickSelector('#region-shortcut-input');
  const armed = ui.calls.find(call => call.method === 'settings:shortcutCapture').params;
  assert.equal(armed.active, true);
  assert.ok(Number.isSafeInteger(armed.captureId));
  assert.equal(field.getAttribute('aria-pressed'), 'true');
  assert.match(value.textContent, /请按下组合键/u);

  const captureEvent = { type: 'regionShortcutCapture', id: armed.captureId };
  await ui.event({ ...captureEvent, candidate: 'Ctrl+Alt+F8' });
  assert.equal(value.textContent, 'Ctrl+Alt+F8');
  assert.match(guide.textContent, /Ctrl\+Shift\+F9/u);
  await ui.event({ ...captureEvent, error: 'Ctrl+Alt+F8 已被占用。' });
  assert.equal(field.getAttribute('aria-pressed'), 'true');
  assert.equal(field.getAttribute('aria-invalid'), 'true');
  assert.equal(ui.document.activeElement, field);
  assert.equal(feedback.classList.contains('hidden'), false);
  assert.match(feedback.textContent, /已被占用/u);
  assert.match(guide.textContent, /Ctrl\+Shift\+F9/u);

  await ui.event({ ...captureEvent, candidate: 'Ctrl+Alt+F7' });
  assert.equal(value.textContent, 'Ctrl+Alt+F7');
  assert.equal(field.getAttribute('aria-invalid'), undefined);
  assert.equal(feedback.classList.contains('hidden'), true);
  await ui.event({ ...captureEvent, done: true, shortcut: 'Ctrl+Alt+F7', status: { shortcut: 'Ctrl+Alt+F7', available: true, error: '' } });
  assert.equal(field.getAttribute('aria-pressed'), 'false');
  assert.equal(value.textContent, 'Ctrl+Alt+F7');
  assert.match(guide.textContent, /Ctrl\+Alt\+F7/u);
  assert.equal(ui.nodes.get('#threshold-input').value, '1600');
  assert.equal(ui.run('state.settingsDirty'), true);
  assert.equal(ui.calls.filter(call => call.method === 'settings:save').length, 0);
});

test('blurring the shortcut recorder cancels its session and late preview and error events cannot alter a new session', async () => {
  const ui = await rendererHarness({ invokeHook: method => method === 'settings:shortcutCapture' ? true : undefined });
  ui.run("showView('settings')");
  const field = ui.nodes.get('#region-shortcut-input');
  const value = ui.nodes.get('#region-shortcut-value');
  const feedback = ui.document.querySelector('#region-shortcut-error');
  const latestCapture = () => ui.calls.filter(call => call.method === 'settings:shortcutCapture').at(-1).params;
  await ui.clickSelector('#region-shortcut-input');
  const previousId = latestCapture().captureId;
  const lateEvent = { type: 'regionShortcutCapture', id: previousId };
  await ui.event({ ...lateEvent, candidate: 'Ctrl+Alt+F8' });
  await ui.emit(field, 'blur');
  assert.deepEqual({ ...latestCapture() }, { active: false, captureId: previousId });
  assert.equal(field.getAttribute('aria-pressed'), 'false');
  assert.equal(value.textContent, 'Ctrl+Shift+F9');
  await ui.clickSelector('#region-shortcut-input');
  assert.notEqual(latestCapture().captureId, previousId);
  await ui.event({ ...lateEvent, candidate: 'Ctrl+Alt+F8' });
  await ui.event({ ...lateEvent, done: true, error: '旧请求失败' });
  assert.equal(field.getAttribute('aria-pressed'), 'true');
  assert.match(value.textContent, /请按下组合键/u);
  assert.equal(feedback.classList.contains('hidden'), true);
});

test('restoring timing defaults changes the form without saving or clearing unrelated settings', async () => {
  const ui = await rendererHarness();
  await ui.input('#preview-delay-input', '1000'); await ui.input('#threshold-input', '2500');
  await ui.input('#capture-delay-input', '600'); await ui.input('#menu-delay-input', '900');
  await ui.input('#keyboard-trigger-input', 'F10');
  ui.nodes.get('#auto-title-enabled').checked = true;
  ui.nodes.get('#capture-screenshots').checked = false;
  await ui.clickSelector('#reset-timing');
  assert.equal(Number(ui.nodes.get('#preview-delay-input').value), 0);
  assert.equal(Number(ui.nodes.get('#threshold-input').value), 550);
  assert.equal(Number(ui.nodes.get('#capture-delay-input').value), 0);
  assert.equal(Number(ui.nodes.get('#menu-delay-input').value), 0);
  assert.equal(ui.nodes.get('#keyboard-trigger-input').value, 'none');
  assert.equal(ui.nodes.get('#auto-title-enabled').checked, true);
  assert.equal(ui.nodes.get('#capture-screenshots').checked, false);
  assert.match(ui.nodes.get('#timing-result').textContent, /保存后生效/u);
  assert.equal(ui.calls.filter(call => call.method === 'settings:save').length, 0);
});

test('timing validation accepts the extended threshold range and rejects out-of-range stage delays', async () => {
  const ui = await rendererHarness();
  await ui.input('#threshold-input', '10000');
  await ui.input('#preview-delay-input', '5000');
  await ui.input('#capture-delay-input', '5000');
  await ui.input('#menu-delay-input', '5000');
  await ui.submitSettings();
  assert.equal(ui.calls.filter(call => call.method === 'settings:save').length, 1);
  await ui.input('#menu-delay-input', '5001');
  await ui.submitSettings();
  assert.equal(ui.calls.filter(call => call.method === 'settings:save').length, 1);
  assert.match(ui.nodes.get('#toast').textContent, /菜单展开等待请填写 0–5000/u);
});

const screenshotFixture = 'inmoment-media://record/fixture-record/image/fixture-image';

test('record screenshot opens the shared viewer using verified original bytes without editing the record', async () => {
  const ui = await rendererHarness({ record: { screenshotUrl: screenshotFixture } });
  ui.expand('context');
  await ui.click('查看 PNG 原图');
  const image = ui.images.active;
  assert.equal(image.url, screenshotFixture);
  assert.equal(image.name, '来源窗口截图');
  assert.equal(typeof image.invoke, 'function');
  assert.equal(image.replaceImage, undefined);
  assert.equal(image.insertText, undefined);
  const original = await image.readImage();
  assert.equal(original.mime, 'image/png');
  assert.deepEqual([...original.bytes], [1, 2, 3]);
  assert.deepEqual(ui.calls.filter(call => call.method === 'image:readRecord').map(call => call.params.id), ['fixture-record']);
  await ui.images.close();
  assert.equal(ui.images.active, null);
});

test('record thumbnail opens the same viewer and remembers the focus return target', async () => {
  const ui = await rendererHarness({ record: { screenshotUrl: screenshotFixture } });
  const thumbnail = ui.created.find(element => element.classList.contains('screenshot-thumbnail-button'));
  assert(thumbnail);
  await ui.emit(thumbnail, 'click');
  assert.equal(ui.images.active.opener, thumbnail);
});

test('both screenshot folder buttons use the saved record ID', async () => {
  const ui = await rendererHarness({ record: { screenshotUrl: screenshotFixture } });
  await ui.click('打开图片所在文件夹');
  ui.expand('context');
  await ui.click('查看 PNG 原图');
  await ui.images.active.revealImage();
  const reveals = ui.calls.filter(call => call.method === 'records:revealScreenshot');
  assert.equal(reveals.length, 2);
  for (const reveal of reveals) assert.equal(reveal.params.id, 'fixture-record');
});

test('records without screenshots have no image actions; original read errors reach the shared viewer', async () => {
  const empty = await rendererHarness();
  assert.equal(empty.created.some(element => element.textContent === '查看 PNG 原图'), false);
  assert.equal(empty.created.some(element => element.textContent === '打开图片所在文件夹'), false);
  const ui = await rendererHarness({ record: { screenshotUrl: screenshotFixture }, readImageError: '截图文件已不存在。' });
  ui.expand('context');
  await ui.click('查看 PNG 原图');
  await assert.rejects(ui.images.active.readImage(), /截图文件已不存在/u);
});

test('deleting the viewed record closes its shared image viewer', async () => {
  const ui = await rendererHarness({ record: { screenshotUrl: screenshotFixture } });
  ui.expand('context');
  await ui.click('查看 PNG 原图');
  assert(ui.images.active);
  await ui.click('删除记录及全部关联材料');
  assert.equal(ui.images.active, null);
  assert.equal(ui.calls.filter(call => call.method === 'records:delete').length, 1);
});

test('inbox cards have independent keyboard-accessible open/delete buttons and cancellation preserves edits', async () => {
  const ui = await rendererHarness({ confirm: () => false });
  await ui.edit();
  await ui.input('#record-transcript-input', '尚未保存的上下文');
  const card = ui.nodes.get('#record-list').children[0];
  assert.equal(card.tag, 'article');
  const open = card.children.find(item => item.classList.contains('record-open'));
  const remove = card.children.find(item => item.classList.contains('card-delete'));
  assert.equal(open.tag, 'button'); assert.equal(remove.tag, 'button');
  assert.match(remove.getAttribute('aria-label'), /删除灵感：临时显示标题/u);
  remove.focus();
  await ui.emit(remove, 'click');
  assert.equal(ui.calls.some(call => call.method === 'records:delete'), false);
  assert.equal(ui.nodes.get('#record-transcript-input').value, '尚未保存的上下文');
  assert.equal(ui.run('state.detailDirty'), true);
  assert.match(ui.confirmations[0].detail, /尚未保存的修改也将放弃/u);
  const restored = ui.nodes.get('#record-list').children[0].children.find(item => item.classList.contains('record-actions-toggle'));
  assert.notEqual(restored, remove);
  assert.equal(ui.document.activeElement, restored);
});

test('deleting an unselected inbox record leaves another record and its unsaved edits untouched', async () => {
  const first = { id: 'fixture-record', title: '要删除的旧想法', transcript: '旧想法' };
  const second = { id: 'second-record', title: '正在编辑的新想法', task: '', transcript: '新想法', audioSegments: [] };
  const ui = await rendererHarness({ records: [first, second] });
  await ui.run('selectRecord("second-record")');
  await ui.edit();
  await ui.input('#record-transcript-input', '这个修改必须留下');
  const editor = ui.nodes.get('#record-transcript-input'); editor.focus();
  const card = ui.nodes.get('#record-list').children[0];
  await ui.emit(card.children.find(item => item.classList.contains('card-delete')), 'click');
  assert.equal(ui.run('state.selectedId'), 'second-record');
  assert.equal(ui.run('state.detailDirty'), true);
  assert.equal(ui.nodes.get('#record-transcript-input').value, '这个修改必须留下');
  assert.equal(ui.document.activeElement, editor);
  assert.deepEqual(ui.calls.filter(call => call.method === 'records:delete').map(call => call.params.id), ['fixture-record']);
});

test('deleting the final inbox record leaves a usable empty list and cleared selection', async () => {
  const ui = await rendererHarness();
  const card = ui.nodes.get('#record-list').children[0];
  const remove = card.children.find(item => item.classList.contains('card-delete')); remove.focus();
  await ui.emit(remove, 'click');
  assert.equal(ui.run('state.selectedId'), null);
  assert.equal(ui.run('state.visibleRecords.length'), 0);
  assert.equal(ui.nodes.get('#inbox-count').textContent, 0);
  assert.equal(ui.nodes.get('#record-list').children[0].classList.contains('list-empty'), true);
  assert.equal(ui.document.activeElement, ui.nodes.get('#search-input'));
  assert.match(ui.confirmations[0].message, /临时显示标题/u);
});

function dialogHarness() {
  const dom = createDOM(); const calls = []; const timers = new Map(); let timerId = 0; let clock = 0;
  class FixedDate extends Date { static now() { return clock; } }
  const window = { inmoment: { async invoke(method, params) { calls.push({ method, params }); return {}; } } };
  runUIScript('src/renderer/dialogs.js', { document: dom.document, window, Date: FixedDate,
    setTimeout(callback, delay) { timers.set(++timerId, { callback, due: clock + delay }); return timerId; }, clearTimeout(id) { timers.delete(id); },
  });
  return { ...dom, calls, api: window.InMomentDialogs,
    buttons() { return dom.nodes.get('#confirm-actions').children; },
    async advance(ms) { clock += ms; let pending = [...timers].filter(([, timer]) => timer.due <= clock); while (pending.length) { for (const [id, timer] of pending) { timers.delete(id); timer.callback(); } pending = [...timers].filter(([, timer]) => timer.due <= clock); } await Promise.resolve(); await Promise.resolve(); },
  };
}

test('real confirmation modal uses text content, starts on cancellation, and only resolves after a fresh armed action', async () => {
  const ui = dialogHarness(); const opener = ui.element('button'); opener.focus();
  const result = ui.api.confirm({ title: '删除灵感？', message: '<img onerror=bad>', detail: '原件无法恢复', confirmLabel: '删除灵感与附件', danger: true });
  assert.equal(ui.nodes.get('#confirm-message').textContent, '<img onerror=bad>');
  assert.equal(ui.nodes.get('#confirm-dialog').open, true);
  await ui.emit(ui.buttons()[1], 'click', { detail: 1 });
  assert.equal(ui.nodes.get('#confirm-dialog').open, true);
  await ui.advance(180);
  assert.equal(ui.document.activeElement.textContent, '取消');
  await ui.emit(ui.buttons()[1], 'click', { detail: 1 });
  assert.equal(await result, true);
  assert.equal(ui.nodes.get('#confirm-dialog').open, false);
  assert.equal(ui.document.activeElement, opener);
  assert.equal(ui.calls.length, 0);
});

test('modal queue cannot approve the next remote authorization with double clicks or held Enter', async () => {
  const ui = dialogHarness();
  const local = ui.api.confirm({ message: '先处理本地修改' });
  const remote = ui.api.remote({ id: 'remote-nonce', options: { title: '云端授权', message: '将发送候选文字', buttons: ['取消', '同意本次请求'], cancelId: 0 } });
  await ui.advance(180); await ui.emit(ui.buttons()[1], 'click', { detail: 1 }); assert.equal(await local, true);
  await ui.emit(ui.document, 'keydown', { key: 'Enter', repeat: false });
  await ui.advance(220); await ui.advance(180);
  assert.equal(ui.buttons()[1].disabled, true);
  await ui.emit(ui.buttons()[1], 'click', { detail: 2 }); assert.equal(ui.calls.length, 0);
  await ui.emit(ui.document, 'keyup', { key: 'Enter' });
  await ui.emit(ui.buttons()[1], 'click', { detail: 2 }); assert.equal(ui.calls.length, 0);
  await ui.emit(ui.buttons()[1], 'click', { detail: 1 }); await remote;
  assert.deepEqual(ui.calls.map(call => ({ method: call.method, id: call.params.id, index: call.params.buttonIndex })), [{ method: 'dialog:respond', id: 'remote-nonce', index: 1 }]);
});

for (const key of ['Enter', ' ']) {
  test(`a fresh ${key === ' ' ? 'Space' : key} confirms the focused button once and holding it never approves the next dialog`, async () => {
    const ui = dialogHarness();
    const first = ui.api.confirm({ message: '第一条本地确认' });
    const second = ui.api.remote({ id: 'keyboard-next', options: { message: '第二条授权', buttons: ['取消', '同意本次请求'], cancelId: 0 } });
    await ui.advance(180); ui.buttons()[1].focus();
    await ui.emit(ui.document, 'keydown', { key, repeat: false });
    assert.equal(await first, true);
    await ui.advance(220); await ui.advance(180);
    assert.equal(ui.buttons()[1].disabled, true);
    ui.buttons()[1].focus();
    await ui.emit(ui.document, 'keydown', { key, repeat: true });
    assert.equal(ui.calls.length, 0);
    await ui.emit(ui.document, 'keyup', { key });
    assert.equal(ui.calls.length, 0);
    assert.equal(ui.buttons()[1].disabled, false);
    await ui.emit(ui.document, 'keydown', { key, repeat: false }); await second;
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0].params.buttonIndex, 1);
  });
}

test('Escape cancels remote authorization and main cancellation removes active and queued requests without response', async () => {
  const ui = dialogHarness();
  const first = ui.api.remote({ id: 'first-nonce', options: { buttons: ['批准', '取消'], cancelId: 1 } });
  const queued = ui.api.remote({ id: 'queued-nonce', options: { buttons: ['取消', '批准'], cancelId: 0 } });
  ui.api.cancelRemote('queued-nonce'); await queued;
  await ui.emit(ui.nodes.get('#confirm-dialog'), 'cancel'); await first;
  assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].params.buttonIndex, 1);
  await ui.advance(220);
  const third = ui.api.remote({ id: 'third-nonce', options: { buttons: ['取消', '批准'], cancelId: 0 } });
  ui.api.cancelRemote('third-nonce'); await third;
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.nodes.get('#confirm-dialog').open, false);
});

test('bootstrap preserves stored settings and never implicitly saves or resets them', async () => {
  const ui = await rendererHarness({ settings: { thresholdMs: 1800, previewDelayMs: 1000, captureDelayMs: 350, menuDelayMs: 700, keyboardTrigger: 'F10', cloudEnabled: true, autoTitleEnabled: true } });
  assert.equal(Number(ui.nodes.get('#threshold-input').value), 1800);
  assert.equal(Number(ui.nodes.get('#preview-delay-input').value), 1000);
  assert.equal(Number(ui.nodes.get('#capture-delay-input').value), 350);
  assert.equal(Number(ui.nodes.get('#menu-delay-input').value), 700);
  assert.equal(ui.nodes.get('#keyboard-trigger-input').value, 'F10');
  assert.equal(ui.nodes.get('#auto-title-enabled').checked, true);
  assert.equal(ui.calls.some(call => ['settings:save', 'settings:reset'].includes(call.method)), false);
});

test('cancelled global reset keeps the unsaved form and key input unchanged', async () => {
  const ui = await rendererHarness({ resetResult: { cancelled: true } });
  await ui.input('#threshold-input', '2500'); await ui.input('#api-key', 'unsaved-fixture-input');
  ui.nodes.get('#cloud-enabled').checked = true;
  await ui.clickSelector('#reset-settings');
  assert.equal(ui.nodes.get('#threshold-input').value, '2500');
  assert.equal(ui.nodes.get('#api-key').value, 'unsaved-fixture-input');
  assert.equal(ui.nodes.get('#cloud-enabled').checked, true);
  assert.equal(ui.calls.filter(call => call.method === 'settings:reset').length, 1);
  assert.equal(ui.calls.some(call => call.method === 'settings:save'), false);
});

test('confirmed global reset renders backend defaults, clears only unsaved key input, and retains records/key status', async () => {
  const ui = await rendererHarness({ settings: { hasApiKey: true, cloudEnabled: true, autoTitleEnabled: true, thresholdMs: 2500, keyboardTrigger: 'F9' } });
  await ui.input('#api-key', 'unsaved-fixture-input');
  await ui.clickSelector('#reset-settings');
  assert.equal(Number(ui.nodes.get('#threshold-input').value), 550);
  assert.equal(ui.nodes.get('#keyboard-trigger-input').value, 'none');
  assert.equal(ui.nodes.get('#cloud-enabled').checked, false);
  assert.equal(ui.nodes.get('#auto-title-enabled').checked, false);
  assert.equal(ui.nodes.get('#api-key').value, '');
  assert.equal(ui.nodes.get('#key-status').textContent, '已安全保存');
  assert.equal(ui.calls.some(call => ['settings:save', 'records:delete'].includes(call.method)), false);
  assert.equal(ui.calls.filter(call => call.method === 'settings:reset').length, 1);
});

function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('AI search clears pending local debounce and survives recordsChanged both during and after a paid task', async () => {
  const gate = deferred(); const ui = await rendererHarness({ settings: { cloudEnabled: true, aiSearchEnabled: true }, invokeHook(method) { if (method === 'records:aiSearch') return gate.promise; } });
  await ui.input('#search-input', '关于灵感收藏的模糊记忆');
  assert.equal(ui.timers.size, 1);
  await ui.clickSelector('#ai-search'); assert.equal(ui.timers.size, 0);
  const pending = ui.submitAISearch();
  const localBefore = ui.calls.filter(call => call.method === 'records:list' || call.method === 'records:search').length;
  await ui.event({ type: 'recordsChanged' });
  assert.equal(ui.calls.filter(call => call.method === 'records:list' || call.method === 'records:search').length, localBefore);
  gate.resolve({ records: [ui.record], total: 1, scopeTotal: 1, candidateCount: 1, explanation: '按含义找到这一条' }); await pending; await ui.flush();
  assert.equal(ui.run('state.aiMode'), true); assert.match(ui.nodes.get('#library-status').textContent, /按含义找到/u);
  await ui.event({ type: 'recordsChanged' });
  assert.equal(ui.calls.filter(call => call.method === 'records:list' || call.method === 'records:search').length, localBefore);
  assert.equal(ui.calls.filter(call => call.method === 'records:aiSearch').length, 1);
});

test('new input typed while save is pending remains visible and dirty after the submitted version succeeds', async () => {
  const gate = deferred(); let blocked = true;
  const ui = await rendererHarness({ invokeHook(method) { if (method === 'records:update' && blocked) { blocked = false; return gate.promise; } } });
  await ui.edit();
  await ui.input('#record-transcript-input', '提交时的任务');
  const pending = ui.clickLabel('保存语音文本');
  await ui.input('#record-transcript-input', '保存等待中继续输入的新任务'); gate.resolve({ version: 2 }); await pending;
  assert.equal(ui.nodes.get('#record-transcript-input').value, '保存等待中继续输入的新任务');
  assert.equal(ui.run('state.detailDirty'), true);
  assert.match(ui.nodes.get('#record-edit-status').textContent, /随后输入.*未保存/u);
  assert.equal(ui.calls.filter(call => call.method === 'records:update').length, 1);
  assert.equal(ui.calls.filter(call => call.method === 'app:setDirty').at(-1).params.recordDirty, true);
});

test('settingsChanged and cancelled permission confirmation preserve pending settings and key input', async () => {
  const ui = await rendererHarness({ invokeHook(method) { if (method === 'settings:save') return { cancelled: true }; } });
  await ui.input('#api-key', 'unsaved-fixture-input');
  ui.nodes.get('#ai-search-enabled').checked = true; await ui.emit(ui.nodes.get('#ai-search-enabled'), 'change');
  await ui.event({ type: 'settingsChanged' });
  assert.equal(ui.nodes.get('#api-key').value, 'unsaved-fixture-input');
  assert.equal(ui.nodes.get('#ai-search-enabled').checked, true);
  await ui.submitSettings();
  assert.equal(ui.nodes.get('#api-key').value, 'unsaved-fixture-input');
  assert.equal(ui.nodes.get('#ai-search-enabled').checked, true);
  assert.equal(ui.run('state.settingsDirty'), true);
  assert.match(ui.nodes.get('#settings-result').textContent, /已取消保存/u);
});

test('implicit repeated settings submissions issue one save and retain new input while the first save is pending', async () => {
  const gate = deferred();
  const ui = await rendererHarness({ invokeHook(method) { if (method === 'settings:save') return gate.promise; } });
  await ui.input('#threshold-input', '1200');
  const pending = ui.submitSettings();
  await ui.flush();
  await ui.input('#threshold-input', '1800');
  await ui.submitSettings();
  assert.equal(ui.calls.filter(call => call.method === 'settings:save').length, 1);
  gate.resolve({ thresholdMs: 1200 }); await pending;
  assert.equal(ui.nodes.get('#threshold-input').value, '1800');
  assert.equal(ui.run('state.settingsDirty'), true);
  assert.match(ui.nodes.get('#settings-result').textContent, /随后修改的表单仍未保存/u);
  assert.equal(ui.run('settingsSaving'), false);
});

async function switchAIProvider(ui, id) { ui.nodes.get('#ai-provider').value = id; await ui.emit(ui.nodes.get('#ai-provider'),'change'); }
function publicAISettings(active = 'deepseek', overrides = {}) {
  const catalog = require('../src/shared/ai-providers.js').PROVIDERS;
  const aiProfiles = Object.fromEntries(Object.values(catalog).map(provider => [provider.id,{model:provider.defaultModel,hasApiKey:false,...overrides[provider.id]}]));
  return {aiProvider:active,aiProfiles,aiProviders:Object.values(catalog),model:aiProfiles[active].model,hasApiKey:aiProfiles[active].hasApiKey};
}

test('legacy AI settings open under DeepSeek with its saved model and never reveal stored key material', async () => {
  const ui = await rendererHarness({settings:{model:'deepseek-v4-pro',hasApiKey:true}});
  assert.equal(ui.nodes.get('#ai-provider').value,'deepseek'); assert.equal(ui.nodes.get('#model-input').value,'deepseek-v4-pro'); assert.equal(ui.nodes.get('#api-key').value,'');
  assert.equal(ui.nodes.get('#key-status').textContent,'已安全保存'); assert.equal(ui.nodes.get('#api-key-label-text').textContent,'DeepSeek API Key');
  assert(ui.nodes.get('#ai-model-options').children.some(option=>option.value === 'deepseek-v4-pro'));
  assert.equal(ui.calls.some(call=>call.method === 'settings:save'),false);
});

test('switching AI services keeps independent unsaved models and keys without saving or requesting AI', async () => {
  const ui = await rendererHarness({settings:publicAISettings('deepseek',{deepseek:{hasApiKey:true}})});
  await ui.input('#model-input','deepseek-custom'); await ui.input('#api-key','synthetic-deepseek-draft');
  await switchAIProvider(ui,'openai'); assert.equal(ui.nodes.get('#model-input').value,'gpt-5.4-mini'); assert.equal(ui.nodes.get('#api-key').value,'');
  await ui.input('#model-input','ft:gpt-5.4-mini:custom'); await ui.input('#api-key','synthetic-openai-draft');
  await switchAIProvider(ui,'gemini'); assert.equal(ui.nodes.get('#model-input').value,'gemini-3.8-flash'); assert.equal(ui.nodes.get('#api-key').value,'');
  await switchAIProvider(ui,'deepseek'); assert.equal(ui.nodes.get('#model-input').value,'deepseek-custom'); assert.equal(ui.nodes.get('#api-key').value,'synthetic-deepseek-draft');
  await switchAIProvider(ui,'openai'); assert.equal(ui.nodes.get('#model-input').value,'ft:gpt-5.4-mini:custom'); assert.equal(ui.nodes.get('#api-key').value,'synthetic-openai-draft');
  assert.equal(ui.calls.some(call=>['settings:save','records:organize','records:aiSearch','library:batchOrganize'].includes(call.method)),false);
});

test('saving AI settings submits only changed profiles and clears saved drafts across services', async () => {
  const ui = await rendererHarness({settings:publicAISettings('deepseek',{deepseek:{hasApiKey:true},openai:{model:'gpt-5.4',hasApiKey:true}})});
  await ui.input('#model-input','deepseek-custom'); await switchAIProvider(ui,'openai'); await ui.input('#api-key','synthetic-openai-replacement'); await switchAIProvider(ui,'gemini');
  await ui.submitSettings(); const params = ui.calls.find(call=>call.method === 'settings:save').params;
  assert.equal(params.aiProvider,'gemini'); assert.deepEqual(Object.keys(params.aiProfiles).sort(),['deepseek','openai']); assert.equal(params.aiProfiles.deepseek.model,'deepseek-custom'); assert.equal(Object.hasOwn(params.aiProfiles.deepseek,'apiKey'),false);
  assert.equal(params.aiProfiles.openai.model,'gpt-5.4'); assert.equal(params.aiProfiles.openai.apiKey,'synthetic-openai-replacement'); assert.equal(Object.hasOwn(params,'model'),false); assert.equal(Object.hasOwn(params,'apiKey'),false);
  await switchAIProvider(ui,'openai'); assert.equal(ui.nodes.get('#api-key').value,''); assert.equal(ui.nodes.get('#key-status').textContent,'已安全保存');
  await switchAIProvider(ui,'deepseek'); assert.equal(ui.nodes.get('#model-input').value,'deepseek-custom'); assert.equal(ui.nodes.get('#api-key').value,'');
});

test('cancelled AI settings authorization retains inactive profile drafts for a later save', async () => {
  const ui = await rendererHarness({settings:publicAISettings(),invokeHook(method) {if(method === 'settings:save') return {cancelled:true};}});
  await ui.input('#api-key','synthetic-deepseek-unsaved'); await switchAIProvider(ui,'openai'); await ui.input('#model-input','gpt-5.4'); await ui.input('#api-key','synthetic-openai-unsaved'); await switchAIProvider(ui,'gemini');
  await ui.submitSettings(); await switchAIProvider(ui,'deepseek'); assert.equal(ui.nodes.get('#api-key').value,'synthetic-deepseek-unsaved');
  await switchAIProvider(ui,'openai'); assert.equal(ui.nodes.get('#api-key').value,'synthetic-openai-unsaved'); assert.equal(ui.nodes.get('#model-input').value,'gpt-5.4'); assert.equal(ui.run('state.settingsDirty'),true);
});

test('AI profile edits and service switches made during save survive its successful response', async () => {
  const gate = deferred(); let fresh = publicAISettings(); const ui = await rendererHarness({settings:fresh,invokeHook(method) {if(method === 'settings:save') return gate.promise;if(method === 'settings:get') return fresh;}});
  await ui.input('#model-input','deepseek-sent'); await ui.input('#api-key','synthetic-sent-key'); const pending = ui.submitSettings(); await ui.flush();
  await ui.input('#model-input','deepseek-newer'); await ui.input('#api-key','synthetic-newer-key'); await switchAIProvider(ui,'openai'); await ui.input('#api-key','synthetic-openai-newer');
  fresh = publicAISettings('deepseek',{deepseek:{model:'deepseek-sent',hasApiKey:true}}); gate.resolve(fresh); await pending;
  assert.equal(ui.nodes.get('#ai-provider').value,'openai'); assert.equal(ui.nodes.get('#api-key').value,'synthetic-openai-newer');
  await switchAIProvider(ui,'deepseek'); assert.equal(ui.nodes.get('#model-input').value,'deepseek-newer'); assert.equal(ui.nodes.get('#api-key').value,'synthetic-newer-key'); assert.equal(ui.run('state.settingsDirty'),true);
  const sent = ui.calls.find(call=>call.method === 'settings:save').params; assert.equal(sent.aiProfiles.deepseek.model,'deepseek-sent'); assert.equal(sent.aiProfiles.deepseek.apiKey,'synthetic-sent-key');
});

test('a saved unchanged key draft is cleared even when unrelated settings change during its save', async () => {
  const gate = deferred(); let fresh = publicAISettings(); const ui = await rendererHarness({settings:fresh,invokeHook(method) {if(method === 'settings:save') return gate.promise;if(method === 'settings:get') return fresh;}});
  await ui.input('#api-key','synthetic-sent-key'); const pending = ui.submitSettings(); await ui.flush(); await ui.input('#threshold-input','1800');
  fresh = publicAISettings('deepseek',{deepseek:{hasApiKey:true}}); gate.resolve(fresh); await pending;
  assert.equal(ui.nodes.get('#api-key').value,''); assert.equal(ui.nodes.get('#key-status').textContent,'已安全保存'); assert.equal(ui.nodes.get('#threshold-input').value,'1800'); assert.equal(ui.run('state.settingsDirty'),true);
  assert.equal(ui.run('Object.keys(collectAIProfileChanges()).length'),0);
});

test('custom model names are validated locally and background metadata changes are not treated as profile edits', async () => {
  const ui = await rendererHarness({settings:publicAISettings()}); ui.run("showView('settings'); state.settings.aiProfiles.deepseek.model = 'deepseek-v4-pro'");
  assert.equal(ui.run('Object.keys(collectAIProfileChanges()).length'),0);
  await switchAIProvider(ui,'gemini'); await ui.input('#model-input','models/invalid'); await ui.submitSettings();
  assert.equal(ui.calls.some(call=>call.method === 'settings:save'),false); assert.match(ui.nodes.get('#toast').textContent,/模型名称无效/u);
});

async function enableManualModel(ui) { ui.nodes.get('#model-manual-enabled').checked = true; await ui.emit(ui.nodes.get('#model-manual-enabled'), 'change'); }

test('AI service and model presets use local floating menus while retaining independent drafts', async () => {
  const ui = await rendererHarness({settings:publicAISettings(),menu(value) {return value.title === 'AI 服务' ? 'openai' : 'gpt-5.4';}});
  await ui.input('#api-key','synthetic-deepseek-draft'); await ui.clickSelector('#ai-provider-trigger');
  assert.equal(ui.nodes.get('#ai-provider').value,'openai'); assert.equal(ui.nodes.get('#ai-provider-trigger').textContent,'OpenAI（GPT）'); assert.equal(ui.nodes.get('#api-key').value,'');
  assert.equal(ui.menus[0].selection,true); assert.equal(ui.menus[0].items.find(item=>item.selected).id,'deepseek'); assert.deepEqual(Array.from(ui.menus[0].items,item=>item.id),['deepseek','openai','gemini']);
  assert.equal(ui.nodes.get('#model-input').disabled,true); assert.equal(ui.nodes.get('#ai-model-presets').disabled,true); await enableManualModel(ui);
  await ui.clickSelector('#ai-model-presets'); assert.equal(ui.nodes.get('#model-input').value,'gpt-5.4'); assert.equal(ui.run('aiProfileDrafts.openai.model'),'gpt-5.4');
  assert.equal(ui.menus[1].title,'模型预设'); assert.equal(ui.menus[1].items.some(item=>item.id === 'deepseek-flash'),false); assert.equal(ui.nodes.get('#ai-model-presets').getAttribute('aria-expanded'),'false');
  await switchAIProvider(ui,'deepseek'); assert.equal(ui.nodes.get('#api-key').value,'synthetic-deepseek-draft');
  assert.equal(ui.calls.some(call=>['settings:save','records:organize','records:aiSearch','library:batchOrganize'].includes(call.method)),false);
});

test('cancelled or disabled AI choice menus do not change the form or its dirty revision', async () => {
  const ui = await rendererHarness({settings:publicAISettings(),menu() {return null;}}); const revision = ui.run('state.settingsRevision');
  await ui.clickSelector('#ai-provider-trigger'); await ui.clickSelector('#ai-model-presets');
  assert.equal(ui.run('state.settingsRevision'),revision); assert.equal(ui.nodes.get('#ai-provider').value,'deepseek'); assert.equal(ui.nodes.get('#model-input').value,'deepseek-flash');
  const opened = ui.menus.length; ui.nodes.get('#ai-provider-trigger').disabled = true; ui.nodes.get('#ai-model-presets').disabled = true;
  await ui.clickSelector('#ai-provider-trigger'); await ui.clickSelector('#ai-model-presets'); assert.equal(ui.menus.length,opened); assert.equal(ui.calls.some(call=>call.method === 'settings:save'),false);
});

test('a stale model preset cannot overwrite the newly selected AI service or a newer page', async () => {
  const gate = deferred(); const ui = await rendererHarness({settings:publicAISettings(),menu() {return gate.promise;}});
  await enableManualModel(ui); const pending = ui.clickSelector('#ai-model-presets'); await switchAIProvider(ui,'gemini'); gate.resolve('deepseek-v4-pro'); await pending;
  assert.equal(ui.nodes.get('#model-input').value,'gemini-3.8-flash'); assert.equal(ui.nodes.get('#ai-provider').value,'gemini');
  const next = deferred(); const other = await rendererHarness({settings:publicAISettings(),menu() {return next.promise;}});
  const choosing = other.clickSelector('#ai-provider-trigger'); other.run("showView('drafts')"); next.resolve('openai'); await choosing;
  assert.equal(other.nodes.get('#ai-provider').value,'deepseek'); assert.equal(other.run('state.view'),'drafts'); assert.equal(other.calls.some(call=>call.method === 'settings:save'),false);
});

test('date and multiple-topic filters pass an inclusive start and exclusive end without cloud calls', async () => {
  const ui = await rendererHarness({ topics: [{ id: 'topic-a', name: '产品' }, { id: 'topic-b', name: '阅读' }] });
  await ui.input('#date-range', 'custom'); await ui.input('#date-from', '2026-10-01'); await ui.input('#date-to', '2026-10-16');
  await ui.emit(ui.nodes.get('#date-to'), 'change'); await ui.flush();
  for (const label of [...ui.nodes.get('#topic-filter-options').children]) { const input = label.children[0]; input.checked = true; await ui.emit(input, 'change'); await ui.flush(); }
  const filters = ui.calls.filter(call => call.method === 'records:list').at(-1).params.filters;
  assert.equal(filters.from, new Date('2026-10-01T00:00:00').getTime());
  assert.equal(filters.to, new Date('2026-10-17T00:00:00').getTime());
  assert.deepEqual(Array.from(filters.topicIds).sort(), ['topic-a', 'topic-b']);
  assert.equal(ui.calls.some(call => call.method === 'records:aiSearch'), false);
});

test('local pagination appends the next page and reports the full scope rather than bootstrap length', async () => {
  const records = Array.from({ length: 45 }, (_, index) => ({ id: index === 0 ? 'fixture-record' : 'record-' + index, title: '记录 ' + index, transcript: '文字', audioSegments: [], createdAt: 1000 + index }));
  const ui = await rendererHarness({ records });
  assert.equal(ui.run('state.visibleRecords.length'), 20);
  await ui.clickSelector('#load-more');
  assert.equal(ui.run('state.visibleRecords.length'), 40);
  assert.equal(ui.calls.filter(call => call.method === 'records:list').at(-1).params.offset, 20);
  assert.match(ui.nodes.get('#record-count').textContent, /40 \/ 45/u);
  assert.equal(ui.run('state.scopeTotal'), 45);
  assert.equal(ui.nodes.get('#library-status').textContent, '');
});

test('notes-only records keep handwritten expression and expose summary evidence honestly without an audio player', async () => {
  const ui = await rendererHarness({ record: { audioSegments: [], transcript: '', notes: '纯截图记录的手写想法', organization: { schemaVersion: 2, summary: '单条摘要', points: [], evidence: [{ segmentId: 'note-id', quote: '手写想法' }], uncertainties: ['关系仍待验证'], context: { source: 'ai_screenshot', description: '画面可能是作品集页面' } } } });
  assert.equal(ui.nodes.get('#record-transcript-input').value, '纯截图记录的手写想法');
  assert(ui.created.some(element => element.textContent === '文字依据（无对应音频）· 手写想法' && element.tag === 'blockquote'));
  assert(ui.created.some(element => element.textContent === 'AI 从截图推断的情境 · 待你核对'));
  assert.equal(ui.created.some(element => element.textContent === '思路 1'), false);
});

test('single summary sends screenshots only under the saved setting and exposes no per-request media or processing panel', async () => {
  const without = await rendererHarness({ record: { screenshotUrl: screenshotFixture }, settings: { cloudEnabled: true, screenshotAnalysisEnabled: false } }); await without.click('AI 总结'); assert.equal(without.calls.filter(call => call.method === 'records:organize').at(-1).params.includeScreenshot, false);
  const allowed = await rendererHarness({ record: { screenshotUrl: screenshotFixture }, settings: { cloudEnabled: true, screenshotAnalysisEnabled: true } }); await allowed.click('AI 总结'); const params = allowed.calls.filter(call => call.method === 'records:organize').at(-1).params; assert.equal(params.includeScreenshot, true); assert.deepEqual(Object.keys(params).sort(), ['id', 'includeScreenshot']);
  const detail = descendants(allowed.nodes.get('#record-detail')); assert.equal(detail.some(item => ['request-info', 'processing'].includes(item.getAttribute('data-disclosure'))), false); assert.equal(detail.some(item => item.classList.contains('screenshot-consent')), false);
});

test('exclusive audio playback uses only local UI state', async () => {
  const ui = await rendererHarness();
  const players = ui.created.filter(element => element.tag === 'audio'); players[0].paused = false; players[1].paused = false; await ui.emit(players[1], 'play'); assert.equal(players[0].paused, true);
  assert.equal(ui.calls.some(call => ['records:organize', 'records:aiSearch', 'library:duplicates'].includes(call.method)), false);
});

test('local audio controls follow metadata, seeking, speed, mute, pause and the end of playback', async () => {
  const ui = await rendererHarness({ record: { audioSegments: [{ id: 'voice-one', url: 'inmoment-media://record/fixture-record/audio/voice-one', transcript: '原始表达', durationMs: 90000 }] } });
  const controls = descendants(ui.nodes.get('#record-detail'));
  const audio = controls.find(item => item.tag === 'audio'); const play = controls.find(item => item.classList.contains('audio-play-button')); const progress = controls.find(item => item.classList.contains('audio-progress')); const time = controls.find(item => item.classList.contains('audio-time')); const speed = controls.find(item => item.classList.contains('audio-speed')); const mute = controls.find(item => item.classList.contains('audio-mute-button'));
  assert.equal(progress.max, 90); assert.equal(progress.disabled, false); assert.equal(play.disabled, false); assert.equal(audio.controls, undefined, 'custom controls replace the browser control surface');
  audio.duration = 120; audio.currentTime = 15; audio.paused = true; await ui.emit(audio, 'loadedmetadata');
  assert.equal(progress.max, 120); assert.equal(progress.value, 15); assert.equal(time.textContent, '00:15 / 02:00');
  await ui.emit(play, 'click'); assert.equal(audio.paused, false); assert.equal(play.getAttribute('data-ui-icon'), 'pause'); assert.equal(play.getAttribute('aria-pressed'), 'true');
  progress.value = 500; await ui.emit(progress, 'input'); assert.equal(audio.currentTime, 120, 'seek is clamped to the real duration');
  progress.value = -10; await ui.emit(progress, 'input'); assert.equal(audio.currentTime, 0, 'negative seeks stay at the start');
  speed.value = '1.5'; await ui.emit(speed, 'change'); assert.equal(audio.playbackRate, 1.5);
  await ui.emit(mute, 'click'); assert.equal(audio.muted, true); assert.equal(mute.getAttribute('aria-pressed'), 'true'); await ui.emit(mute, 'click'); assert.equal(audio.muted, false);
  await ui.emit(play, 'click'); assert.equal(audio.paused, true); assert.equal(play.getAttribute('data-ui-icon'), 'play');
  audio.ended = true; audio.currentTime = 120; await ui.emit(audio, 'ended'); assert.equal(play.getAttribute('aria-pressed'), 'false');
  await ui.emit(play, 'click'); assert.equal(audio.currentTime, 0, 'play after end restarts at the beginning');
  assert.equal(ui.calls.some(call => /organize|transcribe|startManual/u.test(call.method)), false);
});

test('audio without a known duration enables seeking only after metadata and reports playback failures', async () => {
  const ui = await rendererHarness({ record: { audioSegments: [{ id: 'unknown', url: 'inmoment-media://record/fixture-record/audio/unknown', transcript: '原话' }] } });
  const controls = descendants(ui.nodes.get('#record-detail')); const audio = controls.find(item => item.tag === 'audio'); const progress = controls.find(item => item.classList.contains('audio-progress')); const play = controls.find(item => item.classList.contains('audio-play-button')); const error = controls.find(item => item.classList.contains('audio-error'));
  assert.equal(progress.disabled, true); assert.match(progress.getAttribute('aria-valuetext'), /时长待加载/u);
  audio.duration = 8; audio.currentTime = 0; await ui.emit(audio, 'loadedmetadata'); assert.equal(progress.disabled, false); assert.equal(progress.max, 8);
  await ui.emit(audio, 'error'); assert.equal(error.classList.contains('hidden'), false); assert.equal(play.disabled, true); assert.equal(progress.disabled, true);
  assert.equal(ui.calls.some(call => /organize|transcribe|startManual/u.test(call.method)), false);
});

test('missing audio attachments disable local playback with a visible reason', async () => {
  const ui = await rendererHarness({ record: { audioSegments: [{ id: 'missing', durationMs: 5000, transcript: '这段原文仍然保留' }] } });
  const controls = descendants(ui.nodes.get('#record-detail')); assert.equal(controls.find(item => item.classList.contains('audio-play-button')).disabled, true); assert.equal(controls.find(item => item.classList.contains('audio-error')).classList.contains('hidden'), false); assert.equal(controls.find(item => item.classList.contains('audio-progress')).disabled, true);
  assert.equal(ui.record.audioSegments[0].transcript, '这段原文仍然保留'); assert.equal(ui.calls.some(call => call.method === 'records:update'), false);
});

test('real waveform peaks drive SVG shape, played color and exact pointer seeking through the native range',async()=>{
  const peaks=Array(256).fill(0);peaks[64]=.01;peaks[128]=.02;
  const ui=await rendererHarness({record:{audioSegments:[{id:'wave',url:'inmoment-media://record/fixture-record/audio/wave',durationMs:10000}]},invokeHook(method){if(method==='records:waveform')return{peaks,durationMs:10000};}});await ui.flush();
  const contents=descendants(ui.nodes.get('#record-detail')),track=contents.find(x=>x.classList.contains('audio-seek-track')),range=contents.find(x=>x.classList.contains('audio-progress')),audio=contents.find(x=>x.tag==='audio');
  const bars=contents.find(x=>x.classList.contains('audio-waveform-bars')),played=contents.find(x=>x.classList.contains('audio-waveform-played'));
  assert.equal(track.classList.contains('has-waveform'),true);assert.equal(range.type,'range');assert.match(range.getAttribute('aria-label'),/播放进度/u);assert.match(bars.getAttribute('d'),/M64\.5 11\.000V29\.000/u);assert.match(bars.getAttribute('d'),/M128\.5 2\.000V38\.000/u);assert.equal(bars.getAttribute('d').includes('M0.5 '),false);
  audio.currentTime=2.5;await ui.emit(audio,'timeupdate');assert.equal(played.style.clipPath,'inset(0 75.0000% 0 0)');
  await ui.emit(range,'pointerdown',{button:0,pointerId:7,clientX:480});assert.equal(audio.currentTime,5);assert.equal(ui.document.activeElement,range);
  await ui.emit(range,'pointermove',{pointerId:7,clientX:960});assert.equal(audio.currentTime,10);
  await ui.emit(range,'pointerup',{type:'pointerup',pointerId:7,clientX:0});assert.equal(audio.currentTime,0);
  range.value=3.2;await ui.emit(range,'input');assert.equal(audio.currentTime,3.2);
});

test('a silent recording has only a true flat waveform and can use measured duration before metadata',async()=>{
  const ui=await rendererHarness({record:{audioSegments:[{id:'silent-wave',url:'inmoment-media://record/fixture-record/audio/silent-wave'}]},invokeHook(method){if(method==='records:waveform')return{peaks:Array(256).fill(0),durationMs:4500};}});await ui.flush();
  const contents=descendants(ui.nodes.get('#record-detail'));assert.equal(contents.find(x=>x.classList.contains('audio-waveform-bars')).getAttribute('d'),'');
  const range=contents.find(x=>x.classList.contains('audio-progress'));assert.equal(range.max,4.5);assert.equal(range.disabled,false);
});

test('unsupported waveform keeps the original seek track and a short local explanation',async()=>{
  const ui=await rendererHarness({record:{audioSegments:[{id:'old-format',url:'inmoment-media://record/fixture-record/audio/old-format',durationMs:8000}]},invokeHook(method){if(method==='records:waveform')throw new Error('unsupported format');}});await ui.flush();
  const contents=descendants(ui.nodes.get('#record-detail'));assert.equal(contents.find(x=>x.classList.contains('audio-seek-track')).classList.contains('has-waveform'),false);assert.match(contents.find(x=>x.classList.contains('audio-waveform-status')).textContent,/仍可拖动/u);
  const range=contents.find(x=>x.classList.contains('audio-progress')),audio=contents.find(x=>x.tag==='audio');range.value=4;await ui.emit(range,'input');assert.equal(audio.currentTime,4);
});

test('a delayed waveform cannot paint the disposed player after record navigation',async()=>{
  const gate=deferred(),first={id:'fixture-record',version:1,title:'第一条',audioSegments:[{id:'first-wave',url:'inmoment-media://record/fixture-record/audio/first-wave',durationMs:4000}]},second={id:'second-wave-record',version:1,title:'第二条',audioSegments:[{id:'second-wave',url:'inmoment-media://record/second-wave-record/audio/second-wave',durationMs:4000}]};
  const ui=await rendererHarness({record:first,records:[first,second],invokeHook(method,params){if(method==='records:waveform')return params.segmentId==='first-wave'?gate.promise:{peaks:Array(256).fill(.2),durationMs:4000};}});
  const oldTrack=descendants(ui.nodes.get('#record-detail')).find(x=>x.classList.contains('audio-seek-track'));await ui.run('selectRecord("second-wave-record")');gate.resolve({peaks:Array(256).fill(1),durationMs:4000});await ui.flush();
  assert.equal(oldTrack.classList.contains('has-waveform'),false);assert.equal(descendants(ui.nodes.get('#record-detail')).find(x=>x.classList.contains('audio-seek-track')).classList.contains('has-waveform'),true);
});

test('waveform requests are reused on redraw and their cache is bounded and cleared on deletion',async()=>{
  const ui=await rendererHarness({record:{audioSegments:[{id:'cache-wave',url:'inmoment-media://record/fixture-record/audio/cache-wave',durationMs:4000}]},invokeHook(method){if(method==='records:waveform')return{peaks:Array(256).fill(.2),durationMs:4000};}});await ui.flush();await ui.run('renderDetail(fixtureRecord)');await ui.flush();
  assert.equal(ui.calls.filter(c=>c.method==='records:waveform').length,1);
  await ui.run(`Promise.all(Array.from({length:30},(_,index)=>readAudioWaveform({id:'extra-'+index,version:1},{id:'audio',durationMs:1},'media-'+index)))`);assert.equal(ui.run('audioWaveformCache.size'),24);
  await ui.run('cleanDeletedRecord("extra-29")');assert.equal(ui.run('[...audioWaveformCache.values()].some(entry=>entry.id==="extra-29")'),false);
});

test('draft preview merges runtime status and preserves unsaved topic selection across session events', async () => {
  const draft = { id: 'draft-fixture', status: 'draft', title: '未保存的想法', transcript: '', audioSegments: [], topicIds: [], createdAt: 1000 };
  const ui = await rendererHarness({ drafts: [draft], topics: [{ id: 'topic-a', name: '阅读' }], session: { id: draft.id, state: 'recording', mode: 'manual', active: true } });
  await ui.run("showView('drafts'); openDraft('draft-fixture')");
  assert.equal(ui.run('mergedDrafts()[0].state'), 'recording');
  const choices = [...ui.created].reverse().find(element => element.classList.contains('topic-choice')); choices.children[0].checked = true; await ui.emit(choices.children[0], 'change');
  const originalPanel = ui.nodes.get('#draft-detail').children[0];
  await ui.event({ type: 'session', session: { id: draft.id, state: 'paused', mode: 'manual', active: true } });
  assert.equal(ui.nodes.get('#draft-detail').children[0], originalPanel);
  assert.equal(choices.children[0].checked, true);
  assert.equal(ui.run('state.draftTopicDirty'), true);
});

test('recording recovery appears for saved local drafts and ignores the active capture', async () => {
  const current = { id: 'current-capture', status: 'draft' };
  const interrupted = { id: 'interrupted-capture', status: 'draft' };
  const drafts = [current, interrupted];
  const ui = await rendererHarness({ drafts, session: { id: current.id, state: 'paused', mode: 'manual', active: true } });
  const recovery = ui.nodes.get('#open-drafts');
  assert.equal(recovery.classList.contains('hidden'), false);
  assert.equal(recovery.getAttribute('aria-label'), '恢复录音，1 条');
  await ui.run("showView('drafts')");
  drafts.pop();
  await ui.event({ type: 'recordsChanged' });
  assert.equal(recovery.classList.contains('hidden'), true);
  assert.equal(ui.run('state.view'), 'notes');
  assert.equal(ui.nodes.get('#session-banner').classList.contains('hidden'), false);
  await ui.event({ type: 'session', session: { id: current.id, state: 'saved', active: false } });
  assert.equal(recovery.classList.contains('hidden'), true);
});


test('AI topic adoption refuses unsaved editor changes and serializes concurrent adoption attempts', async () => {
  const record = { organization: { summary: '摘要', points: [], topicSuggestions: ['A', 'B'] } };
  const topics = [{ id: 'topic-a', name: 'A' }, { id: 'topic-b', name: 'B' }];
  const dirty = await rendererHarness({ record, topics });
  await dirty.edit();
  await dirty.input('#record-transcript-input', '尚未保存的任务'); await dirty.suggest('A');
  assert.equal(dirty.calls.some(call => call.method === 'records:setTopics'), false);
  assert.match(dirty.nodes.get('#toast').textContent, /先保存或放弃/u);
  const gate = deferred(); let blocked = true;
  const ui = await rendererHarness({ record, topics, invokeHook(method) { if (method === 'records:get' && blocked) { blocked = false; return gate.promise; } } });
  const first = ui.suggest('A'); await ui.suggest('B');
  assert.equal(ui.calls.filter(call => call.method === 'records:get').length, 1);
  gate.resolve(ui.record); await first;
  const writes = ui.calls.filter(call => call.method === 'records:setTopics'); assert.equal(writes.length, 1); assert.deepEqual(Array.from(writes[0].params.topicIds), ['topic-a']);
});

test('topic management supports create, rename and checkbox bulk operations without dropdowns or record deletion', async () => {
  const topics = [{ id: 'topic-a', name: 'A' }, { id: 'topic-b', name: 'B' }, { id: 'topic-c', name: 'C' }];
  const ui = await rendererHarness({ topics, groupPicker: value => value.topics[1] });
  ui.document.querySelector('#new-topic-name');
  await ui.input('#new-topic-name', '新主题'); await ui.clickSelector('#create-topic');
  assert.equal(ui.calls.find(call => call.method === 'topics:create').params.name, '新主题');
  const row = ui.nodes.get('#topic-management-list').children[0]; row.children[1].value = 'A的新名字'; await ui.emit(row.children[2], 'click');
  assert.equal(ui.calls.find(call => call.method === 'topics:rename').params.name, 'A的新名字');
  assert.equal(descendants(ui.nodes.get('#topic-management-list')).some(item => item.tag === 'select'), false);
  await ui.clickSelector('#merge-topic-groups'); assert.equal(ui.nodes.get('#apply-topic-selection').disabled, true);
  for (const item of ui.nodes.get('#topic-management-list').children.slice(0, 2)) { item.children[0].checked = true; await ui.emit(item.children[0], 'change'); }
  await ui.clickSelector('#apply-topic-selection');
  const merge = ui.calls.find(call => call.method === 'topics:mergeMany'); assert.deepEqual(Array.from(merge.params.topicIds), ['topic-a', 'topic-b']); assert.equal(merge.params.targetId, 'topic-b');
  assert.deepEqual(Array.from(ui.pickers[0].topics, item => item.id), ['topic-a', 'topic-b']); assert.equal(ui.confirmations.at(-1).anchor, ui.nodes.get('#apply-topic-selection'));
  await ui.clickSelector('#delete-topic-groups'); await ui.clickSelector('#select-all-topic-groups'); await ui.clickSelector('#apply-topic-selection');
  assert.deepEqual(Array.from(ui.calls.find(call => call.method === 'topics:deleteMany').params.topicIds), ['topic-a', 'topic-b', 'topic-c']);
  assert.equal(ui.calls.some(call => call.method === 'topics:merge' || call.method === 'topics:delete'), false);
  assert.equal(ui.calls.some(call => call.method === 'records:delete'), false);
});

test('bulk group selection can cancel either small floating box without mutating groups', async () => {
  const topics = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]; let picker = null; let approved = false;
  const ui = await rendererHarness({ topics, groupPicker: () => picker, confirm: () => approved });
  await ui.clickSelector('#merge-topic-groups'); await ui.clickSelector('#select-all-topic-groups'); await ui.clickSelector('#apply-topic-selection');
  assert.equal(ui.confirmations.length, 0); assert.equal(ui.run('topicManagement.busy'), false); assert.equal(ui.run('topicManagement.ids.size'), 2);
  picker = topics[0]; await ui.clickSelector('#apply-topic-selection'); assert.equal(ui.confirmations.length, 1); assert.equal(ui.calls.some(call => /^topics:(mergeMany|deleteMany)$/u.test(call.method)), false);
  await ui.clickSelector('#cancel-topic-selection'); assert.equal(ui.run('topicManagement.mode'), null); assert.equal(ui.nodes.get('#topic-management-selection').classList.contains('hidden'), true);
  await ui.clickSelector('#delete-topic-groups'); await ui.clickSelector('#select-all-topic-groups'); await ui.clickSelector('#apply-topic-selection'); assert.equal(ui.calls.some(call => call.method === 'topics:deleteMany'), false); assert.equal(ui.run('topicManagement.ids.size'), 2);
});

test('closing group manager invalidates a pending group picker and prevents a later confirmation or write', async () => {
  const picker = deferred(); const topics = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]; const ui = await rendererHarness({ topics, groupPicker: () => picker.promise });
  await ui.clickSelector('#open-primary-group-manager'); await ui.clickSelector('#merge-topic-groups'); await ui.clickSelector('#select-all-topic-groups'); const pending = ui.clickSelector('#apply-topic-selection'); await ui.flush();
  await ui.clickSelector('#close-group-management'); picker.resolve(topics[0]); await pending;
  assert.equal(ui.nodes.get('#group-management-dialog').open, false); assert.equal(ui.confirmations.length, 0); assert.equal(ui.calls.some(call => call.method === 'topics:mergeMany'), false); assert.equal(ui.run('topicManagement.busy'), false);
});

test('bulk group mutation prevents duplicate submits and keeps selection after an atomic failure', async () => {
  const write = deferred(); const ui = await rendererHarness({ topics: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], invokeHook(method) { if (method === 'topics:deleteMany') return write.promise; } });
  await ui.clickSelector('#open-primary-group-manager'); await ui.clickSelector('#delete-topic-groups'); await ui.clickSelector('#select-all-topic-groups'); const pending = ui.clickSelector('#apply-topic-selection'); await ui.flush();
  await ui.clickSelector('#apply-topic-selection'); await ui.clickSelector('#merge-topic-groups'); await ui.clickSelector('#close-group-management');
  assert.equal(ui.nodes.get('#group-management-dialog').open, true); assert.equal(ui.calls.filter(call => call.method === 'topics:deleteMany').length, 1); assert.equal(ui.nodes.get('#close-group-management').disabled, true);
  write.reject(new Error('分组已变化，请重新选择')); await pending; assert.equal(ui.run('topicManagement.busy'), false); assert.equal(ui.run('topicManagement.mode'), 'delete'); assert.equal(ui.run('topicManagement.ids.size'), 2); assert.match(ui.nodes.get('#topic-management-status').textContent, /重新选择/u);
});

function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }

test('the single reading panel shows a summary or source text, and edits remain an explicit action', async () => {
  const ui = await rendererHarness({ record: { topics: [{ id: 'reading', name: '阅读方法' }], organization: { summary: '这里是单条记录的摘要', points: [{ text: '证据细节' }] }, transcriptionMetrics: { provider: 'whisper.cpp', model: 'base', durationMs: 900 }, jobs: [{ kind: 'transcribe', status: 'done' }, { kind: 'title', status: 'done' }] } });
  const pane = ui.nodes.get('#record-detail'); const contents = descendants(pane); const editor = contents.find(item => item.classList.contains('record-editor')); assert(editor.classList.contains('hidden'));
  const panels = contents.filter(item => item.classList.contains('record-text-panel')); assert.equal(panels.length, 1);
  const original = contents.find(item => item.classList.contains('text-panel-original')); const summary = contents.find(item => item.classList.contains('text-panel-summary')); assert.equal(original.classList.contains('hidden'), true); assert.equal(summary.classList.contains('hidden'), false);
  assert(descendants(summary).some(item => item.textContent === '这里是单条记录的摘要'));
  const proof = contents.find(item => item.getAttribute('data-disclosure') === 'summary-evidence'); assert.equal(proof.open, false); assert(descendants(proof).some(item => item.textContent === '证据细节'));
  assert.equal(contents.some(item => item.getAttribute('data-disclosure') === 'processing' || item.getAttribute('data-disclosure') === 'request-info'), false);
  assert.equal(contents.some(item => /处理耗时/u.test(item.textContent)), false);
  await assert.rejects(ui.input('#record-transcript-input', '隐藏表单不应可编辑'), /open the editor/u);
  await ui.edit(); assert.equal(editor.classList.contains('hidden'), false); assert.equal(original.classList.contains('hidden'), false); assert.equal(summary.classList.contains('hidden'), true); assert.equal(ui.document.activeElement, ui.nodes.get('#record-transcript-input'));
  await ui.input('#record-transcript-input', '显式编辑后修订'); await ui.event({ type: 'recordsChanged' }); assert.equal(ui.nodes.get('#record-transcript-input').value, '显式编辑后修订');
  assert.equal(ui.calls.some(call => ['records:organize', 'records:aiSearch', 'library:duplicates'].includes(call.method)), false);
});



test('searchable topic choices combine unclassified with selected topics and preserve a deleted selection as a narrow scope', async () => {
  const topics = [{ id: 'topic-a', name: '产品设计' }, { id: 'topic-b', name: '阅读方法' }]; const ui = await rendererHarness({ topics });
  await ui.input('#topic-filter-search', '产品'); const choices = ui.nodes.get('#topic-filter-options').children;
  assert.equal(choices.length, 1); const checkbox = choices[0].children[0]; checkbox.checked = true; await ui.emit(checkbox, 'change'); await ui.flush();
  ui.nodes.get('#filter-unclassified').checked = true; await ui.emit(ui.nodes.get('#filter-unclassified'), 'change'); await ui.flush();
  let filters = ui.calls.filter(call => call.method === 'records:list').at(-1).params.filters;
  assert.equal(filters.uncategorized, true); assert.deepEqual(Array.from(filters.topicIds), ['topic-a']); assert.equal(Object.hasOwn(filters, 'unclassified'), false);
  assert.equal(ui.nodes.get('#topic-filter-label').textContent, '产品设计、未分类');
  topics.splice(0, 1); await ui.event({ type: 'topicsChanged' });
  filters = ui.calls.filter(call => call.method === 'records:list').at(-1).params.filters;
  assert.deepEqual(Array.from(filters.topicIds), ['topic-a']); assert.match(ui.nodes.get('#topic-filter-label').textContent, /已删除分组/u);
  assert(ui.nodes.get('#topic-filter-options').children.some(item => /不会自动扩大/u.test(item.textContent)));
  await ui.clickSelector('#clear-topic-filter'); filters = ui.calls.filter(call => call.method === 'records:list').at(-1).params.filters;
  assert.deepEqual(Array.from(filters.topicIds), []); assert.equal(filters.uncategorized, undefined);
});



test('matching reasons and failures remain visible without technical processing information or implicit retries', async () => {
  const ui = await rendererHarness({ record: { jobs: [{ kind: 'organize', status: 'failed', error: '模拟网络中断' }, { kind: 'title', status: 'done' }] }, records: [{ id: 'fixture-record', title: '测试记录', audioSegments: [], topicIds: [], matchReason: '表达了相近的回忆难题' }] });
  assert(descendants(ui.nodes.get('#record-list')).some(item => item.textContent === '匹配原因：表达了相近的回忆难题')); assert(descendants(ui.nodes.get('#record-detail')).some(item => item.classList.contains('persistent-error') && /模拟网络中断/u.test(item.textContent))); assert.equal(ui.calls.some(call => call.method === 'records:organize'), false); assert.equal(descendants(ui.nodes.get('#record-detail')).some(item => item.getAttribute('data-disclosure') === 'processing'), false);
});

test('primary group browsing exposes source text and changes scope through the flat sidebar', async () => {
  const ui = await rendererHarness({ topics: [{ id: 'topic-a', name: '阅读方法' }], records: [{ id: 'fixture-record', title: '来源记录', transcript: '全文', audioSegments: [], topicIds: ['topic-a'], task: '寻找产品求职案例' }] });
  const topic = ui.nodes.get('#primary-group-navigation').children.find(item => item.getAttribute('data-library-group-id') === 'topic-a'); await ui.emit(topic, 'click'); assert.equal(ui.run('state.view'), 'inbox'); assert.deepEqual(Array.from(ui.calls.filter(call => call.method === 'records:list').at(-1).params.filters.topicIds), ['topic-a']); const source = descendants(ui.nodes.get('#record-list')).find(item => item.classList.contains('card-context')); assert.equal(source.textContent, '寻找产品求职案例'); assert.equal(source.getAttribute('title'), '寻找产品求职案例');
});

test('inbox deletion restores focus to its entry list after visiting a group, even when the confirmation is cancelled', async () => {
  const records = [{ id: 'fixture-record', title: '收件箱一', transcript: '一', audioSegments: [], topicIds: [] }, { id: 'record-b', title: '组内二', transcript: '二', audioSegments: [], topicIds: [] }];
  const ui = await rendererHarness({ records, groups: [{ id: 'group-a', name: '组', recordIds: ['record-b'], records: [records[1]] }], confirm: () => false });
  await ui.run("selectRecord('fixture-record')"); ui.run("showView('inbox')");
  const list = ui.nodes.get('#record-list'); const remove = list.children[0].children.find(item => item.classList.contains('card-delete')); remove.focus(); await ui.emit(remove, 'click');
  const restored = list.children[0].children.find(item => item.classList.contains('record-actions-toggle'));
  assert.equal(ui.document.activeElement, restored); assert.equal(ui.document.activeElement.parentElement.parentElement, list); assert.equal(ui.run('state.view'), 'inbox'); assert.equal(ui.calls.some(call => call.method === 'records:delete'), false);
  const previous = restored; list.scrollTop = 132; await ui.event({ type: 'recordsChanged' });
  const afterRefresh = list.children[0].children.find(item => item.classList.contains('record-actions-toggle')); assert.notEqual(afterRefresh, previous); assert.equal(ui.document.activeElement, afterRefresh); assert.equal(afterRefresh.getAttribute('data-record-more-id'), 'fixture-record'); assert.equal(list.scrollTop, 132);
});

test('background list rebuilds never steal an open or delete focus from another list with the same record', async () => {
  const records = [{ id: 'fixture-record', title: '同一记录', transcript: '原件', audioSegments: [], topicIds: [] }];
  const ui = await rendererHarness({ records, groups: [{ id: 'group-a', name: '分组', recordIds: ['fixture-record'], records }] });
  await ui.run("selectRecord('fixture-record')"); ui.run("showView('inbox')");
  const list = ui.nodes.get('#record-list');
  for (const action of ['record-open', 'card-delete']) {
    if (action === 'card-delete') ui.run("setCardActions('fixture-record')");
    list.children[0].children.find(item => item.classList.contains(action)).focus();
    await ui.event({ type: 'recordsChanged' });
    assert.equal(ui.document.activeElement.parentElement.parentElement, list); assert(ui.document.activeElement.classList.contains(action));
  }
});

test('deletion cancellation restores its entry even if a closed confirmation retains the last focused control', async () => {
  const ui = await rendererHarness({ confirm: () => { const modal = ui.document.querySelector('#confirm-dialog'); const cancel = ui.element('button'); modal.append(cancel); modal.open = false; cancel.focus(); return false; } });
  const list = ui.nodes.get('#record-list'); const remove = list.children[0].children.find(item => item.classList.contains('card-delete')); remove.focus(); await ui.emit(remove, 'click');
  const restored = list.children[0].children.find(item => item.classList.contains('record-actions-toggle')); assert.equal(ui.document.activeElement, restored); assert.equal(ui.calls.some(call => call.method === 'records:delete'), false);
});

test('finishing a draft opens its editable notebook entry', async () => {
  const saved = { id: 'draft-a', status: 'draft', title: '新完成记录', transcript: '新原话', audioSegments: [], topicIds: [] };
  const records = [{ id: 'fixture-record', title: '组内原件', transcript: '原件', audioSegments: [], topicIds: [] }];
  const ui = await rendererHarness({ records, drafts: [saved], groups: [{ id: 'group-a', name: '旧组', recordIds: ['fixture-record'], records }], invokeHook(method) { if (method === 'draft:finish') { saved.status = 'saved'; records.push(saved); return saved; } } });
  await ui.run("selectRecord('fixture-record')"); ui.run("showView('drafts')"); await ui.run("sessionAction('draft:finish', null, 'draft-a')");
  assert.equal(ui.run('state.view'), 'notes');
  assert.deepEqual(ui.openedNoteIds, ['record:draft-a']);
});

test('Escape respects dirty editing confirmation and cannot quietly discard revisions', async () => {
  let approve = false; const ui = await rendererHarness({ confirm: () => approve }); await ui.edit(); await ui.input('#record-transcript-input', '应当保留的修订');
  await ui.emit(ui.document, 'keydown', { key: 'Escape' }); await ui.flush(); assert.equal(ui.run('state.detailDirty'), true); assert.equal(ui.nodes.get('#record-transcript-input').value, '应当保留的修订');
  approve = true; await ui.emit(ui.document, 'keydown', { key: 'Escape' }); await ui.flush(); assert.equal(ui.run('state.detailDirty'), false); assert.equal(ui.run('state.editingId'), null);
  const editor = descendants(ui.nodes.get('#record-detail')).find(item => item.classList.contains('record-editor')); assert.equal(editor.classList.contains('hidden'), true);
});

test('unorganized records show their original words immediately and not-applied transcription keeps a short actionable status', async () => {
  const ui = await rendererHarness({ record: { organization: null, jobs: [{ kind: 'transcribe', status: 'not-applied' }] } });
  const words = descendants(ui.nodes.get('#record-detail')).find(item => item.getAttribute('data-disclosure') === 'words'); assert.equal(words.classList.contains('hidden'), false);
  assert(descendants(words).some(item => item.textContent === '第一段\n第二段'));
  assert.equal(ui.record.audioSegments[0].transcript, '第一段'); assert.equal(ui.calls.some(call => call.method === 'records:update'), false);
  assert(!descendants(ui.nodes.get('#record-detail')).some(item => /^尚未整理摘要/u.test(item.textContent)));
});

test('theme creation and renaming validate the same 60-character limit locally with Chinese inline feedback', async () => {
  const ui = await rendererHarness({ topics: [{ id: 'topic-a', name: '已有主题' }] }); ui.run("showView('duplicates')");
  ui.document.querySelector('#new-topic-name');
  await ui.input('#new-topic-name', ' '); await ui.clickSelector('#create-topic'); assert.equal(ui.calls.some(call => call.method === 'topics:create'), false);
  await ui.input('#new-topic-name', '字'.repeat(61)); await ui.clickSelector('#create-topic'); assert.equal(ui.calls.some(call => call.method === 'topics:create'), false); assert.match(ui.nodes.get('#topic-management-status').textContent, /1–60/u);
  const row = ui.nodes.get('#topic-management-list').children[0]; assert.equal(row.children[1].maxLength, 60); row.children[1].value = '字'.repeat(61); await ui.emit(row.children[2], 'click'); assert.equal(ui.calls.some(call => call.method === 'topics:rename'), false); assert.match(ui.nodes.get('#topic-management-status').textContent, /分组名称/u);
  row.children[1].value = '可以保存的名字'; await ui.emit(row.children[2], 'click'); assert.equal(ui.calls.find(call => call.method === 'topics:rename').params.name, '可以保存的名字');
});


test('a delayed saved-draft preview cannot navigate away from the user\'s newer settings selection', async () => {
  const gate = deferred(); const saved = { id: 'saved-draft', status: 'saved', title: '已保存', audioSegments: [], transcript: '原话' };
  const ui = await rendererHarness({ invokeHook(method, params) { if (method === 'records:get' && params.id === saved.id) return gate.promise; } });
  ui.run("showView('drafts')"); const pending = ui.run("openDraft('saved-draft')"); await ui.flush(); ui.run("showView('settings')"); gate.resolve(saved); await pending;
  assert.equal(ui.run('state.view'), 'settings'); assert.equal(ui.run('state.selectedId'), 'fixture-record'); assert.equal(ui.calls.filter(call => call.method === 'records:get' && call.params.id === saved.id).length, 1);
});

test('draft completion keeps a newer user choice while its note opens', async () => {
  const gate = deferred();
  const draft = { id: 'draft-a', status: 'draft', title: '新完成记录', transcript: '新原话', audioSegments: [], topicIds: [] };
  const records = [{ id: 'fixture-record', title: '组内旧记录', transcript: '旧原话', audioSegments: [], topicIds: [] }]; const drafts = [draft];
  const ui = await rendererHarness({ records, drafts, openNote: () => gate.promise, invokeHook(method) {
    if (method === 'draft:finish') { draft.status = 'saved'; records.push(draft); drafts.splice(0); return draft; }
  } });
  await ui.run("selectRecord('fixture-record')"); ui.run("showView('drafts'); state.selectedDraftId = 'draft-a'");
  const pending = ui.run("sessionAction('draft:finish', null, 'draft-a')"); await ui.flush();
  assert.equal(ui.run('state.view'), 'notes'); assert.equal(ui.run('state.recordCount'), 2);
  assert.deepEqual(ui.openedNoteIds, ['record:draft-a']);
  ui.run("showView('settings')"); gate.resolve(draft); await pending;
  assert.equal(ui.run('state.view'), 'settings'); assert.deepEqual(ui.openedNoteIds, ['record:draft-a']); assert.equal(ui.run('state.draftBusy'), false);
});

test('record details offer no linked recording even when a legacy parent is present', async () => {
  const ui = await rendererHarness({ record: { parentRecordId: 'older-record' } });
  assert.ok(!descendants(ui.nodes.get('#record-detail')).some(item => /接着想|关联录音/u.test(item.textContent)));
});


test('group home display toggles preserve the live record nodes, search, filters and selection without data calls', async () => {
  const ui = await rendererHarness({ select:false });
  assert.equal(ui.run('state.libraryDisplay'), 'grid');
  const list=ui.nodes.get('#record-list'), card=list.children[0], search=ui.nodes.get('#search-input');
  ui.run("recordSelection.enabled=true; recordSelection.ids.add('fixture-record'); state.query='保留搜索'; state.filters={topicIds:[],uncategorized:true,from:123}; state.detailDirty=true;");
  search.value='保留搜索'; search.focus(); search.setSelectionRange(1,3); list.scrollTop=57;
  const before=ui.calls.length;
  await ui.clickSelector('#library-display-list');
  assert.equal(ui.run('state.libraryDisplay'),'list'); assert.equal(ui.nodes.get('#record-grid-host').getAttribute('data-library-display'),'list');
  assert.equal(list.children[0],card); assert.equal(list.scrollTop,57); assert.equal(ui.document.activeElement,search); assert.equal(search.selectionStart,1); assert.equal(search.selectionEnd,3);
  assert.equal(ui.run('recordSelection.ids.has("fixture-record")'),true); assert.equal(ui.run('recordSelection.enabled'),true); assert.equal(ui.run('state.detailDirty'),true);
  assert.equal(ui.run('state.query'),'保留搜索'); assert.equal(ui.run('state.filters.from'),123); assert.equal(ui.calls.length,before);
  assert.equal(ui.nodes.get('#library-display-list').getAttribute('aria-pressed'),'true'); assert.equal(ui.nodes.get('#library-display-grid').getAttribute('aria-pressed'),'false');
  await ui.clickSelector('#library-display-grid'); assert.equal(list.children[0],card); assert.equal(ui.run('state.libraryDisplay'),'grid');
});

test('home list preference persists across reload and group navigation while detail remains a separate title navigator', async () => {
  const values=new Map(), storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const records=[{id:'one',title:'未分类记录',createdAt:1,topicIds:[],transcript:'正文'},{id:'two',title:'阅读记录',createdAt:2,topicIds:['reading'],transcript:'阅读正文'}];
  const options={select:false,records,topics:[{id:'reading',name:'阅读'}],localStorage:storage};
  const ui=await rendererHarness(options); await ui.clickSelector('#library-display-list');
  assert.equal(values.get('inmoment.libraryDisplay'),'list');
  await ui.run("openPrimaryGroup('reading')"); assert.equal(ui.run('state.libraryDisplay'),'list');
  await ui.run("selectRecord('two')"); assert.equal(ui.run('state.libraryMode'),'detail'); assert.equal(ui.nodes.get('#library-display-controls').classList.contains('hidden'),true); assert.equal(ui.nodes.get('#record-list').parentElement,ui.nodes.get('#record-column'));
  ui.run('state.detailDirty=true'); await ui.clickSelector('#library-display-grid'); assert.equal(ui.run('state.libraryDisplay'),'list'); assert.equal(ui.run('state.detailDirty'),true);
  ui.run('state.detailDirty=false'); await ui.clickSelector('#back-to-group-home'); assert.equal(ui.run('state.libraryMode'),'home'); assert.equal(ui.nodes.get('#library-display-controls').classList.contains('hidden'),false); assert.equal(ui.run('state.libraryDisplay'),'list');
  const reloaded=await rendererHarness(options); assert.equal(reloaded.run('state.libraryDisplay'),'list'); assert.equal(reloaded.nodes.get('#library-display-list').getAttribute('aria-pressed'),'true');
});

test('display storage failure falls back to grid and does not block switching or record actions', async () => {
  const ui=await rendererHarness({select:false,localStorage:{getItem(){throw new Error('disabled');},setItem(){throw new Error('disabled');}}});
  assert.equal(ui.run('state.libraryDisplay'),'grid'); await ui.clickSelector('#library-display-list'); assert.equal(ui.run('state.libraryDisplay'),'list');
  const card=ui.nodes.get('#record-list').children[0], more=card.children.find(item=>item.getAttribute('data-record-more-id'));
  await ui.emit(more,'click'); assert.equal(ui.menus.at(-1).title,'灵感操作');
  const open=card.children.find(item=>item.getAttribute('data-record-open-id')); assert.equal(open.getAttribute('title'),ui.record.title);
  await ui.emit(open,'click'); assert.equal(ui.run('state.libraryMode'),'detail'); assert.equal(ui.run('state.selectedId'),ui.record.id);
});

test('primary groups are flat, start at uncategorized, and share one grid/list without changing multi-group data', async () => {
  const topics = [{ id: 'reading', name: '阅读' }, { id: 'product', name: '产品' }]; const records = [
    { id: 'fixture-record', title: '未分组记录', transcript: '一', topicIds: [], audioSegments: [] },
    { id: 'record-b', title: '阅读记录', transcript: '二', topicIds: ['reading'], audioSegments: [] },
    { id: 'record-c', title: '跨组记录', transcript: '三', topicIds: ['reading', 'product'], audioSegments: [] },
  ]; const original = JSON.stringify(records); const ui = await rendererHarness({ topics, records, select: false });
  assert.equal(ui.run('state.libraryGroupId'), 'uncategorized'); assert.equal(ui.run('state.libraryMode'), 'home'); assert.equal(ui.document.body.classList.contains('record-detail-open'), false);
  const nav = ui.nodes.get('#primary-group-navigation'); assert.deepEqual(nav.children.map(item => item.getAttribute('data-library-group-id')), ['uncategorized', 'reading', 'product']); assert(nav.children.every(item => item.parentElement === nav)); assert.deepEqual(ui.run('Array.from(state.visibleRecords, record => record.id)'), ['fixture-record']);
  await ui.emit(nav.children.find(item => item.getAttribute('data-library-group-id') === 'reading'), 'click'); assert.equal(ui.nodes.get('#collection-heading').textContent, '阅读'); assert.deepEqual(Array.from(ui.run('state.visibleRecords'), item => item.id), ['record-b', 'record-c']);
  const list = ui.nodes.get('#record-list'); list.scrollTop = 88; const entry = list.children[0].children.find(item => item.getAttribute('data-record-open-id')); await ui.emit(entry, 'click');
  assert.equal(ui.run('state.libraryMode'), 'detail'); assert.equal(ui.document.body.classList.contains('record-detail-open'), true); assert.equal(ui.run('state.libraryGroupId'), 'reading');
  await ui.clickSelector('#back-to-group-home'); assert.equal(ui.run('state.libraryMode'), 'home'); assert.equal(ui.document.body.classList.contains('record-detail-open'), false); assert.equal(list.scrollTop, 88); assert.equal(ui.run('state.selectedId'), null);
  await ui.emit(nav.children.find(item => item.getAttribute('data-library-group-id') === 'product'), 'click'); assert.deepEqual(Array.from(ui.run('state.visibleRecords'), item => item.id), ['record-c']); assert.equal(JSON.stringify(records), original);
  assert.equal(ui.calls.some(call => ['records:setTopics', 'records:update', 'settings:save', 'settings:reset', 'draft:startManual', 'records:organize'].includes(call.method)), false);
});

test('date and keyword changes stay inside the selected group and the retired clear-filters control has no action', async () => {
  const ui = await rendererHarness({ topics: [{ id: 'reading', name: '阅读' }], records: [{ id: 'fixture-record', title: '阅读', transcript: '内容', topicIds: ['reading'], audioSegments: [] }], select: false }); await ui.run("openPrimaryGroup('reading')"); ui.nodes.get('#date-range').value = '7'; await ui.emit(ui.nodes.get('#date-range'), 'change'); await ui.run("search('模糊记忆')"); ui.nodes.get('#date-range').value = 'all'; await ui.emit(ui.nodes.get('#date-range'), 'change'); await ui.run("search('')"); const request = ui.calls.filter(call => call.method === 'records:list').at(-1).params; assert.deepEqual(Array.from(request.filters.topicIds), ['reading']); assert.equal(request.filters.from, undefined); assert.equal(request.query, ''); assert.equal(ui.run('state.libraryGroupId'), 'reading'); assert.equal(ui.nodes.get('#clear-filters')?.handlers.click?.length || 0, 0);
});

test('the sidebar creates a primary group explicitly and its manager opens without starting capture or AI', async () => {
  const topics = []; const ui = await rendererHarness({ topics, select: false, invokeHook(method, params) { if (method === 'topics:create') { const topic = { id: 'created-group', name: params.name }; topics.push(topic); return topic; } } });
  await ui.clickSelector('#create-primary-group'); assert.equal(ui.nodes.get('#primary-group-create-form').classList.contains('hidden'), false); await ui.input('#primary-group-name', '我的新分组'); await ui.emit(ui.nodes.get('#primary-group-create-form'), 'submit');
  assert.equal(ui.calls.find(call => call.method === 'topics:create').params.name, '我的新分组'); assert.equal(ui.run('state.libraryGroupId'), 'created-group'); assert.equal(ui.run('state.libraryMode'), 'home'); assert.equal(ui.nodes.get('#primary-group-create-form').classList.contains('hidden'), true);
  await ui.clickSelector('#open-primary-group-manager'); assert.equal(ui.nodes.get('#group-management-dialog').open, true); await ui.clickSelector('#close-group-management'); assert.equal(ui.nodes.get('#group-management-dialog').open, false); assert.equal(ui.calls.some(call => ['draft:startManual', 'records:organize', 'records:aiSearch'].includes(call.method)), false);
});

test('new AI group suggestions need a second confirmation, preserve originals, and keep the selected record temporarily in its original view', async () => {
  let allow = false; let activeRecord; const topics = [{ id: 'existing', name: '已有分组' }];
  const ui = await rendererHarness({ topics, record: { organization: { summary: '摘要', topicSuggestions: ['建议新分组', '已有分组'] }, version: 1 }, confirm: () => allow, invokeHook(method, params) {
    if (method === 'topics:create') { const topic = { id: 'new-group', name: params.name }; topics.push(topic); return topic; }
    if (method === 'records:setTopics') { activeRecord.topicIds = Array.from(params.topicIds); activeRecord.topics = topics.filter(topic => params.topicIds.includes(topic.id)); return activeRecord; }
  } }); activeRecord = ui.record; const transcript = activeRecord.transcript; const segments = JSON.stringify(activeRecord.audioSegments);
  let suggestions = descendants(ui.nodes.get('#record-detail')).filter(item => item.getAttribute('data-topic-suggestion-name')); assert.deepEqual(suggestions.map(item => item.getAttribute('data-topic-suggestion-name')), ['建议新分组', '已有分组']);
  await ui.emit(suggestions[0], 'click'); assert.equal(ui.confirmations.at(-1).confirmLabel, '创建并归入'); assert.equal(ui.calls.some(call => call.method === 'topics:create' || call.method === 'records:setTopics'), false);
  allow = true; await ui.emit(suggestions[0], 'click'); assert.equal(ui.calls.filter(call => call.method === 'topics:create').length, 1); assert.deepEqual(activeRecord.topicIds, ['new-group']); assert.equal(activeRecord.transcript, transcript); assert.equal(JSON.stringify(activeRecord.audioSegments), segments);
  assert.equal(ui.run('state.libraryGroupId'), 'uncategorized'); assert.equal(ui.run('state.selectedId'), activeRecord.id); assert.equal(ui.run('state.libraryMode'), 'detail'); assert.equal(ui.nodes.get('#primary-group-navigation').children.find(item => item.getAttribute('data-library-group-id') === 'new-group').getAttribute('aria-pressed'), 'false'); assert.equal(ui.run('state.recordProjection.record.id'), activeRecord.id); assert.equal(ui.calls.some(call => call.method === 'records:update'), false);
});

test('accepting an existing suggested group adds membership and retains every previous group without creating a duplicate', async () => {
  let activeRecord; const topics = [{ id: 'old', name: '原分组' }, { id: 'existing', name: '已有分组' }]; const ui = await rendererHarness({ topics, record: { topicIds: ['old'], organization: { summary: '摘要', topicSuggestions: ['已有分组'] } }, invokeHook(method, params) { if (method === 'records:setTopics') { activeRecord.topicIds = Array.from(params.topicIds); return activeRecord; } } }); activeRecord = ui.record;
  await ui.suggest('已有分组'); assert.deepEqual(activeRecord.topicIds, ['old', 'existing']); assert.equal(ui.calls.some(call => call.method === 'topics:create'), false); assert.equal(ui.confirmations.length, 0);
});

test('inline title Enter saves only the title once and preserves newer typing until explicit Escape discard', async () => {
  const gate = deferred(); let activeRecord; let allow = false; const ui = await rendererHarness({ record: { version: 1 }, confirm: () => allow, invokeHook(method, params) { if (method === 'records:update') return gate.promise.then(() => { activeRecord.title = params.title; activeRecord.editableTitle = params.title; activeRecord.version = 2; return activeRecord; }); } }); activeRecord = ui.record;
  await ui.rename(); await ui.input('#field-记录标题', '已提交标题'); const field = ui.nodes.get('#field-记录标题'); const pending = ui.emit(field, 'keydown', { key: 'Enter' }); await ui.flush(); await ui.emit(field, 'keydown', { key: 'Enter', repeat: true }); await ui.input('#field-记录标题', '等待保存时继续输入');
  const update = ui.latestUpdate(); assert.equal(update.title, '已提交标题'); assert.equal(update.expectedVersion, 1); assert.equal(Object.hasOwn(update, 'transcriptSegments'), false); assert.equal(Object.hasOwn(update, 'task'), false); assert.equal(ui.calls.filter(call => call.method === 'records:update').length, 1);
  gate.resolve(); await pending; assert.equal(ui.nodes.get('#field-记录标题').value, '等待保存时继续输入'); assert.equal(ui.run('state.detailDirty'), true);
  await ui.emit(field, 'keydown', { key: 'Escape' }); assert.equal(ui.run('state.detailDirty'), false); assert.equal(ui.nodes.get('#field-记录标题').value, '已提交标题'); assert.equal(ui.confirmations.length,0);
});

test('one voice card combines local playback and transcript while screenshots follow as a separate source section', async () => {
  const ui = await rendererHarness({ record: { screenshotUrl: screenshotFixture, organization: { summary: '生成的一段摘要', uncertainties: ['待验证'], context: { source: 'ai_screenshot', description: '推测现场' } } } }); const inner = ui.nodes.get('#record-detail').children[0];
  const positions = ['record-title-row', 'record-file-actions', 'record-ai-toolbar', 'voice-note', 'record-screenshot-section'].map(name => inner.children.findIndex(item => item.classList.contains(name))); assert(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1]))); assert.equal(descendants(inner).filter(item => item.classList.contains('record-text-panel')).length, 1);
  const voice = inner.children.find(item => item.classList.contains('voice-note')); const audioPosition = voice.children.findIndex(item => item.classList.contains('record-audio-section')); const textPosition = voice.children.findIndex(item => item.classList.contains('record-text-panel')); assert(audioPosition >= 0 && textPosition > audioPosition, 'playback sits immediately above its transcript inside the same card');
  const panel = descendants(inner).find(item => item.classList.contains('record-text-panel')); const summary = descendants(panel).find(item => item.classList.contains('text-panel-summary')); const source = descendants(panel).find(item => item.classList.contains('text-panel-original')); assert.equal(summary.classList.contains('hidden'), false); assert.equal(source.classList.contains('hidden'), true);
  const proof = descendants(summary).find(item => item.getAttribute('data-disclosure') === 'summary-evidence'); assert.equal(proof.open, false); const before = ui.record.transcript; await ui.emit(descendants(panel).find(item => item.getAttribute('data-action') === 'show-original'), 'click'); assert.equal(source.classList.contains('hidden'), false); assert.equal(summary.classList.contains('hidden'), true); assert.equal(ui.record.transcript, before); assert.equal(ui.calls.some(call => call.method === 'records:update'), false);
  const fileActions = descendants(inner).find(item => item.classList.contains('record-file-actions')); assert.equal(descendants(inner).some(item => item.getAttribute('data-action') === 'open-original'), false); const fileButtons = descendants(fileActions).filter(item => item.getAttribute('data-action')); assert.deepEqual(fileButtons.map(item => item.getAttribute('data-action')), ['reveal-record']); assert.equal(fileButtons[0].textContent, '打开所在文件夹'); await ui.emit(fileButtons[0], 'click'); const folderCalls = ui.calls.filter(call => call.method === 'media:reveal-record'); assert.equal(folderCalls.length, 1); assert.deepEqual(Object.keys(folderCalls[0].params), ['id']); assert.equal(folderCalls[0].params.id, 'fixture-record'); assert.equal(ui.calls.some(call => call.method === 'media:open-original'), false);
});

test('the same record list moves between grid and full-height column while preserving focus and handlers', async () => {
  const ui = await rendererHarness({ select: false }); const list = ui.nodes.get('#record-list'); assert.equal(list.parentElement, ui.nodes.get('#record-grid-host'));
  const open = list.children[0].children.find(item => item.getAttribute('data-record-open-id')); open.focus(); await ui.emit(open, 'click'); assert.equal(list.parentElement, ui.nodes.get('#record-column')); assert.equal(ui.document.activeElement.getAttribute('data-record-open-id'), 'fixture-record');
  await ui.event({ type: 'recordsChanged' }); assert.equal(list.parentElement, ui.nodes.get('#record-column')); assert.equal(ui.document.activeElement.parentElement.parentElement, list);
  ui.run("showView('settings')"); assert.equal(list.parentElement, ui.nodes.get('#record-grid-host')); ui.run("showView('inbox')"); assert.equal(list.parentElement, ui.nodes.get('#record-column')); await ui.clickSelector('#back-to-group-home'); assert.equal(list.parentElement, ui.nodes.get('#record-grid-host')); assert.equal(ui.nodes.get('#record-list'), list);
});

test('detail list controls stay in the record column through selection and anchored actions, then return to the home grid', async () => {
  const records = ['first', 'second', 'third'].map(id => ({ id, title: id, transcript: id + ' text', version: 1, topicIds: [], audioSegments: [] }));
  const ui = await rendererHarness({ select: false, records, confirm: () => false, groupPicker: () => null });
  const ids = ['collection-toolbar', 'library-filters', 'library-feedback']; const originals = ids.map(id => ui.nodes.get('#' + id));
  assert(originals.every(element => element.parentElement === ui.nodes.get('#inbox-view')));
  await ui.run("selectRecord('first')"); await ui.flush();
  const header = ui.nodes.get('#record-column-header'), column = ui.nodes.get('#record-column'); const toolbar = ui.nodes.get('#record-selection-toolbar');
  assert.equal(header.parentElement, column); assert(originals.every(element => element.parentElement === header)); assert.equal(toolbar.parentElement, header); assert.equal(ui.nodes.get('#load-more').parentElement, column);
  const detail = ui.nodes.get('#record-detail').children[0];
  await ui.clickSelector('#toggle-record-selection'); assert.equal(toolbar.parentElement, header);
  await ui.clickSelector('#select-visible-records'); assert.equal(ui.run('recordSelection.ids.size'), 3); assert.equal(toolbar.parentElement, header);
  await ui.clickSelector('#add-selected-records'); assert.equal(ui.pickers.at(-1).anchor, ui.nodes.get('#add-selected-records')); assert.equal(toolbar.parentElement, header);
  await ui.clickSelector('#delete-selected-records'); assert.equal(ui.confirmations.at(-1).anchor, ui.nodes.get('#delete-selected-records')); assert.equal(ui.run('recordSelection.ids.size'), 3);
  assert.equal(ui.nodes.get('#record-detail').children[0], detail); assert.equal(toolbar.parentElement, header); assert(originals.every(element => element.parentElement === header));
  assert.equal(ui.calls.some(call => /^(records:(delete|setTopics|organize|aiSearch)|library:batchOrganize)$/u.test(call.method)), false);
  await ui.clickSelector('#back-to-group-home');
  assert(originals.every((element, index) => element === ui.nodes.get('#' + ids[index]) && element.parentElement === ui.nodes.get('#inbox-view')));
  assert.equal(toolbar.parentElement, ui.nodes.get('#record-grid-host')); assert.equal(ui.nodes.get('#load-more').parentElement, ui.nodes.get('#inbox-view')); assert.equal(ui.run('recordSelection.enabled'), false);
});

test('moving the shared search controls preserves their focused field and selection range', async () => {
  const ui = await rendererHarness({ select: false }); const input = ui.nodes.get('#search-input'); input.value = '保留这段搜索'; input.focus(); input.setSelectionRange(1, 4, 'backward');
  ui.run("state.libraryMode = 'detail'; updateLibraryLayout()");
  assert.equal(ui.document.activeElement, input); assert.equal(input.selectionStart, 1); assert.equal(input.selectionEnd, 4); assert.equal(input.selectionDirection, 'backward');
  assert.equal(ui.nodes.get('#collection-toolbar').parentElement, ui.nodes.get('#record-column-header'));
  ui.run("state.libraryMode = 'home'; updateLibraryLayout()");
  assert.equal(ui.document.activeElement, input); assert.equal(input.value, '保留这段搜索'); assert.equal(input.selectionStart, 1); assert.equal(input.selectionEnd, 4);
  assert.equal(ui.nodes.get('#collection-toolbar').parentElement, ui.nodes.get('#inbox-view'));
});

test('sidebar selection and a cancelled filter leave unsaved detail text in place', async () => {
  const ui = await rendererHarness(); await ui.edit(); await ui.input('#record-transcript-input', '侧栏操作时保留的原文修改');
  const field = ui.nodes.get('#record-transcript-input'), editor = ui.nodes.get('#record-detail').children[0];
  await ui.clickSelector('#toggle-record-selection'); await ui.clickSelector('#library-filter-trigger'); await ui.flush();
  assert.equal(field.value, '侧栏操作时保留的原文修改'); assert.equal(ui.run('state.detailDirty'), true); assert.equal(ui.nodes.get('#record-detail').children[0], editor);
  assert.equal(ui.nodes.get('#record-selection-toolbar').parentElement, ui.nodes.get('#record-column-header')); assert.equal(ui.nodes.get('#library-filters').parentElement, ui.nodes.get('#record-column-header'));
  assert.equal(ui.calls.some(call => call.method === 'records:update'), false);
});

test('accepted classification remains a temporary projection until the user selects another record or group', async () => {
  let active; const topics = [{ id: 'target', name: '目标组' }]; const ui = await rendererHarness({ topics, record: { organization: { summary: '摘要', topicSuggestions: ['目标组'] } }, invokeHook(method, params) { if (method === 'records:setTopics') { active.topicIds = Array.from(params.topicIds); active.topics = topics.filter(topic => params.topicIds.includes(topic.id)); return active; } } }); active = ui.record;
  await ui.suggest('目标组'); await ui.event({ type: 'recordsChanged' }); assert.equal(ui.run('state.libraryGroupId'), 'uncategorized'); assert.equal(ui.run('state.selectedId'), 'fixture-record'); assert.equal(ui.run('state.visibleRecords[0].id'), active.id); assert.equal(ui.run('state.recordProjection.record.id'), active.id); assert.equal(ui.records.length, 1);
  ui.records.push({ id: 'other', title: '其他未分类记录', transcript: '其他原文', audioSegments: [], topicIds: [], version: 1 }); await ui.event({ type: 'recordsChanged' }); assert.deepEqual(Array.from(ui.run('state.visibleRecords'), item => item.id), ['fixture-record', 'other']);
  await ui.run("selectRecord('other')"); assert.equal(ui.run('state.recordProjection'), null); assert.deepEqual(Array.from(ui.run('state.visibleRecords'), item => item.id), ['other']); assert.equal(ui.run('state.libraryGroupId'), 'uncategorized'); await ui.run("openPrimaryGroup('target')"); assert.deepEqual(Array.from(ui.run('state.visibleRecords'), item => item.id), ['fixture-record']); assert.equal(ui.records.length, 2);
});

test('AI search opens a dialog without calling a model and displays a visible error for empty descriptions', async () => {
  const ui = await rendererHarness({ settings: { cloudEnabled: true, aiSearchEnabled: true } }); await ui.clickSelector('#ai-search'); assert.equal(ui.nodes.get('#ai-search-dialog').open, true); assert.equal(ui.nodes.get('#ai-search-scope').value, 'all'); assert.equal(ui.calls.some(call => call.method === 'records:aiSearch'), false);
  await ui.input('#ai-search-description', '   '); await ui.submitAISearch(); assert.equal(ui.nodes.get('#ai-search-error').classList.contains('hidden'), false); assert.match(ui.nodes.get('#ai-search-error').textContent, /先描述/u); assert.equal(ui.calls.some(call => call.method === 'records:aiSearch'), false);
});

test('AI search defaults to all records and all time, then renders the backend-applied natural date scope as a grid filter', async () => {
  const from = Date.parse('2026-09-01T00:00:00Z'); const to = Date.parse('2026-10-01T00:00:00Z'); const found = { id: 'outside-current-group', title: '上月的想法', transcript: '找到的原文', audioSegments: [], topicIds: ['other'], version: 1 };
  const ui = await rendererHarness({ settings: { cloudEnabled: true, aiSearchEnabled: true }, invokeHook(method) { if (method === 'records:aiSearch') return { records: [found], scopeTotal: 12, candidateCount: 4, appliedFilters: { from, to }, scopeDescription: '全部灵感 · 上个月（上海时间）', timeInterpretation: { source: 'description', label: '上个月', timezone: 'Asia/Shanghai' }, explanation: '按语义找到相关记录', coverage: { examinedCount: 4 } }; } });
  ui.nodes.get('#date-range').value = '7'; await ui.clickSelector('#ai-search'); await ui.input('#ai-search-description', '上个月关于阅读联想的想法'); await ui.submitAISearch(); const request = ui.calls.find(call => call.method === 'records:aiSearch').params; assert.deepEqual(Object.keys(request.filters), []); assert.equal(ui.run('state.filters.from'), from); assert.equal(ui.run('state.filters.to'), to); assert.match(ui.nodes.get('#library-status').textContent, /上个月（上海时间）/u); assert.equal(ui.run('state.libraryMode'), 'home'); assert.equal(ui.document.body.classList.contains('record-detail-open'), false); assert.equal(ui.nodes.get('#collection-heading').textContent, 'AI 查找结果'); assert.equal(ui.nodes.get('#primary-group-navigation').children.some(button => button.getAttribute('aria-pressed') === 'true'), false);
});

test('AI search sends current group only when chosen, and model failures remain visible without replacing existing records', async () => {
  const ui = await rendererHarness({ topics: [{ id: 'reading', name: '阅读' }], settings: { cloudEnabled: true, aiSearchEnabled: true }, invokeHook(method) { if (method === 'records:aiSearch') throw new Error('语义模型尚未安装，请先在设置中安装。'); } }); await ui.run("openPrimaryGroup('reading')"); await ui.clickSelector('#ai-search'); await ui.input('#ai-search-description', '模糊记得的内容'); ui.nodes.get('#ai-search-scope').value = 'current'; await ui.submitAISearch(); const request = ui.calls.find(call => call.method === 'records:aiSearch').params; assert.deepEqual(Array.from(request.filters.topicIds), ['reading']); assert.equal(request.filters.from, undefined); assert.match(ui.nodes.get('#ai-search-error').textContent, /尚未安装/u); assert.equal(ui.nodes.get('#ai-search-dialog').open, true); assert.equal(ui.nodes.get('#submit-ai-search').disabled, false); assert.equal(ui.run('state.libraryGroupId'), 'reading');
});

test('batch organization freezes only rendered page IDs and versions and ignores out-of-scope results', async () => {
  const gate = deferred(); const records = Array.from({ length: 25 }, (_, index) => ({ id: index === 0 ? 'fixture-record' : 'record-' + index, title: '记录' + index, transcript: '原文' + index, audioSegments: [], topicIds: index >= 20 ? ['other'] : [], version: 1 }));
  const ui = await rendererHarness({ records, topics: [{ id: 'other', name: '其他组' }], select: false, invokeHook(method) { if (method === 'library:batchOrganize') return gate.promise; } }); const snapshot = ui.nodes.get('#record-list').children.map(card => card.getAttribute('data-record-id')); assert.equal(snapshot.length, 20);
  const pending = ui.clickSelector('#batch-organize'); await ui.flush(); const request = ui.calls.find(call => call.method === 'library:batchOrganize').params; assert.deepEqual(Array.from(request.recordIds), snapshot); assert.deepEqual(Object.keys(request.expectedVersions), snapshot); assert(Object.values(request.expectedVersions).every(version => version === 1));
  await ui.run("openPrimaryGroup('other')"); await ui.event({ type: 'batchOrganizeProgress', runId: 'run', total: 20, completed: 1, recordId: 'record-24', status: 'success' }); assert.equal(ui.run('state.batchRunId'), null);
  await ui.event({ type: 'batchOrganizeProgress', runId: 'run', total: 20, completed: 1, recordId: snapshot[0], status: 'success' }); assert.match(ui.nodes.get('#batch-status').textContent, /1 \/ 20/u);
  gate.resolve({ runId: 'run', items: [...snapshot.map((id, index) => ({ id, status: index === 0 ? 'success' : index === 1 ? 'failed' : 'not-processed', error: index ? '模拟未完成' : undefined, topicSuggestions: ['建议组'] })), { id: 'record-24', status: 'success' }], usage: { total_tokens: 5, unknownUsageRequests: 1 } }); await pending;
  assert.equal(ui.run('state.libraryGroupId'), 'other'); assert.deepEqual(descendants(ui.nodes.get('#batch-results-list')).filter(row => row.getAttribute('data-batch-record-id')).map(row => row.getAttribute('data-batch-record-id')), snapshot); assert.match(ui.nodes.get('#batch-results-status').textContent, /范围外/u); assert.match(ui.nodes.get('#batch-status').textContent, /仍可能计费/u); assert.equal(ui.nodes.get('#batch-results-dialog').open, true); assert.equal(ui.nodes.get('#cancel-batch').classList.contains('hidden'), true); assert.equal(ui.calls.some(call => call.method === 'topics:create' || call.method === 'records:setTopics'), false);
});

test('cancelling a matching batch run dismisses partial results and suppresses late progress and completion dialogs', async () => {
  const gate = deferred(); const ui = await rendererHarness({ invokeHook(method) { if (method === 'library:batchOrganize') return gate.promise; } });
  const pending = ui.clickSelector('#batch-organize'); await ui.flush();
  await ui.event({ type: 'batchOrganizeProgress', runId: 'cancel-run', total: 1, completed: 0, recordId: 'fixture-record', status: 'processing' });
  await ui.clickSelector('#cancel-batch'); const cancellation = ui.calls.find(call => call.method === 'library:cancel').params;
  assert.equal(cancellation.kind, 'batchOrganize'); assert.equal(cancellation.runId, 'cancel-run');
  await ui.event({ type: 'batchOrganizeProgress', runId: 'cancel-run', total: 1, completed: 1, recordId: 'fixture-record', status: 'success' });
  assert.match(ui.nodes.get('#batch-status').textContent, /已取消/u);
  // A request can finish before the main-process cancellation arrives. User intent still wins in the UI.
  gate.resolve({ runId: 'cancel-run', cancelled: false, items: [{ id: 'fixture-record', status: 'success', record: ui.record, topicSuggestions: ['新组'] }] }); await pending;
  assert.equal(Boolean(ui.nodes.get('#batch-results-dialog')?.open), false); assert.equal(ui.nodes.get('#batch-results-list')?.children.length || 0, 0);
  assert.equal(ui.run('state.batchResultItems.length'), 0); assert.equal(ui.run('state.batchChoices.size'), 0); assert.equal(ui.run('state.batchBusy'), false);
  assert.equal(ui.nodes.get('#cancel-batch').classList.contains('hidden'), true); assert.equal(ui.calls.some(call => call.method === 'topics:create' || call.method === 'records:setTopics'), false);
});

test('cancelled batch consent never opens results, whether returned with or without unprocessed items', async () => {
  for (const result of [{ cancelled: true }, { cancelled: true, items: [{ id: 'fixture-record', status: 'not-processed', error: '已取消，未发送这条记录。' }] }, { canceled: true, items: [] }]) {
    const ui = await rendererHarness({ invokeHook(method) { if (method === 'library:batchOrganize') return result; } });
    await ui.clickSelector('#batch-organize');
    assert.equal(Boolean(ui.nodes.get('#batch-results-dialog')?.open), false); assert.equal(ui.nodes.get('#batch-results-list')?.children.length || 0, 0);
    assert.match(ui.nodes.get('#batch-status').textContent, /已取消/u); assert.equal(ui.run('state.batchResultItems.length'), 0);
    assert.equal(ui.nodes.get('#batch-organize').disabled, false); assert.equal(ui.calls.some(call => call.method === 'topics:create' || call.method === 'records:setTopics'), false);
  }
});

test('an abort rejection after batch cancellation stays quiet and a later retry can show fresh results', async () => {
  const gate = deferred(); let attempt = 0;
  const ui = await rendererHarness({ invokeHook(method) { if (method === 'library:batchOrganize') return ++attempt === 1 ? gate.promise : { items: [{ id: 'fixture-record', status: 'success', topicSuggestions: ['重新整理'] }] }; } });
  const pending = ui.clickSelector('#batch-organize'); await ui.flush(); await ui.clickSelector('#cancel-batch');
  gate.reject(new Error('AI request was cancelled or timed out.')); await pending;
  assert.equal(Boolean(ui.nodes.get('#batch-results-dialog')?.open), false); assert.match(ui.nodes.get('#batch-status').textContent, /已取消/u); assert.doesNotMatch(ui.nodes.get('#batch-status').textContent, /失败/u);
  await ui.clickSelector('#batch-organize'); assert.equal(ui.run('state.batchCancelRequested'), false); assert.equal(ui.nodes.get('#batch-results-dialog').open, true); assert.equal(ui.run('state.batchChoices.get("fixture-record")'), '重新整理');
});

test('a delayed cancel reply cannot overwrite a newer batch cancellation, even when run identifiers repeat', async () => {
  for (const failOldReply of [false, true]) {
    const firstBatch = deferred(), secondBatch = deferred(), firstCancel = deferred(), secondCancel = deferred(); let batches = 0, cancellations = 0;
    const ui = await rendererHarness({ invokeHook(method) {
      if (method === 'library:batchOrganize') return ++batches === 1 ? firstBatch.promise : secondBatch.promise;
      if (method === 'library:cancel') return ++cancellations === 1 ? firstCancel.promise : secondCancel.promise;
    } });
    const firstRun = ui.clickSelector('#batch-organize'); await ui.flush();
    await ui.event({ type: 'batchOrganizeProgress', runId: 'repeated-run', total: 1, completed: 0, recordId: 'fixture-record', status: 'processing' });
    const oldSnapshot = ui.run('state.batchSnapshot'); const oldCancel = ui.clickSelector('#cancel-batch'); await ui.flush();
    assert.equal(ui.nodes.get('#cancel-batch').disabled, true);
    firstBatch.resolve({ cancelled: true, items: [] }); await firstRun;
    const newRun = ui.clickSelector('#batch-organize'); await ui.flush();
    assert.notEqual(ui.run('state.batchSnapshot'), oldSnapshot); assert.equal(ui.nodes.get('#cancel-batch').disabled, false);
    await ui.event({ type: 'batchOrganizeProgress', runId: 'repeated-run', total: 1, completed: 0, recordId: 'fixture-record', status: 'processing' });
    const newCancel = ui.clickSelector('#cancel-batch'); await ui.flush(); const status = ui.nodes.get('#batch-status').textContent;
    if (failOldReply) firstCancel.reject(new Error('旧任务取消回复失败')); else firstCancel.resolve({ cancelled: true });
    await oldCancel;
    assert.equal(ui.nodes.get('#batch-status').textContent, status); assert.equal(ui.run('state.batchCancelRequested'), true);
    assert.equal(ui.nodes.get('#cancel-batch').disabled, true); assert.equal(Boolean(ui.nodes.get('#batch-results-dialog')?.open), false);
    secondCancel.resolve({ cancelled: true }); await newCancel; secondBatch.resolve({ cancelled: true, items: [] }); await newRun;
    assert.equal(Boolean(ui.nodes.get('#batch-results-dialog')?.open), false);
  }
});

test('a failed cancel reply after its batch finished cannot alter the finished cancellation state', async () => {
  const batch = deferred(), cancellation = deferred();
  const ui = await rendererHarness({ invokeHook(method) { if (method === 'library:batchOrganize') return batch.promise; if (method === 'library:cancel') return cancellation.promise; } });
  const pending = ui.clickSelector('#batch-organize'); await ui.flush(); const cancel = ui.clickSelector('#cancel-batch'); await ui.flush();
  batch.resolve({ cancelled: true, items: [] }); await pending; const status = ui.nodes.get('#batch-status').textContent;
  cancellation.reject(new Error('迟到的取消失败')); await cancel;
  assert.equal(ui.run('state.batchBusy'), false); assert.equal(ui.run('state.batchCancelRequested'), true);
  assert.equal(ui.nodes.get('#batch-status').textContent, status); assert.equal(Boolean(ui.nodes.get('#batch-results-dialog')?.open), false);
});

test('batch organization rejects an empty page, missing versions, and more than 100 rendered records before making a request', async () => {
  const empty = await rendererHarness({ records: [], select: false }); await empty.clickSelector('#batch-organize'); assert.match(empty.nodes.get('#batch-status').textContent, /没有可整理/u); assert.equal(empty.calls.some(call => call.method === 'library:batchOrganize'), false);
  const missing = await rendererHarness({ record: { version: undefined } }); await missing.clickSelector('#batch-organize'); assert.match(missing.nodes.get('#batch-status').textContent, /版本不可用/u); assert.equal(missing.calls.some(call => call.method === 'library:batchOrganize'), false);
  const records = Array.from({ length: 105 }, (_, index) => ({ id: index === 0 ? 'fixture-record' : 'record-' + index, title: '记录' + index, transcript: '原文', audioSegments: [], topicIds: [], version: 1 })); const many = await rendererHarness({ records, select: false }); for (let index = 0; index < 5; index += 1) await many.clickSelector('#load-more'); assert.equal(many.nodes.get('#record-list').children.length, 105); await many.clickSelector('#batch-organize'); assert.match(many.nodes.get('#batch-status').textContent, /超过 100/u); assert.equal(many.calls.some(call => call.method === 'library:batchOrganize'), false);
});

test('batch suggestions stay unapplied until review confirmation, then preserve original data and deduplicate new groups', async () => {
  let allow = false; const topics = []; const records = [{ id: 'fixture-record', title: '记录一', transcript: '原文一', audioSegments: [{ id: 'audio-one', transcript: '原文一' }], topicIds: [], version: 1 }, { id: 'record-b', title: '记录二', transcript: '原文二', audioSegments: [], topicIds: [], version: 1 }]; const originals = records.map(record => ({ transcript: record.transcript, audio: JSON.stringify(record.audioSegments) }));
  const ui = await rendererHarness({ records, topics, confirm: () => allow, invokeHook(method, params) {
    if (method === 'library:batchOrganize') return { runId: 'review-run', items: records.map(record => ({ id: record.id, status: 'success', record, topicSuggestions: ['同一个新组'] })) };
    if (method === 'topics:create') { const topic = { id: 'new', name: params.name }; topics.push(topic); return topic; }
    if (method === 'records:setTopics') { const record = records.find(item => item.id === params.id); record.topicIds = Array.from(params.topicIds); return record; }
  } }); await ui.clickSelector('#batch-organize'); assert.equal(ui.calls.some(call => call.method === 'records:setTopics' || call.method === 'topics:create'), false);
  assert.deepEqual(Array.from(ui.run('state.batchChoices.values()')), ['同一个新组', '同一个新组']); assert.deepEqual(ui.nodes.get('#batch-results-list').children.map(group => group.getAttribute('data-batch-group-name')), ['同一个新组']); assert.equal(descendants(ui.nodes.get('#batch-results-list')).some(item => item.tag === 'select'), false);
  await ui.clickSelector('#apply-batch-groups'); assert.equal(ui.calls.some(call => call.method === 'topics:create'), false); assert.equal(ui.confirmations.at(-1).confirmLabel, '确认应用分类');
  allow = true; await ui.clickSelector('#apply-batch-groups'); assert.equal(ui.calls.filter(call => call.method === 'topics:create').length, 1); assert.deepEqual(ui.calls.filter(call => call.method === 'records:setTopics').map(call => call.params.id), ['fixture-record', 'record-b']); assert(records.every(record => record.topicIds[0] === 'new')); assert.equal(ui.run('state.libraryGroupId'), 'uncategorized'); assert.equal(ui.run('state.recordProjection.record.id'), 'fixture-record'); assert.equal(ui.nodes.get('#apply-batch-groups').disabled, true);
  records.forEach((record, index) => { assert.equal(record.transcript, originals[index].transcript); assert.equal(JSON.stringify(record.audioSegments), originals[index].audio); }); assert.equal(ui.calls.some(call => call.method === 'records:update'), false);
});

test('a record changed after batch review fails classification locally rather than applying a stale suggestion', async () => {
  const record = { id: 'fixture-record', title: '记录', transcript: '原文', audioSegments: [], topicIds: [], version: 1 }; const ui = await rendererHarness({ records: [record], invokeHook(method) { if (method === 'library:batchOrganize') return { runId: 'stale', items: [{ id: record.id, status: 'success', record: { ...record }, topicSuggestions: ['新组'] }] }; } }); await ui.clickSelector('#batch-organize'); record.version = 2; await ui.clickSelector('#apply-batch-groups'); assert.equal(ui.calls.some(call => call.method === 'topics:create' || call.method === 'records:setTopics'), false); assert.match(descendants(ui.nodes.get('#batch-results-list')).map(item => item.textContent).join(' '), /内容已更新/u);
});

test('batch classification preserves choices and edited text when the user edited during organization', async () => {
  const gate = deferred(); const record = { id: 'fixture-record', title: '记录', transcript: '原文', audioSegments: [{ id: 'audio-one', transcript: '原文' }], topicIds: [], version: 1 };
  const ui = await rendererHarness({ records: [record], invokeHook(method) { if (method === 'library:batchOrganize') return gate.promise; } }); const pending = ui.clickSelector('#batch-organize'); await ui.flush(); await ui.edit(); await ui.input('#record-transcript-input', '整理期间仍未保存的输入');
  gate.resolve({ runId: 'edited', items: [{ id: record.id, status: 'success', record: { ...record }, topicSuggestions: ['新组'] }] }); await pending; await ui.clickSelector('#apply-batch-groups');
  assert.equal(ui.calls.some(call => call.method === 'topics:create' || call.method === 'records:setTopics'), false); assert.equal(ui.run('state.batchChoices.get("fixture-record")'), '新组'); assert.equal(ui.nodes.get('#record-transcript-input').value, '整理期间仍未保存的输入'); assert.equal(ui.run('state.detailDirty'), true); assert.match(ui.nodes.get('#batch-results-status').textContent, /先保存或放弃/u);
});

test('batch review prevents duplicate confirmation and writes while its first approval is pending', async () => {
  const approval = deferred(); const topic = { id: 'reading', name: '阅读' }; const record = { id: 'fixture-record', title: '记录', transcript: '原文', audioSegments: [], topicIds: [], version: 1 };
  const ui = await rendererHarness({ records: [record], topics: [topic], confirm: () => approval.promise, invokeHook(method, params) {
    if (method === 'library:batchOrganize') return { runId: 'single-approval', items: [{ id: record.id, status: 'success', record: { ...record }, topicSuggestions: ['阅读'] }] };
    if (method === 'records:setTopics') { record.topicIds = Array.from(params.topicIds); return record; }
  } });
  await ui.clickSelector('#batch-organize'); const first = ui.clickSelector('#apply-batch-groups'); await ui.flush(); await ui.clickSelector('#apply-batch-groups');
  assert.equal(ui.confirmations.length, 1); assert.equal(ui.run('state.batchApplying'), true); assert.equal(ui.nodes.get('#apply-batch-groups').disabled, true); assert.equal(descendants(ui.nodes.get('#batch-results-list')).find(item => item.classList.contains('batch-result-menu')).disabled, true); assert.equal(ui.calls.some(call => call.method === 'records:setTopics'), false);
  approval.resolve(true); await first; assert.equal(ui.calls.filter(call => call.method === 'records:setTopics').length, 1); assert.equal(ui.calls.find(call => call.method === 'records:setTopics').params.expectedVersion, 1); assert.equal(ui.run('state.batchApplying'), false);
});

test('cancelled batch approval unlocks the review and preserves choices for a later successful retry', async () => {
  const approval = deferred(); let attempts = 0; const topic = { id: 'reading', name: '阅读' }; const record = { id: 'fixture-record', title: '记录', transcript: '原文', audioSegments: [], topicIds: [], version: 1 };
  const ui = await rendererHarness({ records: [record], topics: [topic], confirm: () => ++attempts === 1 ? approval.promise : true, invokeHook(method, params) {
    if (method === 'library:batchOrganize') return { runId: 'cancel-retry', items: [{ id: record.id, status: 'success', record: { ...record }, topicSuggestions: ['阅读'] }] };
    if (method === 'records:setTopics') { record.topicIds = Array.from(params.topicIds); return record; }
  } });
  await ui.clickSelector('#batch-organize'); const pending = ui.clickSelector('#apply-batch-groups'); await ui.flush(); approval.resolve(false); await pending;
  assert.equal(ui.run('state.batchApplying'), false); assert.equal(ui.run('state.batchChoices.get("fixture-record")'), '阅读'); assert.equal(ui.nodes.get('#apply-batch-groups').disabled, false); assert.equal(descendants(ui.nodes.get('#batch-results-list')).find(item => item.classList.contains('batch-result-menu')).disabled, false); assert.equal(ui.calls.some(call => call.method === 'records:setTopics'), false);
  await ui.clickSelector('#apply-batch-groups'); assert.equal(attempts, 2); assert.equal(ui.calls.filter(call => call.method === 'records:setTopics').length, 1); assert.deepEqual(record.topicIds, ['reading']);
});

test('batch classification sends the fetched version even when content changes while a new group is being created', async () => {
  const creation = deferred(); const record = { id: 'fixture-record', title: '记录', transcript: '原文', audioSegments: [], topicIds: [], version: 1 };
  const ui = await rendererHarness({ records: [record], invokeHook(method, params) {
    if (method === 'library:batchOrganize') return { runId: 'create-race', items: [{ id: record.id, status: 'success', record: { ...record }, topicSuggestions: ['新组'] }] };
    if (method === 'topics:create') return creation.promise;
    if (method === 'records:setTopics') { if (record.version !== params.expectedVersion) throw new Error('内容已更新，请重新整理后再分类。'); record.topicIds = Array.from(params.topicIds); return record; }
  } });
  await ui.clickSelector('#batch-organize'); const pending = ui.clickSelector('#apply-batch-groups'); await ui.flush(); assert.equal(ui.calls.filter(call => call.method === 'topics:create').length, 1); record.version = 2; record.transcript = '后来修改的原文'; creation.resolve({ id: 'new', name: '新组' }); await pending;
  assert.equal(ui.calls.find(call => call.method === 'records:setTopics').params.expectedVersion, 1); assert.equal(record.topicIds.length, 0); assert.equal(record.transcript, '后来修改的原文'); assert.equal(ui.run('state.batchApplying'), false); assert.match(descendants(ui.nodes.get('#batch-results-list')).map(item => item.textContent).join(' '), /内容已更新/u);
});

test('batch review groups suggestions by destination, preserves AI relevance order, and keeps titles and briefs as single text lines', async () => {
  const topics = [{ id: 'reading', name: '阅读' }]; const records = [
    { id: 'fixture-record', title: '记录一\n标题续行', transcript: '原文一\n第二行', audioSegments: [], topicIds: [], version: 1 },
    { id: 'record-b', title: '记录二', transcript: '原文二', audioSegments: [], topicIds: [], version: 1 },
    { id: 'record-c', title: '没有建议的记录', transcript: '记录三', audioSegments: [], topicIds: [], version: 1 },
    { id: 'record-failed', title: '失败的记录', transcript: '保留的原文', audioSegments: [], topicIds: [], version: 1 },
  ];
  const ui = await rendererHarness({ records, topics, invokeHook(method) { if (method === 'library:batchOrganize') return { runId: 'grouped', items: records.map((record, index) => ({ id: record.id, status: index === 3 ? 'failed' : 'success', record: { ...record, organization: { summary: '简要信息\n后半句' } }, topicSuggestions: index < 2 ? ['新的建议组', ' 阅读 ', '阅读'] : [], error: index === 3 ? '模拟失败\n仍保留原文' : undefined })) }; } });
  await ui.clickSelector('#batch-organize'); assert.deepEqual(Array.from(ui.run('state.batchChoices.entries()'), pair => Array.from(pair)), [['fixture-record', '新的建议组'], ['record-b', '新的建议组']]);
  assert.deepEqual(Array.from(ui.run('batchSuggestionNames(state.batchResultItems[0])')), ['新的建议组', '阅读']);
  const groups = ui.nodes.get('#batch-results-list').children; assert.deepEqual(groups.map(group => group.getAttribute('data-batch-group-name')), ['新的建议组', '暂不分组', '未完成']);
  const grouped = descendants(groups[0]).filter(item => item.getAttribute('data-batch-record-id')); assert.equal(grouped.length, 2); assert.equal(descendants(groups[0]).find(item => item.classList.contains('batch-group-count')).textContent, '2 条');
  assert.equal(descendants(grouped[0]).find(item => item.classList.contains('batch-result-heading')).textContent, '记录一 标题续行'); assert.equal(descendants(grouped[0]).find(item => item.classList.contains('batch-summary')).textContent, '简要信息 后半句');
  assert.equal(descendants(ui.nodes.get('#batch-results-list')).some(item => item.tag === 'select'), false); assert.equal(ui.calls.some(call => call.method === 'topics:create' || call.method === 'records:setTopics'), false);
});

test('batch cross offers cancel or modify in anchored menus and reassigns suggestions without changing stored records', async () => {
  const topics = [{ id: 'reading', name: '阅读' }, { id: 'life', name: '生活' }]; const menuAnswers = ['cancel', 'change', 'change']; let pickerAnswer = null;
  const record = { id: 'fixture-record', title: '一个灵感', transcript: '原始表达', audioSegments: [], topicIds: [], version: 1 };
  const ui = await rendererHarness({ records: [record], topics, menu: () => menuAnswers.shift(), groupPicker: () => pickerAnswer, invokeHook(method) { if (method === 'library:batchOrganize') return { runId: 'move', items: [{ id: record.id, status: 'success', record, topicSuggestions: ['新组', '阅读'] }] }; } });
  await ui.clickSelector('#batch-organize'); const menu = () => descendants(ui.nodes.get('#batch-results-list')).find(item => item.classList.contains('batch-result-menu'));
  await ui.emit(menu(), 'click'); assert.deepEqual(Array.from(ui.menus[0].items, item => item.label), ['取消分组', '修改分组']); assert.equal(ui.run('state.batchChoices.has("fixture-record")'), false); assert.equal(ui.nodes.get('#batch-results-list').children[0].getAttribute('data-batch-group-name'), '暂不分组'); assert.equal(ui.pickers.length, 0); assert.equal(ui.nodes.get('#apply-batch-groups').disabled, true);
  pickerAnswer = { id: 'life', name: '生活' }; await ui.emit(menu(), 'click'); assert.equal(ui.pickers[0].title, '修改分组'); assert.equal(ui.pickers[0].multiple, false); assert.equal(ui.pickers[0].anchor.tag, 'button'); assert(ui.pickers[0].choices.some(topic => topic.name === '新组' && topic.id === 'batch:new:新组')); assert.equal(ui.run('state.batchChoices.get("fixture-record")'), '生活'); assert.equal(ui.nodes.get('#batch-results-list').children[0].getAttribute('data-batch-group-name'), '生活');
  pickerAnswer = null; await ui.emit(menu(), 'click'); assert.equal(ui.pickers[1].selectedIds[0], 'life'); assert.equal(ui.run('state.batchChoices.get("fixture-record")'), '生活'); assert.equal(ui.confirmations.length, 0); assert.equal(ui.calls.some(call => call.method === 'topics:create' || call.method === 'records:setTopics'), false); assert.equal(record.topicIds.length, 0); assert.equal(record.transcript, '原始表达');
});

test('cloud navigation delegates to its module and selects a record through the existing protected reading path', async () => {
  const ui = await rendererHarness(); ui.run("showView('duplicates')"); assert.equal(ui.cloud.shown.length, 1); assert.equal(typeof ui.cloud.shown[0].onSelectRecord, 'function'); assert.equal(ui.nodes.get('#breadcrumb-current').textContent, '灵感云'); await ui.cloud.shown[0].onSelectRecord('fixture-record'); assert.equal(ui.run('state.view'), 'inbox'); assert.equal(ui.run('state.selectedId'), 'fixture-record'); assert.equal(ui.run('state.detailContext.kind'), 'cloud'); assert(ui.cloud.hidden > 0); assert.equal(ui.calls.some(call => call.method === 'library:duplicates'), false);
});

test('direct AI settings are explicit and a cancelled save keeps pending consent edits without running any AI', async () => {
  const ui = await rendererHarness({ invokeHook(method) { if (method === 'settings:save') return { cancelled: true }; } }); assert.equal(ui.nodes.get('#direct-ai-enabled').checked, false); ui.nodes.get('#direct-ai-enabled').checked = true; await ui.emit(ui.nodes.get('#direct-ai-enabled'), 'change'); assert.equal(ui.calls.some(call => call.method === 'settings:save'), false); await ui.submitSettings(); assert.equal(ui.calls.find(call => call.method === 'settings:save').params.directAIEnabled, true); assert.equal(ui.nodes.get('#direct-ai-enabled').checked, true); assert.equal(ui.run('state.settingsDirty'), true); assert.equal(ui.calls.some(call => ['records:organize', 'records:aiSearch', 'library:batchOrganize'].includes(call.method)), false);
});

test('saving current settings never reads or writes the retired similarity-analysis switch', async () => {
  const ui = await rendererHarness({ settings: { duplicateAnalysisEnabled: true, thresholdMs: 700 } });
  assert.equal(ui.nodes.has('#duplicates-enabled'), false); await ui.input('#threshold-input', '800'); await ui.submitSettings();
  const save = ui.calls.find(call => call.method === 'settings:save'); assert.equal(save.params.thresholdMs, 800); assert.equal(Object.hasOwn(save.params, 'duplicateAnalysisEnabled'), false); assert.equal(ui.run('state.settings.duplicateAnalysisEnabled'), true); assert.equal(ui.nodes.has('#duplicates-enabled'), false);
});

test('summary stops before a model request if newer edits appear while its local save is pending', async () => {
  const gate = deferred(); const ui = await rendererHarness({ invokeHook(method) { if (method === 'records:update') return gate.promise; } }); await ui.edit(); await ui.input('#record-transcript-input', '提交的版本'); const pending = ui.click('AI 总结'); await ui.flush(); await ui.input('#record-transcript-input', '保存期间的新输入'); gate.resolve({ version: 2 }); await pending; assert.equal(ui.calls.some(call => call.method === 'records:organize'), false); assert.equal(ui.nodes.get('#record-transcript-input').value, '保存期间的新输入'); assert.equal(ui.run('state.detailDirty'), true); assert.match(ui.nodes.get('#toast').textContent, /后续输入仍未保存/u);
});

test('left swipe on the narrow list reveals actions without opening detail and right swipe closes them', async () => {
  const ui = await rendererHarness({ select: false }); ui.run("state.libraryMode = 'detail'; updateLibraryLayout()"); const card = ui.nodes.get('#record-list').children[0]; const open = card.children.find(item => item.classList.contains('record-open')); const remove = card.children.find(item => item.classList.contains('card-delete'));
  assert.equal(remove.getAttribute('aria-hidden'), 'true'); assert.equal(remove.tabIndex, -1); const reads = ui.calls.filter(call => call.method === 'records:get').length;
  await ui.emit(card, 'pointerdown', { target: open, pointerId: 1, pointerType: 'touch', button: 0, clientX: 80, clientY: 40 }); await ui.emit(card, 'pointermove', { pointerId: 1, clientX: 20, clientY: 43 }); await ui.emit(card, 'pointerup', { pointerId: 1 }); await ui.emit(open, 'click');
  assert.equal(card.classList.contains('actions-open'), true); assert.equal(remove.getAttribute('aria-hidden'), 'false'); assert.equal(remove.tabIndex, 0); assert.equal(ui.calls.filter(call => call.method === 'records:get').length, reads); assert.equal(ui.run('state.selectedId'), null);
  await ui.emit(card, 'pointerdown', { target: open, pointerId: 2, button: 0, clientX: 20, clientY: 40 }); await ui.emit(card, 'pointermove', { pointerId: 2, clientX: 80, clientY: 42 }); await ui.emit(card, 'pointerup', { pointerId: 2 }); await ui.emit(open, 'click'); assert.equal(card.classList.contains('actions-open'), false); assert.equal(ui.run('state.selectedId'), null);
});

test('grid cards never swipe and their more button opens a small action menu', async () => {
  const ui = await rendererHarness({ select: false }); const card = ui.nodes.get('#record-list').children[0]; const open = card.children.find(item => item.classList.contains('record-open')); const more = card.children.find(item => item.classList.contains('record-actions-toggle'));
  for (const [pointerId, button, endX, endY] of [[1, 0, 10, 42], [2, 0, 84, 90], [3, 2, 10, 42]]) { await ui.emit(card, 'pointerdown', { target: open, pointerId, button, clientX: 80, clientY: 40 }); await ui.emit(card, 'pointermove', { pointerId, clientX: endX, clientY: endY }); await ui.emit(card, 'pointerup', { pointerId }); }
  assert.equal(card.classList.contains('actions-open'), false); await ui.emit(more, 'click'); assert.equal(card.classList.contains('actions-open'), false); assert.equal(ui.menus[0].anchor, more); assert.equal(ui.menus[0].title, '灵感操作'); assert.deepEqual(Array.from(ui.menus[0].items, item => item.id), ['group', 'delete']); assert.equal(ui.run('state.selectedId'), null);
});

test('narrow list vertical scrolling and a right mouse hold never expand swipe actions', async () => {
  const ui = await rendererHarness({ select: false }); ui.run("state.libraryMode = 'detail'; updateLibraryLayout()"); const card = ui.nodes.get('#record-list').children[0]; const open = card.children.find(item => item.classList.contains('record-open'));
  await ui.emit(card, 'pointerdown', { target: open, pointerId: 1, button: 0, clientX: 80, clientY: 40 }); await ui.emit(card, 'pointermove', { pointerId: 1, clientX: 76, clientY: 90 }); await ui.emit(card, 'pointermove', { pointerId: 1, clientX: 10, clientY: 100 }); await ui.emit(card, 'pointerup', { pointerId: 1 }); assert.equal(card.classList.contains('actions-open'), false);
  await ui.emit(card, 'pointerdown', { target: open, pointerId: 2, button: 2, clientX: 80, clientY: 40 }); await ui.emit(card, 'pointermove', { pointerId: 2, clientX: 10, clientY: 42 }); assert.equal(card.classList.contains('actions-open'), false);
});

test('swipe click suppression expires promptly and outside clicks or list scrolling collapse actions', async () => {
  const ui = await rendererHarness({ select: false }); ui.run("state.libraryMode = 'detail'; updateLibraryLayout()"); const card = ui.nodes.get('#record-list').children[0]; const open = card.children.find(item => item.classList.contains('record-open'));
  await ui.emit(card, 'pointerdown', { target: open, pointerId: 1, button: 0, clientX: 80, clientY: 40 }); await ui.emit(card, 'pointermove', { pointerId: 1, clientX: 20, clientY: 43 }); await ui.emit(card, 'pointerup', { pointerId: 1 }); for (const [id, timer] of [...ui.timers]) { ui.timers.delete(id); timer(); } await ui.emit(open, 'click'); assert.equal(card.classList.contains('actions-open'), false); assert.equal(ui.run('state.selectedId'), null);
  ui.run("setCardActions('fixture-record')"); const panel = ui.element('div'); panel.classList.add('inmoment-popover'); const choice = ui.element('button'); panel.append(choice); await ui.emit(ui.document, 'click', { target: choice }); assert.equal(card.classList.contains('actions-open'), true); await ui.emit(ui.document, 'click', { target: ui.document.body }); assert.equal(card.classList.contains('actions-open'), false);
  ui.run("setCardActions('fixture-record')"); await ui.emit(ui.nodes.get('#record-list'), 'scroll'); assert.equal(card.classList.contains('actions-open'), false); assert.equal(ui.calls.some(call => call.method === 'records:delete'), false);
});

test('selection checkbox and text are separate controls with distinct select-all and empty-selection actions', async () => {
  const records = [{id:'fixture-record',title:'一',topicIds:[]},{id:'second',title:'二',topicIds:[]}]; const ui = await rendererHarness({records,select:false});
  const control = ui.nodes.get('#record-selection-control'), master = ui.nodes.get('#select-visible-records'), toggle = ui.nodes.get('#toggle-record-selection');
  assert.equal(control.tag,'div'); assert.equal(master.tag,'input'); assert.equal(master.type,'checkbox'); assert.equal(master.parentElement.tag,'label'); assert.equal(master.parentElement.parentElement,control); assert.equal(toggle.parentElement,control); assert.equal(master.parentElement.children.includes(toggle),false);
  assert.equal(toggle.getAttribute('data-ui-icon'),undefined); assert.equal(master.classList.contains('hidden'),false); assert.equal(master.checked,false); assert.equal(master.indeterminate,false); assert.equal(master.getAttribute('aria-checked'),'false');
  await ui.clickSelector('#select-visible-records'); assert.equal(ui.run('recordSelection.enabled'),true); assert.equal(ui.run('recordSelection.ids.size'),2); assert.equal(master.checked,true); assert.equal(toggle.textContent,'完成');
  await ui.clickSelector('#select-visible-records'); assert.equal(ui.run('recordSelection.enabled'),true); assert.equal(ui.run('recordSelection.ids.size'),0); assert.equal(master.checked,false); assert.equal(toggle.textContent,'完成');
  await ui.clickSelector('#toggle-record-selection'); assert.equal(ui.run('recordSelection.enabled'),false); assert.equal(ui.run('recordSelection.ids.size'),0); assert.equal(toggle.textContent,'选择');
  await ui.clickSelector('#toggle-record-selection'); assert.equal(ui.run('recordSelection.enabled'),true); assert.equal(ui.run('recordSelection.ids.size'),0); assert.equal(master.checked,false);
  assert.equal(ui.calls.some(call=>['records:delete','records:setTopics'].includes(call.method)),false);
});

test('the master checkbox reports mixed selection and selects only the rendered page and current group', async () => {
  const records = [...Array.from({length:24},(_,index)=>({id:index === 0?'fixture-record':'record-'+index,title:'记录'+index,topicIds:[]})),{id:'reading-a',title:'分组一',topicIds:['reading']},{id:'reading-b',title:'分组二',topicIds:['reading']}];
  const ui = await rendererHarness({records,topics:[{id:'reading',name:'阅读'}],select:false}); const master = ui.nodes.get('#select-visible-records');
  await ui.clickSelector('#select-visible-records'); assert.equal(ui.run('recordSelection.ids.size'),20); assert.equal(ui.run('recordSelection.ids.has("record-23")'),false); assert.equal(ui.run('recordSelection.ids.has("reading-a")'),false);
  const first = ui.nodes.get('#record-list').children[0].children.find(item=>item.classList.contains('record-selection')); first.checked = false; await ui.emit(first,'change'); assert.equal(master.checked,false); assert.equal(master.indeterminate,true); assert.equal(master.getAttribute('aria-checked'),'mixed');
  await ui.clickSelector('#select-visible-records'); assert.equal(master.checked,true); assert.equal(master.indeterminate,false); assert.equal(master.getAttribute('aria-checked'),'true'); assert.equal(ui.run('recordSelection.ids.size'),20);
  await ui.clickSelector('#load-more'); assert.equal(master.indeterminate,true); await ui.clickSelector('#select-visible-records'); assert.equal(ui.run('recordSelection.ids.size'),24);
  await ui.run("openPrimaryGroup('reading')"); assert.equal(ui.run('recordSelection.ids.size'),0); assert.equal(master.checked,false); await ui.clickSelector('#select-visible-records'); assert.deepEqual(Array.from(ui.run('recordSelection.ids')),['reading-a','reading-b']);
});

test('empty, busy and deleting lists disable the master checkbox without mutating its selection', async () => {
  const empty = await rendererHarness({records:[],select:false}); assert.equal(empty.nodes.get('#select-visible-records').disabled,true); assert.equal(empty.nodes.get('#toggle-record-selection').disabled,true);
  await empty.clickSelector('#toggle-record-selection'); assert.equal(empty.run('recordSelection.enabled'),false);
  empty.run('recordSelection.enabled = true; updateRecordSelectionToolbar()'); assert.equal(empty.nodes.get('#toggle-record-selection').disabled,false); await empty.clickSelector('#toggle-record-selection'); assert.equal(empty.run('recordSelection.enabled'),false);
  const ui = await rendererHarness({select:false}); await ui.clickSelector('#select-visible-records'); const master = ui.nodes.get('#select-visible-records');
  ui.run('recordSelection.busy = true; updateRecordSelectionToolbar()'); assert.equal(master.disabled,true); assert.equal(ui.nodes.get('#toggle-record-selection').disabled,true); master.checked = false; await ui.emit(master,'change'); assert.equal(master.checked,true); assert.equal(ui.run('recordSelection.ids.size'),1);
  ui.run('recordSelection.busy = false; deletingRecords.add("fixture-record"); updateRecordSelectionToolbar()'); assert.equal(master.disabled,true); await ui.clickSelector('#toggle-record-selection'); assert.equal(ui.run('recordSelection.enabled'),true);
  ui.run('deletingRecords.clear(); updateRecordSelectionToolbar()'); assert.equal(master.disabled,false); assert.equal(ui.nodes.get('#toggle-record-selection').disabled,false); assert.equal(master.checked,true);
});

test('selection mode toggles checked rows instead of opening and selects only the records currently rendered', async () => {
  const records = Array.from({ length: 24 }, (_, index) => ({ id: 'record-' + index, title: '灵感 ' + index, transcript: '内容', topicIds: [] })); const ui = await rendererHarness({ records, select: false });
  await ui.clickSelector('#toggle-record-selection'); const first = ui.nodes.get('#record-list').children[0].children.find(item => item.classList.contains('record-open')); await ui.emit(first, 'click'); assert.equal(ui.run('state.selectedId'), null); assert.equal(ui.run('recordSelection.ids.size'), 1); assert.equal(ui.nodes.get('#record-selection-count').textContent, '已选 1 条');
  await ui.clickSelector('#select-visible-records'); assert.equal(ui.run('recordSelection.ids.size'), 20); assert.equal(ui.run('recordSelection.ids.has("record-23")'), false); await ui.clickSelector('#load-more'); assert.equal(ui.nodes.get('#record-list').children.length, 24); assert.equal(ui.run('recordSelection.ids.size'), 20); assert.equal(ui.nodes.get('#select-visible-records').indeterminate, true); assert.equal(ui.nodes.get('#select-visible-records').getAttribute('aria-checked'), 'mixed'); await ui.clickSelector('#toggle-record-selection'); assert.equal(ui.run('recordSelection.ids.size'), 0); assert.equal(ui.document.body.classList.contains('record-selection-mode'), false); assert.equal(ui.calls.some(call => call.method === 'records:delete'), false);
});

test('record selection clears on changed time, group, and view while background refresh removes only missing IDs', async () => {
  const records = [{ id: 'fixture-record', title: '一', topicIds: [], createdAt: Date.now() }, { id: 'other', title: '二', topicIds: [], createdAt: Date.now() }]; const ui = await rendererHarness({ records, topics: [{ id: 'reading', name: '阅读' }], select: false });
  await ui.clickSelector('#toggle-record-selection'); await ui.clickSelector('#select-visible-records'); ui.deletedRecordIds.add('other'); await ui.event({ type: 'recordsChanged' }); assert.deepEqual(Array.from(ui.run('recordSelection.ids')), ['fixture-record']);
  ui.nodes.get('#date-range').value = '7'; await ui.emit(ui.nodes.get('#date-range'), 'change'); assert.equal(ui.run('recordSelection.enabled'), false); assert.equal(ui.run('recordSelection.ids.size'), 0);
  await ui.clickSelector('#toggle-record-selection'); await ui.clickSelector('#select-visible-records'); await ui.run("openPrimaryGroup('reading')"); assert.equal(ui.run('recordSelection.ids.size'), 0); assert.equal(ui.run('recordSelection.enabled'), false);
  await ui.clickSelector('#toggle-record-selection'); ui.run("showView('settings')"); assert.equal(ui.run('recordSelection.enabled'), false); assert.equal(ui.run('recordSelection.ids.size'), 0);
});

test('cancelled multi-delete confirms once and leaves the current unsaved edits and selected IDs intact', async () => {
  const ui = await rendererHarness({ confirm: () => false }); await ui.edit(); await ui.input('#record-transcript-input', '不能丢掉的输入'); await ui.clickSelector('#toggle-record-selection'); await ui.clickSelector('#select-visible-records'); await ui.clickSelector('#delete-selected-records');
  assert.equal(ui.confirmations.length, 1); assert.match(ui.confirmations[0].detail, /尚未保存的修改也将放弃/u); assert.equal(ui.run('state.detailDirty'), true); assert.equal(ui.nodes.get('#record-transcript-input').value, '不能丢掉的输入'); assert.equal(ui.nodes.get('#record-transcript-input').disabled, false); assert.equal(ui.run('recordSelection.ids.size'), 1); assert.equal(ui.calls.some(call => call.method === 'records:delete'), false); assert.equal(ui.run('recordSelection.busy'), false);
});

test('multi-delete sends frozen IDs sequentially once and leaves only existing failed records checked for retry', async () => {
  const records = [{ id: 'fixture-record', title: '一', topicIds: [] }, { id: 'failure', title: '二', topicIds: [] }, { id: 'last', title: '三', topicIds: [] }]; const ui = await rendererHarness({ records, invokeHook(method, params) { if (method === 'records:delete' && params.id === 'failure') throw new Error('模拟文件占用'); } });
  await ui.clickSelector('#toggle-record-selection'); await ui.clickSelector('#select-visible-records'); await ui.clickSelector('#delete-selected-records'); assert.equal(ui.confirmations.length, 1); assert.deepEqual(ui.calls.filter(call => call.method === 'records:delete').map(call => call.params.id), ['fixture-record', 'failure', 'last']); assert.deepEqual(Array.from(ui.run('recordSelection.ids')), ['failure']); assert.deepEqual(Array.from(ui.run('state.visibleRecords'), item => item.id), ['failure']); assert.equal(ui.run('state.selectedId'), null); assert.match(ui.nodes.get('#toast').textContent, /已删除 2 条，1 条删除失败/u); assert.equal(ui.calls.some(call => call.method.includes('organize') || call.method.includes('aiSearch')), false);
});

test('deletion in flight cannot reenter or navigate to a pending ID and leaves newer unrelated editing in place', async () => {
  const gate = deferred(); const records = [{ id: 'fixture-record', title: '一', topicIds: [] }, { id: 'next', title: '二', topicIds: [] }, { id: 'safe', title: '保留', topicIds: [], audioSegments: [] }]; let ui; ui = await rendererHarness({ records, select: false, invokeHook(method, params) { if (method === 'records:delete' && params.id === 'fixture-record') return gate.promise; } });
  await ui.clickSelector('#toggle-record-selection'); ui.run('recordSelection.ids = new Set(["fixture-record", "next"]); renderList()'); const pending = ui.clickSelector('#delete-selected-records'); await ui.flush(); await ui.clickSelector('#delete-selected-records'); assert.equal(await ui.run('selectRecord("next")'), false); await ui.run('selectRecord("safe")'); await ui.edit(); await ui.input('#record-transcript-input', '稍后继续编辑'); ui.deletedRecordIds.add('fixture-record'); gate.resolve({ deleted: true }); await pending;
  assert.deepEqual(ui.calls.filter(call => call.method === 'records:delete').map(call => call.params.id), ['fixture-record', 'next']); assert.equal(ui.run('state.selectedId'), 'safe'); assert.equal(ui.run('state.detailDirty'), true); assert.equal(ui.nodes.get('#record-transcript-input').value, '稍后继续编辑'); assert.equal(ui.nodes.get('#record-transcript-input').disabled, false); assert.equal(ui.confirmations.length, 1);
});

test('adding a record to a group uses the anchored picker, merges fresh memberships, and preserves the reading location', async () => {
  const record = { id: 'fixture-record', title: '原记录', transcript: '完整原话', topicIds: [], audioSegments: [] }; const topics = [{ id: 'existing', name: '原有组' }, { id: 'target', name: '新目标' }]; let fresh = false; const ui = await rendererHarness({ records: [record], topics, groupPicker(value) { assert.equal(value.title, '添加到组'); assert.equal(value.multiple, false); fresh = true; return topics[1]; }, invokeHook(method, params) { if (method === 'records:get' && fresh) return { ...record, topicIds: ['existing'] }; if (method === 'records:setTopics') { record.topicIds = [...params.topicIds]; return record; } } });
  const card = ui.nodes.get('#record-list').children[0]; const group = card.children.find(item => item.classList.contains('record-add-group')); await ui.emit(group, 'click'); const update = ui.calls.find(call => call.method === 'records:setTopics'); assert.deepEqual(Array.from(update.params.topicIds), ['existing', 'target']); assert.equal(ui.pickers[0].anchor, group); assert.equal(ui.run('state.libraryGroupId'), 'uncategorized'); assert.equal(ui.run('state.selectedId'), 'fixture-record'); assert.equal(ui.run('state.recordProjection.record.id'), 'fixture-record'); assert.equal(record.transcript, '完整原话'); assert.equal(ui.calls.some(call => call.method === 'topics:create'), false); assert.equal(ui.confirmations.length, 0);
});

test('multi-delete keeps its snapshot through change broadcasts and verifies a late cleanup error against current storage', async () => {
  const gate = deferred(); const records = [{ id: 'fixture-record', title: '已删除', topicIds: [] }, { id: 'second', title: '第二条', topicIds: [] }]; let ui; ui = await rendererHarness({ records, select: false, invokeHook(method, params) { if (method === 'records:delete' && params.id === 'fixture-record') return gate.promise; } }); await ui.clickSelector('#toggle-record-selection'); await ui.clickSelector('#select-visible-records'); const pending = ui.clickSelector('#delete-selected-records'); await ui.flush(); ui.deletedRecordIds.add('fixture-record'); await ui.event({ type: 'recordsChanged' }); assert.equal(ui.run('recordSelection.ids.has("second")'), true); gate.reject(new Error('数据库删除后临时文件清理失败')); await pending;
  assert.deepEqual(ui.calls.filter(call => call.method === 'records:delete').map(call => call.params.id), ['fixture-record', 'second']); assert.equal(ui.run('recordSelection.ids.size'), 0); assert.equal(ui.run('state.visibleRecords.length'), 0); assert.match(ui.nodes.get('#toast').textContent, /已删除 2 条灵感/u); assert.equal(ui.confirmations.length, 1);
});

test('cancelled multi-delete restores its toolbar focus after an inactive dialog retains the cancel control', async () => {
  let ui; ui = await rendererHarness({ select: false, confirm: () => { const dialog = ui.nodes.get('#confirm-dialog') || ui.document.querySelector('#confirm-dialog'); const cancel = ui.element('button'); dialog.append(cancel); cancel.focus(); return false; } }); await ui.clickSelector('#toggle-record-selection'); await ui.clickSelector('#select-visible-records'); const entry = ui.nodes.get('#delete-selected-records'); entry.focus(); await ui.clickSelector('#delete-selected-records'); assert.equal(ui.document.activeElement, entry); assert.equal(entry.disabled, false); assert.equal(ui.run('recordSelection.ids.size'), 1); assert.equal(ui.calls.some(call => call.method === 'records:delete'), false);
});

test('selection checkbox changes preserve focus through list rebuilds so keyboard users can continue selecting or deselecting', async () => {
  const records = [{ id: 'fixture-record', title: '第一条', topicIds: [] }, { id: 'second', title: '第二条', topicIds: [] }]; const ui = await rendererHarness({ records, select: false }); await ui.clickSelector('#toggle-record-selection');
  const checkbox = id => descendants(ui.nodes.get('#record-list')).find(item => item.getAttribute('data-record-select-id') === id); const first = checkbox('fixture-record'); first.focus(); first.checked = true; await ui.emit(first, 'change'); const rebuiltFirst = checkbox('fixture-record'); assert.notEqual(rebuiltFirst, first); assert.equal(first.isConnected, false); assert.equal(ui.document.activeElement, rebuiltFirst); assert.equal(rebuiltFirst.checked, true); assert.equal(rebuiltFirst.tabIndex, 0);
  const second = checkbox('second'); second.focus(); second.checked = true; await ui.emit(second, 'change'); assert.equal(ui.document.activeElement, checkbox('second')); assert.equal(checkbox('second').checked, true); assert.equal(ui.run('recordSelection.ids.size'), 2);
  const selectedSecond = checkbox('second'); selectedSecond.checked = false; await ui.emit(selectedSecond, 'change'); assert.equal(ui.document.activeElement, checkbox('second')); assert.equal(checkbox('second').checked, false); assert.equal(ui.run('recordSelection.ids.size'), 1); assert.equal(ui.run('state.selectedId'), null); assert.equal(ui.calls.some(call => call.method === 'records:delete'), false);
});

test('cancelling single-delete after outside confirmation collapses actions and restores the visible more button even from inactive-window focus', async () => {
  let ui; ui = await rendererHarness({ select: false, confirm: () => { ui.run('setCardActions(null)'); ui.document.activeElement = ui.document.body; return false; } }); ui.run("setCardActions('fixture-record')"); const card = ui.nodes.get('#record-list').children[0]; const remove = card.children.find(item => item.classList.contains('card-delete')); ui.document.activeElement = ui.document.body; await ui.emit(remove, 'click');
  const restoredCard = ui.nodes.get('#record-list').children[0]; const more = restoredCard.children.find(item => item.classList.contains('record-actions-toggle')); assert.equal(restoredCard.classList.contains('actions-open'), false); assert.equal(ui.document.activeElement, more); assert.equal(more.disabled, false); assert.equal(more.tabIndex, 0); assert.equal(restoredCard.children.find(item => item.classList.contains('card-delete')).getAttribute('aria-hidden'), 'true'); await ui.event({ type: 'recordsChanged' }); assert.equal(ui.document.activeElement, ui.nodes.get('#record-list').children[0].children.find(item => item.classList.contains('record-actions-toggle'))); assert.equal(ui.calls.some(call => call.method === 'records:delete'), false);
});

test('single-delete collapses actions before confirmation and a late cancel-click bubble cannot hide its restored focus', async () => {
  let ui; let cancel; ui = await rendererHarness({ select: false, confirm: () => { assert.equal(ui.run('recordSelection.expandedId'), null); assert.equal(ui.nodes.get('#record-list').children[0].classList.contains('actions-open'), false); const dialog = ui.document.querySelector('#confirm-dialog'); cancel = ui.element('button'); dialog.append(cancel); cancel.focus(); return false; } }); ui.run("setCardActions('fixture-record')"); const card = ui.nodes.get('#record-list').children[0]; const remove = card.children.find(item => item.classList.contains('card-delete')); remove.focus(); await ui.emit(remove, 'click');
  const more = ui.nodes.get('#record-list').children[0].children.find(item => item.classList.contains('record-actions-toggle')); assert.equal(ui.document.activeElement, more); await ui.emit(ui.document, 'click', { target: cancel }); assert.equal(ui.document.activeElement, more); assert.equal(ui.run('recordSelection.expandedId'), null); assert.equal(ui.nodes.get('#record-list').children[0].classList.contains('actions-open'), false); assert.equal(ui.calls.some(call => call.method === 'records:delete'), false);
});

test('grid delete opens only an anchored confirmation at the visible more button and cancellation keeps the record', async () => {
  const ui = await rendererHarness({ select: false, menu: () => 'delete', confirm: () => false }); const card = ui.nodes.get('#record-list').children[0]; const more = card.children.find(item => item.classList.contains('record-actions-toggle')); more.focus(); await ui.emit(more, 'click');
  assert.equal(ui.menus.length, 1); assert.equal(ui.confirmations.length, 1); assert.equal(ui.confirmations[0].anchor, more); assert.equal(ui.confirmations[0].danger, true); assert.equal(ui.nodes.get('#confirm-dialog')?.open ?? false, false); assert.equal(ui.calls.some(call => call.method === 'records:delete'), false); assert.equal(ui.nodes.get('#record-list').children[0].classList.contains('actions-open'), false);
});

test('swipe delete confirms beside the visible more entry rather than anchoring its collapsed delete action', async () => {
  const ui = await rendererHarness({ confirm: () => false }); ui.run("setCardActions('fixture-record')"); const card = ui.nodes.get('#record-list').children[0]; const remove = card.children.find(item => item.classList.contains('card-delete')); const more = card.children.find(item => item.classList.contains('record-actions-toggle')); await ui.emit(remove, 'click'); assert.equal(ui.confirmations[0].anchor, more); assert.notEqual(ui.confirmations[0].anchor, remove); assert.equal(ui.calls.some(call => call.method === 'records:delete'), false);
});

test('multi-select group assignment merges fresh memberships, retains failed IDs and the open record, and never calls AI', async () => {
  const records = [{ id: 'fixture-record', title: '当前打开', transcript: '完整原话', topicIds: [], version: 4, audioSegments: [] }, { id: 'failure', title: '保留失败项', topicIds: [], version: 6 }, { id: 'last', title: '其余记录', topicIds: [], version: 8 }]; const topics = [{ id: 'old', name: '原有组' }, { id: 'target', name: '新目标' }];
  const ui = await rendererHarness({ records, topics, groupPicker: () => topics[1], invokeHook(method, params) { if (method === 'records:get') { const record = records.find(item => item.id === params.id); return { ...record, topicIds: [...new Set([...(record.topicIds || []), 'old'])] }; } if (method === 'records:setTopics') { if (params.id === 'failure') throw new Error('模拟分组更新失败'); const record = records.find(item => item.id === params.id); assert.equal(params.expectedVersion, record.version); record.topicIds = [...params.topicIds]; return record; } } });
  await ui.clickSelector('#toggle-record-selection'); await ui.clickSelector('#select-visible-records'); const entry = ui.nodes.get('#add-selected-records'); await ui.clickSelector('#add-selected-records');
  assert.equal(ui.pickers[0].anchor, entry); assert.equal(ui.pickers[0].title, '添加到组'); assert.deepEqual(ui.calls.filter(call => call.method === 'records:setTopics').map(call => call.params.id), ['fixture-record', 'failure', 'last']); assert.deepEqual(records[0].topicIds, ['old', 'target']); assert.deepEqual(records[2].topicIds, ['old', 'target']); assert.deepEqual(Array.from(ui.run('recordSelection.ids')), ['failure']); assert.equal(ui.run('state.selectedId'), 'fixture-record'); assert.equal(ui.run('state.recordProjection.record.id'), 'fixture-record'); assert.equal(ui.run('state.libraryGroupId'), 'uncategorized'); assert.equal(ui.run('recordSelection.busy'), false); assert.equal(ui.run('state.topicAdoptBusy'), false); assert.match(ui.nodes.get('#toast').textContent, /已添加 2 条.*1 条未能添加/u); assert.equal(ui.calls.some(call => call.method.includes('organize') || call.method.includes('aiSearch') || call.method === 'records:delete'), false);
});

test('cancelling multi-select group picker keeps checked records and makes no grouping writes', async () => {
  const ui = await rendererHarness({ select: false, groupPicker: () => null }); await ui.clickSelector('#toggle-record-selection'); await ui.clickSelector('#select-visible-records'); await ui.clickSelector('#add-selected-records'); assert.equal(ui.run('recordSelection.ids.size'), 1); assert.equal(ui.run('recordSelection.busy'), false); assert.equal(ui.nodes.get('#add-selected-records').disabled, false); assert.equal(ui.calls.some(call => call.method === 'records:setTopics'), false); assert.equal(ui.confirmations.length, 0);
});

test('bulk grouping snapshots rendered checked IDs, blocks reentry and deletion, and keeps unrelated unsaved text', async () => {
  const gate = deferred(); const records = [{ id: 'fixture-record', title: '被选中', topicIds: [], version: 1 }, { id: 'other', title: '不选中', topicIds: [], version: 2, audioSegments: [] }]; const topic = { id: 'target', name: '目标组' }; const ui = await rendererHarness({ records, topics: [topic], select: false, groupPicker: () => topic, invokeHook(method, params) { if (method === 'records:setTopics' && params.id === 'fixture-record') return gate.promise; } }); await ui.clickSelector('#toggle-record-selection'); ui.run('recordSelection.ids = new Set(["fixture-record"]); renderList()'); const pending = ui.clickSelector('#add-selected-records'); await ui.flush(); await ui.clickSelector('#add-selected-records'); await ui.clickSelector('#delete-selected-records'); await ui.run('selectRecord("other")'); await ui.edit(); await ui.input('#record-transcript-input', '未保存的文字'); gate.resolve({ ...records[0], topicIds: [topic.id] }); await pending;
  assert.equal(ui.pickers.length, 1); assert.deepEqual(ui.calls.filter(call => call.method === 'records:setTopics').map(call => call.params.id), ['fixture-record']); assert.equal(ui.calls.some(call => call.method === 'records:delete'), false); assert.equal(ui.run('state.detailDirty'), true); assert.equal(ui.nodes.get('#record-transcript-input').value, '未保存的文字'); assert.equal(ui.nodes.get('#record-transcript-input').disabled, false);
});

test('failed unified grouping retains generated summaries but suppresses fragmented individual group proposals', async () => {
  const records = Array.from({ length: 4 }, (_, index) => ({ id: index ? 'grouping-' + index : 'fixture-record', title: '记录 ' + index, transcript: '完整原文 ' + index, version: 1, topicIds: [], audioSegments: [], organization: { summary: '已保留摘要 ' + index } }));
  const ui = await rendererHarness({ records, invokeHook(method) { if (method === 'library:batchOrganize') return { runId: 'unified-failure', grouping: { error: '分类服务暂时不可用' }, items: records.map((record, index) => ({ id: record.id, status: 'success', record, topicSuggestions: ['每条一个分组' + index] })) }; } });
  await ui.clickSelector('#batch-organize'); assert.equal(ui.run('state.batchChoices.size'), 0); assert.equal(ui.nodes.get('#batch-results-dialog').open, true);
  assert.match(ui.nodes.get('#batch-results-status').textContent, /分类服务暂时不可用/u); assert.match(ui.nodes.get('#batch-results-status').textContent, /摘要已保留/u); assert.equal(ui.nodes.get('#batch-results-status').classList.contains('persistent-error'), true);
  assert.equal(descendants(ui.nodes.get('#batch-results-list')).filter(item => item.getAttribute('data-batch-record-id')).length, records.length);
  assert.deepEqual(Array.from(ui.run('state.batchResultItems'), item => item.record.organization.summary), records.map(record => record.organization.summary));
  assert.equal(ui.calls.some(call => call.method === 'topics:create' || call.method === 'records:setTopics'), false); assert.equal(ui.nodes.get('#apply-batch-groups').disabled, true);
});

test('successful unified grouping reports twenty notes arranged into four proposed groups', async () => {
  const records = Array.from({ length: 20 }, (_, index) => ({ id: index ? 'unified-' + index : 'fixture-record', title: '记录 ' + index, transcript: '内容 ' + index, version: 1, topicIds: [], audioSegments: [] }));
  const ui = await rendererHarness({ records, invokeHook(method) { if (method === 'library:batchOrganize') return { runId: 'unified-success', grouping: { groupCount: 4 }, items: records.map((record, index) => ({ id: record.id, status: 'success', record, topicSuggestions: ['主题 ' + Math.floor(index / 5)] })) }; } });
  await ui.clickSelector('#batch-organize'); assert.equal(ui.run('state.batchChoices.size'), 20); assert.match(ui.nodes.get('#batch-results-status').textContent, /本次 20 条，已整理 20 条，推荐 4 个分组/u);
  const groups = descendants(ui.nodes.get('#batch-results-list')).filter(item => item.getAttribute('data-batch-group-name')); assert.equal(groups.length, 4); assert(groups.every(group => descendants(group).filter(item => item.getAttribute('data-batch-record-id')).length === 5));
  assert.equal(ui.calls.some(call => call.method === 'topics:create' || call.method === 'records:setTopics'), false);
});

test('time selection uses a local radio popover and cancelling keeps the previous filter', async () => {
  const answers = ['30', null, 'all']; const ui = await rendererHarness({ select: false, menu: () => answers.shift() });
  await ui.clickSelector('#date-range-trigger');
  assert.equal(ui.nodes.get('#date-range').value, '30'); assert.equal(ui.nodes.get('#date-range-trigger').textContent, '最近 30 天');
  const request = ui.calls.filter(item => item.method === 'records:list').at(-1); assert.ok(request.params.filters.from > Date.now() - 31 * 86400000); assert.equal(ui.menus.at(-1).selection, true);
  await ui.clickSelector('#date-range-trigger'); assert.equal(ui.nodes.get('#date-range').value, '30');
  assert.equal(ui.menus.at(-1).items.find(item => item.id === '30').selected, true);
  await ui.clickSelector('#date-range-trigger'); assert.equal(ui.nodes.get('#date-range').value, 'all'); assert.equal(ui.nodes.get('#date-range-trigger').getAttribute('aria-expanded'), 'false');
  assert.equal(ui.calls.some(item => /organize|aiSearch|settings:save/u.test(item.method)), false);
});

test('a late time popup selection does not overwrite newer navigation', async () => {
  const choice = deferred(); const ui = await rendererHarness({ select: false, menu: () => choice.promise });
  const pending = ui.clickSelector('#date-range-trigger'); await ui.flush(); ui.run("showView('settings')"); choice.resolve('365'); await pending;
  assert.equal(ui.run('state.view'), 'settings'); assert.notEqual(ui.nodes.get('#date-range').value, '365'); assert.equal(ui.nodes.get('#date-range-trigger').getAttribute('aria-expanded'), 'false');
});

test('audio speed popup applies supported choices and dismissing it preserves playback rate', async () => {
  const answers = ['1.5', null, '9']; const ui = await rendererHarness({ record: { audioSegments: [{ id: 'voice', url: 'inmoment-media://record/fixture-record/audio/voice', durationMs: 8000, transcript: '原话' }] }, menu: () => answers.shift() });
  const controls = descendants(ui.nodes.get('#record-detail')); const trigger = controls.find(item => item.classList.contains('audio-speed-trigger')); const audio = controls.find(item => item.tag === 'audio'); const select = controls.find(item => item.classList.contains('audio-speed'));
  await ui.emit(trigger, 'click'); assert.equal(audio.playbackRate, 1.5); assert.equal(select.value, '1.5'); assert.match(trigger.getAttribute('aria-label'), /1\.5倍/u); assert.equal(ui.menus.at(-1).selection, true);
  await ui.emit(trigger, 'click'); assert.equal(audio.playbackRate, 1.5); assert.equal(ui.menus.at(-1).items.find(item => item.id === '1.5').selected, true);
  await ui.emit(trigger, 'click'); assert.equal(audio.playbackRate, 1.5); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(ui.calls.some(item => /organize|transcribe|update/u.test(item.method)), false);
});

test('many group suggestions show two named actions and use the searchable picker for the full deduplicated list', async () => {
  const ui = await rendererHarness({ topics: [{ id: 'reading', name: '阅读' }, { id: 'travel', name: '出行' }], record: { organization: { summary: '摘要', topicSuggestions: ['阅读', '新的计划', ' 阅读 ', '出行', '新的计划', '另一个方向'] } }, groupPicker: () => ({ id: 'suggestion-3', name: '另一个方向' }), confirm: () => false });
  const actions = descendants(ui.nodes.get('#record-detail')).filter(item => item.getAttribute('data-topic-suggestion-name'));
  assert.deepEqual(actions.map(item => item.getAttribute('data-topic-suggestion-name')), ['阅读', '新的计划']); assert.deepEqual(actions.map(item => item.getAttribute('data-ui-icon')), ['folder-in', 'folder-plus']);
  await ui.clickSelector('#more-topic-suggestions'); const picker = ui.pickers.at(-1); assert.equal(picker.searchLabel, '搜索建议分组'); assert.deepEqual(picker.topics.map(item => item.name), ['阅读', '出行']); assert.deepEqual(picker.choices.map(item => item.name), ['新的计划', '另一个方向']);
  assert.equal(ui.confirmations.at(-1).confirmLabel, '创建并归入'); assert.equal(ui.nodes.get('#more-topic-suggestions').getAttribute('aria-expanded'), 'false');
  assert.equal(ui.calls.some(item => ['topics:create', 'records:setTopics', 'records:organize'].includes(item.method)), false);
});

test('late suggestion picker results are discarded after leaving the selected record', async () => {
  const choice = deferred(); const ui = await rendererHarness({ record: { organization: { summary: '摘要', topicSuggestions: ['甲', '乙', '丙'] } }, groupPicker: () => choice.promise });
  const pending = ui.clickSelector('#more-topic-suggestions'); await ui.flush(); ui.run("showView('settings')"); choice.resolve({ id: 'suggestion-2', name: '丙' }); await pending;
  assert.equal(ui.run('state.view'), 'settings'); assert.equal(ui.calls.some(item => item.method === 'topics:create' || item.method === 'records:setTopics'), false); assert.equal(ui.confirmations.length, 0);
});

test('closing the combined filter panel preserves existing conditions without a new local or AI query', async () => {
  const ui = await rendererHarness({ select: false, filters: () => null });
  ui.nodes.get('#date-range').value = '30'; ui.nodes.get('#search-input').value = '阅读'; ui.run("state.query='阅读'");
  const reads = ui.calls.filter(item => ['records:list', 'records:search'].includes(item.method)).length;
  await ui.clickSelector('#library-filter-trigger');
  assert.equal(ui.filterPanels.at(-1).range, '30'); assert.equal(ui.filterPanels.at(-1).query, '阅读'); assert.equal(ui.nodes.get('#date-range').value, '30'); assert.equal(ui.run('state.query'), '阅读');
  assert.equal(ui.calls.filter(item => ['records:list', 'records:search'].includes(item.method)).length, reads); assert.equal(ui.nodes.get('#library-filter-trigger').getAttribute('aria-expanded'), 'false');
});

test('applying combined date and keyword filters uses the current group and only local matching', async () => {
  const ui = await rendererHarness({ select: false, topics: [{ id: 'reading', name: '阅读' }], filters: () => ({ action: 'apply', range: 'custom', from: '2026-01-01', to: '2026-02-01', query: '联想' }) });
  await ui.run("openPrimaryGroup('reading')"); await ui.clickSelector('#library-filter-trigger');
  const request = ui.calls.filter(item => item.method === 'records:search').at(-1); assert.equal(request.params.query, '联想'); assert.deepEqual(Array.from(request.params.filters.topicIds), ['reading']);
  assert.equal(request.params.filters.from, new Date('2026-01-01T00:00:00').getTime()); assert.equal(request.params.filters.to, new Date('2026-02-02T00:00:00').getTime());
  assert.equal(ui.nodes.get('#search-input').value, '联想'); assert.equal(ui.nodes.get('#library-filter-trigger').getAttribute('data-filter-count'), '2'); assert.equal(ui.calls.some(item => ['records:aiSearch', 'settings:save', 'records:organize'].includes(item.method)), false);
});

test('AI entry in the filter panel opens the description form with the draft query and sends no records', async () => {
  const ui = await rendererHarness({ select: false, filters: () => ({ action: 'ai', query: '之前那条有关做菜的灵感' }) });
  await ui.clickSelector('#library-filter-trigger'); assert.equal(ui.nodes.get('#ai-search-dialog').open, true); assert.equal(ui.nodes.get('#ai-search-description').value, '之前那条有关做菜的灵感');
  assert.equal(ui.calls.some(item => ['records:aiSearch', 'library:batchOrganize', 'records:organize'].includes(item.method)), false);
});

test('a combined filter result arriving after navigation leaves the new page and original conditions in place', async () => {
  const gate = deferred(); const ui = await rendererHarness({ select: false, filters: () => gate.promise });
  const pending = ui.clickSelector('#library-filter-trigger'); await ui.flush(); ui.run("showView('settings')");
  gate.resolve({ action: 'apply', range: '365', from: '', to: '', query: '迟到的条件' }); await pending;
  assert.equal(ui.run('state.view'), 'settings'); assert.notEqual(ui.nodes.get('#date-range').value, '365'); assert.notEqual(ui.run('state.query'), '迟到的条件'); assert.equal(ui.nodes.get('#library-filter-trigger').getAttribute('aria-expanded'), 'false');
});


test('automatic model selection is the normal setting and manual selection requires an explicit advanced switch', async () => {
  const ui = await rendererHarness({settings:publicAISettings()});
  assert.equal(ui.nodes.get('#model-manual-enabled').checked,false);
  assert.equal(ui.nodes.get('#model-input').disabled,true);
  await ui.submitSettings();
  assert.equal(ui.calls.filter(call=>call.method === 'settings:save').at(-1).params.modelMode,'auto');
  await enableManualModel(ui);
  assert.equal(ui.nodes.get('#model-input').disabled,false);
  await ui.submitSettings();
  assert.equal(ui.calls.filter(call=>call.method === 'settings:save').at(-1).params.modelMode,'manual');
});

test('Gemini free-model preference defaults on, survives unsaved provider changes, and is disabled in manual mode', async () => {
  const ui = await rendererHarness({ settings:publicAISettings() });
  const row = ui.nodes.get('#prefer-free-model-row');
  const preference = ui.nodes.get('#prefer-free-model');
  assert.equal(row.classList.contains('hidden'), true);
  assert.equal(preference.checked, true);
  await switchAIProvider(ui, 'gemini');
  assert.equal(row.classList.contains('hidden'), false);
  assert.equal(preference.disabled, false);
  preference.checked = false;
  await ui.emit(preference, 'change');
  await switchAIProvider(ui, 'openai');
  assert.equal(row.classList.contains('hidden'), true);
  await switchAIProvider(ui, 'gemini');
  assert.equal(preference.checked, false);
  await enableManualModel(ui);
  assert.equal(preference.disabled, true);
  await ui.submitSettings();
  assert.equal(ui.calls.filter(call => call.method === 'settings:save').at(-1).params.preferFreeModel, false);
});
