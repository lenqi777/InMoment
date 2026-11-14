'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalStore } = require('../src/core/store.cjs');
const { ChatCapture } = require('../src/main/chat-capture.cjs');

function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(__dirname, '.tmp-chat-capture-recovery-'));
  const store = new LocalStore(root); const marker = path.join(root, 'chat-audio-owners.json');
  const state = { id: null, state: 'idle', active: false }; const sessions = new Map(); let discarded = 0;
  const controller = { snapshot: () => ({ ...state }), async discard() { discarded++; store.discard(state.id); Object.assign(state, { id: null, state: 'idle', active: false }); } };
  const chats = { get: id => sessions.get(id) || null, update(id, value) { Object.assign(sessions.get(id), value); } };
  const make = () => new ChatCapture({ store, controller, chats, asr: {}, analyzeVoiceActivity: async () => ({ decision: 'empty' }) });
  const mark = draftIds => fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, draftIds }));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, marker, state, controller, chats, sessions, make, mark, discarded: () => discarded };
}

test('restart removes only crash-owned provisional draft audio and leaves ordinary drafts intact', t => {
  const { store, marker, make, mark } = fixture(t);
  const temporary = store.createDraft({ notes: '临时聊天录音' }), regular = store.createDraft({ notes: '普通未保存录音' });
  const audio = store.addSegment(temporary.id, { id: 'synthetic-audio', bytes: Buffer.from('synthetic audio bytes') }, store.draftToken(temporary.id));
  mark([temporary.id]); const capture = make();
  assert.equal(store.getDraft(temporary.id), null); assert.equal(fs.existsSync(audio.path), false); assert.ok(store.getDraft(regular.id));
  assert.deepEqual(capture.recoveryErrors, []); assert.equal(fs.existsSync(marker), false);
});

test('restart never discards saved or committing records named by an ownership marker', t => {
  const { store, marker, make, mark } = fixture(t);
  const saved = store.createDraft({ notes: '用户已明确保存' }); store.complete(saved.id);
  const committing = store.createDraft({ notes: '正在提交' }); store.db.prepare("UPDATE records SET status='committing' WHERE id=?").run(committing.id);
  mark([saved.id, committing.id]); const capture = make();
  assert.equal(store.getRecord(saved.id).status, 'saved'); assert.equal(store.getDraft(committing.id).status, 'committing');
  assert.deepEqual([...capture.persistentOwners], [committing.id]); assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).draftIds, [committing.id]);
});

test('failed crash cleanup keeps its ID marker and exposes a visible recovery error for retry', t => {
  const { store, marker, make, mark } = fixture(t); const draft = store.createDraft(); mark([draft.id]);
  const discard = store.discard.bind(store); store.discard = () => { throw new Error('Synthetic permission failure'); };
  const failed = make(); assert.equal(failed.recoveryErrors.length, 1); assert.ok(store.getDraft(draft.id));
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).draftIds, [draft.id]);
  store.discard = discard; const retried = make(); assert.equal(store.getDraft(draft.id), null); assert.equal(retried.recoveryErrors.length, 0); assert.equal(fs.existsSync(marker), false);
});

test('ownership marker stores IDs only and release revokes recognizer permission before awaiting cleanup', async t => {
  const { store, marker, make, state, sessions } = fixture(t); const draft = store.createDraft({ notes: '不会写入所有权文件' });
  Object.assign(state, { id: draft.id, active: true, state: 'paused' }); sessions.set('chat-1', { audioDraftId: draft.id });
  const capture = make(); capture.own('chat-1', draft.id);
  const saved = fs.readFileSync(marker, 'utf8'); assert.equal(saved.includes('不会写入'), false); assert.equal(saved.includes('chat-1'), false);
  const waiting = deferred(), abort = new AbortController(); capture.jobs.set('chat-1', { promise: waiting.promise, abort });
  const task = capture.release('chat-1');
  assert.equal(capture.owners.has('chat-1'), false); assert.equal(abort.signal.aborted, true); assert.equal(fs.existsSync(marker), true); assert.ok(store.getDraft(draft.id));
  waiting.resolve(); await task;
  assert.equal(store.getDraft(draft.id), null); assert.equal(fs.existsSync(marker), false); assert.equal(sessions.get('chat-1').audioDraftId, null);
});

