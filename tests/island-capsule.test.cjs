'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let now = 10000, receive, timeoutId = 0; const nodes = new Map(), calls = [], intervals = [], brandCalls = [], timeouts = new Map();
  function element() {
    const node = { className: '', children: [], attributes: {}, events: {}, style: {}, scrollHeight: 220, textContent: '',
      append(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
      contains(child) { return this.children.includes(child); },
      setAttribute(key, value) { this.attributes[key] = String(value); }, getAttribute(key) { return this.attributes[key]; }, removeAttribute(key) { delete this.attributes[key]; },
      addEventListener(name, listener) { this.events[name] = listener; } };
    node.classList = { add(name) { if (!this.contains(name)) node.className += ' ' + name; }, remove(name) { node.className = node.className.split(/\s+/u).filter(value => value !== name).join(' '); }, contains(name) { return node.className.split(/\s+/u).includes(name); }, toggle(name, value) { if (value ?? !this.contains(name)) this.add(name); else this.remove(name); } };
    return node;
  }
  const get = selector => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const bars = Array.from({ length: 19 }, element), properties = {}, documentEvents = {};
  const document = { body: { className: '', dataset: {} }, documentElement: { style: { setProperty(name, value) { properties[name] = value; } } },
    querySelector: get, querySelectorAll(selector) { if (selector === '#capsule-waveform>span') return bars; if (selector === '.button') return ['#discard', '#finish', '#ask-ai'].map(get); return []; }, createElement: element, addEventListener(name, listener) { documentEvents[name] = listener; } };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ document, window: { InMomentBrandMorph: { mount(container) { assert.equal(container, get('#capsule-logo')); return { setState(state, options) { brandCalls.push({ state, options }); }, destroy() {} }; } }, getComputedStyle() { return { borderLeftWidth: '1px' }; }, inmoment: { subscribe(listener) { receive = listener; }, invoke(method, params) { calls.push({ method, params }); return new Promise(() => {}); } } }, Date: Clock, performance: { now: () => now }, setInterval(fn) { intervals.push(fn); }, setTimeout(fn, milliseconds) { const id = ++timeoutId; timeouts.set(id, { fn, at: now + milliseconds }); return id; }, clearTimeout(id) { timeouts.delete(id); }, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/overlay/app.js'), 'utf8'), context);
  return { event: value => receive(value), get, bars, properties, calls, brandCalls, timeouts, mode: () => document.body.dataset.mode, draggable: () => document.body.dataset.draggable === 'true', documentEvents, advance(milliseconds) { now += milliseconds; for (const [id, task] of [...timeouts]) if (task.at <= now) { timeouts.delete(id); task.fn(); } intervals.forEach(fn => fn()); }, click(selector) { get(selector).events.click(); } };
}
const session = { id: 'synthetic-session', segmentId: 'synthetic-segment-1', active: true, state: 'recording', mode: 'hold', elapsedMs: 23000 };
const level = value => ({ type: 'audioLevel', id: session.id, segmentId: session.segmentId, level: value, peak: value });
const flat = ui => ui.bars.every(bar => bar.style.height === '3.00px');

test('screenshot recording uses the shared draggable capsule without the upward AI gesture', () => {
  const region = { ...session, triggerKey: 'region-screenshot', mode: 'manual', regionScreenshotOpen: true };
  const ui = harness(); ui.event({ type: 'session', session: region });
  assert.equal(ui.mode(), 'capsule'); assert.equal(ui.draggable(), true);
  assert.equal(ui.get('#capsule-hint').getAttribute('aria-hidden'), 'true');
  assert.doesNotMatch(ui.get('#recording-capsule').getAttribute('aria-label'), /问 AI/u);
  ui.documentEvents.wheel({ deltaY: -100, preventDefault() {} });
  assert.deepEqual(ui.calls.map(call => call.method), ['app:bootstrap']);
  ui.event({ type: 'session', session: { ...region, state: 'paused' } });
  assert.equal(ui.mode(), 'card'); assert.equal(ui.draggable(), true);
  ui.event({ type: 'session', session: region });
  assert.equal(ui.mode(), 'card'); assert.equal(ui.draggable(), true);
  ui.click('#ask-ai'); assert.equal(ui.calls.at(-1).method, 'chat:openFloating');
});

