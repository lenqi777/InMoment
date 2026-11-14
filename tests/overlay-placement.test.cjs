'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {OverlayPlacement,clampOverlayPosition}=require('../src/main/overlay-placement.cjs');
function fixture(options={}){let cursor={x:200,y:120},bounds={x:0,y:0,width:400,height:440};const writes=[],work={x:0,y:0,width:1920,height:1080};const screen={getCursorScreenPoint(){return cursor;},screenToDipPoint(point){return{x:point.x/1.5,y:point.y/1.5};},getDisplayNearestPoint(){return{workArea:work};}};const window={isDestroyed:()=>false,getBounds:()=>({...bounds}),setPosition(x,y){writes.push({x,y});bounds={...bounds,x,y};}};return{placement:new OverlayPlacement({getWindow:()=>window,screen,...options}),writes,get bounds(){return bounds;},set cursor(value){cursor=value;},work};}

test('hint headroom preserves the original visual logo anchor away from work-area edges',()=>{const original=fixture(),hint=fixture({offsetY:-4});original.placement.show('old');hint.placement.show('new');assert.equal(original.bounds.y+19,hint.bounds.y+39);assert.equal(original.bounds.x,hint.bounds.x);hint.cursor={x:900,y:600};hint.placement.show('new');assert.equal(original.bounds.y+19,hint.bounds.y+39);});
test('one draft keeps its original position through twenty pause, prepare, error and continuation cycles',()=>{const f=fixture();f.placement.show('draft-a');const first={...f.bounds};for(let i=0;i<20;i++){f.cursor={x:f.bounds.x+24,y:f.bounds.y+24};for(const state of['paused','preparing','recording','error'])f.placement.show('draft-a');assert.deepEqual(f.bounds,first);}assert.equal(f.writes.length,1);f.placement.cancelPreview();f.cursor={x:1200,y:900};f.placement.show('draft-a');assert.deepEqual(f.bounds,first);assert.equal(f.writes.length,1);});
test('a hold preview binds its converted physical point to the first draft without repositioning',()=>{const f=fixture();f.placement.preview({x:900,y:450});assert.deepEqual(f.writes,[{x:624,y:316}]);f.cursor={x:1500,y:800};f.placement.show('draft-a');f.placement.show('draft-a');assert.equal(f.writes.length,1);f.placement.show('draft-b');assert.equal(f.writes.length,2);assert.deepEqual(f.writes[1],{x:1508,y:628});});
test('cancelling a preview permits a later fresh manual draft to choose a new anchor',()=>{const f=fixture();f.placement.preview({x:900,y:450});f.placement.cancelPreview();f.cursor={x:40,y:60};f.placement.show('manual-new');assert.deepEqual(f.writes.at(-1),{x:64,y:76});});
test('hiding an active draft before its first show retains the preview anchor',()=>{const f=fixture();f.placement.preview({x:900,y:450});const first={...f.bounds};f.placement.cancelPreview('draft-preparing');f.cursor={x:1200,y:800};f.placement.show('draft-preparing');assert.deepEqual(f.bounds,first);assert.equal(f.writes.length,1);});
test('fresh placement retains work-area margins on negative and off-screen coordinates',()=>{const size={width:400,height:440},work={x:-1920,y:-200,width:1920,height:1080};assert.deepEqual(clampOverlayPosition({x:-10000,y:-10000},size,work),{x:-1908,y:-188});assert.deepEqual(clampOverlayPosition({x:500,y:5000},size,work),{x:-412,y:428});const f=fixture();f.work.x=-1920;f.cursor={x:-1800,y:300};f.placement.show('second-monitor');const first={...f.bounds};f.cursor={x:800,y:200};f.placement.show('second-monitor');assert.deepEqual(f.bounds,first);});

test('screenshot overlay uses the chosen display and clips only its visible, zoomed hit area', () => {
  const workArea = { x: -1700, y: -250, width: 1700, height: 950 };
  const shapes = [], levels = [];
  let bounds = { x: 40, y: 80, width: 400, height: 440 };
  const window = {
    getBounds: () => bounds, isDestroyed: () => false, isVisible: () => true,
    webContents: { getZoomFactor: () => 1.25 },
    setPosition(x, y) { bounds = { ...bounds, x, y }; },
    setShape(rects) { shapes.push(rects); },
    setAlwaysOnTop(_enabled, level) { levels.push(level); },
  };
  const screen = {
    getDisplayMatching: () => ({ workArea }),
    getDisplayNearestPoint: () => ({ workArea }),
  };
  const placement = new OverlayPlacement({ getWindow: () => window, screen });
  const display = { bounds: { ...workArea }, scaleFactor: 1.5 };
  const anchor = {
    toolbar: { x: -620, y: 240, width: 520, height: 48 },
    selection: { x: -520, y: -70, width: 420, height: 290 },
  };
  placement.setEditorActive(false);
  assert.deepEqual(shapes.at(-1), []);
  placement.show('region-draft', display, anchor);
  assert.deepEqual({ x: bounds.x, y: bounds.y }, { x: -404, y: 262 });
  placement.setEditorActive(true);
  assert.deepEqual(shapes.at(-1), [{ x: 11, y: 36, width: 293, height: 61 }]);
  placement.setSurface({ x: 9, y: 29, width: 260, height: 48 });
  assert.deepEqual(shapes.at(-1), [{ x: 11, y: 36, width: 326, height: 61 }]);
  window.setPosition(-90, 590);
  placement.setSurface({ x: 9, y: 29, width: 260, height: 140 });
  const moved = { ...bounds };
  assert.ok(bounds.x + 11 + 326 <= -12);
  assert.ok(bounds.y + 36 + 176 <= 688);
  placement.show('region-draft', display, anchor);
  assert.deepEqual(bounds, moved);
  placement.setEditorActive(false);
  assert.deepEqual(shapes.at(-1), []);
  const ordinaryLevel = process.platform === 'win32' ? 'screen-saver' : 'floating';
  assert.deepEqual(levels, [ordinaryLevel, 'screen-saver', ordinaryLevel]);
});

test('a screenshot toolbar near the taskbar places the capsule clear of the toolbar and selection', () => {
  const workArea = { x: 0, y: 0, width: 1200, height: 800 };
  const positions = [];
  const window = {
    isDestroyed: () => false,
    getBounds: () => ({ width: 400, height: 440 }),
    webContents: { getZoomFactor: () => 1 },
    setPosition: (x, y) => positions.push({ x, y }),
  };
  const screen = { getDisplayMatching: () => ({ workArea }) };
  const placement = new OverlayPlacement({ getWindow: () => window, screen });
  const display = { bounds: { ...workArea, height: 840 } };
  placement.show('near-taskbar', display, {
    toolbar: { x: 660, y: 774, width: 520, height: 48 },
    selection: { x: 900, y: 200, width: 280, height: 562 },
  });
  assert.deepEqual(positions, [{ x: 937, y: 113 }]);
});
