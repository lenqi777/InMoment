'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness() {
  const animations = [], transitions = [];
  const window = { reduce: false, matchMedia() { return { matches: window.reduce }; } };
  const document = { documentElement: { dataset: {} }, querySelectorAll() { return []; }, addEventListener() {} };
  function element() {
    return { isConnected: true, open: false, scrollHeight: 240, dataset: {}, style: { viewTransitionName: '', overflow: 'visible', height: 'auto' }, getClientRects() { return [{}]; }, getBoundingClientRect() { return { height: 40 }; }, querySelector() { return { getBoundingClientRect() { return { height: 28 }; } }; },
      animate(frames, options) { const done = deferred(); const animation = { frames, options, finished: done.promise, cancelled: false, cancel() { this.cancelled = true; done.reject(new Error('Cancelled')); }, finish() { done.resolve(); } }; animations.push(animation); return animation; } };
  }
  document.startViewTransition = callback => {
    const update = deferred(), finished = deferred(), ready = deferred();
    const transition = { updateCallbackDone: update.promise, ready: ready.promise, finished: finished.promise, skipped: false, skipTransition() { this.skipped = true; ready.reject(new Error('Transition was skipped')); finished.resolve(); }, apply() { try { callback(); update.resolve(); ready.resolve(); } catch (error) { update.reject(error); ready.reject(error); } }, finish() { finished.resolve(); } };
    transitions.push(transition); return transition;
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src/shared/ui-motion.js'), 'utf8'), { window, document, getComputedStyle: () => ({ display: 'block', paddingTop: '4px', paddingBottom: '4px', borderTopWidth: '0px', borderBottomWidth: '0px' }) });
  return { motion: window.InMomentMotion, window, document, element, animations, transitions };
}

test('a newer exit cancels an earlier enter and leaves no animation marker after completion', async () => {
  const ui = harness(), surface = ui.element();
  const entered = ui.motion.enter(surface, { kind: 'popover' }); const exited = ui.motion.exit(surface, { kind: 'popover' });
  assert.equal(ui.animations[0].cancelled, true); await entered; assert.equal(surface.dataset.uiMotion, 'popover-exit');
  ui.animations[1].finish(); await exited; assert.equal(surface.dataset.uiMotion, undefined); assert.equal(surface.isConnected, true);
});

test('reduced motion updates navigation immediately without animation or a transition snapshot', async () => {
  const ui = harness(); ui.window.reduce = true; const from = ui.element(), target = ui.element(); let updates = 0;
  const transition = ui.motion.transition({ from, to: target, update() { updates += 1; }, kind: 'record-open' });
  assert.equal(updates, 1); assert.equal(transition.applied, true); await transition.updated; await transition.finished;
  assert.equal(ui.animations.length, 0); assert.equal(ui.transitions.length, 0); assert.equal(ui.document.documentElement.dataset.uiTransitionKind, undefined);
});

test('rapid newer navigation prevents a skipped older transition from committing stale content', async () => {
  const ui = harness(), from = ui.element(), firstTarget = ui.element(), secondTarget = ui.element(); let current = 1; const committed = [];
  const first = ui.motion.transition({ from, to: firstTarget, guard: () => current === 1, update() { committed.push(1); }, kind: 'record-open' });
  current = 2; const second = ui.motion.transition({ from, to: secondTarget, guard: () => current === 2, update() { committed.push(2); }, kind: 'page' });
  assert.equal(ui.transitions[0].skipped, true); ui.transitions[0].apply(); ui.transitions[1].apply(); await first.updated; await second.updated;
  ui.transitions[1].finish(); await first.finished; await second.finished;
  assert.deepEqual(committed, [2]); assert.equal(ui.document.documentElement.dataset.uiTransitionKind, undefined); assert.equal(ui.motion.activeTransition, null);
  assert.equal(from.style.viewTransitionName, '', 'transition names return to their original values'); assert.equal(firstTarget.style.viewTransitionName, ''); assert.equal(secondTarget.style.viewTransitionName, '');
});