test('closing the screenshot expands the recording without resetting its active segment clock', () => {
  const ui = harness();
  const region = { ...session, mode: 'manual', triggerKey: 'region-screenshot', state: 'recording', elapsedMs: 0, recordingStartedAt: 10000, regionScreenshotOpen: true };
  const timer = ui.get('#capsule-timer');
  ui.event({ type: 'session', session: region });
  assert.equal(ui.mode(), 'capsule');
  ui.advance(3400);
  assert.equal(timer.textContent, '00:03');
  // Saving the image may publish a status update before the screenshot closes.
  ui.event({ type: 'session', session: { ...region, captureStatus: 'captured' } });
  assert.equal(timer.textContent, '00:03');
  ui.event({ type: 'session', session: { ...region, regionScreenshotOpen: false } });
  assert.equal(ui.mode(), 'card');
  assert.equal(timer.textContent, '00:03');
  assert.equal(ui.get('#capsule-logo').getAttribute('aria-label'), '暂停录音');
  ui.advance(700);
  assert.equal(timer.textContent, '00:04');
  ui.event({ type: 'session', session: { ...region, regionScreenshotOpen: false, state: 'paused', elapsedMs: 4100 } });
  ui.advance(3000);
  assert.equal(timer.textContent, '00:04');
  const resumed = { ...region, regionScreenshotOpen: false, segmentId: 'next-segment', recordingStartedAt: 17100, elapsedMs: 4100 };
  ui.event({ type: 'session', session: resumed });
  assert.equal(ui.mode(), 'card');
  ui.advance(1000);
  assert.equal(timer.textContent, '00:05');
});

test('opening the overlay during an active segment uses its original start time', () => {
  const ui = harness();
  ui.advance(3150);
  ui.event({ type: 'session', session: { ...session, recordingStartedAt: 10000, elapsedMs: 0 } });
  assert.equal(ui.get('#capsule-timer').textContent, '00:03');
});

test('compact header contains only its morph button, waveform and timer without nested buttons', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/overlay/index.html'), 'utf8');
  const inner = /<div id="recording-capsule"[^>]*>([\s\S]*?)<\/div>/u.exec(html)?.[1]; assert.ok(inner);
  let depth = 0, direct = 0;
  for (const token of inner.matchAll(/<\/?(span|button)\b[^>]*>/gu)) { if (token[0].startsWith('</')) depth--; else { if (depth === 0) direct++; depth++; } }
  assert.equal(direct, 3); assert.match(inner, /id="capsule-logo"/u); assert.match(inner, /id="capsule-waveform"/u); assert.match(inner, /id="capsule-timer"/u);
  assert.doesNotMatch(inner, /id="(?:capsule-label|capsule-pause|capsule-hint)"|正在听|向上滚动/u);
  assert.equal((inner.match(/<button\b/gu) || []).length, 1); assert.doesNotMatch(html, /capture-toggle/u);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../src/overlay/styles.css'), 'utf8'), /@keyframes|animation\s*:/u);
});

test('only active session and segment PCM levels drive the waveform and logo energy', () => {
  const ui = harness(); ui.event({ type: 'session', session }); assert.equal(ui.mode(), 'capsule'); assert.equal(flat(ui), true);
  ui.event({ ...level(1), id: 'another-session' }); ui.event({ ...level(1), segmentId: 'old-segment' }); assert.equal(flat(ui), true); assert.equal(ui.properties['--audio-energy'], '0.000');
  for (const value of [.1, .8, .2, .5, .9, .35, .7, .15, .65]) ui.event(level(value));
  assert.ok(ui.bars.some(bar => Number.parseFloat(bar.style.height) > 20)); assert.ok(new Set(ui.bars.map(bar => bar.style.height)).size > 4); assert.equal(ui.properties['--audio-energy'], '0.650');
  assert.deepEqual(ui.calls.map(call => call.method), ['app:bootstrap']);
});

test('pause clears the waveform and manual continuation keeps the panel with its pause toggle', () => {
  const ui = harness(); ui.event({ type: 'session', session }); ui.event(level(.9));
  ui.event({ type: 'session', session: { ...session, state: 'paused', mode: 'manual' } }); assert.equal(ui.mode(), 'card'); assert.equal(flat(ui), true);
  ui.event(level(1)); assert.equal(flat(ui), true);
  const continued = { ...session, segmentId: 'synthetic-segment-2', mode: 'manual' }; ui.event({ type: 'session', session: continued }); assert.equal(ui.mode(), 'card');
  ui.event(level(1)); assert.equal(flat(ui), true); ui.event({ ...level(.7), segmentId: continued.segmentId }); assert.equal(flat(ui), false);
  assert.equal(ui.get('#capsule-logo').getAttribute('aria-label'), '暂停录音');
  ui.click('#capsule-logo'); assert.equal(ui.calls.at(-1).method, 'draft:pause');
});

