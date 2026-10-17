'use strict';
const fs = require('node:fs');
const path = require('node:path');

const AUDIO_EXTENSIONS = new Set(['.wav', '.webm', '.ogg', '.mp3', '.m4a']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function savedRecord(store, id) {
  if (store.closed) throw new Error('应用正在退出。');
  const record = store.getRecord(id);
  if (!record) throw new Error('这条正式记录已不存在。');
  return record;
}
function recordDirectory(store, record) {
  try {
    const directory = store.safePath(store.directory(record.id, 'saved'));
    if (!fs.statSync(directory).isDirectory()) throw new Error('not-a-directory');
    return directory;
  } catch { throw new Error('这条记录的本地文件夹已不可用。'); }
}
function originalAttachment(store, record, { imageOnly = false } = {}) {
  const audio = imageOnly ? null : record.segments?.[0];
  const image = record.screenshots?.[0];
  const selected = audio || image;
  if (!selected) throw new Error('这条记录没有可打开的原始录音或截图。');
  const kind = audio ? 'audio' : 'image';
  const directory = recordDirectory(store, record);
  try {
    const filename = store.safePath(selected.path);
    const relative = path.relative(directory, filename);
    const extensions = kind === 'audio' ? AUDIO_EXTENSIONS : IMAGE_EXTENSIONS;
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !extensions.has(path.extname(filename).toLowerCase()) || !fs.statSync(filename).isFile()) throw new Error('not-an-original-file');
    return { filename, kind };
  } catch { throw new Error('原始文件已不可用，或不是这条记录的受支持附件。'); }
}

async function openOriginal({ store, shell }, id) {
  const record = savedRecord(store, id);
  const { filename, kind } = originalAttachment(store, record);
  try {
    const error = await shell.openPath(filename);
    if (error) throw new Error('open-failed');
  } catch { throw new Error('无法打开原始文件，请检查文件或默认播放/看图应用。'); }
  return { opened: true, kind };
}

async function revealRecord({ store, shell }, id) {
  const record = savedRecord(store, id);
  const directory = recordDirectory(store, record);
  try {
    const error = await shell.openPath(directory);
    if (error) throw new Error('open-failed');
  } catch { throw new Error('无法打开这条记录所在的文件夹，请稍后重试。'); }
  return { revealed: true, kind: 'folder' };
}

function revealScreenshot({ store, shell }, id) {
  const record = savedRecord(store, id);
  const screenshot = record.screenshots[0];
  if (!screenshot) throw new Error('这条记录没有可打开的截图。');
  const { filename } = originalAttachment(store, record, { imageOnly: true });
  // The renderer supplies only a record ID. Never accept arbitrary paths or shell commands.
  try { shell.showItemInFolder(filename); }
  catch { throw new Error('无法打开截图所在文件夹，请确认文件仍存在。'); }
  return { revealed: true };
}

module.exports = { revealScreenshot, openOriginal, revealRecord };
