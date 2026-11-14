'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { growChatBounds, applyChatBounds, initialChatBounds, minimumChatWidth, CHAT_GUTTER, CHAT_INITIAL_SIZE } = require('../src/main/chat-window-layout.cjs');
const work = { x: 0, y: 0, width: 1920, height: 1080 };
const initial = { x: 100, y: 300, width: 520, height: 680 };

test('long chat input grows upward at the same bottom edge and respects the work area', () => {
  const result = growChatBounds(initial, work, 900);
  assert.deepEqual(result.bounds, { x: 100, y: 80, width: 520, height: 900 });
  assert.equal(result.changed, true);
  const capped = growChatBounds(result.bounds, work, 100000);
  assert.deepEqual(capped.bounds, { x: 100, y: 12, width: 520, height: 1056 });
  assert.equal(capped.maxHeight, 1056);
  assert.equal(growChatBounds(capped.bounds, work, 100000).changed, false);
});

test('shortened input preserves a larger user window and does not move it', () => {
  const manual = { x: 250, y: 40, width: 700, height: 900 };
  const result = growChatBounds(manual, work, 500);
  assert.deepEqual(result.bounds, manual);
  assert.equal(result.changed, false);
});

test('secondary monitors, negative coordinates and short work areas remain bounded', () => {
  const secondary = { x: -1280, y: -120, width: 1280, height: 720 };
  const result = growChatBounds({ x: -560, y: 0, width: 520, height: 680 }, secondary, 2000);
  assert.equal(result.bounds.y, -108);
  assert.equal(result.bounds.height, 696);
  assert.ok(result.bounds.x >= secondary.x + 12 && result.bounds.x + result.bounds.width <= -12);
  const small = growChatBounds({ x: 10, y: 20, width: 520, height: 680 }, { x: 0, y: 0, width: 480, height: 400 }, 900);
  assert.deepEqual(small.bounds, { x: 12, y: 12, width: 456, height: 376 });
});

test('nonfinite or invalid height cannot resize a native window', () => {
  for (const height of [NaN, Infinity, -1, 0, undefined, '900']) assert.throws(() => growChatBounds(initial, work, height), /高度无效/u);
});

test('fractional Windows size drift is corrected without changing the target width', () => {
  let bounds = { x: 100, y: 100, width: 402, height: 661 }, calls = 0;
  const window = { getBounds: () => ({ ...bounds }), setBounds(request) { calls++; bounds = { ...request, width: request.width + 2, height: request.height + 1 }; } };
  const target = { x: 100, y: 12, width: 402, height: 1080 };
  const result = applyChatBounds(window, target);
  assert.deepEqual(result.bounds, target); assert.equal(calls, 2);
  assert.equal(applyChatBounds(window, target).changed, false); assert.equal(calls, 2);
});

test('one DIP rounding settles without repeated native writes and corrections have a strict limit', () => {
  let calls = 0;
  const stable = { getBounds: () => ({ x: 100, y: 12, width: 402, height: 1081 }), setBounds() { calls++; } };
  assert.equal(applyChatBounds(stable, { x: 100, y: 12, width: 402, height: 1080 }).changed, false);
  assert.equal(calls, 0);
  const constrained = { getBounds: () => ({ x: 100, y: 12, width: 500, height: 700 }), setBounds() { calls++; } };
  applyChatBounds(constrained, { x: 100, y: 12, width: 402, height: 1080 });
  assert.equal(calls, 3);
});

test('opening chat expands above the source pill with its left and bottom edges fixed when space permits',()=>{
  for(const [y,height]of[[404,452],[500,548],[800,584]]){
    const source=Object.freeze({x:240,y,width:260,height:48}),bounds=initialChatBounds(source,work);
    assert.equal(bounds.x+CHAT_GUTTER,source.x);assert.equal(bounds.y+bounds.height-CHAT_GUTTER,source.y+source.height);assert.equal(bounds.height,height);assert.equal(bounds.width,464);
  }
});

