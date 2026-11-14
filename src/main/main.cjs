'use strict';
const { app, BrowserWindow, ipcMain, protocol, safeStorage, dialog, Tray, Menu, nativeImage, powerMonitor, shell, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { NativeBridge } = require('./native-bridge.cjs');
const { Settings } = require('./settings.cjs');
const { LocalStore } = require('../core/store.cjs');
const { createAIClient } = require('../core/ai-client.cjs');
const { DEFAULT_PROVIDER, getProvider, supportsImages } = require('../core/ai-providers.cjs');
const { AutoTitleManager } = require('./auto-title.cjs');
const { CaptureController } = require('./capture-controller.cjs');
const { OfflineASR } = require('./offline-asr.cjs');
const { revealScreenshot, openOriginal, revealRecord } = require('./record-files.cjs');
const { preferredScreenshot, sourceWebUrl, recordMediaURL } = require('./record-background.cjs');
const { LibraryAI, inScope } = require('./library-ai.cjs');
const { BatchOrganizer } = require('./batch-organizer.cjs');
const { NoteGrouping } = require('./note-grouping.cjs');
const { resolveSearchScope } = require('./search-scope.cjs');
const { createSemanticService } = require('./semantic-service.cjs');
const { CAPABILITY_INFO, pendingCapabilities, assertCapability, normalizeFilters, hasDirectConsent, hasSelectionContextConsent } = require('./cloud-permissions.cjs');
const { selectedScreenshot } = require('./analysis-image.cjs');
const { AppDialogManager, isMainFrameEvent } = require('./app-dialogs.cjs');
const { mainChrome, overlayBehavior, windowState, controlWindow, setWindowModalState } = require('./window-ui.cjs');
const { ChatService, rendererChat } = require('./chat-service.cjs');
const { prepareChatMessages } = require('./chat-media.cjs');
const { cleanupVideoJobs } = require('./chat-video.cjs');
const { ChatCapture } = require('./chat-capture.cjs');
const { createChatClient } = require('../core/chat-client.cjs');
const { analyzeVoiceActivity } = require('./voice-activity.cjs');
const { growChatBounds, applyChatBounds, initialChatBounds, minimumChatWidth, CHAT_INITIAL_SIZE, CHAT_MINIMUM_SIZE, CHAT_MINIMUM_VIEWPORT_WIDTH } = require('./chat-window-layout.cjs');
const { OverlayPlacement } = require('./overlay-placement.cjs');
const { ScreenshotCoordinator } = require('./screenshot-coordinator.cjs');
const { DEFAULT_REGION_SHORTCUT, REGION_SHORTCUT_ERROR, normalizeRegionShortcut, shortcutFromInput, RegionShortcut } = require('./region-shortcut.cjs');
const { AudioWaveformService } = require('./audio-waveform.cjs');
const { NotesStore, clipboardFilePaths, noteMediaResponse, recordIdForNote, webLink } = require('./notes.cjs');
const { copyNoteSelection, readNotePicture, copyImageOutline } = require('./note-clipboard.cjs');
const { createNoteOcr, inspectNoteOcrImage, NOTE_OCR_MAX_BYTES } = require('./note-ocr.cjs');
const { NoteAI } = require('./note-ai.cjs');
const { exportNotes, exportName } = require('./note-export.cjs');
const { BATCH_GROUPING_LIMITS } = require('../core/deepseek.cjs');
const { clipboard, ClipboardItem } = require('electron');

app.setName('InMoment');
if (process.platform === 'win32') app.setAppUserModelId('InMoment.Desktop');
protocol.registerSchemesAsPrivileged([{ scheme: 'inmoment-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
if (process.env.INMOMENT_DATA_DIR) app.setPath('userData', path.resolve(process.env.INMOMENT_DATA_DIR));
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow, overlay, overlayPlacement, recorder, chatWindow, tray, store, settings, bridge, controller, offlineASR, autoTitles, libraryAI, semantic, chats, chatCapture, screenshot;
let floatingChatId = null;
let floatingReturnSource = null;
let floatingLoadedChatId = null;
let floatingPause = null;
let chatOpening = null, enteringChat = false;
let openingChatTarget=null;
let chatTransitionVersion = 0;
let chatTransitionCancelKind = 'close';
let chatTransitionTransferSettings = false;
let chatTransitionTransferPending = false;
const captureContexts = new Map();
const chatDeletions=new Map();
const chatClosings=new Map();
const chatVoiceOrigins=new Map(),chatRecordingStarts=new Set();
let uiDialogs;
let noteGrouping;
let audioWaveforms;
let notes, noteAI;
let noteOcr;
const noteOcrRequests = new Map();
let noteOcrQueue = Promise.resolve();

function cancelImageRecognition(owner, requestId) {
  const job = noteOcrRequests.get(owner);
  if (!job || (requestId !== undefined && job.requestId !== requestId)) return;
  noteOcrRequests.delete(owner);
  job.abort.abort(new Error('已取消图片文字识别。'));
}
function publicChat(chat) { return rendererChat(chat, id => chats.referenceTitle(id)); }
let recorderReady = Promise.resolve(), quitting = false, shutdownStarted = false;
let quitApprovalPending = false;
let editState = { recordDirty: false, settingsDirty: false, noteDirty: false };
let progressActive = false;
let overlaySession = null;
let progressTriggerKey = 'right-button';
let capabilities = { nativeAvailable: false, speechEngines: [], asrStatus: 'checking', searchMode: 'local-keyword' };
const modelJobs = new Map();
const asrJobs = new Map();
const libraryTasks = new Map();
let settingsWriteVersion = 0;
const mainFile = path.join(__dirname, '../renderer/index.html');
const overlayFile = path.join(__dirname, '../overlay/index.html');
const recorderFile = path.join(__dirname, '../recorder/index.html');
const chatFile = path.join(__dirname, '../chat/index.html');
const regionShortcut = new RegionShortcut(globalShortcut, onRegionShortcut, process.env.INMOMENT_SMOKE !== '1');
let shortcutCapture = null;

function currentAIConfig() {
  const value = settings.public(); const provider = value.aiProvider || DEFAULT_PROVIDER;
  const info = getProvider(provider); const key = settings.key(provider);
  if (!key) throw new Error(`请先在设置中填写 ${info.label} API Key。`);
  return { provider, model:value.modelMode === 'manual' ? value.model || info.defaultModel : info.defaultModel, key,
    modelMode: value.modelMode, preferFreeModel: value.preferFreeModel };
}
function sameAIConfig(config) {
  try { const current = currentAIConfig(); return current.provider === config.provider && current.model === config.model && current.key === config.key; } catch { return false; }
}
function createConfiguredClient(config = currentAIConfig()) { return createAIClient({ provider:config.provider, model:config.model, apiKey:config.key }); }
function assertAIConfig(config) { if (!sameAIConfig(config)) throw new Error('AI 服务、模型或密钥已变更，请重新发起本次操作。'); }

function prepareNoteAI(note, { full, hasSelectionRange }) {
  const permissions = settings.public();
  assertCapability(permissions, 'cloudEnabled');
  const config = currentAIConfig();
  const includeSelectionContext = hasSelectionRange && hasSelectionContextConsent(permissions);
  let image = null;
  if (full && note.background?.screenshots.length && permissions.screenshotAnalysisEnabled) {
    assertCapability(permissions, 'screenshotAnalysisEnabled');
    if (!supportsImages(config.provider, config.model)) throw new Error('当前模型不支持截图理解，请在设置中选择支持图片的模型，或关闭截图辅助理解后再总结。');
    image = selectedScreenshot(store, store.getRecord(recordIdForNote(note.id)));
  }
  return {
    client: createConfiguredClient(config), image, includeSelectionContext,
    assertAllowed() {
      if (shutdownStarted) throw new Error('应用正在退出。');
      const capability = includeSelectionContext ? 'noteSelectionContextEnabled' : image ? 'screenshotAnalysisEnabled' : 'cloudEnabled';
      assertCapability(settings.public(), capability);
      assertAIConfig(config);
    },
  };
}

function broadcast(message) {
  if (shutdownStarted) return;
  for (const window of [mainWindow, overlay, chatWindow]) if (window && !window.isDestroyed()) {
    if (window === overlay && progressActive && message.type === 'session') { overlaySession = message; continue; }
    window.webContents.send('inmoment:event', message);
  }
}
function sendOverlayAudioLevel(value) {
  if (!overlay || overlay.isDestroyed()) return;
  // Display telemetry contains levels only; raw PCM stays in the recorder path.
  try { overlay.webContents.send('inmoment:event', { type: 'audioLevel', id: value.id, segmentId: value.segmentId, level: value.level, peak: value.peak }); }
  catch { /* A closing display surface cannot interrupt PCM persistence. */ }
}
function sendChatAudioLevel(value) {
  const data = chatCapture?.chatAudioLevel(value);
  if (!data || shutdownStarted) return;
  const event = { type:'chatAudioLevel', id:data.id, token:data.token, draftId:data.draftId, segmentId:data.segmentId, level:data.level, peak:data.peak };
  for (const window of [mainWindow, chatWindow]) if (window && !window.isDestroyed()) {
    try { window.webContents.send('inmoment:event', event); } catch { /* A closing view cannot interrupt recording. */ }
  }
}
function nativeWindowId(window) {
  const handle = window?.getNativeWindowHandle?.();
  return handle?.length >= 8 ? handle.readBigUInt64LE().toString() : handle?.length >= 4 ? String(handle.readUInt32LE()) : null;
}
function externalReturnSource(value) {
  if (!value || !/^\d+$/u.test(String(value.hwnd || '')) || String(value.hwnd) === '0' || !Number.isInteger(Number(value.pid)) || Number(value.pid) <= 0) return null;
  const name = String(value.processName || '').replace(/\.exe$/iu, '').toLowerCase();
  if (!name || ['electron', 'inmoment', path.basename(process.execPath, '.exe').toLowerCase()].includes(name)) return null;
  return { hwnd: String(value.hwnd), pid: Number(value.pid), processName: String(value.processName) };
}
async function rememberChatReturnSource(fromCapture) {
  const captured = fromCapture && externalReturnSource(controller.snapshot().context);
  if (captured) return captured;
  const foreground = await bridge.request('foreground', {}, 1000).catch(() => null);
  return externalReturnSource(foreground) || (String(foreground?.hwnd) === nativeWindowId(chatWindow) ? floatingReturnSource : null);
}
async function restoreChatReturnSource(source) {
  if (!source || !nativeWindowId(chatWindow)) return;
  const foreground = await bridge.request('foreground', {}, 1000).catch(() => null);
  // A close may await audio cleanup. Respect an application the user activated
  // during that wait instead of taking focus back from it.
  if (String(foreground?.hwnd) !== nativeWindowId(chatWindow)) return;
  try {
    const result = await bridge.request('focusWindow', source, 1500);
    return result?.success === false ? { source, reason:result.error?.code || 'FOREGROUND_DENIED' } : null;
  } catch (error) { return { source, reason:error.code || 'WINDOW_SERVICE_UNAVAILABLE' }; }
}
async function reportChatReturnNotice(result) {
  if (!result) return;
  const foreground = await bridge.request('foreground', {}, 1000).catch(() => null);
  if (String(foreground?.hwnd) === result.source.hwnd && Number(foreground?.pid) === result.source.pid) return;
  const closed = ['WINDOW_UNAVAILABLE','WINDOW_IDENTITY_MISMATCH'].includes(result.reason);
  const message = closed ? '原来的窗口已关闭或发生变化，请在需要记录的应用中继续。' : result.reason === 'FOREGROUND_DENIED' ? '聊天已关闭，系统未允许自动切回原窗口，请手动选择该窗口。' : '聊天已关闭，窗口切换服务暂不可用，请手动回到原应用。';
  broadcast({ type:'sourceFocusNotice', message, reason:result.reason, durationMs:5000 });
}
function activeOwnedChat(session = controller?.snapshot()) {
  if (!session?.active || !chatCapture || !chats) return null;
  for (const [id,draftId] of chatCapture.owners) if (draftId === session.id && chats.get(id)) return id;
  return null;
}
function captureSessionForUI(session = controller.snapshot()) {
  const owner=activeOwnedChat(session) || (session?.active && chatRecordingStarts.size===1?[...chatRecordingStarts][0]:null),origin=owner&&chatVoiceOrigins.get(owner);
  return { ...session, chatOwnerId:owner, ...(origin?{captureOrigin:'chatVoice',captureWindow:origin.window===mainWindow?'main':'floating'}:{}) };
}
function shouldRecoverOwnedChat(id) { return id === floatingChatId && id === activeOwnedChat() && (!chatWindow.isVisible() || chatWindow.isMinimized()); }
async function pauseOwnedCapture(id) {
  const active = controller.snapshot();
  if (!id || activeOwnedChat(active) !== id) return captureSessionForUI(active);
  if (['preparing','recording'].includes(active.state)) controller.pause();
  const attempt = chatCapture.recordings?.get(id);
  if (attempt) await chatCapture.stopRecording(id, attempt.token);
  else if (active.active) await chatCapture.fromCapture();
  return captureSessionForUI();
}
function pauseFloatingRecording() {
  const active = controller?.snapshot(),id=activeOwnedChat(active);
  if (shutdownStarted || enteringChat || !id || chatVoiceOrigins.get(id)?.window===mainWindow || id !== floatingChatId || !['preparing','recording'].includes(active.state)) return;
  if (floatingPause) return floatingPause;
  floatingPause = pauseOwnedCapture(id).catch(error => broadcast({ type:'error', message:error.message || '录音未能暂停，请返回聊天检查。' })).finally(() => { floatingPause=null; });
  return floatingPause;
}
function pauseMainChatRecording(){
  const active=controller?.snapshot(),id=activeOwnedChat(active);
  if(shutdownStarted || !id || chatVoiceOrigins.get(id)?.window!==mainWindow || !['preparing','recording'].includes(active.state))return;
  if(floatingPause)return floatingPause;
  floatingPause=pauseOwnedCapture(id).catch(error=>broadcast({type:'error',message:error.message||'录音未能暂停，请返回聊天检查。'})).finally(()=>{floatingPause=null;});return floatingPause;
}
async function recoverOwnedChat(id){
  if(chatVoiceOrigins.get(id)?.window!==mainWindow)return showChat(id);
  if(!chats.get(id))throw new Error('聊天已结束。');
  const view=await mainWindow.webContents.executeJavaScript?.("({id:window.chatView?.currentId,visible:!document.querySelector('#chat-view')?.classList.contains('hidden')})");
  showMain();if(!view?.visible || view.id!==id)mainWindow.webContents.send('inmoment:event',{type:'chatOpen',id});return chats.get(id);
}
async function revealFloatingChat(id) {
  if(chatVoiceOrigins.has(id))chatVoiceOrigins.get(id).window=chatWindow;
  const displayed = await chatWindow.webContents.executeJavaScript?.('window.chatView?.currentId');
  if (displayed !== id) chatWindow.webContents.send('inmoment:event',{type:'chatOpen',id});
  if (chatWindow.isMinimized()) chatWindow.restore();
  chatWindow.setIgnoreMouseEvents?.(false);chatWindow.show();chatWindow.focus();
  chatTransition('layout()')?.catch(()=>{});controller.emitState();await controller.refreshTrigger();
  return chats.get(id);
}
function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionCheckHandler((contents, permission) => permission === 'media' && contents?.id === recorder?.webContents.id);
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(permission === 'media' && contents?.id === recorder?.webContents.id && !(details.mediaTypes || []).includes('video')));
}
function createScreenshotCoordinator() {
  return new ScreenshotCoordinator({chats,isClosing:()=>shutdownStarted,
    async setBusy(busy,job) {
      if(busy){job.previousDisable=controller.disableGlobalInput;controller.disableGlobalInput=true;cancelHoldProgress();}
      else {
        controller.disableGlobalInput=job.previousDisable;
        if (job.purpose === 'region') {
          overlayPlacement?.setEditorActive(false);
          if (!shutdownStarted && job.recordingId && controller.finishRegionScreenshot(job.recordingId) && job.restoreAllowed) showOverlay();
        }
      }
      await controller.refreshTrigger();
    },
    async prepare(job) {
      if (job.purpose === 'region') {
        const foreground = await bridge.request('foreground', {}, 500).catch(() => null);
        if (!job.valid) return;
        const source = externalReturnSource(foreground);
        job.source = source ? { ...source, title: foreground.title } : { processName: foreground?.processName || '', title: foreground?.title || '' };
        if (source) job.sourceContext = bridge.request('readContext', { hwnd: source.hwnd, pid: source.pid }, 1400).catch(() => null);
        return;
      }
      if(activeOwnedChat()===job.id)await pauseOwnedCapture(job.id);
      const window=job.options.origin;
      if(!job.options.keepChatVisible && window && !window.isDestroyed() && window.isVisible()){
        window.hide();
        // Let the native compositor remove the hidden surface before capture.
        await new Promise(resolve=>setTimeout(resolve,80));
      }
    },
    async capture(job) {
      if(process.env.INMOMENT_SMOKE==='1')throw new Error('隔离检查中不截取桌面，请使用合成图片。');
      const {screen,desktopCapturer}=require('electron');
      const display=job.options.display || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.size.width*display.scaleFactor),height:Math.round(display.size.height*display.scaleFactor)},fetchWindowIcons:false});
      const source=sources.find(item=>String(item.display_id)===String(display.id));
      if(!source || source.thumbnail.isEmpty())throw new Error('未能截取当前显示器，请检查系统屏幕捕捉权限后重试。');
      const image=source.thumbnail, size=image.getSize();
      return {image:{dataUrl:image.toDataURL(),width:size.width,height:size.height},display:{bounds:{...display.bounds},scaleFactor:display.scaleFactor}};
    },
    startRecording(job) {
      const started = controller.startRegion(job.source, job.sourceContext);
      if (job.sourceContext && controller.snapshot().id === started.id) {
        captureContexts.clear();
        captureContexts.set(started.id, job.sourceContext);
      }
      return started;
    },
    getRecording: () => controller.snapshot(),
    saveRecordingImage(job, image) {
      controller.saveRegionScreenshot(job.recordingId, {
        bytes: Buffer.from(image.base64, 'base64'), width: image.width, height: image.height, capturedAt: job.capturedAt,
      });
    },
    decode(dataUrl,size){const image=nativeImage.createFromDataURL(dataUrl),actual=image.getSize();if(image.isEmpty() || actual.width!==size.width || actual.height!==size.height)throw new Error('截图图片未能解码，请重新截取。');return image;},
    copyImage({ base64, mimeType }) {
      const png = new Blob([Buffer.from(base64, 'base64')], { type: mimeType });
      return clipboard.write([new ClipboardItem({ [mimeType]: png })]);
    },
    createEditor(job){
      // A normal topmost window can be constrained to the Windows work area.
      // Cover the full display so its captured taskbar is the only visible one.
      // Windows needs a resizable native frame to honor the fullscreen bounds;
      // fullscreen itself removes its draggable resize edges.
      const window=new BrowserWindow({...job.display.bounds,show:false,frame:false,fullscreen:true,fullscreenable:true,roundedCorners:false,hasShadow:false,resizable:true,movable:false,alwaysOnTop:true,skipTaskbar:true,backgroundColor:'#202622',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'../screenshot/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
      secureWindow(window);return window;
    },
    loadEditor:window=>window.loadFile(path.join(__dirname,'../screenshot/index.html')),
    async restore(job){
      const window=job.options.origin;
      if(!window || window.isDestroyed())return;
      if(window===chatWindow && floatingChatId!==job.id)return;
      if(window.isMinimized())window.restore();window.show();window.focus();
    },
  });
}
function takeChatScreenshot(id,params={},originWindow=null) {
  if(params.keepChatVisible!==undefined && typeof params.keepChatVisible!=='boolean')throw new Error('截图窗口选项无效。');
  const keepChatVisible=params.keepChatVisible ?? settings.public().screenshotKeepChatVisible;
  const origin=[mainWindow,chatWindow].includes(originWindow)?originWindow:id===floatingChatId?chatWindow:mainWindow;
  if(origin===chatWindow && id!==floatingChatId)throw new Error('聊天已切换，请在当前聊天中重试。');
  return screenshot.start(id,{keepChatVisible,origin});
}
async function takeRegionScreenshot() {
  if (shutdownStarted || quitApprovalPending || screenshot.busy) return;
  if (controller.snapshot().active || enteringChat || chatOpening || chatRecordingStarts.size) throw new Error('请先结束当前录音或聊天切换，再开始截图录音。');
  const { screen } = require('electron');
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return screenshot.startRegion({ display });
}
function onRegionShortcut() {
  if (shortcutCapture && mainWindow.isFocused()) {
    // Windows sends the registered chord here instead of to the focused page.
    const shortcut = regionShortcut.registered;
    if (!shortcutCapture.pending) {
      shortcutCapture.pending = { shortcut, registered: true };
      shortcutCaptureUpdate({ candidate: shortcut });
    }
    return;
  }
  takeRegionScreenshot().catch(error => {
    if (shutdownStarted) return;
    const visible = [mainWindow, chatWindow, overlay].some(window => window && !window.isDestroyed() && window.isVisible() && !window.isMinimized());
    if (!visible) showMain();
    broadcast({ type: 'error', message: error?.message || '截图录音未能启动。' });
  });
}
function shortcutCaptureUpdate(update, done = false) {
  if (!shortcutCapture) return;
  const id = shortcutCapture.id;
  if (done) shortcutCapture = null;
  if (mainWindow.isDestroyed()) return;
  if (done) mainWindow.webContents.setIgnoreMenuShortcuts?.(false);
  mainWindow.webContents.send('inmoment:event', { type: 'regionShortcutCapture', id, done, ...update });
}
function cancelShortcutCapture() { shortcutCaptureUpdate({}, true); }
function commitShortcutCapture(shortcut) {
  try {
    regionShortcut.save(shortcut, () => {
      if (settings.value.regionScreenshotShortcut !== shortcut) settings.save({ regionScreenshotShortcut: shortcut });
    });
  } catch (error) {
    shortcutCapture.pending = null;
    shortcutCaptureUpdate({ error: error.code === REGION_SHORTCUT_ERROR ? error.message : '快捷键未能保存，请检查目录权限后重试。' });
    return;
  }
  const status = regionShortcut.status(shortcut);
  capabilities.regionScreenshot = status;
  shortcutCaptureUpdate({ shortcut, status }, true);
  broadcast({ type: 'capabilities', capabilities });
}
function captureShortcutInput(input) {
  if (!shortcutCapture || !input || typeof input.key !== 'string' || typeof input.code !== 'string') return;
  const down = input.type === 'keyDown';
  const pending = shortcutCapture.pending;
  if (input.type === 'keyUp' && pending && (pending.registered
    ? pending.shortcut.toUpperCase().split('+').includes(input.key === 'Control' ? 'CTRL' : input.key.toUpperCase())
    : (input.code || input.key) === pending.key)) commitShortcutCapture(pending.shortcut);
  if (!down || pending) return;
  try {
    const shortcut = shortcutFromInput(input);
    if (!shortcut) return;
    shortcutCapture.pending = { shortcut, key: input.code || input.key };
    shortcutCaptureUpdate({ candidate: shortcut });
  } catch (error) { shortcutCaptureUpdate({ error: error.message }); }
}
function saveSettingsWithRegionShortcut(shortcut, persist) {
  const saved = shortcut === settings.value.regionScreenshotShortcut ? persist() : regionShortcut.save(shortcut, persist);
  capabilities.regionScreenshot = regionShortcut.status(saved.regionScreenshotShortcut);
  return saved;
}
function showMain() { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } }
function showChat(id) {
  if(screenshot?.busy)return Promise.reject(new Error('请先完成或取消截图。'));
  id ||= activeOwnedChat();
  if (id && id === floatingChatId && floatingLoadedChatId && !enteringChat && !chatOpening && chats.get(id)) return revealFloatingChat(id);
  if (chatOpening) return chatOpening;
  chatOpening = openChatWindow(id).finally(() => { chatOpening = null; });
  return chatOpening;
}
async function readOverlaySurface() {
  if (!overlay || overlay.isDestroyed() || !overlay.isVisible() || !overlay.webContents.executeJavaScript) return null;
  const value = await overlay.webContents.executeJavaScript(`(() => {
    const panel=document.querySelector('.capture-panel'),rect=panel.getBoundingClientRect();
    return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,viewport:{width:innerWidth,height:innerHeight},visual:{
      paths:[...document.querySelectorAll('#capsule-logo path')].map(path=>({d:path.getAttribute('d'),fill:path.getAttribute('fill')})),
      heights:[...document.querySelectorAll('#capsule-waveform>span')].map(bar=>bar.getBoundingClientRect().height),timer:document.querySelector('#capsule-timer').textContent}};
  })()`);
  if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height) || !value.viewport?.width || !value.viewport?.height) return null;
  const content = overlay.getContentBounds ? overlay.getContentBounds() : overlay.getBounds();
  const scaleX = content.width / value.viewport.width, scaleY = content.height / value.viewport.height;
  return { x:content.x+value.x*scaleX, y:content.y+value.y*scaleY, width:value.width*scaleX, height:value.height*scaleY, visual:value.visual };
}
function chatTransition(script) { return chatWindow.webContents.executeJavaScript?.(`window.InMomentFloatingChat?.${script}`); }
async function openChatWindow(id) {
  if(id && !chats.get(id))throw new Error('聊天不存在。');
  // Replacing a floating conversation closes that view through the same choice
  // gate before this new transition takes ownership of the native window.
  if(floatingChatId && floatingChatId!==id){
    const result=await closeChat(floatingChatId);
    if(result?.cancelled)return result;
  }
  openingChatTarget=id||null;
  const version = ++chatTransitionVersion;
  const current = () => !shutdownStarted && version === chatTransitionVersion && (!openedChat || Boolean(chats.get(openedChat.id)));
  const overlayWasVisible = overlay.isVisible();
  let openedChat = null, revealed = false;
  enteringChat = true;
  if (overlayWasVisible) overlay.webContents.send('inmoment:event', { type: 'overlayChat', phase: 'start' });
  const collapse = new Promise(resolve => setTimeout(resolve, overlayWasVisible ? 180 : 0));
  try {
  const returnSource = await rememberChatReturnSource(overlayWasVisible);
  const chat = id ? chats.get(id) : await chatCapture.fromCapture();
  if (!chat) throw new Error('聊天不存在。');
  openedChat = chat;
  openingChatTarget=chat.id;
  controller.emitState();await controller.refreshTrigger();
  if (!current()) return chat;
  if (floatingChatId && floatingChatId !== chat.id) {
    throw new Error('另一个聊天正在使用浮窗，请稍后重试。');
  }
  floatingChatId = chat.id;
  if(chatVoiceOrigins.has(chat.id))chatVoiceOrigins.get(chat.id).window=chatWindow;
  floatingReturnSource = returnSource;
  await collapse;
  if (!current()) return chat;
  const source = await readOverlaySurface();
  if (!current()) return chat;
  chatWindow.hide();
  await chatWindow.loadFile(chatFile, { query: { id: chat.id, transition:'capsule' } });
  floatingLoadedChatId = chat.id;
  if (!current() || floatingChatId !== chat.id) return chat;
  const { screen } = require('electron');
  const fallback = screen.getCursorScreenPoint();
  const anchor = source || { x:fallback.x+24, y:fallback.y+16, width:233, height:48 };
  const work = screen.getDisplayNearestPoint({x:Math.round(anchor.x),y:Math.round(anchor.y)}).workArea;
  const zoom = chatWindow.webContents.getZoomFactor();
  const bounds = initialChatBounds(anchor,work,zoom);
  chatWindow.setMinimumSize(Math.min(minimumChatWidth(zoom),bounds.width),Math.min(CHAT_MINIMUM_SIZE.height,bounds.height));
  applyChatBounds(chatWindow,bounds);
  const content = chatWindow.getContentBounds ? chatWindow.getContentBounds() : chatWindow.getBounds();
  const prepared = await chatTransition(`prepare(${JSON.stringify({source,window:content})})`);
  if(source && !prepared?.origin)throw new Error('聊天界面尚未准备好，请重试。');
  if (!current() || floatingChatId !== chat.id) return chat;
  chatWindow.setIgnoreMouseEvents?.(true,{forward:true});
  if(chatWindow.showInactive)chatWindow.showInactive();else chatWindow.show();
  chatWindow.focus(); revealed=true;
  await chatTransition('present()');
  if(!current())return chat;
  hideOverlay();
  await chatTransition('enter()');
  if (!current()) return chat;
  return chats.get(chat.id);
  } catch (error) {
    if(!current())return openedChat;
    if(current()) {
      if(revealed)chatWindow.hide();
      overlay.webContents.send('inmoment:event', { type: 'overlayChat', phase: 'cancel' });
      if(overlayWasVisible)overlay.showInactive?.();
    }
    throw error;
  } finally {
    if(openingChatTarget===openedChat?.id || !openedChat && openingChatTarget===id)openingChatTarget=null;
    if(current()) { enteringChat=false;chatWindow.setIgnoreMouseEvents?.(false);chatTransition('layout()')?.catch(()=>{}); }
    else if(openedChat && !shutdownStarted && chatTransitionCancelKind==='transfer') {
      if(chatTransitionTransferPending)mainWindow.webContents.send('inmoment:event',{type:'chatOpen',id:openedChat.id,settings:chatTransitionTransferSettings});
      chatTransitionTransferPending=false;
    } else if(openedChat && !shutdownStarted) {
      // A user close during preparation owns the usual temporary-chat cleanup.
      await chatCapture.release(openedChat.id).catch(()=>{});
      if(chats.get(openedChat.id)&&!chats.get(openedChat.id).saved)chats.delete(openedChat.id);
    }
  }
}
function closeChat(id = floatingChatId) {
  if(chatDeletions.has(id))return chatDeletions.get(id);
  if(chatClosings.has(id))return chatClosings.get(id);
  const task=Promise.resolve().then(async()=>{
    let chat=id&&chats.get(id),decision=chat?.saved||chat?.autoSave?'save':'discard';
    if(chat && id===floatingChatId){
      if(screenshot?.job?.id===id && !chatWindow.isVisible())throw new Error('请先完成或取消截图，再关闭聊天。');
      if(!chat.saved && !chat.autoSave && (!chatWindow.isVisible() || chatWindow.isMinimized())){
        const content=await chatWindow.webContents.executeJavaScript?.(`Boolean(window.chatView?.currentId===${JSON.stringify(id)}&&window.chatView?.hasCloseContent?.())`);
        if(content){if(chatWindow.isMinimized())chatWindow.restore();chatWindow.show();chatWindow.focus();}
      }
      decision=await chatWindow.webContents.executeJavaScript?.(`window.chatView?.confirmClose?.(${JSON.stringify(id)},{prompt:true})`);
      if(!['save','discard','cancel'].includes(decision))throw new Error('聊天界面尚未就绪，请稍后关闭。');
    }
    if(decision==='cancel')return{cancelled:true};
    if(chatDeletions.has(id))return chatDeletions.get(id);
    chat=id&&chats.get(id);
    if(chat && decision==='discard' && !chat.saved && !chat.autoSave)return deleteChat(id);
    if(chat && decision==='save')chats.save(id);
    // The renderer prepared/flushed and the snapshot is durable before cleanup.
    const ownedDraft=chatCapture?.owners?.get(id);if(ownedDraft)audioWaveforms?.invalidate(ownedDraft);
    await screenshot?.cancelChat(id);
    const affectsFloating=id===floatingChatId || id===openingChatTarget;
    const version=affectsFloating?++chatTransitionVersion:chatTransitionVersion;
    if(affectsFloating){chatTransitionCancelKind='close';enteringChat=false;chatTransition('cancel()')?.catch(()=>{});chatWindow.setIgnoreMouseEvents?.(false);}
    if(chat){chats.cancel(id);chats.clearAttachmentCache(id);await chatCapture.release(id);chatVoiceOrigins.delete(id);}
    if(id===floatingChatId && version===chatTransitionVersion){
      const focusResult=await restoreChatReturnSource(floatingReturnSource);
      if(id===floatingChatId && version===chatTransitionVersion){floatingChatId=null;floatingReturnSource=null;floatingLoadedChatId=null;chatWindow.blur?.();chatWindow.hide();await controller.refreshTrigger();await reportChatReturnNotice(focusResult);}
    }
    return true;
  }).finally(()=>chatClosings.delete(id));
  chatClosings.set(id,task);return task;
}
async function prepareChatsForQuit(){
  if(floatingChatId){const result=await closeChat(floatingChatId);if(result?.cancelled)return false;}
  const id=await mainWindow?.webContents.executeJavaScript?.('window.chatView?.currentId');
  if(typeof id==='string' && chats.get(id)){
    const ready=await mainWindow.webContents.executeJavaScript(`window.chatView?.prepareForClose?.(${JSON.stringify(id)})`);
    if(ready!==true && chats.get(id))return false;
  }
  const captureIds=new Set(['owners','starts','jobs','recordings','retryJobs','cancelling'].flatMap(key=>[...(chatCapture?.[key]?.keys()||[])]));
  for(const owner of captureIds){
    if(!chats.get(owner))continue;
    const pending=['starts','jobs','recordings','retryJobs','cancelling'].some(key=>chatCapture[key]?.has(owner));
    const status=chatCapture.voiceStates.get(owner)?.status;
    if(!pending && !['preparing','recording','paused','transcribing','error'].includes(status))continue;
    if(owner===floatingChatId && chatVoiceOrigins.get(owner)?.window!==mainWindow)await revealFloatingChat(owner);
    else {showMain();mainWindow.webContents.send('inmoment:event',{type:'chatOpen',id:owner});}
    throw new Error('这段聊天录音尚未完成转写，请等待完成，或重试／取消本次录音后再退出。');
  }
  return true;
}
function reportCloseFailure(error){
  const message=String(error?.message||'聊天未能保存或关闭，请重试。').slice(0,250);
  const useFloat=floatingChatId && !screenshot?.busy && chatWindow && !chatWindow.isDestroyed();
  if(useFloat){
    if(chatWindow.isMinimized())chatWindow.restore();chatWindow.show();chatWindow.focus();
    chatWindow.webContents.executeJavaScript?.(`window.chatView?.report?.(${JSON.stringify(message)},true)`)?.catch(()=>{});
  }else showMain();
  broadcast({type:'error',message});
}
function deleteChat(id){
  if(chatDeletions.has(id))return chatDeletions.get(id);
  const ownedDraft=chatCapture?.owners?.get(id),active=controller.snapshot();
  if(ownedDraft && active.id===ownedDraft && active.state==='processing')throw new Error('录音正在保存，请稍后删除聊天。');
  chats.beginDelete(id);
  const version=id===floatingChatId?++chatTransitionVersion:null;
  if(version!==null){chatTransitionCancelKind='close';enteringChat=false;chatTransition('cancel()')?.catch(()=>{});chatWindow.setIgnoreMouseEvents?.(false);}
  let released=false;
  const task=Promise.resolve().then(async()=>{
    try{
      if(ownedDraft)audioWaveforms?.invalidate(ownedDraft);
      await screenshot?.cancelChat(id);
      await chatCapture.release(id);released=true;chatVoiceOrigins.delete(id);
      const result=chats.delete(id);
      if(id===floatingChatId && version===chatTransitionVersion){
        const focusResult=await restoreChatReturnSource(floatingReturnSource);
        if(id===floatingChatId && version===chatTransitionVersion){floatingChatId=null;floatingReturnSource=null;floatingLoadedChatId=null;chatWindow.blur?.();chatWindow.hide();await controller.refreshTrigger();await reportChatReturnNotice(focusResult);}
      }
      return result;
    }catch(error){chats.abortDelete(id,{clearAudioDraft:released});throw error;}
    finally{chatDeletions.delete(id);}
  });
  chatDeletions.set(id,task);return task;
}
function resizeFloatingChat(id, height) {
  if (!id || id !== floatingChatId || !chats.get(id) || !chatWindow || chatWindow.isDestroyed()) return { changed: false };
  if (typeof height !== 'number') throw new Error('聊天高度无效。');
  const { screen } = require('electron');
  const bounds = chatWindow.getBounds();
  const work = screen.getDisplayMatching(bounds).workArea;
  const zoom = chatWindow.webContents.getZoomFactor();
  const next = growChatBounds(bounds, work, height * zoom, 12, minimumChatWidth(zoom));
  // loadFile may measure before the initial position is set. The renderer
  // measures again on the ensuing window resize; a hidden chat stays hidden.
  const visible = chatWindow.isVisible();
  let applied = { bounds, changed: false };
  if (visible && !enteringChat) {
    const minimum = chatWindow.getMinimumSize();
    const desiredMinimum = [Math.min(minimumChatWidth(zoom), next.maxWidth), Math.min(minimum[1], CHAT_MINIMUM_SIZE.height, next.maxHeight)];
    const minimumChanged = minimum.some((value, index) => Math.abs(value - desiredMinimum[index]) > 1);
    if (minimumChanged) chatWindow.setMinimumSize(...desiredMinimum);
    if (next.changed || minimumChanged) applied = applyChatBounds(chatWindow, next.bounds);
    applied.changed ||= Object.keys(bounds).some(key => Math.abs(applied.bounds[key] - bounds[key]) > 1);
  }
  return { ...applied.bounds, maxHeight: next.maxHeight, minimumViewportWidth: CHAT_MINIMUM_VIEWPORT_WIDTH, zoom, changed: applied.changed };
}
function askDialog(options) {
  if (!uiDialogs) throw new Error('确认界面尚未就绪，请返回主窗口后重试。');
  return uiDialogs.showMessageBox(options);
}
function showOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  if (enteringChat) return;
  if(chatRecordingStarts.size)return;
  const session = controller?.snapshot();
  if (chatCapture && [...chatCapture.owners.values()].includes(session?.id)) return;
  const job = screenshot?.job;
  const editingRegion = session?.triggerKey === 'region-screenshot' && job?.purpose === 'region' && job.valid;
  overlayPlacement?.show(session?.id, editingRegion ? job.display : null, editingRegion ? job.recordingAnchor : null);
  overlayPlacement?.setEditorActive(Boolean(editingRegion));
  if (progressActive) overlay.webContents.send('inmoment:event', { type: 'holdProgress', phase: 'complete', triggerKey: progressTriggerKey });
  if (overlaySession) { overlay.webContents.send('inmoment:event', overlaySession); overlaySession = null; }
  progressActive = false; overlay.setIgnoreMouseEvents(false); overlay.showInactive();
}
function hideOverlay() { progressActive = false; overlaySession = null; const session=controller?.snapshot();overlayPlacement?.cancelPreview(session?.active?session.id:null); if (overlay && !overlay.isDestroyed()) { overlay.hide(); overlay.setIgnoreMouseEvents(false); } }
function startHoldProgress(data) {
  if (shutdownStarted || screenshot?.busy || !settings.public().inputEnabled || controller.snapshot().active || !overlay || overlay.isDestroyed()) return;
  progressActive = true; overlaySession = null; progressTriggerKey = data.trigger || 'right-button';
  overlayPlacement.preview(data); overlay.setIgnoreMouseEvents(true, { forward: true });
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
  mainWindow = new BrowserWindow({ width: 1320, height: 900, minWidth: 1000, minHeight: 700, show: false, title: 'InMoment', icon: path.join(__dirname, '../assets/icon.ico'), backgroundColor: '#FFFFFF', autoHideMenuBar: true, ...mainChrome, webPreferences: options });
  overlay = new BrowserWindow({ width: 400, height: 440, show: false, frame: false, transparent: true, resizable: false, hasShadow: false, ...overlayBehavior, webPreferences: options });
  overlayPlacement = new OverlayPlacement({getWindow:()=>overlay,screen:require('electron').screen,offsetY:-4});
  overlayPlacement.setEditorActive(false);
  overlay.on('moved', () => overlayPlacement.fitSurface());
  recorder = new BrowserWindow({ show: false, width: 180, height: 100, skipTaskbar: true, webPreferences: { ...options, preload: path.join(__dirname, 'recorder-preload.cjs'), backgroundThrottling: false } });
  chatWindow = new BrowserWindow({ ...CHAT_INITIAL_SIZE, minWidth:CHAT_MINIMUM_SIZE.width, minHeight:CHAT_MINIMUM_SIZE.height, show: false, frame: false, transparent:true, hasShadow:false, alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#00000000', webPreferences: { ...options, backgroundThrottling:false } });
  for (const window of [mainWindow, overlay, recorder, chatWindow]) secureWindow(window);
  for (const window of [mainWindow, chatWindow]) {
    const owner = window.id;
    for (const event of ['did-start-loading', 'render-process-gone']) window.webContents.on(event, () => cancelImageRecognition(owner));
    window.on('closed', () => cancelImageRecognition(owner));
  }
  chatWindow.on('close', event => { if (!quitting) { event.preventDefault(); closeChat().catch(reportCloseFailure); } });
  for (const event of ['hide','minimize','blur']) chatWindow.on(event,pauseFloatingRecording);
  for (const event of ['hide','minimize','blur']) {
    mainWindow.on(event, pauseMainChatRecording);
    mainWindow.on(event, cancelShortcutCapture);
  }
  mainWindow.webContents.on('render-process-gone', cancelShortcutCapture);
  uiDialogs = new AppDialogManager({ getWindow: () => mainWindow, showWindow: showMain });
  mainWindow.webContents.on('did-start-loading', () => { setWindowModalState(mainWindow,false); uiDialogs.cancelAll({ resetReady: true }); });
  mainWindow.webContents.on('render-process-gone', () => { setWindowModalState(mainWindow,false); uiDialogs.cancelAll({ resetReady: true }); });
  mainWindow.on('hide', () => uiDialogs.cancelAll());
  mainWindow.on('closed', () => uiDialogs.close());
  for (const event of ['maximize', 'unmaximize']) mainWindow.on(event, () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('inmoment:event', { type: 'windowState', ...windowState(mainWindow) });
  });
  mainWindow.loadFile(mainFile); overlay.loadFile(overlayFile);
  chatWindow.loadURL('about:blank');
  recorderReady = recorder.loadFile(recorderFile);
  mainWindow.once('ready-to-show', () => { if (process.env.INMOMENT_SMOKE !== '1') mainWindow.show(); });
  mainWindow.on('close', event => { setWindowModalState(mainWindow,false); uiDialogs.cancelAll(); if(screenshot?.job?.options.origin===mainWindow)screenshot.cancelChat(screenshot.job.id).catch(()=>{}); if (!quitting) { event.preventDefault(); mainWindow.hide(); } });
  overlay.on('close', event => { if (!quitting) { event.preventDefault(); overlay.hide(); } });
  recorder.webContents.on('render-process-gone', () => controller?.fail(new Error('录音组件异常，当前录音已停止。')));
  tray = new Tray(imageIcon()); tray.setToolTip('InMoment');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 InMoment', click: showMain }, { label: '暂停录音', click: () => controller?.pause() }, { type: 'separator' }, { label: '退出', click: () => app.quit() }]));
  tray.on('double-click', showMain);
}
function publicRecord(record) {
  if (!record) return null;
  const organization = record.organization;
  const screenshots = record.screenshots.map(item => ({ id: item.id, url: recordMediaURL(record.id, 'image', item.id), capturedAt: item.capturedAt, role: item.method === 'region' ? 'region' : 'background' }));
  const screenshot = screenshots.find(item => item.id === preferredScreenshot(record)?.id) || null;
  return {
    id: record.id, status: record.status, title: record.title || organization?.title || [...(record.transcript || '').replace(/\s+/gu, ' ').trim()].slice(0, 24).join('') || `笔记 · ${new Date(record.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`, editableTitle: record.title, task: record.task, notes: record.notes,
    createdAt: record.createdAt, updatedAt: record.completedAt || record.createdAt, durationMs: record.durationMs,
    transcript: record.hasTranscriptOverride ? record.transcript : record.transcript || (!record.segments.length ? record.notes : ''), hasTranscriptOverride: Boolean(record.hasTranscriptOverride), transcriptionMetrics: record.transcription ? { provider: record.transcription.provider, model: record.transcription.model, durationMs: record.transcription.durationMs, audioDurationMs: record.transcription.audioDurationMs, rtf: record.transcription.rtf } : null, searchMode: record.searchMode || 'local-keyword', matchSnippet: record.matchSnippet,
    keepAudio: record.keepAudio, keepText: record.keepText, audioCleanupPending: record.audioCleanupPending,
    context: { appName: record.source?.processName || record.source?.appName || '', windowTitle: record.source?.title || record.source?.windowTitle || '', url: sourceWebUrl(record.source?.url), canFocus: Boolean(record.source?.hwnd && record.source?.pid), screenshotUnavailable: record.source?.screenshotUnavailable === true },
    audioSegments: record.segments.map(segment => ({ id: segment.id, url: recordMediaURL(record.id, 'audio', segment.id), durationMs: segment.durationMs, transcript: segment.transcript })),
    screenshotUrl: screenshot?.url || '', screenshot, screenshots,
    organization: organization || null,
    version: record.version, contentVersion: record.contentVersion, organizationStale: record.organizationStale,
    topics: record.topics || [], topicIds: (record.topics || []).map(item => item.id), topicsManual: Boolean(record.topicsManual),
    parentId: record.parentId || null, parentTitle: record.parentTitle || '', continuations: record.continuations || [], duplicateGroupId: record.duplicateGroupId || null,
    questions: organization?.questions || [], jobs: record.jobs
  };
}
function publicGroup(group) { return group ? { ...group, records: (group.records || []).map(publicRecord) } : null; }
function bootstrap() {
  if (offlineASR) { const local = offlineASR.capabilities(); capabilities.offlineASR = { available: local.available, provider: local.provider, model: local.model, reason: local.reason }; if (local.available) capabilities.asrStatus = 'available'; }
  return { records: store.listRecords({ limit: 30 }).map(publicRecord), recordCount: store.countRecords(), recordHeaders: store.listRecordHeaders(), settings: settings.public(), capabilities, chats: chats?.list() || [], semantic: semantic?.status(), drafts: store.listDrafts().map(publicRecord), session: captureSessionForUI(), topics: store.listTopics(), duplicateSuggestions: store.listDuplicateSuggestions(), groups: store.listGroups().map(publicGroup), version: app.getVersion(), libraryJobs: [...libraryTasks].map(([kind, task]) => ({ kind, status: task.status || 'processing', runId: task.runId, total: task.total })) };
}

function registerMedia() {
  protocol.handle('inmoment-media', request => {
    try {
      const url = new URL(request.url); const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (url.hostname === 'note' && parts.length === 2) return noteMediaResponse(notes, request, ...parts);
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

async function previewExistingText(id, expectedVersion) {
  const record = store.getRecord(id);
  if (!record?.segments.length || record.version !== expectedVersion) throw new Error('这条灵感已修改，请刷新后重试。');
  if (asrJobs.has(id)) throw new Error('这条灵感正在转写，请稍候。');
  const abort = new AbortController();
  const promise = runLocalTextPreview(record, { signal: abort.signal }).then(result => {
    if (shutdownStarted || abort.signal.aborted || store.getRecord(id)?.version !== expectedVersion) throw new Error('这条灵感已修改，请刷新后重试。');
    return { transcript: result.segments.map(segment => segment.text).filter(value => typeof value === 'string' && /[\p{L}\p{N}]/u.test(value)).join('\n') };
  }).finally(() => asrJobs.delete(id));
  asrJobs.set(id, { abort, promise, preview: true });
  return promise;
}
async function runLocalTextPreview(record, { signal }) {
  if (capabilities.localCleanupError) {
    try { capabilities.localCleanupError = !offlineASR.cleanupStaleJobs().ok; } catch { capabilities.localCleanupError = true; }
    if (capabilities.localCleanupError) throw new Error('上次转写的临时文件尚未清理，请检查本地目录权限后重试。');
  }
  return offlineASR.transcribe(record, { signal });
}
async function transcribe(id, { preserveOriginals = false } = {}) {
  if (shutdownStarted || store.closed) return null;
  if (asrJobs.get(id)?.preview) throw new Error('这条灵感正在转写，请稍候。');
  if (asrJobs.has(id)) return asrJobs.get(id).promise;
  if (capabilities.localCleanupError) {
    try { capabilities.localCleanupError = !offlineASR.cleanupStaleJobs().ok; } catch { capabilities.localCleanupError = true; }
    if (capabilities.localCleanupError) throw new Error('上次转写的临时文件尚未清理，请退出应用、检查本地目录权限后重试。');
  }
  const record = store.getRecord(id); if (!record) throw new Error('记录不存在。');
  const cleanup = store.cleanupTranscriptionAudio(id);
  if (!cleanup.ok) {
    store.setJob(id, 'transcribe', 'failed', '未识别为语音的音频仍待清理，请检查本地目录权限后重试。');
    broadcast({ type: 'recordsChanged' }); return publicRecord(store.getRecord(id));
  }
  if (!record.segments.length) { store.setJob(id, 'transcribe', 'done'); return publicRecord(record); }
  const asrCapability = offlineASR.capabilities();
  if (!asrCapability.available) {
    store.setJob(id, 'transcribe', 'unavailable', asrCapability.reason === 'upgrade-required' ? '本地转写已改用 SenseVoiceSmall，请重新准备离线语音组件。' : 'SenseVoiceSmall 本地语音组件尚未就绪，可在详情中手动补充文字。');
    broadcast({ type: 'recordsChanged' }); autoTitles.run(id).catch(() => {}); return publicRecord(store.getRecord(id));
  }
  const abort = new AbortController();
  const generation = store.row(id).generation;
  store.setJob(id, 'transcribe', 'processing');
  broadcast({ type: 'recordsChanged' });
  const job = (async () => {
  try {
    const result = await offlineASR.transcribe(record, { signal: abort.signal });
    if (shutdownStarted || store.closed || abort.signal.aborted || store.row(id)?.generation !== generation || !store.getRecord(id)) return null;
    const applied = store.applyTranscriptionResult(id, result, { expectedGeneration: generation, expectedSegments: record.segments, expectedContentVersion: record.version, clearTranscriptOverride: !preserveOriginals, retainSilentAudio: preserveOriginals });
    if (!applied.applied) store.setJob(id, 'transcribe', 'not-applied', '本地转写已完成；你已修改文字，因此保留你的修订，未覆盖。');
    else {
      if (applied.removedIds.length) { modelJobs.get(id)?.abort(); autoTitles.cancel(id); semantic?.invalidate(id); }
      store.setJob(id, 'transcribe', applied.cleanup.ok ? 'done' : 'failed', applied.cleanup.ok ? null : '转写已完成，未识别为语音的音频仍待清理，请检查本地目录权限后重试。');
    }
    broadcast({ type: 'recordsChanged' }); autoTitles.run(id).catch(() => {}); return publicRecord(store.getRecord(id));
  } catch (error) { if (!shutdownStarted && !store.closed && store.getRecord(id)) store.setJob(id, 'transcribe', 'failed', '本地转写未完成，可重试或手动补充文字。'); broadcast({ type: 'recordsChanged' }); throw error; }
  finally { asrJobs.delete(id); }
  })();
  asrJobs.set(id, { abort, promise: job });
  return job;
}
async function organize(id, { includeScreenshot = false, expectedVersion, expectedGeneration, signal, requestApproved = false, deferGrouping = false, aiConfig } = {}) {
  assertCapability(settings.public(), 'cloudEnabled');
  if (modelJobs.has(id)) throw new Error('这条记录已有整理任务。');
  const config = aiConfig || currentAIConfig(); assertAIConfig(config); const service = getProvider(config.provider).label;
  const record = store.getRecord(id); if (!record || !(record.hasTranscriptOverride ? record.transcript : record.transcript || record.notes)?.trim()) throw new Error('请先补充转写或表达文字，再进行 AI 整理。');
  const generation = store.row(id)?.generation;
  if (expectedVersion !== undefined && record.version !== expectedVersion || expectedGeneration !== undefined && generation !== expectedGeneration) throw new Error('记录已修改或删除，本次没有发送；请刷新后重试。');
  const sameRecord = () => !shutdownStarted && !store.closed && store.getRecord(id) && store.row(id)?.generation === generation;
  const direct = hasDirectConsent(settings.public());
  const aiRecord = record.hasTranscriptOverride ? { ...record, notes:'', transcription:null, segments:[{ id:`edited-${id}`, transcript:record.transcript, sourceType:'written-note' }] } : { ...record, segments: [...record.segments] };
  if (!record.hasTranscriptOverride && !record.transcript?.trim() && record.notes?.trim()) aiRecord.segments.push({ id: `note-${id}`, transcript: record.notes, sourceType: 'written-note' });
  let image;
  // A pre-approved batch freezes its upload scope and image budget at the click.
  // Turning on screenshots during that batch must not add new material to later items.
  const screenshotRequested = requestApproved === true ? includeScreenshot === true : direct ? settings.public().screenshotAnalysisEnabled === true : includeScreenshot === true;
  const useScreenshot = screenshotRequested && record.screenshots.length > 0;
  if (useScreenshot) {
    assertCapability(settings.public(), 'screenshotAnalysisEnabled');
    if (!supportsImages(config.provider, config.model)) throw new Error('当前模型不支持截图理解或尚未启用，请选择支持图片的模型或关闭截图辅助理解。');
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
      type: 'question', title: `允许这一次 ${service} 请求？`,
      message: `将这条记录的文字发送给 ${service} 整理？`,
      detail: `将发送 ${record.segments.length} 段转写、任务、补充文字、已有主题名称，以及已保存的来源应用、窗口标题和网址线索。${image ? '同时发送预览中的这张来源截图，可能包含个人信息。' : '本次不发送截图。'}不发送原始音频。模型：${config.model}。可能产生 API 费用，本次同意仅授权一次请求，不会自动重试。`,
      buttons: ['取消', '同意发送一次'], defaultId: 0, cancelId: 0, noLink: true,
      });
      approved = approval.response === 1;
    }
    if (!approved || !sameRecord() || abort.signal.aborted) return { cancelled: true };
    assertAIConfig(config);
    if (store.getRecord(id).version !== record.version) throw new Error('确认期间记录已修改，本次未发送；请核对内容后重新整理。');
    assertCapability(settings.public(), 'cloudEnabled');
    if (direct && !hasDirectConsent(settings.public())) throw new Error('点击即发送授权已关闭，本次未发送。');
    if (image) assertCapability(settings.public(), 'screenshotAnalysisEnabled');
    store.setJob(id, 'organize', 'processing');
    broadcast({ type: 'recordsChanged' });
    const result = await createConfiguredClient(config).organize({ ...aiRecord, availableTopics: store.listTopics().map(item => item.name) }, { approved: true, signal: abort.signal, image, deferGrouping });
    if (!sameRecord() || abort.signal.aborted || !sameAIConfig(config)) return { cancelled: true };
    store.saveOrganization(id, { ...result, provider:config.provider, ...(deferGrouping ? { topicSuggestions: [] } : {}) }, { expectedVersion: record.version }); store.setJob(id, 'organize', 'done'); broadcast({ type: 'recordsChanged' }); return publicRecord(store.getRecord(id));
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
  const config = currentAIConfig();
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
      message: (kind === 'search' ? `在选定范围的 ${scopeTotal} 条灵感中查找？` : '分析选定范围内可能重复的灵感？') + ` 服务：${getProvider(config.provider).label}；模型：${config.model}。`,
      detail: kind === 'search' ? '先发送搜索描述，再发送本地筛出的最多 20 条候选的原话片段、摘要、任务与来源线索；最多两次请求。不是逐条阅读全库。不发送录音或截图。会产生 API 费用，取消不能撤回已经发送的内容。' : `范围共 ${scopeTotal} 条。先在本地筛选候选，本次最多比较 5 对，只运行一批请求。发送候选原话片段、摘要、任务与来源线索，不发送录音或截图。只生成重复建议，不直接合并或删除。会显示覆盖和用量，未检查的候选需再次点击分析。`,
      buttons: ['取消', '同意本次分析'], defaultId: 0, cancelId: 0, noLink: true,
      });
      approved = approval.response === 1;
    }
    if (!approved || shutdownStarted || abort.signal.aborted) return { cancelled: true };
    if (direct && !hasDirectConsent(settings.public())) throw new Error('点击即发送授权已关闭，本次未发送。');
    assertAIConfig(config);
    assertCapability(settings.public(), capability); task.status = 'processing'; broadcast({ type: 'libraryJob', kind, status: 'processing' });
    const client = createConfiguredClient(config);
    task.promise = kind === 'search' ? libraryAI.search({ query, filters, approved: true, signal: abort.signal, candidateLimit: 20, client }) : libraryAI.analyzeDuplicates({ filters, approved: true, signal: abort.signal, client });
    const result = await task.promise;
    if (shutdownStarted || abort.signal.aborted || !sameAIConfig(config)) return { cancelled: true };
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
  const config = currentAIConfig();
  if (libraryTasks.size) throw new Error('已有资料库 AI 任务，请等待完成或先取消。');
  const direct = hasDirectConsent(settings.public());
  const batch = new BatchOrganizer({ store, organize:(id, options) => organize(id, { ...options, aiConfig:config }), onProgress: broadcast, async classify(records, options) {
    assertCapability(settings.public(), 'cloudEnabled');
    if (direct && !hasDirectConsent(settings.public())) throw new Error('点击即发送授权已关闭，本次未发送。');
    assertAIConfig(config);
    const result = await createConfiguredClient(config).classifyBatch(records, options);
    assertAIConfig(config); return result;
  } });
  const snapshot = batch.snapshot(params.recordIds, params.expectedVersions);
  const includeScreenshot = direct ? settings.public().screenshotAnalysisEnabled === true : params.includeScreenshot === true;
  if (includeScreenshot) assertCapability(settings.public(), 'screenshotAnalysisEnabled');
  const runId = require('node:crypto').randomUUID(); const abort = new AbortController();
  const task = { abort, runId, total: snapshot.length, status: direct ? 'processing' : 'confirming' }; libraryTasks.set('batchOrganize', task);
  task.promise = (async () => {
    let approved = direct;
    if (!approved) {
      const result = await askDialog({ type: 'question', title: '允许这一次批量整理？', message: `使用 ${getProvider(config.provider).label}（${config.model}）整理当前显示的 ${snapshot.length} 条灵感？`, detail: `只处理点击时已显示的记录快照。先逐条发送转写、任务、补充文字、已有主题名和来源线索，生成摘要；再把本批成功摘要和已有分组名统一比较，形成少量共同分组建议，增加一次请求；本次最多 ${snapshot.length + 1} 次请求。${includeScreenshot ? '逐条摘要时同时发送各记录已保存的来源截图，可能包含个人信息；统一归类只发送文字摘要。' : '不发送截图。'}不上传原始音频或视频。会产生 API 费用，取消无法撤回已发送的内容或费用。统一归类摘要上限为 96,000 字节，超过则保留摘要并提示缩小范围。只保存摘要与分组建议，采用分组需要另外确认。失败不自动重试。`, buttons: ['取消', '同意本次批量整理'], defaultId: 0, cancelId: 0, noLink: true });
      approved = result.response === 1;
    }
    if (!approved) abort.abort();
    task.status = 'processing'; broadcast({ type: 'libraryJob', kind: 'batchOrganize', status: 'processing', runId, total: snapshot.length });
    return batch.run({ snapshot, runId, signal: abort.signal, includeScreenshot, approved: true, onBeforeItem() {
      assertAIConfig(config);
      assertCapability(settings.public(), 'cloudEnabled');
      if (direct && !hasDirectConsent(settings.public())) throw new Error('点击即发送授权已关闭。');
      if (includeScreenshot) assertCapability(settings.public(), 'screenshotAnalysisEnabled');
    } });
  })();
  try { return await task.promise; }
  finally { libraryTasks.delete('batchOrganize'); broadcast({ type: 'libraryJob', kind: 'batchOrganize', status: 'idle', runId }); }
}

