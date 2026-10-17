'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BatchOrganizer, BATCH_LIMITS, validateBatch } = require('../src/main/batch-organizer.cjs');
function fixture(count = 3, options = {}) {
  const records = Array.from({ length: count }, (_, index) => ({ id: `r${index}`, status: 'saved', version: 1, notes: '灵感原话', segments: [], screenshots: [], topics: [] }));
  const rows = new Map(records.map(record => [record.id, { generation: `g-${record.id}` }]));
  const store = { getRecord: id => records.find(record => record.id === id && record.status === 'saved'), row: id => rows.get(id), listTopics: () => options.topics || [], saveOrganization(id, organization, params) { const record = this.getRecord(id); assert.equal(record.version, params.expectedVersion); record.organization = organization; return record; } };
  const calls = [], planCalls = [], progress = [];
  const organize = async (id, params) => {
    calls.push({ id, params });
    const result = options.organize ? await options.organize(id, params) : { organization: { summary: '模拟摘要', topicSuggestions: ['逐条建议'], usage: { totalTokens: 12 } } };
    if (result?.cancelled || !result) return result;
    const record = store.getRecord(id);
    const organization = { summary: '模拟摘要', ...result.organization, topicSuggestions: [] };
    record.organization = organization;
    return { ...record, ...result, version: record.version, organization };
  };
  const classify = async (input, params) => { planCalls.push({ records: input, params }); if (options.classify) return options.classify(input, params); return { schemaVersion: 1, groups: [{ name: '共同主题', reason: '这些记录讨论相同主题', records: input.map(({ id, version }) => ({ id, version })) }], unassigned: [], usage: { totalTokens: 24 } }; };
  const batch = new BatchOrganizer({ store, organize, classify, onProgress: event => progress.push(event), limits: options.limits || BATCH_LIMITS });
  return { records, rows, calls, planCalls, progress, store, batch, snapshot: () => batch.snapshot(records.map(record => record.id)) };
}
test('a displayed set of 38 records is frozen, deduplicated and processed in full without classification writes', async () => {
  const fx = fixture(38); const ids = fx.records.map(record => record.id);
  const snapshot = fx.batch.snapshot([...ids, ids[0]], Object.fromEntries(ids.map(id => [id, 1])));
  const result = await fx.batch.run({ snapshot, approved: true });
  assert.equal(result.total, 38); assert.equal(result.items.length, 38); assert.equal(fx.calls.length, 38);
  assert.ok(result.items.every(item => item.status === 'success')); assert.equal(result.usage.totalTokens, 480);
  assert.ok(fx.records.every(record => record.topics.length === 0 && record.notes === '灵感原话'));
  assert.equal(fx.progress.filter(event => event.status === 'processing').length, 38);
  assert.equal(fx.progress.at(-1).completed, 38);
  assert.equal(fx.planCalls.length, 1); assert.equal(result.grouping.groupCount, 1); assert.equal(result.usage.requestCount, 39);
  assert.ok(fx.calls.every(item => item.params.deferGrouping === true));
  assert.ok(result.items.every(item => item.topicSuggestions[0] === '共同主题'));
  assert.ok(fx.records.every(record => record.organization.topicSuggestions[0] === '共同主题'));
});
test('100 records are allowed while 101, invalid IDs and forged versions are rejected before any call', async () => {
  assert.equal(validateBatch(Array.from({ length: 100 }, (_, index) => `r${index}`)).length, 100);
  assert.throws(() => validateBatch(Array.from({ length: 101 }, (_, index) => `r${index}`)), /100/);
  assert.throws(() => validateBatch(['../outside']), /有效/);
  assert.throws(() => validateBatch(['r0'], { r1: 1 }), /版本/);
  assert.throws(() => validateBatch(['r0'], { r0: '1' }), /版本/);
  const fx = fixture(); await assert.rejects(fx.batch.run({ snapshot: fx.snapshot() }), /授权/); assert.equal(fx.calls.length, 0);
});
test('edited, deleted and recreated queued records cannot use an old snapshot', async () => {
  const fx = fixture(); const snapshot = fx.snapshot();
  fx.records[0].version = 2; fx.records[1].status = 'discarded'; fx.rows.set('r2', { generation: 'recreated' });
  const result = await fx.batch.run({ snapshot, approved: true });
  assert.deepEqual(result.items.map(item => item.status), ['failed', 'failed', 'failed']); assert.equal(fx.calls.length, 0);
});
test('an individual failure is visible and does not prevent later selected records from being processed', async () => {
  const fx = fixture(3, { organize: async id => { if (id === 'r1') throw new Error('mock failure'); return { id, organization: { topicSuggestions: [] } }; } });
  const result = await fx.batch.run({ snapshot: fx.snapshot(), approved: true });
  assert.deepEqual(result.items.map(item => item.status), ['success', 'failed', 'success']); assert.match(result.items[1].error, /mock failure/);
});
test('cancellation retains completed results and names every unprocessed item without additional calls', async () => {
  const abort = new AbortController();
  const fx = fixture(4, { organize: async id => { if (id === 'r1') { abort.abort(); return { cancelled: true }; } return { id, organization: { topicSuggestions: [] } }; } });
  const result = await fx.batch.run({ snapshot: fx.snapshot(), signal: abort.signal, approved: true });
  assert.deepEqual(result.items.map(item => item.status), ['success', 'cancelled', 'not-processed', 'not-processed']);
  assert.equal(result.cancelled, true); assert.equal(fx.calls.length, 2); assert.equal(result.items.length, 4);
});
test('application input budgets never silently truncate or upload over-budget text', async () => {
  const fx = fixture(4, { limits: { ...BATCH_LIMITS, maxRunTextBytes: 150 } });
  const result = await fx.batch.run({ snapshot: fx.snapshot(), approved: true });
  assert.ok(result.items.some(item => item.status === 'not-processed')); assert.equal(result.items.length, 4);
  assert.ok(result.inputBytes.text <= 150);
  const big = fixture(1, { limits: { ...BATCH_LIMITS, maxItemTextBytes: 1 } });
  const rejected = await big.batch.run({ snapshot: big.snapshot(), approved: true }); assert.equal(rejected.items[0].status, 'failed'); assert.equal(big.calls.length, 0);
});

