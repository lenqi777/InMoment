'use strict';

(() => {
  const PREVIEW_EDGE_LENGTH = 160;
  const ECHO_LIMIT = 64;
  const HAN_PHRASE = /^\p{Script=Han}{4,}$/u;
  const PUNCTUATION = /^[，。！？、；：,.!?;:]$/u;
  const CLAUSE_BREAK = /^[，、；：,;:]$/u;
  const SENTENCE_BREAK = /^[。！？.!?]$/u;
  const SENTENCE_END = /[。！？!?；;\n]/u;

  function clashes(first, second) {
    if (first === second) return PUNCTUATION.test(first);
    return (CLAUSE_BREAK.test(first) && SENTENCE_BREAK.test(second)) ||
      (SENTENCE_BREAK.test(first) && CLAUSE_BREAK.test(second));
  }

  function boundaryEcho(neighbor, original, replacement, leading) {
    const edge = (value, length) => leading ? value.slice(0, length) : value.slice(-length);
    const adjacent = (value, length) => leading ? value.slice(-length) : value.slice(0, length);
    const maxLength = Math.min(ECHO_LIMIT, neighbor.length, replacement.length);

    for (let length = maxLength; length >= 4; length -= 1) {
      const repeated = adjacent(neighbor, length);
      if (HAN_PHRASE.test(repeated) && repeated === edge(replacement, length)) {
        // Preserve overlap that the user already had at this boundary.
        return repeated === edge(original, length) ? 0 : length;
      }
    }

    const punctuation = adjacent(neighbor, 1);
    const originalEdge = edge(original, 1);
    if (clashes(punctuation, edge(replacement, 1)) && !clashes(punctuation, originalEdge)) return 1;
    return 0;
  }

  function preview({ value, start, end, text }) {
    const left = value.slice(0, start);
    const right = value.slice(end);
    const original = value.slice(start, end);
    const replacement = text.replace(/\r\n?/gu, '\n');
    const leadingEcho = boundaryEcho(left, original, replacement, true);
    const leadingTrimmed = replacement.slice(leadingEcho);
    const trailingEcho = boundaryEcho(right, original, leadingTrimmed, false);
    const revised = leadingTrimmed.slice(0, leadingTrimmed.length - trailingEcho);

    const leftEdge = left.slice(-PREVIEW_EDGE_LENGTH);
    const rightEdge = right.slice(0, PREVIEW_EDGE_LENGTH);
    const before = leftEdge.match(/[^。！？!?；;\n]*.$/su)?.[0] ?? '';
    const rightBoundary = rightEdge.search(SENTENCE_END);
    const after = rightBoundary < 0 ? rightEdge : rightEdge.slice(0, rightBoundary + 1);

    if (!revised.trim()) return { before, text: revised, after, error: '改写稿没有可替换的内容，请重新生成。' };
    return { before, text: revised, after };
  }

  const api = { preview };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.InMomentNoteRewrite = api;
})();
