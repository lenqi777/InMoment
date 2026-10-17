'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { LocalStore } = require('../src/core/store.cjs');
const { CaptureController } = require('../src/main/capture-controller.cjs');

test('PCM write failure retains previously captured audio and cannot silently complete', async t => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-controller-write-'));
  const store = new LocalStore(dir);
  const bridge = new EventEmitter(); bridge.request = async () => ({});
  const commands = [];
  const controller = new CaptureController({ store, bridge,
    settings: { public: () => ({ inputEnabled: true, thresholdMs: 550, excludedApps: [], captureScreenshots: false }) },
    sendRecorder: command => commands.push(command), showOverlay() {}, hideOverlay() {},
  });
  t.after(() => {
    for (const entry of controller.writers.values()) { try { entry.writer.finish(); } catch {} }
    for (const stop of controller.stops.values()) stop.resolve();
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  await controller.startHold({ title: 'Mock audio failure source' });
  const token = commands.find(command => command.command === 'prepare').token;
  controller.microphoneReady({ token, sampleRate: 16000 });
  controller.audioChunk({ token, pcm: new Int16Array([100, -100, 200, -200]).buffer });
  const entry = controller.writers.get(token.segmentId);
  const stagingPath = entry.writer.path;
  entry.writer.append = () => { throw new Error('Mock disk write failure'); };
  assert.throws(() => controller.audioChunk({ token, pcm: new Int16Array([1, -1]).buffer }), /disk write failure/);
  // Reproduce main IPC's fault notification followed by renderer's rejected-chunk callback.
  controller.fail(new Error('Mock disk write failure'));
  controller.microphoneFailed({ token, code: 'AudioWriteError' });
  const draft = store.getDraft(token.sessionId);
  const retained = fs.existsSync(stagingPath) || draft.segments.some(segment => fs.existsSync(segment.path));
  assert.equal(retained, true, 'Previously recorded PCM was destroyed by a later write failure');
  assert.ok(controller.persistenceError, 'Completion must know this segment failed rather than silently omit it');
  await assert.rejects(controller.finish());
  assert.equal(store.listRecords().length, 0);
});