test('native gutter preserves a440x560 white surface with equal twelve-pixel shadow space',()=>{
  const bounds=initialChatBounds({x:240,y:900,width:233,height:48},work);
  assert.equal(bounds.width-CHAT_GUTTER*2,440);assert.equal(bounds.height-CHAT_GUTTER*2,560);assert.deepEqual(CHAT_INITIAL_SIZE,{width:464,height:584});
});

test('initial chat clamps at top and right edges and on negative-coordinate monitors while containing the pill',()=>{
  const cases=[
    {source:{x:200,y:16,width:260,height:48},area:work},
    {source:{x:1636,y:700,width:260,height:48},area:work},
    {source:{x:-1800,y:-20,width:260,height:48},area:{x:-1920,y:-120,width:1280,height:720}},
  ];
  for(const{source,area}of cases){
    const before={...source},bounds=initialChatBounds(source,area);
    assert.ok(bounds.x>=area.x+12&&bounds.y>=area.y+12);
    assert.ok(bounds.x+bounds.width<=area.x+area.width-12&&bounds.y+bounds.height<=area.y+area.height-12);
    assert.ok(bounds.x<=source.x&&bounds.y<=source.y&&bounds.x+bounds.width>=source.x+source.width&&bounds.y+bounds.height>=source.y+source.height);
    assert.deepEqual(source,before);
  }
});

test('a small work area bounds initial chat dimensions and retains the original pill inside the surface',()=>{
  const area=Object.freeze({x:40,y:100,width:340,height:360}),source=Object.freeze({x:64,y:350,width:260,height:48});
  const bounds=initialChatBounds(source,area);assert.deepEqual(bounds,{x:52,y:112,width:316,height:336});
  assert.ok(bounds.x<=source.x&&bounds.y<=source.y&&bounds.x+bounds.width>=source.x+source.width&&bounds.y+bounds.height>=source.y+source.height);
  assert.deepEqual(initialChatBounds(source,area),bounds,'placement derives solely from the source pill and work area');
});

test('zoom-aware minimum provides280CSS pixels while preserving wide windows and the bottom anchor',()=>{
  assert.equal(minimumChatWidth(1),384);assert.equal(minimumChatWidth(1.25),384);assert.equal(minimumChatWidth(2),560);
  const narrow={x:100,y:200,width:384,height:584};
  const grown=growChatBounds(narrow,work,200,12,minimumChatWidth(2));
  assert.deepEqual(grown.bounds,{...narrow,width:560});assert.equal(grown.bounds.width/2,280);
  assert.equal(growChatBounds(grown.bounds,work,200,12,minimumChatWidth(2)).changed,false);
  const wide={...narrow,width:800};assert.deepEqual(growChatBounds(wide,work,200,12,minimumChatWidth(2)).bounds,wide);
  const source={x:240,y:900,width:233,height:48},opened=initialChatBounds(source,work,2);
  assert.equal(opened.width,560);assert.equal(opened.x+12,source.x);assert.equal(opened.y+opened.height-12,source.y+source.height);
});

test('zoom-aware minimum clamps to a small work area without moving outside it',()=>{
  const area={x:-500,y:100,width:480,height:400},source={x:-450,y:350,width:233,height:48};
  const opened=initialChatBounds(source,area,2);assert.equal(opened.width,456);assert.ok(opened.x>=-488&&opened.x+opened.width<=-32);
  const grown=growChatBounds({x:-450,y:120,width:384,height:300},area,400,12,minimumChatWidth(2));
  assert.equal(grown.bounds.width,456);assert.equal(grown.bounds.height,376);assert.equal(growChatBounds(grown.bounds,area,400,12,minimumChatWidth(2)).changed,false);
  for(const zoom of[0,-1,NaN,Infinity])assert.throws(()=>minimumChatWidth(zoom),/缩放比例无效/u);
});
