'use strict';

// Betaflight desteği sınamaları: MSP v1/v2 çözücü/kodlayıcı (bayt bayt doğru çerçeveler), CLI çıktısı çözümleme,
// gövde/motor tabloları ve sahte Betaflight 4.5 kartına (test/sim/betaflight-sim.js) karşı uçtan uca araç oturumu.

const test = require('node:test');
const assert = require('node:assert');

const msp = require('../src/drone/msp');
const BF = require('../src/drone/bfdata');
const { BfVehicle, parseGetOutput, parseDumpOutput } = require('../src/drone/betaflight');
const { createBfSim } = require('./sim/betaflight-sim');

const { MSP, MspParser, encode, encodeV1, encodeV2, crc8DvbS2 } = msp;
const hex = (h) => Buffer.from(h.replace(/\s+/g, ''), 'hex');

// Bağımsız olarak (Python ile) hesaplanmış ya da MSP v2 belgesinden (iNav wiki "MSP V2") alınmış çerçeveler
const VEC = {
  v1_api_req: '244d3c000101',                                   // $M< boyut 0, komut 1 (yapılandırıcının ilk isteği)
  v1_api_reply: '244d3e030100012e2d',                           // protokol 0, API 1.46
  v1_set_motor: '244d3c10d6e8034c04e803e803e803e803e803e80365', // MSP_SET_MOTOR, 2. motor 1100
  v2_ident_req: '24583c00640000008f',                           // belge örneği: komut 100, veri yok, CRC 0x8F
  v2_hello: '24583ea54242120048656c6c6f20666c79696e6720776f726c6482', // belge örneği: bayrak 0xA5, komut 0x4242, "Hello flying world", CRC 0x82
  v2_over_v1: '244d3e08ff0003300200010273b6',                   // v1 içinde v2: komut 0x3003, veri 01 02
};
const JUMBO_CRC = 0x95; // komut 71, 300 baytlık (i & 0xff) veri

async function waitFor(cond, ms = 4000, what = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

function newVehicle(sim, opts = {}) {
  return new BfVehicle({ type: 'tcp', host: '127.0.0.1', port: sim.port }, { streamRate: 10, linkTimeoutMs: 900, rebootSettleMs: 100, accCalMs: 200, magCalMs: 400, cliSettleMs: 40, ...opts });
}

async function session(t, simOpts = {}, vehOpts = {}) {
  const sim = createBfSim(simOpts);
  await sim.start();
  const v = newVehicle(sim, vehOpts);
  const ev = { texts: [], logs: [], cli: [], params: [], param: [], cal: [], states: 0 };
  v.on('statustext', (m) => ev.texts.push(m));
  v.on('log', (batch) => { for (const e of batch) ev.logs.push(e); });
  v.on('cli', (m) => ev.cli.push(m.text));
  v.on('params', (m) => ev.params.push(m));
  v.on('param', (m) => ev.param.push(m));
  v.on('calibration', (m) => ev.cal.push(m));
  v.on('state', () => { ev.states++; });
  t.after(async () => { v.disconnect(); await sim.stop(); });
  return { sim, v, ev };
}

async function linked(v) {
  assert.deepStrictEqual(await v.connect(), { ok: true });
  await waitFor(() => v.snapshot().linked, 4000, 'link');
}

// ---------------------------------------------------------------- MSP

test('msp: v1 / v2 / jumbo kodlama bayt bayt doğru', () => {
  assert.strictEqual(crc8DvbS2(Buffer.from('123456789')), 0xbc); // CRC-8/DVB-S2 sınama değeri
  assert.strictEqual(encode(MSP.MSP_API_VERSION).toString('hex'), VEC.v1_api_req);
  assert.strictEqual(encodeV1(1, [0, 1, 46], '>').toString('hex'), VEC.v1_api_reply);
  const motors = Buffer.alloc(16);
  [1000, 1100, 1000, 1000, 1000, 1000, 1000, 1000].forEach((v, i) => motors.writeUInt16LE(v, i * 2));
  assert.strictEqual(encode(MSP.MSP_SET_MOTOR, motors).toString('hex'), VEC.v1_set_motor);
  assert.strictEqual(encodeV2(100, null).toString('hex'), VEC.v2_ident_req);
  assert.strictEqual(encodeV2(0x4242, Buffer.from('Hello flying world'), '>', 0xa5).toString('hex'), VEC.v2_hello);
  assert.strictEqual(encode(0x3003, [1, 2]).subarray(0, 3).toString('latin1'), '$X<', 'komut > 254 ise v2');

  // JUMBO: veri ≥ 255 bayt → boyut alanı 255, ardından gerçek boyut (u16 LE)
  const big = Buffer.from(Array.from({ length: 300 }, (_, i) => i & 0xff));
  const j = encodeV1(71, big, '>');
  assert.strictEqual(j.length, 3 + 2 + 2 + 300 + 1);
  assert.strictEqual(j.subarray(0, 7).toString('hex'), '244d3eff472c01');
  assert.strictEqual(j[j.length - 1], JUMBO_CRC);
  assert.strictEqual(encodeV1(71, big.subarray(0, 254), '>')[3], 254, '254 bayta kadar olağan çerçeve');

  assert.strictEqual(MSP.MSP_STATUS_EX, 150);
  assert.strictEqual(MSP.MSP_SET_REBOOT, 68);
  assert.strictEqual(MSP.MSP_ARMING_DISABLE, 99);
  assert.strictEqual(msp.mspName(108), 'MSP_ATTITUDE');
  assert.strictEqual(msp.mspName(99), 'MSP_SET_ARMING_DISABLED');
});

test('msp: akış çözücü — parçalı veri, jumbo, v2, hata yanıtı, yeniden eşitlenme, metin geçişi', () => {
  const texts = [];
  const p = new MspParser({ onText: (s) => texts.push(s) });

  let f = p.push(hex(VEC.v1_api_reply));
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual({ version: f[0].version, dir: f[0].dir, cmd: f[0].cmd, error: f[0].error, payload: [...f[0].payload] }, { version: 1, dir: '>', cmd: 1, error: false, payload: [0, 1, 46] });

  f = p.push(hex(VEC.v2_hello));
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].version, 2);
  assert.strictEqual(f[0].cmd, 0x4242);
  assert.strictEqual(f[0].flags, 0xa5);
  assert.strictEqual(f[0].payload.toString(), 'Hello flying world');

  f = p.push(hex(VEC.v2_over_v1));
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual([f[0].version, f[0].cmd, [...f[0].payload], !!f[0].overV1], [2, 0x3003, [1, 2], true]);

  // Hata yanıtı ($M!)
  f = p.push(encode(MSP.MSP_RAW_GPS, null, { dir: '!' }));
  assert.deepStrictEqual([f[0].dir, f[0].error, f[0].cmd], ['!', true, 106]);

  // Jumbo çerçeve bayt bayt verilse de çözülür
  const big = Buffer.from(Array.from({ length: 300 }, (_, i) => i & 0xff));
  const j = encodeV1(71, big, '>');
  let got = [];
  for (const b of j) got = got.concat(p.push(Buffer.from([b])));
  assert.strictEqual(got.length, 1);
  assert.ok(got[0].payload.equals(big));

  // Art arda çerçeveler tek parçada; araya giren çöp ve bozuk sağlama toplamı atlanır
  assert.strictEqual(texts.join(''), '');
  const bad = hex(VEC.v1_api_reply); bad[bad.length - 1] ^= 0xff;
  f = p.push(Buffer.concat([hex(VEC.v1_api_req), bad, hex(VEC.v2_ident_req), hex(VEC.v1_set_motor)]));
  assert.deepStrictEqual(f.map((x) => [x.version, x.dir, x.cmd]), [[1, '<', 1], [2, '<', 100], [1, '<', 214]]);
  assert.strictEqual(p.stats.errors, 1);
  assert.strictEqual(texts.join(''), '', 'bozuk çerçeve metin sayılmaz');

  // Aynı hattan gelen CLI metni olduğu gibi geçer; içindeki '$' de korunur
  f = p.push(Buffer.concat([Buffer.from('\r\nEntering CLI Mode\r\n$ 5 # '), hex(VEC.v1_api_reply), Buffer.from('ok $M')]));
  assert.strictEqual(f.length, 1);
  assert.strictEqual(texts.join(''), '\r\nEntering CLI Mode\r\n$ 5 # ok ');
  p.flush(); // yarım kalan "$M" de metindir
  assert.strictEqual(texts.join(''), '\r\nEntering CLI Mode\r\n$ 5 # ok $M');
  assert.strictEqual(p.takeText(), texts.join(''));
  assert.strictEqual(p.text, '');

  // Metin kipi (kart CLI'deyken): hiçbir şey çözülmez
  p.textMode = true;
  texts.length = 0;
  assert.strictEqual(p.push(hex(VEC.v1_api_reply)).length, 0);
  assert.strictEqual(Buffer.from(texts.join(''), 'latin1').toString('hex'), VEC.v1_api_reply);
});