test('silence and a suspended PCM source cannot leave a fake animated waveform', () => {
  const ui = harness(); ui.event({ type: 'session', session }); for (let i = 0; i < 19; i++) ui.event(level(.85)); assert.equal(flat(ui), false);
  for (let i = 0; i < 19; i++) ui.event(level(0)); assert.equal(flat(ui), true); assert.equal(ui.properties['--audio-energy'], '0.000');
  ui.event(level(.95)); assert.equal(flat(ui), false); ui.advance(300); assert.equal(flat(ui), true);
  ui.event({ ...level(Number.NaN) }); ui.event({ ...level(.7), peak: Infinity }); assert.equal(flat(ui), true);
});

test('hold preview preserves the original horizontal progress phase before the recording capsule', () => {
  const ui = harness(); ui.event({ type: 'holdProgress', phase: 'start', thresholdMs: 550 });
  assert.equal(ui.mode(), 'progress'); assert.equal(ui.get('#recording-capsule').getAttribute('aria-hidden'), 'true'); assert.equal(ui.get('#hold-progress').getAttribute('aria-hidden'), 'false'); assert.equal(ui.get('#capsule-logo').disabled, true); assert.equal(flat(ui), true);
  ui.event({ type: 'holdProgress', phase: 'complete' }); assert.equal(ui.mode(), 'capsule');
  assert.deepEqual(ui.calls.map(call => call.method), ['app:bootstrap']);
  ui.event({ type: 'session', session: { ...session, state: 'preparing', elapsedMs: 0 } }); assert.equal(ui.mode(), 'capsule'); assert.equal(flat(ui), true);
  ui.event({ type: 'session', session: { ...session, active: false, state: 'saved' } }); assert.equal(ui.mode(), 'hidden'); assert.equal(flat(ui), true);
});

test('round logo mounts the shared contour morph and overlay palette follows shared light tokens', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/overlay/index.html'), 'utf8'), css = fs.readFileSync(path.join(__dirname, '../src/overlay/styles.css'), 'utf8');
  const svg = fs.readFileSync(path.join(__dirname, '../src/assets/icon-circle.svg'), 'utf8');
  assert.match(html, /src="\.\.\/shared\/brand-morph\.js"/u); assert.match(html, /<button id="capsule-logo"/u);
  assert.match(svg, /<circle cx="16" cy="16" r="16"/u); assert.match(svg, /<g id="letterform">/u); assert.match(svg, /<path fill="#F5EDCF"/u);
  assert.match(css, /background:var\(--panel\)/u); assert.doesNotMatch(css, /--island-|conic-gradient|#080A09/iu);
  const logoStyle = /\.capsule-logo \{([^}]+)\}/u.exec(css)[1], svgStyle = /\.capsule-logo svg \{([^}]+)\}/u.exec(css)[1];
  assert.doesNotMatch(logoStyle, /overflow:hidden|transform:/u); assert.match(svgStyle, /width:28px; height:28px/u);
  assert.match(css, /\.mode-progress \.capture-panel[^\n]+width:154px; height:14px/u); assert.match(css, /\.mode-progress \.hold-progress \{ opacity:1; visibility:visible;/u);
});

test('opening chat freezes compact audio and errors always expand into a visible panel', () => {
  const ui = harness(); ui.event({ type: 'session', session }); ui.event(level(.9));
  ui.event({ type: 'overlayChat', phase: 'start' }); assert.equal(ui.mode(), 'capsule'); assert.equal(flat(ui), true); assert.equal(ui.get('#recording-capsule').getAttribute('aria-label'), '正在打开聊天');
  ui.event(level(1)); assert.equal(flat(ui), true);
  ui.event({ type: 'error', message: '合成的本地组件错误' }); assert.equal(ui.mode(), 'card'); assert.equal(ui.get('#error-message').classList.contains('hidden'), false); assert.equal(ui.get('#card-content').getAttribute('aria-hidden'), 'false');
});

test('long elapsed time remains tabular text and cannot add visible compact status labels', () => {
  const ui = harness(); ui.event({ type: 'session', session: { ...session, state: 'paused', elapsedMs: 7381000 } });
  assert.equal(ui.get('#capsule-timer').textContent, '123:01'); assert.equal(ui.mode(), 'card');
});

