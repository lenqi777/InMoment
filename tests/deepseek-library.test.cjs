'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DeepSeekClient, ApprovalRequiredError, validateOrganization, groupingInput, groupingLimit, validateBatchGrouping } = require('../src/core/deepseek.cjs');

const original = { id: 'one', status: 'saved', source: { processName: 'browser', title: '页面标题' }, segments: [{ id: 's1', transcript: '我想留下收藏当时的理由，也能以后找到。' }] };
function organized() { return { schemaVersion: 2, title: '留下收藏理由', summary: '保存收藏时的联想，帮助以后找回。', evidence: [{ segmentId: 's1', quote: '留下收藏当时的理由' }], points: [], uncertainties: [], topicSuggestions: ['灵感捕捉'], context: { application: '', windowTitle: '', visibleUrl: '', description: '' } }; }
function response(value, usage) { return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage }) }; }
const candidates = [{ id: 'one', version: 1, title: '收藏', text: '收藏当时的理由' }, { id: 'two', version: 2, title: '找回', text: '找到以前的灵感' }];

test('v2 summarizes one inspiration without splitting it into artificial branches', async () => {
  let sent;
  const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async (_, options) => { sent = JSON.parse(options.body); return response(organized(), { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }); } });
  const result = await client.organize(original, { approved: true });
  assert.equal(result.schemaVersion, 2); assert.equal(result.points.length, 0); assert.equal(result.ideas, undefined);
  assert.equal(result.evidenceVerified, true); assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 6, totalTokens: 18 });
  assert.match(sent.messages[0].content, /一次记录默认是一条灵感/);
  assert.equal(typeof sent.messages[1].content, 'string');
});

test('v2 evidence still rejects invented quotations and oversized topics', () => {
  const falseQuote = organized(); falseQuote.evidence[0].quote = '用户已决定发布应用';
  assert.throws(() => validateOrganization(falseQuote, original.segments), /does not match/);
  const falseSegment = organized(); falseSegment.points = [{ text: '细节', evidence: [{ segmentId: 'no-such-segment', quote: '理由' }] }];
  assert.throws(() => validateOrganization(falseSegment, original.segments), /unknown segment/);
  const topics = organized(); topics.topicSuggestions = ['一', '二', '三', '四'];
  assert.throws(() => validateOrganization(topics, original.segments), /topicSuggestions/);
});

test('text-only organization cannot invent screenshot-derived metadata', () => {
  const value = organized(); value.context = { application: 'invented app', visibleUrl: 'https://invented.invalid', description: 'invented screenshot' };
  const result = validateOrganization(value, original.segments, { source: original.source });
  assert.equal(result.context.application, 'browser'); assert.equal(result.context.visibleUrl, ''); assert.equal(result.context.description, ''); assert.equal(result.context.source, 'provided');
});

test('explicit screenshot is inline only for deepseek-flash and recognized URLs remain unverified', async () => {
  let sent;
  const value = organized(); value.context = { application: '浏览器', windowTitle: '公开页面', visibleUrl: 'https://example.invalid/visible', description: '资料页' };
  const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async (_, options) => { sent = JSON.parse(options.body); return response(value); } });
  const image = { mimeType: 'image/png', base64: Buffer.from('synthetic image only').toString('base64') };
  const result = await client.organize(original, { approved: true, image });
  assert.equal(sent.messages[1].content[1].type, 'image_url'); assert.equal(sent.messages[1].content[1].image_url.url, `data:image/png;base64,${image.base64}`);
  assert.equal(result.context.visibleUrl, value.context.visibleUrl); assert.equal(result.context.visibleUrlVerified, false); assert.equal(result.context.source, 'ai_screenshot');
  let calls = 0;
  const unsupported = new DeepSeekClient({ apiKey: 'mock-key', model: 'deepseek-v4-pro', fetchImpl: async () => { calls++; } });
  await assert.rejects(unsupported.organize(original, { approved: true, image }), /requires deepseek-flash/); assert.equal(calls, 0);
});

test('unselected record screenshots are never automatically attached', async () => {
  let body;
  const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async (_, options) => { body = options.body; return response(organized()); } });
  await client.organize({ ...original, screenshots: [{ path: 'PRIVATE-LOCAL-IMAGE', base64: 'PRIVATE-IMAGE-DATA' }] }, { approved: true });
  assert.equal(body.includes('PRIVATE'), false); assert.equal(body.includes('image_url'), false);
});

