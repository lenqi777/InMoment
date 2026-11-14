'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAIClient } = require('../src/core/ai-client.cjs');
const { NoteAI } = require('../src/main/note-ai.cjs');

function fixture({ image = null, includeSelectionContext = false, respond = async () => ({ value: { text: '生成的正文' } }) } = {}) {
  let note = { id: 'note', title: '会议记录', body: '第一段。\r\n第二段。', background: {
    appName: '浏览器', windowTitle: '会议', url: 'https://example.test/meeting', task: '汇总计划',
    screenshots: [{ id: 'image', url: 'inmoment-media://record/local/image/image' }],
    audioSegments: [{ id: 'audio', url: 'inmoment-media://record/local/audio/audio', durationMs: 14000 }],
  } };
  const calls = [];
  const saved = [];
  const get = () => {
    if (!note) throw new Error('这条笔记已不存在。');
    return structuredClone(note);
  };
  const service = new NoteAI({
    notes: {
      get,
      createSummary(id, text) {
        const summary = { id: 'summary', title: '总结', body: text };
        saved.push({ id, summary });
        return { note: { ...get(), summaries: [{ id: summary.id, title: summary.title }] }, summary };
      },
    },
    prepareRequest(_note, { full }) {
      return { image: full ? image : null, includeSelectionContext, assertAllowed() {}, client: {
        requestJson(system, payload, options) {
          calls.push({ system, payload, options });
          return respond(payload, options);
        },
      } };
    },
  });
  return { service, calls, saved, get, set(value) { note = value; } };
}

test('full note summary sends persisted body and source metadata and attaches a separate summary', async () => {
  const image = { mimeType: 'image/png', base64: 'aW1hZ2U=' };
  const { service, calls, saved, get } = fixture({ image });
  const original = get();
  const result = await service.summary('note', { approved: true });
  assert.deepEqual(calls.map(call => call.payload), [{
    title: original.title, body: original.body, source: {
      application: '浏览器', windowTitle: '会议', url: 'https://example.test/meeting', task: '汇总计划',
      recordingCount: 1, recordingDurationMs: 14000,
    },
  }]);
  assert.equal(calls[0].options.approved, true);
  assert.equal(calls[0].options.image, image);
  assert.deepEqual(saved, [{ id: 'note', summary: result.summary }]);
  assert.equal(result.summary.body, '生成的正文');
  assert.equal(result.note.body, original.body);
  assert.deepEqual(get(), original);
});

test('selection actions send exactly the selected text with an instruction only for rewriting', async () => {
  const { service, calls, saved } = fixture({
    image: { mimeType: 'image/png', base64: 'aW1hZ2U=' },
    respond: async () => ({ value: { text: ' 改写后的文本。\n' } }),
  });
  const selection = '第一段。\n第二段';
  assert.deepEqual(await service.summary('note', { selection, approved: true }), { text: '改写后的文本。' });
  assert.deepEqual(await service.rewrite('note', { selection, instruction: '使用更口语的表达', approved: true }), { text: ' 改写后的文本。\n' });
  assert.deepEqual(calls.map(call => call.payload), [{ selection }, { selection, instruction: '使用更口语的表达' }]);
  assert.deepEqual(calls.map(call => call.options.image), [null, null]);
  assert.deepEqual(saved, []);
});

test('approval, a current selection, and a rewrite instruction are required before dispatch', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.summary('note'), { code: 'APPROVAL_REQUIRED' });
  await assert.rejects(service.summary('note', { selection: '不存在', approved: true }), /重新选择/u);
  await assert.rejects(service.rewrite('note', { selection: '第一段', instruction: ' ', approved: true }), /修改要求/u);
  assert.deepEqual(calls, []);
});

test('selection context follows the exact normalized range and caps both edges at 900 Unicode code points', async () => {
  const { service, calls, get, set } = fixture({ includeSelectionContext: true });
  const selection = '所选\n文字';
  const before = '前😀'.repeat(449) + '\n尾';
  const after = '始\n' + '🌿后'.repeat(449);
  const prefix = selection + '超出范围' + before;
  set({ ...get(), body: (prefix + selection + after + '不发送').replace(/\n/gu, '\r\n') });
  const range = { selection, start: prefix.length, end: prefix.length + selection.length, approved: true };
  await service.summary('note', range);
  await service.rewrite('note', { ...range, instruction: '更顺畅' });
  await service.summary('note', { selection, approved: true });
  assert.deepEqual(calls.map(call => call.payload), [
    { selection, before, after },
    { selection, instruction: '更顺畅', before, after },
    { selection },
  ]);
  assert.match(calls[1].system, /只返回能放回原选区的替换片段/u);
  assert.match(calls[1].system, /避免重复选区外的文字和标点/u);
  assert.ok(calls.every(call => call.options.image === null));
});

test('malformed ranges are rejected before dispatch even when the same selection occurs elsewhere', async () => {
  const { service, calls, get, set } = fixture({ includeSelectionContext: true });
  set({ ...get(), body: '甲😀乙甲' });
  for (const bounds of [{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 0 }, { start: '0', end: 1 }, { start: -1, end: 1 }, { start: 4, end: 6 }]) {
    await assert.rejects(service.summary('note', { selection: '甲', ...bounds, approved: true }), /重新选择/u);
  }
  await assert.rejects(service.summary('note', { selection: '\ud83d', start: 1, end: 2, approved: true }), /重新选择/u);
  await assert.rejects(service.summary('note', { start: 0, end: 1, approved: true }), /请选中/u);
  assert.deepEqual(calls, []);
});

