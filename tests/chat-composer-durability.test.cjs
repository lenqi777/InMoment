'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ChatView } = require('../src/shared/chat-view.js');
const { ChatService } = require('../src/main/chat-service.cjs');

// Exercise the actual editor synchronization methods with the actual service.
// Rendering is inert because these assertions concern input ownership, not layout.
function fixture(t, { allowSend = false } = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, '.tmp-composer-sync-'));
  const modelCalls = [];
  const config = { rootDir: root, store: {}, getConfig: () => ({ provider: 'deepseek', key: 'inert-fixture' }), createClient: () => ({ async chat(messages) { assert.equal(allowSend, true, 'Only tests with explicit injected-chat intent may send.'); modelCalls.push(messages); return { text: '本地模拟回复', provider: 'deepseek', model: 'mock-only' }; } }) };
  const service = new ChatService(config), chat = service.create({ candidate: '第一段转写' });
  const view = Object.assign(Object.create(ChatView.prototype), { chat, currentId: chat.id, input: { value: '', focus() {} }, editRevision: 0, syncedRevision: 0, writeQueue: Promise.resolve(), dismissed: false, busy: false, voiceStatus: '', request: 0, selected: new Set(), render() {}, renderHistory() {}, togglePanel() {}, closeImage() {}, updateSend() {}, updateGhost() {}, resizeInput() {}, queueComposer() {} });
  const calls = []; let intercept = null;
  view.invoke = async (method, params) => {
    if (method === 'chat:get') return service.get(params.id);
    if (method === 'chat:list') return service.list();
    if (method === 'chat:send') return service.send(params.id, { text: params.text, recordIds: params.recordIds });
    assert.equal(method, 'chat:update'); calls.push({ ...params });
    if (intercept) return intercept(params);
    return service.update(params.id, { input: params.input });
  };
  service.on('change', chat => view.handleEvent({ type: 'chatChanged', chat }));
  t.after(async () => { clearTimeout(view.composerTimer); await service.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, config, service, view, chat, calls, modelCalls, intercept(fn) { intercept = fn; } };
}
function edit(view, text) { view.input.value = text; view.editRevision++; }

test('pending local text survives candidate and attachment service events before acknowledgement', async t => {
  const { view, service, chat } = fixture(t);
  edit(view, chat.candidate);
  service.update(chat.id, { candidate: '第二段转写' });
  service.update(chat.id, { selectedText: '新引用的文字' });
  assert.equal(view.input.value, '第一段转写');
  assert.equal(view.chat.candidate, '第二段转写');
  assert.equal(view.chat.context.selectedText, '新引用的文字');
  assert.equal(service.get(chat.id).input, '');
  await view.flush();
  assert.equal(service.get(chat.id).input, '第一段转写');
  assert.equal(view.input.value, '第一段转写');
});

test('an earlier flush acknowledgement cannot replace newer local text or a later queued write', async t => {
  const h = fixture(t); let release, entered; const began = new Promise(resolve => { entered = resolve; });
  h.intercept(params => {
    const snapshot = h.service.update(params.id, { input: params.input });
    if (h.calls.length === 1) { entered(); return new Promise(resolve => { release = () => resolve(snapshot); }); }
    return snapshot;
  });
  edit(h.view, '已经采用的转写'); const first = h.view.flush(); await began;
  edit(h.view, '已经采用的转写，加上手动修改'); const second = h.view.flush();
  h.service.update(h.chat.id, { candidate: '新的语音候选' });
  release(); await Promise.all([first, second]);
  assert.equal(h.view.input.value, '已经采用的转写，加上手动修改');
  assert.equal(h.service.get(h.chat.id).input, h.view.input.value);
  assert.equal(h.service.get(h.chat.id).candidate, '新的语音候选');
  assert.equal(h.view.syncedRevision, h.view.editRevision);
});

test('failed editor persistence retains local text and can retry without candidate echoes erasing it', async t => {
  const h = fixture(t); let failed = false;
  h.intercept(params => { if (!failed) { failed = true; throw new Error('合成写入失败'); } return h.service.update(params.id, { input: params.input }); });
  edit(h.view, '应当保留的真实输入');
  await assert.rejects(h.view.flush(), /合成写入失败/u);
  h.service.update(h.chat.id, { candidate: '之后到达的转写' });
  assert.equal(h.view.input.value, '应当保留的真实输入');
  assert.ok(h.view.editRevision > h.view.syncedRevision);
  await h.view.flush();
  assert.equal(h.service.get(h.chat.id).input, '应当保留的真实输入');
});

test('acknowledged real input survives subsequent recording candidates and saved-history reload', async t => {
  const h = fixture(t);
  edit(h.view, '已经采用并修改的文字'); await h.view.flush();
  h.service.update(h.chat.id, { candidate: '下一段录音转写' });
  assert.equal(h.view.input.value, '已经采用并修改的文字');
  h.service.save(h.chat.id);
  const restored = new ChatService(h.config);
  try {
    assert.equal(restored.get(h.chat.id).input, '已经采用并修改的文字');
    assert.equal(restored.get(h.chat.id).candidate, '下一段录音转写');
  } finally { await restored.shutdown(); }
});