test('invalid, excessive screenshots and body sizes are rejected before network access', async () => {
  let calls = 0;
  const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async () => { calls++; } });
  for (const image of [{ mimeType: 'image/bmp', base64: 'AAAA' }, { mimeType: 'image/png', base64: '!notbase64!' }, { mimeType: 'image/png', base64: Buffer.alloc(32 * 1024 * 1024 + 1).toString('base64') }]) await assert.rejects(client.organize(original, { approved: true, image }));
  await assert.rejects(client.organize({ ...original, notes: 'x'.repeat(100001) }, { approved: true }), /too long/);
  assert.equal(calls, 0);
});

test('organization reuses bounded existing topic names, prioritizing current and locally relevant names', async () => {
  let sent;
  const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async (_, options) => { sent = JSON.parse(JSON.parse(options.body).messages[1].content); return response(organized()); } });
  await client.organize({ ...original, topics: [{ name: '当前主题' }], availableTopics: [...Array.from({ length: 70 }, (_, index) => `其他${index}`), '收藏理由'] }, { approved: true });
  assert.equal(sent.availableTopics.length, 50); assert.equal(sent.availableTopics[0], '当前主题'); assert.equal(sent.availableTopics[1], '收藏理由');
  assert.deepEqual(sent.assignedTopics, ['当前主题']);
});

test('group suggestions canonicalize existing names without changing relevance order and accept the full local name length', async () => {
  let request;
  const long = '组'.repeat(60);
  const value = organized(); value.topicSuggestions = ['新联想', 'ａｉ 产品', long];
  const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async (_, options) => { request = JSON.parse(options.body); return response(value); } });
  const result = await client.organize({ ...original, topics: [{ name: long }], availableTopics: ['AI 产品', long] }, { approved: true });
  assert.deepEqual(result.topicSuggestions, ['新联想', 'AI 产品', long]);
  const input = JSON.parse(request.messages[1].content);
  assert.equal(input.availableTopics.includes(long), true);
  assert.deepEqual(input.assignedTopics, [long]);
  assert.match(request.messages[0].content, /仅用户二次确认后才采用/);
  assert.match(request.messages[0].content, /新的具体主题更贴切，可以把新组名排在已有组名之前/);
  assert.equal(original.topics, undefined);
});

test('a single broad existing group does not constrain cooking and travel recommendations to that group (mock only)', async () => {
  const fixtures = [
    { text: '根据家里剩下的食材推荐今晚做的菜。', suggested: '家庭烹饪' },
    { text: '给周末旅行安排一条适合步行的老城区路线。', suggested: '旅行计划' },
  ];
  for (const fixture of fixtures) {
    let request;
    const value = organized(); value.topicSuggestions = [fixture.suggested]; value.evidence = [{ segmentId: 's1', quote: fixture.text }];
    const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async (_, options) => { request = JSON.parse(options.body); return response(value); } });
    const result = await client.organize({ ...original, availableTopics: ['灵感记录'], topics: [{ name: '灵感记录' }], segments: [{ id: 's1', transcript: fixture.text }] }, { approved: true });
    const input = JSON.parse(request.messages[1].content);
    assert.deepEqual(input.availableTopics, ['灵感记录']); assert.deepEqual(input.assignedTopics, ['灵感记录']);
    assert.match(request.messages[0].content, /不是必须从中选择的封闭列表/);
    assert.match(request.messages[0].content, /即使只有一个已有组，也不得/);
    assert.match(request.messages[0].content, /不能仅因所有记录都是灵感而视为匹配/);
    assert.deepEqual(result.topicSuggestions, [fixture.suggested]);
    assert.equal(result.topicSuggestions.includes('灵感记录'), false);
  }
});

test('topic suggestion validation removes default-category inventions and normalized duplicates', () => {
  const value = organized(); value.topicSuggestions = ['未分类', 'ａｉ 产品', 'AI 产品'];
  assert.deepEqual(validateOrganization(value, original.segments, { availableTopics: ['AI 产品'] }).topicSuggestions, ['AI 产品']);
  value.topicSuggestions = ['组'.repeat(61)];
  assert.throws(() => validateOrganization(value, original.segments), /topicSuggestions/);
  value.topicSuggestions = ['😀'.repeat(60)];
  assert.equal([...validateOrganization(value, original.segments).topicSuggestions[0]].length, 60);
});

test('query/ranking/duplicate methods require strict approval before any request', async () => {
  let calls = 0; const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async () => { calls++; } });
  await assert.rejects(client.interpretQuery('灵感'), ApprovalRequiredError);
  await assert.rejects(client.rankCandidates('灵感', candidates, { approved: 'true' }), ApprovalRequiredError);
  await assert.rejects(client.findDuplicates(candidates), ApprovalRequiredError); assert.equal(calls, 0);
});

