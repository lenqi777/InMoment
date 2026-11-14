'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LocalStore } = require('../src/core/store.cjs');
const { ChatService } = require('../src/main/chat-service.cjs');
const { ChatCapture } = require('../src/main/chat-capture.cjs');
function wave() { const b = Buffer.alloc(3244); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(16000,24); b.writeUInt32LE(32000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(b.length-44,40); return b; }
function harness(t, { decision = 'uncertain', transcribe, readContext } = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, '.tmp-chat-capture-'));
  const store = new LocalStore(root), draft = store.createDraft({ source: { processName:'SyntheticReader', title:'Synthetic' } });
  store.addSegment(draft.id, { id: 'test-audio', bytes:wave(), ext:'wav', durationMs:100 });
  let state = { active:true, id:draft.id, state:'paused' }, runs = 0;
  const controller = { pending:new Set(), snapshot:()=>({...state}), pause(){state.state='paused';}, waitForStops:async()=>{}, emitState(){},
    continueRecording(){state.state='recording';}, async startManual(){const d=store.createDraft({id:randomUUID()});state={active:true,id:d.id,state:'recording'};},
    async discard(){store.discard(state.id);state={active:false,id:null,state:'idle'};} };
  const chats = new ChatService({ rootDir:root, store, getConfig:()=>({provider:'deepseek',key:'synthetic'}), createClient:()=>({chat:async()=>({text:'mock'})}) });
  const voices = [];
  const capture = new ChatCapture({ store, controller, chats, analyzeVoiceActivity:async()=>({decision}),
    asr:{ capabilities:()=>({available:true}), transcribe:async(...args)=>{runs++;return transcribe ? transcribe(...args) : {text:'识别出的想法',segments:[{id:'test-audio',text:'识别出的想法'}]};} },
    readContext:readContext || (async()=>({selectedText:'选中文字',url:'https://example.com/'})), onVoice:data=>voices.push(data) });
  t.after(async()=>{await capture.shutdown().catch(()=>{});await chats.shutdown();store.close();fs.rmSync(root,{recursive:true,force:true});});
  return { store,draft,controller,chats,capture,voices,get runs(){return runs;},state(value){state={...state,...value};} };
}
async function finished(h,id){await h.capture.jobs.get(id)?.promise;}
async function explicitSegment(h,id,segmentId='explicit-new') {
  const start=await h.capture.record(id);
  const draftId=h.capture.owners.get(id),segment=h.store.addSegment(draftId,{id:segmentId,bytes:wave(),durationMs:100});
  h.state({segmentId});h.capture.observeSession(h.controller.snapshot());return{...start,draftId,segment};
}
test('certain silence removes only temporary audio and keeps selected text',async t=>{
  const h=harness(t,{decision:'empty'}), audio=h.store.getDraft(h.draft.id).segments[0].path;
  const c=await h.capture.fromCapture();await finished(h,c.id);
  assert.equal(h.runs,0);assert.equal(fs.existsSync(audio),false);assert.equal(h.store.getDraft(h.draft.id).segments.length,0);
  assert.equal(h.chats.get(c.id).candidate,'');assert.equal(h.chats.get(c.id).context.selectedText,'选中文字');assert.equal(h.voices.at(-1).status,'empty');
});
test('recognized audio is a candidate, remains provisional even when chat is saved',async t=>{
  const h=harness(t),c=await h.capture.fromCapture();await finished(h,c.id);
  assert.equal(h.chats.get(c.id).input,'');assert.equal(h.chats.get(c.id).candidate,'识别出的想法');
  assert.equal(h.voices.at(-1).intent,'candidate');assert.equal(h.voices.at(-1).text,undefined);
  h.chats.save(c.id);assert.ok(h.store.getDraft(h.draft.id));assert.equal(h.store.getRecord(h.draft.id),null);
  await h.capture.release(c.id);assert.equal(h.store.getDraft(h.draft.id),null);assert.equal(h.chats.get(c.id).saved,true);assert.equal(h.chats.get(c.id).context.audioDraftId,null);
});