test('typing while send waits for editor flush remains an unsent draft and sends only clicked text', async t => {
  const h = fixture(t, { allowSend: true }); let release, entered; const began = new Promise(resolve => { entered = resolve; });
  h.intercept(params => {
    const snapshot = h.service.update(params.id, { input: params.input });
    if (h.calls.length === 1) { entered(); return new Promise(resolve => { release = () => resolve(snapshot); }); }
    return snapshot;
  });
  edit(h.view, '点击发送时的文字'); const sending = h.view.send(); await began;
  edit(h.view, '发送期间写下的新草稿');
  release(); await sending;
  assert.equal(h.modelCalls.length, 1);
  assert.equal(h.service.get(h.chat.id).messages[0].text, '点击发送时的文字');
  assert.equal(h.view.input.value, '发送期间写下的新草稿');
  await h.view.flush();
  assert.equal(h.service.get(h.chat.id).input, '发送期间写下的新草稿');
});

test('an explicit old send snapshot does not clear a newer composer already stored by another view', async t => {
  const h = fixture(t, { allowSend: true });
  h.service.update(h.chat.id, { input: '另一窗口刚写入的新草稿' });
  const result = await h.service.send(h.chat.id, { text: '先前点击发送的文字' });
  assert.equal(result.messages[0].text, '先前点击发送的文字');
  assert.equal(result.input, '另一窗口刚写入的新草稿');
  assert.equal(h.service.get(h.chat.id).input, '另一窗口刚写入的新草稿');
});

test('a delayed older chat snapshot cannot roll back acknowledged input from a newer service event', async t => {
  const h = fixture(t);
  edit(h.view, '先前采用的文字'); await h.view.flush();
  const older = h.service.get(h.chat.id);
  await new Promise(resolve => setTimeout(resolve, 3));
  h.service.update(h.chat.id, { input: '随后保存的更新文字', candidate: '更新的候选' });
  h.view.setChat(older);
  assert.equal(h.view.input.value, '随后保存的更新文字');
  assert.equal(h.view.chat.candidate, '更新的候选');
});

test('opening another session accepts its lower revision without applying the prior session high watermark', async t => {
  const h = fixture(t);
  for (let index = 0; index < 8; index++) h.service.update(h.chat.id, { input: '较旧会话的修改 ' + index });
  const fresh = h.service.create(); h.service.update(fresh.id, { input: '新会话已有的输入' });
  assert.ok(h.service.get(h.chat.id).revision > h.service.get(fresh.id).revision);
  await h.view.open(fresh.id);
  assert.equal(h.view.currentId, fresh.id);
  assert.equal(h.view.chat.id, fresh.id);
  assert.equal(h.view.input.value, '新会话已有的输入');
});

test('emitted chat snapshots have increasing revisions across edits, streaming and cancellation', async t => {
  const h = fixture(t, { allowSend: true }); const revisions = [h.chat.revision];
  h.service.on('change', chat => { if (!chat.deleted) revisions.push(chat.revision); });
  h.service.update(h.chat.id, { input: '新的输入' });
  h.service.cancel(h.chat.id);
  h.service.save(h.chat.id);
  let options, complete, entered; const began = new Promise(resolve => { entered = resolve; });
  h.service.createClient = () => ({ chat(_messages, opts) { options = opts; opts.onDelta('已显示的一部分'); entered(); return new Promise(resolve => { complete = resolve; }); } });
  const sending = h.service.send(h.chat.id, { text: '新的输入' }); await began;
  const streamingRevision = h.service.get(h.chat.id).revision;
  h.service.cancel(h.chat.id);
  const stoppedRevision = h.service.get(h.chat.id).revision;
  assert.ok(stoppedRevision > streamingRevision);
  options.onDelta('已经取消的过期文字'); complete({ text: '已经取消的过期结果' }); await sending;
  assert.equal(h.service.get(h.chat.id).revision, stoppedRevision);
  assert.equal(revisions.every((revision, index) => Number.isSafeInteger(revision) && (index === 0 || revision > revisions[index - 1])), true);
  const restored = new ChatService(h.config);
  try { assert.equal(restored.get(h.chat.id).revision, stoppedRevision); }
  finally { await restored.shutdown(); }
});

test('failed persisted composer update exposes neither a newer revision nor changed text', t => {
  const h = fixture(t); h.service.update(h.chat.id, { input: '原来已保存的输入' }); h.service.save(h.chat.id);
  const original = h.service.get(h.chat.id), filename = path.join(h.root, 'chats', h.chat.id + '.json'), saved = fs.readFileSync(filename, 'utf8');
  let events = 0; h.service.on('change', () => { events++; });
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (source, target) => { if (target === filename) throw Object.assign(new Error('合成磁盘写入失败'), { code: 'EACCES' }); return rename(source, target); });
  try {
    assert.throws(() => h.service.update(h.chat.id, { input: '不应声称已保存的输入' }), /合成磁盘写入失败/u);
    assert.equal(h.service.get(h.chat.id).revision, original.revision);
    assert.equal(h.service.get(h.chat.id).input, original.input);
    assert.equal(events, 0);
    assert.equal(fs.readFileSync(filename, 'utf8'), saved);
  } finally { mock.mock.restore(); }
});

test('saved history without revision opens at legacy revision zero and then participates in ordering', async t => {
  const h = fixture(t); h.service.update(h.chat.id, { input: '旧版本的输入' }); h.service.save(h.chat.id);
  const filename = path.join(h.root, 'chats', h.chat.id + '.json'), legacy = JSON.parse(fs.readFileSync(filename, 'utf8'));
  delete legacy.revision; fs.writeFileSync(filename, JSON.stringify(legacy));
  const restored = new ChatService(h.config);
  try {
    assert.equal(restored.get(h.chat.id).revision, 0);
    const edited = restored.update(h.chat.id, { input: '迁移后新保存的输入' });
    assert.equal(edited.revision, 1);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).revision, 1);
    assert.equal(edited.input, '迁移后新保存的输入');
  } finally { await restored.shutdown(); }
});
