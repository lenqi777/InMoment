'use strict';
const fs = require('node:fs');
const path = require('node:path');
function wavHeader(size, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(size + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(size, 40); return header;
}
class WavWriter {
  constructor(filename, sampleRate = 16000) {
    this.path = filename; this.rate = sampleRate; this.size = 0; this.closed = false; this.startedAt = Date.now();
    fs.mkdirSync(path.dirname(filename), { recursive: true }); this.fd = fs.openSync(filename, 'wx'); fs.writeSync(this.fd, wavHeader(0, sampleRate));
  }
  append(bytes) {
    if (this.closed) throw new Error('音频段已结束。');
    const pcm = Buffer.from(bytes);
    if (pcm.length % 2 || pcm.length > 1024 * 1024 || this.size + pcm.length > 512 * 1024 * 1024) throw new Error('音频数据格式或大小异常。');
    fs.writeSync(this.fd, pcm); this.size += pcm.length;
  }
  finish() {
    if (!this.closed) { fs.writeSync(this.fd, wavHeader(this.size, this.rate), 0, 44, 0); fs.fsyncSync(this.fd); fs.closeSync(this.fd); this.closed = true; }
    return { path: this.path, durationMs: this.size / (this.rate * 2) * 1000, startedAt: this.startedAt, endedAt: Date.now(), size: this.size };
  }
  discard() { try { this.finish(); } finally { fs.rmSync(this.path, { force: true }); } }
}
module.exports = { WavWriter, wavHeader };
