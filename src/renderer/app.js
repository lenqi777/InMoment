'use strict';

const $ = (selector) => document.querySelector(selector);
const state = { records: [], searchRecords: [], visibleRecords: null, drafts: [], topics: [], duplicateSuggestions: [], groups: [], settings: {}, capabilities: {}, session: null, view: 'inbox', selectedId: null, selectedDraftId: null, detailDirty: false, query: '', requestId: 0, total: 0, scopeTotal: 0, limit: 20, loading: false, aiSearching: false, duplicateBusy: false, draftBusy: false, settingsDirty: false, settingsRevision: 0, filters: { topicIds: [], uncategorized: true } };
state.detailContext = { view: 'inbox', kind: 'library' }; state.activeGroupId = null; state.organizationTab = 'groups'; state.navigationVersion = 0;
state.libraryGroupId = 'uncategorized'; state.libraryMode = 'home'; state.homeScroll = {}; state.recordProjection = null; state.batchBusy = false; state.batchRunId = null; state.batchSnapshot = []; state.batchChoices = new Map();
const bridge = window.inmoment;
const dialogs = window.InMomentDialogs;
const deletingRecords = new Set();
const recordSelection = { enabled: false, ids: new Set(), busy: false, busyAction: null, scope: null, expandedId: null };
const recordDeletionLocks = new Map();
const topicManagement = { mode: null, ids: new Set(), busy: false, writing: false, revision: 0 };
let recordSelectionToolbar;
let toastTimer;
let searchTimer;
const screenshotViewer = { recordId: null, source: '', scale: 1, mode: 'fit', loaded: false, opener: null, draft: false };
let mountedAudio = [];
let imageDrag = null;
let lastDirtyState = '';
let settingsSaving = false;
function notifyDirty() { const flags = { recordDirty: Boolean(state.detailDirty || state.draftTopicDirty), settingsDirty: Boolean(state.settingsDirty) }; const serialized = JSON.stringify(flags); if (serialized === lastDirtyState || !bridge?.invoke) return; lastDirtyState = serialized; bridge.invoke('app:setDirty', flags).catch(() => {}); }
function node(tag, className, content) { const element = document.createElement(tag); if (tag === 'button') element.type = 'button'; if (className) element.className = className; if (content !== undefined) element.textContent = String(content); return element; }
function add(parent, ...children) { children.filter(Boolean).forEach((child) => parent.append(child)); return parent; }
function toast(message, error = false) {
  // Keep one persistent, local status rather than interrupting reading with popups.
  const legacy = $('#toast'); legacy.textContent = message; legacy.classList.add('hidden');
  const target = state.view === 'settings' ? $('#settings-result') : state.view === 'drafts' ? $('#draft-error') : state.view === 'duplicates' ? $('#cloud-status') : $('#record-feedback');
  if (target) { target.textContent = message; target.classList.toggle('persistent-error', error); target.classList.remove('hidden'); }
}
async function invoke(method, params = {}) { if (!bridge || typeof bridge.invoke !== 'function') throw new Error('桌面连接尚未就绪，请通过 InMoment 桌面应用打开。'); const result = await bridge.invoke(method, params); if (result && result.ok === false) throw new Error(result.error?.message || result.error || '操作未完成'); return result; }
async function act(button, action) { if (button) button.disabled = true; try { return await action(); } catch (error) { toast(error.message || String(error), true); return null; } finally { if (button?.isConnected) button.disabled = false; } }
function formatDate(value) { const date = new Date(value || Date.now()); return Number.isNaN(date.getTime()) ? '时间未记录' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function duration(ms) { const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }
function audioDuration(ms) { return Number(ms) > 0 && Number(ms) < 1000 ? `${Math.round(Number(ms))} 毫秒` : duration(ms); }
function transcriptText(record) { const transcript = record.transcript || record.transcription || ''; return (Array.isArray(transcript) ? transcript.map((part) => part.text || '').join('\n') : typeof transcript === 'string' ? transcript : transcript.text || '') || record.notes || ''; }
function segmentList(record) { return record.audioSegments || record.segments || record.audio || []; }
function triggerLabel(value) { return ['F8', 'F9', 'F10'].includes(value) ? value : '右键'; }
function contextText(record) { const context = record.context || record.source || {}; return [context.appName || context.processName, context.windowTitle || context.title, context.url].filter(Boolean).join(' · ') || '来源情境未记录'; }
function recordTitle(record) { return record.title || transcriptText(record).split('\n')[0].slice(0, 34) || '一段尚未命名的想法'; }
function findRecord(id) { return state.records.find(record => record.id === id) || (state.recordHeaders || []).find(record => record.id === id) || state.groups.flatMap(group => group.records || []).find(record => record.id === id); }
function showView(view, options = {}) {
  if (view !== state.view) clearRecordSelection();
  if (!options.preserveNavigation) state.navigationVersion += 1;
  if (view !== state.view) stopAudio(); state.view = view;
  document.querySelectorAll('.page-view').forEach(item => item.classList.add('hidden')); $(`#${view}-view`).classList.remove('hidden'); document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  $('#breadcrumb-current').textContent = { inbox: '灵感收件箱', drafts: '未保存记录', settings: '偏好设置', duplicates: '灵感云' }[view];
  if (view === 'inbox' && state.detailContext.view !== view) { document.body.classList?.remove(view === 'duplicates' ? 'group-detail-open' : 'inbox-detail-open'); renderDetailEmpty({ view }); }
  if (view === 'drafts') renderDrafts(); if (view === 'duplicates') window.InMomentCloud?.show({ onSelectRecord: selectCloudRecord }); else window.InMomentCloud?.hide?.();
  updateLibraryLayout();
}
function primaryGroupName() { if (state.aiMode && state.aiResultScope === 'all') return 'AI 查找结果'; return state.libraryGroupId === 'uncategorized' ? '未分类' : state.topics.find(topic => topic.id === state.libraryGroupId)?.name || '筛选结果'; }
function updateLibraryLayout() {
  const detailed = state.view === 'inbox' && state.libraryMode === 'detail'; document.body.classList?.toggle('record-detail-open', detailed); $('#back-to-group-home').classList.toggle('hidden', state.libraryMode !== 'detail');
  const list = $('#record-list'); const host = $(detailed ? '#record-column' : '#record-grid-host'); if (host && list.parentElement !== host) { const focused = within(document.activeElement, list) ? document.activeElement : null; host.append(list); focused?.focus?.({ preventScroll: true }); }
  if (state.view === 'inbox') $('#breadcrumb-current').textContent = primaryGroupName(); else if (state.view === 'duplicates') $('#breadcrumb-current').textContent = '灵感云';
}
function projectionScope() { return JSON.stringify({ groupId: state.libraryGroupId, query: state.query, range: $('#date-range').value, from: $('#date-from').value, to: $('#date-to').value }); }
function projectCurrentRecord(record, reason = '已归类，暂留此处') { if (state.selectedId !== record.id) return; const index = (state.visibleRecords || []).findIndex(item => item.id === record.id); state.recordProjection = { record, scope: projectionScope(), index: Math.max(0, index), reason }; }
function withRecordProjection(records) { const projection = state.recordProjection; if (!projection || projection.scope !== projectionScope()) return records; const index = records.findIndex(item => item.id === projection.record.id); if (index >= 0) return records.map(item => item.id === projection.record.id ? projection.record : item); const result = [...records]; result.splice(Math.min(projection.index, result.length), 0, projection.record); return result; }
function clearRecordProjection() { const projection = state.recordProjection; state.recordProjection = null; if (!projection || !state.visibleRecords) return; const ids = projection.record.topicIds || projection.record.topics?.map(topic => topic.id) || []; const filters = state.filters; const matches = !filters.topicIds?.length && !filters.uncategorized || filters.uncategorized && !ids.length || filters.topicIds?.some(id => ids.includes(id)); if (!matches) state.visibleRecords = state.visibleRecords.filter(record => record.id !== projection.record.id); }
async function selectCloudRecord(id) { return selectRecord(id, { context: { view: 'inbox', kind: 'cloud' } }); }

function groupFilters(id) { return id === 'uncategorized' ? { topicIds: [], uncategorized: true } : { topicIds: id ? [id] : [] }; }
async function openPrimaryGroup(id) {
  const navigationVersion = ++state.navigationVersion;
  if (state.detailDirty && !await dialogs.confirm({ title: '切换分组前放弃修改？', message: '当前记录有尚未保存的修改。', detail: '继续会放弃修改，已保存的内容保留。', confirmLabel: '放弃修改并切换' })) return;
  if (navigationVersion !== state.navigationVersion) return;
  clearRecordSelection();
  stopAudio(); if (state.libraryMode === 'home') state.homeScroll[state.libraryGroupId] = $('#record-list').scrollTop || 0;
  state.recordProjection = null; state.aiMode = false; state.aiResultScope = null; state.libraryGroupId = id; state.libraryMode = 'home'; state.filters = groupFilters(id); state.query = ''; $('#search-input').value = ''; clearTimeout(searchTimer); $('#date-range').value = 'all'; $('#date-from').value = ''; $('#date-to').value = ''; $('#custom-dates').classList.add('hidden');
  state.selectedId = null; state.editingId = null; state.detailDirty = false; state.detailContext = { view: 'inbox', kind: 'library' }; notifyDirty(); renderDetailEmpty(); renderTopics(); showView('inbox', { preserveNavigation: true }); document.body.classList?.remove('group-sidebar-open');
  await loadLibrary(); $('#record-list').scrollTop = state.homeScroll[id] || 0;
}
async function returnToGroupHome() {
  if (state.detailDirty && !await dialogs.confirm({ title: '返回分组主页？', message: '当前记录有尚未保存的修改。', detail: '返回会放弃修改，已保存内容保留。', confirmLabel: '放弃修改并返回' })) return;
  state.navigationVersion += 1; clearRecordSelection(); stopAudio(); state.libraryMode = 'home'; state.selectedId = null; state.editingId = null; state.detailDirty = false; notifyDirty(); renderDetailEmpty(); updateLibraryLayout(); renderList(); $('#record-list').scrollTop = state.homeScroll[state.libraryGroupId] || 0;
}
function renderPrimaryGroups() {
  const navigation = $('#primary-group-navigation'); const focused = within(document.activeElement, navigation) && document.activeElement?.getAttribute?.('data-library-group-id'); const scrollTop = navigation.scrollTop || 0; navigation.replaceChildren();
  [{ id: 'uncategorized', name: '未分类' }, ...state.topics].forEach(group => { const count = (state.recordHeaders || []).filter(record => group.id === 'uncategorized' ? !record.topicIds?.length : record.topicIds?.includes(group.id)).length; const button = node('button', 'primary-group-item'); button.setAttribute('data-library-group-id', group.id); const selected = state.libraryGroupId === group.id && !(state.aiMode && state.aiResultScope === 'all'); button.setAttribute('aria-pressed', String(selected)); button.classList.toggle('active', selected); add(button, node('span', 'primary-group-name', group.name), node('span', 'primary-group-count', count)); button.addEventListener('click', () => openPrimaryGroup(group.id)); navigation.append(button); });
  navigation.scrollTop = scrollTop; if (focused) Array.from(navigation.children).find(button => button.getAttribute('data-library-group-id') === focused)?.focus?.({ preventScroll: true });
}
function emptyState(title, message, type = '', buttonText, onClick) { const element = node('div', `empty-state ${type}`); add(element, node('div', 'empty-mark', type === 'detail-empty' ? '↳' : '✦'), node('h2', '', title), node('p', '', message)); if (buttonText) { const button = node('button', 'button secondary compact', buttonText); button.addEventListener('click', onClick); element.append(button); } return element; }
function detailPane() { return $('#record-detail'); }
function recordListPane() { return $('#record-list'); }
function within(element, parent) { for (let current = element; current; current = current.parentElement) if (current === parent) return true; return false; }
function captureListPosition(list) {
  const focused = document.activeElement; const belongs = within(focused, list); const deleting = focused?.getAttribute?.('data-record-delete-id'); const selecting = focused?.getAttribute?.('data-record-select-id'); const more = focused?.getAttribute?.('data-record-more-id');
  return { scrollTop: list.scrollTop || 0, focusedId: belongs ? selecting || deleting || more || focused?.getAttribute?.('data-record-open-id') || null : null, focusedAction: selecting ? 'select' : deleting ? 'delete' : more ? 'more' : 'open' };
}
function restoreListPosition(list, previous) {
  list.scrollTop = previous.scrollTop;
  if (!previous.focusedId) return;
  const attribute = previous.focusedAction === 'select' ? 'data-record-select-id' : previous.focusedAction === 'delete' ? 'data-record-delete-id' : previous.focusedAction === 'more' ? 'data-record-more-id' : 'data-record-open-id';
  for (const card of Array.from(list.children)) {
    const children = Array.from(card.children || []); const child = children.find(item => !item.disabled && item.getAttribute?.('aria-hidden') !== 'true' && item.getAttribute?.(attribute) === previous.focusedId);
    const fallback = previous.focusedAction === 'delete' && card.getAttribute?.('data-record-id') === previous.focusedId && children.find(item => !item.disabled && item.classList.contains('record-actions-toggle'));
    (child || fallback)?.focus?.({ preventScroll: true });
  }
}
function clearRecordSelection() { recordSelection.enabled = false; recordSelection.ids.clear(); recordSelection.expandedId = null; recordSelection.scope = null; document.body.classList?.remove('record-selection-mode'); if (recordSelectionToolbar) updateRecordSelectionToolbar(); }
function recordSelectionScope() { return JSON.stringify({ view: state.view, scope: projectionScope(), topics: state.filters.topicIds, uncategorized: Boolean(state.filters.uncategorized) }); }
function visibleRecordIds() { return Array.from($('#record-list').children).map(card => card.getAttribute('data-record-id')).filter(Boolean); }
function toggleRecordSelected(id) { if (recordSelection.busy || deletingRecords.has(id)) return; if (recordSelection.ids.has(id)) recordSelection.ids.delete(id); else recordSelection.ids.add(id); renderList(); }
function updateRecordSelectionToolbar() {
  if (!recordSelectionToolbar) {
    recordSelectionToolbar = node('div', 'record-selection-toolbar'); recordSelectionToolbar.id = 'record-selection-toolbar';
    const toggle = node('button', 'record-selection-toggle', '选择'); toggle.id = 'toggle-record-selection'; toggle.addEventListener('click', () => { if (recordSelection.busy) return; recordSelection.enabled = !recordSelection.enabled; recordSelection.ids.clear(); recordSelection.expandedId = null; renderList(); });
    const all = node('button', 'record-selection-all', '全选'); all.id = 'select-visible-records'; all.addEventListener('click', () => { if (recordSelection.busy) return; const ids = visibleRecordIds(); const selected = ids.length && ids.every(id => recordSelection.ids.has(id)); recordSelection.ids = new Set(selected ? [] : ids); renderList(); });
    const count = node('span', 'record-selection-count'); count.id = 'record-selection-count'; count.setAttribute('aria-live', 'polite');
    const group = node('button', 'record-selection-add-group', '添加到组'); group.id = 'add-selected-records'; group.addEventListener('click', () => addSelectedRecordsToGroup());
    const remove = node('button', 'record-selection-delete', '删除'); remove.id = 'delete-selected-records'; remove.addEventListener('click', () => deleteSelectedRecords()); add(recordSelectionToolbar, toggle, all, count, group, remove);
  }
  const host = $('#record-list').parentElement; if (host && recordSelectionToolbar.parentElement !== host) { host.append(recordSelectionToolbar); host.append($('#record-list')); }
  document.body.classList?.toggle('record-selection-mode', recordSelection.enabled);
  $('#toggle-record-selection').textContent = recordSelection.enabled ? '完成' : '选择'; $('#toggle-record-selection').disabled = recordSelection.busy;
  $('#select-visible-records').classList.toggle('hidden', !recordSelection.enabled); $('#select-visible-records').disabled = recordSelection.busy; $('#select-visible-records').textContent = visibleRecordIds().length && visibleRecordIds().every(id => recordSelection.ids.has(id)) ? '取消全选' : '全选';
  $('#record-selection-count').classList.toggle('hidden', !recordSelection.enabled); $('#record-selection-count').textContent = '已选 ' + recordSelection.ids.size + ' 条';
  $('#add-selected-records').classList.toggle('hidden', !recordSelection.enabled); $('#add-selected-records').disabled = recordSelection.busy || !recordSelection.ids.size; $('#add-selected-records').textContent = recordSelection.busyAction === 'group' ? '添加中…' : '添加到组';
  $('#delete-selected-records').classList.toggle('hidden', !recordSelection.enabled); $('#delete-selected-records').disabled = recordSelection.busy || !recordSelection.ids.size; $('#delete-selected-records').textContent = recordSelection.busyAction === 'delete' ? '删除中…' : '删除';
}
function setCardActions(id) { recordSelection.expandedId = id; for (const card of Array.from($('#record-list').children)) { const expanded = card.getAttribute('data-record-id') === id; card.classList.toggle('actions-open', expanded); for (const child of Array.from(card.children || [])) { if (child.classList.contains('record-actions-toggle')) child.setAttribute('aria-expanded', String(expanded)); if (child.classList.contains('card-delete') || child.classList.contains('record-add-group')) { child.tabIndex = expanded ? 0 : -1; child.setAttribute('aria-hidden', String(!expanded)); } } } }
function installRecordSwipe(card, open, id) {
  let gesture; let suppressClick = false; let suppressTimer;
  card.addEventListener('pointerdown', event => { clearTimeout(suppressTimer); suppressClick = false; if (state.libraryMode !== 'detail' || recordSelection.enabled || recordSelection.busy || event.isPrimary === false || event.button !== undefined && event.button !== 0 || !within(event.target, open)) return; gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null }; });
  card.addEventListener('pointermove', event => { if (!gesture || gesture.id !== event.pointerId) return; const dx = event.clientX - gesture.x; const dy = event.clientY - gesture.y; if (!gesture.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 10) { gesture.axis = Math.abs(dx) > Math.abs(dy) * 1.25 ? 'x' : 'y'; if (gesture.axis === 'x') card.setPointerCapture?.(event.pointerId); } if (gesture.axis !== 'x') return; event.preventDefault(); suppressClick = true; if (Math.abs(dx) >= 24) setCardActions(dx < 0 ? id : null); });
  const end = event => { if (!gesture || gesture.id !== event.pointerId) return; gesture = null; if (suppressClick) suppressTimer = setTimeout(() => { suppressClick = false; }, 0); }; card.addEventListener('pointerup', end); card.addEventListener('pointercancel', event => { end(event); suppressClick = false; });
  open.addEventListener('click', event => { if (suppressClick) { clearTimeout(suppressTimer); suppressClick = false; event.preventDefault(); return; } if (recordSelection.enabled) { toggleRecordSelected(id); return; } if (recordSelection.expandedId === id) { setCardActions(null); return; } return selectRecord(id, { context: { view: 'inbox', kind: 'library' } }); });
  open.addEventListener('dragstart', event => event.preventDefault());
}
async function showRecordMenu(record, button, context) {
  if (recordSelection.enabled || recordSelection.busy || deletingRecords.has(record.id) || state.topicAdoptBusy) return;
  if (!window.InMomentMenus?.open) { toast('操作菜单暂时不可用，请重试。', true); return; }
  setCardActions(null);
  const navigationVersion = state.navigationVersion; const scope = recordSelectionScope();
  let action;
  button.setAttribute('aria-expanded', 'true');
  try { action = await window.InMomentMenus.open({ anchor: button, title: '灵感操作', items: [{ id: 'group', label: '添加到组' }, { id: 'delete', label: '删除', danger: true }] }); }
  catch (error) { toast(error.message || '操作菜单暂时不可用，请重试。', true); return; }
  finally { if (button.isConnected) button.setAttribute('aria-expanded', 'false'); }
  if (!button.isConnected || navigationVersion !== state.navigationVersion || scope !== recordSelectionScope()) return;
  if (action === 'group') await addRecordToGroup(record, button);
  else if (action === 'delete') await deleteRecord(record, button, context);
}
async function addRecordToGroup(record, button) {
  if (recordSelection.busy || deletingRecords.has(record.id)) return;
  if (state.topicAdoptBusy) { toast('正在更新分组，请稍后。'); return; }
  if (!window.InMomentGroupPicker?.open) { toast('分组选择暂时不可用，请重试。', true); return; }
  state.topicAdoptBusy = true;
  try {
  const navigationVersion = state.navigationVersion; const scope = projectionScope();
  const topic = await window.InMomentGroupPicker.open({ anchor: button, topics: state.topics, selectedIds: [], multiple: false, title: '添加到组' }); if (!topic?.id || deletingRecords.has(record.id)) return;
  return await act(button, async () => {
    if (state.selectedId === record.id && state.detailDirty) { toast('请先保存或放弃当前修改，再添加分组。'); return; }
    const current = await invoke('records:get', { id: record.id }); const value = current?.record || current; if (!value) throw new Error('这条灵感已不存在。');
    const topicIds = [...new Set([...(value.topicIds || value.topics?.map(item => item.id) || []), topic.id])]; const result = await invoke('records:setTopics', { id: record.id, topicIds, expectedVersion: value.version }); const updated = result?.record || result;
    if (navigationVersion === state.navigationVersion && scope === projectionScope()) {
      if (state.selectedId === record.id) projectCurrentRecord(updated?.id ? updated : { ...value, topicIds });
      else { const index = (state.visibleRecords || []).findIndex(item => item.id === record.id); state.recordProjection = { record: updated?.id ? updated : { ...value, topicIds }, scope, index: Math.max(0, index), reason: '已归类，暂留此处' }; }
    }
    setCardActions(null); await refresh(); toast('已添加到“' + topic.name + '”');
  });
  } catch (error) { toast(error.message || '分组未能更新，请重试。', true); } finally { state.topicAdoptBusy = false; }
}
async function addSelectedRecordsToGroup() {
  if (recordSelection.busy || !recordSelection.enabled || state.topicAdoptBusy) return;
  const ids = visibleRecordIds().filter(id => recordSelection.ids.has(id) && !deletingRecords.has(id)); if (!ids.length) return;
  if (!window.InMomentGroupPicker?.open) { toast('分组选择暂时不可用，请重试。', true); return; }
  if (ids.includes(state.selectedId) && state.detailDirty) { toast('请先保存或放弃当前修改，再添加分组。'); return; }
  const entry = $('#add-selected-records'); const navigationVersion = state.navigationVersion; const scope = recordSelectionScope();
  recordSelection.busy = true; recordSelection.busyAction = 'group'; state.topicAdoptBusy = true; setCardActions(null); updateRecordSelectionToolbar();
  let completed = 0; const failed = [];
  try {
    const topic = await window.InMomentGroupPicker.open({ anchor: entry, topics: state.topics, selectedIds: [], multiple: false, title: '添加到组' });
    if (!topic?.id || navigationVersion !== state.navigationVersion || scope !== recordSelectionScope()) return;
    for (const id of ids) {
      try {
        if (state.selectedId === id && state.detailDirty) throw new Error('当前记录有尚未保存的修改');
        const result = await invoke('records:get', { id }); const current = result?.record || result; if (!current) throw new Error('这条灵感已不存在');
        if (state.selectedId === id && state.detailDirty) throw new Error('当前记录有尚未保存的修改');
        const topicIds = [...new Set([...(current.topicIds || current.topics?.map(item => item.id) || []), topic.id])];
        const response = await invoke('records:setTopics', { id, topicIds, expectedVersion: current.version }); const updated = response?.record || response;
        if (state.selectedId === id && navigationVersion === state.navigationVersion && scope === recordSelectionScope()) projectCurrentRecord(updated?.id ? updated : { ...current, topicIds });
        recordSelection.ids.delete(id); completed += 1;
      } catch (error) { failed.push({ id, message: error.message || '添加未完成' }); }
    }
    await refresh();
    toast(failed.length ? '已添加 ' + completed + ' 条到“' + topic.name + '”，' + failed.length + ' 条未能添加：' + failed[0].message + '。失败项保留，可重试。' : '已将 ' + completed + ' 条灵感添加到“' + topic.name + '”', Boolean(failed.length));
  } catch (error) { toast(error.message || '分组未能更新，请重试。', true); }
  finally { recordSelection.busy = false; recordSelection.busyAction = null; state.topicAdoptBusy = false; renderList(); }
}
function lockDeletingDetail(id) { if (state.selectedId !== id) return; const controls = [...document.querySelectorAll('#record-detail input, #record-detail textarea, #record-detail button')].map(element => ({ element, disabled: element.disabled })); for (const { element } of controls) element.disabled = true; recordDeletionLocks.set(id, [...(recordDeletionLocks.get(id) || []), ...controls]); }
function unlockDeletingDetail(id) { for (const { element, disabled } of recordDeletionLocks.get(id) || []) if (element.isConnected) element.disabled = disabled; recordDeletionLocks.delete(id); }
function cleanDeletedRecord(id) { recordSelection.ids.delete(id); if (state.selectedId === id) { stopAudio(); state.selectedId = null; state.editingId = null; state.detailDirty = false; notifyDirty(); renderDetailEmpty(); } if (screenshotViewer.recordId === id) closeScreenshot(); if (state.recordProjection?.record.id === id) state.recordProjection = null; }
async function deleteSelectedRecords() {
  if (recordSelection.busy || !recordSelection.enabled) return;
  const ids = visibleRecordIds().filter(id => recordSelection.ids.has(id) && !deletingRecords.has(id)); if (!ids.length) return;
  const entry = $('#delete-selected-records'); const restoreEntryFocus = document.activeElement === entry; const entryScope = recordSelectionScope(); const navigationVersion = state.navigationVersion;
  recordSelection.busy = true; recordSelection.busyAction = 'delete'; ids.forEach(id => { deletingRecords.add(id); lockDeletingDetail(id); }); updateRecordSelectionToolbar();
  let completed = 0; const failed = [];
  try {
    const editing = ids.includes(state.selectedId) && state.detailDirty;
    if (!await window.InMomentConfirm.open({ anchor: entry, title: '删除选中的 ' + ids.length + ' 条灵感？', message: '将删除这些记录及其录音、截图与整理结果。', detail: '分组和未选中的灵感会保留。此操作无法撤销。' + (editing ? '\n当前记录尚未保存的修改也将放弃。' : ''), confirmLabel: '删除 ' + ids.length + ' 条灵感', danger: true })) return;
    for (const id of ids) { try { await invoke('records:delete', { id }); completed += 1; cleanDeletedRecord(id); } catch (error) { let missing = false; try { const current = await invoke('records:get', { id }); missing = !(current?.record || current); } catch {} if (missing) { completed += 1; cleanDeletedRecord(id); } else failed.push({ id, message: error.message || '删除未完成' }); } }
    await refresh(); toast(failed.length ? '已删除 ' + completed + ' 条，' + failed.length + ' 条删除失败：' + failed[0].message + '。失败项保留，可重试。' : '已删除 ' + completed + ' 条灵感与关联材料', Boolean(failed.length));
  } catch (error) { toast(error.message || '删除未完成，请重试。', true); }
  finally { ids.forEach(id => { deletingRecords.delete(id); unlockDeletingDetail(id); }); recordSelection.busy = false; recordSelection.busyAction = null; renderList(); const focused = document.activeElement; if (restoreEntryFocus && entryScope === recordSelectionScope() && navigationVersion === state.navigationVersion && (!focused || focused === entry || focused === document.body || !focused.isConnected || !dialogs.open && within(focused, $('#confirm-dialog')))) ($('#delete-selected-records').disabled ? $('#toggle-record-selection') : $('#delete-selected-records')).focus?.({ preventScroll: true }); }
}
function renderRecordCards(list, records, context) {
  const position = captureListPosition(list); list.replaceChildren();
  records.forEach(record => {
    const card = node('article', 'record-card'); card.setAttribute('data-record-id', record.id);
    card.classList.toggle('selected', record.id === state.selectedId && state.detailContext?.view === context.view);
    const open = node('button', 'record-open'); open.setAttribute('title', recordTitle(record)); open.setAttribute('data-record-open-id', record.id); open.setAttribute('aria-pressed', String(record.id === state.selectedId && state.detailContext?.view === context.view)); open.setAttribute('aria-label', '打开灵感：' + recordTitle(record));
    const top = node('div', 'card-top'); add(top, node('span', 'record-time', formatDate(record.createdAt)), node('span', 'record-type', record.organization ? '已有摘要' : '原始记录'));
    const picture = screenshotURL(record); if (picture) { const image = node('img', 'record-card-image'); image.src = picture; image.alt = ''; image.loading = 'lazy'; image.addEventListener('error', () => image.classList.add('hidden')); open.append(image); }
    add(open, top, node('h3', 'record-card-title', recordTitle(record)), node('p', 'card-preview', record.organization?.summary || record.matchSnippet || transcriptText(record) || (segmentList(record).length ? '已保存录音，可打开回听。' : '查看保存的现场材料。')));
    const topicNames = record.topics?.map(topic => topic.name).filter(Boolean) || [];
    open.append(node('div', 'card-topics', topicNames.length ? topicNames.join(' · ') : '未分类'));
    const source = record.task || record.context?.windowTitle || record.context?.url || record.source?.windowTitle || record.source?.url;
    if (source) { const line = node('p', 'card-context', source); line.setAttribute('title', source); open.append(line); }
    const reason = record.matchReason || record.aiMatchReason || record.reason;
    if (reason) open.append(node('p', 'match-reason', '匹配原因：' + (typeof reason === 'string' ? reason : JSON.stringify(reason))));
    if (state.recordProjection?.record.id === record.id && state.recordProjection.scope === projectionScope()) open.append(node('span', 'projection-note', state.recordProjection.reason));
    if (record.searchStale) open.append(node('p', 'field-help', '内容已更新，重新查找后可核对。'));
    installRecordSwipe(card, open, record.id);
    card.classList.toggle('is-checked', recordSelection.ids.has(record.id)); card.classList.toggle('actions-open', recordSelection.expandedId === record.id && !recordSelection.enabled);
    const check = node('input', 'record-selection'); check.type = 'checkbox'; check.checked = recordSelection.ids.has(record.id); check.disabled = recordSelection.busy || deletingRecords.has(record.id); check.setAttribute('aria-label', '选择灵感：' + recordTitle(record)); check.setAttribute('data-record-select-id', record.id); check.addEventListener('change', () => toggleRecordSelected(record.id));
    check.tabIndex = recordSelection.enabled ? 0 : -1; check.setAttribute('aria-hidden', String(!recordSelection.enabled));
    const more = node('button', 'record-actions-toggle', '⋯'); more.setAttribute('data-record-more-id', record.id); more.setAttribute('aria-label', '更多操作：' + recordTitle(record)); more.setAttribute('aria-haspopup', 'menu'); more.disabled = recordSelection.busy || deletingRecords.has(record.id); more.addEventListener('click', () => showRecordMenu(record, more, context));
    more.tabIndex = recordSelection.enabled ? -1 : 0;
    const group = node('button', 'record-add-group', '添加到组'); group.setAttribute('aria-label', '添加到组：' + recordTitle(record)); group.disabled = recordSelection.busy || deletingRecords.has(record.id); group.addEventListener('click', () => addRecordToGroup(record, group));
    const remove = node('button', 'card-delete', '删除'); remove.setAttribute('data-record-delete-id', record.id); remove.setAttribute('aria-label', '删除灵感：' + recordTitle(record)); remove.disabled = deletingRecords.has(record.id); remove.addEventListener('click', () => deleteRecord(record, remove, context));
    const expanded = recordSelection.expandedId === record.id && !recordSelection.enabled; for (const action of [group, remove]) { action.tabIndex = expanded ? 0 : -1; action.setAttribute('aria-hidden', String(!expanded)); }
    add(card, open, check, more, group, remove); list.append(card);
  });
  restoreListPosition(list, position);
}
function renderList(records = state.visibleRecords ?? (state.query ? state.searchRecords : state.records)) {
  const scope = recordSelectionScope(); if (recordSelection.scope !== scope) { clearRecordSelection(); recordSelection.scope = scope; } const visible = new Set(records.map(record => record.id)); recordSelection.ids = new Set([...recordSelection.ids].filter(id => visible.has(id))); if (!visible.has(recordSelection.expandedId)) recordSelection.expandedId = null;
  $('#inbox-count').textContent = state.recordCount ?? state.records.length;
  $('#record-count').textContent = state.recordProjection && state.recordProjection.scope === projectionScope() ? records.length + ' 条（含当前暂留）' : '已显示 ' + records.length + ' / ' + (state.total ?? records.length) + ' 条';
  $('#collection-heading').textContent = state.aiMode ? 'AI 查找结果' : state.query ? primaryGroupName() + ' · 搜索结果' : primaryGroupName(); updateLibraryLayout();
  const list = $('#record-list');
  if (!records.length) {
    const position = captureListPosition(list); list.replaceChildren(emptyState(state.query ? '暂时没有找到这段记忆' : '给下一个想法，留个位置', state.query ? '试试关键词、分组或其他时间范围，也可手动使用 AI 查找。' : '按住右键留下想法，无须先分类。', 'list-empty', state.query ? '清除搜索' : '了解捕捉方式', () => { if (state.query) { $('#search-input').value = ''; search(''); } else openGuide(); })); restoreListPosition(list, position); updateRecordSelectionToolbar(); return;
  }
  renderRecordCards(list, records, { view: 'inbox', kind: 'library' });
  updateRecordSelectionToolbar();
}
function renderDetailEmpty(context = state.detailContext) {
  detailPane(context).replaceChildren(emptyState('选择一条记录', '在这里回看摘要、分组和原始表达。', 'detail-empty'));
}
async function selectRecord(id, options = {}) {
  if (deletingRecords.has(id)) { toast('这条灵感正在删除，请稍后。'); return false; }
  if (options.expectedNavigationVersion !== undefined && options.expectedNavigationVersion !== state.navigationVersion) return false;
  const navigationVersion = ++state.navigationVersion;
  const nextContext = { ...(options.context || state.detailContext || { kind: 'library' }), view: 'inbox' };
  if (state.detailDirty && state.selectedId === id && state.detailContext?.view === nextContext.view && !options.discard) return false;
  if (state.detailDirty && !options.discard && !await dialogs.confirm({ title: '切换前放弃修改？', message: '当前记录有尚未保存的修改。', detail: '继续会放弃这些修改；原先保存的内容保留。', confirmLabel: '放弃修改并切换' })) return false;
  if (navigationVersion !== state.navigationVersion) return false;
  const switchingRecord = state.selectedId !== id || state.detailContext?.view !== nextContext.view; if (switchingRecord) clearRecordProjection();
  if (nextContext.view === 'inbox') { if (state.libraryMode === 'home') state.homeScroll[state.libraryGroupId] = $('#record-list').scrollTop || 0; state.libraryMode = 'detail'; }
  stopAudio(); if (state.detailContext?.view !== nextContext.view) detailPane().replaceChildren(); state.detailDirty = false; state.editingId = null; notifyDirty(); state.detailContext = { ...nextContext }; if (nextContext.groupId) state.activeGroupId = nextContext.groupId; state.selectedId = id; state.resetDetailScroll = switchingRecord || Boolean(options.discard);
  showView(nextContext.view, { preserveNavigation: true });
  renderList();
  const pane = detailPane(); pane.replaceChildren(emptyState('正在读取…', '资料保存在本机。', 'detail-empty')); if (state.resetDetailScroll) pane.scrollTop = 0;
  try {
    const result = await invoke('records:get', { id }); const record = result?.record || result;
    if (state.selectedId !== id || state.detailContext.view !== nextContext.view) return false;
    if (!record) throw new Error('这条记录已不存在。');
    if (nextContext.kind === 'cloud') { projectCurrentRecord(record, '从灵感云打开'); state.visibleRecords = withRecordProjection(state.visibleRecords || []); renderList(); } renderDetail(record); document.body.classList?.toggle('inbox-detail-open', true); return true;
  } catch (error) {
    if (state.selectedId !== id) return false;
    pane.replaceChildren(emptyState('记录暂时无法读取', error.message, 'detail-empty', '重试读取', () => selectRecord(id, { discard: true, context: nextContext }))); return false;
  }
}

