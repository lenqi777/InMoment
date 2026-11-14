'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

function iconsHarness() {
  class Text {
    constructor(value) { this.nodeType = 3; this.textContent = value; this.parentElement = null; }
    remove() { if (this.parentElement) this.parentElement.childNodes = this.parentElement.childNodes.filter(item => item !== this); this.parentElement = null; }
  }
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag; this.nodeType = 1; this.attributes = new Map(); this.childNodes = []; this.parentElement = null; this.dataset = {};
      this.className = ''; this.styles = {}; this.style = { setProperty: (name, value) => { this.styles[name] = value; } };
      this.classList = { contains: name => this.className.split(/\s+/u).includes(name), add: name => { if (!this.classList.contains(name)) this.className = (this.className + ' ' + name).trim(); }, remove: name => { this.className = this.className.split(/\s+/u).filter(item => item !== name).join(' '); } };
    }
    get children() { return this.childNodes.filter(item => item instanceof Element); }
    get textContent() { return this.childNodes.map(item => item.textContent).join(''); }
    set textContent(value) { for (const child of this.childNodes) child.parentElement = null; this.childNodes = []; const text = new Text(String(value)); text.parentElement = this; this.childNodes.push(text); }
    get isConnected() { return this === document.documentElement || Boolean(this.parentElement?.isConnected); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(child) { child.remove?.(); child.parentElement = this; this.childNodes.push(child); }
    prepend(child) { child.remove?.(); child.parentElement = this; this.childNodes.unshift(child); }
    remove() { if (this.parentElement) this.parentElement.childNodes = this.parentElement.childNodes.filter(item => item !== this); this.parentElement = null; }
    matches(selector) {
      if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
      if (selector === '[data-ui-icon]') return this.hasAttribute('data-ui-icon');
      if (selector === '.primary-group-navigation button') return this.tagName === 'button' && Boolean(this.parentElement?.classList.contains('primary-group-navigation'));
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      return false;
    }
    querySelectorAll(selector) { const result = []; const walk = parent => { for (const child of parent.children) { if (child.matches(selector)) result.push(child); walk(child); } }; walk(this); return result; }
  }
  const observers = [];
  const document = { createElement: tag => new Element(tag), querySelectorAll: selector => document.documentElement.querySelectorAll(selector) };
  document.documentElement = new Element('html'); document.body = new Element('body'); document.documentElement.append(document.body);
  const add = (text, icon, className = '') => { const button = new Element('button'); button.textContent = text; button.className = className; if (icon) button.setAttribute('data-ui-icon', icon); document.body.append(button); return button; };
  const first = add('AI 总结', 'sparkle');
  const window = {};
  const context = vm.createContext({ window, document, Element, Node: { TEXT_NODE: 3 }, MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/shared/ui-icons.js'), 'utf8'), context);
  return { first, add, window, document, flush(target, addedNodes = []) { for (const callback of observers) callback([{ target, addedNodes }]); } };
}
const iconChildren = element => element.children.filter(item => item.classList.contains('ui-action-icon'));

test('icon hydration preserves labels and repeated refresh keeps one decorative pair of layers', () => {
  const ui = iconsHarness(); const button = ui.first;
  assert.equal(button.textContent, 'AI 总结'); assert.equal(iconChildren(button).length, 1);
  const icon = iconChildren(button)[0]; assert.equal(icon.getAttribute('aria-hidden'), 'true'); assert.deepEqual(icon.children.map(item => item.className), ['ui-icon-outline', 'ui-icon-solid']);
  for (let index = 0; index < 5; index += 1) ui.window.InMomentIcons.refresh(button);
  assert.equal(iconChildren(button).length, 1); assert.equal(button.textContent, 'AI 总结');
  assert.notEqual(icon.styles['--ui-icon-outline'], icon.styles['--ui-icon-solid']);
});

test('busy text and restored text survive MutationObserver rehydration without duplication', () => {
  const ui = iconsHarness(); const button = ui.first;
  for (const label of ['正在总结…', 'AI 总结', '重试 AI 总结']) {
    button.textContent = label; ui.flush(button);
    assert.equal(button.textContent, label); assert.equal(iconChildren(button).length, 1);
    ui.flush(button, iconChildren(button)); assert.equal(button.textContent, label); assert.equal(iconChildren(button).length, 1);
  }
});

test('dynamic icon changes reuse the component and removing an action icon preserves its text', () => {
  const ui = iconsHarness(); const button = ui.add('静音录音', 'volume'); ui.flush(ui.document.body, [button]);
  const icon = iconChildren(button)[0]; const outline = icon.styles['--ui-icon-outline'];
  button.setAttribute('data-ui-icon', 'volume-off'); button.textContent = '取消静音'; ui.flush(button);
  assert.equal(button.textContent, '取消静音'); assert.equal(iconChildren(button).length, 1); assert.equal(iconChildren(button)[0].dataset.icon, 'volume-off'); assert.notEqual(iconChildren(button)[0].styles['--ui-icon-outline'], outline);
  button.removeAttribute('data-ui-icon'); ui.flush(button); assert.equal(iconChildren(button).length, 0); assert.equal(button.textContent, '取消静音');
});

test('automatic menu icons replace only their symbol while group names and counts remain intact', () => {
  const ui = iconsHarness(); const more = ui.add('…', null, 'record-actions-toggle'); more.setAttribute('aria-label', '更多操作：阅读笔记'); ui.flush(ui.document.body, [more]);
  assert.equal(more.textContent, ''); assert.equal(more.getAttribute('aria-label'), '更多操作：阅读笔记'); assert.equal(more.getAttribute('data-ui-icon'), 'more'); assert.equal(iconChildren(more).length, 1);
  const groupList = ui.document.createElement('nav'); groupList.className = 'primary-group-navigation'; ui.document.body.append(groupList);
  const group = ui.document.createElement('button'); group.textContent = '阅读与思考 12'; groupList.append(group); ui.flush(groupList, [group]);
  assert.equal(group.textContent, '阅读与思考 12'); assert.equal(group.getAttribute('data-ui-icon'), 'folder'); assert.equal(iconChildren(group).length, 1);
});

test('the shipped catalog contains complete independent regular and filled source assets with matching hashes', () => {
  const directory = path.join(__dirname, '..', 'src/assets/ui-icons'); const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.library, 'Microsoft Fluent UI System Icons'); assert.equal(manifest.license.spdx, 'MIT'); assert.ok(Object.keys(manifest.assets).length >= 30);
  for (const [name, entry] of Object.entries(manifest.assets)) {
    assert.notEqual(entry.regular.filename, entry.filled.filename, name + ': separate artwork files');
    let regular;
    for (const state of ['regular', 'filled']) {
      const asset = entry[state]; const bytes = fs.readFileSync(path.join(directory, asset.filename)); const svg = bytes.toString('utf8');
      assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, name + '/' + state + ': published source hash');
      assert.match(asset.filename, new RegExp('_' + state + '\\.svg$')); assert.ok(asset.source.includes('/' + manifest.commit + '/'), name + '/' + state + ': pinned upstream revision');
      const viewBox = svg.match(/viewBox="([^"]+)"/u)?.[1]; assert.ok(viewBox, name + '/' + state + ': viewBox');
      if (state === 'regular') regular = { svg, viewBox }; else { assert.equal(viewBox, regular.viewBox, name + ': common optical bounds'); if (!entry.identicalUpstreamStates) assert.notEqual(svg, regular.svg, name + ': independent states'); }
    }
  }
});

test('the recording help icon uses the pinned official Question Circle pair', () => {
  const ui = iconsHarness(); const button = ui.add('', 'help'); button.setAttribute('aria-label', '录音说明'); ui.flush(ui.document.body, [button]);
  const icon = iconChildren(button)[0]; assert.ok(icon); assert.equal(icon.getAttribute('aria-hidden'), 'true');
  assert.match(icon.styles['--ui-icon-outline'], /ic_fluent_question_circle_20_regular\.svg/u);
  assert.match(icon.styles['--ui-icon-solid'], /ic_fluent_question_circle_20_filled\.svg/u);
  assert.equal(button.getAttribute('aria-label'), '录音说明');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/assets/ui-icons/manifest.json'), 'utf8'));
  assert.equal(manifest.assets.help.upstreamName, 'Question Circle'); assert.equal(manifest.assets.help.opticalSize, 20);
});
