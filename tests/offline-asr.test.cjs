'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { OfflineASR } = require('../src/main/offline-asr.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inmoment-asr-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'models'));
  // These are inert test files. Every child process is injected; no model is executed.
  fs.writeFileSync(path.join(root, 'bin', 'whisper-cli.exe'), 'inert-test-binary');
  fs.writeFileSync(path.join(root, 'models', 'ggml-base.bin'), 'inert-test-model');
  const wav = path.join(root, 'audio.wav');
  fs.writeFileSync(wav, 'inert-test-wav');
  return { root, record: { id: 'record-a', segments: [{ id: 'segment-a', path: wav, durationMs: 2000 }] } };
}

function child() {
  const value = new EventEmitter();
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.kill = () => { queueMicrotask(() => value.emit('close', null)); return true; };
  return value;
}

test('offline capabilities report missing installation without downloading or spawning', t => {
  const { root } = fixture(t);
  let calls = 0;
  const adapter = new OfflineASR(path.join(root, 'absent'), { spawnImpl() { calls++; throw new Error('must not spawn'); } });
  const capability = adapter.capabilities();
  assert.equal(capability.available, false);
  assert.equal(capability.offline, true);
  assert.equal(capability.provider, 'whisper.cpp');
  assert.equal(capability.model, 'base');
  assert.equal(calls, 0);
});

test('offline adapter uses local CLI arguments, preserves segment ids and cleans generated text', async t => {
  const { root, record } = fixture(t);
  record.segments.push({ ...record.segments[0], id: 'segment-b', durationMs: 3000 });
  const calls = [];
  let clock = 100;
  const adapter = new OfflineASR(root, {
    now: () => { clock += 250; return clock; },
    spawnImpl(binary, args, options) {
      calls.push({ binary, args, options });
      const process = child();
      queueMicrotask(() => {
        const prefix = args[args.indexOf('-of') + 1];
        fs.writeFileSync(`${prefix}.json`, JSON.stringify({ transcription: [{ text: ` 测试 ${calls.length} `, offsets: { from: 10, to: 1500 } }] }));
        process.emit('close', 0);
      });
      return process;
    },
  });
  assert.equal(adapter.capabilities().available, true);
  const result = await adapter.transcribe(record);
  assert.deepEqual(result.segments, [{ id: 'segment-a', text: '测试 1' }, { id: 'segment-b', text: '测试 2' }]);
  assert.equal(result.audioDurationMs, 5000);
  assert.equal(result.durationMs, 250);
  assert.equal(result.rtf, 0.05);
  assert.equal(result.timings[0].segmentId, 'segment-a');
  assert.equal(result.timings[0].startMs, 10);
  assert.equal(result.timings[0].endMs, 1500);
  for (const call of calls) {
    assert.equal(call.binary, path.join(root, 'bin', 'whisper-cli.exe'));
    assert.equal(call.args[call.args.indexOf('-l') + 1], 'zh');
    assert.ok(call.args.includes('-ng'));
    assert.ok(call.args.includes('-oj'));
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'jobs')), []);
});

test('abort kills the local worker, waits for close and removes its final late output', async t => {
  const { root, record } = fixture(t);
  const controller = new AbortController();
  let killed = false;
  const adapter = new OfflineASR(root, {
    spawnImpl(binary, args) {
      const process = child();
      process.kill = () => {
        killed = true;
        const prefix = args[args.indexOf('-of') + 1];
        // Simulate a final write already in progress when delete/cancel arrives.
        fs.writeFileSync(`${prefix}.json`, JSON.stringify({ transcription: [{ text: 'late private text' }] }));
        queueMicrotask(() => process.emit('close', null));
        return true;
      };
      queueMicrotask(() => controller.abort());
      return process;
    },
  });
  await assert.rejects(adapter.transcribe(record, { signal: controller.signal }), error => error.name === 'AbortError' && error.code === 'ABORT_ERR');
  assert.equal(killed, true);
  assert.deepEqual(fs.readdirSync(path.join(root, 'jobs')), []);
});

