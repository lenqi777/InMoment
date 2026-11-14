'use strict';

(() => {
  const blockTags = new Set(['p', 'div', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote']);
  const clearableTags = new Set(['p', 'div', 'h1', 'h2', 'h3', 'li', 'blockquote']);
  const inlineTags = new Set(['strong', 'em', 'u', 's', 'br', 'span']);
  const aliases = { b: 'strong', i: 'em', strike: 's', font: 'span' };
  const fontSizes = [12, 14, 16, 20, 24, 32, 40];
  const mediaSelector = '[data-note-media][contenteditable="false"]';
  const paragraphSelector = 'li,p,div,h1,h2,h3,blockquote';
  const maxLength = 1_000_000;
  const tagOf = node => node.localName;

  function mediaLayout(width, align) {
    return {
      ...(Number.isInteger(width) && width >= 48 && width <= 1600 ? { width } : {}),
      ...(align === 'left' || align === 'right' || align === 'inline' ? { align } : {}),
    };
  }

  function markMediaLayout(element, { width, align }) {
    const layout = mediaLayout(width, align);
    if (layout.width) element.dataset.noteMediaWidth = String(layout.width);
    if (layout.align) element.dataset.noteMediaAlign = layout.align;
  }

  function colorHex(value) {
    if (/^#[0-9a-f]{6}$/iu.test(value)) return value.toLowerCase();
    const channels = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/iu.exec(value);
    if (channels && channels.slice(1).every(value => Number(value) <= 255)) {
      return '#' + channels.slice(1).map(value => Number(value).toString(16).padStart(2, '0')).join('');
    }
  }

  function encode(parent) {
    const result = [];
    function append(value) {
      if (typeof value === 'string' && typeof result.at(-1) === 'string') result[result.length - 1] += value;
      else result.push(value);
    }
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.data) append(child.data);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.matches(mediaSelector)) {
        const { noteMedia, noteMediaWidth, noteMediaAlign } = child.dataset;
        append({ attachmentId: noteMedia, ...mediaLayout(Number(noteMediaWidth), noteMediaAlign) });
        continue;
      }
      const name = tagOf(child);
      const tag = aliases[name] || name;
      if (tag === 'br') { append({ tag }); continue; }
      const children = encode(child);
      if (!blockTags.has(tag) && !inlineTags.has(tag)) {
        children.forEach(append);
        continue;
      }
      const color = tag === 'span' ? colorHex(child.style.color || child.getAttribute('color') || '') : undefined;
      const requestedSize = name === 'font' ? fontSizes[Number(child.getAttribute('size')) - 1] : Number.parseFloat(child.style.fontSize);
      const size = tag === 'span' && fontSizes.includes(requestedSize) ? requestedSize : undefined;
      if (tag === 'span' && !color && !size) children.forEach(append);
      else append({ tag, ...(color ? { color } : {}), ...(size ? { size } : {}),
        ...(child.classList.contains('note-media-clear') && clearableTags.has(tag) ? { clear: true } : {}), children });
    }
    return result;
  }

  function decode(nodes, parent, makeMedia) {
    for (const node of nodes) {
      if (typeof node === 'string') parent.append(document.createTextNode(node));
      else if (node.attachmentId) {
        const layout = mediaLayout(node.width, node.align);
        const media = makeMedia(node.attachmentId, layout);
        if (media) {
          markMediaLayout(media, layout);
          parent.append(media);
        }
      } else if (blockTags.has(node.tag) || inlineTags.has(node.tag)) {
        const child = document.createElement(node.tag);
        if (node.clear === true && clearableTags.has(node.tag)) child.classList.add('note-media-clear');
        if (node.tag === 'span') {
          if (/^#[0-9a-f]{6}$/iu.test(node.color || '')) child.style.color = node.color;
          if (fontSizes.includes(node.size)) child.style.fontSize = node.size + 'px';
        }
        if (node.children) decode(node.children, child, makeMedia);
        parent.append(child);
      }
    }
  }

  // Offsets address only the note's text. A media node has no text width.
  function textIndex(root) {
    const chunks = [];
    const textNodes = [];
    const offsets = new WeakMap();
    const boundaries = new Map();
    let length = 0;
    function append(text) { chunks.push(text); length += text.length; }
    function walk(parent) {
      const children = parent.childNodes;
      const points = [];
      offsets.set(parent, points);
      let started = false;
      let previousBlock = false;
      let groupStart = length;
      for (let index = 0; index < children.length; index++) {
        const child = children[index];
        const block = blockTags.has(tagOf(child));
        const media = child.nodeType === Node.ELEMENT_NODE && child.matches(mediaSelector);
        const emptyText = child.nodeType === Node.TEXT_NODE && !child.length;
        if (!media && !emptyText && started && (block || previousBlock)) {
          const endsWithBreak = length > groupStart && chunks.at(-1)?.endsWith('\n');
          const startsWithBreak = child.nodeType === Node.TEXT_NODE && child.data.startsWith('\n');
          if (!endsWithBreak && !startsWithBreak) append('\n');
          groupStart = length;
        }
        points.push(length);
        if (media || emptyText) continue;
        boundaries.set(length, [parent, index]);
        if (child.nodeType === Node.TEXT_NODE) {
          offsets.set(child, length);
          textNodes.push({ node: child, start: length, end: length + child.length });
          append(child.data);
        } else if (tagOf(child) === 'br') {
          if (children.length !== 1) append('\n');
        } else if (child.nodeType === Node.ELEMENT_NODE) walk(child);
        started = true;
        previousBlock = block;
      }
      points.push(length);
      if (!boundaries.has(length)) boundaries.set(length, [parent, children.length]);
    }
    walk(root);
    return {
      text: chunks.join(''),
      offset(node, position) {
        const offset = offsets.get(node);
        if (typeof offset === 'number') return offset + position;
        return offset?.[position];
      },
      point(value, fromEnd) {
        const position = Math.min(Math.max(0, value), length);
        const text = textNodes.find(({ start, end }) => fromEnd ? start < position && position <= end : start <= position && position < end);
        if (text) return [text.node, position - text.start];
        if (boundaries.has(position)) return boundaries.get(position);
        const adjacent = textNodes.find(({ start, end }) => fromEnd ? start === position : end === position);
        return adjacent ? [adjacent.node, position - adjacent.start] : [root, root.childNodes.length];
      },
    };
  }

  function rangeInside(root, range) {
    return Boolean(range && root.contains(range.startContainer) && root.contains(range.endContainer) &&
      !range.startContainer.parentElement?.closest(mediaSelector) && !range.endContainer.parentElement?.closest(mediaSelector) &&
      !range.startContainer.matches?.(mediaSelector) && !range.endContainer.matches?.(mediaSelector));
  }

  function rangeAt(root, start, end = start) {
    const index = textIndex(root);
    const range = document.createRange();
    range.setStart(...index.point(start, false));
    if (start !== end) range.setEnd(...index.point(end, true));
    else range.collapse(true);
    return range;
  }

  function selectionOf(root, preferred) {
    const selection = window.getSelection();
    const range = preferred || (selection?.rangeCount ? selection.getRangeAt(0) : null);
    if (!rangeInside(root, range)) return null;
    const index = textIndex(root);
    const start = index.offset(range.startContainer, range.startOffset);
    const end = index.offset(range.endContainer, range.endOffset);
    if (start === undefined || end === undefined) return null;
    return { start, end, value: index.text, text: index.text.slice(start, end), direction: selection.direction, range: range.cloneRange() };
  }

  function copySelection(root, selection) {
    if (!selection || selection.range.collapsed || !rangeInside(root, selection.range)) return null;
    const fragment = selection.range.cloneContents();
    const common = selection.range.commonAncestorContainer;
    // cloneContents omits the common ancestor and its formatting.
    let parent = fragment;
    for (let ancestor = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
      ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
      const wrapper = ancestor.cloneNode(false);
      wrapper.append(parent);
      const outer = document.createDocumentFragment();
      outer.append(wrapper);
      parent = outer;
    }
    return { version: 1, nodes: encode(parent) };
  }

  function pastedImages(html, maxBytes) {
    if (!html || html.length > maxBytes * 1.5 + maxLength * 6) return null;
    // Template contents are inert. Only the note's known tags and embedded image data are read.
    const template = document.createElement('template');
    template.innerHTML = html;
    const ignored = 'script,style,template,iframe,object,embed,head,noscript,meta,link,title';
    template.content.querySelectorAll(ignored).forEach(node => node.remove());
    const images = [];
    let bytes = 0;
    for (const node of template.content.querySelectorAll('img')) {
      const source = /^data:image\/(png|jpeg|gif|webp|bmp|avif);base64,([\w+/=\s]+)$/iu.exec(node.getAttribute('src') || '');
      if (!source) { node.remove(); continue; }
      const base64 = source[2].replace(/\s/gu, '');
      const [, mime] = source;
      bytes += Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
      if (images.length >= 24 || bytes > maxBytes) throw new Error('剪贴板图片超过粘贴上限，请分次复制。');
      const data = Uint8Array.fromBase64(base64);
      const extension = mime === 'jpeg' ? 'jpg' : mime.toLowerCase();
      const label = node.alt.trim().replace(/\.[^.\\/]+$/u, '').slice(0, 150) || '粘贴的图片';
      const marker = document.createElement('span');
      marker.dataset.noteMedia = String(images.length);
      marker.contentEditable = 'false';
      markMediaLayout(marker, { width: Number(node.dataset.noteWidth), align: node.dataset.noteAlign });
      images.push({ name: label + '.' + extension, bytes: data });
      node.replaceWith(marker);
    }
    if (!images.length) return null;
    for (const node of template.content.querySelectorAll([...clearableTags].join(','))) {
      if (node.style.clear === 'both' || node.dataset.noteClear === '1') node.classList.add('note-media-clear');
    }
    for (const span of template.content.querySelectorAll('span[data-note-color],span[data-note-size]')) {
      const color = colorHex(span.dataset.noteColor || '');
      if (color) span.style.color = color;
      const size = Number(span.dataset.noteSize);
      if (fontSizes.includes(size)) span.style.fontSize = size + 'px';
    }
    const root = template.content.querySelector('[data-inmoment-note-fragment="1"]') || template.content;
    return { document: { version: 1, nodes: encode(root) }, images };
  }

  function insertFragment(root, range, fragment) {
    const last = fragment.lastChild;
    if (!last) return false;
    range.deleteContents();
    if ([...fragment.children].some(node => blockTags.has(node.localName))) {
      const start = range.startContainer;
      const anchor = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
      const paragraph = anchor.closest('p,div,h1,h2,h3,blockquote');
      if (paragraph && paragraph !== root && root.contains(paragraph)) {
        // Preserve inline formatting around the insertion without putting paragraphs inside each other.
        const tail = range.cloneRange();
        tail.setEnd(paragraph, paragraph.childNodes.length);
        const suffix = paragraph.cloneNode(false);
        suffix.append(tail.extractContents());
        paragraph.after(fragment);
        if (suffix.textContent || suffix.querySelector(mediaSelector)) last.after(suffix);
        if (!paragraph.textContent && !paragraph.querySelector(mediaSelector)) paragraph.remove();
        range.setStartAfter(last);
        range.collapse(true);
        return true;
      }
    }
    range.insertNode(fragment);
    range.setStartAfter(last);
    range.collapse(true);
    return true;
  }

  function restore(root, range, direction) {
    if (!rangeInside(root, range)) return false;
    root.focus({ preventScroll: true });
    const selection = window.getSelection();
    selection.removeAllRanges();
    if (direction === 'backward') selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
    else selection.addRange(range);
    return true;
  }

  function emptyParagraph(node) {
    return node.matches?.(paragraphSelector) && !node.textContent.trim() &&
      !node.querySelector(paragraphSelector + ',ol,ul,' + mediaSelector) &&
      node.querySelectorAll('br').length <= 1 && !node.textContent.includes('\n');
  }

  function edgeContent(node, backward) {
    if (node.nodeType === Node.TEXT_NODE) return node.length ? node : null;
    if (node.matches?.('br,' + mediaSelector) || emptyParagraph(node)) return node;
    const children = backward ? [...node.childNodes].reverse() : node.childNodes;
    for (const child of children) {
      const content = edgeContent(child, backward);
      if (content) return content;
    }
    return blockTags.has(tagOf(node)) ? node : null;
  }

  function adjacentContent(root, container, offset, backward) {
    if (container.nodeType === Node.TEXT_NODE) {
      if (backward ? offset > 0 : offset < container.length) return container;
    } else {
      for (let i = backward ? offset - 1 : offset; i >= 0 && i < container.childNodes.length; i += backward ? -1 : 1) {
        const content = edgeContent(container.childNodes[i], backward);
        if (content) return content;
      }
    }
    const siblingKey = backward ? 'previousSibling' : 'nextSibling';
    for (let node = container; node !== root; node = node.parentNode) {
      for (let sibling = node[siblingKey]; sibling; sibling = sibling[siblingKey]) {
        const content = edgeContent(sibling, backward);
        if (content) return content;
      }
    }
    return null;
  }

  function adjacentToNode(root, node, backward) {
    const boundary = document.createRange();
    boundary.selectNode(node);
    boundary.collapse(backward);
    return adjacentContent(root, boundary.startContainer, boundary.startOffset, backward);
  }

  function removeBlankLine(root, line, preceding, following) {
    const caret = document.createRange();
    caret.setStartBefore(line);
    caret.collapse(true);
    const clear = line.classList.contains('note-media-clear');
    if (!following && preceding.dataset.noteMediaAlign !== 'inline' && line.nodeName !== 'BR') {
      // A terminal block or float needs an editable line box for Blink's caret.
      line.replaceWith(document.createElement('br'));
    } else {
      line.remove();
    }
    if (following && root.contains(following)) {
      const element = following.nodeType === Node.TEXT_NODE ? following.parentElement : following;
      const paragraph = element.closest(paragraphSelector);
      if (clear && paragraph !== root && root.contains(paragraph)) paragraph.classList.add('note-media-clear');
      if (following.nodeType === Node.TEXT_NODE || blockTags.has(tagOf(following))) caret.setStart(following, 0);
      else caret.setStartBefore(following);
      caret.collapse(true);
    }
    restore(root, caret);
  }

  function exitListAfterMedia(root, line, item, preceding) {
    const list = item.parentElement;
    // Unlist just this empty item. A native backward deletion can cross the
    // line boundary and include the noneditable picture.
    const paragraph = document.createElement('div');
    if (['left', 'right'].includes(preceding.dataset.noteMediaAlign) ||
      line.classList.contains('note-media-clear') || item.classList.contains('note-media-clear')) {
      paragraph.classList.add('note-media-clear');
    }
    paragraph.append(document.createElement('br'));
    if (!item.previousElementSibling) list.before(paragraph);
    else {
      list.after(paragraph);
      if (item.nextElementSibling) {
        const trailing = list.cloneNode(false);
        while (item.nextSibling) trailing.append(item.nextSibling);
        paragraph.after(trailing);
      }
    }
    item.remove();
    if (!list.firstElementChild) list.remove();
    const caret = document.createRange();
    caret.setStart(paragraph, 0);
    caret.collapse(true);
    restore(root, caret);
  }

  function selectedMedia(root, range) {
    return rangeInside(root, range) && range.startContainer === range.endContainer &&
      range.endOffset === range.startOffset + 1 &&
      range.startContainer.childNodes[range.startOffset]?.matches?.(mediaSelector);
  }

  function deleteAroundMedia(root, event, preferredRange) {
    const selection = window.getSelection();
    const range = preferredRange || (selection?.rangeCount ? selection.getRangeAt(0) : null);
    if (!rangeInside(root, range)) return null;
    const type = event.inputType;
    const start = range.startContainer;
    const offset = range.startOffset;
    if (selectedMedia(root, range)) {
      event.preventDefault();
      range.deleteContents();
      restore(root, range);
      return 'deleteSelectedMedia';
    }
    if (!range.collapsed) return null;
    const backward = type.endsWith('Backward');
    const element = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
    const adjacent = adjacentContent(root, start, offset, backward);
    if (type === 'deleteContentBackward' || type === 'deleteContentForward' || type === 'deleteWordBackward' || type === 'deleteWordForward') {
      const paragraph = element.closest(paragraphSelector);
      let line = paragraph && paragraph !== root && root.contains(paragraph) && emptyParagraph(paragraph) ? paragraph : adjacent;
      if (!backward && start.nodeType === Node.ELEMENT_NODE && start.childNodes[offset - 1]?.nodeName === 'BR' &&
        !(line?.nodeName === 'BR' || (line && emptyParagraph(line)))) line = start.childNodes[offset - 1];
      const lineBreak = line?.nodeName === 'BR' &&
        (line.parentElement === root || !emptyParagraph(line.parentElement));
      if (line && (emptyParagraph(line) || lineBreak)) {
        let preceding = adjacentToNode(root, line, true);
        while (preceding && (preceding.nodeName === 'BR' || emptyParagraph(preceding) ||
          (preceding.nodeType === Node.TEXT_NODE && !preceding.data.trim()))) {
          preceding = adjacentToNode(root, preceding, true);
        }
        if (preceding?.matches?.(mediaSelector)) {
          const following = adjacentToNode(root, line, false);
          const item = line.closest('li');
          if (item && backward && line === paragraph && item.parentElement.matches('ol,ul') &&
            !item.textContent.trim() && !item.querySelector('ol,ul,' + mediaSelector)) {
            event.preventDefault();
            exitListAfterMedia(root, line, item, preceding);
            return 'exitListAfterMedia';
          }
          // A lone soft break between inline content separates two nonempty lines.
          const separatesText = lineBreak && following?.nodeType === Node.TEXT_NODE &&
            following.parentElement.closest(paragraphSelector) === line.parentElement.closest(paragraphSelector) &&
            adjacentToNode(root, line, true)?.nodeName !== 'BR';
          if (!item && !separatesText) {
            if (lineBreak && !following && preceding.dataset.noteMediaAlign !== 'inline' &&
              adjacentToNode(root, line, true) === preceding) {
              event.preventDefault();
              return null;
            }
            event.preventDefault();
            removeBlankLine(root, line, preceding, following);
            return 'deleteBlankLine';
          }
        }
      }
    }

    // Blink sometimes extends a collapsed deletion across a noneditable image.
    if (adjacent?.matches?.(mediaSelector) || event.getTargetRanges().some(target => {
      if (!rangeInside(root, target) || target.collapsed) return false;
      const deletion = document.createRange();
      deletion.setStart(target.startContainer, target.startOffset);
      deletion.setEnd(target.endContainer, target.endOffset);
      return [...root.querySelectorAll(mediaSelector)].some(node => deletion.intersectsNode(node));
    })) event.preventDefault();
    return null;
  }

  function bookmark(root) {
    const selection = selectionOf(root);
    if (!selection) return null;
    const point = (node, offset) => {
      const path = [];
      for (let child = node; child !== root; child = child.parentNode) {
        path.unshift(Array.prototype.indexOf.call(child.parentNode.childNodes, child));
      }
      return { path, offset, type: node.nodeType };
    };
    const { range, start, end, direction } = selection;
    return { start, end, direction,
      first: point(range.startContainer, range.startOffset), last: point(range.endContainer, range.endOffset) };
  }

  function fromBookmark(root, mark) {
    const resolve = ({ path, offset, type }) => {
      const node = path.reduce((parent, index) => parent?.childNodes[index], root);
      return node?.nodeType === type && offset <= (type === Node.TEXT_NODE ? node.length : node.childNodes.length) ? [node, offset] : null;
    };
    const first = resolve(mark.first);
    const last = resolve(mark.last);
    if (first && last) {
      const range = document.createRange();
      range.setStart(...first);
      range.setEnd(...last);
      if (rangeInside(root, range)) {
        const index = textIndex(root);
        if (index.offset(...first) === mark.start && index.offset(...last) === mark.end) return range;
      }
    }
    return rangeAt(root, mark.start, mark.end);
  }

  function textRects(root, selection) {
    const range = selection.range;
    if (!rangeInside(root, range)) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, text =>
      text.parentElement.closest(mediaSelector) || !range.intersectsNode(text) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT);
    const piece = document.createRange();
    const rectangles = [];
    while (walker.nextNode()) {
      const text = walker.currentNode;
      piece.setStart(text, range.startContainer === text ? range.startOffset : 0);
      piece.setEnd(text, range.endContainer === text ? range.endOffset : text.length);
      const lineHeight = Number.parseFloat(getComputedStyle(text.parentElement).lineHeight);
      for (const rect of piece.getClientRects()) {
        const height = Number.isFinite(lineHeight) ? lineHeight : rect.height;
        const top = rect.top + (rect.height - height) / 2;
        if (rect.width) rectangles.push({ left: rect.left, right: rect.right, top, bottom: top + height });
      }
    }
    return rectangles;
  }

  window.InMomentNoteDocument = {
    maxLength, rangeInside, rangeAt, selectionOf, restore, textRects, copySelection, pastedImages, insertFragment, bookmark, fromBookmark,
    deleteAroundMedia, selectedMedia,
    fragment(value, makeMedia) {
      const fragment = document.createDocumentFragment();
      decode(value.nodes, fragment, makeMedia);
      return fragment;
    },
    endOffset: (root, range) => textIndex(root).offset(range.endContainer, range.endOffset),
    value: root => textIndex(root).text,
    read(root) { return { body: textIndex(root).text, document: { version: 1, nodes: encode(root) } }; },
    render(root, value, body, makeMedia) {
      const fragment = document.createDocumentFragment();
      if (value?.version === 1 && Array.isArray(value.nodes)) decode(value.nodes, fragment, makeMedia);
      else if (body) fragment.append(document.createTextNode(body));
      root.replaceChildren(fragment);
    },
    includesMedia(root, range) { return [...root.querySelectorAll(mediaSelector)].some(node => range.intersectsNode(node)); },
  };
})();
