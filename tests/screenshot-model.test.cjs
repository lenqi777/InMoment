'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EditorModel,rectangle,paint}=require('../src/shared/screenshot-model.js');
test('crop uses bounded integer natural-image pixels in either drag direction',()=>{
  assert.deepEqual(rectangle({x:700.8,y:500.3},{x:-12,y:10.2},640,480),{x:0,y:10,width:640,height:470});
  const model=new EditorModel(640,480);assert.equal(model.select({x:10,y:10,width:0,height:1}),false);assert.equal(model.selection,null);
  assert.throws(()=>new EditorModel(20000,20000),/尺寸/u);
});
test('undo and redo restore selected crop and every annotation including multiline text',()=>{
  const model=new EditorModel(800,600);model.select({x:100,y:100,width:400,height:300});
  model.add({type:'rectangle',start:{x:120,y:130},end:{x:400,y:300},color:'#b42318',width:4});
  model.add({type:'text',x:150,y:160,text:'原文\n第二行',color:'#256d49',width:3,fontSize:20});const annotated=model.snapshot();
  model.select({x:0,y:0,width:800,height:600});model.undo();assert.deepEqual(model.snapshot(),annotated);
  model.undo();assert.equal(model.items.length,1);model.redo();assert.deepEqual(model.snapshot(),annotated);
  model.undo();model.undo();assert.equal(model.items.length,0);model.undo();assert.equal(model.selection,null);
  model.redo();assert.equal(model.selection.x,100);
});
test('new edits clear redo while points and styles are copied and kept inside the crop',()=>{
  const model=new EditorModel(800,600);model.select({x:100,y:100,width:200,height:100});const points=[{x:0,y:50},{x:900,y:700}];
  model.add({type:'pen',points,color:'#1768b4',width:6});points[0].x=150;
  assert.deepEqual(model.items[0].points,[{x:100,y:100},{x:300,y:200}]);
  model.undo();assert.equal(model.future.length,1);model.add({type:'ellipse',start:{x:120,y:120},end:{x:180,y:180},width:3,color:'bad'});
  assert.equal(model.future.length,0);assert.equal(model.items[0].color,'#256d49');
});
test('blank text and zero-length geometry do not add undo steps; a pen dot remains a valid mark',()=>{
  const model=new EditorModel(500,500);model.select({x:0,y:0,width:300,height:300});
  assert.equal(model.add({type:'text',x:10,y:10,text:' \n ',fontSize:20}),false);
  assert.equal(model.add({type:'arrow',start:{x:10,y:10},end:{x:10,y:10}}),false);assert.equal(model.history.length,1);
  assert.equal(model.add({type:'pen',points:[{x:10,y:10}],width:2,color:'#b42318'}),true);assert.equal(model.history.length,2);
});
test('highlighter preserves the source beneath its stroke and restores canvas opacity', () => {
  const model = new EditorModel(100, 100);
  model.select({ x: 10, y: 10, width: 50, height: 50 });
  assert.equal(model.add({ type: 'highlighter', color: '#d5a72c', width: 12, points: [{ x: 0, y: 20 }, { x: 80, y: 20 }] }), true);
  const [item] = model.items;
  assert.deepEqual(item.points, [{ x: 10, y: 20 }, { x: 60, y: 20 }]);
  const alphas = [];
  let savedAlpha;
  const context = {
    globalAlpha: 1, save() { savedAlpha = this.globalAlpha; }, restore() { this.globalAlpha = savedAlpha; },
    translate() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { alphas.push(this.globalAlpha); }
  };
  paint(context, item);
  paint(context, { ...item, type: 'pen' });
  assert.deepEqual(alphas, [.32, 1]);
  assert.equal(model.undo(), true);
  assert.equal(model.redo(), true);
  assert.deepEqual(model.items, [item]);
});
