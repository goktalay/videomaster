'use strict';

// Ortak harita karo altyapısı (ana süreç): bütün haritalar (uçuş, görev düzenleyici) karoları buradan alır.
//   Pencereler vdm://tiles/<kaynak>/<z>/<x>/<y> ister; karo diskte varsa oradan verilir, yoksa asıl sunucudan indirilip
//   diske yazılır (dosya: <klasör>/<kaynak>/<z>/<x>/<y>.tile). Bir kez görüntülenen her yer internet yokken de açılır;
//   "çevrimdışı" ayrı bir kip değildir, ağ isteğinin başarısız olması demektir. Bulunamayan karo null döner (→ 404).
//   download(): görünen bölgenin karolarını seçilen yakınlaştırma aralığında önceden indirir.
// Kaynak listesi ve işleyiş Göktungu yer istasyonundaki karo önbelleğiyle aynıdır (tile_cache.py).

const fs = require('fs');
const path = require('path');

// {s}: alt alan (sırayla seçilir), {q}: Bing quadkey
const SOURCES = {
  esri: { name: 'ESRI Uydu', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxzoom: 19, credit: 'Esri, Maxar, Earthstar Geographics' },
  esri_sokak: { name: 'ESRI Sokak', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', maxzoom: 19, credit: 'Esri' },
  esri_topo: { name: 'ESRI Topografik', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', maxzoom: 19, credit: 'Esri' },
  google: { name: 'Google Uydu', url: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', s: ['0', '1', '2', '3'], maxzoom: 20, credit: 'Google' },
  google_hibrit: { name: 'Google Hibrit', url: 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', s: ['0', '1', '2', '3'], maxzoom: 20, credit: 'Google' },
  google_yol: { name: 'Google Yol', url: 'https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', s: ['0', '1', '2', '3'], maxzoom: 20, credit: 'Google' },
  google_arazi: { name: 'Google Arazi', url: 'https://mt{s}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}', s: ['0', '1', '2', '3'], maxzoom: 20, credit: 'Google' },
  bing: { name: 'Bing Uydu', url: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=14891', s: ['0', '1', '2', '3'], maxzoom: 19, credit: 'Microsoft' },
  osm: { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxzoom: 19, credit: '© OpenStreetMap' },
  otm: { name: 'OpenTopoMap', url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', maxzoom: 17, credit: '© OpenTopoMap, © OpenStreetMap' },
  carto_acik: { name: 'CartoDB Açık', url: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', maxzoom: 19, credit: '© CARTO, © OpenStreetMap' },
  carto_koyu: { name: 'CartoDB Koyu', url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', maxzoom: 19, credit: '© CARTO, © OpenStreetMap' },
  // Arazi yüksekliği (terrarium PNG): yükseklik profili ve araziyi izleme için; harita katmanı olarak listelenmez
  dem: { name: 'Arazi yüksekliği', url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', maxzoom: 15, credit: 'AWS Terrain Tiles', hidden: true },
};
const ALIAS = { sat: 'esri', street: 'osm' }; // eski ayarlar ve özel sunucu anahtarları
const DOWNLOAD_LIMIT = 250000;  // tek indirmede en çok karo
const WORKERS = 8;
const EST_RATE = 4.9 * WORKERS; // ön ölçüm: karo/sn
const EST_BYTES = 12000;        // ön ölçüm: karo başına bayt

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => { const r = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
function quadkey(z, x, y) { let q = ''; for (let i = z; i > 0; i--) { let d = 0; const m = 1 << (i - 1); if (x & m) d += 1; if (y & m) d += 2; q += d; } return q; }

// bbox: { south, west, north, east } → her yakınlaştırma için karo aralıkları
function ranges(bbox, zmin, zmax) {
  const out = [];
  for (let z = zmin; z <= zmax; z++) {
    const n = 2 ** z;
    const x0 = Math.max(0, lon2x(bbox.west, z)); const x1 = Math.min(n - 1, lon2x(bbox.east, z));
    const y0 = Math.max(0, lat2y(bbox.north, z)); const y1 = Math.min(n - 1, lat2y(bbox.south, z));
    if (x1 >= x0 && y1 >= y0) out.push({ z, x0, x1, y0, y1 });
  }
  return out;
}
const countIn = (bbox, zmin, zmax) => ranges(bbox, zmin, zmax).reduce((a, r) => a + (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1), 0);
function* tilesIn(bbox, zmin, zmax) { for (const r of ranges(bbox, zmin, zmax)) for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield { z: r.z, x, y }; }

// opts: { dir: () => klasör, fetch(url) → Response, custom: () => ({ <kaynak>: adres kalıbı } özel sunucular) }
function createTileCache(opts) {
  const key = (s) => (SOURCES[s] ? s : ALIAS[s] && SOURCES[ALIAS[s]] ? ALIAS[s] : null);
  const fileOf = (source, z, x, y) => path.join(opts.dir(), source, String(z), String(x), `${y}.tile`);
  const customOf = (source) => { const c = (opts.custom && opts.custom()) || {}; const v = c[source] || Object.entries(ALIAS).filter(([, to]) => to === source).map(([from]) => c[from]).find(Boolean); return typeof v === 'string' && v ? v : null; };
  let turn = 0;
  function urlOf(source, z, x, y) {
    const def = SOURCES[source];
    const tpl = customOf(source) || def.url;
    const s = def.s ? def.s[turn++ % def.s.length] : '';
    return tpl.replace('{s}', s).replace('{q}', quadkey(z, x, y)).replace('{z}', z).replace('{x}', x).replace('{y}', y);
  }
  const pending = new Map();
  let job = null;
  let state = { active: false, total: 0, done: 0, failed: 0, cancelled: false, source: null };

  async function fetchTile(source, z, x, y) {
    const res = await opts.fetch(urlOf(source, z, x, y));
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    const file = fileOf(source, z, x, y);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now() % 100000}.tmp`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file); // yarım yazılmış karo okunmasın
    return buf;
  }

  // Karo: önce disk, yoksa ağ. Bulunamazsa null.
  async function get(src, z, x, y) {
    const source = key(src);
    if (!source || ![z, x, y].every((v) => Number.isInteger(v) && v >= 0) || z > 22) return null;
    try { const buf = await fs.promises.readFile(fileOf(source, z, x, y)); if (buf.length) return buf; } catch { /* önbellekte yok */ }
    const k = `${source}/${z}/${x}/${y}`;
    if (!pending.has(k)) pending.set(k, fetchTile(source, z, x, y).catch(() => null).finally(() => pending.delete(k)));
    return pending.get(k);
  }
  const has = (source, z, x, y) => { try { return fs.statSync(fileOf(source, z, x, y)).size > 0; } catch { return false; } };

  // Ön ölçüm: { total, limit, over, seconds, bytes, zmin, zmax }
  function estimate({ source, bbox, zmin, zmax }) {
    const s = key(source);
    if (!s || !bbox) return { total: 0, limit: DOWNLOAD_LIMIT, over: false, seconds: 0, bytes: 0 };
    const hi = Math.min(Math.max(zmin, zmax), SOURCES[s].maxzoom); const lo = Math.min(zmin, hi);
    const total = countIn(bbox, lo, hi);
    return { total, limit: DOWNLOAD_LIMIT, over: total > DOWNLOAD_LIMIT, seconds: Math.round(total / EST_RATE), bytes: total * EST_BYTES, zmin: lo, zmax: hi };
  }

  // Bölge indirme (aynı anda tek indirme). onProgress(state)
  async function download(q, onProgress) {
    if (job) return { ok: false, error: 'busy' };
    const source = key(q.source);
    if (!source) return { ok: false, error: 'invalid' };
    const est = estimate(q);
    if (est.over) return { ok: false, error: 'too_many', total: est.total, limit: est.limit };
    if (!est.total) return { ok: false, error: 'empty' };
    job = { cancelled: false };
    const me = job;
    state = { active: true, total: est.total, done: 0, failed: 0, cancelled: false, source };
    const it = tilesIn(q.bbox, est.zmin, est.zmax);
    let last = 0;
    const tick = (force) => { const now = Date.now(); if (onProgress && (force || state.done % 5 === 0 || now - last > 1000)) { last = now; onProgress({ ...state }); } };
    const worker = async () => {
      for (;;) {
        if (me.cancelled) return;
        const n = it.next();
        if (n.done) return;
        const tl = n.value;
        if (!has(source, tl.z, tl.x, tl.y)) { const buf = await fetchTile(source, tl.z, tl.x, tl.y).catch(() => null); if (!buf) state.failed++; }
        state.done++;
        tick(false);
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    job = null;
    state = { ...state, active: false, cancelled: me.cancelled };
    tick(true);
    return { ok: !me.cancelled, cancelled: me.cancelled, done: state.done, total: state.total, failed: state.failed };
  }
  const cancel = () => { if (job) job.cancelled = true; };

  // Önbellek bilgisi: toplam ve kaynak başına { count, bytes, zmin, zmax, last }
  async function stats() {
    const out = { files: 0, bytes: 0, sources: {}, download: { ...state } };
    let dirs = [];
    try { dirs = await fs.promises.readdir(opts.dir(), { withFileTypes: true }); } catch { return out; }
    for (const d of dirs) {
      if (!d.isDirectory() || !SOURCES[d.name]) continue;
      const s = { name: SOURCES[d.name].name, count: 0, bytes: 0, zmin: null, zmax: null, last: 0 };
      let zs = [];
      try { zs = await fs.promises.readdir(path.join(opts.dir(), d.name)); } catch { /* yok */ }
      for (const z of zs) {
        let xs = [];
        try { xs = await fs.promises.readdir(path.join(opts.dir(), d.name, z)); } catch { continue; }
        let any = false;
        for (const x of xs) {
          let ys = [];
          try { ys = await fs.promises.readdir(path.join(opts.dir(), d.name, z, x)); } catch { continue; }
          for (const y of ys) {
            if (!y.endsWith('.tile')) continue;
            try { const st = await fs.promises.stat(path.join(opts.dir(), d.name, z, x, y)); s.count++; s.bytes += st.size; if (st.mtimeMs > s.last) s.last = st.mtimeMs; any = true; } catch { /* yok */ }
          }
        }
        if (any) { const n = Number(z); s.zmin = s.zmin === null ? n : Math.min(s.zmin, n); s.zmax = s.zmax === null ? n : Math.max(s.zmax, n); }
      }
      if (s.count) { out.sources[d.name] = s; out.files += s.count; out.bytes += s.bytes; }
    }
    return out;
  }
  // Tüm önbelleği ya da tek kaynağı siler
  const clear = (source) => { const s = source ? key(source) : null; return fs.promises.rm(s ? path.join(opts.dir(), s) : opts.dir(), { recursive: true, force: true }); };
  // Harita katmanı olarak seçilebilen kaynaklar
  const list = () => Object.entries(SOURCES).filter(([, v]) => !v.hidden).map(([id, v]) => ({ id, name: v.name, maxzoom: v.maxzoom, credit: v.credit, custom: !!customOf(id) }));

  return { get, has, estimate, download, cancel, stats, clear, list, key };
}

module.exports = { createTileCache, tilesIn, countIn, quadkey, SOURCES, ALIAS, DOWNLOAD_LIMIT };
