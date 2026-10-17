'use strict';

const { randomUUID } = require('node:crypto');

function isMainFrameEvent(event, window) {
  return Boolean(window && !window.isDestroyed() && event?.sender === window.webContents && event.senderFrame && event.senderFrame === window.webContents.mainFrame);
}

function normalizeOptions(value = {}) {
  const buttons = Array.isArray(value.buttons) && value.buttons.length ? value.buttons.slice(0, 6).map(item => String(item).slice(0, 100)) : ['关闭'];
  const cancelId = Number.isInteger(value.cancelId) && value.cancelId >= 0 && value.cancelId < buttons.length ? value.cancelId : 0;
  const defaultId = Number.isInteger(value.defaultId) && value.defaultId >= 0 && value.defaultId < buttons.length ? value.defaultId : cancelId;
  return {
    title: String(value.title || 'InMoment').slice(0, 200),
    message: String(value.message || '').slice(0, 2000),
    detail: String(value.detail || '').slice(0, 12000),
    type: ['question', 'warning', 'error', 'info'].includes(value.type) ? value.type : 'info',
    buttons, defaultId, cancelId,
  };
}

// Every approval belongs to one live request in the trusted main frame. Reload,
// hide, close and renderer failure all resolve as cancellation, never consent.
class AppDialogManager {
  constructor({ getWindow, showWindow = () => {} }) {
    this.getWindow = getWindow;
    this.showWindow = showWindow;
    this.ready = false;
    this.disposed = false;
    this.queue = [];
    this.active = null;
  }

  showMessageBox(options) {
    const normalized = normalizeOptions(options);
    const window = this.getWindow();
    if (this.disposed || !window || window.isDestroyed()) return Promise.resolve({ response: normalized.cancelId });
    return new Promise(resolve => {
      this.queue.push({ id: randomUUID(), options: normalized, resolve });
      this.drain();
    });
  }

  markReady() {
    if (this.disposed) return false;
    this.ready = true;
    this.drain();
    return true;
  }

  drain() {
    if (!this.ready || this.active || this.disposed || !this.queue.length) return;
    const window = this.getWindow();
    if (!window || window.isDestroyed()) { this.cancelAll({ resetReady: true }); return; }
    const item = this.queue.shift();
    this.active = item;
    try {
      this.showWindow();
      window.webContents.send('inmoment:event', { type: 'dialog:show', id: item.id, options: item.options });
    } catch {
      this.active = null;
      item.resolve({ response: item.options.cancelId });
      this.cancelAll({ resetReady: true });
    }
  }

  respond(event, params = {}) {
    if (!isMainFrameEvent(event, this.getWindow())) return false;
    const item = this.active;
    if (!item || params.id !== item.id || !Number.isInteger(params.buttonIndex) || params.buttonIndex < 0 || params.buttonIndex >= item.options.buttons.length) return false;
    this.active = null;
    item.resolve({ response: params.buttonIndex });
    this.drain();
    return true;
  }

  cancelAll({ resetReady = false } = {}) {
    if (resetReady) this.ready = false;
    const pending = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = null;
    this.queue = [];
    const window = this.getWindow();
    for (const item of pending) {
      item.resolve({ response: item.options.cancelId });
      try { if (window && !window.isDestroyed()) window.webContents.send('inmoment:event', { type: 'dialog:cancel', id: item.id }); } catch {}
    }
  }

  close() {
    this.disposed = true;
    this.cancelAll({ resetReady: true });
  }
}

module.exports = { AppDialogManager, isMainFrameEvent, normalizeOptions };
