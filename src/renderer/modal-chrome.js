'use strict';

(() => {
  let applied;
  function synchronize(force=false) {
    const imageViewer = Boolean(document.querySelector('dialog.note-image-viewer:modal, .note-image-viewer.ui-motion-snapshot'));
    const active = imageViewer || Boolean(document.querySelector('dialog:modal,.ui-motion-scrim'));
    const appearance = imageViewer ? 'image' : active ? 'modal' : 'normal';
    if (!force && appearance === applied) return;
    applied = appearance;
    window.inmoment.invoke('window:modalState', { active, imageViewer }).catch(() => { applied = undefined; });
  }
  new MutationObserver(()=>synchronize()).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
  window.addEventListener('focus',()=>synchronize(true));
  window.addEventListener('pagehide',()=>{window.inmoment.invoke('window:modalState',{active:false}).catch(()=>{});});
  synchronize();
})();
