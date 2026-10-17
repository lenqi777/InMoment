'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A synthetic SVG/DOM boundary exercises cloud interaction without loading a model.
function cloudHarness() {
  const nodes = new Map();
  const element = tag => {
    const value = {
      tag, namespaceURI: 'http://www.w3.org/2000/svg', children: [], attributes: {}, style: {}, handlers: {}, className: '',
      append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this; } },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      setAttribute(name, content) { this.attributes[name] = String(content); },
      getAttribute(name) { return this.attributes[name]; },
      addEventListener(name, callback) { (this.handlers[name] ||= []).push(callback); },
      setPointerCapture() {},
      getBoundingClientRect() { return { width: 1000, height: 600 }; },
      closest(selector) { const attribute = selector.slice(1, -1); for (let item = this; item; item = item.parentElement) if (Object.hasOwn(item.attributes, attribute)) return item; return null; },
      querySelectorAll(selector) { const attribute = selector.slice(1, -1), result = []; const walk = item => { if (Object.hasOwn(item.attributes, attribute)) result.push(item); item.children.forEach(walk); }; this.children.forEach(walk); return result; },
    };
    value.classList = {
      add(name) { if (!this.contains(name)) value.className = (value.className + ' ' + name).trim(); },
      remove(name) { value.className = value.className.split(/\s+/u).filter(item => item !== name).join(' '); },
      contains(name) { return value.className.split(/\s+/u).includes(name); },
      toggle(name, enabled) { if (enabled ?? !this.contains(name)) this.add(name); else this.remove(name); },
    };
    return value;
  };
  const document = {
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element('div')); return nodes.get(selector); },
    createElement: element,
    createElementNS(namespace, tag) { return element(tag); },
  };
  const window = { inmoment: { subscribe() {}, invoke() { throw new Error('Model and IPC calls are forbidden in this fixture.'); } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/cloud.js'), 'utf8'), { window, document });
  const graph = {
    nodes: [{ id: 'a', title: '做菜时记录调料' }, { id: 'b', title: '制作家常菜' }, { id: 'c', title: '旅行路线' }, { id: 'd', title: '旅行中的散步' }],
    edges: [{ source: 'a', target: 'b', weight: .91 }, { source: 'c', target: 'd', weight: .89 }],
    communities: [{ members: ['a', 'b'] }, { members: ['c', 'd'] }],
  };
  window.InMomentCloud.render(graph);
  const svg = nodes.get('#thought-cloud-root').children[0];
  const emit = (target, name, fields = {}) => { for (const handler of target.handlers[name] || []) handler({ target, currentTarget: target, preventDefault() {}, stopPropagation() {}, ...fields }); };
  const node = id => svg.querySelectorAll('[data-cloud-id]').find(item => item.getAttribute('data-cloud-id') === id);
  const pointer = (name, x, y, extra = {}) => emit(svg, name, { button: 0, pointerId: 1, clientX: x, clientY: y, ...extra });
  return { nodes, svg, emit, node, pointer };
}

test('clicking cloud blank space restores all nodes and edges without changing zoom or position', () => {
  const ui = cloudHarness();
  ui.emit(ui.node('a'), 'click');
  assert.equal(ui.node('c').style.opacity, '.17');
  assert.equal(ui.svg.querySelectorAll('[data-cloud-edge]')[1].style.opacity, '.08');
  ui.emit(ui.svg, 'wheel', { deltaY: -150 });
  const before = ui.svg.getAttribute('viewBox');
  ui.pointer('pointerdown', 310, 220);
  ui.pointer('pointermove', 312, 221);
  ui.pointer('pointerup', 312, 221);
  ui.emit(ui.svg, 'click');
  assert.equal(ui.svg.getAttribute('viewBox'), before);
  assert.equal(ui.nodes.get('#cloud-selection').classList.contains('hidden'), true);
  assert.deepEqual(ui.svg.querySelectorAll('[data-cloud-id]').map(item => item.style.opacity), ['1', '1', '1', '1']);
  assert.deepEqual(ui.svg.querySelectorAll('[data-cloud-edge]').map(item => item.style.opacity), ['.4', '.4']);
});

test('dragging the cloud pans while retaining selection and ignores its following click', () => {
  const ui = cloudHarness();
  ui.emit(ui.node('a'), 'click');
  const before = ui.svg.getAttribute('viewBox');
  ui.pointer('pointerdown', 300, 220);
  ui.pointer('pointermove', 370, 260);
  ui.pointer('pointerup', 370, 260);
  ui.emit(ui.svg, 'click');
  assert.notEqual(ui.svg.getAttribute('viewBox'), before);
  assert.equal(ui.nodes.get('#cloud-selection').classList.contains('hidden'), false);
  assert.equal(ui.node('c').style.opacity, '.17');
  ui.pointer('pointerdown', 370, 260);
  ui.pointer('pointerup', 370, 260);
  ui.emit(ui.svg, 'click');
  assert.equal(ui.node('c').style.opacity, '1');
});

test('cancelled cloud pointer actions retain selection; a later blank click clears it', () => {
  const ui = cloudHarness();
  ui.emit(ui.node('a'), 'click');
  ui.pointer('pointerdown', 310, 220);
  ui.pointer('pointercancel', 310, 220);
  assert.equal(ui.node('c').style.opacity, '.17');
  ui.emit(ui.svg, 'click');
  assert.equal(ui.node('c').style.opacity, '1');
});

test('clearing a cloud node keeps an explicit title search and uses neutral labels', () => {
  const ui = cloudHarness();
  ui.emit(ui.node('a'), 'click');
  const search = ui.nodes.get('#cloud-search'); search.value = '旅行'; ui.emit(search, 'input');
  ui.emit(ui.svg, 'click');
  assert.equal(ui.node('a').style.opacity, '.12');
  assert.equal(ui.node('c').style.opacity, '1');
  assert.equal(ui.nodes.get('#cloud-selection').classList.contains('hidden'), true);
  for (const item of ui.svg.querySelectorAll('[data-cloud-id]')) for (const label of item.children.filter(child => child.tag === 'text')) assert.equal(label.getAttribute('fill'), '#252525');
});