test('cancelling a failed initial candidate removes only failed untranscribed audio and preserves prior valid segments and text',async t=>{
  const h=harness(t,{transcribe:async()=>{throw new Error('合成转写失败')}}),failed=h.store.getDraft(h.draft.id).segments[0].path;
  const prior=h.store.addSegment(h.draft.id,{id:'prior-valid',bytes:wave(),durationMs:100,transcript:'以前有效的语音'}),chat=await h.capture.fromCapture();await finished(h,chat.id);const error=h.voices.at(-1);assert.equal(error.status,'error');assert.equal(h.capture.recordings.has(chat.id),false);
  h.chats.update(chat.id,{input:'保留输入',candidate:'以前的候选',quotes:[{id:'keep-quote',text:'保留引用'}],images:[{id:'keep-image',mimeType:'image/png',base64:Buffer.from('synthetic image').toString('base64')}]});const before=h.chats.get(chat.id);assert.equal((await h.capture.cancelRecording(chat.id,'old-token')).cancelled,false);assert.ok(fs.existsSync(failed));
  const result=await h.capture.cancelRecording(chat.id,error.token);assert.equal(result.cancelled,true);assert.equal(result.intent,'candidate');assert.equal(fs.existsSync(failed),false);assert.ok(fs.existsSync(prior.path));assert.deepEqual(h.store.getDraft(h.draft.id).segments.map(segment=>segment.id),['prior-valid']);const after=h.chats.get(chat.id);assert.equal(after.input,before.input);assert.equal(after.candidate,before.candidate);assert.deepEqual(after.context.images,before.context.images);assert.deepEqual(after.context.quotes,before.context.quotes);assert.equal(h.capture.owners.get(chat.id),h.draft.id);assert.equal(h.capture.retryJobs.has(chat.id),false);
});
test('successful empty recognition removes provisional audio and restores an empty candidate',async t=>{
  const h=harness(t,{transcribe:async()=>({text:'',segments:[{id:'test-audio',text:''}]})});
  const c=await h.capture.fromCapture();await finished(h,c.id);
  assert.equal(h.store.getDraft(h.draft.id).segments.length,0);assert.equal(h.voices.at(-1).status,'empty');assert.equal(h.chats.get(c.id).candidate,'');
});

test('punctuation-only ASR is removed before transcript persistence without changing manual input',async t=>{
  let resolve, entered; const started=new Promise(done=>{entered=done;});
  const h=harness(t,{transcribe:async()=>{entered();return new Promise(done=>{resolve=done;});}}),audio=h.store.getDraft(h.draft.id).segments[0].path;
  const c=await h.capture.fromCapture();await started;h.chats.update(c.id,{input:'我自己输入的问题',candidate:'？！'});
  let transcriptWrites=0;const original=h.store.setTranscript.bind(h.store);h.store.setTranscript=(...args)=>{transcriptWrites++;return original(...args);};
  resolve({text:' 。！？... \n—★😀 ',segments:[{id:'test-audio',text:' 。！？... \n—★😀 '}]});await finished(h,c.id);
  assert.equal(transcriptWrites,0);assert.equal(fs.existsSync(audio),false);assert.equal(h.store.getDraft(h.draft.id).segments.length,0);
  assert.equal(h.chats.get(c.id).candidate,'');assert.equal(h.chats.get(c.id).input,'我自己输入的问题');assert.equal(h.chats.get(c.id).context.audioDraftId,null);assert.equal(h.voices.at(-1).status,'empty');
});

test('Unicode speech and numbers retain their punctuation and remain a candidate',async t=>{
  const value='你好，世界！ 42。 café العربية 日本語 १२३';
  const h=harness(t,{transcribe:async()=>({text:value,segments:[{id:'test-audio',text:value}]})}),c=await h.capture.fromCapture();await finished(h,c.id);
  assert.equal(h.chats.get(c.id).candidate,value);assert.equal(h.store.getDraft(h.draft.id).segments[0].transcript,value);assert.equal(h.voices.at(-1).status,'ready');
});

