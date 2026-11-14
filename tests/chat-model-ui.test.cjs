'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatView } = require('../src/shared/chat-view.js');
const { messageKey } = require('../src/shared/chat-navigation.js');

function modelFixture(t, picks) {
  const previous = global.window;
  const menus = [];
  global.window = { InMomentMenus: { async open(menu) { menus.push(menu); return picks.shift(); } } };
  t.after(() => { global.window = previous; });
  const settings = {
    aiProvider:'gemini', modelMode:'manual', model:'gemini-custom',
    aiProviders:[{ id:'gemini', label:'Gemini', models:['gemini-3.8-flash'] }]
  };
  const view = Object.assign(Object.create(ChatView.prototype), {
    currentId:'first', request:1,
    modelButton:{ isConnected:true, disabled:false, setAttribute() {} }, modelLabel:{}, modelShortLabel:{},
    async invoke(method) { assert.equal(method, 'settings:get'); return settings; },
    scheduleInputLayout() {}
  });
  return { view, menus, settings };
}

test('chat picker displays inherited manual model and explicitly selects Auto with a null override', async t => {
  const { view, menus } = modelFixture(t, ['model','auto','effort','deep']);
  await view.readModelCatalog();
  assert.equal(view.modelLabel.textContent, 'gemini-custom');
  assert.deepEqual(await view.modelOptionsForSend('first'), {});
  await view.chooseChatModel();
  assert.equal(menus[1].items.find(item => item.selected).id, 'gemini-custom');
  await view.chooseChatModel();
  assert.deepEqual(await view.modelOptionsForSend('first'), { modelOverride:null, reasoningEffort:'deep' });
  assert.match(view.modelLabel.textContent, /^自动/u);
  view.currentId = 'second';
  assert.deepEqual(await view.modelOptionsForSend('second'), {});
});

test('unknown custom model exposes Auto effort only and a stale provider override cannot send', async t => {
  const { view, menus, settings } = modelFixture(t, ['effort','auto','model','gemini-3.8-flash']);
  await view.chooseChatModel();
  assert.deepEqual(menus[1].items.map(item => item.id), ['auto']);
  await view.chooseChatModel();
  assert.deepEqual(await view.modelOptionsForSend('first'), { modelOverride:'gemini-3.8-flash' });
  settings.aiProvider = 'openai';
  await assert.rejects(view.modelOptionsForSend('first'), /设置已更改/u);
  assert.equal(view.modelChoices.has('first'), false);
});

test('leaving chat cancels a model menu that is still waiting for local settings', async t => {
  const { view, menus, settings } = modelFixture(t, ['model']);
  let resolveSettings;
  view.invoke = () => new Promise(resolve => { resolveSettings = resolve; });
  view.flush = async () => {};
  const opening = view.chooseChatModel();
  await view.prepareToLeave();
  resolveSettings(settings);
  await opening;
  assert.equal(menus.length, 0);
  assert.equal(view.modelMenuOpen, false);
});

test('main progress stays expanded only when requested, while floating shows the current active step', t => {
  const previous = global.document;
  global.document = { createElement(tagName) {
    return { tagName, dataset:{}, children:[], append(...items) { this.children.push(...items); }, addEventListener(name, listener) { this[name] = listener; } };
  } };
  t.after(() => { global.document = previous; });
  const progress = { assistantId:'a', startedAt:1, steps:[{ id:'route', label:'选择模型', startedAt:1, endedAt:51, model:'gemini-3.8-flash' }, { id:'request', label:'发送请求', startedAt:51 }] };
  const main = Object.assign(Object.create(ChatView.prototype), { floating:false });
  const detail = main.progressView('a', progress, true);
  assert.equal(detail.open, true);
  assert.equal(detail.children[1].children[0].children[1].textContent, 'gemini-3.8-flash');
  assert.equal(detail.children[1].children[0].children[2].textContent, '50 ms');
  assert.equal(main.progressView('a', progress, false).open, false);
  const finished = main.progressView('a', progress, false);
  finished.children[0].click({ preventDefault() {} });
  assert.equal(main.progressView('a', progress, false).open, true);
  const floating = Object.assign(Object.create(ChatView.prototype), { floating:true });
  assert.equal(floating.progressView('a', progress, true).textContent, '发送请求');
  assert.equal(floating.progressView('a', progress, false), null);
});

test('chat message keys track new progress and file metadata without serializing file payloads', () => {
  const file = { id:'file', mimeType:'application/pdf', name:'sample.pdf', size:24, base64:'A'.repeat(2*1024*1024) };
  const chat = { id:'chat', pending:true, messages:[{ id:'u', role:'user', attachments:[file] }] };
  const initial = messageKey(chat, false);
  assert.ok(initial.length < 220);
  assert.notEqual(initial, messageKey({ ...chat, progress:{ assistantId:'a', steps:[{ id:'request', label:'发送请求' }] } }, false));
  file.name = 'changed.pdf';
  assert.notEqual(initial, messageKey(chat, false));
});
