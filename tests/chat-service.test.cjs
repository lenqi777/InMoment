'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalStore } = require('../src/core/store.cjs');
const { ChatService, rendererChat } = require('../src/main/chat-service.cjs');
const { NotesStore } = require('../src/main/notes.cjs');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, '.tmp-chat-'));
  const store = new LocalStore(root); const requests = []; const services = [];
  let config = { provider: 'deepseek', key: 'unit-credential', model: 'automatic' };
  const make = overrides => {
    const service = new ChatService({ rootDir: root, store, getConfig: () => ({ ...config }), createClient: () => ({ async chat(messages, settings) { requests.push({ messages, settings }); if (options.chat) return options.chat(messages, settings); settings.onDelta?.('测试'); settings.onDelta?.('回答'); return { text: '测试回答', provider: config.provider, model: 'test-model', usage: { totalTokens: 4 } }; } }), ...options, ...overrides });
    services.push(service); return service;
  };
  const service = make();
  t.after(() => { for (const item of services) item.shutdown(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, service, requests, make, setConfig: value => { config = { ...config, ...value }; } };
}
const image = () => ({ id: 'synthetic-image', mimeType: 'image/png', base64: Buffer.from('synthetic pixels only').toString('base64') });
const textAttachment = (id, text) => ({ id, mimeType: 'text/plain', name: `${id}.txt`, base64: Buffer.from(text).toString('base64') });

test('mixed attachment history persists original bytes and exposes metadata to the renderer', async t => {
  const plain = textAttachment('plain', '原文件正文');
  const pdf = { id: 'pdf', mimeType: 'application/pdf', name: '资料.pdf', base64: Buffer.from('%PDF-1.7\n%%EOF').toString('base64') };
  let prepared;
  const { service, store, root, requests, make } = fixture(t, {
    async prepareMessages(messages, { provider, signal }) {
      assert.equal(provider, 'deepseek');
      assert.equal(signal.aborted, false);
      prepared = messages;
      return messages.map(({ attachments, ...message }) => attachments ? { ...message, text: `${message.text}\n合成提取结果` } : message);
    },
  });
  const note = store.complete(store.createDraft({ title: '笔记', notes: '已保存的引用正文' }).id);
  const chat = service.create({ autoSave: true, images: [image()], attachments: [plain, pdf], selectedText: '所选文字', quotes: [{ id: 'quoted', text: '引用对话' }] });
  const sent = await service.send(chat.id, { text: '比较图片和文件', recordIds: [note.id] });
  const user = sent.messages[0];
  assert.deepEqual(prepared[1].attachments, [plain, pdf]);
  assert.deepEqual(user.attachments, [plain, pdf]);
  assert.deepEqual(requests[0].messages[1].images, [image()]);
  assert.match(requests[0].messages[1].text, /合成提取结果/u);
  assert.equal(requests[0].settings.userQuestion, '比较图片和文件');
  assert.equal(requests[0].settings.sourceCount, 6);
  assert.equal(sent.context.attachments, undefined);

  const unsent = textAttachment('unsent', '新附件');
  service.update(chat.id, { attachments: [unsent] });
  service.shutdown();
  const reopened = make();
  const restored = reopened.get(chat.id);
  assert.deepEqual(restored.messages[0].attachments, [plain, pdf]);
  assert.deepEqual(restored.context.attachments, [unsent]);
  const projected = rendererChat(restored);
  assert.deepEqual(projected.context.attachments, [{ id: unsent.id, mimeType: unsent.mimeType, name: unsent.name, size: Buffer.byteLength('新附件') }]);
  assert.equal(projected.messages[0].attachments[0].base64, undefined);
  assert.deepEqual(projected.messages[0].images, [image()]);
  assert.deepEqual(rendererChat(projected), projected);
  const excerpt = await reopened.toInspiration(chat.id, { messageIds: [user.id] });
  assert.match(excerpt.notes, /仅记录文件名.*plain\.txt、资料\.pdf/u);
  assert.doesNotMatch(excerpt.notes, /新附件|unsent\.txt|原文件正文/u);
  assert.deepEqual(reopened.get(chat.id).messages[0].attachments, [plain, pdf]);
  reopened.delete(chat.id);
  assert.equal(fs.existsSync(path.join(root, 'chats', `${chat.id}.json`)), false);
});

test('file-only preprocessing failure is retryable and retains the original file and later draft', async t => {
  const original = textAttachment('original', '发送时的正文');
  const later = textAttachment('later', '尚未发送的正文');
  let passes = 0;
  let createdClients = 0;
  const { service } = fixture(t, {
    async prepareMessages(messages) {
      assert.deepEqual(messages[1].attachments, [original]);
      assert.match(messages[1].text, /请解读这些文件附件/u);
      if (++passes === 1) throw Object.assign(new Error('附件预处理失败，请重试。'), { code: 'CHAT_INVALID' });
      return messages;
    },
    createClient() {
      createdClients++;
      return { async chat(_messages, options) {
        assert.equal(options.userQuestion, '');
        assert.equal(options.sourceCount, 1);
        return { text: '准备完成' };
      } };
    },
  });
  const chat = service.create({ attachments: [original] });
  const failed = await service.send(chat.id);
  assert.equal(createdClients, 0);
  assert.equal(failed.messages[0].text, '');
  assert.deepEqual(failed.messages[0].attachments, [original]);
  assert.equal(failed.messages[1].status, 'error');
  assert.equal(failed.pending, false);
  assert.match(failed.error, /附件预处理失败/u);
  service.update(chat.id, { input: '后来写的内容', attachments: [later] });
  const retried = await service.retry(chat.id);
  assert.equal(createdClients, 1);
  assert.deepEqual(retried.messages.map(message => message.id), failed.messages.map(message => message.id));
  assert.equal(retried.messages[1].text, '准备完成');
  assert.equal(retried.input, '后来写的内容');
  assert.deepEqual(retried.context.attachments, [later]);
});

test('renderer attachment references are chat-scoped and late composer edits survive send authorization', async t => {
  const approval = deferred();
  const { service, requests } = fixture(t, { beforeSend: () => approval.promise });
  const original = textAttachment('existing', '原正文');
  const chat = service.create({ attachments: [original] });
  const another = service.create();
  assert.throws(() => service.update(another.id, { attachments: [{ id: original.id }] }), /重新添加/u);
  assert.equal(service.get(another.id).context.attachments, undefined);

  const pending = service.send(chat.id);
  const unchanged = textAttachment('new', '新文件');
  const drafted = service.update(chat.id, { attachments: [{ id: original.id }, unchanged] });
  assert.deepEqual(drafted.context.attachments, [original, unchanged]);
  const edited = textAttachment(original.id, '编辑后的文件');
  service.update(chat.id, { attachments: [edited, { id: unchanged.id }] });
  approval.resolve();
  const sent = await pending;
  assert.deepEqual(sent.messages[0].attachments, [original]);
  assert.deepEqual(sent.context.attachments, [edited, unchanged]);
  assert.deepEqual(requests[0].messages[1].attachments, [original]);
  assert.equal(service.update(chat.id, { attachments: [] }).context.attachments, undefined);
  assert.throws(() => service.update(chat.id, { attachments: [{ id: original.id }] }), /重新添加/u);
});

test('late preprocessing cannot start a model after cancellation, deletion or provider change', async t => {
  const configChanges = { configuration: { provider: 'openai' }, modelMode: { modelMode: 'manual' }, freePreference: { preferFreeModel: false } };
  for (const action of ['cancel', 'delete', ...Object.keys(configChanges)]) await t.test(action, async t => {
    const started = deferred();
    const finish = deferred();
    const original = textAttachment('pending', '待处理的文件');
    let signal;
    const { service, requests, setConfig } = fixture(t, {
      async prepareMessages(messages, options) {
        signal = options.signal;
        options.onStage({ id: 'reading-text' });
        started.resolve();
        await finish.promise;
        options.onStage({ id: 'request', model: 'deepseek-flash' });
        return messages;
      },
    });
    const chat = service.create({ attachments: [original] });
    const pending = service.send(chat.id);
    await started.promise;
    assert.deepEqual(service.get(chat.id).messages[0].attachments, [original]);
    if (configChanges[action]) setConfig(configChanges[action]);
    else {
      service[action](chat.id);
      assert.equal(signal.aborted, true);
    }
    finish.resolve();
    const result = await pending;
    assert.equal(requests.length, 0);
    if (action === 'delete') assert.equal(service.get(chat.id), null);
    else {
      const stopped = service.get(chat.id);
      assert.deepEqual(result, stopped);
      assert.equal(stopped.messages[1].status, 'stopped');
      assert.equal(stopped.pending, false);
      assert.deepEqual(stopped.messages[0].attachments, [original]);
      assert.equal(stopped.progress, undefined);
      assert.deepEqual(stopped.messages[1].progress.steps.map(step => step.id), ['reading-text']);
      assert.equal(stopped.messages[1].progress.finishedAt, stopped.messages[1].progress.steps[0].endedAt);
    }
  });
});

test('turn model and effort are validated before approval and survive a failed send, restart and retry', async t => {
  let approvals = 0;
  let calls = 0;
  const { service, make, requests, setConfig } = fixture(t, {
    beforeSend(config) { approvals++; assert.equal(Object.isFrozen(config), true); },
    async chat() {
      if (++calls === 1) throw Object.assign(new Error('mock quota'), { code: 'HTTP_QUOTA' });
      return { text: '重试回答' };
    },
  });
  const chat = service.create({ autoSave: true });
  service.update(chat.id, { input: '原始问题' });
  const before = service.get(chat.id);
  for (const options of [{ modelOverride: '../invalid' }, { modelOverride: 'unit-credential' }, { reasoningEffort: 'unknown' }]) {
    await assert.rejects(service.send(chat.id, options), { code: 'CHAT_INVALID' });
    assert.deepEqual(service.get(chat.id), before);
  }
  assert.equal(approvals, 0);
  assert.equal(calls, 0);
  const failed = await service.send(chat.id, { modelOverride: ' deepseek-v4-pro ', reasoningEffort: 'deep' });
  assert.equal(failed.messages[1].status, 'error');
  assert.equal(failed.messages[0].modelOverride, 'deepseek-v4-pro');
  assert.equal(failed.messages[0].modelOverrideProvider, 'deepseek');
  assert.equal(failed.messages[0].reasoningEffort, 'deep');
  service.shutdown();
  const reopened = make();
  setConfig({ provider: 'openai' });
  const beforeRetry = reopened.get(chat.id);
  await assert.rejects(reopened.retry(chat.id), /切回该服务或重新发送/u);
  assert.deepEqual(reopened.get(chat.id), beforeRetry);
  assert.equal(approvals, 1);
  assert.equal(calls, 1);
  setConfig({ provider: 'deepseek' });
  const retried = await reopened.retry(chat.id);
  assert.equal(retried.messages[1].text, '重试回答');
  assert.deepEqual(retried.messages.map(message => message.id), failed.messages.map(message => message.id));
  for (const { settings } of requests) {
    assert.equal(settings.modelOverride, 'deepseek-v4-pro');
    assert.equal(settings.reasoningEffort, 'deep');
    assert.equal(settings.userQuestion, '原始问题');
  }
});

test('explicit Auto survives restart and retries under a newly selected provider', async t => {
  let calls = 0;
  const { service, make, requests, setConfig } = fixture(t, {
    async chat() {
      if (++calls === 1) throw Object.assign(new Error('mock quota'), { code: 'HTTP_QUOTA' });
      return { text: '自动选择后的回答' };
    },
  });
  setConfig({ modelMode: 'manual', model: 'deepseek-v4-pro' });
  const chat = service.create({ autoSave: true });
  const failed = await service.send(chat.id, { text: '问题', modelOverride: null });
  assert.equal(failed.messages[0].modelOverride, null);
  assert.equal(failed.messages[0].modelOverrideProvider, undefined);
  service.shutdown();
  setConfig({ provider: 'openai', model: 'gpt-5.4' });
  const retried = await make().retry(chat.id);
  assert.equal(retried.messages[0].modelOverride, null);
  assert.equal(retried.messages[1].status, 'complete');
  assert.deepEqual(requests.map(request => request.settings.modelOverride), [null, null]);
});

test('progress reports bounded public stages with streaming text and persists only finished metadata', async t => {
  const started = deferred();
  const finish = deferred();
  const secret = 'unit-credential';
  let callbacks;
  const { service, root, make } = fixture(t, {
    async prepareMessages(messages, { onStage }) {
      onStage({ id: 'thought', label: '模型内部思考' });
      for (let index = 0; index < 25; index++) onStage({ id: index % 2 ? 'reading-text' : 'reading-pdf', label: secret });
      return messages;
    },
    async chat(_messages, options) {
      callbacks = options;
      options.onStage({ id: 'route', label: secret, model: secret });
      options.onStage({ id: 'request', label: '原始响应正文', model: 'deepseek-flash' });
      options.onStage({ id: 'request', label: '重复事件', model: 'deepseek-flash' });
      options.onDelta('已经开始回复');
      started.resolve();
      return finish.promise;
    },
  });
  const chat = service.create({ autoSave: true, attachments: [textAttachment('progress', '文件正文')] });
  const pending = service.send(chat.id, { text: '读附件' });
  await started.promise;
  const active = service.get(chat.id);
  const timeline = active.progress;
  assert.equal(active.pending, true);
  assert.equal(active.messages[1].text, '已经开始回复');
  assert.equal(timeline.assistantId, active.messages[1].id);
  assert.equal(timeline.steps.length, 24);
  assert.deepEqual(timeline.steps.slice(-3).map(step => step.id), ['route', 'request', 'respond']);
  assert.equal(timeline.steps.at(-3).model, undefined);
  assert.equal(timeline.steps.at(-2).model, 'deepseek-flash');
  assert.equal(timeline.steps.at(-1).endedAt, undefined);
  assert.equal(timeline.finishedAt, undefined);
  assert.doesNotMatch(JSON.stringify(active), /unit-credential|模型内部思考|原始响应正文/u);
  for (let index = 1; index < timeline.steps.length; index++) assert.equal(timeline.steps[index - 1].endedAt, timeline.steps[index].startedAt);
  const filename = path.join(root, 'chats', `${chat.id}.json`);
  assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).progress, undefined);
  finish.resolve({ text: '已经开始回复，已完成。' });
  const completed = await pending;
  assert.equal(completed.progress, undefined);
  assert.equal(completed.messages[1].progress.finishedAt, completed.messages[1].progress.steps.at(-1).endedAt);
  callbacks.onStage({ id: 'reading-text' });
  assert.deepEqual(service.get(chat.id), completed);
  service.shutdown();
  assert.deepEqual(make().get(chat.id).messages[1].progress, completed.messages[1].progress);
  assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /unit-credential|模型内部思考|原始响应正文/u);
});

