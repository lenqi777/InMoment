'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { LocalStore } = require('../src/core/store.cjs');
const { CaptureController } = require('../src/main/capture-controller.cjs');
const { NativeBridge } = require('../src/main/native-bridge.cjs');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-controller-shutdown-'));
  const store = new LocalStore(dir);
  const bridge = new EventEmitter();
  const commands = [];
  bridge.request = options.request || (async () => ({}));
  let storeClosed = false;
  const closeStore = () => { if (!storeClosed) { store.close(); storeClosed = true; } };
  const controller = new CaptureController({
    store, bridge,
    settings: { public: () => ({ inputEnabled: true, thresholdMs: 600, excludedApps: [], captureScreenshots: Boolean(options.captureScreenshots) }) },
    sendRecorder: command => commands.push(command), showOverlay() {}, hideOverlay() {},
  });
  t.after(() => {
    options.releasePending?.();
    for (const entry of controller.writers.values()) { try { entry.writer.discard(); } catch {} }
    for (const stop of controller.stops.values()) stop.resolve();
    bridge.removeAllListeners();
    closeStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { controller, store, bridge, commands, closeStore };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('late native fault events after controller and store close cannot access the closed database', async t => {
  const fx = fixture(t);
  await fx.controller.close();
  fx.closeStore();
  assert.doesNotThrow(() => fx.bridge.emit('bridgeFault', { message: 'Expected native child exit' }));
  assert.doesNotThrow(() => fx.bridge.emit('inputFault', { message: 'Late input worker exit' }));
  assert.doesNotThrow(() => fx.bridge.emit('holdEnd', {}));
});

test('shutdown detaches only controller-owned bridge listeners', async t => {
  const fx = fixture(t);
  let externalCalls = 0;
  const external = () => { externalCalls += 1; };
  fx.bridge.on('bridgeFault', external);
  await fx.controller.close();
  assert.equal(fx.bridge.listenerCount('holdStart'), 0);
  assert.equal(fx.bridge.listenerCount('holdEnd'), 0);
  assert.equal(fx.bridge.listenerCount('inputFault'), 0);
  assert.deepEqual(fx.bridge.listeners('bridgeFault'), [external]);
  fx.closeStore();
  fx.bridge.emit('bridgeFault', {});
  assert.equal(externalCalls, 1);
});

test('repeated controller close is safe after database close and does not send new recorder commands', async t => {
  const fx = fixture(t);
  await fx.controller.close();
  const count = fx.commands.length;
  fx.closeStore();
  await assert.doesNotReject(fx.controller.close());
  assert.equal(fx.commands.length, count);
});

test('late recorder IPC and system faults after shutdown are safe no-ops', async t => {
  const fx = fixture(t);
  await fx.controller.close();
  fx.closeStore();
  const token = { sessionId: 'old-session', segmentId: 'old-segment', epoch: 1, generation: 1, kind: 'start' };
  await assert.doesNotReject(fx.controller.segmentStopped({ token, reason: 'pause' }));
  assert.doesNotThrow(() => fx.controller.microphoneFailed({ token, code: 'NotAllowedError' }));
  assert.equal(fx.controller.microphoneReady({ token, sampleRate: 16000 }).allowed, false);
  assert.equal(fx.controller.audioChunk({ token, pcm: new Int16Array([1]).buffer }).accepted, false);
  assert.doesNotThrow(() => fx.controller.fail(new Error('Late lock-screen notification')));
});

test('shutdown waits for final audio and preserves an undecided draft rather than submitting it', async t => {
  const fx = fixture(t);
  await fx.controller.startHold({ title: 'Shutdown audio source' });
  const token = fx.commands.find(command => command.command === 'prepare').token;
  fx.controller.microphoneReady({ token, sampleRate: 16000 });
  fx.controller.audioChunk({ token, pcm: new Int16Array([10, -10, 20, -20]).buffer });
  let closed = false;
  const closing = fx.controller.close().then(() => { closed = true; });
  await nextTurn();
  assert.equal(closed, false);
  await fx.controller.segmentStopped({ token, reason: 'pause' });
  await closing;
  const drafts = fx.store.listDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].segments.length, 1);
  assert.equal(fx.store.listRecords().length, 0);
  fx.closeStore();
  assert.doesNotThrow(() => fx.bridge.emit('bridgeFault', {}));
});

test('shutdown waits for screenshot work before allowing the caller to close SQLite', async t => {
  let resolveCapture;
  const options = {
    captureScreenshots: true,
    request: async (method, params) => {
      if (method !== 'captureWindow') return {};
      return new Promise(resolve => {
        resolveCapture = () => {
          fs.writeFileSync(params.outputPath, Buffer.from('local mock screenshot'));
          resolve({ capturedAt: Date.now() });
        };
      });
    },
    releasePending: () => { resolveCapture?.(); resolveCapture = null; },
  };
  const fx = fixture(t, options);
  const starting = fx.controller.startHold({ hwnd: '42', title: 'Pending shutdown source' });
  await nextTurn();
  assert.equal(fx.commands.some(command => command.command === 'prepare'), false, 'microphone must wait for initial screenshot');
  let closed = false;
  const closing = fx.controller.close().then(() => { closed = true; });
  await nextTurn();
  const waitedForCapture = !closed;
  options.releasePending();
  await Promise.all([starting, closing]);
  assert.equal(waitedForCapture, true, 'close() resolved while screenshot code could still query SQLite');
  fx.closeStore();
  assert.doesNotThrow(() => fx.bridge.emit('bridgeFault', {}));
});

test('intentional native shutdown does not emit an unexpected bridge fault', async () => {
  const bridge = new NativeBridge('not-spawned-in-test');
  let faults = 0;
  bridge.on('bridgeFault', () => { faults += 1; });
  bridge.request = async () => ({});
  // Fake the child exit/error callback without creating a process or enabling input hooks.
  bridge.child = { killed: false, kill: () => bridge.fail('Expected native child exit') };
  await bridge.close();
  assert.equal(faults, 0);
});
