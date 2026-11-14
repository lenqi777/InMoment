'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatClient, selectChatModel, LIMITS } = require('../src/core/chat-client.cjs');
const { ApprovalRequiredError } = require('../src/core/deepseek.cjs');
const providers = ['deepseek', 'openai', 'gemini'];
const key = 'fixture-chat-key-only';
const messages = [{ role: 'system', text: '帮助理解学习资料。' }, { role: 'user', text: '什么是一个想法？' }, { role: 'assistant', text: '一个尚待探索的念头。' }, { role: 'user', text: '举个例子。', images: [{ mimeType: 'image/png', base64: Buffer.from('synthetic image').toString('base64') }] }];
function data(value, event = '') { return (event ? 'event: ' + event + '\n' : '') + 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n'; }
function delta(provider, text) {
  if (provider === 'deepseek') return data({ choices: [{ delta: { content: text } }] });
  if (provider === 'openai') return data({ type: 'response.output_text.delta', delta: text }, 'response.output_text.delta');
  return data({ candidates: [{ content: { parts: [{ text }] } }] });
}
function terminal(provider, reason) {
  if (provider === 'deepseek') return data({ choices: [{ delta: {}, finish_reason: reason || 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }) + data('[DONE]');
  if (provider === 'openai') return data({ type: 'response.' + (reason || 'completed'), response: { status: reason || 'completed', usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } });
  return data({ candidates: [{ content: { parts: [] }, finishReason: reason || 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 1, totalTokenCount: 16 } });
}
function response(text, fragment = 7) {
  const bytes = Buffer.from(text);
  return { ok: true, body: new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += fragment) controller.enqueue(bytes.subarray(offset, offset + fragment)); controller.close(); } }) };
}
function setup(provider, stream) {
  const calls = [];
  return { calls, client: createChatClient({ provider, key, model: 'user-old-model', fetchImpl: async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return response(stream ?? delta(provider, '这是一个想法🙂。') + terminal(provider), 1); } }) };
}

for (const provider of providers) {
  test(provider + ': native streaming preserves history, pictures and UTF-8 using automatic provider model', async () => {
    const { calls, client } = setup(provider); const deltas = [];
    const result = await client.chat(messages, { approved: true, onDelta: value => deltas.push(value) });
    assert.equal(result.text, '这是一个想法🙂。'); assert.equal(deltas.join(''), result.text);
    assert.equal(result.model, selectChatModel(provider, { hasImages: true })); assert.equal(calls.length, 1);
    assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 4, totalTokens: 16 });
    const request = calls[0];
    assert.equal(request.options.redirect, 'error'); assert.equal(request.options.body.includes(key), false); assert.equal(request.url.includes(key), false); assert.equal(request.body.stream ?? true, true);
    if (provider === 'deepseek') { assert.equal(request.url, 'https://api.deepseek.com/chat/completions'); assert.equal(request.body.messages.length, 4); assert.equal(request.body.messages[3].content[1].type, 'image_url'); assert.equal(request.body.thinking.type, 'disabled'); }
    if (provider === 'openai') { assert.equal(request.url, 'https://api.openai.com/v1/responses'); assert.equal(request.body.store, false); assert.equal(request.body.input.length, 4); assert.equal(request.body.input[2].role, 'assistant'); assert.equal(request.body.input[2].content, messages[2].text); assert.equal(request.body.input[3].content[1].type, 'input_image'); }
    if (provider === 'gemini') { assert.match(request.url, /gemini-3\.1-flash-lite:streamGenerateContent\?alt=sse$/u); assert.equal(request.body.contents.length, 3); assert.equal(request.body.contents[1].role, 'model'); assert.equal(request.body.contents[2].parts[1].inlineData.mimeType, 'image/png'); assert.equal(request.options.headers['x-goog-api-key'], key); }
  });
  test(provider + ': approval, key, attachment and budget guards make no requests', async () => {
    const { calls, client } = setup(provider);
    await assert.rejects(client.chat(messages), ApprovalRequiredError);
    await assert.rejects(client.chat([{ role: 'user', text: 'x'.repeat(LIMITS.text + 1) }], { approved: true }), { code: 'CHAT_INVALID' });
    await assert.rejects(client.chat([{ role: 'user', text: '', images: [{ mimeType: 'audio/wav', base64: 'AAAA' }] }], { approved: true }), { code: 'CHAT_INVALID' });
    const stop = new AbortController(); stop.abort();
    await assert.rejects(client.chat(messages, { approved: true, signal: stop.signal }), { name: 'AbortError' });
    assert.equal(calls.length, 0);
    const noKey = createChatClient({ provider, fetchImpl: async () => assert.fail('no fetch') });
    await assert.rejects(noKey.chat(messages, { approved: true }), { code: 'HTTP_AUTH' });
  });
  test(provider + ': split exact key and split sk-key never reach streaming callbacks', async () => {
    for (const parts of [[key.slice(0, 7), key.slice(7)], ['sk-', 'abcd', '12345678']]) {
      const { client } = setup(provider, delta(provider, '正常文字 ') + parts.map(part => delta(provider, part)).join('') + terminal(provider)); const output = [];
      await assert.rejects(client.chat(messages, { approved: true, onDelta: value => output.push(value) }), { code: 'CHAT_SENSITIVE' });
      assert.equal(output.join(''), '正常文字 ');
    }
  });
  test(provider + ': truncated stream and provider finish failures remain retryable visible failures', async () => {
    const short = setup(provider, delta(provider, '未完成'));
    await assert.rejects(short.client.chat(messages, { approved: true }), { code: 'CHAT_INCOMPLETE' });
    const reason = provider === 'deepseek' ? 'length' : provider === 'openai' ? 'incomplete' : 'MAX_TOKENS';
    const incomplete = setup(provider, delta(provider, '未完成') + terminal(provider, reason));
    await assert.rejects(incomplete.client.chat(messages, { approved: true }), { code: 'CHAT_INCOMPLETE' }); assert.equal(incomplete.calls.length, 1);
  });
  test(provider + ': HTTP and transport errors contain no response payload or credential and do not retry', async () => {
    for (const [status, code] of [[401, 'HTTP_AUTH'], [403, 'HTTP_ACCESS'], [404, 'HTTP_ACCESS'], [429, 'HTTP_QUOTA'], [402, 'HTTP_QUOTA'], [503, 'HTTP_TRANSIENT']]) {
      let calls = 0; const client = createChatClient({ provider, key, fetchImpl: async () => { calls++; return { ok: false, status, text: async () => key + ' sensitive response' }; } });
      await assert.rejects(client.chat(messages, { approved: true }), reason => reason.code === code && !reason.message.includes(key) && !reason.message.includes('sensitive'));
      assert.equal(calls, 1);
    }
    const client = createChatClient({ provider, key, fetchImpl: async () => { throw new Error(key); } });
    await assert.rejects(client.chat(messages, { approved: true }), reason => reason.code === 'HTTP_NETWORK' && !reason.message.includes(key));
  });
}

