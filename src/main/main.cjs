'use strict';
const { app, BrowserWindow, ipcMain, protocol, safeStorage, dialog, Tray, Menu, nativeImage, powerMonitor, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { NativeBridge } = require('./native-bridge.cjs');
const { Settings } = require('./settings.cjs');
const { LocalStore } = require('../core/store.cjs');
const { DeepSeekClient } = require('../core/deepseek.cjs');
const { AutoTitleManager } = require('./auto-title.cjs');
const { CaptureController } = require('./capture-controller.cjs');
const { OfflineASR } = require('./offline-asr.cjs');
const { revealScreenshot, openOriginal, revealRecord } = require('./record-files.cjs');
const { LibraryAI, inScope } = require('./library-ai.cjs');
const { BatchOrganizer } = require('./batch-organizer.cjs');
const { resolveSearchScope } = require('./search-scope.cjs');
const { createSemanticService } = require('./semantic-service.cjs');
const { CAPABILITY_INFO, pendingCapabilities, assertCapability, normalizeFilters, hasDirectConsent } = require('./cloud-permissions.cjs');
const { selectedScreenshot } = require('./analysis-image.cjs');
const { AppDialogManager, isMainFrameEvent } = require('./app-dialogs.cjs');
const { mainChrome, overlayBehavior, windowState, controlWindow } = require('./window-ui.cjs');

app.setName('InMoment');
if (process.platform === 'win32') app.setAppUserModelId('InMoment.Desktop');
protocol.registerSchemesAsPrivileged([{ scheme: 'inmoment-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
if (process.env.INMOMENT_DATA_DIR) app.setPath('userData', path.resolve(process.env.INMOMENT_DATA_DIR));
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow, overlay, recorder, tray, store, settings, bridge, controller, offlineASR, autoTitles, libraryAI, semantic;
let uiDialogs;
let recorderReady = Promise.resolve(), quitting = false, shutdownStarted = false;
let quitApprovalPending = false;
let editState = { recordDirty: false, settingsDirty: false };
let progressActive = false;
let overlaySession = null;
let progressTriggerKey = 'right-button';
let capabilities = { nativeAvailable: false, speechEngines: [], asrStatus: 'checking', searchMode: 'local-keyword' };
const modelJobs = new Map();
const asrJobs = new Map();
const libraryTasks = new Map();
const mainFile = path.join(__dirname, '../renderer/index.html');
const overlayFile = path.join(__dirname, '../overlay/index.html');
const recorderFile = path.join(__dirname, '../recorder/index.html');

function broadcast(message) {
  if (shutdownStarted) return;
  for (const window of [mainWindow, overlay]) if (window && !window.isDestroyed()) {
    if (window === overlay && progressActive && message.type === 'session') { overlaySession = message; continue; }
    window.webContents.send('inmoment:event', message);
  }
}
function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionCheckHandler((contents, permission) => permission === 'media' && contents?.id === recorder?.webContents.id);
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(permission === 'media' && contents?.id === recorder?.webContents.id && !(details.mediaTypes || []).includes('video')));
}
function showMain() { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } }
function askDialog(options) {
  if (!uiDialogs) throw new Error('确认界面尚未就绪，请返回主窗口后重试。');
  return uiDialogs.showMessageBox(options);
}
function positionOverlay(point) {
  if (!overlay || overlay.isDestroyed()) return;
  const { screen } = require('electron');
  const cursor = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? screen.screenToDipPoint({ x: point.x, y: point.y }) : screen.getCursorScreenPoint();
  const work = screen.getDisplayNearestPoint(cursor).workArea;
  const [width, height] = overlay.getSize();
  overlay.setPosition(Math.round(Math.max(work.x + 12, Math.min(cursor.x + 24, work.x + work.width - width - 12))), Math.round(Math.max(work.y + 12, Math.min(cursor.y + 16, work.y + work.height - height - 12))));
}
function showOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  if (!progressActive) positionOverlay();
  else overlay.webContents.send('inmoment:event', { type: 'holdProgress', phase: 'complete', triggerKey: progressTriggerKey });
  if (overlaySession) { overlay.webContents.send('inmoment:event', overlaySession); overlaySession = null; }
  progressActive = false; overlay.setIgnoreMouseEvents(false); overlay.showInactive();
}
function hideOverlay() { progressActive = false; overlaySession = null; if (overlay && !overlay.isDestroyed()) { overlay.hide(); overlay.setIgnoreMouseEvents(false); } }
function startHoldProgress(data) {
  if (shutdownStarted || !settings.public().inputEnabled || controller.snapshot().active || !overlay || overlay.isDestroyed()) return;
  progressActive = true; overlaySession = null; progressTriggerKey = data.trigger || 'right-button';
  positionOverlay(data); overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.webContents.send('inmoment:event', { type: 'holdProgress', phase: 'start', thresholdMs: data.thresholdMs, startedAt: data.startedAt, triggerKey: progressTriggerKey });
  overlay.showInactive();
}
function cancelHoldProgress(data = {}) {
  if (!progressActive || controller.snapshot().active || !overlay || overlay.isDestroyed()) return;
  overlay.webContents.send('inmoment:event', { type: 'holdProgress', phase: 'cancel', reason: data.reason }); hideOverlay();
}
function imageIcon() {
  return nativeImage.createFromPath(path.join(__dirname, '../assets/tray-icon.png'));
}
function createWindows() {
  const options = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true };
  mainWindow = new BrowserWindow({ width: 1320, height: 900, minWidth: 1000, minHeight: 700, show: false, title: 'InMoment · 灵感现场', icon: path.join(__dirname, '../assets/icon.ico'), backgroundColor: '#f5f2eb', autoHideMenuBar: true, ...mainChrome, webPreferences: options });
  overlay = new BrowserWindow({ width: 400, height: 440, show: false, frame: false, transparent: true, resizable: false, alwaysOnTop: true, hasShadow: true, ...overlayBehavior, webPreferences: options });
  recorder = new BrowserWindow({ show: false, width: 180, height: 100, skipTaskbar: true, webPreferences: { ...options, preload: path.join(__dirname, 'recorder-preload.cjs'), backgroundThrottling: false } });
  for (const window of [mainWindow, overlay, recorder]) secureWindow(window);
  uiDialogs = new AppDialogManager({ getWindow: () => mainWindow, showWindow: showMain });
  mainWindow.webContents.on('did-start-loading', () => uiDialogs.cancelAll({ resetReady: true }));
  mainWindow.webContents.on('render-process-gone', () => uiDialogs.cancelAll({ resetReady: true }));
  mainWindow.on('hide', () => uiDialogs.cancelAll());
  mainWindow.on('closed', () => uiDialogs.close());
  for (const event of ['maximize', 'unmaximize']) mainWindow.on(event, () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('inmoment:event', { type: 'windowState', ...windowState(mainWindow) });
  });
  mainWindow.loadFile(mainFile); overlay.loadFile(overlayFile);
  recorderReady = recorder.loadFile(recorderFile);
  mainWindow.once('ready-to-show', () => { if (process.env.INMOMENT_SMOKE !== '1') mainWindow.show(); });
  mainWindow.on('close', event => { uiDialogs.cancelAll(); if (!quitting) { event.preventDefault(); mainWindow.hide(); } });
  overlay.on('close', event => { if (!quitting) { event.preventDefault(); overlay.hide(); } });
  recorder.webContents.on('render-process-gone', () => controller?.fail(new Error('录音组件异常，当前录音已停止。')));
  tray = new Tray(imageIcon()); tray.setToolTip('InMoment · 灵感现场');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开灵感现场', click: showMain }, { label: '暂停录音', click: () => controller?.pause() }, { type: 'separator' }, { label: '退出', click: () => app.quit() }]));
  tray.on('double-click', showMain);
}
function mediaURL(record, kind, id) { return `inmoment-media://record/${encodeURIComponent(record.id)}/${kind}/${encodeURIComponent(id)}`; }
function publicRecord(record) {
  if (!record) return null;
  const organization = record.organization;
  return {
    id: record.id, status: record.status, title: record.title || organization?.title || [...(record.transcript || '').replace(/\s+/gu, ' ').trim()].slice(0, 24).join('') || `灵感 · ${new Date(record.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`, editableTitle: record.title, task: record.task, notes: record.notes,
    createdAt: record.createdAt, updatedAt: record.completedAt || record.createdAt, durationMs: record.durationMs,
    transcript: record.transcript || (!record.segments.length ? record.notes : ''), transcriptionMetrics: record.transcription ? { provider: record.transcription.provider, model: record.transcription.model, durationMs: record.transcription.durationMs, audioDurationMs: record.transcription.audioDurationMs, rtf: record.transcription.rtf } : null, searchMode: record.searchMode || 'local-keyword', matchSnippet: record.matchSnippet,
    context: { appName: record.source?.processName || record.source?.appName || '来源未记录', windowTitle: record.source?.title || record.source?.windowTitle || '', url: record.source?.url || '' },
    audioSegments: record.segments.map(segment => ({ id: segment.id, url: mediaURL(record, 'audio', segment.id), durationMs: segment.durationMs, transcript: segment.transcript })),
    screenshotUrl: record.screenshots[0] ? mediaURL(record, 'image', record.screenshots[0].id) : '',
    screenshot: record.screenshots[0] ? { url: mediaURL(record, 'image', record.screenshots[0].id), capturedAt: record.screenshots[0].capturedAt } : null,
    organization: organization || null,
    version: record.version, contentVersion: record.contentVersion, organizationStale: record.organizationStale,
    topics: record.topics || [], topicIds: (record.topics || []).map(item => item.id), topicsManual: Boolean(record.topicsManual),
    parentId: record.parentId || null, parentTitle: record.parentTitle || '', continuations: record.continuations || [], duplicateGroupId: record.duplicateGroupId || null,
    questions: organization?.questions || [], jobs: record.jobs
  };
}
function publicGroup(group) { return group ? { ...group, records: (group.records || []).map(publicRecord) } : null; }
function bootstrap() {
  if (offlineASR) { const local = offlineASR.capabilities(); capabilities.offlineASR = { available: local.available, provider: local.provider, model: local.model }; if (local.available) capabilities.asrStatus = 'available'; }
  return { records: store.listRecords({ limit: 30 }).map(publicRecord), recordCount: store.countRecords(), recordHeaders: store.listRecordHeaders(), settings: settings.public(), capabilities, semantic: semantic?.status(), drafts: store.listDrafts().map(publicRecord), session: controller.snapshot(), topics: store.listTopics(), duplicateSuggestions: store.listDuplicateSuggestions(), groups: store.listGroups().map(publicGroup), version: app.getVersion(), libraryJobs: [...libraryTasks].map(([kind, task]) => ({ kind, status: task.status || 'processing', runId: task.runId, total: task.total })) };
}

