'use strict';
const { performance } = require('node:perf_hooks');

// This is display telemetry, not speech recognition or a voice-activity verdict.
function measurePCM16(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength % 2) throw new Error('音量采样格式无效。');
  const pcm = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let energy = 0, peak = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset) / 32768;
    energy += sample * sample; peak = Math.max(peak, Math.abs(sample));
  }
  return { samples: pcm.length / 2, energy, peak };
}
function displayLevel(rms) {
  if (!Number.isFinite(rms) || rms <= .001) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 54)) ** 1.1;
}

class AudioLevelMeter {
  constructor({ now = () => performance.now(), intervalMs = 50 } = {}) {
    this.now = now; this.intervalMs = Math.max(50, intervalMs);
    this.key = ''; this.lastAt = -Infinity; this.last = null;
    this.energy = 0; this.samples = 0; this.peak = 0;
  }
  push(token, bytes) {
    const key = `${token.sessionId}/${token.segmentId}/${token.epoch}/${token.generation}`;
    if (this.key !== key) { this.key = key; this.lastAt = -Infinity; this.energy = this.samples = this.peak = 0; }
    const measured = measurePCM16(bytes);
    this.energy += measured.energy; this.samples += measured.samples; this.peak = Math.max(this.peak, measured.peak);
    const now = this.now();
    if (!this.samples || now - this.lastAt < this.intervalMs) return null;
    const value = { id: token.sessionId, segmentId: token.segmentId, level: displayLevel(Math.sqrt(this.energy / this.samples)), peak: this.peak };
    this.energy = this.samples = this.peak = 0; this.lastAt = now; this.last = value;
    return value;
  }
  reset(token) {
    this.key = ''; this.lastAt = -Infinity; this.energy = this.samples = this.peak = 0;
    if (!token?.sessionId) return null;
    const value = { id: token.sessionId, segmentId: token.segmentId || null, level: 0, peak: 0 };
    if (this.last?.id === value.id && this.last.segmentId === value.segmentId && this.last.level === 0 && this.last.peak === 0) return null;
    this.last = value;
    return value;
  }
}

module.exports = { AudioLevelMeter, displayLevel, measurePCM16 };
