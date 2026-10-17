'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalStore } = require('../src/core/store.cjs');

function fixture(t) {
  // Workspace-local fixtures avoid Windows AppContainer TEMP rename restrictions.
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-core-'));
  const store = new LocalStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}

test('completed record preserves segments/screenshots and double completion does not duplicate', t => {
  const { store, dir } = fixture(t);
  const draft = store.createDraft({ source: { windowTitle: '项目方向' }, task: '寻找求职项目' });
  const token = store.draftToken(draft.id);
  store.addSegment(draft.id, { bytes: Buffer.from('fake-wav'), id: 'seg-1', transcript: '我想保存收藏时的理由', durationMs: 1200 }, token);
  store.addScreenshot(draft.id, Buffer.from('fake-png'), { capturedAt: 100 }, token);
  assert.equal(store.search('收藏理由').length, 0);
  const record = store.complete(draft.id);
  assert.equal(record.status, 'saved');
  assert.equal(record.segments.length, 1);
  assert.equal(record.screenshots.length, 1);
  assert.equal(record.durationMs, 1200);
  assert.equal(fs.existsSync(record.segments[0].path), true);
  assert.equal(fs.existsSync(path.join(dir, 'drafts', draft.id)), false);
  assert.equal(store.complete(draft.id).id, draft.id);
  assert.equal(store.listRecords().length, 1);
  assert.equal(store.accepts(token), false);
  assert.equal(store.search('收藏 理由')[0].id, draft.id);
  assert.equal(store.search('收藏 理由')[0].searchMode, 'local-keyword');
});

test('discard removes all attachments and metadata and blocks late callback writes', t => {
  const { store, dir } = fixture(t);
  const draft = store.createDraft({ source: { windowTitle: 'Secret source' }, notes: 'private note' });
  const token = store.draftToken(draft.id);
  const audio = store.addSegment(draft.id, { bytes: Buffer.from('private audio') }, token);
  const screenshot = store.addScreenshot(draft.id, Buffer.from('private image'), {}, token);
  const result = store.discard(draft.id);
  assert.equal(result.cleaned, true);
  assert.equal(store.accepts(token), false);
  assert.equal(fs.existsSync(audio.path), false);
  assert.equal(fs.existsSync(screenshot.path), false);
  assert.equal(fs.existsSync(path.join(dir, 'drafts', draft.id)), false);
  assert.equal(store.getDraft(draft.id), null);
  assert.equal(store.listDrafts().length, 0);
  assert.throws(() => store.addScreenshot(draft.id, Buffer.from('late'), {}, token), /cancelled/);
  assert.throws(() => store.createDraft({ id: draft.id }), /already been used/);
  assert.equal(store.discard(draft.id).cleaned, true);
  assert.equal(store.row(draft.id).source_json, null);
  assert.equal(store.row(draft.id).notes, '');
});

test('recording identifiers and path traversal are rejected', t => {
  const { store } = fixture(t);
  for (const id of ['../outside', '..\\outside', '/root', 'C:\\outside', 'x/y', '']) {
    assert.throws(() => store.createDraft({ id }), /Invalid local/);
  }
  assert.throws(() => store.safePath(path.join(store.rootDir, '..', 'outside')), /escapes/);
  const draft = store.createDraft();
  assert.throws(() => store.addScreenshot(draft.id, Buffer.from('bad'), { ext: '../png' }), /Unsupported/);
});

test('crash recovery keeps unresolved drafts out of saved search', t => {
  const { store } = fixture(t);
  const draft = store.createDraft({ notes: '保留未完成草稿' });
  store.recover();
  assert.equal(store.listDrafts()[0].id, draft.id);
  assert.equal(store.search('草稿').length, 0);
  assert.equal(store.listRecords().length, 0);
});

test('transcripts must reference real segment IDs and updates become searchable', t => {
  const { store } = fixture(t);
  const draft = store.createDraft();
  store.addSegment(draft.id, { id: 'segment-1', bytes: Buffer.from('wav') });
  store.complete(draft.id);
  assert.throws(() => store.setTranscript(draft.id, [{ id: 'nonexistent', text: 'bad' }]), /unknown/);
  store.setTranscript(draft.id, [{ segmentId: 'segment-1', text: '我要研究作品集产品取舍' }]);
  assert.equal(store.search('作品集')[0].id, draft.id);
  assert.equal(store.getRecord(draft.id).segments[0].transcript, '我要研究作品集产品取舍');
  store.deleteRecord(draft.id);
  assert.equal(store.search('作品集').length, 0);
});