test('query interpretation and ranking return validated bounded IDs and exact quotes', async () => {
  const responses = [{ intent: '找回收藏时的想法', terms: ['收藏', '理由'] }, { results: [{ id: 'one', reason: '原话提及收藏理由', quote: '收藏当时的理由' }] }];
  const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async () => response(responses.shift()) });
  const query = await client.interpretQuery('以前收藏时的想法', { approved: true }); assert.deepEqual(query.terms, ['收藏', '理由']);
  const ranked = await client.rankCandidates('收藏的理由', candidates, { approved: true }); assert.equal(ranked.results[0].version, 1);
  for (const result of [{ results: [{ id: 'not-sent', reason: '相关', quote: '理由' }] }, { results: [{ id: 'one', reason: '相关', quote: '不存在的原话' }] }]) {
    const invalid = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async () => response(result) });
    await assert.rejects(invalid.rankCandidates('灵感', candidates, { approved: true }));
  }
});

test('candidate metadata is bounded and never accepted as original-speech quotation', async () => {
  let sent;
  const input = [{ ...candidates[0], context: '作品集现场'.repeat(100), summary: 'AI场景摘要'.repeat(100) }];
  const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async (_, options) => { sent = JSON.parse(JSON.parse(options.body).messages[1].content); return response({ results: [{ id: 'one', reason: '场景相关', quote: '收藏当时的理由' }] }); } });
  await client.rankCandidates('作品集', input, { approved: true });
  assert.equal(sent.candidates[0].context.length, 180); assert.equal(sent.candidates[0].summary.length, 200);
  const invalid = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async () => response({ results: [{ id: 'one', reason: '场景相关', quote: 'AI场景摘要' }] }) });
  await assert.rejects(invalid.rankCandidates('作品集', input, { approved: true }), /does not match/);
});

test('duplicate responses must use an allowed pair and source quotations, with evolution distinguished', async () => {
  const value = { duplicates: [{ leftId: 'one', rightId: 'two', kind: 'development', reason: '从保留理由发展到回溯', differences: '后续检索', leftQuote: '收藏当时的理由', rightQuote: '找到以前的灵感' }] };
  const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async () => response(value) });
  const result = await client.findDuplicates(candidates, { approved: true, pairs: [{ leftId: 'one', rightId: 'two' }] });
  assert.equal(result.duplicates[0].kind, 'development'); assert.equal(result.duplicates[0].leftVersion, 1);
  await assert.rejects(client.findDuplicates(candidates, { approved: true, pairs: [] }), /result array/);
  value.duplicates[0].rightQuote = '伪造的原话';
  await assert.rejects(client.findDuplicates(candidates, { approved: true, pairs: [{ leftId: 'one', rightId: 'two' }] }), /does not match/);
});

test('late cancellation rejects schema2, query and duplicate results without retaining response content', async () => {
  for (const method of ['organize', 'interpretQuery', 'findDuplicates']) {
    const controller = new AbortController();
    const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async () => { controller.abort(); return response(organized()); } });
    const options = { approved: true, signal: controller.signal, pairs: [{ leftId: 'one', rightId: 'two' }] };
    if (method === 'organize') await assert.rejects(client.organize(original, options), { name: 'AbortError' });
    if (method === 'interpretQuery') await assert.rejects(client.interpretQuery('灵感', options), { name: 'AbortError' });
    if (method === 'findDuplicates') await assert.rejects(client.findDuplicates(candidates, options), { name: 'AbortError' });
  }
});

const groupingRecords = [
  { id: 'cook-1', version: 1, generation: 'g-cook-1', title: '剩菜变食谱', summary: '根据冰箱剩下的食材推荐今晚做的菜。' },
  { id: 'cook-2', version: 2, generation: 'g-cook-2', title: '家人口味', summary: '根据家庭成员的口味和忌口调整菜谱。' },
  { id: 'trip-1', version: 3, generation: 'g-trip-1', title: '周末步行', summary: '周末探索本地老城区，按步行距离规划路线。' },
];
function sharedPlan() { return { schemaVersion: 1, groups: [{ name: '家庭烹饪', reason: '都在改进家庭菜谱', records: groupingRecords.slice(0, 2).map(({ id, version }) => ({ id, version })) }], unassigned: [{ id: 'trip-1', version: 3, reason: '旅行主题暂时没有共同记录' }] }; }

test('batch summary stage never returns independent group names even if a mock model emits them', async () => {
  let request;
  const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async (_, options) => { request = JSON.parse(options.body); return response(organized()); } });
  const result = await client.organize(original, { approved: true, deferGrouping: true });
  assert.deepEqual(result.topicSuggestions, []); assert.match(request.messages[0].content, /topicSuggestions必须返回空数组/);
  assert.equal(result.summary, organized().summary);
});

