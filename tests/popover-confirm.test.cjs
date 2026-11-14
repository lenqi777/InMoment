'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual floating confirmation, including dismissal. No Electron,
// user files, recording or network is involved.
function harness(options = {}) {
  const matches = (item, selector) => selector === 'button' ? item.tag === 'button' : selector.startsWith('.') ? item.className.split(' ').includes(selector.slice(1)) : false;
  function descendants(item) { return item.children.flatMap(child => [child, ...descendants(child)]); }
  const listeners = {};
  const document = { activeElement: null, createElement: make, addEventListener(name, handler) { (listeners[name] ||= new Set()).add(handler); }, removeEventListener(name, handler) { listeners[name]?.delete(handler); } };
  function make(tag) {
    const item = { tag, children: [], attributes: {}, handlers: {}, style: {}, dataset: {}, className: '', textContent: '', disabled: false, isConnected: true,
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
  const window = { addEventListener() {}, removeEventListener() {}, ...(options.motion ? { InMomentMotion: options.motion } : {}) };
  const context = vm.createContext({ document, window, innerWidth: 800, innerHeight: 600, MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: handler => handler() });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/popovers.js'), 'utf8'), context);
  return { document, anchor, menu:options=>window.InMomentMenus.open({anchor,...options}), closeMenu:()=>window.InMomentMenus.close(), panels:kind=>document.body.children.filter(item=>item.className.includes(kind)), listeners, open: options => window.InMomentConfirm.open({anchor, ...options}), panel: () => document.body.children.find(item => item.className.includes('confirm-popover')), emit(name, extra = {}) { for (const handler of [...listeners[name] || []]) handler({ target: document.activeElement, preventDefault() {}, stopPropagation() {}, ...extra }); } };
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

test('confirmation exit keeps an inert visual surface until animation completion and resolves only once', async () => {
  let finishExit; let exits = 0;
  const ui = harness({ motion: { enter() {}, exit() { exits += 1; return new Promise(resolve => { finishExit = resolve; }); } } });
  let result = 'pending'; const pending = ui.open({ danger: true }).then(value => { result = value; return value; });
  const panel = ui.panel(), confirm = panel.querySelectorAll('.popover-confirm-submit')[0];
  confirm.click(); confirm.click(); await Promise.resolve();
  assert.equal(result, 'pending'); assert.equal(exits, 1); assert.equal(panel.isConnected, true); assert.equal(panel.inert, true); assert.equal(panel.style.pointerEvents, 'none'); assert.equal(panel.getAttribute('aria-hidden'), 'true');
  finishExit(); assert.equal(await pending, true); assert.equal(ui.panel(), undefined); assert.equal(ui.document.activeElement, ui.anchor);
});

test('an older exiting confirmation cannot remove a newer panel or steal its focus', async () => {
  const completions = [];
  const ui = harness({ motion: { enter() {}, exit() { return new Promise(resolve => completions.push(resolve)); } } });
  const first = ui.open({ title: '第一项' }); const oldPanel = ui.panel();
  const second = ui.open({ title: '第二项' });
  const nextPanel = ui.document.body.children.filter(item => item.className.includes('confirm-popover')).at(-1);
  assert.notEqual(nextPanel, oldPanel); const nextCancel = nextPanel.querySelectorAll('.popover-confirm-cancel')[0]; assert.equal(ui.document.activeElement, nextCancel);
  completions[0](); assert.equal(await first, false); assert.equal(nextPanel.isConnected, true); assert.equal(ui.document.activeElement, nextCancel);
  nextCancel.click(); completions[1](); assert.equal(await second, false); assert.equal(ui.panel(), undefined);
});

test('navigating focus elsewhere during confirmation exit keeps the newer focus', async () => {
  let finishExit; const ui = harness({ motion: { enter() {}, exit() { return new Promise(resolve => { finishExit = resolve; }); } } });
  const pending = ui.open(); ui.panel().querySelectorAll('.popover-confirm-cancel')[0].click();
  const newerControl = ui.document.createElement('button'); newerControl.textContent = '新页面操作'; ui.document.body.append(newerControl); newerControl.focus();
  finishExit(); assert.equal(await pending, false); assert.equal(ui.document.activeElement, newerControl);
});

test('Escape during a chosen menu exit cancels its pending child action and removes the temporary key listener',async()=>{
  let finishExit,children=0;const ui=harness({motion:{enter(){},exit(){return new Promise(resolve=>{finishExit=resolve;});}}});
  const pending=ui.menu({items:[{id:'change',label:'修改分组'}]}).then(action=>{if(action==='change')children++;return action;});
  ui.panels('context-menu')[0].querySelectorAll('button')[0].click();
  ui.emit('keydown',{key:'Escape'});finishExit();
  assert.equal(await pending,null);assert.equal(children,0);assert.equal(ui.panels('context-menu').length,0);assert.equal(ui.listeners.keydown.size,0);
});

test('a new panel invalidates a selected action still waiting for the older menu exit',async()=>{
  const exits=[];const ui=harness({motion:{enter(){},exit(){return new Promise(resolve=>exits.push(resolve));}}});
  const first=ui.menu({items:[{id:'change',label:'修改分组'}]});ui.panels('context-menu')[0].querySelectorAll('button')[0].click();
  const second=ui.menu({items:[{id:'other',label:'另一项操作'}]}),next=ui.panels('context-menu').at(-1),nextButton=next.querySelectorAll('button')[0];
  exits[0]();assert.equal(await first,null);assert.equal(next.isConnected,true);assert.equal(ui.document.activeElement,nextButton);
  nextButton.click();exits[1]();assert.equal(await second,'other');assert.equal(ui.listeners.keydown.size,0);
});

test('IME Escape does not revoke a menu choice while its exit is pending',async()=>{
  let finishExit;const ui=harness({motion:{enter(){},exit(){return new Promise(resolve=>{finishExit=resolve;});}}});
  const pending=ui.menu({items:[{id:'change',label:'修改分组'}]});ui.panels('context-menu')[0].querySelectorAll('button')[0].click();
  ui.emit('keydown',{key:'Escape',isComposing:true});finishExit();assert.equal(await pending,'change');
});

test('programmatic close during menu exit revokes the chosen action',async()=>{
  let finishExit;const ui=harness({motion:{enter(){},exit(){return new Promise(resolve=>{finishExit=resolve;});}}});
  const pending=ui.menu({items:[{id:'change',label:'修改分组'}]});ui.panels('context-menu')[0].querySelectorAll('button')[0].click();ui.closeMenu();finishExit();assert.equal(await pending,null);
});

test('an outside click during menu exit cancels its pending action without intercepting the new target',async()=>{
  let finishExit,prevented=false;const ui=harness({motion:{enter(){},exit(){return new Promise(resolve=>{finishExit=resolve;});}}});
  const pending=ui.menu({items:[{id:'change',label:'修改分组'}]});ui.panels('context-menu')[0].querySelectorAll('button')[0].click();
  ui.emit('pointerdown',{target:ui.document.body,preventDefault(){prevented=true;}});finishExit();assert.equal(await pending,null);assert.equal(prevented,false);assert.equal(ui.listeners.pointerdown.size,0);
});
