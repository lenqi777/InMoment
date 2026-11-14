'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['app:bootstrap','app:setDirty','records:list','records:get','records:search','records:aiSearch','records:update','records:delete','records:organize','records:transcribe','records:openSource','records:revealScreenshot','records:setTopics','topics:create','topics:rename','topics:merge','topics:delete','topics:mergeMany','topics:deleteMany','library:duplicates','library:cancel','duplicates:decide','groups:ungroup','draft:continue','draft:pause','draft:discard','draft:finish','draft:startManual','draft:recover','draft:deleteAbandoned','settings:get','settings:save','settings:reset','overlay:hide','app:show']);
for (const method of ['app:uiReady','dialog:respond','window:minimize','window:toggleMaximize','window:close','window:state','window:modalState','groups:rename','media:open-original','media:reveal-record']) allowed.add(method);
for (const method of ['library:batchOrganize','semantic:status','semantic:install','semantic:cancel','semantic:cloud']) allowed.add(method);
for (const method of ['topics:move','topics:copyTree','topics:deleteWithNotes']) allowed.add(method);
allowed.add('records:waveform');
allowed.add('settings:shortcutCapture');
allowed.add('settings:shortcutKey');
allowed.add('overlay:surface');
for (const method of ['draft:retention', 'draft:retryText', 'records:previewText', 'records:keepTextOnly']) allowed.add(method);
allowed.add('records:openSourceUrl');
allowed.add('chat:rename');
allowed.add('chat:referenceNotes');
for (const method of ['notes:list','notes:listIds','notes:get','notes:create','notes:update','notes:copy','notes:delete','notes:deleteMany','notes:export','notes:removeAudio','notes:pasteFiles','notes:attach','notes:pickFiles','notes:remove','notes:reveal','notes:openLink']) allowed.add(method);
for (const method of ['notes:aiSummary','notes:aiRewrite','notes:cancelAI','notes:clipboard','notes:copySelection','notes:readPicture']) allowed.add(method);
for (const method of ['image:recognize', 'image:cancelRecognition', 'image:copyText', 'image:copyOutline', 'image:copyEdited', 'image:readRecord', 'notes:replacePicture']) allowed.add(method);
for (const method of ['notes:suggestGroups','notes:applyGroups','notes:addToTopic']) allowed.add(method);
for (const method of ['chat:list','chat:create','chat:get','chat:update','chat:send','chat:retry','chat:cancel','chat:save','chat:delete','chat:inspiration','chat:openFloating','chat:resize','chat:close','chat:showMain','chat:record','chat:voiceRetry','chat:voiceStop','chat:voiceCancel','chat:screenshot']) allowed.add(method);
contextBridge.exposeInMainWorld('inmoment', Object.freeze({
  invoke(method, params = {}) {
    if (!allowed.has(method)) return Promise.reject(new Error('不支持的操作。'));
    return ipcRenderer.invoke('inmoment:invoke', method, params).then(result => {
      // Preserve the field error code across contextBridge, which drops custom Error properties.
      if (result?.code === 'REGION_SHORTCUT') return result;
      if (!result?.ok) {
        const error = new Error(result?.error || '操作失败。');
        if (result?.code === 'MODEL_NOT_INSTALLED') error.code = result.code;
        throw error;
      }
      return result.value;
    });
  },
  subscribe(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, message) => callback(message); ipcRenderer.on('inmoment:event', listener);
    return () => ipcRenderer.removeListener('inmoment:event', listener);
  }
}));
