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
    dem: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  };

  let flight = null;
  let drone = null;
  let st = { connected: false, linked: false, telemetry: {} };
  let prefs = { layout: 'mapPip', hud: true, follow: true, style: 'sat', terrain: true };
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
    return el('#stage').requestFullscreen().catch(() => {});
  }
  window.VW_FULLSCREEN = () => fullscreen('video');
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && beforeFull) { setLayoutMode(beforeFull, false); beforeFull = null; } if (map) setTimeout(() => map.resize(), 80); });

  // --- Harita ---
  function paintTools() {
    el('#btnHud').classList.toggle('active', prefs.hud);
    if (hud) hud.visible = prefs.hud;
    const b = (id, ic, title, on) => `<button class="icon-btn ${on ? 'active' : ''}" data-t="${id}" title="${esc(title)}">${icon(ic)}</button>`;
    el('#mapTools').innerHTML = b('follow', 'crosshair', t('fl.follow'), prefs.follow) + b('style', 'layers', t(prefs.style === 'sat' ? 'fl.street' : 'fl.sat'), false)
      + b('terrain', 'chart', t('fl.terrain'), prefs.terrain) + b('home', 'home', t('fl.goHome'), false) + b('clear', 'broom', t('fl.clearTrack'), false) + b('zin', 'plus', '+', false) + b('zout', 'minus', '−', false) + b('full', 'expand', t('fl.mapFull'), false);
  }
  el('#mapTools').onclick = (e) => {
    const b = e.target.closest('[data-t]');
    if (!b || !map) return;
    const a = b.dataset.t;
    if (a === 'follow') { prefs.follow = !prefs.follow; if (prefs.follow && shown) map.easeTo({ center: [shown[0], shown[1]], duration: 400 }); }
    else if (a === 'style') { prefs.style = prefs.style === 'sat' ? 'street' : 'sat'; applyStyle(); }
    else if (a === 'terrain') { prefs.terrain = !prefs.terrain; applyTerrain(); }
    else if (a === 'home') { const x = st.telemetry || {}; if (x.homeLat || x.homeLon) map.easeTo({ center: [x.homeLon, x.homeLat], duration: 600 }); }
    else if (a === 'clear') { track.length = 0; paintTrack(true); }
    else if (a === 'zin') map.zoomIn();
    else if (a === 'zout') map.zoomOut();
    else if (a === 'full') fullscreen('map');
    window.api.setSettings({ flightFollow: prefs.follow, flightStyle: prefs.style, flightTerrain: prefs.terrain });
    paintTools();
  };

  function applyStyle() {
    if (!mapReady) return;
    map.setLayoutProperty('sat', 'visibility', prefs.style === 'sat' ? 'visible' : 'none');
    map.setLayoutProperty('street', 'visibility', prefs.style === 'street' ? 'visible' : 'none');
  }
  function applyTerrain() {
    if (!mapReady) return;
    try { map.setTerrain(prefs.terrain ? { source: 'dem', exaggeration: 1 } : null); } catch { /* yükseklik verisi yok */ }
    map.easeTo({ pitch: prefs.terrain ? 62 : 0, duration: 500 });
  }

  function initMap() {
    if (!window.maplibregl) { el('#mapNote').textContent = t('fl.mapMissing'); el('#mapNote').classList.remove('hidden'); return; }
    maplibregl.setWorkerUrl('../vendor/maplibre/maplibre-gl-csp-worker.js');
    const raster = (s) => ({ type: 'raster', tiles: s.tiles, tileSize: 256, maxzoom: s.maxzoom, attribution: s.attribution });
    map = new maplibregl.Map({
      container: 'map', attributionControl: { compact: true }, maxPitch: 80,
      center: [32.8663, 39.9255], zoom: 4, pitch: prefs.terrain ? 62 : 0,
      style: {
        version: 8,
        sources: { sat: raster(TILES.sat), street: raster(TILES.street), dem: { type: 'raster-dem', tiles: [TILES.dem], tileSize: 256, maxzoom: 15, encoding: 'terrarium' } },
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1220' } },
          { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: prefs.style === 'sat' ? 'visible' : 'none' } },
          { id: 'street', type: 'raster', source: 'street', layout: { visibility: prefs.style === 'street' ? 'visible' : 'none' } }],
        sky: { 'sky-color': '#7fb4e6', 'horizon-color': '#cfe4f5', 'fog-color': '#cfe4f5', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.2 },
      },
    });
    let tileErrors = 0;
    map.on('error', () => { if (++tileErrors === 6) { el('#mapNote').textContent = t('fl.mapOffline'); el('#mapNote').classList.remove('hidden'); } });
    map.on('dragstart', () => { if (prefs.follow) { prefs.follow = false; paintTools(); } });
    map.on('load', () => {
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
      map.addLayer({ id: 'home', type: 'circle', source: 'home', paint: { 'circle-radius': 7, 'circle-color': '#34d399', 'circle-stroke-color': '#06121c', 'circle-stroke-width': 2 } });
      const m = document.createElement('div');
      m.className = 'fl-marker';
      m.innerHTML = '<svg viewBox="0 0 48 48"><path d="M24 4 L34 40 L24 33 L14 40 Z" fill="#f43f5e" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/></svg>';
      marker = new maplibregl.Marker({ element: m, rotationAlignment: 'map', pitchAlignment: 'map' });
      applyTerrain();
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
    if (mapReady && (x.homeLat || x.homeLon)) map.getSource('home').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [x.homeLon, x.homeLat] } });
    if (mapReady && prefs.follow && shown && !map.isMoving()) map.easeTo({ center: [x.lon, x.lat], duration: 450, easing: (n) => n });
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
    onTelemetry();
  }
  window.api.onDroneState((m) => { if (drone && m.id === drone.id) applyState(m.state); });
  window.api.onDroneStatustext((m) => { if (drone && m.id === drone.id && m.severity <= 4) toast(m.text, { type: m.severity <= 3 ? 'err' : '', timeout: 5000 }); });
  window.api.onFlightChanged((f) => { if (f.id === FLIGHT_ID) { flight = f; paintDrone(); } });
  el('#drState').onclick = async () => { if (!drone) return; if (st.connected) await window.api.droneDisconnect(drone.id); else applyState(await window.api.droneConnect(drone.id)); };
  el('#drState').title = t('fl.toggleLink');

  // --- Başlangıç ---
  (async () => {
    const [store, f] = await Promise.all([window.api.getStore(), window.api.getFlight(FLIGHT_ID)]);
    if (!f) return window.close();
    flight = f;
    drone = f.droneId ? await window.api.getDrone(f.droneId) : null;
    const s = store.settings;
    prefs = { layout: f.layout || 'mapPip', hud: s.flightHud !== false, follow: s.flightFollow !== false, style: s.flightStyle === 'street' ? 'street' : 'sat', terrain: s.flightTerrain !== false };
    hud = new FlightHud(el('#hud'));
    paintTools();
    setLayoutMode(prefs.layout, false);
    paintDrone();
    initMap();
    animate();
    new ResizeObserver(() => { if (map) map.resize(); }).observe(el('#mapPane'));
    if (drone) {
      const cur = await window.api.droneState(drone.id);
      applyState(cur && cur.connected ? cur : await window.api.droneConnect(drone.id));
    }
  })();
})();
