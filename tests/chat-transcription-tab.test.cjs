'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ChatView}=require('../src/shared/chat-view.js');
function harness(t,{candidate='转写原文',input='',active='input'}={}){
  const original=global.document,originalStyle=global.getComputedStyle;global.document={activeElement:null,querySelector(){return null;}};global.getComputedStyle=()=>({visibility:'visible'});t.after(()=>{global.document=original;global.getComputedStyle=originalStyle;});
  const box={value:input,selectionStart:0,selectionEnd:0,scrollHeight:420,scrollTop:0,focus(){global.document.activeElement=this;},setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;},matches(){return true;}};
  const microphone={matches(){return false;}};global.document.activeElement=active==='input'?box:microphone;
  const hidden={classList:{contains(){return true;}}};const view=Object.assign(Object.create(ChatView.prototype),{currentId:'one',root:{contains:()=>true,getClientRects:()=>[{}]},input:box,voiceButton:microphone,chat:{candidate},imageDialog:{open:false},referencePanel:hidden,actionPanel:hidden,history:{contains:()=>false},composing:false,voiceStatus:'ready',editRevision:0,transcriptionEntry:Boolean(candidate),updateGhost(){},updateSend(){},resizeInput(){},report(message){this.message=message;},flush(){this.flushed=true;return Promise.resolve();},run(action){return action();}});
  function key(overrides={}){const event={key:'Tab',target:box,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...overrides};view.adoptCandidate(event);return event;}
  return{view,input:box,microphone,key};
}
test('plain Tab adopts a complete long candidate and a second Tab keeps the caret in the input',t=>{
  const text='中'.repeat(2000),h=harness(t,{candidate:text});assert(h.key().prevented);assert.equal(h.input.value,text);assert.equal(h.input.selectionEnd,2000);assert.equal(h.view.flushed,true);
  h.input.selectionStart=h.input.selectionEnd=0;assert(h.key().prevented);assert.equal(h.input.selectionStart,0);assert.equal(global.document.activeElement,h.input);assert.equal(h.view.message,'');
});
test('Tab from microphone focus adopts a click-hidden candidate rather than moving to another control',t=>{
  const h=harness(t,{active:'microphone'});h.view.dismissed=true;assert(h.key({target:h.microphone}).prevented);assert.equal(h.input.value,'转写原文');assert.equal(global.document.activeElement,h.input);
});
test('record preparation and transcription keep Tab in input without adopting an old candidate',t=>{
  const h=harness(t,{active:'microphone'});for(const phase of['preparing','recording','transcribing']){h.view.voiceStatus=phase;h.input.value='';global.document.activeElement=h.microphone;assert(h.key({target:h.microphone}).prevented);assert.equal(h.input.value,'');assert.equal(global.document.activeElement,h.input);}
});
test('visible chat plain Tab always returns to input while IME and modified Tab retain native meanings',t=>{
  const h=harness(t,{candidate:''});h.view.transcriptionEntry=false;assert.equal(h.key().prevented,true);h.view.chat.candidate='候选';h.view.transcriptionEntry=true;
  for(const modifier of['shiftKey','ctrlKey','altKey','metaKey','isComposing'])assert.equal(h.key({[modifier]:true}).prevented,undefined,modifier);
  h.view.composing=true;assert.equal(h.key().prevented,undefined);
});
test('explicit menu, image dialog and other text fields keep their own Tab navigation',t=>{
  const h=harness(t);h.view.addMenuOpen=true;assert.equal(h.key().prevented,undefined);h.view.addMenuOpen=false;
  global.document.querySelector = selector => selector.includes('dialog[open]') ? {} : null;
  assert.equal(h.key().prevented,undefined);global.document.querySelector=()=>null;
  assert.equal(h.key({target:{matches:()=>true}}).prevented,undefined);
});
test('first Tab from BODY adopts text and the next Tab cannot focus an attachment',t=>{
  const h=harness(t);h.view.root.contains=()=>false;const body={matches:()=>false};global.document.activeElement=body;assert(h.key({target:body}).prevented);assert.equal(h.input.value,'转写原文');assert.equal(global.document.activeElement,h.input);assert(h.key({target:h.microphone}).prevented);assert.equal(global.document.activeElement,h.input);
});
test('hidden main chat does not capture Tab on another page',t=>{const h=harness(t);h.view.root.getClientRects=()=>[];assert.equal(h.key().prevented,undefined);});
test('opening floating chat keeps BODY focus until the user adopts or clicks',async t=>{
  const h=harness(t),body={matches:()=>false};global.document.body=body;global.document.activeElement=body;Object.assign(h.view,{floating:true,request:0,selected:new Set(),closeImage(){},togglePanel(){},setList(){},setChat(chat){this.chat=chat;},invoke:async method=>method==='chat:list'?[]:{id:'opened',candidate:'候选'},flush:async()=>{}});await h.view.open('opened');assert.equal(global.document.activeElement,body);h.view.chat.candidate='候选';assert(h.key({target:body}).prevented);assert.equal(global.document.activeElement,h.input);assert.equal(h.input.value,'候选');
});
test('late transcription events never transfer BODY or microphone focus into the editor',t=>{
  const h=harness(t),body={matches:()=>false};global.document.body=body;Object.assign(h.microphone,{dataset:{},setAttribute(){},classList:{toggle(){}}});for(const active of[body,h.microphone]){global.document.activeElement=active;for(const status of['recording','transcribing','ready']){h.view.handleEvent({type:'chatVoice',id:h.view.currentId,status});assert.equal(global.document.activeElement,active);}}assert.equal(h.input.value,'');assert.equal(h.view.chat.candidate,'转写原文');
});
function frames(t){const original=[global.requestAnimationFrame,global.cancelAnimationFrame];let next=0;const pending=new Map();global.requestAnimationFrame=fn=>{pending.set(++next,fn);return next;};global.cancelAnimationFrame=id=>pending.delete(id);t.after(()=>{[global.requestAnimationFrame,global.cancelAnimationFrame]=original;});return()=>{for(const[id,fn]of[...pending]){pending.delete(id);fn();}};}
test('explicit caret edge reveals after layout and coalesces a newer Home command',t=>{
  const h=harness(t,{input:'正文'}),flush=frames(t);h.view.currentId='one';h.input.selectionStart=h.input.selectionEnd=2;h.view.resizeInput=()=>{h.input.scrollHeight=780;};h.view.scheduleCaretReveal('end');flush();assert.equal(h.input.scrollTop,780);
  h.view.scheduleCaretReveal('end');h.input.selectionStart=h.input.selectionEnd=0;h.view.scheduleCaretReveal('start');flush();assert.equal(h.input.scrollTop,0);
});
test('queued caret reveal cannot scroll a switched chat or a newly edited draft',t=>{
  const h=harness(t,{input:'正文'}),flush=frames(t);h.view.currentId='one';h.input.selectionStart=h.input.selectionEnd=2;h.view.scheduleCaretReveal('end');h.view.currentId='two';flush();assert.equal(h.input.scrollTop,0);
  h.view.scheduleCaretReveal('end');h.input.value='新正文';h.input.selectionStart=h.input.selectionEnd=3;flush();assert.equal(h.input.scrollTop,0);
});
test('queued caret reveal leaves another control focus and manual scroll unchanged',t=>{
  const h=harness(t,{input:'正文'}),flush=frames(t);h.view.currentId='one';h.input.selectionStart=h.input.selectionEnd=2;h.input.scrollTop=99;h.view.scheduleCaretReveal('end');global.document.activeElement=h.microphone;flush();assert.equal(h.input.scrollTop,99);
});
