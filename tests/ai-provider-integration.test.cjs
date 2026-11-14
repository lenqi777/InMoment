'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { LocalStore } = require('../src/core/store.cjs');
const { Settings } = require('../src/main/settings.cjs');
const { LibraryAI } = require('../src/main/library-ai.cjs');
const { AutoTitleManager } = require('../src/main/auto-title.cjs');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const KEYS = Object.freeze({ deepseek:'mock-fixture-deepseek-not-auth', openai:'mock-fixture-openai-not-auth', gemini:'mock-fixture-gemini-not-auth' });

// The real IPC coordinator runs with a synthetic SQLite store and an injected
// client factory. All network transports fail immediately, even outside the VM.
function fixture(t, options = {}) {
  const denyNetwork = () => { throw new Error('Network is forbidden in provider integration tests.'); };
  t.mock.method(globalThis, 'fetch', denyNetwork);
  for (const name of ['node:http','node:https']) { const transport = require(name); t.mock.method(transport, 'get', denyNetwork); t.mock.method(transport, 'request', denyNetwork); }
  const directory = fs.mkdtempSync(path.join(__dirname, '.tmp-ai-provider-'));
  const store = new LocalStore(directory), calls = [], dialogs = [], events = [], clients = [];
  const secure = { isEncryptionAvailable:() => true, encryptString:value => Buffer.from('mock-only:' + value), decryptString:value => value.toString('utf8').slice('mock-only:'.length) };
  const settings = new Settings(directory, secure);
  settings.save({ aiProvider:options.provider || 'deepseek', aiProfiles:Object.fromEntries(Object.keys(KEYS).map(id => [id, { apiKey:KEYS[id], ...(options.sameModel ? {model:options.sameModel} : {}) }])) });
  settings.value = { ...settings.value, cloudEnabled:true, cloudConsentVersion:1, autoTitleEnabled:true, autoTitleConsentVersion:1, aiSearchEnabled:true, aiSearchConsentVersion:1, duplicateAnalysisEnabled:true, duplicateAnalysisConsentVersion:1, directAIEnabled:options.direct !== false, directAIConsentVersion:1, screenshotAnalysisEnabled:false, screenshotAnalysisConsentVersion:0 };
  const filename = path.join(__dirname, '../src/main/main.cjs'), localRequire = createRequire(filename);
  const electron = { app:{ setName() {}, setAppUserModelId() {}, setPath() {}, getPath:() => directory, requestSingleInstanceLock:() => true, whenReady:() => new Promise(() => {}), on() {}, getVersion:() => 'test', quit() {} }, protocol:{ registerSchemesAsPrivileged() {} } };
  function mockClient(config) {
    const connection = Object.freeze({ ...config }); clients.push(connection);
    const metadata = { provider:connection.provider, model:connection.model, usage:{totalTokens:3} };
    function invoke(method, data, opts, fallback) {
      const call = { method, provider:connection.provider, model:connection.model, key:connection.apiKey, data, opts }; calls.push(call);
      const result = options.clientCall?.(call); return Promise.resolve(result === undefined ? fallback() : result);
    }
    return {
      provider:connection.provider, model:connection.model,
      generateTitle(record, opts) { return invoke('generateTitle', record, opts, () => ({title:'模拟灵感标题', ...metadata})); },
      organize(record, opts) { return invoke('organize', record, opts, () => ({schemaVersion:2, title:'模拟整理', summary:'保留灵感产生时的理由', evidence:[], points:[], uncertainties:[], topicSuggestions:[], ...metadata})); },
      classifyBatch(records, opts) { return invoke('classifyBatch', records, opts, () => ({schemaVersion:1, groups:[{name:'共同想法',reason:'本批记录讨论相同主题',records:records.map(({id,version}) => ({id,version}))}], unassigned:[], ...metadata})); },
      interpretQuery(query, opts) { return invoke('interpretQuery', query, opts, () => ({intent:'找回灵感',terms:['灵感'], ...metadata})); },
      rankCandidates(query, candidates, opts) { return invoke('rankCandidates', candidates, opts, () => ({results:candidates.slice(0,1).map(item => ({id:item.id,reason:'相关的灵感',quote:item.text.slice(0,16),version:item.version})), ...metadata})); },
      findDuplicates(candidates, opts) { return invoke('findDuplicates', candidates, opts, () => ({duplicates:[], ...metadata})); },
    };
  }
  let cloudPermissions;
  const context = vm.createContext({ require(name) { if (name === 'electron') return electron; if (name === '../core/ai-client.cjs') return {createAIClient:mockClient}; if (name === './cloud-permissions.cjs') return cloudPermissions; if (name === './semantic-service.cjs') return {createSemanticService() { throw new Error('Semantic models are forbidden in integration tests.'); }}; return localRequire(name); }, __dirname:path.dirname(filename), process:{platform:'win32',env:options.networkDisabled ? {INMOMENT_DISABLE_NETWORK:'1'} : {},execPath:process.execPath}, Buffer, URL, Response, AbortController, AbortSignal, Promise, structuredClone, setImmediate, setTimeout, clearTimeout, console, fetch:denyNetwork });
  const permissionModule = {exports:{}};
  vm.runInContext('(function(module,exports){\n' + fs.readFileSync(path.join(path.dirname(filename), 'cloud-permissions.cjs'), 'utf8') + '\n})', context)(permissionModule, permissionModule.exports); cloudPermissions = permissionModule.exports;
  vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nglobalThis.integration={invoke,bootstrap,currentAIConfig,sameAIConfig,createConfiguredClient,init(deps){store=deps.store;settings=deps.settings;controller=deps.controller;autoTitles=deps.autoTitles;libraryAI=deps.libraryAI;semantic=deps.semantic;offlineASR={capabilities:()=>({available:false})};mainWindow=deps.mainWindow;uiDialogs=deps.uiDialogs;}};', context);
  const semantic = options.semantic || {status:() => ({available:false}), async search() { return store.listRecords().map(record => ({id:record.id,score:.9})); }};
  const libraryAI = new LibraryAI({store, semantic, client:() => context.integration.createConfiguredClient()});
  const autoTitles = new AutoTitleManager({store, settings, createClient:() => context.integration.createConfiguredClient(), networkDisabled:() => Boolean(options.networkDisabled)});
  const mainWindow = {isDestroyed:() => false, isMinimized:() => false, show() {}, focus() {}, webContents:{send(channel,message) { events.push(message); }}};
  const uiDialogs = {async showMessageBox(value) { dialogs.push(value); return options.confirm ? options.confirm(value) : {response:options.approve === false ? 0 : 1}; }};
  context.integration.init({store,settings,libraryAI,autoTitles,semantic,mainWindow,uiDialogs,controller:{snapshot:() => ({active:false}),refreshTrigger:async () => {},emitState() {},session:{}}});
  t.after(() => { autoTitles.cancelAll(); store.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(__dirname) + path.sep + '.tmp-ai-provider-')); fs.rmSync(directory,{recursive:true,force:true}); });
  function record(id = 'one', title = id) { store.createDraft({id,title}); store.addSegment(id,{id:id+'-audio',bytes:Buffer.from('synthetic WAV fixture'),transcript:'保存灵感发生时的理由，回顾记录中的想法。'}); return store.complete(id); }
  return { ...context.integration, store, settings, calls, clients, dialogs, events, libraryAI, autoTitles, record };
}

