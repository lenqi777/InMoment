'use strict';
((scope,factory)=>{const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else scope.InMomentScissors=api;})(typeof window==='object'?window:globalThis,()=>{
  const NS='http://www.w3.org/2000/svg';
  function createCutCycle({animate,cancel,reduced=()=>false,disabled=()=>false}) {
    let entered=false;
    return {
      enter(){if(entered)return;entered=true;if(!disabled()&&!reduced())animate();},
      leave(){entered=false;cancel();},
      focus(){if(!entered&&!disabled()&&!reduced())animate();},
      reset(){entered=false;cancel();}
    };
  }
  function mount(button) {
    const doc=button.ownerDocument,win=doc.defaultView;
    const node=(name,attrs)=>{const element=doc.createElementNS(NS,name);for(const[key,value]of Object.entries(attrs||{}))element.setAttribute(key,String(value));return element;};
    const svg=node('svg',{viewBox:'0 0 32 32','aria-hidden':'true',focusable:'false',class:'brand-scissors'});
    const upper=node('g',{class:'brand-scissors-arm'}),lower=node('g',{class:'brand-scissors-arm'});
    for(const[arm,y,angle,tip]of[[upper,24,-25,5.8],[lower,8,25,26.2]]) {
      arm.append(node('ellipse',{cx:7,cy:y,rx:4.3,ry:3.5,transform:`rotate(${angle} 7 ${y})`,fill:'none',stroke:'currentColor','stroke-width':2.2}));
      arm.append(node('path',{d:`M10.2 ${y===24?21.2:10.8}L25.8 ${tip}`,fill:'none',stroke:'currentColor','stroke-width':2.2,'stroke-linecap':'round'}));
    }
    upper.append(node('path',{d:'M4.1 23.8C5.5 22.4 7.6 22.1 9.3 23.1',fill:'none',stroke:'var(--color-brand-accent, #D9B57A)','stroke-width':1.2,'stroke-linecap':'round'}));
    svg.append(lower,upper,node('circle',{cx:16,cy:16,r:2.5,fill:'currentColor'}),node('circle',{cx:16,cy:16,r:1.15,fill:'var(--color-brand-accent, #D9B57A)'}));
    button.replaceChildren(svg);
    const media=win.matchMedia('(prefers-reduced-motion: reduce)');let animations=[];
    const cancel=()=>{animations.forEach(animation=>animation.cancel());animations=[];};
    const cycle=createCutCycle({disabled:()=>button.disabled||button.getAttribute('aria-disabled')==='true',reduced:()=>media.matches,cancel,animate(){
      cancel();animations=[upper,lower].map((arm,index)=>arm.animate([{transform:'rotate(0deg)'},{transform:`rotate(${index===0?44:-44}deg)`,offset:.43},{transform:'rotate(0deg)'}],{duration:360,easing:'cubic-bezier(.3,.7,.3,1)'}));
    }});
    const enter=()=>cycle.enter(),leave=()=>cycle.leave(),focus=()=>cycle.focus(),blur=()=>{if(!button.matches(':hover'))cycle.reset();},reduce=()=>{if(media.matches)cycle.reset();};
    button.addEventListener('mouseenter',enter);button.addEventListener('mouseleave',leave);button.addEventListener('focus',focus);button.addEventListener('blur',blur);media.addEventListener('change',reduce);
    return {reset:()=>cycle.reset(),destroy(){cycle.reset();button.removeEventListener('mouseenter',enter);button.removeEventListener('mouseleave',leave);button.removeEventListener('focus',focus);button.removeEventListener('blur',blur);media.removeEventListener('change',reduce);}};
  }
  return {mount,createCutCycle};
});
