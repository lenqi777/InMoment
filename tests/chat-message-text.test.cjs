'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { tokenize, limits } = require('../src/shared/chat-message-text.js');
const katex = require('../src/vendor/katex/katex.min.js');
const moduleSource = fs.readFileSync(path.join(__dirname, '../src/shared/chat-message-text.js'), 'utf8');
const formulas = value => tokenize(value).filter(token => token.type === 'math');

class Node {
  constructor(document, tag = '', type = 1, data = '') { this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.nodeType = type; this.nodeValue = type === 3 ? data : null; this.childNodes = []; this.attributes = new Map(); this.className = ''; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.childNodes = []; if (String(value)) this.append(this.ownerDocument.createTextNode(String(value))); }
  get classList() { return { add: name => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), name])].join(' '); } }; }
  append(...nodes) { for (let node of nodes) { if (typeof node === 'string') node = this.ownerDocument.createTextNode(node); node.parentNode = this; this.childNodes.push(node); } }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
  cloneNode(deep) { const copy = new Node(this.ownerDocument, this.tagName, this.nodeType, this.nodeValue); copy.className = this.className; copy.attributes = new Map(this.attributes); if (deep) copy.append(...this.childNodes.map(child => child.cloneNode(true))); return copy; }
  querySelectorAll(selector) { const result = [], match = node => selector.startsWith('[') ? node.hasAttribute(selector.slice(1, -1)) : node.tagName === selector.toUpperCase(); function visit(node) { for (const child of node.childNodes) { if (child.nodeType === 1 && match(child)) result.push(child); visit(child); } } visit(this); return result; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function documentFixture() {
  const document = { createElement: tag => new Node(document, tag), createTextNode: text => new Node(document, '', 3, text), createDocumentFragment: () => new Node(document, '', 11) };
  return document;
}
function browserFixture(render) {
  const calls = [], document = documentFixture();
  const window = { katex: { render(tex, node, options) { calls.push({ tex, node, options }); if (render) render(tex, node, options); else node.append(document.createTextNode('rendered:' + tex)); } } };
  vm.runInNewContext(moduleSource, { window });
  return { api: window.InMomentChatMessageText, document, calls, parent: () => document.createElement('div') };
}
function mathNode(document, source, { display = false } = {}) {
  const node = document.createElement(display ? 'div' : 'span'); node.setAttribute('data-chat-math-source', source);
  node.append(document.createTextNode('visual duplicate'), document.createTextNode('MathML duplicate')); return node;
}
function selectedRange(root, fragment, { start = root, end = root, original = 'native selected text' } = {}) {
  const actions = [];
  const range = { startContainer: start, endContainer: end, cloneRange() { return { ...this }; }, setStartBefore(node) { actions.push(['start', node]); }, setEndAfter(node) { actions.push(['end', node]); }, cloneContents() { return fragment.cloneNode(true); } };
  return { selection: { isCollapsed: false, rangeCount: 1, getRangeAt: () => range, toString: () => original }, actions };
}

test('tokenization preserves source and handles inline and multiline display delimiters before markdown', () => {
  const source = String.raw`比例 **\(\frac{5}{8}\)** 与 $x_1^2$。
\[
\begin{pmatrix}1&2\\3&4\end{pmatrix}
\]
$$a+b=c$$`;
  const result = tokenize(source), math = formulas(source);
  assert.equal(result.map(token => token.source).join(''), source);
  assert.deepEqual(math.map(token => [token.value.trim(), token.display, token.allowed]), [[String.raw`\frac{5}{8}`, false, true], ['x_1^2', false, true], [String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, true, true], ['a+b=c', true, true]]);
  assert.equal(formulas(String.raw`$x ** y$`)[0].value, 'x ** y');
});

test('code, escaped delimiters, currency and unmarked TeX remain literal', () => {
  const source = '```tex\n' + String.raw`\(\frac{5}{8}\) $x$` + '\n```\n`$a$` and ``\\(b\\)``\n' + String.raw`\$5 and \$10; $5 and $10.00; \\(not math\\); \frac{5}{8}`;
  const tokens = tokenize(source);
  assert.equal(tokens.map(token => token.source).join(''), source);
  assert.equal(tokens.filter(token => token.type === 'math').length, 0);
  assert.equal(tokens.filter(token => token.type === 'code').length, 3);
  for (const value of ['$5 and $10', 'USD $20 or $30.50', '$ plain prose $', '$many ordinary words$', String.raw`\$x\$`]) assert.equal(formulas(value).length, 0, value);
  assert.deepEqual(formulas('Cost $5 and $10; example $x^2$').map(token => token.value), ['x^2']);
});

test('streaming incomplete math and code retain raw source until a matching close arrives', () => {
  const partial = String.raw`结果 \(\frac{5}{`;
  assert.equal(formulas(partial).length, 0);
  assert.equal(tokenize(partial).map(token => token.source).join(''), partial);
  assert.equal(formulas(partial + String.raw`8}\)`)[0].value, String.raw`\frac{5}{8}`);
  assert.equal(formulas('`unfinished $x$\nthen $y$').map(token => token.value).join(','), 'y');
  assert.equal(formulas('```tex\n$x$\n').length, 0);
  assert.equal(formulas(String.raw`\[a+b`)[0], undefined);
});

test('source, formula count, formula size and total TeX budgets keep the entire message visible', () => {
  const oversized = String.raw`\(` + 'x'.repeat(limits.formula + 1) + String.raw`\)`, token = formulas(oversized)[0];
  assert.equal(token.allowed, false); assert.equal(token.source, oversized);
  const repeated = String.raw`\(x\) `.repeat(limits.tokens), tokens = tokenize(repeated);
  assert.equal(tokens.map(item => item.source).join(''), repeated);
  assert.ok(tokens.length <= limits.tokens + 1);
  assert.equal(tokens.filter(item => item.type === 'math' && item.allowed).length, limits.formulas);
  const full = Array.from({ length: 10 }, () => String.raw`\(` + 'x'.repeat(limits.formula) + String.raw`\)`).join(' ');
  assert.equal(formulas(full).filter(item => item.allowed).length, limits.math / limits.formula);
  const tail = 'a'.repeat(limits.source) + String.raw`\(tail\)`;
  assert.equal(formulas(tail).length, 0); assert.equal(tokenize(tail).map(item => item.source).join(''), tail);
  const prices = '$1 price '.repeat(15000);
  assert.equal(tokenize(prices).map(item => item.source).join(''), prices);
});

test('safe DOM rendering keeps headings, list lines, bold text, inline code and fenced code', () => {
  const h = browserFixture(), parent = h.parent();
  h.api.render(parent, '# Heading\n\n**Important ' + String.raw`\(x^2\)` + '**\nnext\n- list\n`$code$`\n```js\nconst x = "<img>";\n```\n<img src=x onerror=alert(1)>');
  assert.equal(parent.querySelector('h3').textContent, 'Heading');
  assert.equal(parent.querySelector('strong').querySelector('[data-chat-math-source]').getAttribute('data-chat-math-source'), String.raw`\(x^2\)`);
  assert.equal(parent.querySelectorAll('br').length, 1);
  assert.equal(parent.querySelector('pre').textContent, 'const x = "<img>";');
  assert.equal(parent.querySelectorAll('code')[0].textContent, '$code$');
  assert.equal(parent.querySelectorAll('img').length, 0); assert.match(parent.textContent, /<img src=x onerror=alert\(1\)>/u);
  const list = parent.querySelectorAll('p').find(node => node.className === 'chat-list-line'); assert.equal(list.textContent, '- list');
});

test('math rendering uses safe bounded options and fresh macro state for each formula', () => {
  const macroSnapshots = [], h = browserFixture((tex, node, options) => { macroSnapshots.push(Object.keys(options.macros)); options.macros.test = tex; node.textContent = tex; });
  h.api.render(h.parent(), String.raw`\(a\) and \[b\]`);
  assert.equal(h.calls.length, 2); assert.deepEqual(macroSnapshots, [[], []]);
  for (const { options } of h.calls) { assert.equal(options.trust, false); assert.equal(options.throwOnError, true); assert.equal(options.maxExpand, 200); assert.equal(options.maxSize, 10); assert.equal(options.output, 'htmlAndMathml'); }
  assert.equal(h.calls[0].options.displayMode, false); assert.equal(h.calls[1].options.displayMode, true);
  assert.notEqual(h.calls[0].options.macros, h.calls[1].options.macros);
});

test('real local KaTeX rejects unsafe capabilities and bounded recursive macros with the renderer options', () => {
  const h = browserFixture(); h.api.render(h.parent(), String.raw`\(x\)`); const options = h.calls[0].options;
  for (const input of [String.raw`\href{javascript:alert(1)}{x}`, String.raw`\includegraphics{https://example.invalid/x.png}`, String.raw`\htmlClass{untrusted}{x}`]) {
    const result = katex.renderToString(input, { ...options, macros: {} });
    assert.doesNotMatch(result, /<(?:a|img)(?:\s|>)/u); assert.doesNotMatch(result, /class="untrusted"/u);
  }
  assert.throws(() => katex.renderToString(String.raw`\def\loop{\loop}\loop`, { ...options, macros: {} }), /Too many expansions/u);
  assert.throws(() => katex.renderToString(String.raw`\frac{`, { ...options, macros: {} }), /parse error/u);
  assert.match(katex.renderToString(String.raw`\frac{5}{8}`, { ...options, macros: {} }), /class="mfrac"/u);
});

test('invalid and oversized formulas fall back exactly while a later valid formula still renders', () => {
  const h = browserFixture((tex, node) => { if (tex.includes('invalid')) throw new Error('invalid fixture formula'); node.textContent = tex; });
  const parent = h.parent(), invalid = String.raw`\(invalid{\)`, long = String.raw`\[` + 'x'.repeat(limits.formula + 1) + String.raw`\]`;
  h.api.render(parent, invalid + ' then ' + String.raw`\(x\)` + '\n' + long);
  const math = parent.querySelectorAll('[data-chat-math-source]');
  assert.equal(math[0].textContent, invalid); assert.match(math[0].className, /chat-math-fallback/u);
  assert.equal(math[1].textContent, 'x'); assert.equal(math[2].textContent, long); assert.equal(h.calls.length, 2);
  h.api.render(h.parent(), invalid); assert.equal(h.calls.length, 3, 'failed formulas are retried, never cached');
});

test('per-document LRU reuses successful DOM clones and evicts by entry count', () => {
  const h = browserFixture(), first = h.parent(), second = h.parent();
  h.api.render(first, String.raw`\(x\)`); h.api.render(second, String.raw`\(x\) streaming tail`);
  assert.equal(h.calls.length, 1); assert.notEqual(first.querySelector('[data-chat-math-source]').childNodes[0], second.querySelector('[data-chat-math-source]').childNodes[0]);
  const otherDocument = documentFixture(); h.api.render(otherDocument.createElement('div'), String.raw`\(x\)`); assert.equal(h.calls.length, 2);
  const lru = browserFixture();
  for (let i = 0; i <= limits.cacheEntries; i++) lru.api.render(lru.parent(), String.raw`\(x_` + i + String.raw`\)`);
  assert.equal(lru.calls.length, limits.cacheEntries + 1);
  lru.api.render(lru.parent(), String.raw`\(x_` + limits.cacheEntries + String.raw`\)`); assert.equal(lru.calls.length, limits.cacheEntries + 1);
  lru.api.render(lru.parent(), String.raw`\(x_0\)`); assert.equal(lru.calls.length, limits.cacheEntries + 2);
});

test('LRU also evicts by retained source characters and incomplete input never renders', () => {
  const h = browserFixture(), body = 'x'.repeat(3990), source = i => String.raw`\(` + body + '_' + i + String.raw`\)`;
  for (let i = 0; i < 9; i++) h.api.render(h.parent(), source(i));
  assert.equal(h.calls.length, 9); h.api.render(h.parent(), source(0)); assert.equal(h.calls.length, 10);
  h.api.render(h.parent(), String.raw`\(unfinished`); assert.equal(h.calls.length, 10);
});

test('selection without math uses exact native selection text and outside-root selection stays native', () => {
  const h = browserFixture(), root = h.parent(), fragment = h.document.createDocumentFragment(); fragment.append(h.document.createTextNode('different DOM text')); root.append(h.document.createTextNode('original'));
  const native = 'Browser spacing stays   exact\ntext', range = selectedRange(root, fragment, { original: native });
  assert.equal(h.api.selectionText(range.selection, root), native);
  const outside = h.document.createElement('p'), external = selectedRange(root, fragment, { start: outside, end: outside, original: native });
  assert.equal(h.api.selectionText(external.selection, root), native);
});

test('partial math selection expands atomically and returns original LaTeX once', () => {
  const h = browserFixture(), root = h.parent(), formula = mathNode(h.document, String.raw`\(\frac{5}{8}\)`); root.append(formula);
  const fragment = h.document.createDocumentFragment(); fragment.append(formula.cloneNode(true));
  const range = selectedRange(root, fragment, { start: formula.childNodes[0], end: formula.childNodes[1], original: 'visual duplicateMathML duplicate' });
  assert.equal(h.api.selectionText(range.selection, root), String.raw`\(\frac{5}{8}\)`);
  assert.deepEqual(range.actions.map(action => action[0]), ['start', 'end']); assert.ok(range.actions.every(action => action[1] === formula));
});

test('selection across prose, formulas and code retains paragraph boundaries and code text', () => {
  const h = browserFixture(), root = h.parent(), fragment = h.document.createDocumentFragment(), first = h.document.createElement('p'), second = h.document.createElement('p'), code = h.document.createElement('code');
  first.append(h.document.createTextNode('Before '), mathNode(h.document, '$x^2$'), h.document.createTextNode(' after'));
  code.textContent = 'const value = "$code$";\nnext line'; second.append(code); fragment.append(first, second);
  const range = selectedRange(root, fragment);
  assert.equal(h.api.selectionText(range.selection, root), 'Before $x^2$ after\n\nconst value = "$code$";\nnext line');
  const blocks = h.document.createDocumentFragment(); blocks.append(mathNode(h.document, String.raw`\[x\]`, { display: true }), mathNode(h.document, '$$y$$', { display: true }));
  assert.equal(h.api.selectionText(selectedRange(root, blocks).selection, root), String.raw`\[x\]` + '\n$$y$$');
});
