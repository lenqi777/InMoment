'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function invalid(message = '录音文件不是完整的单声道 PCM WAV，无法本地转写。') {
  return Object.assign(new Error(message), { code: 'ASR_AUDIO_INVALID' });
}

async function readExactly(file, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw invalid();
    offset += bytesRead;
  }
  return buffer;
}

async function inspectWav(file) {
  const stat = await file.stat();
  if (stat.size < 44) throw invalid();
  const header = await readExactly(file, 12, 0);
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw invalid();
  const limit = header.readUInt32LE(4) + 8;
  if (limit > stat.size || limit < 44) throw invalid();
  let format, data;
  for (let position = 12; position + 8 <= limit;) {
    const chunk = await readExactly(file, 8, position);
    const size = chunk.readUInt32LE(4), start = position + 8;
    if (start + size > limit) throw invalid();
    const kind = chunk.toString('ascii', 0, 4);
    if (kind === 'fmt ') {
      if (size < 16) throw invalid();
      const fmt = await readExactly(file, 16, start);
      const sampleRate = fmt.readUInt32LE(4);
      if (fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1 || fmt.readUInt16LE(12) !== 2
        || fmt.readUInt16LE(14) !== 16 || sampleRate < 8000 || sampleRate > 192000 || fmt.readUInt32LE(8) !== sampleRate * 2) throw invalid();
      format = { sampleRate };
    } else if (kind === 'data') {
      if (data || !size || size % 2) throw invalid();
      data = { offset: start, bytes: size };
    }
    position = start + size + size % 2;
  }
  if (!format || !data) throw invalid();
  return { ...format, ...data, frames: data.bytes / 2 };
}

function wavHeader(sampleRate, bytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + bytes, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(bytes, 40);
  return header;
}

// Every sample is retained. Prefer a pause near 22 seconds and cap each input at 28 seconds.
function splitFrame(pcm, sampleRate) {
  const frames = pcm.length / 2;
  const block = Math.max(1, Math.round(sampleRate * .02));
  const threshold = 32768 ** 2 * 10 ** (-35 / 10);
  let quietStart = null, selected = null, bestDistance = Infinity;
  const consider = end => {
    if (quietStart === null || end - quietStart < sampleRate * .3) return;
    const middle = Math.round((quietStart + end) / 2);
    if (middle < sampleRate * 12 || middle > sampleRate * 28) return;
    const distance = Math.abs(middle - sampleRate * 22);
    if (distance < bestDistance) { selected = middle; bestDistance = distance; }
  };
  for (let start = 0; start < frames; start += block) {
    const end = Math.min(frames, start + block);
    let energy = 0;
    for (let i = start; i < end; i++) { const value = pcm.readInt16LE(i * 2); energy += value * value; }
    if (energy / (end - start) < threshold) { if (quietStart === null) quietStart = start; }
    else { consider(start); quietStart = null; }
  }
  consider(frames);
  return selected || frames;
}

async function prepareAudioSegments(segments, directory, { checkCancelled = () => {} } = {}) {
  const parts = [], originals = [];
  for (const segment of segments) {
    checkCancelled();
    if (typeof segment?.id !== 'string' || !segment.id || typeof segment.path !== 'string' || path.extname(segment.path).toLowerCase() !== '.wav') throw invalid();
    let file;
    try { file = await fs.open(segment.path, 'r'); }
    catch { throw Object.assign(new Error('录音文件已不可用。'), { code: 'AUDIO_UNAVAILABLE' }); }
    try {
      const info = await inspectWav(file);
      originals.push({ id: segment.id, durationMs: info.frames / info.sampleRate * 1000 });
      const maximumFrames = Math.floor(info.sampleRate * 28);
      for (let offset = 0; offset < info.frames;) {
        checkCancelled();
        const remaining = info.frames - offset;
        const pcm = await readExactly(file, Math.min(maximumFrames, remaining) * 2, info.offset + offset * 2);
        const count = remaining > maximumFrames ? splitFrame(pcm, info.sampleRate) : pcm.length / 2;
        const name = `part-${String(parts.length).padStart(6, '0')}.wav`;
        checkCancelled();
        await fs.writeFile(path.join(directory, name), Buffer.concat([wavHeader(info.sampleRate, count * 2), pcm.subarray(0, count * 2)]), { flag: 'wx' });
        parts.push({ name, segmentId: segment.id, startMs: offset / info.sampleRate * 1000, endMs: (offset + count) / info.sampleRate * 1000 });
        offset += count;
      }
    } finally { await file.close(); }
  }
  checkCancelled();
  return { parts, originals };
}

module.exports = { prepareAudioSegments };