// ---------------------------------------------------------------- Tablolar ve CLI çözümleme

test('bfdata: karıştırıcıdan gövde — Betaflight motor numaraları, konumlar ve dönüş yönleri', () => {
  const quad = BF.frameFromMixer(3, false, 4);
  assert.strictEqual(quad.name, 'QUAD X');
  // 1 arka-sağ CW, 2 ön-sağ CCW, 3 arka-sol CCW, 4 ön-sol CW (pervaneler içe)
  assert.deepStrictEqual(quad.motors.map((m) => [m.n, m.x, m.y, m.dir]), [[1, 1, -1, 'cw'], [2, 1, 1, 'ccw'], [3, -1, -1, 'ccw'], [4, -1, 1, 'cw']]);
  assert.deepStrictEqual(quad.motors.map((m) => m.testOrder), [2, 1, 3, 4]); // ön-sağdan saat yönünde
  // yaw_motors_reversed: bütün yönler ters (pervaneler dışa)
  assert.deepStrictEqual(BF.frameFromMixer(3, true, 4).motors.map((m) => m.dir), ['ccw', 'cw', 'cw', 'ccw']);

  const plus = BF.frameFromMixer(2, false, 4);
  assert.strictEqual(plus.name, 'QUAD +');
  assert.deepStrictEqual(plus.motors.map((m) => [m.x, m.y, m.dir]), [[0, -1, 'cw'], [1, 0, 'ccw'], [-1, 0, 'ccw'], [0, 1, 'cw']]); // arka, sağ, sol, ön

  const tri = BF.frameFromMixer(1, false, 3);
  assert.deepStrictEqual(tri.motors.map((m) => [m.x, m.y, m.dir]), [[0, -1, null], [0.75, 0.5, null], [-0.75, 0.5, null]]);

  const hex6 = BF.frameFromMixer(10, false, 6);
  assert.strictEqual(hex6.name, 'HEX X');
  assert.deepStrictEqual(hex6.motors.map((m) => [m.x, m.y, m.dir]), [[0.5, -0.866, 'ccw'], [0.5, 0.866, 'ccw'], [-0.5, -0.866, 'cw'], [-0.5, 0.866, 'cw'], [1, 0, 'cw'], [-1, 0, 'ccw']]);

  for (const [id, n] of [[4, 2], [6, 6], [7, 6], [9, 4], [11, 8], [12, 8], [13, 8], [17, 4], [18, 6], [22, 4], [26, 4], [27, 8]]) {
    const fr = BF.frameFromMixer(id, false, n);
    assert.strictEqual(fr.motors.length, n, fr.name);
    assert.deepStrictEqual(fr.motors.map((m) => m.testOrder).sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i + 1), fr.name);
    for (const m of fr.motors) assert.ok(Math.abs(m.x) <= 1 && Math.abs(m.y) <= 1, fr.name);
  }
  // Dengeli gövdelerde CW ve CCW sayısı eşittir
  for (const id of [2, 3, 6, 7, 10, 11, 12, 13, 26, 27]) {
    const d = BF.frameFromMixer(id, false).motors.map((m) => m.dir);
    assert.strictEqual(d.filter((x) => x === 'cw').length, d.filter((x) => x === 'ccw').length, `mixer ${id}`);
  }
  // Bilinmeyen / özel karıştırıcı: çizim yok, motor sayısı MSP'den
  const custom = BF.frameFromMixer(23, false, 5);
  assert.deepStrictEqual([custom.motors.length, custom.motorCount, custom.name], [0, 5, 'CUSTOM']);
  assert.deepStrictEqual(BF.frameFromMixer(99, false, 4).motors, []);

  // Kurma engelleri: 4.5 ve 4.4 tabloları
  assert.deepStrictEqual(BF.armingFlagNames((1 << 2) | (1 << 13) | (1 << 25), 26, 46), ['RXLOSS', 'CLI', 'ARMSWITCH']);
  assert.deepStrictEqual(BF.armingFlagNames((1 << 3) | (1 << 20), 26, 46), ['NOT_DISARMED', 'DSHOT_TELEM']);
  assert.deepStrictEqual(BF.armingFlagNames((1 << 3) | (1 << 20), 26, 45), ['BADRX', 'RPMFILTER']);
  assert.deepStrictEqual(BF.armingFlagNames((1 << 16) | (1 << 29), 30, 49), ['MSP', 'ARM_SWITCH']);
});

