'use strict';
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { groupingInput, validateBatchGrouping } = require('../core/deepseek.cjs');

// These are conservative application safeguards, not provider context limits.
const BATCH_LIMITS = Object.freeze({ maxRecords: 100, maxItemTextBytes: 64000, maxRunTextBytes: 2000000, maxRunImageBytes: 128 * 1024 * 1024 });
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
function validateBatch(recordIds, expectedVersions) {
  if (!Array.isArray(recordIds) || !recordIds.length || recordIds.length > 1000 || recordIds.some(id => typeof id !== 'string' || !ID.test(id))) throw new Error('请选择当前显示的有效灵感记录。');
  const ids = [...new Set(recordIds)];
  if (ids.length > BATCH_LIMITS.maxRecords) throw new Error('一次最多整理 100 条。当前范围超过上限，本次没有发送；请缩小显示范围。');
  if (expectedVersions !== undefined && (!expectedVersions || typeof expectedVersions !== 'object' || Array.isArray(expectedVersions) || Object.keys(expectedVersions).some(id => !ids.includes(id) || !Number.isSafeInteger(expectedVersions[id]) || expectedVersions[id] < 0))) throw new Error('记录版本快照无效，请刷新后重试。');
  return ids;
}
function itemTextBytes(record, topics) {
  return Buffer.byteLength(JSON.stringify({ task: record.task, notes: record.notes, source: { appName: record.source?.appName, processName: record.source?.processName, title: record.source?.title, windowTitle: record.source?.windowTitle, url: record.source?.url }, topics, transcript: record.transcript, segments: record.segments.map(item => ({ id: item.id, text: item.transcript })) }), 'utf8');
}
function usageEmpty() { return { promptTokens: 0, completionTokens: 0, totalTokens: 0, requestCount: 0, attemptedRequests: 0, unknownUsageRequests: 0 }; }
function candidateTopics(topics, records, currentNames = []) {
  const text = records.map(record => `${record.title}\n${record.summary}`).join('\n').toLocaleLowerCase();
  const current = new Set(currentNames);
  return topics.map(topic => topic.name).map(name => ({ name, score: (current.has(name) ? 1000 : 0) + (text.includes(name.toLocaleLowerCase()) ? 100 : 0) + [...new Set(name.toLocaleLowerCase())].filter(character => /[\p{L}\p{N}]/u.test(character) && text.includes(character)).length }))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name)).slice(0, 50).map(item => item.name);
}

