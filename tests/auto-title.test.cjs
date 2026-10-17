'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalStore } = require('../src/core/store.cjs');
const { AutoTitleManager } = require('../src/main/auto-title.cjs');
const { Settings } = require('../src/main/settings.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-title-'));
  const store = new LocalStore(dir);
  const draft = store.createDraft({});
  store.addSegment(draft.id, { bytes: Buffer.from('synthetic-test-audio'), ext: 'wav', transcript: '阅读项目作品集时想到如何保留灵感的上下文。' }, store.draftToken(draft.id));
  const record = store.complete(draft.id);
  const value = { cloudEnabled: true, autoTitleEnabled: true, autoTitleConsentVersion: 1, hasApiKey: true };
  const settings = { public: () => value };
  let calls = 0, resolve, requestSignal;
  const createClient = () => ({ generateTitle: async (input, options) => { calls++; requestSignal = options.signal; assert.equal(input.id, record.id); assert.equal(options.approved, true); return new Promise(done => { resolve = done; }); } });
  const manager = new AutoTitleManager({ store, settings, createClient, networkDisabled: () => false });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, record, value, settings, manager, calls: () => calls, reply: title => resolve({ title }), signal: () => requestSignal };
}
const dispatch = () => new Promise(resolve => setImmediate(resolve));

test('automatic title is sent once only after consent, cloud opt-in and a saved transcript', async t => {
  const fx = fixture(t);
  for (const key of ['cloudEnabled', 'autoTitleEnabled', 'hasApiKey']) { fx.value[key] = false; await fx.manager.run(fx.record.id); fx.value[key] = true; }
  fx.value.autoTitleConsentVersion = 0; await fx.manager.run(fx.record.id); fx.value.autoTitleConsentVersion = 1;
  assert.equal(fx.calls(), 0);
  const first = fx.manager.run(fx.record.id), repeated = fx.manager.run(fx.record.id);
  assert.equal(first, repeated); await dispatch(); assert.equal(fx.calls(), 1);
  fx.reply('保存阅读时的灵感情境'); await first;
  assert.equal(fx.store.getRecord(fx.record.id).title, '保存阅读时的灵感情境');
  await fx.manager.run(fx.record.id); assert.equal(fx.calls(), 1);
});

test('network-disabled test mode prevents even an injected title client from starting', async t => {
  const fx = fixture(t); fx.manager.networkDisabled = () => true;
  await fx.manager.run(fx.record.id); assert.equal(fx.calls(), 0);
  assert.equal(fx.store.getRecord(fx.record.id).jobs.length, 0);
});

test('a pending generated title cannot overwrite a manually saved title', async t => {
  const fx = fixture(t), pending = fx.manager.run(fx.record.id); await dispatch();
  fx.store.updateRecord(fx.record.id, { title: '我的人工标题' }); fx.reply('模型的旧标题'); await pending;
  const saved = fx.store.getRecord(fx.record.id); assert.equal(saved.title, '我的人工标题');
  assert.equal(saved.jobs.find(job => job.kind === 'title').status, 'not-applied');
});

test('editing transcript while naming is pending prevents an obsolete title from applying', async t => {
  const fx = fixture(t), pending = fx.manager.run(fx.record.id); await dispatch();
  fx.store.setTranscript(fx.record.id, [{ id: fx.record.segments[0].id, text: '这条表达已由用户修正。' }]);
  fx.reply('过时的旧内容标题'); await pending;
  const saved = fx.store.getRecord(fx.record.id); assert.equal(saved.title, '');
  assert.equal(saved.jobs.find(job => job.kind === 'title').status, 'not-applied');
});

test('delete cancels the title worker and late results cannot recreate the record', async t => {
  const fx = fixture(t), pending = fx.manager.run(fx.record.id); await dispatch();
  fx.manager.cancel(fx.record.id); assert.equal(fx.signal().aborted, true); fx.store.deleteRecord(fx.record.id);
  fx.reply('迟到结果'); await pending; assert.equal(fx.store.getRecord(fx.record.id), null);
});

test('turning the feature off cancels an in-flight response and keeps it from retrying', async t => {
  const fx = fixture(t), pending = fx.manager.run(fx.record.id); await dispatch();
  fx.value.autoTitleEnabled = false; fx.manager.cancelAll(); fx.reply('取消的标题'); await pending;
  assert.equal(fx.store.getRecord(fx.record.id).title, '');
  fx.value.autoTitleEnabled = true; await fx.manager.run(fx.record.id); assert.equal(fx.calls(), 1);
});

test('failed and interrupted calls are persistent and are not repeated on restart', async t => {
  const fx = fixture(t);
  fx.manager.createClient = () => ({ generateTitle: async () => { throw new Error('private provider content'); } });
  await fx.manager.run(fx.record.id);
  assert.equal(fx.store.getRecord(fx.record.id).jobs.find(job => job.kind === 'title').status, 'failed');
  fx.store.setJob(fx.record.id, 'title', 'processing');
  const next = new AutoTitleManager({ store: fx.store, settings: fx.settings, networkDisabled: () => false, createClient: () => { throw new Error('must not start'); } });
  next.recoverInterrupted(); await next.run(fx.record.id);
  assert.equal(fx.store.getRecord(fx.record.id).jobs.find(job => job.kind === 'title').status, 'cancelled');
});

test('closing cancels pending title work before the caller closes the database', async t => {
  const fx = fixture(t), pending = fx.manager.run(fx.record.id); await dispatch();
  const closed = fx.manager.close(); assert.equal(fx.signal().aborted, true);
  fx.reply('退出后的标题'); await Promise.all([pending, closed]); fx.store.close();
  await assert.doesNotReject(fx.manager.run(fx.record.id));
});

test('auto title feature consent cannot be forged through settings form fields', t => {
  const fx = fixture(t);
  const secure = { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('opaque-test-data'), decryptString: () => 'inert-test-key' };
  const settings = new Settings(fx.dir, secure);
  assert.throws(() => settings.save({ autoTitleEnabled: true, autoTitleConsentVersion: 1 }), /确认/);
  assert.equal(settings.public().autoTitleEnabled, false);
  settings.save({ autoTitleEnabled: true }, { approvedAutoTitle: true });
  assert.equal(settings.public().autoTitleConsentVersion, 1);
  settings.save({ autoTitleEnabled: false });
  assert.throws(() => settings.save({ autoTitleEnabled: true }), /确认/);
});
