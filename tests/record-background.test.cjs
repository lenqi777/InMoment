'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { LocalStore } = require('../src/core/store.cjs');
const { CaptureController } = require('../src/main/capture-controller.cjs');
const { sourceWebUrl } = require('../src/main/record-background.cjs');

function fixture(t, captureScreenshots = false) {
  const root = fs.mkdtempSync(path.join(__dirname, '.tmp-background-'));
  const store = new LocalStore(root);
  const bridge = new EventEmitter();
  bridge.request = async method => {
    if (method === 'captureWindow') throw new Error('Synthetic protected window');
    return {};
  };
  const controller = new CaptureController({ store, bridge, settings: { public: () => ({ inputEnabled: false, captureScreenshots, excludedApps: [] }) }, sendRecorder() {}, showOverlay() {}, hideOverlay() {} });
  t.after(async () => {
    for (const stop of controller.stops.values()) stop.resolve();
    await controller.close(); store.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { controller, store };
}

test('an available web address becomes private background metadata even with source images switched off', async t => {
  const { controller, store } = fixture(t);
  const { id } = await controller.startHold({ hwnd: '1', pid: 2, title: 'Browser tab' });
  await controller.collectBackgroundUrl(id, Promise.resolve({ url: 'https://example.test/note', selectedText: 'transient context' }));
  assert.deepEqual(store.getDraft(id).source, { hwnd: '1', pid: 2, title: 'Browser tab', url: 'https://example.test/note' });
  assert.deepEqual(store.getDraft(id).screenshots, []);
  assert.equal(store.getRecord(id), null);
});

test('source screenshot failure stays visible and a late URL cannot resurrect a discarded capture', async t => {
  const { controller, store } = fixture(t, true);
  const { id, segmentId } = await controller.startHold({ hwnd: '1', pid: 2 });
  assert.equal(controller.snapshot().captureStatus, 'unavailable');
  assert.equal(store.getDraft(id).source.screenshotUnavailable, true);
  const reading = Promise.withResolvers();
  const collected = controller.collectBackgroundUrl(id, reading.promise);
  controller.microphoneFailed({ token: controller.stops.get(segmentId).token, code: 'NotAllowedError' });
  const discarded = controller.discard();
  reading.resolve({ url: 'https://example.test/late' });
  await Promise.all([collected, discarded]);
  assert.equal(store.getDraft(id), null);
  assert.equal(store.getRecord(id), null);
});

test('source URLs accept web links and exclude local, executable and credentialed addresses', () => {
  assert.equal(sourceWebUrl('https://example.test/路径'), 'https://example.test/%E8%B7%AF%E5%BE%84');
  for (const url of ['file:///C:/test.exe', 'javascript:alert(1)', 'https:query', 'https://user:password@example.test/', 'search terms']) assert.equal(sourceWebUrl(url), '');
});
