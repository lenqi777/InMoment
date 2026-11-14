'use strict';
((scope,factory)=>{const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else scope.InMomentChatNavigation=api;})(typeof window==='object'?window:globalThis,()=>{
  const bottomDistance=host=>Math.max(0,host.scrollHeight-host.clientHeight-host.scrollTop);
  function capture(host){const viewport=host.getBoundingClientRect(),anchor=[...host.querySelectorAll('[data-message-id]')].find(node=>node.getBoundingClientRect().bottom>viewport.top+1);return{top:host.scrollTop,left:host.scrollLeft,bottom:bottomDistance(host)<=4,anchor:anchor?.dataset.messageId,offset:anchor?anchor.getBoundingClientRect().top-viewport.top:0};}
  function restore(host,state,{followBottom=true}={}){if(!state)return;if(followBottom&&state.bottom)host.scrollTop=host.scrollHeight;else{const anchor=[...host.querySelectorAll('[data-message-id]')].find(node=>node.dataset.messageId===state.anchor);host.scrollTop=anchor?host.scrollTop+anchor.getBoundingClientRect().top-host.getBoundingClientRect().top-state.offset:state.top;}host.scrollLeft=state.left||0;}
  const clampScrollTop=(host,top)=>Math.max(0,Math.min(Math.max(0,host.scrollHeight-host.clientHeight),top));
  function activeQuestion(positions,threshold){let id=positions[0]?.id;for(const item of positions){if(item.top>threshold)break;id=item.id;}return id;}
  function questionLabel(message){const text=String(message.text||message.selectedText||message.quotes?.map(q=>q.text).join(' ')||message.attachments?.[0]?.name||(message.images?.length?'图片提问':'提问')).replace(/\s+/gu,' ').trim();return [...text].length>80?[...text].slice(0,79).join('')+'…':text||'提问';}
  function imageKey(image){if(image.id)return[image.id,image.mimeType,image.name];const data=String(image.base64||image.data||'');return[image.mimeType,image.name,data.length,data.slice(0,32),data.slice(-32)];}
  function messageKey(chat,selecting,selected=[]){return JSON.stringify([chat?.id,Boolean(chat?.pending),Boolean(selecting),[...selected].sort(),chat?.progress,(chat?.messages||[]).map(m=>[m.id,m.role,m.text,m.status,m.images?.map(imageKey),m.attachments?.map(file=>[file.id,file.mimeType,file.name,file.size]),m.quotes?.map(q=>[q.id,q.text]),m.selectedText,m.references?.map(r=>[r.id,r.recordId,r.title]),m.progress])]);}
  const edgeZone = 22;
  const edgePixelsPerMs = 0.12;
  function mount({conversation,messages,composer,header,getMessages=()=>[],getId=()=>null}){
    const doc=conversation.ownerDocument,win=doc.defaultView,nav=doc.createElement('nav'),list=doc.createElement('div'),tip=doc.createElement('div'),bottom=doc.createElement('button');nav.className='chat-question-navigation';nav.setAttribute('aria-label','按提问跳转');list.className='chat-question-ticks';nav.append(list);tip.className='chat-question-preview';tip.setAttribute('role','tooltip');tip.hidden=true;bottom.className='icon-button chat-bottom-button';bottom.type='button';bottom.dataset.uiIcon='chevron';bottom.setAttribute('aria-label','回到底部');bottom.title='回到底部';bottom.hidden=true;conversation.classList.add('chat-has-question-navigation');conversation.append(nav,bottom,tip);
    let frame=null,destroyed=false,key='',currentId,following=true,activeId,smoothTarget=null,readingState=null,scrollTimer=null,hiddenReading=null,pendingQuestion=null;
    let activeControl = null, revealActive = true, railHeight = 0;
    let edgeFrame = null, edgeY = null, edgeTime = null, edgeRemainder = 0;
    const listeners=[];const listen=(node,type,fn,options)=>{node.addEventListener(type,fn,options);listeners.push(()=>node.removeEventListener(type,fn,options));};
    const reduced=()=>Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches),messageNodes=()=>new Map([...messages.querySelectorAll('[data-message-id]')].map(node=>[node.dataset.messageId,node]));
    const finishScroll=()=>{clearTimeout(scrollTimer);smoothTarget=null;pendingQuestion=null;following=bottomDistance(messages)<=4;readingState=capture(messages);schedule();},cancelScroll=()=>{if(smoothTarget!==null)messages.scrollTo({top:messages.scrollTop,behavior:'instant'});finishScroll();following=false;},scroll=top=>{clearTimeout(scrollTimer);top=clampScrollTop(messages,top);smoothTarget=top;messages.scrollTo({top,behavior:reduced()?'auto':'smooth'});if(Math.abs(messages.scrollTop-top)<2)finishScroll();else scrollTimer=setTimeout(finishScroll,1200);schedule();};
    function hideTip(){tip.hidden=true;tip.textContent='';}
    function preview(button){tip.textContent=button.getAttribute('aria-label');tip.hidden=false;const buttonBox=button.getBoundingClientRect(),panel=conversation.getBoundingClientRect();tip.style.left=Math.max(panel.left+28,Math.min(buttonBox.right+8,win.innerWidth-tip.offsetWidth-8))+'px';tip.style.top=Math.max(panel.top+8,Math.min(buttonBox.top+(buttonBox.height-tip.offsetHeight)/2,win.innerHeight-tip.offsetHeight-8))+'px';}
    function revealTick(control) {
      const box = control.getBoundingClientRect(), clip = list.getBoundingClientRect();
      if (box.top < clip.top) list.scrollTop -= Math.ceil(clip.top - box.top);
      else if (box.bottom > clip.bottom) list.scrollTop += Math.ceil(box.bottom - clip.bottom);
    }
    function edgeDirection() {
      if (edgeY === null || nav.hidden || !visible()) return 0;
      const { top, bottom, height } = list.getBoundingClientRect();
      const zone = Math.min(edgeZone, height / 4);
      if (edgeY >= top && edgeY < top + zone && list.scrollTop > 0) return -1;
      if (edgeY > bottom - zone && edgeY <= bottom && bottomDistance(list) > 1) return 1;
      return 0;
    }
    function stopEdgeScroll() {
      if (edgeFrame !== null) win.cancelAnimationFrame(edgeFrame);
      edgeFrame = null;
      edgeY = null;
      edgeTime = null;
      edgeRemainder = 0;
    }
    function scrollEdge(now) {
      edgeFrame = null;
      const direction = edgeDirection();
      if (!direction) { stopEdgeScroll(); return; }
      const elapsed = edgeTime === null ? 0 : Math.min(40, now - edgeTime);
      const distance = direction * elapsed * edgePixelsPerMs + edgeRemainder;
      const step = Math.trunc(distance);
      edgeTime = now;
      edgeRemainder = distance - step;
      list.scrollTop += step;
      edgeFrame = win.requestAnimationFrame(scrollEdge);
    }
    function onRailPointer(event) {
      if (event.pointerType !== 'mouse' || event.buttons) return;
      edgeY = event.clientY;
      if (!edgeDirection()) {
        const wasScrolling = edgeFrame !== null;
        stopEdgeScroll();
        const control = event.target.closest?.('[data-question-id]');
        if (wasScrolling && control) preview(control);
        return;
      }
      if (edgeFrame === null) {
        hideTip();
        edgeFrame = win.requestAnimationFrame(scrollEdge);
      }
    }
    function jump(id){const target=messageNodes().get(id);if(!target)return;pendingQuestion=id;following=false;hideTip();scroll(Math.max(0,messages.scrollTop+target.getBoundingClientRect().top-messages.getBoundingClientRect().top-12));}
    function refresh(){const id=getId();if(id!==currentId){currentId=id;clearTimeout(scrollTimer);smoothTarget=null;readingState=null;hiddenReading=null;pendingQuestion=null;following=true;activeId=null;stopEdgeScroll();list.scrollTop=0;hideTip();}if(!getMessages().length){clearTimeout(scrollTimer);smoothTarget=null;pendingQuestion=null;following=true;readingState=null;hiddenReading=null;hideTip();}const questions=getMessages().filter(m=>m.role==='user');conversation.classList.toggle('chat-has-questions',questions.length>0);const next=JSON.stringify(questions.map(m=>[m.id,questionLabel(m)]));if(next!==key){key=next;list.replaceChildren();revealActive=true;hideTip();for(const message of questions){const control=doc.createElement('button');control.type='button';control.className='chat-question-tick';control.dataset.questionId=message.id;control.setAttribute('aria-label',questionLabel(message));const line=doc.createElement('span');line.setAttribute('aria-hidden','true');control.append(line);list.append(control);}}observeMessages();nav.hidden=!questions.length;schedule();}
    const visible=()=>Boolean(messages.getClientRects().length&&conversation.getClientRects().length&&messages.clientHeight>0);
    function restoreReading(state,options){clearTimeout(scrollTimer);smoothTarget=null;pendingQuestion=null;if(!visible()){hiddenReading={state,options};return;}if(state?.pendingQuestion){const target=messageNodes().get(state.pendingQuestion);if(target)state={...state,bottom:false,anchor:null,top:clampScrollTop(messages,messages.scrollTop+target.getBoundingClientRect().top-messages.getBoundingClientRect().top-12)};}restore(messages,state,options);following=bottomDistance(messages)<=4;readingState=capture(messages);hiddenReading=null;schedule();}
    function update() {
      frame = null;
      if (destroyed || !visible()) return;
      if (hiddenReading) restoreReading(hiddenReading.state, hiddenReading.options);
      const panel = conversation.getBoundingClientRect(), area = messages.getBoundingClientRect();
      const top = Math.max(0, header.getBoundingClientRect().bottom - panel.top + 8, area.top - panel.top);
      const end = Math.min(panel.bottom, area.bottom, composer.getBoundingClientRect().top) - panel.top;
      const available = Math.max(0, end - top), distance = bottomDistance(messages);
      nav.style.maxHeight = Math.min(panel.height / 3, available) + 'px';
      const height = list.clientHeight;
      const center = Math.max(top + height / 2, Math.min(panel.height / 2, end - height / 2));
      nav.style.top = (center + conversation.scrollTop) + 'px';
      bottom.style.left = (area.left - panel.left + area.width / 2 - 16) + 'px';
      bottom.style.top = Math.max(top, end - 40) + 'px';
      bottom.hidden = !getMessages().length || distance <= 80 || available < 48;

      const controls = [...list.children];
      const atBottom = messages.scrollHeight > messages.clientHeight && distance <= 4;
      if (atBottom) activeId = controls.at(-1)?.dataset.questionId;
      else {
        const nodes = messageNodes();
        const positions = controls.map(control => {
          const id = control.dataset.questionId;
          return { id, top: nodes.get(id)?.getBoundingClientRect().top ?? Infinity };
        });
        activeId = activeQuestion(positions, area.top + Math.min(80, area.height * .25));
      }
      const nextControl = controls.find(control => control.dataset.questionId === activeId);
      if (nextControl !== activeControl) {
        activeControl?.classList.remove('active');
        activeControl?.removeAttribute('aria-current');
        activeControl = nextControl;
        activeControl?.classList.add('active');
        activeControl?.setAttribute('aria-current', 'step');
        revealActive = true;
      }
      if (height !== railHeight) { railHeight = height; revealActive = true; }
      // A pointer or keyboard user browsing the rail keeps control until leaving it.
      if (revealActive && activeControl && height && !nav.matches(':hover') && !nav.contains(doc.activeElement)) {
        revealTick(activeControl);
        revealActive = false;
      }
    }
    function schedule(){if(!frame&&!destroyed)frame=win.requestAnimationFrame(update);}
    function onScroll(){if(!visible())return;if(smoothTarget!==null&&Math.abs(messages.scrollTop-smoothTarget)<2){clearTimeout(scrollTimer);smoothTarget=null;}if(smoothTarget===null)following=bottomDistance(messages)<=4;readingState=capture(messages);revealActive=true;schedule();}
    function observeMessages(){observer?.disconnect();for(const node of[messages,composer,header,...messages.children])observer?.observe(node);}
    const observer=typeof win.ResizeObserver==='function'?new win.ResizeObserver(()=>{if(!visible())return;if(hiddenReading)restoreReading(hiddenReading.state,hiddenReading.options);if(smoothTarget===null){if(following&&getMessages().length)messages.scrollTop=messages.scrollHeight;else if(readingState)restore(messages,readingState,{followBottom:false});}schedule();}):null;
    listen(list,'click',event=>{const control=event.target.closest?.('[data-question-id]');if(control)jump(control.dataset.questionId);});
    listen(list,'pointerover',event=>{const control=event.target.closest?.('[data-question-id]');if(edgeFrame===null&&control&&!control.contains(event.relatedTarget))preview(control);});
    listen(list,'pointerout',event=>{const control=event.target.closest?.('[data-question-id]');if(control&&!control.contains(event.relatedTarget))hideTip();});
    listen(list,'focusin',event=>{const control=event.target.closest?.('[data-question-id]');if(control){stopEdgeScroll();revealTick(control);preview(control);}});
    listen(list,'focusout',()=>{hideTip();schedule();});
    listen(messages,'scroll',onScroll,{passive:true});
    listen(messages,'scrollend',finishScroll);
    listen(messages,'wheel',cancelScroll,{passive:true});
    listen(messages,'pointerdown',cancelScroll);
    listen(messages,'keydown',event=>{if(['PageUp','PageDown','Home','End','ArrowUp','ArrowDown',' '].includes(event.key))cancelScroll();});
    listen(conversation,'scroll',schedule,{passive:true});
    listen(bottom,'pointerdown',event=>{if(event.button===0)event.preventDefault();});
    listen(bottom,'click',()=>{pendingQuestion=null;following=true;hideTip();scroll(Math.max(0,messages.scrollHeight-messages.clientHeight));});
    listen(nav,'pointerenter',onRailPointer);
    listen(nav,'pointermove',onRailPointer);
    listen(nav,'pointerleave',()=>{stopEdgeScroll();hideTip();schedule();});
    listen(nav,'pointerdown',event=>{stopEdgeScroll();if(event.pointerType==='mouse'&&event.button===0)event.preventDefault();});
    listen(nav,'keydown',event=>{if(event.key==='Escape'){stopEdgeScroll();hideTip();event.preventDefault();return;}if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;const items=[...list.children],at=items.indexOf(doc.activeElement);if(at<0)return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,at+(event.key==='ArrowUp'?-1:1)));items[next].focus({preventScroll:true});});
    listen(win,'blur',stopEdgeScroll);
    listen(win,'resize',schedule);
    refresh();
    return{capture:()=>{if(!visible())return hiddenReading?.state||readingState||{top:messages.scrollTop,left:messages.scrollLeft,bottom:following};const state={...capture(messages),bottom:following&&smoothTarget!==null||bottomDistance(messages)<=4,pendingQuestion};readingState=state;return state;},restore:restoreReading,refresh,schedule,jump,toBottom:()=>bottom.click(),report:()=>({activeId,following,distance:bottomDistance(messages),bottomVisible:!bottom.hidden,questions:list.children.length,scrollTarget:smoothTarget,pendingQuestion}),destroy(){destroyed=true;clearTimeout(scrollTimer);stopEdgeScroll();if(frame)win.cancelAnimationFrame(frame);observer?.disconnect();for(const remove of listeners)remove();nav.remove();bottom.remove();tip.remove();conversation.classList.remove('chat-has-question-navigation','chat-has-questions');}};
  }
  return{mount,capture,restore,activeQuestion,questionLabel,messageKey,bottomDistance,clampScrollTop};
});
