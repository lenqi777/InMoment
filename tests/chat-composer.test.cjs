'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { candidateState, acceptsCandidate, PLACEHOLDER } = require('../src/shared/chat-view.js');

test('a transcription remains a candidate until the user adopts it', () => {
  const state = { input:'', candidate:'这个概念是什么意思？' };
  assert.equal(candidateState(state).visible, true);
  assert.equal(acceptsCandidate({key:'Enter'},state), false);
  assert.equal(acceptsCandidate({key:'Tab'},state), true);
  assert.equal(candidateState({...state,input:state.candidate}).visible,false);
  assert.equal(candidateState({...state,input:'我的问题'}).visible,false);
});
test('click and focus retain the candidate while IME and modifiers keep their meanings', () => {
  const state = { input:'',candidate:'刚才的录音' };
  assert.equal(acceptsCandidate({key:'Tab'},{...state,dismissed:true}),true);
  assert.equal(acceptsCandidate({key:'Tab'},{...state,composing:true}),false);
  for (const modifier of ['shiftKey','ctrlKey','altKey','metaKey','isComposing']) assert.equal(acceptsCandidate({key:'Tab',[modifier]:true},state),false,modifier);
  assert.equal(acceptsCandidate({key:'Tab'},{...state,input:' '}),false);
});
test('punctuation-only and symbol-only legacy candidates use the ordinary placeholder',()=>{
  for(const candidate of['  ','。？！……','... , !','😊★—'])assert.deepEqual(candidateState({candidate}),{visible:false,text:PLACEHOLDER});
  for(const candidate of['问题？','你好','what?','123'])assert.equal(candidateState({candidate}).visible,true);
  assert.equal(candidateState({input:'？！',candidate:'候选'}).visible,false);
});
test('empty input restores the candidate and no candidate restores the normal prompt', () => {
  assert.equal(candidateState({input:'',candidate:'转写'}).visible,true);
  assert.deepEqual(candidateState({input:'',candidate:''}),{visible:false,text:PLACEHOLDER});
  assert.equal(PLACEHOLDER,'你有什么想法～');
});
