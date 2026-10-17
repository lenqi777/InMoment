'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { LocalStore } = require('../src/core/store.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-library-'));
  const store = new LocalStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}

function saved(store, { id, title = '', notes = '保存灵感发生时的联想', createdAt, ...fields } = {}) {
  const draft = store.createDraft({ id, title, notes, createdAt, ...fields });
  return store.complete(draft.id);
}

function suggestion(store, leftId, rightId, overrides = {}) {
  const left = store.getRecord(leftId), right = store.getRecord(rightId);
  return { leftId, rightId, leftVersion: left.contentVersion, rightVersion: right.contentVersion,
    reason: '两次表达都希望保留灵感发生的缘由', differences: '后一条补充了使用场景',
    leftQuote: left.transcript || left.notes, rightQuote: right.transcript || right.notes, ...overrides };
}

test('topics normalize names and draft assignments do not leak into saved counts or search', t => {
  const { store } = fixture(t);
  const topic = store.createTopic('  AI  产品 ');
  assert.equal(topic.name, 'AI 产品');
  assert.equal(store.createTopic('ＡＩ 产品').id, topic.id);
  assert.throws(() => store.createTopic('   '), /1–60/);
  assert.throws(() => store.createTopic('题'.repeat(61)), /1–60/);
  const draft = store.createDraft({ topicIds: [topic.id], notes: '这是未完成记录' });
  assert.deepEqual(draft.topics.map(item => item.id), [topic.id]);
  assert.equal(draft.topicsManual, true);
  assert.equal(store.listTopics()[0].recordCount, 0);
  assert.equal(store.listRecords({ topicIds: [topic.id] }).length, 0);
  assert.equal(store.search('AI 产品').length, 0);
  store.complete(draft.id);
  assert.equal(store.listTopics()[0].recordCount, 1);
  assert.equal(store.search('AI 产品')[0].id, draft.id);
});

test('manual topic choices including clearing take priority over late AI suggestions', t => {
  const { store } = fixture(t);
  const a = store.createTopic('阅读'), b = store.createTopic('求职');
  const record = saved(store);
  let next = store.setRecordTopics(record.id, [a.id], { manual: false, expectedVersion: record.contentVersion });
  assert.equal(next.topicsManual, false);
  assert.equal(next.topics[0].manual, false);
  next = store.setRecordTopics(record.id, []);
  assert.equal(next.topicsManual, true);
  next = store.setRecordTopics(record.id, [b.id], { manual: false });
  assert.deepEqual(next.topics, []);
  assert.equal(next.contentVersion, record.contentVersion);
  assert.equal(store.listRecords({ uncategorized: true })[0].id, record.id);
  assert.throws(() => store.setRecordTopics(record.id, ['unknown-topic']), /unavailable/);
  assert.equal(store.getRecord(record.id).topics.length, 0);
  store.updateRecord(record.id, { notes: '修改正文' });
  assert.throws(() => store.setRecordTopics(record.id, [a.id], { manual: false, expectedVersion: record.contentVersion }), /stale/);
});

test('topic rename merge and delete preserve all records and manual provenance', t => {
  const { store } = fixture(t);
  const old = store.createTopic('海洋探索'), target = store.createTopic('目标');
  const a = saved(store, { title: '记录一', topicIds: [old.id] });
  const b = saved(store, { title: '记录二' });
  store.setRecordTopics(b.id, [old.id, target.id], { manual: false });
  store.renameTopic(old.id, '星际旅行');
  assert.equal(store.search('星际旅行').length, 2);
  assert.equal(store.search('海洋探索').length, 0);
  assert.throws(() => store.renameTopic(old.id, '目标'), /merge/);
  store.mergeTopic(old.id, target.id);
  assert.equal(store.listTopics().length, 1);
  assert.equal(store.listTopics()[0].recordCount, 2);
  assert.deepEqual(store.getRecord(a.id).topics.map(item => [item.id, item.manual]), [[target.id, true]]);
  assert.deepEqual(store.getRecord(b.id).topics.map(item => [item.id, item.manual]), [[target.id, false]]);
  store.deleteTopic(target.id);
  assert.equal(store.listTopics().length, 0);
  assert.equal(store.listRecords().length, 2);
  assert.equal(store.listRecords({ uncategorized: true }).length, 2);
  assert.equal(store.getRecord(a.id).title, '记录一');
});

