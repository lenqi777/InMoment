'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { fileURLToPath } = require('node:url');
const { sourceWebUrl, recordMediaURL } = require('./record-background.cjs');
const { packNoteDocument, unpackNoteDocument } = require('./note-document.cjs');

const ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u;
const RECORD_NOTE_ID = /^record:([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u;
const PAGE_SIZE = 50;
const MAX_ATTACHMENTS = 24;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_CLIPBOARD_BYTES = 32 * 1024 * 1024;
const MEDIA_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'], ['.avif', 'image/avif'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'],
  ['.m4v', 'video/mp4'], ['.ogv', 'video/ogg'],
]);

function noteId(value) {
  if (typeof value !== 'string' || !ID.test(value) && !RECORD_NOTE_ID.test(value)) throw new Error('这条笔记已不存在。');
  return value;
}

function assetId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('附件已不存在。');
  return value;
}

function recordIdForNote(id) { return typeof id === 'string' ? RECORD_NOTE_ID.exec(id)?.[1] || null : null; }

function validateNoteText(title, body) {
  if (typeof title !== 'string' || typeof body !== 'string' || title.length > 500 || body.length > 1_000_000) {
    throw new Error('笔记标题最多 500 字，正文最多 100 万字。');
  }
}

function recordNoteText(record) {
  return {
    title: record.title || (record.noteTitleEdited ? '' : typeof record.organization?.title === 'string' ? record.organization.title : ''),
    body: record.hasTranscriptOverride ? record.transcript : [record.transcript, record.notes].filter(Boolean).join('\n\n'),
  };
}

function summaryTitle(title) {
  return `总结 · ${title.trim() || '未命名笔记'}`.slice(0, 500).replace(/[\uD800-\uDBFF]$/u, '');
}

function recordBackground(record) {
  const source = record.source;
  const background = {
    appName: source?.processName || source?.appName || '', windowTitle: source?.title || source?.windowTitle || '',
    url: sourceWebUrl(source?.url), task: record.task, screenshotUnavailable: source?.screenshotUnavailable === true,
    audioCleanupPending: Boolean(record.audioCleanupPending),
    screenshots: record.screenshots.map(item => ({ id: item.id, url: recordMediaURL(record.id, 'image', item.id), role: item.method === 'region' ? 'region' : 'background', capturedAt: item.capturedAt })),
    audioSegments: record.segments.map(segment => ({ id: segment.id, url: recordMediaURL(record.id, 'audio', segment.id), durationMs: segment.durationMs })),
  };
  return background.appName || background.windowTitle || background.url || background.task || background.screenshotUnavailable || background.audioCleanupPending || background.screenshots.length || background.audioSegments.length ? background : null;
}

function attachmentName(value) {
  const clean = String(value || '').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/gu, '_').trim().replace(/[ .]+$/u, '');
  const extension = path.extname(clean).slice(0, 16);
  const base = path.basename(clean, path.extname(clean)).slice(0, 160).replace(/[ .]+$/u, '') || '附件';
  return (/^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/iu.test(base) ? '_' : '') + base + extension;
}

function publicAttachment(row) {
  const kind = row.mime_type.startsWith('image/') ? 'image' : row.mime_type.startsWith('video/') ? 'video' : 'file';
  return {
    id: row.id, name: row.name, kind, size: row.size,
    ...(row.inline_only ? { inlineOnly: true } : {}),
    url: kind === 'file' ? '' : `inmoment-media://note/${encodeURIComponent(row.note_id)}/${row.id}`,
  };
}

function mediaIds(attachments) {
  return new Map(attachments.filter(item => item.kind === 'image' || item.kind === 'video').map(item => [item.id, item.id]));
}