async function deleteRecord(record, button, entryContext = state.detailContext) {
  if (deletingRecords.has(record.id) || recordSelection.busy) return;
  const entryCard = Array.from($('#record-list').children).find(card => card.getAttribute('data-record-id') === record.id);
  const anchor = button?.classList.contains('card-delete') ? Array.from(entryCard?.children || []).find(child => child.classList.contains('record-actions-toggle')) || button : button;
  setCardActions(null);
  const entryNavigationVersion = state.navigationVersion; const entryScope = recordSelectionScope();
  const list = recordListPane(entryContext); const entryIndex = Array.from(list.children).findIndex(card => card.getAttribute('data-record-id') === record.id);
  deletingRecords.add(record.id);
  lockDeletingDetail(record.id);
  return act(button, async () => {
    try {
      const editing = state.selectedId === record.id && state.detailDirty;
      if (!await window.InMomentConfirm.open({ anchor, title: '删除这条灵感？', message: '“' + recordTitle(record) + '”', detail: '将删除这条记录、录音、截图与整理结果。关联记录和分组中的其他原件会保留。此操作无法撤销。' + (editing ? '\n这条记录尚未保存的修改也将放弃。' : ''), confirmLabel: '删除灵感与附件', danger: true })) return;
      await invoke('records:delete', { id: record.id });
      cleanDeletedRecord(record.id);
      await refresh(); toast('记录与关联材料已删除');
    } finally {
      deletingRecords.delete(record.id);
      unlockDeletingDetail(record.id);
      const focused = document.activeElement;
      const restoreFocus = entryNavigationVersion === state.navigationVersion && entryScope === recordSelectionScope() && (!focused || focused === button || focused === document.body || !focused.isConnected || (!dialogs.open && within(focused, $('#confirm-dialog'))));
      renderList();
      if (restoreFocus) {
        const cards = Array.from(list.children).filter(card => card.getAttribute('data-record-id'));
        const original = cards.find(card => card.getAttribute('data-record-id') === record.id);
        const target = original || cards[Math.min(Math.max(0, entryIndex), cards.length - 1)];
        const action = target && Array.from(target.children).find(child => !child.disabled && child.classList.contains(original ? target.classList.contains('actions-open') ? 'card-delete' : 'record-actions-toggle' : 'record-open'));
        (action || $('#search-input')).focus?.({ preventScroll: true });
      }
    }
  });
}
function section(title, english) { const element = node('section', 'detail-section'); const heading = node('h3', '', title); if (english) heading.append(node('span', '', english)); element.append(heading); return element; }
function disclosure(label, kind, className = '') { const element = node('details', 'progressive-section ' + className); element.setAttribute('data-disclosure', kind); element.append(node('summary', '', label)); return element; }
function labeledInput(parent, label, value, multiline = false, placeholder = '') { const id = `field-${label.replace(/\s/g, '')}`; const fieldLabel = node('label', 'field-label', label); fieldLabel.htmlFor = id; const input = node(multiline ? 'textarea' : 'input'); input.id = id; input.value = value; input.placeholder = placeholder; if (multiline) input.rows = 5; add(parent, fieldLabel, input); return input; }
function setScreenshotControls() {
  for (const id of ['#screenshot-zoom-in', '#screenshot-zoom-out', '#screenshot-fit', '#screenshot-actual-size']) $(id).disabled = !screenshotViewer.loaded;
}
function applyScreenshotZoom(scale, mode = 'custom') {
  if (!screenshotViewer.loaded || !Number.isFinite(scale)) return;
  const image = $('#screenshot-full-image'); screenshotViewer.scale = Math.max(0.01, Math.min(8, scale)); screenshotViewer.mode = mode;
  image.style.width = `${Math.round(image.naturalWidth * screenshotViewer.scale)}px`;
  image.style.height = `${Math.round(image.naturalHeight * screenshotViewer.scale)}px`;
  $('#screenshot-zoom-label').textContent = `${Math.round(screenshotViewer.scale * 100)}%`;
}
function fitScreenshot() {
  if (!screenshotViewer.loaded) return;
  const image = $('#screenshot-full-image'); const viewport = $('#screenshot-viewport');
  const width = Math.max(1, (viewport.clientWidth || 1000) - 32); const height = Math.max(1, (viewport.clientHeight || 600) - 32);
  applyScreenshotZoom(Math.min(1, width / image.naturalWidth, height / image.naturalHeight), 'fit');
}
function zoomScreenshotAt(scale, clientX, clientY, mode = 'custom') {
  if (!screenshotViewer.loaded) return;
  const image = $('#screenshot-full-image'); const viewport = $('#screenshot-viewport');
  const before = image.getBoundingClientRect?.(); const oldScale = screenshotViewer.scale;
  const point = before && Number.isFinite(clientX) && Number.isFinite(clientY) ? { x: (clientX - before.left) / oldScale, y: (clientY - before.top) / oldScale } : null;
  applyScreenshotZoom(scale, mode);
  if (point) { const after = image.getBoundingClientRect(); viewport.scrollLeft += after.left + point.x * screenshotViewer.scale - clientX; viewport.scrollTop += after.top + point.y * screenshotViewer.scale - clientY; }
}
function openScreenshot(record, source) {
  if (!source) return;
  screenshotViewer.opener = document.activeElement; screenshotViewer.recordId = record.id; screenshotViewer.source = source; screenshotViewer.loaded = false; screenshotViewer.mode = 'fit'; screenshotViewer.draft = ['draft', 'committing'].includes(record.status);
  $('#screenshot-reveal').classList.toggle('hidden', screenshotViewer.draft);
  const image = $('#screenshot-full-image'); image.classList.add('hidden');
  $('#screenshot-viewer-error').classList.add('hidden'); $('#screenshot-dimensions').textContent = '正在读取原始 PNG…'; $('#screenshot-zoom-label').textContent = '—';
  $('#screenshot-viewport').scrollTop = 0; $('#screenshot-viewport').scrollLeft = 0; setScreenshotControls();
  if (!$('#screenshot-dialog').open) $('#screenshot-dialog').showModal();
  image.src = source;
}
function closeScreenshot() {
  const opener = screenshotViewer.opener; screenshotViewer.opener = null; imageDrag = null; $('#screenshot-viewport').classList.remove('dragging');
  screenshotViewer.recordId = null; screenshotViewer.source = ''; screenshotViewer.loaded = false;
  $('#screenshot-dialog').close(); $('#screenshot-full-image').removeAttribute('src'); setScreenshotControls();
  if (opener?.isConnected) opener.focus?.();
}
function screenshotLoaded() {
  if (!screenshotViewer.source || !$('#screenshot-dialog').open) return;
  const image = $('#screenshot-full-image');
  if (!image.naturalWidth || !image.naturalHeight) { screenshotFailed(); return; }
  screenshotViewer.loaded = true; image.classList.remove('hidden'); $('#screenshot-viewer-error').classList.add('hidden');
  $('#screenshot-dimensions').textContent = `${image.naturalWidth} × ${image.naturalHeight} 像素 · PNG 原图`;
  setScreenshotControls(); fitScreenshot();
}
function screenshotFailed() {
  if (!screenshotViewer.source || !$('#screenshot-dialog').open) return;
  screenshotViewer.loaded = false; $('#screenshot-full-image').classList.add('hidden');
  $('#screenshot-viewer-error').textContent = '原图读取失败。可打开所在文件夹检查原始文件。'; $('#screenshot-viewer-error').classList.remove('hidden');
  $('#screenshot-dimensions').textContent = '原图暂不可用'; $('#screenshot-zoom-label').textContent = '—'; setScreenshotControls();
}
async function revealScreenshot(id, button) {
  if (!id) return;
  return act(button, async () => { try { await invoke('records:revealScreenshot', { id }); } catch (error) { if ($('#screenshot-dialog').open) { $('#screenshot-viewer-error').textContent = error.message; $('#screenshot-viewer-error').classList.remove('hidden'); } throw error; } });
}
function stopAudio() { mountedAudio.forEach(player => { try { player.pause?.(); } catch {} }); }
function audioSection(record) {
  const area = section('回听当时的表达'); const players = []; const segments = segmentList(record);
  if (!Array.isArray(segments) || !segments.length) { area.append(node('p', 'field-help', '当前没有可播放的音频段。截图、文字和音频分别保存，0:00 也可能只是不到一秒。')); return { area, players }; }
  segments.forEach((segment, index) => {
    const wrapper = node('div', 'audio-segment'); const label = node('div', 'audio-label'); const length = node('span', '', audioDuration(segment.durationMs || 0)); add(label, node('span', '', `第 ${index + 1} 段`), length);
    const player = node('audio'); player.controls = true; player.preload = 'metadata'; const url = typeof segment === 'string' ? segment : segment.url || segment.audioUrl || segment.src; if (url) player.src = url;
    player.setAttribute('aria-label', `第 ${index + 1} 段原始录音`); mountedAudio.push(player); players.push({ player, id: segment.id });
    const error = node('p', 'field-help audio-error hidden', '这段录音暂时无法播放，请检查附件是否存在，或重新打开记录。');
    player.addEventListener('error', () => error.classList.remove('hidden'));
    player.addEventListener('loadedmetadata', () => { if (Number.isFinite(player.duration) && player.duration > 0) length.textContent = audioDuration(player.duration * 1000); });
    player.addEventListener('play', () => mountedAudio.forEach(other => { if (other !== player) other.pause?.(); }));
    const speed = node('select', 'audio-speed'); speed.setAttribute('aria-label', `第 ${index + 1} 段播放速度`); [0.75, 1, 1.25, 1.5, 2].forEach(value => { const option = node('option', '', `${value}×`); option.value = value; speed.append(option); }); speed.value = 1; speed.addEventListener('change', () => { player.playbackRate = Number(speed.value) || 1; });
    add(wrapper, label, player, speed, error); area.append(wrapper);
  }); return { area, players };
}
function renderDetail(record) {
  stopAudio(); mountedAudio = []; state.detailDirty = false; notifyDirty();
  const selectionContext = { ...state.detailContext }; const detail = detailPane(); const scrollTop = state.resetDetailScroll ? 0 : detail.scrollTop || 0; state.resetDetailScroll = false;
  const inner = node('div', 'detail-inner'); const editor = node('div', 'record-editor hidden');
  const titleRow = node('div', 'record-title-row'); const titleHeading = node('h2', '', recordTitle(record)); const rename = node('button', 'title-rename-button', '✎'); rename.setAttribute('data-action', 'rename-record'); rename.setAttribute('aria-label', '重命名标题'); rename.setAttribute('title', '重命名标题'); add(titleRow, titleHeading, rename); inner.append(titleRow);
  const titleEditor = node('div', 'inline-title-editor hidden'); const fieldTitle = labeledInput(titleEditor, '记录标题', record.editableTitle ?? record.title ?? '', false, '给这段想法一个名字'); const saveTitle = node('button', 'button secondary compact', '保存标题'); const cancelTitle = node('button', 'button quiet compact', '取消重命名'); add(titleEditor, saveTitle, cancelTitle); inner.append(titleEditor);
  let titleStartValue = fieldTitle.value;
  rename.addEventListener('click', () => { titleStartValue = fieldTitle.value; titleEditor.classList.remove('hidden'); rename.classList.add('hidden'); state.editingId = record.id; fieldTitle.focus(); });
  const files = node('div', 'record-file-actions');
  if (segmentList(record).length || screenshotURL(record)) {
    const openFolder = node('button', 'button quiet compact', '打开所在文件夹'); openFolder.setAttribute('data-action', 'reveal-record'); openFolder.addEventListener('click', () => act(openFolder, () => invoke('media:reveal-record', { id: record.id }))); files.append(openFolder);
  }
  files.append(node('span', 'record-time', formatDate(record.createdAt))); inner.append(files);
  const failure = (Array.isArray(record.jobs) ? record.jobs : Object.values(record.jobs || {})).find(job => ['failed', 'unavailable'].includes(job.status)); const errorNotice = failure ? node('p', 'persistent-error', failure.error || '上次操作未完成，可重新尝试。') : null;
  const context = section('截图'); context.classList.add('record-screenshot-section'); context.setAttribute('data-disclosure', 'context');
  if (record.context || record.source) context.append(node('div', 'detail-context', contextText(record)));
  if ((record.context?.windowTitle || record.context?.appName) && record.context?.appName !== 'InMoment') {
    const source = node('button', 'button quiet compact', '回到原窗口'); source.addEventListener('click', () => act(source, async () => { const result = await invoke('records:openSource', { id: record.id }); if (result?.success === false || result?.focused === false) throw new Error(result.message || '原窗口已关闭，请根据保存的来源重新打开。'); })); context.append(source);
  }
  renderScreenshot(context, record);
  const audio = audioSection(record); const audioDetails = node('section', 'record-audio-section'); audioDetails.setAttribute('data-disclosure', 'audio'); audioDetails.append(audio.area); audio.players.forEach(entry => { entry.reveal = () => { audioDetails.scrollIntoView?.({ block: 'nearest' }); }; });
  const reading = node('section', 'record-text-panel'); const panelHeader = node('div', 'text-panel-header'); const panelTitle = node('h3'); const panelToggle = node('div', 'text-panel-toggle');
  const originalWords = node('div', 'text-panel-original'); originalWords.setAttribute('data-disclosure', 'words'); const rawText = node('div', 'original-text'); const summaryBody = node('div', 'text-panel-summary');
  const hasSummary = Boolean(typeof record.organization === 'string' ? record.organization.trim() : record.organization?.summary?.trim());
  const showOriginal = node('button', 'text-button', '语音文本'); showOriginal.setAttribute('data-action', 'show-original'); const showSummary = node('button', 'text-button', '思考摘要'); showSummary.setAttribute('data-action', 'show-summary');
  function showTextMode(mode) { const summary = mode === 'summary' && hasSummary; panelTitle.textContent = summary ? '思考摘要' : '语音文本'; originalWords.classList.toggle('hidden', summary); summaryBody.classList.toggle('hidden', !summary); showOriginal.classList.toggle('active', !summary); showSummary.classList.toggle('active', summary); showOriginal.setAttribute('aria-pressed', String(!summary)); showSummary.setAttribute('aria-pressed', String(summary)); }
  if (hasSummary) add(panelToggle, showOriginal, showSummary); add(panelHeader, panelTitle, panelToggle); add(reading, panelHeader, summaryBody, originalWords); showOriginal.addEventListener('click', () => showTextMode('original')); showSummary.addEventListener('click', () => showTextMode('summary')); showTextMode(hasSummary ? 'summary' : 'original');
  const edit = node('button', 'button quiet compact', '编辑原文'); edit.setAttribute('data-action', 'edit-record'); edit.id = 'dynamic-record-edit-button';
  const fieldTask = labeledInput(editor, '当时正在做什么', record.task || '', false, '当时在解决什么问题');
  edit.addEventListener('click', () => { showTextMode('original'); editor.classList.remove('hidden'); rawText.classList.add('hidden'); edit.classList.add('hidden'); state.editingId = record.id; (transcriptFields[0]?.field || fieldTask).focus(); });
  const segments = segmentList(record);
  if (segments.length) segments.forEach((segment, index) => { if (segments.length > 1) rawText.append(node('h4', '', '第 ' + (index + 1) + ' 段')); rawText.append(node('p', 'original-transcript', (segment.transcript ?? (segments.length === 1 ? transcriptText(record) : '')) || '这段尚无转写，可编辑原文补充。')); });
  else rawText.append(node('p', 'original-transcript', transcriptText(record) || '暂无语音文本，可编辑原文补充文字。'));
  add(originalWords, edit, rawText, editor);
  const words = section('你的原话');
  words.append(node('p', 'field-help', '逐段编辑保留文字与原声的对应关系。转写和 AI 结论可能有误，以你的原始表达为准。'));
  const transcriptFields = [];
  if (Array.isArray(segments) && segments.length) segments.forEach((segment, index) => {
    transcriptFields.push({ id: segment.id, field: labeledInput(words, '第 ' + (index + 1) + ' 段表达', segment.transcript ?? (segments.length === 1 ? transcriptText(record) : ''), true, '补充或修正这一段原话…') });
  });
  else transcriptFields.push({ id: null, field: labeledInput(words, '表达内容', transcriptText(record), true, '这条记录没有音频段，也可以补充文字…') });
  let revision = 0; let titleRevision = 0; let topicsRevision = 0; let titleSavedRevision = 0; let topicsSavedRevision = 0; let baseVersion = record.version; let nonTitleRevision = 0; let nonTitleSavedRevision = 0;
  const status = node('p', 'field-help edit-status'); status.id = 'record-edit-status';
  function dirty(kind) { revision += 1; if (kind === 'title') titleRevision = revision; else nonTitleRevision = revision; if (kind === 'topics') topicsRevision = revision; if (state.selectedId === record.id) state.detailDirty = true; notifyDirty(); status.textContent = '有未保存修改'; }
  fieldTitle.addEventListener('input', () => dirty('title'));
  fieldTask.addEventListener('input', () => dirty('task'));
  transcriptFields.forEach(({ field }) => field.addEventListener('input', () => dirty('transcript')));
  const topicPicker = topicChoices(record, () => dirty('topics')); words.append(topicPicker.area);
  const actions = node('div', 'detail-actions');
  const save = node('button', 'button secondary compact', '保存修改');
  const transcribe = node('button', 'button secondary compact', '重新本地转写');
  const organize = node('button', 'button primary compact', 'AI 总结'); organize.setAttribute('data-action', 'organize-record');
  if (getJob(record, 'organize')?.status === 'processing') { organize.disabled = true; organize.textContent = '正在总结…'; }
  const discardEdit = node('button', 'button secondary compact', '放弃未保存修改');
  add(actions, save, discardEdit); add(words, actions, status); audioDetails.append(transcribe);
  async function persist() {
    const snapshot = { revision, titleRevision, topicsRevision, nonTitleRevision, topicIds: topicPicker.ids(), title: fieldTitle.value.trim(), task: fieldTask.value.trim(), fields: transcriptFields.map(({ id, field }) => ({ id, text: field.value })) };
    const payload = { id: record.id, task: snapshot.task, expectedVersion: baseVersion };
    if (snapshot.titleRevision > titleSavedRevision) payload.title = snapshot.title;
    if (Array.isArray(segments) && segments.length) payload.transcriptSegments = snapshot.fields;
    else payload.transcript = snapshot.fields.map(item => item.text).join('\n');
    const result = await invoke('records:update', payload); baseVersion = (result?.record || result)?.version ?? baseVersion;
    if (snapshot.topicsRevision > topicsSavedRevision) { const updated = await invoke('records:setTopics', { id: record.id, topicIds: snapshot.topicIds }); baseVersion = (updated?.record || updated)?.version ?? baseVersion; }
    titleSavedRevision = Math.max(titleSavedRevision, snapshot.titleRevision); topicsSavedRevision = Math.max(topicsSavedRevision, snapshot.topicsRevision); nonTitleSavedRevision = Math.max(nonTitleSavedRevision, snapshot.nonTitleRevision);
    const unchanged = revision === snapshot.revision;
    if (state.selectedId === record.id) state.detailDirty = !unchanged;
    notifyDirty();
    status.textContent = unchanged ? '已保存在本机' : '已保存提交时的版本；随后输入的修改仍未保存';
    return unchanged;
  }
  save.addEventListener('click', () => act(save, async () => { const unchanged = await persist(); if (unchanged) state.editingId = null; toast(unchanged ? '修改已保存在本机' : '提交版本已保存，后续输入仍保留在编辑区'); await refresh(); }));
  organize.addEventListener('click', () => act(organize, async () => {
    if (!transcriptFields.some(({ field }) => field.value.trim())) { toast('先在“你的原话”中补充文字，再进行整理。'); return; }
    if (state.detailDirty) { const unchanged = await persist(); if (!unchanged) { toast('后续输入仍未保存，请先保存这些修订，再重新总结。'); return; } state.editingId = null; } const result = await invoke('records:organize', { id: record.id, includeScreenshot: Boolean(state.settings.screenshotAnalysisEnabled) });
    if (result?.cancelled || result?.canceled) { toast('本次整理已取消'); await refresh(); return; }
    toast('思路整理完成'); await refresh();
  }));
  const transcribeJob = getJob(record, 'transcribe'); transcribe.disabled = transcribeJob?.status === 'processing' || !segments.length;
  transcribe.addEventListener('click', () => act(transcribe, async () => {
    if ((state.detailDirty || transcriptFields.some(({ field }) => field.value.trim())) && !await dialogs.confirm({ title: '重新本地转写？', message: '重新转写会替换已有转写。', detail: '录音保留，音频不上传；若转写期间继续修订，将保留你的新修订。', confirmLabel: '重新转写' })) return;
    if (state.detailDirty) { toast('请先保存或明确放弃未保存修改，再重新转写。', true); return; }
    const result = await invoke('records:transcribe', { id: record.id }); const job = getJob(result?.record || result, 'transcribe');
    if (job && ['failed', 'unavailable'].includes(job.status)) toast(job.error || '本地转写未完成', true);
    else toast(job?.status === 'not-applied' ? '转写完成，但保留了你的修订文字。' : '本地转写已完成');
    await refresh();
  }));
  discardEdit.addEventListener('click', () => act(discardEdit, async () => { if (!state.detailDirty || await dialogs.confirm({ title: '放弃修改？', message: '放弃当前尚未保存的修改？', detail: '原先保存的内容保留。', confirmLabel: '放弃修改' })) await selectRecord(record.id, { discard: true }); }));
  let titleSaving = false;
  const saveTitleAction = () => { if (titleSaving) return; titleSaving = true; cancelTitle.disabled = true; return act(saveTitle, async () => {
    const snapshot = { revision: titleRevision, title: fieldTitle.value.trim() }; const result = await invoke('records:update', { id: record.id, title: snapshot.title, expectedVersion: baseVersion }); baseVersion = (result?.record || result)?.version ?? baseVersion; titleSavedRevision = Math.max(titleSavedRevision, snapshot.revision);
    if (state.selectedId === record.id) state.detailDirty = titleRevision > titleSavedRevision || nonTitleRevision > nonTitleSavedRevision; notifyDirty();
    if (titleRevision === snapshot.revision) { titleEditor.classList.add('hidden'); rename.classList.remove('hidden'); titleHeading.textContent = snapshot.title || recordTitle(record); }
    if (!state.detailDirty && editor.classList.contains('hidden')) state.editingId = null; toast(state.detailDirty ? '标题已保存，其他修订仍未保存。' : '标题已保存。'); await refresh();
  }).finally(() => { titleSaving = false; if (cancelTitle.isConnected) cancelTitle.disabled = false; }); }; saveTitle.addEventListener('click', saveTitleAction);
  const cancelTitleAction = () => { if (titleSaving) return; return act(cancelTitle, async () => { if (titleRevision > titleSavedRevision && !await dialogs.confirm({ title: '取消重命名？', message: '放弃尚未保存的标题修改？', confirmLabel: '放弃标题修改' })) return; fieldTitle.value = titleStartValue; titleSavedRevision = titleRevision; titleEditor.classList.add('hidden'); rename.classList.remove('hidden'); state.detailDirty = nonTitleRevision > nonTitleSavedRevision; if (!state.detailDirty && editor.classList.contains('hidden')) state.editingId = null; notifyDirty(); await refresh(); }); }; cancelTitle.addEventListener('click', cancelTitleAction);
  fieldTitle.addEventListener('keydown', event => { if (event.key !== 'Enter' && event.key !== 'Escape') return; event.preventDefault(); event.stopPropagation?.(); return event.key === 'Enter' ? saveTitleAction() : cancelTitleAction(); });
  editor.append(words);
  if (hasSummary) { if (record.organizationStale) summaryBody.append(node('p', 'persistent-error', '记录已更新，旧摘要可能过时，请核对原文。')); renderOrganization(summaryBody, record.organization, audio.players, record, { embedded: true }); }
  const toolbar = node('div', 'record-ai-toolbar'); const suggestions = node('div', 'record-group-suggestions'); renderTopicSuggestions(suggestions, record.organization, record); add(toolbar, organize, suggestions);
  add(inner, toolbar, errorNotice, reading, context, audioDetails);
  const more = disclosure('更多操作', 'more', 'record-more-actions'); renderThoughtNavigation(more, record);
  const next = node('button', 'button secondary compact', '接着想 · 开始关联录音'); next.addEventListener('click', () => act(next, async () => { if (state.detailDirty) { toast('请先保存或放弃当前修改。'); return; } const navigationVersion = state.navigationVersion; await invoke('records:continueThought', { id: record.id }); await refresh(); if (navigationVersion !== state.navigationVersion) return; showView('drafts'); const active = state.session?.id; if (active) await openDraft(active); })); more.append(next); more.append(node('p', 'field-help', '新录音会关联这条灵感。'));
  const remove = node('button', 'delete-record', '删除记录及全部关联材料'); remove.addEventListener('click', () => deleteRecord(record, remove, selectionContext)); more.append(remove); inner.append(more); detail.replaceChildren(inner); detail.scrollTop = scrollTop; if (deletingRecords.has(record.id)) lockDeletingDetail(record.id);

}
function screenshotURL(record) { return record.screenshotUrl || record.screenshot?.url || record.context?.screenshotUrl || record.screenshots?.[0]?.url || ''; }
function renderScreenshot(parent, record) {
  const url = screenshotURL(record);
  if (!url) { parent.append(node('p', 'field-help', '这条记录没有来源截图。')); return; }
  const thumbnail = node('button', 'screenshot-thumbnail-button'); thumbnail.type = 'button'; thumbnail.setAttribute('aria-label', '查看来源截图 PNG 原图');
  const image = node('img', 'detail-screenshot'); image.src = url; image.alt = '录音菜单展开前保存的来源窗口截图，点击查看原图'; image.addEventListener('error', () => { thumbnail.replaceChildren(node('p', 'field-help', '缩略图无法读取，请尝试原图或检查文件。')); }); thumbnail.append(image); thumbnail.addEventListener('click', () => openScreenshot(record, url)); parent.append(thumbnail);
  const actions = node('div', 'detail-actions'); const open = node('button', 'button secondary compact', '查看 PNG 原图'); open.addEventListener('click', () => openScreenshot(record, url)); actions.append(open);
  if (!['draft', 'committing'].includes(record.status)) { const reveal = node('button', 'button secondary compact', '打开图片所在文件夹 ↗'); reveal.addEventListener('click', () => revealScreenshot(record.id, reveal)); actions.append(reveal); }
  parent.append(actions);
}
function getJob(record, kind) { return Array.isArray(record?.jobs) ? record.jobs.find(job => job.kind === kind) : record?.jobs?.[kind]; }
function topicChoices(record, onChange) {
  const area = section('记录分组'); const selected = new Set(record.topicIds || record.topics?.map(topic => topic.id) || []);
  if (!state.topics.length) area.append(node('p', 'field-help', '尚未建立分组；可以先保存记录，稍后在“分组管理”中创建。'));
  const search = node('input', 'topic-choice-search'); search.type = 'search'; search.placeholder = '查找分组'; search.setAttribute('aria-label', '查找记录分组'); area.append(search);
  const choices = node('div', 'topic-choices');
  function paint() { choices.replaceChildren(); state.topics.filter(topic => topic.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())).forEach(topic => { const label = node('label', 'topic-choice'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(topic.id); checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(topic.id); else selected.delete(topic.id); onChange(); }); add(label, checkbox, node('span', '', topic.name)); choices.append(label); }); if (!choices.children.length && state.topics.length) choices.append(node('p', 'field-help', '没有匹配的分组。')); } search.addEventListener('input', paint); paint();
  area.append(choices); return { area, ids: () => [...selected] };
}
function renderThoughtNavigation(parent, record) {
  const nav = node('div', 'thought-navigation');
  if (record.parentId) { const original = findRecord(record.parentId); const previous = node('button', 'button secondary compact', '← 上次想法：' + (original ? recordTitle(original) : '打开原记录')); previous.addEventListener('click', () => selectRecord(record.parentId)); nav.append(previous); }
  (record.continuations || []).forEach(next => { const button = node('button', 'button secondary compact', '后续 → ' + (next.title || '继续思考')); button.addEventListener('click', () => selectRecord(next.id)); nav.append(button); });
  if (nav.children.length) parent.append(nav);
}
function renderOrganization(parent, organization, players, record, options = {}) {
  if (options.embedded) {
    const body = node('div', 'organization-body'); const summary = typeof organization === 'string' ? organization : organization.summary; if (summary) body.append(node('p', 'organization-summary', summary));
    if (typeof organization !== 'string' && (organization.evidence?.length || organization.points?.length || organization.ideas?.length || organization.branches?.length || organization.uncertainties?.length || organization.questions?.length || organization.context?.source && organization.context.source !== 'none')) { const evidence = disclosure('查看总结依据', 'summary-evidence'); renderOrganization(evidence, { ...organization, summary: '' }, players, record, { evidenceOnly: true }); body.append(evidence); }
    parent.append(body); return;
  }
  const area = options.evidenceOnly ? node('div', 'summary-evidence-body') : section('思考摘要', 'AI · 可追溯整理');
  if (!options.evidenceOnly) area.append(node('p', 'field-help', '这是一条记录的摘要。原话引用与 AI 推断分开展示；点击引用从对应音频段开头回听。'));
  if (typeof organization === 'string') { area.append(node('p', 'organization-summary', organization)); parent.append(area); return; }
  if (organization.summary) area.append(node('p', 'organization-summary', organization.summary));
  (organization.evidence || []).forEach(item => { const text = typeof item === 'string' ? item : item.quote || item.text; if (!text) return; const entry = players.find(player => player.id === item.segmentId); const quote = node(entry ? 'button' : 'blockquote', 'evidence', (entry ? '摘要依据 · ' : '文字依据（无对应音频）· ') + text); if (entry) quote.addEventListener('click', () => { entry.reveal?.(); entry.player.currentTime = 0; entry.player.play().catch(() => toast('对应音频无法播放，请检查附件。', true)); }); area.append(quote); });
  const points = organization.points || organization.ideas || organization.branches || [];
  points.forEach(point => {
    if (!point) return;
    const card = node('div', 'thought-branch'); card.append(node('p', '', typeof point === 'string' ? point : point.text || point.description || ''));
    const evidence = point.evidence || [];
    evidence.forEach(item => { const text = typeof item === 'string' ? item : item.quote || item.text; if (!text) return; const quote = node('button', 'evidence', '原话依据 · ' + text); const entry = players.find(player => player.id === item.segmentId); quote.disabled = !entry; if (entry) quote.addEventListener('click', () => { entry.reveal?.(); entry.player.currentTime = 0; entry.player.play().catch(() => toast('音频无法开始播放，请检查对应附件。', true)); }); card.append(quote); });
    area.append(card);
  });
  const uncertain = organization.uncertainties || organization.questions || [];
  if (uncertain.length) { area.append(node('h4', '', '尚待确认')); const list = node('ul', 'question-list'); uncertain.forEach(item => list.append(node('li', '', typeof item === 'string' ? item : item.text || item.question))); area.append(list); }
  const context = organization.context;
  if (context && context.source !== 'none') {
    const box = node('div', 'ai-context');
    box.append(node('h4', '', context.source === 'ai_screenshot' ? 'AI 从截图推断的情境 · 待你核对' : '提供给 AI 的情境'));
    [context.application, context.windowTitle, context.visibleUrl, context.description].filter(Boolean).forEach(text => box.append(node('p', '', text)));
    area.append(box);
  }
  parent.append(area);
}

