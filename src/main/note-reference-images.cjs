'use strict';

const fs = require('node:fs');
const { LIMITS } = require('../core/chat-client.cjs');

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const supportedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function orderedPictures(note) {
  const remaining = new Map(note.attachments.filter(asset => asset.kind === 'image').map(asset => [asset.id, asset]));
  const pictures = [];
  function visit(nodes) {
    for (const node of nodes) {
      if (node.attachmentId && remaining.has(node.attachmentId)) {
        pictures.push(remaining.get(node.attachmentId));
        remaining.delete(node.attachmentId);
      } else if (node.children) visit(node.children);
    }
  }
  if (remaining.size && note.document) visit(note.document.nodes);
  return pictures.concat([...remaining.values()]);
}

function matchesFormat(mime, bytes) {
  switch (mime) {
    case 'image/png':
      return bytes.length >= 45 && bytes.subarray(0, 8).equals(pngSignature) &&
        bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' &&
        bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 &&
        bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND';
    case 'image/jpeg':
      return bytes.length > 8 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
        bytes.lastIndexOf(Buffer.from([0xff, 0xd9])) > 2;
    case 'image/webp':
      return bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
        bytes.readUInt32LE(4) === bytes.length - 8 && bytes.toString('ascii', 8, 12) === 'WEBP' &&
        ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16));
    case 'image/gif':
      return bytes.length > 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) &&
        bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0 && bytes.at(-1) === 0x3b;
    default: return false;
  }
}

function readBoundedPicture(filename, maxSize) {
  const fd = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !stat.size) return null;
    if (stat.size > maxSize) return { tooLarge: true };
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) return null;
      offset += read;
    }
    return { bytes };
  } finally { fs.closeSync(fd); }
}

function readNoteReferenceImages(notes, note, {
  maxImages = LIMITS.images, maxBytes = 24 * 1024 * 1024,
} = {}) {
  const pictures = orderedPictures(note);
  if (!pictures.length) return [];
  const title = note.title || '未命名笔记';
  if (pictures.length > maxImages) throw new Error(`引用《${title}》中的图片会超过本次聊天的图片数量上限。请减少引用或新建聊天。`);

  let remainingBytes = maxBytes;
  return pictures.map(({ id, name }) => {
    let file, data;
    try {
      file = notes.file(note.id, id);
      if (supportedTypes.has(file.mime)) data = readBoundedPicture(file.filename, LIMITS.imageBytes);
    } catch {
      throw new Error(`无法读取《${title}》中的图片“${name}”。请在笔记中检查图片后重试。`);
    }
    if (data?.tooLarge) throw new Error(`《${title}》中的图片“${name}”过大。请将图片压缩至 8 MiB 以内后重试。`);
    const bytes = data?.bytes;
    const mimeType = file.mime;
    if (!bytes || !matchesFormat(mimeType, bytes)) {
      throw new Error(`《${title}》中的图片“${name}”无法读取为聊天支持的格式。请检查原图，或保存为 PNG、JPEG、WebP 后重试。`);
    }
    remainingBytes -= bytes.length;
    if (remainingBytes < 0) throw new Error(`引用《${title}》中的图片会超过本次可发送的图片大小上限。请减少引用或图片大小。`);
    return { id, name, mimeType, base64: bytes.toString('base64') };
  });
}

module.exports = { readNoteReferenceImages };
