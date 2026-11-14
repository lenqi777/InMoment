'use strict';

(() => {
  const ADD_ITEMS = /^(?:(?:请|你|帮我|帮忙|麻烦|能不能|能否|可以|可不可以|再|继续|顺便|额外|给我|在(?:这个|原)?(?:列表)?(?:后面|末尾|结尾))[\s，,]*)*(?:补充|新增|添加|增加|追加|加上|加)\s*(?<count>[1-9]\d?|[一二两三四五六七八九十]|几|多|若干|一些)\s*(?:条|项|点|(?:个)?(?:建议|要点|条目|例子|事项|方向))/u;
  const CHINESE_COUNTS = new Map([...('一二三四五六七八九十')].map((value, index) => [value, index + 1]));
  const LIST_ITEM = /^(?<indent>[ \t]*)(?:(?<bullet>[-+*•▪])(?<gap>[ \t]+)|(?<number>[0-9]{1,9})(?<delimiter>[.)、）])(?<numberGap>[ \t]*))(?<content>\S.*)$/u;

  function item(line) {
    const parts = line.match(LIST_ITEM)?.groups;
    if (!parts || (parts.number && !parts.numberGap && /[.)]/u.test(parts.delimiter))) return null;
    return parts;
  }

  function startOfLine(value, index) {
    return index <= 0 ? 0 : value.lastIndexOf('\n', index - 1) + 1;
  }

  function listLine(value, start) {
    const newline = value.indexOf('\n', start);
    const end = newline < 0 ? value.length : newline;
    const raw = value.slice(start, end);
    return { start, end, raw, marker: item(raw) };
  }

  function sameList(first, second) {
    return second?.indent === first.indent && second.bullet === first.bullet && second.delimiter === first.delimiter;
  }

  function continuation(line, marker) {
    return line.raw.trim() && line.raw.match(/^[ \t]*/u)[0].length > marker.indent.length;
  }

  function target({ value, end, instruction }) {
    const count = instruction.trim().match(ADD_ITEMS)?.groups.count;
    if (!count) return null;
    const minItems = Number(count) || CHINESE_COUNTS.get(count) || 2;
    const lastSelected = value.slice(0, end).trimEnd().length - 1;
    const line = listLine(value, startOfLine(value, lastSelected));
    if (!line.marker) return null;

    let first = line;
    let last = line;
    let lastMarker = line.marker;
    const existing = [line.marker.content];
    while (first.start > 0) {
      const previous = listLine(value, startOfLine(value, first.start - 1));
      if (sameList(line.marker, previous.marker)) existing.push(previous.marker.content);
      else if (!continuation(previous, line.marker)) break;
      first = previous;
    }
    while (last.end < value.length) {
      const next = listLine(value, last.end + 1);
      if (sameList(line.marker, next.marker)) {
        existing.push(next.marker.content);
        lastMarker = next.marker;
      } else if (!continuation(next, line.marker)) break;
      last = next;
    }

    return { insertAt: last.end, lastLine: last.raw, marker: lastMarker, existing, minItems };
  }

  function comparable(value) {
    return value.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase();
  }

  function repeatsExisting(key, known) {
    if (known.includes(key)) return true;
    if (key.length < 4) return false;
    const remaining = known.reduce((rest, line) => line.length >= 4 ? rest.replaceAll(line, '') : rest, key);
    return !remaining || (remaining.length >= 4 && known.some(line => line.includes(remaining)));
  }

  function preview({ value, target, items }) {
    const known = target.existing.map(comparable).filter(Boolean);
    const additions = [];
    for (const response of items) {
      const line = response.trim();
      const text = item(line)?.content ?? line;
      const key = comparable(text);
      if (!key || repeatsExisting(key, known)) continue;
      additions.push(text);
      known.push(key);
    }

    if (additions.length < target.minItems) return { error: 'AI 生成的新条目不足，请重试或调整修改要求。' };
    const { indent, bullet, gap, number, delimiter, numberGap } = target.marker;
    const text = additions.map((line, index) => {
      const prefix = bullet ? bullet + gap : (Number(number) + index + 1) + delimiter + numberGap;
      return '\n' + indent + prefix + line;
    }).join('');
    return { before: target.lastLine, text, after: value.slice(target.insertAt, target.insertAt + 160), insertAt: target.insertAt };
  }

  const api = { target, preview };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.InMomentNoteListExpansion = api;
})();
