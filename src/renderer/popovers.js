'use strict';
(() => {
  let current = null;
  const make = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; if (tag === 'button') item.type = 'button'; return item; };
  const canonical = name => String(name || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  function openPanel({ anchor, title, kind, populate }) {
    current?.close(null, false);
    if (!anchor?.isConnected) return Promise.resolve(null);
    return new Promise(resolve => {
      const panel = make('div', 'inmoment-popover ' + kind); panel.setAttribute('popover', 'manual'); panel.setAttribute('role', kind === 'context-menu' ? 'menu' : 'dialog'); panel.setAttribute('aria-label', title); panel.setAttribute('aria-modal', 'false');
      const host = anchor.closest?.('dialog[open]') || document.body; host.append(panel);
      let finished = false, observer;
      const close = (value = null, restore = true) => {
        if (finished) return; finished = true;
        document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keyboard, true); document.removeEventListener('focusin', focusOutside, true); document.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', position);
        observer?.disconnect(); try { panel.hidePopover?.(); } catch {} panel.remove(); if (current?.panel === panel) current = null;
        if (restore && anchor.isConnected) { if (!anchor.disabled) anchor.focus?.({ preventScroll: true }); else requestAnimationFrame(() => { if (!current && anchor.isConnected && !anchor.disabled) anchor.focus?.({ preventScroll: true }); }); } resolve(value);
      };
      const buttons = () => [...panel.querySelectorAll('button')].filter(item => !item.disabled && !item.hidden);
      const keyboard = event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (!panel.contains(event.target)) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { const options = buttons(); if (!options.length) return; const at = options.indexOf(document.activeElement); const next = event.key === 'ArrowDown' ? (at + 1) % options.length : (at < 0 ? options.length - 1 : (at - 1 + options.length) % options.length); event.preventDefault(); options[next].focus(); }
      };
      const outside = event => { if (!panel.contains(event.target)) close(null, false); };
      const focusOutside = event => { if (!panel.contains(event.target) && event.target !== anchor) close(null, false); };
      const onScroll = event => { if (!panel.contains(event.target)) close(null, false); };
      const position = () => {
        if (!anchor.isConnected) { close(null, false); return; }
        const rect = anchor.getBoundingClientRect(); const bounds = panel.getBoundingClientRect(); const margin = 10, gap = 7;
        const width = Math.min(bounds.width || 300, Math.max(0, innerWidth - margin * 2)); const height = Math.min(bounds.height || 280, Math.max(0, innerHeight - margin * 2));
        const left = Math.max(margin, Math.min(rect.left, innerWidth - width - margin));
        const below = rect.bottom + gap; const top = below + height <= innerHeight - margin ? below : Math.max(margin, rect.top - height - gap);
        panel.style.left = left + 'px'; panel.style.top = top + 'px';
      };
      const content = populate(panel, value => close(value));
      current = { panel, close };
      try { panel.showPopover?.(); } catch { panel.removeAttribute('popover'); }
      position(); (content?.focus || buttons()[0])?.focus?.({ preventScroll: true });
      document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keyboard, true); document.addEventListener('focusin', focusOutside, true); document.addEventListener('scroll', onScroll, true); window.addEventListener('resize', position);
      observer = new MutationObserver(() => { if (!anchor.isConnected || !panel.isConnected || (host !== document.body && !host.open)) close(null, false); }); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    });
  }
  function picker({ anchor, topics = [], choices = [], selectedIds = [], title = '添加到组' } = {}) {
    const names = new Set(), entries = [];
    for (const [items, existing] of [[topics, true], [choices, false]]) for (const item of items) {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || !canonical(item.name) || names.has(canonical(item.name))) continue;
      names.add(canonical(item.name)); entries.push({ id: item.id, name: item.name.trim(), existing });
    }
    return openPanel({ anchor, title, kind: 'group-picker', populate(panel, choose) {
      panel.append(make('div', 'popover-heading', title));
      const search = make('input', 'group-picker-search'); search.type = 'search'; search.placeholder = '搜索分组'; search.setAttribute('aria-label', '搜索分组'); search.autocomplete = 'off'; panel.append(search);
      const list = make('div', 'group-picker-options'); panel.append(list);
      function render() {
        list.replaceChildren(); const query = canonical(search.value); const visible = entries.filter(item => canonical(item.name).includes(query));
        for (const item of visible) { const button = make('button', 'group-picker-option'); button.setAttribute('data-group-choice-id', item.id); button.setAttribute('aria-pressed', String(selectedIds.includes(item.id))); button.title = item.name; button.append(make('span', 'group-picker-name', item.name)); if (!item.existing) button.append(make('span', 'group-picker-new', '新分组')); if (selectedIds.includes(item.id)) button.append(make('span', 'group-picker-check', '✓')); button.addEventListener('click', () => choose({ id: item.id, name: item.name })); list.append(button); }
        if (!visible.length) list.append(make('p', 'popover-empty', entries.length ? '没有匹配的分组' : '还没有分组，可在左侧创建。'));
      }
      search.addEventListener('input', render); search.addEventListener('keydown', event => { if (event.isComposing || event.keyCode === 229) return; if (event.key === 'Enter') { const first = list.querySelector('button'); if (first) { event.preventDefault(); first.click(); } } }); render(); return { focus: search };
    } });
  }
  window.InMomentGroupPicker = { open: picker, close: () => current?.close() };
  window.InMomentConfirm = { async open({ anchor, title = '确认删除？', message = '', detail = '', confirmLabel = '删除', danger = false } = {}) {
    return (await openPanel({ anchor, title, kind: 'confirm-popover', populate(panel, choose) {
      panel.append(make('div', 'popover-heading', title));
      if (message) panel.append(make('p', 'popover-message', message));
      if (detail) panel.append(make('p', 'popover-detail', detail));
      const actions = make('div', 'popover-confirm-actions');
      const cancel = make('button', 'popover-confirm-cancel', '取消'); cancel.setAttribute('data-confirm-action', 'cancel'); cancel.addEventListener('click', () => choose(false));
      const confirm = make('button', 'popover-confirm-submit' + (danger ? ' danger' : ''), confirmLabel); confirm.setAttribute('data-confirm-action', 'confirm'); confirm.addEventListener('click', () => choose(true));
      actions.append(cancel, confirm); panel.append(actions); return { focus: cancel };
    } })) === true;
  }, close: () => current?.close() };
  window.InMomentMenus = { open({ anchor, items = [], title = '分组操作' } = {}) { return openPanel({ anchor, title, kind: 'context-menu', populate(panel, choose) { for (const item of items) { const button = make('button', 'popover-menu-item' + (item.danger ? ' danger' : ''), item.label); button.setAttribute('role', 'menuitem'); button.setAttribute('data-menu-id', item.id); button.addEventListener('click', () => choose(item.id)); panel.append(button); } } }); }, close: () => current?.close() };
})();
