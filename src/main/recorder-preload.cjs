'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('recorderBridge', Object.freeze({
  onCommand(callback) { ipcRenderer.on('recorder:command', (_event, message) => callback(message)); },
  ready: data => ipcRenderer.invoke('recorder:ready', data),
  chunk: data => ipcRenderer.invoke('recorder:chunk', data),
  stopped: data => ipcRenderer.invoke('recorder:stopped', data),
  failed: data => ipcRenderer.invoke('recorder:failed', data)
}));
