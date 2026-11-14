'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { target, preview } = require('../src/shared/note-list-expansion.js');

test('a partial selection appends distinct bullets after the complete list', () => {
  const list = '- 解释这张图里某个区域的作用\n- 帮你看看这段设计或文案有没有问题\n- 根据截图帮你提炼需求或建议';
  const next = '\n\n随后记录结论。';
  const value = list + next;
  const expansion = target({ value, end: list.indexOf('设计'), instruction: '再补充几条' });
  assert.equal(expansion.insertAt, list.length);
  const items = ['帮你看看这段', '根据截图帮你提炼需求或建议。', '根据截图帮你提炼需求或建议设计或文案有没有问题', '补上验收步骤', '- 列出极限窗口尺寸', '补上验收步骤。'];
  assert.deepEqual(preview({ value, target: expansion, items }), {
    before: '- 根据截图帮你提炼需求或建议', text: '\n- 补上验收步骤\n- 列出极限窗口尺寸', after: next, insertAt: list.length,
  });
  assert.match(preview({ value, target: expansion, items: items.slice(0, 4) }).error, /新条目不足/u);
  assert.equal(target({ value, end: list.length, instruction: '不要再补充几条，只润色' }), null);
  assert.equal(target({ value, end: list.length, instruction: '再加几个字' }), null);
});

test('numbered items preserve punctuation and continuations at the end of the list', () => {
  const value = '1、列出最常见的场景\n2、覆盖失败和重试\n   附一条检查备注\n\n结论';
  const insertion = value.indexOf('\n\n');
  const expansion = target({ value, end: value.indexOf('场景'), instruction: '请再加两项' });
  assert.equal(expansion.insertAt, insertion);
  assert.equal(preview({ value, target: expansion, items: ['核对日志', '检查撤销'] }).text, '\n3、核对日志\n4、检查撤销');
});
