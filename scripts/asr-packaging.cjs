'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const ASR_ASSETS = require('./asr-assets.json');

function safeFile(root, relative) {
  const directory = fs.realpathSync(root); const absolute = path.resolve(directory, relative);
  const inside = path.relative(directory, absolute);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Unsafe ASR component path.');
  for (let current = absolute; current !== directory; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('ASR component contains a link: ' + relative);
  }
  const resolved = fs.realpathSync(absolute); const resolvedRelative = path.relative(directory, resolved);
  if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative) || !fs.statSync(resolved).isFile()) throw new Error('Unsafe ASR component: ' + relative);
  return resolved;
}

function fileDigest(filename) {
  const hash = crypto.createHash('sha256'); const descriptor = fs.openSync(filename, 'r'); const buffer = Buffer.alloc(1024 * 1024);
  try { let length; while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length)); }
  finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function verifyOfflineASR(directory, { assets = ASR_ASSETS, strict = true } = {}) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(fs.readFileSync(safeFile(root, 'asr.json'), 'utf8'));
  for (const key of ['provider', 'version', 'model', 'modelRevision', 'precision', 'binaryPath', 'modelPath', 'tokensPath']) {
    if (manifest[key] !== assets[key]) throw new Error('Unexpected ASR configuration. Run the explicit SenseVoice setup to upgrade the installation.');
  }
  const allowlist = new Set(['asr.json', 'PROVENANCE.json', ...assets.files.map(file => file.path)]);
  const provenance = JSON.parse(fs.readFileSync(safeFile(root, 'PROVENANCE.json'), 'utf8'));
  if (strict && !isDeepStrictEqual(provenance, assets)) throw new Error('Unexpected ASR provenance metadata.');
  for (const file of assets.files) {
    const filename = safeFile(root, file.path);
    if (fs.statSync(filename).size !== file.bytes || fileDigest(filename) !== file.sha256) throw new Error('ASR component integrity mismatch: ' + file.path);
  }
  if (strict) {
    function visit(current) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const filename = path.join(current, entry.name);
        if (entry.isSymbolicLink()) throw new Error('ASR package contains a link.');
        if (entry.isDirectory()) visit(filename);
        else if (!allowlist.has(path.relative(root, filename).split(path.sep).join('/'))) throw new Error('Unexpected ASR package file: ' + path.relative(root, filename));
      }
    }
    visit(root);
  }
  return manifest;
}

function copyOfflineASR(source, destination, { assets = ASR_ASSETS } = {}) {
  verifyOfflineASR(source, { assets, strict: false });
  if (fs.existsSync(destination)) throw new Error('ASR package destination already exists.');
  fs.mkdirSync(destination, { recursive: true });
  for (const relative of assets.files.map(file => file.path)) {
    const target = path.join(destination, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(safeFile(source, relative), target);
  }
  // Generate public metadata from pinned assets; never copy arbitrary local JSON fields.
  const manifest = { schemaVersion: 2 };
  for (const key of ['provider', 'version', 'model', 'modelRevision', 'precision', 'binaryPath', 'modelPath', 'tokensPath']) manifest[key] = assets[key];
  Object.assign(manifest, { runtimeFiles: assets.files.filter(file => file.path.endsWith('.dll')).map(file => file.path),
    modelSha256: assets.files.find(file => file.path === assets.modelPath).sha256,
    tokensSha256: assets.files.find(file => file.path === assets.tokensPath).sha256,
    binaryArchiveUrl: assets.runtimeArchive.url, binaryArchiveSha256: assets.runtimeArchive.sha256,
    modelArchiveUrl: assets.modelArchive.url, modelArchiveSha256: assets.modelArchive.sha256 });
  fs.writeFileSync(path.join(destination, 'asr.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(destination, 'PROVENANCE.json'), JSON.stringify(assets, null, 2) + '\n');
  verifyOfflineASR(destination, { assets });
}

module.exports = { ASR_ASSETS, copyOfflineASR, verifyOfflineASR };
