'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {ScreenshotCoordinator,pngImage,MAX_BYTES,MAX_CAPTURE_BYTES}=require('../src/main/screenshot-coordinator.cjs');
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=';
const regionPng='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGPgEVXhEVVhgFAABzoBFTFqH3MAAAAASUVORK5CYII=';
const regionRect={x:0,y:0,width:2,height:2};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}};
function fixture(options={}){
  const calls=[],chat={id:'chat-one',input:'未发送的草稿',candidate:'临时候选',messages:[],context:{images:[],audioDraftId:'owned-audio'}};
  let current=chat;
  const chats={get:id=>id===chat.id&&current?structuredClone(current):null,update(id,fields){assert.equal(id,chat.id);current.context.images=structuredClone(fields.images);calls.push('attach');return structuredClone(current)}};
  let editor, recording;
  const coordinator=new ScreenshotCoordinator({chats,
    setBusy:async busy=>{calls.push('busy:'+busy);await options.setBusy?.(busy)},
    prepare:async job=>{calls.push(job.options.keepChatVisible?'keep':'hide');await options.prepare?.(job)},
    capture:async job=>{calls.push('capture');return await options.capture?.()||{image:job.purpose==='region'?{dataUrl:regionPng,width:2,height:2}:{dataUrl:png,width:1,height:1},display:{bounds:{x:-800,y:0,width:800,height:600},scaleFactor:1.25}}},
    createEditor(){calls.push('create');editor=new EventEmitter();let destroyed=false;editor.webContents=new EventEmitter();editor.webContents.mainFrame={};editor.webContents.send=()=>{};Object.assign(editor,{isDestroyed:()=>destroyed,show(){calls.push('show')},focus(){calls.push('focus')},destroy(){destroyed=true;calls.push('destroy');editor.emit('closed')}});return editor},
    loadEditor:async()=>{calls.push('load');await options.load?.()},
    restore:async()=>{calls.push('restore');await options.restore?.()},decode:(url,size)=>{calls.push('decode');options.decode?.(url,size);return url},
    copyImage(image){calls.push('copy');return options.copyImage?.(image)},
    async startRecording(job){calls.push('start-region');await options.startRecording?.(job);return recording={id:'region-draft',state:'recording',active:true};},
    getRecording:()=>recording,
    saveRecordingImage(job,image){calls.push('save-region');options.saveRecordingImage?.(job,image);},
  });
  return{coordinator,chats,calls,chat,get editor(){return editor},get current(){return current},removeChat(){current=null},event(){return{sender:editor.webContents,senderFrame:editor.webContents.mainFrame}},async init(){await settle();return coordinator.invoke(this.event(),'screenshot:init')}};
}

test('confirm attaches and copies the edited PNG, preserving concurrent chat input and temporary audio ownership',async()=>{
  const copies=[],f=fixture({copyImage:image=>copies.push(`data:${image.mimeType};base64,${image.base64}`)}),result=f.coordinator.start(f.chat.id);const init=await f.init();
  assert.equal(init.image.width,1);assert.equal(init.display.bounds.x,-800);assert.equal(init.display.scaleFactor,1.25);
  f.current.input='编辑期间继续输入';f.current.context.images.push({id:'existing',mimeType:'image/png',base64:png.slice(22)});
  await f.coordinator.invoke(f.event(),'screenshot:confirm',{token:init.token,dataUrl:png});
  const value=await result;assert.equal(value.chat.id,f.chat.id);assert.equal(value.chat.input,'编辑期间继续输入');assert.equal(value.chat.candidate,'临时候选');assert.equal(value.chat.context.audioDraftId,'owned-audio');assert.equal(value.chat.context.images.length,2);assert.equal(value.chat.messages.length,0);assert.equal(f.coordinator.busy,false);
  assert.deepEqual(f.calls.slice(0,4),['busy:true','hide','capture','decode']);assert.ok(f.calls.indexOf('destroy')<f.calls.indexOf('restore'));assert.equal(f.calls.filter(x=>x==='restore').length,1);
  assert.deepEqual(copies, [png]);assert.ok(f.calls.indexOf('attach')<f.calls.indexOf('copy'));
});

