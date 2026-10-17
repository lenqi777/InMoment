'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const palette = ['#6b8c54', '#7897a0', '#ae956a', '#8e80a4', '#71a18b', '#b0827c'];
  const state = { graph: null, points: new Map(), selected: null, query: '', zoom: 1, center: { x: 0, y: 0 }, base: { width: 1200, height: 800 }, request: 0, visible: false, onSelectRecord: null, drag: null, suppressBlankClick: false };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '灵感云：滚轮缩放，拖动空白平移；点选灵感查看连接，点击空白取消选中，双击打开记录。');
  svg.style.userSelect = 'none';
  function element(tag, attributes = {}, text) { const item = document.createElementNS(svg.namespaceURI, tag); for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value)); if (text !== undefined) item.textContent = text; return item; }
  function view() { const w = state.base.width / state.zoom, h = state.base.height / state.zoom; svg.setAttribute('viewBox', [state.center.x - w / 2, state.center.y - h / 2, w, h].join(' ')); }
  function reset() {
    const points = [...state.points.values()]; if (!points.length) return;
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    state.base = { width: Math.max(500, Math.max(...xs) - Math.min(...xs) + 180), height: Math.max(400, Math.max(...ys) - Math.min(...ys) + 180) };
    state.center = { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 }; state.zoom = 1; view();
  }
  function neighbours(id) { return new Set((state.graph?.edges || []).filter(edge => edge.source === id || edge.target === id).flatMap(edge => [edge.source, edge.target])); }
  function highlight() {
    const id = state.selected, related = neighbours(id);
    for (const item of svg.querySelectorAll('[data-cloud-id]')) {
      const active = item.getAttribute('data-cloud-id'), node = state.graph?.nodes.find(value => value.id === active);
      item.style.opacity = state.query && !node?.title.toLocaleLowerCase().includes(state.query) ? '.12' : !id || active === id || related.has(active) ? '1' : '.17';
    }
    for (const item of svg.querySelectorAll('[data-cloud-edge]')) item.style.opacity = !id ? '.4' : item.getAttribute('data-cloud-edge').split('|').includes(id) ? '.65' : '.08';
  }
  function select(id) {
    const selected = state.graph?.nodes.find(node => node.id === id); state.selected = selected ? id : null; const related = neighbours(state.selected); highlight();
    const panel = $('#cloud-selection'); panel.replaceChildren(); panel.classList.toggle('hidden', !selected); if (!selected) return;
    const title = document.createElement('strong'); title.textContent = selected.title; panel.append(title);
    const hint = document.createElement('p'); hint.className = 'field-help'; hint.textContent = related.size ? '相近的灵感 · 连线是语义相似推断' : '暂未找到足够相近的灵感'; panel.append(hint);
    for (const node of state.graph.nodes.filter(node => node.id !== id && related.has(node.id)).slice(0, 8)) { const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = node.title; button.addEventListener('click', () => { select(node.id); focus(); }); panel.append(button); }
    const open = document.createElement('button'); open.type = 'button'; open.className = 'button primary compact'; open.textContent = '打开这条灵感'; open.addEventListener('click', () => state.onSelectRecord?.(id)); panel.append(open);
  }
  function focus() { const point = state.points.get(state.selected); if (!point) return; state.center = { x: point.x, y: point.y }; state.zoom = Math.max(1.6, state.zoom); view(); }
  function render(graph) {
    state.graph = graph; state.selected = null; state.drag = null; state.points.clear(); svg.replaceChildren(); $('#cloud-selection').classList.add('hidden');
    const groups = graph.communities || [];
    const columns = Math.max(1, Math.ceil(Math.sqrt(groups.length)));
    groups.forEach((group, groupIndex) => {
      const centerX = groupIndex % columns * 420, centerY = Math.floor(groupIndex / columns) * 380;
      group.members.forEach((id, index) => { const angle = index * 2.399963; const radius = Math.sqrt(index) * Math.min(34, 155 / Math.sqrt(Math.max(1, group.members.length))); state.points.set(id, { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius, color: palette[groupIndex % palette.length] }); });
      if (group.members.length > 1) { const radius = Math.max(65, Math.sqrt(group.members.length - 1) * Math.min(34, 155 / Math.sqrt(group.members.length)) + 35); const halo = element('circle', { cx: centerX, cy: centerY, r: radius, fill: palette[groupIndex % palette.length], opacity: '.035', 'pointer-events': 'none' }); svg.append(halo); }
    });
    for (const [index, node] of graph.nodes.entries()) if (!state.points.has(node.id)) state.points.set(node.id, { x: index * 30, y: 0, color: palette[0] });
    for (const edge of graph.edges) { const a = state.points.get(edge.source), b = state.points.get(edge.target); if (!a || !b) continue; svg.append(element('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: a.color, 'stroke-width': 1 + Math.max(0, edge.weight - .8) * 8, opacity: '.4', 'pointer-events': 'none', 'data-cloud-edge': edge.source + '|' + edge.target })); }
    const degree = new Map(); for (const edge of graph.edges) for (const id of [edge.source, edge.target]) degree.set(id, (degree.get(id) || 0) + 1);
    const labelled = new Set(groups.flatMap(group => group.members.slice().sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0)).slice(0, group.members.length < 8 ? 3 : 2)));
    for (const node of graph.nodes) {
      const point = state.points.get(node.id); const item = element('g', { transform: 'translate(' + point.x + ',' + point.y + ')', role: 'button', tabindex: '0', 'aria-label': node.title, 'data-cloud-id': node.id }); item.style.cursor = 'pointer';
      item.append(element('circle', { r: 14, fill: 'transparent', class: 'cloud-node-hit', 'pointer-events': 'all' }), element('circle', { r: Math.min(10, 5 + (degree.get(node.id) || 0) * .7), fill: point.color, stroke: '#fff', 'stroke-width': 2, class: 'cloud-node-dot' }), element('title', {}, node.title));
      if (labelled.has(node.id)) item.append(element('text', { x: 13, y: 4, fill: '#252525', 'font-size': 13, 'pointer-events': 'none' }, node.title.length > 18 ? node.title.slice(0, 18) + '…' : node.title));
      item.addEventListener('click', event => { event.stopPropagation(); select(node.id); }); item.addEventListener('dblclick', event => { event.stopPropagation(); state.onSelectRecord?.(node.id); });
      item.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); state.onSelectRecord?.(node.id); } else if (event.key === ' ') { event.preventDefault(); select(node.id); focus(); } }); svg.append(item);
    }
    $('#thought-cloud-root').replaceChildren(svg); reset(); highlight();
    const count = graph.coverage?.totalCount ?? graph.nodes.length, missing = graph.coverage?.hasMore;
    $('#cloud-status').textContent = '显示 ' + graph.nodes.length + ' / ' + count + ' 条灵感 · ' + groups.filter(group => !group.isolated).length + ' 个相似团' + (missing ? '；单次最多显示 800 条' : '') + '。连线表示相似，不代表事实关系。';
  }
  async function load() {
    const version = ++state.request; $('#cloud-status').textContent = '正在建立本地语义索引…';
    try { const graph = await window.inmoment.invoke('semantic:cloud'); if (version === state.request && state.visible) render(graph); }
    catch (error) { if (version !== state.request) return; const empty = document.createElement('div'); empty.className = 'empty-state detail-empty'; const title = document.createElement('h2'); title.textContent = '灵感云还未准备好'; const description = document.createElement('p'); description.textContent = error.message; empty.append(title, description); $('#thought-cloud-root').replaceChildren(empty); $('#cloud-status').textContent = error.message; }
  }
  svg.addEventListener('wheel', event => { event.preventDefault(); state.zoom = Math.max(.2, Math.min(8, state.zoom * Math.exp(-event.deltaY * .0015))); view(); }, { passive: false });
  svg.addEventListener('pointerdown', event => { if (event.button !== 0 || event.target.closest('[data-cloud-id]')) return; state.suppressBlankClick = false; state.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, center: { ...state.center }, moved: false }; svg.setPointerCapture(event.pointerId); });
  svg.addEventListener('pointermove', event => { const drag = state.drag; if (!drag || drag.id !== event.pointerId) return; if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 5) drag.moved = true; if (!drag.moved) return; const rect = svg.getBoundingClientRect(); state.center = { x: drag.center.x - (event.clientX - drag.x) * state.base.width / state.zoom / rect.width, y: drag.center.y - (event.clientY - drag.y) * state.base.height / state.zoom / rect.height }; view(); });
  svg.addEventListener('pointerup', event => { const drag = state.drag; if (!drag || drag.id !== event.pointerId) return; state.drag = null; state.suppressBlankClick = drag.moved; if (!drag.moved) select(null); });
  for (const name of ['pointercancel', 'lostpointercapture']) svg.addEventListener(name, () => { state.drag = null; });
  svg.addEventListener('click', event => { if (event.target.closest('[data-cloud-id]')) return; if (!state.suppressBlankClick) select(null); state.suppressBlankClick = false; });
  $('#cloud-zoom-out').addEventListener('click', () => { state.zoom = Math.max(.2, state.zoom / 1.3); view(); }); $('#cloud-zoom-in').addEventListener('click', () => { state.zoom = Math.min(8, state.zoom * 1.3); view(); });
  $('#cloud-reset').addEventListener('click', () => { select(null); reset(); }); $('#cloud-focus').addEventListener('click', focus); $('#cloud-refresh').addEventListener('click', load);
  $('#cloud-search').addEventListener('input', event => { state.query = event.target.value.trim().toLocaleLowerCase(); highlight(); });
  window.inmoment.subscribe(event => { if (!['recordsChanged', 'libraryChanged', 'topicsChanged'].includes(event.type)) return; state.request += 1; state.graph = null; state.selected = null; state.points.clear(); svg.replaceChildren(); $('#cloud-selection').replaceChildren(); $('#cloud-selection').classList.add('hidden'); if (state.visible) $('#cloud-status').textContent = '灵感已更新，点击“刷新”重新查看相似连接。'; });
  window.InMomentCloud = { show({ onSelectRecord } = {}) { state.onSelectRecord = onSelectRecord; state.visible = true; return load(); }, hide() { state.visible = false; state.request += 1; }, render };
})();
