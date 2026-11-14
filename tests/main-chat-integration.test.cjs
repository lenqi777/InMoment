'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { LocalStore } = require('../src/core/store.cjs');
const { Settings } = require('../src/main/settings.cjs');

// Run production IPC + production chat initialization against an isolated store.
// Electron, native input, microphone and external inference never start.
function fixture(t, options = {}) {
  const deny = () => { throw new Error('External network forbidden in chat IPC tests.'); };
  t.mock.method(globalThis, 'fetch', deny);
  for (const name of ['node:http', 'node:https']) { const transport = require(name); t.mock.method(transport, 'request', deny); t.mock.method(transport, 'get', deny); }
  const root = fs.mkdtempSync(path.join(__dirname, '.tmp-main-chat-'));
  const store = new LocalStore(root), calls = [], events = [], windowActions = [], windowScripts = [], nativeCalls = [], clipboardImages = [];
  let foreground = options.foreground || {};
  const settings = new Settings(root, { isEncryptionAvailable: () => true, encryptString: value => Buffer.from('opaque:' + value), decryptString: value => value.toString().slice(7) });
  settings.save({ cloudEnabled: true, apiKey: 'fixture-chat-credential', ...options.settings }, { approvedCapabilities: ['cloudEnabled'] });
  const filename = path.join(__dirname, '../src/main/main.cjs'), localRequire = createRequire(filename), source = fs.readFileSync(filename, 'utf8');
  const callbacks = new Map();
  const workArea = options.workArea || { x: 0, y: 0, width: 1200, height: 900 };
  const electron = { app: { setName() {}, setAppUserModelId() {}, setPath() {}, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on(name, callback) { callbacks.set(name, callback); }, quit() {}, getVersion: () => 'test' }, protocol: { registerSchemesAsPrivileged() {} }, screen: { getCursorScreenPoint: () => ({ x: 100, y: 100 }), getDisplayNearestPoint: () => ({ workArea }), getDisplayMatching: () => ({ workArea }), ...options.screen }, desktopCapturer: options.desktopCapturer };
  electron.ClipboardItem = class { constructor(items) { this.items = items; } };
  electron.clipboard = { async write([item]) {
    assert.ok(item instanceof electron.ClipboardItem);
    assert.deepEqual(Object.keys(item.items), ['image/png']);
    const png = item.items['image/png'];
    assert.equal(png.type, 'image/png');
    clipboardImages.push(`data:image/png;base64,${Buffer.from(await png.arrayBuffer()).toString('base64')}`);
  } };
  let permissions;
  const context = vm.createContext({ require(name) {
    if (name === 'electron') return electron;
    if (name === './cloud-permissions.cjs') return permissions;
    if (name === '../core/chat-client.cjs') return { createChatClient(config) { return { async chat(messages, opts) { calls.push({ config, messages, opts }); if (options.chat) return options.chat(messages, opts); opts.onDelta?.('模拟回复'); return { text: '模拟回复', provider: config.provider, model: 'mock-model' }; } }; } };
    return localRequire(name);
  }, __dirname: path.dirname(filename), process: { platform: 'win32', execPath: process.execPath, env: options.networkDisabled ? { INMOMENT_DISABLE_NETWORK: '1' } : {} }, Buffer, Blob, URL, Response, AbortController, Promise, setTimeout, clearTimeout, console, fetch: deny });
  const permissionModule = { exports: {} };
  vm.runInContext('(function(module,exports){' + fs.readFileSync(path.join(path.dirname(filename), 'cloud-permissions.cjs'), 'utf8') + '\n})', context)(permissionModule, permissionModule.exports);
  permissions = permissionModule.exports;
  const begin = source.indexOf('  chats = new ChatService('), end = source.indexOf("  bridge.on('holdStart'", begin);
  assert.ok(begin > 0 && end > begin, 'production chat initializer remains available');
  vm.runInContext(source + '\nglobalThis.fixtureAPI = { invoke, takeRegionScreenshot, currentAIConfig, sendChatAudioLevel, pauseFloatingRecording, pauseMainChatRecording, recoverOwnedChat, prepareChatsForQuit, reportCloseFailure, showOverlay, captureSessionForUI, shouldRecoverOwnedChat, init(deps) { const dataDir = deps.root; store=deps.store; settings=deps.settings; mainWindow=deps.mainWindow; chatWindow=deps.chatWindow; overlay=deps.overlay; controller=deps.controller; offlineASR=deps.asr; bridge=deps.bridge; autoTitles=deps.autoTitles; uiDialogs=deps.uiDialogs; libraryAI={clearCache(){}};\n' + source.slice(begin, end) + '\nreturn { chats, chatCapture, screenshot }; }, setFloating(id) { floatingChatId=id; }, floating() { return floatingChatId; }, flags(){return{shutdownStarted,quitApprovalPending,quitting}} };', context);
  const windows = {};
  function window(name) {
    let minimized = false, focused = true;
    let visible = name === 'floating' && options.floatingVisible === true || name === 'overlay' && options.overlayVisible === true || name==='main' && options.mainVisible===true;
    let bounds = { x: 100, y: 100, width: 464, height: 584, ...options.bounds, ...options.windowBounds?.[name] };
    let minimum = options.minimum || [384, 424];
    return windows[name] = { isDestroyed: () => false, isMinimized: () => minimized, isFocused:()=>focused, setFocused(value){focused=value;}, minimize(){minimized=true;visible=false;}, restore(){minimized=false;visible=true;windowActions.push(name+':restore');}, isVisible: () => visible, getNativeWindowHandle() { const handle=Buffer.alloc(8);handle.writeBigUInt64LE(name==='floating'?42n:11n);return handle; }, blur() { windowActions.push(name+':blur'); }, hide() { visible = false; if(name==='floating'&&options.restoreOnHide)foreground={...options.source};windowActions.push(name + ':hide'); }, show() { visible = true; windowActions.push(name + ':show'); }, showInactive() { visible = true; windowActions.push(name + ':showInactive'); }, focus() { windowActions.push(name + ':focus'); }, setIgnoreMouseEvents(value) { windowActions.push(name + ':ignore:' + value); }, getMinimumSize: () => [...minimum], setMinimumSize(width, height) { minimum = [width, height]; }, getBounds: () => ({ ...bounds }), getContentBounds: () => ({ ...bounds }), setBounds(next) { bounds = { ...bounds, ...next }; windowActions.push(name + ':resize'); }, async loadFile(...args) { windowActions.push(name + ':load'); return options.windowCallbacks?.loadFile?.(name,...args); }, webContents: { getZoomFactor: () => options.zoom || 1, send(_channel, event) { events.push({ window: name, ...event }); }, async executeJavaScript(script) { windowScripts.push({ window:name,script }); if(options.windowCallbacks?.executeJavaScript){const value=await options.windowCallbacks.executeJavaScript(name,script);if(value!==undefined)return value;}if(script.includes('confirmClose'))return options.closeChoice||'discard';if(script.includes('prepareForClose'))return options.prepareClose!==false;if(script.includes('hasCloseContent'))return options.closeContent===true;if(name==='main'&&script==='window.chatView?.currentId')return options.mainCurrentId||null;return name==='overlay'?options.overlaySurface:null; } } };
  }
  let active = { active: false, id: null, state: 'idle' };
  const controller = new EventEmitter(); Object.assign(controller, { pending: new Set(), snapshot: () => ({ ...active }), refreshTrigger: async () => { nativeCalls.push({method:'refreshTrigger',foreground:{...foreground}}); }, emitState() {}, pause() { active.state = 'paused'; }, waitForStops: async () => {}, async discard() { store.discard(active.id); active = { active: false, id: null, state: 'idle' }; } });
  controller.finishRegionScreenshot = id => {
    if (id !== active.id || !active.regionScreenshotOpen) return false;
    active.regionScreenshotOpen = false;
    events.push({ type: 'regionScreenshotFinished', id });
    return true;
  };
  const initialized = context.fixtureAPI.init({ root, store, settings, controller, mainWindow: window('main'), chatWindow: window('floating'), overlay: window('overlay'), asr: { capabilities: () => ({ available: false }) }, bridge: { request: async (method,params) => {nativeCalls.push({method,params});if(method==='foreground')return{...foreground};if(method==='focusWindow'){if(options.focusError)throw Object.assign(new Error('synthetic focus failure'),{code:options.focusError});if(options.focusDenied)return{success:false,error:{code:'FOREGROUND_DENIED'}};foreground={...params};return{success:true}}return{};} }, autoTitles: { cancelAll() {},close(){} }, uiDialogs: { close(){},async showMessageBox() { return { response: 1 }; } } });
  t.after(async () => { await initialized.chatCapture.shutdown().catch(() => {}); await initialized.chats.shutdown(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function ownedChat({ saved = false, savedRecording = false } = {}) {
    const draft = store.createDraft({ notes: '合成临时文字' }); const chat = initialized.chats.create({ audioDraftId: draft.id });
    initialized.chatCapture.own(chat.id, draft.id); active = { active: true, id: draft.id, state: 'paused', context: options.source || {} };
    if (saved) initialized.chats.save(chat.id);
    if (savedRecording) { store.complete(draft.id); active = { active: false, id: draft.id, state: 'saved' }; }
    context.fixtureAPI.setFloating(chat.id);
    return { chat, draft };
  }
  return { beforeQuit:callbacks.get('before-quit'), root, store, settings, calls, events, windowActions, windowScripts, nativeCalls, clipboardImages, windows, ownedChat, controller, setForeground(value) {foreground={...value};}, setActive(value) { active = { ...value }; }, ...initialized, ...context.fixtureAPI };
}

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

test('trusted main creates a formal welcome while floating and external origins create temporary sessions',async t=>{
  const fx=fixture(t),formal=await fx.invoke('chat:create',{autoSave:false},fx.windows.main),temporary=await fx.invoke('chat:create',{autoSave:true},fx.windows.floating),external=await fx.invoke('chat:create',{autoSave:true});assert.equal(formal.autoSave,true);assert.equal(formal.saved,false);assert.equal(temporary.autoSave,false);assert.equal(external.autoSave,false);assert.deepEqual(fs.readdirSync(path.join(fx.root,'chats')),[]);
  const read=await fx.invoke('chat:get',{id:temporary.id},fx.windows.main);assert.equal(read.autoSave,false,'readonly get cannot promote a hidden temporary session');await fx.invoke('chat:send',{id:formal.id,text:'首次正式提问'},fx.windows.main);assert.equal(fx.chats.get(formal.id).saved,true);assert.equal(fx.chats.list().find(chat=>chat.id===formal.id).autoSave,true);assert.ok(fs.existsSync(path.join(fx.root,'chats',formal.id+'.json')));
});

test('cancel close restores a hidden temporary float and keeps its same chat, draft and pending materials',async t=>{
  const fx=fixture(t,{closeChoice:'cancel',closeContent:true}),{chat,draft}=fx.ownedChat();fx.chats.update(chat.id,{input:'未提交输入',candidate:'未采用候选',quotes:[{id:'quote',text:'保留引用'}]});const before=fx.chats.get(chat.id);fx.windows.floating.minimize();const a=fx.invoke('chat:close',{id:chat.id}),b=fx.invoke('chat:close',{id:chat.id});assert.equal((await a).cancelled,true);await b;assert.deepEqual(fx.chats.get(chat.id),before);assert.ok(fx.store.getDraft(draft.id));assert.equal(fx.chatCapture.owners.get(chat.id),draft.id);assert.equal(fx.windows.floating.isVisible(),true);assert.equal(fx.windows.floating.isMinimized(),false);assert.equal(fx.windowScripts.filter(item=>item.script.includes('confirmClose')).length,1);
});

test('save-and-close waits for renderer preparation then preserves hint text after restart while deleting raw temporary audio',async t=>{
  let fx;const prepared=deferred();fx=fixture(t,{floatingVisible:true,windowCallbacks:{async executeJavaScript(name,script){if(name==='floating'&&script.includes('confirmClose')){await prepared.promise;fx.chats.update(fx.floating(),{input:'保存前完成的尾输入',candidate:'保留为提示的转写'});return'save';}}}});const{chat,draft}=fx.ownedChat(),raw=fx.store.addSegment(draft.id,{id:'raw-close',bytes:Buffer.from('synthetic raw voice')}).path;const closing=fx.invoke('chat:close',{id:chat.id});await new Promise(resolve=>setImmediate(resolve));assert.ok(fs.existsSync(raw));assert.equal(fx.chats.get(chat.id).saved,false);prepared.resolve();await closing;
  assert.equal(fx.chats.get(chat.id).saved,true);assert.equal(fx.chats.get(chat.id).autoSave,true);assert.equal(fx.store.getDraft(draft.id),null);assert.equal(fs.existsSync(raw),false);const restored=new fx.chats.constructor({rootDir:fx.root,store:fx.store,getConfig:()=>({}),createClient:()=>{throw new Error('no model')}});assert.equal(restored.get(chat.id).candidate,'保留为提示的转写');assert.equal(restored.get(chat.id).input,'保存前完成的尾输入');assert.equal(restored.get(chat.id).context.audioDraftId,null);restored.shutdown();assert.equal(fx.windows.floating.isVisible(),false);assert.equal(fx.calls.length,0);
});

test('save-close and transfer persistence failures keep the current float and its owned audio intact',async t=>{
  const fx=fixture(t,{floatingVisible:true,closeChoice:'save'}),{chat,draft}=fx.ownedChat();fx.chats.update(chat.id,{candidate:'不能丢的候选',input:'不能丢的输入'});const filename=path.join(fx.root,'chats',chat.id+'.json');fs.mkdirSync(filename);await assert.rejects(()=>fx.invoke('chat:close',{id:chat.id}),/不是普通文件/u);assert.equal(fx.windows.floating.isVisible(),true);assert.equal(fx.chats.get(chat.id).saved,false);assert.ok(fx.store.getDraft(draft.id));assert.equal(fx.chatCapture.owners.get(chat.id),draft.id);
  await assert.rejects(()=>fx.invoke('chat:showMain',{id:chat.id}),/不是普通文件/u);assert.equal(fx.windows.floating.isVisible(),true);assert.equal(fx.floating(),chat.id);assert.equal(fx.windowActions.includes('main:show'),false);fs.rmdirSync(filename);await fx.invoke('chat:showMain',{id:chat.id});assert.equal(fx.chats.get(chat.id).saved,true);assert.equal(fx.chats.get(chat.id).autoSave,true);assert.ok(fx.store.getDraft(draft.id));assert.equal(fx.windows.floating.isVisible(),false);assert.equal(fx.windows.main.isVisible(),true);
});

test('normal quit reuses cancel decision without shutting down; a formal main tail input is flushed before shutdown',async t=>{
  const cancelled=fixture(t,{floatingVisible:true,closeChoice:'cancel'}),{chat,draft}=cancelled.ownedChat();cancelled.chats.update(chat.id,{input:'退出前保留'});cancelled.beforeQuit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled.flags().shutdownStarted,false);assert.equal(cancelled.flags().quitApprovalPending,false);assert.ok(cancelled.store.getDraft(draft.id));assert.equal(cancelled.windows.floating.isVisible(),true);
  let fx,formal;fx=fixture(t,{mainVisible:true,windowCallbacks:{executeJavaScript(name,script){if(name==='main'&&script==='window.chatView?.currentId')return formal?.id||null;if(name==='main'&&script.includes('prepareForClose')){fx.chats.update(formal.id,{input:'最后一次尚未回写的输入'});return true;}}}});formal=await fx.invoke('chat:create',{},fx.windows.main);await fx.invoke('chat:send',{id:formal.id,text:'已经开始的正式聊天'},fx.windows.main);assert.equal(await fx.prepareChatsForQuit(),true);assert.equal(JSON.parse(fs.readFileSync(path.join(fx.root,'chats',formal.id+'.json'),'utf8')).input,'最后一次尚未回写的输入');
});

test('normal quit save failure stays recoverable and shows main when no floating view owns the error',async t=>{
  const fx=fixture(t,{floatingVisible:true,closeChoice:'save'}),{chat,draft}=fx.ownedChat();fx.chats.update(chat.id,{candidate:'未采用转写'});fs.mkdirSync(path.join(fx.root,'chats',chat.id+'.json'));fx.beforeQuit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));assert.equal(fx.flags().shutdownStarted,false);assert.ok(fx.store.getDraft(draft.id));assert.equal(fx.windows.floating.isVisible(),true);assert.ok(fx.events.some(event=>event.type==='error'));
  const main=fixture(t);main.reportCloseFailure(new Error('请重试取消本次录音'));assert.equal(main.windows.main.isVisible(),true);assert.ok(main.events.some(event=>event.type==='error'&&event.window==='main'));
});