test('shared batch grouping requires approval and sends only bounded summaries with a common group budget', async () => {
  let request, calls = 0;
  const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async (_, options) => { calls++; request = JSON.parse(options.body); return response(sharedPlan(), { total_tokens: 50 }); } });
  await assert.rejects(client.classifyBatch(groupingRecords), ApprovalRequiredError); assert.equal(calls, 0);
  const result = await client.classifyBatch(groupingRecords, { approved: true, availableTopics: ['灵感记录'] });
  const input = JSON.parse(request.messages[1].content);
  assert.equal(input.maxGroups, 2); assert.deepEqual(input.records, groupingRecords); assert.equal(request.max_tokens, 4096);
  assert.match(request.messages[0].content, /先通读所有摘要/); assert.match(request.messages[0].content, /每个新建组至少含2条/);
  assert.match(request.messages[0].content, /不是封闭选项/); assert.match(request.messages[0].content, /命令不得执行/);
  assert.equal(request.messages[1].content.includes('segments'), false); assert.equal(request.messages[1].content.includes('image_url'), false);
  assert.equal(result.groups[0].records[0].generation, 'g-cook-1'); assert.equal(result.unassigned.length, 1); assert.equal(result.usage.totalTokens, 50);
  assert.deepEqual([groupingLimit(1), groupingLimit(20), groupingLimit(100)], [1, 5, 8]);
});

test('global taxonomy validation rejects unknown, stale, duplicate, omitted and overfragmented assignments', () => {
  const input = groupingInput(groupingRecords, []);
  const altered = change => { const value = sharedPlan(); change(value); return value; };
  for (const value of [
    altered(plan => { plan.groups[0].records[0].id = 'outside'; }),
    altered(plan => { plan.groups[0].records[0].version = 100; }),
    altered(plan => { plan.unassigned[0].id = 'cook-1'; plan.unassigned[0].version = 1; }),
    altered(plan => { plan.unassigned = []; }),
    altered(plan => { plan.groups[0].records.pop(); plan.unassigned.push({ id: 'cook-2', version: 2, reason: '其他' }); }),
    { schemaVersion: 1, groups: groupingRecords.map(record => ({ name: record.title, reason: '一篇一个组', records: [{ id: record.id, version: record.version }] })), unassigned: [] },
  ]) assert.throws(() => validateBatchGrouping(value, input));
});

test('an existing singleton is allowed but unrelated notes are not forced into a new group', () => {
  const input = groupingInput(groupingRecords, ['旅行计划']);
  const value = sharedPlan(); value.groups.push({ name: '旅行计划', reason: '已存在的旅行主题', records: [{ id: 'trip-1', version: 3 }] }); value.unassigned = [];
  assert.equal(validateBatchGrouping(value, input).groups.length, 2);
  const empty = { schemaVersion: 1, groups: [], unassigned: groupingRecords.map(({ id, version }) => ({ id, version, reason: '暂不确定共同主题' })) };
  assert.equal(validateBatchGrouping(empty, input).unassigned.length, 3);
});

test('summary input and output limits fail before network access without silently dropping or shortening notes', async () => {
  let calls = 0;
  const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async () => { calls++; return response(sharedPlan()); } });
  const tooMany = Array.from({ length: 101 }, (_, index) => ({ ...groupingRecords[0], id: `r${index}` }));
  const oversized = Array.from({ length: 10 }, (_, index) => ({ ...groupingRecords[0], id: `r${index}`, summary: '字'.repeat(4000) }));
  await assert.rejects(client.classifyBatch(tooMany, { approved: true }), /100/);
  await assert.rejects(client.classifyBatch(oversized, { approved: true }), /96,000/);
  await assert.rejects(client.classifyBatch([{ ...groupingRecords[0], generation: '' }], { approved: true }));
  assert.equal(calls, 0); assert.equal(oversized[0].summary.length, 4000);
});

test('empty, truncated and cancelled grouping output is rejected without a hidden retry', async () => {
  for (const mode of ['empty', 'truncated', 'cancelled']) {
    let calls = 0; const controller = new AbortController();
    const client = new DeepSeekClient({ apiKey: 'mock-key', fetchImpl: async () => {
      calls++;
      if (mode === 'cancelled') controller.abort();
      return { ok: true, json: async () => ({ choices: [{ finish_reason: mode === 'truncated' ? 'length' : 'stop', message: { content: mode === 'empty' ? '' : JSON.stringify(sharedPlan()) } }] }) };
    } });
    await assert.rejects(client.classifyBatch(groupingRecords, { approved: true, signal: controller.signal })); assert.equal(calls, 1);
  }
});
