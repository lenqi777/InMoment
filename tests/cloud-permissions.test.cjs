'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Settings } = require('../src/main/settings.cjs');
const { CAPABILITY_INFO, pendingCapabilities, assertCapability, normalizeFilters } = require('../src/main/cloud-permissions.cjs');
const { selectedScreenshot } = require('../src/main/analysis-image.cjs');

function fixture(t, existing = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, '.tmp-consent-'));
  const file = path.join(root, 'settings.json'); const original = JSON.stringify(existing);
  fs.writeFileSync(file, original);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file, original, settings: new Settings(root, { decryptString() { throw new Error('not used'); } }) };
}
test('upgrade adds disabled capability defaults in memory without rewriting custom settings or protected key', t => {
  const fx = fixture(t, { thresholdMs: 2780, cloudEnabled: true, apiKeyEncrypted: 'opaque-fixture', keyboardTrigger: 'F10' });
  assert.equal(fs.readFileSync(fx.file, 'utf8'), fx.original);
  for (const key of ['aiSearchEnabled', 'duplicateAnalysisEnabled', 'screenshotAnalysisEnabled', 'directAIEnabled']) assert.equal(fx.settings.public()[key], false);
  fx.settings.save({ menuDelayMs: 910 });
  assert.equal(fx.settings.value.apiKeyEncrypted, 'opaque-fixture'); assert.equal(fx.settings.public().thresholdMs, 2780);
  assert.equal(fx.settings.public().cloudEnabled, true);
});
test('each new cloud scope requires its own explicit approval and a caller cannot forge consent versions', t => {
  const fx = fixture(t);
  for (const [key, info] of Object.entries(CAPABILITY_INFO)) {
    assert.throws(() => fx.settings.save({ [key]: true, [info.version]: 1 }), /确认/);
    fx.settings.save({ [key]: true }, { approvedCapabilities: [key] });
    assert.equal(fx.settings.public()[info.version], 1);
    assertCapability({ ...fx.settings.public(), cloudEnabled: true, hasApiKey: true }, key, { networkDisabled: false });
    fx.settings.save({ [key]: false });
    assert.equal(fx.settings.public()[info.version], 0);
    assert.throws(() => assertCapability({ ...fx.settings.public(), hasApiKey: true }, key, { networkDisabled: false }), /确认/);
  }
});
test('development network lock precedes all enabled permissions', () => {
  assert.throws(() => assertCapability({ cloudEnabled: true, hasApiKey: true }, 'cloudEnabled', { networkDisabled: true }), /测试模式/);
  assert.deepEqual(pendingCapabilities({ cloudEnabled: true }, { cloudEnabled: true, aiSearchEnabled: true }), ['aiSearchEnabled']);
  assert.throws(() => assertCapability({ cloudEnabled: false, aiSearchEnabled: true, aiSearchConsentVersion: 1, hasApiKey: true }, 'aiSearchEnabled', { networkDisabled: false }), /总开关/);
});
test('date and theme scope validates explicit bounds and does not widen the range', () => {
  assert.deepEqual(normalizeFilters({ from: 10, to: 20, topicIds: ['topic-a', 'topic-a'], ignored: 'unused' }), { from: 10, to: 20, topicIds: ['topic-a'], uncategorized: false });
  assert.throws(() => normalizeFilters({ from: 20, to: 10 }), /结束日期/);
  assert.throws(() => normalizeFilters({ topicIds: ['../escape'] }), /主题/);
  assert.throws(() => normalizeFilters({ from: NaN }), /日期/);
  assert.deepEqual(normalizeFilters({ topicIds: ['topic-a'], unclassified: true }), { topicIds: ['topic-a'], uncategorized: true });
  assert.deepEqual(normalizeFilters({ uncategorized: false, unclassified: false }), { uncategorized: false });
  assert.throws(() => normalizeFilters({ uncategorized: 'true' }), /未分类/);
  assert.throws(() => normalizeFilters({ uncategorized: false, unclassified: true }), /冲突/);
});
test('screenshot input is limited to the selected saved record and actual bounded PNG bytes', t => {
  const fx = fixture(t); const file = path.join(fx.root, 'synthetic.png');
  const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.write('IHDR', 12); png.writeUInt32BE(100, 16); png.writeUInt32BE(100, 20); fs.writeFileSync(file, png);
  const store = { safePath(value) { assert.equal(value, file); return value; } };
  assert.equal(selectedScreenshot(store, { status: 'saved', screenshots: [{ path: file }] }).base64, png.toString('base64'));
  assert.throws(() => selectedScreenshot(store, { status: 'draft', screenshots: [{ path: file }] }), /已保存/);
  png.writeUInt32BE(8193, 16); fs.writeFileSync(file, png);
  assert.throws(() => selectedScreenshot(store, { status: 'saved', screenshots: [{ path: file }] }), /边长/);
  fs.writeFileSync(file, Buffer.alloc(25));
  assert.throws(() => selectedScreenshot(store, { status: 'saved', screenshots: [{ path: file }] }), /PNG/);
});