test('already cancelled requests never start the model or create a job', async t => {
  const { root, record } = fixture(t);
  const controller = new AbortController(); controller.abort();
  let spawned = false;
  const adapter = new OfflineASR(root, { spawnImpl() { spawned = true; return child(); } });
  await assert.rejects(adapter.transcribe(record, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(spawned, false);
  assert.equal(fs.existsSync(path.join(root, 'jobs')), false);
});

test('model stderr and failed JSON contents never appear in exposed errors', async t => {
  const { root, record } = fixture(t);
  const secretText = 'private recording sentence that must not escape';
  const adapter = new OfflineASR(root, {
    spawnImpl() {
      const process = child();
      queueMicrotask(() => { process.stderr.end(secretText); process.emit('close', 2); });
      return process;
    },
  });
  await assert.rejects(adapter.transcribe(record), error => error.code === 'ASR_FAILED' && !error.message.includes(secretText));
  assert.deepEqual(fs.readdirSync(path.join(root, 'jobs')), []);
});

test('relocatable manifest accepts only paths inside its configured installation', t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'asr.json'), JSON.stringify({ binaryPath: '../other.exe', modelPath: 'models/ggml-base.bin' }));
  const capability = new OfflineASR(root).capabilities();
  assert.equal(capability.available, false);
  assert.equal(capability.reason, 'invalid-configuration');
});

test('startup cleanup removes only stale transcribe directories and preserves unrelated files', t => {
  const { root } = fixture(t);
  const jobsDir = path.join(root, 'private-jobs');
  const stale = path.join(jobsDir, 'transcribe-Ab12xy');
  fs.mkdirSync(path.join(stale, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(stale, 'nested', 'segment.json'), 'private old transcript');
  fs.mkdirSync(path.join(jobsDir, 'other-data'));
  fs.writeFileSync(path.join(jobsDir, 'keep.txt'), 'unrelated');
  const adapter = new OfflineASR(root, { jobsDir });
  assert.deepEqual(adapter.cleanupStaleJobs(), { ok: true, cleaned: 1, remaining: [], skipped: 2 });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.readFileSync(path.join(jobsDir, 'keep.txt'), 'utf8'), 'unrelated');
  assert.equal(fs.existsSync(path.join(jobsDir, 'other-data')), true);
  assert.deepEqual(adapter.cleanupStaleJobs(), { ok: true, cleaned: 0, remaining: [], skipped: 2 });
});

test('cleanup with no previous jobs creates no directories and never starts a process', t => {
  const { root } = fixture(t);
  const jobsDir = path.join(root, 'not-created', 'jobs');
  const adapter = new OfflineASR(root, { jobsDir, spawnImpl() { throw new Error('must not spawn'); } });
  assert.deepEqual(adapter.cleanupStaleJobs(), { ok: true, cleaned: 0, remaining: [], skipped: 0 });
  assert.equal(fs.existsSync(jobsDir), false);
});

test('cleanup refuses a filesystem root or the installation root as a jobs directory', t => {
  const { root } = fixture(t);
  for (const jobsDir of [root, path.parse(root).root]) {
    const adapter = new OfflineASR(root, { jobsDir });
    assert.throws(() => adapter.cleanupStaleJobs(), error => error.code === 'ASR_UNSAFE_JOBS_DIR');
  }
  assert.equal(fs.readFileSync(path.join(root, 'models', 'ggml-base.bin'), 'utf8'), 'inert-test-model');
});

test('cleanup cannot race a running local worker', async t => {
  const { root, record } = fixture(t);
  const abort = new AbortController();
  const adapter = new OfflineASR(root, { spawnImpl: () => child() });
  const running = adapter.transcribe(record, { signal: abort.signal });
  assert.equal(adapter.activeJobs.size, 1);
  assert.throws(() => adapter.cleanupStaleJobs(), error => error.code === 'ASR_JOBS_BUSY');
  abort.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(adapter.activeJobs.size, 0);
  assert.equal(adapter.cleanupStaleJobs().ok, true);
});

function makeDirectoryLink(t, target, link) {
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); return () => fs.unlinkSync(link); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    // Exercise the same lstat rejection path when the Windows sandbox forbids creating links.
    fs.mkdirSync(link);
    const original = fs.lstatSync;
    let simulatedLink = true;
    t.mock.method(fs, 'lstatSync', (candidate, ...args) => {
      const stat = original(candidate, ...args);
      if (simulatedLink && typeof candidate === 'string' && path.resolve(candidate) === path.resolve(link)) return { isSymbolicLink: () => true, isDirectory: () => true };
      return stat;
    });
    return () => { simulatedLink = false; fs.rmdirSync(link); };
  }
}

