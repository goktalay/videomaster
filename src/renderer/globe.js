'use strict';

// 3B küre haritası (CesiumJS): gerçek arazi kabartmasıyla uçuş görünümü. flight.js'in diğer haritalarla (MapLibre,
// FlatMap) ortak kullandığı arayüzü sunar: on/once, addSource/getSource().setData, addLayer, setLayoutProperty,
// jumpTo/easeTo, getCenter, zoomIn/zoomOut, resize, isEasing, dragPan.isActive, fitBounds, remove ve GlobeMarker.
//   Uydu / sokak görüntüsü uygulamanın kendi karo önbelleğinden (vdm://tiles) gelir.
//   Arazi: Cesium ion erişim anahtarı verilirse Cesium World Terrain; verilmezse düz elipsoit.
//   Yükseklikler: araç irtifası kalkış noktasına göredir; kalkış noktasının arazi yüksekliği örneklenip üstüne eklenir.
// Cesium kitaplığı ilk kullanımda yüklenir (GlobeMap.load()).

const GLOBE_BASE = '../vendor/cesium/';

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

  // opts: { container, center [lon, lat], token, sources: { sat: { tiles, maxzoom }, street: … }, visible }
  constructor(opts) {
    const C = window.Cesium;
    this.C = C;
    this.el = typeof opts.container === 'string' ? document.getElementById(opts.container) : opts.container;
    this.handlers = {};
    this.data = {};
    this.markers = new Set();
    this.base = 0;          // kalkış noktasındaki arazi yüksekliği (elipsoide göre)
    this.baseKey = '';
    this.dragging = false;
    this.lastTarget = null; // izleme: kameranın bağlı olduğu son konum
    this.removed = false;
    this.el.classList.add('globe-map');
    if (opts.token) C.Ion.defaultAccessToken = opts.token;
    this.hasTerrain = !!opts.token;
    const w = new C.CesiumWidget(this.el, {
      baseLayer: false, skyAtmosphere: new C.SkyAtmosphere(), scene3DOnly: true, requestRenderMode: false,
      terrain: opts.token ? C.Terrain.fromWorldTerrain() : undefined,
    });
    this.w = w;
    this.layers = {};
    for (const [id, src] of Object.entries(opts.sources || {})) {
      const layer = w.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({ url: src.tiles[0], maximumLevel: src.maxzoom || 19, credit: src.attribution || '' }));
      layer.show = id === (opts.visible || 'sat');
      layer.imageryProvider.errorEvent.addEventListener(() => this._fire('error', { error: new Error('tile') }));
      this.layers[id] = layer;
    }
    w.scene.globe.depthTestAgainstTerrain = true;
    if (w.terrain && w.terrain.errorEvent) w.terrain.errorEvent.addEventListener((e) => { this.hasTerrain = false; this._fire('terrainerror', e); });
    // çizimler
    this.lines = w.scene.primitives.add(new C.PolylineCollection());
    this.points = w.scene.primitives.add(new C.PointPrimitiveCollection());
    this.prim = {};
    const c = opts.center || [32.8663, 39.9255];
    w.camera.setView({ destination: C.Cartesian3.fromDegrees(c[0], c[1] - 0.35, 60000), orientation: { heading: 0, pitch: C.Math.toRadians(-55), roll: 0 } });

    const h = new C.ScreenSpaceEventHandler(w.canvas);
    this.input = h;
    const pick = (pos) => { const ray = w.camera.getPickRay(pos); const p = ray && w.scene.globe.pick(ray, w.scene); if (!p) return null; const g = C.Cartographic.fromCartesian(p); return { lng: C.Math.toDegrees(g.longitude), lat: C.Math.toDegrees(g.latitude) }; };
    h.setInputAction((e) => { const ll = pick(e.position); if (ll) this._fire('click', { lngLat: ll, point: e.position }); }, C.ScreenSpaceEventType.LEFT_CLICK);
    h.setInputAction((e) => { const ll = pick(e.position); if (ll) this._fire('contextmenu', { lngLat: ll, point: e.position }); }, C.ScreenSpaceEventType.RIGHT_CLICK);
    let down = false;
    h.setInputAction(() => { down = true; }, C.ScreenSpaceEventType.LEFT_DOWN);
    h.setInputAction(() => { down = false; this.dragging = false; }, C.ScreenSpaceEventType.LEFT_UP);
    h.setInputAction(() => { if (down && !this.dragging) { this.dragging = true; this._fire('dragstart'); } }, C.ScreenSpaceEventType.MOUSE_MOVE);
    this.dragPan = { isActive: () => this.dragging };
    w.scene.postRender.addEventListener(() => { for (const m of this.markers) m._place(); });
    requestAnimationFrame(() => { if (!this.removed) { this._fire('style.load'); this._fire('load'); } });
  }

  on(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); return this; }
  once(name, fn) { const wr = (e) => { this.handlers[name] = this.handlers[name].filter((x) => x !== wr); fn(e); }; return this.on(name, wr); }
  _fire(name, e) { for (const fn of (this.handlers[name] || []).slice()) { try { fn(e); } catch (err) { console.error(err); } } }

  addSource(id) { this.data[id] = null; }
  addLayer() {}
  setTerrain() {}
  getSource(id) { return { setData: (d) => { this.data[id] = d; this._draw(id); } }; }
  setLayoutProperty(id, prop, value) { if (prop === 'visibility' && this.layers[id]) this.layers[id].show = value === 'visible'; }
  resize() { if (!this.removed) this.w.resize(); }
  isEasing() { return false; }
  isMoving() { return this.dragging; }
  getZoom() { return 16; }
  getPitch() { return 60; }
  remove() { this.removed = true; try { this.input.destroy(); this.w.destroy(); } catch { /* yok */ } this.el.classList.remove('globe-map'); this.el.innerHTML = ''; }

  // Konum → dünya koordinatı (alt: kalkış noktasına göre metre)
  _pos(lon, lat, alt = 0) { return this.C.Cartesian3.fromDegrees(lon, lat, this.base + alt); }

  // Kalkış noktasının arazi yüksekliği: ev konumu değişince yeniden örneklenir
  _setBase(lon, lat) {
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    if (key === this.baseKey || !this.hasTerrain) return;
    this.baseKey = key;
    const C = this.C;
    C.sampleTerrainMostDetailed(this.w.terrainProvider, [C.Cartographic.fromDegrees(lon, lat)]).then((r) => {
      if (this.removed || this.baseKey !== key || !r[0] || !Number.isFinite(r[0].height)) return;
      this.base = r[0].height;
      for (const id of Object.keys(this.data)) this._draw(id);
      if (this.path3d) this.setPath3d(this.path3d);
    }).catch(() => {});
  }

  _line(key, positions, color, width, dashed) {
    const C = this.C;
    if (this.prim[key]) { this.lines.remove(this.prim[key]); this.prim[key] = null; }
    if (!positions || positions.length < 2) return;
    this.prim[key] = this.lines.add({ positions, width, material: dashed ? C.Material.fromType('PolylineDash', { color, dashLength: 16 }) : C.Material.fromType('Color', { color }) });
  }
  _point(key, position, color, size) {
    if (this.prim[key]) { this.points.remove(this.prim[key]); this.prim[key] = null; }
    if (position) this.prim[key] = this.points.add({ position, color, pixelSize: size, outlineColor: this.C.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY });
  }

  // Uçulan yol, irtifasıyla: [[lon, lat, alt]…]
  setPath3d(pts) {
    this.path3d = pts;
    this._line('track', pts.map((q) => this._pos(q[0], q[1], q[2])), this.C.Color.fromCssColorString('#fbbf24'), 3);
  }

  _draw(id) {
    const C = this.C;
    const d = this.data[id];
    const feats = !d ? [] : d.type === 'FeatureCollection' ? d.features : [d];
    const col = (s) => C.Color.fromCssColorString(s);
    if (id === 'home') {
      const f = feats[0];
      if (f && f.geometry && f.geometry.type === 'Point') { const q = f.geometry.coordinates; this._setBase(q[0], q[1]); this._point('home', this._pos(q[0], q[1], 0.5), col('#34d399'), 12); } else this._point('home', null);
    } else if (id === 'craft') {
      // aracın yere izdüşüm çizgisi
      const f = feats[0];
      const ring = f && f.geometry && f.geometry.coordinates && f.geometry.coordinates[0];
      if (ring && ring.length) {
        const lon = (ring[0][0] + ring[2][0]) / 2; const lat = (ring[0][1] + ring[2][1]) / 2;
        const alt = ((f.properties.base || 0) + (f.properties.top || 0)) / 2;
        if (!this.baseKey) this._setBase(lon, lat);
        this._line('drop', [this._pos(lon, lat, 0), this._pos(lon, lat, alt)], col('#f43f5e').withAlpha(0.8), 1.5);
      } else this._line('drop', null);
    } else if (id === 'mission' || id === 'target') {
      const ln = feats.find((f) => f.geometry && f.geometry.type === 'LineString');
      const pt = feats.find((f) => f.geometry && f.geometry.type === 'Point');
      this._line(id, ln ? ln.geometry.coordinates.map((q) => this._pos(q[0], q[1], q[2] || 0)) : null, col(id === 'mission' ? '#f5d0fe' : '#a78bfa'), 2.5, true);
      if (id === 'target') this._point('targetPt', pt ? this._pos(pt.geometry.coordinates[0], pt.geometry.coordinates[1], pt.geometry.coordinates[2] || 0) : null, col('#a78bfa'), 12);
    }
  }

  getCenter() {
    const C = this.C; const cv = this.w.canvas;
    const ray = this.w.camera.getPickRay(new C.Cartesian2(cv.clientWidth / 2, cv.clientHeight / 2));
    const p = ray && this.w.scene.globe.pick(ray, this.w.scene);
    const g = C.Cartographic.fromCartesian(p || this.w.camera.position);
    return { lng: C.Math.toDegrees(g.longitude), lat: C.Math.toDegrees(g.latitude) };
  }

  // İzleme: kamera, hedefle birlikte ötelenir (kullanıcının seçtiği bakış açısı ve uzaklık korunur)
  jumpTo(o) {
    if (!o.center || this.removed) return;
    const C = this.C;
    const alt = Number.isFinite(o.center[2]) ? o.center[2] : 0;
    const target = this._pos(o.center[0], o.center[1], alt);
    if (!this.lastTarget || C.Cartesian3.distance(target, this.lastTarget) > 20000) {
      this.w.camera.lookAt(target, new C.HeadingPitchRange(0, C.Math.toRadians(-30), 450));
      this.w.camera.lookAtTransform(C.Matrix4.IDENTITY);
    } else {
      const delta = C.Cartesian3.subtract(target, this.lastTarget, new C.Cartesian3());
      this.w.camera.position = C.Cartesian3.add(this.w.camera.position, delta, new C.Cartesian3());
    }
    this.lastTarget = target;
  }
  easeTo(o) { if (o.center) { this.lastTarget = null; this.jumpTo(o); } }
  zoomIn() { const c = this.w.camera; c.zoomIn(this.C.Cartographic.fromCartesian(c.position).height * 0.35); }
  zoomOut() { const c = this.w.camera; c.zoomOut(this.C.Cartographic.fromCartesian(c.position).height * 0.5); }
  fitBounds(points) {
    if (!points || !points.length) return;
    const C = this.C;
    let a = Infinity; let b = -Infinity; let c = Infinity; let d = -Infinity;
    for (const [lo, la] of points) { a = Math.min(a, lo); b = Math.max(b, lo); c = Math.min(c, la); d = Math.max(d, la); }
    const pad = Math.max(0.002, (b - a) * 0.3, (d - c) * 0.3);
    this.lastTarget = null;
    this.w.camera.flyTo({ destination: C.Rectangle.fromDegrees(a - pad, c - pad, b + pad, d + pad), duration: 0.8 });
  }
}