test('cli: "get" ve "dump" çıktısı çözümleme (cli.c biçimi)', () => {
  const text = [
    'gyro_lpf1_static_hz = 250', 'Allowed range: 0 - 1000', '',
    'acc_calibration = -12,7,104,1', 'Array length: 4', 'Default value: 0,0,0,0', '',
    'align_mag = CW90', 'Allowed values: DEFAULT, CW0, CW90, CW180', 'Default value: DEFAULT', '',
    'p_roll = 50', 'profile 0', 'Allowed range: 0 - 250', 'Default value: 45', '',
    'roll_rc_rate = 7', 'rateprofile 2', 'Allowed range: 1 - 255', '',
    'gps_rescue_offset = -5', 'Allowed range: -20 - 20', '',
    'craft_name = -', 'String length: 1 - 16', '',
    'pilot_name = ACE = 1', 'String length: 1 - 16', 'Default value: -',
  ].join('\r\n');
  const list = parseGetOutput(text);
  assert.deepStrictEqual(list.map((p) => [p.name, p.type, p.index]), [
    ['gyro_lpf1_static_hz', 'number', 0], ['acc_calibration', 'array', 1], ['align_mag', 'enum', 2], ['p_roll', 'number', 3],
    ['roll_rc_rate', 'number', 4], ['gps_rescue_offset', 'number', 5], ['craft_name', 'text', 6], ['pilot_name', 'text', 7],
  ]);
  const by = Object.fromEntries(list.map((p) => [p.name, p]));
  assert.deepStrictEqual([by.gyro_lpf1_static_hz.value, by.gyro_lpf1_static_hz.range, by.gyro_lpf1_static_hz.def], [250, [0, 1000], 250]);
  assert.deepStrictEqual([by.acc_calibration.value, by.acc_calibration.length, by.acc_calibration.def], ['-12,7,104,1', 4, '0,0,0,0']);
  assert.deepStrictEqual([by.align_mag.value, by.align_mag.values, by.align_mag.def], ['CW90', ['DEFAULT', 'CW0', 'CW90', 'CW180'], 'DEFAULT']);
  assert.deepStrictEqual([by.p_roll.value, by.p_roll.def, by.p_roll.scope, by.p_roll.profile], [50, 45, 'profile', 0]);
  assert.deepStrictEqual([by.roll_rc_rate.scope, by.roll_rc_rate.profile], ['rateprofile', 2]);
  assert.deepStrictEqual([by.gps_rescue_offset.value, by.gps_rescue_offset.range], [-5, [-20, 20]]);
  assert.deepStrictEqual([by.craft_name.value, by.craft_name.maxLength, by.craft_name.range], ['', 16, null]);
  assert.deepStrictEqual([by.pilot_name.value, by.pilot_name.def], ['ACE = 1', '']);

  const dump = parseDumpOutput('# master\r\nset min_check = 1050\r\nset align_mag = CW90\r\nset dshot_bidir = ON\r\nset acc_calibration = 1,2,3,4\r\n\r\nprofile 0\r\n\r\nset p_roll = 45\r\nprofile 1\r\nset p_roll = 60\r\n');
  assert.deepStrictEqual(dump.map((p) => [p.name, p.value, p.type]), [['min_check', 1050, 'number'], ['align_mag', 'CW90', 'text'], ['dshot_bidir', 'ON', 'enum'], ['acc_calibration', '1,2,3,4', 'array'], ['p_roll', 45, 'number']]);
  assert.ok(dump.every((p) => p.guessed && p.range === null));
});

// ---------------------------------------------------------------- Araç oturumu (sahte karta karşı)
// Her sınama kendi sahte kartını (ayrı kapı) kullanır: birlikte koşabilirler (yeniden başlatma beklemeleri üst üste biner)

