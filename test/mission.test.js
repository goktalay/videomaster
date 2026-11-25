'use strict';

// MAVLink görev protokolü sınamaları: sahte ArduCopter'a karşı görev / coğrafi çit / toplanma noktası yükleme, okuma,
// silme; yeniden deneme ve eski (MISSION_REQUEST / MISSION_ITEM) yolları; görevi başlatma, duraklatma, sürdürme.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const MISSION = require('../src/drone/mission');
const { MavVehicle } = require('../src/drone/vehicle');
const { createDroneSessions, METHODS } = require('../src/drone/sessions');
const { createSim } = require('./sim/vehicle-sim');

const FAST = { linkTimeoutMs: 900, paramGapMs: 250, missionRetryMs: 150, missionItemTimeoutMs: 1500 };

async function waitFor(cond, ms = 4000, what = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

// Araç + sahte araç çifti; fn bitince ikisi de kapatılır
async function withSim(simOpts, fn, vehOpts = {}) {
  const v = new MavVehicle({ type: 'udpin', localPort: 0 }, { ...FAST, ...vehOpts });
  let sim = null;
  try {
    assert.deepStrictEqual(await v.connect(), { ok: true });
    sim = await createSim({ udp: { host: '127.0.0.1', port: v.link.localPort }, heartbeatMs: 150, ...simOpts }).start();
    await waitFor(() => v.snapshot().linked, 3000, 'linked');
    await fn(v, sim);
  } finally { v.disconnect(); if (sim) await sim.stop(); }
}

const DOC = {
  name: 'Sınama görevi', vehicle: 'copter', home: { lat: 39.9255, lon: 32.8663, alt: 890 },
  items: [
    { type: 'takeoff', alt: 20 },
    { type: 'waypoint', lat: 39.9262, lon: 32.8663, alt: 20 }, // yön verilmedi → param4 = NaN
    { type: 'speed', p: { speed: 8 } },
    { type: 'waypoint', lat: 39.9262, lon: 32.8672, alt: 30, p: { hold: 0, radius: 0, yaw: 90 } },
    { type: 'jump', p: { item: 2, repeat: 1 } },
    { type: 'rtl' },
  ],
  fence: {
    polygons: [{ inclusion: true, points: [[39.92, 32.86], [39.93, 32.86], [39.93, 32.875], [39.92, 32.875]] }],
    circles: [{ inclusion: false, lat: 39.9258, lon: 32.867, radius: 25 }],
  },
  rally: [{ lat: 39.9251, lon: 32.8659, alt: 15 }],
};
const NO_FENCE = { ...DOC, fence: { polygons: [], circles: [] }, rally: [] };
const EMPTY = { loaded: false, count: 0, current: -1, reached: -1, path: [] };

test('görev: bağlı değilken bütün işlemler not_connected döner', async () => {
  const v = new MavVehicle({ type: 'udpin', localPort: 0 }, { ...FAST });
  try {
    assert.strictEqual((await v.uploadMission(DOC)).error, 'not_connected'); // bağlantı hiç açılmadı
    await v.connect(); // kapı açık ama araç yok
    for (const call of [() => v.uploadMission(DOC), () => v.downloadMission(), () => v.clearMission(), () => v.startMission(), () => v.pauseMission(), () => v.resumeMission(), () => v.setMissionCurrent(0)]) {
      const r = await call();
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'not_connected');
    }
    assert.deepStrictEqual(v.snapshot().mission, EMPTY);
  } finally { v.disconnect(); }
});

