'use strict';
const $ = (selector) => document.querySelector(selector);
const bridge = window.inmoment;
let session = null;
let timerBase = 0;
let timerStarted = 0;
let busy = false;
let progressFrame = 0;
let progressStarted = 0;
let progressThreshold = 550;
let previewPhase = null;
let previewTriggerKey = '右键';
let topics = [];

function format(ms) { const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }
function triggerLabel(value) { return ['F8', 'F9', 'F10'].includes(value) ? value : '右键'; }
function hasActiveSession(next = session) { const state = next?.state || next?.status; return Boolean(next && next.active !== false && ['preparing', 'recording', 'paused', 'processing', 'error'].includes(state)); }
function setMode(mode) {
  document.body.className = `mode-${mode}`;
  document.body.dataset.mode = mode;
  $('#card-content').setAttribute('aria-hidden', String(mode !== 'card'));
  $('#hold-progress').setAttribute('aria-hidden', String(mode !== 'progress'));
  if (mode === 'card') measureCard();
}
function measureCard() { document.documentElement.style.setProperty('--card-height', `${Math.min(422, Math.max(220, $('#card-content').scrollHeight + 29))}px`); }
function renderTopics() {
  const ids = session?.topicIds || [];
  const names = topics.filter(topic => ids.includes(topic.id)).map(topic => topic.name);
  $('#draft-topics-label').textContent = `分组：${names.join('、') || '未分类'}`;
  const choices = $('#draft-topic-options'); choices.replaceChildren();
  if (!topics.length) { const hint = document.createElement('p'); hint.textContent = '还没有其他分组，可以直接保存到未分类。'; choices.append(hint); }
  for (const topic of topics) {
    const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = ids.includes(topic.id); checkbox.disabled = busy;
    checkbox.addEventListener('change', () => saveTopics(topic.id, checkbox.checked));
    const text = document.createElement('span'); text.textContent = topic.name; label.append(checkbox); label.append(text); choices.append(label);
  }
}
function stopProgress() { if (progressFrame) cancelAnimationFrame(progressFrame); progressFrame = 0; }
function fillProgress(value) { const ratio = Math.max(0, Math.min(1, value)); document.documentElement.style.setProperty('--hold-progress', String(ratio)); $('#hold-progress').setAttribute('aria-valuenow', String(Math.round(ratio * 100))); }
function startProgress(event) {
  if (hasActiveSession()) return;
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
  $('#orb').className = 'orb'; $('#mode-label').textContent = `首次 · 按住 ${previewTriggerKey}`;
  $('#status-title').textContent = '正在准备录音…'; $('#status-description').textContent = `保持按住 ${previewTriggerKey}，等待麦克风就绪`;
  $('#timer').textContent = '00:00'; $('#actions').classList.add('hidden'); setMode('card');
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
function showError(message) { $('#error-message').textContent = typeof message === 'string' ? message : message?.message || '操作未完成，请重试。'; $('#error-message').classList.remove('hidden'); if (document.body.dataset.mode === 'card') measureCard(); }
function render(next) {
  session = next;
  const state = next?.state || next?.status || 'idle'; const mode = next?.mode || next?.triggerMode || 'manual'; const recording = state === 'recording'; const paused = state === 'paused';
  if (!hasActiveSession(next)) { if (!previewPhase) setMode('hidden'); return; }
  stopProgress(); previewPhase = null; $('#actions').classList.remove('hidden');
  $('#orb').className = `orb ${recording ? 'recording' : paused ? 'paused' : state === 'error' ? 'error-orb' : ''}`;
  const triggerKey = triggerLabel(next?.triggerKey);
  $('#mode-label').textContent = mode === 'hold' && ['preparing', 'recording'].includes(state) ? `首次 · 按住 ${triggerKey}` : paused ? '已暂停' : '手动录音';
  $('#status-title').textContent = paused ? '停一停，想法还在这里' : state === 'preparing' ? '正在准备录音…' : state === 'processing' ? '正在保存这段想法…' : state === 'error' ? '录音遇到一点问题' : '正在听你说';
  $('#status-description').textContent = paused ? '继续表达，或把这一刻留下。' : recording && mode === 'hold' ? `松开 ${triggerKey}，自动暂停` : recording ? '无需按住按键 · 点击暂停' : state === 'preparing' ? '正在启动本地麦克风' : state === 'processing' ? '原始表达会保存在本机' : '可删除草稿，或稍后重试。';
  $('#pause').classList.toggle('hidden', !recording || mode === 'hold'); $('#continue').classList.toggle('hidden', !paused); $('#finish').classList.toggle('hidden', !paused);
  $('#draft-topics').classList.toggle('hidden', !paused);
  if (!paused) $('#draft-topics').open = false;
  renderTopics();
  if (next?.error) showError(next.error); else $('#error-message').classList.add('hidden');
  timerBase = Number(next?.elapsedMs || next?.durationMs || 0); timerStarted = recording ? Date.now() : 0; updateTimer(); syncDisabled(); setMode('card');
}
function updateTimer() { if (document.body.dataset.mode === 'card' && hasActiveSession()) $('#timer').textContent = format(timerBase + (timerStarted ? Date.now() - timerStarted : 0)); }
function syncDisabled() {
  const state = session?.state || session?.status || 'idle';
  document.querySelectorAll('.button').forEach((button) => { button.disabled = busy || state === 'processing'; });
  document.querySelectorAll('#draft-topic-options input').forEach(input => { input.disabled = busy || state !== 'paused'; });
}
async function action(method) {
  if (busy || !bridge || (session?.state || session?.status) === 'processing') return; busy = true; syncDisabled();
  try { const result = await bridge.invoke(method, {}); if (result?.ok === false) throw new Error(result.error?.message || result.error || '操作未完成'); if (result?.session) render(result.session); }
  catch (error) { showError(error.message || String(error)); }
  finally { busy = false; syncDisabled(); }
}
$('#discard').addEventListener('click', () => action('draft:discard')); $('#continue').addEventListener('click', () => action('draft:continue')); $('#pause').addEventListener('click', () => action('draft:pause')); $('#finish').addEventListener('click', () => action('draft:finish'));
$('#draft-topics').addEventListener('toggle', measureCard);
async function saveTopics(topicId, checked) {
  if (busy || !session?.id || session.state !== 'paused') return;
  busy = true; syncDisabled();
  try {
    const selected = new Set(session.topicIds || []); if (checked) selected.add(topicId); else selected.delete(topicId); const topicIds = [...selected];
    const result = await bridge.invoke('records:setTopics', { id: session.id, topicIds });
    if (result?.ok === false) throw new Error(result.error || '分组未保存');
    session.topicIds = topicIds; renderTopics();
  } catch (error) { showError(error.message); }
  finally { busy = false; syncDisabled(); renderTopics(); }
}
async function refreshTopics() { const data = await bridge.invoke('app:bootstrap', {}); topics = data?.topics || []; render(data?.session || null); }
if (bridge?.subscribe) bridge.subscribe((event) => { if (event?.type === 'holdProgress') holdProgress(event); else if (event?.type === 'session' || event?.type === 'sessionChanged') render(event.session); else if (event?.type === 'recordsChanged') refreshTopics().catch(error => showError(error.message)); else if (event?.type === 'error') showError(event.message); });
if (bridge?.invoke) refreshTopics().catch((error) => showError(error.message));
else showError('桌面连接尚未就绪。');
setInterval(updateTimer, 250);
