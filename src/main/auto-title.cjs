'use strict';

/** Automatic production requests require the user's explicit feature consent; tests inject clients. */
class AutoTitleManager {
  constructor({ store, settings, createClient, onChanged = () => {}, isClosing = () => false, networkDisabled = () => process.env.INMOMENT_DISABLE_NETWORK === '1' }) {
    Object.assign(this, { store, settings, createClient, onChanged, isClosing, networkDisabled });
    this.jobs = new Map(); this.closed = false;
  }
  allowed() {
    const value = this.settings.public();
    return !this.closed && !this.isClosing() && !this.store.closed && !this.networkDisabled() && value.cloudEnabled && value.autoTitleEnabled && value.autoTitleConsentVersion === 1 && value.hasApiKey;
  }
  run(id) {
    if (this.jobs.has(id)) return this.jobs.get(id).promise;
    if (!this.allowed()) return Promise.resolve({ skipped: true });
    const record = this.store.getRecord(id);
    if (!record || record.title?.trim() || record.organization?.title?.trim() || !record.transcript?.trim() || record.jobs.some(job => job.kind === 'title')) return Promise.resolve({ skipped: true });
    const abort = new AbortController();
    // Persist before dispatch; interrupted/failed calls never silently retry on restart or re-transcription.
    this.store.setJob(id, 'title', 'processing'); this.onChanged();
    const promise = Promise.resolve().then(async () => {
      try {
        if (!this.allowed() || abort.signal.aborted || !this.store.getRecord(id)) return { cancelled: true };
        const result = await this.createClient().generateTitle(record, { approved: true, signal: abort.signal });
        if (!this.allowed() || abort.signal.aborted || !this.store.getRecord(id)) return { cancelled: true };
        if (this.store.getRecord(id).transcript !== record.transcript) { this.store.setJob(id, 'title', 'not-applied', '等待命名期间文字已修改，保留当前内容，未应用旧标题。'); return { updated: false }; }
        const saved = this.store.setGeneratedTitleIfUntitled(id, result.title);
        this.store.setJob(id, 'title', saved.updated ? 'done' : 'not-applied');
        return { updated: saved.updated };
      } catch {
        if (!this.store.closed && !this.isClosing() && this.store.getRecord(id)) this.store.setJob(id, 'title', abort.signal.aborted ? 'cancelled' : 'failed', abort.signal.aborted ? '自动命名已取消。' : '自动命名未完成，未自动重试；你可以手动修改标题。');
        return { cancelled: abort.signal.aborted, failed: !abort.signal.aborted };
      } finally {
        if (!this.store.closed && !this.isClosing() && this.store.getRecord(id)) {
          const job = this.store.getRecord(id).jobs.find(item => item.kind === 'title');
          if (job?.status === 'processing') this.store.setJob(id, 'title', 'cancelled', '自动命名已取消。');
        }
        this.jobs.delete(id); this.onChanged();
      }
    });
    this.jobs.set(id, { abort, promise }); return promise;
  }
  cancel(id) { this.jobs.get(id)?.abort.abort(); }
  cancelAll() { for (const job of this.jobs.values()) job.abort.abort(); }
  recoverInterrupted() {
    for (const record of this.store.listRecords()) if (record.jobs.some(job => job.kind === 'title' && job.status === 'processing')) this.store.setJob(record.id, 'title', 'cancelled', '上次命名任务被中断；为避免重复请求，未自动重试。');
  }
  async close() { this.closed = true; this.cancelAll(); await Promise.allSettled([...this.jobs.values()].map(job => job.promise)); }
}

module.exports = { AutoTitleManager };
