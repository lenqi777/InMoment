'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const AUDIO_EXTENSIONS = new Set(['wav', 'webm', 'ogg', 'mp3', 'm4a']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

function json(value) { return JSON.stringify(value ?? null); }
function parse(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }
function validId(value) { if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid local record identifier.'); return value; }
function text(value, limit = 1000000) { return String(value ?? '').slice(0, limit); }
function topicName(value) {
  if (typeof value !== 'string') throw new Error('Topic name must be text.');
  const name = value.replace(/\s+/gu, ' ').trim();
  if (!name || [...name].length > 60) throw new Error('Topic name must contain 1–60 characters.');
  return { name, normalized: name.normalize('NFKC').toLocaleLowerCase() };
}
function groupName(value) {
  if (typeof value !== 'string') throw new Error('分组名称必须是文字。');
  const name = value.replace(/\s+/gu, ' ').trim();
  if (!name || [...name].length > 60 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('分组名称须为 1–60 个字符。');
  return name;
}
function defaultGroupName(records) {
  const source = records.map(record => record.title?.trim() || (!record.organizationStale && record.organization?.title) || record.transcript || record.notes).find(Boolean);
  const compact = String(source || '灵感分组').replace(/\s+/gu, ' ').trim();
  const characters = [...compact];
  return characters.length > 40 ? characters.slice(0, 39).join('') + '…' : compact;
}
function pageOptions({ limit = 30, offset = 0 } = {}) {
  return { limit: Math.max(1, Math.min(100, Math.trunc(Number(limit) || 30))), offset: Math.max(0, Math.min(1000000, Math.trunc(Number(offset) || 0))) };
}

/** Local synchronous store. No network access; drafts never participate in search. */
class LocalStore {
  constructor(rootDir) {
    if (!rootDir || typeof rootDir !== 'string') throw new Error('A local storage directory is required.');
    fs.mkdirSync(path.resolve(rootDir), { recursive: true });
    this.rootDir = fs.realpathSync(path.resolve(rootDir));
    this.draftsDir = path.join(this.rootDir, 'drafts');
    this.recordsDir = path.join(this.rootDir, 'records');
    fs.mkdirSync(this.draftsDir, { recursive: true });
    fs.mkdirSync(this.recordsDir, { recursive: true });
    this.safePath(this.draftsDir);
    this.safePath(this.recordsDir);
    this.db = new DatabaseSync(this.safePath(path.join(this.rootDir, 'inmoment.sqlite')));
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, generation TEXT NOT NULL,
        created_at INTEGER NOT NULL, completed_at INTEGER,
        title TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
        source_json TEXT, organization_json TEXT
      );
      CREATE TABLE IF NOT EXISTS segments (
        id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, relative_path TEXT NOT NULL, mime_type TEXT NOT NULL,
        started_at INTEGER, ended_at INTEGER, duration_ms REAL NOT NULL DEFAULT 0,
        transcript TEXT NOT NULL DEFAULT '', UNIQUE(record_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, relative_path TEXT NOT NULL, metadata_json TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
        updated_at INTEGER NOT NULL, PRIMARY KEY(record_id, kind)
      );
      CREATE TABLE IF NOT EXISTS transcription_runs (
        record_id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
        result_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_records_status_time ON records(status,created_at);
      CREATE INDEX IF NOT EXISTS idx_segments_record ON segments(record_id,ordinal);`);
    // Additive migrations preserve existing records, files, and user configuration.
    const columns = new Set(this.db.prepare('PRAGMA table_info(records)').all().map(column => column.name));
    for (const [name, definition] of [
      ['parent_id', 'TEXT REFERENCES records(id) ON DELETE SET NULL'],
      ['content_version', 'INTEGER NOT NULL DEFAULT 1'],
      ['organization_version', 'INTEGER'],
      ['topics_manual', 'INTEGER NOT NULL DEFAULT 0'],
    ]) if (!columns.has(name)) this.db.exec(`ALTER TABLE records ADD COLUMN ${name} ${definition}`);
    if (!columns.has('organization_version')) this.db.exec('UPDATE records SET organization_version=content_version WHERE organization_json IS NOT NULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS record_topics (
        record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        manual INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(record_id,topic_id)
      );
      CREATE TABLE IF NOT EXISTS duplicate_groups (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS duplicate_group_members (
        group_id TEXT NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
        record_id TEXT NOT NULL UNIQUE REFERENCES records(id) ON DELETE CASCADE,
        joined_version INTEGER NOT NULL, PRIMARY KEY(group_id,record_id)
      );
      CREATE TABLE IF NOT EXISTS duplicate_suggestions (
        id TEXT PRIMARY KEY,
        left_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        right_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        reason TEXT NOT NULL, differences TEXT NOT NULL DEFAULT '',
        left_quote TEXT NOT NULL, right_quote TEXT NOT NULL,
        left_version INTEGER NOT NULL, right_version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        group_id TEXT REFERENCES duplicate_groups(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(left_id,right_id,left_version,right_version)
      );
      CREATE INDEX IF NOT EXISTS idx_record_topics_topic ON record_topics(topic_id,record_id);
      CREATE INDEX IF NOT EXISTS idx_records_parent ON records(parent_id,status);
      CREATE INDEX IF NOT EXISTS idx_duplicates_status ON duplicate_suggestions(status,created_at);`);
    const groupColumns = new Set(this.db.prepare('PRAGMA table_info(duplicate_groups)').all().map(column => column.name));
    if (!groupColumns.has('name')) this.db.exec("ALTER TABLE duplicate_groups ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    this.ftsAvailable = false;
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS record_search USING fts5(record_id UNINDEXED, content, tokenize='trigram');");
      this.ftsAvailable = true;
      // Erase obsolete index entries on update/delete rather than keeping FTS tombstones.
      try { this.db.exec("INSERT INTO record_search(record_search,rank) VALUES('secure-delete',1)"); } catch { /* Older FTS builds use secure_delete plus index rebuild below. */ }
    } catch { /* SQLite builds without trigram still support deterministic local fallback. */ }
    this.recover();
  }

  safePath(candidate) {
    const absolute = path.resolve(candidate);
    const relative = path.relative(this.rootDir, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Attachment path escapes local storage.');
    let current = this.rootDir;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not allowed in local attachment paths.');
    }
    return absolute;
  }

  row(id) { return this.db.prepare('SELECT * FROM records WHERE id = ?').get(validId(id)); }
  directory(id, status = 'draft') { return this.safePath(path.join(status === 'saved' ? this.recordsDir : this.draftsDir, validId(id))); }

  createDraft({ id = randomUUID(), source = null, createdAt = Date.now(), title = '', task = '', notes = '', parentId = null, topicIds, topicsManual = topicIds !== undefined } = {}) {
    validId(id);
    if (this.row(id)) throw new Error('This recording identifier has already been used.');
    if (parentId !== null && this.row(validId(parentId))?.status !== 'saved') throw new Error('A continuation must reference a saved record.');
    const topics = topicIds === undefined ? null : this.validateTopicIds(topicIds);
    const generation = randomUUID();
    const dir = this.directory(id);
    fs.mkdirSync(dir, { recursive: false });
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('INSERT INTO records(id,status,generation,created_at,title,task,notes,source_json,parent_id,topics_manual) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id, 'draft', generation, createdAt, text(title, 500), text(task, 10000), text(notes), json(source), parentId, topicsManual ? 1 : 0);
        for (const topicId of topics || []) this.db.prepare('INSERT INTO record_topics(record_id,topic_id,manual) VALUES(?,?,?)').run(id, topicId, topicsManual ? 1 : 0);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
    return this.getDraft(id);
  }

  draftToken(id) {
    const row = this.row(id);
    if (!row || row.status !== 'draft') return null;
    return Object.freeze({ id: row.id, generation: row.generation });
  }

  getToken(id) { return this.draftToken(id); }

  accepts(token) {
    if (!token || typeof token.id !== 'string' || !ID.test(token.id)) return false;
    const row = this.row(token.id);
    return Boolean(row && row.status === 'draft' && row.generation === token.generation);
  }

  writable(id, token) {
    const row = this.row(id);
    if (!row || row.status !== 'draft' || (token && (token.id !== id || !this.accepts(token)))) throw new Error('Draft write was cancelled or has already completed.');
    return row;
  }

  writeAttachment(id, kind, bytes, extension, token) {
    this.writable(id, token);
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new Error('Attachment bytes must be a Buffer or Uint8Array.');
    const attachmentId = randomUUID();
    const name = `${kind}-${attachmentId}.${extension}`;
    const absolute = this.safePath(path.join(this.directory(id), name));
    const temp = this.safePath(`${absolute}.part`);
    try {
      fs.writeFileSync(temp, bytes, { flag: 'wx' });
      this.writable(id, token);
      fs.renameSync(temp, absolute);
    } catch (error) { fs.rmSync(temp, { force: true }); throw error; }
    return { attachmentId, absolute, relative: `${id}/${name}` };
  }

  addSegment(id, { id: segmentId, order, ordinal, bytes, ext = 'wav', mimeType = 'audio/wav', durationMs = 0, startedAt = null, endedAt = null, transcript = '' }, token) {
    if (!AUDIO_EXTENSIONS.has(ext)) throw new Error('Unsupported audio attachment extension.');
    const row = this.writable(id, token);
    const next = this.db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM segments WHERE record_id = ?').get(id).next;
    const segmentOrder = order ?? ordinal ?? next;
    if (!Number.isSafeInteger(segmentOrder) || segmentOrder < 1) throw new Error('Invalid segment ordinal.');
    const actualId = validId(segmentId || randomUUID());
    const existing = this.db.prepare('SELECT id FROM segments WHERE id = ?').get(actualId);
    if (existing) throw new Error('Audio segment already exists.');
    const file = this.writeAttachment(row.id, 'audio', bytes, ext, token);
    try {
      this.db.prepare('INSERT INTO segments(id,record_id,ordinal,relative_path,mime_type,started_at,ended_at,duration_ms,transcript) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(actualId, id, segmentOrder, file.relative, text(mimeType, 100), startedAt, endedAt, Math.max(0, Number(durationMs) || 0), text(transcript));
    } catch (error) { fs.rmSync(file.absolute, { force: true }); throw error; }
    return this.getDraft(id).segments.find(item => item.id === actualId);
  }

  addScreenshot(id, bytes, { ext = 'png', capturedAt = Date.now(), ...metadata } = {}, token) {
    if (!IMAGE_EXTENSIONS.has(ext)) throw new Error('Unsupported screenshot attachment extension.');
    const file = this.writeAttachment(id, 'screenshot', bytes, ext, token);
    try {
      this.db.prepare('INSERT INTO attachments(id,record_id,kind,relative_path,metadata_json) VALUES(?,?,?,?,?)')
        .run(file.attachmentId, id, 'screenshot', file.relative, json({ ...metadata, capturedAt }));
    } catch (error) { fs.rmSync(file.absolute, { force: true }); throw error; }
    return this.getDraft(id).screenshots.find(item => item.id === file.attachmentId);
  }

  setTranscript(id, transcripts) {
    const row = this.row(id);
    if (!row || !['draft', 'saved'].includes(row.status)) throw new Error('Record is unavailable.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changes = this.transcriptChanges(id, transcripts);
      for (const item of changes) this.db.prepare('UPDATE segments SET transcript=? WHERE id=? AND record_id=?').run(item.transcript, item.id, id);
      if (changes.length) this.bumpContentVersion(id);
      if (row.status === 'saved') this.refreshSearch(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(id);
  }

  transcriptChanges(id, transcripts) {
    if (!Array.isArray(transcripts)) throw new Error('Expected segment transcripts.');
    const pending = new Map();
    for (const item of transcripts) {
      if (!item || typeof item !== 'object') throw new Error('Expected segment transcripts.');
      const segment = this.db.prepare('SELECT id,transcript FROM segments WHERE id=? AND record_id=?').get(item.id || item.segmentId, id);
      if (!segment) throw new Error('Transcript references an unknown audio segment.');
      pending.set(segment.id, { id: segment.id, original: segment.transcript, transcript: text(item.transcript ?? item.text) });
    }
    return [...pending.values()].filter(item => item.transcript !== item.original);
  }

  updateRecord(id, fields = {}, { transcriptSegments, expectedVersion } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.row(id);
      if (!row || !['draft', 'saved'].includes(row.status)) throw new Error('Record is unavailable.');
      this.checkExpectedVersion(row, expectedVersion);
      // Validate every audio reference before writing any part of an editor save.
      const changes = transcriptSegments === undefined ? [] : this.transcriptChanges(id, transcriptSegments);
      const title = text(fields.title ?? row.title, 500), task = text(fields.task ?? row.task, 10000), notes = text(fields.notes ?? row.notes);
      const fieldsChanged = title !== row.title || task !== row.task || notes !== row.notes;
      if (fieldsChanged) this.db.prepare('UPDATE records SET title=?,task=?,notes=? WHERE id=?').run(title, task, notes, id);
      for (const item of changes) this.db.prepare('UPDATE segments SET transcript=? WHERE id=? AND record_id=?').run(item.transcript, item.id, id);
      if (fieldsChanged || changes.length) {
        const titleOnly = title !== row.title && task === row.task && notes === row.notes && changes.length === 0;
        this.bumpContentVersion(id, { preserveOrganization: titleOnly });
        if (row.status === 'saved') this.refreshSearch(id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(id);
  }

  bumpContentVersion(id, { preserveOrganization = false } = {}) {
    // Titles are not organization input. Preserve only a previously fresh result;
    // record versions and duplicate suggestions still change on every real edit.
    this.db.prepare(`UPDATE records SET organization_version=CASE
      WHEN ?=1 AND organization_json IS NOT NULL AND organization_version=content_version THEN content_version+1
      ELSE organization_version END,content_version=content_version+1 WHERE id=?`).run(preserveOrganization ? 1 : 0, id);
    this.db.prepare("UPDATE duplicate_suggestions SET status='stale',updated_at=? WHERE status='pending' AND (left_id=? OR right_id=?)").run(Date.now(), id, id);
  }

  setGeneratedTitleIfUntitled(id, title) {
    if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > 200) throw new Error('Generated title must be a nonempty short string.');
    const generatedTitle = title.replace(/\s+/gu, ' ').trim();
    let updated = false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.row(id);
      if (row?.status === 'saved' && !row.title.trim()) {
        const result = this.db.prepare("UPDATE records SET title=? WHERE id=? AND status='saved' AND title=?").run(generatedTitle, id, row.title);
        updated = Number(result.changes) === 1;
        if (updated) { this.bumpContentVersion(id, { preserveOrganization: true }); this.refreshSearch(id); }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { updated, record: this.getRecord(id) };
  }

  complete(id) {
    const row = this.row(id);
    if (!row || ['delete_pending', 'discarded'].includes(row.status)) throw new Error('This draft is unavailable.');
    if (row.status === 'saved') return this.getRecord(id); // Idempotent: double click never duplicates.
    if (!['draft', 'committing'].includes(row.status)) throw new Error('Draft cannot be completed.');
    this.db.prepare("UPDATE records SET status='committing',generation=? WHERE id=?").run(randomUUID(), id);
    const from = this.directory(id);
    const to = this.directory(id, 'saved');
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
    if (!fs.existsSync(to)) throw new Error('Cannot complete a draft whose attachments directory is missing.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE records SET status='saved',completed_at=COALESCE(completed_at,?) WHERE id=?").run(Date.now(), id);
      this.refreshSearch(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getRecord(id);
  }

  discard(id) {
    const row = this.row(id);
    if (!row || row.status === 'discarded') return { id, status: 'discarded', cleaned: true };
    if (row.status === 'saved') throw new Error('Use deleteRecord to delete a saved record.');
    return this.remove(id);
  }

  deleteRecord(id) { return this.remove(id); }

  remove(id) {
    validId(id);
    if (!this.row(id)) return { id, status: 'discarded', cleaned: true };
    // Persist cancellation and erase searchable metadata before touching files.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE records SET status='delete_pending',generation=?,title='',task='',notes='',source_json=NULL,organization_json=NULL WHERE id=?").run(randomUUID(), id);
      this.db.prepare('DELETE FROM segments WHERE record_id=?').run(id);
      this.db.prepare('DELETE FROM attachments WHERE record_id=?').run(id);
      this.db.prepare('DELETE FROM jobs WHERE record_id=?').run(id);
      this.db.prepare('DELETE FROM transcription_runs WHERE record_id=?').run(id);
      this.db.prepare('DELETE FROM record_topics WHERE record_id=?').run(id);
      this.db.prepare('DELETE FROM duplicate_suggestions WHERE left_id=? OR right_id=?').run(id, id);
      this.db.prepare('DELETE FROM duplicate_group_members WHERE record_id=?').run(id);
      this.db.prepare('UPDATE records SET parent_id=NULL WHERE parent_id=?').run(id);
      this.db.prepare('UPDATE records SET parent_id=NULL,topics_manual=0,organization_version=NULL WHERE id=?').run(id);
      this.pruneGroups();
      if (this.ftsAvailable) this.db.prepare('DELETE FROM record_search WHERE record_id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (this.ftsAvailable) this.db.exec("INSERT INTO record_search(record_search) VALUES('optimize')");
    for (const status of ['draft', 'saved']) {
      fs.rmSync(this.directory(id, status), { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    }
    this.db.prepare("UPDATE records SET status='discarded' WHERE id=?").run(id);
    return { id, status: 'discarded', cleaned: true };
  }

  recover() {
    for (const row of this.db.prepare("SELECT id,status FROM records WHERE status IN ('delete_pending','committing')").all()) {
      try { if (row.status === 'delete_pending') this.remove(row.id); else this.complete(row.id); }
      catch { /* Keep a visible cleanup/commit task for later retry; never silently claim success. */ }
    }
  }

  listPendingCleanup() { return this.db.prepare("SELECT id,status FROM records WHERE status='delete_pending'").all().map(row => ({ ...row })); }
  listDrafts() { return this.db.prepare("SELECT id FROM records WHERE status IN ('draft','committing') ORDER BY created_at DESC").all().map(row => this.get(row.id)); }
  recordFilter(filters = {}) {
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new Error('Invalid record filter.');
    const clauses = ["r.status='saved'"], values = [];
    for (const [key, operator] of [['from', '>='], ['to', '<']]) {
      if (filters[key] === undefined || filters[key] === null || filters[key] === '') continue;
      const value = typeof filters[key] === 'string' && !/^\d+$/u.test(filters[key]) ? Date.parse(filters[key]) : Number(filters[key]);
      if (!Number.isSafeInteger(value)) throw new Error('Invalid record time filter.');
      clauses.push(`r.created_at ${operator} ?`); values.push(value);
    }
    const themes = [];
    for (const key of ['uncategorized', 'unclassified']) if (filters[key] !== undefined && typeof filters[key] !== 'boolean') throw new Error('Invalid unclassified filter.');
    if (filters.uncategorized !== undefined && filters.unclassified !== undefined && filters.uncategorized !== filters.unclassified) throw new Error('Conflicting unclassified filters.');
    const uncategorized = filters.uncategorized === true || filters.unclassified === true;
    if (filters.topicIds !== undefined) {
      if (!Array.isArray(filters.topicIds) || filters.topicIds.length > 100) throw new Error('Invalid topic filter.');
      const topics = [...new Set(filters.topicIds.map(validId))];
      if (topics.length) {
        themes.push(`EXISTS(SELECT 1 FROM record_topics rt WHERE rt.record_id=r.id AND rt.topic_id IN (${topics.map(() => '?').join(',')}))`);
        values.push(...topics);
      }
    }
    if (uncategorized) themes.push('NOT EXISTS(SELECT 1 FROM record_topics rt WHERE rt.record_id=r.id)');
    if (themes.length) clauses.push(`(${themes.join(' OR ')})`);
    return { where: clauses.join(' AND '), values };
  }

  listRecords(filters = {}) {
    const { where, values } = this.recordFilter(filters);
    const pagination = filters.limit === undefined ? '' : ' LIMIT ? OFFSET ?';
    if (pagination) { const page = pageOptions(filters); values.push(page.limit, page.offset); }
    return this.db.prepare(`SELECT r.id FROM records r WHERE ${where} ORDER BY r.created_at DESC,r.id DESC${pagination}`).all(...values).map(row => this.getRecord(row.id));
  }

  countRecords(filters = {}) {
    const { where, values } = this.recordFilter(filters);
    return this.db.prepare(`SELECT COUNT(*) AS count FROM records r WHERE ${where}`).get(...values).count;
  }

  listRecordHeaders(filters = {}) {
    const { where, values } = this.recordFilter(filters);
    const assignedTopics = this.db.prepare('SELECT topic_id FROM record_topics WHERE record_id=? ORDER BY topic_id');
    return this.db.prepare(`SELECT r.id,r.title,r.content_version,r.created_at,r.organization_json,r.organization_version
      FROM records r WHERE ${where} ORDER BY r.created_at DESC,r.id DESC`).all(...values).map(row => ({
      id: row.id, title: row.title.trim() || (row.organization_version === row.content_version ? parse(row.organization_json)?.title : '') || '未命名灵感',
      version: row.content_version, contentVersion: row.content_version, createdAt: row.created_at,
      topicIds: assignedTopics.all(row.id).map(topic => topic.topic_id),
    }));
  }

  listTopics() {
    return this.db.prepare(`SELECT t.id,t.name,t.created_at AS createdAt,
      COUNT(CASE WHEN r.status='saved' THEN 1 END) AS recordCount
      FROM topics t LEFT JOIN record_topics rt ON rt.topic_id=t.id LEFT JOIN records r ON r.id=rt.record_id
      GROUP BY t.id ORDER BY t.normalized_name,t.id`).all().map(row => ({ ...row }));
  }

  createTopic(name) {
    const item = topicName(name), existing = this.db.prepare('SELECT id,name,created_at AS createdAt FROM topics WHERE normalized_name=?').get(item.normalized);
    if (existing) return { ...existing, recordCount: this.countRecords({ topicIds: [existing.id] }) };
    const result = { id: randomUUID(), name: item.name, createdAt: Date.now(), recordCount: 0 };
    this.db.prepare('INSERT INTO topics(id,name,normalized_name,created_at) VALUES(?,?,?,?)').run(result.id, result.name, item.normalized, result.createdAt);
    return result;
  }

  renameTopic(id, name) {
    const item = topicName(name), topic = this.db.prepare('SELECT id FROM topics WHERE id=?').get(validId(id));
    if (!topic) throw new Error('Topic is unavailable.');
    const duplicate = this.db.prepare('SELECT id FROM topics WHERE normalized_name=? AND id<>?').get(item.normalized, id);
    if (duplicate) throw new Error('This topic already exists; merge the topics instead.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE topics SET name=?,normalized_name=? WHERE id=?').run(item.name, item.normalized, id);
      for (const row of this.db.prepare('SELECT record_id FROM record_topics WHERE topic_id=?').all(id)) this.refreshSearch(row.record_id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.listTopics().find(topicItem => topicItem.id === id);
  }

  mergeTopic(sourceId, targetId) {
    validId(sourceId); validId(targetId);
    this.validateTopicIds([sourceId, targetId]);
    if (sourceId === targetId) return this.listTopics().find(item => item.id === targetId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const affected = this.db.prepare('SELECT record_id FROM record_topics WHERE topic_id=?').all(sourceId);
      this.db.prepare(`INSERT INTO record_topics(record_id,topic_id,manual)
        SELECT record_id,?,manual FROM record_topics WHERE topic_id=?
        ON CONFLICT(record_id,topic_id) DO UPDATE SET manual=MAX(manual,excluded.manual)`).run(targetId, sourceId);
      this.db.prepare('DELETE FROM topics WHERE id=?').run(sourceId);
      for (const row of affected) this.refreshSearch(row.record_id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.listTopics().find(item => item.id === targetId);
  }

  deleteTopic(id) {
    validId(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const affected = this.db.prepare('SELECT record_id FROM record_topics WHERE topic_id=?').all(id);
      this.db.prepare('DELETE FROM topics WHERE id=?').run(id);
      for (const row of affected) this.refreshSearch(row.record_id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { id, deleted: true };
  }

  mergeTopics(topicIds, targetId) {
    const ids = this.bulkTopicIds(topicIds); validId(targetId);
    if (ids.length < 2 || !ids.includes(targetId)) throw new Error('Choose at least two groups and keep one selected group.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) if (!this.db.prepare('SELECT id FROM topics WHERE id=?').get(id)) throw new Error('Topic is unavailable.');
      const affected = new Set();
      for (const id of ids) {
        if (id === targetId) continue;
        for (const row of this.db.prepare('SELECT record_id FROM record_topics WHERE topic_id=?').all(id)) affected.add(row.record_id);
        this.db.prepare(`INSERT INTO record_topics(record_id,topic_id,manual)
          SELECT record_id,?,manual FROM record_topics WHERE topic_id=?
          ON CONFLICT(record_id,topic_id) DO UPDATE SET manual=MAX(manual,excluded.manual)`).run(targetId, id);
        this.db.prepare('DELETE FROM topics WHERE id=?').run(id);
      }
      for (const id of affected) this.refreshSearch(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { topic: this.listTopics().find(item => item.id === targetId), mergedIds: ids.filter(id => id !== targetId) };
  }

  deleteTopics(topicIds) {
    const ids = this.bulkTopicIds(topicIds);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) if (!this.db.prepare('SELECT id FROM topics WHERE id=?').get(id)) throw new Error('Topic is unavailable.');
      const affected = new Set();
      for (const id of ids) {
        for (const row of this.db.prepare('SELECT record_id FROM record_topics WHERE topic_id=?').all(id)) affected.add(row.record_id);
        this.db.prepare('DELETE FROM topics WHERE id=?').run(id);
      }
      for (const id of affected) this.refreshSearch(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { ids, deleted: true };
  }

  bulkTopicIds(topicIds) {
    if (!Array.isArray(topicIds) || !topicIds.length || topicIds.length > 1000) throw new Error('Choose between 1 and 1000 groups.');
    return [...new Set(topicIds.map(validId))];
  }

  validateTopicIds(topicIds) {
    if (!Array.isArray(topicIds) || topicIds.length > 100) throw new Error('Expected at most 100 topic identifiers.');
    const ids = [...new Set(topicIds.map(validId))];
    for (const id of ids) if (!this.db.prepare('SELECT id FROM topics WHERE id=?').get(id)) throw new Error('Topic is unavailable.');
    return ids;
  }

  setRecordTopics(id, topicIds, { manual = true, expectedVersion } = {}) {
    const topics = this.validateTopicIds(topicIds);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.row(id);
      if (!row || !['draft', 'saved'].includes(row.status)) throw new Error('Record is unavailable.');
      this.checkExpectedVersion(row, expectedVersion);
      if (!manual && row.topics_manual) { this.db.exec('COMMIT'); return this.get(id); }
      this.db.prepare('DELETE FROM record_topics WHERE record_id=?').run(id);
      for (const topicId of topics) this.db.prepare('INSERT INTO record_topics(record_id,topic_id,manual) VALUES(?,?,?)').run(id, topicId, manual ? 1 : 0);
      this.db.prepare('UPDATE records SET topics_manual=? WHERE id=?').run(manual ? 1 : 0, id);
      if (row.status === 'saved') this.refreshSearch(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(id);
  }

  checkExpectedVersion(row, expectedVersion) {
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || row.content_version !== expectedVersion)) {
      const error = new Error('Record content changed; the AI result is stale.');
      error.code = 'STALE_RECORD'; throw error;
    }
  }
  getDraft(id) { const row = this.row(id); return row && ['draft', 'committing'].includes(row.status) ? this.hydrate(row) : null; }
  getRecord(id) { const row = this.row(id); return row?.status === 'saved' ? this.hydrate(row) : null; }
  get(id) { const row = this.row(id); return row && ['draft', 'committing', 'saved'].includes(row.status) ? this.hydrate(row) : null; }

  hydrate(row) {
    const bucket = row.status === 'saved' || (row.status === 'committing' && fs.existsSync(this.directory(row.id, 'saved'))) ? 'saved' : 'draft';
    const resolveAttachment = relative => this.safePath(path.join(bucket === 'saved' ? this.recordsDir : this.draftsDir, relative));
    const segments = this.db.prepare('SELECT * FROM segments WHERE record_id=? ORDER BY ordinal').all(row.id).map(item => ({ id: item.id, order: item.ordinal, ordinal: item.ordinal, path: resolveAttachment(item.relative_path), mimeType: item.mime_type, startedAt: item.started_at, endedAt: item.ended_at, durationMs: item.duration_ms, transcript: item.transcript }));
    const screenshots = this.db.prepare("SELECT * FROM attachments WHERE record_id=? AND kind='screenshot'").all(row.id).map(item => ({ ...parse(item.metadata_json, {}), id: item.id, path: resolveAttachment(item.relative_path) }));
    const transcriptionRun = this.db.prepare('SELECT result_json FROM transcription_runs WHERE record_id=?').get(row.id);
    const group = row.status === 'saved' ? this.db.prepare('SELECT group_id FROM duplicate_group_members WHERE record_id=?').get(row.id) : null;
    const topics = this.db.prepare('SELECT t.id,t.name,rt.manual FROM topics t JOIN record_topics rt ON rt.topic_id=t.id WHERE rt.record_id=? ORDER BY t.normalized_name,t.id').all(row.id).map(item => ({ ...item, manual: Boolean(item.manual) }));
    const continuations = this.db.prepare("SELECT id,title,created_at AS createdAt,completed_at AS completedAt FROM records WHERE parent_id=? AND status='saved' ORDER BY created_at,id").all(row.id).map(item => ({ ...item }));
    const parent = row.parent_id ? this.db.prepare("SELECT id,title FROM records WHERE id=? AND status='saved'").get(row.parent_id) : null;
    return {
      id: row.id, status: row.status, createdAt: row.created_at, completedAt: row.completed_at, title: row.title, task: row.task, notes: row.notes,
      source: parse(row.source_json), organization: parse(row.organization_json), organizationStale: Boolean(row.organization_json && row.organization_version !== row.content_version),
      contentVersion: row.content_version, version: row.content_version, topics, topicsManual: Boolean(row.topics_manual), parentId: parent?.id || null, parentTitle: parent?.title || '', continuations, duplicateGroupId: group?.group_id || null,
      segments, screenshots, transcript: segments.map(item => item.transcript).filter(Boolean).join('\n'), durationMs: segments.reduce((sum, item) => sum + item.durationMs, 0),
      transcription: transcriptionRun ? parse(transcriptionRun.result_json) : null,
      jobs: this.db.prepare('SELECT kind,status,error,updated_at AS updatedAt FROM jobs WHERE record_id=?').all(row.id).map(item => ({ ...item })),
    };
  }

  saveOrganization(id, organization, options = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.row(id);
      if (row?.status !== 'saved') throw new Error('Only completed records can receive AI organization.');
      this.checkExpectedVersion(row, typeof options === 'number' ? options : options.expectedVersion);
      this.db.prepare('UPDATE records SET organization_json=?,organization_version=? WHERE id=?').run(json(organization), row.content_version, id);
      this.refreshSearch(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getRecord(id);
  }

  duplicateEvidence(record) {
    return [record.notes, ...record.segments.map(segment => segment.transcript)]
      .filter(Boolean).join('\n');
  }

  duplicateSuggestion(row) {
    if (!row) return null;
    return { id: row.id, leftId: row.left_id, rightId: row.right_id, reason: row.reason, differences: row.differences,
      leftQuote: row.left_quote, rightQuote: row.right_quote, leftVersion: row.left_version, rightVersion: row.right_version,
      status: row.status, groupId: row.group_id, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  saveDuplicateSuggestions(suggestions) {
    if (!Array.isArray(suggestions) || suggestions.length > 100) throw new Error('Expected at most 100 duplicate suggestions.');
    const results = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of suggestions) {
        if (!item || typeof item !== 'object') throw new Error('Invalid duplicate suggestion.');
        let leftId = validId(item.leftId), rightId = validId(item.rightId);
        if (leftId === rightId) throw new Error('Duplicate suggestions require two different records.');
        let leftVersion = item.leftVersion, rightVersion = item.rightVersion;
        let leftQuote = item.leftQuote, rightQuote = item.rightQuote;
        if (leftId > rightId) { [leftId, rightId] = [rightId, leftId]; [leftVersion, rightVersion] = [rightVersion, leftVersion]; [leftQuote, rightQuote] = [rightQuote, leftQuote]; }
        const left = this.getRecord(leftId), right = this.getRecord(rightId);
        if (!left || !right) throw new Error('Duplicate suggestions may only reference saved records.');
        this.checkExpectedVersion(this.row(leftId), leftVersion);
        this.checkExpectedVersion(this.row(rightId), rightVersion);
        if (!Number.isSafeInteger(leftVersion) || !Number.isSafeInteger(rightVersion)) throw new Error('Duplicate suggestions require content versions.');
        if (typeof leftQuote !== 'string' || !leftQuote.trim() || leftQuote.length > 3000 || !this.duplicateEvidence(left).includes(leftQuote)
          || typeof rightQuote !== 'string' || !rightQuote.trim() || rightQuote.length > 3000 || !this.duplicateEvidence(right).includes(rightQuote)) throw new Error('Duplicate evidence must quote original record text.');
        if (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 3000) throw new Error('Duplicate suggestions require a short reason.');
        const existing = this.db.prepare('SELECT * FROM duplicate_suggestions WHERE left_id=? AND right_id=? AND left_version=? AND right_version=?').get(leftId, rightId, leftVersion, rightVersion);
        if (existing) { results.push(this.duplicateSuggestion(existing)); continue; }
        const now = Date.now(), id = randomUUID();
        this.db.prepare(`INSERT INTO duplicate_suggestions(id,left_id,right_id,reason,differences,left_quote,right_quote,left_version,right_version,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, leftId, rightId, item.reason.trim(), text(Array.isArray(item.differences) ? item.differences.join('\n') : item.differences, 3000), leftQuote, rightQuote, leftVersion, rightVersion, now, now);
        results.push(this.duplicateSuggestion(this.db.prepare('SELECT * FROM duplicate_suggestions WHERE id=?').get(id)));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return results;
  }

  listDuplicateSuggestions() {
    return this.db.prepare(`SELECT ds.* FROM duplicate_suggestions ds
      JOIN records l ON l.id=ds.left_id AND l.status='saved' AND l.content_version=ds.left_version
      JOIN records r ON r.id=ds.right_id AND r.status='saved' AND r.content_version=ds.right_version
      WHERE ds.status='pending' ORDER BY ds.created_at DESC,ds.id`).all().map(row => this.duplicateSuggestion(row));
  }

  listDuplicateDecisions() {
    return this.db.prepare(`SELECT ds.* FROM duplicate_suggestions ds
      JOIN records l ON l.id=ds.left_id AND l.status='saved' AND l.content_version=ds.left_version
      JOIN records r ON r.id=ds.right_id AND r.status='saved' AND r.content_version=ds.right_version
      WHERE ds.status IN ('grouped','rejected','ungrouped') ORDER BY ds.updated_at DESC,ds.id`).all().map(row => this.duplicateSuggestion(row));
  }

  getGroup(id) {
    const group = this.db.prepare('SELECT id,created_at,name FROM duplicate_groups WHERE id=?').get(validId(id));
    if (!group) return null;
    const members = this.db.prepare(`SELECT gm.record_id,gm.joined_version,r.content_version FROM duplicate_group_members gm
      JOIN records r ON r.id=gm.record_id AND r.status='saved' WHERE gm.group_id=? ORDER BY r.created_at,r.id`).all(id);
    if (members.length < 2) return null;
    const records = members.map(member => this.getRecord(member.record_id));
    const stale = members.some(member => member.joined_version !== member.content_version);
    return { id, groupId: id, name: group.name || defaultGroupName(records), customName: Boolean(group.name), createdAt: group.created_at, recordIds: records.map(record => record.id), records,
      members: members.map(member => ({ recordId: member.record_id, contentVersion: member.joined_version, currentVersion: member.content_version, stale: member.joined_version !== member.content_version })), stale, needsReview: stale };
  }

  listGroups() {
    return this.db.prepare('SELECT id FROM duplicate_groups ORDER BY created_at DESC,id').all().map(row => this.getGroup(row.id)).filter(Boolean);
  }

  renameGroup(id, name) {
    validId(id);
    const normalized = groupName(name);
    if (!this.getGroup(id)) throw new Error('分组不存在，原始记录仍保留。');
    this.db.prepare('UPDATE duplicate_groups SET name=? WHERE id=?').run(normalized, id);
    return this.getGroup(id);
  }

  decideDuplicate(id, decision = 'group') {
    validId(id);
    if (!['group', 'reject'].includes(decision)) throw new Error('Unknown duplicate decision.');
    let groupId, result;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM duplicate_suggestions WHERE id=?').get(id);
      if (!row) throw new Error('Duplicate suggestion is unavailable.');
      const left = this.row(row.left_id), right = this.row(row.right_id);
      if (left?.status !== 'saved' || right?.status !== 'saved') throw new Error('Duplicate suggestion is unavailable.');
      this.checkExpectedVersion(left, row.left_version); this.checkExpectedVersion(right, row.right_version);
      if (decision === 'reject' && row.status === 'rejected') result = this.duplicateSuggestion(row);
      else if (decision === 'group' && row.status === 'grouped' && row.group_id) groupId = row.group_id;
      else {
        if (row.status !== 'pending') throw new Error('This duplicate suggestion has already been handled or is stale.');
        if (decision === 'reject') {
          this.db.prepare("UPDATE duplicate_suggestions SET status='rejected',updated_at=? WHERE id=?").run(Date.now(), id);
          result = this.duplicateSuggestion(this.db.prepare('SELECT * FROM duplicate_suggestions WHERE id=?').get(id));
        } else {
          const leftGroup = this.db.prepare('SELECT group_id FROM duplicate_group_members WHERE record_id=?').get(row.left_id)?.group_id;
          const rightGroup = this.db.prepare('SELECT group_id FROM duplicate_group_members WHERE record_id=?').get(row.right_id)?.group_id;
          groupId = leftGroup || rightGroup || randomUUID();
          if (!leftGroup && !rightGroup) this.db.prepare('INSERT INTO duplicate_groups(id,created_at) VALUES(?,?)').run(groupId, Date.now());
          if (leftGroup && rightGroup && leftGroup !== rightGroup) {
            const targetName = this.db.prepare('SELECT name FROM duplicate_groups WHERE id=?').get(groupId)?.name;
            const sourceName = this.db.prepare('SELECT name FROM duplicate_groups WHERE id=?').get(rightGroup)?.name;
            if (!targetName && sourceName) this.db.prepare('UPDATE duplicate_groups SET name=? WHERE id=?').run(sourceName, groupId);
            this.db.prepare('UPDATE duplicate_group_members SET group_id=? WHERE group_id=?').run(groupId, rightGroup);
            this.db.prepare('UPDATE duplicate_suggestions SET group_id=? WHERE group_id=?').run(groupId, rightGroup);
            this.db.prepare('DELETE FROM duplicate_groups WHERE id=?').run(rightGroup);
          }
          this.db.prepare('INSERT OR IGNORE INTO duplicate_group_members(group_id,record_id,joined_version) VALUES(?,?,?)').run(groupId, row.left_id, row.left_version);
          this.db.prepare('INSERT OR IGNORE INTO duplicate_group_members(group_id,record_id,joined_version) VALUES(?,?,?)').run(groupId, row.right_id, row.right_version);
          this.db.prepare("UPDATE duplicate_suggestions SET status='grouped',group_id=?,updated_at=? WHERE id=?").run(groupId, Date.now(), id);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return groupId ? this.getGroup(groupId) : result;
  }

  ungroup(groupId) {
    validId(groupId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE duplicate_suggestions SET status='ungrouped',group_id=NULL,updated_at=? WHERE group_id=?").run(Date.now(), groupId);
      this.db.prepare('DELETE FROM duplicate_groups WHERE id=?').run(groupId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { id: groupId, ungrouped: true };
  }

  pruneGroups() {
    const rows = this.db.prepare('SELECT dg.id FROM duplicate_groups dg LEFT JOIN duplicate_group_members gm ON gm.group_id=dg.id GROUP BY dg.id HAVING COUNT(gm.record_id)<2').all();
    for (const row of rows) {
      this.db.prepare("UPDATE duplicate_suggestions SET status='ungrouped',group_id=NULL,updated_at=? WHERE group_id=?").run(Date.now(), row.id);
      this.db.prepare('DELETE FROM duplicate_groups WHERE id=?').run(row.id);
    }
  }

  saveTranscription(id, result) {
    if (this.row(id)?.status !== 'saved') throw new Error('Only completed records can receive transcription.');
    this.db.prepare('INSERT INTO transcription_runs(record_id,result_json,updated_at) VALUES(?,?,?) ON CONFLICT(record_id) DO UPDATE SET result_json=excluded.result_json,updated_at=excluded.updated_at')
      .run(id, json(result), Date.now());
  }

  setJob(id, kind, status, error = null) {
    if (this.row(id)?.status !== 'saved') throw new Error('Only saved records can be processed.');
    this.db.prepare('INSERT INTO jobs(record_id,kind,status,error,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(record_id,kind) DO UPDATE SET status=excluded.status,error=excluded.error,updated_at=excluded.updated_at')
      .run(id, text(kind, 50), text(status, 50), error ? text(error, 300) : null, Date.now());
  }

  searchable(record) {
    return [record.title, record.task, record.notes, record.source?.title, record.source?.windowTitle, record.source?.appName, record.source?.url,
      ...record.segments.map(item => item.transcript), ...(record.topics || []).map(topic => topic.name), record.organization && !record.organizationStale ? JSON.stringify(record.organization) : ''].filter(Boolean).join('\n').toLocaleLowerCase();
  }

  refreshSearch(id) {
    if (!this.ftsAvailable) return;
    this.db.prepare('DELETE FROM record_search WHERE record_id=?').run(id);
    const record = this.getRecord(id);
    if (record) this.db.prepare('INSERT INTO record_search(record_id,content) VALUES(?,?)').run(id, this.searchable(record));
  }

  /** Lexical Chinese matching, deliberately not labelled semantic/vector search. */
  searchMatches(query, filters = {}) {
    const normalized = text(query, 500).trim().toLocaleLowerCase();
    const { limit, offset, ...scope } = filters;
    if (!normalized) return this.listRecords(scope);
    const words = normalized.split(/[\s,，。！？!?;；]+/u).filter(Boolean);
    const chars = [...new Set([...normalized].filter(char => /[\p{L}\p{N}]/u.test(char)))];
    return this.listRecords(scope).map(record => {
      const content = this.searchable(record);
      const full = content.includes(normalized);
      const wordHits = words.filter(word => content.includes(word)).length;
      const charHits = chars.filter(char => content.includes(char)).length;
      const overlap = chars.length ? charHits / chars.length : 0;
      const score = (full ? 100 : 0) + wordHits * 20 + overlap * 10;
      const matches = full || wordHits > 0 || (chars.length >= 3 && overlap >= 0.65);
      return { record, content, score: matches ? score : 0 };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt || b.record.id.localeCompare(a.record.id)).map(({ record, score }) => ({ ...record, searchScore: score, searchMode: 'local-keyword', matchSnippet: record.transcript.slice(0, 220) || record.notes.slice(0, 220) || record.source?.windowTitle || record.source?.title || '' }));
  }

  search(query, options = {}) { const { limit, offset } = pageOptions(options); return this.searchMatches(query, options).slice(offset, offset + limit); }
  countSearch(query, filters = {}) { return this.searchMatches(query, filters).length; }

  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}

module.exports = { LocalStore, Store: LocalStore };
