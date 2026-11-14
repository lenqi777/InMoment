'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');

function sample(items, limit) {
  if (items.length <= limit) return items;
  if (limit === 1) return [items[0]];
  return Array.from({ length: limit }, (_, index) => items[Math.round(index * (items.length - 1) / (limit - 1))]);
}

async function analyze() {
  let pdfjs, runtime;
  try {
    runtime = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    createRequire(runtime)('@napi-rs/canvas');
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch { return { error: 'capability' }; }

  const root = path.dirname(path.dirname(path.dirname(runtime)));
  const resource = name => path.join(root, name).replaceAll('\\', '/') + '/';
  const loading = pdfjs.getDocument({ data: workerData.data, cMapUrl: resource('cmaps'), cMapPacked: true,
    standardFontDataUrl: resource('standard_fonts'), wasmUrl: resource('wasm'), useWorkerFetch: false,
    isEvalSupported: false, stopAtErrors: true, maxImageSize: 25000000, canvasMaxAreaInBytes: 48000000 });
  try {
    const document = await loading.promise;
    const pageCount = document.numPages;
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 1000) return { error: 'pages' };
    const all = Array.from({ length: pageCount }, (_, index) => index + 1);
    const textPages = sample(all, 40);
    const scanPages = [], texts = [];
    let remainingText = 40000;
    for (const number of textPages) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = content.items.map(item => typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
        if (text) {
          const used = text.slice(0, remainingText);
          texts.push({ page: number, text: used, clipped: used.length < text.length });
          remainingText -= used.length;
        } else scanPages.push(number);
      } finally { page.cleanup(); }
    }
    const renderPages = sample(scanPages, workerData.imageLimit);
    for (const number of sample(all.filter(page => !renderPages.includes(page)), workerData.imageLimit - renderPages.length)) {
      if (renderPages.length < workerData.imageLimit) renderPages.push(number);
    }
    renderPages.sort((a, b) => a - b);
    const images = [];
    for (const number of renderPages) {
      const page = await document.getPage(number);
      let canvas;
      try {
        const natural = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 1360 / Math.max(natural.width, natural.height) });
        canvas = document.canvasFactory.create(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
        await page.render({ canvasContext: canvas.context, viewport, background: 'white' }).promise;
        const jpeg = canvas.canvas.toBuffer('image/jpeg', 84);
        if (!jpeg.length || jpeg.length > 1024 * 1024) return { error: 'render' };
        images.push({ page: number, mimeType: 'image/jpeg', base64: jpeg.toString('base64') });
      } finally {
        if (canvas) document.canvasFactory.destroy(canvas);
        page.cleanup();
      }
    }
    return { pageCount, textPages, texts, images };
  } catch (error) {
    return { error: error?.name === 'PasswordException' ? 'password' : 'document' };
  } finally { await loading.destroy().catch(() => {}); }
}

if (parentPort) analyze().then(result => parentPort.postMessage(result), () => parentPort.postMessage({ error: 'document' }));
