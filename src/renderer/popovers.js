'use strict';
(() => {
  let current = null;
  let panelGeneration = 0;
  const make = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; if (tag === 'button') item.type = 'button'; return item; };
  const canonical = name => String(name || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  function openPanel({ anchor, title, kind, populate }) {
    const generation = ++panelGeneration;
    current?.close(null, false);
    if (!anchor?.isConnected) return Promise.resolve(null);
    return new Promise(resolve => {
      const panel = make('div', 'inmoment-popover ' + kind); panel.setAttribute('popover', 'manual'); panel.setAttribute('role', kind.includes('context-menu') ? 'menu' : 'dialog'); panel.setAttribute('aria-label', title); panel.setAttribute('aria-modal', 'false');
      const host = anchor.closest?.('dialog[open]') || document.body; host.append(panel);
      let finished = false, observer, pendingValue = null;
      let submenu, submenuEvents, submenuBridge, submenuOpen = false, submenuVersion = 0, submenuTimer;
      const inSubmenu = target => submenuOpen && submenu.panel.contains(target);
      function placeSubmenu() {
        if (!submenuOpen) return;
        const child = submenu.panel;
        const trigger = submenu.anchor.getBoundingClientRect();
        const menu = panel.getBoundingClientRect();
        const margin = 12, gap = 8;
        const width = child.offsetWidth;
        const height = child.offsetHeight;
        const right = menu.right + gap;
        const left = menu.left - gap - width;
        const stacked = right + width > innerWidth - margin && left < margin;
        const hadMenuFocus = panel.contains(document.activeElement);
        child.dataset.submenuPlacement = stacked ? 'stacked' : right + width <= innerWidth - margin ? 'right' : 'left';
        child.style.left = (stacked ? Math.max(margin, Math.min(menu.left, innerWidth - width - margin))
          : child.dataset.submenuPlacement === 'right' ? right : left) + 'px';
        child.style.top = Math.max(margin, Math.min(stacked ? menu.top : trigger.top, innerHeight - height - margin)) + 'px';
        panel.inert = stacked;
        panel.classList.toggle('submenu-replaced', stacked);
        if (stacked && hadMenuFocus) submenu.focus?.focus({ preventScroll: true });
        submenuBridge.hidden = stacked;
        if (!stacked) {
          const start = child.dataset.submenuPlacement === 'right' ? menu.right : left + width;
          const top = Math.min(trigger.top, Number.parseFloat(child.style.top));
          const bottom = Math.max(trigger.bottom, Number.parseFloat(child.style.top) + height);
          Object.assign(submenuBridge.style, { left: start + 'px', top: top + 'px', width: gap + 'px', height: bottom - top + 'px' });
        }
      }
      function closeSubmenu(restore = false, immediately = false) {
        if (!submenu || (!submenuOpen && !immediately)) return;
        clearTimeout(submenuTimer);
        const version = ++submenuVersion;
        const child = submenu.panel;
        if (submenuOpen) submenu.onClose?.();
        submenuOpen = false;
        submenu.anchor.setAttribute('aria-expanded', 'false');
        panel.inert = false;
        panel.classList.remove('submenu-replaced');
        child.inert = true;
        submenuBridge.hidden = true;
        child.dataset.popoverState = 'closing';
        if (restore && !finished) submenu.anchor.focus({ preventScroll: true });
        const hide = () => {
          if (version !== submenuVersion || submenuOpen) return;
          child.hidePopover?.();
          child.remove();
        };
        if (immediately) hide();
        else Promise.resolve(window.InMomentMotion?.exit?.(child, { kind: 'popover' })).then(hide, hide);
      }
      function openSubmenu(focus = false) {
        clearTimeout(submenuTimer);
        if (finished || !submenu || submenu.anchor.disabled) return;
        const child = submenu.panel;
        if (!submenuOpen) {
          submenuVersion++;
          submenuOpen = true;
          host.append(child);
          child.inert = false;
          child.dataset.popoverState = 'open';
          submenu.anchor.setAttribute('aria-expanded', 'true');
          try { child.showPopover?.(); } catch { child.removeAttribute('popover'); }
          placeSubmenu();
          window.InMomentMotion?.enter?.(child, { kind: 'popover' });
          submenu.onOpen?.();
        }
        if (focus || child.dataset.submenuPlacement === 'stacked') submenu.focus?.focus({ preventScroll: true });
      }
      function scheduleSubmenuClose() {
        clearTimeout(submenuTimer);
        if (!submenuOpen || submenu.panel.dataset.submenuPlacement === 'stacked' || inSubmenu(document.activeElement)) return;
        submenuTimer = setTimeout(() => closeSubmenu(), 220);
      }
      function setupSubmenu() {
        if (!submenu) return;
        const { anchor: trigger, panel: child, closeButton } = submenu;
        submenuEvents = new AbortController();
        const { signal } = submenuEvents;
        submenuBridge = make('div', 'menu-submenu-gap');
        submenuBridge.setAttribute('aria-hidden', 'true');
        submenuBridge.hidden = true;
        panel.append(submenuBridge);
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', child.id);
        trigger.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') openSubmenu(); });
        trigger.addEventListener('pointerleave', scheduleSubmenuClose);
        trigger.addEventListener('click', () => openSubmenu(true));
        panel.addEventListener('pointerover', event => {
          const next = event.target.closest?.('.popover-menu-item');
          if (next && next !== trigger && submenuOpen && !inSubmenu(document.activeElement)) closeSubmenu();
        });
        child.addEventListener('pointerenter', () => clearTimeout(submenuTimer), { signal });
        child.addEventListener('pointerleave', scheduleSubmenuClose, { signal });
        submenuBridge.addEventListener('pointerenter', () => clearTimeout(submenuTimer), { signal });
        submenuBridge.addEventListener('pointerleave', scheduleSubmenuClose, { signal });
        closeButton?.addEventListener('click', () => closeSubmenu(true), { signal });
      }
      const cancelPending = event => {
        if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
        event.preventDefault(); event.stopPropagation(); pendingValue = null;
      };
      const cancelPendingPointer = event => { if (!panel.contains(event.target)) pendingValue = null; };
      const close = (value = null, restore = true) => {
        if (finished) { if (value === null) pendingValue = null; return; } finished = true; pendingValue = value;
        const closingFocus = document.activeElement;
        const restoreFocus = !closingFocus || closingFocus === anchor || panel.contains(closingFocus) || inSubmenu(closingFocus);
        document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keyboard, true); document.removeEventListener('focusin', focusOutside, true); document.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', position);
        document.addEventListener('keydown', cancelPending, true);
        document.addEventListener('pointerdown', cancelPendingPointer, true);
        submenuEvents?.abort();
        closeSubmenu(false, true);
        submenuBridge?.remove();
        observer?.disconnect(); panel.setAttribute('aria-hidden', 'true'); panel.setAttribute('data-popover-state', 'closing'); panel.style.pointerEvents = 'none'; panel.inert = true;
        const finish = () => {
          document.removeEventListener('keydown', cancelPending, true);
          document.removeEventListener('pointerdown', cancelPendingPointer, true);
          const active = document.activeElement; const mayRestore = restoreFocus && (!active || active === closingFocus || active === anchor || active === document.body || panel.contains(active) || !active.isConnected);
          try { panel.hidePopover?.(); } catch {} panel.remove(); if (current?.panel === panel) current = null;
          if (restore && mayRestore && !current && anchor.isConnected) { if (!anchor.disabled) anchor.focus?.({ preventScroll: true }); else requestAnimationFrame(() => { if (!current && anchor.isConnected && !anchor.disabled) anchor.focus?.({ preventScroll: true }); }); } resolve(generation === panelGeneration ? pendingValue : null);
        };
        try { const exit = window.InMomentMotion?.exit?.(panel, { kind: 'popover' }); if (exit?.then) return exit.then(finish, finish); } catch {}
        finish();
      };
      const buttons = () => [...panel.querySelectorAll('button')].filter(item => !item.disabled && !item.hidden);
      const isSelection = kind.includes('select-popover');
      const focusOption = button => {
        if (!button) return;
        button.focus?.({ preventScroll: isSelection });
        if (!isSelection || !panel.clientHeight) return;
        const top = button.offsetTop;
        const bottom = top + button.offsetHeight;
        if (top < panel.scrollTop) panel.scrollTop = top;
        else if (bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = bottom - panel.clientHeight;
      };
      let typed = '', typedAt = 0;
      const keyboard = event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (submenuOpen) closeSubmenu(true); else close(); return; }
        if (event.key === 'ArrowRight' && event.target === submenu?.anchor) { event.preventDefault(); openSubmenu(true); return; }
        if (!panel.contains(event.target)) return;
        const input = ['input', 'textarea'].includes(String(event.target?.tagName || event.target?.tag || '').toLocaleLowerCase());
        if (input && event.target?.type === 'date') return;
        if (input && (event.key === 'Home' || event.key === 'End')) return;
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { const options = buttons(); if (!options.length) return; const at = options.indexOf(document.activeElement); const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowDown' ? (at + 1) % options.length : (at < 0 ? options.length - 1 : (at - 1 + options.length) % options.length); event.preventDefault(); focusOption(options[next]); return; }
        if (!input && event.key?.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) { const now = Date.now(); typed = (now - typedAt > 600 ? '' : typed) + canonical(event.key); typedAt = now; const match = buttons().find(option => canonical(option.getAttribute('data-option-label') || option.textContent).startsWith(typed)); if (match) { event.preventDefault(); focusOption(match); } }
      };
      const outside = event => { if ((submenu || kind.includes('select-popover')) && anchor.contains(event.target)) return; if (!panel.contains(event.target) && !inSubmenu(event.target) && event.target !== submenuBridge) close(null, false); };
      const focusOutside = event => { if (!panel.contains(event.target) && event.target !== anchor && !inSubmenu(event.target)) close(null, false); };
      const onScroll = event => { if (!panel.contains(event.target) && !inSubmenu(event.target)) close(null, false); };
      const position = () => {
        if (!anchor.isConnected) { close(null, false); return; }
        const rect = anchor.getBoundingClientRect(); const bounds = panel.getBoundingClientRect(); const margin = 10, gap = 7;
        const width = Math.min(bounds.width || 300, Math.max(0, innerWidth - margin * 2)); const height = Math.min(bounds.height || 280, Math.max(0, innerHeight - margin * 2));
        const left = Math.max(margin, Math.min(rect.left, innerWidth - width - margin));
        const below = rect.bottom + gap; const top = below + height <= innerHeight - margin ? below : Math.max(margin, rect.top - height - gap);
        panel.style.left = left + 'px'; panel.style.top = top + 'px'; panel.dataset.uiPlacement = below + height <= innerHeight - margin ? 'bottom' : 'top';
        placeSubmenu();
      };
      const content = populate(panel, (value, restore) => close(value, restore));
      submenu = content?.submenu;
      setupSubmenu();
      current = { panel, anchor, close };
      try { panel.showPopover?.(); } catch { panel.removeAttribute('popover'); }
      position(); panel.setAttribute('data-popover-state', 'open'); try { window.InMomentMotion?.enter?.(panel, { kind: 'popover' })?.catch?.(() => {}); } catch {}
      const initialFocus = content?.focus || buttons()[0];
      if (isSelection) focusOption(initialFocus);
      else initialFocus?.focus?.({ preventScroll: true });
      document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', keyboard, true); document.addEventListener('focusin', focusOutside, true); document.addEventListener('scroll', onScroll, true); window.addEventListener('resize', position);
      observer = new MutationObserver(() => { if (!anchor.isConnected || !panel.isConnected || (host !== document.body && !host.open)) close(null, false); }); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    });
  }
  function picker({ anchor, topics = [], choices = [], selectedIds = [], disabledIds = [], title = '添加到组', searchLabel = '搜索分组' } = {}) {
    const names = new Set(), entries = [];
    for (const [items, existing] of [[topics, true], [choices, false]]) for (const item of items) {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || !canonical(item.name) || names.has(canonical(item.name))) continue;
      names.add(canonical(item.name)); entries.push({ id: item.id, name: item.name.trim(), existing });
    }
    return openPanel({ anchor, title, kind: 'group-picker', populate(panel, choose) {
      panel.append(make('div', 'popover-heading', title));
      const search = make('input', 'group-picker-search'); search.type = 'search'; search.placeholder = searchLabel; search.setAttribute('aria-label', searchLabel); search.autocomplete = 'off'; panel.append(search);
      const list = make('div', 'group-picker-options'); panel.append(list);
      function render() {
        list.replaceChildren(); const query = canonical(search.value); const visible = entries.filter(item => canonical(item.name).includes(query));
        for (const item of visible) { const button = make('button', 'group-picker-option'); button.setAttribute('data-group-choice-id', item.id); button.setAttribute('data-ui-icon', item.existing ? 'folder-in' : 'folder-plus'); button.setAttribute('aria-pressed', String(selectedIds.includes(item.id))); button.disabled = disabledIds.includes(item.id); button.title = (selectedIds.includes(item.id) ? '已在分组“' : item.existing ? '添加到“' : '新建分组并添加到“') + item.name + '”'; button.setAttribute('aria-label', button.title); button.append(make('span', 'group-picker-name', item.name)); if (selectedIds.includes(item.id)) { const check = make('span', 'group-picker-check'); check.setAttribute('data-ui-icon', 'check'); check.setAttribute('aria-hidden', 'true'); button.append(check); } button.addEventListener('click', () => { if (!button.disabled) choose({ id: item.id, name: item.name }); }); list.append(button); }
        if (!visible.length) list.append(make('p', 'popover-empty', entries.length ? '没有匹配的分组' : '还没有分组，可在左侧创建。'));
      }
      search.addEventListener('input', render); search.addEventListener('keydown', event => { if (event.isComposing || event.keyCode === 229) return; if (event.key === 'Enter') { event.preventDefault(); const first = [...list.querySelectorAll('button')].find(button => !button.disabled); first?.click(); } }); render(); return { focus: search };
    } });
  }
  function filters({ anchor, range = 'all', from = '', to = '', query = '', semanticQuery = '', scopeLabel = '当前分组' } = {}) {
    const ranges = [{ id: 'all', label: '全部时间' }, { id: '7', label: '最近 7 天' }, { id: '30', label: '最近 30 天' }, { id: '365', label: '最近一年' }, { id: 'custom', label: '自定日期' }];
    if (!ranges.some(item => item.id === range)) range = 'all';
    return openPanel({ anchor, title: '筛选灵感', kind: 'library-filter-popover', populate(panel, choose) {
      panel.append(make('div', 'popover-heading', '筛选'));
      const scope = make('p', 'filter-scope'); scope.append(make('span', 'filter-field-caption', '当前范围'), make('span', 'filter-scope-name', scopeLabel)); panel.append(scope);
      const timeLabel = make('div', 'filter-field-label', '时间'); panel.append(timeLabel);
      const timeOptions = make('div', 'filter-time-options'); timeOptions.setAttribute('role', 'group'); timeOptions.setAttribute('aria-label', '时间范围'); panel.append(timeOptions);
      const customDates = make('div', 'filter-custom-dates'); customDates.setAttribute('data-motion-region', 'filter-dates');
      const fromLabel = make('label', 'filter-date-field', '开始日期'); const fromInput = make('input', 'filter-date-input'); fromInput.type = 'date'; fromInput.id = 'filter-popup-from'; fromInput.value = from; fromInput.setAttribute('aria-label', '筛选开始日期'); fromLabel.append(fromInput);
      const toLabel = make('label', 'filter-date-field', '结束日期'); const toInput = make('input', 'filter-date-input'); toInput.type = 'date'; toInput.id = 'filter-popup-to'; toInput.value = to; toInput.setAttribute('aria-label', '筛选结束日期'); toLabel.append(toInput); customDates.append(fromLabel, toLabel); panel.append(customDates);
      function showDates(animate = false) {
        const shown = range === 'custom'; if (animate && window.InMomentMotion?.show) window.InMomentMotion.show(customDates, shown); else customDates.className = 'filter-custom-dates' + (shown ? '' : ' hidden');
      }
      ranges.forEach(item => { const button = make('button', 'filter-time-option' + (range === item.id ? ' is-selected' : ''), item.label); button.setAttribute('data-filter-range', item.id); button.setAttribute('aria-pressed', String(range === item.id)); button.addEventListener('click', () => { range = item.id; for (const option of timeOptions.querySelectorAll('button')) { const selected = option.getAttribute('data-filter-range') === range; option.className = 'filter-time-option' + (selected ? ' is-selected' : ''); option.setAttribute('aria-pressed', String(selected)); } showDates(true); }); timeOptions.append(button); }); showDates();
      const keywordLabel = make('label', 'filter-keyword-field', '关键词'); const keyword = make('input', 'filter-keyword-input'); keyword.id = 'filter-popup-keyword'; keyword.type = 'search'; keyword.autocomplete = 'off'; keyword.value = query; keyword.placeholder = '在当前范围内匹配文字'; keyword.setAttribute('aria-label', '筛选关键词'); keywordLabel.append(keyword); panel.append(keywordLabel);
      if (semanticQuery) panel.append(make('p', 'filter-semantic-current', '当前描述：' + semanticQuery));
      const semantic = make('button', 'filter-semantic-action'); semantic.id = 'filter-popup-ai'; semantic.setAttribute('data-ui-icon', 'sparkle'); semantic.textContent = '按描述查找'; semantic.addEventListener('click', () => choose({ action: 'ai', query: keyword.value.trim() || semanticQuery })); panel.append(semantic);
      const error = make('p', 'persistent-error hidden'); error.id = 'filter-popup-error'; error.setAttribute('role', 'alert'); panel.append(error);
      const actions = make('div', 'filter-popover-actions'); const cancel = make('button', 'button quiet compact', '取消'); cancel.id = 'filter-popup-cancel'; cancel.addEventListener('click', () => choose(null));
      const apply = make('button', 'button primary compact', '应用筛选'); apply.id = 'filter-popup-apply';
      function applyFilters() {
        const start = fromInput.value ? new Date(fromInput.value + 'T00:00:00').getTime() : null; const end = toInput.value ? new Date(toInput.value + 'T00:00:00').getTime() : null;
        if (range === 'custom' && (start !== null && !Number.isFinite(start) || end !== null && !Number.isFinite(end) || start !== null && end !== null && start > end)) { error.textContent = '请检查日期，结束日期应不早于开始日期。'; error.className = 'persistent-error'; fromInput.focus(); return; }
        choose({ action: 'apply', range, from: fromInput.value, to: toInput.value, query: keyword.value.trim() });
      }
      apply.addEventListener('click', applyFilters); keyword.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); applyFilters(); } }); actions.append(cancel, apply); panel.append(actions);
      return { focus: timeOptions.querySelectorAll('button')[ranges.findIndex(item => item.id === range)] };
    } });
  }
  window.InMomentFilters = { open: filters, close: () => current?.close() };
  window.InMomentGroupPicker = { open: picker, close: () => current?.close() };
  window.InMomentConfirm = { async open({ anchor, title = '确认删除？', message = '', detail = '', confirmLabel = '删除', danger = false } = {}) {
    return (await openPanel({ anchor, title, kind: 'confirm-popover', populate(panel, choose) {
      panel.append(make('div', 'popover-heading', title));
      if (message) panel.append(make('p', 'popover-message', message));
      if (detail) panel.append(make('p', 'popover-detail', detail));
      const actions = make('div', 'popover-confirm-actions');
      const cancel = make('button', 'popover-confirm-cancel', '取消'); cancel.setAttribute('data-confirm-action', 'cancel'); cancel.addEventListener('click', () => choose(false));
      const confirm = make('button', 'popover-confirm-submit' + (danger ? ' danger' : ''), confirmLabel); if (danger) confirm.setAttribute('data-ui-icon', 'trash'); confirm.setAttribute('data-confirm-action', 'confirm'); confirm.addEventListener('click', () => choose(true));
      actions.append(cancel, confirm); panel.append(actions); return { focus: cancel };
    } })) === true;
  }, close: () => current?.close() };
  window.InMomentMenus = {
    open({ anchor, items = [], title = '分组操作', selection = false, onSelect } = {}) {
      return openPanel({ anchor, title, kind: 'context-menu' + (selection ? ' select-popover' : ''), populate(panel, choose) {
        let selected, submenu;
        for (const item of items) {
          const button = make('button', 'popover-menu-item' + (item.danger ? ' danger' : '') + (item.selected ? ' is-selected' : ''), item.label);
          if (item.icon || item.danger) button.setAttribute('data-ui-icon', item.icon || 'trash');
          button.setAttribute('role', selection ? 'menuitemradio' : 'menuitem');
          if (selection) {
            button.setAttribute('aria-checked', String(Boolean(item.selected)));
            if (item.selected) {
              selected = button;
              const check = make('span', 'popover-option-check');
              check.setAttribute('data-ui-icon', 'check');
              check.setAttribute('aria-hidden', 'true');
              button.append(check);
            }
          }
          button.setAttribute('data-menu-id', item.id);
          button.setAttribute('data-option-label', item.label);
          if (item.ariaLabel) button.setAttribute('aria-label', item.ariaLabel);
          button.disabled = Boolean(item.disabled);
          if (item.submenu) submenu = { ...item.submenu, anchor: button };
          else button.addEventListener('click', () => {
            if (button.disabled) return;
            choose(item.id, onSelect ? false : undefined);
            onSelect?.(item.id);
          });
          panel.append(button);
        }
        return { focus: selected?.disabled ? undefined : selected, submenu };
      } });
    },
    close: (restore = true, anchor) => { if (!anchor || current?.anchor === anchor) return current?.close(null, restore); },
  };
})();
