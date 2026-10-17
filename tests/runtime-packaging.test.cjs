'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { createRequire } = require('node:module');
const { copyProductionDependencies, copySemanticModel, verifyRuntimeImport } = require('../scripts/runtime-packaging.cjs');
const { MODEL_MANIFEST, MARKER, EXTRA_FILES } = require('../src/main/semantic-installer.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(__dirname, '.tmp-runtime-packaging-'));
  t.after(() => {
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), __dirname); assert.ok(path.basename(absolute).startsWith('.tmp-runtime-packaging-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  return directory;
}
function write(directory, name, content) { const filename = path.join(directory, name); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content); }
function packageAt(directory, name, metadata = {}, body = "module.exports = 'fixture';") { write(directory, 'package.json', JSON.stringify({ name, version: '1.0.0', license: 'MIT', main: 'index.cjs', ...metadata })); write(directory, 'index.cjs', body); write(directory, 'LICENSE', 'Synthetic test license'); }

test('portable dependencies copy only production closure, preserve two versions and handle cycles without links', t => {
  const directory = fixture(t); const root = path.join(directory, 'project'); const app = path.join(directory, 'portable');
  const sources = { a: path.join(root, 'node_modules/alpha'), b: path.join(root, 'node_modules/beta'), c1: path.join(root, 'node_modules/alpha/node_modules/common'), c2: path.join(root, 'node_modules/beta/node_modules/common'), foreign: path.join(root, 'node_modules/beta/node_modules/foreign') };
  const source = name => sources[name];
  packageAt(root, 'fixture-app', { dependencies: { alpha: '1', beta: '1' }, devDependencies: { electron: '99', 'dev-only': '1' } });
  packageAt(source('a'), 'alpha', { dependencies: { common: '1' } }, "module.exports = 'alpha:' + require('common');");
  packageAt(source('b'), 'beta', { dependencies: { common: '2' }, optionalDependencies: { missing: '1', foreign: '1' } }, "module.exports = 'beta:' + require('common');");
  packageAt(source('c1'), 'common', { dependencies: { alpha: '1' } }, "module.exports = 'one';");
  packageAt(source('c2'), 'common', { version: '2.0.0' }, "module.exports = 'two';");
  packageAt(source('foreign'), 'foreign', { os: ['linux'], cpu: ['arm64'] });
  write(source('a'), '.env', 'not a secret, must be excluded'); write(source('a'), 'test/fixture.txt', 'test fixture'); write(source('a'), 'private.key', 'synthetic excluded key');
  fs.mkdirSync(app, { recursive: true }); write(app, 'package.json', '{"name":"packaged-fixture"}');
  const records = copyProductionDependencies(root, app);
  assert.deepEqual(records.map(record => record.name).sort(), ['alpha', 'beta', 'common', 'common']);
  const requireFromApp = createRequire(path.join(app, 'package.json'));
  assert.equal(requireFromApp('alpha'), 'alpha:one'); assert.equal(requireFromApp('beta'), 'beta:two');
  assert.equal(fs.existsSync(path.join(app, 'node_modules/alpha/.env')), false);
  assert.equal(fs.existsSync(path.join(app, 'node_modules/alpha/test')), false);
  assert.equal(fs.existsSync(path.join(app, 'node_modules/alpha/private.key')), false);
  assert.equal(fs.existsSync(path.join(app, 'node_modules/electron')), false);
  assert.equal(fs.lstatSync(path.join(app, 'node_modules/alpha')).isSymbolicLink(), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(app, 'RUNTIME-DEPENDENCIES.json')));
  assert.ok(manifest.packages.every(record => !path.isAbsolute(record.directory) && !JSON.stringify(record).includes(root)));
});

test('missing required production package is visible and Electron is never included as a dependency', t => {
  const directory = fixture(t); const root = path.join(directory, 'project'); const app = path.join(directory, 'portable');
  packageAt(root, 'fixture-app', { dependencies: { missing: '1' } }); fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  assert.throws(() => copyProductionDependencies(root, app), /Missing production dependency/u);
  packageAt(root, 'fixture-app', { dependencies: { electron: '99' } });
  assert.throws(() => copyProductionDependencies(root, app), /Not an allowed production/u);
});

test('runtime copy rejects a resolved package entry that escapes its package directory', t => {
  const directory = fixture(t); const root = path.join(directory, 'project'); const app = path.join(directory, 'portable');
  const packageSource = path.join(root, 'node_modules/alpha'); const other = path.join(directory, 'other');
  packageAt(root, 'fixture-app', { dependencies: { alpha: '1' } }); packageAt(packageSource, 'alpha'); write(other, 'private.txt', 'synthetic outside file');
  const escape = path.join(packageSource, 'escape'); fs.mkdirSync(escape);
  const realpath = fs.realpathSync.bind(fs);
  // The restricted Windows test environment forbids creating junctions. Inject
  // their resolved result to exercise the escape check without needing one.
  t.mock.method(fs, 'realpathSync', value => path.resolve(value) === escape ? other : realpath(value));
  assert.throws(() => copyProductionDependencies(root, app), /link escapes its package/u);
  assert.equal(fs.existsSync(path.join(app, 'node_modules/alpha/escape/private.txt')), false);
});