test('görev: yükleme — görev + çit + toplanma noktaları, ev öğesi, NaN yön, atlama kaydırması, ilerleme olayları', async () => {
  await withSim({}, async (v, sim) => {
    const events = [];
    v.on('mission', (p) => events.push(p));
    assert.deepStrictEqual(v.snapshot().mission, EMPTY);

    const r = await v.uploadMission(DOC);
    assert.deepStrictEqual(r, { ok: true, count: 6, fence: 5, rally: 1 });

    const ms = sim.mission[0];
    assert.strictEqual(ms.length, 7); // ev + 6 öğe
    assert.deepStrictEqual(ms.map((o) => o.seq), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepStrictEqual(ms.map((o) => o.command), [16, 22, 16, 178, 16, 177, 20]);
    assert.deepStrictEqual([ms[0].x, ms[0].y, ms[0].z, ms[0].frame], [399255000, 328663000, 890, 0]); // 0. öğe = ev
    assert.strictEqual(ms[1].z, 20);
    assert.deepStrictEqual([ms[2].x, ms[2].y, ms[2].z, ms[2].frame], [399262000, 328663000, 20, 3]);
    assert.ok(Number.isNaN(ms[2].param4), 'verilmeyen yön NaN olarak gitmeli (0 değil)');
    assert.strictEqual(ms[4].param4, 90);
    assert.strictEqual(ms[3].param2, 8);
    assert.deepStrictEqual([ms[5].param1, ms[5].param2], [2, 1]); // 2. belge öğesi → seq 2 (ev kaydırması)
    assert.ok(ms.every((o) => o.mission_type === 0));

    const fence = sim.mission[1];
    assert.deepStrictEqual(fence.map((o) => o.command), [5001, 5001, 5001, 5001, 5004]);
    assert.deepStrictEqual([fence[0].param1, fence[0].x, fence[0].y], [4, 399200000, 328600000]);
    assert.deepStrictEqual([fence[4].param1, fence[4].x, fence[4].y], [25, 399258000, 328670000]);
    assert.ok(fence.every((o) => o.mission_type === 1));
    assert.deepStrictEqual(sim.mission[2].map((o) => [o.command, o.x, o.y, o.z, o.mission_type]), [[5100, 399251000, 328659000, 15, 2]]);

    // İlerleme: her bölüm 0'dan toplamına
    for (const [part, total] of [['mission', 7], ['fence', 5], ['rally', 1]]) {
      const ev = events.filter((e) => e.op === 'upload' && e.part === part);
      assert.deepStrictEqual(ev[0], { op: 'upload', part, done: 0, total });
      assert.deepStrictEqual(ev[ev.length - 1], { op: 'upload', part, done: total, total });
    }
    assert.deepStrictEqual([...new Set(events.map((e) => e.part))], ['mission', 'fence', 'rally']);

    // Yüklenen görev durum özetinde
    const snap = v.snapshot().mission;
    assert.strictEqual(snap.loaded, true);
    assert.strictEqual(snap.count, 6);
    assert.strictEqual(snap.reached, -1);
    assert.deepStrictEqual(snap.path, [
      { lat: 39.9262, lon: 32.8663, alt: 20, index: 1, type: 'waypoint' },
      { lat: 39.9262, lon: 32.8672, alt: 30, index: 3, type: 'waypoint' },
    ]);
    await waitFor(() => v.missionState.seq === 0 && v.missionState.count === 7, 3000, 'MISSION_CURRENT');
    assert.strictEqual(v.snapshot().mission.current, -1); // seq 0 = ev

    // Çit ve toplanma noktası olmayan görev eskileri siler
    assert.deepStrictEqual(await v.uploadMission(NO_FENCE), { ok: true, count: 6, fence: 0, rally: 0 });
    assert.deepStrictEqual([sim.mission[0].length, sim.mission[1].length, sim.mission[2].length], [7, 0, 0]);
    assert.deepStrictEqual(sim.calls.filter((c) => c.name === 'MISSION_CLEAR_ALL').map((c) => c.params[0]), [1, 2]);
  });
});

test('görev: okuma — yüklenen görev aynen geri gelir; silme', async () => {
  await withSim({}, async (v, sim) => {
    const norm = MISSION.normalize(DOC);
    assert.strictEqual((await v.uploadMission(DOC)).ok, true);
    const events = [];
    v.on('mission', (p) => events.push(p));

    const r = await v.downloadMission();
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.mission.items, norm.items);
    assert.deepStrictEqual(r.mission.fence, norm.fence);
    assert.deepStrictEqual(r.mission.rally, norm.rally);
    assert.deepStrictEqual(r.mission.home, norm.home);
    assert.strictEqual(r.mission.vehicle, 'copter');
    assert.strictEqual(r.mission.skipped, 0);
    await waitFor(() => sim.calls.filter((c) => c.name === 'MISSION_ACK').length === 3, 2000, 'download acks');
    assert.deepStrictEqual(sim.calls.filter((c) => c.name === 'MISSION_ACK').map((c) => c.params), [[0, 0], [0, 1], [0, 2]]); // her liste onaylandı
    assert.deepStrictEqual(events.filter((e) => e.part === 'mission').pop(), { op: 'download', part: 'mission', done: 7, total: 7 });
    assert.deepStrictEqual(events.filter((e) => e.part === 'fence').pop(), { op: 'download', part: 'fence', done: 5, total: 5 });
    assert.strictEqual(v.snapshot().mission.count, 6);

    assert.deepStrictEqual(await v.clearMission(), { ok: true });
    assert.deepStrictEqual([sim.mission[0].length, sim.mission[1].length, sim.mission[2].length], [0, 0, 0]);
    assert.deepStrictEqual(v.snapshot().mission, EMPTY);

    // Boş araç: boş görev
    const e = await v.downloadMission();
    assert.strictEqual(e.ok, true);
    assert.deepStrictEqual([e.mission.items.length, e.mission.home, e.mission.rally.length], [0, null, 0]);
  });
});

