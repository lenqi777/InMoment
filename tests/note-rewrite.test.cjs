'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { preview } = require('../src/renderer/note-rewrite.js');

function rewrite(left, original, right, text) {
  return preview({ value: left + original + right, start: left.length, end: left.length + original.length, text });
}

test('partial rewrite previews the joined sentence and removes the echoed topic and period', () => {
  assert.deepEqual(rewrite(
    '上一句。\n在情感化设计',
    '中可靠客观的获得用户的情感信息很重要，这关系到最终的设计效果',
    '。\n下一句。',
    '情感化设计中，可靠、客观地获取用户的情感信息，直接关系到最终的设计效果。',
  ), {
    before: '在情感化设计',
    text: '中，可靠、客观地获取用户的情感信息，直接关系到最终的设计效果',
    after: '。',
  });
});

test('only new exact repeats next to the selection are removed', () => {
  assert.equal(rewrite('先讨论，', '再投票', '。', '，再匿名投票。').text, '再匿名投票');
  assert.equal(rewrite('首先', '讨论并总结', '情感化设计方法。', '交流并归纳情感化设计').text, '交流并归纳');
  assert.equal(rewrite('他说：人人', '都有意见', '。', '人人都能发言').text, '人人都能发言');
  assert.equal(rewrite('他们喊道我们共同努力', '我们共同努力才行', '。', '我们共同努力才能做到').text, '我们共同努力才能做到');
  assert.equal(rewrite('等一等。', '。再试', '。', '。再重新试。').text, '。再重新试');
});

test('a previously observed model response loses its extra period when the original comma follows', () => {
  assert.deepEqual(rewrite(
    '录音流程测试发现，截图框选松手后仍会弹出录音确认。改动是框选松手后',
    '直接开始就行',
    '，停止键位置维持原样。',
    '框选松手后即可直接开始录音。',
  ), {
    before: '改动是框选松手后',
    text: '即可直接开始录音',
    after: '，停止键位置维持原样。',
  });
  assert.equal(rewrite('真的', '能行？', '！', '有效吗？').text, '有效吗？');
});

test('empty replacement after trimming is retryable and multiline replacements use textarea newlines', () => {
  assert.ok(rewrite('在情感化设计', '很重要', '。', '情感化设计。').error);
  assert.deepEqual(rewrite('🌱 ', '写笔记', '\n下一行', '先想一想\r\n再写下来'), {
    before: '🌱 ', text: '先想一想\n再写下来', after: '\n',
  });
});
