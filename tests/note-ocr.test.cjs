'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { createNoteOcr, inspectNoteOcrImage, normalizeNoteOcr } = require('../src/main/note-ocr.cjs');

function pngHeader(width = 1200, height = 600) {
  const bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test('OCR rejects oversized, empty and non-PNG images before dispatch', async t => {
  const worker = t.mock.fn();
  const ocr = createNoteOcr({ spawnProcess: worker });
  assert.deepEqual(inspectNoteOcrImage(pngHeader()), { width: 1200, height: 600 });
  await assert.rejects(ocr.recognize(pngHeader(0, 600)), { code: 'OCR_IMAGE' });
  await assert.rejects(ocr.recognize(pngHeader(6_000, 6_000)), { code: 'OCR_IMAGE' });
  await assert.rejects(ocr.recognize(pngHeader(35_000, 1)), { code: 'OCR_IMAGE' });
  await assert.rejects(ocr.recognize(Buffer.alloc(33)), { code: 'OCR_IMAGE' });
  assert.equal(worker.mock.callCount(), 0);
  await ocr.close();
});

const rectangle = (left, top, right, bottom) => [[left, top], [right, top], [right, bottom], [left, bottom]];
function recognizedLine(text, chars = []) {
  return { text, points: rectangle(3, 4, 24, 36), chars };
}

test('OCR keeps line order and clips Chinese character quadrilaterals to the input', () => {
  const { width, height, text, blocks } = normalizeNoteOcr({
    lines: [recognizedLine('答 题 技 巧 ， English words\n', [
      { text: '答', points: [[-2, 6], [10, 4], [9, 47], [-4, 60]] },
      { text: '题', points: rectangle(10, 4, 24, 60) },
      { text: '丢弃', points: rectangle(40, 4, 45, 60) },
    ]), recognizedLine('总结\n')],
  }, { width: 30, height: 50 });
  assert.equal(width, 30);
  assert.equal(height, 50);
  assert.equal(text, '答题技巧， English words\n总结');
  assert.deepEqual(blocks[0].lines[0].words.flatMap(word => word.symbols), [
    { text: '答', points: [[0, 6], [10, 4], [9, 47], [0, 50]], bounds: { x: 0, y: 4, width: 10, height: 46 } },
    { text: '题', points: rectangle(10, 4, 24, 50), bounds: { x: 10, y: 4, width: 14, height: 46 } },
  ]);
  assert.deepEqual(normalizeNoteOcr({ lines: [] }, { width: 1, height: 1 }), {
    width: 1, height: 1, text: '', blocks: [],
  });
});

test('layout output preserves text lines and order while raw recognition stays available', () => {
  const size = { width: 100, height: 100 };
  const lines = [recognizedLine('例题'), recognizedLine('主 题')];
  const roots = [{ lines: ['主 题'], children: [{ lines: ['例题', '材料', '解析'], children: [] }] }];
  const result = normalizeNoteOcr({ lines, outline: { roots, unassigned: [] } }, size);
  assert.equal(result.text, '例题\n主题');
  assert.deepEqual(result.outline, {
    roots: [{ lines: ['主题'], children: [{ lines: ['例题', '材料', '解析'], children: [] }] }], unassigned: [],
  });
  const invalid = normalizeNoteOcr({ lines, outline: { roots: [{ lines: [], children: [] }], unassigned: [] } }, size);
  assert.equal(invalid.text, result.text);
  assert.equal(invalid.outline, undefined);
});

function fixture(t, options) {
  const jobs = new EventEmitter();
  const workers = [];
  const ocr = createNoteOcr({
    bundlePath: path.resolve('offline-fixture'),
    spawnProcess: (binary, args, settings) => {
      assert.equal(binary, path.resolve('offline-fixture', 'python', 'python.exe'));
      assert.deepEqual(args.slice(0, 3), ['-I', '-B', '-u']);
      assert.equal(path.basename(args[3]), 'note-ocr-runner.py');
      assert.equal(args[4], path.resolve('offline-fixture'));
      assert.equal(settings.shell, false);
      const worker = new EventEmitter();
      worker.stdout = new PassThrough();
      worker.kill = t.mock.fn(() => { queueMicrotask(() => worker.emit('close')); });
      worker.result = message => {
        const bytes = Buffer.from(JSON.stringify(message) + '\n');
        const midpoint = Math.floor(bytes.length / 2);
        worker.stdout.write(bytes.subarray(0, midpoint));
        worker.stdout.write(bytes.subarray(midpoint));
      };
      let size;
      worker.stdin = new Writable({ write(chunk, _encoding, callback) {
        if (size === undefined) size = chunk.readUInt32BE();
        else {
          assert.equal(size, chunk.length);
          assert.deepEqual(inspectNoteOcrImage(chunk), { width: 1200, height: 600 });
          size = undefined;
          jobs.emit('start', worker);
        }
        callback();
      } });
      workers.push(worker);
      return worker;
    },
    ...options,
  });
  t.after(() => ocr.close());
  return { ocr, jobs, workers };
}

test('abort stops the worker and ignores stale OCR output after a new image starts', async t => {
  const { ocr, jobs, workers } = fixture(t);
  const control = new AbortController();
  const first = ocr.recognize(pngHeader(), { signal: control.signal });
  const [worker] = await once(jobs, 'start');
  await assert.rejects(ocr.recognize(pngHeader()), { code: 'OCR_BUSY' });
  control.abort();
  await assert.rejects(first, { code: 'OCR_CANCELLED', name: 'AbortError' });
  assert.equal(worker.kill.mock.callCount(), 1);
  const next = ocr.recognize(pngHeader());
  const [replacement] = await once(jobs, 'start');
  worker.result({ data: { lines: [recognizedLine('过期')] } });
  replacement.result({ data: { lines: [recognizedLine('新图片')] } });
  assert.equal((await next).text, '新图片');
  assert.equal(workers.length, 2);
});

test('a missing or failed offline runtime reports its capability error and can retry', async t => {
  const { ocr, jobs } = fixture(t);
  const first = ocr.recognize(pngHeader());
  const [worker] = await once(jobs, 'start');
  worker.result({ error: 'capability' });
  await assert.rejects(first, { code: 'OCR_UNAVAILABLE' });
  const next = ocr.recognize(pngHeader());
  const [replacement] = await once(jobs, 'start');
  replacement.result({ data: { lines: [recognizedLine('重试成功')] } });
  assert.equal((await next).text, '重试成功');
});

test('a stalled recognition times out and service close cancels current and future requests', async t => {
  const { ocr, jobs } = fixture(t, { timeout: 30 });
  const first = ocr.recognize(pngHeader());
  const [worker] = await once(jobs, 'start');
  await assert.rejects(first, { code: 'OCR_TIMEOUT' });
  assert.equal(worker.kill.mock.callCount(), 1);
  const next = ocr.recognize(pngHeader());
  const [replacement] = await once(jobs, 'start');
  const rejected = assert.rejects(next, { code: 'OCR_CANCELLED' });
  await ocr.close();
  await rejected;
  assert.equal(replacement.kill.mock.callCount(), 1);
  await assert.rejects(ocr.recognize(pngHeader()), { code: 'OCR_CANCELLED' });
});

test('sequential OCR requests reuse the same child process until the service closes', async t => {
  const { ocr, jobs, workers } = fixture(t);
  for (const text of ['第一张', '第二张']) {
    const response = ocr.recognize(pngHeader());
    const [worker] = await once(jobs, 'start');
    worker.result({ data: { lines: [recognizedLine(text)] } });
    assert.equal((await response).text, text);
  }
  assert.equal(workers.length, 1);
});

test('a malformed response is reported and the subprocess is discarded', async t => {
  const { ocr, jobs } = fixture(t);
  const response = ocr.recognize(pngHeader());
  const [worker] = await once(jobs, 'start');
  worker.stdout.write(Buffer.from('not a response\n'));
  await assert.rejects(response, { code: 'OCR_FAILED' });
  assert.equal(worker.kill.mock.callCount(), 1);
});
