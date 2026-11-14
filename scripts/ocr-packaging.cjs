'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assets = require('./ocr-assets.json');

const OCR_DIRECTORY = 'offline-ocr';
const MANIFEST = 'ocr-bundle.json';
const PYTHON = 'python/python.exe';
const PYTHON_PATH = 'python/python314._pth';
const PYTHON_PATH_CONTENT = 'python314.zip\n.\n../site-packages\n';
const RUNNER = 'src/main/note-ocr-runner.py';
const bundleDirectories = new Set(['python', 'site-packages', 'models']);

function fingerprint(file) {
  const descriptor = fs.openSync(file, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    let length;
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null))) {
      hash.update(buffer.subarray(0, length));
      bytes += length;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { bytes, sha256: hash.digest('hex') };
}

function inventory(directory) {
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('OCR bundle must be a directory.');
  const files = {};
  function visit(folder, prefix) {
    for (const name of fs.readdirSync(folder).sort()) {
      const relative = prefix + name;
      const file = path.join(folder, name);
      const entry = fs.lstatSync(file);
      if (relative === MANIFEST && entry.isFile()) continue;
      if ((!prefix && !bundleDirectories.has(name)) || /(?:^|\/)__pycache__(?:\/|$)|\.pyc$/u.test(relative)) {
        throw new Error('Unexpected offline OCR file: ' + relative);
      }
      if (entry.isDirectory()) visit(file, relative + '/');
      else if (entry.isFile()) files[relative] = fingerprint(file);
      else throw new Error('Offline OCR bundle contains a link or special file: ' + relative);
    }
  }
  visit(directory, '');
  return files;
}

function verifyOfflineOCR(directory, runner) {
  const manifestPath = path.join(directory, MANIFEST);
  if (!fs.lstatSync(manifestPath).isFile() || fingerprint(manifestPath).sha256 !== assets.bundleManifestSha256) {
    throw new Error('Offline OCR bundle manifest checksum mismatch. Run pnpm ocr:setup.');
  }
  const files = inventory(directory);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1 || Object.keys(files).length !== Object.keys(manifest.files ?? {}).length ||
      Object.entries(files).some(([file, entry]) => entry.bytes !== manifest.files[file]?.bytes || entry.sha256 !== manifest.files[file]?.sha256)) {
    throw new Error('Offline OCR bundle checksum verification failed. Run pnpm ocr:setup.');
  }
  for (const file of [PYTHON, PYTHON_PATH, 'python/LICENSE.txt', 'python/python314.zip']) {
    if (!files[file]?.bytes) throw new Error('Missing offline OCR component: ' + file);
  }
  if (fs.readFileSync(path.join(directory, PYTHON_PATH), 'utf8') !== PYTHON_PATH_CONTENT) {
    throw new Error('Offline OCR Python must use only packaged import paths.');
  }
  for (const model of assets.models) {
    const file = files['models/' + model.file];
    if (file?.bytes !== model.bytes || file.sha256 !== model.sha256) throw new Error('Offline OCR model checksum mismatch: ' + model.file);
  }
  for (const wheel of assets.wheels) {
    if (!files[`site-packages/${wheel.name}-${wheel.version}.dist-info/METADATA`]?.bytes) {
      throw new Error('Missing pinned offline OCR dependency: ' + wheel.name);
    }
  }
  const rapidocr = assets.wheels.find(wheel => wheel.name === 'rapidocr');
  const licenseDirectory = `site-packages/rapidocr-${rapidocr.version}.dist-info/licenses/`;
  for (const file of ['LICENSE', 'MODEL_LICENSES.md']) {
    if (!files[licenseDirectory + file]?.bytes) throw new Error('Missing offline OCR license: ' + file);
  }
  if (runner) verifyRuntime(directory, runner);
}

function verifyRuntime(directory, runner) {
  const executable = path.resolve(directory, PYTHON);
  const bundle = path.resolve(directory);
  // Only Windows DLLs and the bundled Python are available through this PATH.
  const env = { ...process.env, PATH: path.join(process.env.SystemRoot, 'System32') };
  const version = spawnSync(executable, ['-I', '-B', '--version'], { cwd: bundle, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (version.status !== 0 || version.stdout.trim() !== 'Python ' + assets.python.version) {
    throw new Error('Pinned offline OCR Python is unavailable: ' + (version.error?.message || version.stderr || version.stdout));
  }
  const result = spawnSync(executable, ['-I', '-B', '-u', path.resolve(runner), bundle, '--check'], {
    cwd: bundle, env, encoding: 'utf8', windowsHide: true, timeout: 45000,
  });
  if (result.status !== 0 || result.stdout.trim() !== '{"ok":true}') {
    throw new Error('Portable OCR runtime check failed: ' + (result.error?.message || result.stderr || result.stdout));
  }
}

function copyOfflineOCR(source, destination) {
  verifyOfflineOCR(source);
  fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
}

module.exports = { OCR_DIRECTORY, MANIFEST, PYTHON_PATH, PYTHON_PATH_CONTENT, RUNNER, fingerprint, inventory, verifyOfflineOCR, copyOfflineOCR };