test('bulk group merge deduplicates memberships, preserves provenance and keeps unselected groups and originals', t => {
  const { store } = fixture(t); const a = store.createTopic('甲组'), b = store.createTopic('乙组'), keep = store.createTopic('保留组'), other = store.createTopic('其他组');
  const record = saved(store, { title: '保留标题', topicIds: [a.id, keep.id, other.id] });
  const draft = store.createDraft({ notes: '尚未完成的记录', topicIds: [b.id] });
  const second = saved(store, { title: '第二条记录' }); store.setRecordTopics(second.id, [b.id, keep.id], { manual: false });
  const before = store.getRecord(record.id); const result = store.mergeTopics([a.id, b.id, keep.id, a.id], keep.id);
  assert.equal(result.topic.id, keep.id); assert.equal(result.topic.name, '保留组'); assert.deepEqual(result.mergedIds.sort(), [a.id, b.id].sort());
  assert.deepEqual(store.listTopics().map(topic => topic.name).sort(), ['保留组', '其他组'].sort());
  assert.deepEqual(store.getRecord(record.id).topics.map(topic => [topic.id, topic.manual]).sort(), [[keep.id, true], [other.id, true]].sort());
  assert.deepEqual(store.getRecord(second.id).topics.map(topic => [topic.id, topic.manual]), [[keep.id, false]]);
  assert.deepEqual(store.get(draft.id).topics.map(topic => topic.id), [keep.id]);
  assert.equal(store.getRecord(record.id).title, before.title); assert.equal(store.getRecord(record.id).notes, before.notes); assert.equal(store.getRecord(record.id).version, before.version);
  assert.equal(store.search('甲组').length, 0); assert.equal(store.search('乙组').length, 0); assert.equal(store.search('保留组').length, 2);
});

test('bulk group operations validate the full selection before any write and roll back search failures', t => {
  const { store } = fixture(t); const a = store.createTopic('甲组'), b = store.createTopic('乙组'); const record = saved(store, { topicIds: [a.id, b.id] });
  for (const operation of [() => store.mergeTopics([a.id, 'missing', b.id], b.id), () => store.deleteTopics([a.id, 'missing']), () => store.mergeTopics([a.id, b.id], 'outside'), () => store.deleteTopics([]), () => store.mergeTopics([a.id], a.id)]) assert.throws(operation);
  assert.equal(store.listTopics().length, 2); assert.equal(store.getRecord(record.id).topics.length, 2);
  const refresh = store.refreshSearch; store.refreshSearch = () => { throw new Error('injected search failure'); };
  assert.throws(() => store.mergeTopics([a.id, b.id], b.id), /injected/); assert.throws(() => store.deleteTopics([a.id, b.id]), /injected/); store.refreshSearch = refresh;
  assert.equal(store.listTopics().length, 2); assert.equal(store.getRecord(record.id).topics.length, 2); assert.equal(store.search('甲组').length, 1);
});

test('bulk group deletion retains records, attachments and memberships outside the deleted selection', t => {
  const { store } = fixture(t); const a = store.createTopic('甲组'), b = store.createTopic('乙组'), other = store.createTopic('其他组');
  const draft = store.createDraft({ topicIds: [a.id, b.id, other.id] }); store.addSegment(draft.id, { id: 'bulk-audio', bytes: Buffer.from('synthetic audio only'), transcript: '保留语音' }); const record = store.complete(draft.id);
  const lone = saved(store, { topicIds: [b.id] }); const audio = fs.readFileSync(record.segments[0].path);
  const result = store.deleteTopics([a.id, b.id]); assert.equal(result.deleted, true); assert.deepEqual(result.ids, [a.id, b.id]);
  assert.deepEqual(store.getRecord(record.id).topics.map(topic => topic.id), [other.id]); assert.deepEqual(store.getRecord(lone.id).topics, []); assert.equal(store.listRecords().length, 2); assert.equal(store.listRecords({ uncategorized: true })[0].id, lone.id);
  assert.deepEqual(fs.readFileSync(store.getRecord(record.id).segments[0].path), audio); assert.equal(store.search('甲组').length, 0); assert.equal(store.search('其他组').length, 1);
});

