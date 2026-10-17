'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LibraryAI, SEARCH_INPUT_BUDGET, SEARCH_OUTPUT_BUDGET } = require('../src/main/library-ai.cjs');
const { ApprovalRequiredError } = require('../src/core/deepseek.cjs');

function record(id, text = '收藏时留下当时的灵感理由', extra = {}) { return { id, title: `记录${id}`, status: 'saved', version: 1, createdAt: 100, transcript: text, topics: [], ...extra }; }
function fixture(records, hooks = {}) {
  const stored = records.map(item => structuredClone(item)); const writes = []; const calls = [];
  const store = {
    listRecords: () => stored.filter(item => item.status === 'saved'), getRecord: id => stored.find(item => item.id === id && item.status === 'saved'),
    search: term => stored.filter(item => item.status === 'saved' && (item.transcript + item.title).includes(term)).map(item => ({ ...item, searchScore: 1 })),
    saveDuplicateSuggestions: items => { writes.push(...items); return items.map(item => ({ ...item, status: 'pending' })); },
    listDuplicateDecisions: () => hooks.decisions || [],
  };
  const client = {
    model: 'mock-model',
    interpretQuery: async (query, options) => { calls.push(['interpret', query, options]); if (hooks.interpret) return hooks.interpret(query, options); return { intent: query, terms: ['灵感'], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }; },
    rankCandidates: async (query, candidates, options) => { calls.push(['rank', candidates, options]); if (hooks.rank) return hooks.rank(query, candidates, options); return { results: candidates.map(item => ({ id: item.id, reason: '原话提及灵感', quote: item.text.slice(0, 5) })), usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } }; },
    findDuplicates: async (candidates, options) => { calls.push(['duplicates', candidates, options]); if (hooks.duplicates) return hooks.duplicates(candidates, options); return { duplicates: options.pairs.slice(0, 1).map(pair => ({ ...pair, kind: 'same', reason: '相同想法', differences: '', leftQuote: candidates.find(item => item.id === pair.leftId).text.slice(0, 5), rightQuote: candidates.find(item => item.id === pair.rightId).text.slice(0, 5) })) }; },
  };
  const semantic = hooks.semantic || { async search() { return []; } };
  return { store, client, stored, calls, writes, library: new LibraryAI({ store, client, semantic }) };
}

test('library methods never call an AI client without strict approval', async () => {
  const { library, calls } = fixture([record('one')]);
  for (const approved of [undefined, false, 'true']) {
    await assert.rejects(library.search({ query: '灵感', approved }), ApprovalRequiredError);
    await assert.rejects(library.analyzeDuplicates({ approved }), ApprovalRequiredError);
  }
  assert.equal(calls.length, 0);
});

test('AI search enforces caller date/topic scope even if injected store search ignores it', async () => {
  const { library, calls } = fixture([record('within', undefined, { createdAt: 100, topics: [{ id: 'work' }] }), record('old', undefined, { createdAt: 10, topics: [{ id: 'work' }] }), record('other', undefined, { topics: [{ id: 'life' }] }), record('draft', undefined, { status: 'draft' })]);
  const result = await library.search({ query: '之前收藏灵感', filters: { from: 50, to: 200, topicIds: ['work'] }, approved: true });
  assert.deepEqual(result.results.map(item => item.id), ['within']);
  assert.equal(result.coverage.scopeCount, 1); assert.equal(result.coverage.examinedCount, 1);
  assert.equal(calls.length, 2); assert.equal(calls[0][2].maxTokens + calls[1][2].maxTokens, SEARCH_OUTPUT_BUDGET);
});

