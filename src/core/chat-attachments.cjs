'use strict';

const { randomUUID } = require('node:crypto');

const ATTACHMENT_LIMITS = Object.freeze({ count: 4, bytes: 12 * 1024 * 1024, textBytes: 256 * 1024 });
const TYPES = new Map([
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['text/markdown', '.md'],
  ['video/mp4', '.mp4'],
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const encodedLimit = Math.ceil(ATTACHMENT_LIMITS.bytes / 3) * 4;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'CHAT_INVALID' });
}

function textOf(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\u0000')) throw new Error();
    return text;
  } catch {
    throw invalid('请将文本附件保存为 UTF-8 编码后重新添加。');
  }
}

function attachmentsOf(value = []) {
  if (!Array.isArray(value) || value.length > ATTACHMENT_LIMITS.count) {
    throw invalid('每条消息最多附加 4 个 PDF、文本或 MP4 文件。');
  }
  let total = 0;
  const ids = new Set();
  return value.map(item => {
    const { mimeType, name, base64 } = item || {};
    const extension = TYPES.get(mimeType);
    if (!extension || typeof name !== 'string' || name.length > 255 || !name.toLowerCase().endsWith(extension)
      || /[\u0000-\u001F\u007F/\\]/u.test(name)) {
      throw invalid('请选择 PDF、TXT、Markdown 或 MP4 文件。');
    }
    if (typeof base64 !== 'string' || !base64.length || base64.length > encodedLimit
      || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) {
      throw invalid('附件无法读取，或文件大小超过 12 MiB。');
    }
    const size = Buffer.byteLength(base64, 'base64');
    total += size;
    if (!size || total > ATTACHMENT_LIMITS.bytes) throw invalid('每条消息的非图片附件合计最多 12 MiB。');

    const bytes = Buffer.from(base64, 'base64');
    if (mimeType === 'application/pdf' && !bytes.subarray(0, 1024).includes('%PDF-')) {
      throw invalid('此附件不是有效的 PDF 文件。');
    }
    if (mimeType === 'video/mp4' && (bytes.length < 16 || bytes.toString('ascii', 4, 8) !== 'ftyp')) {
      throw invalid('此附件不是有效的 MP4 文件。');
    }
    if (mimeType.startsWith('text/')) {
      if (size > ATTACHMENT_LIMITS.textBytes) throw invalid('单个文本附件最多 256 KiB。');
      textOf(bytes);
    }
    const id = typeof item.id === 'string' && ID.test(item.id) ? item.id : randomUUID();
    if (ids.has(id)) throw invalid('附件标识重复，请重新添加文件。');
    ids.add(id);
    return { id, mimeType, name, base64 };
  });
}

module.exports = { attachmentsOf, ATTACHMENT_LIMITS, textOf };