test('time scopes intersect any selected topics and pagination has an honest total', t => {
  const { store } = fixture(t);
  const topic = store.createTopic('产品');
  saved(store, { id: 'old', createdAt: 100, notes: '共同关键词', topicIds: [topic.id] });
  saved(store, { id: 'middle', createdAt: 200, notes: '共同关键词', topicIds: [topic.id] });
  saved(store, { id: 'new', createdAt: 300, notes: '共同关键词' });
  const filters = { from: 100, to: 300, topicIds: [topic.id] };
  assert.deepEqual(store.listRecords(filters).map(record => record.id), ['middle', 'old']);
  assert.equal(store.countRecords(filters), 2);
  assert.deepEqual(store.listRecords({ ...filters, limit: 1, offset: 1 }).map(record => record.id), ['old']);
  assert.equal(store.countRecords({ ...filters, limit: 1, offset: 1 }), 2);
  assert.deepEqual(store.search('共同关键词', { ...filters, limit: 1, offset: 1 }).map(record => record.id), ['old']);
  assert.equal(store.countSearch('共同关键词', filters), 2);
  assert.equal(store.search('共同关键词', { ...filters, limit: 1, offset: 2 }).length, 0);
  assert.deepEqual(store.search('', { limit: 1, offset: 1 }).map(record => record.id), ['middle']);
  assert.deepEqual(store.listRecords({ uncategorized: true }).map(record => record.id), ['new']);
  assert.equal(store.listRecords({ topicIds: ['missing'] }).length, 0);
  assert.throws(() => store.listRecords({ from: 'not-a-time' }), /time filter/);
  assert.throws(() => store.listRecords({ topicIds: ["x' OR 1=1"] }), /Invalid local/);
});

test('unclassified and multiple topics form one union inside the date scope for every local query', t => {
  const { store } = fixture(t);
  const work = store.createTopic('产品'), life = store.createTopic('生活');
  saved(store, { id: 'lower', notes: '共同关键词', createdAt: 100, topicIds: [work.id] });
  saved(store, { id: 'unclassified', notes: '共同关键词', createdAt: 150 });
  saved(store, { id: 'both', notes: '共同关键词', createdAt: 170, topicIds: [work.id, life.id] });
  saved(store, { id: 'other', notes: '共同关键词', createdAt: 180, topicIds: [life.id] });
  saved(store, { id: 'upper', notes: '共同关键词', createdAt: 200 });
  store.createDraft({ id: 'draft', notes: '共同关键词', createdAt: 160 });
  const scope = { from: 100, to: 200, topicIds: [work.id, work.id, 'unknown-topic'], uncategorized: true };
  const expected = ['both', 'unclassified', 'lower'];
  assert.deepEqual(store.listRecords(scope).map(item => item.id), expected);
  assert.deepEqual(store.listRecordHeaders(scope).map(item => item.id), expected);
  assert.equal(store.countRecords(scope), 3);
  assert.equal(store.countSearch('共同关键词', scope), 3);
  assert.deepEqual(store.search('共同关键词', { ...scope, limit: 1, offset: 1 }).map(item => item.id), ['unclassified']);
  assert.deepEqual(store.listRecords({ from: 100, to: 200, unclassified: true }).map(item => item.id), ['unclassified']);
  assert.deepEqual(store.listRecords({ topicIds: ['unknown-topic'] }), []);
  assert.throws(() => store.listRecords({ uncategorized: 'true' }), /filter/);
  assert.throws(() => store.listRecords({ uncategorized: false, unclassified: true }), /Conflicting/);
});

test('group-name migration and manual rename survive reopening without changing originals or settings', t => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-group-name-migrate-'));
  let store = new LocalStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const settingsPath = path.join(dir, 'settings.json');
  const settingsBytes = Buffer.from('{ "thresholdMs": 1725, "fixture": "opaque synthetic settings" }\r\n');
  fs.writeFileSync(settingsPath, settingsBytes);
  const draft = store.createDraft({ id: 'first', title: '阅读时保留联想的理由', notes: '同一灵感' });
  store.addSegment(draft.id, { bytes: Buffer.from('synthetic original audio'), transcript: '同一灵感' });
  store.addScreenshot(draft.id, Buffer.from('synthetic original screenshot'));
  const first = store.complete(draft.id), second = saved(store, { id: 'second', title: '保存当时的联想', notes: '同一灵感' });
  const [candidate] = store.saveDuplicateSuggestions([suggestion(store, first.id, second.id)]);
  const group = store.decideDuplicate(candidate.id, 'group');
  const originalFirst = store.getRecord(first.id), originalSecond = store.getRecord(second.id);
  const audioPath = originalFirst.segments[0].path, screenshotPath = originalFirst.screenshots[0].path;
  const audio = fs.readFileSync(audioPath), image = fs.readFileSync(screenshotPath);
  store.close();
  // Simulate the previous released group table. Existing IDs, memberships,
  // decisions and attachment files all remain in place during the additive upgrade.
  const legacy = new DatabaseSync(path.join(dir, 'inmoment.sqlite'));
  legacy.exec('ALTER TABLE duplicate_groups DROP COLUMN name'); legacy.close();
  store = new LocalStore(dir);
  assert.equal(store.listGroups()[0].id, group.id);
  assert.equal(store.getGroup(group.id).name, '阅读时保留联想的理由');
  assert.equal(store.getGroup(group.id).customName, false);
  assert.deepEqual(store.getRecord(first.id), originalFirst);
  assert.deepEqual(store.getRecord(second.id), originalSecond);
  assert.deepEqual(store.listDuplicateDecisions().map(item => item.id), [candidate.id]);
  assert.equal(store.renameGroup(group.id, '  阅读   与灵感  ').name, '阅读 与灵感');
  assert.throws(() => store.renameGroup(group.id, ''), /1–60/);
  assert.throws(() => store.renameGroup(group.id, '题'.repeat(61)), /1–60/);
  assert.throws(() => store.renameGroup('missing-group', '有效名称'), /不存在/);
  store.close(); store = new LocalStore(dir);
  assert.equal(store.getGroup(group.id).name, '阅读 与灵感');
  assert.equal(store.getGroup(group.id).customName, true);
  assert.deepEqual(fs.readFileSync(audioPath), audio);
  assert.deepEqual(fs.readFileSync(screenshotPath), image);
  assert.deepEqual(fs.readFileSync(settingsPath), settingsBytes);
  assert.deepEqual(store.getRecord(first.id), originalFirst);
  assert.deepEqual(store.getRecord(second.id), originalSecond);
});

