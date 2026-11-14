'use strict';

const { createHash } = require('node:crypto');

const tags = new Set(['p', 'div', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'strong', 'em', 'u', 's', 'br', 'span']);
const sizes = new Set([12, 14, 16, 20, 24, 32, 40]);
const clearableTags = new Set(['p', 'div', 'h1', 'h2', 'h3', 'li', 'blockquote']);
const colorPattern = /^#[0-9a-f]{6}$/iu;
const attachmentPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u;

function normalizeNoteDocument(document, mediaIds) {
  if (document == null) return null;
  if (document.version !== 1 || !Array.isArray(document.nodes)) throw new Error('笔记格式数据无效。');
  const usedMedia = new Set();
  let nodeCount = 0;
  let textLength = 0;

  function visit(nodes, depth) {
    if (depth > 64) throw new Error('笔记格式嵌套过深。');
    const result = [];
    for (const node of nodes) {
      if (++nodeCount > 1_000_000) throw new Error('笔记格式数据超出保存上限。');
      if (typeof node === 'string') {
        textLength += node.length;
        if (textLength > 1_000_000) throw new Error('笔记正文最多 100 万字。');
        result.push(node);
        continue;
      }
      if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('笔记格式数据无效。');
      if (Object.hasOwn(node, 'attachmentId')) {
        if (typeof node.attachmentId !== 'string' || !attachmentPattern.test(node.attachmentId)) throw new Error('正文媒体标识无效。');
        const attachmentId = mediaIds.get(node.attachmentId);
        if (attachmentId && !usedMedia.has(attachmentId)) {
          usedMedia.add(attachmentId);
          const entry = { attachmentId };
          if (Number.isInteger(node.width) && node.width >= 48 && node.width <= 1600) entry.width = node.width;
          if (node.align === 'left' || node.align === 'right' || node.align === 'inline') entry.align = node.align;
          result.push(entry);
        }
        continue;
      }
      if (!tags.has(node.tag) || node.children !== undefined && !Array.isArray(node.children)) throw new Error('笔记格式数据无效。');
      const entry = { tag: node.tag };
      if (node.clear === true && clearableTags.has(node.tag)) entry.clear = true;
      if (typeof node.color === 'string' && colorPattern.test(node.color)) entry.color = node.color.toLowerCase();
      if (sizes.has(node.size)) entry.size = node.size;
      if (node.tag !== 'br' && node.children?.length) entry.children = visit(node.children, depth + 1);
      result.push(entry);
    }
    return result;
  }

  return { version: 1, nodes: visit(document.nodes, 0) };
}

function bodyHash(body) { return createHash('sha256').update(body).digest('hex'); }

function packNoteDocument(document, body, mediaIds) {
  const normalized = normalizeNoteDocument(document, mediaIds);
  return normalized === null ? null : JSON.stringify({ bodyHash: bodyHash(body), document: normalized });
}

function unpackNoteDocument(serialized, body, mediaIds) {
  if (!serialized) return null;
  try {
    const packed = JSON.parse(serialized);
    // Older clients can edit the text without updating its formatting.
    return packed.bodyHash === bodyHash(body) ? normalizeNoteDocument(packed.document, mediaIds) : null;
  } catch { return null; }
}

module.exports = { normalizeNoteDocument, packNoteDocument, unpackNoteDocument };
