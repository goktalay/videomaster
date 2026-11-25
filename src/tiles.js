'use strict';

// Harita karoları için disk önbelleği ve çevrimdışı indirme (ana süreç).
//   Pencereler karoları vdm://tiles/<kaynak>/<z>/<x>/<y> adresinden ister; karo diskte varsa oradan verilir, yoksa
//   asıl sunucudan indirilip diske yazılır. Böylece bir kez görüntülenen her yer internet yokken de açılır.
//   download(): bir bölgenin karolarını önceden indirir (çevrimdışı harita).
// Kaynaklar: sat (uydu), street (sokak), dem (arazi yüksekliği, terrarium PNG).

const fs = require('fs');
const path = require('path');

const BUILTIN = {
  sat: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  street: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  dem: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
};
const MAX_ZOOM = { sat: 19, street: 19, dem: 15 };
// Hazır uydu / sokak kaynaklarının kullanım koşulları toplu indirmeyi kısıtlar (OpenStreetMap: en çok 250 karo);
// kullanıcının kendi karo sunucusunda ve açık veri olan yükseklik karolarında bu sınır uygulanmaz.
const BULK_LIMIT = { sat: 250, street: 250 };
const HARD_LIMIT = 60000;

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => { const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };

// bbox: { south, west, north, east } → karo listesi [{ z, x, y }]
function tilesIn(bbox, zmin, zmax, cap = HARD_LIMIT + 1) {
  const out = [];
  for (let z = zmin; z <= zmax; z++) {
    const n = 2 ** z;
    const x0 = Math.max(0, lon2x(bbox.west, z)); const x1 = Math.min(n - 1, lon2x(bbox.east, z));
    const y0 = Math.max(0, lat2y(bbox.north, z)); const y1 = Math.min(n - 1, lat2y(bbox.south, z));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { out.push({ z, x, y }); if (out.length >= cap) return out; }
  }
  return out;
}

// opts: { dir: () => klasör, fetch(url) → Response, custom: () => ({ sat?, street?, dem? } özel adres kalıpları) }
function createTileCache(opts) {
  const fileOf = (source, z, x, y) => path.join(opts.dir(), source, String(z), String(x), `${y}.tile`);
  const urlOf = (source, z, x, y) => {
    const custom = (opts.custom && opts.custom()) || {};
    const tpl = typeof custom[source] === 'string' && custom[source] ? custom[source] : BUILTIN[source];
    return tpl ? tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y) : null;
  };
  const isCustom = (source) => { const c = (opts.custom && opts.custom()) || {}; return typeof c[source] === 'string' && !!c[source]; };
  const pending = new Map();
  let job = null;

  async function fetchTile(source, z, x, y) {
    const url = urlOf(source, z, x, y);
    if (!url) return null;
    const res = await opts.fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    const file = fileOf(source, z, x, y);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, buf);
    return buf;
  }

  // Karo: önce disk, yoksa ağ. Bulunamazsa null.
  async function get(source, z, x, y) {
    if (!BUILTIN[source] || ![z, x, y].every((v) => Number.isInteger(v) && v >= 0) || z > 22) return null;
    const file = fileOf(source, z, x, y);
    try { return await fs.promises.readFile(file); } catch { /* önbellekte yok */ }
    const key = `${source}/${z}/${x}/${y}`;
    if (!pending.has(key)) pending.set(key, fetchTile(source, z, x, y).catch(() => null).finally(() => pending.delete(key)));
    return pending.get(key);
  }
  const has = (source, z, x, y) => fs.existsSync(fileOf(source, z, x, y));

  // İndirme planı: kaynak başına karo sayısı ve sınır
  function plan({ sources, bbox, zmin, zmax }) {
    const out = {};
    for (const s of sources || []) {
      if (!BUILTIN[s]) continue;
      const hi = Math.min(zmax, MAX_ZOOM[s]); const lo = Math.min(zmin, hi);
      const count = tilesIn(bbox, lo, hi).length;
      const limit = isCustom(s) ? HARD_LIMIT : (BULK_LIMIT[s] || HARD_LIMIT);
      out[s] = { count, limit, allowed: count <= limit, zmin: lo, zmax: hi, custom: isCustom(s) };
    }
    return out;
  }

  // Bölge indirme. onProgress({ done, total, failed, source }); iptal: cancel()
  async function download({ sources, bbox, zmin, zmax }, onProgress) {
    if (job) return { ok: false, error: 'busy' };
    const p = plan({ sources, bbox, zmin, zmax });
    const list = [];
    for (const [s, info] of Object.entries(p)) { if (!info.allowed) return { ok: false, error: 'too_many', source: s, count: info.count, limit: info.limit }; for (const tl of tilesIn(bbox, info.zmin, info.zmax)) list.push({ s, ...tl }); }
    if (!list.length) return { ok: false, error: 'empty' };
    job = { cancelled: false };
    const me = job;
    let done = 0; let failed = 0; let i = 0;
    const worker = async () => {
      while (!me.cancelled && i < list.length) {
        const tl = list[i++];
        if (!has(tl.s, tl.z, tl.x, tl.y)) { const buf = await fetchTile(tl.s, tl.z, tl.x, tl.y).catch(() => null); if (!buf) failed++; }
        done++;
        if (onProgress && (done % 5 === 0 || done === list.length)) onProgress({ done, total: list.length, failed });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    job = null;
    return { ok: !me.cancelled, cancelled: me.cancelled, done, total: list.length, failed };
  }
  const cancel = () => { if (job) job.cancelled = true; };

  async function stats() {
    let files = 0; let bytes = 0;
    const walk = async (d) => { let ents; try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else { files++; try { bytes += (await fs.promises.stat(p)).size; } catch { /* yok */ } } } };
    await walk(opts.dir());
    return { files, bytes };
  }
  const clear = () => fs.promises.rm(opts.dir(), { recursive: true, force: true });

  return { get, has, plan, download, cancel, stats, clear };
}

module.exports = { createTileCache, tilesIn, BUILTIN, BULK_LIMIT, HARD_LIMIT, MAX_ZOOM };
