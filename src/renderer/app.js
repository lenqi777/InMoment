'use strict';

const $ = (selector) => document.querySelector(selector);
const state = { records: [], searchRecords: [], visibleRecords: null, drafts: [], topics: [], duplicateSuggestions: [], groups: [], settings: {}, capabilities: {}, session: null, view: 'notes', selectedId: null, selectedDraftId: null, detailDirty: false, query: '', requestId: 0, total: 0, scopeTotal: 0, limit: 20, loading: false, aiSearching: false, duplicateBusy: false, draftBusy: false, settingsDirty: false, settingsRevision: 0, filters: { topicIds: [], uncategorized: true } };
state.detailContext = { view: 'inbox', kind: 'library' }; state.activeGroupId = null; state.organizationTab = 'groups'; state.navigationVersion = 0;
state.libraryGroupId = 'uncategorized'; state.libraryMode = 'home'; state.homeScroll = {}; state.recordProjection = null; state.batchBusy = false; state.batchRunId = null; state.batchSnapshot = []; state.batchChoices = new Map();
const libraryDisplayKey = 'inmoment.libraryDisplay';
function readLibraryDisplay() { try { return window.localStorage?.getItem(libraryDisplayKey) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } }
state.libraryDisplay = readLibraryDisplay();
const bridge = window.inmoment;
const dialogs = window.InMomentDialogs;
let chatView;
let notesView;
let notebookGroups;
let primaryGroupForm = { mode: 'create', group: null };
function ensureNotesView() {
  notesView ||= new window.InMomentNotesView({
    root: $('#notes-view'), invoke, toast, notifyDirty,
    onGroupsChange: () => { if (state.view === 'notes') renderPrimaryGroups(); },
    backgroundAudio: renderNoteBackgroundAudio,
  });
  notesView.grouping ||= window.InMomentNotesGrouping && new window.InMomentNotesGrouping(notesView);
  return notesView;
}
async function openNotebook(id) {
  const update = showView('notes');
  const navigationVersion = state.navigationVersion;
  await update;
  if (!id || state.view !== 'notes' || navigationVersion !== state.navigationVersion) return;
  const notes = ensureNotesView();
  if (notes.topicId !== 'all' && !notes.listItem(id)) await notes.selectTopic('all');
  if (state.view === 'notes' && navigationVersion === state.navigationVersion) await notes.open(id);
}
function ensureChatView() {
  if (!chatView && window.InMomentChatView) {
    chatView = new window.InMomentChatView({ root:$('#chat-root'), invoke, onDirtyChange: notifyDirty, onSettings:() => act(null,async()=>{if(!await prepareChatNavigation())return;showView('settings', { settingsSection:'ai' });}), onOpenRecord: (id, noteId) => act(null, async () => { if (id && await prepareChatNavigation()) { await openNotebook(noteId || 'record:' + id); } }) });
    window.chatView = chatView;
  }
  return chatView;
}
async function openChat(id) {
  if (state.view !== 'chat' && await window.InMomentNoteImageViewer?.close({ restoreFocus: false }) === false) return;
  const view = ensureChatView();
  showView('chat', { skipChatOpen: true });
  if (view && (id || !view.currentId)) await view.open(id);
}
async function prepareChatNavigation() {
  if (!chatView?.currentId) return true;
  if (chatView.closeImage && !await chatView.closeImage({ restoreFocus: false })) return false;
  if (chatView.prepareToLeave) await chatView.prepareToLeave({ waitForTranscription: false });
  else await chatView.flush();
  return true;
}
const deletingRecords = new Set();
const recordSelection = { enabled: false, ids: new Set(), busy: false, busyAction: null, scope: null, expandedId: null };
const recordDeletionLocks = new Map();
const topicManagement = { mode: null, ids: new Set(), busy: false, writing: false, revision: 0 };
let recordSelectionToolbar;
let toastTimer;
let searchTimer;
let screenshotViewer = null;
let mountedAudio = [];
const audioWaveformCache = new Map();
let lastDirtyState = '';
let settingsSaving = false;
const settingsSections = ['capture', 'ai', 'local', 'maintenance'];
let settingsSection = 'capture';
let settingsSectionVersion = 0;
let sessionReturnChat = null;
const dateRangeItems = [{ id: 'all', label: '全部时间' }, { id: '7', label: '最近 7 天' }, { id: '30', label: '最近 30 天' }, { id: '365', label: '最近一年' }, { id: 'custom', label: '自定日期' }];
let dateRangeOpen = false;
let libraryFiltersOpen = false;
const aiProviderDefaults = Object.values(window.InMomentAIProviders || {});
const aiProviderIds = ['deepseek','openai','gemini'];
let aiFormProvider = 'deepseek';
let aiProfileDrafts = {};
let aiRenderedProvider = null;
let aiProviderMenuOpen = false;
let aiModelMenuOpen = false;
function notifyDirty() { const flags = { recordDirty: Boolean(state.detailDirty || state.draftTopicDirty), settingsDirty: Boolean(state.settingsDirty), noteDirty: Boolean(notesView?.dirty || window.InMomentNoteImageViewer?.isDirty()) }; const serialized = JSON.stringify(flags); if (serialized === lastDirtyState || !bridge?.invoke) return; lastDirtyState = serialized; bridge.invoke('app:setDirty', flags).catch(() => {}); }
function node(tag, className, content) { const element = document.createElement(tag); if (tag === 'button') element.type = 'button'; if (className) element.className = className; if (content !== undefined) element.textContent = String(content); if (tag === 'button' && /^(AI\s|一键整理|分析当前范围|分析当前筛选范围)/u.test(String(content || ''))) element.setAttribute('data-ui-icon', 'sparkle'); return element; }
function add(parent, ...children) { children.filter(Boolean).forEach((child) => parent.append(child)); return parent; }
function setVisible(element, shown) { if (window.InMomentMotion?.show) window.InMomentMotion.show(element, shown); else element?.classList.toggle('hidden', !shown); }
function uiTransition(options) { if (window.InMomentMotion?.transition) return window.InMomentMotion.transition(options); const applied = !options.guard || options.guard(); if (applied) options.update(); return { applied, updated:Promise.resolve(), finished:Promise.resolve() }; }
function setGroupSidebar(open) {
  const changed = document.body.classList.contains('group-sidebar-open') !== open;
  if (window.InMomentMotion?.sidebar) window.InMomentMotion.sidebar(open); else document.body.classList?.toggle('group-sidebar-open', open);
  const trigger = $('#toggle-group-sidebar');
  trigger.setAttribute('aria-expanded', String(open));
  if (!changed || !window.matchMedia?.('(max-width: 900px)').matches) return;
  if (open) ($('#primary-group-navigation [aria-pressed=true]') || $('#close-group-sidebar')).focus({ preventScroll: true });
  else if (within(document.activeElement, $('#primary-group-sidebar')) || document.activeElement === $('#group-sidebar-backdrop')) trigger.focus({ preventScroll: true });
}
function toggleNotebookGroupColumn() {
  if (state.view !== 'notes' || window.matchMedia?.('(max-width: 900px)').matches) return;
  const trigger = $('#fold-notebook-groups');
  const collapsed = !document.body.classList.contains('notebook-groups-collapsed');
  if (collapsed) {
    window.InMomentMenus?.close?.();
    if (within(document.activeElement, $('#notebook-group-content'))) trigger.focus({ preventScroll: true });
  }
  document.body.classList.toggle('notebook-groups-collapsed', collapsed);
  const label = collapsed ? '展开分组栏' : '收起分组栏';
  trigger.setAttribute('aria-expanded', String(!collapsed));
  trigger.setAttribute('aria-label', label);
  trigger.title = label;
}
function toast(message, error = false) {
  if (window.InMomentToast) return window.InMomentToast.show(message,{tone:error?'error':'success'});
  // The same transient region is also available before the shared script loads.
  const target=$('#toast');clearTimeout(toastTimer);target.textContent=message;target.classList.add('ui-toast');target.classList.remove('hidden','toast');target.setAttribute('data-tone',error?'error':'success');target.setAttribute('role',error?'alert':'status');window.InMomentMotion?.enter(target);
  toastTimer=setTimeout(()=>{setVisible(target,false);},error?5000:3000);
}
function showSourceFocusNotice(event) {
  if (!event.message) return;
  if(window.InMomentToast)window.InMomentToast.show(event.message,{tone:'info',durationMs:event.durationMs||5000});else toast(event.message);
}
async function invoke(method, params = {}) {
  if (!bridge || typeof bridge.invoke !== 'function') throw new Error('桌面连接尚未就绪，请通过 InMoment 桌面应用打开。');
  const result = await bridge.invoke(method, params);
  if (result?.ok === false) throw Object.assign(new Error(result.error?.message || result.error || '操作未完成'), { code: result.code });
  return result;
}
async function act(button, action) { if (button) button.disabled = true; try { return await action(); } catch (error) { toast(error.message || String(error), true); return null; } finally { if (button?.isConnected) button.disabled = false; } }
function formatDate(value) { const date = new Date(value || Date.now()); return Number.isNaN(date.getTime()) ? '时间未记录' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function duration(ms) { const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }
function audioDuration(ms) { return Number(ms) > 0 && Number(ms) < 1000 ? `${Math.round(Number(ms))} 毫秒` : duration(ms); }
function transcriptText(record) { if (record.hasTranscriptOverride) return typeof record.transcript === 'string' ? record.transcript : ''; const transcript = record.transcript || record.transcription || ''; return (Array.isArray(transcript) ? transcript.map((part) => part.text || '').join('\n') : typeof transcript === 'string' ? transcript : transcript.text || '') || record.notes || ''; }
function segmentList(record) { return record.audioSegments || record.segments || record.audio || []; }
function triggerLabel(value) { return ['F8', 'F9', 'F10'].includes(value) ? value : '右键'; }
function recordTitle(record) { return record.title || transcriptText(record).split('\n')[0].slice(0, 34) || '一段尚未命名的想法'; }
function findRecord(id) { return state.records.find(record => record.id === id) || (state.recordHeaders || []).find(record => record.id === id) || state.groups.flatMap(group => group.records || []).find(record => record.id === id); }
function showView(view, options = {}) {
  const previous = state.view;
  if (previous === 'settings' && view !== previous) stopShortcutCapture();
  if (view !== state.view) { clearRecordSelection(); setGroupSidebar(false); }
  if (!options.preserveNavigation) state.navigationVersion += 1;
  if (view !== state.view) stopAudio(); state.view = view;
  const apply = () => {
  document.querySelectorAll('.page-view').forEach(item => item.classList.add('hidden')); $(`#${view}-view`).classList.remove('hidden'); document.querySelectorAll('.nav-item').forEach(item => { const active=item.dataset.view===view;item.classList.toggle('active',active);if(item.classList.contains('rail-button'))item.setAttribute('aria-current',active?'page':'false'); });
  $('#breadcrumb-current').textContent = { inbox: '灵感收件箱', drafts: '恢复录音', settings: '偏好设置', duplicates: '灵感云', chat:'聊天', notes:'笔记' }[view];
  document.body.classList.toggle('chat-open', view === 'chat');
  document.body.classList.toggle('notes-open', view === 'notes');
  document.body.classList.toggle('notebook-layout', !['inbox', 'duplicates'].includes(view));
  if (view === 'settings' && options.settingsSection) showSettingsSection(options.settingsSection, { animate:false });
  if (view === 'notes') { ensureNotesView().show(state.topics); renderPrimaryGroups(); }
  else if (previous === 'notes') { notesView?.hide(); renderPrimaryGroups(); }
  if (view === 'inbox' && state.detailContext.view !== view) { document.body.classList?.remove(view === 'duplicates' ? 'group-detail-open' : 'inbox-detail-open'); renderDetailEmpty({ view }); }
  if (view === 'drafts') renderDrafts(); if (view === 'duplicates') window.InMomentCloud?.show({ onSelectRecord: selectCloudRecord }); else window.InMomentCloud?.hide?.();
  if (view === 'chat' && !options.skipChatOpen) { const chat = ensureChatView(); if (chat && !chat.currentId && !chat.opening) { chat.opening = true; chat.run(() => chat.open()).finally(() => { chat.opening = false; }); } }
  updateLibraryLayout();
  };
  const viewNavigation = state.navigationVersion;
  if (previous !== view && !options.skipMotion) {
    const content = $('.app-content');
    return uiTransition({ from:content, to:content, update:apply, guard:() => state.view === view && state.navigationVersion === viewNavigation, kind:'page' }).updated;
  }
  apply();
}
function primaryGroupName() { if (state.aiMode && state.aiResultScope === 'all') return 'AI 查找结果'; return state.libraryGroupId === 'uncategorized' ? '未分类' : state.topics.find(topic => topic.id === state.libraryGroupId)?.name || '筛选结果'; }
function updateLibraryDisplay() {
  $('#record-grid-host').setAttribute('data-library-display', state.libraryDisplay);
  $('#library-display-controls').classList.toggle('hidden', state.libraryMode !== 'home');
  for (const mode of ['grid', 'list']) $('#library-display-' + mode).setAttribute('aria-pressed', String(state.libraryDisplay === mode));
}
function setLibraryDisplay(mode) {
  if (!['grid', 'list'].includes(mode) || state.view !== 'inbox' || state.libraryMode !== 'home' || state.libraryDisplay === mode) return;
  window.InMomentMenus?.close?.();
  state.libraryDisplay = mode;
  try { window.localStorage?.setItem(libraryDisplayKey, mode); } catch {}
  updateLibraryDisplay(); window.InMomentMotion?.enter($('#record-list'));
}
function updateLibraryLayout() {
  syncDateRangeTrigger();
  const detailed = state.view === 'inbox' && state.libraryMode === 'detail'; document.body.classList?.toggle('record-detail-open', detailed); $('#back-to-group-home').classList.toggle('hidden', state.libraryMode !== 'detail');
  const toolsHost = detailed ? $('#record-column-header') : $('#inbox-view');
  const tools = ['#collection-toolbar', '#library-filters', '#library-feedback'].map(selector => $(selector));
  const movingTools = tools.some(element => element.parentElement !== toolsHost);
  if (movingTools) {
    const focused = tools.some(element => within(document.activeElement, element)) ? document.activeElement : null;
    const caret = focused === $('#search-input') ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null;
    window.InMomentMenus?.close?.();
    for (const element of tools) { if (detailed) toolsHost.append(element); else toolsHost.insertBefore(element, $('#record-feedback')); }
    focused?.focus?.({ preventScroll: true });
    if (caret?.start !== null && caret?.start !== undefined) { try { focused.setSelectionRange(caret.start, caret.end, caret.direction); } catch {} }
  }
  $('#batch-organize').textContent = detailed ? '整理' : '一键整理';
  $('#batch-organize').setAttribute('aria-label', '一键整理当前列表中的灵感'); $('#batch-organize').title = '一键整理当前列表中的灵感';
  const list = $('#record-list'); const host = $(detailed ? '#record-column' : '#record-grid-host'); if (host && list.parentElement !== host) { const focused = within(document.activeElement, list) ? document.activeElement : null; host.append(list); focused?.focus?.({ preventScroll: true }); }
  const moreHost = detailed ? $('#record-column') : $('#inbox-view'); if ($('#load-more').parentElement !== moreHost) moreHost.append($('#load-more'));
  updateLibraryDisplay();
  updateRecordSelectionToolbar();
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
  state.selectedId = null; state.editingId = null; state.detailDirty = false; state.detailContext = { view: 'inbox', kind: 'library' }; notifyDirty(); renderDetailEmpty(); renderTopics(); showView('inbox', { preserveNavigation: true }); setGroupSidebar(false);
  await loadLibrary(); $('#record-list').scrollTop = state.homeScroll[id] || 0;
}
async function returnToGroupHome() {
  if (state.detailDirty && !await dialogs.confirm({ title: '返回分组主页？', message: '当前记录有尚未保存的修改。', detail: '返回会放弃修改，已保存内容保留。', confirmLabel: '放弃修改并返回' })) return;
  const id = state.selectedId; const navigationVersion = ++state.navigationVersion;
  const motion = uiTransition({ from:detailPane(), to:() => Array.from($('#record-list').children).find(card => card.getAttribute('data-record-id') === id) || $('#record-grid-host'), kind:'record-close', guard:() => navigationVersion === state.navigationVersion, update:() => {
    clearRecordSelection(); stopAudio(); state.libraryMode = 'home'; state.selectedId = null; state.editingId = null; state.detailDirty = false; notifyDirty(); renderDetailEmpty(); updateLibraryLayout(); renderList(); $('#record-list').scrollTop = state.homeScroll[state.libraryGroupId] || 0;
  } });
  await motion.updated;
}
async function selectPrimaryGroup(id) {
  if (state.view !== 'notes') return openPrimaryGroup(id);
  const notes = ensureNotesView();
  if (id !== notes.topicId) state.navigationVersion++;
  setGroupSidebar(false);
  return notes.run(() => notes.selectTopic(id));
}
function ensureNotebookGroups() {
  notebookGroups ||= new window.InMomentTopicTree({
    navigation: $('#primary-group-navigation'), invoke, toast, refresh,
    select: selectPrimaryGroup, editName: openPrimaryGroupForm,
    beforeRead: async () => {
      const note = notesView?.opened;
      if (note && (!note.provisional || notesView.hasText(note))) await notesView.ensureSaved([note.id]);
    },
    onDeleted: result => {
      const notes = notesView;
      if (!notes) return;
      for (const id of result.deletedNotes || []) {
        const cached = notes.cache.get(id);
        if (cached) notes.removeFromCache(cached);
        notes.noteSelection.ids.delete(id);
      }
      if (notes.opened?.deleted) notes.closeEditor();
      notes.cleanupNotice(result);
      notifyDirty();
    },
  });
  return notebookGroups;
}
function renderPrimaryGroups() {
  const isNotebook = state.view === 'notes';
  const uncategorized = { id: 'uncategorized', name: '未分类' };
  const groups = isNotebook ? [{ id: 'all', name: '全部笔记' }, ...state.topics, uncategorized] : [uncategorized, ...state.topics];
  const active = isNotebook ? notesView?.topicId ?? null : state.aiMode && state.aiResultScope === 'all' ? '' : state.libraryGroupId;
  if (isNotebook) {
    const label = groups.find(group => group.id === active)?.name;
    $('#breadcrumb-current').textContent = label && active !== 'all' ? '笔记 · ' + label : '笔记';
  }
  if (isNotebook && window.InMomentTopicTree) {
    state.primaryGroupsFingerprint = null;
    ensureNotebookGroups().show(state.topics, notesView?.groupCounts || {}, active);
    return;
  }
  notebookGroups?.hide();
  const navigation = $('#primary-group-navigation');
  const rows = groups.map(group => ({ ...group, count: isNotebook ? notesView?.groupCounts?.[group.id] ?? 0 :
    (state.recordHeaders || []).filter(record => group.id === 'uncategorized' ? !record.topicIds?.length : record.topicIds?.includes(group.id)).length }));
  const fingerprint = JSON.stringify([isNotebook, active, rows]);
  if (state.primaryGroupsFingerprint === fingerprint) return;
  state.primaryGroupsFingerprint = fingerprint;
  const focused = within(document.activeElement, navigation) && document.activeElement?.getAttribute?.('data-library-group-id');
  const scrollTop = navigation.scrollTop;
  navigation.replaceChildren(...rows.map(group => {
    const button = node('button', 'primary-group-item');
    button.setAttribute('data-ui-icon', 'folder');
    button.setAttribute('data-library-group-id', group.id);
    if (isNotebook) button.setAttribute('aria-controls', 'notes-list');
    button.setAttribute('aria-pressed', String(group.id === active));
    button.title = group.name;
    add(button, node('span', 'primary-group-name', group.name), node('span', 'primary-group-count', group.count));
    button.addEventListener('click', () => selectPrimaryGroup(group.id));
    return button;
  }));
  navigation.scrollTop = scrollTop;
  if (focused) {
    const match = id => Array.from(navigation.children).find(button => button.getAttribute('data-library-group-id') === id);
    (match(focused) || match(active) || $('#create-primary-group')).focus({ preventScroll: true });
  }
}
function openPrimaryGroupForm(mode = 'create', group = null) {
  primaryGroupForm = { mode, group };
  const field = $('#primary-group-name');
  $('#primary-group-status').textContent = '';
  field.value = mode === 'rename' ? group.name : '';
  field.setAttribute('aria-label', mode === 'rename' ? '分组名称' : mode === 'child' ? '子分组名称' : '新分组名称');
  field.placeholder = mode === 'child' ? '子分组名称' : '分组名称';
  $('#save-primary-group').textContent = mode === 'rename' ? '保存' : '创建';
  setVisible($('#primary-group-create-form'), true);
  field.focus();
  if (mode === 'rename') field.select();
}
function closePrimaryGroupForm() {
  const { group } = primaryGroupForm;
  primaryGroupForm = { mode: 'create', group: null };
  setVisible($('#primary-group-create-form'), false);
  $('#primary-group-name').value = '';
  const row = group && Array.from($('#primary-group-navigation').querySelectorAll('[data-library-group-id]')).find(button => button.dataset.libraryGroupId === group.id);
  (row || $('#create-primary-group')).focus({ preventScroll: true });
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
  const previousMode = recordSelectionToolbar?.getAttribute('data-selection-active');
  if (!recordSelectionToolbar) {
    recordSelectionToolbar = node('div', 'record-selection-toolbar'); recordSelectionToolbar.id = 'record-selection-toolbar';
    const control = node('div', 'record-selection-control'); control.id = 'record-selection-control';
    const allTarget = node('label', 'record-selection-checkbox-target'); allTarget.htmlFor = 'select-visible-records';
    const all = node('input', 'record-selection-master'); all.type = 'checkbox'; all.id = 'select-visible-records'; all.setAttribute('aria-controls', 'record-list');
    all.addEventListener('change', () => { const ids = visibleRecordIds(); if (recordSelection.busy || !ids.length || ids.some(id => deletingRecords.has(id))) { updateRecordSelectionToolbar(); return; } const selected = recordSelection.enabled && ids.every(id => recordSelection.ids.has(id)); recordSelection.enabled = true; recordSelection.scope = recordSelectionScope(); recordSelection.ids = new Set(selected ? [] : ids); recordSelection.expandedId = null; renderList(); }); allTarget.append(all);
    const toggle = node('button', 'record-selection-toggle', '选择'); toggle.id = 'toggle-record-selection'; toggle.addEventListener('click', () => { const ids = visibleRecordIds(); if (recordSelection.busy || ids.some(id => deletingRecords.has(id)) || !ids.length && !recordSelection.enabled) return; recordSelection.enabled = !recordSelection.enabled; recordSelection.scope = recordSelectionScope(); recordSelection.ids.clear(); recordSelection.expandedId = null; renderList(); }); add(control, allTarget, toggle);
    const count = node('span', 'record-selection-count'); count.id = 'record-selection-count'; count.setAttribute('aria-live', 'polite');
    const group = node('button', 'record-selection-add-group', '添加到组'); group.setAttribute('data-ui-icon', 'folder-in'); group.id = 'add-selected-records'; group.addEventListener('click', () => addSelectedRecordsToGroup());
    const remove = node('button', 'record-selection-delete danger', '删除'); remove.setAttribute('data-ui-icon', 'trash'); remove.id = 'delete-selected-records'; remove.addEventListener('click', () => deleteSelectedRecords()); add(recordSelectionToolbar, control, count, group, remove);
  }
  const detailed = state.view === 'inbox' && state.libraryMode === 'detail'; const host = detailed ? $('#record-column-header') : $('#record-grid-host');
  if (host && recordSelectionToolbar.parentElement !== host) { const focused = within(document.activeElement, recordSelectionToolbar) ? document.activeElement : null; host.append(recordSelectionToolbar); if (!detailed && $('#record-list').parentElement === host) host.append($('#record-list')); focused?.focus?.({ preventScroll:true }); }
  document.body.classList?.toggle('record-selection-mode', recordSelection.enabled);
  recordSelectionToolbar.setAttribute('data-selection-active', String(recordSelection.enabled)); $('#toggle-record-selection').setAttribute('aria-pressed', String(recordSelection.enabled));
  const ids = visibleRecordIds(); const blocked = recordSelection.busy || ids.some(id => deletingRecords.has(id)); const selectedCount = recordSelection.enabled ? ids.filter(id => recordSelection.ids.has(id)).length : 0;
  const allSelected = ids.length > 0 && selectedCount === ids.length; const partial = selectedCount > 0 && !allSelected;
  $('#toggle-record-selection').textContent = recordSelection.enabled ? '完成' : '选择'; $('#toggle-record-selection').disabled = blocked || !ids.length && !recordSelection.enabled;
  const master = $('#select-visible-records'); master.checked = allSelected; master.indeterminate = partial; master.disabled = blocked || !ids.length; master.setAttribute('aria-checked', partial ? 'mixed' : String(allSelected));
  const masterLabel = !ids.length ? '当前没有可选择的灵感' : allSelected ? '取消选择当前显示的 ' + ids.length + ' 条灵感' : '全选当前显示的 ' + ids.length + ' 条灵感' + (partial ? '，已选 ' + selectedCount + ' 条' : ''); master.setAttribute('aria-label', masterLabel); master.title = masterLabel;
  $('#record-selection-control').setAttribute('data-selection-disabled', String(blocked || !ids.length));
  $('#record-selection-count').classList.toggle('hidden', !recordSelection.enabled); $('#record-selection-count').textContent = '已选 ' + recordSelection.ids.size + ' 条';
  $('#add-selected-records').classList.toggle('hidden', !recordSelection.enabled); $('#add-selected-records').disabled = recordSelection.busy || !recordSelection.ids.size; $('#add-selected-records').textContent = recordSelection.busyAction === 'group' ? detailed ? '…' : '添加中…' : detailed ? '分组' : '添加到组';
  $('#add-selected-records').setAttribute('aria-label', recordSelection.busyAction === 'group' ? '正在添加所选灵感到组' : '添加所选灵感到组'); $('#add-selected-records').title = '添加所选灵感到组';
  $('#delete-selected-records').classList.toggle('hidden', !recordSelection.enabled); $('#delete-selected-records').disabled = recordSelection.busy || !recordSelection.ids.size; $('#delete-selected-records').textContent = recordSelection.busyAction === 'delete' ? detailed ? '…' : '删除中…' : '删除';
  $('#delete-selected-records').setAttribute('aria-label', recordSelection.busyAction === 'delete' ? '正在删除所选灵感' : '删除所选灵感'); $('#delete-selected-records').title = '删除所选灵感';
  if (previousMode !== undefined && previousMode !== null && previousMode !== String(recordSelection.enabled)) window.InMomentMotion?.enter?.(recordSelectionToolbar, { kind:'reveal' });
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
  try { action = await window.InMomentMenus.open({ anchor: button, title: '灵感操作', items: [{ id: 'group', label: '添加到组', icon: 'folder-in' }, { id: 'delete', label: '删除', danger: true }] }); }
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
function cleanDeletedRecord(id) { forgetAudioWaveforms(id); recordSelection.ids.delete(id); if (state.selectedId === id) { stopAudio(true); state.selectedId = null; state.editingId = null; state.detailDirty = false; notifyDirty(); renderDetailEmpty(); } if (screenshotViewer?.recordId === id) closeScreenshot(); if (state.recordProjection?.record.id === id) state.recordProjection = null; }
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
    const picture = recordScreenshots(record).find(item => item.role === 'region')?.url;
    const placeholder = node('span', 'record-card-placeholder' + (picture ? ' hidden' : '')); placeholder.setAttribute('data-ui-icon', segmentList(record).length ? 'record' : 'transcript'); placeholder.setAttribute('aria-hidden', 'true'); open.append(placeholder);
    if (picture) { const image = node('img', 'record-card-image'); image.src = picture; image.alt = ''; image.loading = 'lazy'; image.addEventListener('error', () => { image.classList.add('hidden'); placeholder.classList.remove('hidden'); }); open.append(image); }
    add(open, top, node('h3', 'record-card-title', recordTitle(record)), node('p', 'card-preview', record.organization?.summary || record.matchSnippet || transcriptText(record) || (segmentList(record).length ? '已保存录音，可打开回听。' : '查看保存的现场材料。')));
    const topicNames = record.topics?.map(topic => topic.name).filter(Boolean) || [];
    open.append(node('div', 'card-topics', topicNames.length ? topicNames.join(' · ') : '未分类'));
    const source = record.task;
    if (source) { const line = node('p', 'card-context', source); line.setAttribute('title', source); open.append(line); }
    const reason = record.matchReason || record.aiMatchReason || record.reason;
    if (reason) open.append(node('p', 'match-reason', '匹配原因：' + (typeof reason === 'string' ? reason : JSON.stringify(reason))));
    if (state.recordProjection?.record.id === record.id && state.recordProjection.scope === projectionScope()) open.append(node('span', 'projection-note', state.recordProjection.reason));
    if (record.searchStale) open.append(node('p', 'field-help', '内容已更新，重新查找后可核对。'));
    installRecordSwipe(card, open, record.id);
    card.classList.toggle('is-checked', recordSelection.ids.has(record.id)); card.classList.toggle('actions-open', recordSelection.expandedId === record.id && !recordSelection.enabled);
    const check = node('input', 'record-selection'); check.type = 'checkbox'; check.checked = recordSelection.ids.has(record.id); check.disabled = recordSelection.busy || deletingRecords.has(record.id); check.setAttribute('aria-label', '选择灵感：' + recordTitle(record)); check.setAttribute('data-record-select-id', record.id); check.addEventListener('change', () => toggleRecordSelected(record.id));
    check.tabIndex = recordSelection.enabled ? 0 : -1; check.setAttribute('aria-hidden', String(!recordSelection.enabled));
    const more = node('button', 'record-actions-toggle'); more.setAttribute('data-ui-icon', 'more'); more.setAttribute('data-record-more-id', record.id); more.setAttribute('aria-label', '更多操作：' + recordTitle(record)); more.setAttribute('aria-haspopup', 'menu'); more.disabled = recordSelection.busy || deletingRecords.has(record.id); more.addEventListener('click', () => showRecordMenu(record, more, context));
    more.tabIndex = recordSelection.enabled ? -1 : 0;
    const group = node('button', 'record-add-group', '添加到组'); group.setAttribute('data-ui-icon', 'folder-in'); group.setAttribute('aria-label', '添加到组：' + recordTitle(record)); group.disabled = recordSelection.busy || deletingRecords.has(record.id); group.addEventListener('click', () => addRecordToGroup(record, group));
    const remove = node('button', 'card-delete danger', '删除'); remove.setAttribute('data-ui-icon', 'trash'); remove.setAttribute('data-record-delete-id', record.id); remove.setAttribute('aria-label', '删除灵感：' + recordTitle(record)); remove.disabled = deletingRecords.has(record.id); remove.addEventListener('click', () => deleteRecord(record, remove, context));
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
    const position = captureListPosition(list); list.replaceChildren(emptyState(state.query ? '暂时没有找到这段记忆' : '给下一个想法，留个位置', state.query ? '试试关键词、分组或其他时间范围，也可手动使用 AI 查找。' : '按住右键留下想法，无须先分类。', 'list-empty', state.query ? '清除搜索' : undefined, () => { $('#search-input').value = ''; search(''); })); restoreListPosition(list, position); updateRecordSelectionToolbar(); return;
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
  const switchingRecord = state.selectedId !== id || state.detailContext?.view !== nextContext.view;
  const fromHome = state.view === 'inbox' && state.libraryMode === 'home';
  const source = fromHome ? Array.from($('#record-list').children).find(card => card.getAttribute('data-record-id') === id) : detailPane();
  const previewRecord = (state.visibleRecords || []).find(record => record.id === id) || findRecord(id);
  let pane;
  const motion = uiTransition({ from:source, to:() => detailPane(), kind:fromHome ? 'record-open' : 'record-switch', guard:() => navigationVersion === state.navigationVersion, update:() => {
  if (switchingRecord) clearRecordProjection();
  if (nextContext.view === 'inbox') { if (state.libraryMode === 'home') state.homeScroll[state.libraryGroupId] = $('#record-list').scrollTop || 0; state.libraryMode = 'detail'; }
  stopAudio(true); if (state.detailContext?.view !== nextContext.view) detailPane().replaceChildren(); state.detailDirty = false; state.editingId = null; notifyDirty(); state.detailContext = { ...nextContext }; if (nextContext.groupId) state.activeGroupId = nextContext.groupId; state.selectedId = id; state.resetDetailScroll = switchingRecord || Boolean(options.discard);
  showView(nextContext.view, { preserveNavigation: true, skipMotion:true });
  renderList();
  pane = detailPane();
  if (previewRecord) {
    const preview = node('div', 'detail-inner record-opening-preview'); preview.setAttribute('aria-busy', 'true');
    add(preview, node('h2', '', recordTitle(previewRecord)), node('p', 'field-help', '正在读取完整记录…'));
    const text = previewRecord.organization?.summary || transcriptText(previewRecord);
    if (text) preview.append(node('p', 'record-opening-text', text.slice(0, 360)));
    pane.replaceChildren(preview);
  } else pane.replaceChildren(emptyState('正在读取…', '资料保存在本机。', 'detail-empty'));
  if (state.resetDetailScroll) pane.scrollTop = 0;
  } });
  await motion.updated;
  if (!motion.applied || navigationVersion !== state.navigationVersion) return false;
  try {
    const result = await invoke('records:get', { id }); const record = result?.record || result;
    await motion.finished;
    if (state.selectedId !== id || state.detailContext.view !== nextContext.view || navigationVersion !== state.navigationVersion) return false;
    if (!record) throw new Error('这条记录已不存在。');
    if (nextContext.kind === 'cloud') { projectCurrentRecord(record, '从灵感云打开'); state.visibleRecords = withRecordProjection(state.visibleRecords || []); renderList(); } renderDetail(record); window.InMomentMotion?.enter?.(pane.querySelector?.('.detail-inner'), { kind:'reveal' }); document.body.classList?.toggle('inbox-detail-open', true); return true;
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
  updateRecordSelectionToolbar();
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
function openScreenshot(record, screenshot, opener = document.activeElement) {
  if (!screenshot?.url) return;
  const owner = { recordId: record.id };
  const identity = { id: record.id, attachmentId: screenshot.id };
  const draft = ['draft', 'committing'].includes(record.status);
  const opened = window.InMomentNoteImageViewer?.open({
    owner, invoke, opener,
    url: screenshot.url,
    name: screenshot.role === 'region' ? '选区截图' : '来源窗口截图',
    readImage: () => invoke('image:readRecord', identity),
    revealImage: draft ? undefined : () => invoke('records:revealScreenshot', identity),
    onDirtyChange: notifyDirty,
    onClose: () => { if (screenshotViewer === owner) screenshotViewer = null; },
  });
  if (opened) screenshotViewer = owner;
}
function closeScreenshot() {
  if (screenshotViewer) window.InMomentNoteImageViewer?.close({ owner: screenshotViewer, force: true });
}
async function revealScreenshot(id, button, attachmentId) {
  if (!id) return;
  return act(button, () => invoke('records:revealScreenshot', attachmentId ? { id, attachmentId } : { id }));
}
function stopAudio(dispose = false) { mountedAudio.forEach(player => { try { player.pause?.(); } catch {} if (dispose) player.disposeWaveform?.(); }); }
function forgetAudioWaveforms(id) { for (const [key, entry] of audioWaveformCache) if (entry.id === id) audioWaveformCache.delete(key); }
function readAudioWaveform(record, segment, url) {
  const key = JSON.stringify([record.id, segment.id, url, record.version ?? record.updatedAt ?? segment.durationMs]);
  if (audioWaveformCache.has(key)) { const value = audioWaveformCache.get(key); audioWaveformCache.delete(key); audioWaveformCache.set(key, value); return value.promise; }
  const promise = invoke('records:waveform', { id: record.id, segmentId: segment.id }).then(value => {
    if (!Array.isArray(value?.peaks) || value.peaks.length < 1 || value.peaks.length > 2048 || value.peaks.some(peak => !Number.isFinite(peak) || peak < 0 || peak > 1)) throw new Error('波形暂不可用');
    return { peaks: value.peaks, durationMs: Number(value.durationMs) || 0 };
  }).catch(error => { if (audioWaveformCache.get(key)?.promise === promise) audioWaveformCache.delete(key); throw error; });
  audioWaveformCache.set(key, { id: record.id, promise }); while (audioWaveformCache.size > 24) audioWaveformCache.delete(audioWaveformCache.keys().next().value);
  return promise;
}
function waveformLayer(className, peaks) {
  const namespace = 'http://www.w3.org/2000/svg', svg = document.createElementNS(namespace, 'svg'); svg.setAttribute('class', className); svg.setAttribute('viewBox', `0 0 ${peaks.length} 40`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
  const baseline = document.createElementNS(namespace, 'path'); baseline.setAttribute('class', 'audio-waveform-baseline'); baseline.setAttribute('d', `M0 20H${peaks.length}`);
  const bars = document.createElementNS(namespace, 'path'); bars.setAttribute('class', 'audio-waveform-bars'); bars.setAttribute('d', peaks.map((peak, index) => peak > 0 ? `M${index + .5} ${(20 - peak * 18).toFixed(3)}V${(20 + peak * 18).toFixed(3)}` : '').join(''));
  add(svg, baseline, bars); return svg;
}
function audioSection(record, mounted = mountedAudio) {
  const area = node('div', 'audio-playlist'); area.setAttribute('aria-label', '原始录音'); const players = []; const segments = segmentList(record);
  if (!Array.isArray(segments) || !segments.length) { area.append(node('p', 'field-help audio-empty', '这条记录没有录音，可继续阅读或编辑文字。')); return { area, players }; }
  segments.forEach((segment, index) => {
    const wrapper = node('div', 'audio-segment'); const label = node('div', 'audio-label'); const length = node('span', 'audio-length', audioDuration(segment.durationMs || 0)); add(label, node('span', 'audio-segment-name', segments.length > 1 ? `第 ${index + 1} 段录音` : '原始录音'), length);
    const player = node('audio', 'audio-source hidden'); player.preload = 'metadata'; const url = typeof segment === 'string' ? segment : segment.url || segment.audioUrl || segment.src; if (url) player.src = url;
    player.setAttribute('aria-label', `第 ${index + 1} 段原始录音`); mounted.push(player); players.push({ player, id: segment.id });
    const controls = node('div', 'audio-controls'); const play = node('button', 'icon-button audio-play-button'); play.setAttribute('data-ui-icon', 'play'); play.setAttribute('aria-label', `播放第 ${index + 1} 段录音`); play.setAttribute('aria-pressed', 'false');
    const timeline = node('div', 'audio-timeline'), seekTrack = node('div', 'audio-seek-track'); const progress = node('input', 'audio-progress'); progress.type = 'range'; progress.min = 0; progress.step = 0.1; progress.value = 0; progress.setAttribute('aria-label', `第 ${index + 1} 段播放进度`);
    const waveform = node('div', 'audio-waveform hidden'); waveform.setAttribute('aria-hidden', 'true'); const waveStatus = node('span', 'audio-waveform-status hidden'); waveStatus.setAttribute('role', 'status');
    let alive = true, waveReady = false, waveformLength = 0, playedWave = null, dragPointer = null;
    const time = node('span', 'audio-time'); time.setAttribute('aria-hidden', 'true');
    const mute = node('button', 'icon-button audio-mute-button'); mute.setAttribute('aria-label', `静音第 ${index + 1} 段录音`); mute.setAttribute('data-ui-icon', 'volume'); mute.setAttribute('aria-pressed', 'false');
    const error = node('p', 'field-help audio-error hidden', '这段录音暂时无法播放，请检查附件是否存在，或重新打开记录。');
    const knownLength = Math.max(0, Number(segment.durationMs || 0) / 1000); let failed = !url;
    function totalSeconds() { return Number.isFinite(player.duration) && player.duration > 0 ? player.duration : knownLength || waveformLength; }
    function sync() {
      if (!alive) return;
      const total = totalSeconds(); const current = Math.max(0, Math.min(total || Infinity, Number(player.currentTime) || 0)); const playing = player.paused === false && !player.ended;
      progress.max = total || 1; progress.value = current; progress.disabled = failed || !total;
      progress.setAttribute('aria-valuetext', duration(current * 1000) + ' / ' + (total ? duration(total * 1000) : '时长待加载'));
      time.textContent = duration(current * 1000) + ' / ' + (total ? duration(total * 1000) : '—'); length.textContent = total ? audioDuration(total * 1000) : '时长待加载';
      play.setAttribute('data-ui-icon', playing ? 'pause' : 'play'); play.setAttribute('aria-label', `${playing ? '暂停' : '播放'}第 ${index + 1} 段录音`); play.setAttribute('aria-pressed', String(playing)); play.disabled = failed;
      mute.setAttribute('data-ui-icon', player.muted ? 'volume-off' : 'volume'); mute.setAttribute('aria-label', `${player.muted ? '取消静音' : '静音'}第 ${index + 1} 段录音`); mute.setAttribute('aria-pressed', String(Boolean(player.muted))); mute.disabled = failed;
      const fraction = total ? Math.min(1, current / total) : 0; if (playedWave) playedWave.style.clipPath = `inset(0 ${(100 - fraction * 100).toFixed(4)}% 0 0)`; waveform.style.setProperty?.('--audio-played', String(fraction));
    }
    function playbackFailed() { failed = true; error.classList.remove('hidden'); sync(); }
    play.addEventListener('click', async () => { if (player.paused !== false || player.ended) { try { if (player.ended) player.currentTime = 0; await player.play(); } catch { playbackFailed(); } } else player.pause(); sync(); });
    mute.addEventListener('click', () => { player.muted = !player.muted; sync(); });
    function seek(seconds) { const total = totalSeconds(); if (!alive || !total || failed) return; try { player.currentTime = Math.max(0, Math.min(total, Number(seconds) || 0)); sync(); } catch { error.textContent = '录音仍在读取，请稍后调整播放进度。'; error.classList.remove('hidden'); } }
    progress.addEventListener('input', () => seek(progress.value));
    function pointerSeek(event) { const rect = seekTrack.getBoundingClientRect(); if (rect.width > 0) seek((event.clientX - rect.left) / rect.width * totalSeconds()); }
    progress.addEventListener('pointerdown', event => { if (!waveReady || progress.disabled || event.button !== 0) return; event.preventDefault(); progress.focus({ preventScroll: true }); dragPointer = event.pointerId; progress.setPointerCapture?.(event.pointerId); pointerSeek(event); });
    progress.addEventListener('pointermove', event => { if (dragPointer === event.pointerId && dragPointer !== null) pointerSeek(event); });
    const stopSeeking = event => { if (dragPointer !== event.pointerId) return; if (event.type === 'pointerup') pointerSeek(event); try { progress.releasePointerCapture?.(dragPointer); } catch {} dragPointer = null; };
    progress.addEventListener('pointerup', stopSeeking); progress.addEventListener('pointercancel', stopSeeking); progress.addEventListener('lostpointercapture', () => { dragPointer = null; });
    player.disposeWaveform = () => { alive = false; if (dragPointer !== null) { try { progress.releasePointerCapture?.(dragPointer); } catch {} } dragPointer = null; };
    player.addEventListener('error', playbackFailed);
    ['loadedmetadata', 'durationchange', 'timeupdate', 'pause', 'ended', 'seeking', 'seeked', 'volumechange'].forEach(event => player.addEventListener(event, sync));
    player.addEventListener('play', () => { mounted.forEach(other => { if (other !== player) other.pause?.(); }); sync(); });
    const speeds = [0.75, 1, 1.25, 1.5, 2]; const speed = node('select', 'audio-speed hidden'); speed.setAttribute('aria-label', `第 ${index + 1} 段播放速度`); speed.setAttribute('aria-hidden', 'true'); speed.tabIndex = -1; speeds.forEach(value => { const option = node('option', '', `${value}×`); option.value = value; speed.append(option); }); speed.value = 1;
    const speedTrigger = node('button', 'button quiet compact audio-speed-trigger', '1×'); speedTrigger.setAttribute('data-ui-icon', 'chevron'); speedTrigger.setAttribute('aria-haspopup', 'menu'); speedTrigger.setAttribute('aria-expanded', 'false'); speedTrigger.setAttribute('aria-label', `第 ${index + 1} 段播放速度：1倍`); speedTrigger.title = '选择播放速度'; let speedOpen = false;
    function changeSpeed() { const rate = Number(speed.value) || 1; player.playbackRate = rate; speedTrigger.textContent = rate + '×'; speedTrigger.setAttribute('aria-label', `第 ${index + 1} 段播放速度：${rate}倍`); }
    speed.addEventListener('change', changeSpeed);
    async function openSpeed() {
      if (speedOpen) { window.InMomentMenus?.close?.(); return; } if (!window.InMomentMenus?.open) return; speedOpen = true; speedTrigger.setAttribute('aria-expanded', 'true');
      try { const result = await window.InMomentMenus.open({ anchor: speedTrigger, title: '播放速度', selection: true, items: speeds.map(value => ({ id: String(value), label: value + '×', selected: Number(speed.value) === value })) }); if (result === null || !speeds.includes(Number(result)) || !speed.isConnected) return; speed.value = String(result); changeSpeed(); }
      finally { speedOpen = false; speedTrigger.setAttribute('aria-expanded', 'false'); }
    }
    speedTrigger.addEventListener('click', openSpeed); speedTrigger.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); return openSpeed(); } });
    add(seekTrack, waveform, progress); add(timeline, seekTrack, time, waveStatus); add(controls, play, timeline, speedTrigger, mute, speed); add(wrapper, label, controls, player, error); if (failed) error.classList.remove('hidden'); sync(); area.append(wrapper);
    if (url && record.id && segment.id) readAudioWaveform(record, segment, url).then(value => {
      if (!alive || !player.isConnected) return;
      waveformLength = Math.max(0, value.durationMs / 1000); const maximum = Math.max(...value.peaks), displayPeaks = maximum > 0 ? value.peaks.map(peak => peak / maximum) : value.peaks;
      playedWave = waveformLayer('audio-waveform-layer audio-waveform-played', displayPeaks); add(waveform, waveformLayer('audio-waveform-layer', displayPeaks), playedWave); waveReady = true; waveform.classList.remove('hidden'); seekTrack.classList.add('has-waveform'); sync();
    }).catch(() => { if (alive && player.isConnected) { waveStatus.textContent = '波形暂不可用，仍可拖动进度条。'; waveStatus.classList.remove('hidden'); } });
  }); return { area, players };
}
function renderNoteBackgroundAudio(note, audioSegments) {
  const mounted = [];
  const { area } = audioSection({ id: note.id.slice('record:'.length), updatedAt: note.updatedAt, audioSegments }, mounted);
  return { area, dispose() {
    for (const player of mounted) {
      player.pause(); player.disposeWaveform(); player.removeAttribute('src'); player.load();
    }
  } };
}
function renderDetail(record) {
  stopAudio(true); mountedAudio = []; state.detailDirty = false; notifyDirty();
  const selectionContext = { ...state.detailContext }; const detail = detailPane(); const scrollTop = state.resetDetailScroll ? 0 : detail.scrollTop || 0; state.resetDetailScroll = false;
  const inner = node('div', 'detail-inner'); const editor = node('div', 'record-editor hidden');
  const titleRow = node('div', 'record-title-row'); const titleHeading = node('h2', '', recordTitle(record));
  const fieldTitle = node('input', 'record-title-input hidden'); fieldTitle.id = 'field-记录标题'; fieldTitle.value = recordTitle(record); fieldTitle.maxLength = 500; fieldTitle.setAttribute('aria-label', '记录标题');
  const titleActions = node('div', 'record-inline-actions');
  const inlineAction = (label, icon, hidden = false) => { const button = node('button', 'icon-button' + (icon === 'check' ? ' ui-confirm' : icon === 'close' ? ' ui-cancel' : '') + (hidden ? ' hidden' : '')); button.setAttribute('data-ui-icon', icon); button.setAttribute('aria-label', label); button.setAttribute('title', label); return button; };
  const rename = inlineAction('重命名标题', 'edit'); rename.classList.add('title-rename-button'); rename.setAttribute('data-action', 'rename-record');
  const saveTitle = inlineAction('保存标题', 'check', true), cancelTitle = inlineAction('取消重命名', 'close', true);
  add(titleActions, rename, saveTitle, cancelTitle); add(titleRow, titleHeading, fieldTitle, titleActions); inner.append(titleRow);
  const titleFeedback = node('p', 'inline-edit-feedback hidden'); titleFeedback.setAttribute('role', 'status'); titleFeedback.setAttribute('aria-live', 'polite'); inner.append(titleFeedback);
  const files = node('div', 'record-file-actions');
  if (segmentList(record).length || screenshotURL(record)) {
    const openFolder = node('button', 'button quiet compact', '打开所在文件夹'); openFolder.setAttribute('data-ui-icon', 'folder'); openFolder.setAttribute('data-action', 'reveal-record'); openFolder.addEventListener('click', () => act(openFolder, () => invoke('media:reveal-record', { id: record.id }))); files.append(openFolder);
  }
  files.append(node('span', 'record-time', formatDate(record.createdAt))); inner.append(files);
  const failure = (Array.isArray(record.jobs) ? record.jobs : Object.values(record.jobs || {})).find(job => ['failed', 'unavailable'].includes(job.status)); const errorNotice = failure ? node('p', 'persistent-error', failure.error || '上次操作未完成，可重新尝试。') : null;
  const voiceNote = node('section', 'voice-note'); const voiceLabel = segmentList(record).length ? '录音与文本' : '文字'; voiceNote.setAttribute('aria-label', voiceLabel); const voiceHeading = node('div', 'voice-note-heading'); voiceHeading.append(node('h3', '', voiceLabel));
  const audio = audioSection(record); const audioDetails = node('div', 'record-audio-section'); audioDetails.setAttribute('data-disclosure', 'audio'); audioDetails.append(audio.area); audio.players.forEach(entry => { entry.reveal = () => { audioDetails.scrollIntoView?.({ block: 'nearest' }); }; });
  const reading = node('section', 'record-text-panel'); const panelHeader = node('div', 'text-panel-header'); const panelTitle = node('h3'); const panelToggle = node('div', 'text-panel-toggle');
  const originalWords = node('div', 'text-panel-original'); originalWords.setAttribute('data-disclosure', 'words'); const rawText = node('div', 'original-text'); const summaryBody = node('div', 'text-panel-summary');
  const hasSummary = Boolean(typeof record.organization === 'string' ? record.organization.trim() : record.organization?.summary?.trim());
  const showOriginal = node('button', 'text-button', '语音文本'); showOriginal.setAttribute('data-action', 'show-original'); const showSummary = node('button', 'text-button', '思考摘要'); showSummary.setAttribute('data-action', 'show-summary');
  let currentTextMode = null; let syncTextActions = () => {};
  function showTextMode(mode) {
    const summary = mode === 'summary' && hasSummary; const changed = currentTextMode !== summary; currentTextMode = summary;
    if (state.selectedId === record.id) state.detailTextMode = { id: record.id, mode: summary ? 'summary' : 'original' };
    const apply = () => { panelTitle.textContent = summary ? '思考摘要' : '语音文本'; originalWords.classList.toggle('hidden', summary); summaryBody.classList.toggle('hidden', !summary); showOriginal.classList.toggle('active', !summary); showSummary.classList.toggle('active', summary); showOriginal.setAttribute('aria-pressed', String(!summary)); showSummary.setAttribute('aria-pressed', String(summary)); syncTextActions(); };
    if (reading.isConnected && changed) uiTransition({ from:summary ? originalWords : summaryBody, to:() => summary ? summaryBody : originalWords, update:apply, guard:() => currentTextMode === summary && reading.isConnected, kind:'text' }); else apply();
  }
  if (hasSummary) add(panelToggle, showOriginal, showSummary); add(panelHeader, panelTitle, panelToggle); add(reading, panelHeader, summaryBody, originalWords); showOriginal.addEventListener('click', () => showTextMode('original')); showSummary.addEventListener('click', () => showTextMode('summary')); showTextMode(state.detailTextMode?.id === record.id ? state.detailTextMode.mode : hasSummary ? 'summary' : 'original');
  const segments = segmentList(record);
  const originalParagraph = node('p', 'original-transcript', transcriptText(record)); rawText.append(originalParagraph);
  const fieldTranscript = node('textarea', 'record-transcript-input'); fieldTranscript.id = 'record-transcript-input'; fieldTranscript.value = transcriptText(record); fieldTranscript.rows = 8; fieldTranscript.setAttribute('aria-label', '语音文本');
  const textActions = node('div', 'record-inline-actions'); const edit = inlineAction('编辑语音文本', 'edit'); edit.setAttribute('data-action', 'edit-record'); edit.id = 'dynamic-record-edit-button';
  const save = inlineAction('保存语音文本', 'check', true), discardEdit = inlineAction('取消语音文本编辑', 'close', true); add(textActions, edit, save, discardEdit); panelHeader.append(textActions);
  const status = node('p', 'field-help edit-status'); status.id = 'record-edit-status';
  add(editor, fieldTranscript, status); add(originalWords, rawText, editor);
  let titleRevision = 0, textRevision = 0, baseVersion = record.version, savedTitle = fieldTitle.value, savedText = fieldTranscript.value;
  let titleEditing = false, textEditing = false, titleSaving = false, textSaving = false, writes = Promise.resolve();
  let textOnlyEditing = false, conversionRevision = 0;
  const convert = node('button', 'button quiet danger compact', record.audioCleanupPending && !segments.length ? '重试清理录音' : '只保留文字');
  convert.setAttribute('data-ui-icon', 'trash');
  const confirmTextOnly = node('button', 'button danger compact hidden', '保存文字并删除录音');
  confirmTextOnly.setAttribute('data-ui-icon', 'trash');
  editor.append(confirmTextOnly);
  const current = () => state.selectedId === record.id && inner.isConnected;
  function syncDirty() { if (!current()) return; state.detailDirty = fieldTitle.value !== savedTitle || fieldTranscript.value !== savedText; state.editingId = titleEditing || textEditing ? record.id : null; notifyDirty(); }
  function titleMode(editing) { titleEditing = editing; setVisible(titleHeading, !editing); setVisible(fieldTitle, editing); setVisible(rename, !editing); setVisible(saveTitle, editing); setVisible(cancelTitle, editing); syncDirty(); }
  syncTextActions = () => {
    setVisible(edit, !currentTextMode && !textEditing);
    setVisible(save, !currentTextMode && textEditing && !textOnlyEditing);
    setVisible(discardEdit, !currentTextMode && textEditing);
    setVisible(confirmTextOnly, textOnlyEditing && textEditing);
    confirmTextOnly.disabled = textSaving || !fieldTranscript.value.trim();
  };
  function textMode(editing) { textEditing = editing; setVisible(editor, editing); setVisible(rawText, !editing); syncTextActions(); syncDirty(); }
  syncTextActions();
  rename.addEventListener('click', () => { titleFeedback.textContent = ''; setVisible(titleFeedback, false); titleMode(true); fieldTitle.focus(); fieldTitle.setSelectionRange?.(0, fieldTitle.value.length); });
  edit.addEventListener('click', () => { showTextMode('original'); textMode(true); fieldTranscript.focus(); });
  fieldTitle.addEventListener('input', () => { titleRevision++; titleFeedback.textContent = ''; setVisible(titleFeedback, false); syncDirty(); });
  fieldTranscript.addEventListener('input', () => { textRevision++; status.textContent = fieldTranscript.value === savedText ? '' : '有未保存修改'; syncDirty(); syncTextActions(); });
  async function persist(kinds = ['title', 'transcript'], explicitSave = false) {
    const snapshot = { title: fieldTitle.value, transcript: fieldTranscript.value, titleRevision, textRevision };
    if (kinds.includes('title') && !snapshot.title.trim()) { titleFeedback.textContent = '标题不能为空'; setVisible(titleFeedback, true); fieldTitle.focus(); return false; }
    const payload = { id: record.id };
    if (kinds.includes('title') && (explicitSave || snapshot.title !== savedTitle)) payload.title = snapshot.title;
    if (kinds.includes('transcript') && (explicitSave || snapshot.transcript !== savedText)) payload.transcript = snapshot.transcript;
    if (Object.keys(payload).length > 1) {
      const write = writes.catch(() => {}).then(() => invoke('records:update', { ...payload, expectedVersion: baseVersion })); writes = write;
      const result = await write; baseVersion = (result?.record || result)?.version ?? baseVersion;
      if (Object.hasOwn(payload, 'title')) savedTitle = snapshot.title;
      if (Object.hasOwn(payload, 'transcript')) savedText = snapshot.transcript;
    }
    if (!current()) return false;
    if (kinds.includes('title')) { titleHeading.textContent = savedTitle; if (titleRevision === snapshot.titleRevision && fieldTitle.value === snapshot.title) titleMode(false); }
    if (kinds.includes('transcript')) { originalParagraph.textContent = savedText; if (textRevision === snapshot.textRevision && fieldTranscript.value === snapshot.transcript) textMode(false); }
    syncDirty(); status.textContent = state.detailDirty ? '提交版本已保存；随后输入的修改仍未保存' : '';
    return !state.detailDirty;
  }
  function saveTitleAction() {
    if (titleSaving) return; titleSaving = true; cancelTitle.disabled = true;
    return act(saveTitle, async () => { try { await persist(['title'], true); if (current() && !titleEditing) { rename.focus(); await refresh(); } } catch (error) { titleFeedback.textContent = error.message; setVisible(titleFeedback, true); throw error; } }).finally(() => { titleSaving = false; if (cancelTitle.isConnected) cancelTitle.disabled = false; });
  }
  function cancelTitleAction() { if (titleSaving) return; fieldTitle.value = savedTitle; titleRevision++; titleFeedback.textContent = ''; setVisible(titleFeedback, false); titleMode(false); rename.focus(); }
  saveTitle.addEventListener('click', saveTitleAction); cancelTitle.addEventListener('click', cancelTitleAction);
  fieldTitle.addEventListener('keydown', event => { if (event.isComposing || !['Enter', 'Escape'].includes(event.key)) return; event.preventDefault(); event.stopPropagation?.(); return event.key === 'Enter' ? saveTitleAction() : cancelTitleAction(); });
  save.addEventListener('click', () => { if (textSaving) return; textSaving = true; discardEdit.disabled = true; return act(save, async () => { try { await persist(['transcript'], true); if (current() && !textEditing) { edit.focus(); await refresh(); } } catch (error) { status.textContent = error.message; throw error; } }).finally(() => { textSaving = false; if (discardEdit.isConnected) discardEdit.disabled = false; }); });
  const cancelTextAction = () => {
    if (textSaving) return;
    const opener = textOnlyEditing ? convert : edit;
    textOnlyEditing = false; conversionRevision++;
    fieldTranscript.value = savedText; textRevision++; status.textContent = ''; textMode(false); opener.focus();
  };
  discardEdit.addEventListener('click', cancelTextAction);
  fieldTranscript.addEventListener('keydown', event => { if (event.key !== 'Escape' || event.isComposing) return; event.preventDefault(); event.stopPropagation?.(); cancelTextAction(); });
  const transcribe = node('button', 'button quiet compact', '重新本地转写'); transcribe.setAttribute('data-ui-icon', 'transcript');
  const organize = node('button', 'button primary compact', 'AI 总结'); organize.setAttribute('data-action', 'organize-record');
  if (getJob(record, 'organize')?.status === 'processing') { organize.disabled = true; organize.textContent = '正在总结…'; }
  if (segments.length) voiceHeading.append(transcribe);
  organize.addEventListener('click', () => act(organize, async () => {
    if (!fieldTranscript.value.trim()) { toast('请先补充语音文本，再进行整理。'); return; }
    if (state.detailDirty) { const unchanged = await persist(); if (!unchanged) { toast('后续输入仍未保存，请先保存这些修订，再重新总结。'); return; } state.editingId = null; } const result = await invoke('records:organize', { id: record.id, includeScreenshot: Boolean(state.settings.screenshotAnalysisEnabled) });
    if (result?.cancelled || result?.canceled) { toast('本次整理已取消'); await refresh(); return; }
    toast('思路整理完成'); await refresh();
  }));
  const transcribeJob = getJob(record, 'transcribe'); transcribe.disabled = transcribeJob?.status === 'processing' || !segments.length;
  if (segments.length || record.audioCleanupPending) voiceHeading.append(convert);
  convert.disabled = transcribeJob?.status === 'processing';
  convert.addEventListener('click', () => act(convert, async () => {
    if (textOnlyEditing || textSaving) return;
    if (!segments.length) {
      await invoke('records:keepTextOnly', { id: record.id, expectedVersion: baseVersion });
      await refresh(); toast('原录音已清理'); return;
    }
    showTextMode('original'); textOnlyEditing = true; textMode(true); fieldTranscript.focus();
    if (fieldTranscript.value.trim()) return;
    const attempt = ++conversionRevision, originalRevision = textRevision;
    status.textContent = '正在本地转写…';
    try {
      await writes;
      const result = await invoke('records:previewText', { id: record.id, expectedVersion: baseVersion });
      if (!current() || attempt !== conversionRevision || originalRevision !== textRevision) return;
      fieldTranscript.value = result.transcript; textRevision++;
      status.textContent = result.transcript ? '' : '录音未识别到文字，可填写要保留的内容。';
      syncDirty(); syncTextActions();
    } catch (error) {
      if (current() && attempt === conversionRevision && originalRevision === textRevision) status.textContent = error.message;
    }
  }));
  confirmTextOnly.addEventListener('click', async () => {
    if (textSaving || !fieldTranscript.value.trim()) return;
    if (fieldTitle.value !== savedTitle) { toast('请先保存标题修改', true); return; }
    if (!await dialogs.confirm({ title: '删除原录音？', message: '保存当前文字并删除这条灵感的原录音。', detail: '删除录音后无法恢复。', confirmLabel: '保存文字并删除录音', danger: true }) || !current() || !textOnlyEditing) return;
    textSaving = true; discardEdit.disabled = true; fieldTranscript.readOnly = true;
    return act(confirmTextOnly, async () => {
      try {
        await writes;
        stopAudio(true);
        await invoke('records:keepTextOnly', { id: record.id, transcript: fieldTranscript.value, expectedVersion: baseVersion });
        if (current()) { savedText = fieldTranscript.value; textOnlyEditing = false; textMode(false); }
        forgetAudioWaveforms(record.id);
        await refresh(); toast('文字已保存，原录音已删除');
      } catch (error) {
        if (current()) {
          const latest = await invoke('records:get', { id: record.id }).catch(() => null);
          if (latest?.audioCleanupPending && !segmentList(latest).length) {
            savedText = fieldTranscript.value; textOnlyEditing = false; textMode(false); await refresh();
          } else status.textContent = error.message;
        }
        throw error;
      }
    }).finally(() => { textSaving = false; discardEdit.disabled = false; fieldTranscript.readOnly = false; syncTextActions(); });
  });
  transcribe.addEventListener('click', () => act(transcribe, async () => {
    if ((state.detailDirty || fieldTranscript.value.trim()) && !await dialogs.confirm({ title: '重新本地转写？', message: '重新转写会替换已有转写。', detail: '录音保留，音频不上传；若转写期间继续修订，将保留你的新修订。', confirmLabel: '重新转写' })) return;
    if (state.detailDirty) { toast('请先保存或明确放弃未保存修改，再重新转写。', true); return; }
    const result = await invoke('records:transcribe', { id: record.id }); const job = getJob(result?.record || result, 'transcribe');
    if (job && ['failed', 'unavailable'].includes(job.status)) toast(job.error || '本地转写未完成', true);
    else toast(job?.status === 'not-applied' ? '转写完成，但保留了你的修订文字。' : '本地转写已完成');
    await refresh();
  }));
  if (hasSummary) { if (record.organizationStale) summaryBody.append(node('p', 'persistent-error', '记录已更新，旧摘要可能过时，请核对原文。')); renderOrganization(summaryBody, record.organization, audio.players, record, { embedded: true }); }
  const toolbar = node('div', 'record-ai-toolbar'); const suggestions = node('div', 'record-group-suggestions'); renderTopicSuggestions(suggestions, record.organization, record); add(toolbar, organize, suggestions);
  add(voiceNote, segments.length || record.audioCleanupPending ? voiceHeading : null, segments.length ? audioDetails : null, reading); add(inner, toolbar, errorNotice, voiceNote); renderCaptureDetails(inner, record);
  const more = disclosure('更多操作', 'more', 'record-more-actions');
  const remove = node('button', 'button quiet compact delete-record danger', '删除记录及全部关联材料'); remove.setAttribute('data-ui-icon', 'trash'); remove.addEventListener('click', () => deleteRecord(record, remove, selectionContext)); more.append(remove); inner.append(more); detail.replaceChildren(inner); detail.scrollTop = scrollTop; if (deletingRecords.has(record.id)) lockDeletingDetail(record.id);

}
function screenshotURL(record) { return record.screenshotUrl || record.screenshot?.url || record.context?.screenshotUrl || record.screenshots?.[0]?.url || ''; }
function recordScreenshots(record) {
  if (Array.isArray(record.screenshots)) return record.screenshots;
  const url = screenshotURL(record);
  return url ? [{ role: 'background', ...record.screenshot, url }] : [];
}
function renderCaptureDetails(parent, record) {
  const screenshots = recordScreenshots(record);
  const regions = screenshots.filter(item => item.role === 'region');
  if (regions.length) {
    const selected = section('选区截图'); selected.classList.add('record-screenshot-section');
    for (const screenshot of regions) renderScreenshot(selected, record, screenshot);
    parent.append(selected);
  }
  const background = screenshots.filter(item => item.role !== 'region');
  const source = record.context || record.source || {};
  const app = source.appName || source.processName;
  const title = source.windowTitle || source.title;
  const url = source.url;
  if (!background.length && !app && !title && !url && !source.screenshotUnavailable) return;
  const context = section('背景信息'); context.classList.add('record-screenshot-section'); context.setAttribute('data-disclosure', 'context');
  if (app || title) context.append(node('div', 'detail-context', [app, title].filter(Boolean).join(' · ')));
  if (source.canFocus) {
    const focus = node('button', 'button quiet compact', '回到原窗口'); focus.setAttribute('data-ui-icon', 'external');
    focus.addEventListener('click', () => act(focus, async () => {
      const result = await invoke('records:openSource', { id: record.id });
      if (result?.success === false || result?.focused === false) throw new Error(result.message || '原窗口已关闭，请根据保存的来源重新打开。');
    }));
    context.append(focus);
  }
  if (url) {
    const link = node('button', 'button quiet compact background-url'); link.type = 'button';
    link.append(node('span', 'background-url-text', url));
    link.setAttribute('data-ui-icon', 'external'); link.setAttribute('aria-label', '打开来源网址：' + url); link.setAttribute('title', url);
    link.addEventListener('click', () => act(link, () => invoke('records:openSourceUrl', { id: record.id })));
    context.append(link);
  }
  for (const screenshot of background) renderScreenshot(context, record, screenshot);
  if (source.screenshotUnavailable && !background.length) context.append(node('p', 'field-help background-status', '未能截取来源窗口。录音和已选截图可照常保存。'));
  parent.append(context);
}
function renderScreenshot(parent, record, screenshot) {
  const label = screenshot.role === 'region' ? '选区截图' : '来源窗口截图';
  const thumbnail = node('button', 'screenshot-thumbnail-button'); thumbnail.type = 'button'; thumbnail.setAttribute('aria-label', '查看' + label + ' PNG 原图');
  const image = node('img', 'detail-screenshot'); image.src = screenshot.url; image.alt = label; image.addEventListener('error', () => { thumbnail.replaceChildren(node('p', 'field-help', '缩略图无法读取，请尝试原图或检查文件。')); }); thumbnail.append(image); thumbnail.addEventListener('click', event => openScreenshot(record, screenshot, event.currentTarget)); parent.append(thumbnail);
  const actions = node('div', 'detail-actions'); const open = node('button', 'button secondary compact', '查看 PNG 原图'); open.setAttribute('data-ui-icon', 'image'); open.addEventListener('click', event => openScreenshot(record, screenshot, event.currentTarget)); actions.append(open);
  if (!['draft', 'committing'].includes(record.status)) { const reveal = node('button', 'button secondary compact', '打开图片所在文件夹'); reveal.setAttribute('data-ui-icon', 'folder'); reveal.addEventListener('click', () => revealScreenshot(record.id, reveal, screenshot.id)); actions.append(reveal); }
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
  const seen = new Set(); const suggestions = (organization?.topicSuggestions || organization?.suggestedTopics || []).map(value => typeof value === 'string' ? value : value?.name).filter(name => typeof name === 'string' && canonical(name)).filter(name => { const key = canonical(name); if (seen.has(key)) return false; seen.add(key); return true; }).map((name, index) => ({ name: name.trim(), topic: state.topics.find(topic => canonical(topic.name) === canonical(name)), choiceId: 'suggestion-' + index }));
  if (!suggestions.length) { parent.append(node('span', 'field-help', '总结后可查看分组建议')); return; }
  parent.append(node('span', 'group-suggestion-label', '分组建议'));
  const memberships = record.topicIds || record.topics?.map(topic => topic.id) || [];
  function adoptSuggestion({ name }, button) { return act(button, async () => {
      if (state.detailDirty) { toast('请先保存或放弃当前编辑，再采用分组建议。'); return; } if (state.topicAdoptBusy) { toast('正在采用上一项建议，请稍后。'); return; }
      if (Array.from(name).length > 60) { toast('建议的分组名超过 60 个字符，请在分组管理中手动创建。', true); return; }
      state.topicAdoptBusy = true; const navigationVersion = state.navigationVersion; const selector = state.detailContext.view === 'duplicates' ? '#group-record-detail' : '#record-detail'; const locked = [...document.querySelectorAll(selector + ' input, ' + selector + ' textarea, ' + selector + ' button')].map(element => ({ element, disabled: element.disabled })); locked.forEach(({ element }) => { element.disabled = true; });
      try {
        let topic = state.topics.find(item => canonical(item.name) === canonical(name));
        if (!topic) { if (!await window.InMomentConfirm.open({ anchor: button, title: '创建新分组并归入？', message: '“' + name + '”还不是已有分组。', detail: '确认后创建这个分组，并把这条灵感加入其中。其他分组、原文、截图与录音保留。', confirmLabel: '创建并归入' })) return; const result = await invoke('topics:create', { name }); topic = result?.topic || result; }
        if (!topic?.id) throw new Error('分组创建未完成，请在分组管理中核对。');
        const current = await invoke('records:get', { id: record.id }); const value = current?.record || current; if (!value) throw new Error('这条灵感已不存在。');
        const response = await invoke('records:setTopics', { id: record.id, topicIds: [...new Set([...(value.topicIds || value.topics?.map(item => item.id) || []), topic.id])] }); const updated = response?.record || response;
        if (state.selectedId === record.id && navigationVersion === state.navigationVersion) { state.editingId = null; projectCurrentRecord(updated?.id ? updated : { ...value, topicIds: [...new Set([...(value.topicIds || []), topic.id])] }); }
        await refresh(); toast('已归入“' + topic.name + '”，原始表达保留。');
      } finally { state.topicAdoptBusy = false; locked.forEach(({ element, disabled }) => { if (element.isConnected) element.disabled = disabled; }); }
    }); }
  suggestions.slice(0, 2).forEach(suggestion => {
    const { name, topic: existing } = suggestion; const label = existing?.name || name; const already = existing && memberships.includes(existing.id);
    const button = node('button', 'group-suggestion-button'); button.append(node('span', 'group-suggestion-name', label)); button.setAttribute('data-ui-icon', existing ? 'folder-in' : 'folder-plus'); button.setAttribute('data-topic-suggestion-name', label); button.setAttribute('data-topic-suggestion-new', String(!existing)); button.setAttribute('data-topic-suggestion-applied', String(Boolean(already)));
    button.title = already ? '已在分组“' + label + '”' : (existing ? '添加到“' : '新建分组并添加到“') + label + '”'; button.setAttribute('aria-label', button.title); button.disabled = Boolean(already);
    button.addEventListener('click', () => adoptSuggestion(suggestion, button)); parent.append(button);
  });
  if (suggestions.length > 2) {
    const more = node('button', 'group-suggestion-more button quiet compact', '更多建议'); more.id = 'more-topic-suggestions'; more.setAttribute('data-ui-icon', 'more'); more.setAttribute('aria-haspopup', 'dialog'); more.setAttribute('aria-expanded', 'false'); more.title = '查看全部 ' + suggestions.length + ' 个分组建议';
    more.addEventListener('click', () => act(more, async () => {
      if (!window.InMomentGroupPicker?.open) { toast('分组建议暂时不可用，请重试。', true); return; }
      const navigationVersion = state.navigationVersion; more.setAttribute('aria-expanded', 'true');
      try {
        const result = await window.InMomentGroupPicker.open({ anchor: more, title: '分组建议', searchLabel: '搜索建议分组', topics: suggestions.filter(item => item.topic).map(item => ({ id: item.topic.id, name: item.topic.name })), choices: suggestions.filter(item => !item.topic).map(item => ({ id: item.choiceId, name: item.name })), selectedIds: memberships, disabledIds: memberships });
        if (!result || navigationVersion !== state.navigationVersion || state.selectedId !== record.id || !more.isConnected) return;
        const chosen = suggestions.find(item => (item.topic?.id || item.choiceId) === result.id); if (chosen) await adoptSuggestion(chosen, more);
      } finally { more.setAttribute('aria-expanded', 'false'); }
    })); parent.append(more);
  }
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
function syncDateRangeTrigger() {
  const trigger = $('#date-range-trigger'); const value = $('#date-range').value || 'all'; const label = dateRangeItems.find(item => item.id === value)?.label || '全部时间';
  trigger.textContent = label; trigger.setAttribute('aria-label', '时间范围：' + label); trigger.title = '选择时间范围';
  const conditions = []; if (value !== 'all') conditions.push(label); if (state.query.trim()) conditions.push(state.aiMode ? '描述查找' : '关键词');
  const detailed = state.view === 'inbox' && state.libraryMode === 'detail';
  const filter = $('#library-filter-trigger'); filter.textContent = '筛选' + (!detailed && conditions.length ? ' · ' + (conditions.length === 1 ? conditions[0] : conditions.length) : ''); filter.classList.toggle('active', Boolean(conditions.length)); filter.setAttribute('data-filter-count', String(conditions.length)); filter.setAttribute('aria-label', conditions.length ? '筛选，已应用：' + conditions.join('、') : '筛选灵感'); filter.title = conditions.length ? '已应用：' + conditions.join('、') : '设置时间、关键词或按描述查找';
}
function changeDateRange() { syncDateRangeTrigger(); $('#custom-dates').classList.toggle('hidden', $('#date-range').value !== 'custom'); return loadLibrary(); }
async function openLibraryFilters() {
  if (libraryFiltersOpen) { window.InMomentFilters?.close?.(); return; }
  if (!window.InMomentFilters?.open) { toast('筛选面板暂时不可用，请重试。', true); return; }
  const anchor = $('#library-filter-trigger'); const navigationVersion = state.navigationVersion; const snapshot = { range: $('#date-range').value || 'all', from: $('#date-from').value, to: $('#date-to').value, query: state.aiMode ? '' : $('#search-input').value.trim() };
  libraryFiltersOpen = true; anchor.setAttribute('aria-expanded', 'true');
  try {
    const result = await window.InMomentFilters.open({ anchor, ...snapshot, semanticQuery: state.aiMode ? state.query : '', scopeLabel: primaryGroupName() });
    if (!result || navigationVersion !== state.navigationVersion || state.view !== 'inbox') return;
    if (result.action === 'ai') { openAISearch(result.query); return; }
    if (result.action !== 'apply' || !dateRangeItems.some(item => item.id === result.range)) return;
    const unchanged = result.range === snapshot.range && result.from === snapshot.from && result.to === snapshot.to && result.query === snapshot.query;
    if (unchanged && (state.aiMode || state.query === snapshot.query)) return;
    clearTimeout(searchTimer); $('#date-range').value = result.range; $('#date-from').value = result.from; $('#date-to').value = result.to; $('#search-input').value = result.query; state.query = result.query; state.aiMode = false; state.aiResultScope = null;
    syncDateRangeTrigger(); $('#custom-dates').classList.toggle('hidden', result.range !== 'custom'); await loadLibrary();
  } finally { libraryFiltersOpen = false; anchor.setAttribute('aria-expanded', 'false'); }
}
async function openDateRange() {
  if (dateRangeOpen) { window.InMomentMenus?.close?.(); return; }
  if (!window.InMomentMenus?.open) { toast('时间选择暂时不可用，请重试。', true); return; }
  const anchor = $('#date-range-trigger'); const navigationVersion = state.navigationVersion; dateRangeOpen = true; anchor.setAttribute('aria-expanded', 'true');
  try { const selected = await window.InMomentMenus.open({ anchor, title: '时间范围', selection: true, items: dateRangeItems.map(item => ({ ...item, selected: item.id === ($('#date-range').value || 'all') })) }); if (!dateRangeItems.some(item => item.id === selected) || navigationVersion !== state.navigationVersion || state.view !== 'inbox') return; $('#date-range').value = selected; await changeDateRange(); if (selected === 'custom' && navigationVersion === state.navigationVersion && state.view === 'inbox') $('#date-from').focus?.(); }
  finally { dateRangeOpen = false; anchor.setAttribute('aria-expanded', 'false'); }
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
    renderList(); window.InMomentMotion?.enter($('#record-list')); $('#load-more').classList.toggle('hidden', ai || state.visibleRecords.length >= state.total);
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
  setVisible($('#topic-management-selection'), selecting);
  $('#merge-topic-groups').disabled = busy || state.topics.length < 2; $('#delete-topic-groups').disabled = busy || !state.topics.length;
  $('#merge-topic-groups').classList.toggle('active', mode === 'merge'); $('#delete-topic-groups').classList.toggle('active', mode === 'delete');
  $('#topic-selection-count').textContent = '已选 ' + ids.size + ' 个分组';
  $('#select-all-topic-groups').disabled = busy; $('#select-all-topic-groups').textContent = ids.size === state.topics.length && ids.size ? '取消全选' : '全选';
  $('#apply-topic-selection').disabled = busy || ids.size < (mode === 'merge' ? 2 : 1); $('#apply-topic-selection').textContent = writing ? '处理中…' : mode === 'merge' ? '下一步' : '删除所选';
  $('#apply-topic-selection').classList.toggle('danger', mode === 'delete'); if (mode === 'delete') $('#apply-topic-selection').setAttribute('data-ui-icon', 'trash'); else $('#apply-topic-selection').removeAttribute('data-ui-icon');
  $('#cancel-topic-selection').disabled = busy; $('#close-group-management').disabled = writing; $('#create-topic').disabled = selecting || busy; $('#new-topic-name').disabled = selecting || busy;
  for (const row of $('#topic-management-list').children) {
    const id = row.getAttribute('data-topic-manage-id'); if (!id) continue;
    const [check, name, rename] = row.children; check.classList.toggle('hidden', !selecting); check.checked = ids.has(id); check.disabled = busy; name.disabled = selecting || busy; rename.disabled = selecting || busy; row.classList.toggle('selected', selecting && ids.has(id));
  }
}
function beginTopicSelection(mode) {
  if (topicManagement.busy || state.topics.length < (mode === 'merge' ? 2 : 1)) return;
  topicManagement.mode = mode; topicManagement.ids.clear(); topicManagement.revision += 1;
  $('#topic-management-status').textContent = mode === 'merge' ? '选择要合并的分组，再选择保留的分组名称。' : '选择要删除的分组。笔记和附件会保留。'; updateTopicManagementControls();
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
    const approved = await window.InMomentConfirm.open({ anchor, title: mode === 'merge' ? '合并所选分组？' : '删除所选分组？', message: mode === 'merge' ? '将 ' + ids.length + ' 个分组合并为“' + target.name + '”。' : '删除选中的 ' + ids.length + ' 个分组？', detail: mode === 'merge' ? '所选分组内的笔记将归入同一个分组。' : '原有笔记和附件会保留。没有其他分组的笔记会回到未分类。', confirmLabel: mode === 'merge' ? '确认合并' : '删除分组', danger: mode === 'delete' });
    if (!approved || revision !== topicManagement.revision) return;
    topicManagement.writing = true; updateTopicManagementControls();
    await invoke(mode === 'merge' ? 'topics:mergeMany' : 'topics:deleteMany', mode === 'merge' ? { topicIds: ids, targetId: target.id } : { topicIds: ids });
    const removed = new Set(ids.filter(id => id !== target?.id));
    if (removed.has(state.libraryGroupId)) { state.libraryGroupId = target?.id || 'uncategorized'; state.filters = groupFilters(state.libraryGroupId); state.recordProjection = null; }
    else { const selectedRemoved = state.filters.topicIds.some(id => removed.has(id)); state.filters.topicIds = state.filters.topicIds.filter(id => !removed.has(id)); if (target && selectedRemoved && !state.filters.topicIds.includes(target.id)) state.filters.topicIds.push(target.id); }
    topicManagement.mode = null; topicManagement.ids.clear(); state.topicFingerprint = null;
    await refresh(); $('#topic-management-status').textContent = mode === 'merge' ? '已合并为“' + target.name + '”。' : '已删除 ' + ids.length + ' 个分组。';
  } catch (error) { $('#topic-management-status').textContent = error.message || '分组未能更新，请重试。'; }
  finally { if (revision === topicManagement.revision) { topicManagement.busy = false; topicManagement.writing = false; updateTopicManagementControls(); } }
}
function validTopicName(name) { if (!name || name.length > 60) { $('#topic-management-status').textContent = '分组名称请填写 1–60 个字符。'; return false; } return true; }
async function topicMutation(button, method, params) { if (topicManagement.mode || topicManagement.busy || method === 'topics:rename' && !validTopicName(params.name)) return; return act(button, async () => { try { await invoke(method, params); $('#topic-management-status').textContent = '分组已更新，原始记录保留。'; await refresh(); } catch (error) { $('#topic-management-status').textContent = error.message; throw error; } }); }
function usageText(usage) { if (!usage) return ''; const total = usage.total_tokens ?? usage.totalTokens ?? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)); const unknown = Number(usage.unknownUsageRequests || 0); return (Number.isFinite(total) ? (unknown ? ' 已知用量 ' : ' 本次 ') + total + ' tokens。' : '') + (unknown ? '另有 ' + unknown + ' 次请求未取得用量，仍可能计费。' : ''); }