test('cancel restores the unchanged chat and clears captured memory/token before restore',async()=>{
  const f=fixture({restore(){assert.equal(f.coordinator.job.image,null);assert.equal(f.coordinator.job.token,null);assert.equal(f.coordinator.job.valid,false)}}),result=f.coordinator.start(f.chat.id,{keepChatVisible:true}),init=await f.init();
  await f.coordinator.invoke(f.event(),'screenshot:cancel',{token:init.token});assert.deepEqual(await result,{cancelled:true});assert.equal(f.current.context.images.length,0);assert.equal(f.current.input,'未发送的草稿');assert.ok(f.calls.includes('keep'));assert.ok(f.calls.includes('busy:false'));assert.equal(f.coordinator.busy,false);
  assert.equal(f.calls.includes('copy'), false);
});

test('only the current editor main frame and exact one-use token can read or confirm',async()=>{
  const f=fixture(),result=f.coordinator.start(f.chat.id),init=await f.init();
  await assert.rejects(()=>f.coordinator.invoke({sender:{},senderFrame:{}},'screenshot:init'),/失效/u);
  await assert.rejects(()=>f.coordinator.invoke({...f.event(),senderFrame:{}},'screenshot:confirm',{token:init.token,dataUrl:png}),/失效/u);
  await assert.rejects(()=>f.coordinator.invoke(f.event(),'screenshot:confirm',{token:'wrong',dataUrl:png}),/失效/u);
  await assert.rejects(()=>f.coordinator.invoke(f.event(),'records:list',{token:init.token}),/不支持/u);
  assert.equal(f.calls.includes('attach'),false);
  const event=f.event();await f.coordinator.invoke(event,'screenshot:confirm',{token:init.token,dataUrl:png});await result;
  await assert.rejects(()=>f.coordinator.invoke(event,'screenshot:confirm',{token:init.token,dataUrl:png}),/失效/u);assert.equal(f.current.context.images.length,1);
});

test('malformed or oversized output stays in the editor with a visible correction error',async()=>{
  const f=fixture(),result=f.coordinator.start(f.chat.id),init=await f.init();
  for(const dataUrl of ['file:///private.png','data:image/png;base64,Zm9v','data:image/jpeg;base64,AAAA'])await assert.rejects(()=>f.coordinator.invoke(f.event(),'screenshot:confirm',{token:init.token,dataUrl}),/格式/u);
  await assert.rejects(()=>f.coordinator.invoke(f.event(),'screenshot:confirm',{token:init.token,dataUrl:'data:image/png;base64,'+'A'.repeat(Math.ceil(MAX_BYTES/3)*4+4)}),/缩小选区/u);
  assert.equal(f.editor.isDestroyed(),false);assert.equal(f.current.context.images.length,0);
  await f.coordinator.invoke(f.event(),'screenshot:cancel',{token:init.token});await result;
});

test('chat close during capture invalidates the request before late image delivery and never restores',async()=>{
  const capture=gate(),f=fixture({capture:()=>capture.promise}),result=f.coordinator.start(f.chat.id);await settle();
  await f.coordinator.cancelChat(f.chat.id);f.removeChat();capture.resolve({image:{dataUrl:png,width:1,height:1},display:{bounds:{x:0,y:0,width:10,height:10},scaleFactor:1}});await settle();
  assert.deepEqual(await result,{cancelled:true});assert.equal(f.calls.includes('create'),false);assert.equal(f.calls.includes('restore'),false);assert.equal(f.calls.includes('attach'),false);assert.equal(f.coordinator.busy,false);
});

