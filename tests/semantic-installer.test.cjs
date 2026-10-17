'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ModelInstaller, MODEL_MANIFEST, MARKER, validModelDirectory } = require('../src/main/semantic-installer.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(__dirname, '.tmp-semantic-installer-'));
  t.after(() => { assert.equal(path.dirname(directory), __dirname); assert(path.basename(directory).startsWith('.tmp-semantic-installer-')); fs.rmSync(directory, { recursive: true, force: true }); });
  const buffers = new Map(MODEL_MANIFEST.files.map((file, index) => [file.path, Buffer.from('synthetic-public-model-fixture-' + index)]));
  const files = MODEL_MANIFEST.files.map((file, index) => { const content = buffers.get(file.path); return { path: file.path, size: content.length, ...(index < 3 ? { gitSha1: crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex') } : { sha256: crypto.createHash('sha256').update(content).digest('hex') }) }; });
  const manifest = { ...MODEL_MANIFEST, files, totalBytes: files.reduce((sum, file) => sum + file.size, 0) };
  let calls = 0;
  const fetchImpl = async url => { calls += 1; const name = manifest.files.find(file => new URL(url).pathname.endsWith('/' + file.path))?.path; assert(name); return new Response(buffers.get(name), { status: 200, headers: { 'content-length': String(buffers.get(name).length) } }); };
  const modelPath = path.join(directory, 'model');
  return { directory, modelPath, manifest, buffers, fetchImpl, count: () => calls,
    installer(options = {}) { return new ModelInstaller({ directory: modelPath, manifest, fetchImpl, ...options }); },
  };
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

test('public manifest pins exactly five files, revision, total bytes and published integrity digests', () => {
  assert.equal(MODEL_MANIFEST.revision, '761b726dd34fb83930e26aab4e9ac3899aa1fa78');
  assert.equal(MODEL_MANIFEST.files.length, 5); assert.equal(MODEL_MANIFEST.totalBytes, 135392183);
  assert.equal(MODEL_MANIFEST.files.find(file => file.path.endsWith('.onnx')).sha256, 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193');
  assert.equal(MODEL_MANIFEST.files.find(file => file.path === 'tokenizer.json').sha256, '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39');
});

test('download requires literal approval; network-disabled tests never invoke fetch or create model files', async t => {
  const f = fixture(t); const installer = f.installer();
  await assert.rejects(installer.install(), /同意/); await assert.rejects(installer.install({ approved: 'true' }), /同意/);
  await assert.rejects(f.installer({ networkDisabled: true }).install({ approved: true }), /禁用网络/);
  assert.equal(f.count(), 0); assert.equal(fs.existsSync(f.modelPath), false);
});

test('synthetic download verifies SHA256 and Git blob SHA1, promotes once, and produces a fast reusable status', async t => {
  const f = fixture(t); const events = []; const installer = f.installer({ onProgress: value => events.push(value) });
  const result = await installer.install({ approved: true });
  assert.equal(result.installed, true); assert.equal(result.modelDirectory, f.modelPath); assert.equal(f.count(), 5);
  assert.equal(result.downloaded, f.manifest.totalBytes); assert.equal(result.phase, 'installed');
  assert(validModelDirectory(f.modelPath, f.manifest));
  assert.equal(f.installer().status().installed, true);
  assert.equal(events.at(-1).type, 'semanticProgress'); assert.equal(events.at(-1).phase, 'installed');
  assert.match(fs.readFileSync(path.join(f.modelPath, 'MODEL-LICENSE.txt'), 'utf8'), /Copyright \(c\) Microsoft Corporation/);
  assert.equal(fs.readdirSync(f.directory).some(name => name.includes('.install-')), false);
  fs.appendFileSync(path.join(f.modelPath, 'config.json'), 'tamper');
  assert.equal(installer.status().installed, false);
});

test('valid bundled models are detected without downloads and invalid local models cannot shadow the bundle', async t => {
  const f = fixture(t); await f.installer().install({ approved: true });
  const installer = new ModelInstaller({ directory: path.join(f.directory, 'local'), bundledDirectory: f.modelPath, manifest: f.manifest, networkDisabled: true });
  assert.equal(installer.modelDirectory(), f.modelPath); assert.equal(installer.status().installed, true);
  fs.mkdirSync(installer.directory); fs.writeFileSync(path.join(installer.directory, MARKER), '{}');
  assert.equal(installer.modelDirectory(), f.modelPath);
});

test('hash mismatches never replace an existing valid installation and remove provisional files', async t => {
  const f = fixture(t); await f.installer().install({ approved: true });
  const before = fs.readFileSync(path.join(f.modelPath, MARKER), 'utf8');
  const installer = f.installer({ fetchImpl: async () => new Response(Buffer.alloc(f.manifest.files[0].size, 88)) });
  await assert.rejects(installer.install({ approved: true }), /完整性/);
  assert.equal(fs.readFileSync(path.join(f.modelPath, MARKER), 'utf8'), before);
  assert.equal(installer.status().installed, true); assert.equal(installer.status().phase, 'failed');
  assert.deepEqual(fs.readdirSync(f.directory), ['model']);
});

test('untrusted redirects, HTTP downgrades, credentials, and excessive redirects never reach another host', async t => {
  const f = fixture(t);
  for (const url of ['https://example.com/model', 'http://cdn-lfs.huggingface.co/model', 'https://user:password@cdn-lfs.huggingface.co/model', 'https://huggingface.co/other/repo/resolve/main/model', 'https://cdn-lfs.huggingface.co:8080/model']) {
    let calls = 0; const installer = f.installer({ fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: url } }); } });
    await assert.rejects(installer.install({ approved: true }), /允许/); assert.equal(calls, 1);
  }
  let calls = 0; const installer = f.installer({ fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: 'https://cas-bridge.xethub.hf.co/model' } }); } });
  await assert.rejects(installer.install({ approved: true }), /重定向/); assert.equal(calls, 7);
  assert.equal(fs.existsSync(f.modelPath), false);
});

