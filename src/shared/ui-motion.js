'use strict';
(() => {
  const reduced = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const running = new WeakMap();
  const animations = new Set();
  const graphRuns = new WeakMap();
  const graphAnimations = new Set();
  const detailState = new WeakMap();
  const showRuns = new WeakMap();
  const styleOwners = new WeakMap();
  let transitionId = 0;
  let activeTransition = null;
  let sidebarCopies = [];
  const easing = 'cubic-bezier(.2,.75,.25,1)';
  const visible = element => Boolean(element?.isConnected && element.getClientRects?.().length && getComputedStyle(element).display !== 'none');
  function animate(element, frames, options = {}, label = 'change') {
    if (!element?.animate || reduced() || !element.isConnected) return Promise.resolve();
    running.get(element)?.cancel();
    const animation = element.animate(frames, { duration: 180, easing, fill: 'both', ...options });
    animations.add(animation);
    running.set(element, animation); element.dataset.uiMotion = label;
    return animation.finished.catch(() => {}).finally(() => {
      animations.delete(animation); if (running.get(element) === animation) { running.delete(element); delete element.dataset.uiMotion; animation.cancel(); }
    });
  }
  function enter(element, { kind = 'reveal' } = {}) {
    if (!visible(element)) return Promise.resolve();
    const above = element.dataset.uiPlacement === 'top';
    const start = kind === 'scrim' ? 'none' : kind === 'sidebar' ? 'translateX(-20px)' : kind === 'dialog' ? 'translateY(12px) scale(.97)' : kind === 'popover' ? `translateY(${above ? 6 : -6}px) scale(.98)` : 'translateY(6px)';
    if (kind === 'popover') element.style.transformOrigin = above ? 'bottom left' : 'top left';
    return animate(element, [{ opacity: 0, transform: start }, { opacity: 1, transform: 'none' }], { duration: kind === 'sidebar' ? 220 : kind === 'dialog' ? 220 : 180 }, kind + '-enter');
  }
  function exit(element, { kind = 'reveal' } = {}) {
    if (!visible(element)) return Promise.resolve();
    const end = kind === 'scrim' ? 'none' : kind === 'sidebar' ? 'translateX(-20px)' : kind === 'dialog' ? 'translateY(8px) scale(.98)' : kind === 'popover' ? `translateY(${element.dataset.uiPlacement === 'top' ? 5 : -5}px) scale(.98)` : 'translateY(-4px)';
    const current = getComputedStyle(element);
    return animate(element, [{ opacity: current.opacity, transform: current.transform }, { opacity: 0, transform: end }], { duration: kind === 'sidebar' ? 180 : 120 }, kind + '-exit');
  }
  function transition({ from, to, update, guard = () => true, kind = 'page' }) {
    const id = ++transitionId; const previous = activeTransition; activeTransition = null; previous?.skipTransition?.(); delete document.documentElement.dataset.uiTransitionKind;
    const name = kind.startsWith('record') ? 'inmoment-record' : kind === 'text' ? 'inmoment-text' : 'inmoment-page';
    const saved = new Map(); let applied = false;
    const remember = element => { if (element?.style && !saved.has(element)) { const value = styleOwners.get(element)?.original ?? element.style.viewTransitionName; saved.set(element, value); styleOwners.set(element, { id, original:value }); } };
    const restore = () => { for (const [element, value] of saved) if (styleOwners.get(element)?.id === id) { element.style.viewTransitionName = value; styleOwners.delete(element); } if (id === transitionId) { delete document.documentElement.dataset.uiTransitionKind; activeTransition = null; } };
    const commit = () => {
      if (applied || !guard()) return;
      applied = true;
      if (from?.style && styleOwners.get(from)?.id === id) from.style.viewTransitionName = '';
      update();
      const target = typeof to === 'function' ? to() : to;
      if (visible(target)) { remember(target); target.style.viewTransitionName = name; }
    };
    if (reduced() || !document.startViewTransition || !visible(from)) {
      if (guard()) { applied = true; update(); }
      const target = typeof to === 'function' ? to() : to;
      const finished = reduced() ? Promise.resolve() : enter(target, { kind: 'reveal' });
      return { updated: Promise.resolve(), finished, get applied() { return applied; } };
    }
    remember(from); from.style.viewTransitionName = name;
    document.documentElement.dataset.uiTransitionKind = kind;
    try {
      const current = document.startViewTransition(commit); activeTransition = current;
      current.ready?.catch(() => {});
      const updated = current.updateCallbackDone.catch(() => { if (!applied) commit(); });
      const finished = current.finished.catch(() => {}).finally(restore);
      return { updated, finished, get applied() { return applied; }, skip: () => current.skipTransition() };
    } catch {
      commit(); restore(); return { updated: Promise.resolve(), finished: Promise.resolve(), get applied() { return applied; } };
    }
  }
  // Exit snapshots are inert, local DOM copies. Application state changes remain synchronous.
  const snapshotProperties = ['display','box-sizing','width','height','min-width','min-height','max-width','max-height','padding','margin','gap','font','font-family','font-size','font-weight','line-height','letter-spacing','color','background','border','border-radius','box-shadow','flex','flex-direction','flex-wrap','align-items','justify-content','grid-template-columns','grid-template-rows','overflow','white-space','text-align','text-overflow','object-fit','position','top','right','bottom','left','opacity'];
  function snapshot(element, { scrim = false } = {}) {
    if (reduced() || !visible(element)) return null;
    const rect = element.getBoundingClientRect(); const clone = element.cloneNode(true);
    const originals = [element, ...element.querySelectorAll('*')]; const copies = [clone, ...clone.querySelectorAll('*')];
    originals.forEach((original, index) => {
      const copy = copies[index]; const style = getComputedStyle(original);
      for (const property of snapshotProperties) copy.style.setProperty(property, style.getPropertyValue(property));
      copy.removeAttribute('id'); copy.removeAttribute('autofocus');
      for (const attribute of [...copy.attributes]) if (attribute.name.startsWith('data-') && attribute.name !== 'data-icon') copy.removeAttribute(attribute.name);
      if (copy.matches('audio,video,source')) { copy.removeAttribute('src'); copy.removeAttribute('autoplay'); }
      if (copy.matches('input,textarea')) copy.value = original.value;
    });
    clone.classList.add('ui-motion-snapshot'); clone.setAttribute('aria-hidden', 'true'); clone.inert = true;
    Object.assign(clone.style, { position:'fixed', top:rect.top+'px', left:rect.left+'px', right:'auto', bottom:'auto', width:rect.width+'px', height:rect.height+'px', margin:'0', zIndex:'1000', pointerEvents:'none', overflow:'hidden' });
    let backdrop;
    if (scrim) {
      backdrop = document.createElement('div'); backdrop.className = 'ui-motion-scrim'; backdrop.setAttribute('aria-hidden','true');
      const appearance=getComputedStyle(element,'::backdrop');
      if(appearance.backgroundColor)backdrop.style.backgroundColor=appearance.backgroundColor;
      if(appearance.backdropFilter)backdrop.style.backdropFilter=appearance.backdropFilter;
      document.body.append(backdrop);
    }
    document.body.append(clone);
    clone.scrollTop = element.scrollTop; clone.scrollLeft = element.scrollLeft;
    return { element:clone, backdrop, remove() { clone.remove(); backdrop?.remove(); } };
  }
  function leaveSnapshot(copy, kind = 'reveal') {
    if (!copy) return Promise.resolve();
    if (copy.backdrop) animate(copy.backdrop, [{ opacity:1 }, { opacity:0 }], { duration:120 }, 'scrim-exit');
    return exit(copy.element, { kind }).finally(() => copy.remove());
  }
  function show(element, shown, { kind = 'reveal' } = {}) {
    if (!element) return;
    const wasVisible = visible(element); const wasHidden = element.classList.contains('hidden');
    if (wasHidden === !shown) return;
    const copy = !shown && wasVisible ? snapshot(element) : null;
    const previous = showRuns.get(element); const overflow = previous?.overflow ?? element.style.overflow;
    running.get(element)?.cancel(); previous?.cleanup();
    const token = { overflow, cleanup() { token.slot?.remove(); token.copy?.remove(); if (showRuns.get(element) === token) { element.style.overflow = overflow; showRuns.delete(element); } } };
    showRuns.set(element, token); token.copy = copy;
    element.classList.toggle('hidden', !shown);
    const expand = element.matches('.record-editor,.inline-title-editor,.primary-group-create-form,.topic-management-selection,[data-motion-region]');
    if (shown && expand && visible(element) && !reduced()) {
      const height = element.getBoundingClientRect().height; element.style.overflow = 'hidden';
      animate(element, [{ height:'0px', opacity:0 }, { height:height+'px', opacity:1 }], { duration:200 }, 'expand-enter').finally(token.cleanup);
    } else if (shown) enter(element, { kind }).finally(token.cleanup); else {
      let collapse = Promise.resolve();
      if (copy && expand) {
        const slot = document.createElement('div'); slot.setAttribute('aria-hidden','true'); slot.className = 'ui-motion-collapse-slot';
        const height = copy.element.getBoundingClientRect().height; slot.style.height = height+'px'; element.after(slot);
        token.slot = slot;
        collapse = animate(slot, [{ height:height+'px' }, { height:'0px' }], { duration:160 }, 'expand-exit');
      }
      Promise.all([leaveSnapshot(copy, kind), collapse]).finally(token.cleanup);
    }
  }
  function sidebar(open) {
    const element = document.querySelector('.library-sidebar');
    if (document.body.classList.contains('group-sidebar-open') === open) return;
    for (const copy of sidebarCopies) copy?.remove(); sidebarCopies = [];
    if (!window.matchMedia?.('(max-width: 900px)').matches) { document.body.classList.toggle('group-sidebar-open', open); return; }
    const copy = !open ? snapshot(element) : null;
    const backdrop = document.querySelector('.group-sidebar-backdrop'); const scrim = !open ? snapshot(backdrop) : null;
    if (!open) sidebarCopies = [copy, scrim];
    document.body.classList.toggle('group-sidebar-open', open);
    if (open) { enter(element, { kind:'sidebar' }); enter(backdrop, { kind:'scrim' }); } else { leaveSnapshot(copy, 'sidebar'); leaveSnapshot(scrim, 'scrim'); }
  }
  function details(element) {
    const previous = detailState.get(element); const opening = previous ? !previous.opening : !element.open;
    const height = element.getBoundingClientRect().height;
    running.get(element)?.cancel();
    const overflow = previous?.overflow ?? element.style.overflow;
    const originalHeight = previous?.height ?? element.style.height;
    const token = { opening, overflow, height:originalHeight }; detailState.set(element, token);
    element.open = true;
    const full = element.scrollHeight; const summary = element.querySelector('summary');
    const style = getComputedStyle(element);
    const collapsed = (summary?.getBoundingClientRect().height || 28) + parseFloat(style.paddingTop || 0) + parseFloat(style.paddingBottom || 0) + parseFloat(style.borderTopWidth || 0) + parseFloat(style.borderBottomWidth || 0);
    if (reduced()) { element.open = opening; element.style.overflow = overflow; element.style.height = originalHeight; detailState.delete(element); return; }
    element.style.overflow = 'hidden';
    animate(element, [{ height:height+'px' }, { height:(opening ? full : collapsed)+'px' }], { duration:opening ? 200 : 160 }, opening ? 'details-enter' : 'details-exit').then(() => {
      if (detailState.get(element) !== token) return;
      element.open = opening; element.style.overflow = overflow; element.style.height = originalHeight; detailState.delete(element);
    });
  }
  function viewBox(element, target, { smooth = false } = {}) {
    graphRuns.get(element)?.cancel();
    const start = (element.getAttribute('viewBox') || '').split(/\s+/u).map(Number);
    const apply = values => element.setAttribute('viewBox', values.join(' '));
    if (!smooth || reduced() || start.length !== 4 || !start.every(Number.isFinite)) { apply(target); return; }
    const started = performance.now(); let frame;
    const run = { cancel(finish = false) { if (finish) apply(target); cancelAnimationFrame(frame); graphAnimations.delete(run); graphRuns.delete(element); delete element.dataset.uiMotion; } };
    graphRuns.set(element, run); graphAnimations.add(run); element.dataset.uiMotion = 'graph-zoom';
    const step = now => { const time = Math.min(1, (now - started) / 200), progress = 1 - (1 - time) ** 3; apply(start.map((value, index) => value + (target[index] - value) * progress)); if (time < 1 && !reduced()) frame = requestAnimationFrame(step); else { apply(target); run.cancel(); } };
    frame = requestAnimationFrame(step);
  }
  function imageSize(element, width, height, { smooth = true } = {}) {
    const previous = element.getBoundingClientRect(); element.style.width = width+'px'; element.style.height = height+'px';
    if (!smooth || reduced() || !previous.width) { running.get(element)?.cancel(); return; }
    return animate(element, [{ width:previous.width+'px', height:previous.height+'px' }, { width:width+'px', height:height+'px' }], { duration:180 }, 'image-zoom');
  }
  document.addEventListener('click', event => {
    const summary = event.target.closest?.('summary');
    if (!summary || event.defaultPrevented || event.button > 0 || event.target.closest?.('button,a,input')) return;
    const parent = summary.parentElement;
    if (parent?.tagName !== 'DETAILS') return;
    event.preventDefault(); details(parent);
  });
  function wireDialogs() {
    document.querySelectorAll('dialog').forEach(dialog => {
      let closingCopy;
      const nativeShow = dialog.showModal.bind(dialog); const nativeClose = dialog.close.bind(dialog);
      dialog.showModal = function() { closingCopy?.remove(); closingCopy = null; nativeShow(); enter(dialog, { kind:'dialog' }); };
      dialog.close = function(value) { closingCopy?.remove(); const copy = snapshot(dialog, { scrim:true }); closingCopy = copy; nativeClose(value); leaveSnapshot(copy, 'dialog').finally(() => { if (closingCopy === copy) closingCopy = null; }); };
      if (!['confirm-dialog','group-management-dialog'].includes(dialog.id)) dialog.addEventListener('cancel', event => { if (!event.defaultPrevented) { event.preventDefault(); dialog.close(); } });
    });
  }
  wireDialogs();
  window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', event => { if (event.matches) { for (const animation of animations) animation.cancel(); for (const animation of graphAnimations) animation.cancel(true); activeTransition?.skipTransition?.(); } });
  window.InMomentMotion = { enter, exit, transition, show, sidebar, snapshot, leaveSnapshot, details, viewBox, imageSize, get activeTransition() { return activeTransition; }, reduced };
})();