test('derived group names follow remaining members and explicit names survive group expansion', t => {
  const { store } = fixture(t);
  const records = ['a', 'b', 'c', 'd'].map((id, index) => saved(store, { id, title: `标题${id}`, createdAt: 100 + index }));
  const [ab, cd, bc] = store.saveDuplicateSuggestions([suggestion(store, 'a', 'b'), suggestion(store, 'c', 'd'), suggestion(store, 'b', 'c')]);
  const left = store.decideDuplicate(ab.id, 'group'), right = store.decideDuplicate(cd.id, 'group');
  assert.equal(left.name, '标题a');
  store.renameGroup(right.id, '用户整理后的组名');
  const merged = store.decideDuplicate(bc.id, 'group');
  assert.equal(merged.id, left.id);
  assert.equal(merged.name, '用户整理后的组名');
  assert.equal(merged.records.length, 4);
  assert.equal(store.listRecords().length, 4);
  store.ungroup(merged.id);
  const freshPair = store.saveDuplicateSuggestions([suggestion(store, 'a', 'c')])[0];
  const freshGroup = store.decideDuplicate(freshPair.id, 'group');
  // Add d via an unused pair so the derived name can be checked after deleting a.
  const extraPair = store.saveDuplicateSuggestions([suggestion(store, 'a', 'd')])[0];
  store.decideDuplicate(extraPair.id, 'group');
  store.deleteRecord('a');
  assert.equal(store.getGroup(freshGroup.id).name, '标题c');
  assert.equal(JSON.stringify(store.getGroup(freshGroup.id)).includes('标题a'), false);
  assert.equal(store.getRecord(records[1].id).title, '标题b');
});

test('continuations require a saved parent and never expose an unfinished child', t => {
  const { store } = fixture(t);
  const parent = saved(store, { title: '旧想法' });
  const draft = store.createDraft({ parentId: parent.id, notes: '在新场景继续思考' });
  assert.equal(draft.parentId, parent.id);
  assert.equal(draft.parentTitle, '旧想法');
  assert.deepEqual(store.getRecord(parent.id).continuations, []);
  assert.throws(() => store.createDraft({ parentId: draft.id }), /saved record/);
  assert.throws(() => store.createDraft({ parentId: 'missing' }), /saved record/);
  const child = store.complete(draft.id);
  assert.equal(child.parentId, parent.id);
  assert.equal(store.getRecord(parent.id).continuations[0].id, child.id);
  store.deleteRecord(parent.id);
  assert.equal(store.getRecord(child.id).parentId, null);
  assert.equal(store.getRecord(child.id).notes, '在新场景继续思考');
});