test('normal quit restores a noncurrent failed voice chat and preserves its raw audio, prior text and attachments',async t=>{
  let current;const fx=fixture(t,{mainVisible:true,windowCallbacks:{executeJavaScript(name,script){if(name==='main'&&script==='window.chatView?.currentId')return current;}}});
  const a=await fx.invoke('chat:create',{},fx.windows.main),b=await fx.invoke('chat:create',{},fx.windows.main);
  fx.controller.startManual=async()=>{const draft=fx.store.createDraft();fx.setActive({active:true,id:draft.id,state:'preparing'});return fx.controller.snapshot()};
  await fx.invoke('chat:record',{id:a.id},fx.windows.main);const draftId=fx.chatCapture.owners.get(a.id);
  const valid=fx.store.addSegment(draftId,{id:'prior-speech',bytes:Buffer.from('synthetic prior voice'),transcript:'此前有效原文'}),failed=fx.store.addSegment(draftId,{id:'failed-speech',bytes:Buffer.from('synthetic failed voice')});
  fx.chats.update(a.id,{input:'独立保留的输入',candidate:'此前候选',quotes:[{id:'kept-reference',text:'此前引用'}]});const before=fx.chats.get(a.id);
  fx.chatCapture.recordings.delete(a.id);fx.chatCapture.retryJobs.set(a.id,{segmentIds:[failed.id],details:{intent:'candidate',token:'failed-token',draftId}});fx.chatCapture.voice(a.id,'error','合成转写失败',{intent:'candidate',token:'failed-token',draftId});fx.setActive({active:true,id:draftId,state:'paused'});
  current=b.id;fx.windows.main.hide();fx.beforeQuit({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(fx.flags().shutdownStarted,false);assert.equal(fx.flags().quitApprovalPending,false);assert.equal(fx.windows.main.isVisible(),true);assert.ok(fx.events.some(event=>event.window==='main'&&event.type==='chatOpen'&&event.id===a.id));
  assert.equal(fx.chatCapture.owners.get(a.id),draftId);assert.equal(fx.chatCapture.retryJobs.has(a.id),true);assert.equal(fx.store.getDraft(draftId).segments.length,2);assert.ok(fs.existsSync(valid.path));assert.ok(fs.existsSync(failed.path));assert.deepEqual(fx.chats.get(a.id),before);assert.ok(fx.events.some(event=>event.type==='error'&&/录音尚未完成转写/u.test(event.message)));assert.equal(fx.calls.length,0);
});

test('switching floats with cancel never loads the new chat and preserves both old materials and a separate external capture',async t=>{
  const fx=fixture(t,{floatingVisible:true,closeChoice:'cancel'}),{chat,draft}=fx.ownedChat(),next=fx.chats.create();fx.chats.update(chat.id,{input:'旧聊天草稿'});await assert.rejects(()=>fx.invoke('chat:openFloating',{id:'already-deleted'}),/不存在/u);assert.equal(fx.windowScripts.some(item=>item.script.includes('confirmClose')),false);const result=await fx.invoke('chat:openFloating',{id:next.id});assert.equal(result.cancelled,true);assert.equal(fx.floating(),chat.id);assert.ok(fx.store.getDraft(draft.id));assert.ok(fx.chats.get(chat.id));assert.equal(fx.windowActions.includes('floating:load'),false);
  const external=fixture(t,{floatingVisible:true,closeChoice:'cancel'}),old=external.chats.create(),newDraft=external.store.createDraft({notes:'外部新capture不能丢'});external.chats.update(old.id,{input:'旧临时输入'});external.setFloating(old.id);external.setActive({active:true,id:newDraft.id,state:'paused'});const cancelled=await external.invoke('chat:openFloating');assert.equal(cancelled.cancelled,true);assert.ok(external.store.getDraft(newDraft.id));assert.equal(external.controller.snapshot().id,newDraft.id);assert.equal(external.chatCapture.owners.size,0);assert.equal(external.windowActions.includes('floating:load'),false);
});

test('switching floats with save keeps old history before loading the new requested id',async t=>{
  const fx=fixture(t,{floatingVisible:true,closeChoice:'save'}),{chat,draft}=fx.ownedChat(),next=fx.chats.create();fx.chats.update(chat.id,{input:'旧聊天输入',candidate:'旧候选'});await fx.invoke('chat:openFloating',{id:next.id});assert.equal(fx.chats.get(chat.id).saved,true);assert.equal(fx.chats.get(chat.id).candidate,'旧候选');assert.equal(fx.chats.get(chat.id).input,'旧聊天输入');assert.equal(fx.store.getDraft(draft.id),null);assert.equal(fx.floating(),next.id);assert.ok(fx.windowActions.includes('floating:load'));assert.equal(fx.windows.floating.isVisible(),true);assert.ok(fs.existsSync(path.join(fx.root,'chats',chat.id+'.json')));
});

test('switching floats with discard removes only the old temporary chat and owned draft',async t=>{
  const fx=fixture(t,{floatingVisible:true,closeChoice:'discard'}),{chat,draft}=fx.ownedChat(),next=fx.chats.create(),unrelated=fx.store.createDraft({notes:'保留其他材料'});await fx.invoke('chat:openFloating',{id:next.id});assert.equal(fx.chats.get(chat.id),null);assert.equal(fx.store.getDraft(draft.id),null);assert.ok(fx.store.getDraft(unrelated.id));assert.ok(fx.chats.get(next.id));assert.equal(fx.floating(),next.id);assert.equal(fx.windows.floating.isVisible(),true);
});

test('a transfer for an already noncurrent chat cannot hide or cancel the current floating chat',async t=>{
  const fx=fixture(t,{floatingVisible:true}),a=fx.chats.create(),b=fx.chats.create();fx.chats.update(b.id,{input:'当前B的材料'});fx.setFloating(b.id);const before=fx.chats.get(b.id);
  await fx.invoke('chat:showMain',{id:a.id});assert.equal(fx.chats.get(a.id).saved,true);assert.equal(fx.floating(),b.id);assert.equal(fx.windows.floating.isVisible(),true);assert.deepEqual(fx.chats.get(b.id),before);assert.equal(fx.windowActions.includes('floating:hide'),false);assert.equal(fx.windowScripts.some(item=>item.window==='floating'&&item.script.includes('cancel()')),false);
});

test('a transfer that finishes after preparation or screenshot cancellation cannot affect a replacement float',async t=>{
  for(const phase of ['prepare','screenshot'])await t.test(phase,async sub=>{
    const waiting=deferred(),release=deferred();let a;const fx=fixture(sub,{floatingVisible:true,closeChoice:'save',windowCallbacks:{async executeJavaScript(name,script){if(phase==='prepare'&&name==='floating'&&script.includes('prepareForClose')){waiting.resolve();await release.promise;return true;}}}});a=fx.chats.create();const b=fx.chats.create();fx.chats.update(a.id,{input:'旧A的转主材料'});fx.chats.update(b.id,{input:'新B不得受迟到A影响'});fx.setFloating(a.id);
    if(phase==='screenshot')fx.screenshot.cancelChat=async id=>{if(id===a.id){waiting.resolve();await release.promise;}};
    const transfer=fx.invoke('chat:showMain',{id:a.id});await waiting.promise;
    if(phase==='prepare')await fx.invoke('chat:openFloating',{id:b.id});else fx.setFloating(b.id); // Synthetic completion of a new window owner while the old cleanup waits.
    const before=fx.chats.get(b.id),actionIndex=fx.windowActions.length,scriptIndex=fx.windowScripts.length;release.resolve();await transfer;
    assert.equal(fx.chats.get(a.id).saved,true);assert.equal(fx.floating(),b.id);assert.equal(fx.windows.floating.isVisible(),true);assert.deepEqual(fx.chats.get(b.id),before);assert.equal(fx.windowActions.slice(actionIndex).includes('floating:hide'),false);assert.equal(fx.windowScripts.slice(scriptIndex).some(item=>item.window==='floating'&&item.script.includes('cancel()')),false);assert.ok(fx.events.some(event=>event.window==='main'&&event.type==='chatOpen'&&event.id===a.id));
  });
});

test('chat quote attachment IPC creates, edits, removes and sends cards without inserting reference markup into input',async t=>{
  const fx=fixture(t),chat=await fx.invoke('chat:create',{quotes:[{id:'initial',text:'> 【 初始引用 】'}],selectedText:'> (外部选中内容)'});assert.equal(chat.context.quotes[0].text,'初始引用');assert.equal(chat.context.selectedText,'外部选中内容');
  await fx.invoke('chat:update',{id:chat.id,input:'原始输入 > (原样保留)',quotes:[{id:'keep',text:'> - 保留的引用。'},{id:'remove',text:'删除的引用。'}]});await fx.invoke('chat:update',{id:chat.id,quotes:[{id:'keep',text:'保留的引用。'}],selectedText:''});
  const result=await fx.invoke('chat:send',{id:chat.id,text:''});assert.equal(result.input,'原始输入 > (原样保留)');assert.equal(result.messages[0].text,'');assert.deepEqual(JSON.parse(JSON.stringify(result.messages[0].quotes)),[{id:'keep',text:'保留的引用。'}]);assert.equal(result.context.quotes.length,0);assert.match(fx.calls[0].messages[1].text,/请解释这些引用内容/u);assert.match(fx.calls[0].messages[1].text,/保留的引用。/u);assert.equal(fx.calls[0].messages[1].text.includes('删除的引用'),false);
});

test('history rename and inactive delete update both surfaces without altering the active composer or ownership',async t=>{
  const fx=fixture(t),{chat,draft}=fx.ownedChat(),other=fx.chats.create();fx.chats.update(chat.id,{input:'当前编辑内容',candidate:'当前候选'});fx.chats.save(other.id);
  const renamed=await fx.invoke('chat:rename',{id:other.id,title:'  已改名  '});assert.equal(renamed.title,'已改名');assert.equal(renamed.saved,true);assert.equal(fx.chats.get(chat.id).input,'当前编辑内容');assert.equal(fx.chatCapture.owners.get(chat.id),draft.id);
  await fx.invoke('chat:delete',{id:other.id});assert.equal(fx.chats.get(other.id),null);assert.ok(fx.events.some(event=>event.window==='main'&&event.type==='chatDeleted'&&event.id===other.id));assert.ok(fx.events.some(event=>event.window==='floating'&&event.type==='chatDeleted'&&event.id===other.id));assert.ok(fx.chats.get(chat.id));assert.equal(fx.calls.length,0);
});

test('history delete gates stale edits, model deltas and duplicate cleanup before awaits, then closes only its own floating chat',async t=>{
  const provider=deferred(),entered=deferred();let stream;const source={hwnd:'21',pid:2121,processName:'Fixture.External'},fx=handoffFixture(t,{source,foreground:{hwnd:'42',pid:4242,processName:'electron'},chat(_messages,opts){stream=opts;entered.resolve();return provider.promise}}),{chat,draft}=fx.ownedChat({saved:true});await fx.invoke('chat:openFloating',{id:chat.id});const reply=fx.invoke('chat:send',{id:chat.id,text:'待删除的问题'});await entered.promise;
  const cleanup=deferred(),started=deferred(),release=fx.chatCapture.release.bind(fx.chatCapture);let releases=0;fx.chatCapture.release=async id=>{releases++;started.resolve();await cleanup.promise;return release(id)};
  const deleting=fx.invoke('chat:delete',{id:chat.id});await started.promise;assert.equal(fx.chats.get(chat.id),null);await assert.rejects(()=>fx.invoke('chat:update',{id:chat.id,input:'迟到改动'}),/正在删除/u);await assert.rejects(()=>fx.invoke('chat:rename',{id:chat.id,title:'迟到改名'}),/正在删除/u);const repeated=fx.invoke('chat:delete',{id:chat.id});stream.onDelta('迟到回复');provider.resolve({text:'不得恢复'});await reply;
  cleanup.resolve();await Promise.all([deleting,repeated]);assert.equal(releases,1);assert.equal(fx.chats.get(chat.id),null);assert.equal(fx.store.getDraft(draft.id),null);assert.equal(fx.windows.floating.isVisible(),false);assert.equal(fx.floating(),null);assert.ok(fx.nativeCalls.some(call=>call.method==='focusWindow'&&call.params.hwnd===source.hwnd));assert.equal(fx.events.filter(event=>event.window==='main'&&event.type==='chatDeleted'&&event.id===chat.id).length,1);
});

test('main-window voice and screenshot retain their trusted origin even when the same chat has a hidden floating id',async t=>{
  const fx=fixture(t,{mainVisible:true}),chat=fx.chats.create();fx.setFloating(chat.id);let draft;
  fx.controller.startManual=async()=>{draft=fx.store.createDraft({notes:'synthetic main voice'});fx.setActive({active:true,id:draft.id,state:'preparing'});fx.showOverlay();const session=fx.captureSessionForUI();assert.equal(session.captureOrigin,'chatVoice');assert.equal(session.captureWindow,'main');assert.equal(session.chatOwnerId,chat.id);return fx.controller.snapshot()};
  const result=await fx.invoke('chat:record',{id:chat.id},fx.windows.main);assert.equal(result.state,'preparing');assert.equal(fx.controller.snapshot().state,'preparing');assert.equal(fx.captureSessionForUI().captureWindow,'main');assert.equal(fx.windowActions.some(action=>action==='floating:load'||action==='floating:show'||action==='overlay:showInactive'),false);
  await fx.invoke('draft:startManual');assert.equal(fx.windows.main.isVisible(),true);assert.equal(fx.windowActions.some(action=>action==='floating:load'||action==='floating:show'),false);
  fx.setActive({active:true,id:draft.id,state:'recording'});await fx.pauseMainChatRecording();assert.equal(fx.controller.snapshot().state,'paused');fx.controller.continueRecording=()=>{fx.setActive({active:true,id:draft.id,state:'recording'});fx.showOverlay();return fx.controller.snapshot()};await fx.invoke('chat:record',{id:chat.id},fx.windows.main);assert.equal(fx.captureSessionForUI().captureWindow,'main');assert.equal(fx.controller.snapshot().state,'recording');
  const helper=syntheticScreenshot(fx),pending=fx.invoke('chat:screenshot',{id:chat.id},fx.windows.main),init=await helper.init();assert.equal(fx.screenshot.job.options.origin,fx.windows.main);assert.equal(fx.windows.main.isVisible(),false);assert.equal(fx.windows.floating.isVisible(),false);await fx.screenshot.invoke(init.event,'screenshot:cancel',{token:init.token});await pending;assert.equal(fx.windows.main.isVisible(),true);assert.equal(fx.windows.floating.isVisible(),false);assert.equal(fx.chats.get(chat.id).id,chat.id);assert.equal(fx.calls.length,0);
  await fx.invoke('chat:close',{id:chat.id});const ordinary=fx.store.createDraft({notes:'普通灵感'});fx.setActive({active:true,id:ordinary.id,state:'paused'});assert.equal(fx.captureSessionForUI().captureOrigin,undefined);
});

test('starting voice in a new main chat releases only the previous completed chat audio and preserves its messages and draft',async t=>{
  const fx=fixture(t,{mainVisible:true}),a=fx.chats.create(),b=fx.chats.create();let sequence=0;
  fx.controller.startManual=async()=>{const draft=fx.store.createDraft({id:'voice-switch-'+(++sequence)});fx.setActive({active:true,id:draft.id,state:'preparing'});return fx.controller.snapshot()};
  await fx.invoke('chat:record',{id:a.id},fx.windows.main);const prior=fx.chatCapture.owners.get(a.id);fx.store.addSegment(prior,{id:'completed-audio',bytes:Buffer.from('synthetic completed voice'),transcript:'已转写原文'});fx.chatCapture.recordings.delete(a.id);fx.setActive({active:true,id:prior,state:'paused'});
  await fx.invoke('chat:send',{id:a.id,text:'已经发出的消息'});fx.chats.rename(a.id,'保留的会话');fx.chats.update(a.id,{input:'未发送的后续输入',candidate:'尚未采用的候选',images:[{id:'still-image',mimeType:'image/png',base64:Buffer.from('synthetic pixels').toString('base64')}]});const before=fx.chats.get(a.id);
  await fx.invoke('chat:record',{id:b.id},fx.windows.main);const after=fx.chats.get(a.id);for(const key of ['title','input','candidate','messages'])assert.deepEqual(after[key],before[key]);assert.deepEqual(after.context.images,before.context.images);assert.equal(after.context.audioDraftId,null);assert.equal(fx.store.getDraft(prior),null);assert.equal(fx.chatCapture.owners.has(a.id),false);assert.equal(fx.chatCapture.owners.get(b.id),'voice-switch-2');assert.equal(fx.captureSessionForUI().captureWindow,'main');assert.equal(fx.windowActions.some(action=>action==='floating:load'||action==='floating:show'),false);assert.equal(fx.calls.length,1);
});

test('switching main voice never discards a pending recognizer or an ordinary inspiration draft',async t=>{
  const fx=fixture(t,{mainVisible:true}),a=fx.chats.create(),b=fx.chats.create();fx.controller.startManual=async()=>{const draft=fx.store.createDraft();fx.setActive({active:true,id:draft.id,state:'preparing'});return fx.controller.snapshot()};await fx.invoke('chat:record',{id:a.id},fx.windows.main);const prior=fx.chatCapture.owners.get(a.id);fx.chatCapture.recordings.delete(a.id);fx.setActive({active:true,id:prior,state:'paused'});
  const asr=deferred();fx.chatCapture.jobs.set(a.id,{abort:new AbortController(),promise:asr.promise});await assert.rejects(()=>fx.invoke('chat:record',{id:b.id},fx.windows.main),/请先完成当前录音/u);assert.ok(fx.store.getDraft(prior));assert.equal(fx.chatCapture.owners.get(a.id),prior);fx.chatCapture.jobs.delete(a.id);asr.resolve();
  fx.chatCapture.retryJobs.set(a.id,{segmentIds:['failed-asr']});await assert.rejects(()=>fx.invoke('chat:record',{id:b.id},fx.windows.main),/请先完成当前录音/u);assert.ok(fx.store.getDraft(prior));fx.chatCapture.retryJobs.delete(a.id);
  const ordinary=fixture(t,{mainVisible:true}),owner=ordinary.ownedChat(),target=ordinary.chats.create();await assert.rejects(()=>ordinary.invoke('chat:record',{id:target.id},ordinary.windows.main),/请先完成当前录音/u);assert.ok(ordinary.store.getDraft(owner.draft.id));assert.equal(ordinary.chatCapture.owners.get(owner.chat.id),owner.draft.id);
});
function syntheticScreenshot(fx){
  const ready=deferred(),png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=';
  let editor;
  const regionPng='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGPgEVXhEVVhgFAABzoBFTFqH3MAAAAASUVORK5CYII=';
  fx.screenshot.capture=async job=>({image:job.purpose==='region'?{dataUrl:regionPng,width:2,height:2}:{dataUrl:png,width:1,height:1},display:{bounds:{x:0,y:0,width:600,height:400},scaleFactor:1}});fx.screenshot.decode=dataUrl=>dataUrl;
  fx.screenshot.createEditor=()=>{editor=new EventEmitter();let gone=false;editor.webContents=new EventEmitter();editor.webContents.mainFrame={};Object.assign(editor,{isDestroyed:()=>gone,show(){},focus(){},destroy(){gone=true;editor.emit('closed')}});ready.resolve();return editor};fx.screenshot.loadEditor=async()=>{};
  return{png,async init(){await ready.promise;const event={sender:editor.webContents,senderFrame:editor.webContents.mainFrame};return{event,...await fx.screenshot.invoke(event,'screenshot:init')}}};
}

test('shortcut requests foreground context, starts recording on selection, and later attaches the confirmed image', async t => {
  const foreground = { hwnd: '21', pid: 2121, processName: 'chrome', title: '合成网页' };
  const fx = fixture(t, { foreground });
  const helper = syntheticScreenshot(fx);
  let recordingCount = 0;
  fx.controller.startRegion = (source, sourceContext) => {
    recordingCount++;
    assert.deepEqual({ ...source }, foreground);
    assert.ok(sourceContext);
    assert.equal(fx.controller.disableGlobalInput, true);
    assert.ok(fx.screenshot.job.image);
    fx.setActive({ id: 'region-draft', active: true, state: 'recording', regionScreenshotOpen: true });
    return fx.controller.snapshot();
  };
  let saved = false;
  fx.controller.saveRegionScreenshot = (id, image) => {
    assert.equal(id, 'region-draft');
    assert.equal(image.bytes.toString('base64'), helper.png.slice(22));
    assert.ok(Number.isFinite(image.capturedAt));
    saved = true;
  };
  fx.setActive({ id: 'previous-draft', active: true, state: 'paused' });
  await assert.rejects(() => fx.takeRegionScreenshot(), /当前录音/u);
  fx.setActive({ id: null, active: false, state: 'idle' });
  const result = fx.takeRegionScreenshot(), init = await helper.init();
  assert.equal(init.purpose, 'region');
  assert.equal(recordingCount, 0);
  await assert.rejects(() => fx.invoke('draft:startManual'), /先完成或取消截图/u);
  assert.equal(await fx.takeRegionScreenshot(), undefined);
  assert.ok(fx.nativeCalls.some(call => call.method === 'readContext' && call.params.hwnd === foreground.hwnd));
  await fx.screenshot.invoke(init.event, 'screenshot:record', { token: init.token, rect: { x:0, y:0, width:2, height:2 } });
  assert.equal(fx.controller.snapshot().state, 'recording');
  assert.equal(saved, false);
  await fx.invoke('draft:pause');
  assert.equal(fx.controller.snapshot().state, 'paused');
  assert.equal(fx.screenshot.busy, true);
  assert.equal(saved, false);
  await fx.screenshot.invoke(init.event, 'screenshot:confirm', { token: init.token, dataUrl: helper.png });
  assert.equal((await result).id, 'region-draft');
  assert.equal(saved, true);
  assert.deepEqual(fx.clipboardImages, [helper.png]);
  assert.equal(fx.controller.snapshot().state, 'paused');
  assert.equal(fx.controller.snapshot().regionScreenshotOpen, false);
  assert.deepEqual(fx.events.filter(event => event.type === 'regionScreenshotFinished'), [{ type: 'regionScreenshotFinished', id: 'region-draft' }]);
  assert.ok(fx.windowActions.includes('overlay:showInactive'));
  assert.equal(recordingCount, 1);
  assert.equal(fx.controller.disableGlobalInput, undefined);
  assert.equal(fx.calls.length, 0);
});

test('cancelling an editor during recording startup closes the screenshot once the draft is ready', async t => {
  const fx = fixture(t);
  const helper = syntheticScreenshot(fx);
  const started = deferred();
  fx.controller.startRegion = () => started.promise.then(() => {
    fx.setActive({ id: 'region-draft', active: true, state: 'recording', regionScreenshotOpen: true });
    return fx.controller.snapshot();
  });
  const result = fx.takeRegionScreenshot(), init = await helper.init();
  const starting = fx.screenshot.invoke(init.event, 'screenshot:record', { token: init.token, rect: { x: 0, y: 0, width: 2, height: 2 } });
  const cancelling = fx.screenshot.invoke(init.event, 'screenshot:cancel', { token: init.token });
  assert.equal(fx.events.some(event => event.type === 'regionScreenshotFinished'), false);
  started.resolve();
  await starting;
  await cancelling;
  assert.equal((await result).cancelled, true);
  assert.equal(fx.controller.snapshot().state, 'recording');
  assert.equal(fx.controller.snapshot().regionScreenshotOpen, false);
  assert.deepEqual(fx.events.filter(event => event.type === 'regionScreenshotFinished'), [{ type: 'regionScreenshotFinished', id: 'region-draft' }]);
  assert.ok(fx.windowActions.includes('overlay:showInactive'));
  assert.deepEqual(fx.clipboardImages, []);
});

test('mixed-DPI capture keeps the monitor selected at the shortcut and resolves its matching source by ID', async t => {
  const monitors = [
    { id: 13, bounds: { x: -1600, y: -180, width: 1600, height: 900 }, size: { width: 1600, height: 900 }, scaleFactor: 1 },
    { id: 71, bounds: { x: 0, y: 0, width: 1280, height: 800 }, size: { width: 1280, height: 800 }, scaleFactor: 1.5 },
  ];
  for (const [index, monitor] of monitors.entries()) {
    let point = { x: monitor.bounds.x + 50, y: monitor.bounds.y + 60 };
    let sourceRead = null;
    let optionsRead;
    const fx = fixture(t, {
      screen: { getCursorScreenPoint: () => point, getDisplayNearestPoint: cursor => monitors[cursor.x < 0 ? 0 : 1] },
      desktopCapturer: { async getSources(options) {
        optionsRead = options;
        return monitors.toReversed().map(({ id }) => ({ display_id: String(id), thumbnail: {
          isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toDataURL() { sourceRead = id; return helper.png; },
        } }));
      } },
    });
    const productionCapture = fx.screenshot.capture;
    const helper = syntheticScreenshot(fx);
    fx.screenshot.capture = productionCapture;
    const result = fx.takeRegionScreenshot();
    point = { x: index === 0 ? 50 : -50, y: 50 };
    const init = await helper.init();
    assert.equal(sourceRead, monitor.id);
    assert.deepEqual({ ...init.display.bounds }, monitor.bounds);
    assert.equal(init.display.scaleFactor, monitor.scaleFactor);
    assert.deepEqual({ ...optionsRead.thumbnailSize }, { width: monitor.size.width * monitor.scaleFactor, height: monitor.size.height * monitor.scaleFactor });
    await fx.screenshot.invoke(init.event, 'screenshot:cancel', { token: init.token });
    assert.equal((await result).cancelled, true);
    assert.equal(fx.store.listDrafts().length, 0);
  }
});

test('screenshot IPC pauses owned input, hides then restores the same chat without cleanup, reload or send',async t=>{
  const fx=handoffFixture(t),{chat,draft}=fx.ownedChat();await fx.invoke('chat:openFloating',{id:chat.id});fx.chats.update(chat.id,{input:'截图前的输入'});fx.controller.disableGlobalInput=false;
  fx.setActive({active:true,id:draft.id,state:'recording'});fx.chatCapture.recordings.set(chat.id,{token:'owned-input',draftId:draft.id});const stopped=[];fx.chatCapture.stopRecording=async(id,token)=>{stopped.push([id,token]);return{state:'transcribing'}};
  const helper=syntheticScreenshot(fx),loads=fx.windowActions.filter(x=>x==='floating:load').length,result=fx.invoke('chat:screenshot',{id:chat.id}),init=await helper.init();
  assert.equal(fx.controller.disableGlobalInput,true);assert.equal(fx.windows.floating.isVisible(),false);assert.deepEqual(stopped,[[chat.id,'owned-input']]);
  await assert.rejects(()=>fx.invoke('chat:openFloating',{id:chat.id}),/完成或取消截图/u);await assert.rejects(()=>fx.invoke('chat:record',{id:chat.id}),/完成或取消截图/u);
  fx.chats.update(chat.id,{input:'截图编辑期间的新输入'});await fx.screenshot.invoke(init.event,'screenshot:confirm',{token:init.token,dataUrl:helper.png});const value=await result;
  assert.deepEqual(fx.clipboardImages, [helper.png]);
  assert.equal(value.chat.id,chat.id);assert.equal(value.chat.input,'截图编辑期间的新输入');assert.equal(value.chat.context.images.length,1);assert.equal(fx.windows.floating.isVisible(),true);assert.equal(fx.controller.disableGlobalInput,false);assert.equal(fx.chatCapture.owners.get(chat.id),draft.id);assert.ok(fx.store.getDraft(draft.id));assert.equal(fx.windowActions.filter(x=>x==='floating:load').length,loads);assert.equal(fx.calls.length,0);
});

test('screenshot keep-visible default comes from local settings; explicit close cannot be undone by editor completion',async t=>{
  const fx=handoffFixture(t,{settings:{screenshotKeepChatVisible:true}}),{chat}=fx.ownedChat();await fx.invoke('chat:openFloating',{id:chat.id});fx.controller.disableGlobalInput=true;
  const helper=syntheticScreenshot(fx),result=fx.invoke('chat:screenshot',{id:chat.id}),init=await helper.init();assert.equal(fx.windows.floating.isVisible(),true);assert.equal(fx.screenshot.job.options.keepChatVisible,true);
  await fx.invoke('chat:close',{id:chat.id});assert.deepEqual({...await result},{cancelled:true});assert.equal(fx.controller.disableGlobalInput,true);assert.equal(fx.windows.floating.isVisible(),false);assert.equal(fx.chats.get(chat.id),null);
  await assert.rejects(()=>fx.screenshot.invoke(init.event,'screenshot:confirm',{token:init.token,dataUrl:helper.png}),/失效/u);assert.equal(fx.calls.length,0);
});
const capsuleSurface={x:9,y:29,width:233,height:48,viewport:{width:400,height:440},visual:{paths:[],heights:[3,3],timer:'00:12'}};
function handoffFixture(t,{load,prepare,enter,...options}={}){
  return fixture(t,{...options,overlayVisible:true,windowBounds:{overlay:{x:200,y:200,width:400,height:440}},windowCallbacks:{
    async loadFile(name){if(name==='floating'&&load){load.started.resolve();await load.release.promise;}},
    async executeJavaScript(name,script){
      if(name==='overlay')return capsuleSurface;
      if(script.includes('prepare(')){if(prepare){prepare.started.resolve();await prepare.release.promise;}return{origin:{x:0,y:217,width:233,height:48}};}
      if(script.includes('enter()')&&enter){enter.started.resolve();await enter.release.promise;}
    }
  }});
}
const transitionGate=()=>({started:deferred(),release:deferred()});

test('closing the focused floating chat restores its trusted source and rearms after hide without another click',async t=>{
  const source={hwnd:'21',pid:2121,processName:'Fixture.External'},fx=handoffFixture(t,{source,foreground:{hwnd:'42',pid:4242,processName:'electron'}}),{chat,draft}=fx.ownedChat();
  await fx.invoke('chat:openFloating',{id:chat.id});
  await fx.invoke('chat:close',{id:chat.id,source:{hwnd:'999',pid:999,processName:'Untrusted.Renderer'}});
  assert.equal(fx.store.getDraft(draft.id),null);assert.equal(fx.windows.floating.isVisible(),false);assert.equal(fx.controller.snapshot().active,false);
  const focus=fx.nativeCalls.find(call=>call.method==='focusWindow');assert.deepEqual({...focus.params},source);
  const rearmed=fx.nativeCalls.at(-1);assert.equal(rearmed.method,'refreshTrigger');assert.equal(rearmed.foreground.hwnd,source.hwnd);
  assert.ok(fx.windowActions.indexOf('floating:blur')<fx.windowActions.lastIndexOf('floating:hide'));
  assert.equal(fx.calls.length,0);
});

test('a user foreground switch while audio cleanup waits is respected when closing chat',async t=>{
  const fx=handoffFixture(t,{source:{hwnd:'21',pid:2121,processName:'Fixture.External'},foreground:{hwnd:'42',pid:4242,processName:'electron'}}),{chat}=fx.ownedChat();
  await fx.invoke('chat:openFloating',{id:chat.id});
  const gate=transitionGate(),discard=fx.controller.discard.bind(fx.controller);fx.controller.discard=async()=>{gate.started.resolve();await gate.release.promise;return discard()};
  const closing=fx.invoke('chat:close',{id:chat.id});await gate.started.promise;fx.setForeground({hwnd:'61',pid:6161,processName:'New.Foreground'});gate.release.resolve();await closing;
  assert.equal(fx.nativeCalls.some(call=>call.method==='focusWindow'),false);assert.equal(fx.nativeCalls.at(-1).foreground.hwnd,'61');assert.equal(fx.windows.floating.isVisible(),false);
});

test('chat meter relay accepts backend ownership decisions and never forwards PCM or extra source fields',async t=>{
  const fx=fixture(t);let valid=true;fx.chatCapture.chatAudioLevel=()=>valid?{id:'chat',token:'attempt',draftId:'draft',segmentId:'segment',level:.4,peak:.7,pcm:'not-forwarded',source:'not-forwarded'}:null;
  fx.sendChatAudioLevel({});const events=fx.events.filter(event=>event.type==='chatAudioLevel');assert.deepEqual(events.map(event=>event.window),['main','floating']);
  for(const event of events){assert.equal(event.level,.4);assert.equal(event.token,'attempt');assert.equal(event.pcm,undefined);assert.equal(event.source,undefined)}
  valid=false;fx.sendChatAudioLevel({});assert.equal(fx.events.filter(event=>event.type==='chatAudioLevel').length,2);
});

test('voice stop and cancel pass the current attempt token without toggling a new recording',async t=>{
  const fx=fixture(t),chat=await fx.invoke('chat:create'),called=[];
  fx.chatCapture.record=()=>{throw new Error('Stop/cancel must never start recording')};
  fx.chatCapture.stopRecording=async(id,token)=>{called.push(['stop',id,token]);return{state:'transcribing'}};
  fx.chatCapture.cancelRecording=async(id,token)=>{called.push(['cancel',id,token]);return{state:'cancelled'}};
  fx.chatCapture.retry=async id=>{called.push(['retry',id]);return{state:'transcribing'}};
  await fx.invoke('chat:voiceStop',{id:chat.id,token:'current-attempt'});await fx.invoke('chat:voiceCancel',{id:chat.id,token:'current-attempt'});await fx.invoke('chat:voiceRetry',{id:chat.id});
  assert.deepEqual(called,[['stop',chat.id,'current-attempt'],['cancel',chat.id,'current-attempt'],['retry',chat.id]]);assert.equal(fx.calls.length,0);
});

for(const saved of [false,true])test(`hidden and minimized ${saved?'saved':'temporary'} owned chat is restored without reloading or discarding its capture`,async t=>{
  const fx=handoffFixture(t),{chat,draft}=fx.ownedChat({saved});fx.store.addSegment(draft.id,{id:'prior-audio',bytes:Buffer.from('synthetic owned audio'),transcript:'此前的文字',durationMs:100});fx.chats.update(chat.id,{input:'尚未发送的输入'});
  await fx.invoke('chat:openFloating',{id:chat.id});const loads=fx.windowActions.filter(value=>value==='floating:load').length;
  fx.windows.floating.hide();await fx.invoke('chat:openFloating',{id:chat.id});assert.equal(fx.windows.floating.isVisible(),true);
  fx.windows.floating.minimize();fx.controller.startManual=()=>{throw Error('Recovery must not create a recording')};await fx.invoke('draft:startManual');
  assert.equal(fx.windows.floating.isMinimized(),false);assert.equal(fx.windowActions.filter(value=>value==='floating:load').length,loads);assert.equal(fx.chatCapture.owners.get(chat.id),draft.id);assert.equal(fx.store.getDraft(draft.id).segments.length,1);assert.equal(fx.chats.get(chat.id).input,'尚未发送的输入');assert.equal(fx.captureSessionForUI().chatOwnerId,chat.id);assert.equal(fx.store.listDrafts().length,1);assert.equal(fx.calls.length,0);
});

test('hiding a floating input recording pauses through its attempt token while preserving ownership and text',async t=>{
  const fx=handoffFixture(t),{chat,draft}=fx.ownedChat();await fx.invoke('chat:openFloating',{id:chat.id});fx.chats.update(chat.id,{input:'保留输入',candidate:'保留候选'});fx.setActive({active:true,id:draft.id,state:'recording',segmentId:'synthetic-segment'});
  fx.chatCapture.recordings.set(chat.id,{token:'input-attempt',draftId:draft.id});const stops=[];fx.chatCapture.stopRecording=async(id,token)=>{stops.push({id,token});return{state:'transcribing'}};
  fx.windows.floating.hide();await fx.pauseFloatingRecording();assert.deepEqual(stops,[{id:chat.id,token:'input-attempt'}]);assert.equal(fx.controller.snapshot().state,'paused');assert.equal(fx.chatCapture.owners.get(chat.id),draft.id);assert.ok(fx.store.getDraft(draft.id));assert.equal(fx.chats.get(chat.id).input,'保留输入');assert.equal(fx.chats.get(chat.id).candidate,'保留候选');
});

test('intentional transfer to main is not mistaken for lost-window history recovery',async t=>{
  const fx=handoffFixture(t),{chat,draft}=fx.ownedChat();await fx.invoke('chat:openFloating',{id:chat.id});fx.windows.floating.hide();assert.equal(fx.shouldRecoverOwnedChat(chat.id),true);
  await fx.invoke('chat:showMain',{id:chat.id});assert.equal(fx.shouldRecoverOwnedChat(chat.id),false);assert.equal(fx.floating(),null);assert.equal(fx.chatCapture.owners.get(chat.id),draft.id);assert.ok(fx.chats.get(chat.id));
});

test('ownership assigned after a startup blur cannot leave the hidden input microphone running',async t=>{
  const fx=fixture(t,{floatingVisible:true}),chat=await fx.invoke('chat:create');fx.setFloating(chat.id);let began,resume,draft;const ready=new Promise(resolve=>{began=resolve});
  fx.controller.startManual=async()=>{draft=fx.store.createDraft({notes:'synthetic startup'});fx.setActive({active:true,id:draft.id,state:'preparing'});began();await new Promise(resolve=>{resume=resolve});return fx.controller.snapshot()};
  const starting=fx.invoke('chat:record',{id:chat.id});await ready;fx.windows.floating.setFocused(false);await fx.pauseFloatingRecording();resume();await starting;
  assert.equal(fx.controller.snapshot().state,'paused');assert.equal(fx.chatCapture.owners.get(chat.id),draft.id);assert.ok(fx.store.getDraft(draft.id));assert.equal(fx.calls.length,0);
});

test('a false native focus result that is restored by hide produces no persistent or transient error',async t=>{
  const source={hwnd:'21',pid:2121,processName:'Fixture.External'},fx=handoffFixture(t,{source,foreground:{hwnd:'42',pid:4242,processName:'electron'},focusDenied:true,restoreOnHide:true}),{chat}=fx.ownedChat();await fx.invoke('chat:openFloating',{id:chat.id});await fx.invoke('chat:close',{id:chat.id});
  assert.equal(fx.events.some(event=>event.type==='error'||event.type==='sourceFocusNotice'),false);
});

for(const reason of ['FOREGROUND_DENIED','WINDOW_UNAVAILABLE'])test(`real ${reason} is a specific quiet transient notice after close`,async t=>{
  const source={hwnd:'21',pid:2121,processName:'Fixture.External'},fx=handoffFixture(t,{source,foreground:{hwnd:'42',pid:4242,processName:'electron'},focusDenied:reason==='FOREGROUND_DENIED',focusError:reason==='WINDOW_UNAVAILABLE'?reason:null}),{chat}=fx.ownedChat();await fx.invoke('chat:openFloating',{id:chat.id});await fx.invoke('chat:close',{id:chat.id});
  const notice=fx.events.find(event=>event.type==='sourceFocusNotice');assert.equal(notice.reason,reason);assert.equal(notice.durationMs,5000);assert.match(notice.message,reason==='WINDOW_UNAVAILABLE'?/关闭或发生变化/u:/系统未允许/u);assert.equal(fx.events.some(event=>event.type==='error'),false);assert.equal(fx.windows.floating.isVisible(),false);
});

test('floating handoff uses the actual capsule origin, preserves overlay until prepared and defers input growth through entry',{timeout:3000},async t=>{
  const load=transitionGate(),prepare=transitionGate(),enter=transitionGate(),fx=handoffFixture(t,{load,prepare,enter}),{chat}=fx.ownedChat();
  const opening=fx.invoke('chat:openFloating',{id:chat.id});await load.started.promise;
  assert.equal(fx.windows.overlay.isVisible(),true);assert.equal(fx.windows.floating.isVisible(),false);
  load.release.resolve();await prepare.started.promise;assert.equal(fx.windows.overlay.isVisible(),true);assert.ok(!fx.windowActions.includes('overlay:hide'));
  const script=fx.windowScripts.find(value=>value.window==='floating'&&value.script.includes('prepare(')).script,payload=JSON.parse(script.match(/prepare\((.*)\)$/u)[1]);
  assert.deepEqual({x:payload.source.x,y:payload.source.y,width:payload.source.width,height:payload.source.height},{x:209,y:229,width:233,height:48});
  assert.equal(payload.window.x+12,209);assert.ok(payload.window.y<=229&&payload.window.y+payload.window.height>=277);
  prepare.release.resolve();await enter.started.promise;assert.equal(fx.windows.overlay.isVisible(),false);assert.equal(fx.windows.floating.isVisible(),true);
  const before=fx.windows.floating.getBounds(),writes=fx.windowActions.filter(value=>value==='floating:resize').length;
  assert.equal((await fx.invoke('chat:resize',{id:chat.id,height:800})).changed,false);assert.deepEqual(fx.windows.floating.getBounds(),before);assert.equal(fx.windowActions.filter(value=>value==='floating:resize').length,writes);
  enter.release.resolve();await opening;assert.ok(fx.windowScripts.some(value=>value.script.includes('layout()')));assert.equal((await fx.invoke('chat:resize',{id:chat.id,height:800})).changed,true);assert.equal(fx.calls.length,0);
});

test('closing a temporary chat during native load prevents a late show and cleans only its owned draft',{timeout:3000},async t=>{
  const load=transitionGate(),fx=handoffFixture(t,{load}),{chat,draft}=fx.ownedChat(),unrelated=fx.store.createDraft({notes:'其他草稿'});
  const opening=fx.invoke('chat:openFloating',{id:chat.id});await load.started.promise;await fx.invoke('chat:close',{id:chat.id});load.release.resolve();await opening;
  assert.equal(fx.chats.get(chat.id),null);assert.equal(fx.store.getDraft(draft.id),null);assert.ok(fx.store.getDraft(unrelated.id));assert.equal(fx.floating(),null);assert.equal(fx.windows.floating.isVisible(),false);assert.ok(!fx.windowActions.includes('floating:showInactive'));assert.equal(fx.calls.length,0);
});

test('closing while renderer preparation waits never reveals the closed chat or retains its provisional recording',{timeout:3000},async t=>{
  const prepare=transitionGate(),fx=handoffFixture(t,{prepare}),{chat,draft}=fx.ownedChat();const opening=fx.invoke('chat:openFloating',{id:chat.id});await prepare.started.promise;
  assert.equal(fx.windows.overlay.isVisible(),true);
  await fx.invoke('chat:close',{id:chat.id});prepare.release.resolve();await opening;
  assert.equal(fx.chats.get(chat.id),null);assert.equal(fx.store.getDraft(draft.id),null);assert.ok(!fx.windowActions.includes('floating:showInactive'));assert.equal(fx.windows.floating.isVisible(),false);assert.equal(fx.calls.length,0);
});

test('transferring to main during renderer preparation preserves the session and provisional recording',{timeout:3000},async t=>{
  const prepare=transitionGate(),fx=handoffFixture(t,{prepare}),{chat,draft}=fx.ownedChat();const opening=fx.invoke('chat:openFloating',{id:chat.id});await prepare.started.promise;
  await fx.invoke('chat:showMain',{id:chat.id,settings:true});prepare.release.resolve();await opening;
  assert.ok(fx.chats.get(chat.id));assert.ok(fx.store.getDraft(draft.id));assert.equal(fx.chatCapture.owners.get(chat.id),draft.id);assert.equal(fx.floating(),null);assert.equal(fx.windows.floating.isVisible(),false);assert.ok(!fx.windowActions.includes('floating:showInactive'));assert.ok(fx.events.some(value=>value.window==='main'&&value.type==='chatOpen'&&value.id===chat.id&&value.settings===true));assert.equal(fx.calls.length,0);
});

test('floating chat height IPC converts zoom and bounds growth without sending input to a model', async t => {
  const fx = fixture(t, { floatingVisible: true, zoom: 1.25 }), { chat } = fx.ownedChat();
  const result = await fx.invoke('chat:resize', { id: chat.id, height: 700 });
  assert.equal(result.height, 875); assert.equal(result.changed, true); assert.equal(fx.windows.floating.getBounds().height, 875);
  assert.ok(result.y >= 12 && result.y + result.height <= 888);
  const unchanged = await fx.invoke('chat:resize', { id: chat.id, height: 100 });
  assert.equal(unchanged.changed, false); assert.equal(unchanged.height, 875);
  assert.equal(fx.calls.length, 0);
  await assert.rejects(fx.invoke('chat:resize', { id: chat.id, height: Infinity }), /高度无效/u);
  await assert.rejects(fx.invoke('chat:resize', { id: chat.id, height: '900' }), /高度无效/u);
});

test('hidden or stale chat sizing cannot show, resize or affect the current conversation', async t => {
  const fx = fixture(t), { chat } = fx.ownedChat();
  assert.equal((await fx.invoke('chat:resize', { id: chat.id, height: 2000 })).changed, false);
  assert.equal(fx.windows.floating.getBounds().height, 584);
  assert.equal((await fx.invoke('chat:resize', { id: 'stale-chat', height: 2000 })).changed, false);
  assert.equal(fx.windowActions.length, 0); assert.equal(fx.calls.length, 0);
});

test('moving a narrow chat from a small display restores its current zoom minimum once', async t => {
  const fx = fixture(t, { floatingVisible: true, minimum: [200, 300], bounds: { width: 276, height: 500 } }), { chat } = fx.ownedChat();
  const result = await fx.invoke('chat:resize', { id: chat.id, height: 750 });
  assert.equal(result.width, 384); assert.deepEqual(fx.windows.floating.getMinimumSize(), [384, 300]);
  const writes=fx.windowActions.filter(value=>value==='floating:resize').length;
  assert.equal((await fx.invoke('chat:resize',{id:chat.id,height:750})).changed,false);assert.equal(fx.windowActions.filter(value=>value==='floating:resize').length,writes);
  assert.equal(fx.calls.length, 0);
});

test('width-only sizing at200percent grows narrow native windows and preserves wider user bounds',async t=>{
  const fx=fixture(t,{floatingVisible:true,zoom:2,bounds:{x:100,y:100,width:384,height:584}}),{chat}=fx.ownedChat();
  const result=await fx.invoke('chat:resize',{id:chat.id,height:200});assert.equal(result.width,560);assert.equal(result.height,584);assert.equal(result.minimumViewportWidth,280);assert.equal(result.zoom,2);assert.equal(result.changed,true);assert.equal(fx.windows.floating.getMinimumSize()[0],560);
  const writes=fx.windowActions.filter(value=>value==='floating:resize').length;assert.equal((await fx.invoke('chat:resize',{id:chat.id,height:200})).changed,false);assert.equal(fx.windowActions.filter(value=>value==='floating:resize').length,writes);
  fx.windows.floating.setBounds({width:700});const wide=await fx.invoke('chat:resize',{id:chat.id,height:200});assert.equal(wide.width,700);assert.equal(wide.changed,false);assert.equal(fx.calls.length,0);
});

test('chat IPC network lock rejects send before appending a message or invoking even mock inference', async t => {
  const fx = fixture(t, { networkDisabled: true }), chat = await fx.invoke('chat:create');
  await assert.rejects(fx.invoke('chat:send', { id: chat.id, text: '合成问题' }), /测试模式/u);
  assert.equal(fx.calls.length, 0); assert.equal(fx.chats.get(chat.id).messages.length, 0);
});
test('chat IPC disabled cloud setting preserves input without a request', async t => {
  const fx = fixture(t, { settings: { cloudEnabled: false } }), chat = await fx.invoke('chat:create');
  await fx.invoke('chat:update', { id: chat.id, input: '仍保留的输入' });
  await assert.rejects(fx.invoke('chat:send', { id: chat.id }), /总开关/u);
  assert.equal(fx.calls.length, 0); assert.equal(fx.chats.get(chat.id).input, '仍保留的输入');
});
test('chat send IPC routes only chosen provider credentials and valid screenshot bytes', async t => {
  const fx = fixture(t); const image = { mimeType: 'image/png', base64: Buffer.from('synthetic-image').toString('base64') };
  const chat = await fx.invoke('chat:create', { images: [image], selectedText: '选中的原文' });
  const result = await fx.invoke('chat:send', { id: chat.id, text: '解释这段内容' });
  assert.equal(result.messages.at(-1).text, '模拟回复'); assert.equal(fx.calls.length, 1);
  assert.equal(fx.calls[0].config.provider, 'deepseek'); assert.equal(fx.calls[0].config.apiKey, 'fixture-chat-credential');
  assert.equal(fx.calls[0].config.allowModelOverride, false); assert.equal(fx.calls[0].config.model, 'deepseek-flash');
  assert.equal(fx.calls[0].messages.at(-1).images[0].base64, image.base64); assert.match(fx.calls[0].messages.at(-1).text, /选中的原文/u);
  await assert.rejects(fx.invoke('chat:create', { images: [{ mimeType: 'text/plain', base64: image.base64, path: 'outside-file' }] }), /图片/u);
  assert.equal(fx.calls.length, 1);
});
test('provider setting change aborts active reply and prevents late deltas updating old session', async t => {
  let entered; const ready = new Promise(resolve => { entered = resolve; }); let signal, delta;
  const fx = fixture(t, { chat(_messages, opts) { signal = opts.signal; delta = opts.onDelta; entered(); return new Promise(resolve => opts.signal.addEventListener('abort', () => resolve({ text: '失效回复' }), { once: true })); } });
  const chat = await fx.invoke('chat:create'), reply = fx.invoke('chat:send', { id: chat.id, text: '合成问题' }); await ready;
  await fx.invoke('settings:save', { aiProvider: 'openai', apiKey: 'fixture-new-provider-credential' });
  assert.equal(signal.aborted, true); delta('不应显示的旧内容'); await reply;
  assert.equal(fx.chats.get(chat.id).messages.at(-1).text, ''); assert.equal(fx.chats.get(chat.id).pending, false); assert.equal(fx.calls.length, 1);
});
test('closing a temporary chat discards owned draft and session while keeping unrelated draft', async t => {
  const fx = fixture(t), { chat, draft } = fx.ownedChat(), unrelated = fx.store.createDraft({ notes: '其他草稿' });
  await fx.invoke('chat:close', { id: chat.id });
  assert.equal(fx.chats.get(chat.id), null); assert.equal(fx.store.getDraft(draft.id), null); assert.ok(fx.store.getDraft(unrelated.id)); assert.equal(fx.floating(), null);
  assert.equal(fx.calls.length, 0);
});
test('saving a chat preserves history on close but still cleans its unsaved recording', async t => {
  const fx = fixture(t), { chat, draft } = fx.ownedChat({ saved: true });
  await fx.invoke('chat:close', { id: chat.id });
  assert.equal(fx.chats.get(chat.id).saved, true); assert.equal(fx.chats.get(chat.id).context.audioDraftId, null); assert.equal(fx.store.getDraft(draft.id), null); assert.equal(fx.store.getRecord(draft.id), null);
  assert.equal(fs.existsSync(path.join(fx.root, 'chats', chat.id + '.json')), true);
});
test('explicitly saved recording survives chat close and is separated from temporary ownership', async t => {
  const fx = fixture(t), { chat, draft } = fx.ownedChat({ savedRecording: true });
  await fx.invoke('chat:close', { id: chat.id });
  assert.ok(fx.store.getRecord(draft.id)); assert.equal(fx.chatCapture.owners.has(chat.id), false); assert.equal(fx.chats.get(chat.id), null);
});
test('moving floating chat to main keeps same session and owned draft, then allows explicit close', async t => {
  const fx = fixture(t), { chat, draft } = fx.ownedChat();
  await fx.invoke('chat:showMain', { id: chat.id });
  assert.ok(fx.chats.get(chat.id)); assert.ok(fx.store.getDraft(draft.id)); assert.equal(fx.chatCapture.owners.get(chat.id), draft.id);
  assert.ok(fx.events.some(event => event.window === 'main' && event.type === 'chatOpen' && event.id === chat.id)); assert.equal(fx.floating(), null);
  await fx.invoke('chat:close', { id: chat.id }); assert.equal(fx.store.getDraft(draft.id), null);
});
test('floating chat settings action routes to main settings while retaining current session', async t => {
  const fx = fixture(t), { chat } = fx.ownedChat();
  await fx.invoke('chat:showMain', { id: chat.id, settings: true });
  assert.ok(fx.chats.get(chat.id));
  assert.ok(fx.events.some(event => event.window === 'main' && event.type === 'chatOpen' && event.id === chat.id && event.settings === true));
});
test('automatic mode ignores legacy model field and manual selection is explicit', async t => {
  const fx = fixture(t, { settings: { model: 'legacy-model' } });
  assert.equal(fx.currentAIConfig().model, 'deepseek-flash');
  await fx.invoke('settings:save', { modelMode: 'manual', model: 'deepseek-v4-pro' });
  assert.equal(fx.currentAIConfig().model, 'deepseek-v4-pro');
  const chat = await fx.invoke('chat:create');
  await fx.invoke('chat:send', { id: chat.id, text: '使用显式手动设置' });
  assert.equal(fx.calls[0].config.model, 'deepseek-v4-pro'); assert.equal(fx.calls[0].config.allowModelOverride, true);
});
test('closing chat while manual microphone start is awaiting cannot orphan a new recording', async t => {
  const fx = fixture(t), chat = await fx.invoke('chat:create');
  let resume, began, draft; const entered = new Promise(resolve => { began = resolve; });
  fx.controller.startManual = async () => {
    draft = fx.store.createDraft({ notes: '尚未完成的合成录音启动' });
    fx.setActive({ active: true, id: draft.id, state: 'preparing' }); began();
    await new Promise(resolve => { resume = resolve; });
    return fx.controller.snapshot();
  };
  const recording = fx.invoke('chat:record', { id: chat.id });
  const settled = recording.catch(() => {});
  await entered;
  let closed = false;
  const closing = fx.invoke('chat:close', { id: chat.id }).then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  resume(); await Promise.all([closing, settled]);
  assert.equal(fx.store.getDraft(draft.id), null);
  assert.equal(fx.chatCapture.owners.has(chat.id), false);
  assert.equal(fx.controller.snapshot().active, false);
});
