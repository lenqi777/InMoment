'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');

const helperPath = path.join(__dirname, '..', 'build', 'native', 'InMoment.Native.exe');
const skipReason = process.platform !== 'win32'
  ? 'Windows-only native helper'
  : !existsSync(helperPath) ? 'Build the helper with npm run native:build first' : false;

test('native self-test probes capabilities without taking a screenshot or recording audio', { skip: skipReason, timeout: 10000 }, () => {
  const probe = spawnSync(helperPath, ['--self-test'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0);
  const result = JSON.parse(probe.stdout.replace(/^\uFEFF/, '').trim());
  assert.equal(result.ok, true);
  assert.equal(result.win32Available, true);
  assert.equal(result.pointerBits, 64);
  assert.ok(Array.isArray(result.speechEngines));
  assert.equal(result.screenshotTest, 'not-run');
  assert.equal(result.microphoneTest, 'not-run');
  assert.equal(result.hookTest, 'not-installed');
});

test('native JSON protocol rejects unsafe targets, reports capabilities, and shuts down', { skip: skipReason, timeout: 15000 }, async () => {
  const child = spawn(helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  let stderr = '';
  const lines = createInterface({ input: child.stdout });
  const closed = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', data => { stderr += data; });
  const rejectPending = error => {
    for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(error); }
    pending.clear();
  };
  child.on('error', rejectPending);
  child.on('exit', () => rejectPending(new Error('Native helper exited before replying')));
  lines.on('line', line => {
    let result;
    try { result = JSON.parse(line.replace(/^\uFEFF/, '')); }
    catch (error) { rejectPending(error); return; }
    const wait = pending.get(result.id);
    if (wait) { clearTimeout(wait.timer); pending.delete(result.id); wait.resolve(result); }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native request timed out: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    // Keep capture disabled. No test sends real pointer input or requests a real image.
    const config = await request('configure', { enabled: false, thresholdMs: 650, excludedApps: ['electron.exe'] });
    assert.equal(config.ok, true);
    assert.equal(config.result.enabled, false);
    assert.equal(config.result.thresholdMs, 650);
    assert.deepEqual(config.result.excludedApps, ['electron']);
    assert.equal(config.result.triggerVersion, 3);
    assert.equal(typeof config.result.hookThreadAlive, 'boolean');
    assert.equal(typeof config.result.keyboardHookAvailable, 'boolean');
    const stages = await request('configure', { enabled: false, previewDelayMs: 5000, thresholdMs: 10000, keyboardTrigger: 'F8' });
    assert.equal(stages.result.previewDelayMs, 5000);
    assert.equal(stages.result.thresholdMs, 10000);
    assert.equal(stages.result.keyboardTrigger, 'F8');
    const invalidKey = await request('configure', { keyboardTrigger: 'F7', previewDelayMs: 0 });
    assert.equal(invalidKey.ok, false);
    assert.equal(invalidKey.error.code, 'INVALID_PARAMS');
    const unchanged = await request('configure');
    assert.equal(unchanged.result.keyboardTrigger, 'F8');
    assert.equal(unchanged.result.previewDelayMs, 5000);
    for (const keyboardTrigger of ['F9', 'F10', 'none']) {
      const option = await request('configure', { enabled: false, keyboardTrigger, previewDelayMs: 0 });
      assert.equal(option.result.keyboardTrigger, keyboardTrigger);
    }
    // Burst configuration is processed in stdin order, even when unrelated native
    // work uses the ThreadPool. Keep every request disabled: this test never arms capture.
    await Promise.all([520, 610, 720].map(thresholdMs => request('configure', { enabled: false, thresholdMs })));
    const finalConfig = await request('configure');
    assert.equal(finalConfig.result.thresholdMs, 720);
    assert.equal(finalConfig.result.enabled, false);
    const engines = await request('speechEngines');
    assert.equal(engines.ok, true);
    assert.ok(Array.isArray(engines.result.engines));
    const source = await request('foreground');
    assert.equal(source.ok, true);
    assert.match(source.result.hwnd, /^\d+$/);
    assert.equal(typeof source.result.pid, 'number');
    assert.equal(typeof source.result.title, 'string');
    const invalidCapture = await request('captureWindow', { hwnd: '0', outputPath: path.join(__dirname, 'unused.png') });
    assert.equal(invalidCapture.ok, false);
    assert.equal(invalidCapture.error.code, 'INVALID_WINDOW');
    const invalidFocus = await request('focusWindow', { hwnd: '0', pid: 1 });
    assert.equal(invalidFocus.ok, false);
    assert.equal(invalidFocus.error.code, 'INVALID_WINDOW');
    if (source.result.hwnd !== '0' && source.result.pid > 0) {
      const wrongPid = source.result.pid === 0xffffffff ? 1 : source.result.pid + 1;
      const mismatch = await request('focusWindow', { hwnd: source.result.hwnd, pid: wrongPid });
      assert.equal(mismatch.ok, false);
      assert.ok(['WINDOW_IDENTITY_MISMATCH', 'WINDOW_UNAVAILABLE'].includes(mismatch.error.code));
    }
    const unavailableLanguage = await request('transcribe', { language: 'xx-InMoment-unavailable', audioPaths: [] });
    assert.equal(unavailableLanguage.ok, false);
    assert.equal(unavailableLanguage.error.code, 'CAPABILITY_UNAVAILABLE');
    const unknown = await request('not-a-method');
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, 'UNKNOWN_METHOD');
    const productionTestHook = await request('testMouseInput');
    assert.equal(productionTestHook.ok, false);
    assert.equal(productionTestHook.error.code, 'UNKNOWN_METHOD');
    const stop = await request('shutdown');
    assert.equal(stop.ok, true);
    assert.equal(stop.result.stopped, true);
    const exit = await closed;
    assert.equal(exit.code, 0);
    assert.equal(stderr, '');
  } finally {
    lines.close();
    child.stdin.destroy();
    if (child.exitCode === null) child.kill();
    rejectPending(new Error('Native test completed'));
  }
});