test('prepared attachment caches are scoped to chats and clear on close, eviction and shutdown', async t => {
  const seen = [];
  const { service } = fixture(t, {
    async prepareMessages(messages, { cache }) {
      seen.push(cache);
      cache?.set('synthetic-conversion', 'temporary data');
      return messages;
    },
  });
  const first = service.create({ attachments: [textAttachment('cache', '缓存样例')] });
  await service.send(first.id);
  await service.send(first.id, { text: '追问' });
  assert.equal(seen[0], seen[1]);
  service.clearAttachmentCache(first.id);
  assert.equal(seen[0].size, 0);
  await service.send(first.id, { text: '关闭后重新打开' });
  assert.notEqual(seen[0], seen[2]);
  for (let index = 0; index < 8; index++) {
    const other = service.create({ attachments: [textAttachment('cache', '另一段聊天')] });
    await service.send(other.id);
  }
  assert.equal(seen[2].size, 0);
  assert.equal(new Set(seen.slice(2)).size, 9);
  service.shutdown();
  assert.ok(seen.every(cache => cache.size === 0));
});

test('shutdown aborts preparation and the bounded drain waits for its cleanup', async t => {
  const started = deferred();
  const cleanup = deferred();
  let cleaned = false;
  const { service, requests } = fixture(t, {
    async prepareMessages(messages, { signal }) {
      started.resolve(signal);
      try { return await cleanup.promise.then(() => messages); }
      finally { cleaned = true; }
    }
  });
  const chat = service.create({ attachments: [textAttachment('cleanup', '待清理附件')] });
  const send = service.send(chat.id);
  const signal = await started.promise;
  service.shutdown();
  assert.equal(signal.aborted, true);
  assert.equal(await service.drainAttachmentJobs(5), false);
  assert.equal(cleaned, false);
  cleanup.resolve();
  assert.equal(await service.drainAttachmentJobs(), true);
  assert.equal(cleaned, true);
  await send;
  assert.equal(requests.length, 0);
});