function registerMedia() {
  protocol.handle('inmoment-media', request => {
    try {
      const url = new URL(request.url); const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (url.hostname !== 'record' || parts.length !== 3) return new Response('Not found', { status: 404 });
      const [id, kind, attachmentId] = parts; const record = store.get(id);
      if (!record) return new Response('Not found', { status: 404 });
      const attachment = kind === 'audio' ? record.segments.find(item => item.id === attachmentId) : kind === 'image' ? record.screenshots.find(item => item.id === attachmentId) : null;
      if (!attachment || !fs.existsSync(attachment.path)) return new Response('Not found', { status: 404 });
      const data = fs.readFileSync(store.safePath(attachment.path)); const range = request.headers.get('range');
      const headers = { 'Content-Type': kind === 'audio' ? 'audio/wav' : 'image/png', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
        if (!match) return new Response(null, { status: 416 });
        const start = Number(match[1]); const end = Math.min(data.length - 1, match[2] ? Number(match[2]) : data.length - 1);
        if (start > end || start >= data.length) return new Response(null, { status: 416 });
        return new Response(data.subarray(start, end + 1), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': String(end - start + 1) } });
      }
      return new Response(data, { headers: { ...headers, 'Content-Length': String(data.length) } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}

async function transcribe(id) {
  if (shutdownStarted || store.closed) return null;
  if (asrJobs.has(id)) return asrJobs.get(id).promise;
  if (capabilities.localCleanupError) {
    try { capabilities.localCleanupError = !offlineASR.cleanupStaleJobs().ok; } catch { capabilities.localCleanupError = true; }
    if (capabilities.localCleanupError) throw new Error('上次转写的临时文件尚未清理，请退出应用、检查本地目录权限后重试。');
  }
  const record = store.getRecord(id); if (!record) throw new Error('记录不存在。');
  if (!offlineASR.capabilities().available) {
    store.setJob(id, 'transcribe', 'unavailable', '本机未安装兼容的中文离线语音识别引擎，可在详情中手动补充文字。');
    broadcast({ type: 'recordsChanged' }); autoTitles.run(id).catch(() => {}); return publicRecord(store.getRecord(id));
  }
  if (!record.segments.length) return publicRecord(record);
  const abort = new AbortController();
  const originalText = JSON.stringify(record.segments.map(segment => [segment.id, segment.transcript]));
  store.setJob(id, 'transcribe', 'processing');
  broadcast({ type: 'recordsChanged' });
  const job = (async () => {
  try {
    const result = await offlineASR.transcribe(record, { signal: abort.signal });
    if (shutdownStarted || store.closed || abort.signal.aborted || !store.getRecord(id)) return null;
    const grouped = result.segments;
    if (grouped.every(segment => !segment.text) && result.text) grouped[0].text = result.text;
    const currentText = JSON.stringify(store.getRecord(id).segments.map(segment => [segment.id, segment.transcript]));
    store.saveTranscription(id, { ...result, segments: grouped });
    if (currentText === originalText) { store.setTranscript(id, grouped); store.setJob(id, 'transcribe', 'done'); }
    else store.setJob(id, 'transcribe', 'not-applied', '本地转写已完成；你已修改文字，因此保留你的修订，未覆盖。');
    broadcast({ type: 'recordsChanged' }); autoTitles.run(id).catch(() => {}); return publicRecord(store.getRecord(id));
  } catch (error) { if (!shutdownStarted && !store.closed && store.getRecord(id)) store.setJob(id, 'transcribe', 'failed', '本地转写未完成，可重试或手动补充文字。'); broadcast({ type: 'recordsChanged' }); throw error; }
  finally { asrJobs.delete(id); }
  })();
  asrJobs.set(id, { abort, promise: job });
  return job;
}
async function organize(id, { includeScreenshot = false, expectedVersion, expectedGeneration, signal, requestApproved = false, deferGrouping = false } = {}) {
  assertCapability(settings.public(), 'cloudEnabled');
  if (modelJobs.has(id)) throw new Error('这条记录已有整理任务。');
  const key = settings.key(); if (!key) throw new Error('请先在设置中输入自己的 DeepSeek API Key。');
  const record = store.getRecord(id); if (!record || !(record.transcript || record.notes)?.trim()) throw new Error('请先补充转写或表达文字，再进行 AI 整理。');
  const generation = store.row(id)?.generation;
  if (expectedVersion !== undefined && record.version !== expectedVersion || expectedGeneration !== undefined && generation !== expectedGeneration) throw new Error('记录已修改或删除，本次没有发送；请刷新后重试。');
  const sameRecord = () => !shutdownStarted && !store.closed && store.getRecord(id) && store.row(id)?.generation === generation;
  const direct = hasDirectConsent(settings.public());
  const aiRecord = { ...record, segments: [...record.segments] };
  if (!record.transcript?.trim() && record.notes?.trim()) aiRecord.segments.push({ id: `note-${id}`, transcript: record.notes, sourceType: 'written-note' });
  let image;
  // A pre-approved batch freezes its upload scope and image budget at the click.
  // Turning on screenshots during that batch must not add new material to later items.
  const screenshotRequested = requestApproved === true ? includeScreenshot === true : direct ? settings.public().screenshotAnalysisEnabled === true : includeScreenshot === true;
  const useScreenshot = screenshotRequested && record.screenshots.length > 0;
  if (useScreenshot) {
    assertCapability(settings.public(), 'screenshotAnalysisEnabled');
    if (settings.public().model !== 'deepseek-flash') throw new Error('当前模型不支持截图理解。请在设置中选择 deepseek-flash，或取消本次截图。');
    image = selectedScreenshot(store, record);
  }
  const abort = new AbortController(); const cancel = () => abort.abort();
  if (signal?.aborted) return { cancelled: true };
  signal?.addEventListener('abort', cancel, { once: true }); modelJobs.set(id, abort);
  try {
    let approved = direct || requestApproved;
    if (!approved) {
      showMain();
      const approval = await askDialog({
      type: 'question', title: '允许这一次 DeepSeek 请求？',
      message: '将这条记录的文字发送给 DeepSeek 整理？',
      detail: `将发送 ${record.segments.length} 段转写、任务、补充文字、已有主题名称，以及已保存的来源应用、窗口标题和网址线索。${image ? '同时发送预览中的这张来源截图，可能包含个人信息。' : '本次不发送截图。'}不发送原始音频。模型：${settings.public().model}。可能产生 API 费用，本次同意仅授权一次请求，不会自动重试。`,
      buttons: ['取消', '同意发送一次'], defaultId: 0, cancelId: 0, noLink: true,
      });
      approved = approval.response === 1;
    }
    if (!approved || !sameRecord() || abort.signal.aborted) return { cancelled: true };
    if (store.getRecord(id).version !== record.version) throw new Error('确认期间记录已修改，本次未发送；请核对内容后重新整理。');
    assertCapability(settings.public(), 'cloudEnabled');
    if (direct && !hasDirectConsent(settings.public())) throw new Error('点击即发送授权已关闭，本次未发送。');
    if (image) assertCapability(settings.public(), 'screenshotAnalysisEnabled');
    store.setJob(id, 'organize', 'processing');
    broadcast({ type: 'recordsChanged' });
    const result = await new DeepSeekClient({ apiKey: key, model: settings.public().model }).organize({ ...aiRecord, availableTopics: store.listTopics().map(item => item.name) }, { approved: true, signal: abort.signal, image, deferGrouping });
    if (!sameRecord() || abort.signal.aborted) return { cancelled: true };
    store.saveOrganization(id, deferGrouping ? { ...result, topicSuggestions: [] } : result, { expectedVersion: record.version }); store.setJob(id, 'organize', 'done'); broadcast({ type: 'recordsChanged' }); return publicRecord(store.getRecord(id));
  } catch (error) {
    if (sameRecord()) store.setJob(id, 'organize', abort.signal.aborted ? 'cancelled' : 'failed', abort.signal.aborted ? '整理已取消。已发送的请求仍可能产生费用。' : '整理未应用；可能是内容已修改、设置不可用或服务异常。原始记录仍保留，可重新整理。');
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (sameRecord() && store.getRecord(id).jobs.some(job => job.kind === 'organize' && job.status === 'processing')) store.setJob(id, 'organize', 'cancelled', '整理已停止，原始记录保留。');
    modelJobs.delete(id); broadcast({ type: 'recordsChanged' });
  }
}

async function runLibraryTask(kind, params) {
  const capability = kind === 'search' ? 'aiSearchEnabled' : 'duplicateAnalysisEnabled';
  assertCapability(settings.public(), capability);
  if (libraryTasks.size) throw new Error('已有资料库 AI 任务，请等待完成或先取消。');
  const query = String(params.query || '').trim().slice(0, 500);
  if (kind === 'search' && !query) throw new Error('请先描述你想找的灵感。');
  const resolvedScope = kind === 'search' ? resolveSearchScope(query, params.filters) : { filters: normalizeFilters(params.filters) };
  const filters = resolvedScope.filters;
  const scopeTotal = store.countRecords(filters);
  if (!scopeTotal) return kind === 'search' ? { ...resolvedScope, records: [], total: 0, scopeTotal: 0, candidateCount: 0, explanation: '当前范围没有已保存记录。' } : { suggestions: [], groups: store.listGroups().map(publicGroup), coverage: { scopeCount: 0, examinedCount: 0 } };
  const direct = hasDirectConsent(settings.public());
  const abort = new AbortController(); const task = { abort, status: 'confirming' }; libraryTasks.set(kind, task);
  try {
    let approved = direct;
    if (!approved) {
      const approval = await askDialog({
      type: 'question', title: kind === 'search' ? '允许这一次 AI 查找？' : '允许这一次重复分析？',
      message: kind === 'search' ? `在选定范围的 ${scopeTotal} 条灵感中查找？` : `分析选定范围内可能重复的灵感？`,
      detail: kind === 'search' ? '先发送搜索描述，再发送本地筛出的最多 20 条候选的原话片段、摘要、任务与来源线索；最多两次请求。不是逐条阅读全库。不发送录音或截图。会产生 API 费用，取消不能撤回已经发送的内容。' : `范围共 ${scopeTotal} 条。先在本地筛选候选，本次最多比较 5 对，只运行一批请求。发送候选原话片段、摘要、任务与来源线索，不发送录音或截图。只生成重复建议，不直接合并或删除。会显示覆盖和用量，未检查的候选需再次点击分析。`,
      buttons: ['取消', '同意本次分析'], defaultId: 0, cancelId: 0, noLink: true,
      });
      approved = approval.response === 1;
    }
    if (!approved || shutdownStarted || abort.signal.aborted) return { cancelled: true };
    if (direct && !hasDirectConsent(settings.public())) throw new Error('点击即发送授权已关闭，本次未发送。');
    assertCapability(settings.public(), capability); task.status = 'processing'; broadcast({ type: 'libraryJob', kind, status: 'processing' });
    task.promise = kind === 'search' ? libraryAI.search({ query, filters, approved: true, signal: abort.signal, candidateLimit: 20 }) : libraryAI.analyzeDuplicates({ filters, approved: true, signal: abort.signal });
    const result = await task.promise;
    if (shutdownStarted || abort.signal.aborted) return { cancelled: true };
    if (kind === 'search') {
      const records = (result.results || []).map(match => {
        const record = store.getRecord(match.id || match.recordId);
        if (!record || !inScope(record, filters) || match.version !== undefined && String(record.version) !== String(match.version)) return null;
        return { ...publicRecord(record), matchReason: match.reason, matchSnippet: match.quote, searchMode: 'ai-candidates' };
      }).filter(Boolean);
      return { ...result, ...resolvedScope, records, total: records.length, scopeTotal: result.coverage?.scopeCount ?? scopeTotal, candidateCount: result.coverage?.candidateCount || 0, explanation: `在 ${result.coverage?.examinedCount || 0} 条候选中找到 ${records.length} 条。未检查全部原文，仍可能遗漏。`, fromCache: Boolean(result.cached) };
    }
    return { ...result, suggestions: store.listDuplicateSuggestions(), groups: store.listGroups().map(publicGroup), scopeTotal: result.coverage?.scopeCount ?? scopeTotal, candidateCount: result.coverage?.candidateCount || 0 };
  } finally { libraryTasks.delete(kind); broadcast({ type: 'libraryJob', kind, status: 'idle' }); if (kind === 'duplicates') broadcast({ type: 'recordsChanged' }); }
}

async function runBatchOrganize(params) {
  assertCapability(settings.public(), 'cloudEnabled');
  if (libraryTasks.size) throw new Error('已有资料库 AI 任务，请等待完成或先取消。');
  const direct = hasDirectConsent(settings.public());
  const batch = new BatchOrganizer({ store, organize, onProgress: broadcast, async classify(records, options) {
    assertCapability(settings.public(), 'cloudEnabled');
    if (direct && !hasDirectConsent(settings.public())) throw new Error('点击即发送授权已关闭，本次未发送。');
    const key = settings.key(); if (!key) throw new Error('请先在设置中输入自己的 DeepSeek API Key。');
    return new DeepSeekClient({ apiKey: key, model: settings.public().model }).classifyBatch(records, options);
  } });
  const snapshot = batch.snapshot(params.recordIds, params.expectedVersions);
  const includeScreenshot = direct ? settings.public().screenshotAnalysisEnabled === true : params.includeScreenshot === true;
  if (includeScreenshot) assertCapability(settings.public(), 'screenshotAnalysisEnabled');
  const runId = require('node:crypto').randomUUID(); const abort = new AbortController();
  const task = { abort, runId, total: snapshot.length, status: direct ? 'processing' : 'confirming' }; libraryTasks.set('batchOrganize', task);
  task.promise = (async () => {
    let approved = direct;
    if (!approved) {
      const result = await askDialog({ type: 'question', title: '允许这一次批量整理？', message: `整理当前显示的 ${snapshot.length} 条灵感？`, detail: `只处理点击时已显示的记录快照。先逐条发送转写、任务、补充文字、已有主题名和来源线索，生成摘要；再把本批成功摘要和已有分组名统一比较，形成少量共同分组建议，增加一次请求；本次最多 ${snapshot.length + 1} 次请求。${includeScreenshot ? '逐条摘要时同时发送各记录已保存的来源截图，可能包含个人信息；统一归类只发送文字摘要。' : '不发送截图。'}不上传原始音频或视频。会产生 API 费用，取消无法撤回已发送的内容或费用。统一归类摘要上限为 96,000 字节，超过则保留摘要并提示缩小范围。只保存摘要与分组建议，采用分组需要另外确认。失败不自动重试。`, buttons: ['取消', '同意本次批量整理'], defaultId: 0, cancelId: 0, noLink: true });
      approved = result.response === 1;
    }
    if (!approved) abort.abort();
    task.status = 'processing'; broadcast({ type: 'libraryJob', kind: 'batchOrganize', status: 'processing', runId, total: snapshot.length });
    return batch.run({ snapshot, runId, signal: abort.signal, includeScreenshot, approved: true, onBeforeItem() {
      assertCapability(settings.public(), 'cloudEnabled');
      if (direct && !hasDirectConsent(settings.public())) throw new Error('点击即发送授权已关闭。');
      if (includeScreenshot) assertCapability(settings.public(), 'screenshotAnalysisEnabled');
    } });
  })();
  try { return await task.promise; }
  finally { libraryTasks.delete('batchOrganize'); broadcast({ type: 'libraryJob', kind: 'batchOrganize', status: 'idle', runId }); }
}

function cancelLibraryTasks() { for (const task of libraryTasks.values()) task.abort.abort(); libraryAI?.clearCache?.(); }

async function invoke(method, params = {}) {
  if (shutdownStarted) throw new Error('应用正在退出，请稍后重新打开。');
  const id = typeof params.id === 'string' ? params.id : '';
  switch (method) {
    case 'app:bootstrap': return bootstrap();
    case 'app:uiReady': return uiDialogs?.markReady() || false;
    case 'window:minimize': return controlWindow(mainWindow, 'minimize');
    case 'window:toggleMaximize': return controlWindow(mainWindow, 'toggleMaximize');
    case 'window:close': return controlWindow(mainWindow, 'close');
    case 'window:state': return windowState(mainWindow);
    case 'app:setDirty': editState = { recordDirty: params.recordDirty === true, settingsDirty: params.settingsDirty === true }; return true;
    case 'app:show': showMain(); return true;
    case 'overlay:hide': hideOverlay(); return true;
    case 'settings:get': return settings.public();
    case 'settings:reset': {
      const approval = await askDialog({ type: 'question', title: '恢复默认设置？', message: '恢复功能和交互时序的默认设置？', detail: '会重置触发时间、可选功能键、排除应用、截图开关和模型选择，并关闭云端 AI 与自动命名。保留全部灵感记录、录音、截图和已保存的 API 密钥；不会删除资料，也不会调用 API。只有本次确认后才执行。', buttons: ['取消', '恢复默认'], defaultId: 0, cancelId: 0, noLink: true });
      if (approval.response !== 1 || shutdownStarted) return { cancelled: true };
      let saved; try { saved = settings.resetToDefaults(); } catch { throw new Error('默认设置未能保存，原有设置已保留，请检查目录权限后重试。'); }
      autoTitles.cancelAll(); for (const job of modelJobs.values()) job.abort(); cancelLibraryTasks();
      await controller.refreshTrigger(); broadcast({ type: 'settingsChanged' }); return saved;
    }
    case 'settings:save': {
      let approvedAutoTitle = false;
      const current = settings.public();
      const approvedCapabilities = pendingCapabilities(current, params);
      if (approvedCapabilities.length) {
        const detail = approvedCapabilities.map(key => `${CAPABILITY_INFO[key].label}：${CAPABILITY_INFO[key].description}`).join('\n\n');
        const approval = await askDialog({ type: 'question', title: '启用所选 AI 功能？', message: '了解功能、发送内容和费用后启用？', detail: `${detail}\n\n数据发送至 DeepSeek，使用你自己的 API Key 按输入和输出 tokens 计费。启用本身不会调用 API 或扫描灵感库。${params.directAIEnabled === true || hasDirectConsent(current) ? '启用点击即发送后，之后主动点击所选 AI 功能即发送，不再逐次询问；截图仅在单独授权后附加。' : '未开启点击即发送时，手动任务仍需逐次确认。'}原始音频和视频不上传。可随时关闭，关闭后本地记录和普通搜索仍可用。`, buttons: ['取消', '同意并启用所选 AI 功能'], defaultId: 0, cancelId: 0, noLink: true });
        if (approval.response !== 1 || shutdownStarted) return { cancelled: true };
      }
      if (params.autoTitleEnabled && (!current.autoTitleEnabled || current.autoTitleConsentVersion !== 1)) {
        const approval = await askDialog({ type: 'question', title: '启用完成后的自动命名？', message: '允许为后续完成的灵感自动生成标题？', detail: '启用云端功能并配置你自己的密钥后，每条完成且已有转写的记录最多自动请求一次 DeepSeek，不再逐条弹窗。只发送这条记录前 12,000 字符的转写，不发送录音、截图、窗口信息或其他记录；可能产生 API 费用。手动标题不会被覆盖，失败不自动重试。可随时关闭此设置。开发测试仍需另行授权，当前操作不会测试 API。', buttons: ['取消', '启用自动命名'], defaultId: 0, cancelId: 0, noLink: true });
        if (shutdownStarted) return { cancelled: true };
        approvedAutoTitle = approval.response === 1;
        if (!approvedAutoTitle) params = { ...params, autoTitleEnabled: false };
      }
      const saved = settings.save(params, { approvedAutoTitle, approvedCapabilities });
      const keyChanged = params.clearApiKey === true || typeof params.apiKey === 'string' && Boolean(params.apiKey.trim());
      if (!saved.autoTitleEnabled || !saved.cloudEnabled || !saved.hasApiKey) autoTitles.cancelAll();
      if (!saved.cloudEnabled || current.screenshotAnalysisEnabled && !saved.screenshotAnalysisEnabled || current.directAIEnabled && !hasDirectConsent(saved) || !saved.hasApiKey || saved.model !== current.model) for (const job of modelJobs.values()) job.abort();
      if (!saved.hasApiKey || saved.model !== current.model) cancelLibraryTasks();
      else { if (!saved.aiSearchEnabled) libraryTasks.get('search')?.abort.abort(); if (!saved.duplicateAnalysisEnabled) libraryTasks.get('duplicates')?.abort.abort(); }
      if (!saved.cloudEnabled || keyChanged || current.directAIEnabled && !hasDirectConsent(saved) || current.screenshotAnalysisEnabled && !saved.screenshotAnalysisEnabled) { autoTitles.cancelAll(); for (const job of modelJobs.values()) job.abort(); cancelLibraryTasks(); }
      await controller.refreshTrigger(); broadcast({ type: 'settingsChanged' }); return saved;
    }
    case 'records:list': {
      const filters = normalizeFilters(params.filters); const limit = Math.max(1, Math.min(100, Number(params.limit) || 30)); const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
      const total = store.countRecords(filters); return { records: store.listRecords({ ...filters, limit, offset }).map(publicRecord), total, scopeTotal: total, limit, offset };
    }
    case 'records:get': return publicRecord(store.get(id));
    case 'records:search': {
      const filters = normalizeFilters(params.filters); const query = String(params.query || '').slice(0, 500); const limit = Math.max(1, Math.min(100, Number(params.limit) || 30)); const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
      return { records: store.search(query, { ...filters, limit, offset }).map(publicRecord), total: store.countSearch(query, filters), scopeTotal: store.countRecords(filters), limit, offset };
    }
    case 'records:aiSearch': return runLibraryTask('search', params);
    case 'library:duplicates': return runLibraryTask('duplicates', params);
    case 'library:batchOrganize': return runBatchOrganize(params);
    case 'library:cancel': {
      if (!params.kind || ['search', 'duplicates', 'batchOrganize'].includes(params.kind)) { for (const [kind, task] of libraryTasks) if ((!params.kind || params.kind === kind) && (!params.runId || params.runId === task.runId)) task.abort.abort(); }
      const recordId = typeof params.recordId === 'string' ? params.recordId : id;
      if (recordId && (!params.kind || params.kind === 'organize')) modelJobs.get(recordId)?.abort();
      if (recordId && (!params.kind || params.kind === 'transcribe')) asrJobs.get(recordId)?.abort.abort();
      if (recordId && (!params.kind || params.kind === 'title')) autoTitles.cancel(recordId);
      return { cancelled: true };
    }
    case 'topics:create': { const result = store.createTopic(params.name); broadcast({ type: 'recordsChanged' }); return result; }
    case 'topics:rename': { const result = store.renameTopic(id, params.name); broadcast({ type: 'recordsChanged' }); return result; }
    case 'topics:merge': { const result = store.mergeTopic(id, params.targetId); broadcast({ type: 'recordsChanged' }); return result; }
    case 'topics:delete': { const result = store.deleteTopic(id); broadcast({ type: 'recordsChanged' }); return result; }
    case 'topics:mergeMany': { const result = store.mergeTopics(params.topicIds, params.targetId); broadcast({ type: 'recordsChanged' }); return result; }
    case 'topics:deleteMany': { const result = store.deleteTopics(params.topicIds); broadcast({ type: 'recordsChanged' }); return result; }
    case 'records:setTopics': { const result = store.setRecordTopics(id, params.topicIds, { expectedVersion: params.expectedVersion }); controller.emitState(); broadcast({ type: 'recordsChanged' }); return publicRecord(result); }
    case 'duplicates:decide': { const result = store.decideDuplicate(id, params.decision); broadcast({ type: 'recordsChanged' }); return result?.records ? publicGroup(result) : result; }
    case 'groups:ungroup': { const result = store.ungroup(id); broadcast({ type: 'recordsChanged' }); return result; }
    case 'groups:rename': { const result = store.renameGroup(id, params.name); broadcast({ type: 'recordsChanged' }); return publicGroup(result); }
    case 'records:continueThought': return controller.startThought(id);
    case 'records:update': {
      const record = store.getRecord(id); if (!record) throw new Error('只能编辑已完成记录。');
      if (params.expectedVersion !== undefined && params.expectedVersion !== record.version) throw new Error('这条记录已发生变化，请保留当前文字，重新打开核对后再保存。');
      let transcriptSegments = Array.isArray(params.transcriptSegments) ? params.transcriptSegments : undefined;
      let fields = params;
      if (!transcriptSegments && typeof params.transcript === 'string') {
        if (record.segments.length > 1 && params.transcript !== record.transcript) throw new Error('请分别编辑各段转写，不能把多段原话合并覆盖到第一段。');
        if (record.segments.length === 1) transcriptSegments = [{ id: record.segments[0].id, text: params.transcript.slice(0, 1000000) }];
        else if (!record.segments.length) fields = { ...params, notes: params.transcript };
      }
      store.updateRecord(id, fields, { transcriptSegments, expectedVersion: params.expectedVersion });
      broadcast({ type: 'recordsChanged' }); autoTitles.run(id).catch(() => {}); return publicRecord(store.getRecord(id));
    }
    case 'records:delete': {
      modelJobs.get(id)?.abort(); cancelLibraryTasks(); autoTitles.cancel(id); const local = asrJobs.get(id); local?.abort.abort(); if (local) await local.promise.catch(() => {});
      if (shutdownStarted || store.closed) return { cancelled: true };
      store.deleteRecord(id);
      semantic?.invalidate(id);
      let cleaned = false; try { cleaned = offlineASR.cleanupRecordJobs(id).ok; } catch {}
      broadcast({ type: 'recordsChanged' });
      if (!cleaned) { capabilities.localCleanupError = true; throw new Error('记录已移除，但部分转写临时文件清理失败。请退出应用、检查本地目录权限后重试；应用启动时会再次清理。'); }
      return { deleted: true };
    }
    case 'records:organize': return organize(id, { includeScreenshot: params.includeScreenshot === true, expectedVersion: params.expectedVersion });
    case 'semantic:status': return semantic?.status() || { installed: false, available: false };
    case 'semantic:install': {
      if (!semantic) throw new Error('本地语义服务尚未就绪。');
      const approval = await askDialog({ type: 'question', title: '安装本地语义模型？', message: '下载并校验本地语义模型？', detail: '将从公开模型源下载所需文件到本机，不上传你的灵感、录音或截图。模型用于本地语义搜索与灵感关系图，安装后可能占用磁盘和内存。可取消、重试；安装本身不调用付费 API。', buttons: ['取消', '下载并安装'], defaultId: 0, cancelId: 0, noLink: true });
      if (approval.response !== 1 || shutdownStarted) return { cancelled: true };
      return semantic.install({ approved: true });
    }
    case 'semantic:cancel': return semantic ? await semantic.cancel() : { cancelled: true };
    case 'semantic:cloud': {
      if (!semantic) throw new Error('本地语义服务尚未就绪。');
      return semantic.cloud({ limit: Math.max(1, Math.min(800, Number(params.limit) || 800)) });
    }
    case 'records:transcribe': return transcribe(id);
    case 'records:revealScreenshot': return revealScreenshot({ store, shell }, id);
    case 'media:open-original': return openOriginal({ store, shell }, id);
    case 'media:reveal-record': return revealRecord({ store, shell }, id);
    case 'records:openSource': {
      const record = store.get(id); if (!record?.source?.hwnd || !record.source.pid) throw new Error('这条记录没有可返回的窗口。');
      return bridge.request('focusWindow', { hwnd: record.source.hwnd, pid: record.source.pid, processName: record.source.processName });
    }
    case 'draft:startManual': return controller.startManual();
    case 'draft:continue': if (id) controller.restoreDraft(id); return controller.continueRecording();
    case 'draft:pause': return controller.pause();
    case 'draft:discard': if (id && id !== controller.session.sessionId) { store.discard(id); broadcast({ type: 'recordsChanged' }); return { deleted: true }; } return controller.discard();
    case 'draft:finish': if (id) controller.restoreDraft(id); return publicRecord(await controller.finish());
    case 'draft:deleteAbandoned': if (id === controller.session.sessionId) return controller.discard(); store.discard(id); broadcast({ type: 'recordsChanged' }); return { deleted: true };
    case 'draft:recover': {
      const draft = store.getDraft(id); if (!draft) throw new Error('草稿不存在。');
      controller.restoreDraft(id); return publicRecord(await controller.finish());
    }
    default: throw new Error('不支持的操作。');
  }
}

async function start() {
  if (!gotLock) return;
  const dataDir = app.getPath('userData'); fs.mkdirSync(dataDir, { recursive: true });
  store = new LocalStore(dataDir); settings = new Settings(dataDir, safeStorage);
  for (const job of store.db.prepare("SELECT j.record_id,j.kind FROM jobs j JOIN records r ON r.id=j.record_id WHERE r.status='saved' AND j.status='processing' AND j.kind IN ('organize','transcribe')").all()) store.setJob(job.record_id, job.kind, 'cancelled', '上次任务已中断。原始记录仍保留，未自动重试。');
  semantic = createSemanticService({ store, dataDir, bundledModelDir: path.join(path.dirname(process.execPath), 'offline-semantic'), onProgress: broadcast, networkDisabled: process.env.INMOMENT_DISABLE_NETWORK === '1' });
  libraryAI = new LibraryAI({ store, semantic, client: () => new DeepSeekClient({ apiKey: settings.key(), model: settings.public().model }) });
  autoTitles = new AutoTitleManager({ store, settings, createClient: () => new DeepSeekClient({ apiKey: settings.key(), model: settings.public().model }), onChanged: () => broadcast({ type: 'recordsChanged' }), isClosing: () => shutdownStarted });
  autoTitles.recoverInterrupted();
  const portableASR = path.join(path.dirname(process.execPath), 'offline-asr');
  const asrRoot = process.env.INMOMENT_ASR_DIR ? path.resolve(process.env.INMOMENT_ASR_DIR) : fs.existsSync(path.join(portableASR, 'asr.json')) ? portableASR : app.isPackaged ? path.join(dataDir, 'offline-asr') : path.join(app.getAppPath(), '.local/asr');
  offlineASR = new OfflineASR(asrRoot, { jobsDir: path.join(dataDir, 'asr-jobs') });
  try { capabilities.localCleanupError = !offlineASR.cleanupStaleJobs().ok; } catch { capabilities.localCleanupError = true; }
  createWindows(); registerMedia();
  const nativePath = path.join(app.getAppPath(), 'build/native/InMoment.Native.exe');
  bridge = new NativeBridge(nativePath).start();
  controller = new CaptureController({ store, bridge, settings,
    disableGlobalInput: process.env.INMOMENT_SMOKE === '1',
    sendRecorder: message => { recorderReady.then(() => { if (!recorder.isDestroyed()) recorder.webContents.send('recorder:command', message); }).catch(() => controller.fail(new Error('录音组件未能加载。'))); },
    showOverlay, hideOverlay,
  });
  controller.on('session', session => broadcast({ type: 'session', session }));
  controller.on('recordsChanged', () => broadcast({ type: 'recordsChanged' }));
  controller.on('inputStatus', status => { capabilities.inputTrigger = status; capabilities.nativeAvailable = status.available; broadcast({ type: 'capabilities', capabilities }); if (status.error) broadcast({ type: 'error', message: status.error }); });
  controller.on('saved', record => { if (shutdownStarted) return; broadcast({ type: 'recordsChanged' }); transcribe(record.id).catch(() => {}); });
  bridge.on('holdPreviewStart', startHoldProgress);
  bridge.on('holdPreviewCancel', cancelHoldProgress);
  ipcMain.handle('inmoment:invoke', async (event, method, params) => {
    if (![mainWindow.webContents.id, overlay.webContents.id].includes(event.sender.id) || event.senderFrame !== event.sender.mainFrame) return { ok: false, error: '不允许的界面来源。' };
    if (typeof method !== 'string') return { ok: false, error: '不支持的操作。' };
    if ((method === 'dialog:respond' || method === 'app:uiReady' || method.startsWith('window:') || method.startsWith('semantic:') || method === 'library:batchOrganize') && !isMainFrameEvent(event, mainWindow)) return { ok: false, error: '此操作只能在主窗口执行。' };
    try {
      if (method === 'dialog:respond') return { ok: true, value: uiDialogs.respond(event, params) };
      return { ok: true, value: await invoke(method, params) };
    } catch (error) { return { ok: false, error: String(error.message || '操作未完成。').slice(0, 350), ...(error.code === 'MODEL_NOT_INSTALLED' ? { code: error.code } : {}) }; }
  });
  for (const [channel, handler] of Object.entries({ 'recorder:ready': data => controller.microphoneReady(data), 'recorder:chunk': data => controller.audioChunk(data), 'recorder:stopped': data => controller.segmentStopped(data), 'recorder:failed': data => controller.microphoneFailed(data) })) {
    ipcMain.handle(channel, async (event, data) => {
      if (event.sender.id !== recorder.webContents.id) throw new Error('Invalid recorder origin.');
      try { return await handler(data); } catch (error) { controller.fail(error); throw new Error('本地音频处理未完成。'); }
    });
  }
  bridge.on('bridgeFault', () => { capabilities.nativeAvailable = false; broadcast({ type: 'capabilities', capabilities }); });
  bridge.on('inputFault', data => { capabilities.nativeAvailable = false; cancelHoldProgress(); broadcast({ type: 'capabilities', capabilities }); broadcast({ type: 'error', message: data.message || '右键监听异常，可先使用手动录音。' }); });
  try {
    await bridge.request('configure', { enabled: false }); capabilities.nativeAvailable = true;
    const speech = await bridge.request('speechEngines'); capabilities.speechEngines = speech.engines || [];
    const local = offlineASR.capabilities(); capabilities.offlineASR = { available: local.available, provider: local.provider, model: local.model };
    capabilities.asrStatus = local.available ? 'available' : 'unavailable';
    if (process.env.INMOMENT_SMOKE !== '1') await controller.refreshTrigger();
  } catch { capabilities.asrStatus = 'unavailable'; capabilities.nativeAvailable = false; }
  broadcast({ type: 'capabilities', capabilities });
  for (const event of ['lock-screen', 'suspend']) powerMonitor.on(event, () => controller.fail(new Error('系统已锁定或休眠，录音已暂停。')));
  app.on('second-instance', showMain);
  app.on('activate', showMain);
}

app.whenReady().then(start).catch(() => { dialog.showErrorBox('InMoment 启动失败', '本地组件未能启动。请确认原生程序已构建，并查看项目 README 中的运行要求。'); quitting = true; app.exit(1); });
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); if (shutdownStarted || quitApprovalPending) return;
  quitApprovalPending = true;
  (async () => {
    if (editState.recordDirty || editState.settingsDirty) {
      const approval = await askDialog({ type: 'question', title: '有尚未保存的修改', message: '丢弃未保存的文字或设置并退出？', detail: '已保存的灵感和本地录音草稿仍保留。取消后可回到窗口保存修改。', buttons: ['返回保存', '丢弃修改并退出'], defaultId: 0, cancelId: 0, noLink: true });
      if (approval.response !== 1) { quitApprovalPending = false; showMain(); return; }
    }
    shutdownStarted = true;
    uiDialogs?.close();
    for (const job of modelJobs.values()) job.abort();
    cancelLibraryTasks();
    for (const job of asrJobs.values()) job.abort.abort();
    const titleShutdown = autoTitles?.close();
    try { await controller?.close(); } catch {}
    await Promise.allSettled([...asrJobs.values()].map(job => job.promise));
    await Promise.allSettled([...libraryTasks.values()].map(task => task.promise).filter(Boolean));
    try { await titleShutdown; } catch {}
    try { await bridge?.close(); } catch {}
    try { await semantic?.close(); } catch {}
    try { store?.close(); } catch {}
    quitting = true; tray?.destroy(); app.quit();
  })();
});

// Test driver is local to the main process; never exposed through renderer IPC.
if (process.env.INMOMENT_SMOKE === '1') globalThis.__inmomentSmokeNativeEvent = (name, data) => {
  if (!['holdPreviewStart', 'holdPreviewCancel', 'holdStart', 'holdEnd'].includes(name)) throw new Error('Unsupported synthetic input event.');
  bridge.emit(name, data || {});
};
