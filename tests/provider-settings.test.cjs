'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Settings, DEFAULTS, CAPABILITIES } = require('../src/main/settings.cjs');
const { PROVIDERS } = require('../src/core/ai-providers.cjs');
const ids = Object.keys(PROVIDERS);

function fixture(t, initial) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-provider-settings-'));
  const file = path.join(dir, 'settings.json');
  if (initial !== undefined) fs.writeFileSync(file, JSON.stringify(initial, null, 4) + '\r\n');
  const calls = { encrypt: [], decrypt: [], availability: 0 };
  const secure = {
    isEncryptionAvailable() { calls.availability++; return true; },
    encryptString(value) { calls.encrypt.push(value); return Buffer.from('protected-mock:' + value); },
    decryptString(value) { const text = value.toString(); calls.decrypt.push(text); if (!text.startsWith('protected-mock:')) throw new Error('Synthetic unreadable blob'); return text.slice('protected-mock:'.length); },
  };
  const settings = new Settings(dir, secure);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file, secure, settings, calls };
}
const syntheticKeys = { deepseek: 'synthetic-deepseek-key', openai: 'synthetic-openai-key', gemini: 'synthetic-gemini-key' };
function saveAll(fx) {
  return fx.settings.save({ aiProfiles: Object.fromEntries(ids.map(id => [id, { model: PROVIDERS[id].defaultModel, apiKey: syntheticKeys[id] }])) });
}
const protectedSnapshot = settings => structuredClone(settings.value);

test('free Gemini model preference defaults on and persists without changing provider keys', t => {
  const fx = fixture(t);
  assert.equal(fx.settings.public().preferFreeModel, true);
  saveAll(fx);
  const before = protectedSnapshot(fx.settings).aiProfiles;
  fx.settings.save({ aiProvider: 'gemini', preferFreeModel: false });
  assert.equal(new Settings(fx.dir, fx.secure).public().preferFreeModel, false);
  assert.deepEqual(protectedSnapshot(fx.settings).aiProfiles, before);
  assert.throws(() => fx.settings.save({ preferFreeModel: 'false' }), /免费模型/u);
  assert.equal(fx.settings.resetToDefaults().preferFreeModel, true);
});

test('legacy settings migrate only in memory into DeepSeek without decrypting or rewriting the original file', t => {
  const original = { model: 'custom-deepseek-model', apiKeyEncrypted: 'opaque-legacy-protected-data', thresholdMs: 2733, excludedApps: ['reader.exe'] };
  const fx = fixture(t, original); const bytes = fs.readFileSync(fx.file);
  const result = fx.settings.public();
  assert.equal(result.aiProvider, 'deepseek'); assert.equal(result.model, original.model); assert.equal(result.hasApiKey, true);
  assert.deepEqual(result.aiProfiles.deepseek, { model: original.model, hasApiKey: true });
  assert.equal(result.aiProfiles.openai.hasApiKey, false); assert.equal(result.aiProfiles.gemini.hasApiKey, false);
  assert.equal(fx.settings.key('openai'), ''); assert.equal(fx.settings.key('gemini'), '');
  assert.deepEqual(fx.calls.decrypt, []); assert.deepEqual(fx.calls.encrypt, []); assert.equal(fx.calls.availability, 0);
  assert.deepEqual(fs.readFileSync(fx.file), bytes);
  assert.deepEqual(fs.readdirSync(fx.dir), ['settings.json']);
});

test('each provider retains its own encrypted key and model when switching and after restart', t => {
  const fx = fixture(t); saveAll(fx);
  const protectedKeys = Object.fromEntries(ids.map(id => [id, fx.settings.value.aiProfiles[id].apiKeyEncrypted]));
  for (const id of ids) {
    const result = fx.settings.save({ aiProvider: id });
    assert.equal(result.aiProvider, id); assert.equal(result.model, PROVIDERS[id].defaultModel); assert.equal(result.hasApiKey, true);
    assert.equal(fx.settings.key(), syntheticKeys[id]);
    assert.equal(fx.settings.value.apiKeyEncrypted, protectedKeys.deepseek);
    for (const other of ids) assert.equal(fx.settings.value.aiProfiles[other].apiKeyEncrypted, protectedKeys[other]);
  }
  const reloaded = new Settings(fx.dir, fx.secure);
  for (const id of ids) { assert.equal(reloaded.key(id), syntheticKeys[id]); assert.equal(reloaded.public().aiProfiles[id].model, PROVIDERS[id].defaultModel); }
  assert.equal(reloaded.public().aiProvider, 'gemini');
});