test('attachment drain does not wait for the model response after preparation', async t => {
  const started = deferred();
  const response = deferred();
  const { service } = fixture(t, {
    chat(_messages, { signal }) {
      started.resolve(signal);
      return response.promise;
    }
  });
  const chat = service.create({ attachments: [textAttachment('prepared', '已处理附件')] });
  const send = service.send(chat.id);
  const signal = await started.promise;
  service.shutdown();
  assert.equal(signal.aborted, true);
  assert.equal(await service.drainAttachmentJobs(5), true);
  response.resolve({ text: '迟到的模拟回复' });
  await send;
});

test('chat requests provide inline and display math formatting while preserving original formula data',async t=>{const {service,requests}=fixture(t),text='解释 \\(62.5\\% = \\frac{5}{8}\\)';const chat=service.create();const result=await service.send(chat.id,{text});const system=requests[0].messages[0].text;assert.ok(system.includes('行内用 \\('));assert.ok(system.includes('独立公式用 \\['));assert.equal(result.messages[0].text,text);assert.equal(requests[0].messages[1].text,text);});

test('temporary snapshot capacity rejects create and update before publishing or consuming draft materials',t=>{
  const {service,root,requests}=fixture(t,{maxSnapshotBytes:2048});let changes=0;service.on('change',()=>changes++);
  assert.throws(()=>service.create({candidate:'超限候选'.repeat(500)}),error=>error.code==='CHAT_TOO_LARGE');assert.equal(service.list().length,0);assert.equal(changes,0);
  const chat=service.create({candidate:'保留候选',quotes:[{id:'kept',text:'保留引用'}],images:[image()]});service.update(chat.id,{input:'保留输入'});const before=service.get(chat.id);changes=0;
  assert.throws(()=>service.update(chat.id,{input:'超限输入'.repeat(500)}),error=>error.code==='CHAT_TOO_LARGE');assert.deepEqual(service.get(chat.id),before);assert.equal(changes,0);assert.equal(requests.length,0);assert.deepEqual(fs.readdirSync(path.join(root,'chats')),[]);
});

test('temporary and saved send use the same capacity gate before clearing composer or creating a client',async t=>{
  const {service,root,requests}=fixture(t,{maxSnapshotBytes:2048}),chat=service.create({candidate:'保留候选',quotes:[{id:'kept',text:'保留引用'}],images:[image()]});service.update(chat.id,{input:'保留输入'});
  for(const saved of [false,true]){
    if(saved)service.save(chat.id);const before=service.get(chat.id),filename=path.join(root,'chats',chat.id+'.json'),disk=saved?fs.readFileSync(filename,'utf8'):null;
    await assert.rejects(()=>service.send(chat.id,{text:'超限提问'.repeat(500)}),error=>error.code==='CHAT_TOO_LARGE');assert.deepEqual(service.get(chat.id),before);assert.equal(requests.length,0);assert.equal(service.jobs.size,0);if(saved)assert.equal(fs.readFileSync(filename,'utf8'),disk);else assert.deepEqual(fs.readdirSync(path.join(root,'chats')),[]);
  }
});

test('formal welcome stays memory-only until first send durably commits the complete turn before inference',async t=>{
  let fixtureData;
  const f=fixture(t,{chat(_messages){const filename=path.join(fixtureData.root,'chats',fixtureData.id+'.json'),disk=JSON.parse(fs.readFileSync(filename,'utf8'));assert.equal(disk.saved,true);assert.equal(disk.autoSave,true);assert.equal(disk.messages[0].images.length,1);assert.equal(disk.messages[0].quotes[0].text,'引用');assert.equal(disk.pending,true);return{text:'正式回答'}}});
  const chat=f.service.create({autoSave:true,images:[image()],quotes:[{id:'quote',text:'引用'}]});fixtureData={root:f.root,id:chat.id};f.service.update(chat.id,{input:'正式提问'});assert.deepEqual(fs.readdirSync(path.join(f.root,'chats')),[]);assert.equal(f.service.get(chat.id).saved,false);
  const result=await f.service.send(chat.id);assert.equal(result.saved,true);assert.equal(result.autoSave,true);f.service.update(chat.id,{input:'自动保存的后续输入',candidate:'未采用的文字'});const reopened=f.make().get(chat.id);assert.equal(reopened.messages.at(-1).text,'正式回答');assert.equal(reopened.input,'自动保存的后续输入');assert.equal(reopened.candidate,'未采用的文字');assert.equal(reopened.context.audioDraftId,null);
});

test('formal first-send persistence failure keeps every draft field and makes no model request',async t=>{
  const {service,root,requests}=fixture(t),chat=service.create({autoSave:true,images:[image()],candidate:'保留候选',quotes:[{id:'quote',text:'保留引用'}]});service.update(chat.id,{input:'不能丢失的提问'});const before=service.get(chat.id);fs.mkdirSync(path.join(root,'chats',chat.id+'.json'));
  await assert.rejects(()=>service.send(chat.id),/不是普通文件/u);assert.deepEqual(service.get(chat.id),before);assert.equal(requests.length,0);assert.equal(service.get(chat.id).messages.length,0);assert.equal(service.get(chat.id).saved,false);
});

test('failed formal authorization leaves welcome unstarted and does not create a history file',async t=>{
  const {service,root,requests}=fixture(t,{beforeSend:()=>{throw new Error('需要授权')}}),chat=service.create({autoSave:true,quotes:[{id:'quote',text:'候选引用'}]});await assert.rejects(()=>service.send(chat.id,{text:''}),/需要授权/u);assert.equal(service.get(chat.id).messages.length,0);assert.equal(service.get(chat.id).context.quotes.length,1);assert.deepEqual(fs.readdirSync(path.join(root,'chats')),[]);assert.equal(requests.length,0);
});

test('quote attachments are cleaned independently, survive explicit save/restart and can be removed without editing input',t=>{
  const {service,make}=fixture(t),chat=service.create({quotes:[{id:'quote-one',text:'> 【 - First   quoted sentence. 】'},{id:'quote-two',text:'（第二段，保留标点。）'}],selectedText:'> （外部选中文字。）'});service.update(chat.id,{input:'原始输入 > (不清理)',candidate:'候选原样'});
  const before=service.get(chat.id);assert.equal(before.context.selectedText,'外部选中文字。');assert.deepEqual(before.context.quotes.map(q=>q.text),['First quoted sentence.','第二段，保留标点。']);service.update(chat.id,{quotes:[before.context.quotes[1]],selectedText:''});assert.equal(service.get(chat.id).input,'原始输入 > (不清理)');assert.equal(service.get(chat.id).candidate,'候选原样');service.save(chat.id);
  const reopened=make().get(chat.id);assert.deepEqual(reopened.context.quotes,[before.context.quotes[1]]);assert.equal(reopened.input,'原始输入 > (不清理)');assert.equal(reopened.context.selectedText,'');
});

