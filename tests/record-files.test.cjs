'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LocalStore } = require('../src/core/store.cjs');
const { revealScreenshot, openOriginal, revealRecord } = require('../src/main/record-files.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(__dirname, '.tmp-record-files-'));
  const store = new LocalStore(root), revealed = [], opened = [];
  const services = { store, shell: { showItemInFolder: filename => revealed.push(filename), async openPath(filename) { opened.push(filename); return ''; } } };
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, services, revealed, opened };
}

test('folder reveal selects the stored original screenshot without exposing a path to the renderer', t => {
  const fx = fixture(t); const draft = fx.store.createDraft({});
  fx.store.addScreenshot(draft.id, Buffer.from('synthetic-original-image'), {}, fx.store.draftToken(draft.id));
  const record = fx.store.complete(draft.id);
  assert.deepEqual(revealScreenshot(fx.services, record.id), { revealed: true });
  assert.deepEqual(fx.revealed, [record.screenshots[0].path]);
  assert.equal(fs.readFileSync(fx.revealed[0], 'utf8'), 'synthetic-original-image');
});

test('missing screenshot, provisional draft, and deleted record never open an arbitrary folder', t => {
  const fx = fixture(t); const draft = fx.store.createDraft({});
  assert.throws(() => revealScreenshot(fx.services, draft.id), /正式记录/);
  fx.store.complete(draft.id); assert.throws(() => revealScreenshot(fx.services, draft.id), /没有/);
  fx.store.deleteRecord(draft.id); assert.throws(() => revealScreenshot(fx.services, draft.id), /正式记录/);
  assert.equal(fx.revealed.length, 0);
});

test('removed or unsafe attachment paths are rejected before any OS folder action', t => {
  const fx = fixture(t); const draft = fx.store.createDraft({});
  fx.store.addScreenshot(draft.id, Buffer.from('synthetic-image'), {}, fx.store.draftToken(draft.id));
  const record = fx.store.complete(draft.id); fs.unlinkSync(record.screenshots[0].path);
  assert.throws(() => revealScreenshot(fx.services, record.id), /不可用/);
  const unsafe = { store: { getRecord: () => ({ screenshots: [{ path: path.resolve('outside.png') }] }), safePath: () => { throw new Error('outside local data'); } }, shell: fx.services.shell };
  assert.throws(() => revealScreenshot(unsafe, record.id), /不可用/);
  assert.equal(fx.revealed.length, 0);
});

test('shell failure is a visible sanitized error and leaves the original screenshot intact', t => {
  const fx = fixture(t); const draft = fx.store.createDraft({});
  fx.store.addScreenshot(draft.id, Buffer.from('synthetic-image'), {}, fx.store.draftToken(draft.id));
  const record = fx.store.complete(draft.id);
  fx.services.shell.showItemInFolder = () => { throw new Error('private operating-system diagnostic'); };
  assert.throws(() => revealScreenshot(fx.services, record.id), error => /无法打开/.test(error.message) && !error.message.includes('private'));
  assert.equal(fs.existsSync(record.screenshots[0].path), true);
});

test('original file opens the first recording and the folder action opens only that record directory', async t => {
  const fx = fixture(t); const draft = fx.store.createDraft({});
  fx.store.addSegment(draft.id, { bytes: Buffer.from('synthetic audio one') });
  fx.store.addSegment(draft.id, { bytes: Buffer.from('synthetic audio two') });
  fx.store.addScreenshot(draft.id, Buffer.from('synthetic image'));
  const record = fx.store.complete(draft.id);
  assert.deepEqual(await openOriginal(fx.services, record.id), { opened: true, kind: 'audio' });
  assert.deepEqual(await revealRecord(fx.services, record.id), { revealed: true, kind: 'folder' });
  assert.deepEqual(fx.opened, [record.segments[0].path, fx.store.directory(record.id, 'saved')]);
  assert.equal(fx.store.getRecord(record.id).segments.length, 2);
  assert.equal(fx.store.getRecord(record.id).screenshots.length, 1);
});

test('image-only originals open their screenshot and text-only records still have their own folder', async t => {
  const fx = fixture(t); const draft = fx.store.createDraft({});
  fx.store.addScreenshot(draft.id, Buffer.from('synthetic image'));
  const image = fx.store.complete(draft.id);
  assert.deepEqual(await openOriginal(fx.services, image.id), { opened: true, kind: 'image' });
  assert.equal(fx.opened[0], image.screenshots[0].path);
  const text = fx.store.createDraft({ notes: 'Synthetic text only' }); fx.store.complete(text.id);
  await assert.rejects(openOriginal(fx.services, text.id), /没有/);
  await revealRecord(fx.services, text.id);
  assert.equal(fx.opened.at(-1), fx.store.directory(text.id, 'saved'));
});

test('a draft, deleted record, missing original and shell errors stay visible and never expose paths', async t => {
  const fx = fixture(t); const draft = fx.store.createDraft({});
  await assert.rejects(openOriginal(fx.services, draft.id), /正式记录/);
  await assert.rejects(revealRecord(fx.services, draft.id), /正式记录/);
  fx.store.addSegment(draft.id, { bytes: Buffer.from('synthetic audio') });
  const record = fx.store.complete(draft.id);
  fx.services.shell.openPath = async () => 'private OS diagnostic and path';
  await assert.rejects(openOriginal(fx.services, record.id), error => /无法打开/.test(error.message) && !error.message.includes('private'));
  fx.services.shell.openPath = async () => { throw new Error('private OS exception'); };
  await assert.rejects(revealRecord(fx.services, record.id), error => /无法打开/.test(error.message) && !error.message.includes('private'));
  fs.unlinkSync(record.segments[0].path);
  await assert.rejects(openOriginal(fx.services, record.id), /不可用/);
  fx.store.deleteRecord(record.id);
  await assert.rejects(revealRecord(fx.services, record.id), /正式记录/);
  assert.equal(fx.opened.length, 0);
});

test('a tampered stored path cannot open a different record or an executable inside the data directory', async t => {
  const fx = fixture(t);
  const a = fx.store.createDraft({ id: 'first' }), b = fx.store.createDraft({ id: 'second' });
  fx.store.addSegment(a.id, { bytes: Buffer.from('synthetic first') }); fx.store.addSegment(b.id, { bytes: Buffer.from('synthetic second') });
  const first = fx.store.complete(a.id), second = fx.store.complete(b.id);
  const originalGet = fx.store.getRecord.bind(fx.store);
  fx.store.getRecord = id => id === first.id ? { ...originalGet(id), segments: [{ path: second.segments[0].path }] } : originalGet(id);
  await assert.rejects(openOriginal(fx.services, first.id), /不是这条记录/);
  const executable = path.join(fx.store.directory(first.id, 'saved'), 'not-an-attachment.exe'); fs.writeFileSync(executable, 'synthetic non-executable text');
  fx.store.getRecord = id => ({ ...originalGet(id), segments: [{ path: executable }] });
  await assert.rejects(openOriginal(fx.services, first.id), /受支持附件/);
  assert.equal(fx.opened.length, 0);
});
