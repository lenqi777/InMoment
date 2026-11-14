'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeNoteDocument } = require('./note-document.cjs');
const { clipboardPayload } = require('../shared/note-outline.js');

const maxBytes = 32 * 1024 * 1024;
const maxPixels = 32_000_000;
const blocks = new Set(['p', 'div', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote']);

function escapeHtml(value) {
  return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function escapeRtf(text) {
  return text.replace(/\r\n|[^ -~]|[\\{}]/g, character => {
    if (character === '\n' || character === '\r' || character === '\r\n') return '\\line ';
    if (character === '\t') return '\\tab ';
    if (/[\\{}]/u.test(character)) return '\\' + character;
    const unit = character.charCodeAt(0);
    return '\\u' + (unit > 32767 ? unit - 65536 : unit) + '?';
  });
}

function imageSize(node, image) {
  const width = Math.min(node.width || image.width, 600);
  return { width, height: Math.max(1, Math.round(image.height * width / image.width)) };
}

function clipboardHtml(nodes, assets) {
  const render = nodes => nodes.map(node => {
    if (typeof node === 'string') return escapeHtml(node).replace(/\r\n|\r|\n/gu, '<br>');
    if (node.attachmentId) {
      const image = assets.get(node.attachmentId);
      if (!image.png) return escapeHtml(image.name);
      const size = imageSize(node, image);
      const align = node.align ? ' data-note-align="' + node.align + '"' : '';
      const width = node.width ? ' data-note-width="' + node.width + '"' : '';
      return `<img alt="${escapeHtml(image.name)}" width="${size.width}" height="${size.height}"${align}${width} src="data:image/png;base64,${image.png.toString('base64')}">`;
    }
    if (node.tag === 'br') return '<br>';
    const style = [node.color && 'color:' + node.color, node.size && 'font-size:' + node.size + 'px', node.clear && 'clear:both'].filter(Boolean).join(';');
    const color = node.color ? ' data-note-color="' + node.color + '"' : '';
    const size = node.size ? ' data-note-size="' + node.size + '"' : '';
    const clear = node.clear ? ' data-note-clear="1"' : '';
    return `<${node.tag}${color}${size}${clear}${style ? ' style="' + style + '"' : ''}>${render(node.children || [])}</${node.tag}>`;
  }).join('');
  return '<div data-inmoment-note-fragment="1" style="white-space:pre-wrap">' + render(nodes) + '</div>';
}

function clipboardRtf(nodes, assets) {
  const colors = new Map();
  const marks = { strong: '\\b', em: '\\i', u: '\\ul', s: '\\strike', h1: '\\b\\fs42', h2: '\\b\\fs36', h3: '\\b\\fs28' };
  function render(nodes) {
    let previousBlock = false;
    let output = '';
    for (const node of nodes) {
      const block = blocks.has(node.tag);
      if (output && (block || previousBlock)) output += '\\par\n';
      previousBlock = block;
      if (typeof node === 'string') { output += escapeRtf(node); continue; }
      if (node.attachmentId) {
        const image = assets.get(node.attachmentId);
        if (!image.png) { output += escapeRtf(image.name); continue; }
        const size = imageSize(node, image);
        output += `{\\pict\\pngblip\\picw${image.width}\\pich${image.height}\\picwgoal${size.width * 15}\\pichgoal${size.height * 15}\n${image.png.toString('hex')}}`;
      } else if (node.tag === 'br') output += '\\line ';
      else {
        if (node.color && !colors.has(node.color)) colors.set(node.color, colors.size + 1);
        const style = (marks[node.tag] || '') + (node.size ? '\\fs' + Math.round(node.size * 1.5) : '') +
          (node.color ? '\\cf' + colors.get(node.color) : '');
        const prefix = node.tag === 'li' ? '\\bullet\\tab ' : '';
        output += '{' + style + (style ? ' ' : '') + prefix + render(node.children || []) + '}';
      }
    }
    return output;
  }
  const body = render(nodes);
  const table = [...colors.keys()].map(color => {
    const [red, green, blue] = color.slice(1).match(/../gu).map(channel => Number.parseInt(channel, 16));
    return `\\red${red}\\green${green}\\blue${blue};`;
  }).join('');
  return '{\\rtf1\\ansi\\ansicpg1252\\uc1{\\colortbl;' + table + '}\n' + body + '}';
}

async function readNotePicture(notes, id, attachmentId) {
  const { filename, mime, size } = notes.file(id, attachmentId);
  if (!mime.startsWith('image/')) throw new Error('请先选中正文图片。');
  if (size > maxBytes) throw new Error('选中的图片超过 32 MB，请分次复制。');
  return { mime, bytes: await fs.readFile(filename) };
}

async function copyNoteSelection({ notes, clipboard, ClipboardItem, nativeImage }, { id, document, plain, converted = {} }) {
  if (typeof plain !== 'string' || plain.length > 1_000_000) throw new Error('复制的文字超出长度上限。');
  const owned = new Map(notes.get(id, { includeHistoryAssets: true }).attachments.map(asset => [asset.id, asset]));
  const selected = normalizeNoteDocument(document, new Map([...owned.keys()].map(id => [id, id])));
  if (!selected) throw new Error('请先选中正文图片。');
  const refs = [];
  function collect(nodes) {
    for (const node of nodes) {
      if (node.attachmentId) refs.push(node.attachmentId);
      else if (node.children) collect(node.children);
    }
  }
  collect(selected.nodes);
  const assets = new Map();
  let total = 0;
  for (const ref of refs) {
    const asset = owned.get(ref);
    if (asset.kind !== 'image') {
      assets.set(ref, { name: asset.name });
      continue;
    }
    const { filename, mime, size } = notes.file(id, ref);
    if (size > maxBytes - total) throw new Error('选中的图片超过 32 MB，请分次复制。');
    const data = mime === 'image/png' || mime === 'image/jpeg' ? await fs.readFile(filename) : converted[ref];
    if (!(data instanceof Uint8Array) || data.byteLength > maxBytes - total) throw new Error('无法复制选中的图片，请确认图片能够打开。');
    const image = nativeImage.createFromBuffer(Buffer.from(data));
    const { width, height } = image.getSize();
    if (!width || !height) throw new Error('无法复制选中的图片，请确认图片能够打开。');
    if (width * height > maxPixels) throw new Error('图片尺寸过大，请缩小原图后再复制。');
    const png = mime === 'image/png' ? Buffer.from(data) : image.toPNG();
    total += png.byteLength;
    if (total > maxBytes) throw new Error('选中的图片超过 32 MB，请分次复制。');
    assets.set(ref, { name: path.basename(filename), png, width, height });
  }
  const pictures = [...assets.values()].filter(asset => asset.png);
  if (!pictures.length) throw new Error('请先选中正文图片。');
  const data = !plain.trim() && refs.length === 1
    ? { 'image/png': new Blob([pictures[0].png], { type: 'image/png' }) }
    : { 'text/rtf': clipboardRtf(selected.nodes, assets), 'text/html': clipboardHtml(selected.nodes, assets), 'text/plain': plain };
  await clipboard.write([new ClipboardItem(data)]);
  return true;
}

async function copyImageOutline({ clipboard, ClipboardItem }, outline) {
  const payload = clipboardPayload(outline);
  if (!payload) throw new Error('没有可复制的大纲，或大纲超出长度上限。');
  await clipboard.write([new ClipboardItem({ 'text/html': payload.html, 'text/plain': payload.text })]);
  return true;
}

module.exports = { copyNoteSelection, readNotePicture, copyImageOutline };