test.describe('betaflight oturumu', { concurrency: 6 }, () => {
test.it('betaflight: bağlanma, kimlik, telemetri, gövde, günlük', async (t) => {
  const { sim, v, ev } = await session(t, { gps: true, armingDisableFlags: 0 });
  assert.strictEqual(v.snapshot().connected, false);
  await linked(v);
  await waitFor(() => { const x = v.snapshot().telemetry; return x.roll !== null && x.voltage !== null && x.altRel !== null && x.rc.length && x.servo.length && x.lat !== null && x.batteryPct !== null && x.homeDist !== null; }, 4000, 'telemetry');
  const s = v.snapshot();
  assert.strictEqual(s.connected, true);
  assert.strictEqual(s.firmware, 'betaflight');
  assert.strictEqual(s.vehicle, 'copter');
  assert.strictEqual(s.variant, 'BTFL');
  assert.strictEqual(s.version, '4.5.1');
  assert.strictEqual(s.apiVersion, '1.46');
  assert.strictEqual(s.board, 'SPEEDYBEEF405V4');
  assert.strictEqual(s.boardInfo.target, 'STM32F405');
  assert.strictEqual(s.boardInfo.manufacturer, 'SPBE');
  assert.strictEqual(s.craftName, 'SIMQUAD');
  assert.strictEqual(s.uid, '002500313338511739343437');
  assert.strictEqual(s.link, `tcp 127.0.0.1:${sim.port}`);
  assert.strictEqual(s.error, null);
  assert.strictEqual(s.armed, false);
  assert.strictEqual(s.mode, 'ACRO');
  assert.deepStrictEqual(s.modes, []);
  assert.strictEqual(s.systemStatus, 'STANDBY');
  assert.strictEqual(s.cliMode, false);
  assert.deepStrictEqual(s.armingDisabled, []);
  assert.deepStrictEqual(s.params, { total: 0, received: 0, loading: false });

  const x = s.telemetry;
  assert.ok(Math.abs(x.roll) <= 15 && Math.abs(x.pitch) <= 8 && x.yaw >= 0 && x.yaw < 360);
  assert.strictEqual(x.heading, x.yaw);
  assert.ok(x.altRel > 11 && x.altRel < 14 && Math.abs(x.climb) <= 0.5);
  assert.strictEqual(x.voltage, 15.82);
  assert.strictEqual(x.current, 12.34);
  assert.strictEqual(x.mahDrawn, 320);
  assert.strictEqual(x.batteryPct, 79); // 1500 mAh kapasiteden 320 mAh
  assert.strictEqual(x.cells, 4);
  assert.strictEqual(x.rssi, 85);       // 870 / 1023
  assert.strictEqual(x.rc.length, 16);
  assert.strictEqual(x.throttle, 0);
  assert.deepStrictEqual(x.servo, [1000, 1000, 1000, 1000]);
  assert.deepStrictEqual([x.gpsFix, x.gpsFixName, x.sats, x.hdop], [3, '3D_FIX', 14, 1.35]);
  assert.ok(Math.abs(x.lat - 39.9255) < 0.001 && Math.abs(x.lon - 32.8663) < 0.001);
  assert.strictEqual(x.altMsl, 905);
  assert.strictEqual(x.groundspeed, 3.2);
  assert.strictEqual(x.homeDist, 42);
  assert.ok(x.homeLat < x.lat && Math.abs(x.homeLon - x.lon) < 1e-4, 'ev güneyde (yön 180°, 42 m)');
  assert.ok(x.load >= 9 && x.load <= 15);
  assert.ok(Date.now() - x.time < 2000);

  assert.deepStrictEqual(s.sensors.list.map((q) => [q.name, q.present]), [['GYRO', true], ['ACC', true], ['BARO', true], ['MAG', true], ['GPS', true], ['RANGEFINDER', false]]);
  assert.ok(s.sensors.list.every((q) => q.enabled === q.present && q.healthy === q.present && typeof q.id === 'number'));

  assert.strictEqual(s.frame.name, 'QUAD X');
  assert.strictEqual(s.frame.class, 3);
  assert.deepStrictEqual(s.frame.motors.map((m) => [m.n, m.x, m.y, m.dir]), [[1, 1, -1, 'cw'], [2, 1, 1, 'ccw'], [3, -1, -1, 'ccw'], [4, -1, 1, 'cw']]);

  // İstatistik ve günlük
  await waitFor(() => v.snapshot().stats.msgRate > 0, 3000, 'msg rate');
  const st = v.snapshot().stats;
  assert.ok(st.rxBytes > 0 && st.txBytes > 0 && st.rxMsgs > 20 && st.txMsgs >= st.rxMsgs && st.byteRate > 0);
  assert.strictEqual(st.lost, 0);
  assert.ok(st.msgRate >= 15, `10 Hz tutum + kumanda + ötekiler: ${st.msgRate}`);
  await waitFor(() => ev.logs.some((e) => e.name === 'MSP_RAW_GPS' && e.dir === 'rx'), 2000, 'log');
  const names = (dir) => new Set(ev.logs.filter((e) => e.dir === dir).map((e) => e.name));
  for (const n of ['MSP_API_VERSION', 'MSP_FC_VARIANT', 'MSP_BOARD_INFO', 'MSP_MIXER_CONFIG', 'MSP_BOXIDS', 'MSP_STATUS_EX', 'MSP_ATTITUDE', 'MSP_RC', 'MSP_ANALOG', 'MSP_MOTOR', 'MSP_ALTITUDE']) {
    assert.ok(names('tx').has(n), `tx ${n}`);
    assert.ok(names('rx').has(n), `rx ${n}`);
  }
  const att = ev.logs.find((e) => e.name === 'MSP_ATTITUDE' && e.dir === 'rx');
  assert.deepStrictEqual([att.id, att.sysid, att.compid], [108, 0, 0]);
  assert.match(att.text, /^roll=-?[\d.]+ pitch=-?[\d.]+ yaw=\d+$/);
  assert.ok(typeof att.t === 'number');
  assert.ok(ev.states > 3);

  // Desteklenmeyenler
  assert.deepStrictEqual(await v.arm(true), { ok: false, error: 'unsupported' });
  assert.deepStrictEqual(await v.setMode('ANGLE'), { ok: false, error: 'unsupported' });
  assert.deepStrictEqual(await v.command('DO_SET_MODE', []), { ok: false, error: 'unsupported' });
  assert.deepStrictEqual(await v.calibrate('gyro'), { ok: false, error: 'unsupported' });
  assert.deepStrictEqual(v.getParams(), []);
});

test.it('betaflight: GPS yokken konum boş; açık olmayan kapıya bağlanma hatası', async (t) => {
  const { v } = await session(t, {});
  await linked(v);
  await waitFor(() => v.snapshot().telemetry.voltage !== null && v.snapshot().telemetry.rc.length, 3000, 'telemetry');
  await new Promise((r) => setTimeout(r, 150));
  const s = v.snapshot();
  assert.deepStrictEqual([s.telemetry.lat, s.telemetry.lon, s.telemetry.homeLat, s.telemetry.homeLon], [null, null, null, null]);
  assert.strictEqual(s.sensors.list.find((q) => q.name === 'GPS').present, false);

  const dead = new BfVehicle({ type: 'tcp', host: '127.0.0.1', port: 1 }, {});
  const r = await dead.connect();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'connect_failed');
  assert.deepStrictEqual(await dead.fetchParams(), { ok: false, error: 'not_connected', total: 0, received: 0 });
  assert.deepStrictEqual(await dead.motorTest({ motor: 1 }), { ok: false, error: 'not_connected' });
  assert.deepStrictEqual(await dead.cli('status'), { ok: false, error: 'not_connected' });
  assert.deepStrictEqual(await new BfVehicle({ type: 'nope' }, {}).connect(), { ok: false, error: 'unsupported' });
  dead.disconnect();
});

test.it('betaflight: kurma engelleri → statustext; kurulu araç ve kip', async (t) => {
  const { sim, v, ev } = await session(t, {});
  await linked(v);
  await waitFor(() => ev.texts.some((m) => /Arming disabled/.test(m.text)), 3000, 'arming statustext');
  const first = ev.texts.find((m) => /Arming disabled/.test(m.text));
  assert.deepStrictEqual([first.severity, first.severityName, first.text], [4, 'WARNING', 'Arming disabled: RXLOSS, ARMSWITCH']);
  assert.ok(typeof first.t === 'number');
  assert.deepStrictEqual(v.snapshot().armingDisabled, ['RXLOSS', 'ARMSWITCH']);

  sim.setArmingFlags(sim.ARM.THROTTLE);
  await waitFor(() => ev.texts.some((m) => m.text === 'Arming disabled: THROTTLE'), 3000, 'flag change');
  sim.setArmingFlags(0);
  await waitFor(() => ev.texts.some((m) => m.severity === 6 && m.text === 'Arming allowed'), 3000, 'flags cleared');
  assert.deepStrictEqual(v.snapshot().armingDisabled, []);

  sim.state.angle = true;
  await waitFor(() => v.snapshot().mode === 'ANGLE', 3000, 'angle mode');
  assert.deepStrictEqual(v.snapshot().boxes, ['ANGLE']);
  sim.setArmed(true);
  await waitFor(() => v.snapshot().armed, 3000, 'armed');
  // Motor değerleri ayrı bir iletiyle gelir; kurulu durumundan sonra ulaşabilir
  await waitFor(() => v.snapshot().telemetry.servo[0] === 1300 && v.snapshot().telemetry.throttle === 35, 3000, 'armed motor values');
  const s = v.snapshot();
  assert.strictEqual(s.systemStatus, 'ACTIVE');
  assert.strictEqual(s.telemetry.throttle, 35);
  assert.deepStrictEqual(s.telemetry.servo, [1300, 1310, 1320, 1330]);

  // Kuruluyken: motor testi, kalibrasyon, CLI ve yeniden başlatma reddedilir
  assert.deepStrictEqual(await v.motorTest({ motor: 1, throttlePct: 10, seconds: 1 }), { ok: false, error: 'armed' });
  assert.deepStrictEqual(await v.calibrate('accel'), { ok: false, error: 'armed' });
  assert.deepStrictEqual(await v.cli('status'), { ok: false, error: 'armed' });
  assert.deepStrictEqual(await v.reboot(), { ok: false, error: 'armed' });
  assert.strictEqual(sim.calls.filter((c) => c.name !== 'CLI').length, 0);
});

test.it('betaflight: motor testi — değerler, kurma engeli, kendiliğinden durma', async (t) => {
  const { sim, v, ev } = await session(t, { armingDisableFlags: 0 });
  await linked(v);
  await waitFor(() => v.snapshot().telemetry.servo.length === 4, 3000, 'motors');
  assert.deepStrictEqual(await v.motorTest({ motor: 5, throttlePct: 10, seconds: 1 }), { ok: false, error: 'invalid' });
  assert.deepStrictEqual(await v.motorTest({ motor: 0, throttlePct: 10, seconds: 1 }), { ok: false, error: 'invalid' });

  const t0 = Date.now();
  const r = await v.motorTest({ motor: 2, throttlePct: 10, seconds: 0.4 });
  assert.deepStrictEqual(r, { ok: true, motor: 2, value: 1100, seconds: 0.4 }); // DSHOT: 1000 (dur) … 2000
  const sets = () => sim.calls.filter((c) => c.name === 'MSP_SET_MOTOR');
  // Önce kurma MSP ile engellenir, sonra motor değeri yazılır (8 değer; ötekiler durma değerinde)
  assert.deepStrictEqual(sim.calls.map((c) => c.name), ['MSP_SET_ARMING_DISABLED', 'MSP_SET_MOTOR']);
  assert.deepStrictEqual([sim.calls[0].disabled, sim.calls[0].runawayOff], [1, 0]);
  assert.deepStrictEqual(sets()[0].values, [1000, 1100, 1000, 1000, 1000, 1000, 1000, 1000]);
  assert.strictEqual(v.snapshot().motorTest, true);
  await waitFor(() => v.snapshot().telemetry.servo[1] === 1100, 2000, 'motor telemetry');

  // Süre dolunca kendiliğinden durur ve kurma engeli kaldırılır
  await waitFor(() => sets().length >= 2 && sim.calls[sim.calls.length - 1].name === 'MSP_SET_ARMING_DISABLED', 3000, 'auto stop');
  const stop = sets()[1];
  assert.deepStrictEqual(stop.values, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
  const dt = stop.t - t0;
  assert.ok(dt >= 350 && dt < 1500, `0,4 sn sonra durmalı: ${dt} ms`);
  assert.strictEqual(sim.calls[sim.calls.length - 1].disabled, 0);
  assert.strictEqual(sim.state.mspArmingDisabled, false);
  await waitFor(() => !v.snapshot().motorTest, 1000, 'motorTest flag');
  assert.ok(!ev.texts.some((m) => /MSP/.test(m.text)), 'kendi MSP engelimiz bildirilmez');

  // Elle durdurma ve yüzde → değer dönüşümü
  assert.strictEqual((await v.motorTest({ motor: 4, throttlePct: 100, seconds: 30 })).value, 2000);
  assert.deepStrictEqual(sets()[2].values.slice(0, 4), [1000, 1000, 1000, 2000]);
  assert.deepStrictEqual(await v.motorStop(), { ok: true });
  assert.deepStrictEqual(sets()[3].values.slice(0, 4), [1000, 1000, 1000, 1000]);
  await new Promise((r2) => setTimeout(r2, 100));
  assert.strictEqual(sets().length, 4, 'durdurulan testin zamanlayıcısı kalmaz');
  // Gaz 0 = durdur
  assert.deepStrictEqual(await v.motorTest({ motor: 1, throttlePct: 0, seconds: 2 }), { ok: true });

  // Analog protokolde aralık min_command … max_throttle
  v.motorProtocol = 0; v.motorCfg.minCommand = 1000; v.motorCfg.maxThrottle = 1900;
  assert.strictEqual((await v.motorTest({ motor: 1, throttlePct: 50, seconds: 5 })).value, 1450);
  await v.motorStop();
  v.motorProtocol = 9;
  assert.deepStrictEqual(await v.motorTest({ motor: 1, throttlePct: 5, seconds: 1 }), { ok: false, error: 'motor_protocol_disabled' });
});

test.it('betaflight: fetchParams (CLI get), setParam, saveParams → yeniden başlatma ve kendiliğinden yeniden bağlanma', async (t) => {
  const { sim, v, ev } = await session(t, {});
  await linked(v);
  const r = await v.fetchParams();
  assert.deepStrictEqual(r, { ok: true, total: 51, received: 51 });
  assert.ok(ev.params.length >= 2);
  assert.deepStrictEqual(ev.params[0], { total: 0, received: 0, loading: true, done: false });
  assert.deepStrictEqual(ev.params[ev.params.length - 1], { total: 51, received: 51, loading: false, done: true });
  assert.deepStrictEqual(v.snapshot().params, { total: 51, received: 51, loading: false });
  // 4.5+: okuma bitince CLI'den yeniden başlatmadan çıkılır ve telemetri sürer
  assert.strictEqual(v.snapshot().cliMode, false);
  assert.deepStrictEqual(sim.calls.filter((c) => c.name === 'CLI').map((c) => c.line), ['get', 'exit noreboot']);
  assert.strictEqual(sim.state.rebooted, 0);
  const before = v.snapshot().stats.rxMsgs;
  await waitFor(() => v.snapshot().stats.rxMsgs > before + 5 && v.snapshot().armingDisabled.includes('CLI'), 3000, 'telemetry after CLI');

  const list = v.getParams();
  assert.strictEqual(list.length, 51);
  assert.deepStrictEqual(list.map((p) => p.name), list.map((p) => p.name).slice().sort());
  const by = Object.fromEntries(list.map((p) => [p.name, p]));
  assert.deepStrictEqual(by.min_check, { name: 'min_check', value: 1050, type: 'number', index: 8, range: [750, 2250], values: null, def: 1050, scope: 'master', profile: null });
  assert.deepStrictEqual([by.motor_pwm_protocol.type, by.motor_pwm_protocol.value, by.motor_pwm_protocol.values.length, by.motor_pwm_protocol.values[7], by.motor_pwm_protocol.range], ['enum', 'DSHOT600', 10, 'DSHOT600', null]);
  assert.deepStrictEqual(by.yaw_motors_reversed.values, ['OFF', 'ON']);
  assert.deepStrictEqual([by.acc_calibration.type, by.acc_calibration.value, by.acc_calibration.length], ['array', '0,0,0,0', 4]);
  assert.deepStrictEqual([by.craft_name.type, by.craft_name.value, by.craft_name.maxLength], ['text', 'SIMQUAD', 16]);
  assert.strictEqual(by.pilot_name.value, '');
  assert.deepStrictEqual([by.p_roll.scope, by.p_roll.profile, by.roll_rc_rate.scope], ['profile', 0, 'rateprofile']);
  const types = new Set(list.map((p) => p.type));
  assert.deepStrictEqual([...types].sort(), ['array', 'enum', 'number', 'text']);

  // setParam: kabul, aralık dışı, bilinmeyen ad, geçersiz girdi
  assert.deepStrictEqual(await v.setParam('min_check', 1100), { ok: true, value: 1100 });
  assert.strictEqual(v.snapshot().cliMode, true, 'kaydedilmemiş değişiklik varken CLI açık kalır');
  assert.strictEqual(v.snapshot().systemStatus, 'CLI');
  assert.strictEqual(v.snapshot().unsaved, 1);
  assert.deepStrictEqual(ev.param[0], { name: 'min_check', value: 1100, type: 'number', index: 8 });
  assert.strictEqual(sim.settings.get('min_check'), '1100');
  const rej = await v.setParam('min_check', 5000);
  assert.deepStrictEqual([rej.ok, rej.error], [false, 'rejected']);
  assert.match(rej.detail, /INVALID VALUE.*Allowed range: 750 - 2250/);
  const unk = await v.setParam('no_such_setting', 1);
  assert.deepStrictEqual([unk.ok, unk.error], [false, 'unknown_param']);
  assert.match(unk.detail, /INVALID NAME/);
  assert.deepStrictEqual(await v.setParam('bad name', 1), { ok: false, error: 'invalid' });
  assert.deepStrictEqual(await v.setParam('min_check', '10 # x'), { ok: false, error: 'invalid' });
  assert.deepStrictEqual(await v.setParam('yaw_motors_reversed', 'on'), { ok: true, value: 'ON' });
  const badEnum = await v.setParam('motor_pwm_protocol', 'DSHOT9000');
  assert.deepStrictEqual([badEnum.ok, badEnum.error], [false, 'rejected']);
  assert.match(badEnum.detail, /Allowed values: PWM, ONESHOT125/);
  assert.deepStrictEqual(await v.setParam('craft_name', 'KARTAL'), { ok: true, value: 'KARTAL' });
  assert.deepStrictEqual(await v.setParam('acc_calibration', [1, -2, 3, 4]), { ok: true, value: '1,-2,3,4' });
  assert.strictEqual(v.snapshot().unsaved, 4);
  assert.strictEqual(v.getParams().find((p) => p.name === 'min_check').value, 1100);
  assert.strictEqual(sim.state.saves, 0);

  // CLI kipinde MSP işlenmez: telemetri durur, motor testi reddedilir, bağlantı "bağlı" kalır
  const frozen = v.snapshot().stats.rxMsgs;
  await new Promise((r2) => setTimeout(r2, 1100)); // linkTimeoutMs (900) geçse de
  assert.strictEqual(v.snapshot().stats.rxMsgs, frozen);
  assert.strictEqual(v.snapshot().linked, true);
  assert.deepStrictEqual(await v.motorTest({ motor: 1, throttlePct: 5, seconds: 1 }), { ok: false, error: 'cli_mode' });
  assert.deepStrictEqual(await v.calibrate('accel'), { ok: false, error: 'cli_mode' });

  // save: EEPROM'a yazar, kart yeniden başlar; bağlantı düşer ve kendiliğinden döner
  ev.texts.length = 0;
  const t0 = Date.now();
  const p = v.saveParams();
  await waitFor(() => v.snapshot().rebooting && !v.snapshot().linked, 3000, 'rebooting state');
  assert.strictEqual(v.snapshot().systemStatus, 'BOOT');
  assert.deepStrictEqual(await p, { ok: true });
  assert.ok(Date.now() - t0 < 8000);
  assert.strictEqual(sim.state.saves, 1);
  assert.strictEqual(sim.state.rebooted, 1);
  const s = v.snapshot();
  assert.deepStrictEqual([s.linked, s.connected, s.cliMode, s.rebooting, s.unsaved, s.error], [true, true, false, false, 0, null]);
  // Yeniden tanındı: yeni ayarlar MSP'den de görünür
  assert.strictEqual(s.craftName, 'KARTAL');
  assert.deepStrictEqual(s.frame.motors.map((m) => m.dir), ['ccw', 'cw', 'cw', 'ccw']);
  assert.ok(ev.texts.some((m) => m.severity === 6 && /saved/i.test(m.text)));
  assert.ok(ev.texts.some((m) => m.severity === 6 && /back online/i.test(m.text)));
  const rx = s.stats.rxMsgs;
  await waitFor(() => v.snapshot().stats.rxMsgs > rx + 5 && !v.snapshot().armingDisabled.includes('CLI'), 3000, 'telemetry after reboot');
  assert.strictEqual(sim.settings.get('min_check'), '1100');
});

test.it('betaflight: cli() — çıktı, olaylar, bilinmeyen komut, set izleme, exitCli', async (t) => {
  const { sim, v, ev } = await session(t, {});
  await linked(v);
  const r = await v.cli('status');
  assert.strictEqual(r.ok, true);
  assert.match(r.text, /^MCU F40X Clock=168MHz/);
  assert.match(r.text, /Arming disable flags: RXLOSS CLI$/);
  assert.ok(!/\r/.test(r.text) && !/^status/m.test(r.text) && !/# $/.test(r.text), 'yankı ve istem ayıklanır');
  assert.strictEqual(r.text.split('\n').length, 13);
  assert.strictEqual(v.snapshot().cliMode, true);
  // 'cli' olayları aynı metni sırasıyla taşır
  assert.strictEqual(ev.cli.join('').trim(), r.text);
  assert.ok(ev.logs.length >= 0);
  await waitFor(() => ev.logs.some((e) => e.name === 'CLI' && e.dir === 'tx' && e.text === 'status') && ev.logs.some((e) => e.name === 'CLI' && e.dir === 'rx' && /^MCU/.test(e.text)), 2000, 'cli log');

  const ver = await v.cli('version');
  assert.match(ver.text, /^# Betaflight \/ STM32F405 \(S405\) 4\.5\.1 .* MSP API: 1\.46\n# board: manufacturer_id: SPBE/);
  const unk = await v.cli('frobnicate');
  assert.deepStrictEqual(unk, { ok: true, text: "###ERROR IN input: UNKNOWN COMMAND, TRY 'HELP'###" });
  const one = await v.cli('get min_check');
  assert.strictEqual(one.text, 'min_check = 1050\nAllowed range: 750 - 2250');
  const dump = await v.cli('dump all');
  assert.match(dump.text, /# version\n# Betaflight/);
  assert.match(dump.text, /\nset min_check = 1050\n/);
  assert.match(dump.text, /batch end$/);
  assert.deepStrictEqual(await v.cli('  '), { ok: false, error: 'invalid' });

  // Konsoldan yazılan "set" de kaydedilmemiş sayılır
  ev.cli.length = 0;
  const set = await v.cli('set small_angle = 180');
  assert.deepStrictEqual(set, { ok: true, text: 'small_angle set to 180' });
  assert.strictEqual(ev.cli.join('').trim(), 'small_angle set to 180');
  assert.strictEqual(v.snapshot().unsaved, 1);

  // exitCli: 4.5'te "exit noreboot" — yeniden başlatmaz, RAM'deki değişiklik kalır, telemetri döner
  assert.deepStrictEqual(await v.exitCli(), { ok: true, rebooted: false });
  assert.strictEqual(sim.calls[sim.calls.length - 1].line, 'exit noreboot');
  assert.strictEqual(sim.state.rebooted, 0);
  assert.strictEqual(sim.settings.get('small_angle'), '180');
  await waitFor(() => v.snapshot().linked && !v.snapshot().cliMode && v.snapshot().armingDisabled.includes('CLI'), 3000, 'back to MSP');
  assert.deepStrictEqual(await v.exitCli(), { ok: true, rebooted: false });

  // Konsoldan "exit" (yeniden başlatır): cli() hemen döner, bağlantı arkada geri gelir; kaydedilmemiş değişiklik yiter
  const ex = await v.cli('exit');
  assert.deepStrictEqual([ex.ok, ex.reboot], [true, true]);
  assert.match(ex.text, /leaving CLI mode, unsaved changes lost/);
  assert.strictEqual(v.snapshot().unsaved, 0);
  await waitFor(() => v.snapshot().linked && !v.snapshot().rebooting, 6000, 'relink after exit');
  assert.strictEqual(sim.state.rebooted, 1);
  assert.strictEqual(sim.settings.get('small_angle'), '25');
});

test.it('betaflight: ivmeölçer ve pusula kalibrasyonu olayları', async (t) => {
  const { sim, v, ev } = await session(t, { armingDisableFlags: 0 });
  await linked(v);
  await waitFor(() => v.snapshot().sensors.list.length > 0, 2000, 'sensors');
  assert.deepStrictEqual(await v.calibrate('accel'), { ok: true });
  assert.deepStrictEqual(sim.calls.map((c) => c.name), ['MSP_ACC_CALIBRATION']);
  let states = ev.cal.map((c) => c.state);
  assert.strictEqual(states[0], 'started');
  assert.strictEqual(states[states.length - 1], 'done');
  assert.ok(states.includes('progress'));
  assert.ok(ev.cal.every((c) => c.kind === 'accel' && typeof c.text === 'string'));
  assert.deepStrictEqual([ev.cal[0].percent, ev.cal[ev.cal.length - 1].percent], [0, 100]);
  const pr = ev.cal.filter((c) => c.state === 'progress').map((c) => c.percent);
  assert.deepStrictEqual(pr, pr.slice().sort((a, b) => a - b));

  ev.cal.length = 0;
  const p = v.calibrate('compass');
  await waitFor(() => ev.cal.length > 0, 1000, 'compass started');
  assert.deepStrictEqual(await v.calibrate('accel'), { ok: false, error: 'busy' });
  assert.deepStrictEqual(await p, { ok: true });
  states = ev.cal.map((c) => c.state);
  assert.deepStrictEqual([states[0], states[states.length - 1]], ['started', 'done']);
  assert.ok(ev.cal.every((c) => c.kind === 'compass'));
  assert.match(ev.cal[0].text, /Rotate/);
  assert.strictEqual(sim.calls[1].name, 'MSP_MAG_CALIBRATION');

  // İptal: bekleyiş biter
  ev.cal.length = 0;
  const q = v.calibrate('compass');
  await waitFor(() => ev.cal.length > 0, 1000, 'compass started');
  assert.deepStrictEqual(await v.calibrate('cancel'), { ok: true });
  assert.deepStrictEqual(await q, { ok: false, error: 'cancelled' });
  assert.strictEqual(ev.cal[ev.cal.length - 1].state, 'cancelled');
});

test.it('betaflight: reboot() (MSP) ve kart kapanınca bağlantı kaybı', async (t) => {
  const { sim, v, ev } = await session(t, {});
  await linked(v);
  const r = await v.reboot();
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(sim.calls.map((c) => [c.name, c.mode]), [['MSP_REBOOT', 0]]);
  assert.strictEqual(sim.state.rebooted, 1);
  assert.strictEqual(v.snapshot().linked, true);
  assert.ok(ev.texts.some((m) => m.severity === 6 && /rebooting/i.test(m.text)));

  // Kart yanıt vermeyi keserse (bağlantı açık) 'linked' düşer, yanıtlar dönünce yeniden tanınır
  sim.setSilent(true);
  await waitFor(() => !v.snapshot().linked, 3000, 'link loss (silent)');
  assert.strictEqual(v.snapshot().connected, true);
  sim.setSilent(false);
  await waitFor(() => v.snapshot().linked, 3000, 'link back');

  await sim.stop();
  await waitFor(() => !v.snapshot().linked, 3000, 'link loss (stopped)');
  const s = v.snapshot();
  assert.strictEqual(s.linked, false);
  assert.strictEqual(s.systemStatus, null);
  const q = await v.motorTest({ motor: 1, throttlePct: 5, seconds: 1 });
  assert.strictEqual(q.ok, false);
  v.disconnect();
  assert.deepStrictEqual([v.snapshot().connected, v.snapshot().linked], [false, false]);
  assert.deepStrictEqual(await v.cli('status'), { ok: false, error: 'not_connected' });
});

test.it('betaflight: 4.4 ve öncesi — "exit" her zaman yeniden başlatır; fetchParams CLI\'de kalır', async (t) => {
  const { sim, v } = await session(t, { apiMinor: 45 });
  await linked(v);
  assert.strictEqual(v.snapshot().version, '4.4.1');
  assert.strictEqual(v.snapshot().apiVersion, '1.45');
  const r = await v.fetchParams();
  assert.deepStrictEqual(r, { ok: true, total: 51, received: 51 });
  assert.strictEqual(v.snapshot().cliMode, true);
  assert.deepStrictEqual(sim.calls.map((c) => c.line), ['get']);
  assert.deepStrictEqual(await v.exitCli(), { ok: true, rebooted: true });
  assert.strictEqual(sim.calls[sim.calls.length - 1].line, 'exit');
  assert.strictEqual(sim.state.rebooted, 1);
  assert.deepStrictEqual([v.snapshot().linked, v.snapshot().cliMode], [true, false]);
});

test.it('betaflight: "get" yoksa "dump all" yedeği (aralık bilgisi olmadan)', async (t) => {
  const { sim, v } = await session(t, { noGet: true });
  await linked(v);
  const r = await v.fetchParams();
  assert.deepStrictEqual(r, { ok: true, total: 51, received: 51 });
  assert.deepStrictEqual(sim.calls.map((c) => c.line), ['get', 'dump all', 'exit noreboot']);
  const by = Object.fromEntries(v.getParams().map((p) => [p.name, p]));
  assert.deepStrictEqual([by.min_check.value, by.min_check.type, by.min_check.range, by.min_check.guessed], [1050, 'number', null, true]);
  assert.deepStrictEqual([by.p_roll.value, by.p_roll.scope, by.p_roll.profile], [45, 'profile', 0]);
  assert.deepStrictEqual([by.yaw_motors_reversed.type, by.yaw_motors_reversed.values], ['enum', ['OFF', 'ON']]);
  assert.strictEqual(by.acc_calibration.type, 'array');
});

test.it('betaflight: kart CLI kipinde bırakılmışsa bağlanınca sezilir ve çıkılabilir', async (t) => {
  // Seri hatta kartın CLI durumu oturumlar arasında kalır; sim'de bunu cliSticky taklit eder
  const { sim, v, ev } = await session(t, { cliSticky: true });
  sim.state.cli = true;
  sim.state.cliEver = true;
  assert.deepStrictEqual(await v.connect(), { ok: true });
  // MSP istekleri yanıtlanmaz ama yankılanır → CLI kipi sezilir, sürüm CLI'den öğrenilir
  await waitFor(() => v.snapshot().cliMode, 4000, 'cli adopted');
  assert.ok(ev.texts.some((m) => m.severity === 4 && /CLI mode/.test(m.text)));
  await waitFor(() => v.snapshot().apiVersion === '1.46' && v.snapshot().version === '4.5.1', 3000, 'version from CLI');
  assert.strictEqual(v.snapshot().linked, true);
  assert.strictEqual(v.snapshot().board, 'STM32F405');
  const r = await v.cli('get min_check');
  assert.match(r.text, /^min_check = 1050/);
  assert.deepStrictEqual(await v.exitCli(), { ok: true, rebooted: false });
  await waitFor(() => v.snapshot().linked && !v.snapshot().cliMode && v.snapshot().board === 'SPEEDYBEEF405V4' && v.snapshot().frame, 3000, 'identified after exit');
  assert.strictEqual(v.snapshot().frame.name, 'QUAD X');
});
});
