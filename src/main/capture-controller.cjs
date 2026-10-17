'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { RecordingSession, STATES } = require('../core/recording-session.cjs');
const { WavWriter, wavHeader } = require('./wav-writer.cjs');

const safeError = error => String(error?.message || '本地操作未完成。').slice(0, 250);
class CaptureController extends EventEmitter {
  constructor({ store, bridge, settings, sendRecorder, showOverlay, hideOverlay, disableGlobalInput = false }) {
    super(); Object.assign(this, { store, bridge, settings, sendRecorder, showOverlay, hideOverlay, disableGlobalInput });
    this.session = new RecordingSession(); this.writers = new Map(); this.stops = new Map(); this.pending = new Set(); this.holdDelays = new Set(); this.error = ''; this.captureStatus = ''; this.persistenceError = null;
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
      holdStart: data => { if (!this.closing) this.startHold(data.source).catch(error => this.fail(error)); },
      holdEnd: () => { if (!this.closing && [STATES.ARMING_HOLD, STATES.RECORDING_HOLD].includes(this.session.state)) this.pause(true); },
      inputFault: data => this.fail(new Error(data.message || '输入监听异常。')),
      bridgeFault: data => this.fail(new Error(data.message || 'Windows 模块已断开。')),
    };
    for (const [name, handler] of Object.entries(this.bridgeHandlers)) bridge.on(name, handler);
  }
  emitState() { const snapshot = this.snapshot(); if (!this.closing && !this.closed) this.emit('session', snapshot); return snapshot; }
  snapshot() {
    if (this.closing || this.closed) return { id: null, state: 'idle', rawState: 'CLOSED', active: false, mode: 'manual', elapsedMs: 0, error: '' };
    const raw = this.session.snapshot();
    const draft = raw.sessionId ? this.store.getDraft(raw.sessionId) : null;
    const states = { IDLE: 'idle', ARMING_HOLD: 'preparing', RECORDING_HOLD: 'recording', PAUSED: 'paused', ARMING_MANUAL: 'preparing', RECORDING_MANUAL: 'recording', COMMITTING: 'processing', SAVED: 'saved', DISCARDED: 'idle' };
    return { id: raw.sessionId, state: states[raw.state], rawState: raw.state, mode: [STATES.ARMING_HOLD, STATES.RECORDING_HOLD].includes(raw.state) ? 'hold' : 'manual', triggerKey: raw.source?.trigger || 'right-button', elapsedMs: draft?.durationMs || 0, segmentCount: draft?.segments.length || 0, context: draft?.source || raw.source, parentId: draft?.parentId || null, topicIds: draft?.topics?.map(item => item.id) || [], captureStatus: this.captureStatus, error: this.error, active: Boolean(draft), cleanupPending: this.store.listPendingCleanup().length > 0 };
  }
  async refreshTrigger() {
    if (this.closing || this.closed) return;
    const active = ![STATES.IDLE, STATES.SAVED, STATES.DISCARDED].includes(this.session.state);
    const configuration = this.settings.public();
    try {
      const result = await this.bridge.request('configure', { enabled: configuration.inputEnabled && !active && !this.disableGlobalInput, previewDelayMs: configuration.previewDelayMs || 0, thresholdMs: configuration.thresholdMs, keyboardTrigger: configuration.keyboardTrigger || 'none', excludedApps: [...configuration.excludedApps, 'InMoment', 'electron'] });
      if (!this.closing) this.emit('inputStatus', { enabled: Boolean(result?.enabled), available: result?.hookAvailable !== false, error: '' });
      return result;
    } catch {
      if (!this.closing) { this.error = '右键监听未能启用，请退出应用后重新打开；仍失败时可先使用手动录音入口。'; this.emit('inputStatus', { enabled: false, available: false, error: this.error }); this.emitState(); }
      return { enabled: false, hookAvailable: false };
    }
  }
  watch(promise) { this.pending.add(promise); promise.finally(() => this.pending.delete(promise)).catch(() => {}); return promise; }
  createDraft(source, extra = {}) {
    const initial = this.session.holdThresholdReached(source);
    this.store.createDraft({ id: initial.sessionId, source, createdAt: initial.createdAt, ...extra });
    this.storeToken = this.store.draftToken(initial.sessionId); this.error = ''; this.persistenceError = null; this.captureStatus = 'pending';
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
  async startManual() {
    if (this.closing || this.closed) throw new Error('应用正在退出。');
    if (![STATES.IDLE, STATES.SAVED, STATES.DISCARDED].includes(this.session.state)) { this.showOverlay(); return this.emitState(); }
    this.session.rightDown(); this.createDraft({ processName: 'InMoment', title: '手动辅助录音（未自动采集来源）' });
    this.session.rightUp(); this.captureStatus = 'not-requested'; this.showOverlay(); return this.continueRecording();
  }
  async startThought(parentId) {
    if (this.closing || this.closed) throw new Error('应用正在退出。');
    if (![STATES.IDLE, STATES.SAVED, STATES.DISCARDED].includes(this.session.state)) throw new Error('请先完成或删除当前记录，再接着旧灵感思考。');
    const parent = this.store.getRecord(parentId); if (!parent) throw new Error('原灵感不存在。');
    // This explicit UI action starts a fresh manual segment. Never reuse an old screenshot as a new capture.
    this.session.rightDown();
    this.createDraft({ processName: 'InMoment', title: '接着想 · 手动录音（本次未自动采集来源）' }, { parentId, topicIds: (parent.topics || []).map(item => item.id), topicsManual: false });
    this.session.rightUp(); this.captureStatus = 'not-requested'; this.showOverlay(); return this.continueRecording();
  }
  restoreDraft(id) {
    if (this.session.sessionId === id && this.store.getDraft(id)) return this.emitState();
    if (![STATES.IDLE, STATES.SAVED, STATES.DISCARDED].includes(this.session.state)) throw new Error('请先完成或删除当前正在记录的草稿。');
    const draft = this.store.getDraft(id); if (!draft) throw new Error('草稿不存在。');
    this.session = new RecordingSession(); this.session.state = STATES.PAUSED; this.session.sessionId = id; this.session.epoch += 1;
    this.session.source = draft.source; this.session.createdAt = draft.createdAt; this.session.segmentCount = Math.max(0, ...draft.segments.map(item => item.order));
    this.storeToken = this.store.draftToken(id); this.error = ''; this.persistenceError = null; this.captureStatus = draft.screenshots.length ? 'captured' : 'unavailable';
    this.refreshTrigger(); return this.emitState();
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
        if (fs.existsSync(filename)) this.store.addScreenshot(id, fs.readFileSync(filename), { capturedAt: result.capturedAt, width: result.width, height: result.height, method: result.method }, storeToken);
        this.captureStatus = 'captured';
      } catch { if (this.session.accepts(token)) this.captureStatus = 'unavailable'; }
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
    this.error = ''; this.emitState(); return { allowed: true };
  }
  audioChunk({ token, pcm }) {
    if (this.closed) return { accepted: false };
    const entry = this.writers.get(token?.segmentId);
    if (!entry || !this.session.accepts(entry.token) || token.sessionId !== entry.token.sessionId || token.epoch !== entry.token.epoch) return { accepted: false };
    entry.writer.append(new Uint8Array(pcm)); return { accepted: true };
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
    if (['device-ended', 'replace'].includes(reason) && [STATES.RECORDING_HOLD, STATES.RECORDING_MANUAL].includes(this.session.state)) { this.session.pause(); this.error = '音频设备已停止，记录已暂停。'; }
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
      if (this.persistenceError) this.error = this.persistenceError.message;
      this.showOverlay(); this.emitState();
    }
    return { accepted: true };
  }
  pause(fromRightRelease = false) {
    if (![STATES.ARMING_HOLD, STATES.RECORDING_HOLD, STATES.ARMING_MANUAL, STATES.RECORDING_MANUAL].includes(this.session.state)) return this.emitState();
    const result = fromRightRelease ? this.session.rightUp() : this.session.pause();
    this.cancelHoldDelays();
    if (!this.captureInFlight && this.captureStatus === 'pending') this.captureStatus = 'cancelled-before-capture';
    for (const action of result.actions) if (['stopRecording', 'cancelRecordingStart'].includes(action.type)) this.sendRecorder({ command: 'stop', token: action.token, reason: 'pause' });
    this.showOverlay(); return this.emitState();
  }
  continueRecording() {
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
  async finish() {
    if (this.completing) return this.completing;
    if (this.session.state === STATES.SAVED) return this.store.getRecord(this.session.sessionId);
    const id = this.session.sessionId; this.session.finish(); this.emitState();
    this.completing = (async () => {
      try {
        await this.waitForStops(); await Promise.allSettled([...this.pending]);
        if (this.persistenceError) throw this.persistenceError;
        const draft = this.store.getDraft(id);
        if (draft && !draft.segments.length && !draft.screenshots.length && !draft.notes?.trim()) throw new Error('还没有录音、截图或文字；可以继续录音或删除这次空记录。');
        const record = this.store.complete(id); this.session.markSaved(); this.hideOverlay(); this.emitState(); this.emit('saved', record); await this.refreshTrigger(); return record;
      } catch (error) { this.session.commitFailed(); this.error = safeError(error); this.emitState(); throw error; }
      finally { this.completing = null; }
    })();
    return this.completing;
  }
  async discard() {
    if (this.completing || this.session.state === STATES.COMMITTING) throw new Error('记录正在提交，请稍后在正式记录中删除。');
    const id = this.session.sessionId; if (!id) return this.emitState();
    this.session.discard(); this.emitState(); this.sendRecorder({ command: 'stopAll' });
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
    this.emitState();
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.cancelHoldDelays();
    for (const [name, handler] of Object.entries(this.bridgeHandlers)) this.bridge.removeListener(name, handler);
    this.session.pause(); this.sendRecorder({ command: 'stopAll' });
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
