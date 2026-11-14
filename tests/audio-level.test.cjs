'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { LocalStore } = require('../src/core/store.cjs');
const { CaptureController } = require('../src/main/capture-controller.cjs');
const { AudioLevelMeter, measurePCM16 } = require('../src/main/audio-level.cjs');

function pcm(values) { return Buffer.from(Int16Array.from(values).buffer); }
const constant = value => pcm(Array(1024).fill(value));
const token = { sessionId: 'test-session', segmentId: 'test-session-1', epoch: 1, generation: 1 };

test('actual PCM silence, low amplitude and louder amplitude produce ordered numeric levels', () => {
  let time = 0; const meter = new AudioLevelMeter({ now: () => time });
  const quiet = meter.push(token, constant(0)); time += 60;
  const low = meter.push(token, constant(200)); time += 60;
  const speech = meter.push(token, constant(2000)); time += 60;
  const loud = meter.push(token, constant(12000)); time += 60;
  const clipped = meter.push(token, constant(-32768));
  assert.equal(quiet.level, 0); assert.equal(quiet.peak, 0);
  assert.ok(low.level > 0 && low.level < speech.level && speech.level < loud.level && loud.level <= clipped.level);
  assert.ok(speech.level >= .3 && speech.level <= .8);
  assert.equal(clipped.level, 1); assert.equal(clipped.peak, 1);
  for (const value of [quiet, low, speech, loud, clipped]) { assert.deepEqual(Object.keys(value).sort(), ['id', 'level', 'peak', 'segmentId']); assert.ok(Number.isFinite(value.level) && value.level >= 0 && value.level <= 1); }
  assert.deepEqual(measurePCM16(pcm([0, 16384, -16384, -32768])), { samples: 4, energy: 1.5, peak: 1 });
});