async function runNoteGrouping(params) {
  assertCapability(settings.public(), 'cloudEnabled');
  if (libraryTasks.size) throw new Error('已有资料库 AI 任务，请等待完成或先取消。');
  const config = currentAIConfig();
  const classifyUnfiled = params.uncategorized === true;
  const noteIds = classifyUnfiled ? notes.listIds('', 'uncategorized', BATCH_GROUPING_LIMITS.maxRecords) : params.noteIds;
  if (classifyUnfiled && !noteIds.length) throw new Error('未分类中没有需要整理的笔记。');
  const snapshot = noteGrouping.snapshot(noteIds);
  const direct = hasDirectConsent(settings.public());
  const abort = new AbortController();
  const task = { abort, runId: snapshot.runId, status: direct ? 'processing' : 'confirming', total: snapshot.input.records.length };
  libraryTasks.set('noteGrouping', task);
  try {
    if (!direct) {
      const result = await askDialog({
        type: 'question', title: '允许这一次整理笔记？',
        message: `用 ${getProvider(config.provider).label}（${config.model}）为${classifyUnfiled ? '未分类中的' : '选中的'} ${task.total} 条笔记推荐分组？`,
        detail: '发送笔记的标题、正文摘录和候选分组路径。每次整理发起一次 AI 请求，采用建议后才更新笔记的分组。',
        buttons: ['取消', '同意本次整理'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response !== 1) abort.abort();
    }
    if (abort.signal.aborted) return { cancelled: true };
    assertCapability(settings.public(), 'cloudEnabled');
    assertAIConfig(config);
    if (direct && !hasDirectConsent(settings.public())) throw new Error('点击即发送授权已关闭。');
    task.status = 'processing';
    return await noteGrouping.suggest(snapshot, async (records, options) => {
      const result = await createConfiguredClient(config).classifyBatch(records, options);
      assertAIConfig(config);
      return result;
    }, { signal: abort.signal });
  } catch (error) {
    if (abort.signal.aborted) return { cancelled: true };
    throw error;
  } finally { libraryTasks.delete('noteGrouping'); }
}

function cancelLibraryTasks() { for (const task of libraryTasks.values()) task.abort.abort(); libraryAI?.clearCache?.(); }

function removeSavedAudio(id, transcript, expectedVersion) {
  if (!Number.isSafeInteger(expectedVersion) || store.getRecord(id)?.version !== expectedVersion) throw new Error('这条笔记已修改，请刷新后重试。');
  if (asrJobs.has(id)) throw new Error('这条笔记正在转写，请稍候。');
  if (!offlineASR.cleanupRecordJobs(id).ok) throw new Error('上次转写的临时文件尚未清理，请检查本地目录权限后重试。');
  controller.removeStagedAudio(id);
  const cleanup = store.keepRecordTextOnly(id, transcript, { expectedVersion });
  modelJobs.get(id)?.abort(); autoTitles.cancel(id); libraryAI?.clearCache?.(); semantic?.invalidate(id); audioWaveforms?.invalidate(id);
  broadcast({ type: 'recordsChanged' });
  return cleanup.ok;
}

async function deleteSavedRecord(id) {
  if (store.row(id)?.status !== 'saved') return { deleted: false };
  noteAI?.cancel(`record:${id}`);
  audioWaveforms?.invalidate(id);
  modelJobs.get(id)?.abort(); cancelLibraryTasks(); autoTitles.cancel(id);
  const local = asrJobs.get(id);
  local?.abort.abort();
  if (local) await local.promise.catch(() => {});
  if (shutdownStarted || store.closed) return { cancelled: true };
  if (store.row(id)?.status !== 'saved') return { deleted: false };
  store.deleteRecord(id);
  const attachments = notes?.removeAttachmentOwner(`record:${id}`);
  audioWaveforms?.invalidate(id);
  semantic?.invalidate(id);
  let transcriptionCleaned = false;
  try { transcriptionCleaned = offlineASR.cleanupRecordJobs(id).ok; } catch {}
  if (!transcriptionCleaned) capabilities.localCleanupError = true;
  broadcast({ type: 'recordsChanged' });
  return { deleted: true, transcriptionCleaned, cleanupPending: Boolean(attachments?.cleanupPending) || !transcriptionCleaned };
}

function selectedNotes(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new Error('请选择要操作的笔记。');
  const unique = [...new Set(ids)];
  for (const id of unique) notes.requireOwner(id);
  return unique;
}

async function deleteNote(id) {
  const recordId = recordIdForNote(id);
  if (recordId) return deleteSavedRecord(recordId);
  noteAI?.cancel(id);
  return { deleted: true, ...notes.delete(id) };
}

async function deleteNotes(ids) {
  const deleted = [];
  let cleanupPending = false;
  for (const id of selectedNotes(ids)) {
    const result = await deleteNote(id);
    if (result.deleted) deleted.push(id);
    cleanupPending ||= Boolean(result.cleanupPending);
  }
  if (deleted.length) broadcast({ type: 'recordsChanged' });
  return { deleted, cleanupPending };
}

function copyNotes(ids, topicId) {
  const chosen = selectedNotes(ids);
  const topicIds = topicId === undefined ? undefined : [topicId];
  const copies = [];
  try {
    for (const id of chosen) copies.push(notes.copy(id, { topicIds }));
  } catch (error) {
    for (const copy of copies) { try { notes.delete(copy.id); } catch { /* File cleanup can resume at startup. */ } }
    throw error;
  }
  broadcast({ type: 'recordsChanged' });
  return { notes: copies };
}

async function printNotePDF(html) {
  const filename = path.join(app.getPath('userData'), `.note-print-${randomUUID()}.html`);
  let printer;
  try {
    await fs.promises.writeFile(filename, html, { flag: 'wx' });
    printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
    await printer.loadFile(filename);
    return await printer.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
  } finally {
    if (printer && !printer.isDestroyed()) printer.destroy();
    await fs.promises.rm(filename, { force: true }).catch(() => {});
  }
}

async function runNoteExport(params) {
  const { groupIds } = params;
  const group = groupIds !== undefined;
  const ids = group ? [...notes.membershipsInTopics(store.topicSubtreeIds(groupIds)).keys()] : selectedNotes(params.ids);
  if (!ids.length) throw new Error('所选分组里没有可导出的笔记。');
  let { mode, format } = params;
  if (mode === undefined && (group || ids.length > 1)) {
    const { response } = await askDialog({ type: 'question', title: '导出笔记', message: `导出 ${ids.length} 条笔记`,
      detail: '可以合并为一个文档，也可以按笔记分别生成文件。附件随文档另存。',
      buttons: ['取消', '合为一个文件', '每条一个文件'], defaultId: 1, cancelId: 0 });
    if (!response) return null;
    mode = response === 1 ? 'combined' : 'separate';
  }
  mode ??= 'combined';
  if (!['combined', 'separate'].includes(mode)) throw new Error('请选择支持的导出方式。');
  if (format === undefined) {
    const { response } = await askDialog({ type: 'question', title: '选择导出格式', message: '将笔记保存为 PDF 或 Markdown',
      buttons: ['取消', 'PDF', 'Markdown'], defaultId: 1, cancelId: 0 });
    if (!response) return null;
    format = response === 1 ? 'pdf' : 'markdown';
  }
  if (!['pdf', 'markdown'].includes(format)) throw new Error('请选择支持的导出格式。');
  let target;
  if (mode === 'separate') {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择导出目录', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    [target] = result.filePaths;
  } else {
    const ext = format === 'pdf' ? 'pdf' : 'md';
    const title = group && groupIds.length === 1 ? store.listTopics().find(topic => topic.id === groupIds[0])?.name
      : ids.length === 1 ? notes.get(ids[0]).title : 'InMoment 笔记';
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出笔记', defaultPath: `${exportName(title)}.${ext}`,
      filters: [{ name: format === 'pdf' ? 'PDF' : 'Markdown', extensions: [ext] }] });
    if (result.canceled) return null;
    target = result.filePath;
    if (target && path.extname(target).toLowerCase() !== '.' + ext) throw new Error(`请使用 .${ext} 文件扩展名。`);
  }
  if (!target || shutdownStarted) return null;
  return exportNotes({ notes, ids, target, format, mode, printPDF: printNotePDF });
}