for (const provider of ['deepseek','openai','gemini']) test(provider + ' routes all five AI workflows through its own key and model', async t => {
  const fx = fixture(t,{provider}); const one = fx.record('one'), two = fx.record('two'); fx.record('untitled','');
  await fx.invoke('records:organize',{id:one.id});
  const batch = await fx.invoke('library:batchOrganize',{recordIds:[one.id,two.id],expectedVersions:{[one.id]:one.version,[two.id]:two.version}}); assert.equal(batch.grouping.status,'done');
  await fx.invoke('records:aiSearch',{query:'灵感'}); await fx.invoke('library:duplicates',{filters:{}}); await fx.autoTitles.run('untitled');
  assert.deepEqual(new Set(fx.calls.map(call => call.method)),new Set(['organize','classifyBatch','interpretQuery','rankCandidates','findDuplicates','generateTitle']));
  assert(fx.calls.every(call => call.provider === provider && call.key === KEYS[provider] && call.model === fx.settings.public().model));
  const publicData = JSON.stringify([fx.bootstrap(),fx.events,fx.dialogs]); for (const key of Object.values(KEYS)) assert.equal(publicData.includes(key),false); assert.equal(publicData.includes('apiKeyEncrypted'),false);
});

test('a provider switch while a one-off approval is pending cancels the original request', async t => {
  const approval = deferred(), ready = deferred();
  const fx = fixture(t,{direct:false, confirm(value) { if (/允许这一次/.test(value.title)) {ready.resolve(); return approval.promise;} return {response:1}; }}); fx.record();
  const request = fx.invoke('records:organize',{id:'one'}); await ready.promise;
  await fx.invoke('settings:save',{aiProvider:'openai'}); approval.resolve({response:1}); const result = await request;
  assert.equal(result.cancelled,true); assert.equal(fx.calls.length,0); assert.equal(fx.store.getRecord('one').organization,null); assert.equal(fx.settings.public().aiProvider,'openai');
  assert(fx.dialogs.some(value => /DeepSeek/u.test(value.message + value.title + value.detail)));
});