test('number-only recognition is meaningful speech',async t=>{
  const value='１２３，४५६。';
  const h=harness(t,{transcribe:async()=>({text:value,segments:[{id:'test-audio',text:value}]})}),c=await h.capture.fromCapture();await finished(h,c.id);
  assert.equal(h.chats.get(c.id).candidate,value);assert.equal(h.store.getDraft(h.draft.id).segments[0].transcript,value);assert.equal(h.voices.at(-1).status,'ready');
});

test('meaningful segment text survives an empty aggregate result',async t=>{
  const h=harness(t,{transcribe:async()=>({text:'！？',segments:[{id:'test-audio',text:'只有这段有效，123！'}]})}),c=await h.capture.fromCapture();await finished(h,c.id);
  assert.equal(h.chats.get(c.id).candidate,'只有这段有效，123！');assert.equal(h.store.getDraft(h.draft.id).segments[0].transcript,'只有这段有效，123！');assert.equal(h.voices.at(-1).status,'ready');
});

test('new empty speech removes only its own segment and preserves previous speech and draft edits',async t=>{
  const h=harness(t),c=await h.capture.fromCapture();await finished(h,c.id);
  const originalAudio=h.store.getDraft(h.draft.id).segments[0].path;
  const extra=h.store.addSegment(h.draft.id,{id:'empty-next',bytes:wave(),durationMs:100});
  h.chats.update(c.id,{input:'已有手写内容',candidate:'此前有效的候选'});
  h.capture.asr.transcribe=async()=>({text:'……。',segments:[{id:'empty-next',text:'……。'}]});
  await h.capture.transcribe(c.id,['empty-next']);
  assert.equal(fs.existsSync(extra.path),false);assert.equal(fs.existsSync(originalAudio),true);assert.equal(h.store.getDraft(h.draft.id).segments.length,1);
  assert.equal(h.store.getDraft(h.draft.id).segments[0].transcript,'识别出的想法');assert.equal(h.chats.get(c.id).candidate,'此前有效的候选');assert.equal(h.chats.get(c.id).input,'已有手写内容');assert.equal(h.chats.get(c.id).context.audioDraftId,h.draft.id);
});

test('empty re-recognition never deletes an existing valid transcript',async t=>{
  const h=harness(t),c=await h.capture.fromCapture();await finished(h,c.id);
  h.chats.update(c.id,{candidate:''});h.capture.asr.transcribe=async()=>({text:'。',segments:[{id:'test-audio',text:'。'}]});
  await h.capture.transcribe(c.id,['test-audio']);
  assert.equal(h.store.getDraft(h.draft.id).segments.length,1);assert.equal(h.store.getDraft(h.draft.id).segments[0].transcript,'识别出的想法');assert.equal(h.chats.get(c.id).candidate,'识别出的想法');
});

