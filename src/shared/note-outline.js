'use strict';

(() => {
  const MAX_DEPTH = 24;
  const MAX_ITEMS = 3000;
  const MAX_TEXT = 100_000;
  const MARKER = 'data-inmoment-ocr-outline';
  const NO_CHILD_TAGS = new Set();
  const CHILD_TAGS = {
    div: new Set(['h2', 'h3', 'ul']),
    h2: new Set(['br']),
    h3: NO_CHILD_TAGS,
    ul: new Set(['li']),
    li: new Set(['br', 'ul']),
    br: NO_CHILD_TAGS,
  };
  const TEXT_TAGS = new Set(['h2', 'h3', 'li']);
  const cleanLine = line => line.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  const escapeHtml = line => line.replace(/[&<>]/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);

  function normalize(value, normalizeLine = cleanLine) {
    let nodes = 0, lines = 0, length = 0;
    function visit(entries, depth) {
      if (!Array.isArray(entries) || entries.length > MAX_ITEMS || entries.length && depth > MAX_DEPTH) throw new Error('Invalid outline level');
      return Array.from(entries, entry => {
        if (!entry || ++nodes > MAX_ITEMS || !Array.isArray(entry.lines) || !entry.lines.length || (lines += entry.lines.length) > MAX_ITEMS) {
          throw new Error('Invalid outline node');
        }
        const text = Array.from(entry.lines, line => {
          if (typeof line !== 'string' || (length += line.length) > MAX_TEXT) throw new Error('Invalid outline text');
          return normalizeLine(line);
        });
        if (text.some(line => typeof line !== 'string' || !line)) throw new Error('Empty outline line');
        return { lines: text, children: visit(entry.children, depth + 1) };
      });
    }
    try {
      const roots = visit(value?.roots, 1), unassigned = visit(value?.unassigned, 1);
      return roots.length || unassigned.length ? { roots, unassigned } : null;
    } catch { return null; }
  }

  function clipboardPayload(value) {
    const outline = normalize(value);
    if (!outline) return null;
    const text = [];
    const htmlLines = lines => lines.map(escapeHtml).join('<br>');
    function list(nodes, depth) {
      if (!nodes.length) return '';
      const indent = '  '.repeat(depth);
      const items = nodes.map(({ lines, children }) => {
        text.push(indent + '• ' + lines[0], ...lines.slice(1).map(line => indent + '  ' + line));
        return '<li>' + htmlLines(lines) + list(children, depth + 1) + '</li>';
      });
      return '<ul>' + items.join('') + '</ul>';
    }
    let html = '';
    for (const { lines, children } of outline.roots) {
      text.push(...lines);
      html += '<h2>' + htmlLines(lines) + '</h2>' + list(children, 0);
    }
    if (outline.unassigned.length) {
      text.push('未归类');
      html += '<h3>未归类</h3>' + list(outline.unassigned, 0);
    }
    return { text: text.join('\n'), html: `<div ${MARKER}="1">${html}</div>` };
  }

  function readClipboard(document, html) {
    if (typeof html !== 'string' || html.length > MAX_TEXT * 8 + MAX_ITEMS * 45 || !html.includes(MARKER)) return null;
    const template = document.createElement('template');
    template.innerHTML = html;
    const source = template.content.querySelector(`div[${MARKER}="1"]`);
    if (!source) return null;
    const fragment = document.createDocumentFragment();
    let nodes = 0, length = 0;
    function visit(input, output, depth) {
      for (const node of input.childNodes) {
        if (++nodes > MAX_ITEMS * 5 || depth > 2 * MAX_DEPTH + 2) return false;
        if (node.nodeType === 3) {
          if ((length += node.data.length) > MAX_TEXT + 3) return false;
          if (TEXT_TAGS.has(input.localName)) output.append(document.createTextNode(node.data));
          else if (node.data.trim()) return false;
        } else if (node.nodeType === 1) {
          if (!CHILD_TAGS[input.localName]?.has(node.localName) || node.namespaceURI !== source.namespaceURI) return false;
          const element = document.createElement(node.localName);
          if (!visit(node, element, depth + 1)) return false;
          output.append(element);
        } else if (node.nodeType !== 8) return false;
      }
      return true;
    }
    return visit(source, fragment, 1) && fragment.textContent.trim() ? fragment : null;
  }

  function render(document, value) {
    const payload = clipboardPayload(value);
    if (!payload) return document.createDocumentFragment();
    const template = document.createElement('template');
    template.innerHTML = payload.html;
    const fragment = document.createDocumentFragment();
    fragment.append(...template.content.firstElementChild.childNodes);
    return fragment;
  }

  const api = Object.freeze({ normalize, clipboardPayload, readClipboard, render });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.InMomentNoteOutline = api;
})();