test('allowed CDN redirects stream only exact-sized content and reject declared or streamed excess', async t => {
  const f = fixture(t); const first = f.manifest.files[0];
  for (const declared of [true, false]) {
    let calls = 0;
    const installer = f.installer({ fetchImpl: async () => { calls += 1; if (calls === 1) return new Response(null, { status: 302, headers: { location: 'https://cas-bridge.xethub.hf.co/signed-model' } }); return new Response(Buffer.alloc(first.size + 1), { headers: declared ? { 'content-length': String(first.size + 1) } : {} }); } });
    await assert.rejects(installer.install({ approved: true }), /大小/); assert.equal(calls, 2);
    assert.equal(fs.existsSync(f.modelPath), false); assert.deepEqual(fs.readdirSync(f.directory), []);
  }
});

test('cancel invalidates a pending uncooperative response, cleans temp files and allows a fresh installation', async t => {
  const f = fixture(t); const pending = deferred(); const started = deferred(); let requests = 0;
  const installer = f.installer({ fetchImpl: (...args) => { if (++requests === 1) { started.resolve(); return pending.promise; } return f.fetchImpl(...args); } });
  const install = installer.install({ approved: true }); await started.promise; assert.equal(installer.cancel(), true);
  await assert.rejects(install, /取消/); assert.equal(installer.status().phase, 'cancelled');
  assert.deepEqual(fs.readdirSync(f.directory), []);
  const count = requests; pending.resolve(new Response(Buffer.from('late bytes'))); await Promise.resolve(); await Promise.resolve(); assert.equal(requests, count);
  assert.equal((await installer.install({ approved: true })).installed, true);
});

test('concurrent installation and progress re-entry share one operation; redirect cleanup cannot stall it', async t => {
  const f = fixture(t); let reentrant; let redirected = false;
  const installer = f.installer({ onProgress: value => { if (value.phase === 'preparing') reentrant = installer.install({ approved: true }); }, fetchImpl: (url, options) => {
    if (!redirected) { redirected = true; return Promise.resolve({ status: 302, headers: new Headers({ location: 'https://cdn-lfs.huggingface.co/synthetic-model' }), body: { cancel: () => new Promise(() => {}) } }); }
    if (new URL(url).hostname === 'cdn-lfs.huggingface.co') return Promise.resolve(new Response(f.buffers.get(f.manifest.files[0].path)));
    return f.fetchImpl(url, options);
  } });
  const first = installer.install({ approved: true }); const second = installer.install({ approved: true }); assert.equal(first, second);
  assert.equal((await first).installed, true); assert.equal(reentrant, first);
});