test('valid transcript added while ASR is pending survives an empty late recognition',async t=>{
  let resolve, entered;const started=new Promise(done=>{entered=done;});
  const h=harness(t,{transcribe:async()=>{entered();return new Promise(done=>{resolve=done;});}}),c=await h.capture.fromCapture();await started;
  h.store.setTranscript(h.draft.id,[{id:'test-audio',text:'等待转写时已人工补充的内容'}]);
  resolve({text:'。',segments:[{id:'test-audio',text:'。'}]});await finished(h,c.id);
  assert.equal(h.store.getDraft(h.draft.id).segments[0].transcript,'等待转写时已人工补充的内容');assert.equal(h.chats.get(c.id).candidate,'等待转写时已人工补充的内容');
});
test('ASR error retains provisional audio and emits visible error',async t=>{
  const h=harness(t,{transcribe:async()=>{throw new Error('本地转写失败。');}}),c=await h.capture.fromCapture();await finished(h,c.id);
  assert.equal(h.store.getDraft(h.draft.id).segments.length,1);assert.equal(h.voices.at(-1).status,'error');
});
test('release invalidates late ASR result before cleanup, candidate never returns',async t=>{
  let finish,started;const entered=new Promise(r=>{started=r;});
  const h=harness(t,{transcribe:async()=>{started();return new Promise(r=>{finish=r;});}}),c=await h.capture.fromCapture();await entered;
  const release=h.capture.release(c.id);h.chats.delete(c.id);finish({text:'late',segments:[{id:'test-audio',text:'late'}]});await release;
  assert.equal(h.chats.get(c.id),null);assert.equal(h.store.getDraft(h.draft.id),null);assert.ok(!h.voices.some(v=>v.status==='ready'));
});
test('saving recording explicitly protects it from later chat cleanup',async t=>{
  const h=harness(t),c=await h.capture.fromCapture();await finished(h,c.id);h.store.complete(h.draft.id);h.state({active:false,state:'saved'});
  await h.capture.release(c.id);assert.ok(h.store.getRecord(h.draft.id));
});
test('recording commit blocks chat cleanup and keeps its ownership',async t=>{
  const h=harness(t),c=await h.capture.fromCapture();await finished(h,c.id);h.state({state:'processing'});
  await assert.rejects(h.capture.release(c.id),/正在保存/u);assert.equal(h.capture.owners.get(c.id),h.draft.id);h.state({state:'paused'});
});
test('another active draft cannot be overwritten by chat microphone',async t=>{
  const h=harness(t),c=h.chats.create();await assert.rejects(h.capture.record(c.id),/当前录音/u);assert.equal(h.controller.snapshot().id,h.draft.id);
});
test('draft audio cleanup rejects expired tokens and completed records',t=>{
  const h=harness(t),token=h.store.draftToken(h.draft.id);h.store.complete(h.draft.id);
  assert.throws(()=>h.store.removeSilentDraftAudio(h.draft.id,['test-audio'],token));assert.equal(h.store.getRecord(h.draft.id).segments.length,1);
});

test('explicit chat microphone delivers only the new segment as token-owned input text',async t=>{
  const h=harness(t),c=await h.capture.fromCapture();await finished(h,c.id);
  h.chats.update(c.id,{input:'已有输入'});
  let passed=[];h.capture.asr.transcribe=async draft=>{passed=draft.segments.map(s=>s.id);return{text:'新的口述！',segments:[{id:'explicit-new',text:'新的口述！'}]};};
  const start=await explicitSegment(h,c.id);const stopped=await h.capture.stopRecording(c.id,start.token);await finished(h,c.id);
  assert.deepEqual(passed,['explicit-new']);assert.equal(stopped.intent,'input');assert.equal(stopped.token,start.token);
  const ready=h.voices.at(-1);assert.equal(ready.status,'ready');assert.equal(ready.intent,'input');assert.equal(ready.token,start.token);assert.equal(ready.text,'新的口述！');assert.equal(ready.draftId,h.draft.id);assert.equal(ready.segmentId,'explicit-new');
  assert.equal(h.chats.get(c.id).candidate,'识别出的想法');assert.equal(h.chats.get(c.id).input,'已有输入');
  const lateStop=await h.capture.stopRecording(c.id,start.token);assert.equal(lateStop.state,'ready');assert.equal(h.controller.snapshot().state,'paused');assert.equal(h.capture.recordings.size,0);
});

