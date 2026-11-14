'use strict';

(() => {
  const MAX_CLIPBOARD_BYTES = 32 * 1024 * 1024;
  const noteDocument = window.InMomentNoteDocument;
  const noteMedia = window.InMomentNoteMedia;
  const noteHistory = window.InMomentNoteHistory;
  const CLIPBOARD_EXTENSIONS = new Map([
    ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp'],
    ['image/bmp', 'bmp'], ['image/avif', 'avif'], ['video/mp4', 'mp4'], ['video/webm', 'webm'],
  ]);
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' });
  const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    if (tag === 'button') node.type = 'button';
    return node;
  }

  function titleFor(note) {
    return note.title.trim() || '无标题笔记';
  }

  function bodyLinks(body) {
    const links = new Set();
    for (const match of body.matchAll(/https?:\/\/[^\s<>"“”‘’，。！；、（）《》]+/giu)) {
      let candidate = match[0].replace(/[.,;]+$/u, '');
      if (candidate.endsWith(')') && candidate.split(')').length > candidate.split('(').length) candidate = candidate.slice(0, -1);
      try {
        const url = new URL(candidate);
        if (!url.username && !url.password && url.href.length <= 4096) links.add(url.href);
      } catch { /* An incomplete URL can remain part of the editable text. */ }
      if (links.size >= 100) break;
    }
    return [...links];
  }

  function pastedFiles(data) {
    const items = [...(data?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    return items.length ? items : [...(data?.files || [])];
  }

  function fileSize(size) {
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return Math.ceil(size / 1024) + ' KB';
    return (size / (1024 * 1024)).toFixed(1) + ' MB';
  }

  class NotesView {
    constructor({ root, invoke, toast, notifyDirty, backgroundAudio, onGroupsChange }) {
      Object.assign(this, { root, invoke, toast, notifyDirty, backgroundAudio, onGroupsChange });
      for (const id of ['new-note','new-note-from-empty','notes-query','notes-list','notes-list-status','notes-more','notes-empty','note-editor','note-title','note-body','note-back','note-status','note-retry','note-attach','note-delete','note-group','note-attachments','note-attachments-section','note-links','note-links-section','note-background','note-background-dialog','note-background-content','close-note-background','notes-select-all','notes-select-toggle','notes-selection-status','notes-selection-count','notes-selection-actions']) {
        this[id] = root.querySelector('#' + id);
      }
      for (const id of ['note-summaries', 'note-ai-summary', 'note-ai-inline', 'note-ai-form', 'note-ai-instruction', 'note-ai-submit', 'note-ai-result', 'note-ai-preview-wrap', 'note-ai-preview', 'note-ai-accept', 'note-ai-dismiss', 'note-ai-feedback']) {
        this[id] = root.querySelector('#' + id);
      }
      this['notes-recent'] = root.querySelector('#notes-recent');
      this['notes-recent-list'] = root.querySelector('#notes-recent-list');
      this.cache = new Map();
      this.list = [];
      this.topics = [];
      this.topicId = 'all';
      this.groupCounts = {};
      this.listRequest = 0;
      this.openRequest = 0;
      this.opened = null;
      this.localNoteId = 0;
      this.resetSelection();
      this['new-note'].addEventListener('click', () => this.run(() => this.create()));
      this['new-note-from-empty'].addEventListener('click', () => {
        if (this.visible && !this.opened) this.run(() => this.create());
      });
      this['notes-more'].addEventListener('click', () => this.run(() => this.refreshList(true)));
      this['notes-select-all'].addEventListener('change', event => this.run(() => this.selectAllNotes(event.target.checked)));
      this['notes-select-toggle'].addEventListener('click', () => {
        this.resetSelection(!this.noteSelection.enabled);
        this.renderList();
      });
      this['notes-selection-actions'].addEventListener('click', () => this.run(() => this.openBulkMenu()));
      this['notes-query'].addEventListener('input', () => {
        this.listRequest++;
        this['notes-more'].disabled = true;
        if (this.noteSelection.enabled) {
          this.resetSelection();
          this.renderList();
        }
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => this.run(() => this.refreshList()), 160);
      });
      this['note-back'].addEventListener('click', () => this.run(() => this.backFromNote()));
      this['note-group'].addEventListener('click', () => this.run(() => this.addToGroup()));
      this['note-background'].addEventListener('click', () => this.showBackground());
      this['close-note-background'].addEventListener('click', () => this['note-background-dialog'].close());
      this['note-background-dialog'].addEventListener('close', () => {
        if (this['note-background-dialog'].open) return;
        this.disposeBackgroundAudio?.();
        this.disposeBackgroundAudio = null;
        this['note-background-content'].replaceChildren();
        const anchor = this['note-background'];
        anchor.setAttribute('aria-expanded', 'false');
        if (this.restoreBackgroundFocus && this.visible && this.root.dataset.noteOpen === 'true') (anchor.classList.contains('hidden') ? this['note-title'] : anchor).focus({ preventScroll: true });
      });
      this['note-attach'].addEventListener('click', () => this.run(() => this.changeMedia('notes:pickFiles')));
      this['note-delete'].addEventListener('click', () => this.run(() => this.delete()));
      this['note-retry'].addEventListener('click', () => this.save(this.opened));
      for (const field of [this['note-title'], this['note-body']]) {
        field.addEventListener('beforeinput', event => {
          if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
            event.preventDefault();
            this.applyHistory(event.inputType === 'historyUndo' ? 'undo' : 'redo', field);
          } else this.beginHistory(field);
        });
        field.addEventListener('keydown', event => {
          if (event.isComposing || event.keyCode === 229 || event.altKey || !(event.ctrlKey || event.metaKey)) return;
          const undo = event.code === 'KeyZ';
          if (!undo && (event.code !== 'KeyY' || event.shiftKey)) return;
          event.preventDefault();
          this.applyHistory(undo && !event.shiftKey ? 'undo' : 'redo', field);
        });
        field.addEventListener('input', event => this.input(event.isComposing, event.inputType));
        field.addEventListener('compositionstart', () => {
          this.beginHistory(field);
          if (this.opened) this.opened.composing = true;
        });
        field.addEventListener('compositionend', () => this.input(false, 'composition'));
      }
      this['note-editor'].addEventListener('paste', event => this.paste(event));
      this['note-ai-summary'].addEventListener('click', () => this.run(() => this.summarizeNote()));
      const body = this['note-body'];
      this['note-title'].addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || this.opened?.composing ||
          !body.isContentEditable || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        if (event.repeat) return;
        const start = document.createRange();
        start.selectNodeContents(body);
        start.collapse(true);
        noteDocument.restore(body, start);
      });
      this.noteFormat = window.InMomentNoteFormat.mount({
        editor: body, container: root.querySelector('#note-format'),
        onChange: () => this.input(false),
      });
      noteMedia.bind(body, () => this.input(false));
      for (const type of ['copy', 'cut']) {
        body.addEventListener(type, event => {
          const selection = noteDocument.selectionOf(body);
          if (!this.selectedPictures(selection).length) return;
          event.preventDefault();
          this.run(() => this.copyPictures(selection, type === 'cut'));
        });
      }
      document.addEventListener('selectionchange', () => {
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (this.opened && noteDocument.rangeInside(body, range)) {
          this.bodyCaret = { note: this.opened, range: range.cloneRange() };
          this.bodyCaret.range.collapse(false);
        }
      });
      body.addEventListener('beforeinput', event => {
        if (event.defaultPrevented) return;
        if (/^delete(?:Content|Word|SoftLine|HardLine)(?:Back|For)ward$/u.test(event.inputType) && event.cancelable &&
          !event.isComposing && !this.opened?.composing && body.isContentEditable) {
          const kind = noteDocument.deleteAroundMedia(body, event, noteMedia.selection(body));
          if (kind) this.input(false, kind);
          return;
        }
        if (event.isComposing || !event.data || !event.inputType.startsWith('insert')) return;
        const selection = noteDocument.selectionOf(body);
        if (selection && selection.value.length - selection.text.length + event.data.length > noteDocument.maxLength) event.preventDefault();
      });
      body.addEventListener('dragover', event => {
        if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
      });
      body.addEventListener('drop', event => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        const files = [...(event.dataTransfer?.files || [])];
        if (!files.length || !this.opened) return;
        const range = noteMedia.point(body, event);
        const position = this.attachmentPosition(range);
        const note = this.opened;
        this.run(() => this.mediaAction(note, identity => this.attachFiles(identity, files), position));
      });
      const panel = this['note-ai-inline'];
      this.selectionGeometry = new window.InMomentNoteSelection(body, panel);
      body.addEventListener('contextmenu', event => this.handleSelectionMenu(event));
      body.addEventListener('keydown', event => {
        if (!event.isComposing && event.keyCode !== 229 && !this.opened?.composing && !event.altKey && !event.shiftKey &&
          event.target === body && body.isContentEditable && (event.key === 'Backspace' || event.key === 'Delete')) {
          const selection = window.getSelection();
          const range = noteMedia.selection(body) || (selection.rangeCount ? selection.getRangeAt(0) : null);
          if (noteDocument.selectedMedia(body, range)) {
            if (selection.isCollapsed) noteDocument.restore(body, range);
            this.beginHistory(body);
            noteDocument.deleteAroundMedia(body, event, range);
            this.input(false, 'deleteSelectedMedia');
            return;
          }
        }
        if (!event.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
          (event.code === 'KeyC' || event.code === 'KeyX') && event.target === body) {
          const pictureRange = noteMedia.selection?.(body);
          if (pictureRange) {
            event.preventDefault();
            if (!event.repeat) {
              const selection = noteDocument.selectionOf(body, pictureRange);
              if (this.selectedPictures(selection).length) this.run(() => this.copyPictures(selection, event.code === 'KeyX'));
            }
            return;
          }
        }
        if (!event.isComposing && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) this.handleSelectionMenu(event);
      });
      this['note-ai-instruction'].addEventListener('input', () => this.renderSelectionAI());
      this['note-ai-form'].addEventListener('submit', event => {
        event.preventDefault();
        this.run(() => this.runSelectionAI(this.selectionAI));
      });
      this['note-ai-accept'].addEventListener('click', () => this.acceptRewrite());
      this['note-ai-dismiss'].addEventListener('click', () => this.closeSelectionAI({ restore: true }));
      panel.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.isComposing || !this.selectionAI) return;
        event.preventDefault();
        event.stopPropagation();
        this.closeSelectionAI({ restore: true });
      });
      document.addEventListener('pointerdown', event => {
        if (this.selectionAI && !panel.contains(event.target)) this.closeSelectionAI();
      }, true);
    }

    get dirty() {
      return Boolean(window.InMomentNoteImageViewer?.isDirty?.()) ||
        [...this.cache.values()].some(note => note.version !== note.savedVersion && (!note.provisional || this.hasText(note)));
    }
    get visible() { return !this.root.classList.contains('hidden'); }
    get narrow() { return window.matchMedia('(max-width: 670px)').matches; }

    async run(action) {
      try { return await action(); }
      catch (error) { this.toast(error.message || '笔记操作未完成，请重试。', true); return null; }
    }

    show(topics) {
      if (topics) this.setTopics(topics);
      return this.run(() => this.refreshList());
    }

    hide() {
      window.InMomentNoteImageViewer?.close({ owner: this, force: true });
      this.grouping?.hide();
      window.InMomentConfirm.close();
      window.InMomentGroupPicker?.close();
      this.openRequest++;
      this.closeNoteAI();
      this.noteFormat.reset();
      this.closeBackground();
      this.pauseMedia();
      if (this.opened?.provisional && !this.hasText(this.opened) && !this.opened.mediaBusy && !this.opened.saving) this.closeEditor();
      else if (!this.opened?.composing) this.save(this.opened);
    }

    setTopics(topics) {
      const fingerprint = JSON.stringify(topics.map(({ id, name, parentId }) => [id, name, parentId]));
      if (fingerprint === this.topicFingerprint) return;
      this.topicFingerprint = fingerprint;
      this.topics = topics;
      if (!['all', 'uncategorized'].includes(this.topicId) && !topics.some(topic => topic.id === this.topicId)) this.resetTopic('all');
      this.renderStatus();
      this.onGroupsChange();
    }

    async selectTopic(topicId) {
      if (this.topicId === topicId) return;
      this.resetTopic(topicId);
      this.onGroupsChange();
      await this.refreshList();
    }

    resetTopic(topicId) {
      this.topicId = topicId;
      this['notes-query'].value = '';
      this.grouping?.hide();
      this.closeEditor();
      this.resetSelection();
      this.list = [];
      this.listHasMore = false;
      this['notes-list'].replaceChildren();
      this.renderRecent([]);
      this['notes-list-status'].classList.add('hidden');
      this['notes-more'].classList.add('hidden');
      this.updateSelection();
      this.grouping?.update();
    }

    pauseMedia() {
      for (const video of this['note-editor'].querySelectorAll('video')) video.pause();
    }

    focusSearch() {
      if (!this.visible) return;
      if (this.narrow && this.opened) this.back(false);
      this['notes-query'].focus();
      this['notes-query'].select();
    }

    shortcut(event) {
      if (event.isComposing || this['note-background-dialog'].open || (!event.ctrlKey && !event.metaKey)) return false;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        this.run(() => this.focusSearch());
        return true;
      }
      if (key === 's') {
        event.preventDefault();
        this.save(this.opened);
        return true;
      }
      return false;
    }

    async refreshList(append = false) {
      clearTimeout(this.searchTimer);
      const request = ++this.listRequest;
      const query = this['notes-query'].value;
      const topicId = this.topicId;
      const offset = append ? this.list.length : 0;
      this['notes-more'].disabled = true;
      try {
        const result = await this.invoke('notes:list', { query, offset, includeRecent: !append, ...(topicId !== 'all' ? { topicId } : {}) });
        if (request !== this.listRequest) return;
        this.list = append ? [...this.list, ...result.notes] : result.notes;
        this.listHasMore = result.hasMore;
        this.listScope = { query, topicId };
        this.groupCounts = result.groupCounts;
        this.onGroupsChange();
        this.renderList();
        if (!append) this.renderRecent(result.recent);
        this['notes-more'].classList.toggle('hidden', !this.listHasMore);
      } finally {
        if (request === this.listRequest) this['notes-more'].disabled = false;
      }
    }

    renderRecent(notes = []) {
      const host = this['notes-recent-list'];
      const focusedId = document.activeElement?.dataset?.recentNoteId;
      let focusTarget;
      const items = notes.map(note => {
        const title = titleFor(note);
        const row = element('li');
        const button = element('button', 'text-button notes-recent-item');
        button.dataset.recentNoteId = note.id;
        button.dataset.uiIcon = 'transcript';
        button.title = title;
        const updatedAt = new Date(note.updatedAt);
        const time = element('time', '', dateFormat.format(updatedAt) + ' ' + timeFormat.format(updatedAt));
        time.dateTime = updatedAt.toISOString();
        button.append(element('span', 'notes-recent-title', title), time);
        button.addEventListener('click', () => this.run(() => this.open(note.id, { focus: 'body' })));
        if (note.id === focusedId) focusTarget = button;
        row.append(button);
        return row;
      });
      host.replaceChildren(...items);
      this['notes-recent'].classList.toggle('hidden', items.length === 0);
      focusTarget?.focus({ preventScroll: true });
    }

    renderList() {
      const host = this['notes-list'];
      const active = document.activeElement;
      const focused = active?.dataset.noteId || active?.dataset.noteChoiceId;
      const scrollTop = host.scrollTop;
      const fragment = document.createDocumentFragment();
      const seen = new Set();
      for (const note of this.list) {
        if (seen.has(note.id)) continue;
        seen.add(note.id);
        const row = element('div', 'note-list-row');
        const button = element('button', 'note-list-item');
        button.dataset.noteId = note.id;
        if (note.id === this.opened?.id && this.root.dataset.noteOpen === 'true') button.setAttribute('aria-current', 'true');
        const title = titleFor(note);
        button.title = title;
        const date = element('span', 'note-list-date');
        date.append(element('span', '', dateFormat.format(note.updatedAt)), element('span', '', timeFormat.format(note.updatedAt)));
        button.append(element('span', 'note-list-title', title), date);
        button.addEventListener('click', () => {
          if (this.noteSelection.enabled) this.toggleNoteSelection(note.id);
          else this.run(() => this.open(note.id, { focus: this.narrow ? 'body' : false }));
        });
        const showMenu = event => {
          event.preventDefault();
          event.stopPropagation();
          this.run(() => this.openRowMenu(note, button));
        };
        button.addEventListener('contextmenu', showMenu);
        button.addEventListener('keydown', event => {
          if (!event.isComposing && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) showMenu(event);
        });
        if (this.noteSelection.enabled) {
          const checkbox = element('input', 'record-selection-master note-list-checkbox');
          checkbox.type = 'checkbox';
          checkbox.dataset.noteChoiceId = note.id;
          checkbox.checked = this.noteSelection.ids.has(note.id);
          button.setAttribute('aria-pressed', String(checkbox.checked));
          checkbox.disabled = this.noteSelection.pending;
          checkbox.setAttribute('aria-label', `选择“${title}”`);
          checkbox.addEventListener('change', () => this.toggleNoteSelection(note.id));
          row.append(checkbox);
        }
        row.append(button);
        fragment.append(row);
      }
      host.replaceChildren(fragment);
      host.scrollTop = scrollTop;
      if (focused) {
        const item = this.listItem(focused);
        const target = active.dataset.noteChoiceId && item?.parentElement.querySelector('input') || item;
        target?.focus({ preventScroll: true });
      }
      this['notes-list-status'].textContent = this['notes-query'].value.trim() ? '没有匹配的笔记' : '暂无笔记';
      this['notes-list-status'].classList.toggle('hidden', this.list.length > 0);
      this.updateSelection();
      this.grouping?.update();
    }

    listItem(id) { return [...this['notes-list'].querySelectorAll('.note-list-item')].find(item => item.dataset.noteId === id); }

    resetSelection(enabled = false) { this.noteSelection = { enabled, ids: new Set(), all: false, pending: false }; }

    updateSelection() {
      const selection = this.noteSelection;
      const count = selection.ids.size;
      const master = this['notes-select-all'];
      master.disabled = !this.list.length || selection.pending;
      master.checked = selection.all || Boolean(count && !this.listHasMore && this.list.every(note => selection.ids.has(note.id)));
      master.indeterminate = Boolean(count && !master.checked);
      this['notes-select-toggle'].disabled = selection.pending;
      this['notes-select-toggle'].textContent = selection.enabled ? '完成' : '多选';
      this['notes-select-toggle'].setAttribute('aria-pressed', String(selection.enabled));
      this['notes-selection-status'].classList.toggle('hidden', !selection.enabled);
      this['notes-selection-count'].textContent = selection.pending ? '正在选择…' : `已选 ${count} 条`;
      this['notes-selection-actions'].disabled = !count || selection.pending;
    }

    toggleNoteSelection(id) {
      const { ids, pending } = this.noteSelection;
      if (pending) return;
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      this.noteSelection.all = false;
      this.renderList();
    }

    async selectAllNotes(checked) {
      const { topicId } = this;
      const query = this['notes-query'].value;
      if (!this.list.length) return;
      this.resetSelection(true);
      const selection = this.noteSelection;
      try {
        if (checked) {
          selection.pending = true;
          this.renderList();
          const { ids } = await this.invoke('notes:listIds', { query, ...(topicId === 'all' ? {} : { topicId }) });
          if (selection !== this.noteSelection) return;
          selection.ids = new Set(ids);
          selection.all = Boolean(ids.length);
        }
      } finally {
        selection.pending = false;
        if (selection === this.noteSelection) this.renderList();
      }
    }

    async openRowMenu(note, anchor) {
      const scope = this.topicId;
      const action = await window.InMomentMenus.open({ anchor, title: '笔记操作', items: [
        { id: 'rename', label: '重命名', icon: 'edit' },
        { id: 'organize', label: 'AI 整理', icon: 'sparkle', disabled: Boolean(this.grouping?.request) },
        { id: 'copy', label: '复制笔记', icon: 'transcript' },
        { id: 'delete', label: '删除笔记', danger: true },
        { id: 'group', label: '添加到组', icon: 'folder-in', disabled: !this.topics.length },
        { id: 'export', label: '导出为…', icon: 'external' },
      ] });
      if (!action || !this.visible || this.topicId !== scope || !anchor.isConnected) return;
      await this.applyNoteAction(action, [note.id], anchor);
    }

    async openBulkMenu() {
      const selection = this.noteSelection;
      if (selection.pending || !selection.ids.size) return;
      const anchor = this['notes-selection-actions'];
      const action = await window.InMomentMenus.open({ anchor, title: '批量笔记操作', items: [
        { id: 'copy', label: '复制笔记', icon: 'transcript' },
        { id: 'group', label: '添加到组', icon: 'folder-in', disabled: !this.topics.length },
        { id: 'export', label: '导出笔记', icon: 'external' },
        { id: 'delete', label: '删除笔记', danger: true },
      ] });
      if (!action || this.noteSelection !== selection || !this.visible) return;
      try { await this.applyNoteAction(action, [...selection.ids], anchor); }
      finally { if (selection === this.noteSelection && !selection.ids.size) this['notes-select-toggle'].focus({ preventScroll: true }); }
    }

    async ensureSaved(ids) {
      const notes = ids.map(id => this.cache.get(id)).filter(Boolean);
      await Promise.all(notes.map(note => this.save(note)));
      if (notes.some(note => note.provisional || note.version !== note.savedVersion || note.deleted || note.deleting)) {
        throw new Error('请先完成所选笔记的保存。');
      }
    }

    async applyNoteAction(action, ids, anchor) {
      if (action === 'rename') return this.open(ids[0], { focus: 'selectTitle' });
      if (action === 'organize') return this.grouping?.run({ noteIds: ids, anchor });
      if (action === 'delete') return this.deleteNotes(ids, anchor);
      if (action === 'group') return this.copyToGroup(ids, anchor);
      await this.ensureSaved(ids);
      if (action === 'export') {
        const result = await this.invoke('notes:export', { ids });
        if (result && !result.cancelled) this.toast('笔记已导出。');
        return;
      }
      const result = await this.invoke('notes:copy', { ids });
      await this.refreshList();
      this.toast(`已复制 ${result.notes.length} 条笔记。`);
    }

    async deleteNotes(ids, anchor) {
      const confirmed = await window.InMomentConfirm.open({ anchor, title: `删除 ${ids.length} 条笔记？`, message: '所选笔记及其录音、截图和附件将从本机删除。', danger: true, confirmLabel: '删除笔记' });
      if (!confirmed) return;
      const notes = ids.map(id => this.cache.get(id)).filter(Boolean);
      if (notes.some(note => note.mediaBusy || note.deleting)) throw new Error('笔记正在处理附件或删除，请稍后重试。');
      for (const note of notes) { note.deleting = true; clearTimeout(note.saveTimer); }
      const wasOpen = ids.includes(this.opened?.id);
      if (wasOpen) {
        window.InMomentNoteImageViewer?.close({ owner: this, force: true });
        this.closeNoteAI(); this.closeBackground(); this.pauseMedia();
      }
      this.renderStatus();
      try {
        await Promise.all(notes.map(note => note.saving));
        const result = await this.invoke('notes:deleteMany', { ids });
        for (const id of result.deleted) {
          const note = this.cache.get(id);
          if (note) this.removeFromCache(note);
          this.noteSelection.ids.delete(id);
        }
        this.noteSelection.all = false;
        if (result.deleted.includes(this.opened?.id)) this.closeEditor();
        this.cleanupNotice(result);
        await this.refreshList();
        this.toast(`已删除 ${result.deleted.length} 条笔记。`);
        if (this.visible && document.activeElement === document.body) this['notes-select-toggle'].focus({ preventScroll: true });
      } finally {
        for (const note of notes) { note.deleting = false; this.save(note); }
        this.notifyDirty();
        this.renderStatus();
      }
    }

    async copyToGroup(ids, anchor) {
      if (!this.topics.length) return;
      const scope = this.topicId;
      const topics = window.InMomentTopicTree?.pathLabels?.(this.topics) || this.topics;
      const disabledIds = ids.length === 1 ? (await this.invoke('notes:get', { id: ids[0] })).topicIds : [scope];
      if (!this.visible || scope !== this.topicId || !anchor.isConnected) return;
      const topic = await window.InMomentGroupPicker.open({ anchor, topics, selectedIds: disabledIds, disabledIds, title: '复制笔记到组' });
      if (!topic || !this.visible || scope !== this.topicId) return;
      await this.ensureSaved(ids);
      const result = await this.invoke('notes:copy', { ids, topicId: topic.id });
      await this.refreshList();
      this.toast(`已将 ${result.notes.length} 条笔记复制到“${topic.name}”。`);
    }

    async create() {
      if (this['new-note'].disabled) return;
      const topic = this.topics.find(topic => topic.id === this.topicId);
      const note = this.addToCache({ id: `local-note:${++this.localNoteId}`, title: '', body: '', attachments: [], summaries: [], topics: topic ? [topic] : [], pendingTopicId: topic?.id, provisional: true });
      if (this.noteSelection.enabled) this.resetSelection();
      const filtered = Boolean(this['notes-query'].value);
      this['notes-query'].value = '';
      await this.open(note.id, { focus: 'title' });
      if (this.opened !== note) this.releaseNote(note);
      if (filtered) await this.refreshList();
      else this.renderList();
    }

    addToCache(note) {
      const entry = { ...note, version: 0, savedVersion: 0 };
      this.cache.set(note.id, entry);
      return entry;
    }

    hasText(note) { return Boolean(note.title.trim() || note.body.trim()); }

    releaseNote(note) {
      if (!note || note.deleted) return;
      if (note.provisional && !this.hasText(note) && !note.mediaBusy && !note.saving) {
        this.removeFromCache(note);
        this.notifyDirty();
      } else this.save(note);
    }

    newNoteFields(note) {
      const { title, body, document, pendingTopicId } = note;
      const topicId = this.topics.find(topic => topic.id === pendingTopicId)?.id;
      return { title, body, document, ...(topicId ? { topicId } : {}) };
    }

    adoptNewNote(note, result, version) {
      this.cache.delete(note.id);
      const { title, body, document } = note;
      Object.assign(note, result, { title, body, document, savedVersion: version, saveError: '', provisional: false });
      this.cache.set(note.id, note);
    }

    async open(id, { focus = 'title' } = {}) {
      const request = ++this.openRequest;
      let note = this.cache.get(id);
      if (!note) {
        const saved = await this.invoke('notes:get', { id });
        if (request !== this.openRequest) return;
        if (!saved) throw new Error('这条笔记已不存在。');
        note = this.cache.get(id) || this.addToCache(saved);
      }
      if (request !== this.openRequest || note.deleted || note.deleting) return;
      const viewer = window.InMomentNoteImageViewer;
      if (this.opened !== note && viewer?.isOpen() && !await viewer.close({ restoreFocus: false })) return;
      if (request !== this.openRequest || note.deleted || note.deleting) return;
      const change = () => {
        if (this.opened !== note) {
          this.releaseNote(this.opened);
          this.closeNoteAI();
          this.closeBackground();
          this.pauseMedia();
          this.opened = note;
          this['note-title'].value = note.title;
          this.bodyCaret = null;
          this.noteFormat.reset();
          this.loadDocument(note);
          this['note-editor'].querySelector('.note-document').scrollTop = 0;
          this.renderMedia();
          this.renderSummaries(note);
          this.renderLinks();
        }
        this.root.dataset.noteOpen = 'true';
        this['notes-empty'].classList.add('hidden');
        this['note-editor'].classList.remove('hidden');
        for (const item of this['notes-list'].querySelectorAll('.note-list-item')) {
          if (item.dataset.noteId === id) item.setAttribute('aria-current', 'true');
          else item.removeAttribute('aria-current');
        }
        this.renderStatus();
        if (focus && this.visible) {
          const field = this[focus === 'body' ? 'note-body' : 'note-title'];
          field.focus({ preventScroll: true });
          if (focus === 'selectTitle') field.select();
        }
      };
      if (this.opened !== note && window.InMomentMotion && this.visible) {
        const from = this.narrow ? this.root.querySelector('.notes-navigator') : this['note-editor'];
        await window.InMomentMotion.transition({ from, to: this['note-editor'], update: change, guard: () => this.openRequest === request, kind: 'text' }).updated;
      } else change();
    }

    back(restoreFocus = true) {
      const id = this.opened?.id;
      this.closeEditor();
      if (restoreFocus) (this.listItem(id) || this['new-note']).focus();
    }

    closeEditor() {
      window.InMomentNoteImageViewer?.close({ owner: this, force: true });
      this.openRequest++;
      this.releaseNote(this.opened);
      this.closeNoteAI();
      this.closeBackground();
      this.pauseMedia();
      this.noteFormat.reset();
      this.bodyCaret = null;
      this.opened = null;
      this.root.dataset.noteOpen = 'false';
      this['note-editor'].classList.add('hidden');
      this['notes-empty'].classList.remove('hidden');
      for (const item of this['notes-list'].querySelectorAll('[aria-current=true]')) item.removeAttribute('aria-current');
    }

    async backFromNote() {
      const child = this.opened;
      if (!child?.summaryParentId) return this.back();
      await this.open(child.summaryParentId, { focus: false });
      if (this.opened?.id !== child.summaryParentId || !this.visible) return;
      const attachment = [...this['note-summaries'].querySelectorAll('.note-summary-link')].find(link => link.dataset.summaryId === child.id);
      (attachment || this['note-title']).focus();
    }

    editorSelection(field = document.activeElement) {
      if (field === this['note-title']) {
        return { field: 'title', start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection };
      }
      const body = this['note-body'];
      const mark = noteDocument.bookmark(body);
      return mark ? { field: 'body', mark } : null;
    }

    beginHistory(field) {
      const note = this.opened;
      if (!note || note.deleting || note.composing || this.restoringHistory) return;
      note.beforeEdit = noteHistory.snapshot(note, this.editorSelection(field));
    }

    applyHistory(action, field) {
      const note = this.opened;
      if (!note || note.deleting || note.composing || note.mediaBusy || this.restoringHistory ||
        !this.visible || this.root.dataset.noteOpen !== 'true') return;
      const state = noteHistory.step(note, action);
      if (!state) return;
      this.restoringHistory = true;
      try {
        note.beforeEdit = null;
        this.closeNoteAI();
        this.pauseMedia();
        this.noteFormat.reset();
        const body = this['note-body'];
        const title = this['note-title'];
        title.value = state.title;
        if (note.documentSignature !== state.documentSignature || note.body !== state.body) this.renderDocument(note, body, state);
        const selection = state.selection;
        if (selection?.field === 'title') {
          title.focus({ preventScroll: true });
          title.setSelectionRange(selection.start, selection.end, selection.direction);
        } else if (selection?.field === 'body') {
          noteDocument.restore(body, noteDocument.fromBookmark(body, selection.mark), selection.mark.direction);
        } else if (field === body) {
          const range = document.createRange();
          range.selectNodeContents(body);
          range.collapse(false);
          noteDocument.restore(body, range);
        }
        this.input(false);
      } finally { this.restoringHistory = false; }
    }

    input(composing, kind) {
      const note = this.opened;
      if (!note || note.deleting) return;
      const title = this['note-title'].value;
      const previous = note.documentSignature;
      const snapshot = noteDocument.read(this['note-body']);
      const signature = JSON.stringify(snapshot.document);
      const before = note.beforeEdit || noteHistory.snapshot(note, null);
      if (!composing) note.beforeEdit = null;
      if (title !== note.title || snapshot.body !== note.body || signature !== previous) {
        if (composing) note.beforeEdit ||= before;
        Object.assign(note, { title, ...snapshot, documentSignature: signature, version: note.version + 1, saveError: '' });
        this.notifyDirty();
        const embedded = this.embeddedMediaIds(this['note-body']);
        if (embedded !== this.embeddedMedia) this.renderMedia();
      }
      if (!composing && !this.restoringHistory) {
        noteHistory.record(note, before, noteHistory.snapshot(note, this.editorSelection()), kind);
      }
      note.composing = Boolean(composing);
      clearTimeout(note.saveTimer);
      if (!note.composing) note.saveTimer = setTimeout(() => this.save(note), 280);
      this.renderStatus();
      if (this.selectionAI && !this.matchesSelection(this.selectionAI.selection)) this.closeSelectionAI();
    }

    save(note) {
      if (!note || note.deleted || note.deleting || note.composing || note.mediaBusy || note.savedVersion === note.version) return;
      if (note.saving) return note.saving;
      clearTimeout(note.saveTimer);
      if (note.provisional && !this.hasText(note)) return;
      note.saveError = '';
      const save = async () => {
        while (!note.deleting && !note.composing && !note.mediaBusy && note.savedVersion !== note.version) {
          const { id, title, body, document, version } = note;
          if (note.provisional) {
            const result = await this.invoke('notes:create', this.newNoteFields(note));
            this.adoptNewNote(note, result, version);
            continue;
          }
          const result = await this.invoke('notes:update', { id, title, body, document });
          note.savedVersion = version;
          note.updatedAt = result.updatedAt;
          const parent = this.cache.get(note.summaryParentId);
          const attachment = parent?.summaries?.find(summary => summary.id === id);
          if (attachment && attachment.title !== result.title) {
            attachment.title = result.title;
            if (this.opened === parent) this.renderSummaries(parent);
          }
        }
        if (this.opened === note) this.renderLinks();
        this.run(() => this.refreshList());
      };
      note.saving = save().catch(error => {
        note.saveError = error.message || '保存失败';
        this.toast('笔记保存失败，修改仍保留。' + note.saveError, true);
      }).finally(() => {
        note.saving = null;
        this.notifyDirty();
        this.renderStatus();
      });
      this.renderStatus();
      return note.saving;
    }

    renderStatus() {
      const note = this.opened;
      if (!note) return;
      const busy = note.mediaBusy || note.deleting;
      const status = note.saveError ? '保存失败' : note.mediaBusy ? '正在处理附件…' :
        note.provisional && !this.hasText(note) ? '新笔记' :
          note.version !== note.savedVersion ? '正在保存…' : note.summaryBusy ? '正在生成总结…' : '已保存';
      if (this['note-status'].textContent !== status) this['note-status'].textContent = status;
      this['note-status'].classList.toggle('note-save-error', Boolean(note.saveError));
      this['note-retry'].classList.toggle('hidden', !note.saveError);
      this['note-background'].classList.toggle('hidden', !note.background);
      this['note-back'].classList.toggle('note-parent-back', Boolean(note.summaryParentId));
      this['note-back'].title = note.summaryParentId ? '返回原笔记' : '返回笔记列表';
      this['note-back'].setAttribute('aria-label', this['note-back'].title);
      this['note-ai-summary'].disabled = Boolean(busy || note.composing || (!note.title.trim() && !note.body.trim() && !note.background && !note.attachments.length));
      this['note-ai-summary'].setAttribute('aria-disabled', String(Boolean(note.summaryBusy || this.selectionAI?.pending)));
      this['note-group'].classList.toggle('hidden', Boolean(note.summaryParentId || note.provisional) || !this.topics.length);
      const attachmentControls = this['note-editor'].querySelectorAll('.note-remove, .note-summary-link, .note-inline-media button');
      for (const control of [this['note-delete'], this['note-attach'], this['note-group'], this['note-background'], ...attachmentControls]) {
        control.disabled = Boolean(busy || (note.summaryBusy && control.classList.contains('note-summary-remove')));
      }
      this['note-title'].readOnly = Boolean(note.deleting);
      this['note-body'].contentEditable = String(!note.deleting);
      this['note-body'].setAttribute('aria-readonly', String(Boolean(note.deleting)));
      this.noteFormat.setDisabled(Boolean(note.deleting));
    }

    async summarizeNote() {
      const note = this.opened;
      const button = this['note-ai-summary'];
      if (!note || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
      note.summaryBusy = true;
      if (this.selectionAI) this.renderSelectionAI(); else this.renderStatus();
      try {
        await this.save(note);
        if (note.deleted || note.deleting) return;
        if (note.savedVersion !== note.version) throw new Error('请先保存笔记，再生成总结。');
        const { note: updated, summary } = await this.invoke('notes:aiSummary', { id: note.id });
        if (note.deleted || note.deleting) return;
        note.summaries = updated.summaries;
        note.updatedAt = Math.max(note.updatedAt, updated.updatedAt);
        if (!this.cache.has(summary.id)) this.addToCache(summary);
        if (this.opened === note && this.visible) {
          this.renderSummaries(note);
          this.toast('总结笔记已添加到附件。');
        }
        this.run(() => this.refreshList());
      } finally {
        note.summaryBusy = false;
        if (this.selectionAI) this.renderSelectionAI(); else this.renderStatus();
      }
    }

    handleSelectionMenu(event) {
      const note = this.opened;
      const body = this['note-body'];
      if (!note || note.deleting || note.composing || !this.visible || !window.InMomentMenus) return;
      let selection = noteDocument.selectionOf(body, noteMedia.selection?.(body));
      const image = event.target.closest?.('[data-note-media] img')?.closest('[data-note-media]');
      if (image && !this.selectedPictures(selection).includes(image)) {
        const range = document.createRange();
        range.selectNode(image);
        noteDocument.restore(body, range);
        selection = noteDocument.selectionOf(body);
      }
      if (!selection?.text.trim() && !this.selectedPictures(selection).length) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = body.getBoundingClientRect();
      const documentRect = body.parentElement.getBoundingClientRect();
      const mouse = event.type === 'contextmenu' && (event.clientX || event.clientY);
      const point = { x: mouse ? event.clientX : rect.left + 16, y: mouse ? event.clientY : Math.max(rect.top, documentRect.top) + 24 };
      this.run(() => this.openSelectionMenu({ ...selection, note, version: note.version }, point, mouse));
    }

    async openSelectionMenu(selection, point, mouse) {
      const { note } = selection;
      const body = this['note-body'];
      const view = this;
      this.closeSelectionAI();
      this.selectionMenu = selection;
      const line = this.selectionGeometry.set(selection);
      const pictures = this.selectedPictures(selection);
      const x = !mouse && line ? line.right : point.x;
      const anchor = {
        get isConnected() { return body.isConnected && view.selectionMenu === selection && view.opened === note && view.visible; },
        getBoundingClientRect: () => ({ left: x, right: x, top: line?.selectionTop ?? point.y, bottom: line?.bottom ?? point.y }),
        focus: () => this.restoreSelection(selection),
      };
      const aiActions = selection.text.trim() && !pictures.length ? [
        { id: 'ai-summary', label: '总结', icon: 'sparkle', disabled: Boolean(note.summaryBusy) },
        { id: 'ai-rewrite', label: '改写', icon: 'sparkle', disabled: Boolean(note.summaryBusy) },
      ] : [];
      let action;
      try {
        action = await window.InMomentMenus.open({ anchor, title: pictures.length ? '所选图文操作' : '所选文字操作', items: [
          ...aiActions,
          { id: 'copy', label: '复制' }, { id: 'cut', label: '剪切' }, { id: 'paste', label: '粘贴' },
        ] });
      } finally {
        if (this.selectionMenu !== selection) action = null;
        else {
          this.selectionMenu = null;
          if (!action || !this.matchesSelection(selection) || !action.startsWith('ai-') || note.summaryBusy) this.selectionGeometry.clear();
        }
      }
      if (!action || !this.matchesSelection(selection)) return;
      this.restoreSelection(selection);
      if (action === 'ai-summary' || action === 'ai-rewrite') {
        if (note.summaryBusy) return;
        const state = { selection, mode: action === 'ai-rewrite' ? 'rewrite' : 'summary' };
        this.selectionAI = state;
        this.renderSelectionAI();
        this.showSelectionAI(true);
        if (state.mode === 'rewrite') this['note-ai-instruction'].focus({ preventScroll: true });
        else await this.runSelectionAI(state);
      } else if (pictures.length && action !== 'paste') await this.copyPictures(selection, action === 'cut');
      else await this.invoke('notes:clipboard', { action });
    }

    selectedPictures(selection) {
      if (!selection || selection.range.collapsed) return [];
      return [...this['note-body'].querySelectorAll('[data-note-media]')].filter(media =>
        selection.range.intersectsNode(media) && this.opened?.attachments.some(asset => asset.id === media.dataset.noteMedia && asset.kind === 'image'));
    }

    async copyPictures(selection, cut) {
      const note = this.opened;
      if (!note || note.deleting || note.composing) return;
      const body = this['note-body'];
      const version = note.version;
      const pictures = this.selectedPictures(selection);
      const contents = noteDocument.copySelection(body, selection);
      if (!contents) return;
      const converted = {};
      let convertedBytes = 0;
      for (const media of pictures) {
        const id = media.dataset.noteMedia;
        const attachment = note.attachments.find(asset => asset.id === id);
        if (/\.(?:png|jpe?g)$/iu.test(attachment.name)) continue;
        const { bytes, mime } = await this.invoke('notes:readPicture', { id: note.id, attachmentId: id });
        const picture = await createImageBitmap(new Blob([bytes], { type: mime }));
        const canvas = document.createElement('canvas');
        try {
          canvas.width = picture.width;
          canvas.height = picture.height;
          if (!canvas.width || !canvas.height || canvas.width * canvas.height > 32_000_000) throw new Error('图片尺寸过大，请缩小原图后再复制。');
          canvas.getContext('2d').drawImage(picture, 0, 0);
        } finally { picture.close(); }
        const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!png) throw new Error('无法复制选中的图片，请确认图片能够打开。');
        convertedBytes += png.size;
        if (convertedBytes > MAX_CLIPBOARD_BYTES) throw new Error('选中的图片超过 32 MB，请分次复制。');
        converted[id] = new Uint8Array(await png.arrayBuffer());
      }
      await this.invoke('notes:copySelection', { id: note.id, document: contents, plain: selection.text, converted });
      if (cut && this.matchesSelection({ ...selection, note, version }) && document.activeElement === body) {
        const current = noteDocument.selectionOf(body, noteMedia.selection?.(body))?.range;
        if (current && current.compareBoundaryPoints(Range.START_TO_START, selection.range) === 0 &&
          current.compareBoundaryPoints(Range.END_TO_END, selection.range) === 0) {
          noteDocument.restore(body, selection.range, selection.direction);
          document.execCommand('delete');
        }
      }
    }

    matchesSelection({ note, version, range }) {
      return this.opened === note && this.visible && this.root.dataset.noteOpen === 'true' &&
        !note.deleted && !note.deleting && !note.composing && note.version === version && noteDocument.rangeInside(this['note-body'], range);
    }

    restoreSelection(selection) {
      if (!this.matchesSelection(selection)) return;
      const body = this['note-body'];
      const bodyScroll = body.scrollTop;
      const documentScroll = body.parentElement.scrollTop;
      noteDocument.restore(body, selection.range, selection.direction);
      body.scrollTop = bodyScroll;
      body.parentElement.scrollTop = documentScroll;
    }

    showSelectionAI(show) {
      const panel = this['note-ai-inline'];
      if (window.InMomentMotion) window.InMomentMotion.show(panel, show, { kind: 'popover' });
      else panel.classList.toggle('hidden', !show);
      if (show) this.selectionGeometry.position();
    }

    renderSelectionAI() {
      const state = this.selectionAI;
      if (!state) return;
      const rewrite = state.mode === 'rewrite';
      const instruction = this['note-ai-instruction'];
      const result = this['note-ai-result'];
      const preview = this['note-ai-preview'];
      const accept = this['note-ai-accept'];
      const dismiss = this['note-ai-dismiss'];
      const feedback = this['note-ai-feedback'];
      const changed = !this.matchesSelection(state.selection);
      const error = (changed && rewrite ? '正文已更改，请重新选择要改写的文字。' : '') || state.error;
      const panel = this['note-ai-inline'];
      const hasResult = Boolean(state.text || state.preview);
      panel.dataset.state = error ? 'error' : hasResult ? 'result' : state.pending || !rewrite ? 'pending' : 'prompt';
      this['note-ai-form'].classList.toggle('hidden', !rewrite || hasResult || Boolean(state.pending));
      this['note-ai-submit'].disabled = Boolean(state.pending || state.selection.note.summaryBusy || changed || !instruction.value.trim());
      result.classList.toggle('hidden', !state.text);
      if (result.value !== (state.text || '')) result.value = state.text || '';
      this['note-ai-preview-wrap'].classList.toggle('hidden', !state.preview);
      if (state.preview && !preview.hasChildNodes()) {
        const { before, text, after, insertAt } = state.preview;
        document.getElementById('note-ai-preview-label').textContent = insertAt === undefined ? '高亮部分将替换原选段' : '高亮条目将追加到列表末尾';
        preview.replaceChildren(before, element('mark', '', text), after);
      }
      accept.classList.toggle('hidden', !state.preview);
      accept.disabled = changed || Boolean(error);
      dismiss.title = rewrite ? '放弃修改' : '关闭选段总结';
      dismiss.setAttribute('aria-label', dismiss.title);
      dismiss.classList.toggle('ui-cancel', rewrite);
      const message = error || (state.pending
        ? (rewrite ? '正在生成修改稿…' : '正在总结选段…')
        : (hasResult ? (rewrite ? '改写稿已生成' : '选段总结已生成') : ''));
      if (feedback.textContent !== message) feedback.textContent = message;
      feedback.classList.toggle('note-ai-error', Boolean(error));
      this.selectionGeometry.position();
      this.renderStatus();
    }

    async runSelectionAI(state) {
      if (!state || this.selectionAI !== state || state.pending || state.text || state.preview || !this.matchesSelection(state.selection)) return;
      const { note, text, start, end, value } = state.selection;
      const rewrite = state.mode === 'rewrite';
      const instruction = this['note-ai-instruction'].value.trim();
      if (note.summaryBusy || (rewrite && !instruction)) return;
      state.pending = true;
      state.error = '';
      this.renderSelectionAI();
      try {
        await this.save(note);
        if (this.selectionAI !== state) return;
        if (!this.matchesSelection(state.selection)) throw new Error('正文已更改，请重新选择文字。');
        if (note.savedVersion !== note.version) throw new Error('请先保存笔记，再继续。');
        const method = rewrite ? 'notes:aiRewrite' : 'notes:aiSummary';
        const response = await this.invoke(method, { id: note.id, selection: text, start, end, ...(rewrite ? { instruction } : {}) });
        if (this.selectionAI !== state) return;
        if (!this.matchesSelection(state.selection)) throw new Error('正文已更改，请重新选择文字。');
        if (rewrite) {
          const expansion = window.InMomentNoteListExpansion.target({ value, end, instruction });
          let preview;
          if (expansion) {
            if (!Array.isArray(response?.items)) throw new Error('AI 没有返回新条目，请重试。');
            preview = window.InMomentNoteListExpansion.preview({ value, target: expansion, items: response.items });
          } else {
            if (!response?.text?.trim()) throw new Error('AI 没有返回文字，请重试。');
            preview = window.InMomentNoteRewrite.preview({ value, start, end, text: response.text });
          }
          if (preview.error) throw new Error(preview.error);
          const removedLength = expansion ? 0 : end - start;
          if (value.length - removedLength + preview.text.length > noteDocument.maxLength) {
            throw new Error('修改稿会超过笔记正文的长度限制。');
          }
          state.preview = preview;
        } else {
          if (!response?.text?.trim()) throw new Error('AI 没有返回文字，请重试。');
          state.text = response.text;
        }
      } catch (error) {
        state.error = error.message || 'AI 操作未完成，请重试。';
      } finally {
        state.pending = false;
        if (this.selectionAI === state) this.renderSelectionAI();
      }
    }

    closeSelectionAI({ restore = false } = {}) {
      const state = this.selectionAI;
      if (!state) return;
      this.selectionAI = null;
      this.showSelectionAI(false);
      this.selectionGeometry.clear();
      this['note-ai-instruction'].value = this['note-ai-result'].value = '';
      this['note-ai-preview'].replaceChildren();
      this['note-ai-feedback'].textContent = '';
      this.renderStatus();
      if (restore) {
        if (this.matchesSelection(state.selection)) this.restoreSelection(state.selection);
        else this['note-body'].focus({ preventScroll: true });
      }
      if (state.pending) this.invoke('notes:cancelAI', { id: state.selection.note.id }).catch(() => {});
    }

    closeNoteAI() {
      if (this.selectionMenu) {
        this.selectionMenu = null;
        window.InMomentMenus?.close();
        this.selectionGeometry.clear();
      }
      this.closeSelectionAI();
    }

    acceptRewrite() {
      const state = this.selectionAI;
      if (!state?.preview || state.error || !this.matchesSelection(state.selection)) return;
      const { value } = state.selection;
      const body = this['note-body'];
      const { text, insertAt } = state.preview;
      const start = insertAt ?? state.selection.start;
      const end = insertAt ?? state.selection.end;
      if (value.length - (end - start) + text.length > noteDocument.maxLength) {
        state.error = '修改稿会超过笔记正文的长度限制。';
        this.renderSelectionAI();
        return;
      }
      const range = insertAt === undefined ? state.selection.range : noteDocument.rangeAt(body, insertAt);
      if (noteDocument.includesMedia(body, range)) {
        state.error = '请只选中要改写的文字，图片和视频可单独移动。';
        this.renderSelectionAI();
        return;
      }
      this.closeSelectionAI({ restore: true });
      noteDocument.restore(body, range);
      document.execCommand('insertText', false, text);
      this.input(false);
    }

    async delete() {
      const note = this.opened;
      if (!note || note.mediaBusy || note.deleting) return;
      if (note.provisional && !this.hasText(note) && !note.saving) return this.back();
      const confirmed = await window.InMomentConfirm.open({ anchor: this['note-delete'], title: '删除笔记？', message: '这条笔记及其录音、截图和附件将从本机删除。', danger: true, confirmLabel: '删除笔记' });
      if (!confirmed || this.opened !== note || note.mediaBusy || note.deleting) return;
      note.deleting = true;
      clearTimeout(note.saveTimer);
      window.InMomentNoteImageViewer?.close({ owner: this, force: true });
      this.closeNoteAI();
      this.closeBackground();
      this.pauseMedia();
      this.renderStatus();
      try {
        await note.saving;
        const result = note.provisional ? null : await this.invoke('notes:delete', { id: note.id });
        this.removeFromCache(note);
        const parent = this.cache.get(note.summaryParentId);
        if (parent) parent.summaries = (parent.summaries || []).filter(summary => summary.id !== note.id);
        this.notifyDirty();
        if (this.opened === note) {
          this.opened = null;
          this.root.dataset.noteOpen = 'false';
          this['note-editor'].classList.add('hidden');
          this['notes-empty'].classList.remove('hidden');
          this['note-attachments'].replaceChildren();
          this['note-summaries'].replaceChildren();
          if (this.visible) {
            if (note.summaryParentId) await this.open(note.summaryParentId);
            else this['new-note'].focus();
          }
        } else if (parent && this.opened === parent) {
          this.renderSummaries(parent);
        }
        this.cleanupNotice(result);
        await this.refreshList();
      } finally {
        note.deleting = false;
        if (!note.deleted && !note.saveError) this.save(note);
        this.renderStatus();
      }
    }

    cleanupNotice(result) {
      if (result?.cleanupPending) this.toast('部分附件仍被占用，下次打开应用时会重试清理。', true);
    }

    removeFromCache(note) {
      note.deleted = true;
      clearTimeout(note.saveTimer);
      this.cache.delete(note.id);
      for (const summary of note.summaries || []) {
        const child = this.cache.get(summary.id);
        if (child) this.removeFromCache(child);
      }
    }

    async addToGroup() {
      const note = this.opened;
      if (!note || note.summaryParentId || note.provisional || note.deleting) return;
      return this.copyToGroup([note.id], this['note-group']);
    }

    showBackground() {
      const note = this.opened;
      const dialog = this['note-background-dialog'];
      if (!note?.background || dialog.open) return;
      this.renderBackground(note);
      this.restoreBackgroundFocus = true;
      this['note-background'].setAttribute('aria-expanded', 'true');
      dialog.showModal();
    }

    renderBackground(note) {
      this.disposeBackgroundAudio?.();
      this.disposeBackgroundAudio = null;
      const { appName, windowTitle, url, task, screenshots = [], audioSegments = [], screenshotUnavailable } = note.background;
      const content = this['note-background-content'];
      content.replaceChildren();
      const section = title => {
        const box = element('section', 'note-background-section');
        box.append(element('h3', '', title));
        content.append(box);
        return box;
      };
      if (audioSegments.length) {
        const playback = this.backgroundAudio(note, audioSegments);
        const audio = section('录音');
        audio.append(playback.area);
        const remove = element('button', 'button quiet compact danger', '移除录音');
        remove.dataset.uiIcon = 'trash';
        remove.disabled = !note.body.trim();
        remove.addEventListener('click', () => this.run(() => this.removeAudio(note, remove)));
        audio.append(remove);
        if (remove.disabled) audio.append(element('p', 'field-help', '先在笔记正文保留文字，即可移除录音。'));
        this.disposeBackgroundAudio = playback.dispose;
      }
      if (appName || windowTitle || url || task) {
        const details = element('dl', 'note-background-source');
        for (const [label, value] of [['应用', appName], ['窗口', windowTitle], ['任务', task]]) {
          if (value) details.append(element('dt', '', label), element('dd', '', value));
        }
        if (url) {
          const address = element('dd');
          const link = element('a', 'note-link', url);
          link.href = url;
          link.addEventListener('click', event => { event.preventDefault(); this.run(() => this.invoke('notes:openLink', { url })); });
          address.append(link);
          details.append(element('dt', '', '网址'), address);
        }
        section('来源').append(details);
      }
      if (screenshots.length || screenshotUnavailable) {
        const images = section('截图');
        for (const screenshot of screenshots) {
          const label = screenshot.role === 'region' ? '选区截图' : '来源窗口截图';
          const figure = element('figure', 'note-background-screenshot');
          const preview = element('button', 'screenshot-thumbnail-button');
          preview.setAttribute('aria-label', '查看' + label + '原图');
          const image = element('img', 'note-background-image');
          image.alt = label;
          image.src = screenshot.url;
          image.addEventListener('error', () => image.replaceWith(element('span', 'field-help', '缩略图无法读取，点击查看原图。')));
          preview.append(image);
          preview.addEventListener('click', () => this.openImagePreview(note, { ...screenshot, name: label }, null, preview));
          figure.append(element('figcaption', '', label), preview);
          images.append(figure);
        }
        if (screenshotUnavailable) images.append(element('p', 'field-help', '未能截取来源窗口。'));
      }
      content.scrollTop = 0;
    }

    async removeAudio(note, anchor) {
      if (this.opened !== note || !note.body.trim() || anchor.disabled) return;
      const confirmed = await window.InMomentConfirm.open({ anchor, title: '移除录音？', message: '将删除这条笔记的录音文件。正文、截图和其他附件会保留。', danger: true, confirmLabel: '移除录音' });
      if (!confirmed || this.opened !== note || !this['note-background-dialog'].open) return;
      anchor.disabled = true;
      try {
        await this.save(note);
        if (note.savedVersion !== note.version) throw new Error('请先保存笔记正文，再移除录音。');
        const result = await this.invoke('notes:removeAudio', { id: note.id });
        note.background = result.background;
        note.updatedAt = result.updatedAt;
        this.cleanupNotice(result);
        if (this.opened !== note) return;
        this.renderStatus();
        if (this['note-background-dialog'].open) {
          if (note.background) {
            this.renderBackground(note);
            this['close-note-background'].focus({ preventScroll: true });
          } else this['note-background-dialog'].close();
        }
        await this.refreshList();
      } finally { if (anchor.isConnected) anchor.disabled = false; }
    }

    closeBackground() {
      this.restoreBackgroundFocus = false;
      if (this['note-background-dialog'].open) {
        window.InMomentNoteImageViewer?.close({ owner: this, force: true });
        this['note-background-dialog'].close();
      }
    }

    async changeMedia(method, params = {}, note = this.opened) {
      const position = method === 'notes:pickFiles' ? this.attachmentPosition() : null;
      return this.mediaAction(note, identity => this.invoke(method, { ...identity, ...params }), position);
    }

    attachmentPosition(preferred) {
      const body = this['note-body'];
      const selection = window.getSelection();
      const active = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const cached = this.bodyCaret?.note === this.opened ? this.bodyCaret.range : null;
      const candidate = [preferred, active, cached].find(range => noteDocument.rangeInside(body, range));
      if (!candidate) return { append: true };
      const range = candidate.cloneRange();
      range.collapse(false);
      return { range, offset: noteDocument.endOffset(body, range) };
    }

    async mediaAction(note, operation, position = null) {
      if (!note || note.mediaBusy || note.deleting) return;
      note.mediaBusy = true;
      this.renderStatus();
      try {
        await note.saving;
        const version = note.version;
        const identity = note.provisional ? { create: this.newNoteFields(note) } : { id: note.id };
        const result = await operation(identity);
        if (!result || note.deleted) return;
        const updated = result.note || result;
        const previousIds = new Set(note.attachments.map(attachment => attachment.id));
        if (note.provisional) this.adoptNewNote(note, updated, version);
        note.attachments = updated.attachments;
        note.updatedAt = updated.updatedAt;
        const added = note.attachments.filter(attachment => !previousIds.has(attachment.id) && noteMedia.canEmbed(attachment));
        this.updateInlineMedia(note, added, position);
        if (this.opened === note) this.renderMedia();
        this.cleanupNotice(result);
        this.run(() => this.refreshList());
      } finally {
        note.mediaBusy = false;
        if (this.opened !== note) this.releaseNote(note);
        else if (!note.saveError) this.save(note);
        this.notifyDirty();
        this.renderStatus();
      }
    }

    paste(event) {
      const note = this.opened;
      if (!note || event.defaultPrevented || !event.clipboardData || this['note-ai-inline'].contains(event.target)) return;
      const files = pastedFiles(event.clipboardData);
      const plain = event.clipboardData.getData('text/plain');
      const inBody = this['note-body'].contains(event.target);
      if (inBody && event.clipboardData.types.includes('text/html')) {
        const html = event.clipboardData.getData('text/html');
        const outline = window.InMomentNoteOutline.readClipboard(document, html);
        if (outline) {
          event.preventDefault();
          this.pasteOutline(note, outline);
          return;
        }
        let rich;
        try { rich = noteDocument.pastedImages(html, MAX_CLIPBOARD_BYTES); }
        catch (error) { event.preventDefault(); this.toast(error.message, true); return; }
        if (rich) {
          event.preventDefault();
          if (note.mediaBusy) { this.toast('正在处理附件，请稍后再粘贴。'); return; }
          if (note.deleting || note.composing) return;
          const body = this['note-body'];
          const selection = noteDocument.selectionOf(body);
          const position = this.attachmentPosition(selection?.range);
          position.range = selection?.range || position.range;
          position.rich = rich.document;
          position.version = note.version;
          const fragment = noteDocument.fragment(rich.document, () => null);
          const length = noteDocument.value(fragment).length;
          if (note.body.length - (selection?.text.length || 0) + length > noteDocument.maxLength) {
            this.toast('笔记正文最多 100 万字。', true);
            return;
          }
          this.run(() => this.mediaAction(note, identity => this.invoke('notes:attach', { ...identity, files: rich.images, inlineOnly: true }), position));
          return;
        }
      }
      if (!files.length && (plain || !event.isTrusted)) {
        if (inBody) {
          event.preventDefault();
          if (plain && !note.deleting) document.execCommand('insertText', false, plain);
        }
        return;
      }
      event.preventDefault();
      if (note.mediaBusy) { this.toast('正在处理附件，请稍后再粘贴。'); return; }
      const position = this.attachmentPosition();
      this.run(() => this.mediaAction(note, async identity => {
        if (event.isTrusted) {
          const fromExplorer = await this.invoke('notes:pasteFiles', identity);
          if (fromExplorer) return fromExplorer;
        }
        return files.length ? this.attachFiles(identity, files, { inlineOnly: inBody }) : null;
      }, position));
    }

    pasteOutline(note, outline) {
      const body = this['note-body'];
      if (note.deleting || note.composing || !body.isContentEditable) return;
      const selection = noteDocument.selectionOf(body);
      if (note.body.length - (selection?.text.length || 0) + noteDocument.value(outline).length + 2 > noteDocument.maxLength) {
        this.toast('笔记正文最多 100 万字。', true);
        return;
      }
      const range = selection?.range || noteDocument.rangeAt(body, note.body.length);
      this.beginHistory(body);
      noteDocument.insertFragment(body, range, outline);
      noteDocument.restore(body, range);
      this.input(false, 'insertFromPaste');
    }

    async attachFiles(identity, files, { inlineOnly = false } = {}) {
      if (files.length > 24 || files.reduce((bytes, file) => bytes + file.size, 0) > MAX_CLIPBOARD_BYTES) {
        throw new Error('粘贴或拖入的数据过大，请使用“插入文件”选择本机文件。');
      }
      const payload = [];
      for (const file of files) {
        const extension = CLIPBOARD_EXTENSIONS.get(file.type);
        const name = file.name.includes('.') || !extension ? file.name : (file.name || '粘贴的附件') + '.' + extension;
        payload.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) });
      }
      return this.invoke('notes:attach', { ...identity, files: payload, inlineOnly });
    }

    async removeAttachment(note, attachmentId, anchor, kind) {
      if (this.opened !== note || note.mediaBusy || note.deleting || note.deleted) return;
      const ownedFocus = document.activeElement === anchor;
      try {
        if (kind === 'summary') await this.removeSummaryAttachment(note, attachmentId);
        else {
          this.pauseMedia();
          await this.changeMedia('notes:remove', { attachmentId }, note);
        }
      } finally {
        if (ownedFocus && this.opened === note && this.visible && this.root.dataset.noteOpen === 'true' && document.activeElement === document.body) {
          (anchor.isConnected ? anchor : this['note-attach']).focus({ preventScroll: true });
        }
      }
    }

    async removeSummaryAttachment(note, attachmentId) {
      const summary = this.cache.get(attachmentId);
      if (note.summaryBusy || summary?.deleting) return;
      note.mediaBusy = true;
      if (summary) summary.deleting = true;
      this.renderStatus();
      try {
        await summary?.saving;
        const result = await this.invoke('notes:remove', { id: note.id, attachmentId, kind: 'summary' });
        if (summary) this.removeFromCache(summary);
        if (note.deleted) return;
        note.summaries = result.note.summaries;
        note.updatedAt = Math.max(note.updatedAt, result.note.updatedAt);
        if (this.opened === note) this.renderSummaries(note);
        this.cleanupNotice(result);
        this.run(() => this.refreshList());
      } finally {
        note.mediaBusy = false;
        if (summary) {
          summary.deleting = false;
          this.save(summary);
        }
        this.renderStatus();
      }
    }

    attachmentRemoveButton(note, attachmentId, title, kind) {
      const remove = element('button', 'icon-button ui-cancel note-remove');
      if (kind === 'summary') remove.classList.add('note-summary-remove');
      remove.dataset.uiIcon = 'close';
      remove.dataset.attachmentId = attachmentId;
      remove.title = '移除 ' + title;
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => this.run(() => this.removeAttachment(note, attachmentId, remove, kind)));
      return remove;
    }

    mediaElement(note, attachment, layout) {
      return noteMedia.create(attachment, {
        remove: (asset, button) => this.run(() => this.removeAttachment(note, asset.id, button)),
        reveal: asset => this.run(() => this.invoke('notes:reveal', { id: note.id, attachmentId: asset.id })),
        preview: (asset, media, button) => this.openImagePreview(note, asset, media, button),
      }, layout);
    }

    openImagePreview(note, image, media, opener) {
      if (this.opened !== note || note.deleting || note.composing || note.mediaBusy || !this.visible) return;
      const source = !media;
      const id = source ? note.id.slice('record:'.length) : note.id;
      const identity = { id, attachmentId: image.id };
      window.InMomentNoteImageViewer.open({
        url: image.url, name: image.name, opener, owner: this, animated: /\.gif$/iu.test(image.name),
        invoke: (method, params) => this.invoke(method, params),
        readImage: () => this.invoke(source ? 'image:readRecord' : 'notes:readPicture', identity),
        revealImage: () => this.invoke(source ? 'records:revealScreenshot' : 'notes:reveal', identity),
        insertText: source ? undefined : text => this.insertPictureText(note, media, text),
        insertOutline: source ? undefined : outline => this.insertPictureText(note, media, outline),
        replaceImage: source ? undefined : bytes => this.replacePicture(note, media, bytes),
        onDirtyChange: () => this.notifyDirty(),
      });
    }

    assertPictureTarget(note, media) {
      const body = this['note-body'];
      if (this.opened !== note || note.deleted || note.deleting || note.composing || !this.visible || !body.contains(media)) {
        throw new Error('原图片已变更，请重新打开大图。');
      }
      return body;
    }

    insertPictureText(note, media, value) {
      const body = this.assertPictureTarget(note, media);
      if (note.mediaBusy) throw new Error('正在处理附件，请稍后再试。');
      const plain = typeof value === 'string';
      const outline = plain ? null : window.InMomentNoteOutline.render(document, value);
      const text = plain ? value : noteDocument.value(outline);
      if (!text.trim() || note.body.length + text.length + 4 > noteDocument.maxLength) {
        throw new Error('没有可插入的文字，或笔记正文已达到长度上限。');
      }
      this.beginHistory(body);
      const caret = plain ? noteMedia.insertTextBelow(body, media, text) : noteMedia.insertOutlineBelow(body, media, outline);
      this.input(false, 'insertPictureText');
      // Focus is returned after the modal releases the editor.
      const restore = () => {
        if (this.opened === note) noteDocument.restore(body, caret);
      };
      requestAnimationFrame(restore);
      return body;
    }

    async replacePicture(note, media, bytes) {
      const body = this.assertPictureTarget(note, media);
      if (note.mediaBusy) throw new Error('正在处理附件，请稍后再试。');
      await this.ensureSaved([note.id]);
      this.assertPictureTarget(note, media);
      if (note.mediaBusy) throw new Error('正在处理附件，请稍后再试。');
      const before = noteHistory.snapshot(note, null);
      note.mediaBusy = true;
      this.renderStatus();
      try {
        const displayWidth = Math.max(48, Math.min(1600, Math.round(media.getBoundingClientRect().width)));
        const { note: result, replacementId } = await this.invoke('notes:replacePicture', {
          id: note.id, attachmentId: media.dataset.noteMedia, bytes,
          updatedAt: note.updatedAt, legacyDocument: note.document, displayWidth,
        });
        note.attachments = result.attachments;
        note.updatedAt = result.updatedAt;
        note.document = result.document;
        note.documentSignature = JSON.stringify(result.document);
        note.savedVersion = ++note.version;
        noteHistory.record(note, before, noteHistory.snapshot(note, null), 'replacePicture');
        if (this.opened !== note || !this.visible) return;
        const attachment = note.attachments.find(asset => asset.id === replacementId);
        const replacement = this.mediaElement(note, attachment, {
          width: media.dataset.noteMediaWidth === undefined ? displayWidth : Number(media.dataset.noteMediaWidth),
          align: media.dataset.noteMediaAlign,
        });
        if (body.contains(media)) media.replaceWith(replacement);
        else this.renderDocument(note, body);
        this.renderMedia();
        this.toast('已替换图片，可用 Ctrl+Z 撤销。');
        return body.querySelector(`[data-note-media="${replacementId}"] .note-inline-media-preview`) || body;
      } finally {
        note.mediaBusy = false;
        this.notifyDirty();
        this.renderStatus();
      }
    }

    embeddedMediaIds(body) {
      return [...body.querySelectorAll('[data-note-media]')].map(media => media.dataset.noteMedia).join(' ');
    }

    renderDocument(note, body, state = note) {
      const assets = new Map(note.attachments.filter(noteMedia.canEmbed).map(attachment => [attachment.id, attachment]));
      noteDocument.render(body, state.document, state.body, (id, layout) => {
        const attachment = assets.get(id);
        return attachment ? this.mediaElement(note, attachment, layout) : null;
      });
      if (!state.document) body.append(...[...assets.values()].map(attachment => this.mediaElement(note, attachment)));
    }

    loadDocument(note, body = this['note-body']) {
      this.renderDocument(note, body);
      const snapshot = noteDocument.read(body);
      note.document = snapshot.document;
      note.documentSignature = JSON.stringify(snapshot.document);
    }

    updateInlineMedia(note, added, position) {
      const active = this.opened === note;
      const body = active ? this['note-body'] : document.createElement('div');
      const before = noteHistory.snapshot(note, active ? this.editorSelection() : null);
      if (!active) {
        const assets = new Set(note.attachments.map(attachment => attachment.id));
        noteDocument.render(body, note.document, note.body, id => {
          if (!assets.has(id)) return null;
          const marker = element('span');
          marker.dataset.noteMedia = id;
          marker.contentEditable = 'false';
          return marker;
        });
      }
      const assets = new Set(note.attachments.map(attachment => attachment.id));
      for (const media of body.querySelectorAll('[data-note-media]')) {
        if (!assets.has(media.dataset.noteMedia)) media.remove();
      }
      if (added.length && position?.rich) {
        const fragment = noteDocument.fragment(position.rich, (index, layout) => {
          const attachment = added[Number(index)];
          return attachment ? this.mediaElement(note, attachment, layout) : null;
        });
        const live = noteDocument.rangeInside(body, position.range);
        const range = live ? position.range.cloneRange() : noteDocument.rangeAt(body, position.offset ?? noteDocument.value(body).length);
        if (note.version !== position.version) range.collapse(false);
        const inserted = noteDocument.insertFragment(body, range, fragment);
        if (inserted && active && this.visible && document.activeElement === body) {
          noteDocument.restore(body, range);
        }
      } else if (added.length) {
        const live = position && noteDocument.rangeInside(body, position.range);
        const range = live ? position.range : Number.isInteger(position?.offset) ? noteDocument.rangeAt(body, position.offset) : null;
        const focused = document.activeElement;
        noteMedia.insert(body, added.map(attachment => this.mediaElement(note, attachment)), range, {
          focus: active && this.visible && (body.contains(focused) || focused === this['note-attach']),
        });
      }
      if (active) {
        note.beforeEdit = before;
        this.input(note.composing, position?.rich ? 'paste' : undefined);
      }
      else {
        const snapshot = noteDocument.read(body);
        const signature = JSON.stringify(snapshot.document);
        if (signature !== note.documentSignature) Object.assign(note, { ...snapshot, documentSignature: signature, version: note.version + 1 });
        noteHistory.record(note, before, noteHistory.snapshot(note, null), position?.rich ? 'paste' : undefined);
      }
    }

    renderMedia() {
      const note = this.opened;
      this.embeddedMedia = this.embeddedMediaIds(this['note-body']);
      const embedded = new Set(this.embeddedMedia.split(' '));
      const fragment = document.createDocumentFragment();
      for (const attachment of note.attachments) {
        if (embedded.has(attachment.id) || attachment.inlineOnly) continue;
        const entry = element('div', 'note-attachment');
        const row = element('div', 'note-file-row');
        const reveal = element('button', 'button quiet compact note-file-link', attachment.name);
        reveal.dataset.uiIcon = 'folder';
        reveal.title = '在文件夹中查看 ' + attachment.name;
        reveal.setAttribute('aria-label', reveal.title);
        reveal.addEventListener('click', () => this.run(() => this.invoke('notes:reveal', { id: note.id, attachmentId: attachment.id })));
        row.append(reveal, element('span', 'note-file-size', fileSize(attachment.size)));
        if (noteMedia.canEmbed(attachment)) {
          const insert = element('button', 'button quiet compact', '插入正文');
          insert.addEventListener('click', () => {
            if (this.opened !== note || note.deleting || note.mediaBusy) return;
            this.updateInlineMedia(note, [attachment], this.attachmentPosition());
          });
          row.append(insert);
        }
        entry.append(row, this.attachmentRemoveButton(note, attachment.id, attachment.name));
        fragment.append(entry);
      }
      this['note-attachments'].replaceChildren(fragment);
      this.updateAttachmentsVisibility(note);
    }

    renderSummaries(note) {
      const host = this['note-summaries'];
      const active = document.activeElement;
      const focusKey = active?.classList.contains('note-summary-remove') ? 'attachmentId' : 'summaryId';
      const focused = host.contains(active) && active.dataset[focusKey];
      host.replaceChildren(...(note.summaries || []).map(summary => {
        const entry = element('div', 'note-summary-attachment');
        const title = summary.title.trim() || '总结笔记';
        const link = element('button', 'button quiet compact note-file-link note-summary-link');
        link.dataset.summaryId = summary.id;
        link.dataset.uiIcon = 'transcript';
        link.append(element('span', 'note-summary-title', title));
        link.addEventListener('click', () => {
          if (!note.deleting && !note.mediaBusy) this.run(() => this.open(summary.id));
        });
        entry.append(link, this.attachmentRemoveButton(note, summary.id, title, 'summary'));
        return entry;
      }));
      this.updateAttachmentsVisibility(note);
      if (focused) [...host.querySelectorAll('button')].find(button => button.dataset[focusKey] === focused)?.focus({ preventScroll: true });
    }

    updateAttachmentsVisibility(note) {
      this['note-attachments-section'].classList.toggle('hidden', !this['note-attachments'].childElementCount && !note.summaries?.length);
    }

    renderLinks() {
      const links = bodyLinks(this.opened.body);
      const host = this['note-links'];
      if (links.join('\n') === this.linksSignature) return;
      this.linksSignature = links.join('\n');
      host.replaceChildren(...links.map(url => {
        const item = element('li');
        const link = element('a', 'note-link', url);
        link.href = url;
        link.addEventListener('click', event => {
          event.preventDefault();
          this.run(() => this.invoke('notes:openLink', { url }));
        });
        item.append(link);
        return item;
      }));
      this['note-links-section'].classList.toggle('hidden', !links.length);
    }
  }

  window.InMomentNotesView = NotesView;
})();
