'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assets = require('./ocr-assets.json');
const { OCR_DIRECTORY, MANIFEST, PYTHON_PATH, PYTHON_PATH_CONTENT, RUNNER, fingerprint, inventory, verifyOfflineOCR } = require('./ocr-packaging.cjs');

const root = path.resolve(__dirname, '..');
const local = path.join(root, '.local');
const cache = path.join(local, 'ocr-packaging-work');
const destination = path.join(local, OCR_DIRECTORY);
const prefix = 'ocr-setup-';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw result.error || new Error(command + ' exited with status ' + result.status);
}

function download(asset, stage) {
  const cached = path.join(cache, asset.file);
  if (fs.existsSync(cached) && fingerprint(cached).sha256 === asset.sha256) return cached;
  const pending = path.join(stage, asset.file);
  run('curl.exe', ['--fail', '--location', '--proto', '=https', '--retry', '2', '--connect-timeout', '20', '--output', pending, asset.url]);
  if (fingerprint(pending).sha256 !== asset.sha256) throw new Error('Download checksum mismatch: ' + asset.file);
  fs.renameSync(pending, cached);
  return cached;
}

function prepare(stage) {
  const pythonDirectory = path.join(stage, 'python');
  const pythonArchive = download(assets.python, stage);
  const wheelArchives = assets.wheels.map(wheel => download(wheel, stage));
  fs.mkdirSync(pythonDirectory);
  run('tar.exe', ['-xf', pythonArchive, '-C', pythonDirectory]);
  fs.writeFileSync(path.join(stage, PYTHON_PATH), PYTHON_PATH_CONTENT);
  const unpack = String.raw`
import pathlib
import shutil
import sys
import zipfile

bundle = pathlib.Path(sys.argv[1])
packages = bundle / 'site-packages'
packages.mkdir()
models = bundle / 'models'
models.mkdir()
model_files = set(sys.argv[2].split(','))
for wheel in sys.argv[3:]:
    with zipfile.ZipFile(wheel) as archive:
        for member in archive.infolist():
            filename = pathlib.PurePosixPath(member.filename)
            if member.is_dir():
                continue
            if filename.parts[0].endswith('.data'):
                raise RuntimeError('Wheel requires installation instead of extraction: ' + wheel)
            if filename.suffix == '.onnx':
                if filename.parent.as_posix() != 'rapidocr/models' or filename.name not in model_files:
                    continue
                target = models / filename.name
            else:
                target = packages.joinpath(*filename.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
`;
  run(path.join(pythonDirectory, 'python.exe'), ['-I', '-B', '-c', unpack, stage, assets.models.map(model => model.file).join(','), ...wheelArchives]);
  fs.writeFileSync(path.join(stage, MANIFEST), JSON.stringify({ version: 1, files: inventory(stage) }));
  verifyOfflineOCR(stage, path.join(root, RUNNER));
}

function setup() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Offline OCR setup requires Windows x64.');
  if (process.argv.length !== 2) throw new Error('Usage: pnpm ocr:setup');
  fs.mkdirSync(cache, { recursive: true });
  if (fs.existsSync(destination)) {
    try {
      verifyOfflineOCR(destination, path.join(root, RUNNER));
      console.log('Offline OCR already verified:', destination);
      return;
    } catch (error) {
      console.log('Rebuilding offline OCR:', error.message);
    }
  }
  const localRoot = fs.realpathSync(local);
  if (localRoot !== local) throw new Error('Offline OCR setup requires the workspace .local directory.');
  const stage = fs.mkdtempSync(path.join(localRoot, prefix));
  try {
    prepare(stage);
    // Keep the prior bundle until the replacement has been fully prepared.
    const backup = path.join(localRoot, OCR_DIRECTORY + '-backup-' + Date.now());
    const hadBundle = fs.existsSync(destination);
    if (hadBundle) fs.renameSync(destination, backup);
    try {
      fs.renameSync(stage, destination);
    } catch (error) {
      if (hadBundle) fs.renameSync(backup, destination);
      throw error;
    }
    console.log('Offline OCR prepared:', destination);
  } finally {
    if (fs.existsSync(stage)) {
      if (path.dirname(stage) !== localRoot || !path.basename(stage).startsWith(prefix) || fs.realpathSync(stage) !== stage) {
        throw new Error('Refusing to clean an unexpected OCR setup directory.');
      }
      fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

setup();