test('AI search and duplicate analysis use the same unclassified/topic union and never upload outside dates', async () => {
  const records = [
    record('selected', undefined, { createdAt: 100, topics: [{ id: 'work' }] }),
    record('unclassified', undefined, { createdAt: 150 }),
    record('other', undefined, { createdAt: 160, topics: [{ id: 'life' }] }),
    record('upper', undefined, { createdAt: 200 }),
    record('older', undefined, { createdAt: 99, topics: [{ id: 'work' }] }),
  ];
  const fx = fixture(records);
  const filters = { from: 100, to: 200, topicIds: ['work', 'missing'], unclassified: true };
  const result = await fx.library.search({ query: '灵感', filters, approved: true });
  assert.deepEqual(result.results.map(item => item.id).sort(), ['selected', 'unclassified']);
  assert.equal(result.filters.uncategorized, true);
  assert.equal(result.coverage.scopeCount, 2);
  assert.deepEqual(fx.calls.find(call => call[0] === 'rank')[1].map(item => item.id).sort(), ['selected', 'unclassified']);
  const duplicates = await fx.library.analyzeDuplicates({ filters, approved: true });
  assert.equal(duplicates.coverage.scopeCount, 2);
  assert.deepEqual(fx.calls.find(call => call[0] === 'duplicates')[1].map(item => item.id).sort(), ['selected', 'unclassified']);
  const before = fx.calls.length;
  await assert.rejects(fx.library.search({ query: '灵感', filters: { uncategorized: 'true' }, approved: true }), /未分类/);
  await assert.rejects(fx.library.analyzeDuplicates({ filters: { topicIds: ['../invalid'] }, approved: true }), /主题/);
  assert.equal(fx.calls.length, before);
});

test('AI search bounds candidates and token estimate, and reports unexamined records', async () => {
  const { library, calls, store } = fixture(Array.from({ length: 200 }, (_, index) => record(`r${index}`, '灵感当时为什么有用'.repeat(60))));
  store.search = () => { throw new Error('Do not rehydrate the entire database for every query term.'); };
  const result = await library.search({ query: '灵感', approved: true });
  assert.equal(calls.length, 2); assert.ok(calls[1][1].length <= 20);
  assert.ok(result.usage.estimatedInputTokens <= SEARCH_INPUT_BUDGET);
  assert.equal(result.coverage.scopeCount, 200); assert.ok(result.coverage.notExaminedCount > 0); assert.equal(result.coverage.hasMore, true);
  assert.match(result.limitations[0], /可能漏检/);
});

test('scene descriptions and valid summaries reach reranking as context, with quotations limited to original expression', async () => {
  const f = fixture([record('one', '我想把当时的理由留下来', { task: '研究求职项目', organization: { summary: '保留阅读时的联想', context: { source: 'ai_screenshot', description: '浏览个人作品集', visibleUrl: 'https://example.invalid/portfolio' } } })], { interpret: async () => ({ intent: '浏览作品集时的想法', terms: ['作品集'] }), rank: async (_, candidates) => {
    assert.equal(candidates.length, 1); assert.match(candidates[0].context, /作品集/); assert.match(candidates[0].context, /未核验/);
    assert.equal(candidates[0].summary, '保留阅读时的联想'); assert.ok(candidates[0].context.length <= 180);
    return { results: [{ id: 'one', reason: '来源场景为作品集', quote: '当时的理由留下来' }] };
  } });
  const result = await f.library.search({ query: '看作品集时想到的记录方法', approved: true }); assert.equal(result.results.length, 1);
});

test('stale AI scene and summary are excluded from candidate recall and upload', async () => {
  const f = fixture([record('one', '灵感原话', { organizationStale: true, organization: { summary: '过期的私密摘要', context: { description: '过期的作品集线索' } } })]);
  await f.library.search({ query: '灵感', approved: true }); const candidate = f.calls.find(call => call[0] === 'rank')[1][0];
  assert.equal(candidate.summary, ''); assert.equal(candidate.context, '');
});

test('user notes remain searchable evidence even when an audio transcript also exists', async () => {
  const f = fixture([record('one', '录音里是另一个内容', { notes: '作品集浏览时要保存联想' })], { interpret: async () => ({ terms: ['作品集'] }) });
  const result = await f.library.search({ query: '作品集的灵感', approved: true });
  assert.equal(result.results.length, 1); assert.match(result.results[0].quote, /作品集/);
});