test('quote-only send snapshots reference cards, supplies explanation intent, clears sent cards and preserves independent input',async t=>{
  const {service,requests,make}=fixture(t),chat=service.create({quotes:[{id:'quote',text:'> {需要解释的原文。}'}]});service.update(chat.id,{input:'还没决定发送的独立草稿'});const result=await service.send(chat.id,{text:''}),user=result.messages[0];
  assert.equal(user.text,'');assert.deepEqual(user.quotes,[{id:'quote',text:'需要解释的原文。'}]);assert.deepEqual(result.context.quotes,[]);assert.equal(result.input,'还没决定发送的独立草稿');assert.match(requests[0].messages[1].text,/请解释这些引用内容/u);assert.match(requests[0].messages[1].text,/<inmoment_reference_data>/u);assert.match(requests[0].messages[1].text,/需要解释的原文/u);assert.equal(requests[0].messages[1].text.includes(result.input),false);
  service.update(chat.id,{quotes:[{id:'new-quote',text:'后来的另一段'}]});service.save(chat.id);const saved=make().get(chat.id);assert.deepEqual(saved.messages[0].quotes,user.quotes);assert.equal(saved.context.quotes[0].text,'后来的另一段');const inspiration=await service.toInspiration(chat.id,{messageIds:[user.id]});assert.match(inspiration.notes,/引用对话：\n需要解释的原文。/u);assert.equal(inspiration.notes.includes('独立草稿'),false);assert.equal(inspiration.notes.includes('后来的另一段'),false);
});

test('quote limits and duplicate IDs reject atomically before mutating composer or references',t=>{
  const {service}=fixture(t),chat=service.create({quotes:[{id:'keep',text:'保留'}]});service.update(chat.id,{input:'保留输入'});const before=service.get(chat.id);
  const invalid=[null,[{id:'empty',text:'> 【】'}],[{id:'bad/id',text:'正文'}],[{id:'same',text:'一'},{id:'same',text:'二'}],[{id:'long',text:'界'.repeat(10001)}],Array.from({length:9},(_,i)=>({id:'q'+i,text:'文字'})),Array.from({length:5},(_,i)=>({id:'q'+i,text:'界'.repeat(10000)}))];
  for(const quotes of invalid){assert.throws(()=>service.update(chat.id,{quotes}));assert.deepEqual(service.get(chat.id),before);}
  const accepted=service.update(chat.id,{quotes:Array.from({length:4},(_,i)=>({id:'max'+i,text:'界'.repeat(10000)}))});assert.equal(accepted.context.quotes.length,4);assert.equal(accepted.context.quotes.reduce((n,q)=>n+q.text.length,0),40000);
});

test('quotes added or edited while authorization waits remain in the composer after the sent snapshot is consumed',async t=>{
  const approval=deferred(),{service}=fixture(t,{beforeSend:()=>approval.promise}),chat=service.create({quotes:[{id:'first',text:'先前选中的文字'}]}),task=service.send(chat.id,{text:''});await new Promise(resolve=>setImmediate(resolve));service.update(chat.id,{quotes:[{id:'first',text:'正在修改的引用'},{id:'later',text:'新添加的引用'}]});approval.resolve();const result=await task;
  assert.deepEqual(result.messages[0].quotes,[{id:'first',text:'先前选中的文字'}]);assert.deepEqual(result.context.quotes,[{id:'first',text:'正在修改的引用'},{id:'later',text:'新添加的引用'}]);
});

test('failed saved quote update preserves the previous snapshot and leaves no staging file',t=>{
  const {service,root}=fixture(t),chat=service.create({quotes:[{id:'old',text:'先前引用'}]});service.update(chat.id,{input:'保留问题'});service.save(chat.id);const before=service.get(chat.id),filename=path.join(root,'chats',chat.id+'.json'),stored=fs.readFileSync(filename,'utf8'),rename=fs.renameSync;
  t.mock.method(fs,'renameSync',(from,to)=>{if(to===filename)throw new Error('synthetic quote write failure');return rename(from,to)});assert.throws(()=>service.update(chat.id,{quotes:[{id:'new',text:'后来的引用'}]}),/quote write/u);t.mock.restoreAll();assert.deepEqual(service.get(chat.id),before);assert.equal(fs.readFileSync(filename,'utf8'),stored);assert.ok(fs.readdirSync(path.join(root,'chats')).every(name=>!name.endsWith('.part')));
});

test('legacy chat snapshots gain empty quote arrays without cleaning original messages or old selected text',t=>{
  const {root,make}=fixture(t);const selected='> （原始旧引用）',body='> 历史消息正文 (必须原样)';fs.writeFileSync(path.join(root,'chats','legacy-quotes.json'),JSON.stringify({schemaVersion:1,id:'legacy-quotes',saved:true,title:'旧聊天',messages:[{id:'user',role:'user',text:body,status:'complete',selectedText:selected}],context:{selectedText:selected}}));const restored=make().get('legacy-quotes');assert.deepEqual(restored.context.quotes,[]);assert.deepEqual(restored.messages[0].quotes,[]);assert.equal(restored.messages[0].text,body);assert.equal(restored.messages[0].selectedText,selected);assert.equal(restored.context.selectedText,selected);
});

test('summarizing selected messages includes their quote snapshots and excludes unsent or unselected content',async t=>{
  const {service,requests}=fixture(t),chat=service.create({quotes:[{id:'chosen',text:'被选对话的引用附件'}]});await service.send(chat.id,{text:'被选的第一条消息'});const selectedId=service.get(chat.id).messages[0].id;await service.send(chat.id,{text:'绝不发送给摘要的第二条消息'});service.update(chat.id,{input:'尚未发送的输入',quotes:[{id:'draft',text:'尚未发送的引用'}]});await service.toInspiration(chat.id,{messageIds:[selectedId],summarize:true});const prompt=requests.at(-1).messages[1].text;assert.match(prompt,/被选对话的引用附件/u);assert.match(prompt,/被选的第一条消息/u);for(const excluded of ['绝不发送给摘要的第二条消息','尚未发送的输入','尚未发送的引用'])assert.equal(prompt.includes(excluded),false);
});

test('temporary rename preserves composer/context and never saves or calls a model',t=>{
  const {service,root,requests}=fixture(t),chat=service.create({candidate:'候选语音',images:[image()],audioDraftId:'owned-draft'});service.update(chat.id,{input:'未发送的文字',recordIds:['chosen-record']});
  const before=service.get(chat.id),renamed=service.rename(chat.id,'  人工名称  ');assert.equal(renamed.title,'人工名称');assert.equal(renamed.titleManual,true);assert.equal(renamed.saved,false);assert.equal(renamed.input,before.input);assert.equal(renamed.candidate,before.candidate);assert.deepEqual(renamed.context,before.context);assert.deepEqual(renamed.recordIds,before.recordIds);assert.deepEqual(fs.readdirSync(path.join(root,'chats')),[]);assert.equal(requests.length,0);
});

test('saved manual title survives restart and first-send naming including the literal default title',async t=>{
  const {service,make}=fixture(t),chat=service.create();service.rename(chat.id,'新聊天');service.update(chat.id,{input:'保存的草稿'});service.save(chat.id);
  const reopened=make();assert.equal(reopened.get(chat.id).titleManual,true);assert.equal(reopened.get(chat.id).input,'保存的草稿');await reopened.send(chat.id,{text:'这是第一条真正的提问'});assert.equal(reopened.get(chat.id).title,'新聊天');assert.equal(reopened.get(chat.id).saved,true);
});