test('görev: kaybolan MISSION_COUNT ve öğeler yeniden denenir; iki aktarım üst üste binmez (busy)', async () => {
  await withSim({ dropMissionRequests: 2 }, async (v, sim) => {
    const first = v.uploadMission(DOC);
    assert.deepStrictEqual(await v.downloadMission(), { ok: false, error: 'busy' });
    assert.deepStrictEqual(await v.clearMission(), { ok: false, error: 'busy' });
    assert.deepStrictEqual(await first, { ok: true, count: 6, fence: 5, rally: 1 });
    assert.strictEqual(sim.calls.filter((c) => c.name === 'MISSION_COUNT' && c.params[1] === 0).length, 3); // 2 kayıp + 1
    assert.strictEqual(sim.mission[0].length, 7);
    assert.ok(Number.isNaN(sim.mission[0][2].param4));
    assert.strictEqual((await v.downloadMission()).ok, true); // meşguliyet bitti
  });
});

test('görev: araç hiç yanıt vermezse timeout; hata onayı (MISSION_ACK) adıyla döner', async () => {
  await withSim({ dropMissionRequests: 99 }, async (v, sim) => {
    assert.deepStrictEqual(await v.uploadMission(DOC), { ok: false, error: 'timeout', part: 'mission' });
    assert.strictEqual(sim.calls.filter((c) => c.name === 'MISSION_COUNT').length, 3); // ilk + 2 yineleme
    assert.strictEqual(v.snapshot().mission.loaded, false);
  }, { missionRetries: 2 });
  await withSim({ missionMax: 3 }, async (v) => {
    assert.deepStrictEqual(await v.uploadMission(DOC), { ok: false, error: 'no_space', result: 4, part: 'mission' });
  });
});

test('görev: eski yol — MISSION_REQUEST ile yükleme, MISSION_REQUEST / MISSION_ITEM ile okuma', async () => {
  await withSim({ legacyMission: true }, async (v, sim) => {
    assert.deepStrictEqual(await v.uploadMission(DOC), { ok: true, count: 6, fence: 5, rally: 1 });
    assert.strictEqual(sim.mission[0].length, 7);
    assert.strictEqual(sim.mission[0][2].x, 399262000); // yanıt her zaman MISSION_ITEM_INT

    const r = await v.downloadMission();
    assert.strictEqual(r.ok, true);
    const norm = MISSION.normalize(DOC);
    assert.deepStrictEqual(r.mission.items.map((it) => it.type), norm.items.map((it) => it.type));
    // MISSION_ITEM'da konum float32 derecedir: ~1 m duyarlık
    assert.ok(Math.abs(r.mission.items[1].lat - 39.9262) < 1e-5 && Math.abs(r.mission.items[1].lon - 32.8663) < 1e-5);
    assert.strictEqual(r.mission.items[1].p.yaw, null);
    assert.strictEqual(r.mission.items[3].p.yaw, 90);
    assert.strictEqual(r.mission.fence.polygons[0].points.length, 4);
    assert.strictEqual(r.mission.rally.length, 1);
  });
});

