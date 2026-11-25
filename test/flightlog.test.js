'use strict';

// Telemetri kaydı (bağlantıya göre aç/kapat, dosya biçimi, liste) ve kaydı oynatan sahte araç
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createFlightLog, ReplayVehicle } = require('../src/drone/flightlog');
const { createDroneSessions } = require('../src/drone/sessions');
const { EventEmitter } = require('events');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-log-'));
const st = (o = {}) => ({ connected: true, linked: true, firmware: 'ardupilot', vehicle: 'copter', sysid: 1, armed: false, mode: 'STABILIZE', systemStatus: 'STANDBY', modes: [{ id: 0, name: 'STABILIZE' }], stats: { rx: 1 }, params: { total: 0 }, telemetry: { lat: 39.9, lon: 32.8, altRel: 0, heading: 10 }, ...o });

test('kayıt: bağlanınca açılır, kesilince kapanır, yeniden bağlanınca yeni dosya; liste ve okuma', async () => {
  const dir = tmp();
  let clock = Date.parse('2026-03-04T10:00:00Z');
  const log = createFlightLog({ dir: () => dir, now: () => clock });
  const drone = { id: 'd1', name: 'Keşif', firmware: 'ardupilot' };

  log.state('d1', drone, { connected: true, linked: false }); // araç henüz konuşmuyor: kayıt yok
  assert.strictEqual(log.isRecording('d1'), false);
  log.state('d1', drone, st());
  assert.strictEqual(log.isRecording('d1'), true);
  assert.strictEqual(log.list('d1')[0].recording, true);
  clock += 50; log.state('d1', drone, st({ telemetry: { lat: 39.9, lon: 32.8, altRel: 1 } }));               // çok sık: atlanır
  clock += 20; log.state('d1', drone, st({ armed: true, mode: 'GUIDED', telemetry: { lat: 39.9, lon: 32.8, altRel: 2 } })); // kurma: hemen yazılır
  for (let i = 1; i <= 40; i++) { clock += 100; log.state('d1', drone, st({ armed: true, mode: 'GUIDED', telemetry: { lat: 39.9 + i * 1e-5, lon: 32.8, altRel: 2 + i, heading: 90 } })); }
  log.text('d1', { severity: 4, severityName: 'WARNING', text: 'Battery low' });
  clock += 100;
  log.state('d1', drone, { connected: true, linked: false }); // bağlantı koptu
  assert.strictEqual(log.isRecording('d1'), false);
  await new Promise((r) => setTimeout(r, 150));

  // Yeniden bağlanınca ikinci dosya; çok kısa kayıt saklanmaz
  clock += 60000;
  log.state('d1', drone, st());
  clock += 500;
  await log.close('d1');
  clock += 60000;
  log.state('d1', drone, st());
  for (let i = 0; i < 30; i++) { clock += 100; log.state('d1', drone, st({ telemetry: { lat: 39.9, lon: 32.8, altRel: 0, heading: i } })); }
  await log.close('d1');

  const list = log.list('d1');
  assert.strictEqual(list.length, 2);
  assert.ok(list[0].startedAt > list[1].startedAt);
  const first = list[1];
  assert.strictEqual(first.name, 'Keşif');
  assert.ok(Math.abs(first.durationMs - 4070) < 5, String(first.durationMs));
  assert.strictEqual(first.maxAlt, 42);
  assert.ok(first.armedMs >= 4000 && first.armedMs <= 4200);
  assert.ok(first.distance >= 40 && first.distance <= 50, String(first.distance));

  const read = log.read('d1', first.file);
  assert.strictEqual(read.header.drone.id, 'd1');
  assert.strictEqual(read.records.length, 42); // ilk tam durum + kurma + 40 telemetri (çok sık gelen bir kayıt atlandı)
  assert.strictEqual(read.records[0].state.stats, undefined); // büyük / anlık alanlar yazılmaz
  assert.strictEqual(read.records[1].state.mode, 'GUIDED');
  assert.deepStrictEqual(read.records[1].state.modes, [{ id: 0, name: 'STABILIZE' }]); // değişmeyen bilgiler ilk kayıttan gelir
  assert.deepStrictEqual(read.texts.map((x) => x.text), ['Battery low']);

  // Dosya adı dron klasörünün dışına çıkamaz; silme
  assert.strictEqual(log.read('d1', '../../etc/passwd'), null);
  assert.strictEqual(log.remove('d1', first.file), true);
  assert.strictEqual(log.list('d1').length, 1);

  // Yarım kalmış (sonu kesik) dosya da okunur
  const cut = zlib.gzipSync(`${JSON.stringify(read.header)}\n${JSON.stringify({ t: 0, s: st() })}\n{"t":100,"m":{"la`);
  fs.writeFileSync(path.join(log.dirOf('d1'), '20260101-000000.vmlog.gz'), cut.subarray(0, cut.length - 6));
  assert.strictEqual(log.read('d1', '20260101-000000.vmlog.gz').records.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('oturum: araç olayları kaydediciye gider; oturum kapanınca kayıt kapanır', () => {
  const calls = [];
  const v = new EventEmitter(); v.snapshot = () => st(); v.disconnect = () => {};
  const s = createDroneSessions({ getDrone: () => ({ id: 'd1', name: 'X' }), emit: () => {}, createVehicle: () => v, paramDefs: () => null,
    recorder: { state: (id, d, x) => calls.push(['state', id, x.linked]), text: (id, m) => calls.push(['text', id, m.text]), close: (id) => calls.push(['close', id]) } });
  s.open('d1');
  v.emit('state', st()); v.emit('statustext', { text: 'hi' });
  s.close('d1');
  assert.deepStrictEqual(calls, [['state', 'd1', true], ['text', 'd1', 'hi'], ['close', 'd1']]);
});

test('oynatma: kayıt gerçek araç gibi durum yayar; hız, duraklatma, sarma ve iz', async () => {
  const records = []; const texts = [{ t: 1000, severity: 4, severityName: 'WARNING', text: 'Low battery' }];
  for (let i = 0; i <= 50; i++) records.push({ t: i * 100, state: st({ armed: i > 5, telemetry: { lat: 39.9 + i * 1e-4, lon: 32.8, altRel: i } }) });
  const v = new ReplayVehicle({ header: { startedAt: 1700000000000, drone: { name: 'Keşif' } }, records, texts, durationMs: 5000 }, { tickMs: 10, speed: 8 });
  const states = []; const got = [];
  v.on('state', (s) => states.push(s)); v.on('statustext', (m) => got.push(m.text));
  await v.connect();
  assert.strictEqual(v.snapshot().linked, true);
  assert.strictEqual(v.snapshot().replay.playing, true);
  await new Promise((r) => setTimeout(r, 900));
  const end = v.snapshot();
  assert.strictEqual(end.replay.playing, false); // sona gelince durur
  assert.strictEqual(end.replay.pos, 5000);
  assert.strictEqual(end.telemetry.altRel, 50);
  assert.deepStrictEqual(got, ['Low battery']);
  assert.ok(states.length > 20);
  for (let i = 1; i < states.length; i++) assert.ok(states[i].replay.pos >= states[i - 1].replay.pos);

  v.replayPlay(false);
  const r = v.replaySeek(2000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(v.snapshot().telemetry.altRel, 20);
  assert.strictEqual(r.path.length, 21);
  assert.deepStrictEqual(r.path[20], [32.8, 39.9 + 20e-4, 20]);
  assert.strictEqual(v.replaySpeed(0).ok, false);
  assert.strictEqual(v.replaySpeed(2).ok, true);
  assert.strictEqual(v.replayPlay(true).ok, true);
  await new Promise((res) => setTimeout(res, 120));
  assert.ok(v.snapshot().replay.pos > 2000 && v.snapshot().replay.pos < 3000);
  v.disconnect();
  assert.strictEqual(v.snapshot().linked, false);
});
