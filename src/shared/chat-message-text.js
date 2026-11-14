'use strict';
((scope, factory) => {
  const api = factory(() => typeof module === 'object' && module.exports ? require('../vendor/katex/katex.min.js') : scope.katex);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.InMomentChatMessageText = api;
})(typeof window === 'object' ? window : globalThis, getKatex => {
  const limits = Object.freeze({ source: 100000, formula: 4096, formulas: 128, math: 32768, tokens: 4096, cacheEntries: 128, cacheSource: 32768 });
  const caches = new WeakMap();
  const mathAttribute = 'data-chat-math-source';

  // Each scan consumes its inspected range, including unmatched delimiters. An
  // unfinished dollar sequence cannot cause repeated searches through the tail.
  function tokenize(value) {
    const source = String(value ?? ''), end = Math.min(source.length, limits.source), tokens = [];
    const escaped = new Uint8Array(end); let slashes = 0;
    for (let i = 0; i < end; i++) { escaped[i] = slashes % 2; slashes = source[i] === '\\' ? slashes + 1 : 0; }
    let cursor = 0, plain = 0, formulas = 0, math = 0;
    function text(until) {
      if (until <= plain) return;
      const part = source.slice(plain, until), previous = tokens.at(-1);
      if (previous?.type === 'text') previous.source += part;
      else tokens.push({ type: 'text', source: part });
      plain = until;
    }
    function atom(token, until) { text(cursor); tokens.push(token); cursor = plain = until; }
    while (cursor < end && tokens.length + 2 <= limits.tokens) {
      if (source[cursor] === '`' && !escaped[cursor]) {
        let width = 1; while (cursor + width < end && source[cursor + width] === '`') width++;
        let header = cursor + width;
        while (header < end && source[header] !== '\n' && source[header] !== '`') header++;
        const block = width >= 3 && header < end && source[header] === '\n';
        const body = block ? header + 1 : cursor + width;
        let scan = body, close = -1, after = end;
        while (scan < end) {
          if (!block && (source[scan] === '\n' || source[scan] === '\r')) { after = scan; break; }
          if (source[scan] !== '`') { scan++; continue; }
          let count = 1; while (scan + count < end && source[scan + count] === '`') count++;
          if (count >= width) { close = scan; after = scan + width; break; }
          scan += count;
        }
        if (block || close >= 0) {
          const code = source.slice(body, close < 0 ? after : close);
          atom({ type: 'code', source: source.slice(cursor, after), value: block ? code.replace(/\n$/u, '') : code, block, language: block ? source.slice(cursor + width, header) : '' }, after);
          continue;
        }
        // Protect the unfinished inline-code line while it is being streamed.
        atom({ type: 'literal', source: source.slice(cursor, after) }, after); continue;
      }
      let open = '', close = '', display = false;
      if (!escaped[cursor] && source[cursor] === '\\' && (source[cursor + 1] === '(' || source[cursor + 1] === '[')) {
        open = source.slice(cursor, cursor + 2); display = source[cursor + 1] === '['; close = display ? '\\]' : '\\)';
      } else if (!escaped[cursor] && source[cursor] === '$') {
        display = source[cursor + 1] === '$'; open = close = display ? '$$' : '$';
        if (!display && (!source[cursor + 1] || /\s/u.test(source[cursor + 1]))) { cursor++; continue; }
      }
      if (!open) { cursor++; continue; }
      const body = cursor + open.length; let scan = body, found = false;
      while (scan < end) {
        if (!display && (source[scan] === '\n' || source[scan] === '\r')) break;
        if (scan + close.length <= end && !escaped[scan] && source.startsWith(close, scan)) { found = true; break; }
        scan++;
      }
      if (!found) {
        // A block opener owns the remaining block; inline openers stop at EOL.
        atom({ type: 'literal', source: source.slice(cursor, scan) }, scan); continue;
      }
      const formula = source.slice(body, scan), until = scan + close.length;
      if (open === '$' && (!formula || /\s$/u.test(formula) || /\d/u.test(source[until] || '') || source[scan + 1] === '$' || !dollarFormula(formula))) {
        // The candidate closer becomes the next possible opener. Thus currency
        // before a later genuine formula remains plain text without rescanning.
        cursor = scan; continue;
      }
      const allowed = formula.trim().length > 0 && formula.length <= limits.formula && formulas < limits.formulas && math + formula.length <= limits.math;
      formulas++; math += formula.length;
      atom({ type: 'math', source: source.slice(cursor, until), value: formula, display, allowed }, until);
    }
    text(source.length);
    return tokens;
  }
  function dollarFormula(value) {
    // Ordinary prices and prose with dollar signs should remain ordinary text.
    return !/\s/u.test(value) || /\\[A-Za-z]|[=+*/^_{}<>|]/u.test(value);
  }
  function make(document, tag, className = '', text) {
    const node = document.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function options(displayMode) { return { displayMode, output: 'htmlAndMathml', throwOnError: true, trust: false, maxExpand: 200, maxSize: 10, strict: 'ignore', macros: {} }; }
  function mathNode(document, token) {
    const node = make(document, token.display ? 'div' : 'span', 'chat-math' + (token.display ? ' chat-math-display' : ''));
    node.setAttribute(mathAttribute, token.source);
    if (token.allowed) {
      try {
        const katex = getKatex();
        if (typeof katex?.render === 'function') {
          let cache = caches.get(document);
          if (!cache) { cache = { entries: new Map(), source: 0 }; caches.set(document, cache); }
          const key = (token.display ? '1' : '0') + token.source, cached = cache.entries.get(key);
          if (cached) { cache.entries.delete(key); cache.entries.set(key, cached); node.append(cached.node.cloneNode(true)); return node; }
          const output = make(document, 'span', 'chat-math-output');
          katex.render(token.value, output, options(token.display));
          node.append(output);
          const cost = token.source.length;
          if (cost <= limits.cacheSource) {
            cache.entries.set(key, { node: output.cloneNode(true), cost }); cache.source += cost;
            while (cache.entries.size > limits.cacheEntries || cache.source > limits.cacheSource) {
              const oldest = cache.entries.keys().next().value; cache.source -= cache.entries.get(oldest).cost; cache.entries.delete(oldest);
            }
          }
          return node;
        }
      } catch { /* Invalid TeX retains its exact source in the message. */ }
    }
    node.classList.add('chat-math-fallback'); node.textContent = token.source; return node;
  }
  function appendInline(parent, segments, document) {
    const units = [];
    for (const segment of segments) {
      if (segment.type !== 'text') { units.push(segment); continue; }
      for (const part of segment.source.split(/(\*\*)/u)) if (part) units.push({ type: part === '**' ? 'bold' : 'text', source: part });
    }
    function append(target, unit) {
      if (unit.type === 'math') target.append(mathNode(document, unit));
      else if (unit.type === 'code') target.append(make(document, 'code', '', unit.value));
      else target.append(document.createTextNode(unit.source));
    }
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (unit.type !== 'bold') { append(parent, unit); continue; }
      let end = i + 1; while (end < units.length && units[end].type !== 'bold') end++;
      if (end > i + 1 && end < units.length) {
        const strong = make(document, 'strong'); for (let j = i + 1; j < end; j++) append(strong, units[j]); parent.append(strong); i = end;
      } else { append(parent, unit); if (end === units.length) { for (let j = i + 1; j < end; j++) append(parent, units[j]); break; } }
    }
  }
  function render(parent, value) {
    const document = parent.ownerDocument || globalThis.document; let paragraph = null, line = [];
    function flush() {
      if (!line.some(part => part.type !== 'text' || part.source.trim())) { line = []; paragraph = null; return; }
      let target, first = line[0];
      const heading = first.type === 'text' && /^(#{1,4})[ \t]+/u.exec(first.source);
      const list = first.type === 'text' && /^\s*(?:[-*]|\d+[.)])[ \t]+/u.test(first.source);
      if (heading) { target = make(document, 'h3'); line[0] = { ...first, source: first.source.slice(heading[0].length) }; parent.append(target); paragraph = null; }
      else if (list) { target = make(document, 'p', 'chat-list-line'); line[0] = { ...first, source: first.source.trimStart() }; const last = line.at(-1); if (last.type === 'text') line[line.length - 1] = { ...last, source: last.source.trimEnd() }; parent.append(target); paragraph = null; }
      else { if (!paragraph) { paragraph = make(document, 'p'); parent.append(paragraph); } else paragraph.append(make(document, 'br')); target = paragraph; }
      appendInline(target, line, document); line = [];
    }
    for (const token of tokenize(value)) {
      if (token.type === 'code' && token.block) {
        if (line.length) flush(); paragraph = null;
        const pre = make(document, 'pre'); pre.append(make(document, 'code', '', token.value)); if (token.language) pre.setAttribute('aria-label', token.language); parent.append(pre);
      } else if (token.type === 'math' && token.display) {
        if (line.length) flush(); paragraph = null; parent.append(mathNode(document, token));
      } else if (token.type === 'text' || token.type === 'literal') {
        const pieces = token.source.split('\n');
        pieces.forEach((source, index) => { if (source) line.push({ type: token.type, source }); if (index < pieces.length - 1) flush(); });
      } else line.push(token);
    }
    if (line.length) flush();
  }
  function enclosingMath(node, root) {
    let element = node?.nodeType === 1 ? node : node?.parentElement;
    while (element && element !== root) { if (element.hasAttribute?.(mathAttribute)) return element; element = element.parentElement; }
    return element?.hasAttribute?.(mathAttribute) ? element : null;
  }
  function fragmentText(fragment) {
    let text = '', pending = 0;
    const block = /^(?:DIV|P|H[1-6]|PRE|LI|UL|OL|ARTICLE|SECTION|HEADER|FOOTER|ASIDE|NAV|TR|BLOCKQUOTE)$/u;
    function append(value) {
      if (!value) return;
      if (text && pending) { const trailing = /\n*$/u.exec(text)[0].length; text += '\n'.repeat(Math.max(0, pending - trailing)); }
      pending = 0; text += value;
    }
    function visit(node) {
      if (node.nodeType === 3) { append(node.nodeValue ?? node.textContent ?? ''); return; }
      if (node.nodeType === 1 && node.hasAttribute?.(mathAttribute)) {
        const display = String(node.tagName || '').toUpperCase() === 'DIV';
        if (display) pending = Math.max(pending, 1); append(node.getAttribute(mathAttribute)); if (display) pending = Math.max(pending, 1); return;
      }
      const tag = String(node.tagName || '').toUpperCase(), isBlock = block.test(tag), gap = tag === 'P' || /^H[1-6]$/u.test(tag) ? 2 : 1;
      if (tag === 'BR') { append('\n'); return; }
      if (isBlock) pending = Math.max(pending, gap);
      for (const child of node.childNodes || []) visit(child);
      if (isBlock) pending = Math.max(pending, gap);
    }
    visit(fragment); return text;
  }
  function selectionText(selection, root) {
    const original = selection?.toString?.() || '';
    if (!selection || selection.isCollapsed || !selection.rangeCount) return original;
    try {
      const results = []; let containsMath = false;
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i).cloneRange();
        if (root && (!root.contains(range.startContainer) || !root.contains(range.endContainer))) return original;
        const start = enclosingMath(range.startContainer, root), end = enclosingMath(range.endContainer, root);
        if (start) range.setStartBefore(start);
        if (end) range.setEndAfter(end);
        const fragment = range.cloneContents();
        const hasMath = Boolean(start || end || fragment.querySelector?.('[' + mathAttribute + ']'));
        containsMath ||= hasMath; results.push(fragmentText(fragment));
      }
      return containsMath ? results.join('\n') : original;
    } catch { return original; }
  }
  return Object.freeze({ render, selectionText, tokenize, limits });
});
