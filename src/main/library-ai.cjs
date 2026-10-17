'use strict';

const { createHash } = require('node:crypto');
const { ApprovalRequiredError } = require('../core/deepseek.cjs');
const { normalizeFilters: normalizeRequestFilters } = require('./cloud-permissions.cjs');

// App policy, deliberately much smaller than the provider's context window.
const SEARCH_INPUT_BUDGET = 12000;
const SEARCH_OUTPUT_BUDGET = 1500;
const DUPLICATE_INPUT_BUDGET = 12000;
const MAX_CANDIDATES = 20;
const MAX_DUPLICATE_PAIRS = 5;

function cancelled(signal) {
  if (signal?.aborted) { const error = new Error('AI library task was cancelled. Completed requests may already have incurred charges.'); error.name = 'AbortError'; throw error; }
}
function estimateTokens(value) { return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'); }
function versionOf(record) { return record.version ?? record.contentVersion ?? ''; }
function signature(records) { return createHash('sha256').update(JSON.stringify(records.map(record => [record.id, versionOf(record), record.organizationStale ? null : [record.organization?.generatedAt, record.organization?.summary, record.organization?.context], (record.topics || []).map(topic => [topic.id, topic.name])]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex'); }
function textOf(record) { return [record.notes, ...(record.segments?.length ? record.segments.map(segment => segment.transcript || '') : [record.transcript])].filter(Boolean).join('\n').trim(); }
function searchText(record) { return [record.title, textOf(record), record.task, record.notes, record.source?.title, record.source?.windowTitle, record.source?.appName, record.source?.processName, record.source?.url, !record.organizationStale && record.organization?.summary, !record.organizationStale && JSON.stringify(record.organization?.context || {}), ...(record.topics || []).map(topic => topic.name)].filter(Boolean).join('\n').toLocaleLowerCase(); }
function normalizeFilters(filters = {}) {
  const result = normalizeRequestFilters(filters);
  if (result.topicIds) result.topicIds.sort();
  return result;
}
function inScope(record, filters) {
  if (!record || record.status !== 'saved') return false;
  if (filters.from != null && record.createdAt < filters.from || filters.to != null && record.createdAt >= filters.to) return false;
  const selected = filters.topicIds?.length > 0;
  const withoutTopics = !record.topics?.length;
  return !selected && !filters.uncategorized || Boolean(selected && record.topics?.some(topic => filters.topicIds.includes(topic.id))) || Boolean(filters.uncategorized && withoutTopics);
}
function usageEmpty() { return { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedInputTokens: 0, requestCount: 0 }; }
function addUsage(total, result, estimate) {
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens']) total[key] += Math.max(0, Number(result?.usage?.[key]) || 0);
  total.estimatedInputTokens += estimate; total.requestCount += 1;
}
function quoteSnippet(record, terms = [], limit = 200) {
  const text = textOf(record); const lower = text.toLocaleLowerCase();
  let at = -1;
  for (const term of terms) { const index = lower.indexOf(term.toLocaleLowerCase()); if (index >= 0 && (at < 0 || index < at)) at = index; }
  const start = at > 50 ? at - 50 : 0;
  return text.slice(start, start + limit);
}
function asCandidate(record, terms = []) {
  const recognized = !record.organizationStale && record.organization?.context;
  const recognizedText = recognized && [recognized.application, recognized.windowTitle, recognized.visibleUrl, recognized.description].filter(Boolean).join(' · ');
  const pieces = [
    record.source?.appName || record.source?.processName,
    record.source?.windowTitle || record.source?.title,
    record.source?.url,
    record.task && `当时任务：${record.task}`,
    recognizedText && `${recognized.source === 'provided' ? '已保存场景' : 'AI场景线索（未核验）'}：${recognizedText}`,
  ].filter(Boolean).map(value => String(value).slice(0, 180));
  const score = text => terms.filter(term => text.toLocaleLowerCase().includes(term.toLocaleLowerCase())).length;
  pieces.sort((left, right) => score(right) - score(left));
  return { id: record.id, version: versionOf(record), title: String(record.title || '').slice(0, 80), text: quoteSnippet(record, terms),
    context: pieces.join(' · ').slice(0, 180), summary: record.organizationStale ? '' : String(record.organization?.summary || '').slice(0, 200), createdAt: record.createdAt };
}
function pairKey(left, right) { return [left, right].sort().join('\u0000'); }
function pairVersion(left, right) { return [left, right].map(record => `${record.id}:${versionOf(record)}`).sort().join('\u0000'); }
function tokens(text) {
  const normalized = text.toLocaleLowerCase().replace(/\s+/gu, ' ');
  const result = new Set(normalized.match(/[a-z0-9]{2,}/gu) || []);
  const chinese = [...normalized].filter(char => /[\p{Script=Han}]/u.test(char));
  for (let index = 0; index < chinese.length - 1; index++) result.add(chinese[index] + chinese[index + 1]);
  return [...result].slice(0, 80);
}

class LibraryAI {
  constructor({ store, client, readImage = null, semantic = null } = {}) {
    if (!store || !client) throw new Error('A local store and injectable AI client are required.');
    this.store = store; this.client = client; this.readImage = readImage; this.semantic = semantic;
    this.searchCache = new Map(); this.examinedPairs = new Set(); this.indexSignature = '';
  }

  getClient() { return typeof this.client === 'function' ? this.client() : this.client; }
  records(filters) { return this.store.listRecords(filters).filter(record => inScope(record, filters)); }
  fresh(record, filters) {
    const current = this.store.getRecord(record.id);
    return current && inScope(current, filters) && String(versionOf(current)) === String(versionOf(record));
  }
  clearCache() { this.searchCache.clear(); this.examinedPairs.clear(); this.indexSignature = ''; }

  async search({ query, filters = {}, approved = false, signal, candidateLimit = MAX_CANDIDATES } = {}) {
    if (approved !== true) throw new ApprovalRequiredError();
    cancelled(signal);
    if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new Error('Describe the inspiration in 1 to 1000 characters.');
    const scope = normalizeFilters(filters); const records = this.records(scope);
    const index = signature(records); const cacheKey = JSON.stringify([query.trim(), scope, index, Math.min(MAX_CANDIDATES, Number(candidateLimit) || MAX_CANDIDATES), this.getClient().model || '']);
    if (this.searchCache.has(cacheKey)) return { ...structuredClone(this.searchCache.get(cacheKey)), cached: true, usage: usageEmpty() };
    const usage = usageEmpty(); const coverage = { scopeCount: records.length, candidateCount: 0, examinedCount: 0, notExaminedCount: records.length, hasMore: records.length > 0, mode: 'local-candidates-ai-ranked' };
    const limitations = ['先由本地语义向量与关键词召回候选，再由 AI 排序；只上传本次有限候选，可能漏检。'];
    if (!records.length) return { query: query.trim(), filters: scope, results: [], coverage, usage, cached: false, limitations };
    if (!this.semantic?.search) { const error = new Error('请先在设置中安装本地语义模型，再使用 AI 查找。普通关键词搜索仍可使用。'); error.code = 'MODEL_NOT_INSTALLED'; throw error; }
    // Resolve local semantic availability before any paid query interpretation.
    const semanticMatches = await this.semantic.search({ query: query.trim(), filters: scope, limit: MAX_CANDIDATES, signal });
    cancelled(signal);
    if (!Array.isArray(semanticMatches)) throw new Error('本地语义检索未返回有效候选。');
    const client = this.getClient();
    const interpretedEstimate = estimateTokens({ query }) + 1000;
    if (interpretedEstimate > SEARCH_INPUT_BUDGET - 2000) throw new Error('The query exceeds the search budget.');
    const interpreted = await client.interpretQuery(query.trim(), { approved: true, signal, maxTokens: 300 });
    cancelled(signal); addUsage(usage, interpreted, interpretedEstimate);
    if (!Array.isArray(interpreted.terms)) throw new Error('Invalid AI query interpretation.');
    const terms = [...new Set([query.trim(), ...interpreted.terms].filter(term => typeof term === 'string' && term.trim() && term.length <= 1000))].slice(0, 9);
    const byId = new Map(records.map(record => [record.id, record])); const scores = new Map();
    for (const item of semanticMatches.slice(0, MAX_CANDIDATES)) {
      if (!item || typeof item.id !== 'string' || !Number.isFinite(item.score)) throw new Error('本地语义检索返回无效记录。');
      if (byId.has(item.id) && this.fresh(byId.get(item.id), scope)) scores.set(item.id, 200 + Math.max(-1, Math.min(1, item.score)) * 100);
    }
    const searches = terms.map(term => {
      const normalized = term.toLocaleLowerCase();
      return { normalized, words: normalized.split(/[\s,，。！？!?;；]+/u).filter(Boolean), chars: [...new Set([...normalized].filter(character => /[\p{L}\p{N}]/u.test(character)))] };
    });
    // Reuse the one local snapshot instead of rehydrating every record per term.
    let scanned = 0;
    for (const record of records) {
      if (++scanned % 200 === 0) await new Promise(resolve => setImmediate(resolve));
      cancelled(signal);
      const text = searchText(record); let score = 0;
      for (const search of searches) {
        const full = text.includes(search.normalized); const wordHits = search.words.filter(word => text.includes(word)).length;
        const overlap = search.chars.length ? search.chars.filter(character => text.includes(character)).length / search.chars.length : 0;
        if (full || wordHits > 0 || search.chars.length >= 3 && overlap >= 0.65) score += (full ? 100 : 0) + wordHits * 20 + overlap * 10;
      }
      if (score > 0) scores.set(record.id, (scores.get(record.id) || 0) + score);
    }
    const ranked = [...scores].sort((a, b) => b[1] - a[1] || byId.get(b[0]).createdAt - byId.get(a[0]).createdAt);
    coverage.candidateCount = ranked.length;
    const limit = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(Number(candidateLimit) || MAX_CANDIDATES)));
    const selected = []; let rankEstimate = 0;
    for (const [id] of ranked) {
      if (selected.length >= limit) break;
      if (!this.fresh(byId.get(id), scope)) continue;
      const candidate = asCandidate(byId.get(id), terms);
      if (!candidate.text) continue;
      const nextEstimate = estimateTokens({ query, candidates: [...selected, candidate] }) + 1500;
      if (nextEstimate + interpretedEstimate > SEARCH_INPUT_BUDGET) break;
      selected.push(candidate); rankEstimate = nextEstimate;
    }
    let results = [];
    if (selected.length) {
      const response = await client.rankCandidates(query.trim(), selected, { approved: true, signal, maxTokens: SEARCH_OUTPUT_BUDGET - 300 });
      cancelled(signal); addUsage(usage, response, rankEstimate);
      const selectedById = new Map(selected.map(item => [item.id, item])); const used = new Set();
      if (!Array.isArray(response.results)) throw new Error('Invalid AI search results.');
      results = response.results.map(item => {
        const original = byId.get(item.id); const candidate = selectedById.get(item.id);
        if (!candidate || used.has(item.id) || typeof item.quote !== 'string' || !item.quote.trim() || !candidate.text.includes(item.quote) || typeof item.reason !== 'string') throw new Error('Invalid AI search evidence.');
        used.add(item.id);
        return { id: item.id, title: original.title, reason: item.reason.slice(0, 1000), quote: item.quote, version: versionOf(original), _original: original };
      }).filter(item => this.fresh(item._original, scope)).map(({ _original, ...item }) => item);
    }
    coverage.examinedCount = selected.length; coverage.notExaminedCount = Math.max(0, records.length - selected.length); coverage.hasMore = coverage.notExaminedCount > 0;
    const result = { query: query.trim(), filters: scope, interpretedIntent: interpreted.intent || '', results, coverage, usage, cached: false, model: client.model || interpreted.model || '', limitations };
    // Never retain stale or deleted content returned while a request was in flight.
    if (signature(this.records(scope)) === index) {
      if (this.searchCache.size >= 30) this.searchCache.delete(this.searchCache.keys().next().value);
      this.searchCache.set(cacheKey, structuredClone(result));
    }
    return result;
  }

  async duplicateCandidates(records, signal) {
    const postings = new Map(); const pairs = new Map();
    let scanned = 0;
    for (const record of records) {
      if (++scanned % 200 === 0) await new Promise(resolve => setImmediate(resolve));
      cancelled(signal);
      const terms = tokens(searchText(record)); const counts = new Map();
      for (const term of terms) for (const previous of postings.get(term) || []) counts.set(previous.id, (counts.get(previous.id) || 0) + 1);
      for (const [id, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
        const previous = records.byId.get(id);
        if (count < 2 || this.examinedPairs.has(pairVersion(record, previous))) continue;
        pairs.set(pairKey(id, record.id), { left: previous, right: record, score: count });
      }
      for (const term of terms) { const list = postings.get(term) || []; list.push(record); if (list.length > 20) list.shift(); postings.set(term, list); }
    }
    return [...pairs.values()].sort((a, b) => b.score - a.score || b.right.createdAt - a.right.createdAt);
  }

  async analyzeDuplicates({ filters = {}, approved = false, signal, limit = MAX_CANDIDATES } = {}) {
    if (approved !== true) throw new ApprovalRequiredError();
    cancelled(signal);
    const scope = normalizeFilters(filters); const records = this.records(scope);
    // Indexing is local; only a bounded selection of likely pairs is uploaded.
    records.byId = new Map(records.map(record => [record.id, record]));
    const index = signature(records);
    // Versioned pair keys retain unchanged work when an unrelated record changes.
    if (this.examinedPairs.size > 5000) this.examinedPairs.clear();
    this.indexSignature = index;
    for (const decision of this.store.listDuplicateDecisions?.() || []) {
      const left = records.byId.get(decision.leftId); const right = records.byId.get(decision.rightId);
      if (left && right && String(versionOf(left)) === String(decision.leftVersion) && String(versionOf(right)) === String(decision.rightVersion)) this.examinedPairs.add(pairVersion(left, right));
    }
    const candidates = await this.duplicateCandidates(records, signal); cancelled(signal);
    const selected = new Map(); const pairs = [];
    const maxRecords = Math.max(2, Math.min(MAX_CANDIDATES, Math.floor(Number(limit) || MAX_CANDIDATES)));
    let estimate = 0;
    for (const pair of candidates) {
      if (pairs.length >= MAX_DUPLICATE_PAIRS) break;
      if (!this.fresh(pair.left, scope) || !this.fresh(pair.right, scope)) continue;
      const next = new Map(selected); next.set(pair.left.id, asCandidate(pair.left, [])); next.set(pair.right.id, asCandidate(pair.right, []));
      if ([...next.values()].some(item => !item.text) || next.size > maxRecords) continue;
      const nextPairs = [...pairs, { leftId: pair.left.id, rightId: pair.right.id }];
      const nextEstimate = estimateTokens({ candidates: [...next.values()], pairs: nextPairs }) + 1500;
      if (nextEstimate > DUPLICATE_INPUT_BUDGET) continue;
      selected.clear(); for (const [id, candidate] of next) selected.set(id, candidate);
      pairs.push(nextPairs.at(-1)); estimate = nextEstimate;
    }
    const usage = usageEmpty(); let suggestions = []; let developments = [];
    const client = this.getClient();
    if (pairs.length) {
      const response = await client.findDuplicates([...selected.values()], { approved: true, signal, maxTokens: 1500, pairs });
      cancelled(signal); addUsage(usage, response, estimate);
      if (!Array.isArray(response.duplicates)) throw new Error('Invalid AI duplicate suggestions.');
      const allowed = new Set(pairs.map(pair => pairKey(pair.leftId, pair.rightId))); const used = new Set(); const valid = [];
      for (const item of response.duplicates) {
        const key = pairKey(item.leftId, item.rightId); const left = records.byId.get(item.leftId); const right = records.byId.get(item.rightId);
        if (!allowed.has(key) || used.has(key) || !['same', 'development'].includes(item.kind) || typeof item.reason !== 'string' || typeof item.leftQuote !== 'string' || !item.leftQuote.trim() || typeof item.rightQuote !== 'string' || !item.rightQuote.trim() || !selected.get(item.leftId)?.text.includes(item.leftQuote) || !selected.get(item.rightId)?.text.includes(item.rightQuote)) throw new Error('Invalid AI duplicate evidence.');
        used.add(key);
        if (!this.fresh(left, scope) || !this.fresh(right, scope)) continue;
        valid.push({ ...item, leftVersion: versionOf(left), rightVersion: versionOf(right) });
      }
      cancelled(signal);
      suggestions = (this.store.saveDuplicateSuggestions(valid.filter(item => item.kind === 'same')) || []).filter(item => !item.status || item.status === 'pending');
      developments = valid.filter(item => item.kind === 'development');
      for (const pair of pairs) {
        const left = records.byId.get(pair.leftId); const right = records.byId.get(pair.rightId);
        if (this.fresh(left, scope) && this.fresh(right, scope)) this.examinedPairs.add(pairVersion(left, right));
      }
    }
    const examinedCount = selected.size;
    return { suggestions, developments, model: client.model || '', usage,
      coverage: { scopeCount: records.length, candidateCount: new Set(candidates.flatMap(pair => [pair.left.id, pair.right.id])).size, candidatePairCount: candidates.length, examinedCount, examinedPairCount: pairs.length, notExaminedCount: Math.max(0, records.length - examinedCount), hasMore: candidates.length > pairs.length },
      limitations: ['仅检查本次本地召回的相似记录对，不代表已完整比较所有灵感；原始记录不会被自动合并或删除。'],
    };
  }
}

module.exports = { LibraryAI, inScope, normalizeFilters, estimateTokens, SEARCH_INPUT_BUDGET, SEARCH_OUTPUT_BUDGET, DUPLICATE_INPUT_BUDGET, MAX_CANDIDATES };
