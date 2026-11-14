'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {clean,limits}=require('../src/shared/chat-quote-text.js');

test('quote cleanup flattens lines, strips markdown prefixes and enclosing decorations, and keeps word spaces',()=>{
  assert.equal(clean(' > 【 - First    English sentence. 】\r\n> （第二句，含逗号、顿号？感叹！）\n\n• {Keep   these words!}'),'First English sentence. 第二句，含逗号、顿号？感叹！ Keep these words!');
  assert.equal(clean('> **引用的重点**\n> > - 下一句。'),'引用的重点 下一句。');
});

test('ordinary punctuation, numbers, formulas and URL punctuation remain meaningful',()=>{
  const body='f(x) = (a+b)*2，x <= -3.5；链接 https://example.com/a_(v2)?q=(a+b)&n=-2#part 保留。';
  assert.equal(clean('> '+body),body);assert.equal(clean('- 3.14 + x'),'- 3.14 + x');assert.equal(clean('* x^2 + 1'),'* x^2 + 1');assert.equal(clean('(a) + (b)'),'(a) + (b)');assert.equal(clean('(https://example.com/a(b))'),'https://example.com/a(b)');
});

test('empty wrappers and decorative separators vanish while their inner prose remains',()=>{
  assert.equal(clean('{}\n()\n【】\n---\n✦\n  '),'');assert.equal(clean('“{（Inner prose）}”'),'Inner prose');assert.equal(clean('有（括号）与 {x: 1} 的正文。'),'有（括号）与 {x: 1} 的正文。');
});

test('cleanup is idempotent for ordinary quotes and does not mutate its source',()=>{
  const source='> 【 - 一个想法。】\n> “Two  English words”';const once=clean(source);assert.equal(clean(once),once);assert.equal(source,'> 【 - 一个想法。】\n> “Two  English words”');assert.equal(clean(null),'');assert.deepEqual(limits,{quotes:8,perQuote:10000,total:40000});
});

test('browser UMD and Node share the same cleanup rules',()=>{
  const window={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/shared/chat-quote-text.js'),'utf8'),{window});assert.equal(window.InMomentQuoteText.clean('> (Hello   world.)'),clean('> (Hello   world.)'));assert.equal(window.InMomentQuoteText.limits.total,40000);
});
