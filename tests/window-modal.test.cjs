'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {mainChrome,modalChrome,imageViewerChrome,setWindowModalState}=require('../src/main/window-ui.cjs');
function fakeWindow(){let flags={minimizable:false,maximizable:true,closable:true},chrome=mainChrome.titleBarOverlay;const calls=[];return{calls,get flags(){return flags;},get chrome(){return chrome;},isDestroyed:()=>false,isMinimizable:()=>flags.minimizable,isMaximizable:()=>flags.maximizable,isClosable:()=>flags.closable,setMinimizable(value){flags.minimizable=value;calls.push(['minimize',value]);},setMaximizable(value){flags.maximizable=value;calls.push(['maximize',value]);},setClosable(value){flags.closable=value;calls.push(['close',value]);},setTitleBarOverlay(value){chrome=value;calls.push(['chrome',value]);}};}
test('modal caption tint blocks native controls and restores their exact previous flags',()=>{const window=fakeWindow();setWindowModalState(window,true);assert.deepEqual(window.flags,{minimizable:false,maximizable:false,closable:false});assert.equal(window.chrome,modalChrome);const count=window.calls.length;setWindowModalState(window,true);assert.equal(window.calls.length,count);setWindowModalState(window,false);assert.deepEqual(window.flags,{minimizable:false,maximizable:true,closable:true});assert.equal(window.chrome,mainChrome.titleBarOverlay);setWindowModalState(window,false);assert.equal(window.calls.length,count*2);});
test('modal state validates booleans and safely ignores a destroyed window',()=>{const window=fakeWindow();assert.throws(()=>setWindowModalState(window,'true'),/布尔/);assert.equal(window.calls.length,0);window.isDestroyed=()=>true;assert.deepEqual(setWindowModalState(window,true),{active:false});assert.equal(window.calls.length,0);});
test('the image viewer hides native caption paint without re-enabling native controls', () => {
  const window = fakeWindow();
  setWindowModalState(window, true);
  setWindowModalState(window, true, true);
  assert.equal(window.chrome, imageViewerChrome);
  assert.deepEqual(window.flags, { minimizable: false, maximizable: false, closable: false });
  setWindowModalState(window, true);
  assert.equal(window.chrome, modalChrome);
  setWindowModalState(window, false);
  assert.equal(window.chrome, mainChrome.titleBarOverlay);
  assert.deepEqual(window.flags, { minimizable: false, maximizable: true, closable: true });
});
test('modal chrome follows regular dialogs, viewer snapshots, exit scrims, and focus', () => {
  let modal = false, scrim = false, image = false, changed;
  const sent = [], listeners = {};
  const context = {
    MutationObserver: class { constructor(callback) { changed = callback; } observe() {} },
    document: { documentElement: {}, querySelector(selector) { return (selector.includes('note-image-viewer') ? image : modal || scrim) ? {} : null; } },
    window: {
      inmoment: { invoke(method, params) { sent.push({ method, active: params.active, imageViewer: params.imageViewer }); return Promise.resolve(); } },
      addEventListener(name, callback) { listeners[name] = callback; },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/modal-chrome.js'), 'utf8'), context);
  assert.deepEqual(sent, [{ method: 'window:modalState', active: false, imageViewer: false }]);
  modal = true; changed(); assert.equal(sent.at(-1).active, true);
  image = true; changed(); assert.equal(sent.at(-1).imageViewer, true);
  modal = false; changed(); assert.equal(sent.length, 3);
  image = false; scrim = true; changed(); assert.equal(sent.at(-1).imageViewer, false);
  assert.equal(sent.at(-1).active, true);
  scrim = false; changed(); assert.equal(sent.at(-1).active, false);
  const count = sent.length; changed(); assert.equal(sent.length, count);
  modal = true; listeners.focus(); assert.equal(sent.at(-1).active, true);
  listeners.pagehide(); assert.equal(sent.at(-1).active, false);
});
