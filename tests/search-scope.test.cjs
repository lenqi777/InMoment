'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSearchScope } = require('../src/main/search-scope.cjs');
const now = Date.parse('2026-10-16T12:30:00+08:00');
test('description dates override only date selection, preserving even unknown topic IDs', () => {
  const result = resolveSearchScope('上周阅读时的灵感', { from: 1, to: 2, topicIds: ['missing'], uncategorized: true }, { now });
  assert.deepEqual(result.filters, { from: Date.parse('2026-10-05T00:00:00+08:00'), to: Date.parse('2026-10-12T00:00:00+08:00'), topicIds: ['missing'], uncategorized: true });
  assert.equal(result.timeInterpretation.source, 'description'); assert.equal(result.timeInterpretation.timezone, 'Asia/Shanghai');
});
test('last calendar month differs from the preceding rolling month', () => {
  const calendar = resolveSearchScope('上个月的想法', {}, { now }).filters;
  assert.equal(calendar.from, Date.parse('2026-09-01T00:00:00+08:00')); assert.equal(calendar.to, Date.parse('2026-10-01T00:00:00+08:00'));
  const rolling = resolveSearchScope('过去一个月的想法', {}, { now }).filters;
  assert.equal(rolling.from, Date.parse('2026-09-16T12:30:00+08:00')); assert.equal(rolling.to, now + 1);
  assert.equal(resolveSearchScope('最近一年', {}, { now }).filters.from, Date.parse('2025-10-16T12:30:00+08:00'));
});
test('calendar subtraction clamps leap days and month ends in the client timezone', () => {
  assert.equal(resolveSearchScope('最近一年', {}, { now: Date.parse('2024-02-29T23:30:00+08:00') }).filters.from, Date.parse('2023-02-28T23:30:00+08:00'));
  assert.equal(resolveSearchScope('最近一个月', {}, { now: Date.parse('2026-03-31T00:30:00+08:00') }).filters.from, Date.parse('2026-02-28T00:30:00+08:00'));
  assert.equal(resolveSearchScope('今天', {}, { now: Date.parse('2026-10-16T00:01:00+08:00') }).filters.from, Date.parse('2026-10-16T00:00:00+08:00'));
});
test('default search spans all time while explicit selection remains intact without a description date', () => {
  const all = resolveSearchScope('阅读后的灵感', {}, { now }); assert.deepEqual(all.filters, { uncategorized: false }); assert.equal(all.timeInterpretation.source, 'none');
  const chosen = resolveSearchScope('阅读后的灵感', { from: 100, to: 200 }, { now }); assert.equal(chosen.filters.from, 100); assert.equal(chosen.timeInterpretation.source, 'selection');
  assert.throws(() => resolveSearchScope('上周或上个月的想法', {}, { now }), /多个时间/);
});
test('calendar years and numeric or Chinese rolling intervals resolve without a cloud interpretation', () => {
  assert.equal(resolveSearchScope('去年阅读', {}, { now }).filters.from, Date.parse('2025-01-01T00:00:00+08:00'));
  assert.equal(resolveSearchScope('去年阅读', {}, { now }).filters.to, Date.parse('2026-01-01T00:00:00+08:00'));
  assert.equal(resolveSearchScope('今年阅读', {}, { now }).filters.from, Date.parse('2026-01-01T00:00:00+08:00'));
  assert.equal(resolveSearchScope('最近两个月', {}, { now }).filters.from, Date.parse('2026-08-16T12:30:00+08:00'));
  assert.equal(resolveSearchScope('近12个月', {}, { now }).filters.from, Date.parse('2025-10-16T12:30:00+08:00'));
  assert.equal(resolveSearchScope('最近三年', {}, { now }).filters.from, Date.parse('2023-10-16T12:30:00+08:00'));
  assert.equal(resolveSearchScope('过去二十一天', {}, { now }).filters.from, now - 21 * 86400000);
  assert.equal(resolveSearchScope('最近两周', {}, { now }).filters.from, now - 14 * 86400000);
  assert.equal(resolveSearchScope('💡 上周的灵感', {}, { now }).timeInterpretation.label, '上周');
});
test('explicit date ranges include the final Shanghai calendar day and reject invalid dates or reversed bounds', () => {
  const found = resolveSearchScope('2026-09-01 到 2026-09-30 关于阅读', { topicIds: ['work'] }, { now });
  assert.equal(found.filters.from, Date.parse('2026-09-01T00:00:00+08:00')); assert.equal(found.filters.to, Date.parse('2026-10-01T00:00:00+08:00')); assert.deepEqual(found.filters.topicIds, ['work']);
  assert.throws(() => resolveSearchScope('2026-02-30至2026-03-01', {}, { now }), /日期无效/);
  assert.throws(() => resolveSearchScope('2026-03-02至2026-03-01', {}, { now }), /早于/);
});
test('unsupported or ambiguous time restrictions never silently become an all-time search', () => {
  for (const query of ['上上周的灵感', '前年想到的事情', '最近半年', '三个月之前', '2026-05-01的记录', '上周和前年的灵感']) assert.throws(() => resolveSearchScope(query, {}, { now }), /时间|日期/);
  assert.throws(() => resolveSearchScope('最近0天', {}, { now }), /时间长度/);
});