test('public metadata is detached and omits plaintext keys, encrypted blobs and unknown stored secret fields', t => {
  const fx = fixture(t, { apiKey: 'accidentally-stored-private-field', privateExtra: { key: 'private-extra' } }); saveAll(fx);
  const result = fx.settings.public(); const serialized = JSON.stringify(result);
  for (const id of ids) {
    assert.deepEqual(Object.keys(result.aiProfiles[id]).sort(), ['hasApiKey', 'model']);
    assert.equal(serialized.includes(syntheticKeys[id]), false); assert.equal(serialized.includes(fx.settings.value.aiProfiles[id].apiKeyEncrypted), false);
  }
  assert.equal(serialized.includes('apiKeyEncrypted'), false); assert.equal(serialized.includes('private-extra'), false); assert.equal(serialized.includes('accidentally-stored-private-field'), false);
  assert.equal(Object.hasOwn(result, 'apiKey'), false); assert.equal(Object.hasOwn(result, 'privateExtra'), false);
  assert.deepEqual(result.aiProviders.map(item => item.id), ids);
  result.aiProfiles.openai.model = 'modified-snapshot'; result.aiProviders[0].models.push('modified-snapshot'); result.excludedApps.push('modified.exe');
  assert.notEqual(fx.settings.public().aiProfiles.openai.model, 'modified-snapshot');
  assert.equal(fx.settings.public().aiProviders[0].models.includes('modified-snapshot'), false); assert.deepEqual(fx.settings.public().excludedApps, []);
  const stored = fs.readFileSync(fx.file, 'utf8');
  for (const id of ids) assert.equal(stored.includes(syntheticKeys[id]), false);
});

test('clearing one provider never clears or falls back to a different provider key', t => {
  const fx = fixture(t); saveAll(fx);
  fx.settings.save({ aiProvider: 'openai', clearApiKey: true });
  assert.equal(fx.settings.key(), ''); assert.equal(fx.settings.public().hasApiKey, false);
  assert.equal(fx.settings.key('deepseek'), syntheticKeys.deepseek); assert.equal(fx.settings.key('gemini'), syntheticKeys.gemini);
  fx.settings.save({ aiProfiles: { deepseek: { clearApiKey: true } } });
  assert.equal(fx.settings.key('deepseek'), ''); assert.equal(fx.settings.value.apiKeyEncrypted, '');
  assert.equal(fx.settings.key('gemini'), syntheticKeys.gemini);
});

test('legacy top-level fields target the newly selected provider and preserve the DeepSeek alias', t => {
  const fx = fixture(t); fx.settings.save({ apiKey: syntheticKeys.deepseek });
  const original = fx.settings.value.apiKeyEncrypted;
  fx.settings.save({ aiProvider: 'openai', model: 'ft:gpt-5.4-mini:sample:project', apiKey: syntheticKeys.openai });
  assert.equal(fx.settings.key(), syntheticKeys.openai); assert.equal(fx.settings.public().model, 'ft:gpt-5.4-mini:sample:project');
  assert.equal(fx.settings.value.apiKeyEncrypted, original); assert.equal(fx.settings.key('deepseek'), syntheticKeys.deepseek);
  fx.settings.save({ aiProvider: 'gemini', aiProfiles: { gemini: { model: 'gemini-custom-preview' } }, apiKey: syntheticKeys.gemini });
  assert.equal(fx.settings.key(), syntheticKeys.gemini); assert.equal(fx.settings.public().model, 'gemini-custom-preview');
});

test('invalid provider or profile patches cannot change memory, disk or protected storage', t => {
  const fx = fixture(t); saveAll(fx); const before = protectedSnapshot(fx.settings), bytes = fs.readFileSync(fx.file); const encryptCount = fx.calls.encrypt.length;
  for (const patch of [
    { aiProvider: 'unknown' }, { aiProvider: null }, { aiProvider: '__proto__' },
    { aiProfiles: null }, { aiProfiles: [] }, { aiProfiles: { openai: null } },
    { aiProfiles: { unknown: { model: 'test-model' } } },
    { aiProfiles: { openai: { apiKeyEncrypted: 'forged-protected-data' } } },
    { aiProfiles: { openai: { clearApiKey: 'true' } } }, { aiProfiles: { gemini: { apiKey: 33 } } },
    { aiProfiles: JSON.parse('{"__proto__":{"model":"forged"}}') },
  ]) {
    assert.throws(() => fx.settings.save(patch));
    assert.deepEqual(fx.settings.value, before); assert.deepEqual(fs.readFileSync(fx.file), bytes);
  }
  assert.equal(fx.calls.encrypt.length, encryptCount);
});

