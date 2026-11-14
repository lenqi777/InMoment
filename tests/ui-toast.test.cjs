'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createToast}=require('../src/shared/ui-toast.js');
function fixture({exit}={}){
 const timers=new Map(),classes=new Set(['toast','hidden']);let serial=0;
 const host={hidden:false,textContent:'',attrs:{},classList:{add(...items){items.forEach(item=>classes.add(item));},remove(...items){items.forEach(item=>classes.delete(item));},contains(item){return classes.has(item);}},setAttribute(name,value){this.attrs[name]=value;}};
 const toast=createToast({document:{getElementById:()=>host},motion:{enter(){},exit:exit||(()=>Promise.resolve())},setTimer(callback,delay){const id=++serial;timers.set(id,{callback,delay});return id;},clearTimer(id){timers.delete(id);}});
 return{host,timers,toast};
}
test('temporary error feedback stays outside layout and expires with accessible severity',async()=>{
 const f=fixture();f.toast.show('这条记录没有可返回的窗口。',{tone:'error'});
 assert.equal(f.host.attrs.role,'alert');assert.equal(f.host.attrs['data-tone'],'error');assert.equal(f.host.classList.contains('hidden'),false);assert.equal(f.host.textContent,'这条记录没有可返回的窗口。');
 const timer=[...f.timers.values()][0];assert.equal(timer.delay,5000);timer.callback();await Promise.resolve();assert.equal(f.host.hidden,true);assert.equal(f.host.textContent,'');
});
test('a new notification invalidates an old exit and retains literal text content',async()=>{
 let complete;const f=fixture({exit:()=>new Promise(resolve=>{complete=resolve;})});f.toast.show('旧提示');const closing=f.toast.hide();
 f.toast.show('<img onerror=alert(1)>',{tone:'success',durationMs:2000});complete();await closing;
 assert.equal(f.host.hidden,false);assert.equal(f.host.textContent,'<img onerror=alert(1)>');assert.equal(f.host.attrs.role,'status');assert.equal(f.host.attrs['data-tone'],'success');assert.equal([...f.timers.values()].at(-1).delay,2000);
});