test('switching provider aborts an in-flight summary and ignores a late success', async t => {
  const response = deferred(), ready = deferred(); let signal;
  const fx = fixture(t,{clientCall(call) { if (call.method === 'organize') {signal=call.opts.signal;ready.resolve();return response.promise;} }}); fx.record();
  const request = fx.invoke('records:organize',{id:'one'}); await ready.promise; await fx.invoke('settings:save',{aiProvider:'gemini'}); assert.equal(signal.aborted,true);
  response.resolve({schemaVersion:2,title:'过期结果',summary:'不应落盘',evidence:[],points:[],uncertainties:[],topicSuggestions:[]}); const result = await request;
  assert.equal(result.cancelled,true); assert.equal(fx.store.getRecord('one').organization,null);
});

test('a batch cannot continue summaries or unified grouping with a newly selected provider', async t => {
  const response = deferred(), ready = deferred(); let signal;
  const fx = fixture(t,{clientCall(call) { if (call.method === 'organize') {signal=call.opts.signal;ready.resolve();return response.promise;} }}); const one = fx.record('one'), two = fx.record('two');
  const request = fx.invoke('library:batchOrganize',{recordIds:[one.id,two.id],expectedVersions:{one:one.version,two:two.version}}); await ready.promise;
  await fx.invoke('settings:save',{aiProvider:'openai'}); assert.equal(signal.aborted,true); response.resolve({schemaVersion:2,title:'旧摘要',summary:'不应跨服务继续',evidence:[],points:[],uncertainties:[],topicSuggestions:[]});
  const result = await request; assert.equal(result.cancelled,true); assert.equal(fx.calls.filter(call => call.method === 'organize').length,1); assert.equal(fx.calls.some(call => call.method === 'classifyBatch'),false); assert(fx.calls.every(call => call.provider === 'deepseek'));
});

test('a destination change during unified classification preserves summaries without applying old grouping', async t => {
  const response=deferred(), ready=deferred(); let signal;
  const fx=fixture(t,{clientCall(call) { if (call.method==='classifyBatch') {signal=call.opts.signal;ready.resolve(call.data);return response.promise;} }}); const one=fx.record('one'),two=fx.record('two');
  const pending=fx.invoke('library:batchOrganize',{recordIds:['one','two'],expectedVersions:{one:one.version,two:two.version}}); const records=await ready.promise;
  await fx.invoke('settings:save',{aiProvider:'gemini'}); response.resolve({schemaVersion:1,groups:[{name:'过期分组',reason:'旧服务结果',records:records.map(({id,version})=>({id,version}))}],unassigned:[]}); const result=await pending;
  assert.equal(signal.aborted,true); assert.equal(result.cancelled,true); assert.equal(result.grouping.status,'cancelled');
  for (const id of ['one','two']) { assert.equal(fx.store.getRecord(id).organization.provider,'deepseek'); assert.deepEqual(fx.store.getRecord(id).organization.topicSuggestions,[]); }
});