test('record headers expose saved names and versions without hydrating audio or screenshots', t => {
  const { store } = fixture(t);
  const topics = [store.createTopic('阅读'), store.createTopic('产品')];
  const a = saved(store, { id: 'named', title: '手动标题', createdAt: 10 });
  store.setRecordTopics(a.id, topics.map(topic => topic.id));
  const b = saved(store, { id: 'ai-named', createdAt: 20 });
  store.saveOrganization(b.id, { title: '整理标题' });
  saved(store, { id: 'fallback', createdAt: 30 });
  store.createDraft({ id: 'hidden-draft', title: '不要显示', createdAt: 40 });
  const hydrate = store.hydrate;
  store.hydrate = () => { throw new Error('Header lookup must not hydrate media.'); };
  try {
    const headers = store.listRecordHeaders();
    assert.deepEqual(headers.map(item => [item.id, item.title]), [['fallback', '未命名灵感'], ['ai-named', '整理标题'], ['named', '手动标题']]);
    assert.equal(headers[2].contentVersion, a.contentVersion);
    assert.equal(headers[2].version, a.contentVersion);
    assert.deepEqual(headers[2].topicIds, topics.map(topic => topic.id).sort());
    assert.deepEqual(headers[0].topicIds, []);
    assert.deepEqual(store.listRecordHeaders({ from: 20, to: 30 }).map(item => item.id), ['ai-named']);
    assert.equal(Object.hasOwn(headers[0], 'segments'), false);
    assert.equal(Object.hasOwn(headers[0], 'organization_json'), false);
    assert.equal(Object.hasOwn(headers[0], 'notes'), false);
    assert.equal(Object.hasOwn(headers[0], 'transcript'), false);
    assert.equal(Object.hasOwn(headers[0], 'screenshots'), false);
  } finally { store.hydrate = hydrate; }
});

test('inherited continuation topics stay suggestions instead of locking in a manual choice', t => {
  const { store } = fixture(t);
  const oldTopic = store.createTopic('早先主题'), newTopic = store.createTopic('新的主题');
  const parent = saved(store, { topicIds: [oldTopic.id] });
  const draft = store.createDraft({ parentId: parent.id, topicIds: [oldTopic.id], topicsManual: false });
  assert.equal(draft.topicsManual, false);
  assert.equal(draft.topics[0].manual, false);
  store.complete(draft.id);
  const updated = store.setRecordTopics(draft.id, [newTopic.id], { manual: false });
  assert.deepEqual(updated.topics.map(topic => topic.id), [newTopic.id]);
  const unclassified = store.createDraft({ parentId: parent.id, topicIds: [], topicsManual: false });
  assert.equal(unclassified.topicsManual, false);
});

test('AI results retain provenance, become stale on real edits, and reject late writes', t => {
  const { store } = fixture(t);
  const record = saved(store, { notes: '原始想法' });
  store.saveOrganization(record.id, { summary: '应当过期的整理词' }, { expectedVersion: record.contentVersion });
  assert.equal(store.getRecord(record.id).organizationStale, false);
  assert.equal(store.search('应当过期的整理词').length, 1);
  store.updateRecord(record.id, { notes: record.notes });
  assert.equal(store.getRecord(record.id).contentVersion, record.contentVersion);
  store.updateRecord(record.id, { notes: '现在想法已经不同' });
  const changed = store.getRecord(record.id);
  assert.equal(changed.contentVersion, record.contentVersion + 1);
  assert.equal(changed.organizationStale, true);
  assert.equal(changed.organization.summary, '应当过期的整理词');
  assert.equal(store.search('应当过期的整理词').length, 0);
  assert.throws(() => store.saveOrganization(record.id, { summary: '迟到的结果' }, { expectedVersion: record.contentVersion }), error => error.code === 'STALE_RECORD');
  assert.equal(store.getRecord(record.id).organization.summary, '应当过期的整理词');
  store.saveOrganization(record.id, { summary: '新的整理' }, { expectedVersion: changed.contentVersion });
  assert.equal(store.getRecord(record.id).organizationStale, false);
});

test('title-only rename retains a fresh summary while record versions and duplicate evidence still invalidate', t => {
  const { store } = fixture(t);
  const record = saved(store, { title: '旧标题', notes: '用户真实表达' }), other = saved(store, { notes: '用户真实表达的另一种记录' });
  const organization = { summary: '仍可使用的整理摘要', evidence: [], topicSuggestions: [] };
  store.saveOrganization(record.id, organization);
  const [candidate] = store.saveDuplicateSuggestions([suggestion(store, record.id, other.id)]);
  const renamed = store.updateRecord(record.id, { title: '新标题' }, { expectedVersion: record.version });
  assert.equal(renamed.version, record.version + 1);
  assert.equal(renamed.organizationStale, false);
  assert.deepEqual(renamed.organization, organization);
  assert.equal(renamed.notes, record.notes);
  assert.equal(store.search('仍可使用的整理摘要')[0].id, record.id);
  assert.equal(store.listDuplicateSuggestions().length, 0);
  assert.equal(store.db.prepare('SELECT status FROM duplicate_suggestions WHERE id=?').get(candidate.id).status, 'stale');
  assert.throws(() => store.updateRecord(record.id, { title: '迟到标题' }, { expectedVersion: record.version }), error => error.code === 'STALE_RECORD');
  assert.equal(store.getRecord(record.id).title, '新标题');
});

