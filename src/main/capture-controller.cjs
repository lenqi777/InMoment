'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { RecordingSession, STATES } = require('../core/recording-session.cjs');
const { WavWriter, wavHeader } = require('./wav-writer.cjs');
const { AudioLevelMeter } = require('./audio-level.cjs');
const { sourceWebUrl } = require('./record-background.cjs');

const safeError = error => String(error?.message || '本地操作未完成。').slice(0, 250);
class CaptureController extends EventEmitter {
  constructor({ store, bridge, settings, sendRecorder, showOverlay, hideOverlay, disableGlobalInput = false, now, canRecoverActive = () => false, onActiveHold = () => {}, transcribeDraft, shouldPreviewText = () => true }) {
    super(); Object.assign(this, { store, bridge, settings, sendRecorder, showOverlay, hideOverlay, disableGlobalInput, canRecoverActive, onActiveHold, transcribeDraft, shouldPreviewText });
    this.session = new RecordingSession(); this.writers = new Map(); this.stops = new Map(); this.pending = new Set(); this.holdDelays = new Set(); this.error = ''; this.captureStatus = ''; this.persistenceError = null;
    this.regionScreenshotOpen = false;
    this.audioMeter = new AudioLevelMeter({ now });
    this.tempDir = path.join(store.rootDir, 'capture-staging'); fs.mkdirSync(this.tempDir, { recursive: true });
    // Recover only into an existing undecided local draft; discarded material cannot return.
    for (const filename of fs.readdirSync(this.tempDir)) {
      if (!/^[a-zA-Z0-9_-]+\.(png|wav)$/u.test(filename)) continue;
      const file = path.join(this.tempDir, filename);
      const draft = this.store.listDrafts().find(item => filename === item.id + '.png' || filename.startsWith(item.id + '-') && filename.endsWith('.wav'));
      try {
        if (draft) {
          const bytes = fs.readFileSync(file);
          if (filename.endsWith('.wav') && bytes.length > 44 && bytes.toString('ascii', 0, 4) === 'RIFF') {
            const id = path.basename(filename, '.wav');
            if (!draft.segments.some(segment => segment.id === id)) {
              const size = Math.floor((bytes.length - 44) / 2) * 2; const rate = bytes.readUInt32LE(24);
              if (rate >= 8000 && rate <= 96000) {
                wavHeader(size, rate).copy(bytes, 0);
                this.store.addSegment(draft.id, { id, bytes: bytes.subarray(0, size + 44), ext: 'wav', durationMs: size / rate / 2 * 1000 }, this.store.draftToken(draft.id));
              }
            }
          } else if (filename.endsWith('.png') && !draft.screenshots.length && bytes[0] === 137 && bytes.toString('ascii', 1, 4) === 'PNG') this.store.addScreenshot(draft.id, bytes, {}, this.store.draftToken(draft.id));
        }
        fs.unlinkSync(file);
      } catch { /* Keep a failed recovery in private staging rather than destroying the raw recording. */ }
    }
    this.closing = false; this.closed = false;
    this.bridgeHandlers = {
      holdStart: data => {
        if (this.closing || this.disableGlobalInput) return;
        const active = ![STATES.IDLE, STATES.SAVED, STATES.DISCARDED].includes(this.session.state);
        if (active && this.canRecoverActive()) Promise.resolve().then(() => this.onActiveHold(data)).catch(error => this.fail(error));
        else this.startHold(data.source).catch(error => this.fail(error));
      },
      holdEnd: () => { if (!this.closing && [STATES.ARMING_HOLD, STATES.RECORDING_HOLD].includes(this.session.state)) this.pause(true); },
      inputFault: data => this.fail(new Error(data.message || '输入监听异常。')),
      bridgeFault: data => this.fail(new Error(data.message || 'Windows 模块已断开。')),
    };
    for (const [name, handler] of Object.entries(this.bridgeHandlers)) bridge.on(name, handler);
  }
  emitState() { const snapshot = this.snapshot(); if (!this.closing && !this.closed) this.emit('session', snapshot); return snapshot; }
  resetAudioLevel() { const value = this.audioMeter.reset(this.session.snapshot()); if (value) this.emit('audioLevel', value); }
  snapshot() {
    if (this.closing || this.closed) return { id: null, segmentId: null, state: 'idle', rawState: 'CLOSED', active: false, mode: 'manual', elapsedMs: 0, error: '' };
    const raw = this.session.snapshot();
    const draft = raw.sessionId ? this.store.getDraft(raw.sessionId) : null;
    const states = { IDLE: 'idle', ARMING_HOLD: 'preparing', RECORDING_HOLD: 'recording', PAUSED: 'paused', ARMING_MANUAL: 'preparing', RECORDING_MANUAL: 'recording', COMMITTING: 'processing', SAVED: 'saved', DISCARDED: 'idle' };
    const recordingStartedAt = states[raw.state] === 'recording' ? this.writers.get(raw.segmentId)?.writer.startedAt ?? null : null;
    return { id: raw.sessionId, segmentId: raw.segmentId, state: states[raw.state], rawState: raw.state, mode: [STATES.ARMING_HOLD, STATES.RECORDING_HOLD].includes(raw.state) ? 'hold' : 'manual', triggerKey: raw.source?.trigger || 'right-button', elapsedMs: draft?.durationMs || 0, segmentCount: draft?.segments.length || 0, context: draft?.source || raw.source, parentId: draft?.parentId || null, topicIds: draft?.topics?.map(item => item.id) || [], captureStatus: this.captureStatus, error: this.error, active: Boolean(draft), cleanupPending: this.store.listPendingCleanup().length > 0,
      recordingStartedAt, regionScreenshotOpen: raw.source?.trigger === 'region-screenshot' && this.regionScreenshotOpen,
      keepAudio: draft?.keepAudio ?? true, keepText: draft?.keepText ?? true, draftTranscript: draft?.transcript || '', textPreviewing: Boolean(this.textPreview), textPreviewError: this.textPreviewError || '',
      textPreviewCanRetry: Boolean(this.textPreviewError && draft?.segments.some(segment => segment.order > draft.reviewedAudioOrder)),
      committingText: draft?.status === 'committing' };
  }
  async refreshTrigger() {
    if (this.closing || this.closed) return;
    const active = ![STATES.IDLE, STATES.SAVED, STATES.DISCARDED].includes(this.session.state);
    const recovery = active && this.canRecoverActive();
    const configuration = this.settings.public();
    try {
      const result = await this.bridge.request('configure', { enabled: configuration.inputEnabled && (!active || recovery) && !this.disableGlobalInput, previewDelayMs: configuration.previewDelayMs || 0, thresholdMs: configuration.thresholdMs, keyboardTrigger: configuration.keyboardTrigger || 'none', excludedApps: [...configuration.excludedApps, ...(!recovery ? ['InMoment', 'electron'] : [])] });
      if (!this.closing) this.emit('inputStatus', { enabled: Boolean(result?.enabled), available: result?.hookAvailable !== false, error: '' });
      return result;
    } catch {
      if (!this.closing) { this.error = '右键监听未能启用，请从托盘退出 InMoment 后重新打开。'; this.emit('inputStatus', { enabled: false, available: false, error: this.error }); this.emitState(); }
      return { enabled: false, hookAvailable: false };
    }
  }
  watch(promise) { this.pending.add(promise); promise.finally(() => this.pending.delete(promise)).catch(() => {}); return promise; }
  createDraft(source, extra = {}) {
    const initial = this.session.holdThresholdReached(source);
    this.store.createDraft({ id: initial.sessionId, source, createdAt: initial.createdAt, keepAudio: false, ...extra });
    this.storeToken = this.store.draftToken(initial.sessionId); this.error = ''; this.textPreviewError = ''; this.persistenceError = null; this.captureStatus = 'pending';
    this.resetAudioLevel();
    this.emitState(); this.refreshTrigger(); return initial;
  }
  prepare(token, mode) {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    this.stops.set(token.segmentId, { promise, resolve, token });
    this.sendRecorder({ command: 'prepare', token, mode });
  }
  waitHoldDelay(milliseconds, token) {
    const delay = Math.max(0, Math.min(5000, Number(milliseconds) || 0));
    if (!delay) return Promise.resolve(this.session.accepts(token) && !this.closing);
    return new Promise(resolve => {
      const entry = { timer: null, resolve: allowed => { clearTimeout(entry.timer); this.holdDelays.delete(entry); resolve(allowed); } };
      entry.timer = setTimeout(() => entry.resolve(this.session.accepts(token) && !this.closing), delay);
      this.holdDelays.add(entry);
    });
  }
  cancelHoldDelays() { for (const entry of [...this.holdDelays]) entry.resolve(false); }
  async startHold(source) {
    if (this.closing || this.closed) return this.snapshot();
    if (![STATES.IDLE, STATES.SAVED, STATES.DISCARDED].includes(this.session.state)) return this.emitState();
    this.session.rightDown(); const initial = this.createDraft(source || null);
    const startToken = this.session.token('start'); const writeToken = this.session.token(); const storeToken = this.storeToken;
    const configuration = this.settings.public();
    const work = (async () => {
      if (!await this.waitHoldDelay(configuration.captureDelayMs, startToken) || this.closing || !this.session.accepts(startToken)) return;
      await this.capture(initial.sessionId, source, writeToken, storeToken);
      if (this.closing || !this.session.accepts(startToken) || !await this.waitHoldDelay(configuration.menuDelayMs, startToken) || this.closing || !this.session.accepts(startToken)) return;
      this.prepare(startToken, 'hold'); this.showOverlay();
    })();
    await this.watch(work);
    return this.emitState();
  }
  async startManual({ keepAudio = false, keepText = !keepAudio } = {}) {
    if (this.closing || this.closed) throw new Error('应用正在退出。');
    if (![STATES.IDLE, STATES.SAVED, STATES.DISCARDED].includes(this.session.state)) { this.showOverlay(); return this.emitState(); }
    this.session.rightDown(); this.createDraft({ processName: 'InMoment', title: '手动辅助录音（未自动采集来源）' }, { keepAudio, keepText });
    this.session.rightUp(); this.captureStatus = 'not-requested'; this.showOverlay(); return this.continueRecording();
  }
  startRegion(source, sourceContext) {
    if (this.closing || this.closed) throw new Error('应用正在退出。');
    if (![STATES.IDLE, STATES.SAVED, STATES.DISCARDED].includes(this.session.state)) throw new Error('请先完成或丢弃当前录音，再开始截图录音。');
    this.session.rightDown();
    this.regionScreenshotOpen = true;
    let sessionId;
    try {
      ({ sessionId } = this.createDraft({ ...source, trigger: 'region-screenshot' }));
    } catch (error) {
      this.regionScreenshotOpen = false;
      this.session = new RecordingSession(); this.emitState(); this.refreshTrigger();
      throw new Error('录音草稿未能创建。请检查磁盘空间和目录权限后重试。', { cause: error });
    }
    if (sourceContext) this.collectBackgroundUrl(sessionId, sourceContext);
    this.session.rightUp();
    this.captureStatus = 'not-requested';
    return this.continueRecording();
  }
  finishRegionScreenshot(id) {
    if (!this.regionScreenshotOpen || id !== this.session.sessionId || !this.session.accepts(this.session.token())) return false;
    this.regionScreenshotOpen = false;
    this.emitState();
    return true;
  }
  saveRegionScreenshot(id, { bytes, width, height, capturedAt }) {
    if (this.closing || this.closed || id !== this.session.sessionId || !this.store.accepts(this.storeToken)) {
      throw new Error('本次录音草稿已结束。');
    }
    try {
      this.store.addScreenshot(id, bytes, { width, height, capturedAt, method: 'region' }, this.storeToken);
    } catch (error) {
      throw new Error('截图未能保存。请检查磁盘空间和目录权限后重试。', { cause: error });
    }
    this.captureStatus = 'captured';
    this.emitState();
  }
  restoreDraft(id) {
    if (this.session.sessionId === id && this.store.getDraft(id)) return this.emitState();
    if (![STATES.IDLE, STATES.SAVED, STATES.DISCARDED].includes(this.session.state)) throw new Error('请先完成或删除当前正在记录的草稿。');
    const draft = this.store.getDraft(id); if (!draft) throw new Error('草稿不存在。');
    this.session = new RecordingSession(); this.session.state = STATES.PAUSED; this.session.sessionId = id; this.session.epoch += 1;
    this.session.source = draft.source; this.session.createdAt = draft.createdAt; this.session.segmentCount = Math.max(0, ...draft.segments.map(item => item.order));
    this.regionScreenshotOpen = false;
    this.storeToken = this.store.draftToken(id); this.error = ''; this.textPreviewError = ''; this.persistenceError = null;
    this.captureStatus = draft.screenshots.length ? 'captured' : draft.source?.screenshotUnavailable ? 'unavailable' : 'not-requested';
    this.resetAudioLevel();
    this.refreshTrigger(); return this.emitState();
  }
  collectBackgroundUrl(id, reading) {
    const token = this.store.draftToken(id);
    if (!token || this.closing || this.closed) return;
    return this.watch((async () => {
      try {
        const url = sourceWebUrl((await reading)?.url);
        if (!url || this.closing || !this.store.accepts(token)) return;
        this.store.setDraftBackground(id, { url }, token);
        if (this.session.sessionId === id) this.emitState();
      } catch { /* Address-bar metadata is optional. */ }
    })());
  }
  async capture(id, source, token, storeToken) {
    if (this.closing || this.closed || !this.session.accepts(token) || !this.store.accepts(storeToken)) return;
    const work = (async () => {
      if (!this.settings.public().captureScreenshots || !source?.hwnd) { this.captureStatus = 'disabled'; this.emitState(); return; }
      const filename = path.join(this.tempDir, `${id}.png`);
      this.captureInFlight = true;
      try {
        const result = await this.bridge.request('captureWindow', { hwnd: String(source.hwnd), outputPath: filename }, 6500);
        if (!this.session.accepts(token) || !this.store.accepts(storeToken)) return;
        this.store.addScreenshot(id, fs.readFileSync(filename), { capturedAt: result.capturedAt, width: result.width, height: result.height, method: result.method }, storeToken);
        this.captureStatus = 'captured';
      } catch {
        if (this.session.accepts(token) && this.store.accepts(storeToken)) {
          this.captureStatus = 'unavailable';
          try { this.store.setDraftBackground(id, { screenshotUnavailable: true }, storeToken); } catch { /* The active draft still reports the capture failure. */ }
        }
      }
      finally { this.captureInFlight = false; try { fs.rmSync(filename, { force: true }); } catch {} this.emitState(); }
    })();
    return this.watch(work);
  }
  microphoneReady({ token, sampleRate }) {
    if (this.closing || this.closed) return { allowed: false };
    if (!this.session.accepts(token)) return { allowed: false };
    if (![16000, 22050, 24000, 44100, 48000].includes(sampleRate)) { this.microphoneFailed({ token, code: 'UnsupportedSampleRate' }); return { allowed: false }; }
    const result = this.session.microphoneReady(token);
    if (!result.actions.some(action => action.type === 'startRecording')) return { allowed: false };
    const writeToken = this.session.token();
    const filename = path.join(this.tempDir, `${token.segmentId}.wav`);
    this.writers.set(token.segmentId, { writer: new WavWriter(filename, sampleRate), token: writeToken, storeToken: this.storeToken, order: this.session.segmentCount });
    this.resetAudioLevel();
    this.error = ''; this.emitState(); return { allowed: true };
  }
  audioChunk({ token, pcm }) {
    if (this.closed) return { accepted: false };
    const entry = this.writers.get(token?.segmentId);
    if (!entry || !this.session.accepts(entry.token) || token.sessionId !== entry.token.sessionId || token.epoch !== entry.token.epoch || token.generation !== entry.token.generation) return { accepted: false };
    const bytes = new Uint8Array(pcm); entry.writer.append(bytes);
    // Pause may still accept final PCM for the WAV. Only the current live segment
    // can drive a visual level; late flushes never wake the paused capsule.
    const active = this.session.snapshot();
    if (!this.closing && [STATES.RECORDING_HOLD, STATES.RECORDING_MANUAL].includes(active.state)
      && token.segmentId === active.segmentId && token.epoch === active.epoch && token.generation === active.generation
      && token.generation === entry.token.generation) {
      const value = this.audioMeter.push(token, bytes); if (value) this.emit('audioLevel', value);
    }
    return { accepted: true };
  }
  async segmentStopped({ token, reason }) {
    if (this.closed) return { accepted: false };
    const entry = this.writers.get(token?.segmentId);
    if (entry) {
      this.writers.delete(token.segmentId);
      try {
        const info = entry.writer.finish();
        if (info.size && this.session.accepts(entry.token) && this.store.accepts(entry.storeToken)) {
          this.store.addSegment(token.sessionId, { id: token.segmentId, order: entry.order, bytes: fs.readFileSync(info.path), ext: 'wav', mimeType: 'audio/wav', ...info }, entry.storeToken);
        }
      } catch (error) {
        this.persistenceError = error; this.error = '音频保存失败，草稿未提交。请检查磁盘空间后重试。';
        if (!entry.writer.closed) { try { entry.writer.finish(); } catch {} }
        // Keep a closed staging WAV available for local recovery if persistence failed.
      } finally { if (!this.persistenceError) { try { fs.rmSync(entry.writer.path, { force: true }); } catch {} } }
    }
    this.stops.get(token?.segmentId)?.resolve(); this.stops.delete(token?.segmentId);
    if (['device-ended', 'replace'].includes(reason) && [STATES.RECORDING_HOLD, STATES.RECORDING_MANUAL].includes(this.session.state)) { this.session.pause(); this.error = '音频设备已停止，记录已暂停。'; this.previewText(); }
    if (token?.sessionId === this.session.sessionId && token?.segmentId === this.session.segmentId && token?.epoch === this.session.epoch) this.resetAudioLevel();
    this.emitState(); if (this.persistenceError) throw this.persistenceError; return { accepted: true };
  }
  microphoneFailed({ token, code }) {
    if (this.closing || this.closed) { this.stops.get(token?.segmentId)?.resolve(); this.stops.delete(token?.segmentId); return { accepted: false }; }
    this.stops.get(token?.segmentId)?.resolve(); this.stops.delete(token?.segmentId);
    const current = this.session.snapshot();
    if (token && current.sessionId === token.sessionId && current.epoch === token.epoch && current.segmentId === token.segmentId && ![STATES.DISCARDED, STATES.SAVED].includes(current.state)) {
      const entry = this.writers.get(token.segmentId);
      if (code === 'AudioWriteError') {
        this.persistenceError = new Error('音频写入失败，草稿未提交；请检查磁盘空间并保留本地原始文件。');
        if (entry) { try { entry.writer.finish(); } catch {} this.writers.delete(token.segmentId); }
      } else if (entry) { try { entry.writer.discard(); } catch {} this.writers.delete(token.segmentId); }
      this.session.pause(); this.error = code === 'NotAllowedError' ? '麦克风未获授权，请检查 Windows 麦克风隐私设置。' : '麦克风不可用，请检查设备后重试。';
      this.resetAudioLevel();
      if (this.persistenceError) this.error = this.persistenceError.message;
      this.showOverlay(); this.emitState();
    }
    return { accepted: true };
  }
  pause(fromRightRelease = false) {
    if (![STATES.ARMING_HOLD, STATES.RECORDING_HOLD, STATES.ARMING_MANUAL, STATES.RECORDING_MANUAL].includes(this.session.state)) return this.emitState();
    const result = fromRightRelease ? this.session.rightUp() : this.session.pause();
    this.resetAudioLevel();
    this.cancelHoldDelays();
    if (!this.captureInFlight && this.captureStatus === 'pending') this.captureStatus = 'cancelled-before-capture';
    for (const action of result.actions) if (['stopRecording', 'cancelRecordingStart'].includes(action.type)) this.sendRecorder({ command: 'stop', token: action.token, reason: 'pause' });
    this.showOverlay(); this.previewText(); return this.emitState();
  }
  continueRecording(transcript) {
    if (this.session.sessionId && this.store.getDraft(this.session.sessionId)?.status === 'committing') throw new Error('请先重试完成当前草稿。');
    if (transcript !== undefined) this.store.stageDraftText(this.session.sessionId, transcript, this.storeToken);
    this.cancelTextPreview();
    this.textPreviewError = '';
    this.error = ''; const result = this.session.continueRecording();
    for (const action of result.actions) if (action.type === 'prepareRecording') this.prepare(action.token, 'manual');
    this.showOverlay(); this.refreshTrigger(); return this.emitState();
  }
  async waitForStops() {
    const stops = [...this.stops.values()].map(item => item.promise);
    if (!stops.length) return;
    let timer;
    try { await Promise.race([Promise.all(stops), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('音频尚未完成收尾，请稍后重试。')), 8000); })]); }
    finally { clearTimeout(timer); }
  }
  previewText() {
    if (this.textPreview) return this.textPreview.promise;
    const id = this.session.sessionId;
    if (this.closing || this.session.state !== STATES.PAUSED || !this.shouldPreviewText(id)) return;
    const initial = this.store.getDraft(id);
    if (!initial || initial.status !== 'draft' || !initial.keepText || (!this.stops.size && !initial.segments.some(segment => segment.order > initial.reviewedAudioOrder))) return;
    const token = this.storeToken;
    const abort = new AbortController();
    const preview = { abort, promise: null };
    this.textPreview = preview;
    this.textPreviewError = '';
    preview.promise = this.watch((async () => {
      try {
        await this.waitForStops();
        if (abort.signal.aborted || !this.store.accepts(token)) return;
        if (this.persistenceError) throw this.persistenceError;
        const draft = this.store.getDraft(id);
        const segments = draft.segments.filter(segment => segment.order > draft.reviewedAudioOrder);
        if (!segments.length) return;
        if (!this.transcribeDraft) throw new Error('本地转写未就绪，可手动填写文字或保留原录音。');
        const result = await this.transcribeDraft({ ...draft, segments }, { signal: abort.signal });
        if (abort.signal.aborted || this.closing || !this.store.accepts(token)) return;
        if (!Array.isArray(result.segments) || result.segments.length !== segments.length) throw new Error('转写结果缺少对应的录音片段。');
        const recognized = new Map(result.segments.map(segment => [segment.id || segment.segmentId, segment.text ?? segment.transcript]));
        if (segments.some(segment => typeof recognized.get(segment.id) !== 'string')) throw new Error('转写结果缺少对应的录音片段。');
        const lines = segments.map(segment => recognized.get(segment.id).trim()).filter(value => /[\p{L}\p{N}]/u.test(value));
        const current = this.store.getDraft(id);
        const priorText = current.hasTranscriptOverride ? current.transcript : current.segments.filter(segment => segment.order <= current.reviewedAudioOrder).map(segment => segment.transcript).filter(Boolean).join('\n');
        this.store.stageDraftText(id, [priorText, ...lines].filter(Boolean).join('\n'), token, segments.at(-1).order);
        if (!lines.length) this.textPreviewError = '这段录音未识别到文字。可手动填写文字或保留原录音。';
      } catch (error) {
        if (!abort.signal.aborted && this.store.accepts(token)) this.textPreviewError = safeError(error);
      } finally {
        if (this.textPreview === preview) { this.textPreview = null; this.emitState(); }
      }
    })());
    this.emitState();
    return preview.promise;
  }
  cancelTextPreview() {
    const preview = this.textPreview;
    if (!preview) return;
    this.textPreview = null;
    preview.abort.abort();
    return preview.promise;
  }
  setRetention(options) {
    const id = this.session.sessionId;
    if (![STATES.PAUSED, STATES.ARMING_MANUAL, STATES.RECORDING_MANUAL].includes(this.session.state)) throw new Error('请在录音面板选择保存方式。');
    this.store.setDraftRetention(id, options, this.storeToken);
    if (!options.keepText) { this.cancelTextPreview(); this.textPreviewError = ''; }
    else this.previewText();
    return this.emitState();
  }
  removeStagedAudio(id) {
    try {
      for (const filename of fs.readdirSync(this.tempDir)) {
        if (filename.startsWith(id + '-') && /^\d+\.wav$/u.test(filename.slice(id.length + 1))) fs.rmSync(path.join(this.tempDir, filename), { force: true });
      }
    } catch {
      throw new Error('录音暂存文件仍待清理，请检查本地目录权限后重试。');
    }
  }
  async finish(transcript) {
    if (this.completing) return this.completing;
    if (this.session.state === STATES.SAVED) return this.store.getRecord(this.session.sessionId);
    if (transcript !== undefined && (typeof transcript !== 'string' || transcript.length > 1000000)) throw new Error('文字长度超出本地保存上限。');
    const id = this.session.sessionId; this.session.finish(); this.resetAudioLevel(); this.emitState();
    this.completing = (async () => {
      try {
        await this.waitForStops(); await Promise.allSettled([...this.pending]);
        if (this.persistenceError) throw this.persistenceError;
        const draft = this.store.getDraft(id);
        if (draft?.status === 'draft' && draft.keepText && draft.segments.length && !transcript?.trim()) throw new Error('请填写要保留的笔记正文，或仅保留录音。');
        if (draft && !draft.segments.length && !draft.screenshots.length && !(draft.keepText && (draft.notes?.trim() || draft.transcript?.trim() || transcript?.trim()))) throw new Error('还没有录音、截图或文字，可以继续录音或填写笔记。');
        if (draft && !draft.keepAudio) this.removeStagedAudio(id);
        const record = this.store.complete(id, { transcript }); this.session.markSaved(); this.hideOverlay(); this.emitState(); this.emit('saved', record); await this.refreshTrigger(); return record;
      } catch (error) { this.session.commitFailed(); this.error = safeError(error); this.emitState(); throw error; }
      finally { this.completing = null; }
    })();
    return this.completing;
  }
  async discard() {
    if (this.completing || this.session.state === STATES.COMMITTING) throw new Error('记录正在提交，请稍后在正式记录中删除。');
    const id = this.session.sessionId; if (!id) return this.emitState();
    this.session.discard(); this.cancelTextPreview(); this.resetAudioLevel(); this.emitState(); this.sendRecorder({ command: 'stopAll' });
    this.cancelHoldDelays();
    // Store cancellation is persisted before waiting for native/audio callbacks.
    let cleanupError;
    try { this.store.discard(id); } catch (error) { cleanupError = error; }
    try { await this.waitForStops(); } catch {}
    for (const [key, entry] of this.writers) if (entry.token.sessionId === id) { try { entry.writer.discard(); } catch {} this.writers.delete(key); }
    await Promise.allSettled([...this.pending]);
    for (const filename of fs.readdirSync(this.tempDir)) if (filename.startsWith(id + '.') || filename.startsWith(id + '-')) { try { fs.rmSync(path.join(this.tempDir, filename), { force: true }); } catch (error) { cleanupError = error; } }
    if (cleanupError) { this.error = '部分临时材料尚未清理完成，请重试或重启应用继续清理。'; this.emitState(); throw cleanupError; }
    this.hideOverlay(); this.emit('recordsChanged'); await this.refreshTrigger(); return this.emitState();
  }
  fail(error) {
    if (this.closing || this.closed) return;
    this.error = safeError(error);
    if ([STATES.ARMING_HOLD, STATES.RECORDING_HOLD, STATES.ARMING_MANUAL, STATES.RECORDING_MANUAL].includes(this.session.state)) this.pause();
    this.resetAudioLevel();
    this.emitState();
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.cancelTextPreview();
    this.cancelHoldDelays();
    for (const [name, handler] of Object.entries(this.bridgeHandlers)) this.bridge.removeListener(name, handler);
    this.session.pause(); this.resetAudioLevel(); this.sendRecorder({ command: 'stopAll' });
    this.closePromise = (async () => {
      try { await this.bridge.request('configure', { enabled: false }); } catch {}
      try { await this.waitForStops(); } catch {}
      await Promise.allSettled([...this.pending]);
      for (const entry of this.writers.values()) { try { entry.writer.finish(); } catch {} }
      this.writers.clear();
      for (const stop of this.stops.values()) stop.resolve(); this.stops.clear();
      this.closed = true; this.removeAllListeners();
    })();
    return this.closePromise;
  }
}
module.exports = { CaptureController };
