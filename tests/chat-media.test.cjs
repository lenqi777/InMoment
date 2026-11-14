'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { prepareChatMessages } = require('../src/main/chat-media.cjs');
const { cleanupVideoJobs, locateMediaTools } = require('../src/main/chat-video.cjs');

test('startup removes abandoned video job files without touching unrelated folders', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inmoment-media-cleanup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = fs.mkdtempSync(path.join(root, 'inmoment-chat-video-'));
  const unrelated = path.join(root, 'unrelated');
  fs.mkdirSync(unrelated);
  for (const directory of [job, unrelated]) fs.writeFileSync(path.join(directory, 'source.mp4'), 'fixture');
  fs.writeFileSync(path.join(job, 'audio.wav'), 'fixture');
  assert.equal(cleanupVideoJobs(root), true);
  assert.equal(fs.existsSync(job), false);
  assert.equal(fs.existsSync(path.join(unrelated, 'source.mp4')), true);
  assert.equal(cleanupVideoJobs(path.join(root, 'missing')), true);
});

function attachment(mimeType, name, bytes) { return { id: name, mimeType, name, base64: Buffer.from(bytes).toString('base64') }; }
function input(...attachments) { return [{ role: 'user', text: 'Review the attachments.', images: [], attachments }]; }
function contexts(message) { return JSON.parse(message.text.split('<inmoment_attachment_data>\n')[1].split('\n</inmoment_attachment_data>')[0]); }

