'use strict';
(() => {
  const maxOcrPixels = 24_000_000;
  const maxOcrSide = 32_767;
  const maxOcrBytes = 32 * 1024 * 1024;
  let ocrCancellation = Promise.resolve();
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const create = (tag, className = '', text = '') => {
    const element = document.createElement(tag);
    element.className = className;
    if (text) element.textContent = text;
    return element;
  };
  function action(id, label, icon, text = false) {
    const button = create('button', text ? 'button compact' : 'icon-button', text ? label : '');
    button.type = 'button';
    button.dataset.action = id;
    button.setAttribute('aria-label', label);
    button.title = label;
    if (icon) button.dataset.uiIcon = icon;
    return button;
  }
  function rectangle(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  }
  function localActions(invoke) {
    return {
      async recognize({ bytes, signal }) {
        const requestId = crypto.randomUUID();
        await ocrCancellation;
        signal.throwIfAborted();
        const cancel = () => {
          ocrCancellation = Promise.resolve(invoke('image:cancelRecognition', { requestId })).catch(() => {});
        };
        signal.addEventListener('abort', cancel, { once: true });
        try { return await invoke('image:recognize', { requestId, bytes }); }
        finally { signal.removeEventListener('abort', cancel); }
      },
      copyText: text => invoke('image:copyText', { text }),
      copyOutline: outline => invoke('image:copyOutline', { outline }),
      copyImage: bytes => invoke('image:copyEdited', { bytes }),
    };
  }
  function place(element, bounds, width, height) {
    element.style.left = 100 * bounds.x / width + '%';
    element.style.top = 100 * bounds.y / height + '%';
    element.style.width = 100 * bounds.width / width + '%';
    element.style.height = 100 * bounds.height / height + '%';
  }
  async function ocrPng(image, region, signal) {
    let scale = Math.min(1, maxOcrSide / region.width, maxOcrSide / region.height,
      Math.sqrt(maxOcrPixels / (region.width * region.height)));
    const canvas = create('canvas');
    try {
      while (true) {
        signal.throwIfAborted();
        canvas.width = Math.max(1, Math.floor(region.width * scale));
        canvas.height = Math.max(1, Math.floor(region.height * scale));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('无法准备图片文字识别。');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        signal.throwIfAborted();
        if (!blob) throw new Error('无法准备图片文字识别。');
        if (blob.size <= maxOcrBytes) return blob;
        scale *= .75;
      }
    } finally { canvas.width = canvas.height = 1; }
  }
  function boundsOf(bounds) {
    const { x, y, width, height } = bounds || {};
    return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 ? { x, y, width, height } : null;
  }
  function polygonOf(points) {
    return Array.isArray(points) && points.length === 4 && points.every(point =>
      Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) ? points : null;
  }
  function pointInPolygon(x, y, points) {
    let inside = false;
    for (let i = 0; i < points.length; i++) {
      const [startX, startY] = points[i];
      const [endX, endY] = points[(i + 1) % points.length];
      if ((startY > y) !== (endY > y) && x < startX + (endX - startX) * (y - startY) / (endY - startY)) inside = !inside;
    }
    return inside;
  }
  function polygonDistance(x, y, points) {
    if (pointInPolygon(x, y, points)) return 0;
    let distance = Infinity;
    for (let i = 0; i < points.length; i++) {
      const [startX, startY] = points[i];
      const [endX, endY] = points[(i + 1) % points.length];
      // Match the nearest-line preference of rectangular OCR units.
      const dx = endX - startX, dy = (endY - startY) * 2;
      const px = x - startX, py = (y - startY) * 2;
      const along = clamp((px * dx + py * dy) / (dx * dx + dy * dy || 1), 0, 1);
      distance = Math.min(distance, (px - along * dx) ** 2 + (py - along * dy) ** 2);
    }
    return distance;
  }
  function addLineUnits(units, line, lineBreak) {
    const start = units.length;
    let offset = 0, prior = '';
    function add(part) {
      const { text } = part;
      const index = line.text?.indexOf(text, offset) ?? -1;
      const gap = index >= 0 ? line.text.slice(offset, index) : '';
      const before = !prior ? lineBreak : (/^\s+$/u.test(gap) ? gap : '');
      units.push({ text, bounds: part.bounds, points: polygonOf(part.points), before });
      if (index >= 0) offset = index + text.length;
      prior = text;
    }
    for (const word of line.words || []) {
      if (!word.text?.trim()) continue;
      const symbols = (word.symbols || []).filter(symbol => symbol.text?.trim() && boundsOf(symbol.bounds));
      if (symbols.length && symbols.map(symbol => symbol.text).join('').replace(/\s+/gu, '') === word.text.replace(/\s+/gu, '')) {
        for (const symbol of symbols) add(symbol);
      } else if (boundsOf(word.bounds)) add(word);
    }
    if (units.length === start && line.text?.trim() && boundsOf(line.bounds)) add(line);
    return units.length > start;
  }
  function unitsFrom(result) {
    const units = [];
    for (const block of result.blocks || []) {
      let lineBreak = units.length ? '\n\n' : '';
      for (const line of block.lines || []) {
        if (addLineUnits(units, line, lineBreak)) lineBreak = '\n';
      }
    }
    return units;
  }

  class Viewer {
    constructor(options, release) {
      this.options = options;
      this.release = release;
      this.opener = options.opener || document.activeElement;
      this.source = '';
      this.urls = new Set();
      this.lifecycle = new AbortController();
      this.scale = 1;
      this.fit = true;
      this.build();
    }
    build() {
      const dialog = this.dialog = create('dialog', 'note-image-viewer');
      dialog.dataset.noteImageViewer = '';
      dialog.setAttribute('aria-labelledby', 'note-image-viewer-title');
      const header = create('header', 'note-image-viewer-header');
      const title = create('h2', '', this.options.name || '笔记图片');
      title.id = 'note-image-viewer-title';
      this.closeButton = action('close', '关闭图片', 'close');
      header.append(title, this.closeButton);

      const zoom = create('div', 'note-image-zoom');
      const zoomOut = action('zoom-out', '缩小图片', 'minus');
      const zoomIn = action('zoom-in', '放大图片', 'plus');
      const fit = action('fit', '适应窗口', 'expand', true);
      const actual = action('actual-size', '100%', null, true);
      actual.setAttribute('aria-label', '查看原始尺寸');
      actual.title = '查看原始尺寸';
      this.scaleLabel = create('span', 'note-image-scale', '—');
      zoom.append(zoomOut, this.scaleLabel, zoomIn, fit, actual);
      this.extract = action('extract', '提取图片文字', 'transcript', true);
      this.extract.setAttribute('aria-expanded', 'false');
      this.extract.setAttribute('aria-controls', 'note-image-ocr-result');
      this.regionButton = action('region', '框选提取', 'crop', true);
      this.regionButton.setAttribute('aria-pressed', 'false');
      this.edit = action('edit', '编辑图片', 'edit', true);
      this.toolbar = create('div', 'note-image-viewer-toolbar');
      this.toolbar.append(zoom, this.extract, this.regionButton, this.edit);
      this.imageControls = [zoomOut, zoomIn, fit, actual, this.extract, this.regionButton, this.edit];
      if (this.options.revealImage) {
        const reveal = action('reveal', '打开所在文件夹', 'folder', true);
        reveal.onclick = async () => {
          try { await this.options.revealImage(); }
          catch (error) { if (!this.closed) this.tell(error.message || '无法打开图片所在文件夹。', true); }
        };
        this.toolbar.append(reveal);
      }
      this.imageControls.forEach(button => { button.disabled = true; });

      const workspace = create('div', 'note-image-workspace');
      this.viewport = create('div', 'note-image-viewport');
      this.viewport.tabIndex = 0;
      this.viewport.setAttribute('role', 'region');
      this.viewport.setAttribute('aria-label', '图片预览区，滚轮缩放，拖动或方向键查看');
      this.viewport.setAttribute('aria-describedby', 'note-image-viewer-message');
      const stage = create('div', 'note-image-stage');
      this.surface = create('div', 'note-image-canvas');
      this.surface.hidden = true;
      this.image = create('img');
      this.image.alt = this.options.name || '笔记图片';
      this.image.draggable = false;
      this.overlay = create('div', 'note-image-ocr-overlay');
      this.overlay.setAttribute('aria-hidden', 'true');
      this.region = create('div', 'note-image-region');
      this.region.setAttribute('aria-hidden', 'true');
      this.region.hidden = true;
      this.surface.append(this.image, this.overlay, this.region);
      stage.append(this.surface);
      this.viewport.append(stage);
      this.editorHost = create('div', 'note-image-editor-host');
      this.editorHost.hidden = true;

      this.result = create('aside', 'note-image-result hidden');
      this.result.id = 'note-image-ocr-result';
      this.result.setAttribute('aria-labelledby', 'note-image-result-title');
      const resultHeader = create('header', 'note-image-result-header');
      this.resultTitle = create('h3', '', '图片文字');
      this.resultTitle.id = 'note-image-result-title';
      const resultClose = action('close-result', '关闭文字结果', 'close');
      this.resultViews = create('div', 'note-image-result-views');
      this.resultViews.setAttribute('role', 'group');
      this.resultViews.setAttribute('aria-label', '文字结果视图');
      this.outlineView = action('result-outline', '大纲', null, true);
      this.plainView = action('result-plain', '纯文字', null, true);
      this.outlineView.setAttribute('aria-controls', 'note-image-outline');
      this.plainView.setAttribute('aria-controls', 'note-image-plain');
      this.resultViews.append(this.outlineView, this.plainView);
      resultHeader.append(this.resultTitle, this.resultViews, resultClose);
      this.resultOutline = create('div', 'note-image-result-content note-image-outline');
      this.resultOutline.id = 'note-image-outline';
      this.resultOutline.dataset.action = 'result-outline-content';
      this.resultOutline.tabIndex = 0;
      this.resultOutline.setAttribute('role', 'region');
      this.resultOutline.setAttribute('aria-label', '图片文字大纲');
      this.resultText = create('textarea', 'note-image-result-content');
      this.resultText.id = 'note-image-plain';
      this.resultText.dataset.action = 'result-text';
      this.resultText.setAttribute('aria-label', '识别纯文字');
      this.resultText.readOnly = true;
      this.resultInfo = create('p');
      this.resultInfo.setAttribute('role', 'status');
      const resultActions = create('div', 'note-image-result-actions');
      this.copyAll = action('copy-all', '复制全部', null, true);
      this.insert = action('insert-below', '插入到图片下方', null, true);
      this.insert.classList.add('primary');
      resultActions.append(this.copyAll, this.insert);
      this.result.append(resultHeader, this.resultOutline, this.resultText, this.resultInfo, resultActions);
      workspace.append(this.viewport, this.editorHost, this.result);

      this.status = create('footer', 'note-image-viewer-status');
      this.message = create('p', '', '正在读取原图…');
      this.message.id = 'note-image-viewer-message';
      this.message.setAttribute('role', 'status');
      this.copySelected = action('copy-selected', '复制选中文字', null, true);
      this.copySelected.hidden = true;
      this.status.append(this.message, this.copySelected);
      dialog.append(header, this.toolbar, workspace, this.status);
      document.body.append(dialog);

      this.closeButton.onclick = () => { void this.requestClose(); };
      zoomOut.onclick = () => this.zoom(this.scale / 1.25);
      zoomIn.onclick = () => this.zoom(this.scale * 1.25);
      fit.onclick = () => this.fitImage();
      actual.onclick = () => this.zoom(1);
      this.extract.onclick = () => this.extractAll();
      this.regionButton.onclick = () => this.toggleRegion();
      this.edit.onclick = () => this.startEditor();
      resultClose.onclick = () => this.hideResult(true);
      this.outlineView.onclick = () => this.setResultView('outline', true);
      this.plainView.onclick = () => this.setResultView('plain', true);
      this.copySelected.onclick = () => this.copy(this.selectionText());
      this.copyAll.onclick = () => this.copyResult();
      this.insert.onclick = () => this.insertResult();
      this.resultText.addEventListener('copy', event => {
        const text = this.resultSelection();
        if (text) { event.preventDefault(); this.copy(text); }
      });
      this.viewport.addEventListener('wheel', event => {
        if (!this.ready || this.drag) return;
        event.preventDefault();
        this.zoom(this.scale * Math.exp(-event.deltaY * .0015), event);
      }, { passive: false });
      this.viewport.addEventListener('dblclick', event => {
        if (!this.ready || event.target.closest('.note-image-ocr-unit') || this.regionMode) return;
        if (this.fit) this.zoom(1, event); else this.fitImage();
      });
      this.viewport.addEventListener('pointerdown', event => this.beginPointer(event));
      this.viewport.addEventListener('pointermove', event => this.movePointer(event));
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        this.viewport.addEventListener(type, event => this.endPointer(event));
      }
      dialog.addEventListener('keydown', event => this.keydown(event));
      dialog.addEventListener('keyup', event => { if (event.key === ' ') this.space = false; });
      this.viewport.addEventListener('blur', () => { this.space = false; });
      dialog.addEventListener('cancel', event => { event.preventDefault(); this.escape(); });
      dialog.addEventListener('close', () => this.finish('close'));
      this.resize = new ResizeObserver(() => { if (this.ready && this.fit && !this.editor) this.fitImage(); });
      this.resize.observe(this.viewport);
    }
    show() {
      this.dialog.showModal();
      window.InMomentMotion?.enter(this.dialog, { kind: 'dialog' });
      this.closeButton.focus({ preventScroll: true });
      void this.load();
    }
    addUrl(blob) {
      const url = URL.createObjectURL(blob);
      this.urls.add(url);
      return url;
    }
    async load() {
      const { signal } = this.lifecycle;
      try {
        const { readImage, url } = this.options;
        if (readImage) {
          const { bytes, mime } = await readImage();
          signal.throwIfAborted();
          this.source = this.addUrl(new Blob([bytes], { type: mime }));
        } else this.source = url;
        this.image.src = this.source;
        await this.image.decode();
        signal.throwIfAborted();
        this.width = this.image.naturalWidth;
        this.height = this.image.naturalHeight;
        if (!this.width || !this.height) throw new Error('图片没有可预览的内容。');
        if (this.options.animated || /\.gif$/i.test(this.options.name || '')) {
          const frame = await ocrPng(this.image, this.imageBounds(), signal);
          signal.throwIfAborted();
          this.source = this.addUrl(frame);
          this.image.src = this.source;
          await this.image.decode();
          signal.throwIfAborted();
          this.width = this.image.naturalWidth;
          this.height = this.image.naturalHeight;
          this.stillFrame = true;
        }
        this.ready = true;
        this.surface.hidden = false;
        this.imageControls.forEach(button => { button.disabled = false; });
        this.fitImage();
        void this.recognize('full');
      } catch (error) {
        if (!signal.aborted) this.tell(error.message || '图片无法预览。', true);
      }
    }
    imageBounds() { return { x: 0, y: 0, width: this.width, height: this.height }; }
    tell(message, error = false) {
      this.message.textContent = message;
      this.message.dataset.tone = error ? 'error' : '';
    }
    fitImage() {
      if (!this.ready) return;
      this.fit = true;
      const viewport = this.viewport;
      this.size(Math.min(1, Math.max(1, viewport.clientWidth - 32) / this.width, Math.max(1, viewport.clientHeight - 32) / this.height));
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
    size(scale) {
      this.scale = scale;
      this.surface.style.width = this.width * scale + 'px';
      this.surface.style.height = this.height * scale + 'px';
      this.scaleLabel.textContent = Math.max(1, Math.round(scale * 100)) + '%';
    }
    zoom(next, event) {
      if (!this.ready) return;
      const viewport = this.viewport;
      const viewRect = viewport.getBoundingClientRect();
      const imageRect = this.surface.getBoundingClientRect();
      const x = event?.clientX ?? viewRect.left + viewRect.width / 2;
      const y = event?.clientY ?? viewRect.top + viewRect.height / 2;
      const imageX = clamp((x - imageRect.left) / imageRect.width, 0, 1);
      const imageY = clamp((y - imageRect.top) / imageRect.height, 0, 1);
      const min = Math.min(.05, Math.max(1, viewRect.width - 32) / this.width, Math.max(1, viewRect.height - 32) / this.height);
      this.fit = false;
      this.size(clamp(next, min, 8));
      const after = this.surface.getBoundingClientRect();
      viewport.scrollLeft += after.left + after.width * imageX - x;
      viewport.scrollTop += after.top + after.height * imageY - y;
    }
    imagePoint(event) {
      const bounds = this.surface.getBoundingClientRect();
      return { x: clamp((event.clientX - bounds.left) * this.width / bounds.width, 0, this.width),
        y: clamp((event.clientY - bounds.top) * this.height / bounds.height, 0, this.height) };
    }
    beginPointer(event) {
      if (!this.ready || this.drag || event.button !== 0) return;
      const scrollbar = event.target === this.viewport && (event.offsetX >= this.viewport.clientWidth || event.offsetY >= this.viewport.clientHeight);
      if (scrollbar) return;
      const target = event.target.closest('.note-image-ocr-unit');
      const point = this.imagePoint(event);
      const kind = this.regionMode && !this.space ? 'region' : target && !this.space ? 'text' : 'pan';
      const drag = { id: event.pointerId, x: event.clientX, y: event.clientY, point, kind,
        left: this.viewport.scrollLeft, top: this.viewport.scrollTop, moved: false };
      if (kind === 'region') this.showRegion(rectangle(point, point));
      else if (kind === 'text') {
        drag.anchor = Number(target.dataset.ocrIndex);
        this.selectText(drag.anchor, drag.anchor);
      } else this.clearText();
      this.drag = drag;
      this.viewport.dataset.gesture = kind;
      this.viewport.focus({ preventScroll: true });
      this.viewport.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
    movePointer(event) {
      const drag = this.drag;
      if (drag?.id !== event.pointerId) return;
      drag.moved ||= Math.hypot(drag.x - event.clientX, drag.y - event.clientY) > 2;
      if (drag.kind === 'pan') {
        this.viewport.scrollLeft = drag.left + drag.x - event.clientX;
        this.viewport.scrollTop = drag.top + drag.y - event.clientY;
      } else if (drag.kind === 'region') this.showRegion(rectangle(drag.point, this.imagePoint(event)));
      else if (drag.moved) {
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.note-image-ocr-unit');
        const end = target ? Number(target.dataset.ocrIndex) : this.nearestText(this.imagePoint(event));
        this.selectText(drag.anchor, end);
      }
    }
    endPointer(event) {
      const drag = this.drag;
      if (drag?.id !== event.pointerId) return;
      this.drag = null;
      delete this.viewport.dataset.gesture;
      if (drag.kind === 'region') {
        if (drag.moved && event.type === 'pointerup') this.extractRegion(rectangle(drag.point, this.imagePoint(event)));
        else if (event.type !== 'pointerup') this.keyboardRegion();
      } else if (drag.kind === 'text' && event.type !== 'pointerup') this.clearText();
    }
    showRegion(bounds) {
      this.regionBox = bounds;
      this.region.hidden = false;
      place(this.region, bounds, this.width, this.height);
    }
    keyboardRegion() {
      this.showRegion({ x: this.width / 4, y: this.height / 4, width: this.width / 2, height: this.height / 2 });
    }
    toggleRegion() {
      if (this.regionMode) { this.endRegion(); return; }
      this.clearText();
      this.hideResult();
      this.regionMode = true;
      this.regionButton.setAttribute('aria-pressed', 'true');
      this.viewport.dataset.mode = 'region';
      this.keyboardRegion();
      this.viewport.focus({ preventScroll: true });
      this.tell('拖动框选，或用方向键移动、Shift + 方向键调整、Enter 提取。');
    }
    endRegion() {
      this.regionMode = false;
      this.regionButton.setAttribute('aria-pressed', 'false');
      delete this.viewport.dataset.mode;
      this.region.hidden = true;
      if (this.fullResult) this.tell(this.summaryMessage(this.fullResult));
      else if (this.ocr) this.tell('正在识别图片文字…');
      else this.tell('可缩放图片或提取文字。');
    }
    extractRegion(bounds) {
      if (bounds.width < 2 || bounds.height < 2) {
        this.keyboardRegion();
        this.tell('请框选有文字的区域。');
        return;
      }
      const x = Math.floor(bounds.x), y = Math.floor(bounds.y);
      const region = { x, y, width: Math.ceil(bounds.x + bounds.width) - x, height: Math.ceil(bounds.y + bounds.height) - y };
      this.endRegion();
      this.showRegion(region);
      this.showResult('region');
      void this.recognize('region', region);
    }
    keyboardRegionMove(event) {
      const box = this.regionBox;
      const step = Math.max(1, Math.round(8 / this.scale));
      const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
      const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
      if (event.shiftKey) {
        this.showRegion({ ...box, width: clamp(box.width + dx, 2, this.width - box.x), height: clamp(box.height + dy, 2, this.height - box.y) });
      } else {
        this.showRegion({ ...box, x: clamp(box.x + dx, 0, this.width - box.width), y: clamp(box.y + dy, 0, this.height - box.height) });
      }
      this.region.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    keydown(event) {
      // Prevent note-level shortcuts from seeing dialog gestures.
      event.stopPropagation();
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); this.escape(); return; }
      if (this.editor || this.result.contains(event.target) || event.target.closest('input,textarea,[contenteditable]')) return;
      const control = event.ctrlKey || event.metaKey;
      if (control && event.key.toLowerCase() === 'c' && this.textRange) {
        event.preventDefault();
        this.copy(this.selectionText());
        return;
      }
      if (control || event.altKey || !this.ready) return;
      if (event.key === '+' || event.key === '=') { event.preventDefault(); this.zoom(this.scale * 1.25); }
      if (event.key === '-') { event.preventDefault(); this.zoom(this.scale / 1.25); }
      if (event.key === '0') { event.preventDefault(); this.fitImage(); }
      if (event.key === '1') { event.preventDefault(); this.zoom(1); }
      if (event.target !== this.viewport) return;
      if (event.key === ' ') { event.preventDefault(); this.space = true; }
      if (!this.regionMode) {
        if (event.key.startsWith('Arrow')) {
          event.preventDefault();
          this.viewport.scrollBy({ left: event.key === 'ArrowLeft' ? -40 : event.key === 'ArrowRight' ? 40 : 0,
            top: event.key === 'ArrowUp' ? -40 : event.key === 'ArrowDown' ? 40 : 0 });
        }
        return;
      }
      if (event.key.startsWith('Arrow')) { event.preventDefault(); this.keyboardRegionMove(event); }
      if (event.key === 'Enter') { event.preventDefault(); this.extractRegion(this.regionBox); }
    }
    escape() {
      if (this.regionMode) { this.endRegion(); this.regionButton.focus(); return; }
      if (this.panelMode) { this.hideResult(true); return; }
      if (this.textRange) { this.clearText(); return; }
      void this.requestClose(Boolean(this.editor));
    }
    nearestText({ x, y }) {
      let best = 0, distance = Infinity;
      this.units.forEach(({ bounds, points }, index) => {
        const dx = x - clamp(x, bounds.x, bounds.x + bounds.width);
        const dy = y - clamp(y, bounds.y, bounds.y + bounds.height);
        const boundsDistance = dx * dx + dy * dy * 4;
        if (boundsDistance >= distance) return;
        const weight = points ? polygonDistance(x, y, points) : boundsDistance;
        if (weight < distance) { best = index; distance = weight; }
      });
      return best;
    }
    selectText(a, b) {
      const first = Math.min(a, b), last = Math.max(a, b);
      if (this.textRange?.first === first && this.textRange.last === last) return;
      const previous = this.textRange;
      this.textRange = { first, last };
      if (previous) {
        for (let i = previous.first; i <= previous.last; i++) {
          if (i < first || i > last) delete this.units[i].element.dataset.selected;
        }
      }
      for (let i = first; i <= last; i++) this.units[i].element.dataset.selected = '';
      this.copySelected.hidden = false;
    }
    selectionText() {
      if (!this.textRange) return '';
      const { first, last } = this.textRange;
      return this.units.slice(first, last + 1).map(({ before, text }, i) => (i ? before : '') + text).join('');
    }
    clearText() {
      if (!this.textRange) return;
      const { first, last } = this.textRange;
      for (let i = first; i <= last; i++) delete this.units[i].element.dataset.selected;
      this.textRange = null;
      this.copySelected.hidden = true;
    }
    setOverlay(result) {
      this.clearText();
      const fragment = document.createDocumentFragment();
      const scaleX = this.width / result.width, scaleY = this.height / result.height;
      this.units = unitsFrom(result).map((unit, index) => {
        const element = create('span', 'note-image-ocr-unit');
        element.dataset.ocrIndex = String(index);
        const { x, y, width, height } = unit.bounds;
        place(element, unit.bounds, result.width, result.height);
        if (unit.points) {
          const points = unit.points.map(([px, py]) => `${100 * (px - x) / width}% ${100 * (py - y) / height}%`);
          element.style.clipPath = `polygon(${points.join(', ')})`;
        }
        fragment.append(element);
        return { ...unit, bounds: { x: x * scaleX, y: y * scaleY, width: width * scaleX, height: height * scaleY },
          points: unit.points?.map(([px, py]) => [px * scaleX, py * scaleY]), element };
      });
      this.overlay.replaceChildren(fragment);
    }
    summaryMessage(result) {
      const note = this.stillFrame ? ' · GIF 静帧' : '';
      return (result?.text?.trim() ? '拖动选择图片文字，Ctrl+C 复制' : '这张图片未识别到文字') + note;
    }
    stopOcr() {
      const job = this.ocr;
      this.ocr = null;
      job?.controller.abort();
    }
    async recognize(mode, region = this.imageBounds(), providedBytes) {
      this.stopOcr();
      const job = { mode, controller: new AbortController() };
      this.ocr = job;
      const { signal } = job.controller;
      if (!this.regionMode) this.tell('正在识别图片文字…');
      if (this.panelMode === mode) this.resultInfo.textContent = '正在识别…';
      try {
        const bytes = providedBytes || new Uint8Array(await (await ocrPng(this.image, region, signal)).arrayBuffer());
        signal.throwIfAborted();
        const result = await this.options.recognize({ bytes, signal });
        if (this.ocr !== job || this.closed) return;
        if (mode === 'full') {
          this.fullResult = result;
          this.setOverlay(result);
        }
        if (this.panelMode === mode) this.displayResult(result);
        if (!this.regionMode) this.tell(mode === 'full' ? this.summaryMessage(result) : result.text?.trim() ? '文字识别完成。' : '选定范围未识别到文字。');
      } catch (error) {
        if (this.ocr !== job || signal.aborted || this.closed) return;
        const message = error.message || '图片文字识别失败。';
        if (this.panelMode === mode) this.resultInfo.textContent = message;
        if (!this.regionMode) this.tell(message, true);
      } finally {
        if (this.ocr === job) this.ocr = null;
      }
    }
    extractAll() {
      this.endRegion();
      this.showResult('full', this.fullResult);
      if (!this.fullResult && this.ocr?.mode !== 'full') void this.recognize('full');
    }
    showResult(mode, result) {
      this.panelMode = mode;
      this.resultTitle.textContent = mode === 'region' ? '区域文字' : '图片文字';
      this.extract.setAttribute('aria-expanded', String(mode === 'full'));
      this.displayResult(result);
      if (window.InMomentMotion) window.InMomentMotion.show(this.result, true);
      else this.result.classList.remove('hidden');
      this.resultContent().focus({ preventScroll: true });
    }
    hideResult(restore = false) {
      if (!this.panelMode) return;
      const mode = this.panelMode;
      this.panelMode = null;
      if (mode !== 'full' && this.ocr?.mode === mode) this.stopOcr();
      this.extract.setAttribute('aria-expanded', 'false');
      if (window.InMomentMotion) window.InMomentMotion.show(this.result, false);
      else this.result.classList.add('hidden');
      if (mode === 'region') this.region.hidden = true;
      if (restore) {
        if (this.editor) this.editor.focus();
        else {
          (mode === 'region' ? this.regionButton : this.extract).focus({ preventScroll: true });
          this.tell(this.fullResult ? this.summaryMessage(this.fullResult) : '可缩放图片或提取文字。');
        }
      }
    }
    displayResult(result) {
      const text = result?.text?.trim() || '';
      const render = window.InMomentNoteOutline?.render;
      const outline = result?.outline;
      this.resultData = render && (outline?.roots?.length || outline?.unassigned?.length) ? outline : null;
      this.resultText.value = text;
      this.resultText.setSelectionRange(0, 0);
      this.resultOutline.replaceChildren();
      if (this.resultData) this.resultOutline.append(render(document, this.resultData));
      this.resultOutline.scrollTop = 0;
      this.resultViews.hidden = !this.resultData;
      this.resultInfo.textContent = '';
      if (!result) this.resultInfo.textContent = '正在识别…';
      else if (!text && !this.resultData) this.resultInfo.textContent = '这个范围未识别到文字。';
      this.setResultView(this.resultData ? 'outline' : 'plain');
    }
    setResultView(view, animate = false) {
      const previous = this.resultContent();
      const moveFocus = document.activeElement === previous;
      this.resultView = view;
      const content = this.resultContent();
      const outline = view === 'outline';
      this.outlineView.setAttribute('aria-pressed', String(outline));
      this.plainView.setAttribute('aria-pressed', String(!outline));
      this.resultOutline.hidden = !outline;
      this.resultText.hidden = outline;
      this.updateInsert();
      if (previous === content) return;
      if (moveFocus) content.focus({ preventScroll: true });
      if (animate) void window.InMomentMotion?.enter(content, { kind: 'reveal' });
    }
    resultContent() {
      return this.resultView === 'outline' ? this.resultOutline : this.resultText;
    }
    resultSelection() {
      const input = this.resultText;
      return input.value.slice(input.selectionStart, input.selectionEnd);
    }
    updateInsert() {
      const outline = this.resultView === 'outline';
      const hasContent = outline ? Boolean(this.resultData) : Boolean(this.resultText.value.trim());
      this.copyAll.disabled = !hasContent || outline && !this.options.copyOutline;
      const insert = outline ? this.options.insertOutline : this.options.insertText;
      this.insert.hidden = !insert;
      this.insert.disabled = !hasContent || this.inserting;
    }
    async copy(text) {
      if (!text.trim() || this.closed) return;
      try {
        await this.options.copyText(text);
        if (!this.closed) this.tell('文字已复制。');
      } catch (error) { if (!this.closed) this.tell(error.message || '无法复制文字。', true); }
    }
    async copyResult() {
      if (this.resultView !== 'outline') return this.copy(this.resultText.value);
      if (this.closed || !this.resultData || !this.options.copyOutline) return;
      try {
        await this.options.copyOutline(this.resultData);
        if (!this.closed) this.tell('大纲已复制。');
      } catch (error) { if (!this.closed) this.tell(error.message || '无法复制大纲。', true); }
    }
    async insertResult() {
      const outline = this.resultView === 'outline';
      const value = outline ? this.resultData : this.resultSelection().trim() || this.resultText.value.trim();
      const insert = outline ? this.options.insertOutline : this.options.insertText;
      if (!value || !insert || this.inserting || this.closed || this.editor?.isBusy?.()) return;
      if (this.editor?.isDirty() && !await this.confirmDiscard('插入文字并放弃图片修改')) return;
      if (this.closed || this.inserting) return;
      this.inserting = true;
      this.updateInsert();
      try {
        const focus = await insert(value);
        if (!this.closed) this.finish('insert', focus);
      } catch (error) { if (!this.closed) this.tell(error.message || '无法插入识别文字。', true); }
      finally { this.inserting = false; this.updateInsert(); }
    }
    startEditor() {
      const editor = window.InMomentNoteImageEditor;
      if (!this.ready || !editor || this.editor) return;
      this.endRegion();
      this.clearText();
      this.hideResult();
      this.stopOcr();
      this.editor = editor.create({
        url: this.source,
        name: this.options.name,
        onCopy: this.options.copyImage && (async bytes => {
          await this.options.copyImage(bytes);
          if (!this.closed) this.tell('编辑后的图片已复制。');
        }),
        onReplace: this.options.replaceImage && (async bytes => {
          const focus = await this.options.replaceImage(bytes);
          if (!this.closed) this.finish('replace', focus);
        }),
        onCancel: () => this.requestClose(true),
        onRecognize: async bytes => {
          if (this.closed || !this.editor) return;
          this.showResult('edited');
          await this.recognize('edited', undefined, bytes);
        },
        onChange: () => {
          this.stopOcr();
          if (this.panelMode === 'edited') this.hideResult();
          this.tell(this.options.replaceImage ? '可替换笔记图片，或复制编辑后的图片。' : '可复制编辑后的图片。');
        },
        onDirtyChange: dirty => this.options.onDirtyChange?.(dirty),
      });
      this.editorHost.append(this.editor.element);
      this.editorHost.hidden = false;
      this.toolbar.hidden = this.viewport.hidden = true;
      this.dialog.classList.add('note-image-editing');
      this.tell(this.stillFrame ? '正在编辑 GIF 静帧。' : '');
      this.editor.focus();
    }
    leaveEditor() {
      this.stopOcr();
      this.hideResult();
      this.editor.dispose();
      this.editor = null;
      this.options.onDirtyChange?.(false);
      this.editorHost.replaceChildren();
      this.editorHost.hidden = true;
      this.dialog.classList.remove('note-image-editing');
      this.toolbar.hidden = this.viewport.hidden = false;
      if (this.fit) this.fitImage();
      this.edit.focus({ preventScroll: true });
      if (this.fullResult) this.tell(this.summaryMessage(this.fullResult));
      else void this.recognize('full');
    }
    async confirmDiscard(accept = '放弃修改') {
      if (this.confirming) return false;
      this.confirming = true;
      try {
        const options = { title: '放弃图片修改？', message: '放弃后将丢弃本次图片修改。', buttons: ['继续编辑', accept], cancelId: 0, danger: true };
        if (window.InMomentDialogs) return await window.InMomentDialogs.request(options) === 1;
        return await this.confirmInViewer(options);
      } finally { this.confirming = false; }
    }
    confirmInViewer(options) {
      const prompt = create('dialog', 'note-image-discard-dialog');
      const title = create('h2', '', options.title);
      title.id = 'note-image-discard-title';
      prompt.setAttribute('aria-labelledby', title.id);
      const actions = create('div', 'note-image-result-actions');
      const keep = action('keep-editing', options.buttons[0], null, true);
      const discard = action('discard-edit', options.buttons[1], null, true);
      discard.classList.add('danger');
      actions.append(keep, discard);
      prompt.append(title, create('p', '', options.message), actions);
      document.body.append(prompt);
      const opener = document.activeElement;
      return new Promise(resolve => {
        const settle = accept => {
          this.dismissPrompt = null;
          prompt.close();
          prompt.remove();
          if (opener?.isConnected) opener.focus({ preventScroll: true });
          resolve(accept);
        };
        this.dismissPrompt = () => settle(false);
        keep.onclick = this.dismissPrompt;
        discard.onclick = () => settle(true);
        prompt.addEventListener('cancel', event => { event.preventDefault(); settle(false); });
        prompt.showModal();
        window.InMomentMotion?.enter(prompt, { kind: 'dialog' });
        keep.focus({ preventScroll: true });
      });
    }
    async requestClose(editorOnly = false, restoreFocus = true) {
      if (this.closed || this.inserting || this.editor?.isBusy?.()) return false;
      if (this.editor?.isDirty() && !await this.confirmDiscard()) return false;
      if (this.closed) return false;
      if (editorOnly && this.editor) this.leaveEditor();
      else this.finish('close', undefined, { restoreFocus });
      return true;
    }
    finish(reason, focus, { restoreFocus = true, immediate = false } = {}) {
      if (this.closed) return;
      this.closed = true;
      this.release();
      this.dismissPrompt?.();
      this.lifecycle.abort();
      this.stopOcr();
      this.resize.disconnect();
      const motion = window.InMomentMotion;
      const snapshot = !immediate && this.dialog.open && !this.editor && motion?.snapshot(this.dialog);
      this.editor?.dispose();
      if (this.dialog.open) this.dialog.close();
      this.dialog.remove();
      const revoke = () => { for (const url of this.urls) URL.revokeObjectURL(url); };
      if (snapshot) void motion.leaveSnapshot(snapshot, 'dialog').finally(revoke); else revoke();
      this.options.onDirtyChange?.(false);
      this.options.onClose?.({ reason });
      const fallback = this.opener?.isConnected ? this.opener : this.options.fallbackFocus;
      const target = focus instanceof HTMLElement ? focus : reason !== 'insert' ? fallback : null;
      if (restoreFocus && target?.isConnected) target.focus({ preventScroll: true });
    }
  }

  let active;
  function open(options) {
    if (active) return false;
    const actions = options.invoke ? localActions(options.invoke) : {};
    active = new Viewer({ ...actions, ...options }, () => { active = null; });
    active.show();
    return true;
  }
  const matches = owner => Boolean(active) && (owner === undefined || active.options.owner === owner);
  window.InMomentNoteImageViewer = Object.freeze({
    open,
    openLocal: open,
    close({ force = false, restoreFocus = true, owner } = {}) {
      if (!matches(owner)) return true;
      if (!force) return active.requestClose(false, restoreFocus);
      active.finish('close', undefined, { restoreFocus, immediate: true });
      return true;
    },
    isOpen: matches,
    isDirty: owner => matches(owner) && Boolean(active.editor?.isDirty())
  });
})();