test('cleanup refuses a symlink or junction jobs directory without touching its destination', t => {
  const { root } = fixture(t);
  const outside = path.join(root, 'outside');
  const linkedJobs = path.join(root, 'linked-jobs');
  fs.mkdirSync(path.join(outside, 'transcribe-Outside1'), { recursive: true });
  const privateFile = path.join(outside, 'transcribe-Outside1', 'segment.json');
  fs.writeFileSync(privateFile, 'must remain');
  makeDirectoryLink(t, outside, linkedJobs);
  const adapter = new OfflineASR(root, { jobsDir: linkedJobs });
  assert.throws(() => adapter.cleanupStaleJobs(), error => error.code === 'ASR_UNSAFE_JOBS_DIR');
  assert.equal(fs.readFileSync(privateFile, 'utf8'), 'must remain');
});

test('unsafe linked descendants remain visible as cleanup failures and can be retried safely', t => {
  const { root } = fixture(t);
  const jobsDir = path.join(root, 'private-jobs');
  const stale = path.join(jobsDir, 'transcribe-Retry1');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(stale, { recursive: true });
  fs.mkdirSync(outside);
  const privateFile = path.join(outside, 'outside.json');
  fs.writeFileSync(privateFile, 'must remain');
  const linked = path.join(stale, 'linked-content');
  const removeLink = makeDirectoryLink(t, outside, linked);
  const adapter = new OfflineASR(root, { jobsDir });
  assert.deepEqual(adapter.cleanupStaleJobs(), { ok: false, cleaned: 0, remaining: [{ jobId: 'transcribe-Retry1', code: 'ASR_UNSAFE_JOB_PATH' }], skipped: 0 });
  assert.equal(fs.readFileSync(privateFile, 'utf8'), 'must remain');
  removeLink(); // Remove only the test link, never its target.
  assert.deepEqual(adapter.cleanupStaleJobs(), { ok: true, cleaned: 1, remaining: [], skipped: 0 });
  assert.equal(fs.readFileSync(privateFile, 'utf8'), 'must remain');
});

test('per-record cleanup removes only hashed record directories and leaves other active jobs alone', async t => {
  const { root, record } = fixture(t);
  const adapter = new OfflineASR(root, { spawnImpl: () => child() });
  const jobsDir = path.join(root, 'jobs');
  const oldA = path.join(jobsDir, adapter.recordJobPrefix('private-record-a') + 'stale1');
  fs.mkdirSync(oldA, { recursive: true });
  fs.writeFileSync(path.join(oldA, 'segment.json'), 'previous private transcript');
  const unownedLegacy = path.join(jobsDir, 'transcribe-legacy123');
  fs.mkdirSync(unownedLegacy);
  const abort = new AbortController();
  const running = adapter.transcribe({ ...record, id: 'private-record-b' }, { signal: abort.signal });
  const activeB = [...adapter.activeJobs][0];
  assert.equal(path.basename(activeB).includes('private-record-b'), false);
  const cleanup = adapter.cleanupRecordJobs('private-record-a');
  assert.equal(cleanup.ok, true);
  assert.equal(cleanup.cleaned, 1);
  assert.equal(fs.existsSync(oldA), false);
  assert.equal(fs.existsSync(activeB), true);
  assert.equal(fs.existsSync(unownedLegacy), true);
  assert.throws(() => adapter.cleanupRecordJobs('private-record-b'), error => error.code === 'ASR_JOBS_BUSY');
  abort.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(adapter.cleanupRecordJobs('private-record-b').ok, true);
  assert.equal(adapter.cleanupStaleJobs().cleaned, 1);
});

test('per-record failed cleanup can be retried without touching another record', t => {
  const { root } = fixture(t);
  const adapter = new OfflineASR(root);
  const jobsDir = path.join(root, 'jobs');
  const own = path.join(jobsDir, adapter.recordJobPrefix('record-a') + 'failed1');
  const other = path.join(jobsDir, adapter.recordJobPrefix('record-b') + 'other1');
  fs.mkdirSync(own, { recursive: true });
  fs.mkdirSync(other);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  const removeLink = makeDirectoryLink(t, outside, path.join(own, 'linked'));
  const failed = adapter.cleanupRecordJobs('record-a');
  assert.equal(failed.ok, false);
  assert.equal(failed.remaining[0].code, 'ASR_UNSAFE_JOB_PATH');
  assert.equal(fs.existsSync(other), true);
  removeLink();
  assert.equal(adapter.cleanupRecordJobs('record-a').cleaned, 1);
  assert.equal(fs.existsSync(other), true);
});
