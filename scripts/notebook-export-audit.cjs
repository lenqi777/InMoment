'use strict';

// Run the installed application, its dialogs, and Chromium's PDF renderer
// against an isolated library. Only the native destination chooser is injected.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require(process.env.INMOMENT_PLAYWRIGHT || 'playwright');
const { LocalStore } = require('../src/core/store.cjs');
const { NotesStore } = require('../src/main/notes.cjs');

const root = path.resolve(__dirname, '..');
const executablePath = process.env.INMOMENT_SMOKE_EXECUTABLE;
const output = path.join(root, '.local', 'notebook-export');
fs.mkdirSync(output, { recursive: true });
const run = fs.mkdtempSync(path.join(output, 'run-'));
const dataDir = path.join(run, 'data');
const report = { executablePath, checks: [], errors: [] };

async function seed() {
  const store = new LocalStore(dataDir);
  try {
    const notes = new NotesStore(store);
    const parent = store.createTopic('导出验收');
    const child = store.createTopic('子分组', parent.id);
    const a = notes.create(parent.id, { title: '项目笔记', body: '项目笔记正文，用于确认 PDF 中文。\n第二行保留换行。' });
    const b = notes.create(child.id, { title: '子组笔记', body: '子组正文随分组导出。' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
    await notes.attachBytes(a.id, [{ name: '测试图片.png', bytes: png }, { name: '验收资料.txt', bytes: Buffer.from('附件原字节') }]);
    notes.createSummary(a.id, '总结笔记也会导出。');
    return { parent, child, a, b };
  } finally { store.close(); }
}

async function main() {
  const { parent, child, a, b } = await seed();
  const env = { ...process.env, INMOMENT_DATA_DIR: dataDir, INMOMENT_ASR_DIR: path.join(run, 'disabled-asr'), INMOMENT_SMOKE: '1', INMOMENT_DISABLE_NETWORK: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const app = await _electron.launch({ executablePath: executablePath || require('electron'), args: executablePath ? [] : [root], cwd: root, env, timeout: 25000 });
  try {
    await app.firstWindow();
    let page;
    for (let attempt = 0; attempt < 100 && !page; attempt++) {
      page = app.windows().find(window => window.url().includes('/renderer/'));
      if (!page) await new Promise(resolve => setTimeout(resolve, 80));
    }
    assert.ok(page);
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.route(/^https?:\/\//u, route => { report.errors.push('Unexpected network request'); return route.abort(); });
    await app.evaluate(({ BrowserWindow, dialog }, directory) => {
      const path = process.mainModule.require('node:path');
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/renderer/'));
      main.show();
      dialog.showSaveDialog = async (_window, { defaultPath }) => ({ canceled: false, filePath: path.join(directory, defaultPath) });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, run);
    await page.waitForFunction(() => typeof state !== 'undefined' && state.settings.networkDisabled);
    const invoke = (method, params) => page.evaluate(([method, params]) => window.inmoment.invoke(method, params), [method, params]);
    const remote = page.locator('#confirm-dialog');
    async function choose(pending, ...choices) {
      pending.catch(() => {});
      for (const name of choices) {
        const button = remote.getByRole('button', { name, exact: true });
        await page.waitForFunction(node => !node.disabled, await button.elementHandle());
        await button.press('Enter');
        await button.waitFor({ state: 'hidden' });
      }
      return Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('Export IPC did not resolve.')), 8000).unref())]);
    }

    const markdown = await choose(invoke('notes:export', { groupIds: [parent.id] }), '合为一个文件', 'Markdown');
    assert.equal(markdown.count, 2);
    assert.match(fs.readFileSync(markdown.path, 'utf8'), /项目笔记正文[\s\S]*总结笔记也会导出/u);
    assert.match(fs.readFileSync(markdown.path, 'utf8'), /子组正文随分组导出/u);
    assert.deepEqual(fs.readdirSync(markdown.assets).map(name => path.extname(name)).sort(), ['.png', '.txt']);
    report.checks.push({ name: 'group exports parent and descendant to combined Markdown with attachments', markdown });

    const pdf = await choose(invoke('notes:export', { ids: [a.id] }), 'PDF');
    assert.equal(fs.readFileSync(pdf.path).subarray(0, 5).toString(), '%PDF-');
    assert.equal(fs.readFileSync(path.join(pdf.assets, fs.readdirSync(pdf.assets).find(name => name.endsWith('.txt'))), 'utf8'), '附件原字节');
    const combinedPdf = await choose(invoke('notes:export', { groupIds: [parent.id] }), '合为一个文件', 'PDF');
    assert.equal(combinedPdf.count, 2);
    assert.equal(fs.readFileSync(combinedPdf.path).subarray(0, 5).toString(), '%PDF-');
    const split = await choose(invoke('notes:export', { groupIds: [parent.id] }), '每条一个文件', 'PDF');
    assert.equal(split.count, 2);
    const pdfFiles = fs.readdirSync(split.path).filter(name => name.endsWith('.pdf'));
    assert.equal(pdfFiles.length, 2);
    for (const name of pdfFiles) assert.equal(fs.readFileSync(path.join(split.path, name)).subarray(0, 5).toString(), '%PDF-');
    report.checks.push({ name: 'single, combined, and separate PDFs are produced by Electron', pdf, combinedPdf, split });

    const duplicate = (await invoke('notes:copy', { ids: [a.id], topicId: child.id })).notes[0];
    assert.notEqual(duplicate.id, a.id);
    assert.deepEqual(duplicate.topicIds, [child.id]);
    assert.equal(duplicate.summaries.length, 1);
    assert.equal(duplicate.attachments.length, 2);
    assert.deepEqual((await invoke('notes:listIds', { topicId: child.id })).ids.sort(), [b.id, duplicate.id].sort());
    await invoke('notes:update', { id: duplicate.id, title: '副本编辑', body: '内容独立' });
    assert.equal((await invoke('notes:get', { id: a.id })).title, a.title);
    const deleted = await invoke('notes:deleteMany', { ids: [duplicate.id, b.id] });
    assert.equal(deleted.deleted.length, 2);
    assert.deepEqual((await invoke('notes:listIds', { topicId: child.id })).ids, []);
    assert.equal((await invoke('notes:get', { id: a.id })).attachments.length, 2);
    report.checks.push({ name: 'copy to group and multi-delete leave original note and files independent' });

    const before = fs.readdirSync(run);
    assert.equal(await choose(invoke('notes:export', { groupIds: [parent.id] }), '取消'), null);
    assert.deepEqual(fs.readdirSync(run), before);
    assert.equal(fs.readdirSync(dataDir).some(name => name.startsWith('.note-print-')), false);
    report.checks.push({ name: 'cancel writes nothing and print scratch files are cleaned' });
    assert.deepEqual(report.errors, []);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
}

main().catch(error => { report.errors.push(error.stack || error.message); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ run, ...report }));
});