test('failed runtime cleanup can retry after runtime ownership has already been revoked', async t => {
  const { store, marker, make, state, controller } = fixture(t); const draft = store.createDraft();
  Object.assign(state, { id: draft.id, active: true, state: 'paused' }); const capture = make(); capture.own('chat-1', draft.id);
  const discard = controller.discard; controller.discard = async () => { throw new Error('Synthetic cleanup failure'); };
  await assert.rejects(capture.release('chat-1'), /cleanup failure/u); assert.equal(capture.owners.has('chat-1'), false); assert.equal(fs.existsSync(marker), true);
  controller.discard = discard; await capture.release('chat-1');
  assert.equal(store.getDraft(draft.id), null); assert.equal(fs.existsSync(marker), false); assert.equal(capture.releasing.size, 0);
});

test('overlapping close requests share cleanup and cannot discard twice', async t => {
  const { store, make, state, discarded } = fixture(t); const draft = store.createDraft();
  Object.assign(state, { id: draft.id, active: true, state: 'paused' }); const capture = make(); capture.own('chat-1', draft.id);
  await Promise.all([capture.release('chat-1'), capture.release('chat-1')]); assert.equal(discarded(), 1);
});

test('recording commit blocks runtime cleanup and retains ownership until completion', async t => {
  const { store, marker, make, state } = fixture(t); const draft = store.createDraft();
  Object.assign(state, { id: draft.id, active: true, state: 'paused' }); const capture = make(); capture.own('chat-1', draft.id);
  state.state = 'processing'; await assert.rejects(capture.release('chat-1'), /正在保存/u);
  assert.equal(capture.owners.get('chat-1'), draft.id); assert.equal(fs.existsSync(marker), true);
  store.complete(draft.id); Object.assign(state, { id: null, active: false, state: 'idle' }); await capture.release('chat-1');
  assert.equal(store.getRecord(draft.id).status, 'saved'); assert.equal(fs.existsSync(marker), false);
});

test('malformed or traversal ownership files stop recovery without touching unrelated drafts', t => {
  const { store, marker, make } = fixture(t); const draft = store.createDraft();
  fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, draftIds: ['../outside', draft.id] }));
  assert.throws(make, /清理记录无法读取/u); assert.ok(store.getDraft(draft.id)); assert.equal(fs.existsSync(marker), true);
});

test('failed ownership persistence never exposes an untracked runtime owner', t => {
  const { store, marker, make } = fixture(t); const draft = store.createDraft(); const capture = make();
  fs.mkdirSync(marker); assert.throws(() => capture.own('chat-1', draft.id), /不是普通文件/u);
  assert.equal(capture.owners.size, 0); assert.equal(capture.persistentOwners.size, 0); assert.ok(store.getDraft(draft.id));
});

test('failed ownership persistence while starting a chat recording stops and discards the new draft', async t => {
  const { store, marker, make, state, controller, sessions, discarded } = fixture(t);
  sessions.set('chat-1', { audioDraftId: null }); const capture = make(); let created;
  controller.startManual = async () => {
    created = store.createDraft({ notes: '合成启动草稿' });
    Object.assign(state, { id: created.id, active: true, state: 'recording' });
  };
  fs.mkdirSync(marker);
  await assert.rejects(capture.record('chat-1'), /不是普通文件/u);
  assert.equal(discarded(), 1); assert.equal(state.active, false); assert.equal(store.getDraft(created.id), null);
  assert.equal(capture.owners.size, 0); assert.equal(capture.starts.size, 0); assert.equal(sessions.get('chat-1').audioDraftId, null);
});
