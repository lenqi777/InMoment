'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AppDialogManager, isMainFrameEvent } = require('../src/main/app-dialogs.cjs');
const { controlWindow } = require('../src/main/window-ui.cjs');

function harness() {
  const sent = [];
  let shown = 0;
  const mainFrame = {};
  const webContents = { mainFrame, send(channel, message) { sent.push({ channel, ...message }); } };
  const window = { isDestroyed: () => false, webContents };
  const event = { sender: webContents, senderFrame: mainFrame };
  const manager = new AppDialogManager({ getWindow: () => window, showWindow: () => { shown += 1; } });
  return { manager, window, event, sent, shown: () => shown };
}

const approval = { title: '允许这一次请求？', message: '本地模拟确认', buttons: ['取消', '同意发送一次'], defaultId: 0, cancelId: 0, type: 'question' };

test('approvals wait for the subscribed UI and are shown one at a time', async () => {
  const fx = harness();
  const first = fx.manager.showMessageBox(approval);
  const second = fx.manager.showMessageBox(approval);
  assert.equal(fx.sent.length, 0);
  fx.manager.markReady();
  assert.equal(fx.sent.length, 1);
  const id = fx.sent[0].id;
  assert.equal(fx.shown(), 1);
  assert.equal(fx.manager.respond(fx.event, { id, buttonIndex: 1 }), true);
  assert.equal((await first).response, 1);
  assert.equal(fx.sent.length, 2);
  assert.notEqual(fx.sent[1].id, id);
  fx.manager.respond(fx.event, { id: fx.sent[1].id, buttonIndex: 0 });
  assert.equal((await second).response, 0);
});

test('overlay, subframe, forged IDs and out-of-range responses cannot approve', async () => {
  const fx = harness();
  fx.manager.markReady();
  const result = fx.manager.showMessageBox(approval);
  const id = fx.sent[0].id;
  const overlay = { mainFrame: fx.event.senderFrame };
  assert.equal(fx.manager.respond({ sender: overlay, senderFrame: overlay.mainFrame }, { id, buttonIndex: 1 }), false);
  assert.equal(fx.manager.respond({ sender: fx.event.sender, senderFrame: {} }, { id, buttonIndex: 1 }), false);
  assert.equal(fx.manager.respond(fx.event, { id: 'forged', buttonIndex: 1 }), false);
  assert.equal(fx.manager.respond(fx.event, { id, buttonIndex: 7 }), false);
  assert.equal(fx.manager.respond(fx.event, { id, buttonIndex: '1' }), false);
  assert.equal(fx.manager.respond(fx.event, { id, buttonIndex: 1 }), true);
  assert.equal((await result).response, 1);
  assert.equal(fx.manager.respond(fx.event, { id, buttonIndex: 1 }), false);
});

test('reload cancels active and queued permissions and invalidates their IDs', async () => {
  const fx = harness();
  fx.manager.markReady();
  const first = fx.manager.showMessageBox(approval);
  const second = fx.manager.showMessageBox(approval);
  const oldId = fx.sent[0].id;
  fx.manager.cancelAll({ resetReady: true });
  assert.deepEqual(await Promise.all([first, second]), [{ response: 0 }, { response: 0 }]);
  assert.equal(fx.sent.filter(item => item.type === 'dialog:cancel').length, 2);
  const third = fx.manager.showMessageBox(approval);
  assert.equal(fx.sent.filter(item => item.type === 'dialog:show').length, 1);
  fx.manager.markReady();
  assert.equal(fx.manager.respond(fx.event, { id: oldId, buttonIndex: 1 }), false);
  fx.manager.close();
  assert.equal((await third).response, 0);
  assert.equal((await fx.manager.showMessageBox(approval)).response, 0);
});

test('hiding and a failed renderer send cancel instead of defaulting to approval', async () => {
  const fx = harness();
  fx.manager.markReady();
  const pending = fx.manager.showMessageBox({ ...approval, defaultId: 1 });
  fx.manager.cancelAll();
  assert.equal((await pending).response, 0);
  fx.window.webContents.send = () => { throw new Error('renderer gone'); };
  assert.equal((await fx.manager.showMessageBox(approval)).response, 0);
});

test('trusted UI origins are object-identical and window controls preserve normal actions', () => {
  const fx = harness();
  assert.equal(isMainFrameEvent(fx.event, fx.window), true);
  assert.equal(isMainFrameEvent({ sender: { ...fx.event.sender }, senderFrame: fx.event.senderFrame }, fx.window), false);
  let maximized = false;
  const calls = [];
  const window = { isDestroyed: () => false, isMaximized: () => maximized, maximize() { calls.push('maximize'); maximized = true; }, unmaximize() { calls.push('unmaximize'); maximized = false; }, minimize() { calls.push('minimize'); }, close() { calls.push('close'); } };
  assert.equal(controlWindow(window, 'toggleMaximize').maximized, true);
  assert.equal(controlWindow(window, 'toggleMaximize').maximized, false);
  controlWindow(window, 'minimize'); controlWindow(window, 'close');
  assert.deepEqual(calls, ['maximize', 'unmaximize', 'minimize', 'close']);
  assert.throws(() => controlWindow(window, 'destroy'), /不支持/);
});
