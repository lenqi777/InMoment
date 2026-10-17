'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalStore } = require('../src/core/store.cjs');
const { SemanticService, passages } = require('../src/main/semantic-service.cjs');
const { similarityGraph, cosine, unit } = require('../src/core/semantic-graph.cjs');

async function fixture(t, embedder) {
  const root = fs.mkdtempSync(path.join(__dirname, '.tmp-semantic-'));
  const store = new LocalStore(root);
  const installer = { status: () => ({ installed: true, phase: 'ready' }), modelDirectory: () => root, cancel() {} };
  const service = new SemanticService({ store, dataDir: root, installer, embedder });
  t.after(async () => { await service.close(); store.close(); assert.ok(path.resolve(root).startsWith(path.resolve(__dirname) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  function record(id, notes) { store.createDraft({ id, notes }); return store.complete(id); }
  return { root, store, service, record };
}

test('semantic graph separates unrelated synthetic neighbourhoods and preserves isolated ideas', async () => {
  const entries = [{ id: 'cook-a', vector: [1, 0, 0] }, { id: 'cook-b', vector: [.99, .02, 0] }, { id: 'work-a', vector: [0, 1, 0] }, { id: 'work-b', vector: [.02, .99, 0] }, { id: 'alone', vector: [0, 0, 1] }];
  const graph = await similarityGraph(entries);
  assert.equal(graph.nodes.length, 5); assert.equal(graph.edges.length, 2); assert.equal(graph.communities.length, 3);
  assert.ok(graph.communities.some(group => group.members.length === 1 && group.members[0] === 'alone'));
  assert.deepEqual(await similarityGraph(entries), graph);
  assert.ok(graph.nodes.every(node => !('vector' in node)), 'vectors never cross renderer IPC');
});

test('mutual nearest-neighbour graph bounds degree and rejects invalid model output', async () => {
  const graph = await similarityGraph(Array.from({ length: 20 }, (_, index) => ({ id: 'idea-' + index, vector: [1, index / 1000] })));
  for (const node of graph.nodes) assert.ok(graph.edges.filter(edge => edge.source === node.id || edge.target === node.id).length <= 5);
  assert.throws(() => unit([NaN, 1])); assert.throws(() => unit([0, 0])); assert.throws(() => cosine([1], [1, 2]));
});

test('semantic search reuses note embeddings, searches scoped vectors, and invalidates deleted derivatives', async t => {
  const calls = [];
  const f = await fixture(t, async texts => { calls.push(...texts); return texts.map(text => text.includes('菜') || text.includes('cooking') ? [1, 0, 0] : [0, 1, 0]); });
  const cooking = f.record('cooking', '用冰箱里的菜做晚饭'); const work = f.record('work', '作品集展示决策过程');
  const topic = f.store.createTopic('求职'); f.store.setRecordTopics(work.id, [topic.id]);
  const results = await f.service.search({ query: 'cooking' }); assert.equal(results[0].id, cooking.id);
  assert.equal(calls.filter(text => text.startsWith('passage: ')).length, 2);
  const scoped = await f.service.search({ query: 'cooking', filters: { topicIds: [topic.id] } }); assert.deepEqual(scoped.map(item => item.id), [work.id]);
  assert.equal(calls.filter(text => text.startsWith('passage: ')).length, 2, 'unchanged notes are not re-embedded');
  f.store.deleteRecord(cooking.id); f.service.invalidate(cooking.id);
  assert.equal(f.service.database().prepare('SELECT count(*) n FROM vectors WHERE record_id=?').get(cooking.id).n, 0);
  assert.deepEqual((await f.service.search({ query: 'cooking' })).map(item => item.id), [work.id]);
});

test('notes changed or deleted during embedding cannot reappear as a fresh index entry', async t => {
  let mutate = null;
  const f = await fixture(t, async texts => { if (mutate && texts[0].startsWith('passage:')) { const action = mutate; mutate = null; action(); } return texts.map(() => [1, 0]); });
  const record = f.record('changing', '第一版');
  mutate = () => f.store.updateRecord(record.id, { notes: '第二版' });
  assert.deepEqual(await f.service.search({ query: '第一版' }), []);
  assert.equal((await f.service.search({ query: '第二版' })).length, 1);
  f.store.updateRecord(record.id, { notes: '准备删除' }); mutate = () => f.store.deleteRecord(record.id);
  assert.deepEqual(await f.service.search({ query: '准备删除' }), []);
});

test('missing local model is explicit and never requests a download or substitutes keywords', async t => {
  const f = await fixture(t, null); let installed = 0;
  f.service.installer = { status: () => ({ installed: false, phase: 'missing' }), modelDirectory: () => null, install() { installed++; }, cancel() {} };
  f.record('idea', '做菜');
  await assert.rejects(f.service.search({ query: '做菜' }), error => error.code === 'MODEL_NOT_INSTALLED');
  await assert.rejects(f.service.cloud(), error => error.code === 'MODEL_NOT_INSTALLED');
  assert.equal(installed, 0); assert.equal(f.service.db, undefined);
});

test('deleting before opening the index after restart also erases persisted vectors', async t => {
  const f = await fixture(t, async texts => texts.map(() => [1, 0])); const record = f.record('restart-delete', '要删除的向量');
  await f.service.search({ query: '向量' }); await f.service.close();
  const restarted = new SemanticService({ store: f.store, dataDir: f.root, installer: { status: () => ({ installed: true }), modelDirectory: () => f.root, cancel() {} }, embedder: async texts => texts.map(() => [1, 0]) });
  try { f.store.deleteRecord(record.id); restarted.invalidate(record.id); assert.equal(restarted.database().prepare('SELECT count(*) n FROM vectors').get().n, 0); } finally { await restarted.close(); }
});

test('cancel invalidates queued indexing and a later explicit search can start cleanly', async t => {
  let started, first = true, calls = 0; const running = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async (texts, { signal }) => { calls++; if (first) { first = false; started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })); } return texts.map(() => [1, 0]); });
  f.record('cancelled-idea', '不要继续排队'); const search = f.service.search({ query: '查找' }); await running;
  const cloud = f.service.cloud(); const finished = Promise.allSettled([search, cloud]); await f.service.cancel();
  assert.ok((await finished).every(result => result.status === 'rejected')); assert.equal(calls, 1, 'queued task never starts after cancel');
  assert.equal((await f.service.search({ query: '重试' })).length, 1);
});

test('long records use bounded distributed passages, retaining both beginning and end', () => {
  const text = '开始' + '中'.repeat(25000) + '结尾'; const result = passages(text);
  assert.equal(result.limited, true); assert.equal(result.texts.length, 16); assert.ok(result.texts[0].includes('开始')); assert.ok(result.texts.at(-1).includes('结尾'));
});

test('cloud results cannot retain nodes deleted during asynchronous similarity calculation', async t => {
  const f = await fixture(t, async texts => texts.map(() => [1, 0])); f.record('retained', '保留的灵感'); f.record('late-deleted', '要删除的灵感');
  let scheduled = false;
  f.service.onProgress = event => { if (!scheduled && event.phase === 'indexing' && event.completed === event.total) { scheduled = true; setImmediate(() => { f.store.deleteRecord('late-deleted'); f.service.invalidate('late-deleted'); }); } };
  const graph = await f.service.cloud(); assert.deepEqual(graph.nodes.map(node => node.id), ['retained']); assert.equal(graph.edges.length, 0); assert.equal(graph.coverage.totalCount, 1);
});
