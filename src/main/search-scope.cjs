'use strict';
const { normalizeFilters } = require('./cloud-permissions.cjs');
const OFFSET = 8 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
// Parse the supported expressions locally; the query is never sent to a model to
// decide which records the user's date/topic restriction authorizes.
function resolveSearchScope(query, input = {}, { now = Date.now() } = {}) {
  const filters = normalizeFilters(input);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('当前日期无效。');
  const date = new Date(now + OFFSET);
  const year = date.getUTCFullYear(), month = date.getUTCMonth(), day = date.getUTCDate();
  const midnight = Date.UTC(year, month, day) - OFFSET;
  const monthStart = Date.UTC(year, month, 1) - OFFSET;
  const weekStart = midnight - ((date.getUTCDay() + 6) % 7) * DAY;
  function previousCalendar(months) {
    const first = new Date(Date.UTC(year, month - months, 1));
    const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, days), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()) - OFFSET;
  }
  const text = String(query || '');
  if (/上上(?:个)?(?:年|月|周|星期)|前前(?:个)?(?:年|月|周|星期)/u.test(text)) throw new Error('请将较早的时间改成明确日期范围后再查找。');
  const rules = [
    { pattern: /上(?:个)?周/u, label: '上周', from: weekStart - 7 * DAY, to: weekStart },
    { pattern: /上(?:个)?月/u, label: '上个月', from: Date.UTC(year, month - 1, 1) - OFFSET, to: monthStart },
    { pattern: /今天/u, label: '今天', from: midnight, to: midnight + DAY },
    { pattern: /昨天/u, label: '昨天', from: midnight - DAY, to: midnight },
    { pattern: /本周|这周/u, label: '本周', from: weekStart, to: weekStart + 7 * DAY },
    { pattern: /本月|这个月/u, label: '本月', from: monthStart, to: Date.UTC(year, month + 1, 1) - OFFSET },
    { pattern: /去年/u, label: '去年', from: Date.UTC(year - 1, 0, 1) - OFFSET, to: Date.UTC(year, 0, 1) - OFFSET },
    { pattern: /今年/u, label: '今年', from: Date.UTC(year, 0, 1) - OFFSET, to: Date.UTC(year + 1, 0, 1) - OFFSET },
  ];
  const matches = [], spans = [];
  for (const rule of rules) for (const match of text.matchAll(new RegExp(rule.pattern.source, 'gu'))) { matches.push(rule); spans.push([match.index, match[0].length]); }
  function quantity(value) {
    if (/^\d+$/u.test(value)) return Number(value);
    const digits = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (value === '十') return 10;
    if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/u.test(value)) { const [tens, units] = value.split('十'); return (tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0); }
    return value.length === 1 ? digits[value] : NaN;
  }
  for (const match of text.matchAll(/(?:过去|最近|近)([零〇一二三四五六七八九十两\d]+)(?:个)?(天|周|星期|月|年)/gu)) {
    const count = quantity(match[1]), unit = match[2];
    if (!Number.isSafeInteger(count) || count < 1 || count > 1000 || unit === '年' && count > 100) throw new Error('时间长度无效，请使用明确的日期或合理的天、周、月、年数量。');
    const from = unit === '月' ? previousCalendar(count) : unit === '年' ? previousCalendar(12 * count) : now - count * (unit === '天' ? DAY : 7 * DAY);
    matches.push({ label: match[0], from, to: now + 1 }); spans.push([match.index, match[0].length]);
  }
  function explicitDate(yearText, monthText, dayText) {
    const y = Number(yearText), m = Number(monthText), d = Number(dayText); const stamp = Date.UTC(y, m - 1, d); const parsed = new Date(stamp);
    if (y < 1970 || y > 9999 || parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) throw new Error('描述中的日期无效，请使用 YYYY-MM-DD。');
    return stamp - OFFSET;
  }
  for (const match of text.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})\s*(?:到|至|~|～)\s*(\d{4})-(\d{1,2})-(\d{1,2})/gu)) {
    const from = explicitDate(match[1], match[2], match[3]), end = explicitDate(match[4], match[5], match[6]);
    if (end < from) throw new Error('描述中的结束日期不能早于开始日期。');
    matches.push({ label: match[0], from, to: end + DAY }); spans.push([match.index, match[0].length]);
  }
  const residual = text.split(''); for (const [start, length] of spans) for (let index = start; index < start + length; index++) residual[index] = ' ';
  // An unrecognized time restriction must never turn into an all-time upload.
  if (/(?:上上|前前|前|去|今|明|后|上|下|本|这)(?:个)?(?:年|月|周|星期|天)|(?:最近|过去|近).{0,8}(?:天|周|星期|月|年)|[一二三四五六七八九十两\d]+(?:个)?(?:天|周|星期|月|年)(?:之)?(?:前|后|内)|\d{4}[-年]\d{1,2}|[一二三四五六七八九十两\d]+月(?:份)?/u.test(residual.join(''))) throw new Error('未能确定描述中的时间范围。请改为“上周”“去年”“最近三个月”，或“YYYY-MM-DD 到 YYYY-MM-DD”后再查找。');
  const distinct = [...new Map(matches.map(match => [`${match.from}:${match.to}`, match])).values()];
  if (distinct.length > 1) throw new Error('描述中包含多个时间范围，请保留一个明确的时间范围后再查找。');
  let source = filters.from !== undefined || filters.to !== undefined ? 'selection' : 'none';
  let label = source === 'none' ? '全部时间' : '所选日期';
  if (distinct.length) {
    const match = distinct[0];
    filters.from = Math.max(0, match.from); filters.to = match.to;
    source = 'description'; label = match.label;
  }
  const scopeDescription = `${label} · ${filters.topicIds?.length ? `${filters.topicIds.length} 个所选分组${filters.uncategorized ? '及未分类' : ''}` : filters.uncategorized ? '未分类' : '全部灵感'}`;
  return { filters, appliedFilters: { ...filters, ...(filters.topicIds ? { topicIds: [...filters.topicIds] } : {}) }, scopeDescription, timeInterpretation: { source, label, timezone: 'Asia/Shanghai' } };
}
module.exports = { resolveSearchScope };
