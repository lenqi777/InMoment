'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { LocalStore } = require('../src/core/store.cjs');
const { CaptureController } = require('../src/main/capture-controller.cjs');

function localStore(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-text-only-'));
  const store = new LocalStore(dir);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function fixture(t, transcribeDraft) {
  const store = localStore(t);
  const bridge = new EventEmitter();
  bridge.request = async () => ({});
  let token;
  const controller = new CaptureController({
    store, bridge, transcribeDraft,
    settings: { public: () => ({ captureScreenshots: false, inputEnabled: false, excludedApps: [] }) },
    sendRecorder: command => { if (command.command === 'prepare') token = command.token; },
    showOverlay() {},
    hideOverlay() {},
  });
  async function pauseAfterAudio() {
    assert.equal(controller.microphoneReady({ token, sampleRate: 16000 }).allowed, true);
    controller.audioChunk({ token, pcm: new Int16Array([100, -100, 200, -200]).buffer });
    controller.pause();
    await controller.segmentStopped({ token, reason: 'pause' });
  }
  return { store, controller, pauseAfterAudio };
}

test('pause previews text locally, continuation appends only new speech, and final save removes the audio', async t => {
  const inputs = [];
  const { controller, store, pauseAfterAudio } = fixture(t, async ({ segments }) => {
    inputs.push(segments.map(segment => segment.id));
    return { segments: segments.map(segment => ({ id: segment.id, text: inputs.length === 1 ? '第一次语音' : '继续补充' })) };
  });
  const { id, keepAudio } = await controller.startManual();
  assert.equal(keepAudio, false);
  await pauseAfterAudio();
  await controller.previewText();
  assert.equal(controller.snapshot().draftTranscript, '第一次语音');
  const firstAudio = store.getDraft(id).segments[0].path;
  assert.equal(fs.existsSync(firstAudio), true);
  assert.equal(store.getRecord(id), null);
  controller.continueRecording('修改后的第一段');
  await pauseAfterAudio();
  await controller.previewText();
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every(input => input.length === 1));
  assert.notEqual(inputs[0][0], inputs[1][0]);
  assert.equal(controller.snapshot().draftTranscript, '修改后的第一段\n继续补充');
  const provisional = store.getDraft(id);
  const image = store.addScreenshot(id, Buffer.from([137, 80, 78, 71]), { method: 'region' }, store.draftToken(id));
  const saved = await controller.finish('最后编辑的文字');
  assert.equal(saved.transcript, '最后编辑的文字');
  assert.equal(saved.hasTranscriptOverride, true);
  assert.deepEqual(saved.segments, []);
  assert.equal(saved.screenshots.length, 1);
  assert.equal(fs.existsSync(saved.screenshots[0].path), true);
  assert.equal(saved.screenshots[0].id, image.id);
  for (const segment of provisional.segments) assert.equal(fs.existsSync(path.join(store.directory(id, 'saved'), path.basename(segment.path))), false);
  assert.equal(store.search('最后编辑')[0].id, id);
});

test('keeping only audio cancels an in-flight preview and preserves the recording', async t => {
  let started, complete, aborted = false;
  const entered = new Promise(resolve => { started = resolve; });
  const { controller, store, pauseAfterAudio } = fixture(t, (draft, { signal }) => new Promise(resolve => {
    complete = () => resolve({ segments: draft.segments.map(segment => ({ id: segment.id, text: '过期结果' })) });
    signal.addEventListener('abort', () => { aborted = true; complete(); }, { once: true });
    started();
  }));
  const { id } = await controller.startManual();
  await pauseAfterAudio();
  await entered;
  controller.setRetention({ keepAudio: true, keepText: false, transcript: '暂时手写的内容' });
  const saved = await controller.finish();
  assert.equal(aborted, true);
  assert.equal(saved.id, id);
  assert.equal(saved.transcript, '');
  assert.equal(saved.keepText, false);
  assert.equal(saved.hasTranscriptOverride, true);
  assert.equal(saved.segments.length, 1);
  assert.equal(fs.existsSync(saved.segments[0].path), true);
  assert.equal(store.getDraft(id), null);
});

test('retaining both stores editable body and audio, while declining both leaves the prior choices intact', async t => {
  const { controller, store, pauseAfterAudio } = fixture(t, async ({ segments }) => ({ segments: segments.map(segment => ({ id: segment.id, text: '本机转写结果' })) }));
  const { id } = await controller.startManual();
  controller.setRetention({ keepAudio: true, keepText: true });
  await pauseAfterAudio();
  await controller.previewText();
  assert.equal(controller.snapshot().draftTranscript, '本机转写结果');
  assert.throws(() => controller.setRetention({ keepAudio: false, keepText: false, transcript: '无效选择' }), /至少保留/u);
  const draft = store.getDraft(id);
  assert.equal(draft.keepAudio, true);
  assert.equal(draft.keepText, true);
  assert.equal(draft.transcript, '本机转写结果');
  const saved = await controller.finish('我改过的笔记');
  assert.equal(saved.transcript, '我改过的笔记');
  assert.equal(saved.keepAudio, true);
  assert.equal(saved.keepText, true);
  assert.equal(saved.segments.length, 1);
  assert.equal(fs.existsSync(saved.segments[0].path), true);
});