function renderTopicSuggestions(parent, organization, record) {
  const canonical = name => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  const suggestions = (organization?.topicSuggestions || organization?.suggestedTopics || []).map(value => typeof value === 'string' ? value : value?.name).filter(Boolean).map(name => ({ name: name.trim(), topic: state.topics.find(topic => canonical(topic.name) === canonical(name)) }));
  if (!suggestions.length) { parent.append(node('span', 'field-help', '总结后可查看分组建议')); return; }
  parent.append(node('span', 'group-suggestion-label', '分组建议'));
  suggestions.forEach(({ name, topic: existing }) => {
    const button = node('button', 'group-suggestion-button', (existing ? '归入：' : '新建分组：') + (existing?.name || name)); button.setAttribute('data-topic-suggestion-name', existing?.name || name); button.setAttribute('data-topic-suggestion-new', String(!existing));
    const already = existing && (record.topicIds || record.topics?.map(topic => topic.id) || []).includes(existing.id); button.disabled = Boolean(already); if (already) button.textContent = '已在：' + existing.name;
    button.addEventListener('click', () => act(button, async () => {
      if (state.detailDirty) { toast('请先保存或放弃当前编辑，再采用分组建议。'); return; } if (state.topicAdoptBusy) { toast('正在采用上一项建议，请稍后。'); return; }
      if (Array.from(name).length > 60) { toast('建议的分组名超过 60 个字符，请在分组管理中手动创建。', true); return; }
      state.topicAdoptBusy = true; const navigationVersion = state.navigationVersion; const selector = state.detailContext.view === 'duplicates' ? '#group-record-detail' : '#record-detail'; const locked = [...document.querySelectorAll(selector + ' input, ' + selector + ' textarea, ' + selector + ' button')].map(element => ({ element, disabled: element.disabled })); locked.forEach(({ element }) => { element.disabled = true; });
      try {
        let topic = state.topics.find(item => canonical(item.name) === canonical(name));
        if (!topic) { if (!await dialogs.confirm({ title: '创建新分组并归入？', message: '“' + name + '”还不是已有分组。', detail: '确认后创建这个分组，并把这条灵感加入其中。其他分组、原文、截图与录音保留。', confirmLabel: '创建并归入' })) return; const result = await invoke('topics:create', { name }); topic = result?.topic || result; }
        if (!topic?.id) throw new Error('分组创建未完成，请在分组管理中核对。');
        const current = await invoke('records:get', { id: record.id }); const value = current?.record || current; if (!value) throw new Error('这条灵感已不存在。');
        const response = await invoke('records:setTopics', { id: record.id, topicIds: [...new Set([...(value.topicIds || value.topics?.map(item => item.id) || []), topic.id])] }); const updated = response?.record || response;
        if (state.selectedId === record.id && navigationVersion === state.navigationVersion) { state.editingId = null; projectCurrentRecord(updated?.id ? updated : { ...value, topicIds: [...new Set([...(value.topicIds || []), topic.id])] }); }
        await refresh(); toast('已归入“' + topic.name + '”，原始表达保留。');
      } finally { state.topicAdoptBusy = false; locked.forEach(({ element, disabled }) => { if (element.isConnected) element.disabled = disabled; }); }
    })); parent.append(button);
  });
}