test('abort while a mock ignores request abort settles promptly and never exposes later text', async () => {
  const stop = new AbortController(); let writer, cancelled = false, shown = '';
  const client = createChatClient({ provider: 'openai', key, fetchImpl: async () => ({ ok: true, body: new ReadableStream({ start(controller) { writer = controller; controller.enqueue(Buffer.from(delta('openai', '已收到'))); }, cancel() { cancelled = true; } }) }) });
  const running = client.chat(messages, { approved: true, signal: stop.signal, onDelta: value => { shown += value; stop.abort(); } });
  await assert.rejects(running, { name: 'AbortError' }); assert.equal(shown, '已收到'); assert.equal(cancelled, true);
  assert.throws(() => writer.enqueue(Buffer.from(delta('openai', '过期内容'))));
});
test('malformed and oversized streaming events are bounded without leaking raw provider data', async () => {
  for (const stream of ['data: {private-' + key + '}\n\n', 'data: ' + 'a'.repeat(LIMITS.eventCharacters + 1) + '\n\n']) {
    const client = createChatClient({ key, fetchImpl: async () => response(stream, 64000) });
    await assert.rejects(client.chat(messages, { approved: true }), reason => !reason.message.includes(key));
  }
});
test('SSE comments, CRLF split boundaries and multiple data lines are parsed correctly', async () => {
  const stream = ': keep-alive\r\n\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"理解"}}]}\r\n\r\n' + terminal('deepseek');
  const { client } = setup('deepseek', stream);
  assert.equal((await client.chat(messages, { approved: true })).text, '理解');
});
test('unknown destinations fail before any request and unavailable attachment helpers stop final generation', async () => {
  assert.throws(() => createChatClient({ provider: 'custom-proxy' }));
  const models = [];
  const client = createChatClient({ key, provider: 'deepseek', model: 'deepseek-v4-pro', allowModelOverride: true, fetchImpl: async (url, options) => {
    models.push(JSON.parse(options.body).model);
    return { ok: false, status: 404 };
  } });
  await assert.rejects(client.chat(messages, { approved: true }), { code: 'CHAT_CAPABILITY' });
  assert.deepEqual(models, ['deepseek-flash']);
});