test('first multimodal reply supplies the title in the same request and streams only the answer', async t => {
  const heading = '【InMoment标题】', title = '数量关系例题解析';
  const { service, make, requests } = fixture(t, { chat(messages, { onDelta }) {
    if (messages.length > 2) return { text: '继续解答。' };
    const chunks = ['  【In', 'Moment标题】', title, '\r', '\n第一步', '是读懂题意。'];
    for (const chunk of chunks) onDelta(chunk);
    return { text: chunks.join('') };
  } });
  const chat = service.create({ autoSave: true, images: [image()] });
  const visible = [];
  service.on('change', event => visible.push(event.messages.at(-1)?.text || ''));
  const first = await service.send(chat.id, { text: '' });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].messages[0].text.includes(heading));
  assert.equal(requests[0].messages[1].images.length, 1);
  assert.equal(first.title, title);
  assert.equal(first.messages[1].text, '第一步是读懂题意。');
  assert.ok(visible.includes('第一步'));
  assert.ok(visible.every(text => !text.includes('【In') && !text.includes(title)));
  const second = await service.send(chat.id, { text: '下一题呢？' });
  assert.ok(!requests[1].messages[0].text.includes(heading));
  assert.equal(requests[1].messages[2].text, first.messages[1].text);
  assert.equal(second.title, title);
  assert.equal(make().get(chat.id).title, title);
});

test('retry of a failed first turn after reopening can still generate its title', async t => {
  let attempt = 0;
  const { service, make } = fixture(t, { chat(messages, { onDelta }) {
    assert.match(messages[0].text, /【InMoment标题】/u);
    if (++attempt === 1) {
      onDelta('【InMoment标题】未完成的名称\n');
      throw Object.assign(new Error(), { code: 'HTTP_TRANSIENT' });
    }
    return { text: '【InMoment标题】微积分复习\n这是一道求导题。' };
  } });
  const chat = service.create({ autoSave: true });
  const first = await service.send(chat.id, { text: '帮我看下这道求导题' });
  assert.equal(first.title, '帮我看下这道求导题');
  assert.equal(first.messages[1].text, '');
  const retry = await make().retry(chat.id);
  assert.equal(retry.title, '微积分复习');
  assert.equal(retry.messages[1].text, '这是一道求导题。');
});

test('missing, invalid and overlong title lines keep the fallback and leave the reply available', async t => {
  const heading = '【InMoment标题】';
  for (const [chunks, answer] of [
    [['只有正常回答。'], '只有正常回答。'],
    [[heading + '  \n正常回答。'], '正常回答。'],
    [[heading, '字'.repeat(160), '\n', '正常回答。'], '正常回答。'],
    [['【InMoment标', '\n正常回答。'], '正常回答。'],
    [[heading + '只有标题'], ''],
    [['【InMoment标'], ''],
    [['【'], '【'],
  ]) {
    const deltas = [];
    const { service } = fixture(t, { chat(_messages, { onDelta }) {
      for (const chunk of chunks) onDelta(chunk);
      return { text: chunks.join('') };
    } });
    const chat = service.create();
    service.on('change', changed => deltas.push(changed.messages.at(-1)?.text || ''));
    const result = await service.send(chat.id, { text: '第一条问题' });
    assert.equal(result.title, '第一条问题');
    assert.equal(result.messages[1].text, answer);
    assert.equal(result.messages[1].status, answer ? 'complete' : 'error');
    assert.ok(deltas.every(delta => answer.startsWith(delta)));
  }
});

test('rename during streaming keeps message identity and later deltas cannot replace the title',async t=>{
  const waiting=deferred();let options;const {service}=fixture(t,{chat(_messages,opts){options=opts;opts.onDelta('【InMoment标题】模型');return waiting.promise}}),chat=service.create(),pending=service.send(chat.id,{text:'第一次提问'});await new Promise(resolve=>setImmediate(resolve));
  const messageId=service.get(chat.id).messages.at(-1).id;service.rename(chat.id,'手动重命名');options.onDelta('名称\n继续');waiting.resolve({text:'【InMoment标题】模型名称\n完整回答'});await pending;
  const after=service.get(chat.id);assert.equal(after.title,'手动重命名');assert.equal(after.messages.at(-1).id,messageId);assert.equal(after.messages.at(-1).text,'完整回答');
});

test('rename validation and failed atomic persistence leave title, composer, events and disk unchanged',t=>{
  const {service,root}=fixture(t),chat=service.create();service.update(chat.id,{input:'草稿'});service.save(chat.id);const before=service.get(chat.id),filename=path.join(root,'chats',chat.id+'.json'),bytes=fs.readFileSync(filename,'utf8'),events=[];service.on('change',event=>events.push(event));
  for(const title of ['', '   ', 'a'.repeat(201),'多\n行','\n前缀','尾部\t',null])assert.throws(()=>service.rename(chat.id,title),/单行文字/u);
  const rename=fs.renameSync;t.mock.method(fs,'renameSync',(from,to)=>{if(to===filename)throw new Error('synthetic persistence failure');return rename(from,to)});assert.throws(()=>service.rename(chat.id,'不能落盘'),/persistence/u);t.mock.restoreAll();
  assert.deepEqual(service.get(chat.id),before);assert.equal(fs.readFileSync(filename,'utf8'),bytes);assert.equal(events.length,0);assert.ok(fs.readdirSync(path.join(root,'chats')).every(name=>!name.endsWith('.part')));assert.equal(service.rename(chat.id,'界'.repeat(200)).title.length,200);
});

test('deletion gate revokes queued authorization and stale edits before audio cleanup awaits',async t=>{
  const approval=deferred(),{service,requests}=fixture(t,{beforeSend:()=>approval.promise}),chat=service.create();service.update(chat.id,{input:'保留原稿'});const pending=service.send(chat.id);await new Promise(resolve=>setImmediate(resolve));service.beginDelete(chat.id);
  assert.equal(service.get(chat.id),null);assert.throws(()=>service.update(chat.id,{input:'迟到回写'}),/正在删除/u);assert.throws(()=>service.rename(chat.id,'迟到改名'),/正在删除/u);approval.resolve();await assert.rejects(pending,{name:'AbortError'});assert.equal(requests.length,0);
  service.abortDelete(chat.id);assert.equal(service.get(chat.id).input,'保留原稿');service.delete(chat.id);assert.equal(service.get(chat.id),null);
});

test('failed deletion restores the same stopped session and emits no deleted event',async t=>{
  const waiting=deferred();let options;const {service,root}=fixture(t,{chat(_messages,opts){options=opts;return waiting.promise}}),chat=service.create();service.save(chat.id);const task=service.send(chat.id,{text:'问题'});await new Promise(resolve=>setImmediate(resolve));const filename=path.join(root,'chats',chat.id+'.json'),deleted=[];service.on('deleted',event=>deleted.push(event));
  const unlink=fs.unlinkSync;t.mock.method(fs,'unlinkSync',file=>{if(file===filename)throw new Error('synthetic unlink failure');return unlink(file)});assert.throws(()=>service.delete(chat.id),/unlink/u);t.mock.restoreAll();assert.ok(service.get(chat.id));assert.equal(options.signal.aborted,true);assert.equal(service.get(chat.id).messages.at(-1).status,'stopped');assert.deepEqual(deleted,[]);waiting.resolve({text:'迟到回复'});await task;assert.equal(service.get(chat.id).messages.at(-1).text,'');
});

test('image-only send keeps the user turn image-only and supplies an explicit interpretation prompt to the client',async t=>{
  const {service,requests}=fixture(t),chat=service.create({images:[image()]});const answer=await service.send(chat.id,{text:''});assert.equal(answer.messages[0].text,'');assert.equal(answer.messages[0].images.length,1);assert.match(requests[0].messages[1].text,/请解读这些图片/u);assert.equal(requests[0].messages[1].images.length,1);
});