test('empty scope makes no AI calls; no local candidates makes only the interpretation call', async () => {
  const empty = fixture([]); const result = await empty.library.search({ query: '灵感', approved: true });
  assert.equal(result.coverage.scopeCount, 0); assert.equal(empty.calls.length, 0);
  const other = fixture([record('x', '完全不同的内容')]);
  const noMatch = await other.library.search({ query: '灵感', approved: true });
  assert.equal(noMatch.results.length, 0); assert.equal(other.calls.length, 1); assert.equal(noMatch.coverage.examinedCount, 0);
});

test('cached searches require approval, incur no new requests, and invalidate on edits and deletion', async () => {
  const f = fixture([record('one')]);
  await f.library.search({ query: '灵感', approved: true });
  const cached = await f.library.search({ query: '灵感', approved: true });
  assert.equal(cached.cached, true); assert.equal(cached.usage.requestCount, 0); assert.equal(f.calls.length, 2);
  await assert.rejects(f.library.search({ query: '灵感' }), ApprovalRequiredError);
  f.stored[0].version++;
  await f.library.search({ query: '灵感', approved: true }); assert.equal(f.calls.length, 4);
  f.stored[0].status = 'discarded';
  const removed = await f.library.search({ query: '灵感', approved: true }); assert.deepEqual(removed.results, []);
  f.library.clearCache(); assert.equal(f.library.searchCache.size, 0);
});

test('deleted records between query understanding and ranking are never uploaded as candidates', async () => {
  const f = fixture([record('one')], { interpret: async () => { f.stored[0].status = 'discarded'; return { terms: ['灵感'] }; } });
  const result = await f.library.search({ query: '灵感', approved: true });
  assert.equal(f.calls.length, 1); assert.deepEqual(result.results, []);
});

test('renaming a topic invalidates search cache without changing record content versions', async () => {
  const f = fixture([record('one', undefined, { topics: [{ id: 'topic', name: '收藏' }] })]);
  await f.library.search({ query: '灵感', approved: true });
  f.stored[0].topics[0].name = '灵感管理';
  const result = await f.library.search({ query: '灵感', approved: true });
  assert.equal(result.cached, false); assert.equal(f.calls.length, 4); assert.equal(f.stored[0].version, 1);
});

test('late search results for edited records are not returned or cached', async () => {
  const f = fixture([record('one')], { rank: async (_, candidates) => { f.stored[0] = { ...f.stored[0], version: 2 }; return { results: [{ id: candidates[0].id, quote: candidates[0].text, reason: '相关' }] }; } });
  const result = await f.library.search({ query: '灵感', approved: true });
  assert.deepEqual(result.results, []); assert.equal(f.library.searchCache.size, 0);
});

test('search rejects unknown IDs, fabricated quotes and duplicate results', async () => {
  for (const results of [[{ id: 'other', quote: '灵感', reason: '相关' }], [{ id: 'one', quote: '虚构证据', reason: '相关' }], [{ id: 'one', quote: '灵感', reason: '相关' }, { id: 'one', quote: '灵感', reason: '相关' }]]) {
    const f = fixture([record('one')], { rank: async () => ({ results }) });
    await assert.rejects(f.library.search({ query: '灵感', approved: true }), /Invalid AI search/);
  }
});

test('abort before or between search stages prevents subsequent calls', async () => {
  const controller = new AbortController(); controller.abort();
  const first = fixture([record('one')]);
  await assert.rejects(first.library.search({ query: '灵感', approved: true, signal: controller.signal }), { name: 'AbortError' }); assert.equal(first.calls.length, 0);
  const later = new AbortController();
  const second = fixture([record('one')], { interpret: async () => { later.abort(); return { terms: ['灵感'] }; } });
  await assert.rejects(second.library.search({ query: '灵感', approved: true, signal: later.signal }), { name: 'AbortError' }); assert.equal(second.calls.length, 1);
});

