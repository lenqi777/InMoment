'use strict';

(() => {
  function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function paths(topics) {
    const byId = new Map(topics.map(topic => [topic.id, topic]));
    const labels = new Map();
    for (const topic of topics) {
      const parts = [topic.name];
      const seen = new Set([topic.id]);
      for (let parent = byId.get(topic.parentId); parent && !seen.has(parent.id); parent = byId.get(parent.parentId)) {
        seen.add(parent.id);
        parts.unshift(parent.name);
      }
      labels.set(topic.id, parts.join(' / '));
    }
    return labels;
  }

  const canonical = text => String(text || '').normalize('NFKC').toLocaleLowerCase().trim();
  const specials = [{ id: 'all', name: '全部笔记' }, { id: 'uncategorized', name: '未分类' }];
  const rootChoice = { id: 'root-location', name: '分组（顶层）' };

  class TopicTree {
    constructor({ navigation, invoke, toast, refresh, select, editName, beforeRead, onDeleted }) {
      Object.assign(this, { navigation, invoke, toast, refresh, select, editName, beforeRead, onDeleted });
      this.master = document.querySelector('#group-select-all');
      this.mode = document.querySelector('#group-select-mode');
      this.count = document.querySelector('#group-selection-count');
      this.actions = document.querySelector('#group-selection-actions');
      this.search = document.querySelector('#group-search');
      this.controls = document.querySelector('#notebook-group-controls');
      this.list = element('div', 'notebook-group-list');
      this.expanded = new Set();
      this.selected = new Set();
      this.clipboard = [];
      this.groups = new Map();
      this.selecting = false;
      this.busy = false;
      this.search.addEventListener('input', () => this.render());
      this.mode.addEventListener('click', () => this.changeMode(!this.selecting));
      this.master.addEventListener('change', () => {
        this.selecting = true;
        for (const id of this.selectableIds()) {
          if (this.master.checked) this.selected.add(id); else this.selected.delete(id);
        }
        this.render();
      });
      this.actions.addEventListener('click', () => this.run(() => this.batchMenu(this.actions)));
    }

    show(topics, counts, active) {
      this.visible = true;
      this.controls.classList.remove('hidden');
      const fingerprint = JSON.stringify([topics, counts, active]);
      if (this.fingerprint === fingerprint) return;
      this.fingerprint = fingerprint;
      this.groups = new Map(topics.map(group => [group.id, group]));
      this.labels = paths(topics);
      this.counts = counts;
      if (this.active !== active) this.reveal(active);
      this.active = active;
      for (const id of this.selected) if (!this.groups.has(id)) this.selected.delete(id);
      for (const id of this.expanded) if (!this.groups.has(id)) this.expanded.delete(id);
      this.clipboard = this.clipboard.filter(id => this.groups.has(id));
      this.render();
    }

    hide() {
      this.visible = false;
      this.controls.classList.add('hidden');
      this.selecting = false;
      this.selected.clear();
      this.fingerprint = null;
    }

    reveal(id) {
      const seen = new Set([id]);
      for (let parent = this.groups.get(id)?.parentId; parent && !seen.has(parent); parent = this.groups.get(parent)?.parentId) {
        seen.add(parent);
        this.expanded.add(parent);
      }
    }

    selectableIds() {
      const query = canonical(this.search.value);
      return [...this.groups.values()].filter(group => canonical(this.labels.get(group.id)).includes(query)).map(group => group.id);
    }

    rows() {
      const query = canonical(this.search.value);
      const visible = new Set(this.selectableIds());
      for (const id of visible) {
        const parent = this.groups.get(id)?.parentId;
        if (parent) visible.add(parent);
      }
      const children = new Map();
      for (const group of this.groups.values()) {
        if (!visible.has(group.id)) continue;
        const parent = this.groups.has(group.parentId) ? group.parentId : null;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(group);
      }
      const matchingSpecials = specials.filter(group => canonical(group.name).includes(query));
      const rows = matchingSpecials.filter(group => group.id === 'all');
      const stack = [...(children.get(null) || [])].reverse().map(group => ({ group, depth: 0 }));
      while (stack.length) {
        const { group, depth } = stack.pop();
        const nested = children.get(group.id) || [];
        const expanded = Boolean(query) || this.expanded.has(group.id);
        rows.push({ ...group, depth, hasChildren: Boolean(nested.length), expanded, searching: Boolean(query) });
        if (expanded) for (let index = nested.length - 1; index >= 0; index--) stack.push({ group: nested[index], depth: depth + 1 });
      }
      return [...rows, ...matchingSpecials.filter(group => group.id === 'uncategorized')];
    }

    render() {
      if (!this.visible) return;
      const { navigation } = this;
      const focused = navigation.contains(document.activeElement) ? document.activeElement.dataset.topicTreeFocus : null;
      const scroll = this.list.scrollTop;
      const rows = this.rows();
      const uncategorized = rows.at(-1)?.id === 'uncategorized' ? rows.pop() : null;
      const children = rows.map(group => this.row(group));
      if (!children.length && !uncategorized) children.push(element('p', 'notebook-group-empty', '没有匹配的分组'));
      this.list.replaceChildren(...children);
      navigation.replaceChildren(this.list, ...(uncategorized ? [this.row(uncategorized)] : []));
      this.list.scrollTop = scroll;
      if (focused) {
        const target = Array.from(navigation.querySelectorAll('[data-topic-tree-focus]')).find(node => node.dataset.topicTreeFocus === focused);
        (target || this.search).focus({ preventScroll: true });
      }
      this.renderSelection();
    }

    row(group) {
      const id = group.id;
      const editable = this.groups.has(id);
      const row = element('div', 'topic-tree-row');
      row.dataset.topicTreeRow = id;
      row.style.setProperty('--topic-depth', String(Math.min(group.depth || 0, 5)));
      if (editable && this.selecting) {
        const target = element('label', 'record-selection-checkbox-target topic-tree-check');
        const check = element('input', 'record-selection-master');
        check.type = 'checkbox'; check.checked = this.selected.has(id); check.disabled = this.busy;
        check.dataset.topicTreeFocus = `check:${id}`;
        check.setAttribute('aria-label', '选择分组 ' + this.labels.get(id));
        check.addEventListener('change', () => this.toggleSelected(id));
        target.append(check); row.append(target);
      }
      if (group.hasChildren) {
        const toggle = element('button', 'icon-button topic-tree-toggle');
        toggle.type = 'button'; toggle.dataset.uiIcon = 'chevron'; toggle.dataset.topicTreeFocus = `toggle:${id}`;
        toggle.setAttribute('aria-label', (group.expanded ? '收起' : '展开') + group.name + '的子分组');
        toggle.setAttribute('aria-expanded', String(group.expanded));
        toggle.disabled = group.searching;
        toggle.addEventListener('click', () => {
          if (group.expanded) this.expanded.delete(id); else this.expanded.add(id);
          this.render();
        });
        row.append(toggle);
      }
      const button = element('button', 'primary-group-item');
      button.type = 'button'; button.dataset.uiIcon = 'folder'; button.dataset.libraryGroupId = id; button.dataset.topicTreeFocus = `open:${id}`;
      button.title = group.name;
      if (editable) button.setAttribute('aria-description', this.labels.get(id));
      button.setAttribute('aria-pressed', String(this.selecting && editable ? this.selected.has(id) : id === this.active));
      button.setAttribute('aria-controls', 'notes-list');
      button.append(element('span', 'primary-group-name', group.name), element('span', 'primary-group-count', String(this.counts[id] ?? 0)));
      button.addEventListener('click', () => this.selecting && editable ? this.toggleSelected(id) : this.run(() => this.select(id)));
      if (editable) {
        button.addEventListener('contextmenu', event => { event.preventDefault(); this.run(() => this.groupMenu(button, id)); });
        button.addEventListener('keydown', event => this.keydown(event, button, group));
      } else if (id === 'all') {
        const openRootMenu = event => {
          event.preventDefault();
          this.run(() => this.rootMenu(button));
        };
        button.setAttribute('aria-description', '右键或按 Shift+F10 打开分组操作。');
        button.setAttribute('aria-haspopup', 'menu');
        button.addEventListener('contextmenu', openRootMenu);
        button.addEventListener('keydown', event => {
          if (event.isComposing) return;
          if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) openRootMenu(event);
        });
      }
      row.append(button);
      return row;
    }

    keydown(event, button, group) {
      if (this.busy || event.isComposing) return;
      const id = group.id;
      if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
        event.preventDefault(); this.run(() => this.groupMenu(button, id));
      } else if (event.key === 'F2') {
        event.preventDefault(); this.editName('rename', group);
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c') {
        event.preventDefault(); this.copy(this.selecting && this.selected.has(id) ? [...this.selected] : [id]);
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v' && this.clipboard.length) {
        event.preventDefault(); this.run(() => this.paste(id));
      } else if (!event.ctrlKey && !event.metaKey && group.hasChildren && !group.searching && ['ArrowRight', 'ArrowLeft'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'ArrowRight') this.expanded.add(id); else this.expanded.delete(id);
        this.render();
      }
    }

    changeMode(active) {
      this.selecting = active;
      if (!active) this.selected.clear();
      this.render();
    }

    toggleSelected(id) {
      if (this.busy) return;
      if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
      this.render();
    }

    renderSelection() {
      const ids = this.selectableIds();
      const visibleChecked = ids.filter(id => this.selected.has(id)).length;
      this.master.checked = Boolean(ids.length && visibleChecked === ids.length);
      this.master.indeterminate = visibleChecked > 0 && visibleChecked < ids.length;
      this.master.disabled = !ids.length || this.busy;
      this.mode.textContent = this.selecting ? '完成' : '多选';
      this.mode.setAttribute('aria-pressed', String(this.selecting));
      this.mode.disabled = (!ids.length && !this.selecting) || this.busy;
      this.count.textContent = '已选 ' + this.selected.size;
      this.count.classList.toggle('hidden', !this.selecting);
      this.actions.classList.toggle('hidden', !this.selecting);
      this.actions.disabled = !this.selected.size || this.busy;
    }

    run(action) {
      if (this.busy || !this.visible) return;
      return Promise.resolve().then(action).catch(error => this.toast(error.message || '分组操作未完成。', true));
    }

    async mutate(method, params) {
      if (this.busy) return;
      this.busy = true; this.renderSelection();
      try {
        const result = await this.invoke(method, params);
        if (method === 'topics:deleteWithNotes' && !result.cancelled) this.onDeleted(result);
        await this.refresh();
        return result;
      } finally {
        this.busy = false;
        this.render();
      }
    }

    copy(ids) {
      if (this.busy) return;
      this.clipboard = ids.filter(id => this.groups.has(id));
      if (this.clipboard.length) this.toast('已复制 ' + this.clipboard.length + ' 个分组。可在目标分组粘贴。');
    }

    async paste(parentId) {
      if (!this.clipboard.length) return;
      await this.beforeRead();
      const result = await this.mutate('topics:copyTree', { topicIds: this.clipboard, parentId });
      if (!result?.groupIds?.length) return;
      this.changeMode(false);
      if (this.visible) await this.select(result.groupIds[0]);
      this.toast('分组已粘贴。');
    }

    async chooseMove(anchor, id) {
      const current = this.groups.get(id);
      const valid = [...this.groups.values()].filter(group => {
        for (let candidate = group; candidate; candidate = this.groups.get(candidate.parentId)) if (candidate.id === id) return false;
        return true;
      });
      const labels = valid.map(group => ({ ...group, name: this.labels.get(group.id) }));
      const target = await window.InMomentGroupPicker.open({ anchor, title: '移动分组到', topics: [rootChoice, ...labels], disabledIds: [current.parentId || rootChoice.id] });
      if (!target) return;
      const result = await this.mutate('topics:move', { id, parentId: target.id === rootChoice.id ? null : target.id });
      if (result) { this.reveal(id); this.render(); this.toast('分组已移动。'); }
    }

    async remove(anchor, ids, withNotes) {
      const one = ids.length === 1;
      const name = one ? '“' + this.groups.get(ids[0]).name + '”' : ids.length + ' 个分组';
      const confirmLabel = withNotes ? '删除分组和内容' : '删除分组';
      const ok = await window.InMomentConfirm.open({ anchor, title: confirmLabel + '？', message: '删除' + name + '。',
        detail: withNotes ? '子分组及其中独有的笔记会一起删除。其他分组已有的笔记保留。' : '笔记与子分组移到上一级。顶层分组中的笔记移到「未分类」。',
        confirmLabel, danger: true });
      if (!ok) return;
      await this.beforeRead();
      const result = await this.mutate(withNotes ? 'topics:deleteWithNotes' : 'topics:deleteMany', { topicIds: ids });
      if (!result || result.cancelled) return;
      if (result.partial) { this.toast('有笔记未完成删除，分组仍保留。', true); return; }
      this.changeMode(false);
      if (this.visible && !anchor.isConnected) (this.navigation.querySelector('[aria-pressed=true]') || this.search).focus({ preventScroll: true });
      this.toast('分组已删除。');
    }

    async merge(anchor, ids) {
      const topics = ids.map(id => ({ id, name: this.labels.get(id) }));
      const target = await window.InMomentGroupPicker.open({ anchor, title: '选择合并后保留的分组', topics });
      if (!target) return;
      await this.beforeRead();
      await this.mutate('topics:mergeMany', { topicIds: ids, targetId: target.id });
      this.changeMode(false);
      if (this.visible) await this.select(target.id);
      this.toast('分组已合并。');
    }

    async rootMenu(anchor) {
      const choice = await window.InMomentMenus.open({ anchor, title: '分组操作', items: [
        { id: 'paste', label: '粘贴分组', disabled: !this.clipboard.length },
        { id: 'select', label: this.selecting ? '退出多选' : '多选分组', disabled: !this.groups.size },
      ] });
      if (choice === 'paste') return this.paste(null);
      if (choice === 'select') this.changeMode(!this.selecting);
    }

    async export(ids) {
      await this.beforeRead();
      const result = await this.invoke('notes:export', { groupIds: ids });
      if (result && !result.cancelled) this.toast('分组已导出。');
    }

    async groupMenu(anchor, id) {
      if (this.selecting && this.selected.has(id)) return this.batchMenu(anchor);
      const group = this.groups.get(id);
      const choice = await window.InMomentMenus.open({ anchor, title: group.name, items: [
        { id: 'rename', label: '重命名', icon: 'edit' },
        { id: 'child', label: '创建子分组', icon: 'folder-plus' },
        { id: 'move', label: '移动分组', icon: 'folder-in' },
        { id: 'copy', label: '复制分组' },
        { id: 'paste', label: '粘贴分组', disabled: !this.clipboard.length },
        { id: 'export', label: '导出分组…' },
        { id: 'select', label: '多选分组' },
        { id: 'delete', label: '删除分组', danger: true },
        { id: 'delete-content', label: '删除分组和内容', danger: true },
      ] });
      if (choice === 'rename' || choice === 'child') return this.editName(choice, group);
      if (choice === 'move') return this.chooseMove(anchor, id);
      if (choice === 'copy') return this.copy([id]);
      if (choice === 'paste') return this.paste(id);
      if (choice === 'export') return this.export([id]);
      if (choice === 'select') { this.selected.add(id); this.changeMode(true); }
      if (choice === 'delete' || choice === 'delete-content') return this.remove(anchor, [id], choice === 'delete-content');
    }

    async batchMenu(anchor) {
      const ids = [...this.selected];
      if (!ids.length) return;
      const choice = await window.InMomentMenus.open({ anchor, title: '已选 ' + ids.length + ' 个分组', items: [
        { id: 'merge', label: '合并分组', icon: 'merge', disabled: ids.length < 2 },
        { id: 'copy', label: '批量复制分组' },
        { id: 'export', label: '导出分组…' },
        { id: 'delete', label: '批量删除分组', danger: true },
        { id: 'delete-content', label: '批量删除分组和内容', danger: true },
      ] });
      if (choice === 'merge') return this.merge(anchor, ids);
      if (choice === 'copy') return this.copy(ids);
      if (choice === 'export') return this.export(ids);
      if (choice === 'delete' || choice === 'delete-content') return this.remove(anchor, ids, choice === 'delete-content');
    }
  }

  TopicTree.pathLabels = topics => {
    const labels = paths(topics);
    return topics.map(topic => ({ ...topic, name: labels.get(topic.id) }));
  };
  window.InMomentTopicTree = TopicTree;
})();
