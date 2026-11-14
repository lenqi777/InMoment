'use strict';
(() => {
  const mediaSelector = '[data-note-media]';
  const dragType = 'application/x-inmoment-note-media';
  const paragraphSelector = 'p,div,h1,h2,h3,li,blockquote';
  const resizeStep = 16;

  function element(document, tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function action(document, icon, label, className = '') {
    const button = element(document, 'button', ('icon-button ' + className).trim());
    button.type = 'button';
    button.dataset.uiIcon = icon;
    button.title = label;
    button.setAttribute('aria-label', label);
    return button;
  }

  function canEmbed(attachment) {
    return Boolean(attachment?.id && ['image', 'video'].includes(attachment.kind));
  }

  function attachmentURL(attachment) {
    try {
      const url = new URL(attachment.url);
      const parts = url.pathname.split('/').slice(1);
      if (url.protocol === 'inmoment-media:' && url.hostname === 'note' &&
        !url.username && !url.password && !url.port && !url.search && !url.hash &&
        parts.length === 2 && parts[0] && decodeURIComponent(parts[1]) === attachment.id) return url.href;
    } catch {}
    return '';
  }

  function previewWidth(block, width) {
    block.classList.toggle('note-inline-media-sized', width !== undefined);
    if (width === undefined) block.style.removeProperty('--note-media-width');
    else block.style.setProperty('--note-media-width', width + 'px');
  }

  function saveWidth(block, width) {
    const previous = block.dataset.noteMediaWidth;
    if (width === undefined) delete block.dataset.noteMediaWidth;
    else block.dataset.noteMediaWidth = String(width);
    previewWidth(block, width);
    return block.dataset.noteMediaWidth !== previous;
  }

  function savedWidth(block) {
    return block.dataset.noteMediaWidth === undefined ? undefined : Number(block.dataset.noteMediaWidth);
  }

  function alignBlock(block, align) {
    const previous = block.dataset.noteMediaAlign;
    if (['left', 'right', 'inline'].includes(align)) block.dataset.noteMediaAlign = align;
    else delete block.dataset.noteMediaAlign;
    return previous !== block.dataset.noteMediaAlign;
  }

  function clampWidth(width) {
    return Math.min(1600, Math.max(48, Math.round(width)));
  }

  function resizedWidth(block, displayedWidth, delta) {
    const width = clampWidth(displayedWidth + delta);
    return delta > 0 ? Math.max(savedWidth(block) || 0, width) : width;
  }

  function create(attachment, { remove, reveal, preview } = {}, layout = {}) {
    const image = attachment.kind === 'image';
    const block = element(document, 'span', 'note-inline-media');
    const kind = image ? '图片' : '视频';
    const name = attachment.name || kind;
    block.dataset.noteMedia = attachment.id;
    block.contentEditable = 'false';
    block.setAttribute('role', 'group');
    block.setAttribute('aria-label', attachment.name ? kind + ' ' + name : kind);
    alignBlock(block, layout.align);
    if (Number.isInteger(layout.width)) saveWidth(block, clampWidth(layout.width));

    const content = element(document, 'span', 'note-inline-media-content');
    const media = element(document, image ? 'img' : 'video', 'note-media');
    media.draggable = false;
    if (image) {
      media.alt = name;
      media.loading = 'lazy';
    } else {
      media.controls = true;
      media.preload = 'metadata';
      media.setAttribute('aria-label', name);
    }
    content.append(media);
    const showError = () => content.replaceChildren(element(document, 'span', 'note-media-error',
      image ? '图片无法预览，可在文件夹中查看。' : '视频无法在应用内播放，可在文件夹中查看。'));
    const url = attachmentURL(attachment);
    if (url) {
      media.addEventListener('error', showError, { once: true });
      media.src = url;
    } else showError();

    const controls = element(document, 'span', 'note-inline-media-actions');
    const handle = action(document, 'more', '移动 ' + name, 'note-inline-media-handle');
    handle.draggable = true;
    handle.setAttribute('aria-haspopup', 'menu');
    handle.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    handle.title = '拖动调整位置，或点击设置文字环绕';
    controls.append(handle);
    if (image && url && preview) {
      const open = action(document, 'expand', '查看大图', 'note-inline-media-preview');
      const show = () => preview(attachment, block, open);
      controls.append(open);
      block.classList.add('note-inline-media-has-preview');
      open.addEventListener('click', show);
      media.addEventListener('dblclick', show);
    }
    if (reveal) {
      const folder = action(document, 'folder', '在文件夹中查看 ' + name);
      folder.addEventListener('click', () => reveal(attachment, folder));
      controls.append(folder);
    }
    if (remove) {
      const button = action(document, 'close', '移除 ' + name, 'ui-cancel note-inline-media-remove');
      button.dataset.attachmentId = attachment.id;
      button.addEventListener('click', () => remove(attachment, button));
      controls.append(button);
    }
    const resize = action(document, 'arrow', '调整大小 ' + name, 'note-inline-media-resize');
    resize.title = '拖动调整大小，或用左右方向键调整';
    resize.setAttribute('aria-haspopup', 'menu');
    resize.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Home');
    const corner = element(document, 'span', 'note-inline-media-corner');
    corner.append(resize);
    block.append(content);
    if (image) block.append(controls, corner);
    else {
      const tools = element(document, 'span', 'note-inline-media-video-tools');
      tools.append(controls, corner);
      block.append(tools);
    }
    return block;
  }

  function closestMedia(node) {
    return (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest(mediaSelector);
  }

  function withinListItem(range) {
    const list = range.startContainer;
    if (!['OL', 'UL'].includes(list.nodeName)) return range;
    const following = [...list.childNodes].slice(range.startOffset).find(node => node.nodeName === 'LI');
    const item = following || [...list.children].findLast(node => node.nodeName === 'LI');
    if (item) {
      range.selectNodeContents(item);
      range.collapse(Boolean(following));
    }
    return range;
  }

  function safeRange(editor, range) {
    if (!range || !editor.contains(range.endContainer)) {
      const end = editor.ownerDocument.createRange();
      end.selectNodeContents(editor);
      end.collapse(false);
      return end;
    }
    const result = range.cloneRange();
    result.collapse(false);
    const media = closestMedia(result.startContainer);
    if (media && editor.contains(media)) result.setStartAfter(media);
    result.collapse(true);
    return withinListItem(result);
  }

  function insert(editor, mediaNodes, preferred, { focus = true } = {}) {
    const nodes = [...mediaNodes];
    if (!nodes.length) return false;
    const range = safeRange(editor, preferred);
    const fragment = editor.ownerDocument.createDocumentFragment();
    fragment.append(...nodes);
    range.insertNode(fragment);
    if (focus) {
      const selection = editor.ownerDocument.getSelection();
      editor.focus({ preventScroll: true });
      range.setStartAfter(nodes.at(-1));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }

  function neighbor(editor, media, direction) {
    const side = direction === 'up' ? 'previousSibling' : 'nextSibling';
    for (let node = media; node && node !== editor; node = node.parentNode) {
      for (let sibling = node[side]; sibling; sibling = sibling[side]) {
        if (sibling.nodeType !== Node.TEXT_NODE || sibling.data) return sibling;
      }
    }
    return null;
  }

  function moveToNeighbor(editor, media, direction) {
    const sibling = neighbor(editor, media, direction);
    if (!sibling) return false;
    const range = editor.ownerDocument.createRange();
    if (sibling.nodeName === 'LI') {
      range.selectNodeContents(sibling);
      range.collapse(direction === 'up');
    } else {
      if (direction === 'up') range.setStartBefore(sibling);
      else range.setStartAfter(sibling);
      range.collapse(true);
    }
    range.insertNode(media);
    return true;
  }

  function pointTarget(editor, event) {
    const document = editor.ownerDocument;
    const media = closestMedia(event.target);
    const range = document.createRange();
    if (media && editor.contains(media)) {
      const bounds = media.getBoundingClientRect();
      const before = event.clientY < (bounds.top + bounds.bottom) / 2;
      if (before) range.setStartBefore(media);
      else range.setStartAfter(media);
      range.collapse(true);
      return { range, horizontal: true, bounds, y: before ? bounds.top : bounds.bottom };
    }
    const hit = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (hit && editor.contains(hit.startContainer) && !closestMedia(hit.startContainer)) {
      const insertion = withinListItem(hit);
      const bounds = insertion.getBoundingClientRect();
      if (bounds.height) return { range: insertion, bounds };
    }
    const next = [...editor.children].find(node => node.getBoundingClientRect().top > event.clientY);
    if (next) range.setStartBefore(next);
    else range.selectNodeContents(editor);
    range.collapse(Boolean(next));
    const bounds = (next || editor.lastElementChild || editor).getBoundingClientRect();
    return { range, horizontal: true, bounds, y: next ? bounds.top : bounds.bottom };
  }

  function point(editor, event) {
    return pointTarget(editor, event).range;
  }

  function dragTarget(editor, event) {
    const target = pointTarget(editor, event);
    const editorBounds = editor.getBoundingClientRect();
    const edge = Math.min(48, editorBounds.width * .2);
    const align = event.clientX - editorBounds.left < edge ? 'left'
      : editorBounds.right - event.clientX < edge ? 'right' : undefined;
    if (!align) return target;

    const { range } = target;
    const start = range.startContainer;
    const paragraph = (start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement)?.closest(paragraphSelector);
    if (paragraph && paragraph !== editor && editor.contains(paragraph)) {
      range.selectNodeContents(paragraph);
      range.collapse(true);
      target.bounds = paragraph.getBoundingClientRect();
    } else if (start.nodeType === Node.TEXT_NODE) {
      const lineStart = start.data.slice(0, range.startOffset).lastIndexOf('\n') + 1;
      range.setStart(start, lineStart);
      range.collapse(true);
      target.bounds = range.getBoundingClientRect();
    }
    return { ...target, align, editorBounds };
  }

  function samePosition(range, media) {
    const current = media.ownerDocument.createRange();
    current.selectNode(media);
    const before = current.cloneRange();
    before.collapse(true);
    const after = current.cloneRange();
    after.collapse(false);
    return range.compareBoundaryPoints(Range.START_TO_START, before) === 0 ||
      range.compareBoundaryPoints(Range.START_TO_START, after) === 0;
  }

  function setCaret(editor, range) {
    editor.focus({ preventScroll: true });
    const selection = editor.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return range;
  }

  function boundary(media, before) {
    const range = media.ownerDocument.createRange();
    range.selectNode(media);
    range.collapse(before);
    return range;
  }

  function besideCaret(media, before) {
    const range = boundary(media, before);
    let sibling = before ? media.previousSibling : media.nextSibling;
    while (sibling?.nodeType === Node.TEXT_NODE && !sibling.length) {
      sibling = before ? sibling.previousSibling : sibling.nextSibling;
    }
    if (sibling?.nodeType === Node.TEXT_NODE && sibling.length) range.setStart(sibling, before ? sibling.length : 0);
    range.collapse(true);
    return range;
  }

  function insertParagraphAfter(editor, media, clear) {
    const document = editor.ownerDocument;
    const block = media.parentElement.closest(paragraphSelector);
    const host = block && editor.contains(block) ? block : editor;
    const line = document.createElement(host.nodeName === 'LI' ? 'li' : 'div');
    if (clear) line.classList.add('note-media-clear');
    const trailing = boundary(media, false);
    trailing.setEnd(host, host.childNodes.length);
    if (host === editor) {
      // Root text and its inline wrappers are siblings of whole paragraphs.
      const nextBlock = [...editor.children].find(node =>
        (node.matches(paragraphSelector) || node.matches('ul,ol')) &&
        trailing.intersectsNode(node) && node !== media && !node.contains(media));
      if (nextBlock) trailing.setEndBefore(nextBlock);
    }
    line.append(trailing.extractContents());
    if (!line.childNodes.length) line.append(document.createElement('br'));
    if (host === editor) trailing.insertNode(line);
    else host.after(line);
    const caret = document.createRange();
    caret.setStart(line, 0);
    caret.collapse(true);
    return caret;
  }

  function insertTextBelow(editor, media, text) {
    const document = editor.ownerDocument;
    const tail = insertParagraphAfter(editor, media, false).startContainer;
    const line = document.createElement(tail.localName);
    line.classList.add('note-media-clear');
    text.split(/\r\n?|\n/u).forEach((part, index) => {
      if (index) line.append(document.createElement('br'));
      if (part) line.append(document.createTextNode(part));
    });
    tail.before(line);
    if (tail.childNodes.length === 1 && tail.firstChild.nodeName === 'BR') tail.remove();
    const caret = document.createRange();
    caret.selectNodeContents(line);
    caret.collapse(false);
    return caret;
  }

  function insertOutlineBelow(editor, media, fragment) {
    const tail = insertParagraphAfter(editor, media, false).startContainer;
    const first = fragment.firstElementChild;
    const last = fragment.lastChild;
    first.classList.add('note-media-clear');
    if (tail.localName === 'li') tail.previousElementSibling.append(fragment);
    else tail.before(fragment);
    if (tail.childNodes.length === 1 && tail.firstChild.nodeName === 'BR') tail.remove();
    const caret = editor.ownerDocument.createRange();
    caret.setStartAfter(last);
    caret.collapse(true);
    return caret;
  }

  function selectedImage(editor) {
    const selection = editor.ownerDocument.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const parent = range.startContainer;
    if (parent !== range.endContainer || range.endOffset - range.startOffset !== 1) return null;
    const media = parent.childNodes[range.startOffset];
    return media?.matches?.(mediaSelector) && media.querySelector('img') && editor.contains(media) ? media : null;
  }

  function selection(editor) {
    if (editor.ownerDocument.activeElement !== editor) return null;
    const native = editor.ownerDocument.getSelection();
    if (native.rangeCount && !native.isCollapsed) return null;
    const image = editor.querySelector('.note-inline-media-selected');
    if (!image) return null;
    const range = editor.ownerDocument.createRange();
    range.selectNode(image);
    return range;
  }

  function onTextLine(editor, hit, y) {
    if (!hit || !editor.contains(hit.startContainer) || closestMedia(hit.startContainer)) return false;
    const node = hit.startContainer;
    let bounds = hit.getBoundingClientRect();
    if (!bounds.height && node.nodeType === Node.ELEMENT_NODE) {
      const lineBreak = node.childNodes[hit.startOffset];
      if (lineBreak?.nodeName === 'BR') bounds = lineBreak.getBoundingClientRect();
    }
    if (!bounds.height) return false;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || bounds.height;
    const allowance = Math.max(0, (lineHeight - bounds.height) / 2);
    return y >= bounds.top - allowance && y <= bounds.bottom + allowance;
  }

  function blankMediaTarget(editor, x, y) {
    const body = editor.getBoundingClientRect();
    const tolerance = (Number.parseFloat(getComputedStyle(editor).lineHeight) || 24) + 12;
    let nearestBelow;
    let nearestSide;
    for (const media of editor.querySelectorAll(mediaSelector)) {
      const bounds = media.getBoundingClientRect();
      if (!bounds.width || !bounds.height) continue;
      const before = x < bounds.left;
      const sideGap = before ? bounds.left - x : x - bounds.right;
      const available = before ? bounds.left - body.left : body.right - bounds.right;
      if (sideGap >= 0 && available >= 24 && bounds.top <= y && y < bounds.bottom &&
        (!nearestSide || sideGap < nearestSide.gap)) nearestSide = { media, before, gap: sideGap };
      const belowGap = y - bounds.bottom;
      if (belowGap >= 0 && belowGap <= tolerance && (!nearestBelow || belowGap < nearestBelow.gap)) {
        nearestBelow = { media, below: true, gap: belowGap };
      }
    }
    return nearestSide || nearestBelow;
  }

  function bind(editor, onChange) {
    const document = editor.ownerDocument;
    let dragged;
    let marker;
    let resizing;
    let suppressedResizeClick;
    let pressedPoint;
    let selected;
    let caretMarker;
    function hideCaretMarker() {
      caretMarker?.remove();
      caretMarker = null;
    }
    function showCaretMarker(range) {
      if (range.getBoundingClientRect().height) return;
      // Blink sometimes accepts typing at a boundary but paints no caret until
      // that line has text. Measure an empty inline probe without storing it.
      const probe = element(document, 'span', '');
      range.cloneRange().insertNode(probe);
      const bounds = probe.getBoundingClientRect();
      probe.remove();
      if (!bounds.height) return;
      caretMarker = element(document, 'span', 'note-inline-media-caret');
      caretMarker.setAttribute('aria-hidden', 'true');
      caretMarker.style.left = bounds.left + 'px';
      caretMarker.style.top = bounds.top + 'px';
      caretMarker.style.height = bounds.height + 'px';
      document.body.append(caretMarker);
    }
    function showSelected(image) {
      if (image === selected) return;
      selected?.classList.remove('note-inline-media-selected');
      image?.classList.add('note-inline-media-selected');
      selected = image;
    }
    document.addEventListener('selectionchange', () => {
      const native = document.getSelection();
      if (native.rangeCount || document.activeElement !== editor || !editor.contains(selected)) showSelected(selectedImage(editor));
    });
    editor.addEventListener('focusout', () => {
      showSelected(null);
      hideCaretMarker();
    });
    editor.addEventListener('input', hideCaretMarker);
    document.addEventListener('scroll', hideCaretMarker, true);
    function clearMarker() {
      marker?.remove();
      marker = null;
    }
    function finishDrag() {
      clearMarker();
      dragged?.classList.remove('note-inline-media-dragging');
      dragged = null;
    }
    function placeMarker(target) {
      if (!marker) {
        marker = element(document, 'span', 'note-inline-media-drop');
        marker.setAttribute('aria-hidden', 'true');
        document.body.append(marker);
      }
      const { align, bounds, editorBounds, horizontal, y } = target;
      marker.classList.toggle('note-inline-media-drop-line', !align && Boolean(horizontal));
      marker.classList.toggle('note-inline-media-drop-wrap', Boolean(align));
      marker.textContent = align ? (align === 'left' ? '左侧环绕' : '右侧环绕') : '';
      const width = align ? Math.min(96, editorBounds.width * .26) : horizontal ? bounds.width : 2;
      const left = align ? (align === 'left' ? editorBounds.left : editorBounds.right - width) : bounds.left;
      marker.style.left = left + 'px';
      marker.style.top = (!align && horizontal ? y : bounds.top) + 'px';
      marker.style.width = width + 'px';
      marker.style.height = (align ? 28 : horizontal ? 2 : bounds.height) + 'px';
    }
    function activeDrag(event) {
      return dragged && editor.contains(dragged) && event.dataTransfer?.types.includes(dragType);
    }

    editor.addEventListener('dragstart', event => {
      const handle = event.target.closest?.('.note-inline-media-handle');
      if (!handle || handle.disabled || !event.dataTransfer || !editor.isContentEditable) return;
      dragged = closestMedia(handle);
      event.dataTransfer.setData(dragType, dragged.dataset.noteMedia);
      event.dataTransfer.effectAllowed = 'move';
      dragged.classList.add('note-inline-media-dragging');
    });
    editor.addEventListener('dragover', event => {
      if (!activeDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      placeMarker(dragTarget(editor, event));
    });
    editor.addEventListener('dragleave', event => {
      if (!editor.contains(event.relatedTarget)) clearMarker();
    });
    editor.addEventListener('drop', event => {
      if (!activeDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const { range, align } = dragTarget(editor, event);
      const media = dragged;
      finishDrag();
      const moved = !samePosition(range, media);
      if (moved) range.insertNode(media);
      if (alignBlock(media, align) || moved) onChange();
    });
    editor.addEventListener('dragend', finishDrag);

    function move(handle, direction) {
      const media = closestMedia(handle);
      if (editor.isContentEditable && editor.contains(media) && moveToNeighbor(editor, media, direction)) {
        handle.focus({ preventScroll: true });
        media.scrollIntoView({ block: 'nearest' });
        onChange();
      }
    }

    function finishResize(commit) {
      if (!resizing) return;
      const { button, media, pointerId, width } = resizing;
      resizing = null;
      media.classList.remove('note-inline-media-resizing');
      if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
      if (width !== undefined) suppressedResizeClick = button;
      if (commit && width !== undefined && editor.contains(media) && editor.isContentEditable) {
        if (saveWidth(media, width)) onChange();
      } else previewWidth(media, savedWidth(media));
    }

    editor.addEventListener('pointerdown', event => {
      hideCaretMarker();
      pressedPoint = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
      if (pressedPoint) showSelected(null);
      const button = event.target.closest?.('.note-inline-media-resize');
      if (!button || button.disabled || !editor.isContentEditable || event.button !== 0) return;
      suppressedResizeClick = null;
      finishResize(false);
      const media = closestMedia(button);
      resizing = {
        button, media, pointerId: event.pointerId, startX: event.clientX,
        initialWidth: media.getBoundingClientRect().width, width: undefined,
        direction: media.dataset.noteMediaAlign === 'right' ? -1 : 1,
      };
      button.setPointerCapture(event.pointerId);
      media.classList.add('note-inline-media-resizing');
    });
    editor.addEventListener('pointermove', event => {
      if (event.pointerId !== resizing?.pointerId) return;
      const delta = (event.clientX - resizing.startX) * resizing.direction;
      if (resizing.width === undefined && Math.abs(delta) < 3) return;
      resizing.width = resizedWidth(resizing.media, resizing.initialWidth, delta);
      previewWidth(resizing.media, resizing.width);
    });
    editor.addEventListener('pointerup', event => {
      if (event.pointerId === resizing?.pointerId) finishResize(true);
    });
    for (const name of ['pointercancel', 'lostpointercapture']) {
      editor.addEventListener(name, event => {
        if (event.pointerId === resizing?.pointerId) finishResize(false);
      });
    }
    document.defaultView.addEventListener('blur', () => finishResize(false));

    function adjustSize(button, direction) {
      const media = closestMedia(button);
      if (!editor.contains(media) || !editor.isContentEditable || button.disabled) return;
      const width = direction === 'reset' ? undefined :
        resizedWidth(media, media.getBoundingClientRect().width, direction === 'larger' ? resizeStep : -resizeStep);
      if (saveWidth(media, width)) onChange();
    }

    function insertLineBelow(media) {
      const clear = ['left', 'right'].includes(media.dataset.noteMediaAlign);
      setCaret(editor, boundary(media, false));
      const inserted = document.execCommand('insertParagraph');
      const node = document.getSelection().anchorNode;
      const block = (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest(paragraphSelector);
      if (!inserted || !block || block === editor || !editor.contains(block) || block.contains(media)) {
        setCaret(editor, insertParagraphAfter(editor, media, clear));
        onChange();
      } else if (clear) {
        block.classList.add('note-media-clear');
        onChange();
      }
    }

    editor.addEventListener('keydown', event => {
      hideCaretMarker();
      if (event.key === 'Escape' && resizing) {
        event.preventDefault();
        event.stopPropagation();
        finishResize(false);
        return;
      }
      const resize = event.target.closest?.('.note-inline-media-resize');
      const sizes = { ArrowLeft: 'smaller', ArrowRight: 'larger', Home: 'reset' };
      if (resize && sizes[event.key]) {
        event.preventDefault();
        event.stopPropagation();
        adjustSize(resize, sizes[event.key]);
        return;
      }
      if (!event.isComposing && event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && editor.isContentEditable) {
        const image = selectedImage(editor) || (selection(editor) && selected);
        if (image) {
          event.preventDefault();
          showSelected(null);
          insertLineBelow(image);
          return;
        }
      }
      if (selected && (event.key === 'Escape' || event.key.startsWith('Arrow'))) showSelected(null);
      const handle = event.target.closest?.('.note-inline-media-handle');
      if (!handle || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      move(handle, event.key === 'ArrowUp' ? 'up' : 'down');
    });
    editor.addEventListener('click', event => {
      if (!editor.isContentEditable || event.detail !== 1 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
        !pressedPoint || Math.hypot(event.clientX - pressedPoint.x, event.clientY - pressedPoint.y) > 4) return;
      const media = closestMedia(event.target);
      if (media) {
        if (event.target.nodeName === 'IMG') {
          const range = document.createRange();
          range.selectNode(media);
          setCaret(editor, range);
          showSelected(media);
        }
        return;
      }
      const { clientX, clientY } = event;
      if (!document.getSelection().isCollapsed || onTextLine(editor, document.caretRangeFromPoint(clientX, clientY), clientY)) return;
      const target = blankMediaTarget(editor, clientX, clientY);
      if (!target) return;
      if (target.below) insertLineBelow(target.media);
      else {
        const align = target.media.dataset.noteMediaAlign;
        const changed = !align && alignBlock(target.media, 'inline');
        const range = besideCaret(target.media, (align === 'inline' || !align) && target.before);
        if (['left', 'right'].includes(align) && range.startContainer.nodeType !== Node.TEXT_NODE) {
          // Floats do not supply an editable line box when no text follows them.
          let line = range.startContainer.childNodes[range.startOffset];
          if (line?.nodeName !== 'BR') {
            line = document.createElement('br');
            range.insertNode(line);
          }
          range.setStartBefore(line);
          range.collapse(true);
        }
        setCaret(editor, range);
        showCaretMarker(range);
        if (changed) onChange();
      }
    });
    editor.addEventListener('click', event => {
      const menus = window.InMomentMenus;
      if (!menus || !editor.isContentEditable) return;
      const resize = event.target.closest?.('.note-inline-media-resize');
      if (resize) {
        if (resize === suppressedResizeClick && event.detail) return;
        const media = closestMedia(resize);
        menus.open({
          anchor: resize,
          title: '调整媒体大小',
          items: [
            { id: 'larger', label: '放大' },
            { id: 'smaller', label: '缩小' },
            { id: 'reset', label: '恢复原尺寸', disabled: savedWidth(media) === undefined },
          ],
          onSelect: direction => adjustSize(resize, direction),
        });
        return;
      }
      const handle = event.target.closest?.('.note-inline-media-handle');
      if (!handle) return;
      const media = closestMedia(handle);
      const align = media.dataset.noteMediaAlign;
      menus.open({
        anchor: handle,
        title: '媒体位置与环绕',
        items: [
          { id: 'up', label: '上移', disabled: !neighbor(editor, media, 'up') },
          { id: 'down', label: '下移', disabled: !neighbor(editor, media, 'down') },
          { id: 'wrap-block', label: '独立成行', disabled: align === undefined },
          { id: 'wrap-inline', label: '与文字同行', disabled: align === 'inline' },
          { id: 'wrap-left', label: '靠左环绕', disabled: align === 'left' },
          { id: 'wrap-right', label: '靠右环绕', disabled: align === 'right' },
        ],
        onSelect: choice => {
          if (!editor.contains(media) || !editor.isContentEditable || handle.disabled) return;
          if (choice === 'up' || choice === 'down') move(handle, choice);
          else if (alignBlock(media, choice.slice(5))) onChange();
        },
      });
    });
  }

  window.InMomentNoteMedia = Object.freeze({ canEmbed, create, point, insert, insertTextBelow, insertOutlineBelow, bind, selection });
})();
