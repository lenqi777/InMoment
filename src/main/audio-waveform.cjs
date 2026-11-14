'use strict';
const fs=require('node:fs');
const path=require('node:path');
const MAX_FILE_BYTES=513*1024*1024;
const READ_BYTES=64*1024;
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
function issue(code,message){return Object.assign(new Error(message),{code});}
const invalid=()=>issue('WAVEFORM_INVALID','录音文件格式不完整，未能生成波形。');
const unsupported=()=>issue('WAVEFORM_UNSUPPORTED','此录音格式暂不支持波形，仍可播放和拖动进度。');
const unavailable=()=>issue('WAVEFORM_UNAVAILABLE','这段录音已不可用，请重新打开记录。');
const changed=()=>issue('WAVEFORM_CHANGED','录音文件发生变化，请重新打开记录。');
async function readExact(handle,size,position,check){
  const buffer=Buffer.allocUnsafe(size);let offset=0;
  while(offset<size){check();const{bytesRead}=await handle.read(buffer,offset,size-offset,position+offset);if(!bytesRead)throw invalid();offset+=bytesRead;}
  return buffer;
}
function formatOf(bytes,size){
  if(size<16)throw invalid();
  if(size!==16 && (size<18 || 18+bytes.readUInt16LE(16)>size))throw invalid();
  let code=bytes.readUInt16LE(0);const channels=bytes.readUInt16LE(2),sampleRate=bytes.readUInt32LE(4),byteRate=bytes.readUInt32LE(8),align=bytes.readUInt16LE(12),bits=bytes.readUInt16LE(14);
  if(code===0xfffe){
    if(size<40 || bytes.length<40 || bytes.readUInt16LE(16)<22 || bytes.readUInt16LE(18)<1 || bytes.readUInt16LE(18)>bits)throw invalid();
    if(bytes.subarray(28,40).toString('hex')!=='00001000800000aa00389b71')throw unsupported();
    code=bytes.readUInt32LE(24);
  }
  if(![1,3].includes(code) || (code===1?![8,16,24,32].includes(bits):![32,64].includes(bits)))throw unsupported();
  if(channels<1 || channels>8 || sampleRate<1000 || sampleRate>384000)throw unsupported();
  if(align!==channels*(bits/8) || byteRate!==sampleRate*align)throw invalid();
  return{code,channels,sampleRate,align,bits};
}
function amplitude(bytes,offset,format){
  let sample;
  if(format.code===3)sample=format.bits===32?bytes.readFloatLE(offset):bytes.readDoubleLE(offset);
  else if(format.bits===8)sample=(bytes[offset]-128)/128;
  else if(format.bits===16)sample=bytes.readInt16LE(offset)/32768;
  else if(format.bits===24)sample=bytes.readIntLE(offset,3)/8388608;
  else sample=bytes.readInt32LE(offset)/2147483648;
  if(!Number.isFinite(sample))throw invalid();
  return Math.min(1,Math.abs(sample));
}

