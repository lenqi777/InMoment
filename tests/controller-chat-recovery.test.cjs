'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { LocalStore } = require('../src/core/store.cjs');
const { CaptureController } = require('../src/main/capture-controller.cjs');

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(__dirname, '.tmp-chat-hold-recovery-'));
  const store = new LocalStore(directory), bridge = new EventEmitter(), requests = [], commands = [], recovered = [];
  let owned = false;
  const configuration = { inputEnabled:true, thresholdMs:600, excludedApps:['PrivateEditor'], captureScreenshots:true };
  bridge.request = async (method, params) => { requests.push({method,params}); return { enabled:params.enabled, hookAvailable:true }; };
  const controller = new CaptureController({ store, bridge, settings:{public:()=>configuration},
    sendRecorder:command=>commands.push(command), showOverlay(){}, hideOverlay(){},
    canRecoverActive:()=>owned, onActiveHold:data=>{ recovered.push(data); return options.recover?.(); },
    disableGlobalInput:Boolean(options.disableGlobalInput) });
  t.after(async () => { await controller.close(); store.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(__dirname)+path.sep)); fs.rmSync(directory,{recursive:true,force:true}); });
  return {store,controller,bridge,requests,commands,recovered,configuration,setOwned(value){owned=value;},
    active(){const draft=store.createDraft({notes:'保留当前会话',source:{title:'原始页面'}});controller.restoreDraft(draft.id);return draft;}};
}

test('native hold recovers the owned draft repeatedly without recapturing or starting audio', async t => {
  const f=fixture(t), draft=f.active(); f.setOwned(true); await f.controller.refreshTrigger();
  const configured=f.requests.at(-1).params;
  assert.equal(configured.enabled,true); assert.deepEqual(configured.excludedApps,['PrivateEditor']);
  for(let i=0;i<3;i++){f.bridge.emit('holdStart',{source:{hwnd:'unrelated-window',title:'不能替换来源'}});await settle();f.bridge.emit('holdEnd');}
  assert.equal(f.recovered.length,3); assert.equal(f.commands.length,0);
  assert.equal(f.requests.some(request=>request.method==='captureWindow'),false);
  assert.equal(f.controller.snapshot().id,draft.id); assert.equal(f.controller.snapshot().state,'paused');
  assert.equal(f.store.listDrafts().length,1); assert.equal(f.store.getDraft(draft.id).source.title,'原始页面');
  assert.equal(f.store.getDraft(draft.id).notes,'保留当前会话');
});

test('only an owned active chat rearms recovery, retaining user exclusions', async t => {
  const f=fixture(t); await f.controller.refreshTrigger();
  assert.equal(f.requests.at(-1).params.enabled,true);
  assert.deepEqual(f.requests.at(-1).params.excludedApps,['PrivateEditor','InMoment','electron']);
  const draft=f.active(); await f.controller.refreshTrigger();
  assert.equal(f.requests.at(-1).params.enabled,false);
  f.bridge.emit('holdStart',{source:{title:'不能创建第二份'}});await settle();
  assert.equal(f.recovered.length,0);assert.equal(f.controller.snapshot().id,draft.id);
  f.setOwned(true);f.configuration.excludedApps.push('InMoment');await f.controller.refreshTrigger();
  assert.equal(f.requests.at(-1).params.enabled,true);
  assert.deepEqual(f.requests.at(-1).params.excludedApps,['PrivateEditor','InMoment']);
  f.setOwned(false);await f.controller.refreshTrigger();assert.equal(f.requests.at(-1).params.enabled,false);
});

test('input disable and test isolation remain authoritative during recovery', async t => {
  const f=fixture(t,{disableGlobalInput:true});f.active();f.setOwned(true);await f.controller.refreshTrigger();
  assert.equal(f.requests.at(-1).params.enabled,false);
  const g=fixture(t);g.active();g.setOwned(true);g.configuration.inputEnabled=false;await g.controller.refreshTrigger();
  assert.equal(g.requests.at(-1).params.enabled,false);
});

test('queued native holds cannot recover or start recording while screenshot input is suppressed',async t=>{
  const f=fixture(t,{disableGlobalInput:true});f.setOwned(true);f.bridge.emit('holdStart',{source:null});await settle();
  assert.equal(f.store.listDrafts().length,0);assert.equal(f.commands.length,0);assert.equal(f.recovered.length,0);
  const draft=f.active();f.bridge.emit('holdStart',{source:null});await settle();assert.equal(f.recovered.length,0);assert.equal(f.controller.snapshot().id,draft.id);
  f.controller.disableGlobalInput=false;f.bridge.emit('holdStart',{source:null});await settle();assert.equal(f.recovered.length,1);assert.equal(f.controller.snapshot().id,draft.id);
});

test('failed recovery stays visible and preserves the draft; closed controllers cannot recover', async t => {
  const f=fixture(t,{recover:()=>Promise.reject(new Error('测试聊天暂时无法显示'))}),draft=f.active();f.setOwned(true);
  f.bridge.emit('holdStart',{source:null});await settle();
  assert.match(f.controller.snapshot().error,/聊天暂时无法显示/u);assert.ok(f.store.getDraft(draft.id));
  await f.controller.close();f.bridge.emit('holdStart',{source:null});await settle();assert.equal(f.recovered.length,1);
});
