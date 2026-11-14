'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeVoiceActivity } = require('../src/main/voice-activity.cjs');
function wav(samples, rate = 16000) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, index) => bytes.writeInt16LE(value, 44 + index * 2)); return bytes;
}
function fixture(t, values) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inmoment-voice-test-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return values.map((value, index) => { const filename = path.join(directory, 'synthetic-' + index + '.wav'); fs.writeFileSync(filename, value); return { id: String(index), path: filename }; });
}
test('digital silence across all original segments is confidently empty without deleting input', async t => {
  const segments = fixture(t, [wav(Array(16000).fill(0)), wav(Array(8000).fill(1))]);
  const result = await analyzeVoiceActivity(segments);
  assert.equal(result.decision, 'empty'); assert.equal(result.method, 'pcm-silence'); assert.equal(result.durationMs, 1500); assert.equal(result.samples, 24000); assert.equal(result.peak, 1);
  assert.equal(segments.every(segment => fs.existsSync(segment.path)), true);
});
test('quiet speech-like activity, single click, noise and tone stay uncertain rather than being discarded', async t => {
  const cases = [Array.from({ length: 16000 }, (_, i) => Math.round(Math.sin(i * .035) * 3)), [...Array(15999).fill(0), 9], Array.from({ length: 16000 }, (_, i) => ((i * 47) % 31) - 15), Array.from({ length: 16000 }, (_, i) => Math.round(Math.sin(i * .1) * 2000))];
  for (const samples of cases) assert.equal((await analyzeVoiceActivity(fixture(t, [wav(samples)]))).decision, 'uncertain');
});
test('empty headers and no segments are empty while malformed WAV is a failure that preserves data', async t => {
  assert.equal((await analyzeVoiceActivity([])).decision, 'empty');
  assert.equal((await analyzeVoiceActivity(fixture(t, [wav([])]))).decision, 'empty');
  const invalid = wav([0, 1, 2]); invalid.writeUInt32LE(1000000, 40);
  const segments = fixture(t, [invalid]); await assert.rejects(analyzeVoiceActivity(segments), { code: 'VOICE_AUDIO_INVALID' }); assert.equal(fs.existsSync(segments[0].path), true);
});
test('cancelled checks do no file work and do not report empty', async () => {
  const stop = new AbortController(); stop.abort();
  await assert.rejects(analyzeVoiceActivity([{ path: 'never-open.wav' }], { signal: stop.signal }), { name: 'AbortError' });
});
