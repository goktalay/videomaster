'use strict';

// Arazi yüksekliği: terrarium PNG karolarından (vdm://tiles/dem — disk önbellekli) deniz seviyesine göre yükseklik okur.
//   await Terrain.at(lat, lon) → metre | null (veri yoksa);  await Terrain.many([[lat, lon]…]) → [metre | null…]
const Terrain = (() => {
  const Z = 12; // ~25–35 m/piksel (orta enlemlerde)
  const cache = new Map(); // "x/y" → Promise<Uint8ClampedArray | null>
  function tile(x, y) {
    const key = `${x}/${y}`;
    if (!cache.has(key)) {
      cache.set(key, new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            const c = document.createElement('canvas'); c.width = 256; c.height = 256;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(img, 0, 0, 256, 256);
            resolve(g.getImageData(0, 0, 256, 256).data);
          } catch { resolve(null); }
        };
        img.onerror = () => { cache.delete(key); resolve(null); }; // sonra yeniden denenebilsin
        img.src = `vdm://tiles/dem/${Z}/${x}/${y}`;
      }));
      if (cache.size > 400) cache.delete(cache.keys().next().value);
    }
    return cache.get(key);
  }
  const px = (d, x, y) => { const i = (Math.min(255, Math.max(0, y)) * 256 + Math.min(255, Math.max(0, x))) * 4; return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768; };
  async function at(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const n = 2 ** Z;
    const fx = ((lon + 180) / 360) * n;
    const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
    const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
    const tx = Math.floor(fx); const ty = Math.floor(fy);
    const d = await tile(tx, ty);
    if (!d) return null;
    // karo içinde çift doğrusal aradeğer
    const u = (fx - tx) * 256 - 0.5; const v = (fy - ty) * 256 - 0.5;
    const x0 = Math.floor(u); const y0 = Math.floor(v); const a = u - x0; const b = v - y0;
    const e = px(d, x0, y0) * (1 - a) * (1 - b) + px(d, x0 + 1, y0) * a * (1 - b) + px(d, x0, y0 + 1) * (1 - a) * b + px(d, x0 + 1, y0 + 1) * a * b;
    return Math.round(e * 10) / 10;
  }
  const many = (points) => Promise.all(points.map((q) => at(q[0], q[1])));
  return { at, many };
})();
