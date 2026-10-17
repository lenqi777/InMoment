'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const { unit, cosine, similarityGraph, modularityCommunities } = require('../core/semantic-graph.cjs');
const { ModelInstaller } = require('./semantic-installer.cjs');

const MODEL_ID = 'multilingual-e5-small-q8-v1';
function check(signal) { if (signal?.aborted) { const error = new Error('已停止本地索引。'); error.name = 'AbortError'; throw error; } }
function missingModel() { return Object.assign(new Error('本地语义模型尚未安装，请在设置中安装组件。'), { code: 'MODEL_NOT_INSTALLED' }); }
function content(record) {
  return [record.title, !record.organizationStale && record.organization?.summary, record.task, record.notes,
    [record.source?.appName || record.source?.processName, record.source?.windowTitle || record.source?.title, record.source?.url].filter(Boolean).join(' ').slice(0, 800),
    !record.organizationStale && record.organization?.context?.description,
    ...(record.segments?.length ? record.segments.map(segment => segment.transcript) : [record.transcript])].filter(Boolean).join('\n').trim();
}
function signature(text) { return createHash('sha256').update(MODEL_ID + '\n' + text).digest('hex'); }
function passages(text) {
  const characters = Array.from(text), pieces = [];
  const stride = 650, size = 750, maximum = 16;
  const chunks = Math.ceil(characters.length / stride);
  for (let index = 0; index < Math.min(maximum, chunks); index += 1) {
    const start = chunks <= maximum ? index * stride : Math.floor(index * Math.max(0, characters.length - size) / (maximum - 1));
    pieces.push('passage: ' + characters.slice(start, start + size).join(''));
  }
  return { texts: pieces, limited: chunks > maximum };
}