test('title-only rename never refreshes an already stale summary and real expression changes still make it stale', t => {
  const { store } = fixture(t);
  const draft = store.createDraft({ title: '原始标题', task: '原任务', notes: '原笔记' });
  store.addSegment(draft.id, { id: 'speech', bytes: Buffer.from('synthetic audio'), transcript: '原始口述' });
  const record = store.complete(draft.id);
  store.saveOrganization(record.id, { summary: '旧摘要' });
  const transcribed = store.updateRecord(record.id, { title: '同时修改的标题' }, { transcriptSegments: [{ id: 'speech', text: '修改后的口述' }] });
  assert.equal(transcribed.organizationStale, true);
  const renamed = store.updateRecord(record.id, { title: '只改标题也不能恢复旧摘要' });
  assert.equal(renamed.organizationStale, true);
  assert.equal(renamed.version, transcribed.version + 1);
  store.saveOrganization(record.id, { summary: '新摘要' });
  assert.equal(store.updateRecord(record.id, { title: '另一个标题', task: '新任务' }).organizationStale, true);
  store.saveOrganization(record.id, { summary: '第三版摘要' });
  assert.equal(store.updateRecord(record.id, { title: '最后标题', notes: '新笔记' }).organizationStale, true);
});

test('automatic title preserves fresh organization but never promotes an already stale one', t => {
  const { store } = fixture(t);
  const fresh = saved(store, { notes: '自动命名的原话' });
  store.saveOrganization(fresh.id, { summary: '有效摘要' });
  const generated = store.setGeneratedTitleIfUntitled(fresh.id, '自动标题');
  assert.equal(generated.updated, true);
  assert.equal(generated.record.organizationStale, false);
  assert.equal(generated.record.version, fresh.version + 1);
  const stale = saved(store, { notes: '起初的原话' });
  store.saveOrganization(stale.id, { summary: '过时摘要' });
  store.updateRecord(stale.id, { notes: '原话后来改变了' });
  const result = store.setGeneratedTitleIfUntitled(stale.id, '迟到的自动标题');
  assert.equal(result.updated, true);
  assert.equal(result.record.organizationStale, true);
});

test('transcript batches increment content version once only when the original text changes', t => {
  const { store } = fixture(t);
  const draft = store.createDraft();
  store.addSegment(draft.id, { id: 'first', bytes: Buffer.from('synthetic-audio'), transcript: '原话' });
  const record = store.complete(draft.id);
  store.setTranscript(record.id, [{ id: 'first', text: '原话' }]);
  assert.equal(store.getRecord(record.id).contentVersion, record.contentVersion);
  store.setTranscript(record.id, [{ id: 'first', text: '修正原话' }]);
  assert.equal(store.getRecord(record.id).contentVersion, record.contentVersion + 1);
  assert.throws(() => store.setTranscript(record.id, [{ id: 'first', text: '不应改变' }, { id: 'missing', text: '非法' }]), /unknown/);
  assert.equal(store.getRecord(record.id).contentVersion, record.contentVersion + 1);
  assert.equal(store.getRecord(record.id).transcript, '修正原话');
});

test('one editor save commits title notes and transcript together with one content version', t => {
  const { store } = fixture(t);
  const draft = store.createDraft({ title: '原标题', notes: '原笔记' });
  store.addSegment(draft.id, { id: 'editor-segment', bytes: Buffer.from('synthetic-audio'), transcript: '原话' });
  const record = store.complete(draft.id);
  const updated = store.updateRecord(record.id, { title: '新标题', notes: '新笔记' }, {
    expectedVersion: record.contentVersion, transcriptSegments: [{ id: 'editor-segment', text: '新原话' }],
  });
  assert.equal(updated.title, '新标题');
  assert.equal(updated.notes, '新笔记');
  assert.equal(updated.transcript, '新原话');
  assert.equal(updated.contentVersion, record.contentVersion + 1);
  assert.equal(store.search('新原话')[0].id, record.id);
  assert.throws(() => store.updateRecord(record.id, { title: '不应写入' }, { expectedVersion: record.contentVersion }), error => error.code === 'STALE_RECORD');
  assert.equal(store.getRecord(record.id).title, '新标题');
});

test('an invalid audio reference rolls back an entire editor save without changing the version', t => {
  const { store } = fixture(t);
  const draft = store.createDraft({ title: '保留标题', notes: '保留笔记' });
  store.addSegment(draft.id, { id: 'valid-editor-segment', bytes: Buffer.from('synthetic-audio'), transcript: '保留原话' });
  const record = store.complete(draft.id);
  assert.throws(() => store.updateRecord(record.id, { title: '坏标题', notes: '坏笔记' }, {
    expectedVersion: record.contentVersion,
    transcriptSegments: [{ id: 'valid-editor-segment', text: '坏原话' }, { id: 'foreign-segment', text: '坏引用' }],
  }), /unknown audio segment/);
  const unchanged = store.getRecord(record.id);
  assert.equal(unchanged.title, record.title);
  assert.equal(unchanged.notes, record.notes);
  assert.equal(unchanged.transcript, record.transcript);
  assert.equal(unchanged.contentVersion, record.contentVersion);
});