// Chunk headers are read by offset; unknown metadata is skipped, not loaded.
// Audio is scanned once in bounded blocks, preserving impulses between bins.
async function readWavPeaks(handle,fileSize,{bins=256,check=()=>{}}={}){
  if(!Number.isInteger(bins) || bins<16 || bins>512)throw new Error('波形精度无效。');
  if(fileSize<12 || fileSize>MAX_FILE_BYTES)throw invalid();
  const header=await readExact(handle,12,0,check);
  if(header.toString('ascii',0,4)!=='RIFF' || header.toString('ascii',8,12)!=='WAVE')throw unsupported();
  const end=header.readUInt32LE(4)+8;
  if(end<12 || end>fileSize)throw invalid();
  let offset=12,format=null,count=0;const data=[];
  while(offset<end){
    if(end-offset<8 || ++count>4096)throw invalid();
    const chunk=await readExact(handle,8,offset,check),name=chunk.toString('ascii',0,4),size=chunk.readUInt32LE(4),start=offset+8;
    if(start+size>end)throw invalid();
    if(name==='fmt '){if(format)throw invalid();format=formatOf(await readExact(handle,Math.min(size,40),start,check),size);}
    else if(name==='data')data.push({start,size});
    offset=start+size+(size%2);if(offset>end)throw invalid();
  }
  if(!format || !data.length)throw invalid();
  if(data.some(chunk=>chunk.size%format.align))throw invalid();
  const sampleCount=data.reduce((total,chunk)=>total+chunk.size/format.align,0),peaks=Array(bins).fill(0),step=format.bits/8;
  const blockSize=Math.floor(READ_BYTES/format.align)*format.align;let frame=0;
  for(const chunk of data)for(let position=0;position<chunk.size;){
    const size=Math.min(blockSize,chunk.size-position),bytes=await readExact(handle,size,chunk.start+position,check);
    for(let at=0;at<size;at+=format.align,frame++){
      const bin=Math.min(bins-1,Math.floor(frame*bins/sampleCount));let peak=0;
      for(let channel=0;channel<format.channels;channel++)peak=Math.max(peak,amplitude(bytes,at+channel*step,format));
      peaks[bin]=Math.max(peaks[bin],peak);
    }
    position+=size;
  }
  check();return{peaks,durationMs:sampleCount/format.sampleRate*1000,sampleRate:format.sampleRate,channels:format.channels,sampleCount,bitsPerSample:format.bits,format:format.code===1?'pcm':'float'};
}
const stamp=stat=>`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
class AudioWaveformService{
  constructor({store,io=fs.promises,maxEntries=32,maxConcurrent=2}){Object.assign(this,{store,io,maxEntries,maxConcurrent});this.cache=new Map();this.pending=new Map();this.scans=new Set();this.waiters=[];this.active=0;this.requests=0;this.closed=false;}
  _file(id,segmentId){
    if(this.closed || this.store.closed)throw issue('WAVEFORM_CLOSED','应用正在退出。');
    if(typeof id!=='string' || !ID.test(id) || typeof segmentId!=='string' || !ID.test(segmentId))throw unavailable();
    try{
      const record=this.store.get(id);
      if(!record || !['saved','draft'].includes(record.status))throw unavailable();
      const segment=record.segments.find(item=>item.id===segmentId);if(!segment)throw unavailable();
      const filename=this.store.safePath(segment.path),directory=this.store.directory(id,record.status),relative=path.relative(directory,filename);
      if(!relative || relative.startsWith('..') || path.isAbsolute(relative))throw unavailable();
      if(path.extname(filename).toLowerCase()!=='.wav')throw unsupported();
      return{filename,saved:record.status==='saved'};
    }catch(error){if(error.code?.startsWith('WAVEFORM_'))throw error;throw unavailable();}
  }
  async _slot(work){
    if(this.active>=this.maxConcurrent)await new Promise(resolve=>this.waiters.push(resolve));
    else this.active++;
    try{if(this.closed)throw issue('WAVEFORM_CLOSED','应用正在退出。');return await work();}
    finally{const next=this.waiters.shift();if(next)next();else this.active--;}
  }
  async get(id,segmentId){
    if(this.requests>=64)throw issue('WAVEFORM_BUSY','波形正在读取，请稍后重试。');
    this.requests++;
    try{
      const{filename,saved}=this._file(id,segmentId),stat=await this.io.lstat(filename,{bigint:true});
      if(!stat.isFile() || stat.isSymbolicLink() || stat.size<12n || stat.size>BigInt(MAX_FILE_BYTES))throw invalid();
      const identity=stamp(stat),key=filename+'\0'+identity;
      if(this._file(id,segmentId).filename!==filename)throw changed();
      if(saved && this.cache.has(key)){const cached=this.cache.get(key);this.cache.delete(key);this.cache.set(key,cached);return{id,segmentId,...structuredClone(cached.value)};}
      let task=this.pending.get(key);
      if(!task){
        const scan={id,invalid:false};this.scans.add(scan);
        task=this._slot(async()=>{
          let handle;
          const check=()=>{if(this.closed || this.store.closed)throw issue('WAVEFORM_CLOSED','应用正在退出。');if(scan.invalid)throw changed();};
          try{
            check();handle=await this.io.open(filename,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
            if(stamp(await handle.stat({bigint:true}))!==identity)throw changed();
            const value=await readWavPeaks(handle,Number(stat.size),{check});
            if(stamp(await handle.stat({bigint:true}))!==identity || stamp(await this.io.lstat(filename,{bigint:true}))!==identity || this._file(id,segmentId).filename!==filename)throw changed();
            check();for(const old of this.cache.keys())if(old.startsWith(filename+'\0'))this.cache.delete(old);
            if(saved)this.cache.set(key,{id,value});while(this.cache.size>this.maxEntries)this.cache.delete(this.cache.keys().next().value);
            return value;
          }finally{await handle?.close();}
        }).finally(()=>{this.pending.delete(key);this.scans.delete(scan);});
        this.pending.set(key,task);
      }
      const value=await task;if(this._file(id,segmentId).filename!==filename)throw changed();
      return{id,segmentId,...structuredClone(value)};
    }catch(error){if(error.code?.startsWith('WAVEFORM_'))throw error;throw unavailable();}
    finally{this.requests--;}
  }
  invalidate(id){for(const[key,entry]of this.cache)if(entry.id===id)this.cache.delete(key);for(const scan of this.scans)if(scan.id===id)scan.invalid=true;}
  async close(){this.closed=true;this.cache.clear();await Promise.allSettled([...this.pending.values()]);}
}
module.exports={AudioWaveformService,readWavPeaks,MAX_FILE_BYTES};
