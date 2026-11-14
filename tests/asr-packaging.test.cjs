'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ASR_ASSETS, copyOfflineASR, verifyOfflineASR } = require('../scripts/asr-packaging.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(__dirname, '.tmp-asr-packaging-'));
  t.after(() => {
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), __dirname); assert.ok(path.basename(absolute).startsWith('.tmp-asr-packaging-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  return directory;
}
function write(root, relative, content) {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
}
function syntheticASR(root) {
  const assets = structuredClone(ASR_ASSETS);
  assets.files = assets.files.map(file => {
    const content = Buffer.from('synthetic ASR component: ' + file.path);
    write(root, file.path, content);
    return { ...file, bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') };
  });
  const manifest = { schemaVersion: 2 };
  for (const key of ['provider', 'version', 'model', 'modelRevision', 'precision', 'binaryPath', 'modelPath', 'tokensPath']) manifest[key] = assets[key];
  write(root, 'asr.json', JSON.stringify(manifest)); write(root, 'PROVENANCE.json', JSON.stringify(assets));
  return assets;
}

test('ASR packaging copies the pinned runtime/model/license allowlist and excludes legacy/private data', t => {
  const directory = fixture(t), source = path.join(directory, 'source'), destination = path.join(directory, 'bundle');
  const assets = syntheticASR(source);
  write(source, 'models/ggml-base.bin', 'synthetic legacy model'); write(source, 'bin/whisper-cli.exe', 'legacy');
  write(source, 'backups/asr.json', '{}'); write(source, 'downloads/model.part', 'partial');
  write(source, 'jobs/private.wav', 'synthetic audio'); write(source, 'settings.json', '{"syntheticPrivateSetting":true}');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'asr.json'))); manifest.syntheticPrivateSetting = 'must not ship';
  write(source, 'asr.json', JSON.stringify(manifest));
  const provenance = JSON.parse(fs.readFileSync(path.join(source, 'PROVENANCE.json'))); provenance.privatePath = 'must not ship';
  write(source, 'PROVENANCE.json', JSON.stringify(provenance));
  copyOfflineASR(source, destination, { assets });
  verifyOfflineASR(destination, { assets });
  for (const relative of ['models/ggml-base.bin', 'bin/whisper-cli.exe', 'backups', 'downloads', 'jobs', 'settings.json']) assert.equal(fs.existsSync(path.join(destination, relative)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'asr.json'))).syntheticPrivateSetting, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, 'PROVENANCE.json'))), assets);
  assert.throws(() => copyOfflineASR(source, destination, { assets }), /already exists/u);
});

test('ASR packaging rejects damaged files and old manifests before creating a package', t => {
  const directory = fixture(t), source = path.join(directory, 'source'), destination = path.join(directory, 'bundle');
  const assets = syntheticASR(source);
  const model = path.join(source, assets.modelPath); const original = fs.readFileSync(model); const corrupt = Buffer.from(original); corrupt[0] ^= 1; fs.writeFileSync(model, corrupt);
  assert.throws(() => copyOfflineASR(source, destination, { assets }), /integrity mismatch/u);
  assert.equal(fs.existsSync(destination), false); fs.writeFileSync(model, original);
  write(source, 'asr.json', '{"provider":"whisper.cpp","model":"base"}');
  assert.throws(() => copyOfflineASR(source, destination, { assets }), /explicit SenseVoice setup to upgrade/u);
  assert.equal(fs.existsSync(destination), false);
});

test('portable ASR verification rejects unexpected payloads, paths and provenance changes', t => {
  const directory = fixture(t), source = path.join(directory, 'source'); const assets = syntheticASR(source);
  write(source, 'unexpected.wav', 'synthetic audio'); assert.throws(() => verifyOfflineASR(source, { assets }), /Unexpected ASR package file/u);
  fs.unlinkSync(path.join(source, 'unexpected.wav'));
  write(source, 'PROVENANCE.json', '{}'); assert.throws(() => verifyOfflineASR(source, { assets }), /provenance metadata/u);
  write(source, 'PROVENANCE.json', JSON.stringify(assets));
  const escaping = structuredClone(assets); escaping.files[0].path = '../outside.exe'; write(directory, 'outside.exe', 'synthetic outside');
  assert.throws(() => verifyOfflineASR(source, { assets: escaping, strict: false }), /Unsafe ASR component path/u);
});
