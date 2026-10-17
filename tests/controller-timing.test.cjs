'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { LocalStore } = require('../src/core/store.cjs');
const { CaptureController } = require('../src/main/capture-controller.cjs');
const { Settings } = require('../src/main/settings.cjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, timing = {}) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-timing-'));
  const store = new LocalStore(dir), bridge = new EventEmitter();
  const commands = [], requests = [], shown = [];
  let finishCapture;
  bridge.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'captureWindow') return new Promise(resolve => { finishCapture = () => { fs.writeFileSync(params.outputPath, 'synthetic-image-bytes'); resolve({ capturedAt: Date.now() }); }; });
    return { enabled: params.enabled, hookAvailable: true };
  };
  const settings = { public: () => ({ inputEnabled: true, thresholdMs: 1500, previewDelayMs: 1000, captureDelayMs: 100, menuDelayMs: 200, keyboardTrigger: 'F8', captureScreenshots: true, excludedApps: [], ...timing }) };
  const controller = new CaptureController({ store, bridge, settings, sendRecorder: command => commands.push(command), showOverlay: () => shown.push(true), hideOverlay() {} });
  t.after(async () => { controller.cancelHoldDelays(); finishCapture?.(); for (const stop of controller.stops.values()) stop.resolve(); await controller.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, bridge, settings, controller, commands, requests, shown, finishCapture: () => { finishCapture(); finishCapture = null; } };
}

test('configured capture and menu waits precede microphone preparation and retain trigger identity', async t => {
  const fx = fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  const starting = fx.controller.startHold({ hwnd: '42', trigger: 'F8' });
  t.mock.timers.tick(99); await flush();
  assert.equal(fx.requests.some(item => item.method === 'captureWindow'), false); assert.equal(fx.commands.length, 0);
  t.mock.timers.tick(1); await flush();
  assert.equal(fx.requests.filter(item => item.method === 'captureWindow').length, 1);
  assert.equal(fx.commands.length, 0); fx.finishCapture(); await flush();
  t.mock.timers.tick(199); await flush(); assert.equal(fx.commands.length, 0); assert.equal(fx.shown.length, 0);
  t.mock.timers.tick(1); await starting;
  assert.equal(fx.commands[0].command, 'prepare'); assert.equal(fx.shown.length, 1);
  assert.equal(fx.controller.snapshot().triggerKey, 'F8');
});

test('release during capture delay cancels future screenshot and microphone without waiting for the timer', async t => {
  const fx = fixture(t, { captureDelayMs: 5000 }); t.mock.timers.enable({ apis: ['setTimeout'] });
  const starting = fx.controller.startHold({ hwnd: '42', trigger: 'right-button' });
  fx.bridge.emit('holdEnd', { trigger: 'right-button' }); await starting;
  assert.equal(fx.controller.snapshot().state, 'paused');
  t.mock.timers.tick(10000); await flush();
  assert.equal(fx.requests.some(item => item.method === 'captureWindow'), false);
  assert.equal(fx.commands.some(item => item.command === 'prepare'), false);
});

test('release during menu delay keeps the captured context but never starts a late microphone', async t => {
  const fx = fixture(t, { captureDelayMs: 0, menuDelayMs: 5000 }); t.mock.timers.enable({ apis: ['setTimeout'] });
  const starting = fx.controller.startHold({ hwnd: '42', trigger: 'F9' }); await flush();
  fx.finishCapture(); await flush(); fx.bridge.emit('holdEnd', { trigger: 'F9' }); await starting;
  t.mock.timers.tick(10000); await flush();
  assert.equal(fx.controller.snapshot().state, 'paused');
  assert.equal(fx.store.listDrafts()[0].screenshots.length, 1);
  assert.equal(fx.commands.some(item => item.command === 'prepare'), false);
});

test('discard and close revoke stage timers before cleanup, so delayed callbacks cannot restart capture', async t => {
  const fx = fixture(t, { captureDelayMs: 5000 }); t.mock.timers.enable({ apis: ['setTimeout'] });
  const starting = fx.controller.startHold({ hwnd: '42' }); await fx.controller.discard(); await starting;
  assert.equal(fx.store.listDrafts().length, 0);
  const again = fx.controller.startHold({ hwnd: '42' }); await fx.controller.close(); await again; fx.store.close();
  t.mock.timers.tick(10000); await flush();
  assert.equal(fx.commands.some(item => item.command === 'prepare'), false);
  assert.equal(fx.requests.some(item => item.method === 'captureWindow'), false);
});

test('trigger refresh passes timing and shortcut options to the native helper', async t => {
  const fx = fixture(t); await fx.controller.refreshTrigger();
  const request = fx.requests.find(item => item.method === 'configure');
  assert.equal(request.params.previewDelayMs, 1000); assert.equal(request.params.thresholdMs, 1500); assert.equal(request.params.keyboardTrigger, 'F8');
  fx.controller.disableGlobalInput = true; await fx.controller.refreshTrigger();
  assert.equal(fx.requests.at(-1).params.enabled, false, 'desktop smoke must never arm actual hardware capture');
});

test('timing settings persist extended values and reject unsupported ordinary keys', t => {
  const fx = fixture(t); const settings = new Settings(fx.dir, {});
  settings.save({ previewDelayMs: 1000, thresholdMs: 1500, captureDelayMs: 1500, menuDelayMs: 1000, keyboardTrigger: 'F10' });
  const saved = new Settings(fx.dir, {}).public();
  assert.equal(saved.previewDelayMs, 1000); assert.equal(saved.thresholdMs, 1500); assert.equal(saved.captureDelayMs, 1500); assert.equal(saved.menuDelayMs, 1000); assert.equal(saved.keyboardTrigger, 'F10');
  assert.throws(() => settings.save({ keyboardTrigger: 'A' }), /功能键/);
  assert.throws(() => settings.save({ captureDelayMs: Infinity }), /有限/);
  assert.equal(new Settings(fx.dir, {}).public().keyboardTrigger, 'F10');
});

for (const operation of ['release', 'discard', 'close']) test(`zero-delay ${operation} in the same event batch prevents the pending screenshot from starting`, async t => {
  const fx = fixture(t, { captureDelayMs: 0, menuDelayMs: 0 });
  const starting = fx.controller.startHold({ hwnd: '42' });
  if (operation === 'release') fx.bridge.emit('holdEnd');
  else if (operation === 'discard') await fx.controller.discard();
  else await fx.controller.close();
  await starting;
  assert.equal(fx.requests.some(item => item.method === 'captureWindow'), false);
  assert.equal(fx.commands.some(item => item.command === 'prepare'), false);
});