test('shutdown with a live editor invalidates its token without restoring or attaching',async()=>{
  const f=fixture(),result=f.coordinator.start(f.chat.id),init=await f.init(),event=f.event();
  await f.coordinator.shutdown();assert.deepEqual(await result,{cancelled:true});assert.equal(f.calls.includes('restore'),false);
  await assert.rejects(()=>f.coordinator.invoke(event,'screenshot:confirm',{token:init.token,dataUrl:png}),/失效/u);await assert.rejects(()=>f.coordinator.start(f.chat.id),/退出/u);
});

for(const stage of ['capture','load'])test(`${stage} failure releases input suppression and restores the original chat`,async()=>{
  const f=fixture({[stage]:async()=>{throw new Error('合成权限失败')}}),result=f.coordinator.start(f.chat.id);
  await assert.rejects(result,/权限失败/u);assert.equal(f.coordinator.busy,false);assert.ok(f.calls.includes('busy:false'));assert.ok(f.calls.includes('restore'));assert.equal(f.current.context.images.length,0);
});

test('closing editor via window controls cancels; renderer crash is an explicit error',async()=>{
  const f=fixture(),result=f.coordinator.start(f.chat.id);await f.init();f.editor.destroy();assert.deepEqual(await result,{cancelled:true});assert.ok(f.calls.includes('restore'));
  const g=fixture(),failed=g.coordinator.start(g.chat.id);await g.init();g.editor.webContents.emit('render-process-gone');await assert.rejects(failed,/编辑器已退出/u);assert.ok(g.calls.includes('restore'));
});

test('duplicate requests and full attachment slots fail before hiding or capturing',async()=>{
  const f=fixture(),result=f.coordinator.start(f.chat.id),init=await f.init();await assert.rejects(()=>f.coordinator.start(f.chat.id),/当前截图/u);await f.coordinator.invoke(f.event(),'screenshot:cancel',{token:init.token});await result;
  f.current.context.images=Array(4).fill({id:'image'});f.calls.length=0;await assert.rejects(()=>f.coordinator.start(f.chat.id),/最多添加/u);assert.deepEqual(f.calls,[]);
});

test('capture metadata and output dimensions are bounded, initial capture permits a larger crop source',async()=>{
  const bytes=Buffer.from(png.slice(22),'base64'),large=Buffer.alloc(MAX_BYTES+50);bytes.copy(large);const source='data:image/png;base64,'+large.toString('base64');
  assert.equal(pngImage(source,{},MAX_CAPTURE_BYTES).width,1);assert.throws(()=>pngImage(source),/缩小选区/u);
  bytes.writeUInt32BE(2,16);const wider='data:image/png;base64,'+bytes.toString('base64');assert.throws(()=>pngImage(wider,{width:1,height:1}),/尺寸/u);
  const f=fixture({capture:async()=>({image:{dataUrl:png,width:2,height:1},display:{bounds:{},scaleFactor:1}})});await assert.rejects(f.coordinator.start(f.chat.id),/尺寸未能读取/u);assert.ok(f.calls.includes('restore'));
});