test('switching to reduced motion while details is moving restores its original layout styles', async () => {
  const ui = harness(), detail = ui.element(); ui.motion.details(detail); assert.equal(detail.open, true);
  ui.window.reduce = true; ui.motion.details(detail); for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.equal(detail.open, false); assert.equal(detail.style.overflow, 'visible'); assert.equal(detail.style.height, 'auto'); assert.equal(detail.dataset.uiMotion, undefined);
});

// A local DOM boundary for interrupted disclosure/sidebar and SVG animations.
function surfaceHarness({ wireDialog = false, backdropColor, backdropFilter } = {}) {
  const animations = [], frames = new Map(), mediaListeners = []; let clock = 0, frameId = 0;
  const window = { reduce:false, matchMedia(query) { return { matches:query.includes('max-width') || window.reduce, addEventListener(name, handler) { if (query.includes('prefers-reduced-motion')) mediaListeners.push(handler); } }; } };
  const document = { documentElement:{dataset:{}}, querySelectorAll(selector) { return selector === 'dialog' && wireDialog ? [dialog] : []; }, addEventListener() {}, createElement:make };
  function make(tag = 'div', className = '') {
    const attributes = new Map(); const item = { tagName:tag.toUpperCase(), className, dataset:{}, children:[], isConnected:true, scrollTop:0, scrollLeft:0,
      style:{ overflow:'visible', height:'auto', setProperty(name,value) { this[name] = value; } },
      get attributes() { return [...attributes].map(([name,value]) => ({name,value})); },
      setAttribute(name,value) { attributes.set(name,String(value)); if (name === 'open') this.open = true; }, getAttribute(name) { return attributes.get(name); }, removeAttribute(name) { attributes.delete(name); if (name === 'open') this.open = false; },
      append(...children) { for (const child of children) { child.parentElement = this; child.isConnected = true; this.children.push(child); } },
      remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); },
      after(next) { if (!this.parentElement) return; const siblings = this.parentElement.children; siblings.splice(siblings.indexOf(this)+1,0,next); next.parentElement = this.parentElement; },
      matches(selector) { return selector.split(',').some(part => part.startsWith('.') ? this.classList.contains(part.slice(1)) : part === tag); },
      querySelectorAll() { return []; },
      getClientRects() { return this.classList.contains('hidden') || (tag === 'dialog' && !this.open) || ((this === sidebar || this === backdrop) && !document.body.classList.contains('group-sidebar-open')) ? [] : [{}]; },
      getBoundingClientRect() { return {top:0,left:0,width:300,height:40}; },
      cloneNode() { const copy = make(tag,this.className); Object.assign(copy.style,this.style); for (const [name,value] of attributes) copy.setAttribute(name,value); return copy; },
      addEventListener() {}, showModal() { this.setAttribute('open',''); }, close() { this.removeAttribute('open'); },
      animate(frames,options) { const done = deferred(); const animation = {frames,options,finished:done.promise,cancelled:false,cancel() { this.cancelled = true; done.reject(new Error('Cancelled')); },finish() { done.resolve(); } }; animations.push(animation); return animation; },
    };
    item.classList = { contains(name) { return item.className.split(/\s+/u).includes(name); }, add(name) { if (!this.contains(name)) item.className += ' '+name; }, toggle(name,shown) { const set = new Set(item.className.split(/\s+/u).filter(Boolean)); if (shown ?? !set.has(name)) set.add(name); else set.delete(name); item.className = [...set].join(' '); } };
    return item;
  }
  const sidebar = make('aside','library-sidebar'), backdrop = make('button','group-sidebar-backdrop'), dialog = make('dialog','sample-dialog'); document.body = make('body'); document.body.append(sidebar,backdrop); if (wireDialog) document.body.append(dialog);
  document.querySelector = selector => selector === '.library-sidebar' ? sidebar : selector === '.group-sidebar-backdrop' ? backdrop : null;
  const getComputedStyle = (item,pseudo) => pseudo==='::backdrop'?{backgroundColor:backdropColor,backdropFilter}:{ display:item.classList.contains('hidden') ? 'none' : 'block', opacity:'1', transform:'none', getPropertyValue(name) { return name === 'display' ? 'block' : name === 'height' ? '40px' : name === 'width' ? '300px' : ''; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/shared/ui-motion.js'),'utf8'), { window,document,getComputedStyle,performance:{now:()=>clock},requestAnimationFrame(callback) { frames.set(++frameId,callback); return frameId; },cancelAnimationFrame(id) { frames.delete(id); } });
  return {motion:window.InMomentMotion,window,document,make,sidebar,backdrop,dialog,animations,frames, async settle() { for (const animation of animations) animation.finish(); for (let index=0;index<15;index++) await Promise.resolve(); },advance(ms) {clock=ms;const batch=[...frames.values()];frames.clear();batch.forEach(callback=>callback(clock));},reduce() {window.reduce=true;mediaListeners.forEach(callback=>callback({matches:true}));} };
}

test('rapid disclosure show-hide-show removes obsolete snapshots and restores layout styles', async () => {
  const ui = surfaceHarness(), editor = ui.make('section','record-editor hidden'); ui.document.body.append(editor);
  ui.motion.show(editor,true); ui.motion.show(editor,false); ui.motion.show(editor,true); await ui.settle();
  assert.equal(editor.classList.contains('hidden'),false); assert.equal(editor.style.overflow,'visible'); assert.equal(editor.dataset.uiMotion,undefined);
  assert.equal(ui.document.body.children.some(item=>item.classList.contains('ui-motion-snapshot') || item.classList.contains('ui-motion-collapse-slot')),false);
});

test('reopening the narrow sidebar removes its obsolete closing snapshots immediately', async () => {
  const ui = surfaceHarness(); ui.motion.sidebar(true); await ui.settle(); ui.motion.sidebar(false);
  assert.equal(ui.document.body.children.filter(item=>item.classList.contains('ui-motion-snapshot')).length,2);
  ui.motion.sidebar(true);
  assert.equal(ui.document.body.children.filter(item=>item.classList.contains('ui-motion-snapshot')).length,0,'closing sidebar/scrim copies must not cover a newly opened sidebar');
  await ui.settle(); assert.equal(ui.document.body.classList.contains('group-sidebar-open'),true);
});

test('SVG zoom interruption starts at the displayed viewBox and reduced motion finishes its latest target', () => {
  const ui = surfaceHarness(), graph = ui.make('svg'); graph.setAttribute('viewBox','0 0 100 100');
  ui.motion.viewBox(graph,[0,0,50,50],{smooth:true}); ui.advance(50); const intermediate = graph.getAttribute('viewBox').split(' ').map(Number);
  assert(intermediate[2] < 100 && intermediate[2] > 50);
  ui.motion.viewBox(graph,[10,20,25,25],{smooth:true}); assert.equal(graph.getAttribute('viewBox'),intermediate.join(' '));
  ui.reduce(); assert.equal(graph.getAttribute('viewBox'),'10 20 25 25'); assert.equal(ui.frames.size,0); assert.equal(graph.dataset.uiMotion,undefined);
});

test('reopening a dialog removes the previous closing surface and scrim before its animation finishes', async () => {
  const ui = surfaceHarness({wireDialog:true}); ui.dialog.showModal(); await ui.settle(); ui.dialog.close();
  assert.equal(ui.dialog.open,false); assert.equal(ui.document.body.children.filter(item=>item.classList.contains('ui-motion-snapshot')).length,1);
  assert.equal(ui.document.body.children.filter(item=>item.classList.contains('ui-motion-scrim')).length,1);
  ui.dialog.showModal();
  assert.equal(ui.dialog.open,true); assert.equal(ui.document.body.children.some(item=>item.classList.contains('ui-motion-snapshot') || item.classList.contains('ui-motion-scrim')),false);
  await ui.settle(); assert.equal(ui.dialog.open,true);
});

test('closing an image preview preserves its transparent unblurred backdrop through exit',async()=>{
  const ui=surfaceHarness({wireDialog:true,backdropColor:'rgba(0, 0, 0, 0)',backdropFilter:'none'});ui.dialog.showModal();await ui.settle();ui.dialog.close();
  const closing=ui.document.body.children.find(item=>item.classList.contains('ui-motion-scrim'));
  assert.equal(closing.style.backgroundColor,'rgba(0, 0, 0, 0)');assert.equal(closing.style.backdropFilter,'none');
  await ui.settle();assert.equal(ui.document.body.children.some(item=>item.classList.contains('ui-motion-scrim')),false);
});