test('all model patches validate before any provider is encrypted or written', t => {
  const fx = fixture(t); saveAll(fx); const before = protectedSnapshot(fx.settings), bytes = fs.readFileSync(fx.file); const count = fx.calls.encrypt.length;
  for (const model of ['', '   ', null, 5, '../not-a-model', 'model/route', 'bad model', 'x'.repeat(101), 'gpt\ninvalid']) {
    assert.throws(() => fx.settings.save({ aiProfiles: { deepseek: { apiKey: 'synthetic-new-key' }, openai: { model } } }), /模型/);
    assert.deepEqual(fx.settings.value, before); assert.deepEqual(fs.readFileSync(fx.file), bytes); assert.equal(fx.calls.encrypt.length, count);
  }
  fx.settings.save({ aiProfiles: { openai: { model: ' ft:gpt-5.4-mini:org:sample ' } } });
  assert.equal(fx.settings.public().aiProfiles.openai.model, 'ft:gpt-5.4-mini:org:sample');
});

test('reset preserves every protected provider blob without accessing OS key protection', t => {
  const fx = fixture(t); saveAll(fx); fx.settings.save({ aiProvider: 'gemini', thresholdMs: 3300, aiProfiles: { deepseek: { model: 'custom-ds' }, openai: { model: 'custom-gpt' }, gemini: { model: 'custom-gemini' } } });
  const blobs = Object.fromEntries(ids.map(id => [id, fx.settings.value.aiProfiles[id].apiKeyEncrypted]));
  for (const method of ['isEncryptionAvailable', 'encryptString', 'decryptString']) fx.secure[method] = () => { throw new Error('Reset must not access key storage'); };
  const result = fx.settings.resetToDefaults();
  assert.equal(result.aiProvider, 'deepseek'); assert.equal(result.thresholdMs, DEFAULTS.thresholdMs);
  for (const id of ids) { assert.equal(fx.settings.value.aiProfiles[id].apiKeyEncrypted, blobs[id]); assert.equal(result.aiProfiles[id].model, PROVIDERS[id].defaultModel); assert.equal(result.aiProfiles[id].hasApiKey, true); }
  assert.equal(fx.settings.value.apiKeyEncrypted, blobs.deepseek);
  const restart = new Settings(fx.dir, fx.secure); assert.deepEqual(restart.public(), result);
});

test('switching service requires renewed approval of all still-enabled scopes and automatic naming', t => {
  const fx = fixture(t); const enabled = Object.fromEntries(Object.keys(CAPABILITIES).map(key => [key, true]));
  fx.settings.save({ ...enabled, autoTitleEnabled: true }, { approvedCapabilities: Object.keys(CAPABILITIES), approvedAutoTitle: true });
  const before = protectedSnapshot(fx.settings), bytes = fs.readFileSync(fx.file);
  assert.throws(() => fx.settings.save({ aiProvider: 'openai' }), /确认/);
  assert.throws(() => fx.settings.save({ aiProvider: 'openai' }, { approvedCapabilities: ['cloudEnabled'] }), /确认/);
  assert.throws(() => fx.settings.save({ aiProvider: 'openai' }, { approvedCapabilities: Object.keys(CAPABILITIES) }), /自动命名/);
  assert.deepEqual(fx.settings.value, before); assert.deepEqual(fs.readFileSync(fx.file), bytes);
  const approved = fx.settings.save({ aiProvider: 'openai' }, { approvedCapabilities: Object.keys(CAPABILITIES), approvedAutoTitle: true });
  assert.equal(approved.aiProvider, 'openai');
  const disabled = Object.fromEntries(Object.keys(CAPABILITIES).map(key => [key, false]));
  assert.doesNotThrow(() => fx.settings.save({ ...disabled, autoTitleEnabled: false, aiProvider: 'gemini' }));
  assert.equal(fx.settings.public().aiProvider, 'gemini');
});

