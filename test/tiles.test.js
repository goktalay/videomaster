'use strict';

// Karo önbelleği ve çevrimdışı indirme; görev üreteçleri (kamera hesabı, yapı taraması, iniş deseni, arazi yardımcıları)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTileCache, tilesIn, countIn, quadkey } = require('../src/tiles');
const MISSION = require('../src/drone/mission');

test('karo önbelleği: ilk istek ağdan, sonrakiler diskten; ağ yokken önbellekteki karo verilir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-tiles-'));
  let hits = 0; let online = true; const urls = [];
  const cache = createTileCache({ dir: () => dir, custom: () => ({ sat: 'http://x/{z}/{x}/{y}' }),
    fetch: async (url) => { hits++; urls.push(url); if (!online) throw new Error('offline'); return { ok: true, arrayBuffer: async () => Buffer.from(`tile:${url}`) }; } });
  const a = await cache.get('esri', 3, 4, 5); // "sat" özel adresi esri kaynağına uygulanır
  assert.strictEqual(a.toString(), 'tile:http://x/3/4/5');
  assert.strictEqual((await cache.get('sat', 3, 4, 5)).toString(), a.toString()); // eski ad aynı karoyu verir
  assert.strictEqual(hits, 1);
  online = false;
  assert.strictEqual((await cache.get('esri', 3, 4, 5)).toString(), a.toString()); // çevrimdışı: önbellekten
  assert.strictEqual(await cache.get('esri', 3, 4, 6), null);                      // önbellekte yok, ağ yok
  assert.strictEqual(await cache.get('nope', 1, 1, 1), null);
  assert.strictEqual(await cache.get('esri', 1, -1, 1), null);
  online = true;
  await cache.get('bing', 3, 3, 5); await cache.get('google', 2, 1, 1); await cache.get('google', 2, 1, 2);
  assert.match(urls.find((u) => /virtualearth/.test(u)), /tiles\/a213\.jpeg/);     // Bing quadkey
  assert.deepStrictEqual(urls.filter((u) => /google/.test(u)).map((u) => u.slice(0, 22)).length, 2);
  assert.notStrictEqual(urls.filter((u) => /google/.test(u))[0].slice(0, 12), urls.filter((u) => /google/.test(u))[1].slice(0, 12)); // alt alanlar sırayla
  const st = await cache.stats();
  assert.strictEqual(st.files, 4);
  assert.deepStrictEqual([st.sources.esri.count, st.sources.esri.zmin, st.sources.esri.zmax, st.sources.esri.name], [1, 3, 3, 'ESRI Uydu']);
  assert.strictEqual(st.sources.google.count, 2);
  await cache.clear('google');
  assert.strictEqual((await cache.stats()).sources.google, undefined);
  await cache.clear();
  assert.strictEqual((await cache.stats()).files, 0);
  assert.strictEqual(quadkey(3, 3, 5), '213');
  const list = cache.list();
  assert.strictEqual(list.length, 12);
  assert.ok(list.find((x) => x.id === 'esri').custom && !list.some((x) => x.id === 'dem'));
});

test('çevrimdışı indirme: görünen bölge için ön ölçüm, karo sınırı, ilerleme, önbellektekiler atlanır, iptal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-tiles-'));
  let hits = 0; let slow = false;
  const cache = createTileCache({ dir: () => dir, fetch: async (url) => { hits++; if (slow) await new Promise((r) => setTimeout(r, 15)); return { ok: !/tile\/13\/\d+\/4842$/.test(url), arrayBuffer: async () => Buffer.from('x') }; } });
  const bbox = { south: 39.90, west: 32.80, north: 39.95, east: 32.90 };
  assert.strictEqual(countIn(bbox, 12, 12), 4);
  assert.strictEqual([...tilesIn(bbox, 12, 13)].length, countIn(bbox, 12, 13));
  const est = cache.estimate({ source: 'esri', bbox, zmin: 12, zmax: 14 });
  assert.deepStrictEqual([est.total, est.over, est.limit], [countIn(bbox, 12, 14), false, 250000]);
  assert.ok(est.seconds >= 0 && est.bytes === est.total * 12000);
  assert.strictEqual(cache.estimate({ source: 'otm', bbox, zmin: 12, zmax: 19 }).zmax, 17); // kaynağın en yüksek düzeyiyle sınırlanır
  const big = { south: 36, west: 26, north: 42, east: 45 };
  assert.strictEqual(cache.estimate({ source: 'esri', bbox: big, zmin: 3, zmax: 16 }).over, true);
  const refused = await cache.download({ source: 'esri', bbox: big, zmin: 3, zmax: 16 });
  assert.deepStrictEqual([refused.ok, refused.error, refused.limit], [false, 'too_many', 250000]);
  assert.strictEqual(hits, 0);
  const prog = [];
  const ok = await cache.download({ source: 'esri', bbox, zmin: 12, zmax: 14 }, (x) => prog.push(x));
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.total, est.total);
  assert.deepStrictEqual([prog[prog.length - 1].done, prog[prog.length - 1].active], [ok.total, false]);
  const again = hits;
  const second = await cache.download({ source: 'esri', bbox, zmin: 12, zmax: 14 });
  assert.strictEqual(hits, again + second.failed); // önbellektekiler yeniden indirilmez
  slow = true;
  const p = cache.download({ source: 'osm', bbox, zmin: 12, zmax: 16 });
  assert.strictEqual((await cache.download({ source: 'osm', bbox, zmin: 12, zmax: 12 })).error, 'busy'); // aynı anda tek indirme
  setTimeout(() => cache.cancel(), 40);
  const stopped = await p;
  assert.deepStrictEqual([stopped.ok, stopped.cancelled], [false, true]);
  assert.ok(stopped.done < stopped.total);
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