// Kürenin üstünde, ekran konumu her karede güncellenen DOM işareti. setLngLat([lon, lat, alt])
class GlobeMarker {
  constructor({ element }) { this.el = element; this.rot = 0; this.pos = null; this.map = null; Object.assign(this.el.style, { position: 'absolute', left: '0', top: '0' }); }
  setLngLat(p) { this.pos = p; return this; }
  setRotation(deg) { this.rot = deg; return this; }
  addTo(map) {
    this.map = map; map.markers.add(this);
    if (!map.markerBox) { map.markerBox = document.createElement('div'); map.markerBox.className = 'flat-markers'; map.el.appendChild(map.markerBox); }
    map.markerBox.appendChild(this.el);
    return this;
  }
  remove() { if (this.map) this.map.markers.delete(this); this.el.remove(); this.map = null; }
  _place() {
    if (!this.map || !this.pos || this.map.removed) return;
    const C = this.map.C; const sc = this.map.w.scene;
    const world = this.map._pos(this.pos[0], this.pos[1], this.pos[2] || 0);
    const fn = sc.cartesianToCanvasCoordinates || C.SceneTransforms.worldToWindowCoordinates;
    const xy = sc.cartesianToCanvasCoordinates ? sc.cartesianToCanvasCoordinates(world) : fn(sc, world);
    // kürenin arkasında kalan işaret gizlenir
    const occluded = !xy || new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, sc.camera.position).isPointVisible(world) === false;
    this.el.style.display = occluded ? 'none' : '';
    if (!occluded) this.el.style.transform = `translate(${xy.x}px, ${xy.y}px) translate(-50%, -50%) rotate(${this.rot - C.Math.toDegrees(sc.camera.heading)}deg)`;
  }
}