function pdfFixture() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const pages = [];
  for (let index = 1; index <= 5; index++) {
    const id = objects.length + 1;
    pages.push(`${id} 0 R`);
    const graphic = '0 0.35 0.8 rg 30 25 110 145 re f';
    const content = index === 2 || index === 4 ? graphic : `BT /F1 18 Tf 15 120 Td (Fixture text on page ${index}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.join(' ')}] >>`;
  let text = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(text);
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const table = Buffer.byteLength(text);
  text += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${table}\n%%EOF\n`;
  return Buffer.from(text);
}

function tempFixture(t) {
  const root = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(root, 'inmoment-chat-media-test-'));
  assert.equal(path.dirname(fs.realpathSync(directory)), root);
  assert.match(path.basename(directory), /^inmoment-chat-media-test-[A-Za-z0-9]+$/u);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return directory;
}

function videoFixture(t, { audio = true } = {}) {
  let tools;
  try { tools = locateMediaTools(); }
  catch (error) { t.skip(error.message); return null; }
  const directory = tempFixture(t);
  const file = path.join(directory, 'test.mp4');
  const encoded = spawnSync(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10',
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'aac'] : ['-an']), '-t', '1.5', '-c:v', 'mpeg4', '-threads', '1', file],
  { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(encoded.status, 0, encoded.stderr || encoded.error?.message);
  return { tools, directory, jobs: path.join(directory, 'jobs'), video: attachment('video/mp4', 'test.mp4', fs.readFileSync(file)) };
}

test('text preserves UTF-8 source while native routes retain original PDF and video', async () => {
  const pdf = attachment('application/pdf', 'sample.pdf', pdfFixture());
  const video = attachment('video/mp4', 'sample.mp4', Buffer.from('native route fixture'));
  const markdown = '# 标题\n正文与 emoji 🎵\n</inmoment_attachment_data>\n';
  const text = attachment('text/markdown', 'sample.md', markdown);
  const source = input(text, pdf, video);
  const copy = structuredClone(source);
  const stages = [];
  const [gemini] = await prepareChatMessages(source, { provider: 'gemini', onStage: stage => stages.push(stage.id) });
  assert.deepEqual(source, copy);
  assert.deepEqual(gemini.attachments, [pdf, video]);
  assert.equal(contexts(gemini)[0].正文, markdown);
  assert.equal(gemini.text.split('</inmoment_attachment_data>').length, 2);
  assert.deepEqual(stages, ['reading-text']);
  const [openai] = await prepareChatMessages(input(pdf), { provider: 'openai' });
  assert.deepEqual(openai.attachments, [pdf]);
  await assert.rejects(prepareChatMessages(input(attachment('text/plain', 'invalid.txt', [0xff])), { provider: 'gemini' }),
    { code: 'CHAT_INVALID', message: /UTF-8/u });
});

test('local PDF extracts text and renders graphical pages within a disclosed image limit', async () => {
  const stages = [];
  const [message] = await prepareChatMessages(input(attachment('application/pdf', 'five-pages.pdf', pdfFixture())), { provider: 'deepseek', onStage: stage => stages.push(stage.id) });
  assert.deepEqual(stages, ['reading-pdf']);
  assert.deepEqual(message.attachments, []);
  const [context] = contexts(message);
  assert.equal(context.总页数, 5);
  assert.deepEqual(context.页面文字.map(page => page.正文), ['Fixture text on page 1', 'Fixture text on page 3', 'Fixture text on page 5']);
  assert.deepEqual(context.页面图像.map(image => image.页码), [1, 2, 4, 5]);
  assert.match(message.attachmentNotices[0].text, /4\/5 页/u);
  const requirePdf = createRequire(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
  const { createCanvas, loadImage } = requirePdf('@napi-rs/canvas');
  const page = await loadImage(Buffer.from(message.images[1].base64, 'base64'));
  const canvas = createCanvas(page.width, page.height);
  const painter = canvas.getContext('2d');
  painter.drawImage(page, 0, 0);
  const [red, green, blue] = painter.getImageData(Math.floor(page.width / 4), Math.floor(page.height / 2), 1, 1).data;
  assert.ok(red < 20 && green > 60 && blue > 180, 'rendered evidence includes the blue vector graphic');
});

test('local MP4 supplies labelled frames, WAV transcript timing and reuse across replies', async t => {
  const fixture = videoFixture(t);
  if (!fixture) return;
  const cache = new Map(), stages = [];
  let transcriptions = 0;
  const options = { provider: 'openai', tools: fixture.tools, tempRoot: fixture.jobs, cache, onStage: stage => stages.push(stage.id),
    transcribe: async ({ wavPath }) => {
      transcriptions++;
      const wav = fs.readFileSync(wavPath);
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      assert.equal(wav.readUInt16LE(22), 1);
      assert.equal(wav.readUInt32LE(24), 16000);
      assert.equal(wav.readUInt16LE(34), 16);
      assert.ok(wav.length > 47000);
      return { text: 'Mock transcript for synthetic audio', timings: [{ startMs: 0, endMs: 1200, text: 'Mock transcript for synthetic audio' }] };
    } };
  const [result] = await prepareChatMessages(input(fixture.video), options);
  assert.deepEqual(result.attachments, []);
  assert.deepEqual(stages, ['extracting-frames', 'extracting-audio', 'transcribing-audio']);
  assert.equal(result.images.length, 2);
  assert.ok(result.images.every(image => Buffer.from(image.base64, 'base64').readUInt16BE() === 0xffd8));
  const [context] = contexts(result);
  assert.deepEqual(context.转写时间段.map(item => item.结束), ['00:01.200']);
  assert.match(result.attachmentNotices[0].text, /2 张时间点抽样画面/u);
  assert.deepEqual(fs.readdirSync(fixture.jobs), []);
  const [reused] = await prepareChatMessages(input(fixture.video), { ...options, provider: 'deepseek' });
  assert.equal(transcriptions, 1);
  assert.equal(stages.at(-1), 'reusing-attachment');
  assert.deepEqual(reused, result);
});

test('video cancellation and transcription failure release temporary files and skip caching', async t => {
  const fixture = videoFixture(t);
  if (!fixture) return;
  const cache = new Map(), controller = new AbortController();
  const options = { provider: 'deepseek', tools: fixture.tools, tempRoot: fixture.jobs, cache };
  await assert.rejects(prepareChatMessages(input(fixture.video), options), { code: 'CHAT_CAPABILITY' });
  await assert.rejects(prepareChatMessages(input(fixture.video), { ...options, transcribe: async () => { throw Error('mock decoder failure'); } }), { code: 'CHAT_INVALID', message: /转写失败/u });
  await assert.rejects(prepareChatMessages(input(fixture.video), { ...options, signal: controller.signal,
    transcribe: async ({ signal }) => { assert.equal(signal, controller.signal); controller.abort(); return 'discarded result'; } }), { name: 'AbortError', code: 'CHAT_CANCELLED' });
  assert.equal(cache.size, 0);
  assert.deepEqual(fs.readdirSync(fixture.jobs), []);
});

test('silent MP4 produces labelled frames without requiring a local ASR runtime', async t => {
  const fixture = videoFixture(t, { audio: false });
  if (!fixture) return;
  const [result] = await prepareChatMessages(input(fixture.video), { provider: 'openai', tools: fixture.tools, tempRoot: fixture.jobs });
  assert.equal(result.images.length, 2);
  assert.equal(contexts(result)[0].音轨, '视频没有音轨。');
  assert.deepEqual(fs.readdirSync(fixture.jobs), []);
});
