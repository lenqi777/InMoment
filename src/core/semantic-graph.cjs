'use strict';

function unit(vector) {
  if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) throw new Error('无效的本地语义向量。');
  const values = Array.from(vector, Number);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!values.length || values.some(value => !Number.isFinite(value)) || !norm) throw new Error('无效的本地语义向量。');
  return values.map(value => value / norm);
}
function cosine(left, right) {
  if (left.length !== right.length) throw new Error('语义模型维度不一致，请重建索引。');
  return Math.max(-1, Math.min(1, left.reduce((sum, value, index) => sum + value * right[index], 0)));
}
function abort(signal) { if (signal?.aborted) { const error = new Error('已停止本地索引。'); error.name = 'AbortError'; throw error; } }

// Sparse mutual-neighbour graph: similarity edges are inferred, not factual or
// manually assigned group membership. No all-to-all edges or preset cluster count.
async function similarityGraph(entries, { neighbours = 5, threshold = 0.84, signal } = {}) {
  const normalized = entries.map(entry => ({ ...entry, vector: unit(entry.vector) }));
  const near = normalized.map(() => []);
  for (let left = 0; left < normalized.length; left += 1) {
    if (left % 16 === 0) { await new Promise(resolve => setImmediate(resolve)); abort(signal); }
    for (let right = left + 1; right < normalized.length; right += 1) {
      const score = cosine(normalized[left].vector, normalized[right].vector);
      if (score < threshold) continue;
      near[left].push({ index: right, score }); near[right].push({ index: left, score });
    }
  }
  const limit = Math.max(1, Math.min(10, neighbours));
  for (const list of near) list.sort((a, b) => b.score - a.score || a.index - b.index).splice(limit);
  const sets = near.map(list => new Set(list.map(item => item.index)));
  const edges = [];
  near.forEach((list, left) => list.forEach(({ index: right, score }) => {
    if (right > left && sets[right].has(left)) edges.push({ source: normalized[left].id, target: normalized[right].id, weight: score });
  }));
  const communities = modularityCommunities(normalized.map(entry => entry.id), edges);
  const membership = new Map(communities.flatMap(group => group.members.map(id => [id, group.id])));
  return {
    nodes: normalized.map(({ vector, ...entry }) => ({ ...entry, community: membership.get(entry.id) })),
    edges, communities,
    algorithm: { name: 'mutual-knn-modularity', neighbours: limit, threshold, inferred: true },
  };
}

// Deterministic local modularity optimisation, followed by connected-component
// splitting. Isolated ideas remain independent; a bridge never forces one blob.
function modularityCommunities(ids, edges) {
  const adjacency = new Map(ids.map(id => [id, []]));
  const degree = new Map(ids.map(id => [id, 0]));
  for (const edge of edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target) || edge.source === edge.target) continue;
    adjacency.get(edge.source).push([edge.target, edge.weight]); adjacency.get(edge.target).push([edge.source, edge.weight]);
    degree.set(edge.source, degree.get(edge.source) + edge.weight); degree.set(edge.target, degree.get(edge.target) + edge.weight);
  }
  const total = [...degree.values()].reduce((a, b) => a + b, 0);
  const labels = new Map(ids.map(id => [id, id])); const totals = new Map(degree);
  if (total) for (let pass = 0; pass < 16; pass += 1) {
    let changed = false;
    for (const id of ids) {
      const current = labels.get(id), weight = degree.get(id);
      const neighbouring = new Map();
      for (const [other, edgeWeight] of adjacency.get(id)) { const label = labels.get(other); neighbouring.set(label, (neighbouring.get(label) || 0) + edgeWeight); }
      totals.set(current, (totals.get(current) || 0) - weight);
      let best = current, bestGain = (neighbouring.get(current) || 0) - weight * (totals.get(current) || 0) / total;
      for (const [label, within] of neighbouring) {
        const gain = within - weight * (totals.get(label) || 0) / total;
        if (gain > bestGain + 1e-10) { best = label; bestGain = gain; }
      }
      totals.set(best, (totals.get(best) || 0) + weight); labels.set(id, best); if (best !== current) changed = true;
    }
    if (!changed) break;
  }
  const visited = new Set(), groups = [];
  for (const id of ids) {
    if (visited.has(id)) continue;
    const queue = [id], members = []; visited.add(id);
    while (queue.length) { const next = queue.shift(); members.push(next); for (const [other] of adjacency.get(next)) if (!visited.has(other) && labels.get(other) === labels.get(id)) { visited.add(other); queue.push(other); } }
    groups.push({ id: 'cloud-' + groups.length, members, isolated: members.length === 1 });
  }
  return groups;
}

module.exports = { unit, cosine, similarityGraph, modularityCommunities };
