'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const hasSpeechText = value => typeof value === 'string' && /[\p{L}\p{N}]/u.test(value);

// Owns only temporary capture drafts explicitly brought into a chat. Saving a
// conversation never completes its recording draft or promotes its audio files.
class ChatCapture {
  constructor({ store, controller, asr, chats, analyzeVoiceActivity, readContext = async () => ({}), onVoice = () => {} }) {
    Object.assign(this, { store, controller, asr, chats, analyzeVoiceActivity, readContext, onVoice });
    this.owners = new Map(); this.jobs = new Map(); this.starts = new Map(); this.voiceStates = new Map(); this.closed = false;
    this.recordings = new Map(); this.retryJobs = new Map(); this.cancelling = new Map();
    this.persistentOwners = new Set(); this.releasing = new Map(); this.recoveryErrors = [];
    this.ownerFile = path.join(store.rootDir, 'chat-audio-owners.json');
    this.recoverOwnership();
  }
  ownershipFile() {
    const filename = this.store.safePath(this.ownerFile);
    if (fs.existsSync(filename) && (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink())) throw new Error('聊天临时录音清理记录不是普通文件。');
    return filename;
  }
  persistOwnership() {
    const filename = this.ownershipFile();
    if (!this.persistentOwners.size) { if (fs.existsSync(filename)) fs.unlinkSync(filename); return; }
    const staging = this.store.safePath(filename + '.' + randomUUID() + '.part');
    try {
      fs.writeFileSync(staging, JSON.stringify({ schemaVersion: 1, draftIds: [...this.persistentOwners] }), { flag: 'wx' });
      fs.renameSync(staging, filename);
    } finally { if (fs.existsSync(staging)) fs.unlinkSync(staging); }
  }
  recoverOwnership() {
    const filename = this.ownershipFile();
    if (!fs.existsSync(filename)) return;
    let marker;
    try {
      if (fs.statSync(filename).size > 65536) throw new Error();
      marker = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (marker?.schemaVersion !== 1 || !Array.isArray(marker.draftIds) || marker.draftIds.length > 128 || marker.draftIds.some(id => typeof id !== 'string' || !ID.test(id))) throw new Error();
    } catch { throw new Error('聊天临时录音清理记录无法读取；原录音文件仍保留在本机。'); }
    for (const id of marker.draftIds) {
      try {
        const draft = this.store.getDraft(id);
        if (draft?.status === 'draft') this.store.discard(id);
        else if (draft?.status === 'committing' || this.store.row?.(id)?.status === 'delete_pending') this.persistentOwners.add(id);
      } catch {
        this.persistentOwners.add(id);
        this.recoveryErrors.push('上次临时聊天的录音尚未清理，请检查本地存储权限后重启重试。');
      }
    }
    this.persistOwnership();
  }
  own(chatId, draftId) {
    if (typeof draftId !== 'string' || !ID.test(draftId)) throw new Error('临时录音标识无效。');
    if (!this.persistentOwners.has(draftId)) {
      this.persistentOwners.add(draftId);
      try { this.persistOwnership(); } catch (error) { this.persistentOwners.delete(draftId); throw error; }
    }
    // Persist only IDs before exposing ownership; no audio, screenshot, or text is copied.
    this.owners.set(chatId, draftId);
  }
  voiceInfo(attempt) { return attempt ? { intent: attempt.intent||'input', token: attempt.token, draftId: attempt.draftId || null, segmentId: attempt.segmentId || null } : { intent: 'candidate' }; }
  voice(id, status, message = '', details = this.voiceInfo(this.recordings.get(id))) { if (!this.closed && this.chats.get(id)) { const value = { id, status, message, ...details }; this.voiceStates.set(id, value); this.onVoice(value); } }
  observeSession(session) {
    for (const [id, draftId] of this.owners) {
      if (draftId !== session.id) continue;
      if (this.cancelling.has(id)) continue;
      const attempt = this.recordings.get(id);
      if (attempt && !attempt.cancelled) { attempt.draftId = draftId; if (session.segmentId) attempt.segmentId = session.segmentId; }
      if (session.error) this.voice(id, 'error', session.error);
      else if (session.state === 'preparing') this.voice(id, 'preparing');
      else if (session.state === 'recording') this.voice(id, 'recording');
      else if (session.state === 'paused' && this.voiceStates.get(id)?.status === 'recording') this.voice(id, 'paused');
    }
  }
  async fromCapture() {
    if (this.closed) throw new Error('聊天正在关闭。');
    const active = this.controller.snapshot();
    if (!active.active) return this.chats.create();
    if (active.state === 'processing') throw new Error('录音正在保存，请稍后再问 AI。');
    const existing = [...this.owners].find(([chatId, draftId]) => draftId === active.id && this.chats.get(chatId));
    this.controller.pause(); await this.controller.cancelTextPreview?.(); await this.controller.waitForStops();
    await Promise.allSettled([...(this.controller.pending || [])]);
    const draft = this.store.getDraft(active.id);
    if (!draft || draft.status !== 'draft') throw new Error('这次录音已结束。');
    if (existing) {
      const attempt = this.recordings.get(existing[0]);
      const segments = draft.segments.filter(item => attempt ? !attempt.baseline.has(item.id) : !item.transcript);
      this.transcribe(existing[0], segments.map(item => item.id), attempt ? this.voiceInfo(attempt) : {}).catch(() => {});
      return this.chats.get(existing[0]);
    }
    const context = await this.readContext(draft.id, draft.source).catch(() => ({}));
    if (this.closed || this.store.getDraft(draft.id)?.status !== 'draft' || this.controller.snapshot().state !== 'paused' || this.controller.snapshot().id !== draft.id) throw new Error('这次录音已结束。');
    const images = draft.screenshots.slice(0, 1).map(image => {
      const filename = this.store.safePath(image.path);
      if (fs.statSync(filename).size > 8 * 1024 * 1024) throw new Error('来源截图过大，请在聊天中选择较小的图片。');
      return { id: image.id, mimeType: 'image/png', base64: fs.readFileSync(filename).toString('base64') };
    });
    const chat = this.chats.create({ source: { ...draft.source, url: context.url || draft.source?.url || '' }, selectedText: context.selectedText || '', images, audioDraftId: draft.id });
    this.own(chat.id, draft.id);
    this.transcribe(chat.id, draft.segments.map(item => item.id)).catch(() => {});
    return chat;
  }
  async record(id) {
    if (this.closed || !this.chats.get(id)) throw new Error('聊天已结束。');
    if (this.starts.size) throw new Error('正在准备麦克风，请稍候。');
    if (this.jobs.has(id)) throw new Error('正在转写上一段录音，请稍候。');
    if (this.cancelling.has(id)) throw new Error('正在取消上一段录音，请稍候。');
    const active = this.controller.snapshot();
    const owned = this.owners.get(id);
    if (active.active && active.id !== owned) throw new Error('请先完成当前录音，或从录音面板进入聊天。');
    if (active.active && ['preparing', 'recording'].includes(active.state)) {
      if (!this.recordings.has(id)) {
        this.recordings.set(id, { token: randomUUID(), draftId: owned, segmentId: active.segmentId || null, baseline: new Set((this.store.getDraft(owned)?.segments || []).map(item => item.id)), cancelled: false });
        this.voice(id, active.state);
      }
      return this.stopRecording(id);
    }
    if (this.recordings.has(id)) return this.retry(id);
    const attempt = { token: randomUUID(), draftId: owned || null, segmentId: null, baseline: new Set((owned ? this.store.getDraft(owned)?.segments || [] : []).map(item => item.id)), cancelled: false };
    this.recordings.set(id, attempt); this.voice(id, 'preparing');
    if (active.active) {
      try { this.chats.update(id, { audioDraftId: owned }); this.controller.continueRecording(); }
      catch (error) { this.recordings.delete(id); this.voice(id, 'error', error.message, this.voiceInfo(attempt)); throw error; }
    }
    else {
      let complete; const start = { cancelled: false, done: new Promise(resolve => { complete = resolve; }) };
      this.starts.set(id, start);
      let newDraftId;
      try {
        await this.controller.startManual({ keepAudio: true });
        const draftId = this.controller.snapshot().id;
        newDraftId = draftId;
        if (this.closed || start.cancelled || !this.chats.get(id)) {
          if (this.store.getDraft(draftId)?.status === 'draft') await this.controller.discard();
          if (this.recordings.get(id) === attempt) this.recordings.delete(id);
          return { cancelled: true };
        }
        this.own(id, draftId); this.chats.update(id, { audioDraftId: draftId });
      } catch (error) {
        if (newDraftId && this.controller.snapshot().id === newDraftId && this.store.getDraft(newDraftId)?.status === 'draft') {
          try {
            await this.controller.discard(); this.owners.delete(id);
            this.persistentOwners.delete(newDraftId); this.persistOwnership();
          } catch { this.voice(id, 'error', '录音已请求停止，部分临时材料清理失败，请返回录音面板重试。'); }
        }
        if (this.recordings.get(id) === attempt) this.recordings.delete(id);
        if (attempt.cancelled) return { cancelled: true };
        this.voice(id, 'error', error.message, this.voiceInfo(attempt));
        throw error;
      } finally { if (this.starts.get(id) === start) this.starts.delete(id); complete(); }
    }
    const recording = this.controller.snapshot(); attempt.draftId = recording.id; attempt.segmentId = recording.segmentId || null;
    const state = recording.state === 'preparing' ? 'preparing' : 'recording'; this.voice(id, state); return { state, ...this.voiceInfo(attempt) };
  }
  async stopRecording(id, token) {
    const attempt = this.recordings.get(id);
    if (!attempt) {
      const last = this.voiceStates.get(id);
      return { state: last?.status || 'idle', stale: Boolean(token && token !== last?.token), intent: last?.intent || 'candidate', token: last?.token, draftId: last?.draftId, segmentId: last?.segmentId };
    }
    if (token && token !== attempt.token) return { state: this.voiceStates.get(id)?.status || 'idle', stale: true, ...this.voiceInfo(attempt) };
    if (attempt.stopping) return attempt.stopping;
    if (this.jobs.has(id)) return { state: 'transcribing', ...this.voiceInfo(attempt) };
    attempt.stopping = (async () => {
      await this.starts.get(id)?.done;
      const active = this.controller.snapshot();
      if (active.id !== attempt.draftId || this.owners.get(id) !== attempt.draftId) return { state: 'idle', ...this.voiceInfo(attempt) };
      if (['preparing', 'recording'].includes(active.state)) this.controller.pause();
      await this.controller.waitForStops(); await Promise.allSettled([...(this.controller.pending || [])]);
      if (attempt.cancelled || this.recordings.get(id) !== attempt || this.closed || !this.chats.get(id)) return { state: 'cancelled', ...this.voiceInfo(attempt) };
      const draft = this.store.getDraft(attempt.draftId), ids = (draft?.segments || []).filter(item => !attempt.baseline.has(item.id)).map(item => item.id);
      this.transcribe(id, ids, this.voiceInfo(attempt)).catch(() => {});
      return { state: ids.length ? 'transcribing' : 'empty', ...this.voiceInfo(attempt) };
    })();
    try { return await attempt.stopping; } finally { attempt.stopping = null; }
  }
  retry(id) {
    const retry = this.retryJobs.get(id);
    if (!retry || this.closed || !this.chats.get(id)) throw new Error('当前没有待重试的录音。');
    this.transcribe(id, retry.segmentIds, retry.details).catch(() => {});
    return { state: 'transcribing', ...retry.details };
  }
  async cancelRecording(id, token) {
    const existing = this.cancelling.get(id); if (existing && (!token || existing.token === token)) return existing.promise;
    let attempt = this.recordings.get(id);
    if(!attempt){
      const retry=this.retryJobs.get(id),draftId=this.owners.get(id),draft=draftId&&this.store.getDraft(draftId);
      if(retry?.details?.intent==='candidate' && this.voiceStates.get(id)?.status==='error' && draft?.status==='draft' && (!token || token===retry.details.token)){
        const failed=new Set(retry.segmentIds);attempt={intent:'candidate',token:retry.details.token,draftId,segmentId:retry.details.segmentId||null,baseline:new Set(draft.segments.filter(segment=>!failed.has(segment.id)).map(segment=>segment.id)),cancelled:false};
      }
    }
    if (!attempt || token && token !== attempt.token) return { cancelled: false };
    attempt.cancelled = true; this.recordings.delete(id); this.retryJobs.delete(id);
    const details = this.voiceInfo(attempt), job = this.jobs.get(id); job?.abort.abort();
    const starting = this.starts.get(id); if (starting) starting.cancelled = true;
    this.voice(id, 'cancelled', '', details);
    const pending = { token: attempt.token, promise: null }; this.cancelling.set(id, pending);
    pending.promise = (async () => {
      await starting?.done;
      const active = this.controller.snapshot();
      if (active.id === attempt.draftId && ['preparing', 'recording'].includes(active.state)) this.controller.pause();
      await this.controller.waitForStops(); await Promise.allSettled([...(this.controller.pending || [])]); await job?.promise;
      const draft = attempt.draftId && this.store.getDraft(attempt.draftId), writeToken = draft && this.store.draftToken(draft.id);
      if (writeToken && this.owners.get(id) === draft.id) {
        const removable = draft.segments.filter(item => !attempt.baseline.has(item.id) && !hasSpeechText(item.transcript));
        if (removable.length) this.store.removeSilentDraftAudio(draft.id, removable.map(item => item.id), writeToken);
        if (this.chats.get(id) && !this.store.getDraft(draft.id)?.segments.length) this.chats.update(id, { audioDraftId: null });
        this.controller.emitState();
      }
      return { cancelled: true, ...details };
    })();
    try { return await pending.promise; } finally { if (this.cancelling.get(id) === pending) this.cancelling.delete(id); }
  }
  chatAudioLevel(value) {
    const active = this.controller.snapshot();
    if (this.closed || active.state !== 'recording' || value?.id !== active.id || value.segmentId !== active.segmentId || !Number.isFinite(value.level) || !Number.isFinite(value.peak) || value.level < 0 || value.level > 1 || value.peak < 0 || value.peak > 1) return null;
    for (const [id, attempt] of this.recordings) if (!attempt.cancelled && attempt.draftId === active.id && attempt.segmentId === active.segmentId && this.owners.get(id) === active.id && this.chats.get(id)) return { id, ...this.voiceInfo(attempt), level: value.level, peak: value.peak };
    return null;
  }
  async transcribe(id, segmentIds, { intent = 'candidate', token: voiceToken = randomUUID(), draftId: voiceDraftId, segmentId: voiceSegmentId } = {}) {
    const previous = this.jobs.get(id); if (previous) return previous.promise;
    const draftId = this.owners.get(id), draft = draftId && this.store.getDraft(draftId);
    const token = draft && this.store.draftToken(draftId);
    if (!draft || !token || !this.chats.get(id)) return;
    const attempt = intent === 'input' ? this.recordings.get(id) : null;
    if (intent === 'input' && (!attempt || attempt.cancelled || attempt.token !== voiceToken)) return;
    const details = { intent, token: voiceToken, draftId: voiceDraftId || draftId, segmentId: voiceSegmentId || null };
    const segments = draft.segments.filter(segment => segmentIds.includes(segment.id));
    if (!segments.length) { if (!draft.segments.length) this.chats.update(id, { audioDraftId: null }); if (attempt) this.recordings.delete(id); this.retryJobs.delete(id); this.voice(id, 'empty', '', details); return; }
    const abort = new AbortController(); const job = { abort, promise: null };
    this.jobs.set(id, job); this.retryJobs.set(id, { segmentIds: [...segmentIds], details }); this.voice(id, 'transcribing', '', details);
    const valid = () => !this.closed && !abort.signal.aborted && this.chats.get(id) && this.store.accepts(token) && this.owners.get(id) === draftId && this.controller.snapshot().state === 'paused' && (!attempt || !attempt.cancelled && this.recordings.get(id) === attempt);
    job.promise = (async () => {
      try {
        const activity = await this.analyzeVoiceActivity(segments, { signal: abort.signal });
        if (!valid()) return;
        let result = { text: '', segments: [] };
        if (activity.decision !== 'empty') {
          if (!this.asr.capabilities().available) throw new Error('本地语音转写尚未就绪，录音仍临时保留，可重试或手动输入。');
          result = await this.asr.transcribe({ ...draft, segments }, { signal: abort.signal });
        }
        if (!valid()) return;
        const transcripts = (result.segments || []).filter(segment => segmentIds.includes(segment.id || segment.segmentId) && hasSpeechText(segment.transcript ?? segment.text));
        const recognized = transcripts.map(segment => (segment.transcript ?? segment.text).trim()).join('\n');
        if (recognized) {
          this.store.setTranscript(draftId, transcripts);
          if (intent === 'candidate') this.chats.update(id, { candidate: recognized });
          if (attempt) this.recordings.delete(id); this.retryJobs.delete(id);
          this.voice(id, 'ready', '', { ...details, ...(intent === 'input' ? { text: recognized } : {}) });
        } else {
          // Successful recognition with only punctuation/symbols is empty.
          // Keep prior speech and edits; cleanup remains token-gated draft audio.
          const previous = this.chats.get(id).candidate;
          const currentDraft = this.store.getDraft(draftId);
          const candidate = hasSpeechText(previous) ? previous : currentDraft.segments.filter(segment => hasSpeechText(segment.transcript)).map(segment => segment.transcript).join('\n');
          const emptySegments = currentDraft.segments.filter(segment => segmentIds.includes(segment.id) && !hasSpeechText(segment.transcript));
          if (emptySegments.length) this.store.removeSilentDraftAudio(draftId, emptySegments.map(segment => segment.id), token);
          this.chats.update(id, { ...(intent === 'candidate' ? { candidate } : {}), ...(this.store.getDraft(draftId)?.segments.length ? {} : { audioDraftId: null }) }); this.controller.emitState();
          if (attempt) this.recordings.delete(id); this.retryJobs.delete(id); this.voice(id, 'empty', '', details);
        }
      } catch (error) {
        if (valid()) this.voice(id, 'error', error?.message || '本地转写未完成，录音仍临时保留。', details);
      } finally { if (this.jobs.get(id) === job) this.jobs.delete(id); }
    })();
    return job.promise;
  }
  async release(id) {
    const attempt = this.recordings.get(id); if (attempt) attempt.cancelled = true;
    this.recordings.delete(id); this.retryJobs.delete(id);
    const starting = this.starts.get(id);
    if (starting) { starting.cancelled = true; await starting.done; }
    const existing = this.releasing.get(id); if (existing?.promise) return existing.promise;
    const draftId = this.owners.get(id) || existing?.draftId;
    if (draftId && this.controller.snapshot().id === draftId && this.controller.snapshot().state === 'processing') throw new Error('录音正在保存，请稍后关闭聊天。');
    this.owners.delete(id); // Revoke late recognizer callbacks before awaiting it.
    if (!draftId) return;
    const release = { draftId, promise: null }; this.releasing.set(id, release);
    release.promise = (async () => {
      const job = this.jobs.get(id); job?.abort.abort(); await job?.promise;
      await this.cancelling.get(id)?.promise;
      const active = this.controller.snapshot();
      if (active.id === draftId && active.active) await this.controller.discard();
      else if (this.store.getDraft(draftId)?.status === 'draft') this.store.discard(draftId);
      if (this.store.getDraft(draftId)?.status === 'committing' || this.store.row?.(draftId)?.status === 'delete_pending') throw new Error('临时录音仍在保存或清理，请稍后关闭聊天。');
      // Retain the persistent ID until cleanup succeeds, so a crash can retry it.
      this.persistentOwners.delete(draftId);
      try { this.persistOwnership(); } catch (error) { this.persistentOwners.add(draftId); throw error; }
      this.releasing.delete(id);
      this.voiceStates.delete(id);
      if (this.chats.get(id)) this.chats.update(id, { audioDraftId: null });
    })();
    try { return await release.promise; }
    finally { if (this.releasing.get(id) === release) release.promise = null; }
  }
  async shutdown() {
    this.closed = true;
    for (const start of this.starts.values()) start.cancelled = true;
    await Promise.allSettled([...this.starts.values()].map(start => start.done));
    for (const job of this.jobs.values()) job.abort.abort();
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
    const failures = [];
    for (const id of new Set([...this.owners.keys(), ...this.releasing.keys()])) try { await this.release(id); } catch (error) { failures.push(error); }
    if (failures.length) throw failures[0];
  }
}
module.exports = { ChatCapture };
