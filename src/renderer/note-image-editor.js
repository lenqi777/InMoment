'use strict';
(() => {
  const { EditorModel, rectangle, boundedPoint, paint } = window.InMomentScreenshotModel;
  const tools = [
    ['crop', '裁剪', 'crop'], ['pen', '画笔', 'pen'], ['highlighter', '荧光笔'],
    ['rectangle', '矩形', 'rectangle'], ['ellipse', '椭圆', 'ellipse'],
    ['arrow', '箭头', 'arrow'], ['text', '文字', 'text']
  ];
  const colors = [
    ['#256d49', '绿色'], ['#b42318', '红色'], ['#1768b4', '蓝色'],
    ['#d5a72c', '黄色'], ['#171a1d', '黑色'], ['#ffffff', '白色']
  ];
  const freehand = tool => tool === 'pen' || tool === 'highlighter';
  const full = (width, height) => ({ x: 0, y: 0, width, height });
  const maxOutputPixels = 24000000;
  const maxOutputBytes = 32 * 1024 * 1024;

  class PhotoDocument extends EditorModel {
    constructor(width, height) {
      super(width, height);
      this.selection = full(width, height);
      this.previous = null;
    }
    snapshot() {
      return { ...super.snapshot(), width: this.width, height: this.height, previous: this.previous };
    }
    frame() {
      return { width: this.width, height: this.height, items: this.items, previous: this.previous };
    }
    changedFrame(width, height, transform) {
      return { width, height, items: [], previous: { frame: this.frame(), transform } };
    }
    applyFrame({ width, height, items, previous }) {
      this.save();
      Object.assign(this, { width, height, items, previous, selection: full(width, height) });
    }
    rotation(angle) {
      const radians = angle * Math.PI / 180;
      const sin = Math.abs(angle) === 90 ? Math.sign(angle) : Math.sin(radians);
      const cos = Math.abs(angle) === 90 ? 0 : Math.cos(radians);
      const width = Math.ceil(Math.abs(this.width * cos) + Math.abs(this.height * sin));
      const height = Math.ceil(Math.abs(this.height * cos) + Math.abs(this.width * sin));
      if (width * height > 120000000) throw new Error('旋转后的图片尺寸过大，请先裁剪。');
      const x = (width - this.width * cos + this.height * sin) / 2;
      const y = (height - this.width * sin - this.height * cos) / 2;
      return this.changedFrame(width, height, [cos, sin, -sin, cos, x, y]);
    }
    crop({ x, y, width, height }) {
      if (width === this.width && height === this.height) return false;
      this.applyFrame(this.changedFrame(width, height, [1, 0, 0, 1, -x, -y]));
      return true;
    }
  }

  // Geometry operations clip each preceding frame. Annotation paths stay in source pixels.
  function drawFrame(context, image, frame) {
    const frames = [];
    while (frame) {
      context.save();
      context.beginPath();
      context.rect(0, 0, frame.width, frame.height);
      context.clip();
      frames.push(frame);
      const previous = frame.previous;
      if (previous) context.transform(...previous.transform);
      frame = previous?.frame;
    }
    context.drawImage(image, 0, 0);
    for (let i = frames.length - 1; i >= 0; i--) {
      for (const item of frames[i].items) paint(context, item);
      context.restore();
    }
  }

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text) item.textContent = text;
    return item;
  }

  function create({ url, name, onCopy, onReplace, onCancel, onRecognize, onChange, onDirtyChange }) {
    const element = node('section', 'note-image-editor');
    element.setAttribute('aria-label', '编辑图片');
    const toolbar = node('div', 'note-image-editor-toolbar');
    const drawings = node('div', 'note-image-editor-tools');
    const geometry = node('div', 'note-image-editor-tools');
    const settings = node('div', 'note-image-editor-tools');
    const adjustments = node('div', 'note-image-editor-adjustments');
    const viewport = node('div', 'note-image-editor-viewport');
    const page = node('div', 'note-image-editor-page');
    const canvas = node('canvas', 'note-image-editor-canvas');
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', `标注画布${name ? ' · ' + name : ''}`);
    const cropGuide = node('div', 'note-image-editor-crop');
    cropGuide.hidden = true;
    cropGuide.setAttribute('aria-hidden', 'true');
    const entry = node('textarea', 'note-image-editor-text');
    entry.hidden = true;
    entry.rows = 2;
    entry.maxLength = 4000;
    entry.setAttribute('aria-label', '图片标注文字');
    page.append(canvas, cropGuide, entry);
    viewport.append(page);
    const footer = node('div', 'note-image-editor-footer');
    const feedback = node('p', 'note-image-editor-status', '正在读取原图…');
    feedback.setAttribute('role', 'status');
    const outputs = node('div', 'note-image-editor-tools');
    footer.append(feedback, outputs);
    toolbar.append(drawings, settings, geometry);
    element.append(toolbar, adjustments, viewport, footer);

    const image = new Image();
    const controls = [];
    const toolButtons = new Map();
    const swatches = new Map();
    let model, tool = 'pen', penColor = colors[0][0], highlightColor = colors[3][0];
    let zoom = null, scale = 1, renderRequest = 0, angle = null, crop = null;
    let draft = null, drag = null, textMark = null, spaceDown = false;
    let busy = false, disposed = false, lastDirty = false;

    function button(label, action, { icon, iconOnly = false, tone = '', needsImage = true } = {}) {
      const control = node('button', iconOnly ? 'icon-button' : `button compact ${tone}`, iconOnly ? '' : label);
      control.type = 'button';
      control.title = label;
      if (iconOnly) control.setAttribute('aria-label', label);
      if (icon) control.dataset.uiIcon = icon;
      control.addEventListener('click', action);
      if (needsImage) controls.push(control);
      return control;
    }

    function status(message, failed = false) {
      if (disposed) return;
      feedback.textContent = message;
      feedback.classList.toggle('has-error', failed);
    }

    function change() {
      status('');
      onChange?.();
      scheduleDraw();
    }

    const color = () => tool === 'highlighter' ? highlightColor : penColor;
    for (const [id, label, icon] of tools) {
      const control = button(label, event => selectTool(id, event.detail === 0), { icon, iconOnly: Boolean(icon) });
      toolButtons.set(id, control);
      drawings.append(control);
    }

    function selectTool(id, keyboard) {
      commitText();
      if (id !== 'crop') crop = null;
      else if (keyboard && !crop) {
        const { width, height } = model;
        crop = rectangle({ x: width * .1, y: height * .1 }, { x: width * .9, y: height * .9 }, width, height);
        canvas.focus({ preventScroll: true });
      }
      angle = null;
      tool = id;
      renderControls();
      scheduleDraw();
    }

    const palette = node('div', 'note-image-editor-palette');
    palette.setAttribute('role', 'group');
    palette.setAttribute('aria-label', '标注颜色');
    for (const [value, label] of colors) {
      const swatch = button(label, () => {
        if (tool === 'highlighter') highlightColor = value;
        else penColor = value;
        renderControls();
      }, { iconOnly: true });
      swatch.classList.add('note-image-editor-swatch');
      swatch.style.setProperty('--note-mark-color', value);
      if (label === '黑色' || label === '白色') swatch.classList.add('is-neutral');
      swatch.append(node('span'));
      swatches.set(value, swatch);
      palette.append(swatch);
    }
    settings.append(palette);
    const sizeLabel = node('label', 'note-image-editor-size');
    const sizeName = node('span', '', '粗细');
    const size = node('select');
    const sizes = [[2, '细'], [3, '中'], [6, '粗']];
    const fonts = [[16, '16'], [20, '20'], [28, '28']];
    let penSize = 3, fontSize = 20;
    size.addEventListener('change', () => {
      if (tool === 'text') fontSize = Number(size.value);
      else penSize = Number(size.value);
    });
    sizeLabel.append(sizeName, size);
    settings.append(sizeLabel);

    const zoomOut = button('缩小', () => changeZoom((zoom ?? scale) / 1.25), { icon: 'minus', iconOnly: true });
    const zoomIn = button('放大', () => changeZoom((zoom ?? scale) * 1.25), { icon: 'plus', iconOnly: true });
    const fit = button('适应窗口', () => changeZoom(null));
    const left = button('向左旋转', () => rotate(-90));
    const right = button('向右旋转', () => rotate(90));
    const straighten = button('校正角度', () => {
      commitText();
      crop = null;
      angle = angle === null ? 0 : null;
      range.value = 0;
      scheduleDraw();
      if (angle !== null) {
        renderControls();
        range.focus({ preventScroll: true });
      }
    });
    const undo = button('撤销 · Ctrl+Z', () => history('undo'), { icon: 'undo', iconOnly: true });
    const redo = button('重做 · Ctrl+Shift+Z', () => history('redo'), { icon: 'redo', iconOnly: true });
    geometry.append(zoomOut, zoomIn, fit, left, right, straighten, undo, redo);

    const cropOptions = node('div', 'note-image-editor-tools');
    const applyCrop = button('应用裁剪', () => {
      if (!crop) return;
      const selected = crop;
      crop = null;
      if (model.crop(selected)) change();
      else scheduleDraw();
      canvas.focus({ preventScroll: true });
    }, { tone: 'primary', icon: 'check' });
    const cancelCrop = button('取消裁剪', () => {
      crop = null;
      scheduleDraw();
      canvas.focus({ preventScroll: true });
    });
    const cropSize = node('span', 'note-image-editor-measure');
    cropOptions.append(applyCrop, cancelCrop, cropSize);
    const angleOptions = node('div', 'note-image-editor-tools');
    const angleLabel = node('label', 'note-image-editor-angle');
    const angleValue = node('span', 'note-image-editor-measure');
    const range = node('input');
    range.type = 'range';
    range.min = -15;
    range.max = 15;
    range.step = 0.5;
    range.value = 0;
    range.setAttribute('aria-label', '旋转角度');
    range.addEventListener('input', () => {
      angle = Number(range.value);
      scheduleDraw();
    });
    angleLabel.append(range, angleValue);
    const applyAngle = button('应用校正', () => rotate(angle), { tone: 'primary', icon: 'check' });
    const cancelAngle = button('取消校正', () => {
      angle = null;
      scheduleDraw();
      straighten.focus({ preventScroll: true });
    });
    angleOptions.append(angleLabel, applyAngle, cancelAngle);
    adjustments.append(cropOptions, angleOptions);

    const cancel = button('返回预览', () => onCancel?.(), { needsImage: false });
    const recognize = onRecognize && button('提取当前图片文字', () => output('recognize', onRecognize));
    const copy = button('复制编辑后的图片', () => output('copy', onCopy));
    const replace = button('替换笔记中的图片', () => output('replace', onReplace), { tone: 'primary', icon: 'check' });
    outputs.append(cancel);
    if (recognize) outputs.append(recognize);
    if (onCopy) outputs.append(copy);
    if (onReplace) outputs.append(replace);

    function renderControls() {
      const locked = !model || busy;
      for (const control of controls) control.disabled = locked;
      const cropMode = tool === 'crop' && angle === null;
      const blockedByAdjustment = Boolean(crop) || angle !== null;
      for (const [id, control] of toolButtons) control.setAttribute('aria-pressed', String(angle === null && id === tool));
      straighten.setAttribute('aria-pressed', String(angle !== null));
      for (const [value, swatch] of swatches) {
        swatch.disabled = locked || cropMode || angle !== null;
        swatch.setAttribute('aria-pressed', String(value === color()));
      }
      const sizeKind = tool === 'text' ? 'font' : 'stroke';
      if (size.dataset.kind !== sizeKind) {
        size.dataset.kind = sizeKind;
        sizeName.textContent = sizeKind === 'font' ? '字号' : '粗细';
        size.replaceChildren(...(sizeKind === 'font' ? fonts : sizes).map(([value, label]) => new Option(label, value)));
      }
      size.value = sizeKind === 'font' ? fontSize : penSize;
      size.disabled = locked || cropMode || angle !== null;
      cropOptions.hidden = !crop;
      cropSize.textContent = crop ? `${crop.width} × ${crop.height}` : '';
      angleOptions.hidden = angle === null;
      angleValue.textContent = `${angle ?? 0}°`;
      range.disabled = locked;
      applyAngle.disabled = locked || !angle;
      adjustments.hidden = cropOptions.hidden && angleOptions.hidden;
      undo.disabled = locked || !model.history.length;
      redo.disabled = locked || !model.future.length;
      cancel.disabled = busy;
      copy.disabled = locked || blockedByAdjustment || !onCopy;
      replace.disabled = locked || blockedByAdjustment || !onReplace || !hasEdits();
      if (recognize) recognize.disabled = locked || blockedByAdjustment;
      element.dataset.tool = angle !== null ? 'adjust' : tool;
      element.classList.toggle('is-panning', spaceDown || drag?.kind === 'pan');
      element.setAttribute('aria-busy', String(locked && (busy || !image.complete)));
      notifyDirty();
    }

    function frameToShow() {
      if (!angle) return model.frame();
      try { return model.rotation(angle); }
      catch (error) { status(error.message, true); return model.frame(); }
    }

    function scheduleDraw() {
      if (!disposed && !renderRequest) renderRequest = requestAnimationFrame(render);
    }

    function render() {
      renderRequest = 0;
      if (disposed) return;
      renderControls();
      if (!model) return;
      const frame = frameToShow();
      const availableWidth = Math.max(1, viewport.clientWidth - 24);
      const availableHeight = Math.max(1, viewport.clientHeight - 24);
      scale = zoom ?? Math.min(1, availableWidth / frame.width, availableHeight / frame.height);
      const previewScale = Math.min(1, 4096 / Math.max(frame.width, frame.height), scale * devicePixelRatio);
      const width = Math.max(1, Math.round(frame.width * previewScale));
      const height = Math.max(1, Math.round(frame.height * previewScale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext('2d');
      context.setTransform(width / frame.width, 0, 0, height / frame.height, 0, 0);
      context.clearRect(0, 0, frame.width, frame.height);
      drawFrame(context, image, frame);
      if (draft) paint(context, draft);
      page.style.width = `${frame.width * scale}px`;
      page.style.height = `${frame.height * scale}px`;
      const bounds = drag?.kind === 'crop' ? drag.bounds : crop;
      cropGuide.hidden = !bounds || !bounds.width || !bounds.height;
      if (!cropGuide.hidden) Object.assign(cropGuide.style, {
        left: `${bounds.x * scale}px`, top: `${bounds.y * scale}px`,
        width: `${bounds.width * scale}px`, height: `${bounds.height * scale}px`
      });
      if (textMark) positionTextEntry();
    }

    function changeZoom(next) {
      if (!model) return;
      const pageRect = page.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const x = (viewportRect.left + viewport.clientWidth / 2 - pageRect.left) / pageRect.width;
      const y = (viewportRect.top + viewport.clientHeight / 2 - pageRect.top) / pageRect.height;
      zoom = next === null ? null : Math.max(.025, Math.min(4, next));
      if (renderRequest) cancelAnimationFrame(renderRequest);
      render();
      const nextRect = page.getBoundingClientRect();
      viewport.scrollLeft += nextRect.left + x * nextRect.width - viewportRect.left - viewport.clientWidth / 2;
      viewport.scrollTop += nextRect.top + y * nextRect.height - viewportRect.top - viewport.clientHeight / 2;
    }

    function rotate(degrees) {
      commitText();
      try {
        if (degrees) model.applyFrame(model.rotation(degrees));
        crop = null;
        angle = null;
        if (degrees) change();
        else scheduleDraw();
      } catch (error) { status(error.message, true); }
    }

    function history(action) {
      commitText();
      crop = null;
      angle = null;
      if (model?.[action]()) change();
      else scheduleDraw();
    }

    function point(event) {
      const bounds = canvas.getBoundingClientRect();
      return boundedPoint({ x: (event.clientX - bounds.left) * model.width / bounds.width,
        y: (event.clientY - bounds.top) * model.height / bounds.height }, model.selection);
    }

    function positionTextEntry() {
      const x = textMark.x * scale;
      const y = textMark.y * scale;
      entry.style.left = `${Math.min(x, Math.max(0, page.clientWidth - 48))}px`;
      entry.style.top = `${Math.min(y, Math.max(0, page.clientHeight - 32))}px`;
      entry.style.fontSize = `${Math.max(13, textMark.fontSize * scale)}px`;
      entry.style.color = textMark.color;
      entry.style.maxWidth = `${Math.max(48, Math.min(280, page.clientWidth - x))}px`;
    }

    function commitText() {
      if (!textMark) return;
      const value = entry.value;
      const item = { ...textMark, text: value };
      textMark = null;
      entry.hidden = true;
      entry.value = '';
      if (value.trim()) addMark(item);
    }

    function addMark(mark) {
      try { if (model.add(mark)) change(); }
      catch (error) { status(error.message, true); }
    }

    function startPointer(event) {
      if (!model || busy || drag || ![0, 1].includes(event.button)) return;
      event.preventDefault();
      commitText();
      canvas.focus({ preventScroll: true });
      if (event.button === 1 || spaceDown || angle !== null) {
        drag = { kind: 'pan', id: event.pointerId, x: event.clientX, y: event.clientY,
          left: viewport.scrollLeft, top: viewport.scrollTop };
      } else {
        const start = point(event);
        if (tool === 'text') {
          textMark = { type: 'text', ...start, color: color(), width: 1, fontSize: fontSize / scale };
          positionTextEntry();
          entry.hidden = false;
          entry.focus({ preventScroll: true });
          return;
        }
        drag = { kind: tool, id: event.pointerId, start };
        if (tool === 'crop') drag.bounds = rectangle(start, start, model.width, model.height);
        else draft = { type: tool, color: color(), width: Math.min(100, Math.max(.5, penSize * (tool === 'highlighter' ? 6 : 1) / scale)),
          ...(freehand(tool) ? { points: [start] } : { start, end: start }) };
      }
      canvas.setPointerCapture(event.pointerId);
      scheduleDraw();
    }

    function movePointer(event) {
      if (drag?.id !== event.pointerId) return;
      if (drag.kind === 'pan') {
        viewport.scrollLeft = drag.left - event.clientX + drag.x;
        viewport.scrollTop = drag.top - event.clientY + drag.y;
        return;
      }
      const current = point(event);
      if (drag.kind === 'crop') drag.bounds = rectangle(drag.start, current, model.width, model.height);
      else if (!freehand(drag.kind)) draft.end = current;
      else if (draft.points.length < 20000) {
        const last = draft.points.at(-1);
        if (last.x !== current.x || last.y !== current.y) draft.points.push(current);
      }
      scheduleDraw();
    }

    function endPointer(event, committed) {
      if (drag?.id !== event.pointerId) return;
      if (committed) {
        movePointer(event);
        if (drag.kind === 'crop' && drag.bounds.width >= 2 && drag.bounds.height >= 2) crop = drag.bounds;
        if (draft) addMark(draft);
      }
      drag = null;
      draft = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      scheduleDraw();
    }

    function moveCrop(event) {
      const step = event.altKey ? 10 : 1;
      const x = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const y = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      if (event.shiftKey) {
        crop.width = Math.max(2, Math.min(model.width - crop.x, crop.width + x));
        crop.height = Math.max(2, Math.min(model.height - crop.y, crop.height + y));
      } else {
        crop.x = Math.max(0, Math.min(model.width - crop.width, crop.x + x));
        crop.y = Math.max(0, Math.min(model.height - crop.height, crop.y + y));
      }
      scheduleDraw();
    }

    canvas.addEventListener('pointerdown', startPointer);
    canvas.addEventListener('pointermove', movePointer);
    canvas.addEventListener('pointerup', event => endPointer(event, true));
    canvas.addEventListener('pointercancel', event => endPointer(event, false));
    canvas.addEventListener('lostpointercapture', event => endPointer(event, false));
    canvas.addEventListener('keyup', event => {
      if (event.code === 'Space') { spaceDown = false; scheduleDraw(); }
    });
    canvas.addEventListener('blur', () => { spaceDown = false; scheduleDraw(); });
    entry.addEventListener('blur', commitText);
    entry.addEventListener('input', notifyDirty);
    entry.addEventListener('keydown', event => {
      if (event.isComposing || !['Escape', 'Enter'].includes(event.key) || (event.key === 'Enter' && event.shiftKey)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') entry.value = '';
      commitText();
      canvas.focus({ preventScroll: true });
    });
    element.addEventListener('keydown', event => {
      if (busy || !model || event.isComposing || event.target === entry) return;
      if (event.key === 'Escape' && (drag || crop || angle !== null)) {
        event.preventDefault();
        event.stopPropagation();
        if (drag && canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
        drag = draft = null;
        crop = angle = null;
        if (adjustments.contains(document.activeElement)) canvas.focus({ preventScroll: true });
        scheduleDraw();
      } else if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopPropagation();
        history(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo');
      } else if (event.target === canvas && event.code === 'Space') {
        event.preventDefault();
        spaceDown = true;
        scheduleDraw();
      } else if (event.target === canvas && event.key === 'Enter' && crop) {
        event.preventDefault();
        applyCrop.click();
      } else if (event.target === canvas && crop && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        moveCrop(event);
      }
    });

    function hasEdits() { return Boolean(model && (model.previous || model.items.length)); }
    function isDirty() { return hasEdits() || Boolean(angle || crop || entry.value.trim()); }
    function notifyDirty() {
      if (disposed) return;
      const dirty = isDirty();
      if (dirty === lastDirty) return;
      lastDirty = dirty;
      onDirtyChange?.(dirty);
    }

    async function exportPng() {
      if (!model || disposed) throw new Error('图片未能读取。');
      if (crop || angle !== null) throw new Error('请先应用或取消当前调整。');
      commitText();
      if (model.width * model.height > maxOutputPixels) throw new Error('图片超过 2400 万像素，请先裁剪。');
      const output = node('canvas');
      output.width = model.width;
      output.height = model.height;
      try {
        drawFrame(output.getContext('2d'), image, model.frame());
        const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('无法生成编辑后的图片。');
        if (blob.size > maxOutputBytes) throw new Error('生成的图片超过 32 MB，请先裁剪。');
        return new Uint8Array(await blob.arrayBuffer());
      } finally { output.width = output.height = 1; }
    }

    async function output(kind, callback) {
      if (!callback || busy || !model || disposed) return;
      busy = true;
      renderControls();
      status(kind === 'recognize' ? '正在准备识别…' : '正在生成图片…');
      try {
        const bytes = await exportPng();
        if (disposed) return;
        if (kind === 'recognize') {
          busy = false;
          renderControls();
          status('');
          Promise.resolve(callback(bytes)).catch(error => status(error.message || '无法识别当前图片。', true));
        } else {
          await callback(bytes);
          status(kind === 'copy' ? '已复制编辑后的图片' : '已替换笔记中的图片');
        }
      } catch (error) { status(error.message || '图片处理失败，请重试。', true); }
      finally { busy = false; if (!disposed) renderControls(); }
    }

    const resize = new ResizeObserver(scheduleDraw);
    resize.observe(viewport);
    image.src = url;
    const ready = image.decode().then(() => {
      if (disposed) return false;
      model = new PhotoDocument(image.naturalWidth, image.naturalHeight);
      status('');
      scheduleDraw();
      return true;
    }).catch(error => { status(error.message || '无法打开原图。', true); return false; });
    renderControls();
    return {
      element, ready, isDirty, isBusy: () => busy, exportPng,
      focus: () => canvas.focus({ preventScroll: true }),
      dispose() {
        disposed = true;
        resize.disconnect();
        if (renderRequest) cancelAnimationFrame(renderRequest);
        image.removeAttribute('src');
        canvas.width = canvas.height = 1;
        element.remove();
      }
    };
  }

  window.InMomentNoteImageEditor = { create };
})();
