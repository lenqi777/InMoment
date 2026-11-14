'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalize: normalizeOutline } = require('../shared/note-outline.js');

const NOTE_OCR_MAX_BYTES = 32 * 1024 * 1024;
const NOTE_OCR_MAX_PIXELS = 24_000_000;
const PNG_HEADER = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const OCR_BUNDLE = 'offline-ocr';
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_TEXT = 100_000;
const MAX_SYMBOLS = 30_000;
const CJK_GAP = /(?<=[\p{Script=Han}\u3000-\u303f\uff01\uff08\uff09\uff0c\uff1a\uff1b\uff1f])[ \t]+(?=[\p{Script=Han}\u3000-\u303f\uff01\uff08\uff09\uff0c\uff1a\uff1b\uff1f])/gu;

function problem(code, message) { return Object.assign(new Error(message), { code }); }
function unavailable() { return problem('OCR_UNAVAILABLE', '本地文字识别组件不可用，请重新安装 InMoment。'); }
function failed() { return problem('OCR_FAILED', '无法识别这张图片，请检查图片或缩小选区后重试。'); }
function tooMuchText() { return problem('OCR_LIMIT', '识别出的文字较多，请分区域提取。'); }
function cancelled() { return Object.assign(problem('OCR_CANCELLED', '已取消图片文字识别。'), { name: 'AbortError' }); }

function inspectNoteOcrImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || bytes.length > NOTE_OCR_MAX_BYTES) {
    throw problem('OCR_IMAGE', '图片数据无效或过大，请缩小选区后重试。');
  }
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, 24);
  if (!header.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) {
    throw problem('OCR_IMAGE', '无法读取用于文字识别的图片。');
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (!width || !height || width > 32_767 || height > 32_767 || width * height > NOTE_OCR_MAX_PIXELS) {
    throw problem('OCR_IMAGE', '图片像素超出识别范围，请缩小选区后重试。');
  }
  return { width, height };
}

function cleanLine(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '').trim().replace(CJK_GAP, '') : '';
}

function normalizeNoteOcr(data, { width, height }) {
  const clamp = (value, max) => Math.max(0, Math.min(value, max));
  function geometry(raw) {
    if (!Array.isArray(raw) || raw.length !== 4 || raw.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))) return null;
    const points = raw.map(([x, y]) => [clamp(x, width), clamp(y, height)]);
    const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
    const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
    const right = Math.ceil(Math.max(...xs)), bottom = Math.ceil(Math.max(...ys));
    return right > x && bottom > y ? { points, bounds: { x, y, width: right - x, height: bottom - y } } : null;
  }
  const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '').trim() : '';
  let count = 0;
  const blocks = [];
  for (const line of data.lines) {
    const shape = geometry(line?.points);
    const text = cleanLine(line?.text);
    if (!shape || !text) continue;
    const words = [];
    for (const entry of line.chars || []) {
      const char = clean(entry?.text);
      const charShape = geometry(entry?.points);
      if (!char || !charShape) continue;
      if (++count > MAX_SYMBOLS) throw tooMuchText();
      const symbol = { text: char, ...charShape };
      words.push({ ...symbol, symbols: [symbol] });
    }
    blocks.push({ text, ...shape, lines: [{ text, ...shape, words }] });
  }
  const text = blocks.map(block => block.text).join('\n');
  if (text.length > MAX_TEXT) throw tooMuchText();
  const outline = normalizeOutline(data.outline, cleanLine);
  return { width, height, text, blocks, ...(outline && { outline }) };
}

function resolveBundle() {
  const root = path.resolve(__dirname, '..', '..');
  const packaged = path.join(root, OCR_BUNDLE);
  if (fs.existsSync(packaged) || (process.resourcesPath && path.resolve(process.resourcesPath, 'app') === root)) return packaged;
  return path.join(root, '.local', OCR_BUNDLE);
}

function createNoteOcr({
  spawnProcess = spawn,
  bundlePath = resolveBundle(),
  timeout = 45_000,
  idleTimeout = 60_000,
} = {}) {
  let worker, active, idleTimer, closing;
  let termination = Promise.resolve();

  function endWorker() {
    clearTimeout(idleTimer);
    const runtime = worker;
    worker = null;
    if (runtime) {
      termination = runtime.closed;
      runtime.child.kill();
    }
    return termination;
  }

  function finish(job, error, value) {
    if (active !== job) return;
    active = null;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    if (error) {
      endWorker();
      job.reject(error);
    } else {
      idleTimer = setTimeout(endWorker, idleTimeout);
      idleTimer.unref();
      job.resolve(value);
    }
  }

  function startWorker() {
    const executable = path.join(bundlePath, 'python', 'python.exe');
    const runner = path.join(__dirname, 'note-ocr-runner.py');
    const child = spawnProcess(executable, ['-I', '-B', '-u', runner, bundlePath], {
      windowsHide: true, shell: false, cwd: bundlePath, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const runtime = { child, closed: new Promise(resolve => child.once('close', resolve)) };
    worker = runtime;
    const onExit = error => {
      if (worker !== runtime) return;
      worker = null;
      clearTimeout(idleTimer);
      termination = runtime.closed;
      if (active) finish(active, error);
    };
    child.once('error', () => onExit(unavailable()));
    child.once('close', () => onExit(failed()));
    child.stdin.on('error', () => {
      if (worker === runtime && active) finish(active, unavailable());
    });
    child.stdout.on('data', chunk => {
      if (worker !== runtime || !active) return;
      const job = active;
      job.outputBytes += chunk.length;
      if (job.outputBytes > MAX_OUTPUT) { finish(job, tooMuchText()); return; }
      job.chunks.push(chunk);
      const newline = chunk.indexOf(10);
      if (newline < 0) return;
      try {
        if (newline !== chunk.length - 1) throw failed();
        const message = JSON.parse(Buffer.concat(job.chunks).toString('utf8'));
        if (message?.error === 'capability') throw unavailable();
        if (message?.error === 'limit') throw tooMuchText();
        if (!Array.isArray(message?.data?.lines)) throw failed();
        finish(job, null, normalizeNoteOcr(message.data, job.size));
      } catch (error) {
        finish(job, error.code ? error : failed());
      }
    });
    return runtime;
  }

  async function recognize(bytes, { signal } = {}) {
    if (closing || signal?.aborted) throw cancelled();
    const size = inspectNoteOcrImage(bytes);
    if (active) throw problem('OCR_BUSY', '正在识别另一张图片，请稍后重试。');
    clearTimeout(idleTimer);
    return new Promise((resolve, reject) => {
      const job = { size, signal, resolve, reject, chunks: [], outputBytes: 0, abort: () => finish(job, cancelled()) };
      job.timer = setTimeout(() => finish(job, problem('OCR_TIMEOUT', '图片文字识别超时，请缩小选区后重试。')), timeout);
      active = job;
      signal?.addEventListener('abort', job.abort, { once: true });
      if (signal?.aborted) { job.abort(); return; }
      termination.then(() => {
        if (active !== job) return;
        const { child } = worker || startWorker();
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        child.stdin.write(length);
        child.stdin.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      }).catch(() => finish(job, unavailable()));
    });
  }

  function close() {
    if (closing) return closing;
    const stopped = endWorker();
    if (active) finish(active, cancelled());
    closing = stopped;
    return closing;
  }

  return { recognize, close };
}

module.exports = { createNoteOcr, inspectNoteOcrImage, normalizeNoteOcr, OCR_BUNDLE, NOTE_OCR_MAX_BYTES, NOTE_OCR_MAX_PIXELS };