test('foreign draft token cannot write into another session', t => {
  const { store } = fixture(t);
  const a = store.createDraft();
  const b = store.createDraft();
  assert.throws(() => store.addSegment(b.id, { bytes: Buffer.from('bad') }, store.draftToken(a.id)), /cancelled/);
});

test('commit recovery finalizes an explicitly committing record after attachments were moved', t => {
  const { store } = fixture(t);
  const draft = store.createDraft({ notes: '恢复完成中的记录' });
  store.addSegment(draft.id, { id: 'recover-segment', bytes: Buffer.from('wav') });
  store.db.prepare("UPDATE records SET status='committing' WHERE id=?").run(draft.id);
  fs.renameSync(store.directory(draft.id), store.directory(draft.id, 'saved'));
  store.recover();
  const restored = store.getRecord(draft.id);
  assert.equal(restored.status, 'saved');
  assert.equal(fs.existsSync(restored.segments[0].path), true);
  assert.equal(store.listDrafts().length, 0);
  assert.equal(store.listRecords().length, 1);
});

test('interrupted cleanup remains hidden and startup recovery completes deletion', t => {
  const { store } = fixture(t);
  const draft = store.createDraft({ notes: '需要清理的隐私文字' });
  const screenshot = store.addScreenshot(draft.id, Buffer.from('image'));
  store.db.prepare("UPDATE records SET status='delete_pending' WHERE id=?").run(draft.id);
  assert.equal(store.listPendingCleanup().length, 1);
  assert.equal(store.getDraft(draft.id), null);
  assert.equal(store.get(draft.id), null);
  store.recover();
  assert.equal(fs.existsSync(screenshot.path), false);
  assert.equal(store.listPendingCleanup().length, 0);
  assert.equal(store.row(draft.id).notes, '');
});

test('a transcript batch rolls back all changes if one segment does not exist', t => {
  const { store } = fixture(t);
  const draft = store.createDraft();
  store.addSegment(draft.id, { id: 'rollback-segment', bytes: Buffer.from('wav'), transcript: '原始文字' });
  store.complete(draft.id);
  assert.throws(() => store.setTranscript(draft.id, [{ id: 'rollback-segment', text: '不应提交' }, { id: 'missing', text: '坏引用' }]), /unknown/);
  assert.equal(store.getRecord(draft.id).transcript, '原始文字');
});

test('generated title atomically fills a blank saved title once and updates keyword search', t => {
  const { store } = fixture(t);
  const draft = store.createDraft({ title: '\t　 ' });
  store.complete(draft.id);
  const result = store.setGeneratedTitleIfUntitled(draft.id, ' 留住收藏理由 ');
  assert.equal(result.updated, true);
  assert.equal(result.record.title, '留住收藏理由');
  assert.equal(store.search('留住收藏理由')[0].id, draft.id);
  assert.equal(store.setGeneratedTitleIfUntitled(draft.id, '重复自动标题').updated, false);
  assert.equal(store.getRecord(draft.id).title, '留住收藏理由');
});

test('late generated title cannot overwrite a user edit made through another connection', t => {
  const { store } = fixture(t);
  const draft = store.createDraft(); store.complete(draft.id);
  const secondConnection = new LocalStore(store.rootDir);
  try {
    secondConnection.updateRecord(draft.id, { title: '我的手动标题' });
    const result = store.setGeneratedTitleIfUntitled(draft.id, '迟到的自动标题');
    assert.equal(result.updated, false);
    assert.equal(result.record.title, '我的手动标题');
  } finally { secondConnection.close(); }
});

test('late generated title never revives deleted records or titles provisional drafts', t => {
  const { store } = fixture(t);
  const draft = store.createDraft();
  assert.deepEqual(store.setGeneratedTitleIfUntitled(draft.id, '不应写入草稿'), { updated: false, record: null });
  assert.equal(store.getDraft(draft.id).title, '');
  store.complete(draft.id); store.deleteRecord(draft.id);
  assert.deepEqual(store.setGeneratedTitleIfUntitled(draft.id, '不应复活记录'), { updated: false, record: null });
  assert.equal(store.listRecords().length, 0);
  assert.equal(store.row(draft.id).title, '');
});
