'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { LocalStore } = require('../src/core/store.cjs');
const { CaptureController } = require('../src/main/capture-controller.cjs');
const { STATES } = require('../src/core/recording-session.cjs');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-controller-'));
  const store = new LocalStore(dir);
  const commands = [];
  const bridge = new EventEmitter();
  bridge.request = options.request || (async () => ({}));
  const settings = { public: () => ({ inputEnabled: true, thresholdMs: 600, excludedApps: [], captureScreenshots: Boolean(options.captureScreenshots) }) };
  const controller = new CaptureController({ store, bridge, settings, sendRecorder: command => commands.push(command), showOverlay() {}, hideOverlay() {} });
  t.after(() => {
    for (const entry of controller.writers.values()) { try { entry.writer.discard(); } catch {} }
    for (const stop of controller.stops.values()) stop.resolve();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { controller, store, bridge, commands, dir };
}

async function recording(fx) {
  await fx.controller.startHold({ title: 'Original source' });
  const token = fx.commands.find(command => command.command === 'prepare').token;
  assert.equal(fx.controller.microphoneReady({ token, sampleRate: 16000 }).allowed, true);
  fx.controller.audioChunk({ token, pcm: new Int16Array([100, -100, 200, -200]).buffer });
  return token;
}

test('a manual recording creates an independent draft and never reuses a saved capture', async t => {
  const fx = fixture(t);
  fx.store.createDraft({ id: 'old-thought', source: { title: 'Old scene' } });
  const topic = fx.store.createTopic('产品设计'); fx.store.setRecordTopics('old-thought', [topic.id]);
  fx.store.complete('old-thought');
  const started = await fx.controller.startManual();
  assert.notEqual(started.id, 'old-thought');
  const draft = fx.store.getDraft(started.id);
  assert.equal(draft.parentId, null); assert.deepEqual(draft.screenshots, []);
  assert.deepEqual(draft.topics, []); assert.match(draft.source.title, /未自动采集来源/u);
  const token = fx.commands.find(command => command.command === 'prepare').token;
  fx.controller.microphoneReady({ token, sampleRate: 16000 });
  fx.controller.audioChunk({ token, pcm: new Int16Array([100, -100]).buffer });
  fx.controller.pause(); await fx.controller.segmentStopped({ token });
  await fx.controller.previewText();
  const saved = await fx.controller.finish('继续思考的文字');
  assert.equal(saved.parentId, null); assert.deepEqual(fx.store.getRecord('old-thought').continuations, []);
  assert.equal(fx.store.listRecords().length, 2);
});

test('an empty accidental capture cannot be completed and remains available for discard', async t => {
  const fx = fixture(t);
  await fx.controller.startHold({ title: 'No audio or image' });
  const token = fx.commands.find(command => command.command === 'prepare').token;
  fx.controller.pause(true); await fx.controller.segmentStopped({ token });
  await assert.rejects(() => fx.controller.finish(), /还没有录音/u);
  assert.equal(fx.controller.session.state, STATES.PAUSED); assert.equal(fx.store.listRecords().length, 0);
  await fx.controller.discard(); assert.equal(fx.store.listDrafts().length, 0);
});

test('completion waits for final audio before moving the one saved record', async t => {
  const fx = fixture(t);
  const token = await recording(fx);
  fx.controller.pause(true);
  fx.controller.setRetention({ keepAudio: true, keepText: false });
  const finish = fx.controller.finish();
  await Promise.resolve();
  assert.equal(fx.store.listRecords().length, 0);
  assert.equal(fx.controller.session.state, STATES.COMMITTING);
  await fx.controller.segmentStopped({ token, reason: 'pause' });
  const saved = await finish;
  assert.equal(saved.segments.length, 1);
  assert.equal(saved.segments[0].durationMs, 0.25);
  assert.equal(fx.store.listRecords().length, 1);
  assert.equal((await fx.controller.finish()).id, saved.id);
});

test('manual continuation records with no held button and ignores native right release', async t => {
  const fx = fixture(t);
  const first = await recording(fx);
  fx.controller.pause(true);
  await fx.controller.segmentStopped({ token: first, reason: 'pause' });
  fx.controller.continueRecording();
  const second = fx.commands.filter(command => command.command === 'prepare').at(-1).token;
  assert.equal(fx.controller.session.rightHeld, false);
  assert.equal(fx.controller.microphoneReady({ token: second, sampleRate: 16000 }).allowed, true);
  fx.bridge.emit('holdEnd');
  assert.equal(fx.controller.session.state, STATES.RECORDING_MANUAL);
  fx.controller.pause();
  assert.equal(fx.controller.session.state, STATES.PAUSED);
  await fx.controller.segmentStopped({ token: second, reason: 'pause' });
});

const regionImage = {
  bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64'),
  width: 1, height: 1, capturedAt: 1000,
};

test('region selection starts a single manual draft that can save a later screenshot after microphone denial', async t => {
  const fx = fixture(t, { captureScreenshots: false });
  const source = { processName: 'Fixture' }, url = 'https://example.test/';
  const started = fx.controller.startRegion(source, Promise.resolve({ url }));
  await Promise.all(fx.controller.pending);
  assert.equal(started.rawState, STATES.ARMING_MANUAL);
  assert.equal(started.context.trigger, 'region-screenshot');
  const draft = fx.store.getDraft(started.id);
  assert.equal(draft.source.url, url);
  assert.equal(draft.screenshots.length, 0);
  assert.equal(fx.store.listRecords().length, 0);
  assert.throws(() => fx.controller.startRegion(source), /当前录音/u);
  const command = fx.commands.find(item => item.command === 'prepare');
  assert.equal(command.mode, 'manual');
  fx.bridge.emit('holdEnd');
  assert.equal(fx.controller.session.state, STATES.ARMING_MANUAL);
  fx.controller.microphoneFailed({ token: command.token, code: 'NotAllowedError' });
  assert.match(fx.controller.snapshot().error, /麦克风未获授权/u);
  fx.controller.saveRegionScreenshot(started.id, regionImage);
  assert.equal(fx.controller.snapshot().state, 'paused');
  const saved = await fx.controller.finish();
  assert.equal(saved.screenshots.length, 1);
  assert.equal(saved.screenshots[0].method, 'region');
  assert.equal(saved.screenshots[0].capturedAt, 1000);
  assert.deepEqual(fs.readFileSync(fx.store.safePath(saved.screenshots[0].path)), regionImage.bytes);
  assert.equal(saved.segments.length, 0);
});

test('region screenshot write failure leaves the live audio draft and can retry without restarting it', async t => {
  const fx = fixture(t);
  const started = fx.controller.startRegion({});
  const token = fx.commands.at(-1).token;
  assert.equal(fx.controller.microphoneReady({ token, sampleRate: 16000 }).allowed, true);
  const failure = t.mock.method(fx.store, 'addScreenshot', () => { throw new Error('synthetic disk write failure'); });
  assert.throws(() => fx.controller.saveRegionScreenshot(started.id, regionImage), /截图未能保存/u);
  assert.equal(fx.store.getDraft(started.id).screenshots.length, 0);
  assert.equal(fx.controller.snapshot().state, 'recording');
  failure.mock.restore();
  fx.controller.saveRegionScreenshot(started.id, regionImage);
  assert.equal(fx.controller.snapshot().state, 'recording');
  const imagePath = fx.store.safePath(fx.store.getDraft(started.id).screenshots[0].path);
  fx.controller.pause();
  await fx.controller.segmentStopped({ token });
  await fx.controller.discard();
  assert.equal(fs.existsSync(imagePath), false);
  assert.throws(() => fx.controller.saveRegionScreenshot(started.id, regionImage), /已结束/u);
});

for (const action of ['confirm', 'cancel']) test(`region ${action} expands the same live draft with all audio intact`, async t => {
  const { controller, commands, store } = fixture(t);
  const updates = [];
  controller.on('session', session => updates.push(session));
  const draft = controller.startRegion({});
  assert.equal(draft.regionScreenshotOpen, true);
  const { token } = commands.at(-1);
  assert.equal(controller.microphoneReady({ token, sampleRate: 16000 }).allowed, true);
  const pcmSecond = new Int16Array(16000).fill(900).buffer;
  for (let second = 0; second < 3; second++) assert.equal(controller.audioChunk({ token, pcm: pcmSecond }).accepted, true);
  const before = controller.snapshot();
  assert.ok(Number.isFinite(before.recordingStartedAt));
  if (action === 'confirm') {
    controller.saveRegionScreenshot(draft.id, regionImage);
    assert.equal(updates.at(-1).recordingStartedAt, before.recordingStartedAt);
  }
  assert.equal(controller.finishRegionScreenshot('another-draft'), false);
  assert.equal(controller.finishRegionScreenshot(draft.id), true);
  assert.equal(controller.finishRegionScreenshot(draft.id), false);
  const after = updates.at(-1);
  assert.equal(after.id, before.id);
  assert.equal(after.segmentId, before.segmentId);
  assert.equal(after.state, 'recording');
  assert.equal(after.recordingStartedAt, before.recordingStartedAt);
  assert.equal(after.regionScreenshotOpen, false);
  assert.deepEqual(commands.map(command => command.command), ['prepare']);
  assert.equal(controller.audioChunk({ token, pcm: pcmSecond }).accepted, true);
  controller.pause();
  await controller.segmentStopped({ token, reason: 'pause' });
  const savedDraft = store.getDraft(draft.id);
  assert.equal(savedDraft.segments.length, 1);
  assert.equal(savedDraft.segments[0].durationMs, 4000);
  assert.equal(savedDraft.screenshots.length, action === 'confirm' ? 1 : 0);
  assert.equal(controller.snapshot().elapsedMs, 4000);
  assert.equal(controller.snapshot().recordingStartedAt, null);
});

test('late screenshot and audio callbacks after discard cannot recreate draft content', async t => {
  let finishCapture;
  let capturePath;
  const fx = fixture(t, { captureScreenshots: true, request: async (method, params) => {
    if (method !== 'captureWindow') return {};
    capturePath = params.outputPath;
    return new Promise(resolve => { finishCapture = () => { fs.writeFileSync(capturePath, 'fake screenshot'); resolve({ capturedAt: Date.now() }); }; });
  } });
  const start = fx.controller.startHold({ hwnd: '123', title: 'Private window' });
  await new Promise(resolve => setImmediate(resolve));
  fx.controller.pause(true);
  fx.controller.continueRecording();
  const token = fx.commands.find(command => command.command === 'prepare').token;
  fx.controller.microphoneReady({ token, sampleRate: 16000 });
  fx.controller.audioChunk({ token, pcm: new Int16Array([100, -100]).buffer });
  const discarded = fx.controller.discard();
  assert.equal(fx.controller.audioChunk({ token, pcm: new Int16Array([1]).buffer }).accepted, false);
  await fx.controller.segmentStopped({ token, reason: 'discard' });
  finishCapture();
  await Promise.all([start, discarded]);
  assert.equal(fs.existsSync(capturePath), false);
  assert.equal(fx.store.listDrafts().length, 0);
  assert.equal(fx.store.listRecords().length, 0);
  assert.equal(fx.controller.writers.size, 0);
});

test('getUserMedia failure during initial arming pauses and settles completion barrier', async t => {
  const fx = fixture(t);
  await fx.controller.startHold({});
  const token = fx.commands[0].token;
  fx.controller.microphoneFailed({ token, code: 'NotAllowedError' });
  assert.equal(fx.controller.session.state, STATES.PAUSED);
  assert.equal(fx.controller.stops.size, 0);
  assert.match(fx.controller.snapshot().error, /未获授权/);
});

test('audio initialization failure after ready pauses instead of remaining in recording', async t => {
  const fx = fixture(t);
  const token = await recording(fx);
  fx.controller.microphoneFailed({ token, code: 'AudioError' });
  assert.equal(fx.controller.session.state, STATES.PAUSED);
  assert.equal(fx.controller.stops.size, 0);
  assert.equal(fx.controller.writers.size, 0);
});

test('failed final audio persistence settles the stop barrier and reports failure', async t => {
  const fx = fixture(t);
  const token = await recording(fx);
  fx.controller.pause(true);
  fx.store.addSegment = () => { throw new Error('Simulated disk failure'); };
  await assert.rejects(fx.controller.segmentStopped({ token, reason: 'pause' }), /disk failure/);
  assert.equal(fx.controller.stops.size, 0);
  assert.match(fx.controller.snapshot().error, /disk failure|保存|写入|收尾/);
});

test('failure enabling the global trigger is visible instead of silently looking ready', async t => {
  const fx = fixture(t, { request: async () => { throw new Error('inert test configure failure'); } });
  const statuses = []; fx.controller.on('inputStatus', status => statuses.push(status));
  const result = await fx.controller.refreshTrigger();
  assert.equal(result.hookAvailable, false); assert.equal(statuses[0].available, false);
  assert.match(fx.controller.snapshot().error, /右键监听/);
  assert.equal(fx.store.listDrafts().length, 0); assert.equal(fx.commands.length, 0);
});