test('external cancellation and idle timeout fail visibly without waiting forever or creating installed markers', async t => {
  const f = fixture(t); const controller = new AbortController();
  const installer = f.installer({ fetchImpl: () => new Promise(() => {}) });
  const pending = installer.install({ approved: true, signal: controller.signal }); controller.abort();
  await assert.rejects(pending); assert.equal(installer.status().phase, 'cancelled');
  const stalled = f.installer({ fetchImpl: () => new Promise(() => {}), idleTimeoutMs: 5, timeoutMs: 1000 });
  await assert.rejects(stalled.install({ approved: true }), /没有进展/); assert.equal(stalled.status().phase, 'failed');
  assert.equal(fs.existsSync(f.modelPath), false); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('malformed manifests cannot request traversal or unpinned model files', t => {
  const f = fixture(t);
  assert.throws(() => f.installer({ manifest: { ...f.manifest, revision: 'main' } }), /版本/);
  assert.throws(() => f.installer({ manifest: { ...f.manifest, files: [{ ...f.manifest.files[0], path: '../private' }, ...f.manifest.files.slice(1)] } }), /清单/);
});

function interruptedBody(content, count) {
  let read = false;
  return { getReader: () => ({ read: async () => { if (!read) { read = true; return { done: false, value: content.subarray(0, count) }; } throw new TypeError('terminated'); }, cancel: async () => {} }) };
}
test('interrupted synthetic streams resume with a verified offset and forward Range through allowed redirects', async t => {
  for (const fileIndex of [0, 3]) {
    const f = fixture(t); const file = f.manifest.files[fileIndex]; const content = f.buffers.get(file.path); const offset = Math.floor(content.length / 2); const requests = []; const events = []; let interrupted = false;
    const installer = f.installer({ onProgress: value => events.push(value), fetchImpl: async (url, options) => {
      if (new URL(url).hostname === 'cdn-lfs.huggingface.co') { requests.push({ url, range: options.headers.Range }); return new Response(content.subarray(offset), { status: 206, headers: { 'content-range': `bytes ${offset}-${file.size - 1}/${file.size}`, 'content-length': String(file.size - offset) } }); }
      if (!new URL(url).pathname.endsWith('/' + file.path)) return f.fetchImpl(url, options);
      requests.push({ url, range: options.headers.Range });
      if (!interrupted) { interrupted = true; return { ok: true, status: 200, headers: new Headers({ 'content-length': String(file.size) }), body: interruptedBody(content, offset) }; }
      return new Response(null, { status: 302, headers: { location: 'https://cdn-lfs.huggingface.co/synthetic-resume' } });
    } });
    const result = await installer.install({ approved: true });
    assert.equal(result.installed, true); assert.equal(result.downloaded, f.manifest.totalBytes);
    assert.deepEqual(requests.map(request => request.range), [undefined, `bytes=${offset}-`, `bytes=${offset}-`]);
    assert.ok(requests[1].url.startsWith(`https://huggingface.co/${f.manifest.id}/resolve/${f.manifest.revision}/`));
    assert.ok(events.some(event => event.phase === 'retrying' && event.retryCount === 1));
    assert.deepEqual(fs.readFileSync(path.join(f.modelPath, file.path)), content);
  }
});

test('a server ignoring Range restarts the file and resets its digest and progress safely', async t => {
  const f = fixture(t); const file = f.manifest.files[3]; const content = f.buffers.get(file.path); let calls = 0;
  const installer = f.installer({ fetchImpl: async (url, options) => {
    if (!new URL(url).pathname.endsWith('/' + file.path)) return f.fetchImpl(url, options);
    if (++calls === 1) return { ok: true, status: 200, headers: new Headers(), body: interruptedBody(content, 7) };
    assert.equal(options.headers.Range, 'bytes=7-'); return new Response(content, { headers: { 'content-length': String(content.length) } });
  } });
  const result = await installer.install({ approved: true }); assert.equal(calls, 2); assert.equal(result.downloaded, f.manifest.totalBytes); assert.equal(result.installed, true);
});

test('wrong resumable range or length is rejected without further retries or an installed marker', async t => {
  const f = fixture(t); const file = f.manifest.files[0]; const content = f.buffers.get(file.path); const offset = 5;
  for (const headers of [
    { 'content-range': `bytes ${offset + 1}-${file.size - 1}/${file.size}` },
    { 'content-range': `bytes ${offset}-${file.size - 1}/${file.size + 1}` },
    { 'content-range': `bytes ${offset}-${file.size - 2}/${file.size}` },
    { 'content-range': `bytes ${offset}-${file.size - 1}/${file.size}`, 'content-length': String(file.size) },
    {},
  ]) {
    let calls = 0;
    const installer = f.installer({ fetchImpl: async () => ++calls === 1 ? { ok: true, status: 200, headers: new Headers(), body: interruptedBody(content, offset) } : new Response(content.subarray(offset), { status: 206, headers }) });
    await assert.rejects(installer.install({ approved: true }), /范围|大小/u); assert.equal(calls, 2); assert.equal(installer.status().installed, false); assert.deepEqual(fs.readdirSync(f.directory), []);
  }
});

test('network retries stop after three reconnects, while user cancellation and HTTP permissions never retry', async t => {
  const f = fixture(t); const content = f.buffers.get(f.manifest.files[0].path); let attempts = 0;
  const installer = f.installer({ fetchImpl: async () => { attempts += 1; throw new TypeError('connection reset'); } });
  await assert.rejects(installer.install({ approved: true }), /connection reset/u); assert.equal(attempts, 4); assert.equal(installer.status().retryCount, 3); assert.equal(installer.status().attempt, 4);
  let permissions = 0; const forbidden = f.installer({ fetchImpl: async () => { permissions += 1; return new Response(null, { status: 403 }); } });
  await assert.rejects(forbidden.install({ approved: true }), /403/u); assert.equal(permissions, 1);
  let cancelledCalls = 0; let cancelled;
  cancelled = f.installer({ onProgress: event => { if (event.downloaded > 0) cancelled.cancel(); }, fetchImpl: async () => { cancelledCalls += 1; return { ok: true, status: 200, headers: new Headers(), body: interruptedBody(content, 4) }; } });
  await assert.rejects(cancelled.install({ approved: true }), /取消/u); assert.equal(cancelledCalls, 1); assert.equal(cancelled.status().phase, 'cancelled'); assert.deepEqual(fs.readdirSync(f.directory), []);
});