class SemanticService {
  constructor({ store, dataDir = store?.rootDir, bundledModelDir, onProgress = () => {}, networkDisabled = false, embedder = null, installer = null } = {}) {
    if (!store || !dataDir) throw new Error('需要本地灵感资料库。');
    this.store = store; this.root = path.join(dataDir, 'semantic'); this.onProgress = onProgress; this.networkDisabled = networkDisabled;
    this.embedder = embedder; this.worker = null; this.pending = new Map(); this.sequence = 0; this.queue = Promise.resolve(); this.closed = false; this.phase = 'idle'; this.cancelEpoch = 0;
    this.installer = installer || new ModelInstaller({ directory: path.join(this.root, 'model'), bundledDirectory: bundledModelDir, networkDisabled, onProgress: event => this.onProgress(event) });
  }
  status() {
    const installation = this.installer.status();
    return { ...installation, model: MODEL_ID, phase: this.phase === 'indexing' ? this.phase : installation.phase, indexedCount: this.db ? this.db.prepare('SELECT count(*) AS n FROM vectors').get().n : 0 };
  }
  async install(options) { return this.installer.install(options); }
  async cancel() { this.cancelEpoch += 1; const installation = this.installer.job?.promise; this.installer.cancel(); this.active?.abort(); await this.stopWorker(); await installation?.catch(() => {}); return { cancelled: true }; }
  database() {
    if (!this.db) {
      fs.mkdirSync(this.root, { recursive: true });
      this.db = new DatabaseSync(path.join(this.root, 'index.sqlite'));
      this.db.exec('CREATE TABLE IF NOT EXISTS vectors(record_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, vector_json TEXT NOT NULL, limited INTEGER NOT NULL DEFAULT 0)');
    }
    return this.db;
  }
  async vectorize(texts, signal) {
    check(signal); if (this.closed) throw new Error('应用正在退出。');
    if (this.embedder) return this.embedder(texts, { signal });
    if (this.networkDisabled) throw new Error('测试模式不运行真实语义模型。');
    const modelDirectory = this.installer.modelDirectory();
    if (!modelDirectory) throw missingModel();
    if (!this.worker) {
      const worker = this.worker = new Worker(path.join(__dirname, 'semantic-worker.cjs'), { workerData: { modelDirectory } });
      worker.on('message', message => { const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.vectors); });
      const fail = () => { if (this.worker === worker) this.worker = null; for (const [id, pending] of this.pending) if (pending.worker === worker) { pending.reject(new Error('本地语义进程已停止，可重试。')); this.pending.delete(id); } };
      worker.on('error', fail); worker.on('exit', fail);
    }
    const id = ++this.sequence;
    const result = await new Promise((resolve, reject) => {
      const abort = () => { this.stopWorker(); reject(Object.assign(new Error('已取消本地语义处理。'), { name: 'AbortError' })); };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { worker: this.worker, resolve: value => { signal?.removeEventListener('abort', abort); resolve(value); }, reject: error => { signal?.removeEventListener('abort', abort); reject(error); } });
      this.worker.postMessage({ id, texts });
    });
    check(signal); return result;
  }
  async stopWorker() { const worker = this.worker; this.worker = null; if (worker) await worker.terminate(); }
  run(action, signal) {
    const epoch = this.cancelEpoch;
    const work = this.queue.catch(() => {}).then(async () => {
      check(signal); if (this.closed) throw new Error('应用正在退出。');
      if (epoch !== this.cancelEpoch) throw Object.assign(new Error('已取消排队的本地语义处理。'), { name: 'AbortError' });
      const active = this.active = new AbortController(); const abort = () => active.abort(); signal?.addEventListener('abort', abort, { once: true });
      try { return await action(active.signal); } finally { signal?.removeEventListener('abort', abort); this.active = null; this.phase = 'idle'; this.onProgress({ type: 'semanticProgress', ...this.status() }); }
    });
    this.queue = work; return work;
  }
  async ensureIndex(signal) {
    if (!this.embedder && !this.installer.modelDirectory()) throw missingModel();
    const db = this.database(); const records = this.store.listRecords(); const byId = new Map(records.map(record => [record.id, record]));
    for (const row of db.prepare('SELECT record_id FROM vectors').all()) if (!byId.has(row.record_id)) db.prepare('DELETE FROM vectors WHERE record_id=?').run(row.record_id);
    let completed = 0; this.phase = 'indexing';
    for (const record of records) {
      check(signal); const text = content(record), fingerprint = signature(text); const existing = db.prepare('SELECT fingerprint FROM vectors WHERE record_id=?').get(record.id);
      if (!text) { db.prepare('DELETE FROM vectors WHERE record_id=?').run(record.id); }
      else if (existing?.fingerprint !== fingerprint) {
        const chunks = passages(text); const vectors = [];
        for (let offset = 0; offset < chunks.texts.length; offset += 2) { check(signal); vectors.push(...await this.vectorize(chunks.texts.slice(offset, offset + 2), signal)); }
        if (!vectors.length || vectors.some(vector => vector.length !== vectors[0].length)) throw new Error('本地语义向量格式错误。');
        const mean = unit(vectors.reduce((sum, vector) => { const normalized = unit(vector); normalized.forEach((value, index) => { sum[index] += value / vectors.length; }); return sum; }, Array(vectors[0].length).fill(0)));
        check(signal); const current = this.store.getRecord(record.id);
        if (current && signature(content(current)) === fingerprint) db.prepare('INSERT OR REPLACE INTO vectors(record_id,fingerprint,vector_json,limited) VALUES(?,?,?,?)').run(record.id, fingerprint, JSON.stringify(mean), chunks.limited ? 1 : 0);
      }
      this.onProgress({ type: 'semanticProgress', phase: 'indexing', completed: ++completed, total: records.length });
    }
    check(signal); return records;
  }
  async search({ query, filters = {}, limit = 20, signal } = {}) {
    return this.run(async localSignal => {
      if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new Error('请输入要查找的灵感。');
      await this.ensureIndex(localSignal); const [queryVector] = await this.vectorize(['query: ' + query.trim()], localSignal); const vector = unit(queryVector);
      const matches = [];
      for (const record of this.store.listRecords(filters)) { const row = this.db.prepare('SELECT fingerprint,vector_json FROM vectors WHERE record_id=?').get(record.id); if (row?.fingerprint === signature(content(record))) matches.push({ id: record.id, score: cosine(vector, JSON.parse(row.vector_json)) }); }
      return matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
    }, signal);
  }
  async cloud({ limit = 800, signal } = {}) {
    return this.run(async localSignal => {
      const records = await this.ensureIndex(localSignal); const all = [], fingerprints = new Map();
      for (const record of records) { const current = this.store.getRecord(record.id); if (!current) continue; const row = this.db.prepare('SELECT fingerprint,vector_json,limited FROM vectors WHERE record_id=?').get(record.id); if (row?.fingerprint === signature(content(current))) { fingerprints.set(record.id, row.fingerprint); all.push({ id: record.id, title: current.title || (!current.organizationStale && current.organization?.title) || content(current).slice(0, 30), createdAt: current.createdAt, vector: JSON.parse(row.vector_json), limited: Boolean(row.limited) }); } }
      const displayed = all.slice(0, Math.max(1, Math.min(800, Number(limit) || 800)));
      const graph = await similarityGraph(displayed, { signal: localSignal });
      // Similarity computation yields to UI actions. Never return a title or
      // relationship for a record deleted/edited during those yields.
      check(localSignal);
      const valid = new Set(all.filter(entry => { const current = this.store.getRecord(entry.id); return current && signature(content(current)) === fingerprints.get(entry.id); }).map(entry => entry.id));
      const nodes = graph.nodes.filter(node => valid.has(node.id)); const edges = graph.edges.filter(edge => valid.has(edge.source) && valid.has(edge.target));
      const communities = modularityCommunities(nodes.map(node => node.id), edges); const membership = new Map(communities.flatMap(group => group.members.map(id => [id, group.id])));
      return { ...graph, nodes: nodes.map(node => ({ ...node, community: membership.get(node.id) })), edges, communities, coverage: { totalCount: this.store.countRecords(), indexedCount: valid.size, displayedCount: nodes.length, hasMore: valid.size > nodes.length, limitedTextCount: all.filter(entry => valid.has(entry.id) && entry.limited).length } };
    }, signal);
  }
  invalidate(id) { if (this.closed) return; if (!this.db && fs.existsSync(path.join(this.root, 'index.sqlite'))) this.database(); if (this.db) this.db.prepare('DELETE FROM vectors WHERE record_id=?').run(id); }
  async close() { this.closed = true; await this.cancel(); await this.queue.catch(() => {}); this.db?.close(); this.db = null; }
}

module.exports = { SemanticService, createSemanticService: options => new SemanticService(options), content, passages };
