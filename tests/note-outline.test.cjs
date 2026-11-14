'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, clipboardPayload } = require('../src/shared/note-outline.js');
const { copyImageOutline } = require('../src/main/note-clipboard.cjs');

const node = (lines, children = []) => ({ lines, children });
const outline = {
  roots: [node(['导图'], [node(['答题技巧'], [node(['例题 <1>', '材料 & 解析'])]), node(['总结'])])],
  unassigned: [node(['待核对'])],
};

test('OCR clipboard exports nested editable lists with line breaks inside each item and a matching plain-text fallback', async () => {
  let items;
  const clipboard = { async write(value) { items = value; } };
  class ClipboardItem { constructor(data) { this.data = data; } }
  assert.equal(await copyImageOutline({ clipboard, ClipboardItem }, outline), true);
  assert.deepEqual(items[0].data, {
    'text/html': '<div data-inmoment-ocr-outline="1"><h2>导图</h2><ul><li>答题技巧<ul><li>例题 &lt;1&gt;<br>材料 &amp; 解析</li></ul></li><li>总结</li></ul><h3>未归类</h3><ul><li>待核对</li></ul></div>',
    'text/plain': '导图\n• 答题技巧\n  • 例题 <1>\n    材料 & 解析\n• 总结\n未归类\n• 待核对',
  });
});

test('OCR outline normalization rejects incomplete or excessive data before rendering or copying it', () => {
  const cyclic = node(['循环']);
  cyclic.children.push(cyclic);
  for (const root of [cyclic, node(Array(2)), node(['x'.repeat(100_001)]), node(['\n']), { lines: ['缺少子项'] }]) {
    assert.equal(clipboardPayload({ roots: [root], unassigned: [] }), null);
  }
  assert.equal(normalize({ roots: [], unassigned: [] }), null);
  assert.deepEqual(normalize({ roots: [node([' 甲\t乙 '])], unassigned: [] }), { roots: [node(['甲 乙'])], unassigned: [] });
});