test('görev: çit desteklemeyen araç — boş çit sorun değil, dolu çit part: fence ile başarısız', async () => {
  await withSim({ noFence: true }, async (v, sim) => {
    assert.deepStrictEqual(await v.uploadMission(NO_FENCE), { ok: true, count: 6, fence: 0, rally: 0 });
    assert.strictEqual(v.snapshot().mission.loaded, true);

    const r = await v.uploadMission(DOC);
    assert.deepStrictEqual(r, { ok: false, error: 'unsupported', result: 3, part: 'fence' });
    assert.strictEqual(sim.mission[0].length, 7); // görev bölümü yüklendi

    const rallyOnly = await v.uploadMission({ ...NO_FENCE, rally: DOC.rally });
    assert.strictEqual(rallyOnly.ok, false);
    assert.strictEqual(rallyOnly.part, 'rally');

    // Okuma: çit ve toplanma noktaları boş sayılır
    const d = await v.downloadMission();
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.mission.items.length, 6);
    assert.deepStrictEqual(d.mission.fence, { polygons: [], circles: [] });
    assert.deepStrictEqual(await v.clearMission(), { ok: true });
    assert.strictEqual(sim.mission[0].length, 0);
  });
});

test('görev: etkin öğeyi değiştirme — komutla; desteklenmiyorsa MISSION_SET_CURRENT iletisiyle', async () => {
  await withSim({}, async (v, sim) => {
    assert.strictEqual((await v.uploadMission(DOC)).ok, true);
    assert.strictEqual((await v.setMissionCurrent(-1)).error, 'invalid');
    assert.strictEqual((await v.setMissionCurrent('x')).error, 'invalid');

    const r = await v.setMissionCurrent(3);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.index, 3);
    assert.strictEqual(sim.calls.filter((c) => c.id === 224).pop().params[0], 4); // belge sırası 3 → seq 4
    assert.strictEqual(sim.state.missionCur, 4);
    await waitFor(() => v.snapshot().mission.current === 3, 2000, 'current 3');

    const bad = await v.setMissionCurrent(40); // araçta böyle bir öğe yok
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.error, 'failed');
    assert.strictEqual(sim.state.missionCur, 4);
  });
  await withSim({ unsupported: [224] }, async (v, sim) => {
    assert.strictEqual((await v.uploadMission(NO_FENCE)).ok, true);
    const r = await v.setMissionCurrent(1);
    assert.deepStrictEqual(r, { ok: true, result: null, resultName: null, index: 1 });
    assert.deepStrictEqual(sim.calls.filter((c) => c.name === 'MISSION_SET_CURRENT').pop().params, [2]);
    assert.strictEqual(v.snapshot().mission.current, 1);
  });
});

