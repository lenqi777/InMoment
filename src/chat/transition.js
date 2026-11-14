'use strict';
(() => {
  const root = document.querySelector('#floating-chat-root');
  const surface = document.querySelector('#chat-transition-surface');
  const ghost = document.querySelector('#chat-origin-capsule');
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  let animations = [], generation = 0, prepared = false;
  const panelShadow = getComputedStyle(surface).boxShadow;
  const rectStyle = (rect, radius=24) => ({ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, borderRadius: `${radius}px` });
  const targetRect = () => { const rect=root.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height}; };
  const panelRadius = () => parseFloat(getComputedStyle(root).borderTopLeftRadius);
  const clip = rect => { const target=targetRect(),x=rect.x-target.x,y=rect.y-target.y;return `inset(${y}px ${Math.max(0,target.width-x-rect.width)}px ${Math.max(0,target.height-y-rect.height)}px ${x}px round 24px)`; };
  function clearAnimations() { const old = animations; animations = []; old.forEach(animation => animation.cancel()); }
  function finish() {
    clearAnimations(); prepared = false; document.body.classList.remove('chat-window-pending', 'chat-window-opening');
    root.style.clipPath = ''; root.style.opacity = ''; ghost.replaceChildren(); ghost.hidden = true;
    Object.assign(surface.style, rectStyle(targetRect(),panelRadius()));surface.style.boxShadow='';
  }
  function drawGhost(data, rect) {
    ghost.replaceChildren(); ghost.hidden = !data;
    if (!data) return;
    Object.assign(ghost.style, rectStyle(rect));
    const logo = document.createElement('span'); logo.className = 'chat-origin-logo';
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 64 64');
    const circle = document.createElementNS(svg.namespaceURI,'circle');
    for (const [name,value] of Object.entries({cx:32,cy:32,r:32,fill:'#324C36'})) circle.setAttribute(name,value);
    svg.append(circle);
    for (const ink of data.paths || []) { const path=document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d',ink.d); path.setAttribute('fill',ink.fill); svg.append(path); }
    logo.append(svg);
    const waveform=document.createElement('span'); waveform.className='chat-origin-waveform';
    for (const height of data.heights || Array(19).fill(3)) { const bar=document.createElement('span'); bar.style.height=`${height}px`;waveform.append(bar); }
    const timer=document.createElement('span');timer.textContent=data.timer || '00:00';timer.className='chat-origin-timer';
    ghost.append(logo,waveform,timer);
  }
  window.InMomentChatTransition = {
    prepare(payload) {
      generation++; clearAnimations();
      if (!payload?.source) { finish(); return; }
      const scaleX=innerWidth/payload.window.width,scaleY=innerHeight/payload.window.height;
      const source=payload.source;
      const rect={x:(source.x-payload.window.x)*scaleX,y:(source.y-payload.window.y)*scaleY,width:source.width*scaleX,height:source.height*scaleY};
      prepared=true;document.body.classList.remove('chat-window-pending');document.body.classList.add('chat-window-opening');
      Object.assign(surface.style,rectStyle(rect));surface.style.boxShadow='none';root.style.clipPath=clip(rect);root.style.opacity='0';
      drawGhost(source.visual,rect);
      return {origin:rect,viewport:{width:innerWidth,height:innerHeight}};
    },
    async enter() {
      const owner=++generation;
      if (!prepared || media.matches) { finish(); return; }
      const initial={left:surface.style.left,top:surface.style.top,width:surface.style.width,height:surface.style.height,borderRadius:'24px',boxShadow:'none'};
      const timing={duration:320,easing:'cubic-bezier(.2,.75,.25,1)',fill:'forwards'};
      animations=[surface.animate([initial,{...rectStyle(targetRect(),panelRadius()),boxShadow:panelShadow}],timing),root.animate([
        {clipPath:root.style.clipPath,opacity:0,offset:0},{opacity:0,offset:.15},{clipPath:`inset(0px 0px 0px 0px round ${panelRadius()}px)`,opacity:1,offset:1}
      ],timing)];
      if(!ghost.hidden)animations.push(ghost.animate([{opacity:1,offset:0},{opacity:1,offset:.2},{opacity:0,offset:.65},{opacity:0,offset:1}],timing));
      await Promise.all(animations.map(animation=>animation.finished.catch(()=>{})));
      if(owner===generation)finish();
    },
    finish,
    cancel() { generation++;finish(); }
  };
  media.addEventListener('change',()=>{if(media.matches)window.InMomentChatTransition.cancel();});
  window.addEventListener('resize',()=>{if(!prepared&&!document.body.classList.contains('chat-window-pending'))finish();});
  window.addEventListener('unload',()=>window.InMomentChatTransition.cancel());
})();