test('a transcription failure keeps the audio until the user explicitly supplies replacement text', async t => {
  const { controller, store, pauseAfterAudio } = fixture(t, async () => { throw new Error('离线组件不可用'); });
  const { id } = await controller.startManual();
  await pauseAfterAudio();
  await controller.previewText();
  assert.match(controller.snapshot().textPreviewError, /离线组件不可用/u);
  await assert.rejects(controller.finish('   '), /要保留的笔记正文/u);
  assert.equal(fs.existsSync(store.getDraft(id).segments[0].path), true);
  assert.equal((await controller.finish('手写的灵感')).transcript, '手写的灵感');
});

test('discard cancels an unfinished preview before removing draft files and metadata', async t => {
  let started, release, aborted = false;
  const entered = new Promise(resolve => { started = resolve; });
  const { controller, store, pauseAfterAudio } = fixture(t, (draft, { signal }) => new Promise(resolve => {
    release = () => resolve({ segments: draft.segments.map(segment => ({ id: segment.id, text: '迟到的结果' })) });
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    started();
  }));
  const { id } = await controller.startManual();
  await pauseAfterAudio();
  await entered;
  const discard = controller.discard();
  assert.equal(aborted, true);
  assert.equal(store.getDraft(id), null);
  release();
  await discard;
  assert.equal(store.getRecord(id), null);
  assert.equal(fs.existsSync(store.directory(id)), false);
  assert.equal(store.row(id).transcript_override, null);
});

test('old record conversion checks the editing version and retains text, source, screenshots and topics', t => {
  const store = localStore(t);
  const topic = store.createTopic('研究');
  const { id } = store.createDraft({ source: { url: 'https://example.test/' }, topicIds: [topic.id] });
  const token = store.draftToken(id);
  store.addSegment(id, { bytes: Buffer.from('synthetic WAV'), transcript: '最初的转写' }, token);
  store.addScreenshot(id, Buffer.from('synthetic PNG'), {}, token);
  const saved = store.complete(id);
  const edited = store.updateRecord(id, { transcript: '现有手工修订' });
  assert.throws(() => store.keepRecordTextOnly(id, '过期的文字', { expectedVersion: saved.version }), { code: 'STALE_RECORD' });
  assert.equal(fs.existsSync(saved.segments[0].path), true);
  assert.equal(store.keepRecordTextOnly(id, edited.transcript, { expectedVersion: edited.version }).ok, true);
  const converted = store.getRecord(id);
  assert.equal(converted.transcript, edited.transcript);
  assert.deepEqual(converted.segments, []);
  assert.equal(converted.source.url, 'https://example.test/');
  assert.equal(converted.topics[0].id, topic.id);
  assert.equal(converted.screenshots.length, 1);
  assert.equal(fs.existsSync(saved.segments[0].path), false);
  assert.equal(store.search('现有手工修订')[0].id, id);
});

test('interrupted text-only save journals a recoverable cleanup before exposing the saved record', t => {
  const store = localStore(t);
  const { id } = store.createDraft({ keepAudio: false });
  store.addSegment(id, { bytes: Buffer.from('synthetic WAV'), transcript: '旧的转写' }, store.draftToken(id));
  const [segment] = store.getDraft(id).segments;
  const remove = fs.rmSync;
  const lock = t.mock.method(fs, 'rmSync', (filename, options) => {
    if (filename === segment.path) throw new Error('模拟文件占用');
    return remove(filename, options);
  });
  assert.throws(() => store.complete(id, { transcript: '已核对的文字' }), /仍待清理/u);
  assert.equal(store.getRecord(id), null);
  assert.equal(store.getDraft(id).status, 'committing');
  assert.equal(store.getDraft(id).transcript, '已核对的文字');
  assert.equal(store.getDraft(id).audioCleanupPending, true);
  assert.equal(fs.existsSync(segment.path), true);
  lock.mock.restore();
  store.close();
  const reopened = new LocalStore(store.rootDir);
  try {
    const recovered = reopened.getRecord(id);
    assert.equal(recovered.transcript, '已核对的文字');
    assert.equal(recovered.audioCleanupPending, false);
    assert.equal(recovered.segments.length, 0);
    assert.deepEqual(fs.readdirSync(reopened.directory(id, 'saved')), []);
  } finally { reopened.close(); }
});