test('shared grouping compares all summaries, reuses one coherent taxonomy and leaves outliers unassigned', async () => {
  const fx = fixture(5, { topics: [{ name: '家庭烹饪' }], classify: async records => ({ schemaVersion: 1, groups: [
    { name: '家庭烹饪', reason: '根据食材调整食谱', records: records.slice(0, 3).map(({ id, version }) => ({ id, version })) },
  ], unassigned: records.slice(3).map(({ id, version }) => ({ id, version, reason: '与本次其他主题没有明确关联' })) }) });
  const result = await fx.batch.run({ snapshot: fx.snapshot(), approved: true });
  assert.equal(fx.planCalls[0].records.length, 5); assert.deepEqual(fx.planCalls[0].params.availableTopics, ['家庭烹饪']);
  assert.deepEqual(result.items.map(item => item.topicSuggestions), [['家庭烹饪'], ['家庭烹饪'], ['家庭烹饪'], [], []]);
  assert.equal(result.grouping.unassignedCount, 2); assert.equal(result.grouping.maxGroups, 3);
  assert.ok(fx.records.every(record => record.notes === '灵感原话' && record.organization.summary === '模拟摘要'));
});

test('planning failure keeps summaries and never restores fragmented per-record suggestions', async () => {
  const fx = fixture(4, { classify: async () => { throw new Error('mock shared grouping unavailable'); } });
  const result = await fx.batch.run({ snapshot: fx.snapshot(), approved: true });
  assert.equal(result.grouping.status, 'failed'); assert.match(result.grouping.error, /摘要已保留/);
  assert.ok(result.items.every(item => item.status === 'success' && !item.topicSuggestions.length && !item.record.organization.topicSuggestions.length));
  assert.ok(fx.records.every(record => record.organization.summary === '模拟摘要' && !record.organization.topicSuggestions.length));
  assert.equal(fx.planCalls.length, 1); assert.equal(result.usage.attemptedRequests, 5); assert.equal(result.usage.unknownUsageRequests, 1);
});

test('a one-note-one-new-group response is rejected without automatically retrying or creating groups', async () => {
  const fx = fixture(4, { classify: async records => ({ schemaVersion: 1, groups: records.map(record => ({ name: `单篇${record.id}`, reason: '过细的单篇主题', records: [{ id: record.id, version: record.version }] })), unassigned: [] }) });
  const result = await fx.batch.run({ snapshot: fx.snapshot(), approved: true });
  assert.equal(result.grouping.status, 'failed'); assert.ok(result.items.every(item => !item.topicSuggestions.length)); assert.equal(fx.planCalls.length, 1);
});

