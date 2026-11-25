'use strict';

// Görev düzenleyici: harita üzerinde görev planlama (QGroundControl'ün Plan görünümüne benzer).
//   Solda araçlar (nokta, ROI, alan taraması, koridor, çevre turu, çit, toplanma noktası, ev, ölçüm), sağda görev /
//   çit / toplanma sekmeleri ve seçili öğenin ayarları, altta yükseklik profili. Değişiklikler kendiliğinden kaydedilir.
//   Dosya: QGroundControl .plan ve Mission Planner .waypoints içe / dışa aktarma. Araç: yükle, oku, sil.

(() => {
  const ID = new URLSearchParams(location.search).get('id');
  const $ = (s) => document.querySelector(s);
  const TILES = {
    sat: { tiles: ['vdm://tiles/sat/{z}/{x}/{y}'], attribution: 'Esri, Maxar, Earthstar Geographics', maxzoom: 19 },
    street: { tiles: ['vdm://tiles/street/{z}/{x}/{y}'], attribution: '© OpenStreetMap', maxzoom: 19 },
  };
  const TYPE_ICON = { takeoff: 'takeoff', waypoint: 'pin', spline: 'route', loiterTime: 'clock', loiterTurns: 'refresh', loiterUnlim: 'refresh', loiterAlt: 'altitude', land: 'land', rtl: 'home', vtolTakeoff: 'takeoff', vtolLand: 'land',
    delay: 'clock', speed: 'gauge', yaw: 'refresh', roi: 'eyeTarget', roiNone: 'eyeOff', jump: 'swap', camTrigDist: 'camera', camPhoto: 'camera', camStop: 'camera', videoStart: 'video', videoStop: 'video', gimbal: 'crosshair', servo: 'bolt', relay: 'bolt', gripper: 'lock', changeAlt: 'altitude', landStart: 'land' };
  const TOOLS = [['select', 'cursor'], ['waypoint', 'pin'], ['roi', 'eyeTarget'], ['survey', 'grid'], ['corridor', 'route'], ['orbit', 'refresh'], ['fencePoly', 'polygon'], ['fenceCircle', 'circleIcon'], ['rally', 'flag'], ['home', 'home'], ['measure', 'ruler']];
  const DRAW_TOOLS = { survey: 3, corridor: 2, fencePoly: 3, measure: 2 }; // çok noktalı çizim araçları → en az nokta

  let doc = null;
  let settings = {};
  let drones = [];
  let map = null;
  let style = 'sat';
  let tool = 'select';
  let tab = 'mission';
  let sel = -1;            // seçili görev öğesi
  let draft = [];          // çizilmekte olan noktalar [[lat, lon]…]
  let markers = [];
  let dragging = false;
  let saveTimer = null;
  let busy = false;
  const past = []; const future = [];

  const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m || 0)} m`);
  const fmtTime = (s) => { const hh = Math.floor(s / 3600); const mm = Math.floor((s % 3600) / 60); return `${hh ? `${hh}:` : ''}${String(mm).padStart(hh ? 2 : 1, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`; };
  const typeName = (type) => t(`ms.t.${type}`);
  const def = (it) => MISSION.TYPES[it.type];
  const hasPos = (it) => def(it).pos && it.lat !== null && it.lon !== null;

  // ---- Kayıt ve geri alma ----
  function snapshot() { return JSON.stringify(doc); }
  function commit(before) {
    if (before && before !== snapshot()) { past.push(before); if (past.length > 100) past.shift(); future.length = 0; }
    doc = { ...MISSION.normalize(doc), id: ID };
    if (sel >= doc.items.length) sel = doc.items.length - 1;
    paintAll();
    clearTimeout(saveTimer);
    $('#msSub').textContent = t('ms.saving');
    saveTimer = setTimeout(async () => { const r = await window.api.saveMission({ ...doc, id: ID }); $('#msSub').textContent = r && r.ok ? t('ms.saved') : t('ms.saveFailed'); }, 500);
  }
  // Değişikliği uygular: fn doc'u yerinde değiştirir
  function change(fn) { const before = snapshot(); fn(); commit(before); }
  function undo() { if (!past.length) return; future.push(snapshot()); doc = JSON.parse(past.pop()); commit(null); }
  function redo() { if (!future.length) return; past.push(snapshot()); doc = JSON.parse(future.pop()); commit(null); }

  // ---- Harita ----
  function initMap() {
    const v = settings.missionView;
    map = new FlatMap({ container: 'map', center: v && Number.isFinite(v.lon) ? [v.lon, v.lat] : [32.8663, 39.9255], zoom: v && v.zoom ? v.zoom : 5, sources: { sat: TILES.sat, street: TILES.street }, visible: style, dblZoom: false });
    const empty = { type: 'FeatureCollection', features: [] };
    for (const id of ['fence', 'path', 'draft']) map.addSource(id, { type: 'geojson', data: empty });
    map.addLayer({ id: 'fence', type: 'fill', source: 'fence', paint: {} });
    map.addLayer({ id: 'path', type: 'line', source: 'path', paint: { 'line-color': '#fbbf24', 'line-width': 2.6 } });
    map.addLayer({ id: 'draftFill', type: 'fill', source: 'draft', paint: {} });
    map.addLayer({ id: 'draft', type: 'line', source: 'draft', paint: { 'line-color': '#22d3ee', 'line-width': 2, 'line-dasharray': [2, 2] } });
    map.on('click', (e) => onMapClick(e.lngLat.lat, e.lngLat.lng));
    map.on('dblclick', () => { if (DRAW_TOOLS[tool]) finishDraft(); });
    map.on('mousemove', (e) => { $('#coord').textContent = `${e.lngLat.lat.toFixed(6)}, ${e.lngLat.lng.toFixed(6)}`; });
    let moveTimer = null;
    map.on('move', () => { clearTimeout(moveTimer); moveTimer = setTimeout(() => { const c = map.getCenter(); window.api.setSettings({ missionView: { lat: c.lat, lon: c.lng, zoom: map.getZoom() } }); }, 800); });
    new ResizeObserver(() => map.resize()).observe($('#map'));
  }
  function fit() {
    const pts = [];
    for (const it of doc.items) if (hasPos(it)) pts.push([it.lon, it.lat]);
    if (doc.home) pts.push([doc.home.lon, doc.home.lat]);
    for (const pg of doc.fence.polygons) for (const q of pg.points) pts.push([q[1], q[0]]);
    for (const c of doc.fence.circles) pts.push([c.lon, c.lat]);
    for (const q of doc.rally) pts.push([q.lon, q.lat]);
    if (pts.length) map.fitBounds(pts, 110);
  }

  const line = (coords, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });
  const poly = (coords, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [coords] } });
  const ring = (c) => MISSION.orbit({ lat: c.lat, lon: c.lon, radius: c.radius, points: 48 }).map((q) => [q[1], q[0]]);

  // Sürüklenebilir işaret
  function addMarker(cls, html, lat, lon, { onDrag, onDrop, onClick, title } = {}) {
    const el = document.createElement('div');
    el.className = `ms-mk ${cls}`;
    el.innerHTML = html;
    if (title) el.title = title;
    const mk = new FlatMarker({ element: el }).setLngLat([lon, lat]).addTo(map);
    markers.push(mk);
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      const start = [e.clientX, e.clientY];
      let moved = false;
      const before = snapshot();
      const move = (ev) => {
        if (!onDrag) return;
        if (!moved && Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) < 4) return;
        moved = true; dragging = true;
        const r = $('#map').getBoundingClientRect();
        const p = map.unproject(ev.clientX - r.left, ev.clientY - r.top);
        mk.setLngLat([p.lng, p.lat]);
        onDrag(p.lat, p.lng);
        paintShapes();
      };
      const up = () => {
        removeEventListener('mousemove', move); removeEventListener('mouseup', up);
        dragging = false;
        if (moved) { if (onDrop) onDrop(); commit(before); } else if (onClick) onClick();
      };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
    el.addEventListener('click', (e) => e.stopPropagation());
    return mk;
  }

  // Çizgiler ve alanlar (işaretler sürüklenirken de çağrılır)
  function paintShapes() {
    const pts = MISSION.path(doc);
    const feats = [];
    if (pts.length > 1) feats.push(line(pts.map((q) => [q.lon, q.lat])));
    // ROI: bakış çizgileri seçili ROI için
    map.getSource('path').setData({ type: 'FeatureCollection', features: feats });
    const ff = [];
    for (const pg of doc.fence.polygons) ff.push(poly([...pg.points, pg.points[0]].map((q) => [q[1], q[0]]), { color: pg.inclusion ? '#34d399' : '#f43f5e', opacity: pg.inclusion ? 0.1 : 0.25, dash: !pg.inclusion }));
    for (const c of doc.fence.circles) ff.push(poly(ring(c), { color: c.inclusion ? '#34d399' : '#f43f5e', opacity: c.inclusion ? 0.1 : 0.25, dash: !c.inclusion }));
    map.getSource('fence').setData({ type: 'FeatureCollection', features: ff });
    const df = [];
    if (draft.length > 1) {
      const c = draft.map((q) => [q[1], q[0]]);
      if ((tool === 'survey' || tool === 'fencePoly') && draft.length > 2) df.push(poly([...c, c[0]], { color: '#22d3ee', opacity: 0.12, dash: true }));
      else df.push(line(c));
    }
    map.getSource('draft').setData({ type: 'FeatureCollection', features: df });
  }

  function paintMap() {
    for (const mk of markers) mk.remove();
    markers = [];
    if (doc.home) addMarker('home', 'H', doc.home.lat, doc.home.lon, { title: t('ms.home'), onDrag: (la, lo) => { doc.home.lat = la; doc.home.lon = lo; }, onClick: () => { tab = 'mission'; sel = -1; paintPanel(); } });
    doc.items.forEach((it, i) => {
      if (!hasPos(it)) return;
      const cls = `${it.type === 'roi' ? 'roi' : it.type === 'land' || it.type === 'vtolLand' ? 'land' : ''} ${i === sel ? 'sel' : ''} ${it.group ? 'grp' : ''}`;
      addMarker(cls, it.type === 'roi' ? icon('eyeTarget') : String(i + 1), it.lat, it.lon, { title: `${i + 1}. ${typeName(it.type)} · ${it.alt} m`, onDrag: (la, lo) => { it.lat = la; it.lon = lo; }, onClick: () => select(i) });
    });
    doc.fence.polygons.forEach((pg) => pg.points.forEach((q) => addMarker(`vtx ${pg.inclusion ? '' : 'ex'}`, '', q[0], q[1], { onDrag: (la, lo) => { q[0] = la; q[1] = lo; }, onClick: () => { tab = 'fence'; paintPanel(); } })));
    doc.fence.circles.forEach((c) => addMarker(`vtx ${c.inclusion ? '' : 'ex'}`, '', c.lat, c.lon, { onDrag: (la, lo) => { c.lat = la; c.lon = lo; }, onClick: () => { tab = 'fence'; paintPanel(); } }));
    doc.rally.forEach((q, i) => addMarker('rally', 'R', q.lat, q.lon, { title: `${t('ms.rally')} ${i + 1}`, onDrag: (la, lo) => { q.lat = la; q.lon = lo; }, onClick: () => { tab = 'rally'; paintPanel(); } }));
    draft.forEach((q) => addMarker('draft', '', q[0], q[1], {}));
    paintShapes();
  }

  // ---- Araçlar ----
  function setTool(next) {
    tool = next;
    draft = [];
    paintTools();
    paintMap();
  }
  function paintTools() {
    $('#tools').innerHTML = TOOLS.map(([id, ic]) => `<button class="ms-tool ${tool === id ? 'on' : ''}" data-tool="${id}" title="${esc(t(`ms.tool.${id}.tip`))}">${icon(ic)}<span>${esc(t(`ms.tool.${id}`))}</span></button>`).join('');
    const n = DRAW_TOOLS[tool];
    const hint = tool === 'select' ? '' : n ? t(draft.length >= n ? 'ms.hint.finish' : 'ms.hint.draw', { n: draft.length }) : t(`ms.hint.${tool}`);
    $('#hint').textContent = tool === 'measure' && draft.length > 1 ? `${t('ms.tool.measure')}: ${fmtDist(draft.reduce((a, q, i) => (i ? a + MISSION.distance(draft[i - 1][0], draft[i - 1][1], q[0], q[1]) : 0), 0))}` : hint;
    $('#hint').classList.toggle('hidden', !hint);
    $('#map').classList.toggle('picking', tool !== 'select');
    $('#mapTools').innerHTML = [['style', 'layers', t(style === 'sat' ? 'fl.street' : 'fl.sat')], ['fit', 'crosshair', t('ms.fit')], ['zin', 'plus', '+'], ['zout', 'minus', '−']].map(([id, ic, title]) => `<button class="icon-btn" data-t="${id}" title="${esc(title)}">${icon(ic)}</button>`).join('');
  }
  $('#tools').onclick = (e) => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool === tool ? 'select' : b.dataset.tool); };
  $('#mapTools').onclick = (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    if (b.dataset.t === 'style') { style = style === 'sat' ? 'street' : 'sat'; map.setLayoutProperty(style, 'visibility', 'visible'); window.api.setSettings({ flightStyle: style }); paintTools(); }
    else if (b.dataset.t === 'fit') fit();
    else if (b.dataset.t === 'zin') map.zoomIn(); else map.zoomOut();
  };

  // Yeni öğe: seçili öğeden sonra (seçim yoksa sona) eklenir
  function insertItems(list) {
    const at = sel >= 0 ? sel + 1 : doc.items.length;
    doc.items.splice(at, 0, ...list);
    sel = at + list.length - 1;
  }
  // Kopter / uçakta ilk gezinme öğesinden önce kalkış yoksa eklenir (QGroundControl'deki gibi)
  function ensureTakeoff() {
    if (!['copter', 'plane'].includes(doc.vehicle) || doc.items.some((it) => it.type === 'takeoff' || it.type === 'vtolTakeoff')) return;
    doc.items.unshift(MISSION.newItem('takeoff', { alt: doc.defaults.alt }, doc.defaults));
    if (sel >= 0) sel++;
  }

  function onMapClick(lat, lon) {
    if (dragging) return;
    if (tool === 'select') { if (sel !== -1) select(-1); return; }
    if (DRAW_TOOLS[tool]) { draft.push([lat, lon]); paintTools(); paintMap(); return; }
    if (tool === 'waypoint') change(() => { ensureTakeoff(); insertItems([MISSION.newItem('waypoint', { lat, lon }, doc.defaults)]); tab = 'mission'; });
    else if (tool === 'roi') change(() => { insertItems([MISSION.newItem('roi', { lat, lon, alt: 0 }, doc.defaults)]); tab = 'mission'; });
    else if (tool === 'rally') change(() => { doc.rally.push({ lat, lon, alt: doc.defaults.alt }); tab = 'rally'; });
    else if (tool === 'home') { change(() => { doc.home = { lat, lon, alt: doc.home ? doc.home.alt : 0 }; }); setTool('select'); }
    else if (tool === 'orbit') orbitDialog(lat, lon);
    else if (tool === 'fenceCircle') circleDialog(lat, lon);
  }

  function numField(id, label, value, min, max, step = 1, unit = '') {
    return `<div class="field"><label>${esc(label)}</label><div class="unit-wrap"><input class="input" type="number" data-f="${id}" min="${min}" max="${max}" step="${step}" value="${value}">${unit ? `<span class="unit">${esc(unit)}</span>` : ''}</div></div>`;
  }
  function formDialog(title, iconName, fields, okText) {
    return openModal({
      title, iconName, width: 460,
      body: `<div class="op-form">${fields}</div>`,
      buttons: [{ label: t('common.giveUp'), value: null }, { label: okText || t('ms.generate'), cls: 'primary', onClick: (m) => { const out = {}; for (const i of m.querySelectorAll('[data-f]')) out[i.dataset.f] = i.type === 'checkbox' ? i.checked : Number(i.value); return out; } }],
      onMount: (m) => enhanceNumbers(m),
    });
  }
  const check = (id, label, on) => `<label class="ms-check"><input type="checkbox" data-f="${id}" ${on ? 'checked' : ''}><span>${esc(label)}</span></label>`;
  const gid = () => Math.random().toString(36).slice(2, 8);

  async function finishDraft() {
    const pts = draft.slice();
    const need = DRAW_TOOLS[tool];
    if (!need || pts.length < need) return;
    if (tool === 'measure') { setTool('select'); return; }
    if (tool === 'fencePoly') { change(() => { doc.fence.polygons.push({ inclusion: true, points: pts }); tab = 'fence'; }); setTool('select'); return; }
    if (tool === 'survey') {
      const v = await formDialog(t('ms.tool.survey'), 'grid', numField('alt', t('ms.alt'), doc.defaults.alt, 2, 500, 1, 'm') + numField('spacing', t('ms.spacing'), 30, 2, 500, 1, 'm') + numField('angle', t('ms.angle'), 0, 0, 359, 1, '°') + numField('overshoot', t('ms.overshoot'), 0, 0, 200, 1, 'm') + numField('trigger', t('ms.trigger'), 0, 0, 500, 1, 'm'));
      if (!v) return;
      const grid = MISSION.survey({ polygon: pts, spacing: v.spacing, angle: v.angle, overshoot: v.overshoot });
      if (!grid.length) { toast(t('ms.noPattern'), { type: 'err' }); return; }
      addPattern(grid, v.alt, v.trigger);
    } else if (tool === 'corridor') {
      const v = await formDialog(t('ms.tool.corridor'), 'route', numField('alt', t('ms.alt'), doc.defaults.alt, 2, 500, 1, 'm') + numField('width', t('ms.width'), 60, 0, 1000, 1, 'm') + numField('spacing', t('ms.spacing'), 30, 2, 500, 1, 'm') + numField('trigger', t('ms.trigger'), 0, 0, 500, 1, 'm'));
      if (!v) return;
      addPattern(MISSION.corridor({ line: pts, width: v.width, spacing: v.spacing }), v.alt, v.trigger);
    }
    setTool('select');
  }
  // Üretilen noktaları tek bir grup olarak ekler (isteğe bağlı kamera tetikleme ile)
  function addPattern(points, alt, trigger, extra = []) {
    const group = gid();
    change(() => {
      ensureTakeoff();
      const list = [...extra];
      if (trigger > 0) list.push({ ...MISSION.newItem('camTrigDist', {}, doc.defaults), p: { distance: trigger } });
      for (const q of points) list.push(MISSION.newItem('waypoint', { lat: q[0], lon: q[1], alt }, doc.defaults));
      if (trigger > 0) list.push({ ...MISSION.newItem('camTrigDist', {}, doc.defaults), p: { distance: 0 } });
      for (const it of list) it.group = group;
      insertItems(list);
      tab = 'mission';
    });
  }
  async function orbitDialog(lat, lon) {
    const v = await formDialog(t('ms.tool.orbit'), 'refresh', numField('alt', t('ms.alt'), doc.defaults.alt, 2, 500, 1, 'm') + numField('radius', t('ms.radius'), 40, 5, 2000, 1, 'm') + numField('points', t('ms.points'), 12, 3, 72, 1) + check('clockwise', t('ms.clockwise'), true) + check('roi', t('ms.roiCenter'), true));
    if (!v) return;
    const extra = v.roi ? [MISSION.newItem('roi', { lat, lon, alt: 0 }, doc.defaults)] : [];
    addPattern(MISSION.orbit({ lat, lon, radius: v.radius, points: v.points, clockwise: v.clockwise }), v.alt, 0, extra);
    setTool('select');
  }
  async function circleDialog(lat, lon) {
    const v = await formDialog(t('ms.tool.fenceCircle'), 'circleIcon', numField('radius', t('ms.radius'), 200, 5, 20000, 5, 'm') + check('inclusion', t('ms.inclusion'), true), t('common.ok'));
    if (!v) return;
    change(() => { doc.fence.circles.push({ inclusion: v.inclusion, lat, lon, radius: v.radius }); tab = 'fence'; });
    setTool('select');
  }

  // ---- Sağ panel ----
  function select(i) { sel = i; tab = 'mission'; paintMap(); paintPanel(); paintProfile(); const row = $(`.ms-item[data-i="${i}"]`); if (row) row.scrollIntoView({ block: 'nearest' }); }

  function itemSummary(it) {
    const d = def(it);
    const parts = [];
    if (d.pos || d.alt) parts.push(`${it.alt} m`);
    for (const [key] of d.params) { const v = it.p[key]; if (v !== null && v !== undefined && key !== 'yaw' && key !== 'radius' && v !== 0) parts.push(`${t(`ms.p.${key}`)} ${v}`); }
    return parts.slice(0, 3).join(' · ');
  }

  function itemEditor(it, i) {
    const d = def(it);
    const types = MISSION.AVAILABLE[doc.vehicle];
    let html = `<div class="ms-edit"><div class="field"><label>${esc(t('ms.type'))}</label><select class="input" data-e="type">${[...new Set([...types, it.type])].map((k) => `<option value="${k}" ${k === it.type ? 'selected' : ''}>${esc(typeName(k))}</option>`).join('')}</select></div>`;
    if (d.pos) html += `<div class="ms-row2"><div class="field"><label>${esc(t('ms.lat'))}</label><input class="input mono" type="number" step="0.000001" data-e="lat" value="${it.lat === null ? '' : it.lat}"></div><div class="field"><label>${esc(t('ms.lon'))}</label><input class="input mono" type="number" step="0.000001" data-e="lon" value="${it.lon === null ? '' : it.lon}"></div></div>`;
    if (d.pos || d.alt) html += `${numField('alt', t('ms.alt'), it.alt, 0, 500, 1, 'm').replace('data-f="alt"', 'data-e="alt"')}<div class="field"><label>${esc(t('ms.frame'))}</label><select class="input" data-e="frame">${['rel', 'amsl', 'terrain'].map((f) => `<option value="${f}" ${f === it.frame ? 'selected' : ''}>${esc(t(`ms.frame.${f}`))}</option>`).join('')}</select></div>`;
    for (const [key, , dv, lo, hi, step] of d.params) {
      const v = it.p[key];
      if (dv === null) html += `<div class="field"><label>${esc(t(`ms.p.${key}`))}</label><div class="ms-opt"><label class="ms-check"><input type="checkbox" data-auto="${key}" ${v === null ? 'checked' : ''}><span>${esc(t('ms.auto'))}</span></label><input class="input" type="number" data-p="${key}" min="${lo}" max="${hi}" step="${step}" value="${v === null ? 0 : v}" ${v === null ? 'disabled' : ''}></div></div>`;
      else if (lo === 0 && hi === 1) html += `<label class="ms-check"><input type="checkbox" data-pb="${key}" ${v ? 'checked' : ''}><span>${esc(t(`ms.p.${key}`))}</span></label>`;
      else html += numField(key, t(`ms.p.${key}`), v, lo, hi, step).replace(`data-f="${key}"`, `data-p="${key}"`);
    }
    html += `<div class="ms-edit-foot"><button class="btn sm" data-act="up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button><button class="btn sm" data-act="down" ${i === doc.items.length - 1 ? 'disabled' : ''}>${icon('chevronDown')}</button><button class="btn sm" data-act="dup">${icon('copy')}${esc(t('app.duplicate'))}</button><span style="flex:1"></span>${it.group ? `<button class="btn sm danger" data-act="delGroup">${icon('trash')}${esc(t('ms.delGroup'))}</button>` : ''}<button class="btn sm danger" data-act="del">${icon('trash')}${esc(t('common.delete'))}</button></div></div>`;
    return html;
  }

  function paintPanel() {
    $('#tabs').innerHTML = [['mission', 'route', `${t('ms.tab.mission')} (${doc.items.length})`], ['fence', 'polygon', `${t('ms.fence')} (${doc.fence.polygons.length + doc.fence.circles.length})`], ['rally', 'flag', `${t('ms.rally')} (${doc.rally.length})`]].map(([id, ic, label]) => `<button type="button" data-tab="${id}" class="${tab === id ? 'on' : ''}">${icon(ic)}${esc(label)}</button>`).join('');
    const body = $('#panelBody');
    const keep = body.scrollTop;
    if (tab === 'mission') {
      const warns = MISSION.validate(doc).filter((w) => w.code !== 'empty');
      const h0 = doc.home;
      body.innerHTML = `
        <details class="cf-sec" ${settings.msDefaultsOpen === false ? '' : 'open'} data-sec="defaults"><summary>${icon('gear')}<span>${esc(t('ms.defaults'))}</span>${icon('chevronDown', 'chev')}</summary><div class="cf-grid ms-defaults">
          ${numField('alt', t('ms.defAlt'), doc.defaults.alt, 2, 500, 1, 'm').replace('data-f=', 'data-d=')}${numField('speed', t('ms.defSpeed'), doc.defaults.speed, 0.5, 40, 0.5, 'm/s').replace('data-f=', 'data-d=')}
          <div class="field"><label>${esc(t('ms.home'))}</label><div class="ms-home">${h0 ? `<span class="mono">${h0.lat.toFixed(6)}, ${h0.lon.toFixed(6)}</span><button class="icon-btn" data-act="homeDel" title="${esc(t('common.delete'))}">${icon('x')}</button>` : `<span class="muted">${esc(t('ms.homeNone'))}</span>`}<button class="btn sm" data-act="homePick">${icon('home')}${esc(t('ms.homePick'))}</button></div></div>
          ${h0 ? numField('homeAlt', t('ms.homeAlt'), h0.alt, 0, 5000, 1, 'm').replace('data-f=', 'data-d=') : ''}
        </div></details>
        ${warns.map((w) => `<div class="ms-warn">${icon('alert')}<span>${esc(t(`ms.warn.${w.code}`, { n: (w.index || 0) + 1 }))}</span></div>`).join('')}
        <div class="ms-add"><select class="input" id="addType"><option value="">${esc(t('ms.addCommand'))}</option>${MISSION.AVAILABLE[doc.vehicle].map((k) => `<option value="${k}">${esc(typeName(k))}</option>`).join('')}</select></div>
        <div class="ms-items">${doc.items.length ? doc.items.map((it, i) => `<div class="ms-item ${i === sel ? 'sel' : ''} ${it.group ? 'grp' : ''}" data-i="${i}"><div class="ms-item-head"><b>${i + 1}</b>${icon(TYPE_ICON[it.type] || 'pin')}<span class="n">${esc(typeName(it.type))}</span><span class="s">${esc(itemSummary(it))}</span></div>${i === sel ? itemEditor(it, i) : ''}</div>`).join('') : `<div class="empty-note">${esc(t('ms.emptyItems'))}</div>`}</div>`;
    } else if (tab === 'fence') {
      body.innerHTML = `<div class="ms-note">${esc(t('ms.fenceNote'))}</div>
        ${doc.fence.polygons.map((pg, i) => `<div class="ms-item"><div class="ms-item-head">${icon('polygon')}<span class="n">${esc(t('ms.fencePoly', { n: pg.points.length }))}</span><label class="ms-check"><input type="checkbox" data-fp="${i}" ${pg.inclusion ? 'checked' : ''}><span>${esc(t('ms.inclusion'))}</span></label><button class="icon-btn" data-fdel="p${i}">${icon('trash')}</button></div></div>`).join('')}
        ${doc.fence.circles.map((c, i) => `<div class="ms-item"><div class="ms-item-head">${icon('circleIcon')}<span class="n">${esc(t('ms.fenceCircle'))}</span><label class="ms-check"><input type="checkbox" data-fc="${i}" ${c.inclusion ? 'checked' : ''}><span>${esc(t('ms.inclusion'))}</span></label><button class="icon-btn" data-fdel="c${i}">${icon('trash')}</button></div><div class="ms-edit">${numField(`r${i}`, t('ms.radius'), c.radius, 5, 20000, 5, 'm').replace('data-f=', 'data-fr=')}</div></div>`).join('')}
        ${doc.fence.polygons.length + doc.fence.circles.length ? '' : `<div class="empty-note">${esc(t('ms.fenceEmpty'))}</div>`}`;
    } else {
      body.innerHTML = `<div class="ms-note">${esc(t('ms.rallyNote'))}</div>
        ${doc.rally.map((q, i) => `<div class="ms-item"><div class="ms-item-head"><b>R${i + 1}</b>${icon('flag')}<span class="n mono">${q.lat.toFixed(6)}, ${q.lon.toFixed(6)}</span><button class="icon-btn" data-rdel="${i}">${icon('trash')}</button></div><div class="ms-edit">${numField(`a${i}`, t('ms.alt'), q.alt, 0, 500, 1, 'm').replace('data-f=', 'data-ra=')}</div></div>`).join('')}
        ${doc.rally.length ? '' : `<div class="empty-note">${esc(t('ms.rallyEmpty'))}</div>`}`;
    }
    enhanceNumbers(body);
    body.scrollTop = keep;
  }

  $('#tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; paintPanel(); } };
  const body = $('#panelBody');
  body.addEventListener('toggle', (e) => { const d = e.target.closest('[data-sec="defaults"]'); if (d) { settings.msDefaultsOpen = d.open; window.api.setSettings({ msDefaultsOpen: d.open }); } }, true);
  body.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'homePick') setTool('home');
      else if (a === 'homeDel') change(() => { doc.home = null; });
      else if (sel >= 0) {
        const i = sel;
        if (a === 'del') change(() => { doc.items.splice(i, 1); sel = Math.min(i, doc.items.length - 1); });
        else if (a === 'delGroup') change(() => { const g = doc.items[i].group; doc.items = doc.items.filter((x) => x.group !== g); sel = -1; });
        else if (a === 'dup') change(() => { const c = JSON.parse(JSON.stringify(doc.items[i])); delete c.group; doc.items.splice(i + 1, 0, c); sel = i + 1; });
        else if (a === 'up' && i > 0) change(() => { [doc.items[i - 1], doc.items[i]] = [doc.items[i], doc.items[i - 1]]; sel = i - 1; });
        else if (a === 'down' && i < doc.items.length - 1) change(() => { [doc.items[i + 1], doc.items[i]] = [doc.items[i], doc.items[i + 1]]; sel = i + 1; });
      }
      return;
    }
    const fdel = e.target.closest('[data-fdel]');
    if (fdel) { const k = fdel.dataset.fdel; change(() => { (k[0] === 'p' ? doc.fence.polygons : doc.fence.circles).splice(Number(k.slice(1)), 1); }); return; }
    const rdel = e.target.closest('[data-rdel]');
    if (rdel) { change(() => { doc.rally.splice(Number(rdel.dataset.rdel), 1); }); return; }
    const head = e.target.closest('.ms-item-head');
    const row = e.target.closest('.ms-item[data-i]');
    if (head && row && tab === 'mission') { const i = Number(row.dataset.i); select(i === sel ? -1 : i); if (i !== sel) return; const it = doc.items[i]; if (it && hasPos(it)) map.easeTo({ center: [it.lon, it.lat] }); }
  });
  body.addEventListener('change', (e) => {
    const x = e.target;
    const d = x.dataset;
    if (x.id === 'addType') {
      if (!x.value) return;
      const type = x.value;
      change(() => { const c = map.getCenter(); if (type !== 'takeoff' && MISSION.TYPES[type].pos) ensureTakeoff(); if (type === 'takeoff' || type === 'vtolTakeoff') { doc.items.unshift(MISSION.newItem(type, { alt: doc.defaults.alt }, doc.defaults)); sel = 0; } else insertItems([MISSION.newItem(type, { lat: c.lat, lon: c.lng }, doc.defaults)]); });
      return;
    }
    if (d.d !== undefined) { const v = Number(x.value); if (!Number.isFinite(v)) return; change(() => { if (d.d === 'homeAlt') doc.home.alt = v; else doc.defaults[d.d] = v; }); return; }
    if (d.fp !== undefined) { change(() => { doc.fence.polygons[Number(d.fp)].inclusion = x.checked; }); return; }
    if (d.fc !== undefined) { change(() => { doc.fence.circles[Number(d.fc)].inclusion = x.checked; }); return; }
    if (d.fr !== undefined) { change(() => { doc.fence.circles[Number(d.fr.slice(1))].radius = Number(x.value); }); return; }
    if (d.ra !== undefined) { change(() => { doc.rally[Number(d.ra.slice(1))].alt = Number(x.value); }); return; }
    const it = doc.items[sel];
    if (!it) return;
    if (d.e === 'type') change(() => { const n = MISSION.newItem(x.value, { lat: it.lat === null ? map.getCenter().lat : it.lat, lon: it.lon === null ? map.getCenter().lng : it.lon, alt: it.alt || doc.defaults.alt, frame: it.frame }, doc.defaults); doc.items[sel] = n; });
    else if (d.e === 'frame') change(() => { it.frame = x.value; });
    else if (d.e) { const v = Number(x.value); if (x.value === '' || !Number.isFinite(v)) return; change(() => { it[d.e] = v; }); }
    else if (d.p) { const v = Number(x.value); if (!Number.isFinite(v)) return; change(() => { it.p[d.p] = v; }); }
    else if (d.pb) change(() => { it.p[d.pb] = x.checked ? 1 : 0; });
    else if (d.auto) change(() => { it.p[d.auto] = x.checked ? null : 0; });
  });

  // ---- Üst bilgi, istatistik, profil ----
  function paintStats() {
    const s = MISSION.stats(doc);
    const box = (label, value, unit = '') => `<div class="tm"><label>${esc(label)}</label><div><b>${esc(value)}</b><small>${esc(unit)}</small></div></div>`;
    $('#stats').innerHTML = `<div class="fl-tm">${box(t('ms.st.items'), String(s.count))}${box(t('ms.st.distance'), s.distance >= 1000 ? (s.distance / 1000).toFixed(2) : String(s.distance), s.distance >= 1000 ? 'km' : 'm')}${box(t('ms.st.time'), fmtTime(s.time))}${box(t('ms.st.far'), s.maxFromHome >= 1000 ? (s.maxFromHome / 1000).toFixed(2) : String(s.maxFromHome), s.maxFromHome >= 1000 ? 'km' : 'm')}${box(t('ms.st.maxAlt'), String(s.maxAlt), 'm')}</div>`;
  }

  // Yükseklik profili: yol boyunca mesafeye karşı irtifa
  function paintProfile() {
    const c = $('#profile');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth; const h = c.clientHeight;
    if (!w || !h) return;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const pts = MISSION.path(doc);
    const css = getComputedStyle(document.documentElement);
    $('#profileTitle').textContent = t('ms.profile');
    if (pts.length < 2) { $('#profileInfo').textContent = ''; g.fillStyle = css.getPropertyValue('--text-3'); g.font = '12px sans-serif'; g.textAlign = 'center'; g.fillText(t('ms.profileEmpty'), w / 2, h / 2); return; }
    const xs = [0];
    for (let i = 1; i < pts.length; i++) xs.push(xs[i - 1] + MISSION.distance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
    const total = xs[xs.length - 1] || 1;
    const maxAlt = Math.max(10, ...pts.map((q) => q.alt)) * 1.15;
    const L = 38; const R = 10; const T = 8; const B = 18;
    const X = (d) => L + (d / total) * (w - L - R); const Y = (a) => h - B - (a / maxAlt) * (h - T - B);
    g.strokeStyle = css.getPropertyValue('--border'); g.fillStyle = css.getPropertyValue('--text-3'); g.lineWidth = 1; g.font = '10.5px sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let k = 0; k <= 3; k++) { const a = (maxAlt / 3) * k; g.beginPath(); g.moveTo(L, Y(a)); g.lineTo(w - R, Y(a)); g.stroke(); g.fillText(`${Math.round(a)}`, L - 5, Y(a)); }
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let k = 0; k <= 4; k++) g.fillText(fmtDist((total / 4) * k), X((total / 4) * k), h - B + 4);
    g.beginPath(); pts.forEach((q, i) => (i ? g.lineTo(X(xs[i]), Y(q.alt)) : g.moveTo(X(xs[i]), Y(q.alt))));
    g.strokeStyle = '#fbbf24'; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    g.lineTo(X(total), Y(0)); g.lineTo(X(0), Y(0)); g.closePath(); g.globalAlpha = 0.14; g.fillStyle = '#fbbf24'; g.fill(); g.globalAlpha = 1;
    pts.forEach((q, i) => { g.beginPath(); g.arc(X(xs[i]), Y(q.alt), q.index === sel ? 5 : 3, 0, Math.PI * 2); g.fillStyle = q.index === sel ? '#22d3ee' : q.index === -1 ? '#34d399' : '#fbbf24'; g.fill(); });
    $('#profileInfo').textContent = `${fmtDist(total)} · ${t('ms.st.maxAlt')} ${Math.round(Math.max(...pts.map((q) => q.alt)))} m`;
  }

  function paintTop() {
    document.title = `${doc.name} — Video Master`;
    if (document.activeElement !== $('#msName')) $('#msName').value = doc.name;
    $('#msVehicle').innerHTML = MISSION.VEHICLES.map((v) => `<option value="${v}" ${v === doc.vehicle ? 'selected' : ''}>${esc(t(`ms.v.${v}`))}</option>`).join('');
    $('#btnUndo').disabled = !past.length; $('#btnRedo').disabled = !future.length;
    const mav = drones.filter((d) => d.firmware !== 'betaflight');
    const cur = $('#msDrone').value || settings.missionDrone || '';
    $('#msDrone').innerHTML = `<option value="">${esc(t(mav.length ? 'ms.pickDrone' : 'ms.noDrone'))}</option>${mav.map((d) => `<option value="${esc(d.id)}" ${d.id === cur ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}`;
    const ok = !!$('#msDrone').value && !busy;
    $('#btnUpload').disabled = !ok || !doc.items.length; $('#btnDownload').disabled = !ok; $('#btnClearVehicle').disabled = !ok;
  }
  function paintAll() { paintTop(); paintStats(); paintTools(); paintMap(); paintPanel(); paintProfile(); }

  // ---- Üst çubuk ----
  $('#msIcon').innerHTML = icon('route');
  $('#btnUndo').innerHTML = icon('undo'); $('#btnUndo').title = `${t('ms.undo')} (Ctrl+Z)`;
  $('#btnRedo').innerHTML = icon('redo'); $('#btnRedo').title = `${t('ms.redo')} (Ctrl+Y)`;
  $('#btnImport').innerHTML = `${icon('upload')}${esc(t('ms.import'))}`;
  $('#btnExportPlan').innerHTML = `${icon('download')}.plan`; $('#btnExportPlan').title = t('ms.exportPlan');
  $('#btnExportWpl').innerHTML = `${icon('download')}.waypoints`; $('#btnExportWpl').title = t('ms.exportWpl');
  $('#btnUpload').innerHTML = `${icon('upload')}${esc(t('ms.upload'))}`;
  $('#btnDownload').innerHTML = `${icon('download')}${esc(t('ms.download'))}`;
  $('#btnClearVehicle').innerHTML = icon('trash'); $('#btnClearVehicle').title = t('ms.clearVehicle');
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  $('#msName').addEventListener('change', (e) => { const v = e.target.value.trim(); if (v) change(() => { doc.name = v; }); else e.target.value = doc.name; });
  $('#msVehicle').onchange = (e) => change(() => { doc.vehicle = e.target.value; });
  $('#msDrone').onchange = (e) => { settings.missionDrone = e.target.value; window.api.setSettings({ missionDrone: e.target.value }); paintTop(); };
  const firmwareOf = () => { const d = drones.find((x) => x.id === $('#msDrone').value); return d && d.firmware === 'px4' ? 'px4' : 'ardupilot'; };
  $('#btnExportPlan').onclick = async () => { const f = await window.api.exportMission({ doc, format: 'plan', firmware: firmwareOf() }); if (f) toast(t('ms.exported'), { type: 'ok', sub: f }); };
  $('#btnExportWpl').onclick = async () => { const f = await window.api.exportMission({ doc, format: 'waypoints' }); if (f) toast(t('ms.exported'), { type: 'ok', sub: f }); };
  async function replaceWith(next, what) {
    if (doc.items.length && !await confirmBox(what, esc(t('ms.replaceConfirm')), { okText: t('ms.replace'), danger: false })) return false;
    change(() => { doc.items = next.items; doc.fence = next.fence; doc.rally = next.rally; if (next.home) doc.home = next.home; if (next.vehicle && what !== t('ms.download')) doc.vehicle = next.vehicle; sel = -1; });
    fit();
    return true;
  }
  $('#btnImport').onclick = async () => {
    const r = await window.api.importMission();
    if (!r) return;
    if (!r.ok) { toast(t('ms.importFailed'), { type: 'err', sub: r.error }); return; }
    if (await replaceWith(r.doc, t('ms.import'))) toast(t('ms.imported', { n: r.doc.items.length }), { type: 'ok', sub: r.skipped ? t('ms.skipped', { n: r.skipped }) : r.file });
  };
  async function vehicle(op, label) {
    const droneId = $('#msDrone').value;
    if (!droneId || busy) return null;
    busy = true; paintTop();
    const note = toast(label, { sub: t('ms.working'), timeout: 0 });
    let r;
    try { r = await window.api.missionVehicle({ droneId, op, doc }); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    note.remove();
    busy = false; paintTop();
    if (!r || !r.ok) toast(t('dr.failed'), { type: 'err', sub: `${label} — ${tOpt(`dr.err.${r && r.error}`, tOpt(`ms.err.${r && r.error}`, (r && r.error) || ''))}${r && r.part ? ` (${t(`ms.part.${r.part}`)})` : ''}`, timeout: 7000 });
    return r && r.ok ? r : null;
  }
  $('#btnUpload').onclick = async () => {
    const warns = MISSION.validate(doc);
    if (warns.length && !await confirmBox(t('ms.upload'), `${esc(t('ms.uploadWarn'))}<ul>${warns.map((w) => `<li>${esc(t(`ms.warn.${w.code}`, { n: (w.index || 0) + 1 }))}</li>`).join('')}</ul>`, { okText: t('ms.upload'), danger: false })) return;
    const r = await vehicle('upload', t('ms.upload'));
    if (r) toast(t('ms.uploaded', { n: r.count }), { type: 'ok', sub: r.fence || r.rally ? t('ms.uploadedExtra', { fence: r.fence || 0, rally: r.rally || 0 }) : '' });
  };
  $('#btnDownload').onclick = async () => { const r = await vehicle('download', t('ms.download')); if (r && r.mission && await replaceWith(r.mission, t('ms.download'))) toast(t('ms.downloaded', { n: r.mission.items.length }), { type: 'ok', sub: r.mission.skipped ? t('ms.skipped', { n: r.mission.skipped }) : '' }); };
  $('#btnClearVehicle').onclick = async () => { if (await confirmBox(t('ms.clearVehicle'), esc(t('ms.clearVehicleConfirm')), { okText: t('ms.clearVehicle') })) { const r = await vehicle('clear', t('ms.clearVehicle')); if (r) toast(t('ms.cleared'), { type: 'ok' }); } };

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); }
    else if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) { if (tool !== 'select') setTool('select'); else if (sel !== -1) select(-1); }
    else if (e.key === 'Enter' && DRAW_TOOLS[tool] && !typing && !document.querySelector('.modal-backdrop')) finishDraft();
    else if (e.key === 'Backspace' && DRAW_TOOLS[tool] && draft.length && !typing) { draft.pop(); paintTools(); paintMap(); }
    else if (e.key === 'Delete' && !typing && sel >= 0 && tab === 'mission') change(() => { doc.items.splice(sel, 1); sel = Math.min(sel, doc.items.length - 1); });
  });

  window.api.onMissionChanged((m) => { if (m.id === ID) { doc = { ...MISSION.normalize(m), id: ID }; paintAll(); } });
  window.api.onStoreChanged((s) => { drones = s.drones || []; settings = { ...settings, ...s.settings, missionDrone: settings.missionDrone, msDefaultsOpen: settings.msDefaultsOpen }; paintTop(); });
  new ResizeObserver(paintProfile).observe($('#profile'));

  (async () => {
    const [store, m] = await Promise.all([window.api.getStore(), window.api.getMission(ID)]);
    if (!m) return window.close();
    settings = store.settings || {};
    drones = store.drones || [];
    style = settings.flightStyle === 'street' ? 'street' : 'sat';
    doc = { ...MISSION.normalize(m), id: ID };
    themeButton($('#btnTheme'), () => settings);
    initMap();
    paintAll();
    $('#msSub').textContent = t('ms.saved');
    requestAnimationFrame(() => { fit(); });
  })();
})();