test('native runtime copy retains only Windows x64 binaries and original notices', t => {
  const directory = fixture(t); const root = path.join(directory, 'project'); const app = path.join(directory, 'portable'); const packageSource = path.join(root, 'node_modules/onnxruntime-node');
  packageAt(root, 'fixture-app', { dependencies: { 'onnxruntime-node': '1' } }); packageAt(packageSource, 'onnxruntime-node');
  write(packageSource, 'bin/napi-v3/win32/x64/runtime.node', 'synthetic binary'); write(packageSource, 'bin/napi-v3/win32/arm64/runtime.node', 'foreign'); write(packageSource, 'bin/napi-v3/linux/x64/runtime.node', 'foreign');
  copyProductionDependencies(root, app);
  assert.ok(fs.existsSync(path.join(app, 'node_modules/onnxruntime-node/bin/napi-v3/win32/x64/runtime.node')));
  assert.equal(fs.existsSync(path.join(app, 'node_modules/onnxruntime-node/bin/napi-v3/linux')), false);
  assert.equal(fs.existsSync(path.join(app, 'node_modules/onnxruntime-node/bin/napi-v3/win32/arm64')), false);
  assert.ok(fs.existsSync(path.join(app, 'node_modules/onnxruntime-node/LICENSE')));
});

function syntheticModel(directory) {
  const files = MODEL_MANIFEST.files.map((file, index) => {
    const content = Buffer.from('synthetic model file ' + index); write(directory, file.path, content);
    return { path: file.path, size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') };
  });
  const manifest = { ...MODEL_MANIFEST, files, totalBytes: files.reduce((sum, file) => sum + file.size, 0) };
  write(directory, MARKER, JSON.stringify({ schemaVersion: 1, manifestSha256: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex') }));
  write(directory, 'MODEL-LICENSE.txt', 'Synthetic test license'); write(directory, 'PROVENANCE.json', '{}'); return manifest;
}
test('model packaging copies only pinned model allowlist and rechecks hash of every copied file', t => {
  const directory = fixture(t); const source = path.join(directory, 'model'); const destination = path.join(directory, 'bundle'); const manifest = syntheticModel(source);
  write(source, '.env', 'synthetic excluded setting'); write(source, 'other-recording.wav', 'synthetic excluded audio');
  copySemanticModel(source, destination, { manifest });
  assert.deepEqual(fs.readdirSync(destination).sort(), [...manifest.files.filter(file => !file.path.includes('/')).map(file => file.path), 'onnx', ...EXTRA_FILES].sort());
  assert.equal(fs.existsSync(path.join(destination, '.env')), false);
  assert.equal(fs.existsSync(path.join(destination, 'other-recording.wav')), false);
  const damaged = path.join(source, manifest.files[0].path); const content = fs.readFileSync(damaged); content[0] ^= 1; fs.writeFileSync(damaged, content);
  assert.throws(() => copySemanticModel(source, path.join(directory, 'damaged-bundle'), { manifest }), /integrity mismatch/u);
  assert.throws(() => copySemanticModel(source, destination, { manifest }), /already exists/u);
});

test('runtime import validation uses an external temporary copy containing only production packages and cleans success and failure', t => {
  const directory = fixture(t); const app = path.join(directory, 'portable'); packageAt(app, 'fixture-app'); packageAt(path.join(app, 'node_modules/fixture-runtime'), 'fixture-runtime');
  write(app, 'settings.json', '{"syntheticPrivateData":true}'); write(app, 'private.sqlite', 'synthetic private database'); write(app, 'offline-semantic/model.onnx', 'synthetic model that must not be copied');
  let temporary;
  const success = (executable, args, options) => {
    temporary = options.cwd; assert.equal(executable, path.resolve(process.execPath)); assert.equal(path.dirname(temporary), fs.realpathSync(os.tmpdir()));
    assert.deepEqual(fs.readdirSync(temporary).sort(), ['node_modules', 'package.json']);
    assert.equal(fs.existsSync(path.join(temporary, 'node_modules/fixture-runtime/index.cjs')), true);
    assert.equal(options.env.NODE_PATH, ''); assert.equal(options.env.NODE_OPTIONS, ''); assert.equal(options.env.INMOMENT_DISABLE_NETWORK, '1');
    assert.deepEqual(args.slice(0, 2), ['--input-type=module', '-e']); return { status: 0, stdout: 'Synthetic import-only validation.' };
  };
  t.mock.method(console, 'log', () => {});
  verifyRuntimeImport(process.execPath, app, { spawnImpl: success }); assert.equal(fs.existsSync(temporary), false);
  assert.throws(() => verifyRuntimeImport(process.execPath, app, { spawnImpl: (...args) => { success(...args); return { status: 1, stderr: 'synthetic missing dependency' }; } }), /synthetic missing dependency/u);
  assert.equal(fs.existsSync(temporary), false); assert.equal(fs.existsSync(path.join(app, 'settings.json')), true);
});
