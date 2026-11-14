'use strict';

// Serialized into the isolated renderer by Playwright. This measures actual hit
// targets and scroll reachability rather than treating overflow:hidden as a pass.
async function inspectControlReachability() {
  const selector = 'button,input,textarea,select,summary,[role="button"]';
  const controls = [...document.querySelectorAll(selector)];
  const bounds = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const displayed = element => {
    if (!element.getClientRects().length || element.closest('.ui-motion-snapshot,.ui-motion-scrim,[inert]')) return false;
    for (let item = element; item; item = item.parentElement) {
      const style = getComputedStyle(item);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0 || item.hidden || item.tagName === 'DIALOG' && !item.open) return false;
      if (item.tagName === 'DETAILS' && !item.open && !item.querySelector(':scope > summary')?.contains(element)) return false;
    }
    return true;
  };
  const layers = [...document.querySelectorAll('dialog[open],:popover-open,.select-popover,.confirm-popover,.context-menu,.library-filter-popover')].filter(displayed);
  const modal = layers.findLast(item => item.matches('dialog[open]'));
  const scope = modal || layers.at(-1) || document;
  const snapshot = () => [...document.querySelectorAll('*')].filter(item => item.scrollHeight > item.clientHeight || item.scrollWidth > item.clientWidth).map(item => ({ item, top: item.scrollTop, left: item.scrollLeft }));
  const original = snapshot();
  const current = element => {
    // SVG node groups include a text label outside their intentional circular
    // hit shape. Measure that actual shape rather than the group's empty centre.
    const target = element.namespaceURI === 'http://www.w3.org/2000/svg' ? element.querySelector('.cloud-node-hit,[data-hit-target]') || element : element;
    const rect = bounds(target), clippedBy = [], scrolling = [];
    let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), r = parent.getBoundingClientRect();
      const x = /^(auto|scroll|hidden|clip)$/u.test(style.overflowX), y = /^(auto|scroll|hidden|clip)$/u.test(style.overflowY);
      if (x) { clip.left = Math.max(clip.left, r.left); clip.right = Math.min(clip.right, r.right); }
      if (y) { clip.top = Math.max(clip.top, r.top); clip.bottom = Math.min(clip.bottom, r.bottom); }
      if (x || y) clippedBy.push({ name: parent.id || parent.className || parent.tagName, x, y, overflowX: style.overflowX, overflowY: style.overflowY, rect: bounds(parent) });
      if (/^(auto|scroll)$/u.test(style.overflowX) && parent.scrollWidth > parent.clientWidth + 1 || /^(auto|scroll)$/u.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1) scrolling.push(parent.id || parent.className || parent.tagName);
    }
    const within = rect.left >= clip.left - 1 && rect.right <= clip.right + 1 && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1;
    const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2, hit = document.elementFromPoint(x, y);
    return { rect, clip, within, scrolling, clippedBy, hit: hit?.id || hit?.className || hit?.tagName || null, hitTarget: hit === element || Boolean(hit && element.contains(hit)) };
  };
  const results = [];
  try {
    for (const [index, element] of controls.entries()) {
      if (!displayed(element) || scope !== document && !scope.contains(element)) continue;
      const before = current(element);
      if (!before.rect.width || !before.rect.height) continue;
      const label = element.getAttribute('aria-label') || element.textContent.trim() || element.id || element.tagName;
      let after = before, revealed = false;
      // Normal long lists and settings are allowed to scroll. Actually reveal
      // their controls before judging clipping, then restore every scroll offset.
      if (!before.within && before.scrolling.length) {
        element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        await new Promise(resolve => requestAnimationFrame(resolve));
        after = current(element); revealed = true;
      }
      results.push({ index, label: label.slice(0, 80), id: element.id || null, disabled: element.disabled === true, revealed, before, after, reachable: after.within && after.hitTarget });
    }
  } finally {
    for (const value of original) { value.item.scrollTop = value.top; value.item.scrollLeft = value.left; }
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  return { viewport: { width: innerWidth, height: innerHeight }, totalDOMControls: controls.length, scopedControls: results.length, scope: scope === document ? 'document' : scope.id || scope.className || scope.tagName, controls: results, failures: results.filter(item => !item.reachable) };
}

module.exports = { inspectControlReachability };
