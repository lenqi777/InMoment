'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAIClient } = require('../src/core/ai-client.cjs');
const { getProvider, supportsImages, validateModel } = require('../src/core/ai-providers.cjs');
const { ApprovalRequiredError } = require('../src/core/deepseek.cjs');
const record = { id:'one', status:'saved', segments:[{ id:'s1', transcript:'我想留下收藏当时的理由，也能以后找到。' }] };
const organization = () => ({ schemaVersion:2, title:'留下收藏理由', summary:'保留收藏时的联想。', evidence:[{ segmentId:'s1', quote:'留下收藏当时的理由' }], points:[], uncertainties:[], topicSuggestions:[], context:{} });
const candidates = [{ id:'one', version:1, text:'收藏当时的理由', title:'收藏' }, { id:'two', version:2, text:'找到以前的灵感', title:'找回' }];
function response(provider, value) {
  return { ok:true, json:async () => provider === 'openai'
    ? { status:'completed', output:[{ type:'message', content:[{ type:'output_text', text:JSON.stringify(value) }] }], usage:{ input_tokens:12, output_tokens:6, total_tokens:18 } }
    : { candidates:[{ finishReason:'STOP', content:{ parts:[{ text:'not exposed reasoning', thought:true }, { text:JSON.stringify(value) }] } }], usageMetadata:{ promptTokenCount:12, candidatesTokenCount:4, thoughtsTokenCount:2, totalTokenCount:18 } } };
}
function mock(provider, value) { const calls = []; const client = createAIClient({ provider, apiKey:'fixture-key-only', fetchImpl:async (url, options) => { calls.push({ url, options, body:JSON.parse(options.body) }); return response(provider, value); } }); return { client, calls }; }
function inputOf(provider, request) { return JSON.parse(provider === 'openai' ? request.body.input[1].content[0].text : request.body.contents[0].parts[0].text); }
for (const provider of ['openai','gemini']) {
  test(provider + ': all remote methods reject missing approval before fetch', async () => {
    const { client, calls } = mock(provider, {});
    for (const work of [() => client.requestJson('JSON', {}), () => client.generateTitle(record), () => client.organize(record), () => client.classifyBatch([]), () => client.interpretQuery('收藏'), () => client.rankCandidates('收藏', candidates), () => client.findDuplicates(candidates)]) await assert.rejects(work(), ApprovalRequiredError);
    assert.equal(calls.length, 0);
  });
  test(provider + ': native official endpoint, isolated credential header and JSON output format', async () => {
    const { client, calls } = mock(provider, organization());
    const result = await client.organize(record, { approved:true }); const request = calls[0];
    assert.equal(calls.length, 1); assert.equal(result.evidenceVerified, true); assert.deepEqual(result.usage, { promptTokens:12, completionTokens:6, totalTokens:18 });
    assert.equal(request.options.redirect, 'error'); assert.equal(request.url.includes('fixture-key-only'), false); assert.equal(request.options.body.includes('fixture-key-only'), false);
    assert.equal(request.body.thinking, undefined); assert.equal(request.body.response_format, undefined);
    if (provider === 'openai') { assert.equal(request.url, 'https://api.openai.com/v1/responses'); assert.equal(request.options.headers.Authorization, 'Bearer fixture-key-only'); assert.equal(request.body.store, false); assert.equal(request.body.text.format.type, 'json_object'); assert.equal(request.body.reasoning.effort, 'none'); }
    else { assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent'); assert.equal(request.options.headers['x-goog-api-key'], 'fixture-key-only'); assert.equal(request.options.headers.Authorization, undefined); assert.equal(request.body.generationConfig.responseMimeType, 'application/json'); assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, 'low'); }
  });
  test(provider + ': naming sends only bounded transcript and never auxiliary context', async () => {
    const { client, calls } = mock(provider, { title:'留下当时的收藏理由' });
    const result = await client.generateTitle({ ...record, transcript:'灵感🙂'.repeat(6000), notes:'excluded-notes', source:{ title:'excluded-source' }, screenshots:['excluded-image'] }, { approved:true });
    assert.equal(result.title, '留下当时的收藏理由'); assert.equal(result.provider, provider);
    const input = inputOf(provider, calls[0]); assert.deepEqual(Object.keys(input), ['transcript']); assert.equal([...input.transcript].length, 12000);
    for (const excluded of ['excluded-notes','excluded-source','excluded-image']) assert.equal(calls[0].options.body.includes(excluded), false);
  });
  test(provider + ': screenshot is encoded using its native input contract', async () => {
    const { client, calls } = mock(provider, organization()); const image = { mimeType:'image/png', base64:Buffer.from('synthetic-image-only').toString('base64') };
    await client.organize(record, { approved:true, image });
    if (provider === 'openai') { assert.equal(calls[0].body.input[1].content[1].type, 'input_image'); assert.equal(calls[0].body.input[1].content[1].image_url, 'data:image/png;base64,' + image.base64); }
    else assert.deepEqual(calls[0].body.contents[0].parts[1].inlineData, { mimeType:'image/png', data:image.base64 });
  });
  test(provider + ': query, candidate rank, duplicates and shared grouping retain local validators', async () => {
    const values = [{ intent:'找回收藏理由', terms:['收藏'] }, { results:[{ id:'one', reason:'收藏的理由', quote:'收藏当时的理由' }] }, { duplicates:[] }, { schemaVersion:1, groups:[], unassigned:[{ id:'one', version:1, reason:'暂不分组' }] }];
    let index = 0; const client = createAIClient({ provider, apiKey:'fixture-key-only', fetchImpl:async () => response(provider, values[index++]) });
    assert.deepEqual((await client.interpretQuery('收藏', { approved:true })).terms, ['收藏']);
    assert.equal((await client.rankCandidates('收藏', candidates, { approved:true })).results[0].id, 'one');
    assert.equal((await client.findDuplicates(candidates, { approved:true, pairs:[{ leftId:'one', rightId:'two' }] })).duplicates.length, 0);
    const plan = await client.classifyBatch([{ id:'one', version:1, generation:'g1', title:'收藏', summary:'保存收藏理由。' }], { approved:true }); assert.equal(plan.unassigned.length, 1);
    const altered = organization(); altered.evidence[0].quote = '不存在的原话'; const invalid = mock(provider, altered); await assert.rejects(invalid.client.organize(record, { approved:true }), /does not match/);
  });
  test(provider + ': blocked or truncated output fails closed without retry or provider data in errors', async () => {
    for (const mode of ['blocked','truncated','bad-json','http','network','echo-key']) {
      let calls = 0; const client = createAIClient({ provider, apiKey:'fixture-key-only', fetchImpl:async () => {
        calls++;
        if (mode === 'network') throw new Error('fixture-key-only raw sensitive request');
        if (mode === 'http') return { ok:false, status:401, text:async () => 'fixture-key-only raw sensitive response' };
        const result = response(provider, mode === 'echo-key' ? { text:'fixture-key-only' } : {}); const payload = await result.json();
        if (provider === 'openai') { if (mode === 'blocked') payload.output[0].content = [{ type:'refusal', refusal:'sensitive-refusal' }]; if (mode === 'truncated') payload.status = 'incomplete'; if (mode === 'bad-json') payload.output[0].content[0].text = 'not json'; }
        else { if (mode === 'blocked') payload.promptFeedback = { blockReason:'SAFETY' }; if (mode === 'truncated') payload.candidates[0].finishReason = 'MAX_TOKENS'; if (mode === 'bad-json') payload.candidates[0].content.parts = [{ text:'not json' }]; }
        return { ok:true, json:async () => payload };
      } });
      await assert.rejects(client.requestJson('JSON', {}, { approved:true }), error => !/fixture-key-only|sensitive-refusal|raw sensitive/u.test(error.message)); assert.equal(calls, 1);
    }
  });
  test(provider + ': invalid image, budget and aborted signals never send or apply stale results', async () => {
    const { client, calls } = mock(provider, {}); const controller = new AbortController(); controller.abort();
    await assert.rejects(client.requestJson('JSON', {}, { approved:true, signal:controller.signal }), { name:'AbortError' });
    await assert.rejects(client.requestJson('JSON', {}, { approved:true, image:{ mimeType:'text/plain', base64:'AAAA' } }));
    await assert.rejects(client.requestJson('JSON', {}, { approved:true, maxTokens:4097 })); assert.equal(calls.length, 0);
    const later = new AbortController(); const late = createAIClient({ provider, apiKey:'fixture-key-only', fetchImpl:async () => ({ ok:true, json:async () => { later.abort(); return {}; } }) });
    await assert.rejects(late.requestJson('JSON', {}, { approved:true, signal:later.signal }), { name:'AbortError' });
  });
}
test('provider catalog validates custom IDs and refuses unknown service destinations', () => {
  assert.equal(getProvider('openai').defaultModel, 'gpt-5.4-mini'); assert.equal(validateModel(' ft:gpt-5.4-mini:organization:model '), 'ft:gpt-5.4-mini:organization:model');
  assert.throws(() => validateModel('../other')); assert.throws(() => createAIClient({ provider:'unknown' }));
  assert.equal(supportsImages('deepseek','deepseek-v4-pro'), false); assert.equal(supportsImages('openai','gpt-5.4-mini'), true); assert.equal(supportsImages('gemini','gemini-3.8-flash'), true);
});

test('OpenAI presets can use screenshot input and select a compatible reasoning budget', async () => {
  const presets = getProvider('openai').models;
  for (const model of ['gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.4-mini']) assert(presets.includes(model));
  const image = { mimeType:'image/png', base64:Buffer.from('synthetic-image-only').toString('base64') };
  for (const model of presets) {
    let body;
    const client = createAIClient({ provider:'openai', model, apiKey:'fixture-key-only', fetchImpl:async (_url, options) => {
      body = JSON.parse(options.body);
      return response('openai', { summary:'测试摘要' });
    } });
    assert.equal((await client.requestJson('生成 JSON 摘要', {}, { approved:true, image, maxTokens:128 })).model, model);
    assert.equal(body.model, model);
    assert.equal(body.input[1].content[1].type, 'input_image');
    assert.equal(body.text.format.type, 'json_object');
    const requiresReasoning = model === 'gpt-6-astra' || model === 'gpt-6.1-sol';
    assert.equal(body.reasoning.effort, requiresReasoning ? 'low' : 'none');
    assert.equal(body.max_output_tokens, requiresReasoning ? 2048 : 128);
  }
});