test('large local candidate scans yield so cancellation can stop a paid followup request', async () => {
  const abort = new AbortController();
  const search = fixture(Array.from({ length: 500 }, (_, index) => record(`r${index}`)), { interpret: async () => { setImmediate(() => abort.abort()); return { terms: ['灵感'] }; } });
  await assert.rejects(search.library.search({ query: '灵感', approved: true, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(search.calls.length, 1);
  const duplicateAbort = new AbortController(); const duplicate = fixture(Array.from({ length: 500 }, (_, index) => record(`r${index}`)));
  setImmediate(() => duplicateAbort.abort());
  await assert.rejects(duplicate.library.analyzeDuplicates({ approved: true, signal: duplicateAbort.signal }), { name: 'AbortError' });
  assert.equal(duplicate.calls.length, 0); assert.equal(duplicate.writes.length, 0);
});

test('duplicates use bounded likely pairs and preserve all original records', async () => {
  const f = fixture(Array.from({ length: 100 }, (_, index) => record(`r${index}`)));
  const result = await f.library.analyzeDuplicates({ approved: true });
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0][1].length <= 20); assert.ok(f.calls[0][2].pairs.length <= 10);
  assert.equal(result.suggestions.length, 1); assert.equal(result.coverage.scopeCount, 100); assert.equal(result.coverage.hasMore, true);
  assert.equal(f.stored.length, 100); assert.ok(f.stored.every(item => item.version === 1));
  assert.equal(f.writes[0].leftVersion, 1);
});

test('development is distinguished from duplicate and is never persisted as a group suggestion', async () => {
  const f = fixture([record('one'), record('two')], { duplicates: async (candidates, options) => ({ duplicates: [{ ...options.pairs[0], kind: 'development', reason: '增加新的用途', differences: '新场景', leftQuote: candidates[0].text, rightQuote: candidates[1].text }] }) });
  const result = await f.library.analyzeDuplicates({ approved: true });
  assert.equal(result.suggestions.length, 0); assert.equal(result.developments.length, 1); assert.equal(f.writes.length, 0);
});

test('duplicates cache checked pair versions and skip previous user rejection', async () => {
  const f = fixture([record('one'), record('two')]);
  await f.library.analyzeDuplicates({ approved: true }); await f.library.analyzeDuplicates({ approved: true }); assert.equal(f.calls.length, 1);
  f.stored[0] = { ...f.stored[0], version: 2 }; await f.library.analyzeDuplicates({ approved: true }); assert.equal(f.calls.length, 2);
  const rejected = fixture([record('one'), record('two')], { decisions: [{ leftId: 'one', rightId: 'two', leftVersion: 1, rightVersion: 1, status: 'rejected' }] });
  await rejected.library.analyzeDuplicates({ approved: true }); assert.equal(rejected.calls.length, 0);
});

test('edited/deleted duplicate results and cancelled tasks cannot write suggestions', async () => {
  for (const action of ['edit', 'delete', 'abort']) {
    const controller = new AbortController();
    const f = fixture([record('one'), record('two')], { duplicates: async (candidates, options) => {
      const item = { ...options.pairs[0], kind: 'same', reason: '重复', leftQuote: candidates[0].text, rightQuote: candidates[1].text };
      if (action === 'edit') f.stored[0] = { ...f.stored[0], version: 2 };
      if (action === 'delete') f.stored[0].status = 'discarded';
      if (action === 'abort') controller.abort();
      return { duplicates: [item] };
    } });
    if (action === 'abort') await assert.rejects(f.library.analyzeDuplicates({ approved: true, signal: controller.signal }), { name: 'AbortError' });
    else await f.library.analyzeDuplicates({ approved: true, signal: controller.signal });
    assert.equal(f.writes.length, 0);
  }
});

test('SQLite and mock DeepSeek integrate with numeric versions, scope, evidence and persistent decisions', async t => {
  const fs = require('node:fs'); const path = require('node:path');
  const { LocalStore } = require('../src/core/store.cjs'); const { DeepSeekClient } = require('../src/core/deepseek.cjs');
  const directory = fs.mkdtempSync(path.join(__dirname, '.tmp-library-ai-')); const store = new LocalStore(directory);
  t.after(() => { store.close(); const relative = path.relative(__dirname, directory); if (relative.startsWith('.tmp-library-ai-') && !relative.includes(path.sep)) fs.rmSync(directory, { recursive: true, force: true }); });
  const ids = [];
  for (const index of [1, 2]) {
    const draft = store.createDraft({ createdAt: index * 100, title: `收藏灵感${index}` });
    store.addSegment(draft.id, { bytes: Buffer.from('synthetic audio'), transcript: '收藏时留下当时的灵感理由' }); store.complete(draft.id); ids.push(draft.id);
  }
  let requests = 0;
  const client = new DeepSeekClient({ apiKey: 'mock-only', fetchImpl: async (_, options) => {
    requests++;
    const body = JSON.parse(options.body); const input = JSON.parse(body.messages[1].content);
    let value;
    if (!input.candidates) value = { intent: '找灵感', terms: ['灵感'] };
    else if (!input.pairs) value = { results: input.candidates.map(item => ({ id: item.id, reason: '包含收藏理由', quote: item.text })) };
    else value = { duplicates: input.pairs.map(pair => ({ ...pair, kind: 'same', reason: '核心想法相同', differences: '', leftQuote: input.candidates.find(item => item.id === pair.leftId).text, rightQuote: input.candidates.find(item => item.id === pair.rightId).text })) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }) };
  } });
  const library = new LibraryAI({ store, client, semantic: { async search() { return []; } } });
  const found = await library.search({ query: '收藏的灵感', filters: { from: 150 }, approved: true });
  assert.equal(found.results.length, 1); assert.equal(found.results[0].id, ids[1]); assert.equal(typeof found.results[0].version, 'number');
  const duplicate = await library.analyzeDuplicates({ approved: true }); assert.equal(duplicate.suggestions.length, 1); assert.equal(store.listDuplicateSuggestions().length, 1);
  store.decideDuplicate(duplicate.suggestions[0].id, 'reject');
  const before = requests; const restarted = new LibraryAI({ store, client });
  await restarted.analyzeDuplicates({ approved: true }); assert.equal(requests, before); assert.equal(store.listRecords().length, 2);
});

