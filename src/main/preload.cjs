'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['app:bootstrap','app:setDirty','records:list','records:get','records:search','records:aiSearch','records:update','records:delete','records:organize','records:transcribe','records:openSource','records:revealScreenshot','records:setTopics','records:continueThought','topics:create','topics:rename','topics:merge','topics:delete','topics:mergeMany','topics:deleteMany','library:duplicates','library:cancel','duplicates:decide','groups:ungroup','draft:continue','draft:pause','draft:discard','draft:finish','draft:startManual','draft:recover','draft:deleteAbandoned','settings:get','settings:save','settings:reset','overlay:hide','app:show']);
for (const method of ['app:uiReady','dialog:respond','window:minimize','window:toggleMaximize','window:close','window:state','groups:rename','media:open-original','media:reveal-record']) allowed.add(method);
for (const method of ['library:batchOrganize','semantic:status','semantic:install','semantic:cancel','semantic:cloud']) allowed.add(method);
contextBridge.exposeInMainWorld('inmoment', Object.freeze({
  invoke(method, params = {}) {
    if (!allowed.has(method)) return Promise.reject(new Error('不支持的操作。'));
    return ipcRenderer.invoke('inmoment:invoke', method, params).then(result => { if (!result?.ok) { const error = new Error(result?.error || '操作失败。'); if (result?.code === 'MODEL_NOT_INSTALLED') error.code = result.code; throw error; } return result.value; });
  },
  subscribe(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, message) => callback(message); ipcRenderer.on('inmoment:event', listener);
    return () => ipcRenderer.removeListener('inmoment:event', listener);
  }
}));