async function invoke(method, params = {},originWindow=null) {
  if (shutdownStarted) throw new Error('应用正在退出，请稍后重新打开。');
  const id = typeof params.id === 'string' ? params.id : '';
  if (screenshot?.busy && ['chat:record', 'draft:startManual', 'draft:continue'].includes(method)) {
    const activeRegion = screenshot.job.purpose === 'region' && screenshot.job.recordingId && (!id || id === screenshot.job.recordingId);
    if (method !== 'draft:continue' || !activeRegion) throw new Error('请先完成或取消截图。');
  }
  if (screenshot?.job?.purpose === 'region' && ['draft:finish', 'draft:recover'].includes(method)) throw new Error('请先确认或取消截图，再存为笔记。');
  switch (method) {
    case 'app:bootstrap': return bootstrap();
    case 'app:uiReady': return uiDialogs?.markReady() || false;
    case 'window:minimize': return controlWindow(mainWindow, 'minimize');
    case 'window:toggleMaximize': return controlWindow(mainWindow, 'toggleMaximize');
    case 'window:close': return controlWindow(mainWindow, 'close');
    case 'window:state': return windowState(mainWindow);
    case 'window:modalState': return setWindowModalState(mainWindow, params.active, params.imageViewer);
    case 'app:setDirty': editState = { recordDirty: params.recordDirty === true, settingsDirty: params.settingsDirty === true, noteDirty: params.noteDirty === true }; return true;
    case 'app:show': {
      const recordId = params.recordId;
      const noteId = params.noteId;
      if (noteId !== undefined && !notes.reference(noteId)) throw new Error('这条笔记已不存在。');
      if (recordId && !store.getRecord(recordId)) throw new Error('这条笔记已不存在。');
      showMain();
      if (noteId || recordId) mainWindow.webContents.send('inmoment:event', { type: 'noteOpen', id: noteId || 'record:' + recordId });
      return true;
    }
    case 'notes:list': return notes.list(params.query, params.offset, params.topicId, { includeRecent: params.includeRecent === true });
    case 'notes:listIds': return { ids: notes.listIds(params.query, params.topicId) };
    case 'notes:get': return notes.get(id);
    case 'notes:create': return notes.create(params.topicId, { title: params.title, body: params.body, document: params.document });
    case 'notes:copy': return copyNotes(params.ids, params.topicId);
    case 'notes:deleteMany': return deleteNotes(params.ids);
    case 'notes:export': return runNoteExport(params);
    case 'notes:aiSummary': return noteAI.summary(id, { selection: params.selection, start: params.start, end: params.end, approved: true });
    case 'notes:aiRewrite': return noteAI.rewrite(id, { selection: params.selection, start: params.start, end: params.end, instruction: params.instruction, approved: true });
    case 'notes:cancelAI': return noteAI.cancel(id);
    case 'notes:copySelection': return copyNoteSelection({ notes, clipboard, ClipboardItem, nativeImage }, params);
    case 'notes:readPicture': return readNotePicture(notes, id, params.attachmentId);
    case 'image:readRecord': {
      const record = store.get(id);
      const screenshot = record && (params.attachmentId === undefined
        ? preferredScreenshot(record) : record.screenshots.find(item => item.id === params.attachmentId));
      if (!screenshot) throw new Error('来源截图已不存在。');
      const filename = store.safePath(screenshot.path);
      const file = await fs.promises.open(filename, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > NOTE_OCR_MAX_BYTES) throw new Error('图片不可读取或超过 32 MB。');
        return { mime: 'image/png', bytes: await file.readFile() };
      } finally { await file.close(); }
    }
    case 'image:recognize': {
      if (process.env.INMOMENT_SMOKE === '1') throw new Error('隔离测试使用模拟识别结果。');
      const { requestId, bytes } = params;
      if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/u.test(requestId)) throw new Error('图片识别请求无效。');
      const owner = originWindow.id;
      if (noteOcrRequests.has(owner)) {
        throw new Error('已有图片正在识别，请稍后重试。');
      }
      inspectNoteOcrImage(bytes);
      const job = { requestId, abort: new AbortController() };
      noteOcrRequests.set(owner, job);
      const task = noteOcrQueue.then(() => {
        job.abort.signal.throwIfAborted();
        noteOcr ||= createNoteOcr();
        return noteOcr.recognize(bytes, { signal: job.abort.signal });
      });
      noteOcrQueue = task.catch(() => {});
      try {
        return await task;
      } finally {
        if (noteOcrRequests.get(owner) === job) noteOcrRequests.delete(owner);
      }
    }
    case 'image:cancelRecognition': {
      if (typeof params.requestId === 'string') cancelImageRecognition(originWindow.id, params.requestId);
      return true;
    }
    case 'image:copyText': {
      if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 1_000_000) {
        throw new Error('没有可复制的文字，或文字超出长度上限。');
      }
      await clipboard.writeText(params.text);
      return true;
    }
    case 'image:copyOutline': return copyImageOutline({ clipboard, ClipboardItem }, params.outline);
    case 'image:copyEdited': {
      inspectNoteOcrImage(params.bytes);
      const png = new Blob([params.bytes], { type: 'image/png' });
      await clipboard.write([new ClipboardItem({ 'image/png': png })]);
      return true;
    }
    case 'notes:replacePicture': {
      inspectNoteOcrImage(params.bytes);
      const result = await notes.replacePicture(id, params);
      broadcast({ type: 'recordsChanged' });
      return result;
    }
    case 'notes:clipboard': {
      const action = params.action;
      if (!['copy', 'cut', 'paste'].includes(action)) throw new Error('不支持的剪贴板操作。');
      originWindow.webContents[action]();
      return true;
    }
    case 'notes:update': {
      const recordId = recordIdForNote(id);
      const previousVersion = recordId ? store.row(recordId)?.content_version : undefined;
      const result = notes.update(id, params.title, params.body, params.document);
      if (recordId) {
        if (store.row(recordId)?.content_version !== previousVersion) {
          modelJobs.get(recordId)?.abort(); autoTitles.cancel(recordId);
          libraryAI?.clearCache?.(); semantic?.invalidate(recordId);
        }
        broadcast({ type: 'recordsChanged' });
      }
      return result;
    }
    case 'notes:delete': {
      const result = await deleteNote(id);
      if (!result.deleted && !result.cancelled) throw new Error('这条笔记已不存在。');
      return result.cancelled ? result : { cleanupPending: result.cleanupPending };
    }
    case 'notes:removeAudio': {
      const recordId = recordIdForNote(id);
      const record = recordId && store.getRecord(recordId);
      if (!record) throw new Error('这条笔记没有可移除的录音。');
      const note = notes.get(id);
      if (!note.body.trim()) throw new Error('请先填写并保存要保留的正文。');
      removeSavedAudio(recordId, note.body, record.version);
      return notes.get(id);
    }
    case 'notes:pasteFiles': {
      const paths = await clipboardFilePaths(clipboard);
      if (shutdownStarted) return null;
      return paths.length ? notes.attachPaths(params.id, paths, params.create) : null;
    }
    case 'notes:attach': return notes.attachBytes(params.id, params.files, params.create, { inlineOnly: params.inlineOnly === true });
    case 'notes:pickFiles': {
      const result = await dialog.showOpenDialog(mainWindow, { title: '插入文件到笔记', properties: ['openFile', 'multiSelections'] });
      return result.canceled || shutdownStarted ? null : notes.attachPaths(params.id, result.filePaths, params.create);
    }
    case 'notes:remove': {
      const result = notes.remove(id, params.attachmentId, params.kind);
      if (params.kind === 'summary') noteAI?.cancel(params.attachmentId);
      return result;
    }
    case 'notes:reveal': {
      shell.showItemInFolder(notes.file(id, params.attachmentId).filename);
      return true;
    }
    case 'notes:openLink': {
      const url = webLink(params.url);
      if (!url) throw new Error('无法打开此链接。');
      await shell.openExternal(url);
      return true;
    }
    case 'chat:list': return chats.list();
    case 'chat:referenceNotes': return notes.list(params.query, params.offset, '', { includeGroupCounts: false });
    case 'chat:create': return chats.create({ images: params.images, attachments: params.attachments, selectedText: params.selectedText,quotes:params.quotes,autoSave:originWindow===mainWindow });
    case 'chat:get': { const chat=chats.get(id);return chat?{...chat,voice:chatCapture?.voiceStates?.get(id)||null}:null; }
    case 'chat:update': return chats.update(id, Object.fromEntries(['input', 'candidate', 'recordIds', 'images', 'attachments', 'selectedText','quotes'].filter(key => params[key] !== undefined).map(key => [key, params[key]])));
    case 'chat:send': return chats.send(id, { text: params.text, recordIds: params.recordIds, modelOverride: params.modelOverride, reasoningEffort: params.reasoningEffort });
    case 'chat:retry': return chats.retry(id);
    case 'chat:cancel': return chats.cancel(id);
    case 'chat:save': return chats.save(id);
    case 'chat:rename': return chats.rename(id,params.title);
    case 'chat:delete': return deleteChat(id);
    case 'chat:inspiration': {
      const record = await chats.toInspiration(id, { messageIds: params.messageIds, summarize: params.summarize === true });
      broadcast({ type: 'recordsChanged' }); return publicRecord(record);
    }
    case 'chat:openFloating': return showChat(id || undefined);
    case 'chat:resize': return resizeFloatingChat(id, params.height);
    case 'chat:screenshot': return takeChatScreenshot(id,params,originWindow);
    case 'chat:close': return closeChat(id || floatingChatId);
    case 'chat:showMain': {
      const transferVersion=chatTransitionVersion,ownerAtRequest=floatingChatId||openingChatTarget;
      let target=id||floatingChatId;if(!target && chatOpening)target=(await chatOpening)?.id;
      const ownsTransfer=()=>Boolean(target && target===ownerAtRequest && transferVersion===chatTransitionVersion && (target===floatingChatId || target===openingChatTarget));
      if(target){
        if(ownsTransfer()){const ready=await chatWindow.webContents.executeJavaScript?.(`window.chatView?.prepareForClose?.(${JSON.stringify(target)})`);if(ready!==true)throw new Error('聊天尚未准备好，请稍后再转到主窗口。');}
        chats.save(target);
      }
      await screenshot?.cancelChat(target);
      const transfersFloating=ownsTransfer();
      if(transfersFloating){
        chatTransitionCancelKind='transfer';chatTransitionTransferSettings=params.settings===true;chatTransitionVersion++;enteringChat=false;
        chatTransition('cancel()')?.catch(()=>{});chatWindow.setIgnoreMouseEvents?.(false);chatTransitionTransferPending=false;
      }
      showMain();
      if(chatVoiceOrigins.has(target) && (transfersFloating || floatingChatId!==target))chatVoiceOrigins.get(target).window=mainWindow;
      if (target || params.settings) mainWindow.webContents.send('inmoment:event', { type: 'chatOpen', id: target, settings: params.settings === true });
      if(transfersFloating){chatWindow.hide();floatingChatId=null;}return true;
    }
    case 'chat:record': {
      if (process.env.INMOMENT_SMOKE === '1') throw new Error('隔离检查中不启用麦克风。');
      if(!chats.get(id))throw new Error('聊天已结束。');
      const origin=[mainWindow,chatWindow].includes(originWindow)?originWindow:id===floatingChatId?chatWindow:mainWindow;
      if(origin===chatWindow && id!==floatingChatId)throw new Error('聊天已切换，请在当前聊天中重试。');
      const previous=activeOwnedChat(),active=controller.snapshot();
      if(previous && previous!==id && chatVoiceOrigins.has(previous) && !chats.deleting.has(previous) && active.state==='paused' && store.getDraft(chatCapture.owners.get(previous))?.status==='draft' && !['starts','jobs','recordings','retryJobs','cancelling','releasing'].some(key=>chatCapture[key]?.has(previous))){
        await chatCapture.release(previous);chatVoiceOrigins.delete(previous);
        if(!chats.get(id))throw new Error('聊天已结束。');
      }
      chatVoiceOrigins.set(id,{window:origin});chatRecordingStarts.add(id);
      try{
        const result=await chatCapture.record(id),draftId=chatCapture.owners.get(id);if(draftId)chatVoiceOrigins.get(id).draftId=draftId;
        hideOverlay();controller.emitState();await controller.refreshTrigger();
        if(!origin.isVisible() || origin.isMinimized() || origin.isFocused?.()===false)await pauseOwnedCapture(id);
        return result;
      }finally{chatRecordingStarts.delete(id);if(!chatCapture.owners.has(id))chatVoiceOrigins.delete(id);}
    }
    case 'chat:voiceStop': return chatCapture.stopRecording(id, params.token);
    case 'chat:voiceCancel': return chatCapture.cancelRecording(id, params.token);
    case 'chat:voiceRetry': return chatCapture.retry(id);
    case 'overlay:hide': hideOverlay(); return true;
    case 'overlay:surface': overlayPlacement.setSurface(params); return true;
    case 'settings:get': return settings.public();
    case 'settings:shortcutCapture': {
      if (originWindow !== mainWindow || !Number.isSafeInteger(params.captureId)) throw new Error('请在主窗口设置截图录音快捷键。');
      if (params.active === true) {
        if (!mainWindow.isFocused()) return false;
        shortcutCapture = { id: params.captureId, pending: null };
        mainWindow.webContents.setIgnoreMenuShortcuts?.(true);
      } else if (shortcutCapture?.id === params.captureId) cancelShortcutCapture();
      return true;
    }
    case 'settings:shortcutKey': {
      if (originWindow === mainWindow && shortcutCapture?.id === params.captureId && mainWindow.isFocused()) captureShortcutInput(params.input);
      return true;
    }
    case 'settings:reset': {
      const approval = await askDialog({ type: 'question', title: '恢复默认设置？', message: '恢复功能和交互时序的默认设置？', detail: '会重置触发时间、功能键、截图录音快捷键、排除应用、截图开关和模型选择，并关闭云端 AI 与自动命名。保留全部灵感记录、录音、截图和已保存的 API 密钥。', buttons: ['取消', '恢复默认'], defaultId: 0, cancelId: 0, noLink: true });
      if (approval.response !== 1 || shutdownStarted) return { cancelled: true };
      settingsWriteVersion += 1;
      let saved;
      try { saved = saveSettingsWithRegionShortcut(DEFAULT_REGION_SHORTCUT, () => settings.resetToDefaults()); }
      catch (error) {
        if (error.code === REGION_SHORTCUT_ERROR) throw error;
        throw new Error('默认设置未能保存，原有设置已保留，请检查目录权限后重试。');
      }
      autoTitles.cancelAll(); for (const job of modelJobs.values()) job.abort(); cancelLibraryTasks();
      noteAI?.cancelAll();
      for (const chat of chats?.list() || []) chats.cancel(chat.id);
      await controller.refreshTrigger(); broadcast({ type: 'settingsChanged' }); return saved;
    }
    case 'settings:save': {
      let approvedAutoTitle = false;
      const current = settings.public();
      const version = ++settingsWriteVersion; const originalValue = settings.value;
      const shortcut = params.regionScreenshotShortcut === undefined ? current.regionScreenshotShortcut : normalizeRegionShortcut(params.regionScreenshotShortcut);
      const selectedProvider = params.aiProvider ?? current.aiProvider ?? DEFAULT_PROVIDER;
      const service = getProvider(selectedProvider).label;
      const providerChanged = selectedProvider !== (current.aiProvider || DEFAULT_PROVIDER);
      const stillCurrent = () => !shutdownStarted && version === settingsWriteVersion && settings.value === originalValue;
      const approvedCapabilities = pendingCapabilities(current, params);
      if (approvedCapabilities.length) {
        const detail = approvedCapabilities.map(key => `${CAPABILITY_INFO[key].label}：${CAPABILITY_INFO[key].description.replaceAll('DeepSeek', service)}`).join('\n\n');
        const chatMedia = selectedProvider === 'gemini' ? '聊天中添加的 PDF、MP4 和图片可随消息原样发送。'
          : selectedProvider === 'openai' ? '聊天中添加的 PDF 和图片可随消息原样发送，MP4 只发送本地抽出的画面和语音转写。'
            : '聊天中添加的图片可随消息原样发送，PDF 和 MP4 发送本地提取的文字和画面。';
        const approval = await askDialog({ type: 'question', title: providerChanged ? '更换 AI 服务？' : '启用所选 AI 功能？', message: `使用 ${service} 处理已选的 AI 功能？`, detail: `${detail}\n\n数据发送至 ${service}，使用该服务的 API Key，按服务商规则计费。${chatMedia}聊天语音输入发送转写文字。笔记总结的来源截图需要单独启用。${params.directAIEnabled === true || hasDirectConsent(current) ? '批量整理、查找和重复分析按点击发送。' : '批量整理、查找和重复分析逐次确认。'}可随时关闭。`, buttons: ['取消', '同意并保存 AI 设置'], defaultId: 0, cancelId: 0, noLink: true });
        if (approval.response !== 1 || !stillCurrent()) return { cancelled: true };
      }
      if ((params.autoTitleEnabled ?? current.autoTitleEnabled) && (providerChanged || !current.autoTitleEnabled || current.autoTitleConsentVersion !== 1)) {
        const approval = await askDialog({ type: 'question', title: '启用完成后的自动命名？', message: `允许使用 ${service} 为后续完成的灵感自动生成标题？`, detail: `启用云端功能并配置该服务的密钥后，每条完成且已有转写的记录最多自动请求一次 ${service}，不再逐条弹窗。只发送这条记录前 12,000 字符的转写，不发送录音、截图、窗口信息或其他记录；可能产生 API 费用。手动标题不会被覆盖，失败不自动重试。可随时关闭此设置。当前操作不会测试 API。`, buttons: ['取消', '启用自动命名'], defaultId: 0, cancelId: 0, noLink: true });
        if (!stillCurrent()) return { cancelled: true };
        approvedAutoTitle = approval.response === 1;
        if (!approvedAutoTitle) params = { ...params, autoTitleEnabled: false };
      }
      if (!stillCurrent()) return { cancelled: true };
      const saved = saveSettingsWithRegionShortcut(shortcut, () => settings.save(params, { approvedAutoTitle, approvedCapabilities }));
      const activePatch = params.aiProfiles?.[selectedProvider];
      const keyChanged = params.clearApiKey === true || typeof params.apiKey === 'string' && Boolean(params.apiKey.trim()) || activePatch?.clearApiKey === true || typeof activePatch?.apiKey === 'string' && Boolean(activePatch.apiKey.trim());
      const configChanged = providerChanged || saved.model !== current.model || saved.modelMode !== current.modelMode || keyChanged;
      if (!saved.cloudEnabled || !saved.hasApiKey || configChanged || current.screenshotAnalysisEnabled && !saved.screenshotAnalysisEnabled) noteAI?.cancelAll();
      else if (hasSelectionContextConsent(current) && !hasSelectionContextConsent(saved)) noteAI?.cancelSelectionContext();
      if (!saved.cloudEnabled || configChanged || saved.preferFreeModel !== current.preferFreeModel) {
        for (const id of [...(chats?.jobs.keys() || [])]) chats.cancel(id);
      }
      if (!saved.autoTitleEnabled || !saved.cloudEnabled || !saved.hasApiKey || configChanged) autoTitles.cancelAll();
      if (!saved.cloudEnabled || current.screenshotAnalysisEnabled && !saved.screenshotAnalysisEnabled || current.directAIEnabled && !hasDirectConsent(saved) || !saved.hasApiKey || saved.model !== current.model) for (const job of modelJobs.values()) job.abort();
      if (!saved.hasApiKey || configChanged) { for (const job of modelJobs.values()) job.abort(); cancelLibraryTasks(); }
      else { if (!saved.aiSearchEnabled) libraryTasks.get('search')?.abort.abort(); if (!saved.duplicateAnalysisEnabled) libraryTasks.get('duplicates')?.abort.abort(); }
      if (!saved.cloudEnabled || keyChanged || current.directAIEnabled && !hasDirectConsent(saved) || current.screenshotAnalysisEnabled && !saved.screenshotAnalysisEnabled) { autoTitles.cancelAll(); for (const job of modelJobs.values()) job.abort(); cancelLibraryTasks(); }
      await controller.refreshTrigger(); broadcast({ type: 'settingsChanged' }); return saved;
    }
    case 'records:list': {
      const filters = normalizeFilters(params.filters); const limit = Math.max(1, Math.min(100, Number(params.limit) || 30)); const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
      const total = store.countRecords(filters); return { records: store.listRecords({ ...filters, limit, offset }).map(publicRecord), total, scopeTotal: total, limit, offset };
    }
    case 'records:get': return publicRecord(store.get(id));
    case 'records:waveform': {
      audioWaveforms ||= new AudioWaveformService({store});
      return audioWaveforms.get(id,params.segmentId);
    }
    case 'records:search': {
      const filters = normalizeFilters(params.filters); const query = String(params.query || '').slice(0, 500); const limit = Math.max(1, Math.min(100, Number(params.limit) || 30)); const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
      return { records: store.search(query, { ...filters, limit, offset }).map(publicRecord), total: store.countSearch(query, filters), scopeTotal: store.countRecords(filters), limit, offset };
    }
    case 'records:aiSearch': return runLibraryTask('search', params);
    case 'library:duplicates': return runLibraryTask('duplicates', params);
    case 'notes:suggestGroups': return runNoteGrouping(params);
    case 'notes:applyGroups': {
      const result = noteGrouping.apply(params.runId, params.assignments);
      if (result.applied) broadcast({ type: 'recordsChanged' });
      return result;
    }
    case 'notes:addToTopic': {
      store.db.exec('BEGIN IMMEDIATE');
      try { noteGrouping.addTopic(id, params.topicId); store.db.exec('COMMIT'); }
      catch (error) { store.db.exec('ROLLBACK'); throw error; }
      broadcast({ type: 'recordsChanged' });
      return true;
    }
    case 'library:batchOrganize': return runBatchOrganize(params);
    case 'library:cancel': {
      if (!params.kind || ['search', 'duplicates', 'batchOrganize', 'noteGrouping'].includes(params.kind)) { for (const [kind, task] of libraryTasks) if ((!params.kind || params.kind === kind) && (!params.runId || params.runId === task.runId)) task.abort.abort(); }
      const recordId = typeof params.recordId === 'string' ? params.recordId : id;
      if (recordId && (!params.kind || params.kind === 'organize')) modelJobs.get(recordId)?.abort();
      if (recordId && (!params.kind || params.kind === 'transcribe')) asrJobs.get(recordId)?.abort.abort();
      if (recordId && (!params.kind || params.kind === 'title')) autoTitles.cancel(recordId);
      return { cancelled: true };
    }
    case 'topics:create': { const result = store.createTopic(params.name, params.parentId); broadcast({ type: 'recordsChanged' }); return result; }
    case 'topics:rename': { const result = store.renameTopic(id, params.name); broadcast({ type: 'recordsChanged' }); return result; }
    case 'topics:merge': { const result = store.mergeTopic(id, params.targetId); broadcast({ type: 'recordsChanged' }); return result; }
    case 'topics:delete': { const result = store.deleteTopic(id); broadcast({ type: 'recordsChanged' }); return result; }
    case 'topics:mergeMany': { const result = store.mergeTopics(params.topicIds, params.targetId); broadcast({ type: 'recordsChanged' }); return result; }
    case 'topics:deleteMany': { const result = store.deleteTopics(params.topicIds); broadcast({ type: 'recordsChanged' }); return result; }
    case 'topics:move': { const result = store.moveTopic(id, params.parentId); broadcast({ type: 'recordsChanged' }); return result; }
    case 'topics:copyTree': {
      const sources = notes.membershipsInTopics(store.topicSubtreeIds(params.topicIds));
      const { mapping, roots } = store.copyTopicStructure(params.topicIds, params.parentId);
      const copies = [];
      try {
        for (const [noteId, groupIds] of sources) {
          const copy = notes.copy(noteId, { topicIds: groupIds.map(groupId => mapping.get(groupId)) });
          copies.push(copy.id);
        }
        return { groupIds: roots, count: mapping.size };
      } catch (error) {
        const cleanupErrors = [];
        for (const copyId of copies) try { notes.delete(copyId); } catch (failure) { cleanupErrors.push(failure); }
        try { store.deleteTopics(roots, { includeDescendants: true }); } catch (failure) { cleanupErrors.push(failure); }
        if (cleanupErrors.length) throw new Error('复制中断，部分副本仍保留在本机。', { cause: error });
        throw error;
      } finally { broadcast({ type: 'recordsChanged' }); }
    }
    case 'topics:deleteWithNotes': {
      const scope = store.topicSubtreeIds(params.topicIds);
      const noteIds = [...notes.membershipsInTopics(scope, { exclusive: true }).keys()];
      try {
        const result = noteIds.length ? await deleteNotes(noteIds) : { deleted: [], cleanupPending: false };
        if (shutdownStarted || store.closed) return { cancelled: true };
        if (result.deleted.length !== noteIds.length) return { partial: true, deletedNotes: result.deleted, cleanupPending: result.cleanupPending };
        return { ...store.deleteTopics(params.topicIds, { includeDescendants: true }), deletedNotes: result.deleted, cleanupPending: result.cleanupPending };
      } finally { broadcast({ type: 'recordsChanged' }); }
    }
    case 'records:setTopics': { const result = store.setRecordTopics(id, params.topicIds, { expectedVersion: params.expectedVersion }); controller.emitState(); broadcast({ type: 'recordsChanged' }); return publicRecord(result); }
    case 'duplicates:decide': { const result = store.decideDuplicate(id, params.decision); broadcast({ type: 'recordsChanged' }); return result?.records ? publicGroup(result) : result; }
    case 'groups:ungroup': { const result = store.ungroup(id); broadcast({ type: 'recordsChanged' }); return result; }
    case 'groups:rename': { const result = store.renameGroup(id, params.name); broadcast({ type: 'recordsChanged' }); return publicGroup(result); }
    case 'records:update': {
      const record = store.getRecord(id); if (!record) throw new Error('只能编辑已完成记录。');
      if (params.expectedVersion !== undefined && params.expectedVersion !== record.version) throw new Error('这条记录已发生变化，请保留当前文字，重新打开核对后再保存。');
      const transcriptSegments = Array.isArray(params.transcriptSegments) ? params.transcriptSegments : undefined;
      store.updateRecord(id, params, { transcriptSegments, expectedVersion: params.expectedVersion });
      broadcast({ type: 'recordsChanged' }); autoTitles.run(id).catch(() => {}); return publicRecord(store.getRecord(id));
    }
    case 'records:delete': {
      const result = await deleteSavedRecord(id);
      if (result.cancelled) return result;
      if (result.deleted && !result.transcriptionCleaned) throw new Error('记录已移除，但部分转写临时文件清理失败。请退出应用、检查本地目录权限后重试；应用启动时会再次清理。');
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
    case 'records:previewText': return previewExistingText(id, params.expectedVersion);
    case 'records:keepTextOnly': {
      if (!removeSavedAudio(id, params.transcript, params.expectedVersion)) throw new Error('文字已保留，原录音文件仍待清理。请检查本地目录权限后重试。');
      return publicRecord(store.getRecord(id));
    }
    case 'records:revealScreenshot': return revealScreenshot({ store, shell }, id, params.attachmentId);
    case 'media:open-original': return openOriginal({ store, shell }, id);
    case 'media:reveal-record': return revealRecord({ store, shell }, id);
    case 'records:openSource': {
      const record = store.get(id); if (!record?.source?.hwnd || !record.source.pid) throw new Error('这条记录没有可返回的窗口。');
      return bridge.request('focusWindow', { hwnd: record.source.hwnd, pid: record.source.pid, processName: record.source.processName });
    }
    case 'records:openSourceUrl': {
      const url = sourceWebUrl(store.get(id)?.source?.url);
      if (!url) throw new Error('这条记录没有可打开的网址。');
      await shell.openExternal(url); return true;
    }
    case 'draft:startManual': { const owner=activeOwnedChat();if(owner){await recoverOwnedChat(owner);return captureSessionForUI();}return controller.startManual(); }
    case 'draft:continue': { const owner=activeOwnedChat();if(owner&&(!id||id===controller.snapshot().id)){await recoverOwnedChat(owner);return captureSessionForUI();}if (id) controller.restoreDraft(id); return controller.continueRecording(params.transcript); }
    case 'draft:pause': { const owner=activeOwnedChat();return owner?pauseOwnedCapture(owner):controller.pause(); }
    case 'draft:discard': audioWaveforms?.invalidate(id || controller.snapshot().id); if (id && id !== controller.session.sessionId) { store.discard(id); broadcast({ type: 'recordsChanged' }); return { deleted: true }; } await screenshot?.cancelRegion(); return controller.discard();
    case 'draft:retention': return controller.setRetention(params);
    case 'draft:retryText': await controller.previewText(); return captureSessionForUI();
    case 'draft:finish':
    case 'draft:recover': {
      const owner = activeOwnedChat();
      if (owner && (!id || id === controller.snapshot().id)) { await recoverOwnedChat(owner); return { needsTextReview: true }; }
      if (id) controller.restoreDraft(id);
      const active = controller.snapshot();
      if (active.active && active.keepText && !active.committingText && params.transcript === undefined) {
        controller.previewText(); showOverlay(); overlay.focus(); return { needsTextReview: true };
      }
      const record = await controller.finish(params.transcript);
      audioWaveforms?.invalidate(record?.id);
      return publicRecord(record);
    }
    case 'draft:deleteAbandoned': audioWaveforms?.invalidate(id); if (id === controller.session.sessionId) { await screenshot?.cancelRegion(); return controller.discard(); } store.discard(id); broadcast({ type: 'recordsChanged' }); return { deleted: true };
    default: throw new Error('不支持的操作。');
  }
}