test('missing local semantic model blocks every paid search stage without a keyword fallback', async () => {
  const fx = fixture([record('one')]);
  fx.library.semantic = null;
  await assert.rejects(fx.library.search({ query: '灵感', approved: true }), { code: 'MODEL_NOT_INSTALLED' });
  assert.equal(fx.calls.length, 0);
  fx.library.semantic = { async search() { const error = new Error('model not installed'); error.code = 'MODEL_NOT_INSTALLED'; throw error; } };
  await assert.rejects(fx.library.search({ query: '灵感', approved: true }), { code: 'MODEL_NOT_INSTALLED' });
  assert.equal(fx.calls.length, 0);
});
test('semantic candidates find different wording and cannot upload a record outside the selected scope', async () => {
  let received;
  const fx = fixture([record('within', '记录阅读当下的关联', { topics: [{ id: 'work' }] }), record('outside', '私人日记', { topics: [{ id: 'life' }] })], {
    semantic: { async search(options) { received = options; return [{ id: 'outside', score: 1 }, { id: 'within', score: 0.8 }]; } },
    interpret: async () => ({ terms: [] }),
  });
  const result = await fx.library.search({ query: '如何留住瞬间的启发', filters: { topicIds: ['work'] }, approved: true });
  assert.deepEqual(result.results.map(item => item.id), ['within']);
  assert.deepEqual(received.filters.topicIds, ['work']); assert.equal(fx.calls.length, 2);
});
