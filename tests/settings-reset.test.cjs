'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Settings, DEFAULTS } = require('../src/main/settings.cjs');
const { DEFAULT_REGION_SHORTCUT } = require('../src/main/region-shortcut.cjs');

const encryptedFixture = 'opaque-ciphertext-fixture-not-a-real-key';
function resetValueWithKey() {
  const value = structuredClone(DEFAULTS); value.apiKeyEncrypted = encryptedFixture; value.aiProfiles.deepseek.apiKeyEncrypted = encryptedFixture; return value;
}

function fixture(t, { existing = true } = {}) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-settings-reset-'));
  const config = {
    ...structuredClone(DEFAULTS), previewDelayMs: 700, thresholdMs: 2500, captureDelayMs: 900,
    menuDelayMs: 1200, keyboardTrigger: 'F9', excludedApps: ['example-app'], captureScreenshots: false,
    inputEnabled: false, cloudEnabled: true, autoTitleEnabled: true, autoTitleConsentVersion: 1,
    model: 'custom-local-model-name', apiKeyEncrypted: encryptedFixture, obsoleteOption: 'must reset',
  };
  if (existing) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(config));
  const storageCalls = [];
  const protectedStorage = Object.fromEntries(['isEncryptionAvailable', 'encryptString', 'decryptString'].map(name => [name, () => { storageCalls.push(name); throw new Error('Protected storage unavailable in reset test'); }]));
  const settings = new Settings(dir, protectedStorage);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, config, settings, protectedStorage, storageCalls };
}

test('screenshot visibility preference is local, defaults hidden and persists without AI consent',t=>{
  const f=fixture(t,{existing:false});assert.equal(f.settings.public().screenshotKeepChatVisible,false);
  f.settings.save({screenshotKeepChatVisible:true});assert.equal(new Settings(f.dir,f.protectedStorage).public().screenshotKeepChatVisible,true);assert.deepEqual(f.storageCalls,[]);
  assert.throws(()=>f.settings.save({screenshotKeepChatVisible:'false'}),/截图窗口选项/u);assert.equal(f.settings.public().screenshotKeepChatVisible,true);
  f.settings.resetToDefaults();assert.equal(f.settings.public().screenshotKeepChatVisible,false);
});

test('screenshot recording shortcuts migrate, validate, and restore the default independently of long-press keys', t => {
  const f = fixture(t, { existing: false });
  const legacy = '{"keyboardTrigger":"F8"}\n';
  fs.writeFileSync(f.settings.path, legacy);
  const loaded = new Settings(f.dir, f.protectedStorage);
  assert.equal(loaded.public().regionScreenshotShortcut, DEFAULT_REGION_SHORTCUT);
  assert.equal(fs.readFileSync(f.settings.path, 'utf8'), legacy);
  assert.equal(loaded.save({ regionScreenshotShortcut: ' shift ＋ ctrl + 7 ' }).regionScreenshotShortcut, 'Ctrl+Shift+7');
  assert.equal(loaded.public().keyboardTrigger, 'F8');
  assert.equal(new Settings(f.dir, f.protectedStorage).public().regionScreenshotShortcut, 'Ctrl+Shift+7');
  for (const shortcut of ['F9', 'Ctrl+X', 'Alt+F4', 'Ctrl+ctrl+F8', 'Ctrl+Shift+F13', '', null, {}, 'Ctrl+Shift+F9\nAlt+F2']) {
    assert.throws(() => loaded.save({ regionScreenshotShortcut: shortcut }), { code: 'REGION_SHORTCUT' });
    assert.equal(loaded.public().regionScreenshotShortcut, 'Ctrl+Shift+7');
  }
  assert.equal(loaded.resetToDefaults().regionScreenshotShortcut, DEFAULT_REGION_SHORTCUT);
  assert.deepEqual(f.storageCalls, []);
});

test('reset restores every default while preserving the existing encrypted key in its DeepSeek profile and legacy alias', t => {
  const fx = fixture(t);
  const result = fx.settings.resetToDefaults();
  assert.deepEqual(fx.settings.value, resetValueWithKey());
  assert.equal(result.cloudEnabled, false);
  assert.equal(result.autoTitleEnabled, false);
  assert.equal(result.autoTitleConsentVersion, 0);
  assert.equal(result.hasApiKey, true);
  assert.equal(Object.hasOwn(result, 'apiKeyEncrypted'), false);
  assert.equal(JSON.stringify(result).includes(encryptedFixture), false);
  assert.deepEqual(fx.storageCalls, []);
  assert.equal(fs.readdirSync(fx.dir).filter(name => name.endsWith('.tmp')).length, 0);
});

test('reset persists defaults across restart without requiring available OS key protection', t => {
  const fx = fixture(t);
  const expected = fx.settings.resetToDefaults();
  const reloaded = new Settings(fx.dir, fx.protectedStorage);
  assert.deepEqual(reloaded.public(), expected);
  assert.equal(reloaded.value.apiKeyEncrypted, encryptedFixture);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fx.dir, 'settings.json'), 'utf8')), resetValueWithKey());
  assert.deepEqual(fx.storageCalls, []);
});

