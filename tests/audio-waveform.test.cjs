'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {LocalStore}=require('../src/core/store.cjs');
const {AudioWaveformService,readWavPeaks}=require('../src/main/audio-waveform.cjs');
const chunk=(name,body)=>{const header=Buffer.alloc(8);header.write(name);header.writeUInt32LE(body.length,4);return Buffer.concat([header,body,body.length%2?Buffer.alloc(1):Buffer.alloc(0)])};
function riff(chunks){const body=Buffer.concat([Buffer.from('WAVE'),...chunks]),head=Buffer.alloc(8);head.write('RIFF');head.writeUInt32LE(body.length,4);return Buffer.concat([head,body]);}
function format({bits=16,channels=1,sampleRate=16000,code=1,extensible=false}={}){
  const bytes=Buffer.alloc(extensible?40:16);bytes.writeUInt16LE(extensible?0xfffe:code,0);bytes.writeUInt16LE(channels,2);bytes.writeUInt32LE(sampleRate,4);bytes.writeUInt32LE(sampleRate*channels*bits/8,8);bytes.writeUInt16LE(channels*bits/8,12);bytes.writeUInt16LE(bits,14);
  if(extensible){bytes.writeUInt16LE(22,16);bytes.writeUInt16LE(bits,18);bytes.writeUInt32LE(code,24);Buffer.from('00001000800000aa00389b71','hex').copy(bytes,28);}return bytes;
}
function wave({bits=16,channels=1,sampleRate=16000,code=1,frames=1024,sample=()=>0,extensible=false,extra=[]}={}){
  const data=Buffer.alloc(frames*channels*bits/8),step=bits/8;
  for(let i=0;i<frames;i++)for(let c=0;c<channels;c++){
    const n=sample(i,c),offset=(i*channels+c)*step;
    if(code===3){bits===32?data.writeFloatLE(n,offset):data.writeDoubleLE(n,offset);}
    else if(bits===8)data[offset]=Math.max(0,Math.min(255,Math.round(n*128+128)));
    else{const scale=2**(bits-1),value=Math.max(-scale,Math.min(scale-1,Math.round(n*scale)));data.writeIntLE(value,offset,step);}
  }
  return riff([chunk('fmt ',format({bits,channels,sampleRate,code,extensible})),...extra,chunk('data',data)]);
}
function memory(bytes,{partial=Infinity}={}){const reads=[];return{reads,async read(target,offset,length,position){const size=Math.max(0,Math.min(length,bytes.length-position,partial));bytes.copy(target,offset,position,position+size);reads.push({length,position,size});return{bytesRead:size}}};}
async function parse(bytes,opts={}){return readWavPeaks(memory(bytes),bytes.length,opts);}
function fixture(t,{maxEntries=32,io=fs.promises}={}){
  const root=fs.mkdtempSync(path.join(__dirname,'.tmp-waveform-')),store=new LocalStore(root),service=new AudioWaveformService({store,maxEntries,io});
  t.after(async()=>{await service.close();store.close();assert.ok(path.resolve(root).startsWith(path.resolve(__dirname)+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  function add(id,bytes,{saved=true,ext='wav'}={}){store.createDraft({id});store.addSegment(id,{id:id+'-audio',bytes,ext,durationMs:123});return saved?store.complete(id):store.getDraft(id);}
  return{root,store,service,add};
}

test('real PCM samples produce silence, changing amplitude and the final impulse at their actual time positions',async()=>{
  const value=await parse(wave({frames:1024,sample:i=>i<256?0:i<512?.25:i<768?-.5:i===1023?-1:0}));
  assert.equal(value.peaks.length,256);assert.ok(value.peaks.slice(0,64).every(n=>n===0));assert.ok(value.peaks.slice(64,128).every(n=>n===.25));assert.ok(value.peaks.slice(128,192).every(n=>n===.5));assert.equal(value.peaks[255],1);assert.equal(value.durationMs,64);assert.equal(value.sampleCount,1024);assert.equal(value.sampleRate,16000);
});

for(const [code,bits,extensible] of [[1,8,false],[1,16,false],[1,24,false],[1,32,false],[3,32,false],[3,64,false],[1,24,true],[3,32,true]])test(`PCM/float format ${code}/${bits}${extensible?' extensible':''} combines channel amplitudes without phase cancellation`,async()=>{
  const value=await parse(wave({code,bits,extensible,channels:2,frames:256,sample:(_i,c)=>c?-.75:.75}));assert.ok(value.peaks.every(n=>Math.abs(n-.75)<.000001));assert.equal(value.channels,2);assert.equal(value.bitsPerSample,bits);
});

test('RIFF metadata and odd padding are skipped; data may precede fmt and use multiple chunks',async()=>{
  const bytes=riff([chunk('JUNK',Buffer.alloc(65535,0xab)),chunk('data',Buffer.from([128,160,192])),chunk('fmt ',format({bits:8})),chunk('LIST',Buffer.from('odd')),chunk('data',Buffer.from([0]))]),handle=memory(bytes,{partial:7});
  const value=await readWavPeaks(handle,bytes.length,{bins:16});assert.equal(value.sampleCount,4);assert.equal(value.peaks[0],0);assert.equal(value.peaks[4],.25);assert.equal(value.peaks[8],.5);assert.equal(value.peaks[12],1);
  assert.ok(handle.reads.reduce((sum,read)=>sum+read.size,0)<150,'unknown 64KiB metadata is never loaded');
});

test('empty PCM is an actual zero waveform; unsupported formats and invalid chunks have explicit errors',async()=>{
  assert.ok((await parse(wave({frames:0}))).peaks.every(n=>n===0));
  const samples=[Buffer.from('not a wave file'),wave({code:6}),wave().subarray(0,43),riff([chunk('fmt ',format()),chunk('data',Buffer.alloc(1))]),riff([chunk('fmt ',format()),chunk('fmt ',format()),chunk('data',Buffer.alloc(0))])];
  for(const bytes of samples)await assert.rejects(()=>parse(bytes),error=>/^WAVEFORM_(INVALID|UNSUPPORTED)$/u.test(error.code));
  await assert.rejects(()=>parse(wave({code:3,bits:32,sample:()=>NaN})),{code:'WAVEFORM_INVALID'});
});

test('service reads only the requested owned saved or draft segment and returns no filesystem paths',async t=>{
  const f=fixture(t),saved=f.add('saved',wave({sample:()=>.25})),draft=f.add('draft',wave({sample:()=>.5}),{saved:false});
  const first=await f.service.get(saved.id,saved.segments[0].id),second=await f.service.get(draft.id,draft.segments[0].id);assert.ok(first.peaks.every(n=>n===.25));assert.ok(second.peaks.every(n=>n===.5));assert.equal(first.id,saved.id);assert.equal(JSON.stringify(first).includes(f.root),false);
  assert.equal(f.service.cache.size,1,'only saved audio derivatives enter the LRU');assert.ok([...f.service.cache.values()].every(entry=>entry.id===saved.id));
  await assert.rejects(()=>f.service.get(saved.id,draft.segments[0].id),{code:'WAVEFORM_UNAVAILABLE'});await assert.rejects(()=>f.service.get('../outside','saved-audio'),{code:'WAVEFORM_UNAVAILABLE'});
  const nonWav=f.add('webm',Buffer.from('synthetic webm'),{ext:'webm'});await assert.rejects(()=>f.service.get(nonWav.id,nonWav.segments[0].id),{code:'WAVEFORM_UNSUPPORTED'});
});

test('bounded asynchronous scans coalesce concurrent requests; LRU and file stat changes invalidate cached peaks',async t=>{
  let opens=0,maxRead=0,closes=0;
  const io={lstat:(...args)=>fs.promises.lstat(...args),async open(...args){opens++;const handle=await fs.promises.open(...args);return{stat:(...a)=>handle.stat(...a),async read(...a){maxRead=Math.max(maxRead,a[2]);return handle.read(...a)},async close(){closes++;return handle.close()}}}};
  const f=fixture(t,{maxEntries:1,io}),a=f.add('first',wave({frames:100000,sample:()=>.25})),b=f.add('second',wave({sample:()=>.5}));
  const values=await Promise.all([f.service.get(a.id,a.segments[0].id),f.service.get(a.id,a.segments[0].id)]);assert.equal(opens,1);assert.ok(maxRead<=65536);assert.equal(closes,1);values[0].peaks[0]=1;
  assert.equal((await f.service.get(a.id,a.segments[0].id)).peaks[0],.25);assert.equal(opens,1);
  await f.service.get(b.id,b.segments[0].id);await f.service.get(a.id,a.segments[0].id);assert.equal(opens,3);assert.equal(f.service.cache.size,1);
  fs.writeFileSync(a.segments[0].path,wave({frames:100000,sample:()=>.75}));assert.equal((await f.service.get(a.id,a.segments[0].id)).peaks[0],.75);assert.equal(opens,4);assert.equal(closes,4);
});

test('record deletion during a scan cannot publish or cache late waveform data',async t=>{
  let entered,release;const ready=new Promise(resolve=>{entered=resolve}),hold=new Promise(resolve=>{release=resolve});let first=true;
  const io={lstat:(...a)=>fs.promises.lstat(...a),async open(...a){const handle=await fs.promises.open(...a);return{stat:(...x)=>handle.stat(...x),async read(...x){if(first){first=false;entered();await hold;}return handle.read(...x)},close:()=>handle.close()}}};
  const f=fixture(t,{io}),record=f.add('deleted',wave({sample:()=>1})),pending=f.service.get(record.id,record.segments[0].id);await ready;f.store.deleteRecord(record.id);release();await assert.rejects(pending,error=>/^WAVEFORM_/u.test(error.code));assert.equal(f.service.cache.size,0);
});

test('explicit cleanup invalidation clears saved derivatives and revokes scans before file deletion',async t=>{
  let entered,release,blocked=false;const ready=new Promise(resolve=>{entered=resolve}),hold=new Promise(resolve=>{release=resolve});
  const io={lstat:(...a)=>fs.promises.lstat(...a),async open(...a){const handle=await fs.promises.open(...a);return{stat:(...x)=>handle.stat(...x),async read(...x){if(blocked){blocked=false;entered();await hold;}return handle.read(...x)},close:()=>handle.close()}}};
  const f=fixture(t,{io}),record=f.add('invalidated',wave({sample:()=>.5}));await f.service.get(record.id,record.segments[0].id);assert.equal(f.service.cache.size,1);f.service.invalidate(record.id);assert.equal(f.service.cache.size,0);
  blocked=true;const pending=f.service.get(record.id,record.segments[0].id);await ready;f.service.invalidate(record.id);release();await assert.rejects(pending,{code:'WAVEFORM_CHANGED'});assert.ok(f.store.getRecord(record.id),'callbacks are revoked even before the caller deletes audio');assert.equal(f.service.cache.size,0);
});

test('closing the service settles queued work and closes every open file without returning late peaks',async t=>{
  const f=fixture(t),record=f.add('closing',wave({frames:500000,sample:()=>.25}));const tasks=Array.from({length:4},()=>f.service.get(record.id,record.segments[0].id));const results=Promise.allSettled(tasks);await f.service.close();assert.ok((await results).every(result=>result.status==='rejected'));assert.equal(f.service.pending.size,0);assert.equal(f.service.cache.size,0);
});
