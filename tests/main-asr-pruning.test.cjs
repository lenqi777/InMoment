'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { LocalStore } = require('../src/core/store.cjs');

// Runs the production normal-record transcribe coordinator with synthetic files
// and a mock recognizer. Electron never starts; no microphone/network/model runs.
function fixture(t, transcripts = ['', '', ''], recognize) {
  const root = fs.mkdtempSync(path.join(__dirname, '.tmp-asr-pruning-'));
  const store = new LocalStore(root);
  const draft = store.createDraft({ id: 'record', notes: '保留用户的补充文字' });
  for (const [index, transcript] of transcripts.entries()) store.addSegment(draft.id, { id: 'audio-' + index, bytes: Buffer.from('synthetic audio ' + index), transcript, durationMs: 1000 });
  store.addScreenshot(draft.id, Buffer.from('synthetic screenshot'));
  const initial = store.complete(draft.id), cancelled = [], invalidated = [];
  let calls = 0;
  const filename = path.resolve(__dirname, '../src/main/main.cjs'), localRequire = createRequire(filename);
  const electron = { app: { setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on() {} }, protocol: { registerSchemesAsPrivileged() {} } };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : localRequire(name), __dirname: path.dirname(filename), process: { platform: 'win32', env: {} }, Buffer, URL, Response, AbortController, Promise, console });
  vm.runInContext(fs.readFileSync(filename, 'utf8') + '\n globalThis.asrFixture = { transcribe, init(value) { store=value.store; offlineASR=value.asr; autoTitles=value.titles; semantic=value.semantic; }, modelJobs };', context);
  context.asrFixture.init({ store, asr: { capabilities: () => ({ available: true }), transcribe: async (...args) => { calls++; return recognize(...args); } }, titles: { run: async () => {}, cancel: id => cancelled.push(id) }, semantic: { invalidate: id => invalidated.push(id) } });
  const model = new AbortController(); context.asrFixture.modelJobs.set(draft.id, model);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, initial, cancelled, invalidated, model, run: () => context.asrFixture.transcribe(draft.id), get calls() { return calls; } };
}
const result = values => ({ text: '聚合文字不能误分配给没有语音的片段', durationMs: 100, segments: values.map((text, i) => ({ id: 'audio-' + i, text })), timings: values.map((text, i) => ({ segmentId: 'audio-' + i, text, startMs: 0, endMs: 1000 })) });

test('normal saved-record ASR removes only empty segments, renumbers and cleans derived results', async t => {
  const fx = fixture(t, ['', '.', '', ''], async () => result(['真实想法！', '。！？', '１２３。', '★😀']));
  const generation = fx.store.row('record').generation;
  const visible = await fx.run(), saved = fx.store.getRecord('record');
  assert.deepEqual(saved.segments.map(s => [s.id, s.order, s.transcript]), [['audio-0', 1, '真实想法！'], ['audio-2', 2, '１２３。']]);
  assert.deepEqual(Array.from(visible.audioSegments, s => s.id), ['audio-0', 'audio-2']);
  for (const [i, segment] of fx.initial.segments.entries()) assert.equal(fs.existsSync(segment.path), [0, 2].includes(i));
  assert.equal(saved.durationMs, 2000); assert.equal(saved.notes, '保留用户的补充文字'); assert.equal(fs.existsSync(saved.screenshots[0].path), true);
  assert.deepEqual(saved.transcription.segments.map(s => s.id), ['audio-0', 'audio-2']);
  assert.deepEqual(saved.transcription.timings.map(s => s.segmentId), ['audio-0', 'audio-2']);
  assert.equal(saved.transcription.text, '真实想法！\n１２３。'); assert.equal(saved.transcription.audioDurationMs, 2000);
  assert.notEqual(fx.store.row('record').generation, generation); assert.equal(fx.model.signal.aborted, true); assert.deepEqual(fx.cancelled, ['record']); assert.deepEqual(fx.invalidated, ['record']);
});

test('all punctuation removes audio blocks while preserving the record, notes and screenshots', async t => {
  const fx = fixture(t, ['.', ''], async () => result(['。…！？', ' \n★😀 ' ]));
  const visible = await fx.run(), saved = fx.store.getRecord('record');
  assert.equal(saved.segments.length, 0); assert.equal(visible.audioSegments.length, 0); assert.equal(saved.transcription.segments.length, 0); assert.equal(saved.transcription.timings.length, 0); assert.equal(saved.transcription.text, '');
  assert.equal(saved.notes, '保留用户的补充文字'); assert.equal(saved.screenshots.length, 1); assert.equal(saved.jobs.find(j => j.kind === 'transcribe').status, 'done');
  for (const segment of fx.initial.segments) assert.equal(fs.existsSync(segment.path), false);
  await fx.run(); assert.equal(fx.calls, 1);
});

