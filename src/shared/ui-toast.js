'use strict';
((scope, factory) => {
  const create = factory();
  if (typeof module === 'object' && module.exports) module.exports = { createToast:create };
  else scope.InMomentToast = create({ document:scope.document, motion:scope.InMomentMotion, setTimer:scope.setTimeout.bind(scope), clearTimer:scope.clearTimeout.bind(scope) });
})(typeof window === 'object' ? window : globalThis, () => {
  return function createToast({ document, motion, setTimer=setTimeout, clearTimer=clearTimeout }) {
    let host, timer, revision=0;
    function region() {
      if (!host) {
        host=document.getElementById('toast');
        if (!host) { host=document.createElement('div');host.id='toast';host.hidden=true;document.body.append(host); }
        host.classList.add('ui-toast');host.classList.remove('toast','error');
        host.setAttribute('aria-atomic','true');
      }
      return host;
    }
    async function hide() {
      const version=++revision;clearTimer(timer);timer=null;
      if (!host || host.hidden) return;
      await motion?.exit?.(host);
      if (version===revision) { host.hidden=true;host.classList.add('hidden');host.textContent=''; }
    }
    function show(message, { tone='info',durationMs }={}) {
      const text=String(message||'').trim();
      if (!text) { void hide();return; }
      revision++;clearTimer(timer);const target=region();
      const severity=tone==='error'?'error':tone==='success'?'success':'info';
      target.setAttribute('data-tone',severity);target.setAttribute('role',severity==='error'?'alert':'status');target.setAttribute('aria-live',severity==='error'?'assertive':'polite');
      target.textContent=text;target.hidden=false;target.classList.remove('hidden');motion?.enter?.(target);
      const delay=Number.isFinite(durationMs)?Math.max(1000,Math.min(10000,durationMs)):severity==='error'?5000:3000;
      timer=setTimer(()=>{void hide();},delay);
      return target;
    }
    return { show,hide };
  };
});