test('switching provider cancels a library search before ranking and clears its caches', async t => {
  const response = deferred(), ready = deferred(); let signal;
  const fx = fixture(t,{clientCall(call) { if (call.method === 'interpretQuery') {signal=call.opts.signal;ready.resolve();return response.promise;} }}); fx.record();
  fx.libraryAI.searchCache.set('sentinel',{}); fx.libraryAI.examinedPairs.add('sentinel');
  const pending = fx.invoke('records:aiSearch',{query:'灵感'}).then(value => ({value}), error => ({error})); await ready.promise;
  await fx.invoke('settings:save',{aiProvider:'gemini'}); response.resolve({intent:'灵感',terms:['灵感']}); const outcome = await pending;
  assert(outcome.value?.cancelled || /cancel|取消/iu.test(outcome.error?.message || ''));
  assert.equal(signal.aborted,true); assert.equal(fx.calls.some(call => call.method === 'rankCandidates'),false); assert.equal(fx.libraryAI.searchCache.size,0); assert.equal(fx.libraryAI.examinedPairs.size,0);
});

test('a provider change cancels automatic naming and a late title cannot overwrite the record', async t => {
  const response = deferred(), ready = deferred(); let signal;
  const fx = fixture(t,{clientCall(call) { if (call.method === 'generateTitle') {signal=call.opts.signal;ready.resolve();return response.promise;} }}); fx.record('one','');
  const pending = fx.autoTitles.run('one'); await ready.promise; await fx.invoke('settings:save',{aiProvider:'openai'}); response.resolve({title:'过期标题'}); await pending;
  assert.equal(signal.aborted,true); assert.equal(fx.store.getRecord('one').title,'');
});

test('a destination change during duplicate analysis prevents late suggestions from being stored', async t => {
  const response=deferred(),ready=deferred(); let signal;
  const fx=fixture(t,{clientCall(call) { if (call.method==='findDuplicates') {signal=call.opts.signal;ready.resolve();return response.promise;} }}); fx.record('one');fx.record('two');
  const pending=fx.invoke('library:duplicates',{}).then(value=>({value}),error=>({error}));await ready.promise;await fx.invoke('settings:save',{aiProvider:'openai'});
  response.resolve({duplicates:[{leftId:'one',rightId:'two',kind:'same',reason:'过期建议',leftQuote:'保存灵感',rightQuote:'保存灵感'}]});const outcome=await pending;
  assert(outcome.value?.cancelled || /cancel|取消/iu.test(outcome.error?.message || ''));assert.equal(signal.aborted,true);assert.equal(fx.store.listDuplicateSuggestions().length,0);assert.equal(fx.store.countRecords(),2);
});

test('rotating an active profile key aborts old work and the next request uses only its new key', async t => {
  const response=deferred(),ready=deferred();let signal,requests=0;
  const fx=fixture(t,{clientCall(call) { if(call.method==='organize' && ++requests===1) {signal=call.opts.signal;ready.resolve();return response.promise;} }});fx.record();
  const pending=fx.invoke('records:organize',{id:'one'});await ready.promise;const replacement='mock-fixture-replacement-not-auth';await fx.invoke('settings:save',{aiProfiles:{deepseek:{apiKey:replacement}}});
  response.resolve({schemaVersion:2,title:'旧结果',summary:'不应用旧密钥的结果',evidence:[],points:[],uncertainties:[],topicSuggestions:[]});await pending;assert.equal(signal.aborted,true);assert.equal(fx.store.getRecord('one').organization,null);
  await fx.invoke('records:organize',{id:'one'});assert(fx.calls.at(-1).key===replacement);assert.equal(fx.calls.at(-1).provider,'deepseek');
});

test('editing an inactive profile does not cancel the current provider request', async t => {
  const response=deferred(),ready=deferred();let signal;
  const fx=fixture(t,{clientCall(call) {if(call.method==='organize') {signal=call.opts.signal;ready.resolve();return response.promise;}}});fx.record();const pending=fx.invoke('records:organize',{id:'one'});await ready.promise;
  await fx.invoke('settings:save',{aiProfiles:{gemini:{apiKey:'mock-inactive-gemini-update'}}});assert.equal(signal.aborted,false);
  response.resolve({schemaVersion:2,title:'有效结果',summary:'保留原服务请求',evidence:[],points:[],uncertainties:[],topicSuggestions:[]});await pending;assert.equal(fx.store.getRecord('one').organization.provider,'deepseek');
});