test('a failed atomic write preserves all key profiles and leaves no temporary secret file', t => {
  const fx = fixture(t); saveAll(fx); const before = protectedSnapshot(fx.settings), bytes = fs.readFileSync(fx.file); const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => { if (target === fx.file) throw Object.assign(new Error('Synthetic provider rename failure'), { code: 'EACCES' }); return rename(source, target); });
  assert.throws(() => fx.settings.save({ aiProvider: 'openai', aiProfiles: { deepseek: { clearApiKey: true }, openai: { apiKey: 'synthetic-replacement' } } }), /rename failure/);
  assert.deepEqual(fx.settings.value, before); assert.deepEqual(fs.readFileSync(fx.file), bytes);
  assert.deepEqual(fs.readdirSync(fx.dir), ['settings.json']); assert.equal(fx.settings.writing, false);
});

test('queued saves retain completed updates when a following profile patch fails', async t => {
  const fx = fixture(t);
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => fx.settings.save({ aiProfiles: { deepseek: { apiKey: syntheticKeys.deepseek } } })),
    Promise.resolve().then(() => fx.settings.save({ aiProvider: 'openai', aiProfiles: { openai: { model: 'invalid/model', apiKey: syntheticKeys.openai } } })),
    Promise.resolve().then(() => fx.settings.save({ aiProvider: 'gemini', aiProfiles: { gemini: { apiKey: syntheticKeys.gemini } } })),
  ]);
  assert.deepEqual(outcomes.map(item => item.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(fx.settings.key('deepseek'), syntheticKeys.deepseek); assert.equal(fx.settings.key('openai'), ''); assert.equal(fx.settings.key('gemini'), syntheticKeys.gemini);
  const restarted = new Settings(fx.dir, fx.secure); assert.equal(restarted.public().aiProvider, 'gemini'); assert.equal(restarted.key('deepseek'), syntheticKeys.deepseek);
  assert.equal(fs.readdirSync(fx.dir).some(name => name.endsWith('.tmp')), false);
});

test('decrypt failure for one profile is visible and never tries a different service key', t => {
  const fx = fixture(t); saveAll(fx); fx.settings.value.aiProfiles.openai.apiKeyEncrypted = Buffer.from('bad-protected-mock').toString('base64');
  assert.throws(() => fx.settings.key('openai'), /无法解密/); assert.equal(fx.calls.decrypt.at(-1), 'bad-protected-mock');
  assert.equal(fx.settings.key('gemini'), syntheticKeys.gemini); assert.throws(() => fx.settings.key('unknown'), /服务/);
});

test('unavailable key protection prevents plaintext fallback and leaves existing settings intact', t => {
  const fx = fixture(t); saveAll(fx); const before = protectedSnapshot(fx.settings), bytes = fs.readFileSync(fx.file);
  fx.secure.isEncryptionAvailable = () => false;
  assert.throws(() => fx.settings.save({ aiProvider: 'openai', apiKey: 'synthetic-new-key' }), /系统密钥保护/);
  assert.deepEqual(fx.settings.value, before); assert.deepEqual(fs.readFileSync(fx.file), bytes);
  assert.equal(fs.readdirSync(fx.dir).some(name => name.endsWith('.tmp')), false);
});

test('an encryption failure midway through a multi-provider save applies no partial profile and exposes no sensitive error text', t => {
  const fx = fixture(t); saveAll(fx); const before = protectedSnapshot(fx.settings), bytes = fs.readFileSync(fx.file);
  let encrypted = 0;
  fx.secure.encryptString = value => { encrypted++; if (encrypted === 2) throw new Error('Synthetic private storage diagnostic: ' + value); return Buffer.from('protected-mock:' + value); };
  assert.throws(() => fx.settings.save({ aiProfiles: { deepseek: { apiKey: 'synthetic-new-ds' }, openai: { apiKey: 'synthetic-new-openai' } } }), error => /系统密钥保护/u.test(error.message) && !error.message.includes('synthetic-new-openai'));
  assert.equal(encrypted, 2); assert.deepEqual(fx.settings.value, before); assert.deepEqual(fs.readFileSync(fx.file), bytes);
  assert.equal(fs.readdirSync(fx.dir).some(name => name.endsWith('.tmp')), false);
});
