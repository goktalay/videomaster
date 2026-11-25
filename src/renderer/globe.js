'use strict';

// Ortak harita (CesiumJS küre): uçuş penceresi ve görev düzenleyici aynı sınıfı kullanır. Altyapı Göktungu yer
// istasyonundakiyle aynıdır: Cesium Viewer yerine widget'sız sahne, bütün görüntü karoları uygulamanın karo önbelleğinden
// (vdm://tiles/<kaynak>/{z}/{x}/{y}), arazi isteğe bağlı (ArcGIS World Elevation; Cesium ion anahtarı varsa World Terrain).
// Arayüz, WebGL'siz yedek harita (FlatMap, map2d.js) ile ortaktır: on/once, addSource/getSource().setData, addLayer,
// setLayoutProperty, project/unproject, jumpTo/easeTo, getCenter/getZoom, zoomIn/zoomOut, fitBounds, resize, remove.
// Cesium kitaplığı ilk kullanımda yüklenir (GlobeMap.load()).

const GLOBE_BASE = '../vendor/cesium/';
const ARCGIS_TERRAIN = 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer';
// MAV_TYPE → 3B model (Göktungu modelleri: burun +X)
const GLOBE_MODELS = { 1: 'ucak', 2: 'quad', 3: 'quad', 4: 'heli', 13: 'hexa', 14: 'octo', 15: 'tri', 19: 'ucak', 20: 'ucak', 21: 'ucak', 22: 'ucak', 23: 'ucak', 24: 'ucak', 25: 'ucak' };

