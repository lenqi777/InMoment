'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  let busy = false;
  function render(status) {
    const working = ['preparing', 'downloading', 'retrying', 'verifying', 'installing', 'indexing', 'cancelling'].includes(status.phase); busy = working;
    $('#semantic-install').classList.toggle('hidden', Boolean(status.installed) || working); $('#semantic-cancel').classList.toggle('hidden', !working);
    $('#semantic-retry').classList.toggle('hidden', !status.error || working); $('#semantic-progress').classList.toggle('hidden', !working);
    $('#semantic-cancel').disabled = status.phase === 'cancelling';
    const phase = { preparing: '正在准备本地模型', downloading: '正在下载本地模型', retrying: '连接中断，正在重新连接', verifying: '正在校验模型', installing: '正在安装模型', indexing: '正在建立灵感索引', cancelling: '正在取消并清理下载' }[status.phase];
    const retry = status.attempt > 1 && ['downloading', 'retrying'].includes(status.phase) ? `（第 ${status.attempt} 次连接，最多 4 次）` : '';
    $('#semantic-status').textContent = status.error || (working ? phase + retry : status.installed ? '本地语义模型已就绪，灵感云与 AI 查找可用。' : '本地语义模型尚未安装。安装后在本机建立索引，原文和向量不因安装上传。');
    const total = status.totalBytes || status.total || 0, completed = status.downloaded || status.completed || 0;
    if (total) { $('#semantic-progress').max = total; $('#semantic-progress').value = completed; } else $('#semantic-progress').removeAttribute('value');
  }
  async function update() { try { render(await window.inmoment.invoke('semantic:status')); } catch (error) { $('#semantic-status').textContent = error.message; } }
  async function install() { if (busy) return; busy = true; $('#semantic-install').disabled = true; $('#semantic-retry').disabled = true; try { const result = await window.inmoment.invoke('semantic:install'); if (!result?.cancelled) render(result); } catch (error) { render({ error: error.message, phase: 'failed' }); } finally { busy = false; $('#semantic-install').disabled = false; $('#semantic-retry').disabled = false; } }
  $('#semantic-install').addEventListener('click', install); $('#semantic-retry').addEventListener('click', install); $('#semantic-cancel').addEventListener('click', async () => { try { await window.inmoment.invoke('semantic:cancel'); await update(); } catch (error) { render({ error: error.message, phase: 'failed' }); } });
  window.inmoment.subscribe(event => { if (event.type === 'semanticProgress') render(event); }); update();
})();
