'use strict';

// Uçuş penceresi: 3B harita (dronun konumu, izi, ev noktası), kamera görüntüsü (viewer.js gömülü), yerleşimler
// (harita + küçük kamera, kamera + küçük harita, yan yana, yalnız harita, yalnız kamera) ve HUD.
// Kamera tarafının bütün özellikleri (akış ayarları, kamera kontrol, yapay görü) sağdaki panelde açılır.

(() => {
  const Q = new URLSearchParams(location.search);
  const FLIGHT_ID = Q.get('id');
  const HAS_CAM = !!Q.get('cam');
  const el = (s) => document.querySelector(s);
  const TILES = {
    sat: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], attribution: 'Esri, Maxar, Earthstar Geographics', maxzoom: 19 },
    street: { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], attribution: '© OpenStreetMap', maxzoom: 19 },
  };

  let flight = null;
  let drone = null;
  let st = { connected: false, linked: false, telemetry: {} };
  let prefs = { layout: 'mapPip', hud: true, follow: true, style: 'sat', tilt: true, flat: false };
  let flatMode = false;      // sade 2B harita kullanılıyor (seçildi ya da 3B açılamadı)
  let map = null;
  let mapReady = false;
  let marker = null;
  let hud = null;
  const track = [];          // [lon, lat, alt]
  let shown = null;          // haritada gösterilen (yumuşatılmış) konum
  let lastTrackPaint = 0;

  // --- Üst çubuk ---
  el('#flIcon').innerHTML = icon('globe');
  el('#btnHud').innerHTML = icon('gauge');
  el('#btnHud').title = t('fl.hud');
  el('#btnSwap').innerHTML = icon('swap');
  el('#btnSwap').title = t('fl.swap');
  el('#btnPanel').innerHTML = icon('gear');
  el('#btnPanel').title = t('fl.camPanel');
  if (!HAS_CAM) for (const id of ['#camTools', '#panel', '#splitPanel', '#bottom', '#splitBottom']) el(id).classList.add('hidden');

  const LAYOUT_ICONS = { mapPip: 'globe', videoPip: 'video', split: 'columns', map: 'image', video: 'monitor' };
  function paintLayouts() {
    const list = HAS_CAM ? DRONE.LAYOUTS : ['map'];
    el('#layouts').innerHTML = list.map((l) => `<button type="button" data-l="${l}" class="${prefs.layout === l ? 'on' : ''}" title="${esc(t(`fl.l.${l}`))}">${icon(LAYOUT_ICONS[l])}</button>`).join('');
    el('#layouts').classList.toggle('hidden', list.length < 2);
  }
  function setLayoutMode(l, save = true) {
    prefs.layout = HAS_CAM ? l : 'map';
    el('#stage').dataset.layout = prefs.layout;
    el('#btnSwap').classList.toggle('hidden', !['mapPip', 'videoPip'].includes(prefs.layout));
    paintLayouts();
    if (save) window.api.saveFlight({ id: FLIGHT_ID, layout: prefs.layout });
    requestAnimationFrame(() => { if (map) map.resize(); if (typeof player !== 'undefined') player.draw(); });
    setTimeout(() => { if (map) map.resize(); if (typeof player !== 'undefined') player.draw(); }, 260);
  }
  el('#layouts').onclick = (e) => { const b = e.target.closest('button'); if (b) setLayoutMode(b.dataset.l); };
  el('#btnSwap').onclick = () => setLayoutMode(prefs.layout === 'mapPip' ? 'videoPip' : 'mapPip');
  // Küçük pencereye tıklamak büyüğüyle yer değiştirir
  el('#video').addEventListener('click', () => { if (prefs.layout === 'mapPip') setLayoutMode('videoPip'); });
  el('#mapPane').addEventListener('click', (e) => { if (prefs.layout === 'videoPip' && !e.target.closest('.fl-map-tools')) setLayoutMode('mapPip'); }, true);
  el('#btnHud').onclick = () => { prefs.hud = !prefs.hud; window.api.setSettings({ flightHud: prefs.hud }); paintTools(); };

  // Tam ekran: sahnenin tamamı (HUD ile birlikte); kamera düğmesi kamerayı, harita düğmesi haritayı öne alır
  let beforeFull = null;
  function fullscreen(l) {
    if (document.fullscreenElement) return document.exitFullscreen();
    beforeFull = prefs.layout;
    setLayoutMode(l, false);
    return el('#wrap').requestFullscreen().catch(() => {});
  }
  window.VW_FULLSCREEN = () => fullscreen('video');
  document.addEventListener('fullscreenchange', () => {
    // Bildirimler tam ekrandaki öğenin içinde olmalı, yoksa görünmez
    (document.fullscreenElement || document.body).appendChild(toastHost());
    if (!document.fullscreenElement && beforeFull) { setLayoutMode(beforeFull, false); beforeFull = null; } if (map) setTimeout(() => map.resize(), 80); });

  // --- Harita ---
  function paintTools() {
    el('#btnHud').classList.toggle('active', prefs.hud);
    if (hud) hud.visible = prefs.hud;
    const b = (id, ic, title, on) => `<button class="icon-btn ${on ? 'active' : ''}" data-t="${id}" title="${esc(title)}">${icon(ic)}</button>`;
    el('#mapTools').innerHTML = b('follow', 'crosshair', t('fl.follow'), prefs.follow) + b('style', 'layers', t(prefs.style === 'sat' ? 'fl.street' : 'fl.sat'), false)
      + (flatMode ? '' : b('tilt', 'chart', t('fl.tilt'), prefs.tilt)) + b('flat', 'image', t(flatMode ? 'fl.use3d' : 'fl.use2d'), flatMode) + b('home', 'home', t('fl.goHome'), false) + b('clear', 'broom', t('fl.clearTrack'), false) + b('zin', 'plus', '+', false) + b('zout', 'minus', '−', false) + b('full', 'expand', t('fl.mapFull'), false);
  }
  el('#mapTools').onclick = (e) => {
    const b = e.target.closest('[data-t]');
    if (!b || !map) return;
    const a = b.dataset.t;
    if (a === 'follow') { prefs.follow = !prefs.follow; if (prefs.follow && shown) map.easeTo({ center: [shown[0], shown[1]], duration: 400 }); }
    else if (a === 'style') { prefs.style = prefs.style === 'sat' ? 'street' : 'sat'; applyStyle(); }
    else if (a === 'tilt') { prefs.tilt = !prefs.tilt; applyTilt(); }
    else if (a === 'flat') { prefs.flat = !flatMode; window.api.setSettings({ flightFlat: prefs.flat }); initMap(); return; }
    else if (a === 'home') { const x = st.telemetry || {}; if (x.homeLat || x.homeLon) map.easeTo({ center: [x.homeLon, x.homeLat], duration: 600 }); }
    else if (a === 'clear') { track.length = 0; paintTrack(true); }
    else if (a === 'zin') map.zoomIn();
    else if (a === 'zout') map.zoomOut();
    else if (a === 'full') fullscreen('map');
    window.api.setSettings({ flightFollow: prefs.follow, flightStyle: prefs.style, flightTilt: prefs.tilt });
    paintTools();
  };

  function applyStyle() {
    if (!mapReady) return;
    map.setLayoutProperty('sat', 'visibility', prefs.style === 'sat' ? 'visible' : 'none');
    map.setLayoutProperty('street', 'visibility', prefs.style === 'street' ? 'visible' : 'none');
  }
  // 3B görünüm = eğik bakış (iz ve dron yükseklikleriyle). Arazi yükseklik verisi kullanılmaz: yüksek rakımlı yerlerde
  // kamera zeminin altında kalıp haritayı boş gösteriyordu.
  function applyTilt() {
    if (!mapReady || flatMode) return;
    map.easeTo({ pitch: prefs.tilt ? 60 : 0, duration: 500 });
  }

  function note(text) { el('#mapNote').textContent = text || ''; el('#mapNote').classList.toggle('hidden', !text); }

  // 3B harita (MapLibre, WebGL) açılamazsa sade 2B haritaya düşülür; kullanıcı araç çubuğundan da 2B'yi seçebilir.
  function initMap() {
    if (map) { try { if (marker) marker.remove(); map.remove(); } catch { /* yok */ } }
    map = null; mapReady = false; marker = null; shown = null;
    note('');
    const center = (() => { const x = st.telemetry || {}; return Number.isFinite(x.lat) && (x.lat || x.lon) ? [x.lon, x.lat] : [32.8663, 39.9255]; })();
    flatMode = !!prefs.flat;
    if (!flatMode) {
      try {
        if (!window.maplibregl) throw new Error('maplibre');
        maplibregl.setWorkerUrl('../vendor/maplibre/maplibre-gl-csp-worker.js');
        const raster = (s) => ({ type: 'raster', tiles: s.tiles, tileSize: 256, maxzoom: s.maxzoom, attribution: s.attribution });
        map = new maplibregl.Map({
          container: 'map', attributionControl: { compact: true }, maxPitch: 80,
          center, zoom: 4, pitch: prefs.tilt ? 60 : 0,
          style: {
            version: 8,
            sources: { sat: raster(TILES.sat), street: raster(TILES.street) },
            layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1220' } },
              { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: prefs.style === 'sat' ? 'visible' : 'none' } },
              { id: 'street', type: 'raster', source: 'street', layout: { visibility: prefs.style === 'street' ? 'visible' : 'none' } }],
            sky: { 'sky-color': '#7fb4e6', 'horizon-color': '#cfe4f5', 'fog-color': '#cfe4f5', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.2 },
          },
        });
        // Ekran kartı bağlamı yitirilirse 2B haritaya geçilir
        map.getCanvas().addEventListener('webglcontextlost', () => { if (!flatMode) { prefs.flat = true; initMap(); toast(t('fl.fallback2d'), { timeout: 6000 }); } });
      } catch (e) {
        console.warn('3B harita açılamadı, 2B haritaya geçiliyor:', e && e.message);
        try { if (map) map.remove(); } catch { /* yok */ }
        map = null; flatMode = true;
        el('#map').innerHTML = '';
        toast(t('fl.fallback2d'), { timeout: 6000 });
      }
    }
    if (flatMode) map = new FlatMap({ container: 'map', center, zoom: 4, sources: { sat: TILES.sat, street: TILES.street }, visible: prefs.style });
    paintTools();
    let tileErrors = 0;
    map.on('error', () => { if (++tileErrors === 6) note(t('fl.mapOffline')); });
    map.on('click', (e) => { if (picking) { setPicking(false); goTo(e.lngLat.lat, e.lngLat.lng, false); } });
    map.on('contextmenu', (e) => { if (prefs.layout !== 'videoPip') goTo(e.lngLat.lat, e.lngLat.lng, true); });
    map.on('dragstart', () => { if (prefs.follow) { prefs.follow = false; paintTools(); } });
    // Katmanlar stil yüklenince eklenir (karolar inmese de dron ve izi çizilsin)
    map.once('style.load', () => {
      mapReady = true;
      const empty = { type: 'FeatureCollection', features: [] };
      map.addSource('track', { type: 'geojson', data: empty });
      map.addSource('curtain', { type: 'geojson', data: empty });
      map.addSource('craft', { type: 'geojson', data: empty });
      map.addSource('home', { type: 'geojson', data: empty });
      map.addLayer({ id: 'track', type: 'line', source: 'track', paint: { 'line-color': '#fbbf24', 'line-width': 2.2, 'line-opacity': 0.85 } });
      // İzin 3B "perdesi": her parça uçulan yüksekliğe kadar yükselir
      map.addLayer({ id: 'curtain', type: 'fill-extrusion', source: 'curtain', paint: { 'fill-extrusion-color': '#22d3ee', 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.42 } });
      map.addLayer({ id: 'craft', type: 'fill-extrusion', source: 'craft', paint: { 'fill-extrusion-color': '#f43f5e', 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-opacity': 0.95 } });
      map.addSource('target', { type: 'geojson', data: empty });
      map.addLayer({ id: 'targetLine', type: 'line', source: 'target', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#a78bfa', 'line-width': 2, 'line-dasharray': [2, 2] } });
      map.addLayer({ id: 'target', type: 'circle', source: 'target', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 8, 'circle-color': '#a78bfa', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: 'home', type: 'circle', source: 'home', paint: { 'circle-radius': 7, 'circle-color': '#34d399', 'circle-stroke-color': '#06121c', 'circle-stroke-width': 2 } });
      const m = document.createElement('div');
      m.className = 'fl-marker';
      m.innerHTML = '<svg viewBox="0 0 48 48"><path d="M24 4 L34 40 L24 33 L14 40 Z" fill="#f43f5e" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/></svg>';
      marker = flatMode ? new FlatMarker({ element: m }) : new maplibregl.Marker({ element: m, rotationAlignment: 'map', pitchAlignment: 'map' });
      paintTarget();
      paintTrack(true);
    });
  }

  // Metre → derece (yaklaşık; küçük nesneler için yeterli)
  const mLat = (m) => m / 111320;
  const mLon = (m, lat) => m / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
  const square = (lon, lat, half) => [[[lon - mLon(half, lat), lat - mLat(half)], [lon + mLon(half, lat), lat - mLat(half)], [lon + mLon(half, lat), lat + mLat(half)], [lon - mLon(half, lat), lat + mLat(half)], [lon - mLon(half, lat), lat - mLat(half)]]];

  function paintTrack(force) {
    if (!mapReady) return;
    const now = Date.now();
    if (!force && now - lastTrackPaint < 500) return;
    lastTrackPaint = now;
    map.getSource('track').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: track.map((p) => [p[0], p[1]]) } });
    const feats = [];
    const from = Math.max(1, track.length - 1500);
    for (let i = from; i < track.length; i++) {
      const a = track[i - 1]; const b = track[i];
      const dx = b[0] - a[0]; const dy = b[1] - a[1]; const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * mLon(0.6, b[1]); const ny = (dx / len) * mLat(0.6);
      feats.push({ type: 'Feature', properties: { h: Math.max(0.5, (a[2] + b[2]) / 2) }, geometry: { type: 'Polygon', coordinates: [[[a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny], [a[0] - nx, a[1] - ny]]] } });
    }
    map.getSource('curtain').setData({ type: 'FeatureCollection', features: feats });
  }

  // Dronun haritadaki konumu kareler arasında yumuşatılır
  function animate() {
    requestAnimationFrame(animate);
    const x = st.telemetry || {};
    if (!mapReady || !st.linked || !Number.isFinite(x.lat) || !Number.isFinite(x.lon) || (!x.lat && !x.lon)) return;
    const target = [x.lon, x.lat, Number.isFinite(x.altRel) ? x.altRel : 0];
    if (!shown) { shown = target.slice(); marker.setLngLat([shown[0], shown[1]]).addTo(map); map.jumpTo({ center: [shown[0], shown[1]], zoom: 16.5 }); }
    for (let i = 0; i < 3; i++) shown[i] += (target[i] - shown[i]) * 0.18;
    marker.setLngLat([shown[0], shown[1]]);
    // İzleme: kamera her karede yumuşatılmış konuma alınır. (Sürekli easeTo kullanılmaz: MapLibre geçiş sürerken arazi
    // yüksekliğini dondurur; yüksek rakımda kamera zeminin altında kalıp harita boş görünürdü.)
    if (prefs.follow && !map.isEasing() && !map.dragPan.isActive()) {
      const c = map.getCenter();
      if (Math.abs(c.lng - shown[0]) > 1e-7 || Math.abs(c.lat - shown[1]) > 1e-7) map.jumpTo({ center: [shown[0], shown[1]] });
    }
    marker.setRotation(Number.isFinite(x.heading) ? x.heading : 0);
    const alt = Math.max(0, shown[2]);
    map.getSource('craft').setData({ type: 'Feature', properties: { base: Math.max(0, alt - 1.2), top: alt + 1.2 }, geometry: { type: 'Polygon', coordinates: square(shown[0], shown[1], 2.2) } });
  }

  function onTelemetry() {
    const x = st.telemetry || {};
    if (!st.linked || !Number.isFinite(x.lat) || !Number.isFinite(x.lon) || (!x.lat && !x.lon)) return;
    const last = track[track.length - 1];
    const alt = Number.isFinite(x.altRel) ? x.altRel : 0;
    if (!last || FlightHud.distance(last[1], last[0], x.lat, x.lon) > 0.7 || Math.abs(last[2] - alt) > 0.7) {
      track.push([x.lon, x.lat, alt]);
      if (track.length > 20000) track.splice(0, track.length - 20000);
      paintTrack(false);
    }
    paintTarget();
    if (mapReady && (x.homeLat || x.homeLon)) map.getSource('home').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [x.homeLon, x.homeLat] } });
  }

  // --- Dron durumu ---
  function paintDrone() {
    el('#flName').textContent = flight.name;
    el('#flSub').textContent = drone ? `${drone.name} · ${st.link || DRONE.display(drone)}` : t('fl.droneGone');
    document.title = `${flight.name} — Video Master`;
    const chip = el('#drState');
    chip.className = `state-chip s-${st.linked ? 'playing' : st.connected ? 'connecting' : st.error ? 'error' : 'idle'}`;
    chip.innerHTML = `${st.connected && !st.linked ? '<span class="spin"></span>' : '<i></i>'}${esc(st.linked ? t('dr.st.linked') : st.connected ? t('dr.st.waiting') : st.error ? tOpt(`dr.err.${st.error}`, t('dr.st.error')) : t('dr.st.off'))}`;
    const x = st.telemetry || {};
    el('#drChips').innerHTML = st.linked ? `<span class="tag">${esc(st.mode || '')}</span>${st.armed ? `<span class="tag err">${esc(t('dr.armed'))}</span>` : ''}${x.voltage ? `<span class="tag">${fmtNum(x.voltage, 1)} V</span>` : ''}` : '';
  }
  function applyState(next) {
    if (!next) return;
    st = { telemetry: {}, ...next };
    paintDrone();
    if (hud) hud.update(st.telemetry, st);
    paintOps();
    onTelemetry();
  }
  window.api.onDroneState((m) => { if (drone && m.id === drone.id) applyState(m.state); });
  window.api.onDroneStatustext((m) => { if (drone && m.id === drone.id && m.severity <= 4) toast(m.text, { type: m.severity <= 3 ? 'err' : '', timeout: 5000 }); });
  window.api.onFlightChanged((f) => { if (f.id === FLIGHT_ID) { flight = f; paintDrone(); } });
  el('#drState').onclick = async () => { if (!drone) return; if (st.connected) await window.api.droneDisconnect(drone.id); else applyState(await window.api.droneConnect(drone.id)); };
  el('#drState').title = t('fl.toggleLink');

  // --- Temel uçuş işlemleri çubuğu ---
  // Kur/kapat, kalkış, iniş, eve dön, bekle, uçuş kipi, noktaya git, irtifa, acil durdur. Komutlar ana süreçteki araca gider.
  let picking = false;
  let target = null;      // { lat, lon, alt }
  let busy = null;        // süren işlemin adı (düğmeler o sırada kilitlenir)
  let opsKey = '';
  let modesKey = '';
  const hasPos = () => { const x = st.telemetry || {}; return Number.isFinite(x.lat) && Number.isFinite(x.lon) && !!(x.lat || x.lon); };
  const call = (method, ...args) => window.api.droneCall(drone.id, method, ...args);
  // Tam ekranda pencereler tam ekrandaki öğenin içine alınır
  function inStage(promise) { const b = [...document.querySelectorAll('.modal-backdrop')].pop(); if (b && document.fullscreenElement) document.fullscreenElement.appendChild(b); return promise; }
  function opReport(r, what) {
    if (r && r.ok) { toast(what, { type: 'ok', timeout: 2400 }); return true; }
    const why = r && r.error ? tOpt(`dr.err.${r.error}`, r.resultName || r.error) : '';
    toast(r && r.step ? tOpt(`fl.op.step.${r.step}`, t('dr.failed')) : t('dr.failed'), { type: 'err', sub: `${what}${why ? ` — ${why}` : ''}`, timeout: 6000 });
    return false;
  }
  async function run(name, what, fn) {
    if (busy || !drone) return null;
    busy = name; paintOps();
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, error: 'error', resultName: String((e && e.message) || e) }; }
    busy = null; paintOps();
    opReport(r, what);
    return r;
  }

  function caps() {
    const fw = st.firmware; const v = st.vehicle;
    const mav = fw === 'ardupilot' || fw === 'px4';
    return {
      mav,
      takeoff: mav && (fw === 'px4' ? v !== 'rover' && v !== 'sub' : ['copter', 'heli', 'vtol', 'plane'].includes(v)),
      land: mav && v !== 'rover' && !(fw === 'ardupilot' && v === 'other'),
      alt: mav && v !== 'rover',
    };
  }

  function buildOps() {
    const b = (id, ic, label, cls = '') => `<button class="btn ${cls}" data-op="${id}" title="${esc(tOpt(`fl.op.tip.${id}`, label))}">${icon(ic)}<span>${esc(label)}</span></button>`;
    el('#ops').innerHTML = `${b('arm', 'power', t('dr.arm'))}${b('takeoff', 'takeoff', t('fl.op.takeoff'), 'go')}${b('land', 'land', t('fl.op.land'))}${b('rtl', 'home', t('fl.op.rtl'))}${b('hold', 'pause', t('fl.op.hold'))}
      <span class="sep"></span><select class="input" id="opMode" title="${esc(t('fl.op.mode'))}"></select>
      <span class="sep"></span>${b('goto', 'pin', t('fl.op.goto'))}${b('alt', 'altitude', t('fl.op.alt'))}
      <span class="op-target hidden" id="opTarget"><span></span><button type="button" data-op="clearTarget" title="${esc(t('fl.op.clearTarget'))}">${icon('x')}</button></span>
      <span class="op-note hidden" id="opNote"></span><span class="sep"></span>${b('kill', 'alert', t('fl.op.kill'), 'kill')}`;
    el('#pickHint').textContent = t('fl.op.pickHint');
  }

  // Telemetri kutuları: kip + motor durumu, irtifa, hız, tırmanma, yön, eve uzaklık, batarya, GPS, uçuş süresi
  let armedAt = 0;
  let flownMs = 0;
  function buildTm() {
    const box = (id, label, unit = '', extra = '') => `<div class="tm" data-tm="${id}"><label>${esc(label)}</label><div><b>—</b>${unit ? `<small>${esc(unit)}</small>` : '<small></small>'}</div>${extra}</div>`;
    el('#tm').innerHTML = `<div class="tm-mode off" id="tmMode"><b>—</b><span><i></i><em style="font-style:normal"></em></span></div>
      ${box('alt', t('tm.altRel'), 'm')}${box('spd', t('fl.tm.speed'), 'm/s')}${box('climb', t('tm.climb'), 'm/s')}${box('hdg', t('tm.heading'), '°')}${box('home', t('fl.tm.home'), 'm')}
      ${box('batt', t('fl.tm.batt'), 'V', '<span class="bar"><i></i></span>')}${box('gps', 'GPS')}${box('time', t('fl.tm.time'))}
      <button type="button" class="tm-fold" id="tmFold" title="${esc(t('fl.tm.fold'))}">${icon('chevronDown')}</button>`;
    el('#tmFold').onclick = () => { const f = !el('#stage').classList.contains('ops-folded'); el('#stage').classList.toggle('ops-folded', f); window.api.setSettings({ flightOpsFolded: f }); };
    const ro = new ResizeObserver(() => { const stg = el('#stage').style; stg.setProperty('--deck-h', `${el('#deck').offsetHeight}px`); stg.setProperty('--dock-h', `${el('#dock').offsetHeight}px`); });
    ro.observe(el('#deck')); ro.observe(el('#dock'));
    setInterval(paintTm, 1000);
  }
  function paintTm() {
    if (!el('#tm').firstChild) return;
    const x = st.telemetry || {};
    const live = !!st.linked;
    const set = (id, value, cls = '', unit) => {
      const b = el(`#tm [data-tm="${id}"]`);
      b.className = `tm ${cls}`;
      b.querySelector('b').textContent = value;
      if (unit !== undefined) b.querySelector('small').textContent = unit;
      return b;
    };
    const n = (v, d = 1) => (live && Number.isFinite(v) ? v.toFixed(d) : '—');
    const mode = el('#tmMode');
    mode.className = `tm-mode ${!live ? 'off' : st.armed ? 'armed' : ''}`;
    mode.querySelector('b').textContent = live ? (st.mode || '—') : t('dr.st.off');
    mode.querySelector('em').textContent = live ? t(st.armed ? 'dr.armed' : 'dr.disarmed') : (drone ? drone.name : '');
    set('alt', n(x.altRel));
    set('spd', n(x.groundspeed));
    set('climb', live && Number.isFinite(x.climb) ? `${x.climb > 0.05 ? '+' : ''}${x.climb.toFixed(1)}` : '—');
    set('hdg', live && Number.isFinite(x.heading) ? String(Math.round(x.heading)).padStart(3, '0') : '—');
    const d = live && (x.homeLat || x.homeLon) && hasPos() ? FlightHud.distance(x.lat, x.lon, x.homeLat, x.homeLon) : NaN;
    set('home', Number.isFinite(d) ? (d >= 1000 ? (d / 1000).toFixed(2) : String(Math.round(d))) : '—', '', Number.isFinite(d) && d >= 1000 ? 'km' : 'm');
    const pct = live && Number.isFinite(x.batteryPct) && x.batteryPct >= 0 ? x.batteryPct : NaN;
    const batt = set('batt', live && x.voltage ? x.voltage.toFixed(1) : '—', pct < 20 ? 'bad' : pct < 35 ? 'warn' : '', Number.isFinite(pct) ? `V · ${Math.round(pct)}%` : 'V');
    batt.querySelector('.bar i').style.width = `${Number.isFinite(pct) ? Math.min(100, pct) : 0}%`;
    const fix = Number(x.gpsFix) || 0;
    set('gps', live && Number.isFinite(x.sats) ? String(x.sats) : '—', !live ? '' : fix >= 3 ? 'good' : fix >= 2 ? 'warn' : 'bad', live ? (fix >= 3 ? '3D' : fix === 2 ? '2D' : t('fl.tm.noFix')) : '');
    // Uçuş süresi: motorların etkin kaldığı toplam süre
    if (live && st.armed && !armedAt) armedAt = Date.now();
    if ((!live || !st.armed) && armedAt) { flownMs += Date.now() - armedAt; armedAt = 0; }
    const sec = Math.floor((flownMs + (armedAt ? Date.now() - armedAt : 0)) / 1000);
    set('time', `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`);
  }

  function paintOps() {
    const ops = el('#ops');
    if (!ops.firstChild) { buildOps(); buildTm(); }
    paintTm();
    const c = caps();
    const on = !!drone && st.linked && c.mav;
    const key = [on, st.firmware, st.vehicle, st.armed, busy, picking, !!drone, st.linked].join('|');
    if (key !== opsKey) {
      opsKey = key;
      const q = (id) => ops.querySelector(`[data-op="${id}"]`);
      const set = (id, show, enabled) => { const x = q(id); x.classList.toggle('hidden', !show); x.disabled = !enabled || !!busy; };
      const arm = q('arm');
      arm.classList.toggle('armed', !!st.armed);
      arm.querySelector('span').textContent = st.armed ? t('dr.disarm') : t('dr.arm');
      const bf = st.firmware === 'betaflight';
      set('arm', !bf, on);
      set('takeoff', !bf && (c.takeoff || !st.linked), on && c.takeoff);
      set('land', !bf && (c.land || !st.linked), on && c.land);
      set('rtl', !bf, on);
      set('hold', !bf, on);
      set('goto', !bf, on);
      set('alt', !bf && (c.alt || !st.linked), on && c.alt);
      set('kill', !bf, on && !!st.armed);
      q('goto').classList.toggle('on', picking);
      for (const x of ops.querySelectorAll('.sep')) x.classList.toggle('hidden', bf);
      const note = el('#opNote');
      note.textContent = bf && st.linked ? t('fl.op.bfNote') : !st.linked ? t('fl.op.offNote') : '';
      note.classList.toggle('hidden', !note.textContent);
      el('#opMode').classList.toggle('hidden', bf);
      el('#opMode').disabled = !on || !!busy;
    }
    // Kip listesi: araç türü değişince yeniden kurulur; açıkken dokunulmaz
    const sel = el('#opMode');
    const modes = st.linked && Array.isArray(st.modes) ? st.modes : [];
    const mk = modes.map((m) => m.name).join(',');
    if (mk !== modesKey) { modesKey = mk; sel.innerHTML = `<option value="" disabled>${esc(t('fl.op.mode'))}</option>${modes.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('')}`; }
    if (document.activeElement !== sel) { const cur = modes.some((m) => m.name === st.mode) ? st.mode : ''; if (sel.value !== cur) sel.value = cur; }
  }

  function numberForm({ title, iconName, label, note, value, min, max, okText, okCls }) {
    return inStage(openModal({
      title, iconName, width: 440,
      body: `<div class="op-form">${label ? `<div class="field"><label>${esc(label)}</label><input class="input" type="number" id="opNum" min="${min}" max="${max}" step="1" value="${value}"></div>` : ''}${note ? `<div class="op-warn">${icon('alert')}<span>${esc(note)}</span></div>` : ''}</div>`,
      buttons: [{ label: t('common.giveUp'), value: null }, { label: okText, cls: okCls || 'primary', onClick: (m) => { const i = m.querySelector('#opNum'); if (!i) return true; const v = Number(i.value); if (!Number.isFinite(v) || v < min || v > max) { i.classList.add('invalid'); return false; } return v; } }],
      onMount: (m) => enhanceNumbers(m),
    }));
  }

  function setPicking(onNow) {
    picking = !!onNow && !!map;
    el('#mapPane').classList.toggle('picking', picking);
    el('#pickHint').classList.toggle('hidden', !picking);
    if (picking && !['mapPip', 'split', 'map'].includes(prefs.layout)) setLayoutMode(HAS_CAM ? 'mapPip' : 'map', false);
    paintOps();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && picking) setPicking(false); });

  async function goTo(lat, lon, ask) {
    if (!drone || !st.linked || !caps().mav || busy) return;
    const x = st.telemetry || {};
    const rover = st.vehicle === 'rover';
    if (!rover && (!st.armed || !(x.altRel > 1))) { toast(t('fl.op.needAir'), { type: 'err' }); return; }
    const alt = rover ? 0 : Math.max(1, Math.round(x.altRel));
    if (ask && !await inStage(confirmBox(t('fl.op.goto'), t('fl.op.gotoConfirm', { lat: lat.toFixed(6), lon: lon.toFixed(6), alt }), { okText: t('fl.op.goto'), danger: false }))) return;
    const r = await run('goto', t('fl.op.gotoSent'), () => call('goto', lat, lon, rover ? 0 : x.altRel));
    if (r && r.ok) { target = { lat, lon, alt }; paintTarget(); }
  }

  function paintTarget() {
    const box = el('#opTarget');
    const x = st.telemetry || {};
    if (target && hasPos()) {
      const d = FlightHud.distance(x.lat, x.lon, target.lat, target.lon);
      // Varınca ya da araç yere inip motorlar kapanınca işaret kalkar
      if (d < 2.5 || !st.linked || !st.armed) target = null;
      else if (box) { box.firstElementChild.textContent = t('fl.op.target', { dist: d >= 1000 ? `${(d / 1000).toFixed(2)} km` : `${Math.round(d)} m` }); box.classList.remove('hidden'); }
    }
    if (!target && box) box.classList.add('hidden');
    if (!mapReady) return;
    const feats = target ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [target.lon, target.lat] } }] : [];
    if (target && hasPos()) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[x.lon, x.lat], [target.lon, target.lat]] } });
    map.getSource('target').setData({ type: 'FeatureCollection', features: feats });
  }

  el('#ops').addEventListener('change', async (e) => {
    if (e.target.id !== 'opMode' || !e.target.value) return;
    const name = e.target.value;
    e.target.blur();
    await run('mode', t('fl.op.modeSet', { mode: name }), () => call('setMode', name));
  });
  el('#ops').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-op]');
    if (!b || b.disabled || !drone) return;
    const op = b.dataset.op;
    const x = st.telemetry || {};
    if (op === 'clearTarget') { target = null; paintTarget(); return; }
    if (op === 'arm') {
      if (st.armed) { await run('arm', t('dr.disarm'), () => call('arm', false)); return; }
      if (await inStage(confirmBox(t('dr.arm'), esc(t('dr.armConfirm')), { okText: t('dr.arm'), danger: false }))) await run('arm', t('dr.arm'), () => call('arm', true));
    } else if (op === 'takeoff') {
      const plane = st.firmware === 'ardupilot' && st.vehicle === 'plane';
      const saved = Number(settings0.flightTakeoffAlt);
      const v = await numberForm({ title: t('fl.op.takeoff'), iconName: 'takeoff', label: plane ? '' : t('fl.op.takeoffAlt'), note: t(plane ? 'fl.op.takeoffPlane' : 'fl.op.takeoffNote'), value: saved >= 2 && saved <= 120 ? saved : 10, min: 2, max: 120, okText: t('fl.op.takeoff') });
      if (v === null || v === undefined || v === false) return;
      if (!plane) { settings0.flightTakeoffAlt = v; window.api.setSettings({ flightTakeoffAlt: v }); }
      await run('takeoff', t('fl.op.takeoff'), () => call('takeoff', plane ? 0 : v));
    } else if (op === 'land') await run('land', t('fl.op.land'), () => call('land'));
    else if (op === 'rtl') await run('rtl', t('fl.op.rtl'), () => call('rtl'));
    else if (op === 'hold') await run('hold', t('fl.op.hold'), () => call('hold'));
    else if (op === 'goto') {
      if (picking) { setPicking(false); return; }
      if (!hasPos()) { toast(t('fl.op.needPos'), { type: 'err' }); return; }
      if (st.vehicle !== 'rover' && (!st.armed || !(x.altRel > 1))) { toast(t('fl.op.needAir'), { type: 'err' }); return; }
      setPicking(true);
    } else if (op === 'alt') {
      if (!hasPos()) { toast(t('fl.op.needPos'), { type: 'err' }); return; }
      if (!st.armed || !(x.altRel > 1)) { toast(t('fl.op.needAir'), { type: 'err' }); return; }
      const v = await numberForm({ title: t('fl.op.altTitle'), iconName: 'altitude', label: t('fl.op.altLabel'), value: Math.min(500, Math.max(2, Math.round(x.altRel))), min: 2, max: 500, okText: t('fl.op.apply') });
      if (typeof v !== 'number') return;
      await run('alt', `${t('fl.op.alt')}: ${v} m`, () => call('setAltitude', v));
    } else if (op === 'kill') {
      if (await inStage(confirmBox(t('fl.op.kill'), t('fl.op.killConfirm'), { okText: t('fl.op.kill') }))) await run('kill', t('fl.op.kill'), () => call('kill'));
    }
  });
  let settings0 = {};

  // --- Başlangıç ---
  (async () => {
    const [store, f] = await Promise.all([window.api.getStore(), window.api.getFlight(FLIGHT_ID)]);
    if (!f) return window.close();
    flight = f;
    drone = f.droneId ? await window.api.getDrone(f.droneId) : null;
    const s = store.settings;
    // Kendi karo sunucusu (çevrimdışı / kurum içi harita): ayarlardaki flightTiles { sat, street } adresleri varsayılanların yerine geçer
    if (s.flightTiles && typeof s.flightTiles === 'object') { for (const k of ['sat', 'street']) if (typeof s.flightTiles[k] === 'string') TILES[k] = { ...TILES[k], tiles: [s.flightTiles[k]] }; }
    settings0 = { flightTakeoffAlt: s.flightTakeoffAlt };
    el('#stage').classList.toggle('ops-folded', s.flightOpsFolded === true);
    prefs = { layout: f.layout || 'mapPip', hud: s.flightHud !== false, follow: s.flightFollow !== false, style: s.flightStyle === 'street' ? 'street' : 'sat', tilt: s.flightTilt !== false, flat: s.flightFlat === true };
    hud = new FlightHud(el('#hud'));
    paintTools();
    setLayoutMode(prefs.layout, false);
    paintDrone();
    paintOps();
    initMap();
    animate();
    new ResizeObserver(() => { if (map) map.resize(); }).observe(el('#mapPane'));
    if (drone) {
      const cur = await window.api.droneState(drone.id);
      applyState(cur && cur.connected ? cur : await window.api.droneConnect(drone.id));
    }
  })();
})();