test('duplicate candidates need two saved current records and literal original evidence', t => {
  const { store } = fixture(t);
  const a = saved(store, { notes: '原话：保存想法' }), b = saved(store, { notes: '原话：记录想法' });
  const valid = suggestion(store, a.id, b.id);
  assert.throws(() => store.saveDuplicateSuggestions([valid, { ...valid, leftQuote: 'AI编造的证据' }]), /original record text/);
  assert.equal(store.listDuplicateSuggestions().length, 0);
  assert.throws(() => store.saveDuplicateSuggestions([{ ...valid, rightId: a.id }]), /different records/);
  assert.throws(() => store.saveDuplicateSuggestions([{ ...valid, leftVersion: undefined }]), /content versions/);
  assert.throws(() => store.saveDuplicateSuggestions([{ ...valid, leftVersion: 99 }]), /stale/);
  const draft = store.createDraft({ notes: '还没保存' });
  assert.throws(() => store.saveDuplicateSuggestions([{ ...valid, rightId: draft.id }]), /saved records/);
  store.saveDuplicateSuggestions([valid]);
  assert.equal(store.listDuplicateSuggestions().length, 1);
});

test('reversed duplicate pairs are canonical and rejected same-version suggestions stay rejected', t => {
  const { store } = fixture(t);
  const a = saved(store, { id: 'a' }), b = saved(store, { id: 'b' });
  const [candidate] = store.saveDuplicateSuggestions([suggestion(store, b.id, a.id)]);
  assert.equal(candidate.leftId, 'a');
  assert.equal(store.decideDuplicate(candidate.id, 'reject').status, 'rejected');
  assert.equal(store.decideDuplicate(candidate.id, 'reject').status, 'rejected');
  const [same] = store.saveDuplicateSuggestions([suggestion(store, a.id, b.id)]);
  assert.equal(same.id, candidate.id);
  assert.equal(same.status, 'rejected');
  assert.equal(store.listDuplicateSuggestions().length, 0);
  assert.equal(store.listDuplicateDecisions().length, 1);
  store.updateRecord(a.id, { notes: '修改过的原话' });
  assert.equal(store.listDuplicateDecisions().length, 0);
  store.saveDuplicateSuggestions([suggestion(store, a.id, b.id)]);
  assert.equal(store.listDuplicateSuggestions().length, 1);
});

test('grouping and ungrouping preserve originals and do not silently regroup the same version', t => {
  const { store } = fixture(t);
  const draft = store.createDraft({ notes: '同一灵感' });
  const audio = store.addSegment(draft.id, { bytes: Buffer.from('synthetic-audio') });
  const a = store.complete(draft.id), b = saved(store, { notes: '同一灵感的另一种表达' });
  const [candidate] = store.saveDuplicateSuggestions([suggestion(store, a.id, b.id)]);
  const group = store.decideDuplicate(candidate.id, 'group');
  assert.equal(group.records.length, 2);
  assert.equal(group.stale, false);
  assert.equal(store.decideDuplicate(candidate.id, 'group').id, group.id);
  assert.equal(store.getRecord(a.id).duplicateGroupId, group.id);
  assert.equal(fs.existsSync(store.getRecord(a.id).segments[0].path), true);
  assert.equal(fs.existsSync(audio.path), false); // It moved only when the original draft was saved.
  store.ungroup(group.id);
  assert.deepEqual(store.listGroups(), []);
  assert.equal(store.getRecord(a.id).duplicateGroupId, null);
  assert.equal(store.listRecords().length, 2);
  const [same] = store.saveDuplicateSuggestions([suggestion(store, a.id, b.id)]);
  assert.equal(same.status, 'ungrouped');
  assert.equal(store.listDuplicateSuggestions().length, 0);
});