function searchError(message) { const target = $('#ai-search-error'); target.textContent = message; target.classList.toggle('hidden', !message); }
function openAISearch(description) { clearTimeout(searchTimer); $('#ai-search-description').value = typeof description === 'string' ? description : $('#search-input').value.trim(); $('#ai-search-scope').value = 'all'; searchError(''); if (!$('#ai-search-dialog').open) $('#ai-search-dialog').showModal(); $('#ai-search-description').focus(); }
function dateInput(value) { const date = new Date(value); return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); }
function showAppliedDates(filters) { $('#date-range').value = filters.from !== undefined || filters.to !== undefined ? 'custom' : 'all'; $('#date-from').value = filters.from !== undefined ? dateInput(filters.from) : ''; $('#date-to').value = filters.to !== undefined ? dateInput(filters.to - 1) : ''; $('#custom-dates').classList.toggle('hidden', $('#date-range').value !== 'custom'); syncDateRangeTrigger(); }
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
      else if (item.status === 'success') { const menu = node('button', 'batch-result-menu'); menu.setAttribute('data-ui-icon', 'close'); menu.setAttribute('aria-label', '调整“' + title + '”的分组'); menu.title = '调整分组'; menu.disabled = Boolean(state.batchApplying); menu.addEventListener('click', () => act(menu, () => adjustBatchGroup(item, menu))); row.append(menu); }
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

