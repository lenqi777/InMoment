'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { LocalStore } = require('../src/core/store.cjs');
const { NotesStore, clipboardFilePaths, noteMediaResponse, webLink } = require('../src/main/notes.cjs');
const { exportNotes } = require('../src/main/note-export.cjs');

function fixture(t, prepare = () => {}) {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-notes-'));
  let store = new LocalStore(dir);
  t.after(() => { if (!store.closed) store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  prepare(store);
  return {
    dir,
    get store() { return store; },
    notes: new NotesStore(store),
    reopen() { store.close(); store = new LocalStore(dir); return new NotesStore(store); },
  };
}

test('replacing one inline picture keeps its layout and leaves the prior asset available for undo', async t => {
  const { notes, reopen } = fixture(t);
  const note = notes.create(undefined, { title: '例题', body: '正文' });
  const { attachments } = await notes.attachBytes(note.id, [{ name: '题目.png', bytes: Buffer.from('original') }]);
  const oldId = attachments[0].id;
  const layout = { attachmentId: oldId, width: 260, align: 'right' };
  const document = { version: 1, nodes: [{ tag: 'p', children: [layout, '正文'] }] };
  const current = notes.update(note.id, note.title, note.body, document);
  const { note: edited, replacementId } = await notes.replacePicture(note.id, { attachmentId: oldId, bytes: Buffer.from('edited'), updatedAt: current.updatedAt, displayWidth: 230 });
  const updated = { version: 1, nodes: [{ tag: 'p', children: [{ ...layout, attachmentId: replacementId }, '正文'] }] };
  assert.deepEqual(edited.document, updated);
  assert.deepEqual(edited.attachments.map(asset => asset.id), [oldId, replacementId]);
  assert.deepEqual(notes.get(note.id).attachments.map(asset => asset.id), [replacementId]);
  assert.equal(fs.readFileSync(notes.file(note.id, replacementId).filename, 'utf8'), 'edited');
  await assert.rejects(notes.replacePicture(note.id, { attachmentId: oldId, bytes: Buffer.from('late'), updatedAt: current.updatedAt }), /已变更/u);
  notes.update(note.id, note.title, note.body, document);
  assert.deepEqual(notes.get(note.id).attachments.map(asset => asset.id), [oldId]);
  const restarted = reopen();
  assert.deepEqual(restarted.get(note.id).document, document);
  assert.throws(() => restarted.file(note.id, replacementId), /已不存在/u);
});

test('legacy inline rendering can be edited without an existing document snapshot', async t => {
  const { notes } = fixture(t);
  const note = notes.create(undefined, { title: '旧笔记', body: '正文' });
  const { updatedAt, attachments: [old], document } = await notes.attachBytes(note.id, [{ name: '截图.png', bytes: Buffer.from('original') }]);
  assert.equal(document, null);
  const legacy = { version: 1, nodes: ['正文', { attachmentId: old.id }] };
  const { replacementId } = await notes.replacePicture(note.id, { attachmentId: old.id, bytes: Buffer.from('edited'), updatedAt, legacyDocument: legacy, displayWidth: 230 });
  assert.deepEqual(notes.get(note.id).document.nodes, ['正文', { attachmentId: replacementId, width: 230 }]);
});

test('first content or successful attachment can create an already grouped note without empty placeholders', async t => {
  const { notes, store } = fixture(t);
  const topic = store.createTopic('新建分组');
  const first = notes.create(topic.id, { title: '记录', body: '第一句话' });
  assert.deepEqual(notes.listIds('第一句', topic.id), [first.id]);
  assert.equal(await notes.attachBytes(undefined, [], { topicId: topic.id }), null);
  await assert.rejects(notes.attachPaths(undefined, [path.resolve('absent.txt')], { topicId: topic.id }));
  await assert.rejects(notes.attachBytes(undefined, [{ name: 'a.txt', bytes: Buffer.from('test') }], { topicId: 'missing' }));
  assert.deepEqual(notes.listIds('', topic.id), [first.id]);
  const added = await notes.attachBytes(undefined, [{ name: 'a.txt', bytes: Buffer.from('附件正文') }], { topicId: topic.id });
  assert.deepEqual(added.topicIds, [topic.id]);
  assert.equal(added.attachments.length, 1);
});

test('group hierarchy migrates the flat topics schema without replacing legacy identifiers', t => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-topic-migration-'));
  const database = new DatabaseSync(path.join(dir, 'inmoment.sqlite'));
  database.exec("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL); INSERT INTO topics VALUES ('legacy-group','已有分组','已有分组',11)");
  database.close();
  const store = new LocalStore(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.createTopic('已有分组').id, 'legacy-group');
  assert.deepEqual(store.listTopics().map(({ id, parentId }) => [id, parentId]), [['legacy-group', null]]);
  assert.equal(store.createTopic('新增子分组', 'legacy-group').parentId, 'legacy-group');
});

test('nested groups retain memberships across reopen, reject cycles and reparent contents on group-only deletion', t => {
  const fx = fixture(t);
  const root = fx.store.createTopic('资料');
  const other = fx.store.createTopic('档案');
  const child = fx.store.createTopic('笔记', root.id);
  const conflict = fx.store.createTopic('笔记', other.id);
  const leaf = fx.store.createTopic('下一级', child.id);
  const written = fx.notes.create(child.id, { title: '组内笔记', body: '保留正文' });
  fx.store.createDraft({ id: 'nested-capture', title: '组内录音', topicIds: [child.id] });
  fx.store.complete('nested-capture');
  assert.notEqual(child.id, conflict.id);
  assert.throws(() => fx.store.moveTopic(root.id, leaf.id), /不能将分组/u);
  assert.throws(() => fx.store.moveTopic(child.id, other.id), /同名/u);
  assert.deepEqual(fx.store.topicSubtreeIds([leaf.id, root.id]), [root.id, child.id, leaf.id]);
  fx.store.renameTopic(conflict.id, '已经归档');
  fx.store.moveTopic(child.id, other.id);
  const notes = fx.reopen();
  assert.deepEqual(fx.store.topicSubtreeIds([other.id]), [other.id, conflict.id, child.id, leaf.id]);
  fx.store.deleteTopic(child.id);
  assert.equal(fx.store.listTopics().find(group => group.id === leaf.id).parentId, other.id);
  assert.deepEqual(notes.get(written.id).topicIds, [other.id]);
  assert.deepEqual(notes.get('record:nested-capture').topicIds, [other.id]);
  fx.store.deleteTopics([other.id, leaf.id]);
  assert.equal(fx.store.listTopics().find(group => group.id === conflict.id).parentId, null);
  assert.deepEqual(notes.get(written.id).topicIds, []);
  assert.equal(notes.get(written.id).body, '保留正文');
});

test('merging a parent into a descendant and copying a selected subtree preserve distinct children and shared memberships', t => {
  const { store, notes } = fixture(t);
  const root = store.createTopic('研究');
  const source = store.createTopic('访谈', root.id);
  const branch = store.createTopic('整理中', source.id);
  const target = store.createTopic('正式结论', branch.id);
  const sibling = store.createTopic('复盘', source.id);
  const existing = store.createTopic('复盘', target.id);
  const shared = notes.create(source.id, { title: '共享', body: '仍属于原根组' });
  store.db.prepare('INSERT INTO note_topics(note_id,topic_id) VALUES (?,?)').run(shared.id, root.id);
  const own = notes.create(sibling.id, { title: '独有', body: '仅在分支中' });
  store.mergeTopics([source.id, target.id], target.id);
  assert.deepEqual(new Set(notes.get(shared.id).topicIds), new Set([root.id, target.id]));
  const byId = new Map(store.listTopics().map(group => [group.id, group]));
  assert.equal(byId.get(target.id).parentId, root.id);
  assert.equal(byId.get(branch.id).parentId, target.id);
  assert.equal(byId.get(existing.id).name, '复盘');
  assert.equal(byId.get(sibling.id).name, '复盘 (2)');
  const subtree = store.topicSubtreeIds([target.id, sibling.id]);
  assert.deepEqual([...notes.membershipsInTopics(subtree, { exclusive: true }).keys()], [own.id]);
  const copied = store.copyTopicStructure([target.id, sibling.id], root.id);
  assert.deepEqual(copied.roots, [copied.mapping.get(target.id)]);
  const rootCopy = store.listTopics().find(group => group.id === copied.roots[0]);
  assert.equal(rootCopy.name, '正式结论 副本');
  assert.equal(store.listTopics().find(group => group.id === copied.mapping.get(sibling.id)).parentId, rootCopy.id);
  const copiedNote = notes.copy(own.id, { topicIds: [copied.mapping.get(sibling.id)] });
  notes.delete(copiedNote.id);
  store.deleteTopics(copied.roots, { includeDescendants: true });
  assert.equal(notes.get(own.id).body, '仅在分支中');
  assert.deepEqual(store.topicSubtreeIds([target.id, sibling.id]), subtree);
});

test('copied recorded notes retain independently stored recording, source, screenshots, attachments and summaries', async t => {
  const { notes, store } = fixture(t);
  const source = store.createTopic('原组');
  const destination = store.createTopic('目标组');
  const recordId = 'copy-source';
  store.createDraft({ id: recordId, title: '原标题', notes: '补充', topicIds: [source.id], source: { appName: '测试来源', url: 'https://example.test/' } });
  store.addSegment(recordId, { bytes: Buffer.from('audio'), durationMs: 30, transcript: '音频内容' });
  store.addScreenshot(recordId, Buffer.from('image'), { method: 'region' });
  store.complete(recordId);
  const id = `record:${recordId}`;
  await notes.attachBytes(id, [{ name: '资料.txt', bytes: Buffer.from('资料') }]);
  const { summary } = notes.createSummary(id, '总结正文');
  const copy = notes.copy(id, { topicIds: [destination.id] });
  assert.deepEqual(copy.topicIds, [destination.id]);
  assert.equal(copy.body, notes.get(id).body);
  assert.equal(copy.background.url, 'https://example.test/');
  assert.notEqual(copy.background.audioSegments[0].url, notes.get(id).background.audioSegments[0].url);
  assert.notEqual(copy.summaries[0].id, summary.id);
  notes.delete(id);
  assert.equal(fs.readFileSync(store.getRecord(copy.id.slice(7)).segments[0].path, 'utf8'), 'audio');
  assert.equal(fs.readFileSync(store.getRecord(copy.id.slice(7)).screenshots[0].path, 'utf8'), 'image');
  assert.equal(fs.readFileSync(notes.file(copy.id, copy.attachments[0].id).filename, 'utf8'), '资料');
  assert.equal(notes.get(copy.summaries[0].id).body, '总结正文');
  assert.equal(notes.copy(copy.summaries[0].id).summaryParentId, null);
});

test('group export can combine Markdown or produce separate PDFs with original attachments', async t => {
  const { notes, dir } = fixture(t);
  const first = notes.create(undefined, { title: 'CON', body: '<script>仅作为笔记正文</script>' });
  const second = notes.create(undefined, { title: '第二条', body: '要保留的第二条正文' });
  await notes.attachBytes(first.id, [{ name: '中文文件 (1).txt', bytes: Buffer.from('附件原文') }]);
  notes.createSummary(first.id, '完整总结');
  const ids = [first.id, second.id];
  const target = path.join(dir, '合并.md');
  const combined = await exportNotes({ notes, ids, target, format: 'markdown', mode: 'combined' });
  const markdown = fs.readFileSync(target, 'utf8');
  assert.match(markdown, /完整总结[\s\S]*第二条/u);
  assert.match(markdown, /%281%29\.txt/u);
  const [asset] = fs.readdirSync(combined.assets);
  assert.equal(fs.readFileSync(path.join(combined.assets, asset), 'utf8'), '附件原文');
  const html = [];
  const printPDF = async document => { html.push(document); return Buffer.from('%PDF-mock'); };
  const split = await exportNotes({ notes, ids, target: dir, format: 'pdf', mode: 'separate', printPDF });
  assert.deepEqual(fs.readdirSync(split.path).sort(), ['001-_CON.pdf', '002-第二条.pdf', '附件'].sort());
  assert.match(html[0], /&lt;script&gt;仅作为笔记正文&lt;\/script&gt;/u);
  assert.doesNotMatch(html[1], /附件原文|完整总结/u);
  const previous = fs.readdirSync(dir);
  await assert.rejects(exportNotes({ notes, ids, target: dir, format: 'pdf', mode: 'separate', printPDF() { throw new Error('printer failed'); } }), /printer failed/u);
  assert.deepEqual(fs.readdirSync(dir), previous);
});

test('notes preserve edited text and support title/body search across startup and paging', t => {
  const { notes, reopen } = fixture(t);
  const first = notes.create();
  const body = '想法：测试链接 https://example.test/\n<img src=x onerror="alert(1)">';
  notes.update(first.id, 'Case Study', body);
  for (let i = 0; i < 50; i++) notes.create();
  const recovered = reopen();
  assert.equal(recovered.get(first.id).body, body);
  assert.equal(recovered.list('case STUDY').notes[0].id, first.id);
  assert.equal(recovered.list('测试链接').notes[0].id, first.id);
  assert.equal(recovered.list('absent').notes.length, 0);
  const page = recovered.list();
  assert.equal(page.hasMore, true);
  assert.equal(page.notes.length, 50);
  const end = recovered.list('', 50);
  assert.equal(end.hasMore, false);
  assert.equal(end.notes.length, 1);
  assert.ok(!page.notes.some(note => note.id === end.notes[0].id));
});

test('note formatting and inline media round trip without changing searchable text or sharing copied assets', async t => {
  const fixtureState = fixture(t);
  let { notes } = fixtureState;
  const original = notes.create(undefined, { title: '原笔记' });
  const unrelated = await notes.attachBytes(notes.create().id, [{ name: 'other.png', bytes: Buffer.from('other') }]);
  const { attachments: [image, video, file] } = await notes.attachBytes(original.id, [
    { name: 'image.png', bytes: Buffer.from('image') },
    { name: 'video.mp4', bytes: Buffer.from('video') },
    { name: 'file.pdf', bytes: Buffer.from('file') },
  ]);
  const body = '标题\n正文内容';
  const document = { version: 1, nodes: [
    { tag: 'h2', children: ['标题'] },
    { tag: 'p', children: [
      { tag: 'strong', children: ['正文'] },
      { attachmentId: image.id, width: 48, align: 'left' },
      { tag: 'span', color: '#256D49', size: 20, children: ['内容'] },
      { attachmentId: file.id, width: 400, align: 'left' },
      { attachmentId: unrelated.attachments[0].id, width: 400, align: 'right' },
      { attachmentId: video.id, width: 1600, align: 'right' },
      { attachmentId: image.id, width: 300, align: 'right' },
    ] },
  ] };
  const expected = { version: 1, nodes: [
    { tag: 'h2', children: ['标题'] },
    { tag: 'p', children: [
      { tag: 'strong', children: ['正文'] },
      { attachmentId: image.id, width: 48, align: 'left' },
      { tag: 'span', color: '#256d49', size: 20, children: ['内容'] },
      { attachmentId: video.id, width: 1600, align: 'right' },
    ] },
  ] };
  assert.deepEqual(notes.update(original.id, original.title, body, document).document, expected);
  notes = fixtureState.reopen();
  assert.deepEqual(notes.get(original.id).document, expected);
  assert.deepEqual(notes.listIds('正文内容'), [original.id]);
  assert.deepEqual(notes.update(original.id, '新标题', body).document, expected);
  assert.throws(() => notes.update(original.id, '无效格式', body, { version: 1, nodes: [{ tag: 'iframe' }] }), /格式数据无效/u);
  assert.equal(notes.get(original.id).title, '新标题');

  const copy = notes.copy(original.id);
  const copyImage = copy.attachments.find(attachment => attachment.kind === 'image');
  const copyVideo = copy.attachments.find(attachment => attachment.kind === 'video');
  assert.equal(copy.body, body);
  assert.notEqual(copyImage.id, image.id);
  assert.deepEqual(copy.document.nodes[1].children[1], { attachmentId: copyImage.id, width: 48, align: 'left' });
  assert.deepEqual(copy.document.nodes[1].children[3], { attachmentId: copyVideo.id, width: 1600, align: 'right' });
  const { note: afterRemove } = notes.remove(original.id, image.id);
  assert.equal(afterRemove.body, body);
  assert.equal(afterRemove.document.nodes[1].children.length, 3);
  assert.deepEqual(afterRemove.document.nodes[1].children[2], { attachmentId: video.id, width: 1600, align: 'right' });
  assert.equal(fs.readFileSync(notes.file(copy.id, copyImage.id).filename, 'utf8'), 'image');
  const invalidLayout = { version: 1, nodes: [
    body,
    { attachmentId: copyImage.id, width: '50%; position: fixed', align: 'center' },
    { attachmentId: copyVideo.id, width: 1601, align: 'left' },
  ] };
  assert.deepEqual(notes.update(copy.id, copy.title, body, invalidLayout).document, { version: 1, nodes: [
    body,
    { attachmentId: copyImage.id },
    { attachmentId: copyVideo.id, align: 'left' },
  ] });
  assert.equal(notes.update(original.id, '旧版编辑', '另一段正文').document, null);
  assert.equal(notes.update(copy.id, copy.title, body, null).document, null);
});

test('record-backed notes commit body and rich document in the same transaction', t => {
  const { store, notes } = fixture(t);
  const recordId = 'formatted-record';
  store.createDraft({ id: recordId, title: '记录', notes: '原正文' });
  store.complete(recordId);
  const id = 'record:' + recordId;
  const formatted = { version: 1, nodes: [{ tag: 'h1', children: ['新正文'] }] };
  store.db.exec(`CREATE TRIGGER fail_note_document BEFORE UPDATE OF document_json ON notes
    BEGIN SELECT RAISE(ABORT, 'format write blocked'); END`);
  assert.throws(() => notes.update(id, '新标题', '新正文', formatted), /format write blocked/u);
  assert.equal(notes.get(id).body, '原正文');
  assert.equal(notes.get(id).title, '记录');
  assert.equal(notes.get(id).document, null);
  store.db.exec('DROP TRIGGER fail_note_document');

  assert.deepEqual(notes.update(id, '新标题', '新正文', formatted).document, formatted);
  assert.deepEqual(notes.copy(id).document, formatted);
  store.updateRecord(recordId, { transcript: '旧入口编辑后的正文' });
  assert.equal(notes.get(id).document, null);
});

test('welcome recents show up to three edited root notes in scope, independent of search and paging', t => {
  const { notes, store, reopen } = fixture(t);
  const group = store.createTopic('项目');
  const edited = notes.create(group.id, { title: '待整理' });
  const older = notes.create(group.id, { title: '组内历史' });
  const outside = notes.create(undefined, { title: '其他笔记' });
  const { summary } = notes.createSummary(edited.id, '附件总结');
  store.createDraft({ id: 'recent-capture', title: '组内录音', topicIds: [group.id] });
  store.complete('recent-capture');
  const captureId = 'record:recent-capture';
  const earlier = Date.now() - 10000;
  const setTime = store.db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?');
  setTime.run(earlier, edited.id);
  setTime.run(earlier + 1, older.id);
  setTime.run(earlier + 2, outside.id);
  store.db.prepare('UPDATE records SET completed_at = ? WHERE id = ?').run(earlier + 3, 'recent-capture');
  notes.update(edited.id, '最新编辑', '继续整理。');
  setTime.run(Date.now() + 10000, summary.id);

  const recovered = reopen();
  const options = { includeRecent: true };
  const recentIds = result => result.recent.map(note => note.id);
  const all = recovered.list('', 0, '', options);
  assert.deepEqual(recentIds(all), [edited.id, captureId, outside.id]);
  assert.deepEqual(all.recent[0], { id: edited.id, title: '最新编辑', updatedAt: recovered.get(edited.id).updatedAt });
  assert.deepEqual(recentIds(recovered.list('', 1, '', options)), recentIds(all));
  const search = recovered.list('历史', 0, group.id, options);
  assert.deepEqual(search.notes.map(note => note.id), [older.id]);
  assert.deepEqual(recentIds(search), [edited.id, captureId, older.id]);
  assert.deepEqual(recentIds(recovered.list('', 0, 'uncategorized', options)), [outside.id]);
});

test('note groups count root notes of both origins, list unclassified notes and create into a group atomically', t => {
  const { notes, store, reopen } = fixture(t);
  const group = store.createTopic('项目');
  const written = notes.create(group.id);
  notes.update(written.id, '组内笔记', '正文');
  notes.createSummary(written.id, '附件里的总结');
  const unclassified = notes.create();
  store.createDraft({ id: 'grouped-capture', notes: '组内录音', topicIds: [group.id] });
  store.complete('grouped-capture');
  store.createDraft({ id: 'ungrouped-capture', notes: '未分类录音' });
  store.complete('ungrouped-capture');
  store.createDraft({ id: 'recoverable-draft', topicIds: [group.id] });

  const grouped = notes.list('', 0, group.id);
  assert.deepEqual(grouped.notes.map(note => note.id).sort(), [written.id, 'record:grouped-capture'].sort());
  assert.deepEqual(grouped.groupCounts, { all: 4, uncategorized: 2, [group.id]: 2 });
  assert.deepEqual(notes.list('', 0, 'uncategorized').notes.map(note => note.id).sort(), [unclassified.id, 'record:ungrouped-capture'].sort());
  assert.deepEqual(notes.list('未分类录音', 0, group.id).notes, []);
  assert.throws(() => notes.create('missing-topic'));
  assert.equal(notes.list().groupCounts.all, 4);
  assert.deepEqual(reopen().get(written.id).topicIds, [group.id]);
});

test('saved recordings join handwritten notes with editable text, grouping and background media', async t => {
  const fx = fixture(t);
  const { notes, store } = fx;
  const manual = notes.create();
  notes.update(manual.id, '手写标题', '手写正文');
  const topic = store.createTopic('工作笔记');
  const id = 'old_record-17', noteId = `record:${id}`;
  store.createDraft({ id, title: '旧录音灵感', notes: '手写补充', task: '旧任务', topicIds: [topic.id], source: { appName: '浏览器', windowTitle: '文章', url: 'https://example.test/article' } });
  store.addSegment(id, { id: 'part-one', bytes: Buffer.alloc(50), durationMs: 42, transcript: '转写第一段' });
  store.addSegment(id, { id: 'part-two', bytes: Buffer.alloc(51), transcript: '转写第二段' });
  store.addScreenshot(id, Buffer.alloc(24), { method: 'region' });
  store.addScreenshot(id, Buffer.alloc(24), { method: 'window' });
  assert.throws(() => notes.get(noteId), /不存在/u);
  assert.throws(() => notes.delete(noteId), /不存在/u);
  assert.equal(notes.list().notes.length, 1);

  store.complete(id);
  const old = notes.get(noteId);
  assert.equal(old.body, '转写第一段\n转写第二段\n\n手写补充');
  assert.deepEqual(old.topicIds, [topic.id]);
  assert.equal(old.background.appName, '浏览器');
  assert.equal(old.background.windowTitle, '文章');
  assert.equal(old.background.url, 'https://example.test/article');
  assert.equal(old.background.task, '旧任务');
  assert.deepEqual(old.background.screenshots.map(image => image.role), ['region', 'background']);
  assert.equal(old.background.audioSegments[0].url, `inmoment-media://record/${id}/audio/part-one`);
  assert.equal(old.background.audioSegments[0].durationMs, 42);
  assert.equal(Object.hasOwn(old.background.audioSegments[0], 'path'), false);
  assert.deepEqual(notes.list('', 0, topic.id).notes.map(note => note.id), [noteId]);
  assert.deepEqual(notes.list('手写').notes.map(note => note.id).sort(), [manual.id, noteId].sort());
  assert.equal(notes.list('转写第二段').notes[0].preview, old.body);
  assert.equal(notes.list('旧录音灵感').notes[0].id, noteId);
  assert.equal(notes.list().notes.length, 2);

  const edited = notes.update(noteId, '新标题', '改过的正文');
  assert.ok(edited.updatedAt >= old.updatedAt);
  assert.equal(store.getRecord(id).transcript, '改过的正文');
  assert.equal(store.getRecord(id).notes, '手写补充');
  assert.equal(store.getRecord(id).segments.length, 2);
  await notes.attachBytes(noteId, [{ name: '参考图片.png', bytes: new Uint8Array([65, 66, 67]) }]);
  const reopened = fx.reopen();
  const note = reopened.get(noteId);
  assert.equal(note.body, '改过的正文');
  assert.equal(note.title, '新标题');
  assert.equal(reopened.list().notes.length, 2);
  const [asset] = note.attachments;
  assert.equal(noteMediaResponse(reopened, new Request(asset.url), noteId, asset.id).status, 200);
  assert.throws(() => reopened.file(manual.id, asset.id), /不存在/u);
  const audioPath = fx.store.getRecord(id).segments[0].path;
  const assetPath = reopened.file(noteId, asset.id).filename;
  assert.equal(reopened.delete(noteId).cleanupPending, false);
  assert.equal(fs.existsSync(audioPath), false);
  assert.equal(fs.existsSync(assetPath), false);
  assert.throws(() => reopened.get(noteId), /不存在/u);
  assert.equal(reopened.get(manual.id).title, '手写标题');
});

test('clearing the editable title and body of a projected record stays empty after restart', t => {
  const fx = fixture(t);
  const id = 'fallbacks', noteId = `record:${id}`;
  fx.store.createDraft({ id, notes: '早期文字' });
  fx.store.complete(id);
  fx.store.saveOrganization(id, { title: '早期自动标题' });
  assert.equal(fx.notes.get(noteId).title, '早期自动标题');
  assert.equal(fx.notes.list('早期自动标题').notes[0].id, noteId);
  fx.notes.update(noteId, '', '');
  const reopened = fx.reopen();
  assert.equal(reopened.get(noteId).title, '');
  assert.equal(reopened.get(noteId).body, '');
  assert.equal(reopened.list('早期').notes.length, 0);
  assert.equal(fx.store.getRecord(id).organization.title, '早期自动标题');
  assert.equal(fx.store.getRecord(id).notes, '早期文字');
  assert.equal(fx.store.getRecord(id).hasTranscriptOverride, true);
});

test('full summaries are editable attachments and preserve original note text', async t => {
  const { notes, reopen } = fixture(t);
  const original = notes.create();
  notes.update(original.id, '访谈', '原始记录');
  const { note, summary } = notes.createSummary(original.id, '总结文本');
  assert.equal(note.title, '访谈');
  assert.equal(note.body, '原始记录');
  assert.deepEqual(note.summaries.map(item => [item.id, item.title]), [[summary.id, '总结 · 访谈']]);
  assert.equal(summary.summaryParentId, original.id);
  assert.equal(summary.body, '总结文本');
  notes.update(summary.id, '修改的总结', '修改后的总结文本');
  const withFile = await notes.attachBytes(summary.id, [{ name: 'file.txt', bytes: new Uint8Array([65]) }]);
  const filename = notes.file(summary.id, withFile.attachments[0].id).filename;
  const recovered = reopen();
  assert.deepEqual(recovered.list().notes.map(item => item.id), [original.id]);
  assert.equal(recovered.get(original.id).summaries[0].title, '修改的总结');
  assert.equal(recovered.get(summary.id).body, '修改后的总结文本');
  assert.throws(() => recovered.createSummary(original.id, '   '), /总结内容/u);
  assert.equal(recovered.get(original.id).summaries.length, 1);
  assert.equal(recovered.delete(original.id).cleanupPending, false);
  assert.equal(fs.existsSync(filename), false);
  assert.throws(() => recovered.get(summary.id), /不存在/u);
  assert.throws(() => recovered.createSummary(original.id, '已删除的笔记'), /不存在/u);
});

test('a pre-upgrade saved recording summary becomes an editable attachment once', t => {
  const id = 'legacy-summary';
  const noteId = `record:${id}`;
  const { notes, store, reopen } = fixture(t, legacy => {
    legacy.createDraft({ id, notes: '旧笔记正文' });
    legacy.complete(id);
    legacy.saveOrganization(id, { title: '旧标题', summary: '此前生成的总结' });
    legacy.db.exec(`CREATE TABLE notes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
  });
  const original = notes.get(noteId);
  assert.equal(original.body, '旧笔记正文');
  assert.equal(original.summaries.length, 1);
  const [{ id: summaryId, title }] = original.summaries;
  assert.equal(title, '总结 · 旧标题');
  assert.equal(notes.get(summaryId).body, '此前生成的总结');
  assert.equal(store.getRecord(id).organization.summary, '此前生成的总结');
  const generated = notes.createSummary(noteId, '新总结');
  assert.equal(generated.note.summaries.length, 2);
  const recovered = reopen();
  assert.equal(recovered.get(noteId).summaries.length, 2);
  recovered.delete(summaryId);
  assert.equal(recovered.get(noteId).body, '旧笔记正文');
  assert.deepEqual(reopen().get(noteId).summaries.map(item => item.id), [generated.summary.id]);
});

test('direct summary attachment removal is restricted to the owner and cleans up the removed subtree', async t => {
  const { notes, store, reopen } = fixture(t);
  store.createDraft({ id: 'parent', notes: '原始录音笔记' });
  store.complete('parent');
  const parentId = 'record:parent';
  const other = notes.create();
  const { summary: target } = notes.createSummary(parentId, '待移除的总结');
  const { summary: sibling } = notes.createSummary(parentId, '要保留的总结');
  const { summary: child } = notes.createSummary(target.id, '随总结移除');
  const bytes = new Uint8Array([65]);
  const parentFile = (await notes.attachBytes(parentId, [{ name: '笔记附件.txt', bytes }])).attachments[0];
  const childFile = (await notes.attachBytes(child.id, [{ name: '总结附件.txt', bytes }])).attachments[0];
  const filename = notes.file(child.id, childFile.id).filename;

  assert.throws(() => notes.remove(other.id, target.id, 'summary'), /不存在/u);
  assert.throws(() => notes.remove(parentId, child.id, 'summary'), /不存在/u);
  assert.equal(notes.remove(parentId, target.id).note.summaries.length, 2);
  const importing = notes.attachBytes(target.id, [{ name: '并发附件.txt', bytes }]);
  const result = notes.remove(parentId, target.id, 'summary');
  await assert.rejects(importing, /不存在/u);
  assert.equal(result.cleanupPending, false);
  assert.equal(result.note.body, '原始录音笔记');
  assert.deepEqual(result.note.summaries.map(item => item.id), [sibling.id]);
  assert.deepEqual(result.note.attachments, [parentFile]);
  assert.equal(fs.existsSync(filename), false);
  const recovered = reopen();
  assert.throws(() => recovered.get(target.id), /不存在/u);
  assert.throws(() => recovered.get(child.id), /不存在/u);
  assert.equal(recovered.get(sibling.id).body, '要保留的总结');
  assert.equal(fs.readdirSync(recovered.root).length, 1);
});

test('attachments are local copies, stream byte ranges, and enforce note ownership', async t => {
  const { notes, dir, reopen } = fixture(t);
  const first = notes.create(), second = notes.create();
  const video = path.join(dir, '本地视频.mp4');
  const source = Buffer.from('0123456789');
  fs.writeFileSync(video, source);
  await notes.attachPaths(first.id, [video]);
  await notes.attachBytes(first.id, [{ name: 'CON:unsafe.html', bytes: new Uint8Array([65, 66, 67]) }]);
  fs.unlinkSync(video);
  const recovered = reopen();
  const [movie, file] = recovered.get(first.id).attachments;
  assert.equal(movie.name, '本地视频.mp4');
  assert.equal(movie.kind, 'video');
  assert.equal(file.name, 'CON_unsafe.html');
  assert.equal(file.kind, 'file');
  assert.equal(file.url, '');
  assert.throws(() => recovered.file(second.id, movie.id), /不存在/u);
  assert.equal(recovered.remove(second.id, movie.id).cleanupPending, false);
  const response = noteMediaResponse(recovered, new Request(movie.url, { headers: { range: 'bytes=3-6' } }), first.id, movie.id);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 3-6/10');
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(await response.text(), '3456');
  const suffix = noteMediaResponse(recovered, new Request(movie.url, { headers: { range: 'bytes=-3' } }), first.id, movie.id);
  assert.equal(await suffix.text(), '789');
  const unsatisfied = noteMediaResponse(recovered, new Request(movie.url, { headers: { range: 'bytes=20-' } }), first.id, movie.id);
  assert.equal(unsatisfied.status, 416);
  assert.equal(unsatisfied.headers.get('content-range'), 'bytes */10');
  const unsafe = noteMediaResponse(recovered, new Request(movie.url), first.id, file.id);
  assert.equal(unsafe.status, 404);
  const stored = recovered.file(first.id, movie.id).filename;
  assert.deepEqual(fs.readFileSync(stored), source);
  assert.equal(recovered.delete(first.id).cleanupPending, false);
  assert.equal(fs.existsSync(stored), false);
  assert.throws(() => recovered.get(first.id), /不存在/u);
});

test('failed batches roll back and a deleted note cannot be recreated by an in-flight import', async t => {
  const { notes, dir, reopen } = fixture(t);
  const note = notes.create();
  const filename = path.join(dir, 'document.txt');
  fs.writeFileSync(filename, 'source');
  await assert.rejects(notes.attachPaths(note.id, [filename, path.join(dir, 'missing.pdf')]), /无法读取/u);
  assert.deepEqual(notes.get(note.id).attachments, []);
  assert.deepEqual(fs.readdirSync(notes.root), []);
  const importing = notes.attachPaths(note.id, [filename]);
  notes.delete(note.id);
  await assert.rejects(importing, /不存在/u);
  assert.deepEqual(fs.readdirSync(notes.root), []);
  const orphan = '00000000-0000-0000-0000-000000000001';
  fs.mkdirSync(path.join(notes.root, orphan));
  fs.writeFileSync(path.join(notes.root, orphan, 'interrupted.part'), 'temporary');
  assert.deepEqual(fs.readdirSync(reopen().root), []);
});

test('undone pasted pictures stay available for redo in session and are removed after restart', async t => {
  const { notes, reopen } = fixture(t);
  const { id } = notes.create(undefined, { title: '目标笔记', body: '原文' });
  const bytes = Buffer.from('local image fixture');
  const [ordinary] = (await notes.attachBytes(id, [{ name: '普通附件.png', bytes }])).attachments;
  const imported = await notes.attachBytes(id, [
    { name: '粘贴图片一.png', bytes }, { name: '粘贴图片二.png', bytes },
  ], undefined, { inlineOnly: true });
  const [, first, second] = imported.attachments;
  const paste = { version: 1, nodes: ['原文', { attachmentId: first.id }, { attachmentId: second.id }] };
  const undo = { version: 1, nodes: ['原文'] };
  notes.update(id, '目标笔记', '原文', paste);
  assert.deepEqual(notes.get(id).attachments.map(asset => asset.id), [ordinary.id, first.id, second.id]);
  notes.update(id, '目标笔记', '原文', undo);
  assert.deepEqual(notes.get(id).attachments.map(asset => asset.id), [ordinary.id]);
  assert.equal(fs.existsSync(notes.file(id, first.id).filename), true);
  notes.update(id, '目标笔记', '原文', paste);
  assert.deepEqual(notes.get(id).document.nodes, paste.nodes);
  notes.update(id, '目标笔记', '原文', { version: 1, nodes: ['原文', { attachmentId: second.id }] });
  const discarded = notes.file(id, first.id).filename;
  const recovered = reopen();
  assert.deepEqual(recovered.get(id).attachments.map(asset => asset.id), [ordinary.id, second.id]);
  assert.equal(fs.existsSync(discarded), false);
  assert.equal(fs.existsSync(recovered.file(id, second.id).filename), true);
});

test('clipboard paths are captured from native file-list items and links allow web URLs only', async t => {
  const { dir } = fixture(t);
  const filename = path.join(dir, 'hello 中文.txt');
  const uri = pathToFileURL(filename).href;
  const clipboard = { read: async () => [{
    types: ['text/plain', 'text/uri-list'],
    getType: async () => new Blob([`# Windows clipboard\r\n${uri}\r\n${uri}\r\nhttps://example.test\r\n`]),
  }] };
  assert.deepEqual(await clipboardFilePaths(clipboard), [filename]);
  clipboard.read = async () => [{ types: ['text/uri-list'], getType: async () => new Blob(['file://server/share/data.txt']) }];
  await assert.rejects(clipboardFilePaths(clipboard), /本机文件/u);
  assert.equal(webLink('https://example.test/a'), 'https://example.test/a');
  for (const link of ['javascript:alert(1)', 'file:///C:/private', 'https://user:secret@example.test', 'blob:https://example.test/x']) {
    assert.equal(webLink(link), null);
  }
});
