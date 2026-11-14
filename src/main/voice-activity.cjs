'use strict';

const fs = require('node:fs/promises');

function invalid() { return Object.assign(new Error('无法检查录音，原始录音已保留。'), { code: 'VOICE_AUDIO_INVALID' }); }
function check(signal) { if (signal?.aborted) throw Object.assign(new Error('语音检查已取消。'), { name: 'AbortError' }); }
async function read(file, length, position, signal) {
  check(signal);
  const bytes = Buffer.alloc(length); let offset = 0;
  while (offset < length) { const next = await file.read(bytes, offset, length - offset, position + offset); check(signal); if (!next.bytesRead) throw invalid(); offset += next.bytesRead; }
  return bytes;
}

// Deliberately conservative: PCM energy can establish digital silence, not human speech.
// Audible/quiet activity remains uncertain until ASR or a separately installed VAD decides.
async function analyzeVoiceActivity(segments, { signal } = {}) {
  check(signal);
  if (!Array.isArray(segments) || segments.some(segment => typeof segment?.path !== 'string')) throw invalid();
  let samples = 0, energy = 0, peak = 0, activeSamples = 0, durationMs = 0;
  for (const segment of segments) {
    check(signal);
    const file = await fs.open(segment.path, 'r').catch(() => { throw invalid(); });
    try {
      const stat = await file.stat(), header = await read(file, 12, 0, signal);
      if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8) !== 'WAVE') throw invalid();
      const limit = header.readUInt32LE(4) + 8;
      if (limit > stat.size || limit < 44) throw invalid();
      let sampleRate = 0, data = null;
      for (let position = 12; position + 8 <= limit;) {
        const chunk = await read(file, 8, position, signal), length = chunk.readUInt32LE(4), start = position + 8;
        if (start + length > limit) throw invalid();
        if (chunk.toString('ascii', 0, 4) === 'fmt ') {
          if (length < 16) throw invalid();
          const format = await read(file, 16, start, signal); sampleRate = format.readUInt32LE(4);
          if (format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt16LE(12) !== 2 || format.readUInt16LE(14) !== 16
            || sampleRate < 8000 || sampleRate > 192000 || format.readUInt32LE(8) !== sampleRate * 2) throw invalid();
        } else if (chunk.toString('ascii', 0, 4) === 'data') { if (data || length % 2) throw invalid(); data = { offset: start, length }; }
        position = start + length + length % 2;
      }
      if (!sampleRate || !data) throw invalid();
      durationMs += data.length / 2 / sampleRate * 1000;
      for (let offset = 0; offset < data.length;) {
        const pcm = await read(file, Math.min(65536, data.length - offset), data.offset + offset, signal);
        for (let index = 0; index < pcm.length; index += 2) { const value = Math.abs(pcm.readInt16LE(index)); peak = Math.max(peak, value); energy += value * value; if (value > 2) activeSamples++; samples++; }
        offset += pcm.length;
      }
    } finally { await file.close(); }
  }
  check(signal);
  const rms = samples ? Math.sqrt(energy / samples) : 0;
  return { decision: peak <= 2 ? 'empty' : 'uncertain', method: 'pcm-silence', samples, durationMs, peak, rms, activeSamples };
}

module.exports = { analyzeVoiceActivity };