async function start() {
  if (!gotLock) return;
  const dataDir = app.getPath('userData'); fs.mkdirSync(dataDir, { recursive: true });
  for (const name of fs.readdirSync(dataDir)) {
    if (!/^\.note-print-[\da-f-]{36}\.html$/u.test(name)) continue;
    try { fs.rmSync(path.join(dataDir, name), { force: true }); } catch { /* Retry on next startup. */ }
  }
  const videoJobs = path.join(dataDir, 'chat-media-jobs');
  const videoCleanupOK = cleanupVideoJobs(videoJobs);
  store = new LocalStore(dataDir); settings = new Settings(dataDir, safeStorage);
  notes = new NotesStore(store);
  noteAI = new NoteAI({ notes, prepareRequest: prepareNoteAI });
  noteGrouping = new NoteGrouping({ store, notes });
  for (const job of store.db.prepare("SELECT j.record_id,j.kind FROM jobs j JOIN records r ON r.id=j.record_id WHERE r.status='saved' AND j.status='processing' AND j.kind IN ('organize','transcribe')").all()) store.setJob(job.record_id, job.kind, 'cancelled', '上次任务已中断。原始记录仍保留，未自动重试。');
  semantic = createSemanticService({ store, dataDir, bundledModelDir: path.join(path.dirname(process.execPath), 'offline-semantic'), onProgress: broadcast, networkDisabled: process.env.INMOMENT_DISABLE_NETWORK === '1' });
  libraryAI = new LibraryAI({ store, semantic, client: createConfiguredClient });
  autoTitles = new AutoTitleManager({ store, settings, createClient:createConfiguredClient, onChanged: () => broadcast({ type: 'recordsChanged' }), isClosing: () => shutdownStarted });
  autoTitles.recoverInterrupted();
  const portableASR = path.join(path.dirname(process.execPath), 'offline-asr');
  const asrRoot = process.env.INMOMENT_ASR_DIR ? path.resolve(process.env.INMOMENT_ASR_DIR) : fs.existsSync(path.join(portableASR, 'asr.json')) ? portableASR : app.isPackaged ? path.join(dataDir, 'offline-asr') : path.join(app.getAppPath(), '.local/asr');
  offlineASR = new OfflineASR(asrRoot, { jobsDir: path.join(dataDir, 'asr-jobs') });
  try { capabilities.localCleanupError = !offlineASR.cleanupStaleJobs().ok; } catch { capabilities.localCleanupError = true; }
  createWindows(); registerMedia();
  if (!videoCleanupOK) mainWindow.webContents.once('did-finish-load', () => {
    broadcast({ type: 'error', message: '部分视频处理临时文件仍待清理，请检查应用数据目录权限。' });
  });
  if (notes.cleanupFailures) mainWindow.webContents.once('did-finish-load', () => {
    broadcast({ type: 'error', message: '部分已删除的笔记附件仍待清理，请检查本地文件是否被占用。' });
  });
  const nativePath = path.join(app.getAppPath(), 'build/native/InMoment.Native.exe');
  bridge = new NativeBridge(nativePath).start();
  controller = new CaptureController({ store, bridge, settings,
    disableGlobalInput: process.env.INMOMENT_SMOKE === '1',
    canRecoverActive:()=>!screenshot?.job?.valid && Boolean(activeOwnedChat()),onActiveHold:()=>!screenshot?.busy && recoverOwnedChat(activeOwnedChat()),
    transcribeDraft: runLocalTextPreview, shouldPreviewText: () => !enteringChat && !activeOwnedChat() && !chatRecordingStarts.size,
    sendRecorder: message => { recorderReady.then(() => { if (!recorder.isDestroyed()) recorder.webContents.send('recorder:command', message); }).catch(() => controller.fail(new Error('录音组件未能加载。'))); },
    showOverlay, hideOverlay,
  });
  chats = new ChatService({ rootDir: dataDir, store, notes, getConfig: currentAIConfig,
    createClient: config => createChatClient({ provider: config.provider, apiKey: config.key, model: config.model,
      allowModelOverride: config.modelMode === 'manual', preferFreeModel: config.preferFreeModel }),
    prepareMessages: (messages, options) => prepareChatMessages(messages, {
      ...options,
      tempRoot: path.join(dataDir, 'chat-media-jobs'),
      transcribe: ({ wavPath, signal }) => offlineASR.transcribe({
        id: randomUUID(), segments: [{ id: randomUUID(), path: wavPath }],
      }, { signal }),
    }),
    beforeSend: () => {
      if (shutdownStarted) throw new Error('应用正在退出。');
      assertCapability(settings.public(), 'cloudEnabled');
    },
  });
  chats.on('change', chat => broadcast({ type: 'chatChanged', chat: publicChat(chat) }));
  chats.on('deleted',({id})=>{chatVoiceOrigins.delete(id);broadcast({type:'chatDeleted',id});});
  chats.on('list', list => broadcast({ type: 'chatList', chats: list }));
  if (chats.loadErrors.length) {
    capabilities.chatHistoryError = chats.loadErrors[0];
    mainWindow.webContents.once('did-finish-load', () => broadcast({ type: 'error', message: capabilities.chatHistoryError }));
  }
  chatCapture = new ChatCapture({ store, controller, asr: offlineASR, chats, analyzeVoiceActivity,
    readContext: (id, source) => captureContexts.get(id) || (source?.hwnd ? bridge.request('readContext', { hwnd: source.hwnd, pid: source.pid }, 1400).catch(() => ({})) : Promise.resolve({})),
    onVoice: data => broadcast({ type: 'chatVoice', ...data }),
  });
  if (chatCapture.recoveryErrors.length) {
    capabilities.chatCleanupError = chatCapture.recoveryErrors.join(' ');
    mainWindow.webContents.once('did-finish-load', () => broadcast({ type: 'error', message: capabilities.chatCleanupError }));
  }
  screenshot=createScreenshotCoordinator();
  bridge.on('holdStart', data => {
    if (screenshot?.busy || activeOwnedChat()) return;
    const id = controller.snapshot().id;
    if (id && data.source?.hwnd) {
      captureContexts.clear();
      const reading = bridge.request('readContext', { hwnd: data.source.hwnd, pid: data.source.pid }, 1400).catch(() => ({}));
      captureContexts.set(id, reading);
      controller.collectBackgroundUrl(id, reading);
    }
  });
  bridge.on('holdChat', () => {
    const session = controller.snapshot();
    if (screenshot?.busy || !session.active || session.triggerKey === 'region-screenshot') return;
    const owner=activeOwnedChat();(owner?recoverOwnedChat(owner):showChat()).catch(error => broadcast({ type: 'error', message: error.message }));
  });
  controller.on('session', session => {
    if (!session.active && session.id) captureContexts.delete(session.id);
    const focusable = session.active && session.keepText && !session.committingText && session.state === 'paused';
    if (!overlay.isDestroyed() && overlay.isFocusable() !== focusable) overlay.setFocusable(focusable);
    broadcast({ type: 'session', session: captureSessionForUI(session) });
    chatCapture.observeSession(session);
  });
  controller.on('audioLevel', sendOverlayAudioLevel);
  controller.on('audioLevel', sendChatAudioLevel);
  controller.on('recordsChanged', () => broadcast({ type: 'recordsChanged' }));
  controller.on('inputStatus', status => { capabilities.inputTrigger = status; capabilities.nativeAvailable = status.available; broadcast({ type: 'capabilities', capabilities }); if (status.error) broadcast({ type: 'error', message: status.error }); });
  controller.on('saved', record => {
    if (shutdownStarted) return;
    broadcast({ type: 'recordsChanged' });
    if (record.keepText && record.transcript.trim()) autoTitles.run(record.id).catch(() => {});
  });
  bridge.on('holdPreviewStart', startHoldProgress);
  bridge.on('holdPreviewCancel', cancelHoldProgress);
  ipcMain.handle('inmoment:invoke', async (event, method, params) => {
    if (![mainWindow.webContents.id, overlay.webContents.id, chatWindow.webContents.id].includes(event.sender.id) || event.senderFrame !== event.sender.mainFrame) return { ok: false, error: '不允许的界面来源。' };
    if (typeof method !== 'string') return { ok: false, error: '不支持的操作。' };
    if ((method.startsWith('notes:') || method.startsWith('topics:')) && !isMainFrameEvent(event, mainWindow)) return { ok: false, error: '此操作只能在主窗口执行。' };
    if (method.startsWith('image:') && !isMainFrameEvent(event, mainWindow) &&
        (method === 'image:readRecord' || !isMainFrameEvent(event, chatWindow))) return { ok: false, error: '此操作只能在图片预览中执行。' };
    if (method === 'settings:save' && params?.regionScreenshotShortcut !== undefined && !isMainFrameEvent(event, mainWindow)) return { ok: false, error: '请在主窗口修改截图录音快捷键。' };
    if (method === 'chat:resize' && !isMainFrameEvent(event, chatWindow)) return { ok: false, error: '此操作只能在聊天浮窗执行。' };
    if (method === 'overlay:surface' && !isMainFrameEvent(event, overlay)) return { ok: false, error: '此操作只能在录音浮窗执行。' };
    if(['chat:screenshot', 'chat:referenceNotes'].includes(method) && !isMainFrameEvent(event,mainWindow) && !isMainFrameEvent(event,chatWindow))return{ok:false,error:'此操作只能在聊天界面执行。'};
    if(method==='records:waveform' && !isMainFrameEvent(event,mainWindow))return{ok:false,error:'此操作只能在记录界面执行。'};
    if ((method === 'dialog:respond' || method === 'app:uiReady' || method.startsWith('window:') || method.startsWith('semantic:') || method === 'library:batchOrganize') && !isMainFrameEvent(event, mainWindow)) return { ok: false, error: '此操作只能在主窗口执行。' };
    try {
      if (method === 'dialog:respond') return { ok: true, value: uiDialogs.respond(event, params) };
      const value = await invoke(method, params,isMainFrameEvent(event,mainWindow)?mainWindow:isMainFrameEvent(event,chatWindow)?chatWindow:null);
      const publicValue = method.startsWith('chat:') ? (value?.chat ? { ...value, chat: publicChat(value.chat) } : publicChat(value)) : value;
      return { ok: true, value: publicValue };
    } catch (error) { return { ok: false, error: String(error.message || '操作未完成。').slice(0, 350), ...(['MODEL_NOT_INSTALLED', REGION_SHORTCUT_ERROR].includes(error.code) ? { code: error.code } : {}) }; }
  });
  ipcMain.handle('inmoment:screenshot',async(event,method,params)=>{
    try {
      const value = await screenshot.invoke(event,method,params);
      return { ok: true, value: value?.chat ? { ...value, chat: publicChat(value.chat) } : value };
    }
    catch(error){return{ok:false,error:String(error?.message||'截图操作未完成。').slice(0,250)}}
  });
  for (const [channel, handler] of Object.entries({ 'recorder:ready': data => controller.microphoneReady(data), 'recorder:chunk': data => controller.audioChunk(data), 'recorder:stopped': data => controller.segmentStopped(data), 'recorder:failed': data => controller.microphoneFailed(data) })) {
    ipcMain.handle(channel, async (event, data) => {
      if (event.sender.id !== recorder.webContents.id) throw new Error('Invalid recorder origin.');
      try { return await handler(data); } catch (error) { controller.fail(error); throw new Error('本地音频处理未完成。'); }
    });
  }
  bridge.on('bridgeFault', () => { capabilities.nativeAvailable = false; broadcast({ type: 'capabilities', capabilities }); });
  bridge.on('inputFault', data => { capabilities.nativeAvailable = false; cancelHoldProgress(); broadcast({ type: 'capabilities', capabilities }); broadcast({ type: 'error', message: data.message || '右键监听异常，请从托盘退出 InMoment 后重新打开。' }); });
  try {
    await bridge.request('configure', { enabled: false }); capabilities.nativeAvailable = true;
    const speech = await bridge.request('speechEngines'); capabilities.speechEngines = speech.engines || [];
    const local = offlineASR.capabilities(); capabilities.offlineASR = { available: local.available, provider: local.provider, model: local.model, reason: local.reason };
    capabilities.asrStatus = local.available ? 'available' : 'unavailable';
    if (process.env.INMOMENT_SMOKE !== '1') await controller.refreshTrigger();
  } catch { capabilities.asrStatus = 'unavailable'; capabilities.nativeAvailable = false; }
  for (const event of ['lock-screen', 'suspend']) powerMonitor.on(event, () => {
    screenshot.cancelRegion();
    controller.fail(new Error('系统已锁定或休眠，录音已暂停。'));
  });
  capabilities.regionScreenshot = regionShortcut.start(settings.public().regionScreenshotShortcut);
  broadcast({ type: 'capabilities', capabilities });
  app.on('second-instance', showMain);
  app.on('activate', showMain);
}