test('reset never modifies existing record, audio or unrelated sentinel files', t => {
  const fx = fixture(t);
  const sentinels = new Map([
    [path.join(fx.dir, 'inmoment.sqlite'), Buffer.from('synthetic-database-sentinel')],
    [path.join(fx.dir, 'records', 'record-1', 'audio.wav'), Buffer.from([0, 10, 40, 255])],
    [path.join(fx.dir, 'drafts', 'draft-1', 'screenshot.png'), Buffer.from('synthetic-image-sentinel')],
    [path.join(fx.dir, 'other.json'), Buffer.from('{"keep":true}')],
  ]);
  for (const [file, bytes] of sentinels) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  fx.settings.resetToDefaults();
  for (const [file, bytes] of sentinels) assert.deepEqual(fs.readFileSync(file), bytes);
});

test('reset revokes automatic naming consent and re-enabling requires a fresh explicit approval', t => {
  const fx = fixture(t);
  fx.settings.resetToDefaults();
  assert.throws(() => fx.settings.save({ autoTitleEnabled: true, autoTitleConsentVersion: 1 }), /确认/);
  assert.equal(fx.settings.public().autoTitleEnabled, false);
  assert.equal(fx.settings.public().autoTitleConsentVersion, 0);
  fx.settings.save({ autoTitleEnabled: true }, { approvedAutoTitle: true });
  assert.equal(fx.settings.public().autoTitleEnabled, true);
  assert.equal(fx.settings.public().autoTitleConsentVersion, 1);
  assert.equal(fx.settings.public().cloudEnabled, false);
  assert.deepEqual(fx.storageCalls, []);
});

test('reset has no caller-controlled key preservation or clearing options', t => {
  const fx = fixture(t);
  const result = fx.settings.resetToDefaults({ clearApiKey: true, apiKeyEncrypted: 'replacement-not-used', apiKey: 'replacement-not-used', thresholdMs: 9000 });
  assert.equal(fx.settings.value.apiKeyEncrypted, encryptedFixture);
  assert.equal(result.thresholdMs, DEFAULTS.thresholdMs);
  assert.deepEqual(fx.storageCalls, []);
});

test('failed atomic replacement keeps the old disk and memory settings and removes its temporary file', t => {
  const fx = fixture(t);
  const originalBytes = fs.readFileSync(fx.settings.path);
  const originalPublic = fx.settings.public();
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === fx.settings.path) throw Object.assign(new Error('Simulated settings rename failure'), { code: 'EACCES' });
    return rename(source, destination);
  });
  assert.throws(() => fx.settings.resetToDefaults(), /rename failure/);
  assert.deepEqual(fs.readFileSync(fx.settings.path), originalBytes);
  assert.deepEqual(fx.settings.public(), originalPublic);
  assert.equal(fs.readdirSync(fx.dir).filter(name => name.endsWith('.tmp')).length, 0);
  assert.throws(() => fx.settings.save({ thresholdMs: 850 }), /rename failure/);
  assert.deepEqual(fs.readFileSync(fx.settings.path), originalBytes);
  assert.deepEqual(fx.settings.public(), originalPublic);
  assert.equal(fs.readdirSync(fx.dir).filter(name => name.endsWith('.tmp')).length, 0);
});

test('reset of a new installation creates defaults without inventing a key', t => {
  const fx = fixture(t, { existing: false });
  const result = fx.settings.resetToDefaults();
  assert.equal(result.hasApiKey, false);
  assert.deepEqual(fx.settings.value, structuredClone(DEFAULTS));
  assert.deepEqual(fx.storageCalls, []);
});

test('loading an existing custom configuration never writes, normalizes or resets its original bytes', t => {
  const fx = fixture(t, { existing: false });
  const legacy = {
    previewDelayMs: 845, thresholdMs: 3456, captureDelayMs: 1375, menuDelayMs: 1870,
    keyboardTrigger: 'F10', excludedApps: ['custom-reader.exe', 'custom-browser'],
    captureScreenshots: false, inputEnabled: false, cloudEnabled: true,
    model: 'user-selected-model', apiKeyEncrypted: encryptedFixture,
  };
  const originalBytes = Buffer.from(JSON.stringify(legacy, null, 4) + '\r\n', 'utf8');
  fs.writeFileSync(fx.settings.path, originalBytes);
  const loaded = new Settings(fx.dir, fx.protectedStorage);
  for (const [key, value] of Object.entries(legacy)) assert.deepEqual(loaded.value[key], value);
  assert.equal(loaded.public().thresholdMs, 3456);
  assert.deepEqual(loaded.public().excludedApps, legacy.excludedApps);
  assert.equal(loaded.public().hasApiKey, true);
  assert.deepEqual(fs.readFileSync(fx.settings.path), originalBytes);
  assert.deepEqual(fs.readdirSync(fx.dir), ['settings.json']);
  assert.deepEqual(fx.storageCalls, []);
});
