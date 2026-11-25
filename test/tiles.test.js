'use strict';

// Karo önbelleği ve çevrimdışı indirme; görev üreteçleri (kamera hesabı, yapı taraması, iniş deseni, arazi yardımcıları)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTileCache, tilesIn } = require('../src/tiles');
const MISSION = require('../src/drone/mission');

test('karo önbelleği: ilk istek ağdan, sonrakiler diskten; ağ yokken önbellekteki karo verilir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-tiles-'));
  let hits = 0; let online = true;
  const cache = createTileCache({ dir: () => dir, custom: () => ({ sat: 'http://x/{z}/{x}/{y}' }),
    fetch: async (url) => { hits++; if (!online) throw new Error('offline'); return { ok: true, arrayBuffer: async () => Buffer.from(`tile:${url}`) }; } });
  const a = await cache.get('sat', 3, 4, 5);
  assert.strictEqual(a.toString(), 'tile:http://x/3/4/5');
  assert.strictEqual((await cache.get('sat', 3, 4, 5)).toString(), a.toString());
  assert.strictEqual(hits, 1);
  online = false;
  assert.strictEqual((await cache.get('sat', 3, 4, 5)).toString(), a.toString()); // çevrimdışı: önbellekten
  assert.strictEqual(await cache.get('sat', 3, 4, 6), null);                      // önbellekte yok, ağ yok
  assert.strictEqual(await cache.get('nope', 1, 1, 1), null);
  assert.strictEqual(await cache.get('sat', 1, -1, 1), null);
  assert.deepStrictEqual(await cache.stats(), { files: 1, bytes: a.length });
  await cache.clear();
  assert.strictEqual((await cache.stats()).files, 0);
});

test('çevrimdışı indirme: bölge planı, hazır kaynaklarda toplu indirme sınırı, özel sunucuda sınırsız, ilerleme', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-tiles-'));
  let custom = {};
  let hits = 0;
  const cache = createTileCache({ dir: () => dir, custom: () => custom, fetch: async (url) => { hits++; return { ok: !/\/13\/0\//.test(url), arrayBuffer: async () => Buffer.from('x') }; } });
  const bbox = { south: 39.90, west: 32.80, north: 39.95, east: 32.90 };
  assert.strictEqual(tilesIn(bbox, 12, 12).length, 4);
  const p = cache.plan({ sources: ['sat', 'dem'], bbox, zmin: 12, zmax: 17 });
  assert.ok(p.sat.count > 250 && p.sat.allowed === false && p.sat.limit === 250);
  assert.strictEqual(p.dem.zmax, 15);       // yükseklik karoları 15. düzeyde biter
  assert.strictEqual(p.dem.allowed, true);  // açık veri: sınır yok
  const tooMany = await cache.download({ sources: ['sat'], bbox, zmin: 12, zmax: 17 });
  assert.deepStrictEqual([tooMany.ok, tooMany.error, tooMany.limit], [false, 'too_many', 250]);
  assert.strictEqual(hits, 0);
  const prog = [];
  const ok = await cache.download({ sources: ['sat'], bbox, zmin: 12, zmax: 14 }, (x) => prog.push(x));
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.total, tilesIn(bbox, 12, 14).length);
  assert.strictEqual(prog[prog.length - 1].done, ok.total);
  const again = hits;
  await cache.download({ sources: ['sat'], bbox, zmin: 12, zmax: 14 });
  assert.strictEqual(hits, again); // önbellektekiler yeniden indirilmez
  custom = { sat: 'http://mine/{z}/{x}/{y}' };
  assert.strictEqual(cache.plan({ sources: ['sat'], bbox, zmin: 12, zmax: 17 }).sat.allowed, true); // kendi sunucusu
});

test('görev üreteçleri: kamera hesabı, yapı taraması, iniş deseni, ara nokta ekleme ve seyreltme, desen tanımları', () => {
  const p4p = MISSION.CAMERAS.find((c) => c.id === 'p4p');
  const c = MISSION.cameraCalc(p4p, 100, 70, 80);
  assert.ok(Math.abs(c.footW - 150) < 1e-9 && Math.abs(c.footH - 100) < 1e-9);
  assert.ok(Math.abs(c.spacing - 45) < 1e-9 && Math.abs(c.trigger - 20) < 1e-9);
  assert.ok(Math.abs(c.gsd - 2.741) < 0.01);
  assert.ok(MISSION.cameraCalc(p4p, 50, 70, 80).spacing < c.spacing); // alçaldıkça hatlar sıklaşır
  for (const cam of MISSION.CAMERAS) assert.ok(cam.sensorW > 0 && cam.sensorH > 0 && cam.focal > 0 && cam.imageW > 0, cam.id);

  const st = MISSION.structure({ lat: 39.9, lon: 32.8, radius: 30, bottom: 10, top: 40, layers: 4, points: 8 });
  assert.strictEqual(st.length, 4 * 9);
  assert.deepStrictEqual([...new Set(st.map((q) => q[2]))], [10, 20, 30, 40]);
  for (const q of st) assert.ok(Math.abs(MISSION.distance(39.9, 32.8, q[0], q[1]) - 30) < 0.5);

  const lp = MISSION.landingPattern({ lat: 39.9, lon: 32.8, heading: 90, distance: 400, alt: 40 });
  assert.ok(Math.abs(MISSION.distance(39.9, 32.8, lp.approach.lat, lp.approach.lon) - 400) < 2);
  assert.ok(Math.abs(MISSION.bearing(lp.approach.lat, lp.approach.lon, 39.9, 32.8) - 90) < 0.5); // yaklaşma noktasından inişe yön = iniş yönü
  assert.ok(Math.abs(lp.glide - 5.71) < 0.05);

  const dense = MISSION.densify([[39.9, 32.8], [39.9, 32.803]], 50);
  assert.strictEqual(dense.filter((q) => q[2]).length, 5);
  assert.strictEqual(dense[0][2], false);
  const thin = MISSION.thin([{ alt: 10 }, { alt: 12, mid: true }, { alt: 14, mid: true }, { alt: 40, mid: true }, { alt: 18 }]);
  assert.deepStrictEqual(thin.map((q) => q.alt), [10, 40, 18]); // doğrusal gidişten sapmayan ara noktalar atılır

  const m = MISSION.normalize({ name: 'x', items: [{ type: 'waypoint', lat: 1, lon: 1, group: 'g1' }], patterns: { g1: { kind: 'survey', args: { polygon: [[1, 1], [1, 2], [2, 2]], spacing: 30 } }, bos: { kind: 'survey', args: {} }, kotu: { kind: 'hack', args: {} } } });
  assert.deepStrictEqual(Object.keys(m.patterns), ['g1']);
  assert.ok(MISSION.KEYS.includes('patterns'));
});