test('list expansion asks for only new items without transmitting unselected list text', async () => {
  const items = ['检查窗口缩放', '记录失败场景'];
  const { service, calls, get, set } = fixture({ respond: async () => ({ value: { items } }) });
  const body = '标题\n- 查看现有设置\n- 检查可访问性\n\n其他段落';
  const selection = '查看现有';
  const start = body.indexOf(selection);
  const instruction = '再补充几条';
  set({ ...get(), body });
  const result = await service.rewrite('note', { selection, start, end: start + selection.length, instruction, approved: true });
  assert.deepEqual(result, { items });
  assert.deepEqual(calls[0].payload, { selection, instruction });
  assert.match(calls[0].system, /只生成未出现的内容/u);
  assert.match(calls[0].system, /字符串数组 items/u);
  assert.equal(get().body, body);
});

test('ranged rewrite drops a result if the body changes while the exact selected text is still present', async () => {
  const { service, get, set } = fixture({ includeSelectionContext: true, respond: async () => {
    set({ ...get(), body: '开头。\r\n第二段。' });
    return { value: { text: '过时的修改稿' } };
  } });
  await assert.rejects(service.rewrite('note', {
    selection: '第二段', start: 5, end: 8, instruction: '更顺畅', approved: true,
  }), /笔记内容已修改/u);
});

test('long selection summaries use adjacent context only at the corresponding edge', async () => {
  const { service, calls, get, set } = fixture({
    includeSelectionContext: true,
    respond: async payload => ({ value: { text: payload.text ? '片段要点' : '综合总结' } }),
  });
  const before = '起'.repeat(900);
  const after = '终'.repeat(900);
  const selection = '长选段🌿\n'.repeat(40000);
  set({ ...get(), body: before + selection + after });
  await service.summary('note', { selection, start: before.length, end: before.length + selection.length, approved: true });
  const payloads = calls.map(call => call.payload);
  assert.equal(payloads[0].before, before);
  assert.equal(payloads.at(-2).after, after);
  assert.equal(payloads.slice(0, -1).map(payload => payload.text).join(''), selection);
  assert.equal(payloads.filter(payload => Object.hasOwn(payload, 'before')).length, 1);
  assert.equal(payloads.filter(payload => Object.hasOwn(payload, 'after')).length, 1);
  assert.ok(payloads.every(payload => JSON.stringify(payload).length <= 90_000));
});

test('long note summaries include every character through bounded section requests and a final synthesis', async () => {
  const { service, calls, get, set } = fixture({ respond: async payload => ({ value: { text: payload.text ? '片段要点' : '综合总结' } }) });
  const body = '开头' + '某段内容📝\n'.repeat(20000) + '结尾';
  set({ ...get(), body });
  const result = await service.summary('note', { approved: true });
  assert.equal(result.summary.body, '综合总结');
  const requests = calls.map(call => call.payload);
  assert.ok(requests.length > 2);
  assert.equal(requests.slice(0, -1).map(part => part.text).join(''), body);
  assert.equal(requests.at(-1).parts.length, requests.length - 1);
  assert.equal(requests.at(-1).source.url, get().background.url);
  assert.ok(requests.every(part => JSON.stringify(part).length <= 90_000));
});

test('results for a changed or deleted note and invalid responses never create attachments', async () => {
  for (const invalidation of ['update', 'delete', 'schema']) {
    const { service, saved, get, set } = fixture({ respond: async () => {
      if (invalidation === 'update') set({ ...get(), title: '更新后的标题' });
      if (invalidation === 'delete') set(null);
      return { value: invalidation === 'schema' ? { text: '结果', extra: 'invalid' } : { text: '旧结果' } };
    } });
    await assert.rejects(service.summary('note', { approved: true }), /已修改|已不存在|格式有误/u);
    assert.deepEqual(saved, []);
  }
});

test('cancelling a request allows immediate retry and drops the late first result', async () => {
  const { promise, resolve } = Promise.withResolvers();
  let pending = true;
  const { service, saved } = fixture({ respond: () => {
    if (pending) { pending = false; return promise; }
    return Promise.resolve({ value: { text: '本次结果' } });
  } });
  const cancelled = service.summary('note', { approved: true });
  await assert.rejects(service.summary('note', { approved: true }), /已有 AI 任务/u);
  assert.equal(service.cancel('note'), true);
  assert.equal((await service.summary('note', { approved: true })).summary.body, '本次结果');
  resolve({ value: { text: '取消后的结果' } });
  await assert.rejects(cancelled, /已取消/u);
  assert.equal(saved.length, 1);
});

test('note rewrite uses the configured JSON AI transport with injected fetch', async () => {
  const { service, get } = fixture();
  const client = createAIClient({ provider: 'deepseek', apiKey: 'test-only-key', fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'deepseek-flash');
    assert.deepEqual(JSON.parse(payload.messages[1].content), { selection: '第一段', instruction: '缩短' });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"text":"首段"}' } }] }));
  } });
  service.prepareRequest = note => {
    assert.deepEqual(note, get());
    return { client, assertAllowed() {} };
  };
  assert.deepEqual(await service.rewrite('note', { selection: '第一段', instruction: '缩短', approved: true }), { text: '首段' });
});
