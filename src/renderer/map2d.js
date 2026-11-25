'use strict';

// Sade 2B harita: WebGL gerektirmez (karolar <img>, çizimler 2B tuval). 3B harita (MapLibre) açılamadığında ya da
// kullanıcı "2B harita"yı seçtiğinde kullanılır. flight.js'in MapLibre'den kullandığı arayüzün aynısını sunar:
// on/once, addSource/getSource().setData, addLayer, setLayoutProperty, jumpTo/easeTo, getCenter/getZoom, zoomIn/zoomOut,
// resize, isEasing, isMoving, dragPan.isActive, remove ve FlatMarker (setLngLat, setRotation, addTo, remove).

const FLAT_TILE = 256;
const flatX = (lon, z) => ((lon + 180) / 360) * FLAT_TILE * 2 ** z;
const flatY = (lat, z) => { const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * FLAT_TILE * 2 ** z; };
const flatLon = (x, z) => (x / (FLAT_TILE * 2 ** z)) * 360 - 180;
const flatLat = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / (FLAT_TILE * 2 ** z); return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

class FlatMap {
  // opts: { container (id ya da öğe), center [lon, lat], zoom, sources: { ad: { tiles: [url], maxzoom, attribution } }, visible: 'ad' }
  constructor(opts) {
    this.el = typeof opts.container === 'string' ? document.getElementById(opts.container) : opts.container;
    this.center = { lng: opts.center[0], lat: opts.center[1] };
    this.zoom = opts.zoom || 4;
    // sources: [{ id, maxzoom, credit }] (ortak karo önbelleği) ya da eski biçim { ad: { tiles, maxzoom } }
    this.rasters = {};
    if (Array.isArray(opts.sources)) for (const q of opts.sources) this.rasters[q.id] = { tiles: [`vdm://tiles/${q.id}/{z}/{x}/{y}`], maxzoom: q.maxzoom, attribution: q.credit };
    else Object.assign(this.rasters, opts.sources || {});
    this.visible = opts.source || opts.visible || Object.keys(this.rasters)[0];
    this.source = this.visible;
    this.data = {};       // geojson kaynakları
    this.layers = [];     // { id, type, source, paint }
    this.handlers = {};
    this.markers = new Set();
    this.tiles = new Map(); // anahtar → img
    this.dragging = false;
    this.dblZoom = opts.dblZoom !== false; // false: çift tıklama yakınlaştırmaz, 'dblclick' olayı yayılır
    this.anim = null;
    this.el.classList.add('flat-map');
    this.el.innerHTML = '<div class="flat-tiles"></div><canvas class="flat-draw"></canvas><div class="flat-markers"></div><div class="flat-attrib"></div>';
    [this.tileBox, this.canvas, this.markerBox, this.attrib] = this.el.children;
    this._bind();
    this.dragPan = { isActive: () => this.dragging };
    requestAnimationFrame(() => { this._fire('style.load'); this._fire('load'); this.draw(); });
  }