test('image-only authorization preserves an unstarted draft; a text-only override uses same-provider evidence', async t => {
  const blocked = fixture(t, { beforeSend() { throw new Error('需要授权'); } });
  const fresh = blocked.service.create({ images: [image()] });
  await assert.rejects(blocked.service.send(fresh.id, { text: '' }), /需要授权/u);
  assert.equal(blocked.service.get(fresh.id).messages.length, 0);
  assert.equal(blocked.service.get(fresh.id).context.images.length, 1);
  assert.equal(blocked.requests.length, 0);

  const bodies = [];
  const { createChatClient } = require('../src/core/chat-client.cjs');
  const manual = fixture(t, {
    createClient: () => createChatClient({
      provider: 'deepseek', apiKey: 'synthetic-only',
      async fetchImpl(_url, options) {
        bodies.push(JSON.parse(options.body));
        const content = bodies.length === 1 ? '附件中的合成证据' : '最终回答';
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      },
    }),
  });
  const chat = manual.service.create({ images: [image()] });
  const result = await manual.service.send(chat.id, { text: '', modelOverride: 'deepseek-v4-pro' });
  assert.deepEqual(bodies.map(body => body.model), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.match(JSON.stringify(bodies[0]), /image_url/u);
  assert.match(JSON.stringify(bodies[1]), /附件中的合成证据/u);
  assert.doesNotMatch(JSON.stringify(bodies[1]), /image_url/u);
  assert.equal(result.messages[1].text, '最终回答');
  assert.deepEqual(result.messages[1].progress.steps.map(step => [step.id, step.model]), [
    ['route', 'deepseek-v4-pro'], ['read-attachments', 'deepseek-flash'], ['request', 'deepseek-v4-pro'], ['respond', undefined],
  ]);
});

test('temporary streaming conversation stays in memory and its candidate is never sent implicitly', async t => {
  const { service, root, requests } = fixture(t); const events = [];
  service.on('change', chat => events.push(chat));
  const chat = service.create({ candidate: '尚未采用的语音', selectedText: '选中的术语', source: { processName: 'SyntheticReader', title: '测试窗口', url: 'https://example.com/lesson' }, images: [image()], audioDraftId: 'audio-draft-1' });
  service.update(chat.id, { input: '这句话是什么意思？' });
  const result = await service.send(chat.id);
  assert.equal(result.saved, false); assert.equal(result.pending, false); assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1].text, '测试回答'); assert.equal(result.messages[1].status, 'complete');
  assert.equal(result.candidate, ''); assert.equal(result.input, '');
  assert.deepEqual(fs.readdirSync(path.join(root, 'chats')), []);
  assert.equal(JSON.stringify(requests).includes('尚未采用的语音'), false);
  assert.match(requests[0].messages[1].text, /inmoment_reference_data.*\n/u);
  assert.match(requests[0].messages[1].text, /选中的术语/u); assert.equal(requests[0].messages[1].images.length, 1);
  assert.equal(requests[0].settings.approved, true); assert.equal(events.some(item => item.messages?.[1]?.text === '测试'), true);
});

test('explicit save survives restart with pending transcription text and without audio references', async t => {
  const { service, root, make } = fixture(t);
  const chat = service.create({ candidate: '未采用录音', audioDraftId: 'temporary-audio', images: [image()] });
  await service.send(chat.id, { text: '解释图片' }); service.update(chat.id, { input: '后续草稿', candidate: '另一段语音' });
  service.save(chat.id);
  const bytes = fs.readFileSync(path.join(root, 'chats', chat.id + '.json'), 'utf8');
  assert.equal(bytes.includes('temporary-audio'), false); assert.equal(bytes.includes('另一段语音'), true); assert.equal(bytes.includes('unit-credential'), false);
  service.shutdown();
  const reopened = make(); const restored = reopened.get(chat.id);
  assert.equal(restored.messages.length, 2); assert.equal(restored.messages[0].images[0].base64, image().base64);
  assert.equal(restored.saved, true); assert.equal(restored.context.audioDraftId, null); assert.equal(restored.input, '后续草稿'); assert.equal(restored.candidate, '另一段语音');
});

test('retry reuses a failed user turn and preserves its original attachment snapshot', async t => {
  let calls = 0;
  const { service, requests } = fixture(t, { async chat(_messages, settings) { if (!calls++) throw Object.assign(new Error('quota'), { code: 'HTTP_QUOTA' }); settings.onDelta?.('已恢复'); return { text: '已恢复' }; } });
  const chat = service.create({ images: [image()] });
  const failed = await service.send(chat.id, { text: '这是什么？' }); const ids = failed.messages.map(item => item.id);
  assert.equal(failed.messages[1].status, 'error'); assert.match(failed.error, /额度/u);
  service.update(chat.id, { input: '正在编辑的新问题', images: [] });
  const result = await service.retry(chat.id);
  assert.deepEqual(result.messages.map(item => item.id), ids); assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1].status, 'complete'); assert.equal(result.input, '正在编辑的新问题');
  assert.equal(requests[1].messages[1].images[0].base64, image().base64);
});

test('stop invalidates delayed deltas and a late completion cannot alter the stopped reply', async t => {
  const waiting = deferred(); let options;
  const { service } = fixture(t, { chat(_messages, settings) { options = settings; settings.onDelta('已有部分'); return waiting.promise; } });
  const chat = service.create(); const pending = service.send(chat.id, { text: '慢速请求' }); await new Promise(resolve => setImmediate(resolve));
  service.cancel(chat.id); options.onDelta('迟到文字'); waiting.resolve({ text: '迟到完整结果' }); await pending;
  const result = service.get(chat.id); assert.equal(options.signal.aborted, true); assert.equal(result.pending, false);
  assert.equal(result.messages[1].text, '已有部分'); assert.equal(result.messages[1].status, 'stopped');
});

test('deleting a saved pending chat removes disk state before late provider results arrive', async t => {
  const waiting = deferred(); let options;
  const { service, root, make } = fixture(t, { chat(_messages, settings) { options = settings; return waiting.promise; } });
  const chat = service.create({ audioDraftId: 'draft-to-clean' }); service.save(chat.id);
  const task = service.send(chat.id, { text: '将被删除' }); await new Promise(resolve => setImmediate(resolve));
  const deleted = service.delete(chat.id); assert.equal(deleted.audioDraftId, 'draft-to-clean');
  assert.equal(fs.existsSync(path.join(root, 'chats', chat.id + '.json')), false); assert.equal(options.signal.aborted, true);
  options.onDelta('迟到'); waiting.resolve({ text: '迟到回答' }); await task;
  assert.equal(service.list().length, 0); assert.equal(make().list().length, 0); assert.equal(service.get(chat.id), null);
});

test('saving during streaming keeps the completed result and subsequent typed draft', async t => {
  const waiting = deferred(); let options;
  const { service, make } = fixture(t, { chat(_messages, settings) { options = settings; settings.onDelta('前半段'); return waiting.promise; } });
  const chat = service.create(); const task = service.send(chat.id, { text: '继续回复' }); await new Promise(resolve => setImmediate(resolve));
  service.save(chat.id); service.update(chat.id, { input: '下一轮输入' });
  options.onDelta('后半段'); waiting.resolve({ text: '前半段后半段' }); await task;
  const restored = make().get(chat.id); assert.equal(restored.messages[1].text, '前半段后半段'); assert.equal(restored.messages[1].status, 'complete'); assert.equal(restored.input, '下一轮输入');
});

test('shutdown retains saved interrupted history, erases temporary sessions and blocks late callbacks', async t => {
  const waiting = deferred(); let options;
  const { service, root, make } = fixture(t, { chat(_messages, settings) { options = settings; return waiting.promise; } });
  const saved = service.create(); service.save(saved.id); service.create({ candidate: '仅临时存在' });
  const task = service.send(saved.id, { text: '可恢复的提问' }); await new Promise(resolve => setImmediate(resolve));
  service.shutdown(); options.onDelta('退出后结果'); waiting.resolve({ text: '不应写入' }); await task;
  const reopened = make(); assert.equal(reopened.list().length, 1); assert.equal(reopened.get(saved.id).messages[1].status, 'stopped');
  assert.equal(reopened.get(saved.id).messages[1].text, ''); assert.equal(fs.readdirSync(path.join(root, 'chats')).filter(name => name.endsWith('.json')).length, 1);
});

