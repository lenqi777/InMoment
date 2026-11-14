'use strict';
(() => {
  const bridge = window.inmoment;
  const view = new window.InMomentChatView({ root:document.querySelector('#floating-chat-root'), floating:true, invoke:(method,params) => bridge.invoke(method,params), onOpenRecord:(recordId, noteId) => bridge.invoke('app:show', noteId ? { noteId } : { recordId }).catch(error => view.report(error.message, true)), onSettings:() => bridge.invoke('chat:showMain',{ id:view.currentId,settings:true }) });
  window.chatView = view;
  bridge.subscribe(event => { if (event.type === 'chatOpen') view.run(() => view.open(event.id)); else view.handleEvent(event); });
  const id = new URLSearchParams(location.search).get('id');
  const ready = id ? view.open(id).catch(error => { view.report(error.message || '聊天未能打开。',true); }) : Promise.resolve();
  window.InMomentFloatingChat = {
    async prepare(payload) { await ready; const result=window.InMomentChatTransition.prepare(payload);document.querySelector('#chat-transition-surface').getBoundingClientRect();return result; },
    present() { return new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(deadline);resolve();};const deadline=setTimeout(finish,80);requestAnimationFrame(()=>requestAnimationFrame(finish));}); },
    enter: () => window.InMomentChatTransition.enter(),
    cancel: () => window.InMomentChatTransition.cancel(),
    layout() { view.lastNativeResizeKey='';view.scheduleInputLayout(); }
  };
  if(new URLSearchParams(location.search).get('transition')!=='capsule')ready.then(()=>window.InMomentChatTransition.finish());
})();
