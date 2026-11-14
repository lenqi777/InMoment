'use strict';

(() => {
  const GAP = 8;
  const MIN_PANEL_HEIGHT = 96;
  const directions = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

  function clientBounds(element) {
    const rect = element.getBoundingClientRect();
    const left = rect.left + element.clientLeft;
    const top = rect.top + element.clientTop;
    return { left, top, right: left + element.clientWidth, bottom: top + element.clientHeight };
  }

  function intersection(first, second) {
    return {
      left: Math.max(first.left, second.left), top: Math.max(first.top, second.top),
      right: Math.min(first.right, second.right), bottom: Math.min(first.bottom, second.bottom),
    };
  }

  function anchorFor(marks) {
    const firstMark = marks.reduce((first, mark) => mark.top < first.top ? mark : first);
    const middle = (firstMark.top + firstMark.bottom) / 2;
    const first = marks.filter(mark => mark.top <= middle && mark.bottom >= middle);
    return {
      center: (Math.min(...first.map(mark => mark.left)) + Math.max(...first.map(mark => mark.right))) / 2,
      selectionTop: firstMark.top,
      bottom: Math.max(...marks.map(mark => mark.bottom)),
    };
  }

  function placeAboveSelection(panel, anchor, bounds, minimumHeight = Infinity) {
    const { leftEdge, rightEdge, topEdge, bottomEdge } = bounds;
    const availableHeight = Math.max(0, bottomEdge - topEdge);
    const naturalHeight = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
    const requiredHeight = Math.min(minimumHeight, naturalHeight);
    const roomAbove = anchor.selectionTop - GAP - topEdge;
    const roomBelow = bottomEdge - anchor.bottom - GAP;
    const above = roomAbove >= requiredHeight || (roomBelow < requiredHeight && roomAbove >= roomBelow);
    const room = above ? roomAbove : roomBelow;
    panel.style.maxHeight = Math.min(availableHeight, Math.max(requiredHeight, room)) + 'px';
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const top = above ? anchor.selectionTop - GAP - height : anchor.bottom + GAP;
    panel.dataset.uiPlacement = above ? 'top' : 'bottom';
    panel.style.left = Math.max(leftEdge, Math.min(anchor.center - width / 2, rightEdge - width)) + 'px';
    panel.style.top = Math.max(topEdge, Math.min(top, bottomEdge - height)) + 'px';
  }

  class NoteSelection {
    constructor(field, panel) {
      this.field = field;
      this.panel = panel;
      this.editor = field.closest('.note-document');
      this.dragHandle = panel.querySelector('#note-ai-preview-help');
      this.highlight = document.createElement('div');
      this.highlight.className = 'note-selection-highlight';
      this.highlight.setAttribute('aria-hidden', 'true');

      const update = () => {
        if (!this.selection || this.frame) return;
        this.frame = requestAnimationFrame(() => { this.frame = 0; this.position(); });
      };
      this.field.addEventListener('scroll', update, { passive: true });
      this.editor.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
      const observer = new ResizeObserver(update);
      observer.observe(this.field);
      observer.observe(this.editor);
      observer.observe(this.panel);
      this.bindDragHandle();
    }

    bindDragHandle() {
      const handle = this.dragHandle;
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || this.drag) return;
        this.dragged = false;
        this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, ...this.panelPosition() };
        handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener('pointermove', event => {
        const drag = this.drag;
        if (drag?.id !== event.pointerId) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!this.dragged && Math.hypot(dx, dy) < 4) return;
        this.dragged = true;
        handle.dataset.dragging = '';
        this.movePanel(drag.left + dx, drag.top + dy);
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        handle.addEventListener(type, event => { if (this.drag?.id === event.pointerId) this.endDrag(); });
      }
      handle.addEventListener('keydown', event => {
        const direction = directions[event.key];
        if (!direction) return;
        event.preventDefault();
        const { left, top } = this.panelPosition();
        const step = event.shiftKey ? 24 : GAP;
        this.movePanel(left + direction[0] * step, top + direction[1] * step);
      });
      handle.addEventListener('click', event => {
        if ((this.dragged && event.detail) || !this.panelBounds) return;
        const { left, top } = this.panelPosition();
        const { topEdge, bottomEdge } = this.panelBounds;
        const lowest = bottomEdge - this.panel.offsetHeight;
        this.movePanel(left, top > (topEdge + lowest) / 2 ? topEdge : lowest);
      });
    }

    endDrag() {
      const id = this.drag?.id;
      this.drag = null;
      delete this.dragHandle.dataset.dragging;
      if (id !== undefined && this.dragHandle.hasPointerCapture(id)) this.dragHandle.releasePointerCapture(id);
    }

    panelPosition() {
      return { left: this.panel.offsetLeft, top: this.panel.offsetTop };
    }

    movePanel(left, top) {
      if (!this.panelBounds || !this.selection) return;
      const { leftEdge, rightEdge, topEdge, bottomEdge } = this.panelBounds;
      this.panel.style.maxHeight = Math.max(0, bottomEdge - topEdge) + 'px';
      this.manualPosition = {
        left: Math.max(leftEdge, Math.min(left, rightEdge - this.panel.offsetWidth)),
        top: Math.max(topEdge, Math.min(top, bottomEdge - this.panel.offsetHeight)),
      };
      this.panel.style.left = this.manualPosition.left + 'px';
      this.panel.style.top = this.manualPosition.top + 'px';
    }

    set(selection) {
      this.selection = selection;
      if (!this.highlight.isConnected) document.body.append(this.highlight);
      return this.position();
    }

    clear() {
      this.endDrag();
      this.dragged = false;
      this.manualPosition = null;
      this.panelBounds = null;
      this.selection = null;
      this.highlight.remove();
      this.highlight.replaceChildren();
      for (const property of ['left', 'top', 'max-width', 'max-height', 'visibility']) this.panel.style.removeProperty(property);
      delete this.panel.dataset.uiPlacement;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
    }

    position() {
      if (!this.selection) return;
      const viewport = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };
      const editor = intersection(clientBounds(this.editor), viewport);
      const field = clientBounds(this.field);
      const area = intersection(field, editor);
      const marks = window.InMomentNoteDocument.textRects(this.field, this.selection)
        .map(rect => intersection(rect, area))
        .filter(rect => rect.right > rect.left && rect.bottom > rect.top);
      this.highlight.replaceChildren(...marks.map(mark => {
        const node = document.createElement('i');
        Object.assign(node.style, {
          left: mark.left + 'px', top: mark.top + 'px', width: (mark.right - mark.left) + 'px', height: (mark.bottom - mark.top) + 'px',
        });
        return node;
      }));

      this.panel.style.visibility = marks.length || this.manualPosition ? '' : 'hidden';
      if (!marks.length) {
        if (this.manualPosition && this.panel.getClientRects().length) this.placePanel(null, field, editor);
        return;
      }
      const last = marks.at(-1);
      const lastLine = marks.filter(mark => Math.abs(mark.top - last.top) < 3);
      const anchor = { ...anchorFor(marks), right: Math.max(...lastLine.map(mark => mark.right)) };
      if (this.panel.getClientRects().length) this.placePanel(anchor, field, editor);
      return anchor;
    }

    placePanel(anchor, field, editor) {
      const leftEdge = Math.max(field.left, editor.left + GAP);
      const rightEdge = Math.min(field.right, editor.right - GAP);
      const topEdge = editor.top + GAP;
      const bottomEdge = editor.bottom - GAP;
      const panel = this.panel;
      panel.style.maxWidth = Math.max(0, rightEdge - leftEdge) + 'px';
      this.panelBounds = { leftEdge, rightEdge, topEdge, bottomEdge };
      if (this.manualPosition) {
        this.movePanel(this.manualPosition.left, this.manualPosition.top);
        return;
      }
      placeAboveSelection(panel, anchor, this.panelBounds, MIN_PANEL_HEIGHT);
    }
  }

  NoteSelection.anchorFor = anchorFor;
  NoteSelection.placeAbove = placeAboveSelection;
  window.InMomentNoteSelection = NoteSelection;
})();