function collectFilters() {
  const range = $('#date-range').value || 'all'; const filters = { topicIds: [...state.filters.topicIds] };
  if (state.filters.uncategorized) filters.uncategorized = true;
  if (['7', '30', '365'].includes(range)) { filters.from = Date.now() - Number(range) * 86400000; filters.to = Date.now() + 1; }
  if (range === 'custom') {
    const from = $('#date-from').value; const to = $('#date-to').value;
    if (from) filters.from = new Date(from + 'T00:00:00').getTime();
    if (to) filters.to = new Date(to + 'T00:00:00').getTime() + 86400000;
    if ((from && !Number.isFinite(filters.from)) || (to && !Number.isFinite(filters.to)) || (filters.from && filters.to && filters.from >= filters.to)) throw new Error('请检查自定日期，结束日期应不早于开始日期。');
  }
  return filters;
}
async function loadLibrary({ append = false, ai = false } = {}) {
  if (!ai && state.aiSearching) { try { await cancelAISearch(); } catch (error) { $('#library-status').textContent = '取消旧查询失败：' + error.message; return; } }
  if (ai && (!state.settings.cloudEnabled || !state.settings.aiSearchEnabled)) { $('#library-status').textContent = '需先在偏好设置中明确开启云端 AI 和模糊查找；输入文字本身不会调用模型。'; return; }
  if (ai && !state.query) { toast('先输入你对这段想法的模糊描述。'); return; }
  let filters; try { filters = collectFilters(); } catch (error) { $('#library-status').textContent = error.message; return; }
  if (recordSelection.scope !== recordSelectionScope()) { clearRecordSelection(); renderList(); }
  const request = ++state.requestId; const offset = append ? (state.visibleRecords || []).length : 0;
  state.loading = true; state.aiSearching = ai; $('#ai-search').disabled = true; $('#load-more').disabled = true; $('#cancel-search').classList.toggle('hidden', !ai); $('#retry-library').classList.add('hidden');
  $('#library-status').textContent = ai ? '正在在当前范围内寻找相关想法…可随时取消。' : '正在加载本地记录…';
  try {
    const method = ai ? 'records:aiSearch' : state.query ? 'records:search' : 'records:list';
    const limit = append ? state.limit : Math.max(state.limit, state.reloadVisibleLimit || 0); state.reloadVisibleLimit = 0;
    const result = await invoke(method, ai ? { query: state.query, filters, candidateLimit: 20 } : { query: state.query, filters, limit, offset });
    if (request !== state.requestId) return;
    if (result?.cancelled || result?.canceled) { $('#library-status').textContent = '本次查找已取消。'; return; }
    const records = Array.isArray(result) ? result : result?.records || result?.results;
    if (!Array.isArray(records)) throw new Error('记录列表未能加载，请重试。');
    state.visibleRecords = withRecordProjection(append ? [...(state.visibleRecords || []), ...records.filter(record => !(state.visibleRecords || []).some(item => item.id === record.id))] : records);
    state.total = result.total ?? records.length; state.scopeTotal = result.scopeTotal ?? state.total; state.aiMode = ai; state.filters = filters;
    renderList(); $('#load-more').classList.toggle('hidden', ai || state.visibleRecords.length >= state.total);
    $('#library-status').textContent = ai ? (result.explanation || 'AI 已给出相关候选，请结合原话核对。') + ' 范围内 ' + state.scopeTotal + ' 条，本地候选 ' + (result.candidateCount ?? records.length) + ' 条，本次检查 ' + (result.coverage?.examinedCount ?? 0) + ' 条。' + usageText(result.usage) + (result.fromCache ? '本次复用已有结果。' : '') : state.query ? '范围内 ' + state.scopeTotal + ' 条；关键词匹配 ' + state.total + ' 条。可手动使用 AI 理解近义描述。' : '';
  } catch (error) { if (request === state.requestId) { $('#library-status').textContent = '加载失败：' + error.message; $('#retry-library').classList.remove('hidden'); } }
  finally { if (request === state.requestId) { state.loading = false; state.aiSearching = false; $('#ai-search').disabled = false; $('#load-more').disabled = false; $('#cancel-search').classList.add('hidden'); } }
}
function renderTopics() {
  renderPrimaryGroups();
  const filter = $('#topic-filter-options'); filter.replaceChildren();
  const query = $('#topic-filter-search').value.trim().toLocaleLowerCase();
  state.topics.filter(topic => topic.name.toLocaleLowerCase().includes(query)).forEach(topic => { const label = node('label', 'topic-choice'); const input = node('input'); input.type = 'checkbox'; input.checked = state.filters.topicIds.includes(topic.id); input.setAttribute('data-topic-id', topic.id); input.addEventListener('change', () => { state.filters.topicIds = input.checked ? [...new Set([...state.filters.topicIds, topic.id])] : state.filters.topicIds.filter(id => id !== topic.id); renderTopics(); loadLibrary(); }); add(label, input, node('span', '', topic.name)); filter.append(label); });
  const unknown = state.filters.topicIds.filter(id => !state.topics.some(topic => topic.id === id));
  if (unknown.length) filter.append(node('p', 'persistent-error', '已选分组已删除；请重新选择范围，当前不会自动扩大到全部分组。'));
  if (!filter.children.length) filter.append(node('p', 'field-help', state.topics.length ? '没有匹配的分组。' : '还没有分组，可在“分组管理”中创建。'));
  $('#filter-unclassified').checked = Boolean(state.filters.uncategorized);
  const names = state.filters.topicIds.map(id => state.topics.find(topic => topic.id === id)?.name || '已删除分组'); if (state.filters.uncategorized) names.push('未分类');
  $('#topic-filter-label').textContent = names.length ? names.join('、') : '全部分组';
  const fingerprint = JSON.stringify(state.topics.map(topic => [topic.id, topic.name])); if (fingerprint === state.topicFingerprint) return; state.topicFingerprint = fingerprint;
  renderTopicManagement();
}
function renderTopicManagement() {
  const available = new Set(state.topics.map(topic => topic.id)); topicManagement.ids = new Set([...topicManagement.ids].filter(id => available.has(id)));
  const manager = $('#topic-management-list'); manager.replaceChildren();
  state.topics.forEach(topic => {
    const row = node('div', 'topic-manager-row'); row.setAttribute('data-topic-manage-id', topic.id);
    const check = node('input', 'topic-manager-check'); check.type = 'checkbox'; check.setAttribute('data-topic-select-id', topic.id); check.setAttribute('aria-label', '选择分组 ' + topic.name);
    check.addEventListener('change', () => { if (!topicManagement.mode || topicManagement.busy) return; if (check.checked) topicManagement.ids.add(topic.id); else topicManagement.ids.delete(topic.id); updateTopicManagementControls(); });
    const name = node('input', 'topic-manager-name'); name.value = topic.name; name.title = topic.name; name.maxLength = 60; name.setAttribute('aria-label', '修改分组 ' + topic.name);
    const rename = node('button', 'button secondary compact', '改名'); rename.addEventListener('click', () => topicMutation(rename, 'topics:rename', { id: topic.id, name: name.value.trim() }));
    add(row, check, name, rename); manager.append(row);
  });
  if (!state.topics.length) manager.append(node('p', 'field-help', '还没有分组。'));
  updateTopicManagementControls();
}
function updateTopicManagementControls() {
  const { mode, ids, busy, writing } = topicManagement; const selecting = Boolean(mode);
  $('#topic-management-selection').classList.toggle('hidden', !selecting);
  $('#merge-topic-groups').disabled = busy || state.topics.length < 2; $('#delete-topic-groups').disabled = busy || !state.topics.length;
  $('#merge-topic-groups').classList.toggle('active', mode === 'merge'); $('#delete-topic-groups').classList.toggle('active', mode === 'delete');
  $('#topic-selection-count').textContent = '已选 ' + ids.size + ' 个分组';
  $('#select-all-topic-groups').disabled = busy; $('#select-all-topic-groups').textContent = ids.size === state.topics.length && ids.size ? '取消全选' : '全选';
  $('#apply-topic-selection').disabled = busy || ids.size < (mode === 'merge' ? 2 : 1); $('#apply-topic-selection').textContent = writing ? '处理中…' : mode === 'merge' ? '下一步' : '删除所选';
  $('#cancel-topic-selection').disabled = busy; $('#close-group-management').disabled = writing; $('#create-topic').disabled = selecting || busy; $('#new-topic-name').disabled = selecting || busy;
  for (const row of $('#topic-management-list').children) {
    const id = row.getAttribute('data-topic-manage-id'); if (!id) continue;
    const [check, name, rename] = row.children; check.classList.toggle('hidden', !selecting); check.checked = ids.has(id); check.disabled = busy; name.disabled = selecting || busy; rename.disabled = selecting || busy; row.classList.toggle('selected', selecting && ids.has(id));
  }
}
function beginTopicSelection(mode) {
  if (topicManagement.busy || state.topics.length < (mode === 'merge' ? 2 : 1)) return;
  topicManagement.mode = mode; topicManagement.ids.clear(); topicManagement.revision += 1;
  $('#topic-management-status').textContent = mode === 'merge' ? '选择要合并的分组，再选择保留的分组名称。' : '选择要删除的分组。灵感和附件会保留。'; updateTopicManagementControls();
}
function cancelTopicSelection(force = false) {
  if (topicManagement.writing || topicManagement.busy && !force) return false;
  topicManagement.revision += 1; topicManagement.mode = null; topicManagement.ids.clear(); topicManagement.busy = false;
  window.InMomentGroupPicker?.close?.(); window.InMomentConfirm?.close?.(); $('#topic-management-status').textContent = ''; updateTopicManagementControls(); return true;
}
async function applyTopicSelection() {
  if (topicManagement.busy || !topicManagement.mode) return;
  const mode = topicManagement.mode; const ids = state.topics.filter(topic => topicManagement.ids.has(topic.id)).map(topic => topic.id);
  if (ids.length < (mode === 'merge' ? 2 : 1)) return;
  const revision = ++topicManagement.revision, anchor = $('#apply-topic-selection'); const selected = state.topics.filter(topic => ids.includes(topic.id));
  topicManagement.busy = true; updateTopicManagementControls();
  try {
    let target;
    if (mode === 'merge') {
      target = await window.InMomentGroupPicker.open({ anchor, topics: selected, selectedIds: [], title: '选择合并后保留的分组名称' });
      if (revision !== topicManagement.revision || !target?.id || !ids.includes(target.id)) return;
    }
    const approved = await window.InMomentConfirm.open({ anchor, title: mode === 'merge' ? '合并所选分组？' : '删除所选分组？', message: mode === 'merge' ? '将 ' + ids.length + ' 个分组合并为“' + target.name + '”。' : '删除选中的 ' + ids.length + ' 个分组？', detail: mode === 'merge' ? '组内灵感会集中到这个分组，重复关联只保留一份。原文和附件保留。' : '仅移除分组。灵感和附件保留；没有其他分组的灵感会回到未分类。', confirmLabel: mode === 'merge' ? '确认合并' : '删除分组', danger: mode === 'delete' });
    if (!approved || revision !== topicManagement.revision) return;
    topicManagement.writing = true; updateTopicManagementControls();
    await invoke(mode === 'merge' ? 'topics:mergeMany' : 'topics:deleteMany', mode === 'merge' ? { topicIds: ids, targetId: target.id } : { topicIds: ids });
    const removed = new Set(ids.filter(id => id !== target?.id));
    if (removed.has(state.libraryGroupId)) { state.libraryGroupId = target?.id || 'uncategorized'; state.filters = groupFilters(state.libraryGroupId); state.recordProjection = null; }
    else { const selectedRemoved = state.filters.topicIds.some(id => removed.has(id)); state.filters.topicIds = state.filters.topicIds.filter(id => !removed.has(id)); if (target && selectedRemoved && !state.filters.topicIds.includes(target.id)) state.filters.topicIds.push(target.id); }
    topicManagement.mode = null; topicManagement.ids.clear(); state.topicFingerprint = null;
    await refresh(); $('#topic-management-status').textContent = mode === 'merge' ? '已合并为“' + target.name + '”。' : '已删除 ' + ids.length + ' 个分组，灵感已保留。';
  } catch (error) { $('#topic-management-status').textContent = error.message || '分组未能更新，请重试。'; }
  finally { if (revision === topicManagement.revision) { topicManagement.busy = false; topicManagement.writing = false; updateTopicManagementControls(); } }
}
function validTopicName(name) { if (!name || name.length > 60) { $('#topic-management-status').textContent = '分组名称请填写 1–60 个字符。'; return false; } return true; }
async function topicMutation(button, method, params) { if (topicManagement.mode || topicManagement.busy || method === 'topics:rename' && !validTopicName(params.name)) return; return act(button, async () => { try { await invoke(method, params); $('#topic-management-status').textContent = '分组已更新，原始记录保留。'; await refresh(); } catch (error) { $('#topic-management-status').textContent = error.message; throw error; } }); }
function usageText(usage) { if (!usage) return ''; const total = usage.total_tokens ?? usage.totalTokens ?? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)); const unknown = Number(usage.unknownUsageRequests || 0); return (Number.isFinite(total) ? (unknown ? ' 已知用量 ' : ' 本次 ') + total + ' tokens。' : '') + (unknown ? '另有 ' + unknown + ' 次请求未取得用量，仍可能计费。' : ''); }

