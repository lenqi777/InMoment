'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DeepSeekClient, ApprovalRequiredError, validateOrganization, DEFAULT_MODEL, MAX_TITLE_INPUT_CHARACTERS, MAX_GENERATED_TITLE_CHARACTERS } = require('../src/core/deepseek.cjs');

const record = { id: 'record-1', status: 'saved', task: '寻找项目方向', segments: [{ id: 'seg-1', transcript: '可以把收藏当时的理由留下来。' }] };
function organization() { return { title: '保存收藏理由', summary: '探索保存收藏理由的工具', ideas: [{ text: '保存收藏理由', evidence: [{ segmentId: 'seg-1', quote: '把收藏当时的理由留下来' }] }], questions: ['哪些上下文有帮助？'], returnToTask: '回到项目方向研究' }; }
function response(value, extra = {}) { return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop', ...extra }] }) }; }

test('unapproved remote calls never invoke fetch, even with a configured key', async () => {
  let calls = 0;
  const client = new DeepSeekClient({ apiKey: 'test-placeholder', fetchImpl: async () => { calls += 1; throw new Error('Must not happen'); } });
  await assert.rejects(client.organize(record), ApprovalRequiredError);
  await assert.rejects(client.organize(record, { approved: 'true' }), ApprovalRequiredError);
  assert.equal(calls, 0);
});

test('approved organize uses official endpoint and validates verbatim evidence (mock only)', async () => {
  let request;
  const client = new DeepSeekClient({ apiKey: 'test-placeholder', fetchImpl: async (url, options) => { request = { url, options }; return response(organization()); } });
  const result = await client.organize(record, { approved: true });
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(result.evidenceVerified, true);
  assert.equal(result.ideas[0].evidence[0].segmentId, 'seg-1');
  assert.equal(JSON.stringify(body).includes('test-placeholder'), false);
});

test('AI hallucinated quotes and segment references are rejected', () => {
  const altered = organization();
  altered.ideas[0].evidence[0].quote = '用户已经决定开发这个产品';
  assert.throws(() => validateOrganization(altered, record.segments), /does not match/);
  altered.ideas[0].evidence[0] = { segmentId: 'fake-segment', quote: '留下来' };
  assert.throws(() => validateOrganization(altered, record.segments), /unknown segment/);
});

test('drafts and empty transcripts cannot be sent, even after approval', async () => {
  let calls = 0;
  const client = new DeepSeekClient({ apiKey: 'test-placeholder', fetchImpl: async () => { calls += 1; return response(organization()); } });
  await assert.rejects(client.organize({ ...record, status: 'draft' }, { approved: true }), /completed/);
  await assert.rejects(client.organize({ ...record, segments: [] }, { approved: true }), /no transcript/);
  assert.equal(calls, 0);
});

test('HTTP errors are sanitized and never auto retry', async () => {
  let calls = 0;
  const client = new DeepSeekClient({ apiKey: 'test-placeholder', fetchImpl: async () => { calls += 1; return { ok: false, status: 401, text: async () => 'sensitive-provider-body' }; } });
  await assert.rejects(client.organize(record, { approved: true }), error => error.message.includes('401') && !error.message.includes('sensitive'));
  assert.equal(calls, 1);
});

test('missing API key never sends a request', async () => {
  let calls = 0;
  const client = new DeepSeekClient({ fetchImpl: async () => { calls += 1; } });
  await assert.rejects(client.organize(record, { approved: true }), /API key/);
  assert.equal(calls, 0);
});

test('naming requires explicit authorization and never sends an unapproved request', async () => {
  let calls = 0;
  const client = new DeepSeekClient({ apiKey: 'mock-key-only', fetchImpl: async () => { calls++; return response({ title: '保存当时的收藏理由' }); } });
  await assert.rejects(client.generateTitle(record), ApprovalRequiredError);
  await assert.rejects(client.generateTitle(record, { approved: 'true' }), ApprovalRequiredError);
  assert.equal(calls, 0);
});

test('naming accepts only completed, untitled records with transcript text', async () => {
  let calls = 0;
  const client = new DeepSeekClient({ apiKey: 'mock-key-only', fetchImpl: async () => { calls++; return response({ title: '保存当时的收藏理由' }); } });
  await assert.rejects(client.generateTitle({ ...record, status: 'draft' }, { approved: true }), /completed/);
  await assert.rejects(client.generateTitle({ ...record, segments: [] }, { approved: true }), /no transcript/);
  await assert.rejects(client.generateTitle({ ...record, title: '用户自己的标题' }, { approved: true }), /already has/);
  assert.equal(calls, 0);
});

test('naming sends only the bounded transcript to the official endpoint (mock only)', async () => {
  let request;
  const client = new DeepSeekClient({ apiKey: 'mock-key-only', fetchImpl: async (url, options) => { request = { url, options }; return response({ title: '保存当时的收藏理由' }); } });
  const transcript = '灵感🙂'.repeat(5000);
  const result = await client.generateTitle({ ...record, transcript, task: 'TASK-MUST-NOT-SEND', notes: 'NOTES-MUST-NOT-SEND', source: { title: 'SOURCE-MUST-NOT-SEND' }, screenshots: ['SCREENSHOT-MUST-NOT-SEND'] }, { approved: true });
  assert.equal(result.title, '保存当时的收藏理由');
  assert.equal(result.model, DEFAULT_MODEL);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(Object.keys(JSON.parse(body.messages[1].content)), ['transcript']);
  const sent = JSON.parse(body.messages[1].content).transcript;
  assert.equal([...sent].length, MAX_TITLE_INPUT_CHARACTERS);
  assert.equal(sent, [...transcript].slice(0, MAX_TITLE_INPUT_CHARACTERS).join(''));
  for (const forbidden of ['TASK-MUST-NOT-SEND', 'NOTES-MUST-NOT-SEND', 'SOURCE-MUST-NOT-SEND', 'SCREENSHOT-MUST-NOT-SEND', 'mock-key-only']) assert.equal(request.options.body.includes(forbidden), false);
});

test('naming normalizes whitespace and bounds title length without splitting Unicode characters', async () => {
  const client = new DeepSeekClient({ apiKey: 'mock-key-only', fetchImpl: async () => response({ title: '  灵感🙂'.repeat(20) + '\n' }) });
  const result = await client.generateTitle(record, { approved: true });
  assert.equal([...result.title].length, MAX_GENERATED_TITLE_CHARACTERS);
  assert.equal(result.title.includes('\n'), false);
  assert.equal(result.title.includes('  '), false);
  assert.equal(/^[\ud800-\udfff]$/u.test([...result.title].at(-1)), false);
});

test('naming abort before request never invokes fetch; abort after response rejects the result', async () => {
  let calls = 0;
  const abort = new AbortController(); abort.abort();
  const client = new DeepSeekClient({ apiKey: 'mock-key-only', fetchImpl: async () => { calls++; return response({ title: '保存收藏理由' }); } });
  await assert.rejects(client.generateTitle(record, { approved: true, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const later = new AbortController();
  const lateClient = new DeepSeekClient({ apiKey: 'mock-key-only', fetchImpl: async () => { later.abort(); return response({ title: '保存收藏理由' }); } });
  await assert.rejects(lateClient.generateTitle(record, { approved: true, signal: later.signal }), { name: 'AbortError' });
});

test('naming errors omit private HTTP bodies, network messages, model content and key', async () => {
  const privateText = 'PRIVATE-ORIGINAL-EXPRESSION';
  const key = 'mock-key-only';
  for (const fetchImpl of [
    async () => { throw new Error(privateText + key); },
    async () => ({ ok: false, status: 429, text: async () => privateText + key }),
    async () => ({ ok: true, json: async () => { throw new Error(privateText + key); } }),
    async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: privateText + key } }] }) }),
    async () => response({ title: key }),
  ]) {
    const client = new DeepSeekClient({ apiKey: key, fetchImpl });
    await assert.rejects(client.generateTitle(record, { approved: true }), error => !error.message.includes(privateText) && !error.message.includes(key));
  }
});

test('naming rejects malformed or truncated output without automatic retries', async () => {
  for (const invalid of [{}, { title: '' }, { title: ' ' }, { title: 123 }, { title: '合法标题', extra: 'not allowed' }, ['合法标题']]) {
    let calls = 0;
    const client = new DeepSeekClient({ apiKey: 'mock-key-only', fetchImpl: async () => { calls++; return response(invalid); } });
    await assert.rejects(client.generateTitle(record, { approved: true }));
    assert.equal(calls, 1);
  }
  const client = new DeepSeekClient({ apiKey: 'mock-key-only', fetchImpl: async () => response({ title: '截断标题' }, { finish_reason: 'length' }) });
  await assert.rejects(client.generateTitle(record, { approved: true }), /truncated/);
});