  on(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); return this; }
  once(name, fn) { const w = (e) => { this.handlers[name] = this.handlers[name].filter((x) => x !== w); fn(e); }; return this.on(name, w); }
  _fire(name, e) { for (const fn of (this.handlers[name] || []).slice()) { try { fn(e); } catch (err) { console.error(err); } } }

  addSource(id, src) { this.data[id] = src.data || null; }
  getSource(id) { return { setData: (d) => { this.data[id] = d; this._later(); } }; }
  addLayer(l) { this.layers.push(l); }
  setLayoutProperty(id, prop, value) { if (prop === 'visibility' && value === 'visible' && this.rasters[id]) { this.visible = id; this.source = id; for (const img of this.tiles.values()) img.remove(); this.tiles.clear(); this._later(); } }
  setTerrain() {}
  setScene() {}
  setSource(id) { this.setLayoutProperty(id, 'visibility', 'visible'); }
  getBounds() { const w = this.el.clientWidth; const h = this.el.clientHeight; const a = this.unproject(0, 0); const b = this.unproject(w, h); return { north: a.lat, west: a.lng, south: b.lat, east: b.lng }; }
  getCenter() { return { lng: this.center.lng, lat: this.center.lat }; }
  getZoom() { return this.zoom; }
  getPitch() { return 0; }
  isEasing() { return !!this.anim; }
  isMoving() { return !!this.anim || this.dragging; }
  resize() { this._later(); }
  remove() { cancelAnimationFrame(this.anim); cancelAnimationFrame(this.raf); this.removed = true; for (const [n, fn] of this.winHandlers || []) removeEventListener(n, fn); this.el.classList.remove('flat-map'); this.el.innerHTML = ''; }

  jumpTo(o) { this._stop(); this._set(o); }
  easeTo(o) {
    this._stop();
    const from = { lng: this.center.lng, lat: this.center.lat, zoom: this.zoom };
    const to = { lng: o.center ? o.center[0] : from.lng, lat: o.center ? o.center[1] : from.lat, zoom: Number.isFinite(o.zoom) ? o.zoom : from.zoom };
    const dur = o.duration === undefined ? 300 : o.duration;
    if (!dur) { this._set({ center: [to.lng, to.lat], zoom: to.zoom }); return; }
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / dur);
      const e = 1 - (1 - k) ** 3;
      this._set({ center: [from.lng + (to.lng - from.lng) * e, from.lat + (to.lat - from.lat) * e], zoom: from.zoom + (to.zoom - from.zoom) * e });
      this.anim = k < 1 && !this.removed ? requestAnimationFrame(step) : null;
    };
    this.anim = requestAnimationFrame(step);
  }
  // Verilen noktaları ([lon, lat]…) görünüme sığdırır
  fitBounds(points, pad = 80) {
    if (!points || !points.length) return;
    let a = Infinity; let b = -Infinity; let c = Infinity; let d = -Infinity;
    for (const [lo, la] of points) { a = Math.min(a, lo); b = Math.max(b, lo); c = Math.min(c, la); d = Math.max(d, la); }
    const w = Math.max(50, this.el.clientWidth - pad * 2); const h = Math.max(50, this.el.clientHeight - pad * 2);
    let z = this._maxZoom();
    while (z > 2 && (flatX(b, z) - flatX(a, z) > w || flatY(c, z) - flatY(d, z) > h)) z -= 0.25;
    this.jumpTo({ center: [(a + b) / 2, flatLat((flatY(c, z) + flatY(d, z)) / 2, z)], zoom: points.length === 1 ? Math.min(z, 17) : z });
  }
  zoomIn() { this.easeTo({ zoom: this.zoom + 1 }); }
  zoomOut() { this.easeTo({ zoom: this.zoom - 1 }); }
  _stop() { if (this.anim) { cancelAnimationFrame(this.anim); this.anim = null; } }
  _set(o) {
    if (o.center) this.center = { lng: o.center[0], lat: Math.max(-85, Math.min(85, o.center[1])) };
    if (Number.isFinite(o.zoom)) this.zoom = Math.max(2, Math.min(this._maxZoom() + 2, o.zoom));
    this._later();
    this._fire('move');
  }
  _maxZoom() { const r = this.rasters[this.visible]; return (r && r.maxzoom) || 19; }
  _later() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = null; if (!this.removed) this.draw(); }); }

  // ekran pikseli ↔ coğrafi konum
  project(lng, lat) {
    const w = this.el.clientWidth; const h = this.el.clientHeight;
    return [flatX(lng, this.zoom) - flatX(this.center.lng, this.zoom) + w / 2, flatY(lat, this.zoom) - flatY(this.center.lat, this.zoom) + h / 2];
  }
  unproject(x, y) {
    const w = this.el.clientWidth; const h = this.el.clientHeight;
    return { lng: flatLon(flatX(this.center.lng, this.zoom) + x - w / 2, this.zoom), lat: flatLat(flatY(this.center.lat, this.zoom) + y - h / 2, this.zoom) };
  }

  _bind() {
    const pos = (e) => { const r = this.el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    let down = null;
    this.el.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.flat-attrib')) return;
      down = { x: e.clientX, y: e.clientY, cx: flatX(this.center.lng, this.zoom), cy: flatY(this.center.lat, this.zoom), moved: false };
    });
    const move = (e) => {
      if (!down) return;
      const dx = e.clientX - down.x; const dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) < 4) return;
      if (!down.moved) { down.moved = true; this.dragging = true; this._stop(); this._fire('dragstart'); }
      this._set({ center: [flatLon(down.cx - dx, this.zoom), flatLat(down.cy - dy, this.zoom)] });
    };
    const up = (e) => {
      if (!down) return;
      const moved = down.moved; down = null; this.dragging = false;
      if (!moved && e.target && this.el.contains(e.target)) { const [x, y] = pos(e); this._fire('click', { lngLat: this.unproject(x, y), point: { x, y } }); }
    };
    this.winHandlers = [['mousemove', move], ['mouseup', up]];
    for (const [n, fn] of this.winHandlers) addEventListener(n, fn);
    this.el.addEventListener('contextmenu', (e) => { e.preventDefault(); const [x, y] = pos(e); this._fire('contextmenu', { lngLat: this.unproject(x, y), point: { x, y } }); });
    this.el.addEventListener('dblclick', (e) => { const [x, y] = pos(e); if (this.dblZoom) this._zoomAt(x, y, 1, 250); else this._fire('dblclick', { lngLat: this.unproject(x, y), point: { x, y } }); });
    this.el.addEventListener('mousemove', (e) => { if (this.handlers.mousemove && !down) { const [x, y] = pos(e); this._fire('mousemove', { lngLat: this.unproject(x, y), point: { x, y } }); } });
    this.el.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = pos(e); this._zoomAt(x, y, -Math.sign(e.deltaY) * (e.ctrlKey ? 0.5 : 0.35), 0); }, { passive: false });
  }
  // İmlecin altındaki nokta yerinde kalacak biçimde yakınlaştırır
  _zoomAt(x, y, dz, duration) {
    const at = this.unproject(x, y);
    const z = Math.max(2, Math.min(this._maxZoom() + 2, this.zoom + dz));
    const w = this.el.clientWidth; const h = this.el.clientHeight;
    const center = [flatLon(flatX(at.lng, z) - (x - w / 2), z), flatLat(flatY(at.lat, z) - (y - h / 2), z)];
    if (duration) this.easeTo({ center, zoom: z, duration }); else this.jumpTo({ center, zoom: z });
  }

  draw() {
    const w = this.el.clientWidth; const h = this.el.clientHeight;
    if (!w || !h) return;
    // --- karolar ---
    const src = this.rasters[this.visible];
    const used = new Set();
    if (src) {
      const z = Math.max(0, Math.min(this._maxZoom(), Math.round(this.zoom)));
      const scale = 2 ** (this.zoom - z);
      const cx = flatX(this.center.lng, z); const cy = flatY(this.center.lat, z);
      const n = 2 ** z;
      const x0 = Math.floor((cx - w / 2 / scale) / FLAT_TILE); const x1 = Math.floor((cx + w / 2 / scale) / FLAT_TILE);
      const y0 = Math.max(0, Math.floor((cy - h / 2 / scale) / FLAT_TILE)); const y1 = Math.min(n - 1, Math.floor((cy + h / 2 / scale) / FLAT_TILE));
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const key = `${this.visible}/${z}/${tx}/${ty}`;
          used.add(key);
          let img = this.tiles.get(key);
          if (!img) {
            img = new Image();
            img.draggable = false;
            img.crossOrigin = 'anonymous'; // pencere COEP ile yalıtılmış: başka kaynaktan görseller CORS ile istenmeli
            img.onerror = () => { img.style.visibility = 'hidden'; this._fire('error', { error: new Error('tile') }); };
            img.src = src.tiles[0].replace('{z}', z).replace('{x}', ((tx % n) + n) % n).replace('{y}', ty);
            this.tiles.set(key, img);
            this.tileBox.appendChild(img);
          }
          const s = img.style;
          s.left = `${Math.round((tx * FLAT_TILE - cx) * scale + w / 2)}px`;
          s.top = `${Math.round((ty * FLAT_TILE - cy) * scale + h / 2)}px`;
          s.width = s.height = `${Math.ceil(FLAT_TILE * scale) + 1}px`;
        }
      }
      this.attrib.textContent = src.attribution || '';
    }
    for (const [key, img] of this.tiles) if (!used.has(key)) { img.remove(); this.tiles.delete(key); }

    // --- çizimler (iz, hedef, ev) ---
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = this.canvas;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.lineJoin = 'round'; g.lineCap = 'round';
    for (const l of this.layers) {
      const d = this.data[l.source];
      if (!d || (l.type !== 'line' && l.type !== 'circle' && l.type !== 'fill')) continue;
      const feats = d.type === 'FeatureCollection' ? d.features : [d];
      const p = l.paint || {};
      for (const f of feats) {
        const geo = f && f.geometry;
        if (!geo) continue;
        const fp = f.properties || {};
        if (l.type === 'fill' && geo.type === 'Polygon' && geo.coordinates[0] && geo.coordinates[0].length > 2) {
          g.beginPath();
          geo.coordinates[0].forEach((q, i) => { const [x, y] = this.project(q[0], q[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
          g.closePath();
          g.globalAlpha = fp.opacity || p['fill-opacity'] || 0.2; g.fillStyle = fp.color || p['fill-color'] || '#22d3ee'; g.fill(); g.globalAlpha = 1;
          g.setLineDash(fp.dash ? [6, 5] : []); g.lineWidth = 2; g.strokeStyle = fp.color || p['fill-outline-color'] || p['fill-color'] || '#22d3ee'; g.stroke(); g.setLineDash([]);
        } else if (l.type === 'line' && geo.type === 'LineString' && geo.coordinates.length > 1) {
          g.beginPath();
          geo.coordinates.forEach((q, i) => { const [x, y] = this.project(q[0], q[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
          g.setLineDash(p['line-dasharray'] ? p['line-dasharray'].map((v) => v * (p['line-width'] || 2)) : []);
          g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = (p['line-width'] || 2) + 2; g.stroke();
          g.strokeStyle = fp.color || p['line-color'] || '#fbbf24'; g.lineWidth = p['line-width'] || 2; g.stroke();
          g.setLineDash([]);
        } else if (l.type === 'circle' && geo.type === 'Point') {
          const [x, y] = this.project(geo.coordinates[0], geo.coordinates[1]);
          g.beginPath(); g.arc(x, y, p['circle-radius'] || 6, 0, Math.PI * 2);
          g.fillStyle = p['circle-color'] || '#fff'; g.fill();
          if (p['circle-stroke-width']) { g.lineWidth = p['circle-stroke-width']; g.strokeStyle = p['circle-stroke-color'] || '#000'; g.stroke(); }
        }
      }
    }
    for (const m of this.markers) m._place();
  }
}

class FlatMarker {
  constructor({ element }) { this.el = element; this.rot = 0; this.pos = null; this.map = null; this.el.style.position = 'absolute'; this.el.style.left = '0'; this.el.style.top = '0'; }
  setLngLat(p) { this.pos = p; this._place(); return this; }
  setRotation(deg) { this.rot = deg; this._place(); return this; }
  addTo(map) { this.map = map; map.markers.add(this); map.markerBox.appendChild(this.el); this._place(); return this; }
  remove() { if (this.map) this.map.markers.delete(this); this.el.remove(); this.map = null; }
  _place() {
    if (!this.map || !this.pos) return;
    const [x, y] = this.map.project(this.pos[0], this.pos[1]);
    this.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) rotate(${this.rot}deg)`;
  }
}