test('record edits, recreation and newer summaries during classification cannot receive old plans', async () => {
  let fx;
  fx = fixture(4, { classify: async records => {
    fx.records[0].version += 1; fx.rows.set('r1', { generation: 'new-generation' });
    fx.records[2].organization = { summary: '用户后来重新整理的摘要', topicSuggestions: ['后来建议'] };
    return { schemaVersion: 1, groups: [{ name: '共同主题', reason: '共享明确主题', records: records.map(({ id, version }) => ({ id, version })) }], unassigned: [] };
  } });
  const result = await fx.batch.run({ snapshot: fx.snapshot(), approved: true });
  assert.deepEqual(result.items.map(item => item.status), ['failed', 'failed', 'failed', 'success']);
  assert.equal(result.grouping.staleCount, 3); assert.equal(fx.records[2].organization.summary, '用户后来重新整理的摘要');
  assert.deepEqual(fx.records[2].organization.topicSuggestions, ['后来建议']); assert.deepEqual(fx.records[3].organization.topicSuggestions, ['共同主题']);
});

test('classification cancellation never applies a late result or starts another request', async () => {
  const controller = new AbortController();
  const fx = fixture(2, { classify: async records => { controller.abort(); return { schemaVersion: 1, groups: [{ name: '共同主题', reason: '共享主题', records: records.map(({ id, version }) => ({ id, version })) }], unassigned: [] }; } });
  const result = await fx.batch.run({ snapshot: fx.snapshot(), approved: true, signal: controller.signal });
  assert.equal(result.cancelled, true); assert.equal(result.grouping.status, 'cancelled'); assert.equal(fx.planCalls.length, 1);
  assert.ok(fx.records.every(record => !record.organization.topicSuggestions.length));
});

test('large summary sets fail their shared budget visibly before classification instead of truncating', async () => {
  const fx = fixture(20, { organize: async () => ({ organization: { summary: '长'.repeat(2000) } }) });
  const result = await fx.batch.run({ snapshot: fx.snapshot(), approved: true });
  assert.equal(result.grouping.status, 'failed'); assert.match(result.grouping.error, /96,000/); assert.equal(fx.planCalls.length, 0);
  assert.ok(fx.records.every(record => record.organization.summary.length === 2000));
});

test('more than 50 existing groups use bounded relevant candidates instead of blocking all grouping', async () => {
  const topics = [...Array.from({ length: 100 }, (_, index) => ({ name: `不相关${index}` })), { name: '家庭烹饪' }];
  const fx = fixture(3, { topics, organize: async () => ({ organization: { summary: '家庭烹饪时根据冰箱食材推荐食谱。' } }) });
  const result = await fx.batch.run({ snapshot: fx.snapshot(), approved: true });
  assert.equal(result.grouping.status, 'done'); assert.equal(fx.planCalls[0].params.availableTopics.length, 50);
  assert.equal(fx.planCalls[0].params.availableTopics[0], '家庭烹饪'); assert.equal(result.grouping.availableTopicCount, 101);
  assert.equal(result.grouping.candidateTopicCount, 50);
});

test('one failed plan save remains visible without concealing suggestions saved for other records', async () => {
  const fx = fixture(3); const save = fx.store.saveOrganization.bind(fx.store);
  fx.store.saveOrganization = (id, ...args) => { if (id === 'r1') throw new Error('mock save failure'); return save(id, ...args); };
  const result = await fx.batch.run({ snapshot: fx.snapshot(), approved: true });
  assert.equal(result.grouping.status, 'done'); assert.deepEqual(result.items.map(item => item.status), ['success', 'failed', 'success']);
  assert.match(result.items[1].error, /分组建议未保存/); assert.equal(result.items[0].topicSuggestions[0], '共同主题');
  assert.equal(fx.records[0].organization.topicSuggestions[0], '共同主题'); assert.equal(fx.records[1].organization.topicSuggestions.length, 0);
});

test('shared grouping preserves the complete manual title ahead of an older AI-generated title', async () => {
  const fx = fixture(2, { organize: async () => ({ organization: { title: '旧的自动标题', summary: '共有的主题摘要' } }) });
  fx.records[0].title = '手动'.repeat(250);
  const result = await fx.batch.run({ snapshot: fx.snapshot(), approved: true });
  assert.equal(result.grouping.status, 'done'); assert.equal(fx.planCalls[0].records[0].title, fx.records[0].title);
  assert.equal(fx.planCalls[0].records[0].title.length, 500); assert.equal(fx.planCalls[0].records[1].title, '旧的自动标题');
});
