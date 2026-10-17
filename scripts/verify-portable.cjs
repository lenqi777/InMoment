'use strict';
// Inspect files and import metadata only; never start capture or model inference.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MODEL_MANIFEST, validModelDirectory } = require('../src/main/semantic-installer.cjs');

function digest(file, algorithm, prefix = '') {
  const hash = crypto.createHash(algorithm); hash.update(prefix);
  const descriptor = fs.openSync(file, 'r'); const buffer = Buffer.alloc(1024 * 1024);
  try { let length; while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length)); }
  finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}
function verifyPortable(directory, { full = true } = {}) {
  const root = path.resolve(directory); const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Portable package contains a link: ' + path.relative(root, file));
      if (entry.isDirectory()) visit(file); else files.push(file);
    }
  }
  visit(root);
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (/(?:^|\/)(?:\.env(?:\..*)?|settings\.json|[^/]+\.(?:sqlite3?|db)(?:-(?:wal|shm))?|[^/]+\.(?:wav|log|pfx|p12|key))$/iu.test(relative)) throw new Error('Private/development file in portable package: ' + relative);
  }
  const app = path.join(root, 'resources/app');
  for (const relative of ['InMoment.exe', 'LICENSE', 'LICENSES.chromium.html', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md', 'docs/USER_GUIDE.md', 'resources/app/build/native/InMoment.Native.exe', 'resources/app/RUNTIME-DEPENDENCIES.json']) {
    if (!fs.statSync(path.join(root, relative)).isFile()) throw new Error('Missing portable component: ' + relative);
  }
  const dependencies = JSON.parse(fs.readFileSync(path.join(app, 'RUNTIME-DEPENDENCIES.json'), 'utf8'));
  if (!dependencies.packages.some(item => item.name === '@huggingface/transformers')) throw new Error('Missing semantic runtime dependency.');
  if (full) {
    for (const file of ['Install-InMoment.cmd', 'Install-InMoment.ps1', 'ELECTRON-LICENSE.txt']) if (!fs.statSync(path.join(root, file)).isFile()) throw new Error('Missing setup/license component: ' + file);
    const asr = path.join(root, 'offline-asr');
    const manifest = JSON.parse(fs.readFileSync(path.join(asr, 'asr.json'), 'utf8'));
    if (manifest.binaryPath !== 'bin/whisper-cli.exe' || manifest.modelPath !== 'models/ggml-base.bin' || manifest.buildTag !== 'b5454') throw new Error('Unexpected ASR configuration.');
    for (const relative of ['bin/whisper-cli.exe', 'bin/whisper.dll', 'bin/ggml.dll', 'bin/ggml-base.dll', 'bin/ggml-cpu-x64.dll', 'WHISPER-CPP-LICENSE.txt', 'WHISPER-MODEL-LICENSE.txt']) if (!fs.statSync(path.join(asr, relative)).isFile()) throw new Error('Missing ASR component: ' + relative);
    if (digest(path.join(asr, 'models/ggml-base.bin'), 'sha1') !== '465707469ff3a37a2b9b8d8f89f2f99de7299dac') throw new Error('ASR model hash mismatch.');
    const semantic = path.join(root, 'offline-semantic');
    if (!validModelDirectory(semantic)) throw new Error('Missing semantic component marker or file size mismatch.');
    for (const file of MODEL_MANIFEST.files) if (digest(path.join(semantic, file.path), file.sha256 ? 'sha256' : 'sha1', file.sha256 ? '' : `blob ${file.size}\0`) !== (file.sha256 || file.gitSha1)) throw new Error('Semantic model hash mismatch: ' + file.path);
  }
  const result = { version: JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version, full, files: files.length, bytes: files.reduce((sum, file) => sum + fs.statSync(file).size, 0), runtimePackages: dependencies.packages.length, modelRuns: 0, apiCalls: 0 };
  console.log('Portable file verification:', JSON.stringify(result));
  return result;
}
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/verify-portable.cjs <directory> [--minimal]');
  verifyPortable(process.argv[2], { full: !process.argv.includes('--minimal') });
}
module.exports = { verifyPortable };