test('shared header stays visible when paused, and one icon button resumes the draft', () => {
  const ui = harness(); ui.event({ type: 'session', session: { ...session, state: 'paused', triggerKey: 'F8' } });
  assert.equal(ui.get('#recording-capsule').getAttribute('aria-hidden'), 'false');
  assert.equal(ui.get('#capsule-logo').disabled, false);
  assert.equal(ui.get('#capsule-logo').getAttribute('aria-label'), '继续录音');
  assert.equal(ui.brandCalls.at(-1).state, 'play');
  ui.click('#capsule-logo'); assert.equal(ui.calls.at(-1).method, 'draft:continue');
  const html = fs.readFileSync(path.join(__dirname, '../src/overlay/index.html'), 'utf8');
  assert.doesNotMatch(html, /id="(?:orb|timer|status-title|status-description|mode-label|continue|pause)"/u);
  assert.equal((html.match(/id="capsule-logo"/gu) || []).length, 1);
});

test('one draft morphs logo to play then pause and never returns to brand during chat transitions', () => {
  const ui = harness(); ui.event({ type: 'session', session }); assert.equal(ui.brandCalls.at(-1).state, 'logo');
  const firstPause = ui.brandCalls.length;
  for (const state of ['paused', 'preparing', 'recording', 'paused']) ui.event({ type: 'session', session: { ...session, state, mode: 'manual' } });
  assert.deepEqual(ui.brandCalls.slice(firstPause).map(call => call.state), ['play', 'pause', 'play']);
  const count = ui.brandCalls.length; ui.event({ type: 'overlayChat', phase: 'start' }); ui.event({ type: 'overlayChat', phase: 'cancel' });
  assert.equal(ui.brandCalls.length, count); assert.equal(ui.get('#recording-capsule').events.click, undefined);
  ui.event({ type: 'session', session: { ...session, active: false, state: 'saved' } });
  ui.event({ type: 'holdProgress', phase: 'start' }); assert.equal(ui.brandCalls.at(-1).state, 'logo'); assert.equal(ui.brandCalls.at(-1).options.immediate, true);
});

test('manual prepare, record and pause keep the card and preserve expanded group selection', () => {
  const ui = harness(); ui.event({ type: 'session', session: { ...session, state: 'paused', mode: 'manual' } });
  ui.get('#draft-topics').open = true;
  for (const state of ['preparing', 'recording', 'paused']) {
    ui.event({ type: 'session', session: { ...session, state, mode: 'manual', rawState: state === 'preparing' ? 'ARMING_MANUAL' : state === 'recording' ? 'RECORDING_MANUAL' : 'PAUSED' } });
    assert.equal(ui.mode(), 'card'); assert.equal(ui.get('#draft-topics').open, true);
    assert.equal(ui.get('#draft-topics').classList.contains('hidden'), false);
  }
  ui.event({ type: 'session', session: { ...session, id: 'new-draft', state: 'paused', mode: 'manual' } });
  assert.equal(ui.get('#draft-topics').open, false);
});

test('capsule hint expires once per draft and is available on whole-panel hover and focus', () => {
  const ui = harness(), hint = ui.get('#capsule-hint'), panel = ui.get('.capture-panel');
  ui.event({ type: 'session', session }); assert.equal(hint.classList.contains('is-visible'), true);
  ui.advance(2199); assert.equal(hint.getAttribute('aria-hidden'), 'false');
  ui.advance(2); assert.equal(hint.classList.contains('is-visible'), false);
  ui.event({ type: 'session', session }); assert.equal(hint.classList.contains('is-visible'), false);
  panel.events.pointerenter(); assert.equal(hint.classList.contains('is-visible'), true);
  panel.events.pointerleave(); assert.equal(hint.classList.contains('is-visible'), false);
  panel.events.focusin(); assert.equal(hint.classList.contains('is-visible'), true);
  panel.events.focusout({ relatedTarget: null }); assert.equal(hint.classList.contains('is-visible'), false);
});

test('hint callbacks cannot affect a newer draft and handoff cancels its intro timer immediately', () => {
  const ui = harness(), hint = ui.get('#capsule-hint'); ui.event({ type: 'session', session });
  const stale = [...ui.timeouts.values()][0].fn;
  ui.event({ type: 'session', session: { ...session, id: 'new-draft' } }); stale(); assert.equal(hint.classList.contains('is-visible'), true);
  ui.get('.capture-panel').events.pointerenter(); ui.event({ type: 'overlayChat', phase: 'start' });
  assert.equal(ui.timeouts.size, 0); assert.equal(hint.classList.contains('is-visible'), false); assert.equal(hint.classList.contains('handoff-hidden'), true);
  ui.advance(10000); assert.equal(hint.classList.contains('is-visible'), false);
  ui.event({ type: 'session', session: { ...session, active: false, state: 'saved' } }); assert.equal(hint.getAttribute('aria-hidden'), 'true');
});