test('overlapping accepted duplicate groups merge and edited members visibly need review', t => {
  const { store } = fixture(t);
  const records = ['a', 'b', 'c', 'd'].map(id => saved(store, { id }));
  const [ab, cd, bc] = store.saveDuplicateSuggestions([
    suggestion(store, records[0].id, records[1].id), suggestion(store, records[2].id, records[3].id), suggestion(store, records[1].id, records[2].id),
  ]);
  store.decideDuplicate(ab.id, 'group'); store.decideDuplicate(cd.id, 'group');
  assert.equal(store.listGroups().length, 2);
  const group = store.decideDuplicate(bc.id, 'group');
  assert.equal(store.listGroups().length, 1);
  assert.equal(group.recordIds.length, 4);
  store.updateRecord(records[0].id, { notes: '修改后不一定还相同' });
  assert.equal(store.listGroups()[0].needsReview, true);
  assert.equal(store.listGroups()[0].records.length, 4);
  assert.throws(() => store.decideDuplicate(ab.id, 'group'), /stale/);
});

test('changing original content hides pending duplicate evidence until reanalysis', t => {
  const { store } = fixture(t);
  const a = saved(store), b = saved(store);
  const [candidate] = store.saveDuplicateSuggestions([suggestion(store, a.id, b.id)]);
  store.updateRecord(a.id, { notes: '现在的内容' });
  assert.equal(store.listDuplicateSuggestions().length, 0);
  assert.equal(store.db.prepare('SELECT status FROM duplicate_suggestions WHERE id=?').get(candidate.id).status, 'stale');
  assert.throws(() => store.decideDuplicate(candidate.id), /stale/);
});

test('delete immediately clears derived topics candidates groups and continuation metadata', t => {
  const { store } = fixture(t);
  const topic = store.createTopic('保留主题但清掉成员');
  const a = saved(store, { notes: '待删除的私密原话', topicIds: [topic.id] }), b = saved(store), c = saved(store, { parentId: a.id });
  const [ab, ac] = store.saveDuplicateSuggestions([suggestion(store, a.id, b.id), suggestion(store, a.id, c.id)]);
  store.decideDuplicate(ab.id, 'group');
  store.deleteRecord(a.id);
  assert.equal(store.listTopics()[0].recordCount, 0);
  assert.equal(store.listGroups().length, 0);
  assert.equal(store.listDuplicateSuggestions().length, 0);
  assert.equal(store.listDuplicateDecisions().length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM duplicate_suggestions').get().count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM record_topics WHERE record_id=?').get(a.id).count, 0);
  assert.equal(store.getRecord(b.id).duplicateGroupId, null);
  assert.equal(store.getRecord(c.id).parentId, null);
  assert.throws(() => store.decideDuplicate(ac.id), /unavailable/);
  assert.throws(() => store.saveOrganization(a.id, { summary: 'late' }), /completed/);
});

test('additive migration preserves legacy records organization and attachments across reopen', t => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-library-migrate-'));
  fs.mkdirSync(path.join(dir, 'records', 'legacy'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'records', 'legacy', 'original.wav'), Buffer.from('synthetic legacy audio'));
  const legacy = new DatabaseSync(path.join(dir, 'inmoment.sqlite'));
  legacy.exec(`CREATE TABLE records (
    id TEXT PRIMARY KEY,status TEXT NOT NULL,generation TEXT NOT NULL,created_at INTEGER NOT NULL,completed_at INTEGER,
    title TEXT NOT NULL DEFAULT '',task TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',source_json TEXT,organization_json TEXT
  ); CREATE TABLE segments (
    id TEXT PRIMARY KEY,record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,relative_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,started_at INTEGER,ended_at INTEGER,duration_ms REAL NOT NULL DEFAULT 0,transcript TEXT NOT NULL DEFAULT '',UNIQUE(record_id,ordinal)
  );`);
  legacy.prepare('INSERT INTO records(id,status,generation,created_at,title,notes,organization_json) VALUES(?,?,?,?,?,?,?)').run('legacy', 'saved', 'generation', 100, '旧标题', '旧笔记', JSON.stringify({ summary: '旧整理' }));
  legacy.prepare('INSERT INTO segments(id,record_id,ordinal,relative_path,mime_type,transcript) VALUES(?,?,?,?,?,?)').run('legacy-audio', 'legacy', 1, 'legacy/original.wav', 'audio/wav', '旧的原始转写');
  legacy.close();
  const store = new LocalStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const record = store.getRecord('legacy');
  assert.equal(record.contentVersion, 1);
  assert.equal(record.organizationStale, false);
  assert.equal(record.organization.summary, '旧整理');
  assert.equal(record.transcript, '旧的原始转写');
  assert.equal(fs.readFileSync(record.segments[0].path, 'utf8'), 'synthetic legacy audio');
  store.createTopic('迁移后新主题');
  const second = new LocalStore(dir);
  try {
    assert.equal(second.getRecord('legacy').title, '旧标题');
    assert.equal(second.listTopics().length, 1);
  } finally { second.close(); }
});
