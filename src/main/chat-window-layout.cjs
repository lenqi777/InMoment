'use strict';
const CHAT_GUTTER = 12;
const CHAT_INITIAL_SIZE = Object.freeze({ width:464, height:584 });
const CHAT_MINIMUM_SIZE = Object.freeze({ width:384, height:424 });
const CHAT_MINIMUM_VIEWPORT_WIDTH = 280;

function minimumChatWidth(zoom = 1) {
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error('聊天缩放比例无效。');
  return Math.max(CHAT_MINIMUM_SIZE.width, Math.ceil(CHAT_MINIMUM_VIEWPORT_WIDTH * zoom));
}

// Coordinates and sizes use Electron's device-independent pixels. Keep the
// composer's bottom anchor while growing, then clamp to the current work area.
function growChatBounds(bounds, workArea, requestedHeight, margin = 12, minimumWidth = 0) {
  if (!Number.isFinite(requestedHeight) || requestedHeight <= 0) throw new Error('聊天高度无效。');
  const inset = Math.max(0, Math.min(margin, Math.floor(Math.min(workArea.width, workArea.height) / 4)));
  const maxWidth = Math.max(1, Math.floor(workArea.width - inset * 2));
  const maxHeight = Math.max(1, Math.floor(workArea.height - inset * 2));
  const width = Math.min(Math.max(bounds.width, minimumWidth), maxWidth);
  const height = Math.min(maxHeight, Math.max(bounds.height, Math.ceil(requestedHeight)));
  const x = Math.round(Math.max(workArea.x + inset, Math.min(bounds.x, workArea.x + workArea.width - inset - width)));
  const y = Math.round(Math.max(workArea.y + inset, Math.min(bounds.y - Math.max(0, height - bounds.height), workArea.y + workArea.height - inset - height)));
  const next = { x, y, width, height };
  return { bounds: next, maxWidth, maxHeight, changed: Object.keys(next).some(key => next[key] !== bounds[key]) };
}

function applyChatBounds(window, target) {
  let actual = window.getBounds();
  const settled = () => Object.keys(target).every(key => Math.abs(actual[key] - target[key]) <= 1);
  if (settled()) return { bounds: actual, changed: false };
  let request = { ...target };
  // Fractional Windows scaling can enlarge a getBounds/setBounds round trip.
  // Correct the observed error in this main-process turn, with a strict bound;
  // one DIP of display rounding must not cause an ongoing renderer resize loop.
  // Upstream: https://github.com/electron/electron/pull/55429
  for (let attempt = 0; attempt < 3; attempt++) {
    window.setBounds(request, false);
    actual = window.getBounds();
    if (settled()) break;
    request = Object.fromEntries(Object.keys(target).map(key => [key, Math.round(request[key] + target[key] - actual[key])]));
    request.width = Math.max(1, request.width); request.height = Math.max(1, request.height);
  }
  return { bounds: actual, changed: true };
}

function initialChatBounds(source, workArea, zoom = 1) {
  const margin = 12, width = Math.max(1, Math.min(Math.max(CHAT_INITIAL_SIZE.width, minimumChatWidth(zoom)), workArea.width - margin * 2));
  const maxHeight = Math.max(1, workArea.height - margin * 2);
  const bottom = source.y + source.height + CHAT_GUTTER;
  const above = bottom - workArea.y - margin;
  const height = Math.min(CHAT_INITIAL_SIZE.height, maxHeight, above >= CHAT_MINIMUM_SIZE.height ? above : maxHeight);
  return {
    x: Math.round(Math.max(workArea.x + margin, Math.min(source.x - CHAT_GUTTER, workArea.x + workArea.width - margin - width))),
    y: Math.round(Math.max(workArea.y + margin, Math.min(bottom - height, workArea.y + workArea.height - margin - height))),
    width: Math.round(width), height: Math.round(height)
  };
}

module.exports = { growChatBounds, applyChatBounds, initialChatBounds, minimumChatWidth, CHAT_GUTTER, CHAT_INITIAL_SIZE, CHAT_MINIMUM_SIZE, CHAT_MINIMUM_VIEWPORT_WIDTH };
