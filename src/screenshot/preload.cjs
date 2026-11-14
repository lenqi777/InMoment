'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed=new Set(['screenshot:init','screenshot:confirm','screenshot:cancel','screenshot:record']);
contextBridge.exposeInMainWorld('inmomentScreenshot',Object.freeze({
  invoke(method,params={}) {
    if(!allowed.has(method))return Promise.reject(new Error('不支持的截图操作。'));
    return ipcRenderer.invoke('inmoment:screenshot',method,params).then(result=>{
      if(result?.ok===false)throw new Error(result.error||'截图操作未完成。');
      return result?.ok===true?result.value:result;
    });
  }
}));
