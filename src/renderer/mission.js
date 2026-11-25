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
  const TOOLS = [['select', 'cursor'], ['waypoint', 'pin'], ['roi', 'eyeTarget'], ['survey', 'grid'], ['corridor', 'route'], ['orbit', 'refresh'], ['structure', 'layers'], ['landing', 'land'], ['fencePoly', 'polygon'], ['fenceCircle', 'circleIcon'], ['rally', 'flag'], ['home', 'home'], ['measure', 'ruler']];
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
    const sg = sel >= 0 && doc.items[sel] ? doc.items[sel].group : null;
    const pt = sg && doc.patterns ? doc.patterns[sg] : null;
    if (pt && pt.args.polygon) { const c = pt.args.polygon.map((q) => [q[1], q[0]]); df.push(poly([...c, c[0]], { color: '#fde68a', opacity: 0.08, dash: true })); }
    if (pt && pt.args.line) df.push(line(pt.args.line.map((q) => [q[1], q[0]]), { color: '#fde68a' }));
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
    // Seçili öğenin deseni: köşeleri / merkezi sürüklenebilir; bırakınca desen yeniden üretilir
    const sg = sel >= 0 && doc.items[sel] ? doc.items[sel].group : null;
    const pt = sg && doc.patterns ? doc.patterns[sg] : null;
    if (pt) {
      const a = pt.args;
      const geo = a.polygon || a.line;
      if (geo) geo.forEach((q) => addMarker('pvtx', '', q[0], q[1], { onDrag: (la, lo) => { q[0] = la; q[1] = lo; }, onDrop: () => regenerate(sg) }));
      else if (Number.isFinite(a.lat)) addMarker('pvtx ctr', '', a.lat, a.lon, { onDrag: (la, lo) => { a.lat = la; a.lon = lo; }, onDrop: () => regenerate(sg) });
    }
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
    $('#tools').innerHTML = TOOLS.filter(([id]) => id !== 'landing' || doc.vehicle === 'plane').map(([id, ic]) => `<button class="ms-tool ${tool === id ? 'on' : ''}" data-tool="${id}" title="${esc(t(`ms.tool.${id}.tip`))}">${icon(ic)}<span>${esc(t(`ms.tool.${id}`))}</span></button>`).join('');
    const n = DRAW_TOOLS[tool];
    const hint = tool === 'select' ? '' : n ? t(draft.length >= n ? 'ms.hint.finish' : 'ms.hint.draw', { n: draft.length }) : t(`ms.hint.${tool}`);
    $('#hint').textContent = tool === 'measure' && draft.length > 1 ? `${t('ms.tool.measure')}: ${fmtDist(draft.reduce((a, q, i) => (i ? a + MISSION.distance(draft[i - 1][0], draft[i - 1][1], q[0], q[1]) : 0), 0))}` : hint;
    $('#hint').classList.toggle('hidden', !hint);
    $('#map').classList.toggle('picking', tool !== 'select');
    $('#mapTools').innerHTML = [['style', 'layers', t(style === 'sat' ? 'fl.street' : 'fl.sat')], ['fit', 'crosshair', t('ms.fit')], ['offline', 'download', t('ms.offline')], ['zin', 'plus', '+'], ['zout', 'minus', '−']].map(([id, ic, title]) => `<button class="icon-btn" data-t="${id}" title="${esc(title)}">${icon(ic)}</button>`).join('');
  }
  $('#tools').onclick = (e) => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool === tool ? 'select' : b.dataset.tool); };
  $('#mapTools').onclick = (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    if (b.dataset.t === 'style') { style = style === 'sat' ? 'street' : 'sat'; map.setLayoutProperty(style, 'visibility', 'visible'); window.api.setSettings({ flightStyle: style }); paintTools(); }
    else if (b.dataset.t === 'fit') fit();
    else if (b.dataset.t === 'offline') offlineDialog();
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
    else if (tool === 'orbit' || tool === 'structure' || tool === 'landing') patternDialog(tool, { lat, lon });
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
    if (tool === 'survey') await patternDialog('survey', { polygon: pts });
    else if (tool === 'corridor') await patternDialog('corridor', { line: pts });
  }

  // ---- Desenler (alan taraması, koridor, çevre turu, yapı taraması, iniş deseni) ----
  // Her desenin tanımı doc.patterns[grup] içinde saklanır; böylece sonradan yeniden açılıp ayarlanabilir, köşeleri
  // sürüklenebilir. Öğeler tanımdan yeniden üretilir.
  const PATTERN_DEFAULTS = {
    survey: { alt: 0, mode: 'manual', spacing: 30, angle: 0, overshoot: 0, trigger: 0, camera: 'p4p', side: 70, front: 80, sensorW: 13.2, sensorH: 8.8, focal: 8.8, imageW: 5472, follow: false },
    corridor: { alt: 0, mode: 'manual', width: 60, spacing: 30, trigger: 0, camera: 'p4p', side: 70, front: 80, sensorW: 13.2, sensorH: 8.8, focal: 8.8, imageW: 5472, follow: false },
    orbit: { alt: 0, radius: 40, points: 12, clockwise: true, roi: true },
    structure: { radius: 30, bottom: 10, top: 40, layers: 3, points: 12, clockwise: true, roi: true },
    landing: { heading: 0, distance: 300, alt: 40, radius: 60 },
  };
  const camOf = (a) => (a.camera === 'custom' ? { sensorW: a.sensorW, sensorH: a.sensorH, focal: a.focal, imageW: a.imageW } : MISSION.CAMERAS.find((c) => c.id === a.camera) || MISSION.CAMERAS[1]);
  // Kamera kipinde hat ve fotoğraf aralığı irtifa ile örtüşmeden hesaplanır
  function effective(a) {
    if (a.mode !== 'camera') return { spacing: a.spacing, trigger: a.trigger, gsd: null };
    return MISSION.cameraCalc(camOf(a), a.alt, a.side, a.front);
  }
  // Tanımdan görev öğelerini üretir (grup etiketi olmadan). Araziyi izleme için yükseklik verisi okunur.
  async function buildPattern(kind, a) {
    const D = doc.defaults;
    const wp = (q, alt) => MISSION.newItem('waypoint', { lat: q[0], lon: q[1], alt }, D);
    if (kind === 'survey' || kind === 'corridor') {
      const e = effective(a);
      let pts = kind === 'survey' ? MISSION.survey({ polygon: a.polygon, spacing: e.spacing, angle: a.angle, overshoot: a.overshoot }) : MISSION.corridor({ line: a.line, width: a.width, spacing: e.spacing });
      if (!pts.length) return [];
      let list = pts.map((q) => ({ lat: q[0], lon: q[1], alt: a.alt, mid: false }));
      if (a.follow) {
        const dense = MISSION.densify(pts, 50);
        const hq = doc.home ? [doc.home.lat, doc.home.lon] : pts[0];
        const [h0, ...el] = await Terrain.many([hq, ...dense.map((q) => [q[0], q[1]])]);
        if (h0 === null || el.some((v) => v === null)) toast(t('ms.noTerrain'), { type: 'err', timeout: 6000 });
        else list = MISSION.thin(dense.map((q, i) => ({ lat: q[0], lon: q[1], alt: Math.round((el[i] + a.alt - h0) * 10) / 10, mid: q[2] })), 3);
      }
      const items = [];
      if (e.trigger > 0) items.push({ ...MISSION.newItem('camTrigDist', {}, D), p: { distance: Math.round(e.trigger * 10) / 10 } });
      for (const q of list) items.push(wp([q.lat, q.lon], q.alt));
      if (e.trigger > 0) items.push({ ...MISSION.newItem('camTrigDist', {}, D), p: { distance: 0 } });
      return items;
    }
    if (kind === 'orbit') return [...(a.roi ? [MISSION.newItem('roi', { lat: a.lat, lon: a.lon, alt: 0 }, D)] : []), ...MISSION.orbit(a).map((q) => wp(q, a.alt))];
    if (kind === 'structure') return [...(a.roi ? [MISSION.newItem('roi', { lat: a.lat, lon: a.lon, alt: (a.bottom + a.top) / 2 }, D)] : []), ...MISSION.structure(a).map((q) => wp(q, q[2]))];
    if (kind === 'landing') {
      const lp = MISSION.landingPattern(a);
      return [MISSION.newItem('landStart', { lat: lp.approach.lat, lon: lp.approach.lon, alt: a.alt }, D), { ...MISSION.newItem('loiterAlt', { lat: lp.approach.lat, lon: lp.approach.lon, alt: a.alt }, D), p: { radius: a.radius } }, MISSION.newItem('land', { lat: a.lat, lon: a.lon, alt: 0 }, D)];
    }
    return [];
  }
  // Deseni ekler ya da (grup verilmişse) yerinde yeniden üretir
  async function applyPattern(kind, args, group) {
    const items = await buildPattern(kind, args);
    if (!items.length) { toast(t('ms.noPattern'), { type: 'err' }); return false; }
    const id = group || gid();
    for (const it of items) it.group = id;
    change(() => {
      if (group) {
        const at = doc.items.findIndex((x) => x.group === group);
        doc.items = doc.items.filter((x) => x.group !== group);
        doc.items.splice(at < 0 ? doc.items.length : at, 0, ...items);
        sel = Math.max(0, at);
      } else { if (kind !== 'landing') ensureTakeoff(); insertItems(items); }
      doc.patterns = { ...(doc.patterns || {}), [id]: { kind, args } };
      tab = 'mission';
    });
    return true;
  }

  // Desen penceresi: yeni desen (base: çizilen geometri) ya da var olanı düzenleme (group)
  async function patternDialog(kind, base, group) {
    const a = { ...PATTERN_DEFAULTS[kind], ...base };
    if (!a.alt && kind !== 'structure') a.alt = doc.defaults.alt;
    const cam = kind === 'survey' || kind === 'corridor';
    const F = {
      survey: () => numField('alt', t('ms.alt'), a.alt, 2, 500, 1, 'm') + camFields() + numField('angle', t('ms.angle'), a.angle, 0, 359, 1, '°') + numField('overshoot', t('ms.overshoot'), a.overshoot, 0, 200, 1, 'm') + check('follow', t('ms.follow'), a.follow),
      corridor: () => numField('alt', t('ms.alt'), a.alt, 2, 500, 1, 'm') + numField('width', t('ms.width'), a.width, 0, 1000, 1, 'm') + camFields() + check('follow', t('ms.follow'), a.follow),
      orbit: () => numField('alt', t('ms.alt'), a.alt, 2, 500, 1, 'm') + numField('radius', t('ms.radius'), a.radius, 5, 2000, 1, 'm') + numField('points', t('ms.points'), a.points, 3, 72, 1) + check('clockwise', t('ms.clockwise'), a.clockwise) + check('roi', t('ms.roiCenter'), a.roi),
      structure: () => numField('radius', t('ms.radius'), a.radius, 5, 2000, 1, 'm') + numField('bottom', t('ms.bottom'), a.bottom, 2, 500, 1, 'm') + numField('top', t('ms.top'), a.top, 2, 500, 1, 'm') + numField('layers', t('ms.layers'), a.layers, 1, 50, 1) + numField('points', t('ms.pointsLayer'), a.points, 3, 72, 1) + check('clockwise', t('ms.clockwise'), a.clockwise) + check('roi', t('ms.roiCenter'), a.roi),
      landing: () => numField('heading', t('ms.landHeading'), a.heading, 0, 359, 1, '°') + numField('distance', t('ms.landDistance'), a.distance, 50, 5000, 10, 'm') + numField('alt', t('ms.landAlt'), a.alt, 10, 500, 1, 'm') + numField('radius', t('ms.radius'), a.radius, 10, 1000, 5, 'm'),
    };
    function camFields() {
      return `<div class="field"><label>${esc(t('ms.spacingMode'))}</label><div class="seg sm" data-mode><button type="button" data-v="manual">${esc(t('ms.modeManual'))}</button><button type="button" data-v="camera">${esc(t('ms.modeCamera'))}</button></div></div>
        <div data-show="manual" class="op-form">${numField('spacing', t('ms.spacing'), a.spacing, 2, 500, 1, 'm')}${numField('trigger', t('ms.trigger'), a.trigger, 0, 500, 1, 'm')}</div>
        <div data-show="camera" class="op-form"><div class="field"><label>${esc(t('ms.camera'))}</label><select class="input" data-s="camera">${MISSION.CAMERAS.map((c) => `<option value="${c.id}" ${c.id === a.camera ? 'selected' : ''}>${esc(c.id === 'custom' ? t('ms.camCustom') : c.name)}</option>`).join('')}</select></div>
          <div data-show="custom" class="ms-row2">${numField('sensorW', t('ms.sensorW'), a.sensorW, 1, 60, 0.1, 'mm')}${numField('sensorH', t('ms.sensorH'), a.sensorH, 1, 60, 0.1, 'mm')}${numField('focal', t('ms.focal'), a.focal, 1, 300, 0.1, 'mm')}${numField('imageW', t('ms.imageW'), a.imageW, 320, 20000, 1, 'px')}</div>
          ${numField('side', t('ms.sideOverlap'), a.side, 0, 95, 1, '%')}${numField('front', t('ms.frontOverlap'), a.front, 0, 95, 1, '%')}</div>`;
    }
    const v = await openModal({
      title: `${t(`ms.tool.${kind}`)}${group ? ` — ${t('ms.editPattern')}` : ''}`, iconName: (TOOLS.find((x) => x[0] === kind) || [])[1] || 'grid', width: 500,
      body: `<div class="op-form">${F[kind]()}<div class="ms-calc" data-info></div></div>`,
      buttons: [{ label: t('common.giveUp'), value: null }, { label: t(group ? 'ms.regenerate' : 'ms.generate'), cls: 'primary', onClick: () => ({ ...a }) }],
      onMount: (m) => {
        enhanceNumbers(m);
        const read = () => { for (const i of m.querySelectorAll('[data-f]')) a[i.dataset.f] = i.type === 'checkbox' ? i.checked : Number(i.value); const c = m.querySelector('[data-s="camera"]'); if (c) a.camera = c.value; };
        const paint = () => {
          read();
          for (const b of m.querySelectorAll('[data-mode] button')) b.classList.toggle('on', b.dataset.v === a.mode);
          for (const x of m.querySelectorAll('[data-show]')) x.classList.toggle('hidden', x.dataset.show === 'custom' ? a.camera !== 'custom' : x.dataset.show !== a.mode);
          const info = m.querySelector('[data-info]');
          if (cam) {
            const e = effective(a);
            const n = kind === 'survey' ? MISSION.survey({ polygon: a.polygon, spacing: e.spacing, angle: a.angle, overshoot: a.overshoot }).length : MISSION.corridor({ line: a.line, width: a.width, spacing: e.spacing }).length;
            info.innerHTML = `${icon('info')}<span>${esc(t('ms.calc', { spacing: e.spacing.toFixed(1), trigger: e.trigger > 0 ? `${e.trigger.toFixed(1)} m` : t('hud.s.off'), n }))}${e.gsd ? ` · ${esc(t('ms.calcGsd', { gsd: e.gsd.toFixed(2), w: Math.round(e.footW), h: Math.round(e.footH) }))}` : ''}</span>`;
          } else if (kind === 'landing') { const lp = MISSION.landingPattern(a); info.innerHTML = `${icon('info')}<span>${esc(t('ms.calcGlide', { glide: lp.glide.toFixed(1) }))}</span>`; }
          else if (kind === 'structure') info.innerHTML = `${icon('info')}<span>${esc(t('ms.calcStructure', { n: Math.round(a.layers) * (Math.round(a.points) + 1), step: a.layers > 1 ? ((a.top - a.bottom) / (a.layers - 1)).toFixed(1) : '0' }))}</span>`;
          else info.innerHTML = '';
        };
        m.addEventListener('input', paint); m.addEventListener('change', paint);
        const seg = m.querySelector('[data-mode]');
        if (seg) seg.onclick = (e) => { const b = e.target.closest('button'); if (b) { a.mode = b.dataset.v; paint(); } };
        paint();
      },
    });
    if (!v) return;
    await applyPattern(kind, v, group);
    setTool('select');
  }
  // Desenin köşeleri / merkezi sürüklendiğinde yeniden üretilir
  let regenTimer = null;
  function regenerate(group) { clearTimeout(regenTimer); regenTimer = setTimeout(() => { const p = doc.patterns && doc.patterns[group]; if (p) applyPattern(p.kind, p.args, group); }, 30); }

  // ---- Arazi ----
  // Görev yolunun altındaki arazi (profil için). Sonuç yol değişene dek saklanır.
  let terrainKey = ''; let terrain = null;
  async function loadTerrain() {
    const pts = MISSION.path(doc);
    const key = pts.map((q) => `${q.lat},${q.lon}`).join(';');
    if (key === terrainKey) return;
    terrainKey = key; terrain = null;
    if (pts.length < 2) { paintProfile(); return; }
    const xs = [0];
    for (let i = 1; i < pts.length; i++) xs.push(xs[i - 1] + MISSION.distance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
    const total = xs[xs.length - 1];
    const N = 240; const samples = [];
    for (let k = 0; k <= N; k++) {
      const d = (total * k) / N;
      let i = 1; while (i < xs.length - 1 && xs[i] < d) i++;
      const f = xs[i] === xs[i - 1] ? 0 : (d - xs[i - 1]) / (xs[i] - xs[i - 1]);
      samples.push([pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * f, pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * f, d]);
    }
    const [el, at] = await Promise.all([Terrain.many(samples), Terrain.many(pts.map((q) => [q.lat, q.lon]))]);
    if (key !== terrainKey) return;
    terrain = el.some((v) => v === null) || at.some((v) => v === null) ? null : { samples: samples.map((q, i) => [q[2], el[i]]), at, total };
    paintProfile(); paintPanelWarnings();
  }
  // Yol noktalarının deniz seviyesine göre irtifası (arazi verisi varken)
  function amslPath(pts) {
    const h0 = doc.home && doc.home.alt ? doc.home.alt : terrain.at[0];
    return pts.map((q, i) => { const it = q.index >= 0 ? doc.items[q.index] : null; const f = it ? it.frame : 'rel'; return f === 'amsl' && it ? it.alt : f === 'terrain' ? terrain.at[i] + q.alt : h0 + q.alt; });
  }
  // Tüm gezinme noktalarını araziden `h` metre yukarıda olacak biçimde ayarlar (irtifalar kalkış noktasına göre kalır)
  async function terrainAdjust(h) {
    const list = doc.items.map((it, i) => [it, i]).filter(([it]) => hasPos(it) && ['waypoint', 'spline', 'loiterTime', 'loiterTurns', 'loiterUnlim'].includes(it.type));
    if (!list.length) return;
    const hq = doc.home ? [doc.home.lat, doc.home.lon] : [list[0][0].lat, list[0][0].lon];
    const [h0, ...el] = await Terrain.many([hq, ...list.map(([it]) => [it.lat, it.lon])]);
    if (h0 === null || el.some((v) => v === null)) { toast(t('ms.noTerrain'), { type: 'err', timeout: 6000 }); return; }
    change(() => { list.forEach(([it], k) => { it.alt = Math.round((el[k] + h - h0) * 10) / 10; it.frame = 'rel'; }); });
    toast(t('ms.terrainAdjusted', { n: list.length }), { type: 'ok' });
  }

  // ---- Çevrimdışı harita ----
  async function offlineDialog() {
    const r = $('#map').getBoundingClientRect();
    const nw = map.unproject(0, 0); const se = map.unproject(r.width, r.height);
    const bbox = { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng };
    const z0 = Math.max(2, Math.round(map.getZoom()));
    const fmtB = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
    let running = false;
    const off = window.api.onTilesProgress((p) => { const b = document.querySelector('[data-off-bar] i'); const l = document.querySelector('[data-off-prog]'); if (b) b.style.width = `${(p.done / p.total) * 100}%`; if (l) l.textContent = `${p.done} / ${p.total}${p.failed ? ` · ${t('ms.offFailed', { n: p.failed })}` : ''}`; });
    await openModal({
      title: t('ms.offline'), iconName: 'download', width: 520,
      body: `<div class="op-form"><div class="ms-note">${esc(t('ms.offNote'))}</div>
        <div class="ms-off-src">${[['sat', t('fl.sat')], ['street', t('fl.street')], ['dem', t('ms.offDem')]].map(([k, l]) => `<label class="ms-check"><input type="checkbox" data-src="${k}" ${k === style || k === 'dem' ? 'checked' : ''}><span>${esc(l)}</span><em data-count="${k}"></em></label>`).join('')}</div>
        ${numField('zmax', t('ms.offZoom', { z: z0 }), Math.min(19, z0 + 2), z0, 19, 1)}
        <div class="ms-calc" data-off-info></div>
        <div class="ms-off-bar" data-off-bar><i></i></div><div class="ms-note" data-off-prog></div>
        <div class="ms-note" data-off-stats></div></div>`,
      buttons: [{ label: t('ms.offClear'), left: true, cls: 'danger', onClick: async (m) => { await window.api.tilesClear(); stats(m); return false; } },
        { label: t('common.close'), value: null, onClick: () => { if (running) window.api.tilesCancel(); } },
        { label: t('ms.offStart'), cls: 'primary', onClick: async (m, btn) => {
          if (running) return false;
          const q = query(m);
          if (!q.sources.length) return false;
          running = true; btn.disabled = true;
          const res = await window.api.tilesDownload(q);
          running = false; btn.disabled = false;
          const l = m.querySelector('[data-off-prog]');
          if (res && res.ok) l.textContent = t('ms.offDone', { n: res.total - res.failed, failed: res.failed });
          else l.textContent = res && res.error === 'too_many' ? t('ms.offTooMany', { n: res.count, limit: res.limit }) : res && res.cancelled ? t('ms.offCancelled') : t('dr.failed');
          stats(m);
          return false;
        } }],
      onMount: (m) => { enhanceNumbers(m); const upd = () => planInfo(m); m.addEventListener('input', upd); m.addEventListener('change', upd); upd(); stats(m); },
    });
    off();
    function query(m) { return { sources: [...m.querySelectorAll('[data-src]:checked')].map((x) => x.dataset.src), bbox, zmin: z0, zmax: Number(m.querySelector('[data-f="zmax"]').value) || z0 }; }
    async function planInfo(m) {
      const q = query(m);
      const p = await window.api.tilesPlan({ ...q, sources: ['sat', 'street', 'dem'] });
      let over = '';
      for (const k of ['sat', 'street', 'dem']) { const c = m.querySelector(`[data-count="${k}"]`); if (c && p[k]) { c.textContent = t('ms.offTiles', { n: p[k].count }); c.classList.toggle('bad', !p[k].allowed); if (!p[k].allowed && q.sources.includes(k)) over = t('ms.offLimit', { limit: p[k].limit }); } }
      m.querySelector('[data-off-info]').innerHTML = over ? `${icon('alert')}<span>${esc(over)}</span>` : '';
    }
    async function stats(m) { const st = await window.api.tilesStats(); const x = m.querySelector('[data-off-stats]'); if (x) x.textContent = t('ms.offStats', { n: st.files, size: fmtB(st.bytes) }); }
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
    html += `<div class="ms-edit-foot"><button class="btn sm" data-act="up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button><button class="btn sm" data-act="down" ${i === doc.items.length - 1 ? 'disabled' : ''}>${icon('chevronDown')}</button><button class="btn sm" data-act="dup">${icon('copy')}${esc(t('app.duplicate'))}</button><span style="flex:1"></span>${it.group && doc.patterns && doc.patterns[it.group] ? `<button class="btn sm" data-act="editGroup">${icon('gear')}${esc(t('ms.editPattern'))}</button>` : ''}${it.group ? `<button class="btn sm danger" data-act="delGroup">${icon('trash')}${esc(t('ms.delGroup'))}</button>` : ''}<button class="btn sm danger" data-act="del">${icon('trash')}${esc(t('common.delete'))}</button></div></div>`;
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
          <div class="field"><label>${esc(t('ms.terrainAdjust'))}</label><div class="ms-opt"><div class="unit-wrap" style="flex:1"><input class="input" type="number" id="terrH" min="5" max="500" step="1" value="${doc.defaults.alt}"><span class="unit">m</span></div><button class="btn sm" data-act="terrain">${icon('altitude')}${esc(t('ms.terrainApply'))}</button></div></div>
          ${h0 ? numField('homeAlt', t('ms.homeAlt'), h0.alt, 0, 5000, 1, 'm').replace('data-f=', 'data-d=') : ''}
        </div></details>
        <div id="terrWarn"></div>
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
    paintPanelWarnings();
  }

  // Araziye yakın geçen yol için uyarı (arazi verisi varken)
  function paintPanelWarnings() {
    const box = $('#terrWarn');
    if (!box) return;
    const c = clearance();
    box.innerHTML = c !== null && c < 10 ? `<div class="ms-warn ${c < 0 ? 'bad' : ''}">${icon('alert')}<span>${esc(t(c < 0 ? 'ms.warn.terrainHit' : 'ms.warn.terrainLow', { m: Math.round(c) }))}</span></div>` : '';
  }
  // Yolun araziye en yakın olduğu yerdeki açıklık (m); kalkış ve iniş uçları dışında. Veri yoksa null.
  function clearance() {
    if (!terrain) return null;
    const pts = MISSION.path(doc);
    if (pts.length !== terrain.at.length || pts.length < 2) return null;
    const am = amslPath(pts);
    const xs = [0];
    for (let i = 1; i < pts.length; i++) xs.push(xs[i - 1] + MISSION.distance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
    let min = Infinity;
    for (const [d, e] of terrain.samples) {
      let i = 1; while (i < xs.length - 1 && xs[i] < d) i++;
      if (pts[i - 1].alt < 3 || pts[i].alt < 3) continue; // yerdeki uçlar (ev, iniş)
      const f = xs[i] === xs[i - 1] ? 0 : (d - xs[i - 1]) / (xs[i] - xs[i - 1]);
      min = Math.min(min, am[i - 1] + (am[i] - am[i - 1]) * f - e);
    }
    return Number.isFinite(min) ? min : null;
  }

  $('#tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; paintPanel(); } };
  const body = $('#panelBody');
  body.addEventListener('toggle', (e) => { const d = e.target.closest('[data-sec="defaults"]'); if (d) { settings.msDefaultsOpen = d.open; window.api.setSettings({ msDefaultsOpen: d.open }); } }, true);
  body.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'homePick') setTool('home');
      else if (a === 'terrain') terrainAdjust(Number($('#terrH').value) || doc.defaults.alt);
      else if (a === 'homeDel') change(() => { doc.home = null; });
      else if (sel >= 0) {
        const i = sel;
        if (a === 'del') change(() => { doc.items.splice(i, 1); sel = Math.min(i, doc.items.length - 1); });
        else if (a === 'editGroup') { const g = doc.items[i].group; const p = doc.patterns[g]; if (p) patternDialog(p.kind, p.args, g); }
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
    if (x.id === 'terrH') return;
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

  // Yükseklik profili: yol boyunca mesafeye karşı irtifa; arazi verisi varsa altına arazi çizilir (deniz seviyesine göre)
  function paintProfile() {
    loadTerrain();
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
    const tr = terrain && terrain.at.length === pts.length ? terrain : null;
    const alts = tr ? amslPath(pts) : pts.map((q) => q.alt);
    const lo = tr ? Math.min(...tr.samples.map((q) => q[1]), ...alts) : 0;
    const hi = Math.max(lo + 10, ...alts, ...(tr ? tr.samples.map((q) => q[1]) : []));
    const pad = (hi - lo) * 0.12;
    const y0 = tr ? lo - pad : 0; const y1 = hi + pad;
    const L = 44; const R = 10; const T = 8; const B = 18;
    const X = (d) => L + (d / total) * (w - L - R); const Y = (a) => h - B - ((a - y0) / (y1 - y0)) * (h - T - B);
    g.strokeStyle = css.getPropertyValue('--border'); g.fillStyle = css.getPropertyValue('--text-3'); g.lineWidth = 1; g.font = '10.5px sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let k = 0; k <= 3; k++) { const a = y0 + ((y1 - y0) / 3) * k; g.beginPath(); g.moveTo(L, Y(a)); g.lineTo(w - R, Y(a)); g.stroke(); g.fillText(`${Math.round(a)}`, L - 5, Y(a)); }
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let k = 0; k <= 4; k++) g.fillText(fmtDist((total / 4) * k), X((total / 4) * k), h - B + 4);
    if (tr) {
      g.beginPath(); tr.samples.forEach((q, i) => (i ? g.lineTo(X(q[0]), Y(q[1])) : g.moveTo(X(q[0]), Y(q[1]))));
      g.lineTo(X(total), Y(y0)); g.lineTo(X(0), Y(y0)); g.closePath();
      g.fillStyle = 'rgba(52, 211, 153, .28)'; g.fill(); g.strokeStyle = '#34d399'; g.lineWidth = 1.4; g.stroke();
    }
    g.beginPath(); pts.forEach((q, i) => (i ? g.lineTo(X(xs[i]), Y(alts[i])) : g.moveTo(X(xs[i]), Y(alts[i]))));
    g.strokeStyle = '#fbbf24'; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    if (!tr) { g.lineTo(X(total), Y(0)); g.lineTo(X(0), Y(0)); g.closePath(); g.globalAlpha = 0.14; g.fillStyle = '#fbbf24'; g.fill(); g.globalAlpha = 1; }
    if (pts.length <= 400) pts.forEach((q, i) => { g.beginPath(); g.arc(X(xs[i]), Y(alts[i]), q.index === sel ? 5 : 3, 0, Math.PI * 2); g.fillStyle = q.index === sel ? '#22d3ee' : q.index === -1 ? '#34d399' : '#fbbf24'; g.fill(); });
    const cl = clearance();
    $('#profileInfo').textContent = `${fmtDist(total)} · ${t('ms.st.maxAlt')} ${Math.round(Math.max(...pts.map((q) => q.alt)))} m${tr ? ` · ${t('ms.terrainRange', { lo: Math.round(Math.min(...tr.samples.map((q) => q[1]))), hi: Math.round(Math.max(...tr.samples.map((q) => q[1]))) })}${cl !== null ? ` · ${t('ms.clearance', { m: Math.round(cl) })}` : ''}` : ` · ${t('ms.noTerrainShort')}`}`;
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