test('one-off batch authorization names the frozen destination and model without revealing a key', async t => {
  const fx=fixture(t,{provider:'gemini',direct:false});const one=fx.record('one'),two=fx.record('two');await fx.invoke('library:batchOrganize',{recordIds:['one','two'],expectedVersions:{one:one.version,two:two.version}});
  const prompt=fx.dialogs.find(value=>/批量整理/u.test(value.title));const text=prompt.message+'\n'+prompt.detail;assert.match(text,/Gemini/u);assert(text.includes(fx.settings.public().model));for(const key of Object.values(KEYS)) assert(!text.includes(key));
});

test('same model names on different providers do not share search results', async t => {
  const fx = fixture(t,{sameModel:'shared-custom-model'}); fx.record();
  const first = await fx.libraryAI.search({query:'灵感',approved:true}); assert.equal(first.cached,false);
  const cached = await fx.libraryAI.search({query:'灵感',approved:true}); assert.equal(cached.cached,true);
  // Deliberately bypass main's clearCache to verify the cache identity itself.
  fx.settings.save({aiProvider:'gemini'},{approvedAutoTitle:true,approvedCapabilities:['cloudEnabled','aiSearchEnabled','duplicateAnalysisEnabled','directAIEnabled']}); const second = await fx.libraryAI.search({query:'灵感',approved:true});
  assert.equal(second.cached,false); assert.equal(fx.calls.filter(call => call.method === 'interpretQuery').length,2); assert.equal(fx.calls.at(-1).provider,'gemini');
});

test('cancelling a destination change preserves the original provider and its active request', async t => {
  const response = deferred(), ready = deferred(); let signal;
  const fx = fixture(t,{approve:false, confirm:() => ({response:0}), clientCall(call) { if (call.method === 'organize') {signal=call.opts.signal;ready.resolve();return response.promise;} }}); fx.record();
  const pending = fx.invoke('records:organize',{id:'one'}); await ready.promise;
  const saved = await fx.invoke('settings:save',{aiProvider:'gemini'}); assert.equal(saved.cancelled,true); assert.equal(fx.settings.public().aiProvider,'deepseek'); assert.equal(signal.aborted,false);
  response.resolve({schemaVersion:2,title:'仍有效的摘要',summary:'原服务的有效结果',evidence:[],points:[],uncertainties:[],topicSuggestions:[]});
  await pending; assert.equal(fx.store.getRecord('one').organization.summary,'原服务的有效结果');
});

test('changing provider clears duplicate examination state so the new service can evaluate the same pairs', async t => {
  const fx = fixture(t); fx.record('one'); fx.record('two');
  await fx.invoke('library:duplicates',{}); assert.equal(fx.calls.filter(call => call.method === 'findDuplicates').length,1); assert(fx.libraryAI.examinedPairs.size > 0);
  await fx.invoke('settings:save',{aiProvider:'openai'}); assert.equal(fx.libraryAI.examinedPairs.size,0);
  await fx.invoke('library:duplicates',{}); const duplicateCalls = fx.calls.filter(call => call.method === 'findDuplicates'); assert.equal(duplicateCalls.length,2); assert.equal(duplicateCalls.at(-1).provider,'openai');
});

test('the development network lock blocks every manual workflow before a client is created', async t => {
  const fx = fixture(t,{networkDisabled:true}); const one = fx.record('one'), two = fx.record('two');
  for (const [method,params] of [['records:organize',{id:'one'}],['records:aiSearch',{query:'灵感'}],['library:duplicates',{}],['library:batchOrganize',{recordIds:['one','two'],expectedVersions:{one:one.version,two:two.version}}]]) await assert.rejects(fx.invoke(method,params),/测试模式/);
  await fx.autoTitles.run('one'); assert.equal(fx.clients.length,0); assert.equal(fx.dialogs.length,0);
});