test('cancel removes only the explicit pending segment and preserves prior audio, screenshot and draft text',async t=>{
  const h=harness(t),c=await h.capture.fromCapture();await finished(h,c.id);
  const prior=h.store.getDraft(h.draft.id).segments[0];h.store.addScreenshot(h.draft.id,Buffer.from('synthetic image'));h.chats.update(c.id,{input:'保留手写输入'});h.chats.save(c.id);
  const start=await explicitSegment(h,c.id),cancelled=await h.capture.cancelRecording(c.id,start.token);
  assert.equal(cancelled.cancelled,true);assert.equal(fs.existsSync(start.segment.path),false);assert.equal(fs.existsSync(prior.path),true);assert.equal(h.store.getDraft(h.draft.id).screenshots.length,1);
  assert.equal(h.chats.get(c.id).candidate,'识别出的想法');assert.equal(h.chats.get(c.id).input,'保留手写输入');assert.equal(h.chats.get(c.id).saved,true);assert.equal(h.capture.owners.get(c.id),h.draft.id);assert.equal(h.voices.at(-1).status,'cancelled');assert.equal(h.voices.at(-1).token,start.token);
});

test('cancel invalidates late input transcription before deleting only its new audio',async t=>{
  const h=harness(t),c=await h.capture.fromCapture();await finished(h,c.id);const start=await explicitSegment(h,c.id);
  let resolve,entered;const begun=new Promise(done=>{entered=done;});h.capture.asr.transcribe=async()=>{entered();return new Promise(done=>{resolve=done;});};
  await h.capture.stopRecording(c.id,start.token);await begun;const pending=h.capture.cancelRecording(c.id,start.token);
  assert.equal(h.voices.at(-1).status,'cancelled');resolve({text:'不应采用的迟到文字',segments:[{id:'explicit-new',text:'不应采用的迟到文字'}]});await pending;
  assert.equal(h.voices.some(v=>v.intent==='input'&&v.status==='ready'),false);assert.equal(fs.existsSync(start.segment.path),false);assert.equal(h.store.getDraft(h.draft.id).segments.length,1);assert.equal(h.chats.get(c.id).candidate,'识别出的想法');
});

test('input retry retains its original token, intent and segment scope',async t=>{
  const h=harness(t),c=await h.capture.fromCapture();await finished(h,c.id);const start=await explicitSegment(h,c.id);let calls=0;
  h.capture.asr.transcribe=async draft=>{assert.deepEqual(draft.segments.map(s=>s.id),['explicit-new']);if(!calls++)throw new Error('synthetic failure');return{text:'重试后的口述',segments:[{id:'explicit-new',text:'重试后的口述'}]};};
  await h.capture.stopRecording(c.id,start.token);await finished(h,c.id);assert.equal(h.voices.at(-1).status,'error');
  const retry=h.capture.retry(c.id);assert.equal(retry.intent,'input');assert.equal(retry.token,start.token);await finished(h,c.id);
  assert.equal(h.voices.at(-1).text,'重试后的口述');assert.equal(h.voices.at(-1).token,start.token);assert.equal(h.chats.get(c.id).candidate,'识别出的想法');assert.throws(()=>h.capture.retry(c.id),/没有待重试/u);
});

test('cancel during microphone startup discards its new draft without touching earlier text or audio',async t=>{
  const h=harness(t),c=h.chats.create({candidate:'此前候选'});h.chats.update(c.id,{input:'此前输入'});h.state({active:false,id:null,state:'idle'});
  let entered,finish;const begun=new Promise(done=>{entered=done;});const gate=new Promise(done=>{finish=done;});let created;
  h.controller.startManual=async()=>{entered();await gate;created=h.store.createDraft();h.state({active:true,id:created.id,state:'recording'});};
  const recording=h.capture.record(c.id);await begun;const cancelled=h.capture.cancelRecording(c.id,h.voices.at(-1).token);finish();await Promise.all([recording,cancelled]);
  assert.equal(h.store.getDraft(created.id),null);assert.ok(h.store.getDraft(h.draft.id));assert.equal(h.chats.get(c.id).candidate,'此前候选');assert.equal(h.chats.get(c.id).input,'此前输入');assert.equal(h.capture.owners.has(c.id),false);
});

