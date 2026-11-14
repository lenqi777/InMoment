'use strict';
const $ = (selector) => document.querySelector(selector);
const bridge = window.inmoment;
let session = null;
let timerBase = 0;
let timerStarted = null;
let busy = false;
let progressFrame = 0;
let progressStarted = 0;
let progressThreshold = 550;
let previewPhase = null;
let previewTriggerKey = '右键';
let topics = [];
let openingChat = false;
let hintDraftId = null;
let hintTimer = 0;
let hintIntro = false;
let hintHovered = false;
let hintFocused = false;
let brandDraftId = null;
let brandWasPaused = false;
let brandState = 'logo';
let audioHistory = Array(19).fill(0);
let audioSegment = null;
let lastAudioAt = 0;
let draftTextEdited = false;
const capsuleBars = Array.from(document.querySelectorAll('#capsule-waveform>span'));
const brandMorph = window.InMomentBrandMorph.mount($('#capsule-logo'));
brandMorph.setState('logo', { immediate: true });
function alignBrandCorner() { document.documentElement.style.setProperty('--capture-border', window.getComputedStyle($('.capture-panel')).borderLeftWidth); }
alignBrandCorner();

function format(ms) { const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }
function triggerLabel(value) { return ['F8', 'F9', 'F10'].includes(value) ? value : '右键'; }
function hasActiveSession(next = session) { const state = next?.state || next?.status; return Boolean(next && next.active !== false && ['preparing', 'recording', 'paused', 'processing', 'error'].includes(state)); }
function fromScreenshot(next = session) { return next?.triggerKey === 'region-screenshot'; }
function canChooseTopics() { return hasActiveSession() && ['preparing', 'recording', 'paused'].includes(session.state || session.status); }
function syncHint() {
  const visible = document.body.dataset.mode === 'capsule' && !fromScreenshot() && !openingChat && (hintIntro || hintHovered || hintFocused);
  $('#capsule-hint').classList.toggle('is-visible', visible); $('#capsule-hint').classList.toggle('handoff-hidden', openingChat);
  $('#capsule-hint').setAttribute('aria-hidden', String(!visible));
}
function stopHint() { if (hintTimer) clearTimeout(hintTimer); hintTimer = 0; hintIntro = false; syncHint(); }
function beginHint(id) {
  if (hintDraftId === id) return;
  stopHint(); hintDraftId = id; hintIntro = true;
  hintTimer = setTimeout(() => { if (hintDraftId !== id) return; hintTimer = 0; hintIntro = false; syncHint(); }, 2200);
}
function setMode(mode) {
  document.body.className = `mode-${mode}`;
  document.body.dataset.mode = mode;
  document.body.dataset.draggable = String(!openingChat && (mode === 'card' || (mode === 'capsule' && fromScreenshot())));
  $('#card-content').setAttribute('aria-hidden', String(mode !== 'card'));
  $('#hold-progress').setAttribute('aria-hidden', String(mode !== 'progress'));
  $('#recording-capsule').setAttribute('aria-hidden', String(!['capsule', 'card'].includes(mode)));
  $('#card-content').inert = mode !== 'card';
  $('#recording-capsule').inert = !['capsule', 'card'].includes(mode);
  syncCapsule();
  syncHint();
  if (mode === 'card') measureCard();
}
function syncCapsule() {
  const state = session?.state || session?.status;
  const ready = hasActiveSession() && !session?.committingText && ['preparing', 'recording', 'paused'].includes(state);
  $('#capsule-logo').disabled = busy || openingChat || !ready || !['capsule', 'card'].includes(document.body.dataset.mode);
  const actionLabel = state === 'paused' ? '继续录音' : '暂停录音';
  $('#capsule-logo').setAttribute('aria-label', actionLabel); $('#capsule-logo').setAttribute('title', actionLabel);
  if (fromScreenshot()) $('#capsule-logo').removeAttribute('aria-describedby');
  else $('#capsule-logo').setAttribute('aria-describedby', 'capsule-hint');
  const trigger = triggerLabel(session?.triggerKey || previewTriggerKey);
  const hold = !fromScreenshot() && (session?.mode || session?.triggerMode) === 'hold';
  const recordingHint = fromScreenshot() ? '正在录音，点击暂停' : hold ? `正在录音，松开 ${trigger} 自动暂停，向上滚动问 AI` : '正在录音，点击暂停，向上滚动问 AI';
  $('#recording-capsule').setAttribute('aria-label', openingChat ? '正在打开聊天' : document.body.dataset.mode === 'progress' ? `长按${trigger}以开始录音` : state === 'paused' ? `录音已暂停，时长 ${$('#capsule-timer').textContent}` : state === 'processing' ? '正在保存记录' : state === 'preparing' ? hold ? `正在准备麦克风，保持按住 ${trigger}，松开自动暂停` : '正在准备麦克风，点击暂停' : recordingHint);
}
function syncBrand(next) {
  const state = next.state || next.status, hold = (next.mode || next.triggerMode) === 'hold';
  if (next.id !== brandDraftId) { brandDraftId = next.id; brandWasPaused = false; brandState = 'logo'; brandMorph.setState('logo', { immediate: true }); }
  if (state === 'paused') brandWasPaused = true;
  const target = state === 'paused' ? 'play' : ['preparing', 'recording'].includes(state) ? brandWasPaused || !(hold || fromScreenshot(next)) ? 'pause' : 'logo' : brandState;
  if (target !== brandState) { brandState = target; brandMorph.setState(target); }
}
function paintAudio(energy = 0) {
  document.documentElement.style.setProperty('--audio-energy', energy.toFixed(3));
  $('#capsule-waveform').setAttribute('data-level', energy.toFixed(3));
  capsuleBars.forEach((bar, index) => { bar.style.height = `${(3 + audioHistory[index] * 23).toFixed(2)}px`; });
}
function resetAudio() { audioHistory = Array(19).fill(0); audioSegment = null; lastAudioAt = 0; paintAudio(); }
function audioLevel(event) {
  if (!hasActiveSession() || (session.state || session.status) !== 'recording' || openingChat || event.id !== session.id) return;
  if (session.segmentId && event.segmentId !== session.segmentId) return;
  if (typeof event.level !== 'number' || !Number.isFinite(event.level) || typeof event.peak !== 'number' || !Number.isFinite(event.peak)) return;
  if (audioSegment && audioSegment !== event.segmentId) audioHistory = Array(19).fill(0);
  audioSegment = event.segmentId; lastAudioAt = Date.now();
  const level = Math.max(0, Math.min(1, event.level));
  audioHistory.push(level); audioHistory.shift(); paintAudio(Math.max(level, Math.max(0, Math.min(1, event.peak)) * .45));
}
function measureCard() {
  const card = $('#card-content'), oldWidth = card.style.width;
  // Measure the final reading width while the surface is still morphing from the pill.
  card.style.width = `${Math.min(260, (Number(window.innerWidth) || 400) - 18) - 2}px`;
  const height = Math.min(402, (Number(window.innerHeight) || 440) - 38, Math.max(112, card.scrollHeight + 46));
  card.style.width = oldWidth || ''; document.documentElement.style.setProperty('--card-height', `${height}px`);
}
function renderTopics() {
  const ids = session?.topicIds || [];
  const names = topics.filter(topic => ids.includes(topic.id)).map(topic => topic.name);
  $('#draft-topics-label').textContent = `分组：${names.join('、') || '未分类'}`;
  const choices = $('#draft-topic-options'); choices.replaceChildren();
  if (!topics.length) { const hint = document.createElement('p'); hint.textContent = '还没有其他分组，可以直接保存到未分类。'; choices.append(hint); }
  for (const topic of topics) {
    const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = ids.includes(topic.id); checkbox.disabled = busy || !canChooseTopics();
    checkbox.addEventListener('change', () => saveTopics(topic.id, checkbox.checked));
    const text = document.createElement('span'); text.textContent = topic.name; label.append(checkbox); label.append(text); choices.append(label);
  }
}
function stopProgress() { if (progressFrame) cancelAnimationFrame(progressFrame); progressFrame = 0; }
function fillProgress(value) { const ratio = Math.max(0, Math.min(1, value)); document.documentElement.style.setProperty('--hold-progress', String(ratio)); $('#hold-progress').setAttribute('aria-valuenow', String(Math.round(ratio * 100))); }
function startProgress(event) {
  if (hasActiveSession()) return;
  stopHint(); hintDraftId = null; hintHovered = false; hintFocused = false;
  brandDraftId = null; brandWasPaused = false; brandState = 'logo'; brandMorph.setState('logo', { immediate: true });
  resetAudio(); $('#capsule-timer').textContent = '00:00';
  stopProgress(); previewPhase = 'waiting'; progressThreshold = Math.max(1, Number(event.thresholdMs) || 550);
  previewTriggerKey = triggerLabel(event.triggerKey); $('#hold-progress').setAttribute('aria-label', `长按${previewTriggerKey}以开始录音`);
  // Epoch time is used only to compensate event delivery; animation uses a local monotonic clock.
  const startedAt = typeof event.startedAt === 'string' && !Number.isFinite(Number(event.startedAt)) ? Date.parse(event.startedAt) : Number(event.startedAt);
  const deliveryDelay = Number.isFinite(startedAt) && startedAt > 100000000000 ? Math.max(0, Math.min(progressThreshold, Date.now() - startedAt)) : 0;
  progressStarted = performance.now() - deliveryDelay;
  $('#error-message').classList.add('hidden'); fillProgress(deliveryDelay / progressThreshold); setMode('progress');
  const step = (now) => {
    if (previewPhase !== 'waiting' || hasActiveSession()) { progressFrame = 0; return; }
    const ratio = (now - progressStarted) / progressThreshold; fillProgress(ratio);
    if (ratio >= 1) { progressFrame = 0; } else progressFrame = requestAnimationFrame(step);
  };
  progressFrame = requestAnimationFrame(step);
}
function showPreparingCard() {
  $('#capsule-timer').textContent = '00:00'; setMode('capsule');
}
function holdProgress(event) {
  if (event.phase === 'start') startProgress(event);
  else if (event.phase === 'complete') { stopProgress(); if (hasActiveSession()) { previewPhase = null; return; } if (event.triggerKey) previewTriggerKey = triggerLabel(event.triggerKey); previewPhase = 'complete'; fillProgress(1); showPreparingCard(); }
  else if (event.phase === 'cancel') {
    // A delayed preview cancellation must never erase an established recording card.
    if (hasActiveSession() || previewPhase === 'complete') return;
    stopProgress(); previewPhase = null; fillProgress(0); setMode('hidden');
  }
}
function showError(message) { $('#error-message').textContent = typeof message === 'string' ? message : message?.message || '操作未完成，请重试。'; $('#error-message').classList.remove('hidden'); openingChat = false; stopProgress(); previewPhase = null; setMode('card'); measureCard(); }
function syncTextReview(previousId) {
  const state = session.state || session.status;
  const keepText = session.keepText !== false;
  const field = $('#draft-transcript');
  if (previousId !== session.id) draftTextEdited = false;
  if (!draftTextEdited) field.value = session.draftTranscript || '';
  $('#draft-retention').classList.toggle('hidden', session.committingText || !['preparing', 'recording', 'paused'].includes(state));
  $('#draft-keep-audio').checked = session.keepAudio === true;
  $('#draft-keep-text').checked = keepText;
  const review = keepText && !session.committingText && ['paused', 'processing'].includes(state);
  $('#draft-text-review').classList.toggle('hidden', !review);
  const status = $('#draft-text-status');
  status.textContent = session.textPreviewing ? '正在本地转写…' : session.textPreviewError || '';
  status.classList.toggle('hidden', !status.textContent);
  status.classList.toggle('has-error', Boolean(session.textPreviewError));
  $('#draft-retry-text').classList.toggle('hidden', !session.textPreviewCanRetry);
}
function render(next) {
  const previousId = session?.id; const previousState = session?.state || session?.status; const previousSegment = session?.segmentId;
  session = next;
  const state = next?.state || next?.status || 'idle'; const recording = state === 'recording'; const paused = state === 'paused';
  if (previousId !== next?.id || previousSegment !== next?.segmentId || previousState !== 'recording' || !recording) resetAudio();
  if (!hasActiveSession(next)) { openingChat = false; stopHint(); hintHovered = false; hintFocused = false; if (!previewPhase) setMode('hidden'); return; }
  if (fromScreenshot(next)) stopHint(); else beginHint(next.id);
  syncBrand(next);
  stopProgress(); previewPhase = null; $('#actions').classList.remove('hidden');
  const hold = (next?.mode || next?.triggerMode) === 'hold';
  $('#draft-topics').classList.toggle('hidden', !(paused || !hold && ['preparing', 'recording'].includes(state)));
  if (previousId !== next?.id) $('#draft-topics').open = false;
  renderTopics();
  $('#background-capture-status').classList.toggle('hidden', next?.captureStatus !== 'unavailable');
  if (next?.error) showError(next.error); else $('#error-message').classList.add('hidden');
  timerBase = Number(next?.elapsedMs || next?.durationMs || 0);
  if (!recording) timerStarted = null;
  else if (timerStarted === null || previousId !== next.id || previousSegment !== next.segmentId || previousState !== 'recording') {
    const start = next.recordingStartedAt;
    const deliveryDelay = Number.isFinite(start) ? Math.max(0, Date.now() - start) : 0;
    timerStarted = performance.now() - deliveryDelay;
  }
  const compact = ['preparing', 'recording'].includes(state) && (fromScreenshot(next) ? next.regionScreenshotOpen && !brandWasPaused : hold);
  syncTextReview(previousId); syncDisabled(); if (!openingChat) setMode(compact && !next?.error ? 'capsule' : 'card'); updateTimer();
}
function updateTimer() { if (hasActiveSession()) { const time = format(timerBase + (timerStarted === null ? 0 : performance.now() - timerStarted)); $('#capsule-timer').textContent = time; const width = $('#capsule-timer').getBoundingClientRect?.().width; if (Number.isFinite(width) && width > 0) document.documentElement.style.setProperty('--capsule-width', `${199 + width}px`); syncCapsule(); } }
function syncDisabled() {
  const state = session?.state || session?.status || 'idle';
  document.querySelectorAll('.button').forEach((button) => { button.disabled = busy || state === 'processing'; });
  const field = $('#draft-transcript');
  const keepText = session?.keepText !== false;
  const keepAudio = session?.keepAudio === true;
  const processingText = keepText && session?.textPreviewing === true;
  $('#finish').disabled = busy || state !== 'paused' || processingText || keepText && !session?.committingText && session?.segmentCount > 0 && !field.value.trim();
  $('#ask-ai').disabled = busy || state === 'processing' || Boolean(session?.committingText);
  $('#discard').disabled = busy || state === 'processing' || Boolean(session?.committingText);
  field.readOnly = busy || state !== 'paused' || processingText || Boolean(session?.committingText);
  const retentionLocked = busy || state === 'processing' || Boolean(session?.committingText);
  $('#draft-keep-audio').disabled = retentionLocked || !keepText;
  $('#draft-keep-text').disabled = retentionLocked || !keepAudio;
  $('#draft-retry-text').disabled = busy || processingText || draftTextEdited;
  document.querySelectorAll('#draft-topic-options input').forEach(input => { input.disabled = busy || !canChooseTopics(); });
  syncCapsule();
}
async function action(method, params = {}) {
  if (busy || !bridge || (session?.state || session?.status) === 'processing') return; busy = true; syncDisabled();
  try {
    const result = await bridge.invoke(method, params);
    if (result?.ok === false) throw new Error(result.error?.message || result.error || '操作未完成');
    if (Object.hasOwn(params, 'transcript')) draftTextEdited = false;
    if (result?.session) render(result.session);
    else if (result?.state && result.id) render(result);
  }
  catch (error) {
    if (method === 'draft:retention') {
      $('#draft-keep-audio').checked = session?.keepAudio === true;
      $('#draft-keep-text').checked = session?.keepText !== false;
    }
    showError(error.message || String(error));
  }
  finally { busy = false; syncDisabled(); }
}
const editedText = () => draftTextEdited ? { transcript: $('#draft-transcript').value } : {};
$('#draft-transcript').addEventListener('input', () => { draftTextEdited = true; syncDisabled(); });
function changeRetention() {
  return action('draft:retention', { keepAudio: $('#draft-keep-audio').checked, keepText: $('#draft-keep-text').checked, ...editedText() });
}
$('#draft-keep-audio').addEventListener('change', changeRetention);
$('#draft-keep-text').addEventListener('change', changeRetention);
$('#draft-retry-text').addEventListener('click', () => action('draft:retryText'));
$('#discard').addEventListener('click', () => action('draft:discard'));
$('#finish').addEventListener('click', () => action('draft:finish', session?.keepText !== false && !session?.committingText ? { transcript: $('#draft-transcript').value } : {}));
$('#capsule-logo').addEventListener('click', () => { const state = session?.state || session?.status; if (state === 'paused') action('draft:continue', editedText()); else if (['preparing', 'recording'].includes(state)) action('draft:pause'); });
$('#ask-ai').addEventListener('click', () => action('chat:openFloating'));
$('.capture-panel').addEventListener('pointerenter', () => { hintHovered = true; syncHint(); });
$('.capture-panel').addEventListener('pointerleave', () => { hintHovered = false; syncHint(); });
$('.capture-panel').addEventListener('focusin', () => { hintFocused = true; syncHint(); });
$('.capture-panel').addEventListener('focusout', event => { hintFocused = $('.capture-panel').contains(event.relatedTarget); syncHint(); });
document.addEventListener('wheel', event => { if (event.deltaY < 0 && document.body.dataset.mode === 'capsule' && !fromScreenshot()) { event.preventDefault(); action('chat:openFloating'); } }, { passive: false });
$('#draft-topics').addEventListener('toggle', measureCard);
async function saveTopics(topicId, checked) {
  if (busy || !session?.id || !canChooseTopics()) return;
  busy = true; syncDisabled();
  try {
    const selected = new Set(session.topicIds || []); if (checked) selected.add(topicId); else selected.delete(topicId); const topicIds = [...selected];
    const result = await bridge.invoke('records:setTopics', { id: session.id, topicIds });
    if (result?.ok === false) throw new Error(result.error || '分组未保存');
    session.topicIds = topicIds; renderTopics();
  } catch (error) { showError(error.message); }
  finally { busy = false; syncDisabled(); renderTopics(); }
}
async function refreshTopics() {
  const previousSession = session;
  const data = await bridge.invoke('app:bootstrap', {});
  topics = data?.topics || [];
  // A session event may have arrived while bootstrap was in flight.
  if (session === previousSession) render(data?.session || null);
  else if (hasActiveSession()) renderTopics();
}
if (bridge?.subscribe) bridge.subscribe((event) => { if (event?.type === 'audioLevel') audioLevel(event); else if (event?.type === 'overlayChat') { openingChat = event.phase !== 'cancel'; if (openingChat) { stopHint(); resetAudio(); setMode('capsule'); } else render(session); } else if (event?.type === 'holdProgress') { if (event.phase === 'start') openingChat = false; holdProgress(event); } else if (event?.type === 'session' || event?.type === 'sessionChanged') render(event.session); else if (event?.type === 'recordsChanged') refreshTopics().catch(error => showError(error.message)); else if (event?.type === 'error') showError(event.message); });
if (bridge?.invoke) refreshTopics().catch((error) => showError(error.message));
else showError('桌面连接尚未就绪。');
setInterval(updateTimer, 250);
// A stopped or suspended PCM source cannot leave a nonzero waveform behind.
setInterval(() => { if (lastAudioAt && Date.now() - lastAudioAt > 240) resetAudio(); }, 100);
window.addEventListener?.('resize', () => { alignBrandCorner(); if (document.body.dataset.mode === 'card') measureCard(); });
if (bridge?.invoke && typeof ResizeObserver === 'function') {
  const panel = $('.capture-panel');
  new ResizeObserver(() => {
    const { x, y, width, height } = panel.getBoundingClientRect();
    bridge.invoke('overlay:surface', { x, y, width, height }).catch(() => {});
  }).observe(panel);
}
window.addEventListener?.('unload', () => { stopHint(); brandMorph.destroy(); });