const pdf = { id: 'synthetic-pdf', name: '实验报告.pdf', mimeType: 'application/pdf', base64: Buffer.from('%PDF-1.7\nfixture').toString('base64') };
const mp4 = { id: 'synthetic-video', name: '实验演示.mp4', mimeType: 'video/mp4', base64: Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom0000')]).toString('base64') };
const picture = messages.at(-1).images[0];
test('mixed media payload preserves native files where supported and the extracted evidence elsewhere', async () => {
  for (const provider of providers) {
    const { client, calls } = setup(provider);
    const attachments = provider === 'gemini' ? [pdf, mp4] : provider === 'openai' ? [pdf] : [];
    const text = '解释资料。\n文本附件甲' + (provider === 'gemini' ? '' : '\n音轨转写乙');
    await client.chat([{ role: 'user', text, images: provider === 'gemini' ? [picture] : [picture, picture], attachments }], { approved: true });
    assert.equal(calls.length, 1);
    const { body } = calls[0];
    if (provider === 'gemini') {
      assert.deepEqual(body.contents[0].parts.flatMap(part => part.inlineData?.mimeType || []), ['image/png', 'application/pdf', 'video/mp4']);
      assert.equal(body.contents[0].parts.at(-1).text, text);
      assert.match(JSON.stringify(body), /实验演示\.mp4/u);
    } else if (provider === 'openai') {
      assert.deepEqual(body.input[0].content.map(part => part.type), ['input_text', 'input_image', 'input_image', 'input_file']);
      assert.equal(body.input[0].content.at(-1).filename, pdf.name);
      assert.equal(body.input[0].content[0].text, text);
    } else {
      assert.deepEqual(body.messages[0].content.map(part => part.type), ['text', 'image_url', 'image_url']);
      assert.equal(body.messages[0].content[0].text, text);
    }
  }
});

test('manual text-only model receives same-provider evidence from current and historical attachments', async () => {
  const calls = [], deltas = [], stages = [];
  const client = createChatClient({ provider: 'openai', key, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (calls.length === 1) return { ok: false, status: 404 };
    const answer = calls.length === 2 ? '截图写着 18，报告第 2 页写着 19。' : '两份材料的数字相差 1。';
    return response(delta('openai', answer) + terminal('openai'));
  } });
  const result = await client.chat([...messages, { role: 'user', text: '和报告比较。', attachments: [pdf] }], {
    approved: true, userQuestion: '和报告比较。', sourceCount: 2, modelOverride: 'text-only-fixture', reasoningEffort: 'deep',
    onStage: stage => stages.push(stage), onDelta: text => deltas.push(text),
  });
  assert.deepEqual(calls.map(call => call.body.model), ['gpt-5.4-mini', 'gpt-5.4', 'text-only-fixture']);
  assert.ok(calls.every(call => call.url === 'https://api.openai.com/v1/responses'));
  assert.match(JSON.stringify(calls[1].body), /input_image.+input_file.+和报告比较/u);
  assert.doesNotMatch(JSON.stringify(calls[2].body), /input_image|input_file|data:image\//u);
  assert.match(JSON.stringify(calls[2].body), /和报告比较.+报告第 2 页写着 19/u);
  assert.deepEqual(deltas, [result.text]);
  assert.deepEqual(stages.map(stage => stage.id), ['route', 'read-attachments', 'read-attachments', 'request']);
  assert.equal(result.usage.totalTokens, 32);
});

test('Auto checks task and provider preference, with explicit Auto superseding legacy manual default', async () => {
  const tasks = { userQuestion: '核对报告和截图是否一致', sourceCount: 2 };
  assert.equal(selectChatModel('openai', tasks), 'gpt-5.4');
  assert.equal(selectChatModel('openai', { userQuestion: '这是什么？', sourceCount: 4 }), 'gpt-5.4-mini');
  assert.equal(selectChatModel('deepseek', tasks), 'deepseek-v4-pro');
  assert.equal(selectChatModel('deepseek', { ...tasks, hasImages: true }), 'deepseek-flash');
  assert.equal(selectChatModel('gemini', tasks), 'gemini-3.8-flash');
  assert.equal(selectChatModel('gemini', { ...tasks, preferFreeModel: false }), 'gemini-4-argon');
  assert.equal(selectChatModel('gemini', { userQuestion: '你好', preferFreeModel: false }), 'gemini-3.8-flash');
  assert.equal(selectChatModel('openai', { userQuestion: '不用深入分析' }), 'gpt-5.4-mini');
  const calls = [];
  const client = createChatClient({ provider: 'openai', key, allowModelOverride: true, model: 'gpt-5.4', fetchImpl: async (url, options) => {
    calls.push(JSON.parse(options.body));
    return response(delta('openai', '已读。') + terminal('openai'));
  } });
  await client.chat([{ role: 'user', text: '你好' }], { approved: true, modelOverride: null, reasoningEffort: 'deep' });
  assert.equal(calls[0].model, 'gpt-5.4-mini');
  assert.equal(calls[0].reasoning.effort, 'high');
});
test('completed protocol event releases a connection that has not closed and ignores trailing text', async () => {
  for (const provider of ['deepseek', 'openai']) {
    let cancelled = false;
    const client = createChatClient({ provider, key, fetchImpl: async () => ({ ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(delta(provider, '完整回复') + terminal(provider) + delta(provider, '过期尾部'))); }, cancel() { cancelled = true; } }) }) });
    const result = await client.chat(messages, { approved: true });
    assert.equal(result.text, '完整回复'); assert.equal(cancelled, true);
  }
});
test('timeout interrupts an unresponsive injected fetch without raw errors or callbacks', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const client = createChatClient({ key, fetchImpl: () => new Promise(() => {}) });
    await assert.rejects(client.chat(messages, { approved: true, timeoutMs: 10, onDelta: () => assert.fail('no output') }), { name: 'AbortError' });
  } finally { clearTimeout(keepAlive); }
});
