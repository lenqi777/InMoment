'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { recordIdForNote } = require('./notes.cjs');

const IMAGE_MIME = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.bmp', 'image/bmp']]);

function exportName(value, fallback = '未命名笔记') {
  const clean = [...String(value || '').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/gu, '_').trim()]
    .slice(0, 72).join('').replace(/[. ]+$/u, '') || fallback;
  return /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/iu.test(clean) ? '_' + clean : clean;
}

function snapshotNote(notes, id) {
  const note = notes.get(id);
  const files = note.attachments.map(attachment => ({ label: attachment.name, ...notes.file(id, attachment.id) }));
  const recordId = recordIdForNote(id);
  if (recordId) {
    const record = notes.store.getRecord(recordId);
    for (const [index, screenshot] of record.screenshots.entries()) {
      const label = (screenshot.method === 'region' ? '选区截图' : '来源截图') + `-${index + 1}` + path.extname(screenshot.path);
      files.push({ label, filename: screenshot.path });
    }
    for (const [index, audio] of record.segments.entries()) files.push({ label: `录音-${index + 1}` + path.extname(audio.path), filename: audio.path });
  }
  return { ...note, files, summaries: note.summaries.map(summary => snapshotNote(notes, summary.id)) };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, symbol => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[symbol]);
}

function markdownInline(value) { return String(value).replace(/[\\`*_[\]<>]/gu, '\\$&').replace(/[\r\n]+/gu, ' '); }
function relativeLink(value) { return value.split('/').map(segment => encodeURIComponent(segment).replace(/[()]/gu, symbol => symbol === '(' ? '%28' : '%29')).join('/'); }

function backgroundLines(note) {
  const source = note.background;
  return [note.topics.map(topic => topic.name).join(' / '), source?.appName, source?.windowTitle, source?.url, source?.task].filter(Boolean);
}

function markdownNote(note, depth = 1) {
  const lines = ['#'.repeat(Math.min(6, depth)) + ' ' + markdownInline(note.title || '未命名笔记')];
  const background = backgroundLines(note);
  if (background.length) lines.push(background.map(markdownInline).join(' · '));
  if (note.body) lines.push(note.body);
  if (note.files.length) lines.push(note.files.map(file => `- [${markdownInline(file.label)}](${relativeLink(file.link)})`).join('\n'));
  for (const summary of note.summaries) lines.push(markdownNote(summary, depth + 1));
  return lines.join('\n\n');
}

async function pdfNote(note, budget, nested = false) {
  const tag = nested ? 'h2' : 'h1';
  const content = [`<${tag}>${escapeHtml(note.title || '未命名笔记')}</${tag}>`];
  const background = backgroundLines(note);
  if (background.length) content.push(`<p class="source">${background.map(escapeHtml).join(' · ')}</p>`);
  if (note.body) content.push(`<div class="body">${escapeHtml(note.body)}</div>`);
  for (const file of note.files) {
    const mime = IMAGE_MIME.get(path.extname(file.filename).toLowerCase());
    if (mime) {
      const { size } = await fs.stat(file.output);
      if (size <= 8 * 1024 * 1024 && size <= budget.remaining) {
        budget.remaining -= size;
        const data = await fs.readFile(file.output, 'base64');
        content.push(`<img alt="${escapeHtml(file.label)}" src="data:${mime};base64,${data}">`);
      }
    }
    content.push(`<p class="source">附件 ${escapeHtml(file.link)}</p>`);
  }
  for (const summary of note.summaries) content.push(await pdfNote(summary, budget, true));
  return nested ? content.join('') : `<article>${content.join('')}</article>`;
}

async function exportDocument(entries, format, printPDF) {
  if (format === 'markdown') return entries.map(note => markdownNote(note)).join('\n\n---\n\n') + '\n';
  const budget = { remaining: 24 * 1024 * 1024 };
  const articles = [];
  for (const entry of entries) articles.push(await pdfNote(entry, budget));
  return printPDF(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
    body{font:12pt/1.65 "Microsoft YaHei UI", "Segoe UI", sans-serif;color:#18221c;margin:0} h1,h2{line-height:1.3;overflow-wrap:anywhere}
    article+article{break-before:page}.body{white-space:pre-wrap;overflow-wrap:anywhere}.source{color:#53615a;font-size:9pt;overflow-wrap:anywhere}
    img{display:block;max-width:100%;max-height:230mm;object-fit:contain;margin:12pt 0;break-inside:avoid}
  </style><body>${articles.join('')}</body></html>`);
}

async function copyResources(entries, directory, linkBase) {
  let index = 0;
  async function copy(entry) {
    for (const file of entry.files) {
      const ext = path.extname(file.label);
      const extension = /^[.][A-Za-z0-9]{1,15}$/u.test(ext) ? ext : '';
      const name = `${++index}-${exportName(path.basename(file.label, extension), '附件')}${extension}`;
      file.output = path.join(directory, name);
      await fs.copyFile(file.filename, file.output, constants.COPYFILE_EXCL);
      file.link = `${linkBase}/${name}`;
    }
    for (const summary of entry.summaries) await copy(summary);
  }
  for (const entry of entries) await copy(entry);
}

function hasFiles(note) { return note.files.length > 0 || note.summaries.some(hasFiles); }

async function removeCreatedDirectory(parent, directory) {
  const [realParent, realDirectory] = await Promise.all([fs.realpath(parent), fs.realpath(directory)]);
  if (path.relative(realParent, realDirectory) !== path.basename(directory) || (await fs.lstat(directory)).isSymbolicLink()) {
    throw new Error('导出临时目录的位置已变化。');
  }
  await fs.rm(realDirectory, { recursive: true, force: true });
}

async function newExportDirectory(parent, name) {
  for (let index = 1; ; index++) {
    const directory = path.join(parent, index === 1 ? name : `${name} (${index})`);
    try {
      await fs.mkdir(directory);
      return directory;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

async function exportNotes({ notes, ids, target, format, mode, printPDF }) {
  const entries = ids.map(id => snapshotNote(notes, id));
  const separate = mode === 'separate';
  const parent = separate ? target : path.dirname(target);
  const extension = format === 'pdf' ? '.pdf' : '.md';
  let bundle;
  let assets;
  let temp;
  try {
    if (separate) bundle = await newExportDirectory(parent, 'InMoment 笔记');
    if (entries.some(hasFiles)) {
      const owner = bundle || parent;
      if (bundle) {
        assets = path.join(bundle, '附件');
        await fs.mkdir(assets);
      } else {
        assets = await newExportDirectory(owner, `${exportName(path.basename(target, path.extname(target)))} 附件`);
      }
      await copyResources(entries, assets, path.basename(assets));
    }
    if (separate) {
      for (const [index, entry] of entries.entries()) {
        const filename = path.join(bundle, `${String(index + 1).padStart(3, '0')}-${exportName(entry.title)}${extension}`);
        await fs.writeFile(filename, await exportDocument([entry], format, printPDF), { flag: 'wx' });
      }
    } else {
      temp = path.join(parent, `.inmoment-export-${randomUUID()}.tmp`);
      await fs.writeFile(temp, await exportDocument(entries, format, printPDF), { flag: 'wx' });
      await fs.rename(temp, target);
    }
  } catch (error) {
    if (temp) await fs.rm(temp, { force: true }).catch(() => {});
    if (bundle || assets) await removeCreatedDirectory(parent, bundle || assets).catch(() => {});
    throw error;
  }
  return { path: bundle || target, count: entries.length, ...(assets ? { assets } : {}) };
}

module.exports = { exportNotes, exportName };