test('chat audio telemetry is numeric, token-owned and limited to the live recording segment',async t=>{
  const h=harness(t),c=await h.capture.fromCapture();await finished(h,c.id);const start=await explicitSegment(h,c.id);
  const value={id:h.draft.id,segmentId:'explicit-new',level:.4,peak:.7,pcm:'must not forward'};
  assert.deepEqual(h.capture.chatAudioLevel(value),{id:c.id,intent:'input',token:start.token,draftId:h.draft.id,segmentId:'explicit-new',level:.4,peak:.7});
  for(const invalid of [{...value,segmentId:'old'},{...value,id:'foreign'},{...value,level:NaN},{...value,peak:2}])assert.equal(h.capture.chatAudioLevel(invalid),null);
  h.state({state:'paused'});assert.equal(h.capture.chatAudioLevel(value),null);
});

test('stop during microphone startup waits for its attempt and a later stop never restarts recording',async t=>{
  const h=harness(t),c=h.chats.create();h.state({active:false,id:null,state:'idle'});let entered,finish,starts=0;
  const begun=new Promise(done=>{entered=done;}),gate=new Promise(done=>{finish=done;});
  h.controller.startManual=async()=>{starts++;entered();await gate;const draft=h.store.createDraft();h.store.addSegment(draft.id,{id:'startup-audio',bytes:wave(),durationMs:100});h.state({active:true,id:draft.id,state:'recording',segmentId:'startup-audio'});};
  h.capture.asr.transcribe=async()=>({text:'准备完毕后的口述',segments:[{id:'startup-audio',text:'准备完毕后的口述'}]});
  const recording=h.capture.record(c.id);await begun;const token=h.voices.at(-1).token,stopping=h.capture.stopRecording(c.id,token);finish();await recording;assert.equal((await stopping).state,'transcribing');await finished(h,c.id);
  assert.equal(h.voices.at(-1).text,'准备完毕后的口述');await h.capture.stopRecording(c.id,token);assert.equal(starts,1);assert.equal(h.controller.snapshot().state,'paused');
});

test('closing a saved chat suppresses late input delivery while preserving its stored input',async t=>{
  const h=harness(t),c=await h.capture.fromCapture();await finished(h,c.id);h.chats.update(c.id,{input:'已保存的用户输入'});h.chats.save(c.id);const start=await explicitSegment(h,c.id);
  let resolve,entered;const begun=new Promise(done=>{entered=done;});h.capture.asr.transcribe=async()=>{entered();return new Promise(done=>{resolve=done;});};
  await h.capture.stopRecording(c.id,start.token);await begun;const closing=h.capture.release(c.id);resolve({text:'关闭后迟到的口述',segments:[{id:'explicit-new',text:'关闭后迟到的口述'}]});await closing;
  assert.equal(h.voices.some(v=>v.intent==='input'&&v.status==='ready'),false);assert.equal(h.chats.get(c.id).input,'已保存的用户输入');assert.equal(h.chats.get(c.id).saved,true);assert.equal(h.store.getDraft(h.draft.id),null);assert.equal(h.capture.recordings.has(c.id),false);
});

test('stopping an externally resumed owned recording announces its input token before transcription',async t=>{
  const h=harness(t),c=await h.capture.fromCapture();await finished(h,c.id);h.state({state:'recording',segmentId:'resumed-new'});
  h.controller.waitForStops=async()=>{if(!h.store.getDraft(h.draft.id).segments.some(s=>s.id==='resumed-new'))h.store.addSegment(h.draft.id,{id:'resumed-new',bytes:wave(),durationMs:100});};
  h.capture.asr.transcribe=async()=>({text:'继续录下的新文字',segments:[{id:'resumed-new',text:'继续录下的新文字'}]});
  await h.capture.record(c.id);await finished(h,c.id);
  const events=h.voices.filter(v=>v.intent==='input');assert.equal(events[0].status,'recording');assert.equal(events.at(-1).status,'ready');assert.equal(events[0].token,events.at(-1).token);assert.equal(events.at(-1).text,'继续录下的新文字');
});