test('region selection starts recording once, while pausing and confirming remain separate', async () => {
  const f = fixture({ startRecording(job) {
    assert.equal(job.purpose, 'region');
    assert.ok(job.image);
    assert.equal(f.editor.isDestroyed(), false);
    assert.equal(f.coordinator.busy, true);
    assert.deepEqual(job.recordingAnchor, {
      toolbar: { x: -740, y: 48, width: 460, height: 48 },
      selection: { x: -800, y: 0, width: 800, height: 600 },
    });
  }, saveRecordingImage(job, image) {
    assert.equal(job.recordingId, 'region-draft');
    assert.equal(image.base64, png.slice(22));
  } });
  f.removeChat();
  const result = f.coordinator.startRegion();
  const init = await f.init();
  f.editor.webContents.getZoomFactor = () => 1.25;
  assert.equal(init.purpose, 'region');
  assert.equal(f.calls.includes('start-region'), false);
  const invoke = (method, params) => f.coordinator.invoke(f.event(), method, { token: init.token, ...params });
  await assert.rejects(invoke('screenshot:record', { rect: { ...regionRect, width: 3 } }), /范围/u);
  await assert.rejects(invoke('screenshot:confirm', { dataUrl: png }), /录音已结束/u);
  const request = invoke('screenshot:record', { rect: regionRect, toolbar: { x: 48, y: 38.4, width: 368, height: 38.4 } });
  const duplicate = invoke('screenshot:record', { rect: regionRect });
  assert.deepEqual(await request, { id: 'region-draft' });
  assert.deepEqual(await duplicate, { id: 'region-draft' });
  assert.equal(f.calls.filter(call => call === 'start-region').length, 1);
  f.coordinator.getRecording().state = 'paused';
  assert.equal(f.editor.isDestroyed(), false);
  assert.equal(f.calls.includes('save-region'), false);
  f.coordinator.getRecording().state = 'recording';
  await f.coordinator.invoke(f.event(), 'screenshot:confirm', { token: init.token, dataUrl: png });
  assert.deepEqual(await result, { id: 'region-draft' });
  assert.equal(f.coordinator.getRecording().state, 'recording');
  assert.equal(f.calls.includes('attach'), false);
  assert.equal(f.calls.includes('restore'), false);
  assert.deepEqual(f.calls.slice(-5), ['decode', 'save-region', 'destroy', 'copy', 'busy:false']);
});

test('a clipboard write failure reports the partial result without saving a second attachment', async () => {
  const copying = gate();
  const f = fixture({ async copyImage() { await copying.promise; throw new Error('Clipboard locked'); } });
  const result = f.coordinator.start(f.chat.id);
  const completion = assert.rejects(result, /截图已保存，复制到剪贴板失败/u);
  const init = await f.init();
  const confirm = () => f.coordinator.invoke(f.event(), 'screenshot:confirm', { token: init.token, dataUrl: png });
  const submitted = confirm();
  await settle();
  assert.equal(f.coordinator.busy, true);
  assert.equal(f.editor.isDestroyed(), true);
  await assert.rejects(confirm(), /失效/u);
  copying.resolve();
  await submitted;
  await completion;
  assert.equal(f.current.context.images.length, 1);
  assert.equal(f.calls.filter(call => call === 'copy').length, 1);
  assert.equal(f.coordinator.busy, false);
});

test('cancelling after selecting releases image memory and leaves the recording running', async () => {
  const f = fixture();
  const result = f.coordinator.startRegion();
  const init = await f.init();
  await f.coordinator.invoke(f.event(), 'screenshot:record', { token: init.token, rect: regionRect });
  await f.coordinator.invoke(f.event(), 'screenshot:cancel', { token: init.token });
  assert.deepEqual(await result, { cancelled: true });
  assert.equal(f.coordinator.getRecording().state, 'recording');
  assert.equal(f.calls.includes('save-region'), false);
});

test('region cancellation and interruption during screen capture cannot start a recording', async () => {
  const f = fixture();
  const result = f.coordinator.startRegion();
  const init = await f.init();
  await f.coordinator.invoke(f.event(), 'screenshot:cancel', { token: init.token });
  assert.deepEqual(await result, { cancelled: true });
  assert.equal(f.calls.includes('start-region'), false);

  const ready = gate(), capture = gate();
  const g = fixture({ capture() { ready.resolve(); return capture.promise; } });
  const interrupted = g.coordinator.startRegion();
  await ready.promise;
  await g.coordinator.cancelRegion();
  capture.resolve();
  await settle();
  assert.deepEqual(await interrupted, { cancelled: true });
  assert.equal(g.calls.includes('create'), false);
  assert.equal(g.calls.includes('start-region'), false);
  assert.equal(g.coordinator.busy, false);
});