function showSettingsSection(section, { animate = true } = {}) {
  if (!settingsSections.includes(section)) return;
  const previous = settingsSection;
  const from = $(`#settings-${previous}`);
  const target = $(`#settings-${section}`);
  const version = ++settingsSectionVersion;
  if (section === previous) return;
  stopShortcutCapture();
  window.InMomentMenus?.close?.();
  const update = () => {
    settingsSection = section;
    for (const id of settingsSections) {
      $(`#settings-${id}`).classList.toggle('hidden', section !== id);
      $(`#settings-nav-${id}`).setAttribute('aria-current', String(section === id));
    }
    $('#settings-scroll-body').scrollTop = 0;
  };
  if (!animate) { update(); return; }
  uiTransition({ from, to:target, update, guard:() => state.view === 'settings' && version === settingsSectionVersion, kind:'page' });
}

function aiProviderCatalog() {
  const supplied = Array.isArray(state.settings.aiProviders) ? state.settings.aiProviders : Object.entries(state.settings.aiProviders || {}).map(([id,value]) => ({ id,...value }));
  const defaults = aiProviderDefaults.length ? aiProviderDefaults : supplied.filter(item => aiProviderIds.includes(item?.id));
  return defaults.map(fallback => { const item = supplied.find(value => value?.id === fallback.id); return { ...fallback, ...item, id:fallback.id, models:Array.isArray(item?.models) && item.models.length ? item.models.filter(value => typeof value === 'string') : fallback.models }; });
}
function validAIProvider(id) { return aiProviderIds.includes(id) ? id : 'deepseek'; }
function savedAIProfile(id) {
  const provider = aiProviderCatalog().find(item => item.id === id); const profile = state.settings.aiProfiles?.[id]; const active = validAIProvider(state.settings.aiProvider);
  return { model:profile?.model || (id === active ? state.settings.model : '') || provider.defaultModel, hasApiKey:Boolean(profile?.hasApiKey ?? (id === active && state.settings.hasApiKey)) };
}
function resetAIProfileDrafts() {
  aiFormProvider = validAIProvider(state.settings.aiProvider); aiRenderedProvider = null; aiProfileDrafts = {};
  for (const provider of aiProviderCatalog()) { const saved = savedAIProfile(provider.id); aiProfileDrafts[provider.id] = { model:saved.model, baseModel:saved.model, apiKey:'' }; }
}
function readActiveAIFields() {
  const draft = aiProfileDrafts[aiFormProvider]; if (!draft) return;
  draft.model = $('#model-input').value; draft.apiKey = $('#api-key').value;
}
function renderAIProfileFields() {
  const provider = aiProviderCatalog().find(item => item.id === aiFormProvider); const draft = aiProfileDrafts[aiFormProvider]; const saved = savedAIProfile(aiFormProvider);
  if (!draft) return;
  $('#ai-provider').value = aiFormProvider;
  $('#ai-provider-trigger').textContent = provider.label; $('#ai-provider-trigger').setAttribute('aria-label', 'AI 服务：' + provider.label); $('#ai-provider-trigger').title = '选择 AI 服务';
  $('#ai-model-presets').setAttribute('aria-label', '选择 ' + provider.label + ' 模型预设'); $('#ai-model-presets').title = '选择模型预设，也可直接输入模型名称';
  if ($('#model-input').value !== draft.model) $('#model-input').value = draft.model;
  const manual = $('#model-manual-enabled')?.checked === true; $('#model-input').disabled = !manual; $('#ai-model-presets').disabled = !manual;
  $('#prefer-free-model-row').classList.toggle('hidden', aiFormProvider !== 'gemini');
  $('#prefer-free-model').disabled = manual;
  if ($('#api-key').value !== draft.apiKey) $('#api-key').value = draft.apiKey;
  $('#api-key-label-text').textContent = provider.label + ' API Key';
  $('#key-status').textContent = draft.apiKey.trim() ? '待保存' : saved.hasApiKey ? '已安全保存' : '未设置';
  $('#api-key').placeholder = saved.hasApiKey ? '已保存密钥；留空保持不变' : '输入密钥，保存后不再显示';
  $('#ai-model-help').textContent = '选择预设，或填写你的 ' + provider.label + ' 模型名称。';
  if (aiRenderedProvider !== aiFormProvider) { const options = $('#ai-model-options'); options.replaceChildren(); provider.models.forEach(model => { const option = node('option'); option.value = model; options.append(option); }); aiRenderedProvider = aiFormProvider; }
}
function changeAIProvider() { readActiveAIFields(); aiFormProvider = validAIProvider($('#ai-provider').value); renderAIProfileFields(); markSettingsDirty(); }
function changeAIProfileField(selector) { readActiveAIFields(); markSettingsDirty(); if (selector === '#api-key') $('#key-status').textContent = $('#api-key').value.trim() ? '待保存' : savedAIProfile(aiFormProvider).hasApiKey ? '已安全保存' : '未设置'; }
function dispatchAIFieldChange(element, type, fallback) { if (element.dispatchEvent && window.Event) element.dispatchEvent(new window.Event(type, { bubbles:true })); else fallback(); }
async function openAIProviderMenu() {
  const anchor = $('#ai-provider-trigger'); if (anchor.disabled) return; if (aiProviderMenuOpen) { window.InMomentMenus?.close?.(); return; }
  if (!window.InMomentMenus?.open) { toast('AI 服务选择暂时不可用，请重试。', true); return; }
  const provider = aiFormProvider, navigationVersion = state.navigationVersion, sectionVersion = settingsSectionVersion; aiProviderMenuOpen = true; anchor.setAttribute('aria-expanded', 'true');
  try {
    const result = await window.InMomentMenus.open({ anchor, title:'AI 服务', selection:true, items:aiProviderCatalog().map(item => ({ id:item.id,label:item.label,selected:item.id === provider })) });
    if (!aiProviderIds.includes(result) || provider !== aiFormProvider || navigationVersion !== state.navigationVersion || sectionVersion !== settingsSectionVersion || !anchor.isConnected) return;
    if (result !== aiFormProvider) { $('#ai-provider').value = result; dispatchAIFieldChange($('#ai-provider'),'change',changeAIProvider); }
  } finally { aiProviderMenuOpen = false; anchor.setAttribute('aria-expanded', 'false'); }
}
async function openAIModelMenu() {
  const anchor = $('#ai-model-presets'); if (anchor.disabled) return; if (aiModelMenuOpen) { window.InMomentMenus?.close?.(); return; }
  if (!window.InMomentMenus?.open) { toast('模型预设暂时不可用，请重试。', true); return; }
  const provider = aiFormProvider, navigationVersion = state.navigationVersion, sectionVersion = settingsSectionVersion; const models = aiProviderCatalog().find(item => item.id === provider).models; aiModelMenuOpen = true; anchor.setAttribute('aria-expanded', 'true');
  try {
    const result = await window.InMomentMenus.open({ anchor, title:'模型预设', selection:true, items:models.map(model => ({ id:model,label:model,selected:model === $('#model-input').value.trim() })) });
    if (!models.includes(result) || provider !== aiFormProvider || navigationVersion !== state.navigationVersion || sectionVersion !== settingsSectionVersion || !anchor.isConnected) return;
    if ($('#model-input').value !== result) { $('#model-input').value = result; dispatchAIFieldChange($('#model-input'),'input',() => changeAIProfileField('#model-input')); dispatchAIFieldChange($('#model-input'),'change',() => changeAIProfileField('#model-input')); }
    $('#model-input').focus?.();
  } finally { aiModelMenuOpen = false; anchor.setAttribute('aria-expanded', 'false'); }
}
function collectAIProfileChanges() {
  readActiveAIFields(); const changes = {};
  for (const [id,draft] of Object.entries(aiProfileDrafts)) { const model = draft.model.trim(), apiKey = draft.apiKey.trim(); if (model !== draft.baseModel || apiKey) changes[id] = { model, ...(apiKey ? { apiKey } : {}) }; }
  return changes;
}
function reconcileAIProfileDrafts(submitted) {
  for (const [id,draft] of Object.entries(aiProfileDrafts)) {
    const saved = savedAIProfile(id); const sent = submitted[id]; const untouched = draft.model.trim() === draft.baseModel;
    if (untouched || sent && draft.model.trim() === sent.model) draft.model = saved.model;
    draft.baseModel = saved.model;
    if (sent?.apiKey && draft.apiKey.trim() === sent.apiKey) draft.apiKey = '';
  }
  renderAIProfileFields();
}
function renderSettings() {
  const settings = state.settings;
  $('#input-enabled').checked = settings.inputEnabled !== false;
  $('#capture-screenshots').checked = settings.captureScreenshots !== false;
  renderShortcutCapture();
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
  $('#note-selection-context-enabled').checked = Boolean(settings.noteSelectionContextEnabled);
  $('#screenshot-analysis-enabled').checked = Boolean(settings.screenshotAnalysisEnabled);
  if ($('#model-manual-enabled')) $('#model-manual-enabled').checked = settings.modelMode === 'manual';
  $('#prefer-free-model').checked = settings.preferFreeModel !== false;
  resetAIProfileDrafts(); renderAIProfileFields();
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
  $('#timing-timeline').textContent = `按下${trigger} → ${showAt} ms 显示进度条 → ${confirmAt} ms 确认触发 → 再等 ${Math.max(0, timing.captureDelayMs)} ms 截图 → 截图处理后再等 ${Math.max(0, timing.menuDelayMs)} ms 显示录音胶囊`;
}
function resetTimingForm() {
  $('#preview-delay-input').value = 0; $('#threshold-input').value = 550; $('#capture-delay-input').value = 0; $('#menu-delay-input').value = 0; $('#keyboard-trigger-input').value = 'none';
  updateTimingTimeline(); $('#timing-result').textContent = '已恢复表单中的默认时序，保存后生效。';
  markSettingsDirty();
}
function markSettingsDirty() { state.settingsRevision += 1; state.settingsDirty = true; notifyDirty(); $('#settings-result').textContent = '有未保存设置；离开此页不会丢失表单'; }
let nextShortcutCaptureId = 0;
let shortcutCapture = null;
function renderShortcutCapture() {
  $('#region-shortcut-input').setAttribute('aria-pressed', String(Boolean(shortcutCapture)));
  $('#region-shortcut-value').textContent = shortcutCapture
    ? shortcutCapture.candidate || '请按下组合键…'
    : state.settings.regionScreenshotShortcut || 'Ctrl+Shift+F9';
}
async function startShortcutCapture() {
  if (shortcutCapture) { stopShortcutCapture(); return; }
  const captureId = ++nextShortcutCaptureId;
  shortcutCapture = { id: captureId, candidate: '' };
  setRegionShortcutError('');
  renderShortcutCapture();
  try {
    const started = await invoke('settings:shortcutCapture', { active: true, captureId });
    if (!started && shortcutCapture?.id === captureId) stopShortcutCapture();
  } catch (error) {
    if (shortcutCapture?.id !== captureId) return;
    stopShortcutCapture();
    setRegionShortcutError(error.message);
  }
}
function stopShortcutCapture() {
  if (!shortcutCapture) return;
  const captureId = shortcutCapture.id;
  shortcutCapture = null;
  setRegionShortcutError('');
  renderShortcutCapture();
  invoke('settings:shortcutCapture', { active: false, captureId }).catch(() => {});
}
function captureShortcutKey(event) {
  if (!shortcutCapture) return;
  const down = event.type === 'keydown';
  if (down && event.key === 'Tab') { stopShortcutCapture(); return; }
  event.preventDefault(); event.stopPropagation();
  if (down && event.key === 'Escape') { stopShortcutCapture(); return; }
  const input = { type: down ? 'keyDown' : 'keyUp', key: event.key, code: event.code, isAutoRepeat: event.repeat, isComposing: event.isComposing,
    control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey };
  invoke('settings:shortcutKey', { captureId: shortcutCapture.id, input }).catch(() => {});
}
function applyShortcutCapture(event) {
  if (event.shortcut) {
    state.settings = { ...state.settings, regionScreenshotShortcut: event.shortcut };
    state.capabilities = { ...state.capabilities, regionScreenshot: event.status };
    renderCapabilities();
  }
  if (shortcutCapture?.id !== event.id) {
    if (event.shortcut) renderShortcutCapture();
    return;
  }
  if (event.done) shortcutCapture = null;
  else shortcutCapture.candidate = event.candidate || '';
  setRegionShortcutError(event.error || '');
  renderShortcutCapture();
}
function setRegionShortcutError(message) {
  const field = $('#region-shortcut-input');
  const feedback = $('#region-shortcut-error');
  if (message) field.setAttribute('aria-invalid', 'true');
  else field.removeAttribute('aria-invalid');
  feedback.textContent = message;
  setVisible(feedback, Boolean(message));
}
function renderCapabilities() {
  const capabilities = state.capabilities; const status = $('#capability-status'); status.replaceChildren();
  const label = node('strong', '', '桌面能力状态'); status.append(label);
  const hook = capabilities.nativeAvailable ?? capabilities.globalHook ?? capabilities.rightButtonHook ?? capabilities.mouseHook ?? capabilities.nativeHook;
  status.append(node('div', '', state.settings.inputEnabled === false ? '全局长按已关闭。' : hook === false ? '全局按键监听当前不可用。' : hook === true ? `全局监听已就绪。可长按右键${['F8', 'F9', 'F10'].includes(state.settings.keyboardTrigger) ? `或 ${state.settings.keyboardTrigger}` : ''}触发。` : '以原生模块启动状态为准。'));
  const region = capabilities.regionScreenshot;
  const shortcut = region?.shortcut || state.settings.regionScreenshotShortcut || 'Ctrl+Shift+F9';
  const instruction = `按 ${shortcut}，拖动框选，松手即开始录音。录音时可以标注，截图单独确认。`;
  $('#region-shortcut-guide').textContent = region?.error ? `${shortcut} · ${region.error}` : instruction;
  if (region?.available || region?.error) {
    status.append(node('div', '', region.error ? `${shortcut} · ${region.error}` : instruction));
  }
  const offlineASR = capabilities.offlineASR;
  status.append(node('div', '', offlineASR?.available ? `本地转写：${offlineASR.model || 'SenseVoiceSmall'}（音频不上传）` : offlineASR?.reason === 'upgrade-required' ? '本地转写已改用 SenseVoiceSmall，请重新准备离线语音组件。' : capabilities.asrStatus === 'checking' ? '正在检测 SenseVoiceSmall 本地语音模型…' : 'SenseVoiceSmall 本地模型暂未就绪，可在记录详情中手动补充转写。'));
  if (capabilities.localCleanupError) status.append(node('div', 'privacy-note', '部分转写临时文件尚未清理，请退出应用并检查本地目录权限后重试。'));
}
function sessionState(session) { return session?.state || session?.status || 'idle'; }
function recoverableDraftCount() {
  return state.drafts.filter(draft => draft.id !== state.session?.id && ['draft', 'committing'].includes(draft.status)).length;
}
function renderDraftNavigation() {
  const count = recoverableDraftCount();
  const badge = $('#draft-count'); badge.textContent = count > 99 ? '99+' : String(count); badge.classList.toggle('hidden', !count);
  const entry = $('#open-drafts');
  entry.classList.toggle('hidden', !count);
  entry.setAttribute('aria-label', count ? `恢复录音，${count} 条` : '恢复录音');
}
function returnFromEmptyRecovery() {
  if (state.view !== 'drafts' || state.draftBusy || state.draftTopicDirty || recoverableDraftCount()) return;
  state.selectedDraftId = null;
  showView('notes');
  $('#open-notes').focus();
}
function renderSession(session) {
  state.session = session; const status = sessionState(session); const active = Boolean(session && session.active !== false && !['idle', 'saved', 'completed', 'discarded'].includes(status)); const showBanner = active && session.captureOrigin !== 'chatVoice'; $('#session-banner').classList.toggle('hidden', !showBanner);
  let returnChat = sessionReturnChat;
  if (!returnChat) {
    returnChat = node('button', 'button secondary compact hidden'); returnChat.id = 'session-return-chat'; returnChat.textContent = '返回聊天'; returnChat.setAttribute('data-ui-icon', 'chat');
    returnChat.addEventListener('click', () => act(returnChat, async () => { const id = state.session?.chatOwnerId; if (id) await invoke('chat:openFloating', { id }); }));
    const banner = $('#session-banner'), pause = $('#session-pause'); if (pause.parentElement === banner) banner.insertBefore(returnChat, pause); else banner.append(returnChat); sessionReturnChat = returnChat;
  }
  returnChat.classList.toggle('hidden', !showBanner || !session?.chatOwnerId); returnChat.disabled = state.draftBusy || status === 'processing';
  const paused = status === 'paused'; const recording = status === 'recording'; const mode = session?.mode || session?.triggerMode;
  $('#session-finish').title = session?.keepText !== false && !session?.committingText ? '核对文字并存为笔记' : '存为笔记';
  $('#session-title').textContent = paused ? '录音已暂停' : status === 'error' ? '录音遇到问题' : status === 'preparing' ? '正在准备录音…' : '正在录音';
  $('#session-description').textContent = session?.error?.message || session?.error || (paused ? '可继续录音、存为笔记或删除草稿。' : mode === 'hold' ? `首次录音 · 松开 ${triggerLabel(session?.triggerKey)} 自动暂停` : '点击暂停结束这一段');
  $('#session-pause').classList.toggle('hidden', !recording || mode === 'hold'); $('#session-continue').classList.toggle('hidden', !paused); $('#session-finish').classList.toggle('hidden', !paused);
  for (const selector of ['#session-pause', '#session-continue', '#session-finish', '#session-discard']) $(selector).disabled = status === 'processing' || state.draftBusy;
  renderDraftNavigation();
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
  [['删除', 'draft:discard', 'quiet danger'], ['继续录音', 'draft:continue', 'secondary'], ['存为笔记', 'draft:finish', 'primary']].forEach(([label, method, style]) => {
    const button = node('button', 'button ' + style + ' compact', label);
    if (method === 'draft:discard') button.setAttribute('data-ui-icon', 'trash');
    if (method === 'draft:finish' && draft.keepText !== false && !draft.committingText) button.title = '核对文字并存为笔记';
    const pendingCommit = draft.status === 'committing' || draft.committingText;
    button.disabled = state.draftBusy || (pendingCommit ? method !== 'draft:finish' || activeOther || status === 'processing' && state.session?.id === draft.id : status === 'processing' || (method !== 'draft:discard' && (status !== 'paused' || activeOther)));
    button.addEventListener('click', () => act(button, async () => { if (method === 'draft:discard' && state.session?.id !== draft.id && segmentList(draft).length && !await dialogs.confirm({ title: '删除历史草稿？', message: '删除这条历史草稿及全部截图、录音？', detail: '此操作无法撤销。', confirmLabel: '删除草稿', danger: true })) return; await sessionAction(method, button, draft.id); })); actions.append(button);
  }); parent.append(actions);
  if (activeOther) parent.append(node('p', 'field-help', '先完成或删除当前正在记录的草稿，才能恢复这一条。可先预览已有内容。'));
  if (status === 'preparing') parent.append(node('p', 'field-help', '正在准备截图或麦克风，尚未开始的采集可通过松开按键取消。'));
  if (status === 'processing') parent.append(node('p', 'field-help', '正在保存，完成后可在笔记中查看。'));
}
function renderDrafts() {
  const list = $('#draft-list'); list.replaceChildren(); const items = mergedDrafts();
  if (!items.length) { list.append(emptyState('暂无未保存录音', '草稿保存在本机。', 'list-empty')); if (!state.selectedDraftId) $('#draft-detail').replaceChildren(emptyState('选择一条草稿预览', '查看现场与录音后，再决定如何处理。', 'detail-empty')); return; }
  items.forEach(draft => {
    const card = node('article', 'draft-card');
    const open = node('button', 'draft-open', draft.title || '一段还在发生的想法'); open.setAttribute('aria-current', String(draft.id === state.selectedDraftId)); open.setAttribute('aria-label', '预览草稿：' + (draft.title || '未命名')); open.addEventListener('click', () => openDraft(draft.id));
    const labels = { recording: '录音中', preparing: '准备中', paused: '已暂停 / 可恢复', processing: '正在提交' };
    add(card, open, node('p', '', formatDate(draft.createdAt) + ' · ' + (labels[sessionState(draft)] || '可恢复')));
    draftActions(card, draft); list.append(card);
  });
}
async function openDraft(id, options = {}) {
  const navigationVersion = options.passive ? state.navigationVersion : ++state.navigationVersion;
  if (state.draftTopicDirty && state.selectedDraftId === id && !options.force) { const actions = $('#draft-preview-actions'); actions.replaceChildren(); const draft = mergedDrafts().find(item => item.id === id); if (draft) draftActions(actions, draft); return; }
  if (state.draftTopicDirty && !await dialogs.confirm({ title: '切换草稿预览？', message: '草稿分组尚未保存。', detail: '切换将放弃这些分组修改，原始录音与截图保留。', confirmLabel: '放弃修改并切换' })) return;
  state.draftTopicDirty = false; notifyDirty(); stopAudio(true); state.selectedDraftId = id; renderDrafts(); $('#draft-detail').replaceChildren(emptyState('正在读取草稿…', '所有原始材料仍在本机。', 'detail-empty'));
  try {
    const result = await invoke('records:get', { id }); const record = result?.record || result;
    if (state.selectedDraftId !== id) return; if (!record) throw new Error('草稿已不存在。');
    if (record.status === 'saved') { if (navigationVersion !== state.navigationVersion) return; state.selectedDraftId = null; await openNotebook('record:' + id); return; }
    const value = { ...record, ...(mergedDrafts().find(item => item.id === id) || {}) }; const inner = node('div', 'detail-inner'); add(inner, node('h2', '', recordTitle(record)), node('p', 'field-help', '未保存录音'));
    const actions = node('div'); actions.id = 'draft-preview-actions'; draftActions(actions, value); inner.append(actions);
    mountedAudio = []; const audio = audioSection(record); const voiceNote = node('section', 'voice-note'); voiceNote.setAttribute('aria-label', '录音与文本'); const voiceHeading = node('div', 'voice-note-heading'); voiceHeading.append(node('h3', '', '录音与文本')); const audioArea = node('div', 'record-audio-section'); audioArea.append(audio.area); add(voiceNote, voiceHeading, audioArea);
    if (transcriptText(record)) { const textArea = node('div', 'record-text-panel'); add(textArea, node('h3', '', '语音文本'), node('p', 'original-transcript', transcriptText(record))); voiceNote.append(textArea); } inner.append(voiceNote);
    renderCaptureDetails(inner, record);
    let draftRevision = 0; const choices = topicChoices(record, () => { draftRevision += 1; state.draftTopicDirty = true; notifyDirty(); topicStatus.textContent = '草稿分组尚未保存'; }); const topicStatus = node('p', 'field-help'); const saveTopics = node('button', 'button secondary compact ui-confirm', '保存草稿分组'); saveTopics.addEventListener('click', () => act(saveTopics, async () => { const revision = draftRevision; await invoke('records:setTopics', { id, topicIds: choices.ids() }); if (state.selectedDraftId === id && revision === draftRevision) state.draftTopicDirty = false; notifyDirty(); topicStatus.textContent = state.draftTopicDirty ? '提交版本已保存，后续分组修改仍未保存' : '草稿分组已保存'; await refresh(); })); add(inner, choices.area, saveTopics, topicStatus);
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
      if (method === 'draft:finish' && !result?.needsTextReview && navigationVersion === state.navigationVersion) { toast('已存为笔记'); const savedId = (result?.record || result)?.id || id; await openNotebook(savedId ? 'record:' + savedId : null); }
    } catch (error) { $('#draft-error').textContent = error.message || '草稿操作未完成，请重试。'; $('#draft-error').classList.remove('hidden'); throw error; }
    finally { state.draftBusy = false; renderSession(state.session); returnFromEmptyRecovery(); }
  });
}
async function search(query) { state.query = query.trim(); await loadLibrary(); }
async function refresh(initial = false) {
  const result = await invoke('app:bootstrap'); if (!result) return;
  state.records = result.records || []; state.recordCount = result.recordCount ?? state.records.length; state.recordHeaders = result.recordHeaders || state.records; state.drafts = result.drafts || []; state.settings = result.settings || {}; state.capabilities = result.capabilities || {}; state.topics = result.topics || []; state.duplicateSuggestions = result.duplicateSuggestions || []; state.groups = result.groups || [];
  const waveformRecordIds = new Set([...state.recordHeaders, ...state.drafts].map(record => record.id)); for (const [key, entry] of audioWaveformCache) if (!waveformRecordIds.has(entry.id)) audioWaveformCache.delete(key);
  if (state.recordProjection && !state.recordHeaders.some(record => record.id === state.recordProjection.record.id)) state.recordProjection = null;
  if (screenshotViewer?.recordId && ![...state.recordHeaders, ...state.drafts].some(record => record.id === screenshotViewer.recordId)) closeScreenshot();
  renderTopics(); renderSession(result.session || null); if (initial) renderSettings(); if (chatView && result.chats) chatView.setList(result.chats);
  if (state.view === 'notes') await ensureNotesView().show(state.topics);
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
  returnFromEmptyRecovery();
  if (state.view === 'drafts' && state.selectedDraftId) await openDraft(state.selectedDraftId, { passive: true });
}
function openGuide() { const guide = $('#guide-dialog'); if (!guide.open) guide.showModal(); $('#open-guide').setAttribute('aria-expanded', String(guide.open)); }
function closeGuide() { $('#guide-dialog').close(); $('#open-guide').setAttribute('aria-expanded', 'false'); }
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => state.view === 'chat' && button.dataset.view !== 'chat' ? act(button, async () => { if (await prepareChatNavigation()) showView(button.dataset.view); }) : showView(button.dataset.view)));
$('#open-guide').addEventListener('click', openGuide); $('#close-guide').addEventListener('click', closeGuide); $('#guide-done').addEventListener('click', closeGuide); $('#guide-dialog').addEventListener('close', () => $('#open-guide').setAttribute('aria-expanded', String($('#guide-dialog').open)));
$('#back-to-group-home').addEventListener('click', () => act(null, returnToGroupHome));
$('#toggle-group-sidebar').addEventListener('click', () => setGroupSidebar(!document.body.classList?.contains('group-sidebar-open')));
$('#fold-notebook-groups').addEventListener('click', toggleNotebookGroupColumn);
for (const selector of ['#close-group-sidebar', '#group-sidebar-backdrop']) $(selector).addEventListener('click', () => setGroupSidebar(false));
document.addEventListener('focusin', event => {
  if (!document.body.classList.contains('group-sidebar-open') || !window.matchMedia?.('(max-width: 900px)').matches) return;
  const { target } = event;
  if (target !== $('#toggle-group-sidebar') && target !== $('#group-sidebar-backdrop') &&
      !within(target, $('#primary-group-sidebar')) && !target.closest?.('dialog[open]')) setGroupSidebar(false);
});
$('#create-primary-group').addEventListener('click', () => openPrimaryGroupForm());
$('#cancel-primary-group').addEventListener('click', closePrimaryGroupForm);
$('#primary-group-create-form').addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); closePrimaryGroupForm(); }
});
$('#primary-group-create-form').addEventListener('submit', event => {
  event.preventDefault();
  const button = $('#save-primary-group');
  if (button.disabled) return;
  return act(button, async () => {
    const name = $('#primary-group-name').value.trim();
    if (!name || Array.from(name).length > 60) { $('#primary-group-status').textContent = '分组名称请填写 1–60 个字符。'; return; }
    const { mode, group } = primaryGroupForm;
    const navigationVersion = state.navigationVersion;
    const topic = mode === 'rename' ? await invoke('topics:rename', { id: group.id, name }) : await invoke('topics:create', { name, ...(group && { parentId: group.id }) });
    if (!topic?.id) throw new Error('分组保存未完成，请重试。');
    closePrimaryGroupForm();
    await refresh();
    if (mode !== 'rename' && navigationVersion === state.navigationVersion) await selectPrimaryGroup(topic.id);
  });
});
$('#open-primary-group-manager').addEventListener('click', () => {
  if (!$('#group-management-dialog').open) { cancelTopicSelection(true); $('#group-management-dialog').showModal(); }
});
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
  if (dialogs.open || window.InMomentNoteImageViewer?.isOpen()) return;
  if (window.InMomentNoteImageViewer?.isOpen()) return;
  if ($('#guide-dialog').open || $('#note-background-dialog').open) return;
  if (event.key === 'Escape' && !event.defaultPrevented && document.body.classList.contains('group-sidebar-open') && window.matchMedia?.('(max-width: 900px)').matches && !$('#group-management-dialog').open) { event.preventDefault(); setGroupSidebar(false); return; }
  if (state.view === 'notes' && notesView?.shortcut(event)) return;
  if (event.key === 'Escape' && !recordSelection.busy && (recordSelection.enabled || recordSelection.expandedId)) { event.preventDefault(); if (recordSelection.enabled) { clearRecordSelection(); renderList(); } else setCardActions(null); return; }
  if (event.key === 'Escape' && state.editingId === state.selectedId && state.view === state.detailContext.view) { event.preventDefault(); act(null, async () => { if (!state.detailDirty || await dialogs.confirm({ title: '结束编辑？', message: '放弃尚未保存的修改？', detail: '已保存的记录保留。', confirmLabel: '放弃修改' })) await selectRecord(state.selectedId, { discard: true }); }); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); act(null, async () => { if (state.view === 'chat' && !await prepareChatNavigation()) return; await openNotebook(); if (state.view === 'notes') await ensureNotesView().focusSearch(); }); }
});
$('#date-range').addEventListener('change', changeDateRange);
$('#date-range-trigger').addEventListener('click', openDateRange);
$('#date-range-trigger').addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); return openDateRange(); } });
$('#library-filter-trigger').addEventListener('click', openLibraryFilters);
for (const mode of ['grid', 'list']) $('#library-display-' + mode).addEventListener('click', () => setLibraryDisplay(mode));
$('#library-filter-trigger').addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); return openLibraryFilters(); } });
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
for (const section of settingsSections) $(`#settings-nav-${section}`).addEventListener('click', () => showSettingsSection(section));
$('#settings-form').addEventListener('invalid', event => {
  if (event.target !== event.currentTarget.querySelector(':invalid')) return;
  const pane = event.target.closest('[data-settings-pane]');
  if (pane) showSettingsSection(pane.dataset.settingsPane, { animate:false });
  const details = event.target.closest('details');
  if (details) details.open = true;
}, true);
for (const selector of ['#preview-delay-input', '#threshold-input', '#capture-delay-input', '#menu-delay-input', '#keyboard-trigger-input']) { $(selector).addEventListener('input', updateTimingTimeline); $(selector).addEventListener('change', updateTimingTimeline); }
$('#reset-timing').addEventListener('click', resetTimingForm);
$('#reset-settings').addEventListener('click', (event) => act(event.currentTarget, async () => {
  const result = await invoke('settings:reset');
  if (result?.cancelled || result?.canceled) { toast('已取消恢复，表单未改变'); return; }
  if (!result || typeof result !== 'object') throw new Error('默认设置未能恢复，请重试。');
  state.settings = result.settings || result; renderSettings(); $('#timing-result').textContent = ''; $('#settings-result').textContent = '已恢复默认设置'; toast('已恢复默认设置，记录与已保存密钥保留');
}));
for (const selector of ['#input-enabled', '#capture-screenshots', '#cloud-enabled', '#direct-ai-enabled', '#auto-title-enabled', '#ai-search-enabled', '#note-selection-context-enabled', '#screenshot-analysis-enabled', '#threshold-input', '#preview-delay-input', '#capture-delay-input', '#menu-delay-input', '#keyboard-trigger-input', '#excluded-apps']) { $(selector).addEventListener('input', markSettingsDirty); $(selector).addEventListener('change', markSettingsDirty); }
$('#region-shortcut-input').addEventListener('click', startShortcutCapture);
$('#region-shortcut-input').addEventListener('blur', stopShortcutCapture);
document.addEventListener('keydown', captureShortcutKey, true);
document.addEventListener('keyup', captureShortcutKey, true);
$('#ai-provider').addEventListener('change', changeAIProvider);
$('#model-manual-enabled')?.addEventListener('change', () => { renderAIProfileFields(); markSettingsDirty(); });
$('#prefer-free-model').addEventListener('change', markSettingsDirty);
$('#ai-provider-trigger').addEventListener('click', openAIProviderMenu); $('#ai-model-presets').addEventListener('click', openAIModelMenu);
for (const [selector,open] of [['#ai-provider-trigger',openAIProviderMenu],['#ai-model-presets',openAIModelMenu]]) $(selector).addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); return open(); } });
for (const selector of ['#model-input','#api-key']) for (const event of ['input','change']) $(selector).addEventListener(event, () => changeAIProfileField(selector));
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
    const aiProfiles = collectAIProfileChanges();
    for (const [id,profile] of Object.entries(aiProfiles)) { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(profile.model)) { toast(aiProviderCatalog().find(provider => provider.id === id).label + ' 的模型名称无效。请使用字母、数字、点、下划线、冒号或连字符，最多 100 个字符。', true); return; } }
    const params = { ...timing, modelMode:$('#model-manual-enabled')?.checked ? 'manual' : 'auto', inputEnabled: $('#input-enabled').checked, captureScreenshots: $('#capture-screenshots').checked, autoTitleEnabled: $('#auto-title-enabled').checked, aiSearchEnabled: $('#ai-search-enabled').checked, screenshotAnalysisEnabled: $('#screenshot-analysis-enabled').checked, excludedApps: $('#excluded-apps').value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean), cloudEnabled: $('#cloud-enabled').checked, directAIEnabled: $('#direct-ai-enabled').checked, aiProvider:aiFormProvider, aiProfiles };
    params.noteSelectionContextEnabled = $('#note-selection-context-enabled').checked;
    params.preferFreeModel = $('#prefer-free-model').checked;
    const result = await invoke('settings:save', params);
    if (result?.cancelled || result?.canceled) { $('#settings-result').textContent = '已取消保存，表单与已有设置保持不变'; return; }
    state.settings = result?.settings || result || {};
    const fresh = await invoke('settings:get'); state.settings = fresh?.settings || fresh || state.settings;
    reconcileAIProfileDrafts(aiProfiles);
    if (submittedRevision === state.settingsRevision) { renderSettings(); $('#settings-result').textContent = '设置已保存'; $('#timing-result').textContent = ''; }
    else { state.settingsDirty = true; $('#settings-result').textContent = '提交版本已保存；随后修改的表单仍未保存'; renderCapabilities(); }
    toast('设置已保存');
  }).finally(() => { settingsSaving = false; });
});
renderDetailEmpty(); renderList();
if (bridge?.subscribe) bridge.subscribe((event) => { if (!event) return; if (event.type === 'settingsChanged') chatView?.handleEvent(event); if (event.type === 'regionShortcutCapture') { applyShortcutCapture(event); return; } if (event.type === 'sourceFocusNotice') { showSourceFocusNotice(event); return; } if (event.type === 'noteOpen') { act(null, async () => { if (state.view === 'chat' && !await prepareChatNavigation()) return; if (screenshotViewer && await window.InMomentNoteImageViewer?.close({ owner: screenshotViewer, restoreFocus: false }) === false) return; await openNotebook(event.id); }); return; } if (event.type === 'chatOpen') { if (event.settings) showView('settings', { settingsSection:'ai' }); else act(null, () => openChat(event.id)); return; } if (['chatChanged','chatList','chatVoice','chatAudioLevel'].includes(event.type)) { ensureChatView()?.handleEvent(event); return; } if (event.type === 'batchOrganizeProgress') { batchProgress(event); return; } if (event.type === 'dialog:show') { dialogs.remote(event); return; } if (event.type === 'dialog:cancel') { dialogs.cancelRemote(event.id); return; } if (event.type === 'windowState') { document.body.classList?.toggle('window-maximized', Boolean(event.maximized)); return; } if (event.type === 'session' || event.type === 'sessionChanged') { renderSession(event.session); if (state.view === 'drafts' && state.selectedDraftId) openDraft(state.selectedDraftId, { passive: true }); } else if (event.type === 'capabilities') { state.capabilities = event.capabilities || state.capabilities; renderCapabilities(); } else if (['recordsChanged', 'draftsChanged', 'topicsChanged', 'settingsChanged', 'libraryChanged'].includes(event.type)) act(null, () => refresh()); else if (event.type === 'error') toast(event.message || '操作未完成', true); });
if (bridge?.invoke) { bridge.invoke('app:uiReady').catch(() => {}); bridge.invoke('window:state').then(result => document.body.classList?.toggle('window-maximized', Boolean(result?.maximized))).catch(() => {}); }
act(null, () => refresh(true));