class BatchOrganizer {
  constructor({ store, organize, classify, onProgress = () => {}, limits = BATCH_LIMITS } = {}) { this.store = store; this.organize = organize; this.classify = classify; this.onProgress = onProgress; this.limits = limits; }
  snapshot(recordIds, expectedVersions) {
    return validateBatch(recordIds, expectedVersions).map(id => {
      const record = this.store.getRecord(id); const row = this.store.row(id);
      return { id, version: record?.version, generation: row?.generation, invalid: !record ? '记录不存在或尚未完成。' : expectedVersions?.[id] !== undefined && expectedVersions[id] !== record.version ? '记录已修改，未使用旧快照发送。' : '' };
    });
  }
  async run({ snapshot, runId = randomUUID(), signal, includeScreenshot = false, approved = false, onBeforeItem = () => {} } = {}) {
    if (approved !== true) throw new Error('批量整理尚未获得本次授权。');
    if (!Array.isArray(snapshot) || !snapshot.length || snapshot.length > this.limits.maxRecords) throw new Error('批量记录快照无效。');
    const items = [], usage = usageEmpty(); let textBytes = 0, imageBytes = 0; let stoppedByBudget = false;
    const emit = (recordId, status, item) => this.onProgress({ type: 'batchOrganizeProgress', runId, total: snapshot.length, completed: items.length, recordId, status, ...(item ? { item } : {}) });
    for (const frozen of snapshot) {
      let item;
      if (signal?.aborted) item = { id: frozen.id, status: 'not-processed', error: '已取消，未发送这条记录。', topicSuggestions: [] };
      else if (stoppedByBudget) item = { id: frozen.id, status: 'not-processed', error: '达到本次批量资料量上限，未发送这条记录。请缩小范围后重试。', topicSuggestions: [] };
      else if (frozen.invalid) item = { id: frozen.id, status: 'failed', error: frozen.invalid, topicSuggestions: [] };
      else {
        try {
          onBeforeItem();
          const current = this.store.getRecord(frozen.id); const row = this.store.row(frozen.id);
          if (!current || row?.generation !== frozen.generation || current.version !== frozen.version) throw new Error('排队期间记录已删除或修改，本条未发送。');
          const bytes = itemTextBytes(current, this.store.listTopics().slice(0, 50).map(topic => topic.name));
          if (bytes > this.limits.maxItemTextBytes) throw new Error('这条记录文字超过 64,000 字节的批量上限，未发送；可缩短文字后单独整理。');
          let imageSize = 0;
          if (includeScreenshot && current.screenshots[0]) imageSize = fs.statSync(this.store.safePath(current.screenshots[0].path)).size;
          if (textBytes + bytes > this.limits.maxRunTextBytes || imageBytes + imageSize > this.limits.maxRunImageBytes) {
            stoppedByBudget = true;
            item = { id: frozen.id, status: 'not-processed', error: '达到本次批量资料量上限，未发送这条记录。请缩小范围后重试。', topicSuggestions: [] };
          } else {
            textBytes += bytes; imageBytes += imageSize;
            emit(frozen.id, 'processing');
            usage.attemptedRequests += 1;
            const record = await this.organize(frozen.id, { includeScreenshot, expectedVersion: frozen.version, expectedGeneration: frozen.generation, signal, requestApproved: true, deferGrouping: true });
            if (record?.cancelled || !record) { usage.unknownUsageRequests += 1; item = { id: frozen.id, status: 'cancelled', error: '整理已取消。已发送的请求仍可能产生费用。', topicSuggestions: [] }; }
            else {
              const resultUsage = record?.organization?.usage;
              for (const key of ['promptTokens', 'completionTokens', 'totalTokens']) usage[key] += Math.max(0, Number(resultUsage?.[key]) || 0);
              usage.requestCount += 1;
              // Individual summaries cannot supply a taxonomy for the whole batch.
              item = { id: frozen.id, status: 'success', record: { ...record, organization: { ...record.organization, topicSuggestions: [] } }, topicSuggestions: [] };
            }
          }
        } catch (error) { usage.unknownUsageRequests = Math.max(usage.unknownUsageRequests, usage.attemptedRequests - usage.requestCount); item = { id: frozen.id, status: signal?.aborted ? 'cancelled' : 'failed', error: String(error.message || '本条整理失败，原始记录仍保留。').slice(0, 350), topicSuggestions: [] }; }
      }
      items.push(item); emit(frozen.id, item.status, item);
    }
    const successful = items.filter(item => item.status === 'success');
    let grouping = { status: signal?.aborted ? 'cancelled' : 'not-needed', groupCount: 0, unassignedCount: successful.length };
    if (successful.length && !signal?.aborted) {
      try {
        onBeforeItem();
        const frozenById = new Map(snapshot.map(item => [item.id, item]));
        const unchanged = item => {
          const frozen = frozenById.get(item.id), current = this.store.getRecord(item.id);
          return current && current.version === frozen.version && this.store.row(item.id)?.generation === frozen.generation
            && JSON.stringify(current.organization) === JSON.stringify(item.record.organization);
        };
        // The same content version may receive a newer summary while this request runs.
        // Compare the organization too, so the shared plan cannot overwrite that work.
        const eligible = successful.filter(item => {
          if (unchanged(item)) return true;
          item.status = 'failed'; item.error = '统一归类前记录已修改或重新整理，未采用旧建议。'; return false;
        });
        if (!eligible.length) grouping = { status: 'not-needed', groupCount: 0, unassignedCount: 0 };
        else {
          if (typeof this.classify !== 'function') throw new Error('统一归类服务不可用，摘要已保留；没有采用逐条分组建议。');
          const records = eligible.map(item => ({ id: item.id, version: frozenById.get(item.id).version, generation: frozenById.get(item.id).generation, title: item.record.title || item.record.organization?.title || '', summary: item.record.organization?.summary || '' }));
          const topics = this.store.listTopics();
          const input = groupingInput(records, candidateTopics(topics, records, eligible.flatMap(item => (item.record.topics || []).map(topic => topic.name))));
          if (textBytes + Buffer.byteLength(JSON.stringify(input), 'utf8') > this.limits.maxRunTextBytes) throw new Error('统一归类会超过本次资料量上限，摘要已保留；请缩小范围后重试。');
          textBytes += Buffer.byteLength(JSON.stringify(input), 'utf8');
          this.onProgress({ type: 'batchOrganizeProgress', runId, total: snapshot.length, completed: items.length, status: 'grouping' });
          usage.attemptedRequests += 1;
          const result = await this.classify(records, { approved: true, availableTopics: input.availableTopics, signal });
          for (const key of ['promptTokens', 'completionTokens', 'totalTokens']) usage[key] += Math.max(0, Number(result?.usage?.[key]) || 0);
          usage.requestCount += 1;
          if (signal?.aborted) grouping = { status: 'cancelled', groupCount: 0, unassignedCount: eligible.length };
          else {
            const plan = validateBatchGrouping(result, input);
            const assignments = new Map(plan.groups.flatMap(group => group.records.map(record => [record.id, group.name])));
            let stale = 0;
            for (const item of eligible) {
              if (!unchanged(item)) { item.status = 'failed'; item.error = '统一归类期间记录已修改或重新整理，未采用旧建议。'; stale += 1; continue; }
              const topicSuggestions = assignments.has(item.id) ? [assignments.get(item.id)] : [];
              const organization = { ...item.record.organization, topicSuggestions, topicSuggestionsSource: 'batch', topicSuggestionsRunId: runId };
              // Save suggestions only. Actual groups and memberships still require review.
              try {
                const record = this.store.saveOrganization(item.id, organization, { expectedVersion: item.record.version });
                item.topicSuggestions = topicSuggestions;
                item.record = { ...item.record, organization: record?.organization || organization };
              } catch {
                item.status = 'failed'; item.error = '摘要已保留，但这条记录的分组建议未保存，请刷新后重试。'; stale += 1;
              }
            }
            grouping = { status: 'done', groupCount: new Set(eligible.filter(item => item.status === 'success').flatMap(item => item.topicSuggestions)).size, unassignedCount: eligible.filter(item => item.status === 'success' && !item.topicSuggestions.length).length, maxGroups: plan.maxGroups, staleCount: stale, availableTopicCount: topics.length, candidateTopicCount: input.availableTopics.length, model: result.model || '', usage: result.usage };
          }
        }
      } catch (error) {
        usage.unknownUsageRequests = Math.max(usage.unknownUsageRequests, usage.attemptedRequests - usage.requestCount);
        grouping = { status: signal?.aborted ? 'cancelled' : 'failed', groupCount: 0, unassignedCount: successful.length, ...(signal?.aborted ? {} : { error: `摘要已保留，统一归类未完成：${String(error.message || '请稍后重试。').slice(0, 300)}` }) };
        // A failed shared plan must never fall back to fragmented individual names.
        for (const item of successful) { item.topicSuggestions = []; item.record.organization.topicSuggestions = []; }
      }
    }
    return { runId, items, grouping, completed: items.filter(item => !['not-processed'].includes(item.status)).length, total: snapshot.length, cancelled: Boolean(signal?.aborted), usage, limits: { ...this.limits }, inputBytes: { text: textBytes, image: imageBytes } };
  }
}
module.exports = { BatchOrganizer, BATCH_LIMITS, validateBatch };
