'use strict';

(() => {
  const revealDelay = 1000;
  const placementGap = 8;
  const toolbarId = 'note-format-options';
  const paletteSelector = '.context-menu:has(> [data-menu-id^="note-format-"])';
  const fontSizes = Object.freeze([12, 14, 16, 20, 24, 32, 40]);
  const paragraphs = [
    { id: 'p', label: '正文', command: 'formatBlock', value: 'p' },
    { id: 'h1', label: '大标题', command: 'formatBlock', value: 'h1' },
    { id: 'h2', label: '标题', command: 'formatBlock', value: 'h2' },
    { id: 'h3', label: '小标题', command: 'formatBlock', value: 'h3' },
    { id: 'ul', label: '项目符号列表', marker: '•', command: 'insertUnorderedList' },
    { id: 'ol', label: '编号列表', marker: '1.', command: 'insertOrderedList' },
    { id: 'blockquote', label: '引用', command: 'formatBlock', value: 'blockquote' },
  ];
  const colors = [
    ['text', '默认', '#171a1d'],
    ['gray', '灰色', '#5d646d'],
    ['red', '红色', '#b42318'],
    ['orange', '橙色', '#895a12'],
    ['green', '绿色', '#256d49'],
    ['blue', '蓝色', '#1e59a8'],
    ['purple', '紫色', '#7041a3'],
  ];
  const symbols = [
    ['•', '圆点'], ['◦', '空心圆点'], ['▪', '方点'], ['‣', '三角项目符号'],
    ['★', '实心五角星'], ['☆', '空心五角星'], ['✦', '实心四角星'], ['✧', '空心四角星'],
    ['✓', '对勾'], ['✔', '粗对勾'], ['✕', '叉号'], ['☐', '空方框'], ['☑', '勾选方框'],
    ['→', '向右箭头'], ['←', '向左箭头'], ['↑', '向上箭头'], ['↓', '向下箭头'], ['↔', '双向箭头'],
    ['※', '参考标记'], ['◆', '实心菱形'], ['◇', '空心菱形'], ['●', '实心圆'], ['○', '空心圆'],
    ['△', '空心三角'], ['▲', '实心三角'], ['—', '破折号'], ['…', '省略号'],
    ['±', '正负号'], ['×', '乘号'], ['÷', '除号'], ['≈', '约等于'], ['≠', '不等于'],
    ['≤', '小于等于'], ['≥', '大于等于'], ['∞', '无穷大'],
  ];

  function clipRect(rect, bounds) {
    const left = Math.max(bounds.left, rect.left);
    const right = Math.min(bounds.right, rect.right);
    const top = Math.max(bounds.top, rect.top);
    const bottom = Math.min(bounds.bottom, rect.bottom);
    return right >= left && bottom > top ? { left, right, top, bottom } : null;
  }

  function mount({ editor, container, onChange }) {
    const doc = editor.ownerDocument;
    const view = doc.defaultView;
    const scrollArea = container.closest('.note-document');
    const toolbar = doc.createElement('div');
    toolbar.id = toolbarId;
    toolbar.className = 'inmoment-popover note-format-toolbar';
    toolbar.setAttribute('popover', 'manual');
    toolbar.hidden = true;
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', '笔记格式');
    container.insertBefore(toolbar, editor.parentElement === container ? editor : null);
    editor.setAttribute('aria-keyshortcuts', 'Control+Shift+F');

    let savedRange = null;
    let savedDirection = '';
    let composing = false;
    let applying = false;
    let generation = 0;
    let menuAnchor;
    const buttons = [];
    let selectionPointer;
    let pendingRange;
    let dismissedRange;
    let revealedRange;
    let revealTimer;
    let placementFrame;
    let toolbarVersion = 0;
    let source;

    function inEditor(range) {
      return view.InMomentNoteDocument?.rangeInside(editor, range) ?? (range && editor.contains(range.commonAncestorContainer));
    }

    function rememberSelection() {
      if (doc.activeElement !== editor) return savedRange;
      const selection = doc.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (inEditor(range)) {
        savedRange = range.cloneRange();
        savedDirection = selection.direction;
      }
      return savedRange;
    }

    function restoreSelection(range = savedRange) {
      if (!editor.isContentEditable || !editor.isConnected) return false;
      const direction = savedDirection;
      editor.focus({ preventScroll: true });
      const selection = doc.getSelection();
      if (!selection) return false;
      if (!inEditor(range)) {
        range = doc.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
      }
      selection.removeAllRanges();
      if (!range.collapsed && direction === 'backward') {
        selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
      } else selection.addRange(range);
      return true;
    }

    function sameRange(first, second) {
      return Boolean(first && second && first.startContainer === second.startContainer && first.startOffset === second.startOffset &&
        first.endContainer === second.endContainer && first.endOffset === second.endOffset);
    }

    function paintSelection() {
      const highlights = view.CSS?.highlights;
      if (!highlights || !view.Highlight) return;
      if (source && doc.activeElement !== editor && inEditor(savedRange) && !savedRange.collapsed) {
        highlights.set('note-format-selection', new view.Highlight(savedRange));
      } else highlights.delete('note-format-selection');
    }

    function placeToolbar() {
      if (!source || !container.getClientRects().length) return false;
      const area = scrollArea?.getBoundingClientRect();
      const leftEdge = area ? area.left + scrollArea.clientLeft : 0;
      const topEdge = area ? area.top + scrollArea.clientTop : 0;
      const visible = {
        left: Math.max(0, leftEdge), top: Math.max(0, topEdge),
        right: area ? Math.min(view.innerWidth, leftEdge + scrollArea.clientWidth) : view.innerWidth,
        bottom: area ? Math.min(view.innerHeight, topEdge + scrollArea.clientHeight) : view.innerHeight,
      };
      const bounds = {
        left: visible.left + placementGap, top: visible.top + placementGap,
        right: visible.right - placementGap, bottom: visible.bottom - placementGap,
      };
      const anchor = container.getBoundingClientRect();
      toolbar.style.maxWidth = Math.max(0, bounds.right - bounds.left) + 'px';
      toolbar.style.maxHeight = Math.max(0, bounds.bottom - bounds.top) + 'px';
      const range = inEditor(savedRange) ? savedRange : null;
      const rects = !range ? [] : range.collapsed ? Array.from(range.getClientRects()) : view.InMomentNoteDocument.textRects(editor, { range });
      const selected = rects.map(rect => clipRect(rect, visible)).filter(Boolean);
      if (source === 'selection' && !selected.length) {
        dismissedRange = savedRange;
        closePalette();
        hideToolbar(true);
        return false;
      }
      if (selected.length) {
        const { anchorFor, placeAbove } = view.InMomentNoteSelection;
        placeAbove(toolbar, anchorFor(selected), {
          leftEdge: bounds.left, rightEdge: bounds.right, topEdge: bounds.top, bottomEdge: bounds.bottom,
        });
      } else {
        const left = Math.max(bounds.left, Math.min(anchor.left, bounds.right - toolbar.offsetWidth));
        const top = Math.max(bounds.top, Math.min(anchor.top + placementGap, bounds.bottom - toolbar.offsetHeight));
        toolbar.dataset.uiPlacement = 'bottom';
        toolbar.style.left = left + 'px';
        toolbar.style.top = top + 'px';
      }
      return true;
    }

    function schedulePlacement() {
      if (!source || placementFrame) return;
      placementFrame = view.requestAnimationFrame(() => {
        placementFrame = 0;
        placeToolbar();
      });
    }

    function cancelReveal() {
      clearTimeout(revealTimer);
      pendingRange = null;
    }

    function showToolbar(nextSource, focus = false) {
      cancelReveal();
      if (!editor.isContentEditable || !editor.getClientRects().length) return;
      toolbarVersion++;
      source = nextSource;
      const entering = toolbar.hidden || toolbar.inert;
      toolbar.hidden = false;
      toolbar.inert = false;
      if (!toolbar.matches(':popover-open')) toolbar.showPopover();
      revealedRange = savedRange;
      if (!placeToolbar()) return;
      if (entering) view.InMomentMotion?.enter(toolbar, { kind: 'popover' });
      if (focus) buttons[0]?.focus({ preventScroll: true });
      paintSelection();
    }

    function hideToolbar(immediate = false) {
      cancelReveal();
      if (toolbar.hidden || (toolbar.inert && !immediate)) return;
      const version = ++toolbarVersion;
      source = null;
      revealedRange = null;
      toolbar.inert = true;
      paintSelection();
      const finish = () => {
        if (toolbarVersion !== version) return;
        if (toolbar.matches(':popover-open')) toolbar.hidePopover();
        toolbar.hidden = true;
      };
      if (immediate || !view.InMomentMotion) finish();
      else view.InMomentMotion.exit(toolbar, { kind: 'popover' }).then(finish, finish);
    }

    function considerReveal() {
      if (composing || applying || selectionPointer !== undefined) return;
      const range = doc.getSelection()?.rangeCount ? doc.getSelection().getRangeAt(0) : null;
      if (!inEditor(range) || range.collapsed || !range.toString().trim()) {
        dismissedRange = null;
        if (source === 'selection') hideToolbar();
        else cancelReveal();
        return;
      }
      if (sameRange(range, dismissedRange)) return;
      dismissedRange = null;
      if (source === 'manual' || sameRange(range, revealedRange)) return;
      if (source === 'selection') hideToolbar();
      if (sameRange(range, pendingRange)) return;
      cancelReveal();
      pendingRange = range.cloneRange();
      revealTimer = setTimeout(() => {
        const current = doc.getSelection();
        if (doc.activeElement === editor && current?.rangeCount &&
          sameRange(pendingRange, current.getRangeAt(0)) && !composing && selectionPointer === undefined &&
          (view.InMomentNoteDocument?.selectionOf(editor)?.text ?? pendingRange.toString()).trim()) {
          rememberSelection();
          showToolbar('selection');
        } else cancelReveal();
      }, revealDelay);
    }

    function inFormat(target) {
      return toolbar.contains(target) || Boolean(target.closest?.(paletteSelector));
    }

    function apply(command, value) {
      if (composing || !restoreSelection()) return;
      applying = true;
      let emittedInput = false;
      const markInput = () => { emittedInput = true; };
      if (onChange) editor.addEventListener('input', markInput);
      try {
        doc.execCommand('styleWithCSS', false, false);
        if (doc.execCommand(command, false, value) && onChange && !emittedInput) onChange();
      } finally {
        applying = false;
        if (onChange) editor.removeEventListener('input', markInput);
      }
      revealedRange = rememberSelection();
      refresh();
      schedulePlacement();
    }

    function button(label, action, { text, icon, popup = false } = {}) {
      const item = doc.createElement('button');
      item.type = 'button';
      item.className = 'button quiet compact note-format-button';
      item.setAttribute('aria-label', label);
      item.title = label;
      if (text) {
        const value = doc.createElement('span');
        value.className = 'note-format-value';
        value.setAttribute('aria-hidden', 'true');
        value.textContent = text;
        item.append(value);
      } else item.classList.add('note-format-icon-button');
      if (popup) {
        item.setAttribute('aria-haspopup', 'menu');
        item.setAttribute('aria-expanded', 'false');
      }
      if (icon || (text && popup)) item.dataset.uiIcon = icon || 'chevron';
      item.addEventListener('pointerdown', event => {
        if (event.button !== 0 || doc.activeElement !== editor || composing) return;
        rememberSelection();
        event.preventDefault();
      });
      item.addEventListener('click', () => {
        if (!composing && editor.isContentEditable) action(item);
      });
      toolbar.append(item);
      buttons.push(item);
      return item;
    }

    async function choose(anchor, title, options, select, selection = true) {
      const menu = view.InMomentMenus;
      if (!menu) return;
      if (menuAnchor === anchor) {
        generation++;
        menu.close();
        menuAnchor = null;
        anchor.setAttribute('aria-expanded', 'false');
        return;
      }
      const request = ++generation;
      menuAnchor?.setAttribute('aria-expanded', 'false');
      menuAnchor = anchor;
      anchor.setAttribute('aria-expanded', 'true');
      try {
        await menu.open({ anchor, title, items: options, selection, onSelect(action) {
          if (generation !== request) return;
          anchor.setAttribute('aria-expanded', 'false');
          menuAnchor = null;
          select(action);
        } });
      } finally {
        if (generation === request) {
          anchor.setAttribute('aria-expanded', 'false');
          menuAnchor = null;
        }
      }
    }

    function paragraphStyle() {
      const block = String(doc.queryCommandValue('formatBlock')).toLowerCase();
      if (doc.queryCommandState('insertUnorderedList')) return paragraphs.find(option => option.id === 'ul');
      if (doc.queryCommandState('insertOrderedList')) return paragraphs.find(option => option.id === 'ol');
      return paragraphs.find(option => option.id === block) || paragraphs[0];
    }

    function fontSize() {
      const selection = doc.getSelection();
      const node = selection?.anchorNode;
      const element = editor.contains(node) ? (node.nodeType === 1 ? node : node.parentElement) : editor;
      return Math.round(Number.parseFloat(view.getComputedStyle(element).fontSize)) || 16;
    }

    function paragraphMenu(anchor) {
      const current = paragraphStyle();
      const options = paragraphs.map(option => ({
        id: 'note-format-paragraph-' + option.id,
        label: option.marker ? option.marker + ' ' + option.label : option.label,
        ariaLabel: option.marker ? option.label : undefined,
        selected: option.id === current.id,
      }));
      return choose(anchor, '段落格式', options, action => {
        const option = paragraphs[options.findIndex(item => item.id === action)];
        if (option) apply(option.command, option.value);
      });
    }

    const paragraphButton = button('段落', paragraphMenu, { text: '正文', popup: true });
    const sizeButton = button('字号', anchor => {
      const current = Number(anchor.querySelector('.note-format-value').textContent);
      const options = fontSizes.map((size, index) => ({
        id: 'note-format-size-' + (index + 1), label: String(size), selected: current === size,
      }));
      return choose(anchor, '字号', options, action => {
        const index = options.findIndex(item => item.id === action);
        if (index < 0) return;
        apply('fontSize', String(index + 1));
        anchor.querySelector('.note-format-value').textContent = options[index].label;
      });
    }, { text: '16', popup: true });
    sizeButton.classList.add('note-format-size');
    const bold = button('加粗', () => apply('bold'), { icon: 'text-bold' });
    bold.title = '加粗（Ctrl+B）';
    bold.setAttribute('aria-pressed', 'false');
    bold.setAttribute('aria-keyshortcuts', 'Control+B');
    const italic = button('斜体', () => apply('italic'), { icon: 'text-italic' });
    italic.title = '斜体（Ctrl+I）';
    italic.setAttribute('aria-pressed', 'false');
    italic.setAttribute('aria-keyshortcuts', 'Control+I');
    const underline = button('下划线', () => apply('underline'), { icon: 'text-underline' });
    underline.title = '下划线（Ctrl+U）';
    underline.setAttribute('aria-pressed', 'false');
    underline.setAttribute('aria-keyshortcuts', 'Control+U');
    const colorButton = button('颜色', anchor => {
      const current = colorHex(doc.queryCommandValue('foreColor')) || colors[0][2];
      const options = colors.map(([id, label, color]) => ({
        id: 'note-format-color-' + id, label, selected: color === current,
      }));
      return choose(anchor, '文字颜色', options, action => {
        const color = colors[options.findIndex(item => item.id === action)];
        if (color) apply('foreColor', color[2]);
      });
    }, { popup: true });
    colorButton.classList.add('note-format-color');
    const colorSwatch = doc.createElement('span');
    colorSwatch.className = 'note-format-swatch';
    colorSwatch.setAttribute('aria-hidden', 'true');
    colorButton.append(colorSwatch);
    button('符号', anchor => {
      const options = symbols.map(([label, ariaLabel], index) => ({ id: 'note-format-symbol-' + index, label, ariaLabel }));
      return choose(anchor, '常用符号', options, action => {
        const item = options.find(option => option.id === action);
        if (item) apply('insertText', item.label);
      }, false);
    }, { icon: 'omega', popup: true });

    function refresh() {
      if (doc.activeElement !== editor) return;
      rememberSelection();
      for (const [mark, command] of [[bold, 'bold'], [italic, 'italic'], [underline, 'underline']]) {
        mark.setAttribute('aria-pressed', String(doc.queryCommandState(command)));
      }
      const paragraph = paragraphStyle();
      paragraphButton.querySelector('.note-format-value').textContent = paragraph.id === 'ul' ? '项目列表' :
        paragraph.id === 'ol' ? '编号列表' : paragraph.label;
      sizeButton.querySelector('.note-format-value').textContent = String(fontSize());
      colorButton.style.setProperty('--note-format-swatch', colorHex(doc.queryCommandValue('foreColor')) || colors[0][2]);
      paintSelection();
      considerReveal();
    }

    function finishSelection(event) {
      if (event.pointerId !== selectionPointer) return;
      selectionPointer = undefined;
      if (event.type === 'pointercancel') {
        dismissedRange = savedRange;
        hideToolbar();
      } else refresh();
    }

    function explicitOpen() {
      if (composing) return;
      rememberSelection();
      showToolbar('manual', true);
    }

    doc.addEventListener('pointerdown', event => {
      if (inFormat(event.target)) return;
      const selecting = editor.contains(event.target) && event.button === 0;
      if (selecting) selectionPointer = event.pointerId;
      dismissedRange = selecting ? null : savedRange;
      hideToolbar();
    }, true);
    doc.addEventListener('pointerup', finishSelection, true);
    doc.addEventListener('pointercancel', finishSelection, true);
    view.addEventListener('blur', () => {
      selectionPointer = undefined;
      dismissedRange = savedRange;
      closePalette();
      hideToolbar();
    });
    doc.addEventListener('focusin', event => {
      if (event.target === editor) refresh();
      else if (!inFormat(event.target)) {
        dismissedRange = savedRange;
        hideToolbar();
      }
      paintSelection();
    });
    doc.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229 || composing) return;
      if (event.target === editor && event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyF') {
        event.preventDefault();
        explicitOpen();
      } else if (event.key === 'Escape' && !menuAnchor && (source || pendingRange) &&
        (event.target === editor || inFormat(event.target))) {
        event.preventDefault();
        event.stopPropagation();
        dismissedRange = savedRange;
        if (toolbar.contains(event.target)) restoreSelection();
        hideToolbar();
      }
    }, true);
    scrollArea?.addEventListener('scroll', schedulePlacement, { passive: true });
    view.addEventListener('resize', schedulePlacement);
    const layoutObserver = new view.ResizeObserver(schedulePlacement);
    layoutObserver.observe(editor);
    if (scrollArea) layoutObserver.observe(scrollArea);
    editor.addEventListener('compositionstart', () => {
      composing = true;
      hideToolbar();
    });
    editor.addEventListener('compositionend', () => { composing = false; refresh(); });
    editor.addEventListener('input', () => {
      schedulePlacement();
      refresh();
    });
    doc.addEventListener('selectionchange', refresh);

    function closePalette() {
      generation++;
      if (menuAnchor) {
        menuAnchor.setAttribute('aria-expanded', 'false');
        menuAnchor = null;
        if (doc.querySelector('.context-menu[data-popover-state="open"] > [data-menu-id^="note-format-"]')) view.InMomentMenus?.close(false);
      }
    }

    function reset() {
      closePalette();
      savedRange = null;
      savedDirection = '';
      composing = false;
      selectionPointer = undefined;
      dismissedRange = null;
      hideToolbar(true);
      paragraphButton.querySelector('.note-format-value').textContent = '正文';
      sizeButton.querySelector('.note-format-value').textContent = '16';
      for (const mark of [bold, italic, underline]) mark.setAttribute('aria-pressed', 'false');
      colorButton.style.removeProperty('--note-format-swatch');
    }

    return {
      reset,
      rememberSelection,
      restoreSelection,
      setDisabled(disabled) {
        for (const item of buttons) item.disabled = disabled;
        if (disabled) reset();
      },
    };
  }

  function colorHex(color) {
    if (/^#[\da-f]{6}$/iu.test(color)) return color.toLowerCase();
    const channels = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/u);
    return channels ? '#' + channels.slice(1).map(channel => Number(channel).toString(16).padStart(2, '0')).join('') : '';
  }

  window.InMomentNoteFormat = { mount, fontSizes };
})();
