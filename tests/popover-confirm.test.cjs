'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual floating confirmation, including dismissal. No Electron,
// user files, recording or network is involved.
function harness() {
  const matches = (item, selector) => selector === 'button' ? item.tag === 'button' : selector.startsWith('.') ? item.className.split(' ').includes(selector.slice(1)) : false;
  function descendants(item) { return item.children.flatMap(child => [child, ...descendants(child)]); }
  const listeners = {};
  const document = { activeElement: null, createElement: make, addEventListener(name, handler) { (listeners[name] ||= new Set()).add(handler); }, removeEventListener(name, handler) { listeners[name]?.delete(handler); } };
  function make(tag) {
    const item = { tag, children: [], attributes: {}, handlers: {}, style: {}, className: '', textContent: '', disabled: false, isConnected: true,
      append(...items) { for (const child of items) { child.parentElement = this; this.children.push(child); } },
      setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name]; }, removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); },
      querySelectorAll(selector) { return descendants(this).filter(child => matches(child, selector)); },
      contains(child) { return child === this || descendants(this).includes(child); },
      closest() { return null; },
      focus() { document.activeElement = this; },
      getBoundingClientRect() { return tag === 'anchor' ? { left: 750, top: 550, bottom: 580, width: 30, height: 30 } : { width: 300, height: 180 }; },
      showPopover() { this.shown = true; }, hidePopover() { this.shown = false; },
      remove() { this.isConnected = false; this.parentElement.children = this.parentElement.children.filter(child => child !== this); },
      click() { for (const handler of this.handlers.click || []) handler({target:this}); },
    };
    return item;
  }
  document.body = make('body'); const anchor = make('anchor'); document.body.append(anchor);
  const window = { addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ document, window, innerWidth: 800, innerHeight: 600, MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: handler => handler() });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/popovers.js'), 'utf8'), context);
  return { document, anchor, open: options => window.InMomentConfirm.open({anchor, ...options}), panel: () => document.body.children.find(item => item.className.includes('confirm-popover')), emit(name, extra = {}) { for (const handler of [...listeners[name] || []]) handler({ target: document.activeElement, preventDefault() {}, stopPropagation() {}, ...extra }); } };
}

test('delete confirmation is an anchored nonmodal box, focuses cancel, and only explicit confirmation approves', async () => {
  const ui = harness(); const pending = ui.open({title:'删除所选灵感？',message:'只删除选择的两条。',detail:'此操作无法撤销。',confirmLabel:'删除 2 条灵感',danger:true});
  const panel = ui.panel(); assert.equal(panel.shown,true); assert.equal(panel.getAttribute('role'),'dialog'); assert.equal(panel.getAttribute('aria-modal'),'false');
  assert.equal(ui.document.activeElement.getAttribute('data-confirm-action'),'cancel');
  assert.ok(parseFloat(panel.style.left) + 300 <= 800); assert.ok(parseFloat(panel.style.top) + 180 <= 600);
  assert.equal(panel.querySelectorAll('.popover-message')[0].textContent,'只删除选择的两条。');
  panel.querySelectorAll('.popover-confirm-submit')[0].click(); assert.equal(await pending,true); assert.equal(ui.panel(),undefined); assert.equal(ui.document.activeElement,ui.anchor);
});

for (const method of ['outside','escape','cancel','scroll']) test(`floating delete confirmation ${method} dismissal never approves`, async () => {
  const ui=harness(); const pending=ui.open();
  if(method==='outside')ui.emit('pointerdown',{target:ui.document.body});
  if(method==='escape')ui.emit('keydown',{key:'Escape'});
  if(method==='cancel')ui.panel().querySelectorAll('.popover-confirm-cancel')[0].click();
  if(method==='scroll')ui.emit('scroll',{target:ui.document.body});
  assert.equal(await pending,false); assert.equal(ui.panel(),undefined);
});

test('opening another confirmation dismisses the previous one and IME Escape is ignored', async () => {
  const ui=harness();const first=ui.open();const second=ui.open();assert.equal(await first,false);
  ui.emit('keydown',{key:'Escape',isComposing:true});assert.ok(ui.panel());
  ui.panel().querySelectorAll('.popover-confirm-cancel')[0].click();assert.equal(await second,false);
});
