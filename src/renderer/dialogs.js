'use strict';

// One visual surface, but local confirmations never carry a main-process ID.
// The queue has a release/arming guard so a double click or held Enter cannot
// accidentally approve the next authorization request.
(() => {
  const dialog = document.querySelector('#confirm-dialog');
  const title = document.querySelector('#confirm-title');
  const message = document.querySelector('#confirm-message');
  const detail = document.querySelector('#confirm-detail');
  const actions = document.querySelector('#confirm-actions');
  const close = document.querySelector('#confirm-close');
  const marker = document.querySelector('#confirm-marker');
  const queue = [];
  const remoteIds = new Set();
  const cancelledRemoteIds = new Set();
  const heldKeys = new Set();
  let active = null;
  let sequence = 0;
  let armTimer;
  let nextTimer;
  const clock = () => Date.now();

  function releaseReady() { return !heldKeys.has('Enter') && !heldKeys.has(' '); }
  function enableWhenReady(item) {
    if (active !== item || !releaseReady() || clock() < item.readyAt) return;
    item.armed = true;
    item.buttons.forEach(button => { button.disabled = false; });
  }
  function next() {
    if (active || !queue.length) return;
    const item = queue.shift(); active = item;
    const options = item.options;
    const labels = Array.isArray(options.buttons) && options.buttons.length ? options.buttons.map(String) : ['取消', '确认'];
    item.cancelId = Number.isInteger(options.cancelId) && options.cancelId >= 0 && options.cancelId < labels.length ? options.cancelId : 0;
    item.readyAt = clock() + 180; item.armed = false;
    item.opener = document.activeElement;
    title.textContent = options.title || '请确认';
    message.textContent = options.message || '';
    detail.textContent = options.detail || '';
    detail.classList.toggle('hidden', !options.detail);
    dialog.classList.toggle('confirmation-danger', options.type === 'warning' || options.type === 'error' || options.danger === true);
    marker.textContent = options.type === 'warning' || options.danger ? '!' : 'i';
    actions.replaceChildren(); item.buttons = labels.map((label, index) => {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'button ' + (index === item.cancelId ? 'secondary' : options.type === 'warning' || options.danger ? 'danger' : 'primary');
      button.textContent = label; button.disabled = true;
      button.addEventListener('click', event => {
        if (active !== item || !item.armed || !releaseReady() || event.detail > 1) return;
        settle(item, index);
      });
      actions.append(button); return button;
    });
    if (!dialog.open) dialog.showModal();
    // Always start on Cancel, even if a native caller supplied an approving default.
    close.focus?.();
    armTimer = setTimeout(() => { enableWhenReady(item); if (active === item && item.armed) item.buttons[item.cancelId].focus?.(); }, 180);
  }
  function settle(item, index) {
    if (active !== item || item.settled) return;
    item.settled = true; item.armed = false; clearTimeout(armTimer);
    item.buttons.forEach(button => { button.disabled = true; });
    dialog.close(); active = null;
    item.resolve(index);
    if (item.opener?.isConnected) item.opener.focus?.();
    // A new prompt may be waiting: give the previous click/keyup sequence time to finish.
    nextTimer = setTimeout(() => { nextTimer = null; next(); }, 220);
  }
  function request(options = {}, remoteId = null) {
    return new Promise(resolve => { queue.push({ token: ++sequence, remoteId, options: { ...options }, resolve }); if (!nextTimer) next(); });
  }
  function cancel() { if (active) settle(active, active.cancelId); }
  close.addEventListener('click', cancel);
  dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
  document.addEventListener('keydown', event => {
    const releasedBefore = releaseReady();
    const wasHeld = heldKeys.has(event.key);
    heldKeys.add(event.key);
    if (active && (event.key === 'Enter' || event.key === ' ')) {
      // Native Enter clicks occur before keyup. Handle a fresh focused-button
      // activation here, then retain the held-key guard for the next prompt.
      event.preventDefault(); event.stopImmediatePropagation?.();
      const item = active;
      const index = document.activeElement === close ? item.cancelId : item.buttons.indexOf(document.activeElement);
      if (!event.repeat && !wasHeld && releasedBefore && item.armed && index >= 0) settle(item, index);
    }
  }, true);
  document.addEventListener('keyup', event => {
    heldKeys.delete(event.key);
    if (active) enableWhenReady(active);
  }, true);
  window.addEventListener?.('blur', () => { heldKeys.clear(); });
  window.InMomentDialogs = Object.freeze({
    request,
    async confirm(options) {
      const normalized = typeof options === 'string' ? { message: options } : options;
      return await request({ title: '请确认', ...normalized, buttons: ['取消', normalized.confirmLabel || '确认'], cancelId: 0, defaultId: 0 }) === 1;
    },
    async remote(payload) {
      if (!payload || typeof payload.id !== 'string' || remoteIds.has(payload.id)) return;
      remoteIds.add(payload.id);
      const buttonIndex = await request(payload.options || {}, payload.id);
      if (cancelledRemoteIds.has(payload.id)) return;
      try { await window.inmoment.invoke('dialog:respond', { id: payload.id, buttonIndex }); } catch { /* Main already cancels on close/reload. */ }
    },
    cancelRemote(id) {
      if (typeof id !== 'string') return;
      cancelledRemoteIds.add(id);
      if (active?.remoteId === id) { cancel(); return; }
      const index = queue.findIndex(item => item.remoteId === id);
      if (index >= 0) { const [item] = queue.splice(index, 1); item.resolve(item.options.cancelId ?? 0); }
    },
    get open() { return Boolean(active); },
  });
})();