class GlobeMap {
  static load() {
    if (window.Cesium) return Promise.resolve(true);
    if (!GlobeMap.loading) {
      window.CESIUM_BASE_URL = GLOBE_BASE;
      GlobeMap.loading = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = `${GLOBE_BASE}Cesium.js`;
        s.onload = () => resolve(!!window.Cesium);
        s.onerror = () => { GlobeMap.loading = null; resolve(false); };
        document.head.appendChild(s);
      });
    }
    return GlobeMap.loading;
  }

  // opts: { container, center [lon, lat], zoom, source, sources [{ id, maxzoom, credit }], terrain 'off'|'arcgis'|'ion',
  //         token, topDown (üstten bakış: görev düzenleyici), clamp (çizimler araziye oturtulur), scene: { … } }
  constructor(opts) {
    const C = window.Cesium;
    this.C = C;
    this.el = typeof opts.container === 'string' ? document.getElementById(opts.container) : opts.container;
    this.handlers = {}; this.data = {}; this.layerDefs = []; this.markers = new Set(); this.prims = {};
    this.sources = opts.sources || [];
    this.source = opts.source || 'esri';
    this.clamp = !!opts.clamp;
    this.topDown = !!opts.topDown;
    this.base = 0; this.baseKey = '';
    this.dragging = false; this.lastTarget = null; this.removed = false;
    this.terrainMode = 'off';
    this.el.classList.add('globe-map');
    const w = new C.CesiumWidget(this.el, { baseLayer: false, skyAtmosphere: new C.SkyAtmosphere(), scene3DOnly: true });
    this.w = w;
    w.scene.globe.baseColor = C.Color.fromCssColorString('#0b0e11');
    // Düzenleyicide çizimler arazinin arkasında kalmasın; uçuşta gerçek derinlik kullanılır
    w.scene.globe.depthTestAgainstTerrain = !this.clamp;
    w.scene.screenSpaceCameraController.enableCollisionDetection = true;
    this.setSource(this.source);
    this.setScene(opts.scene || {});
    this.token = opts.token || '';
    this.setTerrain(opts.terrain || 'off');
    this.lines = w.scene.primitives.add(new C.PolylineCollection());
    this.points = w.scene.primitives.add(new C.PointPrimitiveCollection());

    const c = opts.center || [32.8663, 39.9255];
    if (this.topDown) this.jumpTo({ center: c, zoom: opts.zoom || 5 });
    else w.camera.setView({ destination: C.Cartesian3.fromDegrees(c[0], c[1] - 0.35, 60000), orientation: { heading: 0, pitch: C.Math.toRadians(-55), roll: 0 } });

    const h = new C.ScreenSpaceEventHandler(w.canvas);
    this.input = h;
    const ev = (pos) => { const ll = this.unproject(pos.x, pos.y); return ll ? { lngLat: ll, point: { x: pos.x, y: pos.y } } : null; };
    h.setInputAction((e) => { const x = ev(e.position); if (x) this._fire('click', x); }, C.ScreenSpaceEventType.LEFT_CLICK);
    h.setInputAction((e) => { const x = ev(e.position); if (x) this._fire('dblclick', x); }, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    h.setInputAction((e) => { const x = ev(e.position); if (x) this._fire('contextmenu', x); }, C.ScreenSpaceEventType.RIGHT_CLICK);
    let down = false;
    h.setInputAction(() => { down = true; }, C.ScreenSpaceEventType.LEFT_DOWN);
    h.setInputAction(() => { down = false; this.dragging = false; }, C.ScreenSpaceEventType.LEFT_UP);
    h.setInputAction((e) => {
      if (down && !this.dragging) { this.dragging = true; this._fire('dragstart'); }
      if (!down && this.handlers.mousemove) { const x = ev(e.endPosition); if (x) this._fire('mousemove', x); }
    }, C.ScreenSpaceEventType.MOUSE_MOVE);
    w.scene.screenSpaceCameraController.inertiaSpin = 0.5;
    // Çift tıklama yakınlaştırmasın (çizim araçları kullanır)
    w.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    this.dragPan = { isActive: () => this.dragging };
    w.camera.moveEnd.addEventListener(() => this._fire('move'));
    w.scene.postRender.addEventListener(() => { for (const m of this.markers) m._place(); });
    // Araziye oturtulan çizimler: arazi karoları yüklendikçe yükseklikler güncellenir
    if (this.clamp) this.clampTimer = setInterval(() => { if (!this.removed && this.terrainMode !== 'off') this._redrawAll(); }, 2500);
    requestAnimationFrame(() => { if (!this.removed) { this._fire('style.load'); this._fire('load'); } });
  }

  on(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); return this; }
  once(name, fn) { const wr = (e) => { this.handlers[name] = this.handlers[name].filter((x) => x !== wr); fn(e); }; return this.on(name, wr); }
  _fire(name, e) { for (const fn of (this.handlers[name] || []).slice()) { try { fn(e); } catch (err) { console.error(err); } } }

  // ---- katmanlar: görüntü, arazi, sahne ----
  setSource(id) {
    const C = this.C;
    const def = this.sources.find((s) => s.id === id) || { id, maxzoom: 19, credit: '' };
    this.source = def.id;
    const w = this.w;
    w.imageryLayers.removeAll();
    const prov = new C.UrlTemplateImageryProvider({ url: `vdm://tiles/${def.id}/{z}/{x}/{y}`, maximumLevel: def.maxzoom || 19, credit: def.credit || '' });
    prov.errorEvent.addEventListener(() => this._fire('error', { error: new Error('tile') }));
    w.imageryLayers.addImageryProvider(prov);
  }
  setLayoutProperty(id, prop, value) { if (prop === 'visibility' && value === 'visible' && this.sources.some((s) => s.id === id)) this.setSource(id); }

  // Arazi: 'off' (düz), 'arcgis' (ArcGIS World Elevation — anahtarsız), 'ion' (Cesium World Terrain — anahtar gerekir)
  async setTerrain(mode) {
    const C = this.C;
    const want = mode === 'ion' && !this.token ? 'arcgis' : mode;
    this.terrainMode = want;
    try {
      let tp;
      if (want === 'arcgis') tp = await C.ArcGISTiledElevationTerrainProvider.fromUrl(ARCGIS_TERRAIN);
      else if (want === 'ion') { C.Ion.defaultAccessToken = this.token; tp = await C.createWorldTerrainAsync(); }
      else tp = new C.EllipsoidTerrainProvider();
      if (this.removed || this.terrainMode !== want) return;
      this.w.terrainProvider = tp;
    } catch (e) {
      if (this.removed) return;
      console.warn('Arazi yüklenemedi:', e && e.message);
      this.w.terrainProvider = new C.EllipsoidTerrainProvider();
      this.terrainMode = 'off';
      this._fire('terrainerror', e);
    }
    this.baseKey = ''; this.base = 0;
    this._redrawAll();
  }
  setTerrain3() {}

  // Sahne ayarları: { atmosphere, fog, lighting, water, fxaa, exaggeration, scale }
  setScene(o) {
    const s = this.w.scene;
    this.sceneOpts = { atmosphere: true, fog: true, lighting: false, fxaa: true, exaggeration: 1, scale: 1, ...(this.sceneOpts || {}), ...o };
    const q = this.sceneOpts;
    if (s.skyAtmosphere) s.skyAtmosphere.show = !!q.atmosphere;
    s.globe.showGroundAtmosphere = !!q.atmosphere;
    s.fog.enabled = !!q.fog;
    s.globe.enableLighting = !!q.lighting;
    if (s.postProcessStages && s.postProcessStages.fxaa) s.postProcessStages.fxaa.enabled = !!q.fxaa;
    s.verticalExaggeration = Math.min(5, Math.max(1, Number(q.exaggeration) || 1));
    this.w.resolutionScale = Math.min(2, Math.max(0.5, Number(q.scale) || 1));
  }

  // ---- çizim kaynakları ----
  addSource(id, src) { this.data[id] = (src && src.data) || null; }
  addLayer(l) { this.layerDefs.push(l); }
  getSource(id) { return { setData: (d) => { this.data[id] = d; this._draw(id); } }; }
  _redrawAll() { for (const id of Object.keys(this.data)) this._draw(id); if (this.path3d) this.setPath3d(this.path3d); }

  // Yükseklik: clamp kipinde arazinin o noktadaki yüksekliği (yüklenmişse), değilse kalkış noktasının yüksekliği
  _ground(lon, lat) {
    if (!this.clamp) return this.base;
    const hgt = this.w.scene.globe.getHeight(this.C.Cartographic.fromDegrees(lon, lat));
    return Number.isFinite(hgt) ? hgt * (this.w.scene.verticalExaggeration || 1) : 0;
  }
  _pos(lon, lat, alt = 0) { return this.C.Cartesian3.fromDegrees(lon, lat, this._ground(lon, lat) + alt + (this.clamp ? 0.3 : 0)); }

  _setBase(lon, lat) {
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}|${this.terrainMode}`;
    if (key === this.baseKey || this.terrainMode === 'off' || this.clamp) return;
    this.baseKey = key;
    const C = this.C;
    C.sampleTerrainMostDetailed(this.w.terrainProvider, [C.Cartographic.fromDegrees(lon, lat)]).then((r) => {
      if (this.removed || this.baseKey !== key || !r[0] || !Number.isFinite(r[0].height)) return;
      this.base = r[0].height;
      this._redrawAll();
    }).catch(() => {});
  }

  _clear(key) {
    for (const p of this.prims[key] || []) { if (p.kind === 'l') this.lines.remove(p.o); else this.points.remove(p.o); }
    this.prims[key] = [];
  }
  _addLine(key, positions, color, width, dashed) {
    const C = this.C;
    if (!positions || positions.length < 2) return;
    this.prims[key].push({ kind: 'l', o: this.lines.add({ positions, width, material: dashed ? C.Material.fromType('PolylineDash', { color, dashLength: 14 }) : C.Material.fromType('Color', { color }) }) });
  }
  _addPoint(key, position, color, size, outline) {
    this.prims[key].push({ kind: 'p', o: this.points.add({ position, color, pixelSize: size, outlineColor: outline || this.C.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY }) });
  }

  // Uçulan yol, irtifasıyla: [[lon, lat, alt]…]
  setPath3d(pts) {
    this.path3d = pts;
    this._clear('path3d');
    this._addLine('path3d', pts.map((q) => this._pos(q[0], q[1], q[2])), this.C.Color.fromCssColorString('#fbbf24'), 3);
  }

  _draw(id) {
    const C = this.C;
    const d = this.data[id];
    const feats = !d ? [] : d.type === 'FeatureCollection' ? d.features : [d];
    const col = (s, a) => { const c = C.Color.fromCssColorString(s || '#22d3ee'); return a === undefined ? c : c.withAlpha(a); };
    this._clear(id);
    if (id === 'home') { const f = feats[0]; if (f && f.geometry && f.geometry.type === 'Point') this._setBase(f.geometry.coordinates[0], f.geometry.coordinates[1]); }
    if (id === 'craft') {
      // aracın yere izdüşüm çizgisi
      const f = feats[0];
      const ring = f && f.geometry && f.geometry.coordinates && f.geometry.coordinates[0];
      if (ring && ring.length) {
        const lon = (ring[0][0] + ring[2][0]) / 2; const lat = (ring[0][1] + ring[2][1]) / 2;
        if (!this.baseKey) this._setBase(lon, lat);
        this._addLine(id, [this._pos(lon, lat, 0), this._pos(lon, lat, ((f.properties.base || 0) + (f.properties.top || 0)) / 2)], col('#f43f5e', 0.8), 1.5);
      }
      return;
    }
    if (id === 'track' && this.path3d) return; // uçuşta yol irtifasıyla çizilir
    for (const l of this.layerDefs) {
      if (l.source !== id) continue;
      const p = l.paint || {};
      for (const f of feats) {
        const g = f && f.geometry; const fp = (f && f.properties) || {};
        if (!g) continue;
        if (l.type === 'line' && g.type === 'LineString') this._addLine(id, g.coordinates.map((q) => this._pos(q[0], q[1], q[2] || 0)), col(fp.color || p['line-color'] || '#fbbf24'), p['line-width'] || 2, !!(p['line-dasharray'] || fp.dash));
        else if (l.type === 'fill' && g.type === 'Polygon' && g.coordinates[0]) this._addLine(id, g.coordinates[0].map((q) => this._pos(q[0], q[1], 0)), col(fp.color || p['fill-color'] || '#22d3ee'), 2.5, !!fp.dash);
        else if (l.type === 'circle' && g.type === 'Point') this._addPoint(id, this._pos(g.coordinates[0], g.coordinates[1], g.coordinates[2] || 0.5), col(p['circle-color'] || '#fff'), (p['circle-radius'] || 6) * 1.7, col(p['circle-stroke-color'] || '#fff'));
      }
    }
  }

  // ---- 3B araç modeli (uçuş): setVehicle({ lon, lat, alt, heading, pitch, roll, mavType }) ----
  setVehicle(v) {
    const C = this.C;
    const name = GLOBE_MODELS[v.mavType] || 'quad';
    if (this.vehicleName !== name) {
      this.vehicleName = name;
      const old = this.vehicle; this.vehicle = null;
      if (old) this.w.scene.primitives.remove(old);
      C.Model.fromGltfAsync({ url: `models/${name}.glb`, scale: 1.5, minimumPixelSize: 90, maximumScale: 6000, color: C.Color.fromCssColorString('#f43f5e'), colorBlendMode: C.ColorBlendMode.MIX, colorBlendAmount: 0.55 })
        .then((m) => { if (this.removed || this.vehicleName !== name) return; this.vehicle = this.w.scene.primitives.add(m); this._fire('vehicle', true); })
        .catch((e) => { console.warn('3B model yüklenemedi:', e && e.message); this._fire('vehicle', false); });
    }
    if (!this.vehicle) return false;
    const pos = this._pos(v.lon, v.lat, v.alt);
    const hpr = new C.HeadingPitchRoll(C.Math.toRadians(v.heading || 0), C.Math.toRadians(v.pitch || 0), C.Math.toRadians(v.roll || 0));
    this.vehicle.modelMatrix = C.Transforms.headingPitchRollToFixedFrame(pos, hpr);
    return true;
  }

  // ---- görünüm ----
  project(lng, lat, alt = 0) {
    const sc = this.w.scene;
    const xy = sc.cartesianToCanvasCoordinates(this._pos(lng, lat, alt));
    return xy ? [xy.x, xy.y] : [-9999, -9999];
  }
  unproject(x, y) {
    const C = this.C;
    const ray = this.w.camera.getPickRay(new C.Cartesian2(x, y));
    const p = ray && this.w.scene.globe.pick(ray, this.w.scene);
    if (!p) return null;
    const g = C.Cartographic.fromCartesian(p);
    return { lng: C.Math.toDegrees(g.longitude), lat: C.Math.toDegrees(g.latitude) };
  }
  getCenter() {
    const cv = this.w.canvas;
    const ll = this.unproject(cv.clientWidth / 2, cv.clientHeight / 2);
    if (ll) return ll;
    const g = this.C.Cartographic.fromCartesian(this.w.camera.position);
    return { lng: this.C.Math.toDegrees(g.longitude), lat: this.C.Math.toDegrees(g.latitude) };
  }
  // Görünen bölge: { south, west, north, east } (çevrimdışı indirme için)
  getBounds() {
    const C = this.C;
    const r = this.w.camera.computeViewRectangle();
    if (!r) return null;
    return { south: C.Math.toDegrees(r.south), west: C.Math.toDegrees(r.west), north: C.Math.toDegrees(r.north), east: C.Math.toDegrees(r.east) };
  }
  // Kamera yüksekliği ↔ web haritası yakınlaştırma düzeyi (yaklaşık)
  _height() { return Math.max(1, this.C.Cartographic.fromCartesian(this.w.camera.position).height - (this.clamp ? 0 : this.base)); }
  getZoom() {
    const c = this.getCenter();
    const mpp = (this._height() * 2 * Math.tan((this.w.camera.frustum.fovy || 1) / 2)) / Math.max(1, this.w.canvas.clientHeight);
    return Math.max(1, Math.min(22, Math.log2((156543.03 * Math.cos((c.lat * Math.PI) / 180)) / mpp)));
  }
  _heightFor(zoom, lat) { const mpp = (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom; return (mpp * Math.max(1, this.w.canvas.clientHeight || 800)) / (2 * Math.tan((this.w.camera.frustum.fovy || 1) / 2)); }
  getPitch() { return 90 + this.C.Math.toDegrees(this.w.camera.pitch); }
  isEasing() { return false; }
  isMoving() { return this.dragging; }
  resize() { if (!this.removed) this.w.resize(); }
  remove() { this.removed = true; clearInterval(this.clampTimer); try { this.input.destroy(); this.w.destroy(); } catch { /* yok */ } this.el.classList.remove('globe-map'); this.el.innerHTML = ''; }

  // center [lon, lat, alt?]; zoom verilirse (ya da üstten bakışta) kamera o noktanın üstüne yerleşir,
  // verilmezse kamera hedefle birlikte ötelenir (izleme: kullanıcının bakış açısı ve uzaklığı korunur)
  jumpTo(o) {
    if (!o.center || this.removed) return;
    const C = this.C;
    if (this.topDown || (Number.isFinite(o.zoom) && this.topDownOnce)) {
      const z = Number.isFinite(o.zoom) ? o.zoom : this.getZoom();
      this.w.camera.setView({ destination: C.Cartesian3.fromDegrees(o.center[0], o.center[1], this._heightFor(z, o.center[1]) + this._ground(o.center[0], o.center[1])), orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 } });
      return;
    }
    const target = this._pos(o.center[0], o.center[1], Number.isFinite(o.center[2]) ? o.center[2] : 0);
    if (!this.lastTarget || C.Cartesian3.distance(target, this.lastTarget) > 20000) {
      this.w.camera.lookAt(target, new C.HeadingPitchRange(0, C.Math.toRadians(-30), 450));
      this.w.camera.lookAtTransform(C.Matrix4.IDENTITY);
    } else {
      this.w.camera.position = C.Cartesian3.add(this.w.camera.position, C.Cartesian3.subtract(target, this.lastTarget, new C.Cartesian3()), new C.Cartesian3());
    }
    this.lastTarget = target;
  }
  easeTo(o) {
    if (!o.center) return;
    if (this.topDown) { const C = this.C; const z = Number.isFinite(o.zoom) ? o.zoom : this.getZoom(); this.w.camera.flyTo({ destination: C.Cartesian3.fromDegrees(o.center[0], o.center[1], this._heightFor(z, o.center[1]) + this._ground(o.center[0], o.center[1])), orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 }, duration: 0.5 }); return; }
    this.lastTarget = null; this.jumpTo(o);
  }
  zoomIn() { this.w.camera.zoomIn(this._height() * 0.4); }
  zoomOut() { this.w.camera.zoomOut(this._height() * 0.7); }
  fitBounds(points) {
    if (!points || !points.length) return;
    const C = this.C;
    let a = Infinity; let b = -Infinity; let c = Infinity; let d = -Infinity;
    for (const [lo, la] of points) { a = Math.min(a, lo); b = Math.max(b, lo); c = Math.min(c, la); d = Math.max(d, la); }
    const pad = Math.max(0.0015, (b - a) * 0.3, (d - c) * 0.3);
    this.lastTarget = null;
    this.w.camera.flyTo({ destination: C.Rectangle.fromDegrees(a - pad, c - pad, b + pad, d + pad), duration: 0.6 });
  }
}

// Kürenin üstünde, ekran konumu her karede güncellenen DOM işareti. setLngLat([lon, lat, alt])
class GlobeMarker {
  constructor({ element }) { this.el = element; this.rot = 0; this.pos = null; this.map = null; Object.assign(this.el.style, { position: 'absolute', left: '0', top: '0' }); }
  setLngLat(p) { this.pos = p; if (this.map) this._place(); return this; }
  setRotation(deg) { this.rot = deg; return this; }
  addTo(map) {
    this.map = map; map.markers.add(this);
    if (!map.markerBox) { map.markerBox = document.createElement('div'); map.markerBox.className = 'flat-markers'; map.el.appendChild(map.markerBox); }
    map.markerBox.appendChild(this.el);
    this._place();
    return this;
  }
  remove() { if (this.map) this.map.markers.delete(this); this.el.remove(); this.map = null; }
  _place() {
    if (!this.map || !this.pos || this.map.removed) return;
    const C = this.map.C; const sc = this.map.w.scene;
    const world = this.map._pos(this.pos[0], this.pos[1], this.pos[2] || 0);
    const xy = sc.cartesianToCanvasCoordinates(world);
    const hidden = !xy || !new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, sc.camera.position).isPointVisible(world);
    this.el.style.display = hidden ? 'none' : '';
    if (!hidden) this.el.style.transform = `translate(${xy.x}px, ${xy.y}px) translate(-50%, -50%) rotate(${this.rot ? this.rot - C.Math.toDegrees(sc.camera.heading) : 0}deg)`;
  }
}
