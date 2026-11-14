'use strict';

(() => {
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    if (tag === 'button') node.type = 'button';
    return node;
  }

  class NotesGroupingView {
    constructor(notes) {
      this.notes = notes;
      this.trigger = notes.root.querySelector('#organize-notes');
      this.progress = notes.root.querySelector('#notes-grouping-progress');
      this.cancelButton = notes.root.querySelector('#cancel-notes-grouping');
      this.dialog = document.querySelector('#notes-grouping-dialog');
      this.list = this.dialog.querySelector('#notes-grouping-list');
      this.status = this.dialog.querySelector('#notes-grouping-status');
      this.applyButton = this.dialog.querySelector('#apply-notes-grouping');
      this.closeButton = this.dialog.querySelector('#close-notes-grouping');
      this.trigger.addEventListener('click', () => notes.run(() => this.run()));
      this.cancelButton.addEventListener('click', () => notes.run(() => this.cancel()));
      this.applyButton.addEventListener('click', () => notes.run(() => this.apply()));
      this.closeButton.addEventListener('click', () => this.dialog.close());
      this.dialog.addEventListener('cancel', event => { if (this.applying) event.preventDefault(); });
      this.dialog.addEventListener('close', () => {
        if (this.dialog.open) return;
        const anchor = this.review?.anchor;
        this.review = null;
        this.list.replaceChildren();
        if (notes.visible && !(notes.narrow && notes.root.dataset.noteOpen === 'true')) {
          (anchor?.isConnected && !anchor.disabled ? anchor : notes['new-note']).focus({ preventScroll: true });
        }
      });
      this.update();
    }

    update() {
      const uncategorized = this.notes.topicId === 'uncategorized';
      this.trigger.classList.toggle('hidden', !uncategorized);
      this.trigger.disabled = Boolean(this.request) || !this.notes.groupCounts?.uncategorized;
      const show = Boolean(this.request && !this.request.cancelled);
      if (window.InMomentMotion?.show) window.InMomentMotion.show(this.progress, show);
      else this.progress.classList.toggle('hidden', !show);
    }

    hide() {
      if (this.dialog.open && !this.applying) this.dialog.close();
      if (this.request) this.notes.run(() => this.cancel());
    }

    async cancel() {
      const request = this.request;
      if (!request || request.cancelled) return;
      request.cancelled = true;
      this.update();
      if (request.sent) await this.notes.invoke('library:cancel', { kind: 'noteGrouping' });
    }

    async run({ noteIds, anchor = this.trigger } = {}) {
      if (this.request) return;
      const { notes } = this;
      const classification = !noteIds;
      if (classification && notes.topicId !== 'uncategorized') return;
      const request = { cancelled: false, sent: false };
      this.request = request;
      this.update();
      try {
        const ids = noteIds || [...notes.cache.values()].filter(note => !note.provisional && !note.topicIds?.length).map(note => note.id);
        await notes.ensureSaved(ids);
        if (request.cancelled || !notes.visible) return;
        request.sent = true;
        const result = await notes.invoke('notes:suggestGroups', classification ? { uncategorized: true } : { noteIds });
        if (request.cancelled || result.cancelled || !notes.visible) return;
        const assignments = new Map();
        for (const group of result.groups) for (const note of group.notes) assignments.set(note.id, group.key);
        const entries = [...result.groups.flatMap(group => group.notes), ...result.unassigned];
        const choices = new Map(result.groups.map(group => [group.key, group]));
        const topics = result.topics || window.InMomentTopicTree?.pathLabels?.(notes.topics) || notes.topics;
        for (const topic of topics) {
          const key = 'topic:' + topic.id;
          if (!choices.has(key)) choices.set(key, { key, name: topic.name, existing: true });
        }
        this.review = { runId: result.runId, entries, choices, assignments, anchor };
        const omitted = result.omitted ? `另有 ${result.omitted} 条空白笔记未参与。` : '';
        this.status.textContent = result.groups.length ? `采用后会为所选笔记添加分组。${omitted}` : `暂无分组建议。${omitted}`;
        this.render();
        this.dialog.showModal();
        this.closeButton.focus();
      } finally {
        this.request = null;
        this.update();
      }
    }

    render(focusId) {
      const { entries, choices, assignments } = this.review;
      const sections = new Map();
      for (const note of entries) {
        const key = assignments.get(note.id) || '';
        if (!sections.has(key)) sections.set(key, []);
        sections.get(key).push(note);
      }
      this.list.replaceChildren();
      let focus;
      const keys = [...choices.keys(), ''].filter(key => sections.has(key));
      for (const key of keys) {
        const choice = choices.get(key);
        const groupNotes = sections.get(key);
        const section = element('section', 'batch-result-group');
        const heading = element('h3', 'batch-group-heading');
        if (choice) {
          const icon = element('span');
          icon.dataset.uiIcon = choice.existing ? 'folder-in' : 'folder-plus';
          icon.setAttribute('aria-hidden', 'true');
          heading.append(icon);
        }
        heading.append(element('span', 'batch-group-name', choice?.name || '暂不分组'), element('span', 'batch-group-count', `${groupNotes.length} 条`));
        section.append(heading);
        if (choice?.reason) heading.title = choice.reason;
        const rows = element('div', 'batch-group-records');
        for (const note of groupNotes) {
          const row = element('article', 'batch-result-item');
          const copy = element('div', 'batch-record-copy');
          const title = element('h4', 'batch-result-heading', note.title);
          title.title = note.title;
          copy.append(title);
          if (!key && note.reason) copy.append(element('p', 'batch-summary', note.reason));
          const adjust = element('button', 'icon-button');
          adjust.dataset.uiIcon = 'more';
          adjust.title = '调整分组';
          adjust.setAttribute('aria-label', `调整“${note.title}”的分组`);
          adjust.disabled = Boolean(this.applying) || !choices.size;
          adjust.addEventListener('click', () => this.notes.run(() => this.adjust(note.id, adjust)));
          row.append(copy, adjust);
          rows.append(row);
          if (focusId === note.id) focus = adjust;
        }
        section.append(rows);
        this.list.append(section);
      }
      this.applyButton.disabled = Boolean(this.applying || this.adjusting) || !assignments.size;
      this.closeButton.disabled = Boolean(this.applying);
      focus?.focus({ preventScroll: true });
    }

    async adjust(id, anchor) {
      if (this.adjusting || this.applying) return;
      const review = this.review;
      const items = [{ id: 'change', label: '修改分组' }];
      if (review.assignments.has(id)) items.push({ id: 'exclude', label: '暂不分组' });
      this.adjusting = true;
      this.applyButton.disabled = true;
      let changed = false;
      try {
        const action = await window.InMomentMenus.open({ anchor, items });
        if (!action || this.review !== review) return;
        if (action === 'exclude') review.assignments.delete(id);
        else {
          const choices = [...review.choices.values()];
          const entries = existing => choices.filter(choice => choice.existing === existing).map(choice => ({ id: choice.key, name: choice.name }));
          const selected = review.assignments.get(id);
          const result = await window.InMomentGroupPicker.open({ anchor, topics: entries(true), choices: entries(false), selectedIds: selected ? [selected] : [], title: '修改分组' });
          if (!result || this.review !== review) return;
          review.assignments.set(id, result.id);
        }
        changed = true;
      } finally {
        this.adjusting = false;
        if (this.review === review) {
          if (changed) this.render(id);
          else this.applyButton.disabled = !review.assignments.size;
        }
      }
    }

    async apply() {
      if (this.adjusting || this.applying || !this.review?.assignments.size) return;
      this.applying = true;
      this.render();
      try {
        const { runId, assignments } = this.review;
        const result = await this.notes.invoke('notes:applyGroups', { runId, assignments: [...assignments].map(([id, key]) => ({ id, key })) });
        this.dialog.close();
        this.notes.toast(`已为 ${result.applied} 条笔记添加分组。${result.skipped ? `另有 ${result.skipped} 条笔记已变化，请重新整理。` : ''}`, !result.applied);
      } catch (error) {
        this.status.textContent = error.message || '分组未能保存，请重试。';
      } finally {
        this.applying = false;
        if (this.dialog.open) {
          this.render();
          this.applyButton.focus({ preventScroll: true });
        }
      }
    }
  }

  window.InMomentNotesGrouping = NotesGroupingView;
})();