test('empty re-recognition preserves prior valid speech', async t => {
  const fx = fixture(t, ['此前正确的文字。', ''], async () => result(['。', '']));
  await fx.run(); const saved = fx.store.getRecord('record');
  assert.equal(saved.segments.length, 1); assert.equal(saved.segments[0].transcript, '此前正确的文字。'); assert.equal(fs.existsSync(saved.segments[0].path), true);
});

test('manual transcript edits made during ASR prevent both overwrite and audio removal', async t => {
  let resolve; const fx = fixture(t, ['', ''], () => new Promise(done => { resolve = done; }));
  const pending = fx.run(); fx.store.setTranscript('record', [{ id: 'audio-1', text: '用户刚刚改好的文字' }]); resolve(result(['。', '。'])); await pending;
  const saved = fx.store.getRecord('record'); assert.equal(saved.segments.length, 2); assert.equal(saved.segments[1].transcript, '用户刚刚改好的文字');
  assert.equal(saved.jobs.find(j => j.kind === 'transcribe').status, 'not-applied'); for (const s of saved.segments) assert.equal(fs.existsSync(s.path), true);
});

test('ASR failure leaves saved audio unchanged', async t => {
  const fx = fixture(t, ['', '.'], async () => { throw new Error('synthetic recognition failure'); });
  await assert.rejects(fx.run(), /synthetic/); assert.equal(fx.store.getRecord('record').segments.length, 2);
  for (const s of fx.initial.segments) assert.equal(fs.existsSync(s.path), true);
});

test('a deleted record rejects a late successful ASR callback', async t => {
  let resolve; const fx = fixture(t, [''], () => new Promise(done => { resolve = done; }));
  const pending = fx.run(); fx.store.deleteRecord('record'); resolve(result(['。'])); assert.equal(await pending, null); assert.equal(fx.store.getRecord('record'), null);
});

test('database failure rolls back segment removal before physical files are touched', async t => {
  const fx = fixture(t, [''], async () => result(['。']));
  t.mock.method(fx.store, 'saveTranscription', () => { throw new Error('synthetic database failure'); });
  await assert.rejects(fx.run(), /database failure/); assert.equal(fx.store.getRecord('record').segments.length, 1); assert.equal(fs.existsSync(fx.initial.segments[0].path), true);
  assert.equal(fx.store.db.prepare('SELECT COUNT(*) AS count FROM transcription_audio_cleanup').get().count, 0);
});

test('failed physical cleanup stays journaled and explicit retry cleans without another ASR run', async t => {
  const fx = fixture(t, [''], async () => result(['。'])); const audio = fx.initial.segments[0].path;
  const original = fs.rmSync; const stub = t.mock.method(fs, 'rmSync', (filename, ...args) => { if (filename === audio) throw new Error('synthetic file lock'); return original(filename, ...args); });
  await fx.run(); assert.equal(fx.store.getRecord('record').segments.length, 0); assert.equal(fs.existsSync(audio), true); assert.equal(fx.store.getRecord('record').jobs.find(j => j.kind === 'transcribe').status, 'failed');
  assert.equal(fx.store.db.prepare('SELECT COUNT(*) AS count FROM transcription_audio_cleanup').get().count, 1);
  stub.mock.restore(); await fx.run(); assert.equal(fs.existsSync(audio), false); assert.equal(fx.calls, 1); assert.equal(fx.store.db.prepare('SELECT COUNT(*) AS count FROM transcription_audio_cleanup').get().count, 0);
});

test('recovery retries only authorized cleanup and leaves old punctuation records untouched', async t => {
  const fx = fixture(t, [''], async () => result(['。'])), audio = fx.initial.segments[0].path;
  const legacy = fx.store.createDraft({ id: 'legacy' }); fx.store.addSegment(legacy.id, { id: 'legacy-audio', bytes: Buffer.from('synthetic legacy audio'), transcript: '.' }); fx.store.complete(legacy.id);
  const original = fs.rmSync, stub = t.mock.method(fs, 'rmSync', (filename, ...args) => { if (filename === audio) throw new Error('synthetic file lock'); return original(filename, ...args); });
  await fx.run(); stub.mock.restore(); fx.store.recover();
  assert.equal(fs.existsSync(audio), false); assert.equal(fx.store.getRecord('record').jobs.find(j => j.kind === 'transcribe').status, 'done');
  const untouched = fx.store.getRecord('legacy'); assert.equal(untouched.segments[0].transcript, '.'); assert.equal(fs.existsSync(untouched.segments[0].path), true); assert.equal(fx.calls, 1);
});