function webLink(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function localFileName(filename) {
  return typeof filename === 'string' && path.isAbsolute(filename) && !/^(?:\\\\|\/\/)/u.test(filename);
}

async function clipboardFilePaths(clipboard) {
  const paths = new Set();
  for (const item of await clipboard.read()) {
    if (!item.types.includes('text/uri-list')) continue;
    const blob = await item.getType('text/uri-list');
    for (const line of (await blob.text()).split(/\r?\n/u)) {
      if (!line.startsWith('file:')) continue;
      let filename;
      try { filename = fileURLToPath(line); } catch { throw new Error('请粘贴本机文件。'); }
      if (!localFileName(filename)) throw new Error('请粘贴本机文件。');
      paths.add(filename);
      if (paths.size > MAX_ATTACHMENTS) throw new Error('每条笔记最多可添加 24 个附件。');
    }
  }
  return [...paths];
}

class NotesStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.root = store.safePath(path.join(store.rootDir, 'notes-assets'));
    fs.mkdirSync(this.root, { recursive: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, document_json TEXT
      );
      CREATE INDEX IF NOT EXISTS notes_recent ON notes(updated_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS note_assets (
        id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS note_assets_owner ON note_assets(note_id, created_at);
      CREATE TABLE IF NOT EXISTS note_topics (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        PRIMARY KEY(note_id, topic_id)
      );
      CREATE INDEX IF NOT EXISTS note_topics_topic ON note_topics(topic_id, note_id);
    `);
    const columns = this.db.prepare('PRAGMA table_info(notes)').all();
    if (!columns.some(column => column.name === 'summary_parent_id')) this.migrateSummaries();
    if (!columns.some(column => column.name === 'document_json')) this.db.exec('ALTER TABLE notes ADD COLUMN document_json TEXT');
    if (!this.db.prepare('PRAGMA table_info(note_assets)').all().some(column => column.name === 'inline_only')) {
      this.db.exec('ALTER TABLE note_assets ADD COLUMN inline_only INTEGER NOT NULL DEFAULT 0');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS notes_summary_parent ON notes(summary_parent_id, created_at, id)');
    this.imports = new Set();
    this.db.exec("DELETE FROM notes WHERE substr(id,1,7)='record:' AND NOT EXISTS (SELECT 1 FROM records r WHERE r.id=substr(notes.id,8) AND r.status='saved')");
    this.db.exec(`DELETE FROM note_assets WHERE inline_only = 1 AND NOT EXISTS (
      SELECT 1 FROM notes n, json_tree(CASE WHEN json_valid(n.document_json) THEN n.document_json END, '$.document.nodes') j
      WHERE n.id = note_assets.note_id AND j.key = 'attachmentId' AND j.value = note_assets.id
    )`);
    this.cleanupFailures = this.removeUnreferenced();
  }

  migrateSummaries() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('ALTER TABLE notes ADD COLUMN summary_parent_id TEXT REFERENCES notes(id) ON DELETE CASCADE');
      const records = this.db.prepare(`SELECT id, title, note_title_edited, organization_json,
        COALESCE(completed_at, created_at) AS saved_at FROM records WHERE status = 'saved' AND organization_json IS NOT NULL`);
      const insert = this.db.prepare('INSERT INTO notes(id, title, body, created_at, updated_at, summary_parent_id) VALUES (?, ?, ?, ?, ?, ?)');
      for (const record of records.iterate()) {
        let organization;
        try { organization = JSON.parse(record.organization_json); } catch { continue; }
        const body = typeof organization === 'string' ? organization : organization?.summary;
        if (typeof body !== 'string' || !body.trim()) continue;
        const id = `record:${record.id}`;
        const title = recordNoteText({ title: record.title, noteTitleEdited: record.note_title_edited, organization }).title;
        this.ensureRecordOwner(id, record.saved_at);
        insert.run(randomUUID(), summaryTitle(title), body.slice(0, 1_000_000), record.saved_at, record.saved_at, id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  list(query = '', offset = 0, topicId = '', { idsOnly = false, limit = PAGE_SIZE + 1, includeRecent = false, includeGroupCounts = true } = {}) {
    const search = typeof query === 'string' ? query.trim().slice(0, 200) : '';
    const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const topic = typeof topicId === 'string' ? topicId.slice(0, 128) : '';
    // Attachment rows for captured notes store timestamps only. The original
    // record owns title, transcript, and recordings throughout its lifetime.
    const statement = this.db.prepare(`WITH captured AS (
      SELECT 'record:' || r.id AS id,
        CASE WHEN r.title <> '' OR r.note_title_edited = 1 THEN r.title
          WHEN json_valid(r.organization_json) THEN CASE WHEN json_type(r.organization_json, '$.title') = 'text' THEN json_extract(r.organization_json, '$.title') ELSE '' END
          ELSE '' END AS title,
        r.transcript_override, r.notes,
        CASE WHEN r.transcript_override IS NULL THEN COALESCE((SELECT group_concat(s.transcript, char(10) ORDER BY s.ordinal)
          FROM segments s WHERE s.record_id = r.id AND s.transcript <> ''), '') END AS transcript,
        max(COALESCE(r.completed_at, r.created_at), COALESCE(r.note_updated_at, 0), COALESCE(n.updated_at, 0)) AS updated_at
      FROM records r LEFT JOIN notes n ON n.id = 'record:' || r.id
      WHERE r.status = 'saved' AND (:topic = '' OR CASE WHEN :topic = 'uncategorized'
        THEN NOT EXISTS (SELECT 1 FROM record_topics rt WHERE rt.record_id = r.id)
        ELSE EXISTS (SELECT 1 FROM record_topics rt WHERE rt.record_id = r.id AND rt.topic_id = :topic) END)
    ), notebook AS (
      SELECT id, title, body, updated_at FROM notes WHERE summary_parent_id IS NULL AND substr(id, 1, 7) <> 'record:'
        AND (:topic = '' OR CASE WHEN :topic = 'uncategorized'
          THEN NOT EXISTS (SELECT 1 FROM note_topics nt WHERE nt.note_id = notes.id)
          ELSE EXISTS (SELECT 1 FROM note_topics nt WHERE nt.note_id = notes.id AND nt.topic_id = :topic) END)
      UNION ALL
      SELECT id, title, COALESCE(transcript_override, transcript || CASE WHEN transcript <> '' AND notes <> '' THEN char(10,10) ELSE '' END || notes), updated_at FROM captured
    ) SELECT ${idsOnly ? 'id' : 'id, title, substr(body, 1, 200) AS preview, updated_at AS updatedAt'}
      FROM notebook WHERE :search = '' OR instr(lower(title), lower(:search)) > 0 OR instr(lower(body), lower(:search)) > 0
      ORDER BY updated_at DESC, id DESC LIMIT :limit OFFSET :start`);
    const rows = statement.all({ topic, search, limit, start });
    if (idsOnly) return rows.map(row => row.id);
    const result = { notes: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE };
    if (includeGroupCounts) result.groupCounts = this.groupCounts();
    if (includeRecent) {
      const recent = search || start ? statement.all({ topic, search: '', limit: 3, start: 0 }) : rows.slice(0, 3);
      result.recent = recent.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
    }
    return result;
  }

  listIds(query, topicId, limit = -1) { return this.list(query, 0, topicId, { idsOnly: true, limit }); }

  reference(id) {
    noteId(id);
    const recordId = recordIdForNote(id);
    const row = this.db.prepare('SELECT title, body, updated_at AS updatedAt FROM notes WHERE id = ?').get(id);
    if (!recordId) return row ? { id, ...row } : null;
    const record = this.store.getRecord(recordId);
    if (record?.status !== 'saved') return null;
    return {
      id, ...recordNoteText(record),
      updatedAt: Math.max(record.completedAt ?? record.createdAt, record.noteUpdatedAt ?? 0, row?.updatedAt ?? 0),
    };
  }

  groupCounts() {
    const rows = this.db.prepare(`WITH saved AS (
      SELECT id FROM records WHERE status = 'saved'
    ), written AS (
      SELECT id FROM notes WHERE summary_parent_id IS NULL AND substr(id, 1, 7) <> 'record:'
    ), assigned AS (
      SELECT rt.topic_id FROM record_topics rt JOIN saved s ON s.id = rt.record_id
      UNION ALL SELECT nt.topic_id FROM note_topics nt JOIN written w ON w.id = nt.note_id
    ) SELECT topic_id AS id, count(*) AS count FROM assigned GROUP BY topic_id
      UNION ALL SELECT 'all', (SELECT count(*) FROM saved) + (SELECT count(*) FROM written)
      UNION ALL SELECT 'uncategorized',
        (SELECT count(*) FROM saved WHERE NOT EXISTS (SELECT 1 FROM record_topics rt WHERE rt.record_id = saved.id)) +
        (SELECT count(*) FROM written WHERE NOT EXISTS (SELECT 1 FROM note_topics nt WHERE nt.note_id = written.id))`).all();
    return Object.fromEntries(rows.map(({ id, count }) => [id, count]));
  }

  membershipsInTopics(topicIds, { exclusive = false } = {}) {
    const memberships = this.db.prepare(`WITH wanted AS (SELECT value AS id FROM json_each(:ids))
      SELECT 'record:' || r.id AS noteId, rt.topic_id AS topicId
        FROM record_topics rt JOIN records r ON r.id = rt.record_id JOIN wanted w ON w.id = rt.topic_id
        WHERE r.status = 'saved' AND (NOT :exclusive OR NOT EXISTS (
          SELECT 1 FROM record_topics other WHERE other.record_id = r.id AND other.topic_id NOT IN (SELECT id FROM wanted)
        ))
      UNION ALL SELECT n.id, nt.topic_id
        FROM note_topics nt JOIN notes n ON n.id = nt.note_id JOIN wanted w ON w.id = nt.topic_id
        WHERE n.summary_parent_id IS NULL AND substr(n.id, 1, 7) <> 'record:' AND (NOT :exclusive OR NOT EXISTS (
          SELECT 1 FROM note_topics other WHERE other.note_id = n.id AND other.topic_id NOT IN (SELECT id FROM wanted)
        ))`).all({ ids: JSON.stringify(topicIds), exclusive: exclusive ? 1 : 0 });
    const byNote = new Map();
    for (const { noteId, topicId } of memberships) {
      if (!byNote.has(noteId)) byNote.set(noteId, []);
      byNote.get(noteId).push(topicId);
    }
    return byNote;
  }

  get(id, { includeHistoryAssets = false } = {}) {
    noteId(id);
    const row = this.db.prepare(`SELECT id, title, body, created_at AS createdAt, updated_at AS updatedAt,
      summary_parent_id AS summaryParentId, document_json AS documentJson FROM notes WHERE id = ?`).get(id);
    const recordId = recordIdForNote(id);
    const summaries = this.db.prepare('SELECT id, title FROM notes WHERE summary_parent_id = ? ORDER BY created_at, id').all(id);
    const attachments = this.assets(id).map(publicAttachment);
    const visibleAssets = document => {
      if (includeHistoryAssets || !attachments.some(asset => asset.inlineOnly)) return attachments;
      const embedded = new Set();
      function visit(nodes) {
        for (const node of nodes) {
          if (node.attachmentId) embedded.add(node.attachmentId);
          else if (node.children) visit(node.children);
        }
      }
      visit(document?.nodes || []);
      return attachments.filter(asset => !asset.inlineOnly || embedded.has(asset.id));
    };
    if (recordId) {
      const record = this.store.getRecord(recordId);
      if (!record) throw new Error('这条笔记已不存在。');
      const text = recordNoteText(record);
      const document = unpackNoteDocument(row?.documentJson, text.body, mediaIds(attachments));
      return { id, ...text, document, createdAt: record.createdAt,
        updatedAt: Math.max(record.completedAt ?? record.createdAt, record.noteUpdatedAt ?? 0, row?.updatedAt ?? 0),
        attachments: visibleAssets(document), summaries, summaryParentId: null, background: recordBackground(record),
        topics: record.topics, topicIds: record.topics.map(topic => topic.id) };
    }
    if (!row) throw new Error('这条笔记已不存在。');
    const topics = this.db.prepare(`SELECT t.id, t.name FROM topics t JOIN note_topics nt ON nt.topic_id = t.id
      WHERE nt.note_id = ? ORDER BY t.normalized_name, t.id`).all(id);
    const { documentJson, ...note } = row;
    const document = unpackNoteDocument(documentJson, note.body, mediaIds(attachments));
    return { ...note, document, attachments: visibleAssets(document), summaries, background: null, topics, topicIds: topics.map(topic => topic.id) };
  }

  assets(id) {
    return this.db.prepare('SELECT * FROM note_assets WHERE note_id = ? ORDER BY created_at, rowid').all(noteId(id));
  }

  create(topicId, { title = '', body = '', document } = {}) {
    validateNoteText(title, body);
    const id = randomUUID();
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.insertNote(id, { title, body, document, topicId }, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(id);
  }

  insertNote(id, { title = '', body = '', document, topicId }, now) {
    validateNoteText(title, body);
    if (topicId !== undefined) this.store.validateTopicIds([topicId]);
    const serialized = packNoteDocument(document, body, new Map());
    this.db.prepare('INSERT INTO notes(id,title,body,created_at,updated_at,document_json) VALUES (?,?,?,?,?,?)')
      .run(id, title, body, now, now, serialized);
    if (topicId !== undefined) this.db.prepare('INSERT INTO note_topics(note_id,topic_id) VALUES (?,?)').run(id, topicId);
  }

  createSummary(id, body) {
    if (typeof body !== 'string' || !body.trim() || body.length > 1_000_000) throw new Error('总结内容不可用。');
    const parent = this.get(id);
    const summaryId = randomUUID();
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (recordIdForNote(id)) this.ensureRecordOwner(id, parent.updatedAt);
      this.db.prepare(`INSERT INTO notes(id, title, body, created_at, updated_at, summary_parent_id)
        VALUES (?, ?, ?, ?, ?, ?)`).run(summaryId, summaryTitle(parent.title), body, now, now, id);
      this.touch(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { note: this.get(id), summary: this.get(summaryId) };
  }

  ensureRecordOwner(id, date) {
    this.db.prepare("INSERT OR IGNORE INTO notes(id, title, body, created_at, updated_at) VALUES (?, '', '', ?, ?)").run(id, date, date);
  }

  update(id, title, body, document) {
    validateNoteText(title, body);
    noteId(id);
    const recordId = recordIdForNote(id);
    const serialized = document === undefined ? null : packNoteDocument(document, body, mediaIds(this.assets(id).map(publicAttachment)));
    if (recordId) {
      const current = this.store.getRecord(recordId);
      if (!current) throw new Error('这条笔记已不存在。');
      const text = recordNoteText(current);
      const updates = {};
      if (title !== text.title) updates.title = title;
      if (body !== text.body) updates.transcript = body;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (Object.keys(updates).length) this.store.updateRecord(recordId, updates, { asNote: true });
        if (document !== undefined || body !== text.body) {
          const now = Date.now();
          if (serialized !== null) this.ensureRecordOwner(id, now);
          this.db.prepare('UPDATE notes SET document_json = ?, updated_at = ? WHERE id = ? AND document_json IS NOT ?')
            .run(serialized, now, id, serialized);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      return this.get(id);
    }
    const result = this.db.prepare(`UPDATE notes SET title = ?, body = ?, updated_at = ?,
      document_json = CASE WHEN ? THEN ? WHEN body = ? THEN document_json END WHERE id = ?`)
      .run(title, body, Date.now(), document === undefined ? 0 : 1, serialized, body, id);
    if (!result.changes) throw new Error('这条笔记已不存在。');
    return this.get(id);
  }

  delete(id) {
    noteId(id);
    const recordId = recordIdForNote(id);
    if (recordId) {
      const status = this.store.row(recordId)?.status;
      if (status === 'saved') this.store.deleteRecord(recordId);
      else if (status === 'draft' || status === 'committing') throw new Error('这条笔记已不存在。');
    }
    return this.removeAttachmentOwner(id);
  }

  copy(id, { topicIds } = {}) {
    const source = this.get(id);
    const topics = this.store.validateTopicIds(topicIds ?? source.topicIds);
    const recordId = recordIdForNote(id);
    const copyId = randomUUID();
    const resultId = recordId ? 'record:' + copyId : copyId;
    const now = Date.now();
    const copiedAssets = [];
    const generation = randomUUID();
    // Until the transaction commits, interrupted recording copies are recovered by
    // the existing delete_pending journal and remain outside the notes list.
    if (recordId) this.db.prepare("INSERT INTO records(id,status,generation,created_at) VALUES(?,'delete_pending',?,?)").run(copyId, generation, now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (recordId) this.copyRecording(recordId, copyId, topics, source.title, now);
      this.copyNoteContents(source, resultId, null, now, copiedAssets);
      if (!recordId) {
        const assign = this.db.prepare('INSERT INTO note_topics(note_id,topic_id) VALUES (?,?)');
        for (const topic of topics) assign.run(copyId, topic);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (recordId) { try { this.store.discard(copyId); } catch { /* The cleanup journal remains recoverable. */ } }
      this.removeFiles(copiedAssets);
      throw error;
    }
    return this.get(resultId);
  }

  copyRecording(sourceId, targetId, topics, title, now) {
    const record = this.store.row(sourceId);
    const sourceDir = this.store.directory(sourceId, 'saved');
    const targetDir = this.store.directory(targetId, 'saved');
    fs.mkdirSync(targetDir);
    const copyMedia = relative => {
      const name = path.basename(relative);
      const filename = this.store.safePath(path.join(sourceDir, name));
      fs.copyFileSync(filename, this.store.safePath(path.join(targetDir, name)), fs.constants.COPYFILE_EXCL);
      return `${targetId}/${name}`;
    };
    this.db.prepare(`UPDATE records SET status='saved',completed_at=?,title=?,task=?,notes=?,source_json=?,organization_json=?,
      organization_version=?,topics_manual=1,transcript_override=?,keep_audio=?,keep_text=?,note_title_edited=1,reviewed_audio_order=? WHERE id=?`)
      .run(now, title, record.task, record.notes, record.source_json, record.organization_json,
        record.organization_version === record.content_version ? 1 : null, record.transcript_override,
        record.keep_audio, record.keep_text, record.reviewed_audio_order, targetId);
    const insertSegment = this.db.prepare('INSERT INTO segments VALUES (?,?,?,?,?,?,?,?,?)');
    for (const row of this.db.prepare('SELECT * FROM segments WHERE record_id=?').all(sourceId)) {
      insertSegment.run(randomUUID(), targetId, row.ordinal, copyMedia(row.relative_path), row.mime_type,
        row.started_at, row.ended_at, row.duration_ms, row.transcript);
    }
    const insertAttachment = this.db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?)');
    for (const row of this.db.prepare('SELECT * FROM attachments WHERE record_id=?').all(sourceId)) {
      insertAttachment.run(randomUUID(), targetId, row.kind, copyMedia(row.relative_path), row.metadata_json);
    }
    const assign = this.db.prepare('INSERT INTO record_topics(record_id,topic_id,manual) VALUES (?,?,1)');
    for (const topic of topics) assign.run(targetId, topic);
    this.store.refreshSearch(targetId);
  }

  copyNoteContents(source, id, parentId, now, copiedAssets) {
    if (recordIdForNote(id)) this.ensureRecordOwner(id, now);
    else this.db.prepare('INSERT INTO notes(id,title,body,created_at,updated_at,summary_parent_id) VALUES (?,?,?,?,?,?)')
      .run(id, source.title, source.body, now, now, parentId);
    const insertAsset = this.db.prepare('INSERT INTO note_assets(id,note_id,name,mime_type,size,created_at,inline_only) VALUES (?,?,?,?,?,?,?)');
    const copiedMedia = new Map();
    for (const attachment of source.attachments) {
      const original = this.file(source.id, attachment.id);
      const asset = randomUUID();
      const directory = this.directory(asset);
      fs.mkdirSync(directory);
      copiedAssets.push(asset);
      fs.copyFileSync(original.filename, this.store.safePath(path.join(directory, attachment.name)), fs.constants.COPYFILE_EXCL);
      insertAsset.run(asset, id, attachment.name, original.mime, original.size, now, Number(Boolean(attachment.inlineOnly)));
      if (attachment.kind === 'image' || attachment.kind === 'video') copiedMedia.set(attachment.id, asset);
    }
    if (source.document) {
      this.db.prepare('UPDATE notes SET document_json = ? WHERE id = ?')
        .run(packNoteDocument(source.document, source.body, copiedMedia), id);
    }
    for (const { id: summaryId } of source.summaries) this.copyNoteContents(this.get(summaryId), randomUUID(), id, now, copiedAssets);
  }

  removeAttachmentOwner(id) {
    noteId(id);
    const assets = this.db.prepare(`WITH RECURSIVE owned(id) AS (
      SELECT ? UNION ALL SELECT n.id FROM notes n JOIN owned o ON n.summary_parent_id = o.id
    ) SELECT a.id FROM note_assets a JOIN owned o ON a.note_id = o.id`).all(id);
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    return { cleanupPending: this.removeFiles(assets.map(asset => asset.id)) };
  }

  remove(id, attachmentId, kind = 'file') {
    this.requireOwner(id);
    const targetId = assetId(attachmentId);
    if (kind === 'summary') {
      if (!this.db.prepare('SELECT 1 FROM notes WHERE id = ? AND summary_parent_id = ?').get(targetId, id)) {
        throw new Error('总结附件已不存在。');
      }
      const result = this.removeAttachmentOwner(targetId);
      this.touch(id);
      return { note: this.get(id), ...result };
    }
    if (kind !== 'file') throw new Error('附件类型不可用。');
    const { document, body } = this.get(id);
    let result;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      result = this.db.prepare('DELETE FROM note_assets WHERE note_id = ? AND id = ?').run(id, targetId);
      if (result.changes) {
        const serialized = document && packNoteDocument(document, body, mediaIds(this.assets(id).map(publicAttachment)));
        this.db.prepare('UPDATE notes SET document_json = ?, updated_at = ? WHERE id = ?').run(serialized, Date.now(), id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { note: this.get(id, { includeHistoryAssets: true }), cleanupPending: Boolean(result.changes) && this.removeFiles([targetId]) };
  }

  touch(id) { this.db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(Date.now(), id); }

  directory(id) { return this.store.safePath(path.join(this.root, assetId(id))); }

  file(id, attachmentId) {
    this.requireOwner(id);
    const asset = this.db.prepare('SELECT * FROM note_assets WHERE note_id = ? AND id = ?').get(id, assetId(attachmentId));
    if (!asset || asset.name !== attachmentName(asset.name)) throw new Error('附件已不存在。');
    const filename = this.store.safePath(path.join(this.directory(asset.id), asset.name));
    if (!fs.statSync(filename).isFile()) throw new Error('附件已不存在。');
    return { filename, mime: asset.mime_type, size: asset.size };
  }

  removeFiles(ids) {
    let failed = false;
    for (const id of ids) {
      try { fs.rmSync(this.directory(id), { recursive: true, force: true }); }
      catch { failed = true; }
    }
    return failed;
  }

  removeUnreferenced() {
    const known = new Set(this.db.prepare('SELECT id FROM note_assets').all().map(asset => asset.id));
    return this.removeFiles(fs.readdirSync(this.root).filter(id => ID.test(id) && !known.has(id)));
  }

  requireOwner(id) {
    noteId(id);
    const recordId = recordIdForNote(id);
    const exists = recordId ? this.store.row(recordId)?.status === 'saved' : this.db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id);
    if (!exists) throw new Error('这条笔记已不存在。');
    return recordId;
  }

  checkCapacity(id, count) {
    const recordId = this.requireOwner(id);
    if (this.get(id).attachments.length + count > MAX_ATTACHMENTS) throw new Error('每条笔记最多可添加 24 个附件。');
    return recordId;
  }

  attachPaths(id, paths, create) {
    return this.import(id, paths.map(filename => ({
      name: path.basename(filename),
      async write(target) {
        if (!localFileName(filename)) throw new Error('请选择本机文件。');
        try {
          const real = await fs.promises.realpath(filename);
          if (!localFileName(real)) throw new Error('remote file');
          const stat = await fs.promises.stat(real);
          if (!stat.isFile()) throw new Error('not a file');
          if (stat.size > MAX_FILE_BYTES) return stat.size;
          await fs.promises.copyFile(real, target, fs.constants.COPYFILE_EXCL);
          return (await fs.promises.stat(target)).size;
        } catch { throw new Error('无法读取附件，请确认文件仍存在且可访问。'); }
      },
    })), create);
  }

  attachBytes(id, files, create, { inlineOnly = false } = {}) {
    if (!Array.isArray(files) || files.length > MAX_ATTACHMENTS ||
        files.some(file => !(file?.bytes instanceof Uint8Array) || typeof file.name !== 'string') ||
        files.reduce((total, file) => total + file.bytes.byteLength, 0) > MAX_CLIPBOARD_BYTES) {
      throw new Error('剪贴板数据过大，请从本机选择文件。');
    }
    return this.import(id, files.map(file => ({
      name: file.name,
      inlineOnly,
      async write(target) {
        await fs.promises.writeFile(target, file.bytes, { flag: 'wx' });
        return file.bytes.byteLength;
      },
    })), create);
  }

  replacePicture(id, { attachmentId, bytes, updatedAt, legacyDocument, displayWidth }) {
    const task = this.commitPictureReplacement(id, attachmentId, bytes, updatedAt, legacyDocument, displayWidth);
    this.imports.add(task);
    const settle = () => this.imports.delete(task);
    task.then(settle, settle);
    return task;
  }

  async commitPictureReplacement(id, attachmentId, bytes, expectedUpdatedAt, legacyDocument, displayWidth) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_CLIPBOARD_BYTES) {
      throw new Error('编辑后的图片超过 32 MB 或格式无效。');
    }
    const original = this.get(id);
    const old = original.attachments.find(asset => asset.id === attachmentId && asset.kind === 'image');
    if (!old || original.updatedAt !== expectedUpdatedAt) throw new Error('笔记中的图片已变更，请重新打开大图。');
    const document = original.document ?? legacyDocument;
    const replacementId = randomUUID();
    let replaced = false;
    function replace(nodes) {
      for (const node of nodes) {
        if (node?.attachmentId === attachmentId) {
          node.attachmentId = replacementId;
          if (node.width === undefined && Number.isInteger(displayWidth) && displayWidth >= 48 && displayWidth <= 1600) node.width = displayWidth;
          replaced = true;
        } else if (node?.children) replace(node.children);
      }
    }
    if (document?.version !== 1 || !Array.isArray(document.nodes)) throw new Error('请重新打开笔记后再编辑图片。');
    const assets = mediaIds(original.attachments);
    assets.set(replacementId, replacementId);
    // Validate the submitted legacy layout before visiting its children.
    const normalized = unpackNoteDocument(packNoteDocument(document, original.body, assets), original.body, assets);
    replace(normalized.nodes);
    if (!replaced) throw new Error('这张图片已不在正文中。');
    const serialized = packNoteDocument(normalized, original.body, assets);
    const stem = path.parse(old.name).name.replace(/（已编辑）$/u, '');
    const name = attachmentName(`${stem}（已编辑）.png`);
    const directory = this.directory(replacementId);
    fs.mkdirSync(directory);
    try {
      await fs.promises.writeFile(this.store.safePath(path.join(directory, name)), bytes, { flag: 'wx' });
      const current = this.get(id);
      if (current.updatedAt !== expectedUpdatedAt || current.body !== original.body || current.title !== original.title ||
          JSON.stringify(current.document) !== JSON.stringify(original.document) ||
          !current.attachments.some(asset => asset.id === attachmentId)) {
        throw new Error('笔记中的图片已变更，请重新打开大图。');
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const now = Math.max(Date.now(), expectedUpdatedAt + 1);
        this.db.prepare("INSERT INTO note_assets(id,note_id,name,mime_type,size,created_at,inline_only) VALUES (?,?,?,'image/png',?,?,1)")
          .run(replacementId, id, name, bytes.length, now);
        // The original remains available to the note's undo stack.
        this.db.prepare('UPDATE note_assets SET inline_only = 1 WHERE id = ? AND note_id = ?').run(attachmentId, id);
        this.db.prepare('UPDATE notes SET document_json = ?, updated_at = ? WHERE id = ?').run(serialized, now, id);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      this.removeFiles([replacementId]);
      throw error;
    }
    return { note: this.get(id, { includeHistoryAssets: true }), replacementId };
  }

  import(id, files, create) {
    const task = this.copyAndCommit(id, files, create);
    this.imports.add(task);
    const settle = () => this.imports.delete(task);
    task.then(settle, settle);
    return task;
  }

  async copyAndCommit(id, files, create) {
    const creating = create !== undefined;
    if (creating) {
      if (id !== undefined || !create || typeof create !== 'object' || Array.isArray(create)) throw new Error('新笔记资料无效。');
      if (!files.length) return null;
      if (files.length > MAX_ATTACHMENTS) throw new Error('每条笔记最多可添加 24 个附件。');
      id = randomUUID();
    } else {
      this.checkCapacity(id, files.length);
      if (!files.length) return this.get(id);
    }
    const staged = [];
    try {
      for (const file of files) {
        const asset = { id: randomUUID(), name: attachmentName(file.name) };
        asset.mime = MEDIA_TYPES.get(path.extname(asset.name).toLowerCase()) || 'application/octet-stream';
        const dir = this.directory(asset.id);
        fs.mkdirSync(dir);
        staged.push(asset);
        asset.size = await file.write(this.store.safePath(path.join(dir, asset.name)));
        if (asset.size > MAX_FILE_BYTES) throw new Error('单个附件最大为 512 MB。');
      }
      const recordId = creating ? null : this.checkCapacity(id, staged.length);
      this.db.exec('BEGIN');
      try {
        const insert = this.db.prepare('INSERT INTO note_assets(id,note_id,name,mime_type,size,created_at,inline_only) VALUES (?,?,?,?,?,?,?)');
        const now = Date.now();
        if (creating) this.insertNote(id, create, now);
        if (recordId) this.ensureRecordOwner(id, now);
        for (const [index, asset] of staged.entries()) {
          insert.run(asset.id, id, asset.name, asset.mime, asset.size, now, Number(files[index].inlineOnly && asset.mime.startsWith('image/')) || 0);
        }
        this.touch(id);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      if (this.removeFiles(staged.map(asset => asset.id))) {
        throw new Error('附件导入未完成，部分临时文件将在下次打开时清理。');
      }
      throw error;
    }
    return this.get(id, { includeHistoryAssets: true });
  }

  close() { return Promise.allSettled([...this.imports]); }
}

function noteMediaResponse(notes, request, id, attachmentId) {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const { filename, mime, size } = notes.file(id, attachmentId);
    if (!MEDIA_TYPES.values().some(type => type === mime)) return new Response(null, { status: 404 });
    const headers = { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    let start = 0;
    let end = size - 1;
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
      const invalid = () => new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      if (!match || (!match[1] && !match[2])) return invalid();
      if (match[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      } else {
        start = Math.max(0, size - Number(match[2]));
      }
      if (start > end) return invalid();
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = String(end - start + 1);
    const body = request.method === 'HEAD' || size === 0 ? null : Readable.toWeb(fs.createReadStream(filename, { start, end }));
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch { return new Response(null, { status: 404 }); }
}

module.exports = { NotesStore, clipboardFilePaths, noteMediaResponse, recordIdForNote, webLink };