test('20 Hz throttle aggregates skipped samples and resets immediately without timers', () => {
  let time = 0; const meter = new AudioLevelMeter({ now: () => time });
  meter.push(token, constant(0));
  time = 10; assert.equal(meter.push(token, constant(16384)), null);
  time = 30; assert.equal(meter.push(token, constant(0)), null);
  time = 49; assert.equal(meter.push(token, constant(0)), null);
  time = 50; const accepted = meter.push(token, constant(0));
  assert.equal(accepted.peak, .5); assert.ok(accepted.level > 0);
  time = 51; assert.equal(meter.push(token, constant(2000)), null);
  const reset = meter.reset(token); assert.equal(reset.level, 0); assert.equal(reset.peak, 0);
  assert.equal(meter.reset(token), null, 'Repeated reset does not introduce extra animation samples.');
  assert.ok(meter.push({ ...token, segmentId: 'test-session-2', generation: 3 }, constant(2000)).level > 0, 'New segment emits immediately.');
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(__dirname, '.tmp-audio-level-')), store = new LocalStore(directory);
  let time = 0;
  const bridge = new EventEmitter(); bridge.request = async () => ({});
  const commands = [], levels = [];
  const controller = new CaptureController({ store, bridge, settings: { public: () => ({ inputEnabled: false, captureScreenshots: false }) }, sendRecorder: value => commands.push(value), showOverlay() {}, hideOverlay() {}, now: () => time });
  controller.on('audioLevel', value => levels.push(value));
  t.after(async () => { for (const stop of controller.stops.values()) stop.resolve(); await controller.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, controller, commands, levels, advance(ms = 64) { time += ms; } };
}
async function start(h) {
  await h.controller.startHold({ title: 'Synthetic source' });
  const token = h.commands.filter(command => command.command === 'prepare').at(-1).token;
  assert.equal(h.controller.microphoneReady({ token, sampleRate: 16000 }).allowed, true);
  return token;
}
function chunk(h, token, bytes) { return h.controller.audioChunk({ token, pcm: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }

test('live PCM drives levels while paused final PCM stays in the WAV without waking the capsule', async t => {
  const h = fixture(t), token = await start(h), first = constant(2000), tail = pcm([300, -400, 500]);
  assert.equal(chunk(h, token, first).accepted, true); assert.ok(h.levels.at(-1).level > 0);
  h.controller.pause(true); assert.equal(h.levels.at(-1).level, 0); assert.equal(h.levels.at(-1).peak, 0);
  const afterPause = h.levels.length; h.advance(); assert.equal(chunk(h, token, tail).accepted, true);
  assert.equal(h.levels.length, afterPause);
  await h.controller.segmentStopped({ token, reason: 'pause' });
  h.controller.setRetention({ keepAudio: true, keepText: false });
  const record = await h.controller.finish();
  assert.deepEqual(fs.readFileSync(record.segments[0].path).subarray(44), Buffer.concat([first, tail]));
  assert.equal(h.levels.at(-1).level, 0);
  assert.equal(JSON.stringify(record).includes('audioLevel'), false);
});

test('wrong epoch, wrong generation and old segment cannot drive current live telemetry', async t => {
  const h = fixture(t), first = await start(h), bytes = constant(4000);
  assert.equal(h.controller.snapshot().segmentId, first.segmentId);
  const before = h.levels.length;
  assert.equal(chunk(h, { ...first, epoch: first.epoch + 1 }, bytes).accepted, false);
  assert.equal(chunk(h, { ...first, generation: first.generation + 1 }, bytes).accepted, false);
  assert.equal(chunk(h, { ...first, segmentId: 'unrelated-segment' }, bytes).accepted, false);
  assert.equal(h.levels.length, before);
  chunk(h, first, bytes); h.controller.pause(true); h.controller.continueRecording();
  const second = h.commands.filter(command => command.command === 'prepare').at(-1).token;
  assert.equal(h.controller.snapshot().segmentId, second.segmentId);
  h.controller.microphoneReady({ token: second, sampleRate: 16000 }); h.advance(); chunk(h, second, bytes);
  const activeLevel = h.levels.at(-1), count = h.levels.length;
  h.advance(); assert.equal(chunk(h, first, constant(12000)).accepted, true, 'An old segment may finish its legitimate file flush.');
  await h.controller.segmentStopped({ token: first, reason: 'pause' });
  assert.equal(h.levels.length, count); assert.equal(h.levels.at(-1), activeLevel);
  h.controller.pause(); await h.controller.segmentStopped({ token: second, reason: 'pause' });
});

test('discard resets before cleanup, rejects late chunks and never returns a positive level', async t => {
  const h = fixture(t), token = await start(h); chunk(h, token, constant(5000));
  const discarded = h.controller.discard();
  assert.equal(h.levels.at(-1).level, 0);
  const afterDiscard = h.levels.length; h.advance(); assert.equal(chunk(h, token, constant(9000)).accepted, false);
  await h.controller.segmentStopped({ token, reason: 'discard' }); await discarded;
  assert.equal(h.levels.length, afterDiscard); assert.equal(h.store.listDrafts().length, 0);
});

test('device failure, device-ended stop and controller close each reset the live level', async t => {
  for (const action of ['failure', 'ended', 'close']) {
    const h = fixture(t), token = await start(h); chunk(h, token, constant(5000)); assert.ok(h.levels.at(-1).level > 0);
    if (action === 'failure') h.controller.microphoneFailed({ token, code: 'AudioError' });
    else if (action === 'ended') await h.controller.segmentStopped({ token, reason: 'device-ended' });
    else { const closing = h.controller.close(); assert.equal(h.controller.snapshot().segmentId, null); assert.equal(h.levels.at(-1).level, 0); await h.controller.segmentStopped({ token, reason: 'pause' }); await closing; }
    assert.equal(h.levels.at(-1).level, 0); assert.equal(h.levels.at(-1).peak, 0);
  }
});

test('PCM worklet emits at 1024 samples and final flush preserves every original sample', () => {
  let Processor; const messages = [];
  class Base { constructor() { this.port = { postMessage(value) { messages.push(value); } }; } }
  const context = vm.createContext({ AudioWorkletProcessor: Base, Float32Array, registerProcessor(name, type) { assert.equal(name, 'inmoment-pcm'); Processor = type; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/recorder/pcm-worklet.js'), 'utf8'), context);
  const worklet = new Processor(), original = Float32Array.from({ length: 2460 }, (_, index) => Math.sin(index / 9) * .3);
  for (let offset = 0; offset < 1024; offset += 128) worklet.process([[original.subarray(offset, offset + 128)]]);
  assert.equal(messages.length, 1); assert.equal(messages[0].samples.length, 1024);
  for (let offset = 1024; offset < original.length; offset += 128) worklet.process([[original.subarray(offset, Math.min(original.length, offset + 128))]]);
  worklet.port.onmessage({ data: 'flush' });
  assert.equal(messages.at(-1).flushed, true);
  const combined = messages.filter(message => message.samples).flatMap(message => Array.from(message.samples));
  assert.deepEqual(combined, Array.from(original)); assert.equal(worklet.process([[new Float32Array(128)]]), false);
});

test('main-process sound telemetry is sent only to overlay and contains no extra capture data', () => {
  const filename = path.join(__dirname, '../src/main/main.cjs'), localRequire = createRequire(filename), events = [];
  const electron = { app: { setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on() {} }, protocol: { registerSchemesAsPrivileged() {} } };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : localRequire(name), __dirname: path.dirname(filename), process: { platform: 'win32', env: {}, execPath: process.execPath }, Buffer, URL, Response, AbortController, console });
  vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nglobalThis.levelTest={sendOverlayAudioLevel,init(windows){mainWindow=windows.main;chatWindow=windows.chat;overlay=windows.overlay;}};', context);
  const window = name => ({ isDestroyed: () => false, webContents: { send(channel, value) { events.push({ name, channel, value }); } } });
  context.levelTest.init({ main: window('main'), chat: window('chat'), overlay: window('overlay') });
  context.levelTest.sendOverlayAudioLevel({ id: 'one', segmentId: 'one-1', level: .4, peak: .5, pcm: new Uint8Array([1, 2]), transcript: 'must not be forwarded' });
  assert.equal(events.length, 1); assert.equal(events[0].name, 'overlay');
  assert.deepEqual(JSON.parse(JSON.stringify(events[0].value)), { type: 'audioLevel', id: 'one', segmentId: 'one-1', level: .4, peak: .5 });
  context.levelTest.init({ main: window('main'), chat: window('chat'), overlay: { isDestroyed: () => false, webContents: { send() { throw new Error('Synthetic closing renderer'); } } } });
  assert.doesNotThrow(() => context.levelTest.sendOverlayAudioLevel({ id: 'one', segmentId: 'one-1', level: 0, peak: 0 }));
});