test('görev: başlatma — kalkış → 2 nokta → eve dönüş uçulur; duraklatma ve sürdürme', async () => {
  const flight = { home: { lat: 39.9255, lon: 32.8663, alt: 890 }, items: [
    { type: 'takeoff', alt: 15 },
    { type: 'waypoint', lat: 39.9261, lon: 32.8663, alt: 15 },
    { type: 'waypoint', lat: 39.9261, lon: 32.8671, alt: 20 },
    { type: 'rtl' },
  ] };
  await withSim({ interactive: true, simSpeed: 8, telemetryScale: 5 }, async (v, sim) => {
    await waitFor(() => Number.isFinite(v.snapshot().telemetry.lat), 3000, 'position');
    assert.strictEqual((await v.uploadMission(flight)).ok, true);

    const r = await v.startMission();
    assert.deepStrictEqual(r, { ok: true, mode: 'AUTO' });
    assert.strictEqual(sim.state.armed, true);
    assert.strictEqual(sim.state.mode, 3);
    assert.deepStrictEqual(sim.calls.filter((c) => c.id === 300).pop().params.slice(0, 2), [0, 0]);

    await waitFor(() => v.snapshot().mission.current === 0, 3000, 'takeoff item');
    await waitFor(() => v.snapshot().mission.current === 1, 5000, 'first waypoint');
    assert.ok(v.snapshot().mission.reached >= 0);
    assert.ok(v.snapshot().telemetry.altRel > 13);

    // Duraklat: BRAKE; araç olduğu yerde kalır, etkin öğe değişmez
    const p = await v.pauseMission();
    assert.strictEqual(p.ok, true);
    assert.strictEqual(sim.state.mode, 17);
    const cur = v.snapshot().mission.current;
    const res = await v.resumeMission();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.mode, 'AUTO');
    assert.strictEqual(sim.state.mode, 3);
    assert.ok(v.snapshot().mission.current >= cur);

    await waitFor(() => v.snapshot().mission.current === 2, 5000, 'second waypoint');
    await waitFor(() => v.snapshot().mission.current === 3 && v.snapshot().mode === 'RTL', 5000, 'rtl item');
    assert.strictEqual(v.snapshot().mission.reached, 2);
    await waitFor(() => v.snapshot().armed === false && v.snapshot().telemetry.altRel < 0.5, 8000, 'landed and disarmed');
    const t = v.snapshot().telemetry;
    assert.ok(Math.abs(t.lat - 39.9255) < 2e-5 && Math.abs(t.lon - 32.8663) < 2e-5, 'eve döndü');
  });
});

test('görev: başlatma başarısızlıkları adımıyla döner (kurma reddi)', async () => {
  await withSim({ interactive: true, denyArm: true }, async (v, sim) => {
    assert.strictEqual((await v.uploadMission(NO_FENCE)).ok, true);
    const r = await v.startMission();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.step, 'arm');
    assert.strictEqual(r.error, 'failed');
    assert.strictEqual(sim.state.armed, false);
    assert.strictEqual(sim.calls.some((c) => c.id === 300), false);
  });
});

test('görev: bağlantı kesilince süren aktarım sonuçlanır ve yüklü görev temizlenir', async () => {
  await withSim({}, async (v, sim) => {
    assert.strictEqual((await v.uploadMission(DOC)).ok, true);
    sim.setSilent(true);
    const pending = v.downloadMission();
    await new Promise((r) => setTimeout(r, 50));
    v.disconnect();
    const r = await pending;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'disconnected');
    assert.deepStrictEqual(v.snapshot().mission, EMPTY);
  });
});

test('oturumlar: görev işlevleri pencerelere açık, ilerleme olayı drone:mission olarak iletilir', async () => {
  for (const m of ['uploadMission', 'downloadMission', 'clearMission', 'startMission', 'pauseMission', 'resumeMission', 'setMissionCurrent']) assert.ok(METHODS.has(m), m);
  const fake = new EventEmitter();
  fake.connect = async () => {};
  fake.disconnect = () => {};
  fake.snapshot = () => ({ connected: true });
  fake.uploadMission = async (doc) => ({ ok: true, count: doc.items.length });
  const out = [];
  const sessions = createDroneSessions({ getDrone: () => ({ id: 'd1' }), createVehicle: () => fake, emit: (ch, p) => out.push([ch, p]), paramDefs: () => null });
  sessions.open('d1');
  fake.emit('mission', { op: 'upload', part: 'mission', done: 2, total: 7 });
  assert.deepStrictEqual(out.pop(), ['drone:mission', { id: 'd1', op: 'upload', part: 'mission', done: 2, total: 7 }]);
  assert.deepStrictEqual(await sessions.call('d1', 'uploadMission', [{ items: [1, 2] }]), { ok: true, count: 2 });
  sessions.close('d1');
});
