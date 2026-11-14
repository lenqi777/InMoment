'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { BATCH_GROUPING_LIMITS, groupingInput, validateBatchGrouping } = require('../core/deepseek.cjs');
const { candidateTopics } = require('./batch-organizer.cjs');
const { recordIdForNote } = require('./notes.cjs');

const MAX_NOTES = BATCH_GROUPING_LIMITS.maxRecords;

function excerpt(value, limit) {
  return value.trim().slice(0, limit * 2).replace(/[\s\u0000-\u001f\u007f]+/gu, ' ')
    .slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '').trim();
}

function topicChoice(id) { return 'topic:' + id; }
function normalizeTopic(name) { return name.normalize('NFKC').toLocaleLowerCase(); }

function scopedTopics(topics) {
  const byId = new Map(topics.map(topic => [topic.id, topic]));
  const used = new Set(topics.filter(topic => !topic.parentId).map(topic => normalizeTopic(topic.name)));
  return topics.map(topic => {
    if (!topic.parentId) return { ...topic, displayName: topic.name };
    const ancestors = [];
    for (let parent = byId.get(topic.parentId); parent; parent = byId.get(parent.parentId)) ancestors.unshift(parent.name);
    const displayName = [...ancestors, topic.name].join(' / ');
    const trimmed = [...displayName].length <= 60 ? displayName
      : [...ancestors.join(' / ')].slice(0, 24).join('') + '… / ' + [...topic.name].slice(0, 31).join('');
    let name = trimmed;
    for (let index = 2; used.has(normalizeTopic(name)); index++) {
      const suffix = ` (${index})`;
      name = [...trimmed].slice(0, 60 - suffix.length).join('') + suffix;
    }
    used.add(normalizeTopic(name));
    return { ...topic, name, displayName };
  });
}

class NoteGrouping {
  constructor({ store, notes }) {
    this.store = store;
    this.notes = notes;
    this.plan = null;
  }

  getNote(id) {
    const note = this.notes.get(id);
    if (note.summaryParentId) throw new Error('总结附件随原笔记归档。');
    return note;
  }

  fingerprint(note) {
    const recordId = recordIdForNote(note.id);
    const generation = recordId ? this.store.row(recordId)?.generation : note.createdAt;
    return createHash('sha256').update(JSON.stringify([generation, note.title, note.body, [...note.topicIds].sort()])).digest('hex');
  }

  unchanged(id, previous) {
    try { return this.fingerprint(this.getNote(id)) === previous; }
    catch (error) {
      if (error.message === '这条笔记已不存在。') return false;
      throw error;
    }
  }

  snapshot(noteIds) {
    if (!Array.isArray(noteIds) || !noteIds.length || noteIds.length > MAX_NOTES || noteIds.some(id => typeof id !== 'string')) {
      throw new Error('请选择当前显示的笔记，一次最多整理 100 条。');
    }
    const generation = randomUUID();
    const ids = [...new Set(noteIds)];
    const bodyLimit = Math.min(4800, Math.floor(7500 / ids.length));
    const frozen = new Map();
    const records = [];
    const currentTopics = new Set();
    for (const id of ids) {
      const note = this.getNote(id);
      const title = excerpt(note.title, 88);
      const summary = excerpt(note.body, bodyLimit) || title;
      if (!summary) continue;
      const key = 'note-' + records.length;
      records.push({ id: key, version: 1, generation, title, summary });
      frozen.set(key, { id, title: title || excerpt(summary, 88), fingerprint: this.fingerprint(note) });
      for (const topic of note.topics) currentTopics.add(topic.id);
    }
    if (!records.length) throw new Error('当前笔记没有可用于分组的标题或正文。');
    const topics = scopedTopics(this.store.listTopics());
    const input = groupingInput(records, candidateTopics(topics, records, topics.filter(topic => currentTopics.has(topic.id)).map(topic => topic.name)));
    return { runId: generation, frozen, topics, input, omitted: ids.length - records.length };
  }

  async suggest(snapshot, classify, { signal } = {}) {
    this.plan = null;
    const { runId, input, frozen, topics, omitted } = snapshot;
    if (signal?.aborted) return { cancelled: true };
    if ([...frozen.values()].some(note => !this.unchanged(note.id, note.fingerprint))) throw new Error('笔记已变化，请重新整理当前列表。');
    const result = await classify(input.records, { availableTopics: input.availableTopics, approved: true, signal });
    if (signal?.aborted) return { cancelled: true };
    const validated = validateBatchGrouping(result, input);
    const topicByName = new Map(topics.map(topic => [normalizeTopic(topic.name), topic]));
    const choices = new Map();
    const noteList = records => records.map(({ id }) => ({ id: frozen.get(id).id, title: frozen.get(id).title }));
    const groups = validated.groups.map((group, index) => {
      const topic = topicByName.get(normalizeTopic(group.name));
      const key = topic ? topicChoice(topic.id) : 'suggestion:' + index;
      if (!topic) choices.set(key, group.name);
      return { key, name: topic?.displayName || group.name, existing: Boolean(topic), reason: group.reason, notes: noteList(group.records) };
    });
    const unassigned = validated.unassigned.map(item => ({ ...noteList([item])[0], reason: item.reason }));
    this.plan = { runId, choices, notes: new Map([...frozen.values()].map(note => [note.id, note.fingerprint])) };
    return { runId, groups, unassigned, omitted, topics: topics.map(topic => ({ id: topic.id, name: topic.displayName })) };
  }

  addTopic(id, topicId) {
    this.getNote(id);
    this.store.validateTopicIds([topicId]);
    const recordId = recordIdForNote(id);
    if (recordId) this.store.addRecordTopic(recordId, topicId);
    else this.store.db.prepare('INSERT OR IGNORE INTO note_topics(note_id,topic_id) VALUES (?,?)').run(id, topicId);
  }

  apply(runId, assignments) {
    const plan = this.plan;
    if (!plan || plan.runId !== runId) throw new Error('分组建议已过期，请重新整理。');
    if (!Array.isArray(assignments) || !assignments.length || assignments.length > plan.notes.size) throw new Error('请选择要采用的分组建议。');
    const topics = new Map(this.store.listTopics().map(topic => [topicChoice(topic.id), topic.id]));
    const ids = new Set();
    for (const assignment of assignments) {
      if (!assignment || !plan.notes.has(assignment.id) || ids.has(assignment.id) || !topics.has(assignment.key) && !plan.choices.has(assignment.key)) {
        throw new Error('分组建议或已有分组已变化，请重新整理。');
      }
      ids.add(assignment.id);
    }
    const { db } = this.store;
    db.exec('BEGIN IMMEDIATE');
    let applied = 0;
    try {
      for (const { id, key } of assignments) {
        if (!this.unchanged(id, plan.notes.get(id))) continue;
        if (!topics.has(key)) topics.set(key, this.store.createTopic(plan.choices.get(key)).id);
        this.addTopic(id, topics.get(key));
        applied += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    this.plan = null;
    return { applied, skipped: assignments.length - applied };
  }
}

module.exports = { NoteGrouping };