function searchError(message) { const target = $('#ai-search-error'); target.textContent = message; target.classList.toggle('hidden', !message); }
function openAISearch() { clearTimeout(searchTimer); $('#ai-search-description').value = $('#search-input').value.trim(); $('#ai-search-scope').value = 'all'; searchError(''); if (!$('#ai-search-dialog').open) $('#ai-search-dialog').showModal(); $('#ai-search-description').focus(); }
function dateInput(value) { const date = new Date(value); return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); }
function showAppliedDates(filters) { $('#date-range').value = filters.from !== undefined || filters.to !== undefined ? 'custom' : 'all'; $('#date-from').value = filters.from !== undefined ? dateInput(filters.from) : ''; $('#date-to').value = filters.to !== undefined ? dateInput(filters.to - 1) : ''; $('#custom-dates').classList.toggle('hidden', $('#date-range').value !== 'custom'); }
async function runAISearch() {
  const query = $('#ai-search-description').value.trim(); searchError('');
  if (!query) { searchError('请先描述你记得的内容。'); $('#ai-search-description').focus(); return; }
  if (state.detailDirty) { searchError('请先保存或放弃当前记录的修改，再开始查找。'); return; }
  if (state.batchBusy) { searchError('当前页面正在整理，请先完成或取消整理。'); return; }
  if (!state.settings.cloudEnabled || !state.settings.aiSearchEnabled) { searchError('请先在偏好设置中开启云端 AI 和 AI 查找。'); return; }
  if (state.aiSearching) return;
  const scope = $('#ai-search-scope').value === 'current' ? 'current' : 'all'; const filters = scope === 'current' ? groupFilters(state.libraryGroupId) : {}; const navigationVersion = state.navigationVersion; const request = ++state.requestId;
  clearTimeout(searchTimer); state.aiSearching = true; state.loading = true; $('#submit-ai-search').disabled = true; $('#cancel-search').classList.remove('hidden'); $('#library-status').textContent = '正在按你的描述查找…';
  try {
    const result = await invoke('records:aiSearch', { query, filters, candidateLimit: 20 }); if (request !== state.requestId) return;
    if (result?.cancelled || result?.canceled) { searchError('本次查找已取消。'); return; }
    if (!Array.isArray(result?.records)) throw new Error('查找结果不可用，请重试。');
    state.query = query; $('#search-input').value = query; state.recordProjection = null; state.aiMode = true; state.aiResultScope = scope; state.filters = { topicIds: [], ...(result.appliedFilters || filters) }; state.aiScopeDescription = result.scopeDescription || (scope === 'all' ? '全部灵感 · 全部时间' : primaryGroupName() + ' · 全部时间'); showAppliedDates(state.filters);
    state.visibleRecords = result.records; state.total = result.total ?? result.records.length; state.scopeTotal = result.scopeTotal ?? result.records.length; state.libraryMode = 'home'; state.selectedId = null; state.editingId = null; notifyDirty(); renderTopics(); renderList(); $('#load-more').classList.add('hidden');
    $('#library-status').textContent = '已应用范围：' + state.aiScopeDescription + '。' + (result.explanation || '') + ' 找到 ' + result.records.length + ' 条；范围内 ' + state.scopeTotal + ' 条，本次检查 ' + (result.coverage?.examinedCount ?? result.candidateCount ?? 0) + ' 条。' + usageText(result.usage);
    $('#ai-search-dialog').close(); if (navigationVersion === state.navigationVersion) showView('inbox');
  } catch (error) { if (request === state.requestId) { searchError(error.message || '查找未完成，请重试。'); $('#library-status').textContent = 'AI 查找失败：' + error.message; } }
  finally { if (request === state.requestId) { state.aiSearching = false; state.loading = false; $('#submit-ai-search').disabled = false; $('#cancel-search').classList.add('hidden'); } }
}
async function cancelAISearch() { if (!state.aiSearching) return; await invoke('library:cancel', { kind: 'search' }); state.requestId += 1; state.aiSearching = false; state.loading = false; $('#submit-ai-search').disabled = false; $('#ai-search').disabled = false; $('#cancel-search').classList.add('hidden'); $('#library-status').textContent = '已取消查找；已发送部分无法撤回，仍可能产生费用。'; }
function batchStatus(message, error = false) { $('#batch-status').textContent = message; $('#batch-status').classList.toggle('persistent-error', error); }
function captureBatchSnapshot() {
  const records = new Map((state.visibleRecords || []).map(record => [record.id, record])); const ids = [...new Set(Array.from($('#record-list').children).map(card => card.getAttribute('data-record-id')).filter(Boolean))];
  if (!ids.length) throw new Error('当前页没有可整理的灵感。'); if (ids.length > 100) throw new Error('当前页超过 100 条，请先缩小范围或分批显示；本次尚未开始。');
  return ids.map(id => { const record = records.get(id); if (!record || !Number.isSafeInteger(record.version)) throw new Error('部分记录版本不可用，请刷新页面后再整理。'); return { id, version: record.version, title: recordTitle(record), summary: record.organization?.summary || transcriptText(record) }; });
}
function batchProgress(event) {
  if (!state.batchBusy || state.batchCancelRequested || event.total !== state.batchSnapshot.length || state.batchRunId && state.batchRunId !== event.runId) return; if (event.recordId && !state.batchSnapshot.some(item => item.id === event.recordId)) return;
  state.batchRunId = event.runId; batchStatus(event.status === 'grouping' ? '正在为本次灵感整理分组…' : '正在整理本次选定的 ' + event.total + ' 条：' + (event.completed || 0) + ' / ' + event.total + ' 已完成');
}
async function runBatchOrganize() {
  if (state.batchBusy) return; if (state.aiSearching) { batchStatus('请先完成或取消 AI 查找。', true); return; } if (state.detailDirty) { batchStatus('请先保存或放弃当前修改，再整理当前页。', true); return; }
  let snapshot; try { snapshot = captureBatchSnapshot(); } catch (error) { batchStatus(error.message, true); return; }
  state.batchSnapshot = snapshot; state.batchBusy = true; state.batchRunId = null; state.batchCancelRequested = false; state.batchResultItems = []; state.batchChoices.clear(); $('#batch-organize').disabled = true; $('#cancel-batch').disabled = false; $('#cancel-batch').classList.remove('hidden'); batchStatus('正在整理点击时当前页的 ' + snapshot.length + ' 条灵感…');
  try {
    const result = await invoke('library:batchOrganize', { recordIds: snapshot.map(item => item.id), expectedVersions: Object.fromEntries(snapshot.map(item => [item.id, item.version])) });
    if (state.batchCancelRequested || result?.cancelled || result?.canceled) { batchStatus('已取消后续整理。'); return; }
    if (!Array.isArray(result?.items)) throw new Error('整理结果不可用，请重试。');
    const groupingError = result.grouping?.error ? String(result.grouping.error) : '';
    state.batchRunId = result.runId || state.batchRunId; state.batchResultItems = snapshot.map(item => { const value = result.items.find(value => value.id === item.id) || { status: 'not-processed', error: '本次未处理这条记录。' }; return { ...item, ...value, ...(groupingError ? { topicSuggestions: [] } : {}) }; }); initializeBatchChoices();
    const extra = result.items.some(item => !snapshot.some(record => record.id === item.id)); const successful = state.batchResultItems.filter(item => item.status === 'success').length; const groupCount = new Set([...state.batchChoices.values()].map(batchTopicKey)).size; const pendingCount = state.batchResultItems.filter(item => item.status === 'success' && !state.batchChoices.has(item.id)).length;
    const outcome = '本次 ' + snapshot.length + ' 条，已整理 ' + successful + ' 条，推荐 ' + groupCount + ' 个分组。'; batchStatus(outcome + (groupingError ? '摘要已保留，分组未完成。' : '') + usageText(result.usage), Boolean(groupingError));
    $('#batch-results-status').textContent = outcome + (pendingCount ? pendingCount + ' 条暂不分组。' : '') + (successful < snapshot.length ? snapshot.length - successful + ' 条未完成。' : '') + (groupingError ? '统一分组未完成：' + groupingError + ' 摘要已保留，尚未新建分组。' : '按分组检查，确认后才会应用。') + (extra ? '范围外的返回项已忽略。' : ''); $('#batch-results-status').classList.toggle('persistent-error', Boolean(groupingError)); renderBatchResults(); if (!$('#batch-results-dialog').open) $('#batch-results-dialog').showModal();
  } catch (error) { if (state.batchCancelRequested) batchStatus('已取消后续整理。'); else batchStatus('整理失败：' + error.message, true); }
  finally { state.batchBusy = false; $('#batch-organize').disabled = false; $('#cancel-batch').classList.add('hidden'); state.reloadVisibleLimit = Math.min(100, Math.max(state.limit, state.visibleRecords?.length || 0)); try { await refresh(); } catch (error) { batchStatus('整理结果已保留，刷新页面失败：' + error.message, true); } }
}
async function cancelBatchOrganize(button) {
  if (!state.batchBusy || state.batchCancelRequested) return;
  const snapshot = state.batchSnapshot; const runId = state.batchRunId;
  const matchesRun = () => state.batchSnapshot === snapshot && state.batchRunId === runId;
  state.batchCancelRequested = true; if (button) button.disabled = true; batchStatus('正在取消…');
  try {
    await invoke('library:cancel', { kind: 'batchOrganize', ...(runId ? { runId } : {}) });
    if (state.batchBusy && matchesRun()) batchStatus('已取消后续整理。');
  } catch (error) {
    if (state.batchBusy && matchesRun()) { state.batchCancelRequested = false; toast(error.message || '取消未完成，请重试。', true); }
  } finally { if (matchesRun() && button?.isConnected) button.disabled = false; }
}
function batchTopicKey(name) { return String(name || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN'); }
function batchSuggestionNames(item) {
  const known = new Map(state.topics.map(topic => [batchTopicKey(topic.name), topic.name])); const names = new Map();
  (item.topicSuggestions || item.record?.organization?.topicSuggestions || []).forEach(value => { const name = String(typeof value === 'string' ? value : value?.name || '').trim(); const key = batchTopicKey(name); if (key && !names.has(key)) names.set(key, known.get(key) || name); });
  return [...names.values()];
}
function initializeBatchChoices() {
  state.batchChoices.clear(); (state.batchResultItems || []).forEach(item => { if (item.status !== 'success' || item.applied) return; const name = batchSuggestionNames(item)[0]; if (name) state.batchChoices.set(item.id, name); });
}
function batchPickerChoices() {
  const known = new Map(state.topics.map(topic => [batchTopicKey(topic.name), topic])); const names = new Map();
  [...(state.batchResultItems || []).flatMap(batchSuggestionNames), ...state.batchChoices.values()].forEach(name => { const key = batchTopicKey(name); if (key && !names.has(key)) names.set(key, known.get(key) || { id: 'batch:new:' + name, name }); });
  return [...names.values()];
}
function batchSingleLine(value) { return String(value || '').replace(/\s+/gu, ' ').trim(); }
async function adjustBatchGroup(item, anchor) {
  if (state.batchApplying || item.applied || item.status !== 'success') return;
  const action = await window.InMomentMenus.open({ anchor, items: [{ id: 'cancel', label: '取消分组' }, { id: 'change', label: '修改分组' }] });
  if (!state.batchResultItems.includes(item) || item.applied || state.batchApplying) return;
  if (action === 'cancel') { state.batchChoices.delete(item.id); renderBatchResults(); return; }
  if (action !== 'change') return;
  const choices = batchPickerChoices(); const selectedName = state.batchChoices.get(item.id); const selected = [...state.topics, ...choices].find(topic => batchTopicKey(topic.name) === batchTopicKey(selectedName));
  const target = await window.InMomentGroupPicker.open({ anchor, topics: state.topics, choices, selectedIds: selected ? [selected.id] : [], multiple: false, title: '修改分组' });
  if (!target || !state.batchResultItems.includes(item) || item.applied || state.batchApplying) return;
  const known = state.topics.find(topic => batchTopicKey(topic.name) === batchTopicKey(target.name)); const name = String(known?.name || target.name || '').trim();
  if (name) state.batchChoices.set(item.id, name); renderBatchResults();
}
function renderBatchResults() {
  const list = $('#batch-results-list'); list.replaceChildren(); const groups = new Map();
  (state.batchResultItems || []).forEach(item => {
    const name = item.applied || (item.status === 'success' ? state.batchChoices.get(item.id) : ''); const kind = name ? 'named' : item.status === 'success' ? 'pending' : item.status || 'failed';
    const label = name || ({ pending: '暂不分组', failed: '未完成', cancelled: '已取消', 'not-processed': '本次未处理' }[kind]) || '未完成'; const key = name ? 'named:' + batchTopicKey(name) : kind;
    if (!groups.has(key)) groups.set(key, { label, kind, items: [] }); groups.get(key).items.push(item);
  });
  const ordered = [...groups.values()].sort((a, b) => Number(a.kind !== 'named') - Number(b.kind !== 'named'));
  ordered.forEach(group => {
    const section = node('section', 'batch-result-group'); section.setAttribute('data-batch-group-name', group.label); section.setAttribute('data-batch-group-kind', group.kind);
    const heading = node('h3', 'batch-group-heading'); heading.title = group.label; add(heading, node('span', 'batch-group-name', group.label), node('span', 'batch-group-count', group.items.length + ' 条')); section.append(heading); const records = node('div', 'batch-group-records'); section.append(records);
    group.items.forEach(item => {
      const title = batchSingleLine(item.record?.title || item.title || recordTitle(item.record || {})); const row = node('article', 'batch-result-item'); row.setAttribute('data-batch-record-id', item.id); const copy = node('div', 'batch-record-copy'); row.append(copy);
      const name = node('h4', 'batch-result-heading', title); name.title = title; copy.append(name);
      const summary = batchSingleLine(item.record?.organization?.summary || item.summary || transcriptText(item.record || {})); const brief = node('p', 'batch-summary', summary || '暂无简要信息'); brief.title = summary || '暂无简要信息'; copy.append(brief);
      if (item.applied) { const badge = node('span', 'batch-applied', '已应用'); row.append(badge); }
      else if (item.status === 'success') { const menu = node('button', 'batch-result-menu', '×'); menu.setAttribute('aria-label', '调整“' + title + '”的分组'); menu.title = '调整分组'; menu.disabled = Boolean(state.batchApplying); menu.addEventListener('click', () => act(menu, () => adjustBatchGroup(item, menu))); row.append(menu); }
      else { const message = batchSingleLine(item.error?.message || item.error || ({ cancelled: '已取消', 'not-processed': '本次未处理' }[item.status]) || '整理失败'); const error = node('p', 'batch-result-status persistent-error', message); error.title = message; copy.append(error); }
      records.append(row);
    }); list.append(section);
  }); $('#apply-batch-groups').disabled = Boolean(state.batchApplying) || !state.batchChoices.size;
}
async function applyBatchGroups() {
  if (state.batchApplying) return;
  if (state.detailDirty) { $('#batch-results-status').textContent = '请先保存或放弃当前记录的修改，再应用分类；所选建议会保留。'; return; }
  const choices = [...state.batchChoices].filter(([id]) => state.batchResultItems.some(item => item.id === id && item.status === 'success' && !item.applied)); if (!choices.length) { $('#batch-results-status').textContent = '先为需要分类的记录选择一项分组建议。'; return; }
  const newNames = [...new Set(choices.map(([, name]) => name).filter(name => !state.topics.some(topic => topic.name === name)))];
  // Hold this guard while the confirmation is pending as well as during writes.
  state.batchApplying = true; renderBatchResults();
  try {
    if (!await dialogs.confirm({ title: '应用所选分类？', message: '将为 ' + choices.length + ' 条灵感添加你选定的分组。', detail: (newNames.length ? '将新建：' + newNames.join('、') + '。\n' : '') + '其他分组关系、原文、截图与录音保留；只处理本次结果中的记录。', confirmLabel: '确认应用分类' })) return;
    const navigationVersion = state.navigationVersion; const created = new Map(state.topics.map(topic => [topic.name, topic])); let completed = 0;
    for (const [id, name] of choices) {
      const item = state.batchResultItems.find(record => record.id === id); if (!item) continue;
      try {
        const response = await invoke('records:get', { id }); const record = response?.record || response; if (!record) throw new Error('记录已不存在。'); const expected = item.record?.version ?? item.version; if (expected !== undefined && record.version !== expected) throw new Error('内容已更新，请重新整理后再分类。'); const expectedVersion = record.version;
        let topic = created.get(name); if (!topic) { if (!name.trim() || Array.from(name).length > 60) throw new Error('建议的分组名称无效，请手动创建。'); const value = await invoke('topics:create', { name }); topic = value?.topic || value; if (!topic?.id) throw new Error('分组未能创建。'); created.set(name, topic); }
        const value = await invoke('records:setTopics', { id, expectedVersion, topicIds: [...new Set([...(record.topicIds || record.topics?.map(topic => topic.id) || []), topic.id])] }); const updated = value?.record || value; if (navigationVersion === state.navigationVersion && state.selectedId === id) projectCurrentRecord(updated?.id ? updated : { ...record, topicIds: [...new Set([...(record.topicIds || []), topic.id])] });
        item.applied = name; state.batchChoices.delete(id); completed += 1;
      } catch (error) { item.error = '分类未完成：' + error.message; item.status = 'failed'; state.batchChoices.delete(id); }
    }
    $('#batch-results-status').textContent = '已为 ' + completed + ' 条灵感应用分类；失败项已逐条标明，原始资料保留。'; state.reloadVisibleLimit = Math.min(100, Math.max(state.limit, state.visibleRecords?.length || 0)); await refresh();
  } finally { state.batchApplying = false; renderBatchResults(); }
}

function renderSettings() {
  const settings = state.settings;
  $('#input-enabled').checked = settings.inputEnabled !== false;
  $('#capture-screenshots').checked = settings.captureScreenshots !== false;
  $('#threshold-input').value = settings.thresholdMs || settings.holdThresholdMs || 550;
  $('#preview-delay-input').value = settings.previewDelayMs ?? 0;
  $('#capture-delay-input').value = settings.captureDelayMs ?? 0;
  $('#menu-delay-input').value = settings.menuDelayMs ?? 0;
  $('#keyboard-trigger-input').value = ['F8', 'F9', 'F10'].includes(settings.keyboardTrigger) ? settings.keyboardTrigger : 'none';
  $('#excluded-apps').value = Array.isArray(settings.excludedApps) ? settings.excludedApps.join('\n') : settings.excludedApps || '';
  $('#cloud-enabled').checked = Boolean(settings.cloudEnabled);
  $('#direct-ai-enabled').checked = Boolean(settings.directAIEnabled);
  $('#auto-title-enabled').checked = Boolean(settings.autoTitleEnabled);
  $('#ai-search-enabled').checked = Boolean(settings.aiSearchEnabled);
  $('#screenshot-analysis-enabled').checked = Boolean(settings.screenshotAnalysisEnabled);
  $('#model-input').value = settings.model || 'deepseek-flash';
  $('#api-key').value = '';
  $('#key-status').textContent = settings.hasApiKey ? '已安全保存' : '未设置';
  $('#api-key').placeholder = settings.hasApiKey ? '已保存密钥；留空保持不变' : '输入密钥，保存后不再显示';
  updateTimingTimeline();
  renderCapabilities();
  state.settingsDirty = false;
  notifyDirty();
}
function timingValues() {
  return {
    previewDelayMs: Number($('#preview-delay-input').value),
    thresholdMs: Number($('#threshold-input').value),
    captureDelayMs: Number($('#capture-delay-input').value),
    menuDelayMs: Number($('#menu-delay-input').value),
    keyboardTrigger: $('#keyboard-trigger-input').value,
  };
}
function updateTimingTimeline() {
  const timing = timingValues();
  const valid = [timing.previewDelayMs, timing.thresholdMs, timing.captureDelayMs, timing.menuDelayMs].every(Number.isFinite);
  if (!valid) { $('#timing-timeline').textContent = '填写有效的毫秒数后，将在这里显示阶段时间线。'; return; }
  const showAt = Math.max(0, timing.previewDelayMs); const confirmAt = showAt + Math.max(0, timing.thresholdMs);
  const trigger = ['F8', 'F9', 'F10'].includes(timing.keyboardTrigger) ? `右键或 ${timing.keyboardTrigger}` : '右键';
  $('#timing-timeline').textContent = `按下${trigger} → ${showAt} ms 显示进度条 → ${confirmAt} ms 确认触发 → 再等 ${Math.max(0, timing.captureDelayMs)} ms 截图 → 截图处理后再等 ${Math.max(0, timing.menuDelayMs)} ms 展开菜单`;
}
function resetTimingForm() {
  $('#preview-delay-input').value = 0; $('#threshold-input').value = 550; $('#capture-delay-input').value = 0; $('#menu-delay-input').value = 0; $('#keyboard-trigger-input').value = 'none';
  updateTimingTimeline(); $('#timing-result').textContent = '已恢复表单中的默认时序，保存后生效。';
  markSettingsDirty();
}
function markSettingsDirty() { state.settingsRevision += 1; state.settingsDirty = true; notifyDirty(); $('#settings-result').textContent = '有未保存设置；离开此页不会丢失表单'; }
function renderCapabilities() {
  const capabilities = state.capabilities; const status = $('#capability-status'); status.replaceChildren();
  const label = node('strong', '', '桌面能力状态'); status.append(label);
  const hook = capabilities.nativeAvailable ?? capabilities.globalHook ?? capabilities.rightButtonHook ?? capabilities.mouseHook ?? capabilities.nativeHook;
  status.append(node('div', '', state.settings.inputEnabled === false ? '全局长按已关闭；可使用左侧手动录音入口。' : hook === false ? '全局按键监听当前不可用，可先使用左侧手动录音入口。' : hook === true ? `全局监听已就绪。可长按右键${['F8', 'F9', 'F10'].includes(state.settings.keyboardTrigger) ? `或 ${state.settings.keyboardTrigger}` : ''}触发。` : '以原生模块启动状态为准；也可使用手动录音入口。'));
  const offlineASR = capabilities.offlineASR;
  status.append(node('div', '', offlineASR?.available ? `本地转写：${offlineASR.provider || 'whisper.cpp'} · ${offlineASR.model || 'base'}（音频不上传）` : capabilities.asrStatus === 'checking' ? '正在检测 whisper.cpp 本地语音模型…' : 'whisper.cpp 本地模型暂未就绪，可在记录详情中手动补充转写。'));
  if (capabilities.localCleanupError) status.append(node('div', 'privacy-note', '部分转写临时文件尚未清理，请退出应用并检查本地目录权限后重试。'));
}
function sessionState(session) { return session?.state || session?.status || 'idle'; }
function renderSession(session) {
  state.session = session; const status = sessionState(session); const active = Boolean(session && session.active !== false && !['idle', 'saved', 'completed', 'discarded'].includes(status)); $('#session-banner').classList.toggle('hidden', !active);
  const paused = status === 'paused'; const recording = status === 'recording'; const mode = session?.mode || session?.triggerMode;
  $('#session-title').textContent = paused ? '想法已暂停，等待你的决定' : status === 'error' ? '录音遇到问题' : status === 'preparing' ? '正在准备录音…' : '正在留下这段想法';
  $('#session-description').textContent = session?.error?.message || session?.error || (paused ? '草稿尚未完成；可继续、完成保存或删除。' : mode === 'hold' ? `首次录音 · 松开 ${triggerLabel(session?.triggerKey)} 自动暂停` : '手动录音 · 点击暂停结束这一段');
  $('#session-pause').classList.toggle('hidden', !recording || mode === 'hold'); $('#session-continue').classList.toggle('hidden', !paused); $('#session-finish').classList.toggle('hidden', !paused);
  for (const selector of ['#session-pause', '#session-continue', '#session-finish', '#session-discard']) $(selector).disabled = status === 'processing' || state.draftBusy;
  $('#draft-count').textContent = Math.max(state.drafts.length, active ? 1 : 0);
  if (state.view === 'drafts') renderDrafts();
}
function activeSession() { return state.session?.active !== false && !['idle', 'saved', 'completed', 'discarded'].includes(sessionState(state.session)) && Boolean(state.session?.id); }
function mergedDrafts() {
  const items = state.drafts.map(draft => state.session?.id === draft.id && activeSession() ? { ...draft, ...state.session, title: draft.title, audioSegments: draft.audioSegments, screenshotUrl: draft.screenshotUrl, topics: draft.topics, topicIds: draft.topicIds } : { ...draft, state: draft.status === 'committing' ? 'processing' : 'paused' });
  if (activeSession() && !items.some(draft => draft.id === state.session.id)) items.unshift(state.session);
  return items;
}
function draftActions(parent, draft) {
  const status = sessionState(draft); const activeOther = activeSession() && state.session.id !== draft.id;
  const actions = node('div', 'detail-actions');
  if (status === 'recording' && draft.mode === 'manual') { const pause = node('button', 'button primary compact', '暂停'); pause.addEventListener('click', () => sessionAction('draft:pause', pause, draft.id)); pause.disabled = state.draftBusy; actions.append(pause); }
  if (status === 'recording' && draft.mode === 'hold') parent.append(node('p', 'field-help', '松开 ' + triggerLabel(draft.triggerKey) + ' 后自动暂停。'));
  [['删除', 'draft:discard', 'secondary'], ['继续录音', 'draft:continue', 'secondary'], ['完成记录', 'draft:finish', 'primary']].forEach(([label, method, style]) => {
    const button = node('button', 'button ' + style + ' compact', label);
    button.disabled = state.draftBusy || status === 'processing' || (method !== 'draft:discard' && (status !== 'paused' || activeOther));
    button.addEventListener('click', () => act(button, async () => { if (method === 'draft:discard' && state.session?.id !== draft.id && segmentList(draft).length && !await dialogs.confirm({ title: '删除历史草稿？', message: '删除这条历史草稿及全部截图、录音？', detail: '此操作无法撤销。', confirmLabel: '删除草稿', danger: true })) return; await sessionAction(method, button, draft.id); })); actions.append(button);
  }); parent.append(actions);
  if (activeOther) parent.append(node('p', 'field-help', '先完成或删除当前正在记录的草稿，才能恢复这一条。可先预览已有内容。'));
  if (status === 'preparing') parent.append(node('p', 'field-help', '正在准备截图或麦克风，尚未开始的采集可通过松开按键取消。'));
  if (status === 'processing') parent.append(node('p', 'field-help', '正在提交，完成后可在收件箱操作。'));
}
function renderDrafts() {
  const list = $('#draft-list'); list.replaceChildren(); const items = mergedDrafts(); $('#draft-count').textContent = items.length;
  if (!items.length) { list.append(emptyState('这里暂时没有未完成的想法', '新草稿会先在本机保管。完成后进入收件箱。', 'list-empty')); if (!state.selectedDraftId) $('#draft-detail').replaceChildren(emptyState('选择一条草稿预览', '查看现场与录音后，再决定如何处理。', 'detail-empty')); return; }
  items.forEach(draft => {
    const card = node('article', 'draft-card'); card.classList.toggle('selected', draft.id === state.selectedDraftId);
    const open = node('button', 'draft-open', draft.title || '一段还在发生的想法'); open.setAttribute('aria-label', '预览草稿：' + (draft.title || '未命名')); open.addEventListener('click', () => openDraft(draft.id));
    const labels = { recording: '录音中', preparing: '准备中', paused: '已暂停 / 可恢复', processing: '正在提交' };
    add(card, open, node('p', '', formatDate(draft.createdAt) + ' · ' + (labels[sessionState(draft)] || '可恢复')), node('p', '', contextText(draft)));
    draftActions(card, draft); list.append(card);
  });
}
async function openDraft(id, options = {}) {
  const navigationVersion = options.passive ? state.navigationVersion : ++state.navigationVersion;
  if (state.draftTopicDirty && state.selectedDraftId === id && !options.force) { const actions = $('#draft-preview-actions'); actions.replaceChildren(); const draft = mergedDrafts().find(item => item.id === id); if (draft) draftActions(actions, draft); return; }
  if (state.draftTopicDirty && !await dialogs.confirm({ title: '切换草稿预览？', message: '草稿分组尚未保存。', detail: '切换将放弃这些分组修改，原始录音与截图保留。', confirmLabel: '放弃修改并切换' })) return;
  state.draftTopicDirty = false; notifyDirty(); stopAudio(); state.selectedDraftId = id; renderDrafts(); $('#draft-detail').replaceChildren(emptyState('正在读取草稿…', '所有原始材料仍在本机。', 'detail-empty'));
  try {
    const result = await invoke('records:get', { id }); const record = result?.record || result;
    if (state.selectedDraftId !== id) return; if (!record) throw new Error('草稿已不存在。');
    if (record.status === 'saved') { if (navigationVersion !== state.navigationVersion) return; state.selectedDraftId = null; await selectRecord(id, { context: { view: 'inbox', kind: 'library' }, expectedNavigationVersion: navigationVersion }); return; }
    const value = { ...record, ...(mergedDrafts().find(item => item.id === id) || {}) }; const inner = node('div', 'detail-inner'); add(inner, node('h2', '', recordTitle(record)), node('p', 'field-help', '未保存记录 · 预览不会开始录音'));
    const actions = node('div'); actions.id = 'draft-preview-actions'; draftActions(actions, value); inner.append(actions); const context = section('保存的现场', 'LOCAL DRAFT'); context.append(node('div', 'detail-context', contextText(record))); renderScreenshot(context, { ...record, status: 'draft' }); inner.append(context);
    mountedAudio = []; const audio = audioSection(record); inner.append(audio.area); if (transcriptText(record)) inner.append(node('p', 'organization-summary', transcriptText(record)));
    let draftRevision = 0; const choices = topicChoices(record, () => { draftRevision += 1; state.draftTopicDirty = true; notifyDirty(); topicStatus.textContent = '草稿分组尚未保存'; }); const topicStatus = node('p', 'field-help'); const saveTopics = node('button', 'button secondary compact', '保存草稿分组'); saveTopics.addEventListener('click', () => act(saveTopics, async () => { const revision = draftRevision; await invoke('records:setTopics', { id, topicIds: choices.ids() }); if (state.selectedDraftId === id && revision === draftRevision) state.draftTopicDirty = false; notifyDirty(); topicStatus.textContent = state.draftTopicDirty ? '提交版本已保存，后续分组修改仍未保存' : '草稿分组已保存'; await refresh(); })); add(inner, choices.area, saveTopics, topicStatus);
    const retry = node('button', 'button secondary compact', '刷新预览'); retry.addEventListener('click', () => openDraft(id, { force: true })); inner.append(retry);
    if (!segmentList(record).length) inner.append(node('p', 'field-help', '尚未看到已落盘的音频段，可能仍在收尾；没有音频不等于没有截图材料。'));
    $('#draft-detail').replaceChildren(inner);
  } catch (error) { if (state.selectedDraftId === id) $('#draft-detail').replaceChildren(emptyState('草稿暂时无法读取', error.message, 'detail-empty', '重试预览', () => openDraft(id))); }
}
async function sessionAction(method, button, id) {
  if (state.draftBusy) return;
  const navigationVersion = state.navigationVersion;
  state.draftBusy = true; $('#draft-error').classList.add('hidden'); renderDrafts();
  return act(button, async () => {
    try {
      const result = await invoke(method, id ? { id } : {});
      if (method === 'draft:discard') { if (state.selectedDraftId === id) { state.selectedDraftId = null; state.draftTopicDirty = false; notifyDirty(); $('#draft-detail').replaceChildren(emptyState('草稿已删除', '本次关联材料已清理。', 'detail-empty')); } toast('本次草稿与关联材料已删除'); }
      await refresh();
      if (method === 'draft:finish' && navigationVersion === state.navigationVersion) { toast('记录已保存在本机'); const savedId = (result?.record || result)?.id || id; if (savedId) await selectRecord(savedId, { context: { view: 'inbox', kind: 'library' }, expectedNavigationVersion: navigationVersion }); else showView('inbox'); }
    } catch (error) { $('#draft-error').textContent = error.message || '草稿操作未完成，请重试。'; $('#draft-error').classList.remove('hidden'); throw error; }
    finally { state.draftBusy = false; renderSession(state.session); }
  });
}
async function search(query) { state.query = query.trim(); await loadLibrary(); }
async function refresh(initial = false) {
  const result = await invoke('app:bootstrap'); if (!result) return;
  state.records = result.records || []; state.recordCount = result.recordCount ?? state.records.length; state.recordHeaders = result.recordHeaders || state.records; state.drafts = result.drafts || []; state.settings = result.settings || {}; state.capabilities = result.capabilities || {}; state.topics = result.topics || []; state.duplicateSuggestions = result.duplicateSuggestions || []; state.groups = result.groups || [];
  if (state.recordProjection && !state.recordHeaders.some(record => record.id === state.recordProjection.record.id)) state.recordProjection = null;
  if (screenshotViewer.recordId && ![...state.recordHeaders, ...state.drafts].some(record => record.id === screenshotViewer.recordId)) closeScreenshot();
  renderTopics(); renderSession(result.session || null); if (initial) renderSettings();
  if (!state.aiSearching && !state.aiMode && !state.batchBusy) await loadLibrary();
  else if (!state.aiSearching && state.visibleRecords) {
    const headers = new Map(state.recordHeaders.map(record => [record.id, record])); let changed = false;
    state.visibleRecords = state.visibleRecords.filter(record => { const exists = headers.has(record.id); if (!exists) changed = true; return exists; }).map(record => { const header = headers.get(record.id); if (record.version != null && header.version !== record.version) { changed = true; return { ...record, title: header.title || record.title, searchStale: true }; } return record; });
    state.total = state.visibleRecords.length; renderList();
    if (changed) $('#library-status').textContent = '资料已发生变化；已有 AI 结果保留并标记过期候选。请手动重新查找，不会自动调用模型。';
  }
  if (state.selectedId) {
    const id = state.selectedId; const response = await invoke('records:get', { id }); const record = response?.record || response; if (state.selectedId !== id) return;
    if (record) { if (state.recordProjection?.record.id === id) { state.recordProjection.record = record; state.visibleRecords = withRecordProjection(state.visibleRecords || []); renderList(); } if (!state.detailDirty && state.editingId !== id && !mountedAudio.some(player => player.paused === false && !player.ended)) renderDetail(record);  }
    else { state.selectedId = null; state.detailDirty = false; notifyDirty(); stopAudio(); renderDetailEmpty(); }
  }
  if (state.view === 'drafts' && state.selectedDraftId) await openDraft(state.selectedDraftId, { passive: true });
}
function openGuide() { if (!$('#guide-dialog').open) $('#guide-dialog').showModal(); }
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$('.brand').addEventListener('click', (event) => { event.preventDefault(); showView('inbox'); });
$('#open-guide').addEventListener('click', openGuide); $('#guide-button').addEventListener('click', openGuide); $('#close-guide').addEventListener('click', () => $('#guide-dialog').close()); $('#guide-done').addEventListener('click', () => $('#guide-dialog').close());
$('#start-recording').addEventListener('click', (event) => sessionAction('draft:startManual', event.currentTarget));
$('#back-to-group-home').addEventListener('click', () => act(null, returnToGroupHome));
$('#toggle-group-sidebar').addEventListener('click', () => document.body.classList?.toggle('group-sidebar-open'));
for (const selector of ['#close-group-sidebar', '#group-sidebar-backdrop']) $(selector).addEventListener('click', () => document.body.classList?.remove('group-sidebar-open'));
$('#create-primary-group').addEventListener('click', () => { $('#primary-group-create-form').classList.remove('hidden'); $('#primary-group-name').focus(); });
$('#cancel-primary-group').addEventListener('click', () => $('#primary-group-create-form').classList.add('hidden'));
$('#primary-group-create-form').addEventListener('submit', event => { event.preventDefault(); return act($('#save-primary-group'), async () => { const name = $('#primary-group-name').value.trim(); if (!validTopicName(name)) { $('#primary-group-status').textContent = '分组名称请填写 1–60 个字符。'; return; } const navigationVersion = state.navigationVersion; const result = await invoke('topics:create', { name }); const topic = result?.topic || result; if (!topic?.id) throw new Error('分组创建未完成，请重试。'); $('#primary-group-create-form').classList.add('hidden'); $('#primary-group-name').value = ''; await refresh(); if (navigationVersion === state.navigationVersion) await openPrimaryGroup(topic.id); }); });
$('#open-primary-group-manager').addEventListener('click', () => { if (!$('#group-management-dialog').open) { cancelTopicSelection(true); $('#group-management-dialog').showModal(); } });
$('#close-group-management').addEventListener('click', () => { if (cancelTopicSelection(true)) $('#group-management-dialog').close(); });
$('#group-management-dialog').addEventListener('cancel', event => { event.preventDefault(); if (cancelTopicSelection(true)) $('#group-management-dialog').close(); });
$('#group-management-dialog').addEventListener('close', () => { if (!topicManagement.writing) cancelTopicSelection(true); });
$('#merge-topic-groups').addEventListener('click', () => beginTopicSelection('merge'));
$('#delete-topic-groups').addEventListener('click', () => beginTopicSelection('delete'));
$('#select-all-topic-groups').addEventListener('click', () => { if (!topicManagement.mode || topicManagement.busy) return; if (topicManagement.ids.size === state.topics.length) topicManagement.ids.clear(); else topicManagement.ids = new Set(state.topics.map(topic => topic.id)); updateTopicManagementControls(); });
$('#cancel-topic-selection').addEventListener('click', () => cancelTopicSelection());
$('#apply-topic-selection').addEventListener('click', applyTopicSelection);
$('#session-pause').addEventListener('click', (event) => sessionAction('draft:pause', event.currentTarget)); $('#session-continue').addEventListener('click', (event) => sessionAction('draft:continue', event.currentTarget)); $('#session-finish').addEventListener('click', (event) => sessionAction('draft:finish', event.currentTarget)); $('#session-discard').addEventListener('click', (event) => sessionAction('draft:discard', event.currentTarget));
$('#search-input').addEventListener('input', (event) => { clearTimeout(searchTimer); const query = event.target.value; searchTimer = setTimeout(() => search(query), 220); });
$('#record-list').addEventListener('scroll', () => { if (recordSelection.expandedId) setCardActions(null); }, { passive: true });
document.addEventListener('click', event => { if (!recordSelection.expandedId) return; for (let parent = event.target; parent; parent = parent.parentElement) { if (parent.classList?.contains('inmoment-popover') || parent.getAttribute?.('data-record-id') === recordSelection.expandedId) return; } setCardActions(null); });
document.addEventListener('keydown', (event) => {
  if (dialogs.open) return;
  if ($('#screenshot-dialog').open) { if (event.key === '+' || event.key === '=') { event.preventDefault(); applyScreenshotZoom(screenshotViewer.scale * 1.25); } if (event.key === '-') { event.preventDefault(); applyScreenshotZoom(screenshotViewer.scale / 1.25); } return; }
  if ($('#guide-dialog').open) return;
  if (event.key === 'Escape' && !recordSelection.busy && (recordSelection.enabled || recordSelection.expandedId)) { event.preventDefault(); if (recordSelection.enabled) { clearRecordSelection(); renderList(); } else setCardActions(null); return; }
  if (event.key === 'Escape' && state.editingId === state.selectedId && state.view === state.detailContext.view) { event.preventDefault(); act(null, async () => { if (!state.detailDirty || await dialogs.confirm({ title: '结束编辑？', message: '放弃尚未保存的修改？', detail: '已保存的记录保留。', confirmLabel: '放弃修改' })) await selectRecord(state.selectedId, { discard: true }); }); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); showView('inbox'); $('#search-input').focus(); }
});
$('#date-range').addEventListener('change', () => { $('#custom-dates').classList.toggle('hidden', $('#date-range').value !== 'custom'); loadLibrary(); });
for (const selector of ['#date-from', '#date-to']) $(selector).addEventListener('change', () => loadLibrary());
$('#topic-filter-search').addEventListener('input', renderTopics);
$('#filter-unclassified').addEventListener('change', () => { state.filters.uncategorized = $('#filter-unclassified').checked; renderTopics(); loadLibrary(); });
$('#clear-topic-filter').addEventListener('click', () => { state.filters.topicIds = []; state.filters.uncategorized = false; $('#topic-filter-search').value = ''; renderTopics(); loadLibrary(); });
$('#ai-search').addEventListener('click', openAISearch);
$('#ai-search-form').addEventListener('submit', event => { event.preventDefault(); return runAISearch(); });
$('#close-ai-search').addEventListener('click', () => act(null, async () => { await cancelAISearch(); $('#ai-search-dialog').close(); }));
$('#ai-search-dialog').addEventListener('cancel', event => { event.preventDefault(); return act(null, async () => { await cancelAISearch(); $('#ai-search-dialog').close(); }); });
$('#batch-organize').addEventListener('click', runBatchOrganize);
$('#cancel-batch').addEventListener('click', event => cancelBatchOrganize(event.currentTarget));
$('#close-batch-results').addEventListener('click', () => $('#batch-results-dialog').close());
$('#apply-batch-groups').addEventListener('click', event => act(event.currentTarget, applyBatchGroups).finally(() => { $('#apply-batch-groups').disabled = Boolean(state.batchApplying) || !state.batchChoices.size; }));
$('#load-more').addEventListener('click', () => loadLibrary({ append: true })); $('#retry-library').addEventListener('click', () => loadLibrary());
$('#cancel-search').addEventListener('click', event => act(event.currentTarget, cancelAISearch));
$('#create-topic').addEventListener('click', (event) => { if (topicManagement.mode || topicManagement.busy) return; const name = $('#new-topic-name').value.trim(); if (!validTopicName(name)) return; return act(event.currentTarget, async () => { await invoke('topics:create', { name }); if ($('#new-topic-name').value.trim() === name) $('#new-topic-name').value = ''; await refresh(); $('#topic-management-status').textContent = '分组已创建。'; }); });
for (const selector of ['#preview-delay-input', '#threshold-input', '#capture-delay-input', '#menu-delay-input', '#keyboard-trigger-input']) { $(selector).addEventListener('input', updateTimingTimeline); $(selector).addEventListener('change', updateTimingTimeline); }
$('#reset-timing').addEventListener('click', resetTimingForm);
$('#reset-settings').addEventListener('click', (event) => act(event.currentTarget, async () => {
  const result = await invoke('settings:reset');
  if (result?.cancelled || result?.canceled) { toast('已取消恢复，表单未改变'); return; }
  if (!result || typeof result !== 'object') throw new Error('默认设置未能恢复，请重试。');
  state.settings = result.settings || result; renderSettings(); $('#timing-result').textContent = ''; $('#settings-result').textContent = '已恢复默认设置'; toast('已恢复默认设置，记录与已保存密钥保留');
}));
$('#screenshot-full-image').addEventListener('load', screenshotLoaded); $('#screenshot-full-image').addEventListener('error', screenshotFailed);
$('#screenshot-zoom-in').addEventListener('click', () => applyScreenshotZoom(screenshotViewer.scale * 1.25));
$('#screenshot-zoom-out').addEventListener('click', () => applyScreenshotZoom(screenshotViewer.scale / 1.25));
$('#screenshot-fit').addEventListener('click', fitScreenshot); $('#screenshot-actual-size').addEventListener('click', () => applyScreenshotZoom(1, 'actual'));
$('#close-screenshot').addEventListener('click', closeScreenshot);
$('#screenshot-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeScreenshot(); });
$('#screenshot-reveal').addEventListener('click', (event) => revealScreenshot(screenshotViewer.recordId, event.currentTarget));
window.addEventListener?.('resize', () => { if ($('#screenshot-dialog').open && screenshotViewer.mode === 'fit') fitScreenshot(); });
$('#screenshot-viewport').addEventListener('wheel', (event) => { if (!screenshotViewer.loaded) return; event.preventDefault(); zoomScreenshotAt(screenshotViewer.scale * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY); }, { passive: false });
$('#screenshot-viewport').addEventListener('dblclick', (event) => { if (!screenshotViewer.loaded) return; event.preventDefault(); if (Math.abs(screenshotViewer.scale - 1) < 0.001) fitScreenshot(); else zoomScreenshotAt(1, event.clientX, event.clientY, 'actual'); });
$('#screenshot-viewport').addEventListener('pointerdown', (event) => { if (!screenshotViewer.loaded || event.button !== 0) return; const viewport = event.currentTarget; imageDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }; viewport.setPointerCapture?.(event.pointerId); viewport.classList.add('dragging'); event.preventDefault(); });
$('#screenshot-viewport').addEventListener('pointermove', (event) => { if (!imageDrag || event.pointerId !== imageDrag.id) return; event.currentTarget.scrollLeft = imageDrag.left + imageDrag.x - event.clientX; event.currentTarget.scrollTop = imageDrag.top + imageDrag.y - event.clientY; });
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('#screenshot-viewport').addEventListener(name, (event) => { if (!imageDrag || event.pointerId !== imageDrag.id) return; imageDrag = null; event.currentTarget.classList.remove('dragging'); });
$('#screenshot-full-image').addEventListener('dragstart', event => event.preventDefault());
for (const selector of ['#input-enabled', '#capture-screenshots', '#cloud-enabled', '#direct-ai-enabled', '#auto-title-enabled', '#ai-search-enabled', '#screenshot-analysis-enabled', '#threshold-input', '#preview-delay-input', '#capture-delay-input', '#menu-delay-input', '#keyboard-trigger-input', '#excluded-apps', '#model-input', '#api-key']) { $(selector).addEventListener('input', markSettingsDirty); $(selector).addEventListener('change', markSettingsDirty); }
$('#settings-form').addEventListener('submit', (event) => {
  event.preventDefault(); const button = event.submitter;
  if (settingsSaving) return;
  settingsSaving = true;
  return act(button, async () => {
    const timing = timingValues(); const submittedRevision = state.settingsRevision;
    if (!Number.isInteger(timing.thresholdMs) || timing.thresholdMs < 250 || timing.thresholdMs > 10000) { toast('进度条填充时长请填写 250–10000 毫秒的整数。', true); return; }
    for (const [key, label] of [['previewDelayMs', '进度条显示等待'], ['captureDelayMs', '截图等待'], ['menuDelayMs', '菜单展开等待']]) {
      if (!Number.isInteger(timing[key]) || timing[key] < 0 || timing[key] > 5000) { toast(`${label}请填写 0–5000 毫秒的整数。`, true); return; }
    }
    if (!['none', 'F8', 'F9', 'F10'].includes(timing.keyboardTrigger)) { toast('请选择有效的并列长按键。', true); return; }
    const params = { ...timing, inputEnabled: $('#input-enabled').checked, captureScreenshots: $('#capture-screenshots').checked, autoTitleEnabled: $('#auto-title-enabled').checked, aiSearchEnabled: $('#ai-search-enabled').checked, screenshotAnalysisEnabled: $('#screenshot-analysis-enabled').checked, excludedApps: $('#excluded-apps').value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean), cloudEnabled: $('#cloud-enabled').checked, directAIEnabled: $('#direct-ai-enabled').checked, model: $('#model-input').value };
    const apiKey = $('#api-key').value.trim(); if (apiKey) params.apiKey = apiKey;
    const result = await invoke('settings:save', params); if (result?.cancelled || result?.canceled) { $('#settings-result').textContent = '已取消保存，表单与已有设置保持不变'; return; } state.settings = result?.settings || result || {};
    const fresh = await invoke('settings:get'); state.settings = fresh?.settings || fresh || state.settings;
    if (submittedRevision === state.settingsRevision) { renderSettings(); $('#settings-result').textContent = '设置已保存'; $('#timing-result').textContent = ''; }
    else { state.settingsDirty = true; $('#settings-result').textContent = '提交版本已保存；随后修改的表单仍未保存'; renderCapabilities(); }
    toast('设置已保存');
  }).finally(() => { settingsSaving = false; });
});
renderDetailEmpty(); renderList();
if (bridge?.subscribe) bridge.subscribe((event) => { if (!event) return; if (event.type === 'batchOrganizeProgress') { batchProgress(event); return; } if (event.type === 'dialog:show') { dialogs.remote(event); return; } if (event.type === 'dialog:cancel') { dialogs.cancelRemote(event.id); return; } if (event.type === 'windowState') { document.body.classList?.toggle('window-maximized', Boolean(event.maximized)); return; } if (event.type === 'session' || event.type === 'sessionChanged') { renderSession(event.session); if (state.view === 'drafts' && state.selectedDraftId) openDraft(state.selectedDraftId, { passive: true }); } else if (event.type === 'capabilities') { state.capabilities = event.capabilities || state.capabilities; renderCapabilities(); } else if (['recordsChanged', 'draftsChanged', 'topicsChanged', 'settingsChanged', 'libraryChanged'].includes(event.type)) act(null, () => refresh()); else if (event.type === 'error') toast(event.message || '操作未完成', true); });
if (bridge?.invoke) { bridge.invoke('app:uiReady').catch(() => {}); bridge.invoke('window:state').then(result => document.body.classList?.toggle('window-maximized', Boolean(result?.maximized))).catch(() => {}); }
act(null, () => refresh(true));