app.whenReady().then(start).catch(() => { dialog.showErrorBox('InMoment 启动失败', '本地组件未能启动。请确认原生程序已构建，并查看项目 README 中的运行要求。'); quitting = true; app.exit(1); });
app.on('window-all-closed', () => {});
app.on('will-quit', () => regionShortcut.close());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); if (shutdownStarted || quitApprovalPending) return;
  quitApprovalPending = true;
  (async () => {
    if (editState.recordDirty || editState.settingsDirty || editState.noteDirty) {
      const approval = await askDialog({ type: 'question', title: '有尚未保存的修改', message: '丢弃未保存的修改并退出？', detail: '已保存的灵感和本地录音草稿仍保留。取消后可回到窗口保存修改。', buttons: ['返回保存', '丢弃修改并退出'], defaultId: 0, cancelId: 0, noLink: true });
      if (approval.response !== 1) { quitApprovalPending = false; showMain(); return; }
    }
    try{if(!await prepareChatsForQuit()){quitApprovalPending=false;return;}}
    catch(error){quitApprovalPending=false;reportCloseFailure(error);return;}
    shutdownStarted = true;
    const noteAIShutdown = noteAI?.close();
    for (const owner of noteOcrRequests.keys()) cancelImageRecognition(owner);
    const noteOcrShutdown = noteOcr?.close();
    await screenshot?.shutdown();
    await notes?.close();
    await audioWaveforms?.close();
    await Promise.allSettled([...chatDeletions.values()]);
    uiDialogs?.close();
    for (const job of modelJobs.values()) job.abort();
    cancelLibraryTasks();
    for (const job of asrJobs.values()) job.abort.abort();
    const titleShutdown = autoTitles?.close();
    try { await chatCapture?.shutdown(); } catch {}
    try { await chats?.shutdown(); } catch {}
    await chats?.drainAttachmentJobs();
    try { await controller?.close(); } catch {}
    await Promise.allSettled([...asrJobs.values()].map(job => job.promise));
    await Promise.allSettled([...libraryTasks.values()].map(task => task.promise).filter(Boolean));
    await noteAIShutdown;
    await noteOcrShutdown;
    try { await titleShutdown; } catch {}
    try { await bridge?.close(); } catch {}
    try { await semantic?.close(); } catch {}
    try { store?.close(); } catch {}
    quitting = true; tray?.destroy(); app.quit();
  })();
});

// Test driver is local to the main process; never exposed through renderer IPC.
if (process.env.INMOMENT_SMOKE === '1') globalThis.__inmomentSmokeNativeEvent = (name, data) => {
  if (!['holdPreviewStart', 'holdPreviewCancel', 'holdStart', 'holdEnd', 'holdChat'].includes(name)) throw new Error('Unsupported synthetic input event.');
  bridge.emit(name, data || {});
};