test('inspiration references snapshot actual saved content and survive deletion of the source', async t => {
  const { store, service, requests, make } = fixture(t);
  const draft = store.createDraft({ title: '原始灵感', notes: '实际保存的原文' }); const record = store.complete(draft.id);
  const chat = service.create(); service.update(chat.id, { recordIds: [record.id] });
  await service.send(chat.id, { text: '继续发展这个想法' }); service.save(chat.id); store.deleteRecord(record.id);
  await service.send(chat.id, { text: '再解释一下' });
  assert.match(requests[1].messages[1].text, /实际保存的原文/u);
  assert.equal(make().get(chat.id).messages[0].references[0].text, '实际保存的原文');
  service.update(chat.id, { input: '保留输入', recordIds: [record.id] });
  await assert.rejects(service.send(chat.id), /引用的笔记已被删除/u); assert.equal(service.get(chat.id).input, '保留输入');
});

test('chat references use the exact edited original and never restore cleared legacy notes', async t => {
  const { store, service, requests } = fixture(t);
  const draft = store.createDraft({ title: '原始灵感', notes: '旧笔记不再引用' });
  store.complete(draft.id);
  const edited = '新的原文\n\n保留第二段';
  store.updateRecord(draft.id, { transcript: edited });
  const chat = service.create(); service.update(chat.id, { recordIds: [draft.id] });
  await service.send(chat.id, { text: '引用修改后的内容' });
  assert.equal(service.get(chat.id).messages[0].references[0].text, edited);
  assert.equal(JSON.stringify(requests).includes('旧笔记不再引用'), false);
  store.updateRecord(draft.id, { transcript: '' });
  const blankChat = service.create(); service.update(blankChat.id, { recordIds: [draft.id] });
  await assert.rejects(service.send(blankChat.id, { text: '引用已清空的原文' }), /没有可发送的文字/u);
  assert.equal(requests.length, 1);
});

test('chat searches written and recorded notes and restores both kinds of sent reference', async t => {
  const { store, requests, make } = fixture(t);
  const notes = new NotesStore(store);
  const written = notes.create(undefined, { title: '数量关系', body: '普通笔记的比例题' });
  const draft = store.createDraft({ title: '录音笔记', notes: '比例题录音正文' });
  const recorded = store.complete(draft.id);
  const recordId = 'record:' + recorded.id;
  assert.deepEqual(notes.list('比例题').notes.map(note => note.id).sort(), [written.id, recordId].sort());
  assert.deepEqual(notes.list('数量').notes.map(note => note.id), [written.id]);

  const service = make({ notes });
  const chat = service.create({ autoSave: true });
  const selected = service.update(chat.id, { recordIds: [written.id, recordId] });
  assert.equal(requests.length, 0);
  assert.deepEqual(rendererChat(selected, id => service.referenceTitle(id)).references, [
    { recordId: written.id, title: written.title }, { recordId, title: recorded.title },
  ]);
  notes.update(written.id, written.title, '刚保存的比例题答案');
  const result = await service.send(chat.id, { text: '比较这两篇笔记' });
  const references = result.messages[0].references;
  assert.deepEqual(references.map(({ noteId, text }) => [noteId, text]), [
    [written.id, '刚保存的比例题答案'], [recordId, '比例题录音正文'],
  ]);
  assert.match(requests[0].messages[1].text, /刚保存的比例题答案/u);
  notes.delete(written.id);
  assert.deepEqual(make({ notes }).get(chat.id).messages[0].references, references);
});

test('written note reference sends inline image bytes in body order and retries the sent snapshot after source deletion', async t => {
  const { store, requests, make } = fixture(t, {
    async chat() {
      if (requests.length === 1) throw Object.assign(new Error('synthetic quota'), { code: 'HTTP_QUOTA' });
      return { text: '合成回答' };
    },
  });
  const notes = new NotesStore(store);
  const body = '例题：求下一项。\n解析：比较相邻项的比值。';
  const written = notes.create(undefined, { title: '数量关系', body });
  const example = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
  const explanation = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGPgEVXhEVVhgFAABzoBFTFqH3MAAAAASUVORK5CYII=', 'base64');
  const { attachments: [explanationAsset, exampleAsset] } = await notes.attachBytes(written.id, [
    { name: '解析.png', bytes: explanation },
    { name: '例题.png', bytes: example },
    { name: '资料.pdf', bytes: Buffer.from('%PDF-1.7\n%%EOF') },
  ]);
  notes.update(written.id, written.title, body, { version: 1, nodes: [
    { tag: 'p', children: ['例题：求下一项。', { attachmentId: exampleAsset.id }] },
    { tag: 'p', children: [{ tag: 'strong', children: ['解析：比较相邻项的比值。'] }, { attachmentId: explanationAsset.id }] },
  ] });

  const service = make({ notes });
  const direct = { id: 'composer-picture', mimeType: 'image/png', base64: example.toString('base64') };
  const chat = service.create({ autoSave: true, images: [direct] });
  service.update(chat.id, { recordIds: [written.id] });
  assert.equal(requests.length, 0);
  const failed = await service.send(chat.id, { text: '对照例题和解析说明解题步骤。' });
  assert.equal(failed.messages[1].status, 'error');
  const turn = requests[0].messages[1];
  assert.deepEqual(turn.images.map(({ mimeType, base64 }) => [mimeType, base64]), [
    [direct.mimeType, direct.base64],
    ['image/png', example.toString('base64')],
    ['image/png', explanation.toString('base64')],
  ]);
  assert.match(turn.text, /^对照例题和解析说明解题步骤。/u);
  const data = JSON.parse(turn.text.split('<inmoment_reference_data>\n')[1].split('\n</inmoment_reference_data>')[0]);
  assert.equal(data.inspirations[0].text, body);
  assert.deepEqual(data.inspirations[0].images, [{ index: 2, name: '例题.png' }, { index: 3, name: '解析.png' }]);
  assert.ok(!turn.text.includes(example.toString('base64')) && !turn.text.includes(explanation.toString('base64')));
  assert.equal(turn.attachments, undefined);

  const snapshot = failed.messages[0].references;
  assert.deepEqual(snapshot[0].images.map(({ id, name, mimeType, base64 }) => [id, name, mimeType, base64]), [
    [exampleAsset.id, '例题.png', 'image/png', example.toString('base64')],
    [explanationAsset.id, '解析.png', 'image/png', explanation.toString('base64')],
  ]);
  const projected = rendererChat(failed);
  assert.equal(projected.messages[0].references[0].imageCount, 2);
  assert.equal(projected.messages[0].references[0].images, undefined);

  notes.update(written.id, '已编辑的题目', '发送之后才修改的正文。');
  notes.delete(written.id);
  service.shutdown();
  const reopened = make({ notes });
  assert.deepEqual(reopened.get(chat.id).messages[0].references, snapshot);
  const retried = await reopened.retry(chat.id);
  assert.equal(retried.messages[1].status, 'complete');
  assert.deepEqual(retried.messages.map(message => message.id), failed.messages.map(message => message.id));
  assert.deepEqual(requests[1].messages[1], turn);

  await reopened.send(chat.id, { text: '接着解释。' });
  assert.deepEqual(requests[2].messages[1], turn);
  assert.deepEqual(requests[2].messages.at(-1), { role: 'user', text: '接着解释。' });
});

