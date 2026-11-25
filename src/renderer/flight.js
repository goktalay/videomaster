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
    sat: { tiles: ['vdm://tiles/sat/{z}/{x}/{y}'], attribution: 'Esri, Maxar, Earthstar Geographics', maxzoom: 19 },
    street: { tiles: ['vdm://tiles/street/{z}/{x}/{y}'], attribution: '© OpenStreetMap', maxzoom: 19 },
  };

  let flight = null;
  let drone = null;
  let st = { connected: false, linked: false, telemetry: {} };
  let prefs = { layout: 'mapPip', hud: 'transparent', follow: true, style: 'sat', tilt: true, flat: false };
  let flatMode = false;      // sade 2B harita kullanılıyor (seçildi ya da 3B açılamadı)
  let map = null;
  let mapReady = false;
  let marker = null;
  let hud = null;
  let inst = null;
  const track = [];          // [lon, lat, alt]
  let shown = null;          // haritada gösterilen (yumuşatılmış) konum
  let lastTrackPaint = 0;

  // --- Üst çubuk ---
  el('#flIcon').innerHTML = icon('globe');
  el('#btnHud').innerHTML = icon('gauge');
  el('#btnHud').title = t('hud.style');
  el('#btnDrone').innerHTML = icon('gear');
  el('#btnDrone').title = t('fl.openDrone');
  el('#btnDrone').onclick = () => { if (drone && !(flight && flight.replay)) window.api.openDrone(drone.id); };
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
  // HUD görünümleri: Transparan (görüntünün üstüne çizilen şeritler), Göstergeler (yüzen yapay ufuk + pusula), Küçük (yalnız yapay ufuk), Kapalı
  const HUD_STYLES = ['transparent', 'instruments', 'compact', 'off'];
  el('#btnHud').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 6, HUD_STYLES.map((s) => ({ label: t(`hud.s.${s}`), icon: prefs.hud === s ? 'check' : s === 'off' ? 'eyeOff' : 'gauge', action: () => { prefs.hud = s; window.api.setSettings({ flightHudStyle: s }); paintTools(); } })));
  };

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
    el('#btnHud').classList.toggle('active', prefs.hud !== 'off');
    if (hud) hud.visible = prefs.hud === 'transparent';
    if (inst) inst.setMode(prefs.hud === 'instruments' || prefs.hud === 'compact', prefs.hud === 'compact');
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
      map.addSource('mission', { type: 'geojson', data: empty });
      map.addLayer({ id: 'mission', type: 'line', source: 'mission', paint: { 'line-color': '#f5d0fe', 'line-width': 2.4, 'line-dasharray': [3, 2] } });
      missionKey = '';
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
    paintMission();
    if (mapReady && (x.homeLat || x.homeLon)) map.getSource('home').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [x.homeLon, x.homeLat] } });
  }

  // --- Dron durumu ---
  function paintDrone() {
    el('#flName').textContent = flight.name;
    el('#flSub').textContent = st.replay ? `${t('dl.replay')} · ${new Date(st.replay.startedAt).toLocaleString()}` : drone ? `${drone.name} · ${st.link || DRONE.display(drone)}` : t('fl.droneGone');
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
    if (inst) inst.update(st.telemetry, st);
    paintOps();
    onTelemetry();
  }
  window.api.onDroneState((m) => { if (drone && m.id === drone.id) applyState(m.state); });
  window.api.onDroneStatustext((m) => { if (drone && m.id === drone.id && m.severity <= 4) toast(m.text, { type: m.severity <= 3 ? 'err' : '', timeout: 5000 }); });
  window.api.onFlightChanged((f) => { if (f.id === FLIGHT_ID) { flight = f; paintDrone(); } });
  el('#drState').onclick = async () => { if (!drone || st.replay || (flight && flight.replay)) return; if (st.connected) await window.api.droneDisconnect(drone.id); else applyState(await window.api.droneConnect(drone.id)); };
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
      <span class="sep"></span>${b('mission', 'route', t('ms.tab.mission'))}${b('goto', 'pin', t('fl.op.goto'))}${b('alt', 'altitude', t('fl.op.alt'))}
      <span class="op-target hidden" id="opTarget"><span></span><button type="button" data-op="clearTarget" title="${esc(t('fl.op.clearTarget'))}">${icon('x')}</button></span>
      <span class="op-note hidden" id="opNote"></span><span class="sep"></span>${b('kill', 'alert', t('fl.op.kill'), 'kill')}<span class="sep keep"></span>${b('screenrec', 'record', t('fl.op.screenrec'), 'rec')}`;
    el('#pickHint').textContent = t('fl.op.pickHint');
  }

  // Telemetri çubuğu: solda kip + motor durumu, ardından kullanıcının seçtiği kutular (dişli düğmesiyle düzenlenir)
  let armedAt = 0;
  let flownMs = 0;
  let tmFields = [];
  const TM_DEFAULT = ['alt', 'spd', 'climb', 'hdg', 'home', 'batt', 'gps', 'time', 'wp'];
  const dist = (d) => (Number.isFinite(d) && d !== null ? [d >= 1000 ? (d / 1000).toFixed(2) : String(Math.round(d)), d >= 1000 ? 'km' : 'm'] : ['—', 'm']);
  // Alan → [kısa etiket, birim, değer işlevi(x, canlı mı) → değer | [değer, birim, sınıf, çubuk %]]
  const TM = {
    alt: [() => t('tm.altRel'), 'm', (x) => x.altRel],
    altMsl: [() => t('s.altMsl'), 'm', (x) => x.altMsl],
    spd: [() => t('fl.tm.speed'), 'm/s', (x) => x.groundspeed],
    airspeed: [() => t('s.airspeed'), 'm/s', (x) => x.airspeed],
    climb: [() => t('tm.climb'), 'm/s', (x) => (Number.isFinite(x.climb) ? [`${x.climb > 0.05 ? '+' : ''}${x.climb.toFixed(1)}`] : null)],
    hdg: [() => t('tm.heading'), '°', (x) => (Number.isFinite(x.heading) ? [String(Math.round(x.heading)).padStart(3, '0')] : null)],
    home: [() => t('fl.tm.home'), 'm', (x) => { const d = (x.homeLat || x.homeLon) && hasPos() ? FlightHud.distance(x.lat, x.lon, x.homeLat, x.homeLon) : null; return d === null ? null : dist(d); }],
    target: [() => t('s.target'), 'm', (x) => (target && hasPos() ? dist(FlightHud.distance(x.lat, x.lon, target.lat, target.lon)) : null)],
    batt: [() => t('fl.tm.batt'), 'V', (x) => { const pct = Number.isFinite(x.batteryPct) && x.batteryPct >= 0 ? x.batteryPct : NaN; return x.voltage ? [x.voltage.toFixed(1), Number.isFinite(pct) ? `V · ${Math.round(pct)}%` : 'V', pct < 20 ? 'bad' : pct < 35 ? 'warn' : '', Number.isFinite(pct) ? pct : 0] : null; }, true],
    current: [() => t('s.current'), 'A', (x) => x.current],
    gps: [() => 'GPS', '', (x) => { const fix = Number(x.gpsFix) || 0; return Number.isFinite(x.sats) ? [String(x.sats), fix >= 3 ? '3D' : fix === 2 ? '2D' : t('fl.tm.noFix'), fix >= 3 ? 'good' : fix >= 2 ? 'warn' : 'bad'] : null; }],
    hdop: [() => t('s.hdop'), '', (x) => (Number.isFinite(x.hdop) ? [x.hdop.toFixed(2), '', x.hdop <= 1.5 ? 'good' : x.hdop <= 2.5 ? 'warn' : 'bad'] : null)],
    time: [() => t('fl.tm.time'), '', () => { const sec = Math.floor((flownMs + (armedAt ? Date.now() - armedAt : 0)) / 1000); return [`${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`]; }, false, true],
    wp: [() => t('s.wp'), '', () => { const ms = st.mission || {}; return ms.loaded ? [`${ms.current >= 0 ? ms.current + 1 : '—'}/${ms.count}`] : null; }],
    throttle: [() => t('s.throttle'), '%', (x) => (Number.isFinite(x.throttle) ? [String(Math.round(x.throttle))] : null)],
    roll: [() => t('s.roll'), '°', (x) => x.roll],
    pitch: [() => t('s.pitch'), '°', (x) => x.pitch],
    rssi: [() => t('s.rssi'), '%', (x) => (Number.isFinite(x.rssi) ? [String(Math.round(x.rssi)), '%', x.rssi < 30 ? 'bad' : x.rssi < 50 ? 'warn' : ''] : null)],
    pos: [() => t('s.pos'), '', (x) => (hasPos() ? [`${x.lat.toFixed(5)}, ${x.lon.toFixed(5)}`] : null)],
  };
  function buildTm() {
    el('#tm').innerHTML = `<div class="tm-mode off" id="tmMode"><b>—</b><span><i></i><em style="font-style:normal"></em></span></div>
      ${tmFields.map((id) => `<div class="tm ${id === 'pos' ? 'wide' : ''}" data-tm="${id}"><label>${esc(TM[id][0]())}</label><div><b>—</b><small>${esc(TM[id][1])}</small></div>${TM[id][3] ? '<span class="bar"><i></i></span>' : ''}</div>`).join('')}
      <button type="button" class="tm-fold" id="tmEdit" title="${esc(t('fl.tm.edit'))}">${icon('gear')}</button>
      <button type="button" class="tm-fold tm-chev" id="tmFold" title="${esc(t('fl.tm.fold'))}">${icon('chevronDown')}</button>`;
    el('#tmFold').onclick = () => { const f = !el('#stage').classList.contains('ops-folded'); el('#stage').classList.toggle('ops-folded', f); window.api.setSettings({ flightOpsFolded: f }); };
    el('#tmEdit').onclick = editTm;
    if (!buildTm.once) {
      buildTm.once = true;
      const ro = new ResizeObserver(() => { const stg = el('#stage').style; stg.setProperty('--deck-h', `${el('#deck').offsetHeight}px`); stg.setProperty('--dock-h', `${el('#dock').offsetHeight}px`); });
      ro.observe(el('#deck')); ro.observe(el('#dock'));
      setInterval(paintTm, 1000);
    }
  }
  function paintTm() {
    if (!el('#tm').firstChild) return;
    const x = st.telemetry || {};
    const live = !!st.linked;
    const mode = el('#tmMode');
    mode.className = `tm-mode ${!live ? 'off' : st.armed ? 'armed' : ''}`;
    mode.querySelector('b').textContent = live ? (st.mode || '—') : t('dr.st.off');
    mode.querySelector('em').textContent = live ? t(st.armed ? 'dr.armed' : 'dr.disarmed') : (drone ? drone.name : '');
    // Uçuş süresi: motorların etkin kaldığı toplam süre
    if (live && st.armed && !armedAt) armedAt = Date.now();
    if ((!live || !st.armed) && armedAt) { flownMs += Date.now() - armedAt; armedAt = 0; }
    for (const id of tmFields) {
      const b = el(`#tm [data-tm="${id}"]`);
      if (!b) continue;
      const f = TM[id];
      let v = live || f[4] ? f[2](x) : null;
      if (typeof v === 'number') v = Number.isFinite(v) ? [v.toFixed(1)] : null;
      else if (!Array.isArray(v)) v = null;
      b.className = `tm ${id === 'pos' ? 'wide' : ''} ${v && v[2] ? v[2] : ''} ${!v && (id === 'wp' || id === 'target') ? 'hidden' : ''}`; // görev / hedef yokken kutu gizlenir
      b.querySelector('b').textContent = v ? v[0] : '—';
      b.querySelector('small').textContent = v && v[1] !== undefined ? v[1] : f[1];
      if (f[3]) b.querySelector('.bar i').style.width = `${v && v[3] ? Math.min(100, v[3]) : 0}%`;
    }
  }
  // Telemetri çubuğunu düzenleme: gösterilecek kutular ve sıraları
  function editTm() {
    let order = [...tmFields, ...Object.keys(TM).filter((k) => !tmFields.includes(k))];
    const on = new Set(tmFields);
    const body = h('<div class="tm-edit"></div>');
    const paint = () => {
      body.innerHTML = `<div class="ms-note">${esc(t('fl.tm.editNote'))}</div>${order.map((k, i) => `<div class="tm-edit-row" data-k="${k}"><label class="ms-check"><input type="checkbox" ${on.has(k) ? 'checked' : ''}><span>${esc(t(`fl.tm.f.${k}`))}</span></label><span style="flex:1"></span><button class="icon-btn" data-up ${i ? '' : 'disabled'}>${icon('up')}</button><button class="icon-btn" data-down ${i < order.length - 1 ? '' : 'disabled'}>${icon('chevronDown')}</button></div>`).join('')}`;
    };
    body.addEventListener('change', (e) => { const row = e.target.closest('[data-k]'); if (row) { if (e.target.checked) on.add(row.dataset.k); else on.delete(row.dataset.k); } });
    body.addEventListener('click', (e) => {
      const row = e.target.closest('[data-k]'); const up = e.target.closest('[data-up]'); const down = e.target.closest('[data-down]');
      if (!row || (!up && !down)) return;
      const i = order.indexOf(row.dataset.k); const j = up ? i - 1 : i + 1;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]]; paint();
    });
    paint();
    const apply = (list) => { tmFields = list; window.api.setSettings({ flightTm: list }); buildTm(); paintTm(); };
    inStage(openModal({ title: t('fl.tm.edit'), iconName: 'gear', width: 440, body,
      buttons: [{ label: t('fl.tm.reset'), left: true, onClick: () => { order = [...TM_DEFAULT, ...Object.keys(TM).filter((k) => !TM_DEFAULT.includes(k))]; on.clear(); TM_DEFAULT.forEach((k) => on.add(k)); paint(); return false; } },
        { label: t('common.giveUp'), value: null }, { label: t('common.ok'), cls: 'primary', onClick: () => { apply(order.filter((k) => on.has(k))); } }] }));
  }

  // --- Kayıt oynatma: kayıtlı telemetri canlı uçuş gibi gösterilir; alttaki çubuk oynatıcıya dönüşür ---
  const SPEEDS = [1, 2, 4, 8, 16];
  let seeking = false;
  const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const hh = Math.floor(s / 3600); return `${hh ? `${hh}:` : ''}${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  function setTrack(path) { track.length = 0; if (Array.isArray(path)) for (const p of path) track.push(p); shown = null; target = null; paintTrack(true); paintTarget(); }
  function buildReplay() {
    const bar = el('#replayBar');
    bar.innerHTML = `<span class="rp-badge">${icon('history')}${esc(t('dl.replay'))}</span>
      <button class="btn rp-play" id="rpPlay"></button><span class="rp-time" id="rpPos">00:00</span>
      <input type="range" id="rpSeek" min="0" max="1000" step="100" value="0"><span class="rp-time" id="rpDur">00:00</span>
      <div class="seg sm" id="rpSpeed">${SPEEDS.map((x) => `<button type="button" data-x="${x}">${x}×</button>`).join('')}</div>`;
    el('#rpPlay').onclick = async () => { const r = await call('replayPlay', !(st.replay && st.replay.playing)); if (r && r.ok && st.replay && st.replay.pos >= st.replay.duration) setTrack(r.path); };
    el('#rpSpeed').onclick = (e) => { const b = e.target.closest('[data-x]'); if (b) call('replaySpeed', Number(b.dataset.x)); };
    const seek = el('#rpSeek');
    seek.addEventListener('input', () => { seeking = true; el('#rpPos').textContent = clock(Number(seek.value)); });
    seek.addEventListener('change', async () => { const r = await call('replaySeek', Number(seek.value)); seeking = false; if (r && r.ok) setTrack(r.path); });
  }
  function paintReplay() {
    const rp = st.replay;
    const bar = el('#replayBar');
    bar.classList.toggle('hidden', !rp);
    el('#ops').classList.toggle('replay', !!rp);
    if (!rp) return;
    if (!bar.firstChild) buildReplay();
    el('#rpPlay').innerHTML = icon(rp.playing ? 'pause' : 'play');
    el('#rpPlay').title = t(rp.playing ? 'dr.logPause' : 'dl.play');
    el('#rpDur').textContent = clock(rp.duration);
    const seek = el('#rpSeek');
    if (Number(seek.max) !== rp.duration) seek.max = String(rp.duration);
    if (!seeking) { seek.value = String(rp.pos); el('#rpPos').textContent = clock(rp.pos); }
    for (const b of el('#rpSpeed').children) b.classList.toggle('on', Number(b.dataset.x) === rp.speed);
  }

  function paintOps() {
    const ops = el('#ops');
    if (!ops.firstChild) { buildOps(); buildTm(); }
    paintTm();
    paintReplay();
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
      set('mission', !bf, on);
      set('alt', !bf && (c.alt || !st.linked), on && c.alt);
      set('kill', !bf, on && !!st.armed);
      q('goto').classList.toggle('on', picking);
      for (const x of ops.querySelectorAll('.sep:not(.keep)')) x.classList.toggle('hidden', bf);
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
    if (op === 'screenrec') { toggleScreenRec(); return; }
    if (op === 'mission') { missionMenu(b); return; }
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

  // --- Görev: yükleme, başlatma / duraklatma / sürdürme, görev noktasına gitme; yüklü görev haritada gösterilir ---
  let missionKey = '';
  let missionMarkers = [];
  function paintMission() {
    if (!mapReady) return;
    const ms = st.linked && st.mission && st.mission.loaded ? st.mission : null;
    const key = ms ? `${ms.path.length}|${ms.current}|${ms.path.map((q) => `${q.lat},${q.lon}`).join(';')}` : '';
    if (key === missionKey) return;
    missionKey = key;
    for (const mk of missionMarkers) mk.remove();
    missionMarkers = [];
    const pts = ms ? ms.path.filter((q) => q.type !== 'roi') : [];
    map.getSource('mission').setData({ type: 'FeatureCollection', features: pts.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.map((q) => [q.lon, q.lat]) } }] : [] });
    if (!ms) return;
    // Çok noktalı görevlerde (tarama) yalnız aralıklı noktalar ve etkin nokta işaretlenir
    const stepN = Math.max(1, Math.ceil(ms.path.length / 150));
    ms.path.forEach((q, i) => {
      if (q.index !== ms.current && i % stepN && i !== ms.path.length - 1) return;
      const m = document.createElement('div');
      m.className = `fl-wp ${q.index === ms.current ? 'cur' : ''} ${q.type === 'roi' ? 'roi' : ''}`;
      m.textContent = String(q.index + 1);
      m.title = `${q.index + 1}. ${t(`ms.t.${q.type}`)} · ${q.alt} m`;
      missionMarkers.push((flatMode ? new FlatMarker({ element: m }) : new maplibregl.Marker({ element: m })).setLngLat([q.lon, q.lat]).addTo(map));
    });
  }
  function missionMenu(btn) {
    const r = btn.getBoundingClientRect();
    const ms = st.mission || {};
    const auto = /^(AUTO|Mission)$/i.test(st.mode || '');
    contextMenu(r.left, r.top - 8, [
      { label: t('flm.load'), icon: 'upload', action: missionLoad },
      { label: t('flm.read'), icon: 'download', action: () => run('mission', t('flm.read'), () => call('downloadMission')) },
      '-',
      { label: t('flm.start'), icon: 'play', disabled: !ms.loaded, action: async () => { if (await inStage(confirmBox(t('flm.start'), esc(t('flm.startConfirm', { n: ms.count })), { okText: t('flm.start'), danger: false }))) run('mission', t('flm.start'), () => call('startMission')); } },
      { label: t('flm.pause'), icon: 'pause', disabled: !auto, action: () => run('mission', t('flm.pause'), () => call('pauseMission')) },
      { label: t('flm.resume'), icon: 'arrowRight', disabled: !ms.loaded || auto || !st.armed, action: () => run('mission', t('flm.resume'), () => call('resumeMission')) },
      { label: t('flm.jump'), icon: 'pin', disabled: !ms.loaded || !ms.path.length, action: missionJump },
      '-',
      { label: t('ms.clearVehicle'), icon: 'trash', danger: true, disabled: !!st.armed, action: async () => { if (await inStage(confirmBox(t('ms.clearVehicle'), esc(t('ms.clearVehicleConfirm')), { okText: t('ms.clearVehicle') }))) run('mission', t('ms.clearVehicle'), () => call('clearMission')); } },
    ]);
    // Menü yukarı doğru açılır; tam ekranda tam ekrandaki öğenin içine alınır
    const menu = document.querySelector('.ctx');
    if (menu) { if (document.fullscreenElement) document.fullscreenElement.appendChild(menu); menu.style.top = `${Math.max(6, r.top - menu.offsetHeight - 8)}px`; }
  }
  async function missionLoad() {
    const store = await window.api.getStore();
    const list = (store.missions || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const body = h(`<div class="dl-list">${list.length ? list.map((m) => `<div class="dl-row" data-id="${esc(m.id)}"><div class="dl-main"><div class="dl-dur">${icon('route')}${esc(m.name)}</div><div class="dl-facts"><span>${esc(t('ms.cardSub', { n: m.count, dist: m.distance >= 1000 ? `${(m.distance / 1000).toFixed(2)} km` : `${m.distance} m`, time: clock((m.time || 0) * 1000) }))}</span>${m.fence ? `<span>${esc(t('ms.fence'))}</span>` : ''}${m.rally ? `<span>${esc(t('ms.rally'))}</span>` : ''}</div></div><button class="btn sm primary" data-up>${icon('upload')}${esc(t('ms.upload'))}</button></div>`).join('') : `<div class="empty-note">${esc(t('flm.none'))}</div>`}</div>`);
    let closeFn = null;
    body.addEventListener('click', async (e) => {
      const row = e.target.closest('[data-up]') && e.target.closest('.dl-row');
      if (!row) return;
      const doc = await window.api.getMission(row.dataset.id);
      if (closeFn) closeFn(null);
      if (!doc) return;
      const r = await run('mission', `${t('ms.upload')}: ${doc.name}`, () => call('uploadMission', doc));
      if (r && r.ok && mapReady && st.mission && st.mission.path.length) { prefs.follow = false; paintTools(); const pts = st.mission.path.map((q) => [q.lon, q.lat]); if (hasPos()) pts.push([st.telemetry.lon, st.telemetry.lat]); fitTo(pts); }
    });
    inStage(openModal({ title: t('flm.load'), iconName: 'route', width: 600, body, buttons: [{ label: t('common.close'), value: null }], onMount: (_m, close) => { closeFn = close; } }));
  }
  function fitTo(pts) {
    if (!pts.length) return;
    if (flatMode) { map.fitBounds(pts, 140); return; }
    let a = Infinity; let b = -Infinity; let c = Infinity; let d = -Infinity;
    for (const [lo, la] of pts) { a = Math.min(a, lo); b = Math.max(b, lo); c = Math.min(c, la); d = Math.max(d, la); }
    try { map.fitBounds([[a, c], [b, d]], { padding: 140, maxZoom: 17, duration: 600 }); } catch { /* geçersiz sınır */ }
  }
  async function missionJump() {
    const ms = st.mission || { path: [] };
    const body = h(`<div class="dl-list">${ms.path.map((q) => `<div class="dl-row" data-i="${q.index}"><div class="dl-when"><b>${q.index + 1}</b></div><div class="dl-main"><div class="dl-dur">${esc(t(`ms.t.${q.type}`))}</div><div class="dl-facts"><span>${q.alt} m</span><span>${q.lat.toFixed(5)}, ${q.lon.toFixed(5)}</span></div></div><button class="btn sm primary" data-go>${icon('arrowRight')}${esc(t('flm.go'))}</button></div>`).join('')}</div>`);
    let closeFn = null;
    body.addEventListener('click', (e) => {
      const row = e.target.closest('[data-go]') && e.target.closest('.dl-row');
      if (!row) return;
      const i = Number(row.dataset.i);
      if (closeFn) closeFn(null);
      run('mission', t('flm.jumped', { n: i + 1 }), () => call('setMissionCurrent', i));
    });
    inStage(openModal({ title: t('flm.jump'), iconName: 'pin', width: 520, body, buttons: [{ label: t('common.close'), value: null }], onMount: (_m, close) => { closeFn = close; } }));
  }
  window.api.onDroneMission((m) => { if (drone && m.id === drone.id && m.total) { const b = el('#ops [data-op="mission"] span'); if (b) b.textContent = m.done >= m.total ? t('ms.tab.mission') : `${Math.round((m.done / m.total) * 100)}%`; } });

  // --- Ekran kaydı: uçuş penceresinin tamamı (harita, kamera, HUD, paneller) video dosyasına yazılır ---
  let screenRec = null; // { recorder, stream, timer, startedAt }
  function paintScreenRec() {
    const b = el('#ops [data-op="screenrec"]');
    if (!b) return;
    b.classList.toggle('recording', !!screenRec);
    const sec = screenRec ? Math.floor((Date.now() - screenRec.startedAt) / 1000) : 0;
    b.querySelector('span').textContent = screenRec ? `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}` : t('fl.op.screenrec');
    b.title = t(screenRec ? 'fl.op.screenrecStop' : 'fl.op.tip.screenrec');
  }
  async function stopScreenRec() {
    const r = screenRec;
    if (!r) return;
    screenRec = null;
    clearInterval(r.timer);
    paintScreenRec();
    await new Promise((res) => { r.recorder.onstop = res; try { r.recorder.stop(); } catch { res(); } });
    for (const tr of r.stream.getTracks()) tr.stop();
    await r.flush;
    const out = await window.api.screenRecStop();
    if (out && out.ok) { const el2 = toast(t('rec.saved'), { type: 'ok', sub: out.file, timeout: 9000 }); el2.style.cursor = 'pointer'; el2.onclick = () => window.api.recOpenFile(out.file); } else toast(t('rec.failed'), { type: 'err', sub: out && out.error === 'empty' ? t('rec.empty') : '' });
  }
  async function toggleScreenRec() {
    if (screenRec) { await stopScreenRec(); return; }
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      const mime = ['video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
      const started = await window.api.screenRecStart({ name: flight ? flight.name : '', mime });
      if (!started || !started.ok) throw new Error((started && (started.detail || started.error)) || 'start');
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
      const rec = { recorder, stream, startedAt: Date.now(), flush: Promise.resolve(), timer: setInterval(paintScreenRec, 1000) };
      recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) rec.flush = rec.flush.then(() => ev.data.arrayBuffer()).then((buf) => window.api.screenRecChunk(new Uint8Array(buf))).catch(() => {}); };
      stream.getVideoTracks()[0].addEventListener('ended', () => { if (screenRec === rec) stopScreenRec(); });
      recorder.start(1000);
      screenRec = rec;
      paintScreenRec();
    } catch (e) {
      if (stream) for (const tr of stream.getTracks()) tr.stop();
      window.api.screenRecStop();
      toast(t('rec.failed'), { type: 'err', sub: String((e && e.message) || e), timeout: 6000 });
    }
  }
  addEventListener('beforeunload', () => { if (screenRec) { try { screenRec.recorder.stop(); } catch { /* yok */ } } });

  // --- Başlangıç ---
  (async () => {
    const [store, f] = await Promise.all([window.api.getStore(), window.api.getFlight(FLIGHT_ID)]);
    if (!f) return window.close();
    flight = f;
    drone = f.droneId ? await window.api.getDrone(f.droneId) : null;
    const s = store.settings;
    settings0 = { flightTakeoffAlt: s.flightTakeoffAlt };
    el('#stage').classList.toggle('ops-folded', s.flightOpsFolded === true);
    prefs = { layout: f.layout || 'mapPip', hud: ['transparent', 'instruments', 'compact', 'off'].includes(s.flightHudStyle) ? s.flightHudStyle : s.flightHud === false ? 'off' : 'transparent', follow: s.flightFollow !== false, style: s.flightStyle === 'street' ? 'street' : 'sat', tilt: s.flightTilt !== false, flat: s.flightFlat === true };
    hud = new FlightHud(el('#hud'));
    inst = new InstrumentPanel(el('#inst'));
    tmFields = Array.isArray(s.flightTm) && s.flightTm.length ? s.flightTm.filter((k) => TM[k]) : TM_DEFAULT.slice();
    el('#btnDrone').classList.toggle('hidden', !drone || !!f.replay);
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
