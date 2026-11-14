'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalStore } = require('../src/core/store.cjs');
const { NotesStore } = require('../src/main/notes.cjs');
const { NoteGrouping } = require('../src/main/note-grouping.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-note-grouping-'));
  const store = new LocalStore(dir);
  const notes = new NotesStore(store);
  const grouping = new NoteGrouping({ store, notes });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const written = notes.update(notes.create().id, '食谱', '番茄炒蛋');
  const record = 'test-record';
  store.createDraft({ id: record, title: '晚饭', notes: '用番茄做饭', source: { url: 'https://example.test/private' } });
  store.complete(record);
  const captured = notes.get(`record:${record}`);
  return { grouping, notes, store, written, captured };
}

function modelPlan(records, name = '家庭烹饪') {
  return { schemaVersion: 1, groups: [{ name, reason: '共同讨论食谱', records: records.map(({ id, version }) => ({ id, version })) }], unassigned: [] };
}

test('classification distinguishes same-name subgroups by their full paths', async t => {
  const { grouping, store, notes, written } = fixture(t);
  const home = store.createTopic('家里');
  const work = store.createTopic('工作');
  const atHome = store.createTopic('备忘', home.id);
  const atWork = store.createTopic('备忘', work.id);
  const result = await grouping.suggest(grouping.snapshot([written.id]), async (records, options) => {
    assert.ok(options.availableTopics.includes('工作 / 备忘'));
    assert.ok(options.availableTopics.includes('家里 / 备忘'));
    return modelPlan(records, '工作 / 备忘');
  });
  assert.equal(result.groups[0].key, `topic:${atWork.id}`);
  assert.equal(result.topics.find(topic => topic.id === atHome.id).name, '家里 / 备忘');
  assert.deepEqual(grouping.apply(result.runId, [{ id: written.id, key: result.groups[0].key }]), { applied: 1, skipped: 0 });
  assert.deepEqual(notes.get(written.id).topicIds, [atWork.id]);
});

test('mixed notes receive grouping suggestions from bounded excerpts without pre-applying changes', async t => {
  const { grouping, notes, store, written, captured } = fixture(t);
  const blank = notes.create();
  const child = notes.createSummary(written.id, '摘要');
  const hidden = notes.update(notes.create().id, '未显示的标题', '未显示的正文');
  const existing = store.createTopic('周末');
  grouping.addTopic(captured.id, existing.id);
  assert.throws(() => grouping.snapshot([child.summary.id]), /总结附件/u);
  const result = await grouping.suggest(grouping.snapshot([written.id, captured.id, blank.id]), async (records, options) => {
    assert.deepEqual(records.map(({ id, title, summary }) => ({ id, title, summary })), [
      { id: 'note-0', title: '食谱', summary: '番茄炒蛋' }, { id: 'note-1', title: '晚饭', summary: '用番茄做饭' },
    ]);
    assert.deepEqual(options.availableTopics, ['周末']);
    assert.equal(options.approved, true);
    return modelPlan(records);
  });
  assert.equal(result.omitted, 1);
  assert.equal(result.groups[0].existing, false);
  assert.deepEqual(store.listTopics().map(topic => topic.name), ['周末']);
  assert.deepEqual(notes.get(written.id).topicIds, []);
  assert.throws(() => grouping.apply(result.runId, [{ id: hidden.id, key: result.groups[0].key }]), /变化/u);
  const assignments = result.groups[0].notes.map(note => ({ id: note.id, key: result.groups[0].key }));
  assert.deepEqual(grouping.apply(result.runId, assignments), { applied: 2, skipped: 0 });
  const group = store.listTopics().find(topic => topic.name === '家庭烹饪');
  assert.deepEqual(notes.list('', 0, group.id).notes.map(note => note.id).sort(), [written.id, captured.id].sort());
  assert.ok(notes.get(captured.id).topicIds.includes(existing.id));
  assert.equal(notes.get(written.id).body, written.body);
  assert.equal(notes.get(captured.id).body, captured.body);
  assert.throws(() => grouping.apply(result.runId, assignments), /过期/u);
});

test('cancel, stale input and stale assignments keep the original grouping and avoid empty groups', async t => {
  const { grouping, notes, store, written, captured } = fixture(t);
  const old = grouping.snapshot([written.id, captured.id]);
  notes.update(written.id, written.title, '新正文');
  await assert.rejects(grouping.suggest(old, () => assert.fail('stale excerpt sent')), /已变化/u);
  const latest = grouping.snapshot([written.id, captured.id]);
  const abort = new AbortController();
  assert.deepEqual(await grouping.suggest(latest, async records => {
    abort.abort();
    return modelPlan(records);
  }, { signal: abort.signal }), { cancelled: true });
  assert.throws(() => grouping.apply(latest.runId, []), /过期/u);
  const result = await grouping.suggest(latest, async records => modelPlan(records));
  notes.delete(written.id);
  notes.update(captured.id, captured.title, '最新转写');
  assert.deepEqual(grouping.apply(result.runId, result.groups[0].notes.map(note => ({ id: note.id, key: result.groups[0].key }))), { applied: 0, skipped: 2 });
  assert.deepEqual(store.listTopics(), []);
});

test('manual topic choice and single or bulk merging retain written and captured memberships', t => {
  const { grouping, notes, store, written, captured } = fixture(t);
  const first = store.createTopic('分组甲');
  const second = store.createTopic('分组乙');
  const third = store.createTopic('分组丙');
  grouping.addTopic(written.id, first.id);
  grouping.addTopic(written.id, second.id);
  grouping.addTopic(captured.id, first.id);
  store.mergeTopic(first.id, second.id);
  assert.deepEqual(notes.get(written.id).topicIds, [second.id]);
  assert.deepEqual(notes.get(captured.id).topicIds, [second.id]);
  store.mergeTopics([second.id, third.id], third.id);
  assert.deepEqual(notes.get(written.id).topicIds, [third.id]);
  assert.deepEqual(notes.get(captured.id).topicIds, [third.id]);
  store.deleteTopics([third.id]);
  assert.deepEqual(notes.get(written.id).topicIds, []);
  assert.deepEqual(notes.get(captured.id).topicIds, []);
});