test('reference image count overflow preserves the draft and sends nothing', async t => {
  const { store, requests, make } = fixture(t);
  const notes = new NotesStore(store);
  const written = notes.create(undefined, { title: '图片笔记', body: '待解释的例题' });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
  await notes.attachBytes(written.id, Array.from({ length: 21 }, (_, i) => ({ name: `例题-${i + 1}.png`, bytes })));
  const service = make({ notes });
  const chat = service.create();
  const draft = service.update(chat.id, { input: '请解题', recordIds: [written.id] });
  await assert.rejects(service.send(chat.id), /图片数量上限/u);
  assert.deepEqual(service.get(chat.id), draft);
  assert.equal(requests.length, 0);
});

test('saving selected messages as inspiration includes only selected text and still-image attachments', async t => {
  const { service, store } = fixture(t); const chat = service.create({ images: [image()] });
  await service.send(chat.id, { text: '第一条问题' }); await service.send(chat.id, { text: '第二条不保存' });
  const current = service.get(chat.id); const record = await service.toInspiration(chat.id, { messageIds: [current.messages[0].id] });
  assert.equal(record.status, 'saved'); assert.match(record.notes, /第一条问题/u); assert.equal(record.notes.includes('第二条不保存'), false);
  assert.equal(record.notes.includes('测试回答'), false); assert.equal(record.segments.length, 0); assert.equal(record.screenshots.length, 1);
  assert.equal(store.listRecords().length, 1); assert.equal(service.get(chat.id).saved, false);
});

test('summarize-and-save waits for the model and cancellation cannot create a record', async t => {
  const summary = deferred(); let calls = 0, summaryOptions;
  const { service, store } = fixture(t, { chat(_messages, options) { if (!calls++) return { text: '正常回答' }; summaryOptions = options; return summary.promise; } });
  const chat = service.create(); await service.send(chat.id, { text: '用户问题' });
  const task = service.toInspiration(chat.id, { summarize: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.listRecords().length, 0); service.delete(chat.id); summary.resolve({ text: '整理好的内容' });
  await assert.rejects(task, { name: 'AbortError' }); assert.equal(summaryOptions.signal.aborted, true); assert.equal(store.listRecords().length, 0);
});

test('denied send preserves composer and does not append messages or instantiate a client', async t => {
  const { service, requests } = fixture(t, { beforeSend() { throw new Error('请先启用云端 AI。'); } });
  const chat = service.create({ selectedText: '待询问的原句' }); service.update(chat.id, { input: '我的问题' });
  await assert.rejects(service.send(chat.id), /启用云端/u);
  const result = service.get(chat.id); assert.equal(result.messages.length, 0); assert.equal(result.input, '我的问题'); assert.equal(result.context.selectedText, '待询问的原句'); assert.equal(requests.length, 0);
});

test('parallel send authorization cannot append duplicate turns', async t => {
  const gate = deferred(); const waiting = deferred();
  const { service, requests } = fixture(t, { beforeSend: () => gate.promise, chat: () => waiting.promise });
  const chat = service.create(); const first = service.send(chat.id, { text: '一次发送' }); const second = service.send(chat.id, { text: '重复点击' });
  gate.resolve(); const secondResult = assert.rejects(second, { name: 'AbortError' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1); waiting.resolve({ text: '完成' }); await first; await secondResult; assert.equal(service.get(chat.id).messages.length, 2);
});

test('provider or credential change cancels applying the previous provider result', async t => {
  const waiting = deferred(); const { service, setConfig } = fixture(t, { chat: () => waiting.promise });
  const chat = service.create(); const task = service.send(chat.id, { text: '保持厂家' }); await new Promise(resolve => setImmediate(resolve));
  setConfig({ provider: 'gemini' }); waiting.resolve({ text: '旧厂家回复' }); await task;
  const result = service.get(chat.id); assert.equal(result.messages[1].status, 'stopped'); assert.equal(result.messages[1].text, '');
});

test('unsafe image, overlong composer and unknown inspiration selection fail without data mutation', async t => {
  const { service, store } = fixture(t); const chat = service.create({ candidate: '候选文字' });
  assert.throws(() => service.update(chat.id, { input: 'x'.repeat(100001) }), /过长/u);
  assert.throws(() => service.update(chat.id, { images: [{ mimeType: 'image/svg+xml', base64: 'YWJjZA==' }] }), /图片格式/u);
  assert.equal(service.get(chat.id).candidate, '候选文字'); assert.equal(service.get(chat.id).input, '');
  await service.send(chat.id, { text: '有效内容' });
  await assert.rejects(service.toInspiration(chat.id, { messageIds: ['unknown-message'] }), /所选对话/u); assert.equal(store.listRecords().length, 0);
  assert.equal(service.get('../outside'), null);
});

test('provider error body and credential material are not exposed through snapshots', async t => {
  const { service } = fixture(t, { chat() { throw new Error('network body Authorization: Bearer unit-credential private diagnostics'); } });
  const chat = service.create(); const result = await service.send(chat.id, { text: '失败测试' });
  assert.equal(result.messages[1].status, 'error'); assert.equal(JSON.stringify(result).includes('unit-credential'), false); assert.equal(JSON.stringify(result).includes('private diagnostics'), false);
});

test('unreadable saved history is reported and incomplete history never resumes a request', t => {
  const { root, make, requests } = fixture(t);
  fs.writeFileSync(path.join(root, 'chats', 'broken.json'), '{');
  fs.writeFileSync(path.join(root, 'chats', 'interrupted.json'), JSON.stringify({ schemaVersion: 1, id: 'interrupted', saved: true, title: '被中断', pending: true, messages: [{ id: 'old-user', role: 'user', text: '问题', status: 'complete' }, { id: 'old-answer', role: 'assistant', text: '半句', status: 'streaming' }], context: {} }));
  const reopened = make(); assert.equal(reopened.loadErrors.length, 1); assert.equal(reopened.get('interrupted').messages[1].status, 'stopped'); assert.equal(reopened.get('interrupted').pending, false); assert.equal(requests.length, 0);
});

test('failed explicit save preserves the composer and does not mark a temporary session saved', t => {
  const { root, service } = fixture(t); const chat = service.create({ candidate: '未采用的录音' });
  service.update(chat.id, { input: '还在编辑的问题' });
  fs.mkdirSync(path.join(root, 'chats', chat.id + '.json'));
  assert.throws(() => service.save(chat.id), /不是普通文件/u);
  const current = service.get(chat.id); assert.equal(current.saved, false); assert.equal(current.input, '还在编辑的问题'); assert.equal(current.candidate, '未采用的录音');
});

test('failed composer persistence leaves the last saved state and current input intact', async t => {
  const { root, service } = fixture(t); const chat = service.create(); service.update(chat.id, { input: '原始草稿' }); service.save(chat.id);
  const filename = path.join(root, 'chats', chat.id + '.json'); fs.unlinkSync(filename); fs.mkdirSync(filename);
  assert.throws(() => service.update(chat.id, { input: '不可保存的改动' }), /不是普通文件/u);
  assert.equal(service.get(chat.id).input, '原始草稿');
  fs.rmdirSync(filename); service.save(chat.id);
});

test('an image-only question can be saved as inspiration without losing its image', async t => {
  const { service } = fixture(t); const chat = service.create({ images: [image()] });
  await service.send(chat.id); const current = service.get(chat.id);
  const saved = await service.toInspiration(chat.id, { messageIds: [current.messages[0].id] });
  assert.equal(saved.screenshots.length, 1); assert.match(saved.notes, /图片附件/u);
});

test('summary errors do not expose a provider error body or credentials', async t => {
  let calls = 0; const { service } = fixture(t, { chat() { if (!calls++) return { text: '初始回答' }; throw new Error('raw body unit-credential'); } });
  const chat = service.create(); await service.send(chat.id, { text: '总结内容' });
  await assert.rejects(service.toInspiration(chat.id, { summarize: true }), error => !error.message.includes('unit-credential') && !error.message.includes('raw body'));
});
