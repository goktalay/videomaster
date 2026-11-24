'use strict';

// Dron haberleşme çekirdeği sınamaları: MAVLink çözücü/kodlayıcı (pymavlink ile üretilmiş bayt bayt doğru çerçeveler),
// taşıyıcılar (TCP, UDP, UDP dinleme) ve sahte ArduCopter'a karşı uçtan uca araç oturumu.

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');

const mav = require('../src/drone/mavlink');
const { createLink, listSerialPorts } = require('../src/drone/link');
const { MavVehicle } = require('../src/drone/vehicle');
const { createSim } = require('./sim/vehicle-sim');

const { MavParser, encode, enumName, crcX25 } = mav;

// pymavlink 2.4.50 (dialects.v20/v10.ardupilotmega) ile üretildi
const VEC = {
  hb_v2: 'fd090000070101000000040000000203510403381c',
  hb_v1: 'fe0907010100040000000203510403661d',
  param_value: 'fd1900000a01011600000000803f3f000c004652414d455f434c4153530000000000091213',
  command_long: 'fd2000002affbe4c00000000803f0098a5460000000000000000000000000000000000000000900101017c75',
  gpi: 'fd1c0000c8010121000040e20100d825cc17d8ff9613d4eb0d00c8c300006affdc00e2ff8769b0a2',
  statustext: 'fd360000030101fd00000650726541726d3a20436f6d70617373206e6f742063616c696272617465640000000000000000000000000000000000000000070001d613',
  statustext_noext: 'fd060000040101fd00000648656c6c6f9306',
  trunc_cmdack: 'fd0200000501014d00009001b82a',
  sys_status_ext: 'fd280000060101010000341200003402000034000000f4013831ffff000000000000000000000000ff0700000008000000097332',
  param_set_v1: 'fe17090101170080894401015243315f4d494e000000000000000000092ef7',
  zero_trunc: 'fd0100000b01014d0000008158',
};
const hex = (h) => Buffer.from(h, 'hex');

async function waitFor(cond, ms = 4000, what = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

function decodeOne(h) {
  const msgs = new MavParser().push(hex(h));
  assert.strictEqual(msgs.length, 1);
  return msgs[0];
}

// ---------------------------------------------------------------- MAVLink

test('mavlink: tanımlar yüklü (common + ardupilotmega) ve CRC X.25 doğru', () => {
  assert.ok(Object.keys(mav.MESSAGES).length > 300);
  assert.strictEqual(mav.MESSAGES.HEARTBEAT.crcExtra, 50);
  assert.strictEqual(mav.MESSAGES_BY_ID[253].name, 'STATUSTEXT');
  assert.ok(mav.MESSAGES.MAG_CAL_PROGRESS && mav.MESSAGES.EKF_STATUS_REPORT, 'ardupilotmega iletileri');
  assert.strictEqual(crcX25(Buffer.from('123456789')), 0x6f91); // CRC-16/MCRF4XX sınama değeri
  assert.strictEqual(enumName('MAV_TYPE', 2), 'MAV_TYPE_QUADROTOR');
  assert.strictEqual(enumName('MAV_AUTOPILOT', 12), 'MAV_AUTOPILOT_PX4');
  assert.strictEqual(enumName('MAV_RESULT', 4), 'MAV_RESULT_FAILED');
  assert.strictEqual(enumName('MAV_CMD', 400), 'MAV_CMD_COMPONENT_ARM_DISARM');
  assert.strictEqual(enumName('ACCELCAL_VEHICLE_POS', 16777215), 'ACCELCAL_VEHICLE_POS_SUCCESS');
  assert.strictEqual(enumName('MAV_TYPE', 9999), null);
  assert.strictEqual(mav.enumValue('MAV_SEVERITY', 'MAV_SEVERITY_WARNING'), 4);
  assert.deepStrictEqual(mav.COMMANDS[209].params.slice(0, 4), ['Instance', 'Throttle Type', 'Throttle', 'Timeout']);
  for (const e of ['MAV_STATE', 'MAV_MODE_FLAG', 'MAV_PARAM_TYPE', 'GPS_FIX_TYPE', 'MAG_CAL_STATUS', 'MOTOR_TEST_ORDER', 'MOTOR_TEST_THROTTLE_TYPE', 'MAV_FRAME', 'MAV_SYS_STATUS_SENSOR']) assert.ok(mav.ENUMS[e], e);
});

test('mavlink: HEARTBEAT v1 ve v2 çözülür, bayt bayt aynı kodlanır', () => {
  const fields = { type: 2, autopilot: 3, base_mode: 81, custom_mode: 4, system_status: 4, mavlink_version: 3 };
  const m2 = decodeOne(VEC.hb_v2);
  assert.strictEqual(m2.version, 2);
  assert.strictEqual(m2.name, 'HEARTBEAT');
  assert.deepStrictEqual([m2.seq, m2.sysid, m2.compid, m2.msgid], [7, 1, 1, 0]);
  assert.deepStrictEqual(m2.fields, fields);
  assert.strictEqual(m2.raw.toString('hex'), VEC.hb_v2);
  const m1 = decodeOne(VEC.hb_v1);
  assert.strictEqual(m1.version, 1);
  assert.deepStrictEqual(m1.fields, fields);
  assert.strictEqual(encode('HEARTBEAT', fields, { sysid: 1, compid: 1, seq: 7 }).toString('hex'), VEC.hb_v2);
  assert.strictEqual(encode('HEARTBEAT', fields, { sysid: 1, compid: 1, seq: 7, version: 1 }).toString('hex'), VEC.hb_v1);
});

test('mavlink: PARAM_VALUE, COMMAND_LONG, GLOBAL_POSITION_INT, PARAM_SET (v1)', () => {
  const pv = decodeOne(VEC.param_value);
  assert.deepStrictEqual(pv.fields, { param_value: 1, param_count: 63, param_index: 12, param_id: 'FRAME_CLASS', param_type: 9 });
  assert.strictEqual(encode('PARAM_VALUE', pv.fields, { sysid: 1, compid: 1, seq: 10 }).toString('hex'), VEC.param_value);

  const cl = decodeOne(VEC.command_long);
  assert.strictEqual(cl.fields.command, 400);
  assert.strictEqual(cl.fields.param1, 1);
  assert.strictEqual(cl.fields.param2, 21196);
  assert.deepStrictEqual([cl.sysid, cl.compid, cl.seq], [255, 190, 42]);
  // Eksik alanlar 0; varsayılan gönderen 255/190
  assert.strictEqual(encode('COMMAND_LONG', { target_system: 1, target_component: 1, command: 400, param1: 1, param2: 21196 }, { seq: 42 }).toString('hex'), VEC.command_long);

  const gp = decodeOne(VEC.gpi);
  assert.deepStrictEqual(gp.fields, { time_boot_ms: 123456, lat: 399255000, lon: 328663000, alt: 912340, relative_alt: 50120, vx: -150, vy: 220, vz: -30, hdg: 27015 });
  assert.strictEqual(encode('GLOBAL_POSITION_INT', gp.fields, { sysid: 1, compid: 1, seq: 200 }).toString('hex'), VEC.gpi);

  const ps = decodeOne(VEC.param_set_v1);
  assert.strictEqual(ps.version, 1);
  assert.deepStrictEqual(ps.fields, { param_value: 1100, target_system: 1, target_component: 1, param_id: 'RC1_MIN', param_type: 9 });
  assert.strictEqual(encode('PARAM_SET', ps.fields, { sysid: 1, compid: 1, seq: 9, version: 1 }).toString('hex'), VEC.param_set_v1);
});

test('mavlink: STATUSTEXT, uzantı alanları ve v2 sıfır kırpma', () => {
  const st = decodeOne(VEC.statustext);
  assert.deepStrictEqual(st.fields, { severity: 6, text: 'PreArm: Compass not calibrated', id: 7, chunk_seq: 1 });
  assert.strictEqual(encode('STATUSTEXT', st.fields, { sysid: 1, compid: 1, seq: 3 }).toString('hex'), VEC.statustext);

  // Uzantılar 0 ise kırpılır: yük 54 yerine 6 bayt
  const s2 = decodeOne(VEC.statustext_noext);
  assert.strictEqual(s2.raw[1], 6);
  assert.deepStrictEqual(s2.fields, { severity: 6, text: 'Hello', id: 0, chunk_seq: 0 });
  assert.strictEqual(encode('STATUSTEXT', { severity: 6, text: 'Hello' }, { sysid: 1, compid: 1, seq: 4 }).toString('hex'), VEC.statustext_noext);

  // COMMAND_ACK: 10 baytlık yük 2 bayta kırpılmış; uzantılar 0 okunur
  const ca = decodeOne(VEC.trunc_cmdack);
  assert.strictEqual(ca.raw[1], 2);
  assert.deepStrictEqual(ca.fields, { command: 400, result: 0, progress: 0, result_param2: 0, target_system: 0, target_component: 0 });
  assert.strictEqual(ca.payload.length, mav.MESSAGES.COMMAND_ACK.length);
  assert.strictEqual(encode('COMMAND_ACK', { command: 400, result: 0 }, { sysid: 1, compid: 1, seq: 5 }).toString('hex'), VEC.trunc_cmdack);

  // Tümü sıfır olan yük en az 1 bayt kalır
  assert.strictEqual(encode('COMMAND_ACK', {}, { sysid: 1, compid: 1, seq: 11 }).toString('hex'), VEC.zero_trunc);
  assert.strictEqual(decodeOne(VEC.zero_trunc).fields.command, 0);

  // SYS_STATUS: uzantı alanları dolu
  const ss = decodeOne(VEC.sys_status_ext);
  assert.strictEqual(ss.fields.onboard_control_sensors_present, 0x1234);
  assert.strictEqual(ss.fields.voltage_battery, 12600);
  assert.strictEqual(ss.fields.current_battery, -1);
  assert.strictEqual(ss.fields.battery_remaining, -1);
  assert.deepStrictEqual([ss.fields.onboard_control_sensors_present_extended, ss.fields.onboard_control_sensors_enabled_extended, ss.fields.onboard_control_sensors_health_extended], [7, 8, 9]);
  assert.strictEqual(encode('SYS_STATUS', ss.fields, { sysid: 1, compid: 1, seq: 6 }).toString('hex'), VEC.sys_status_ext);
});

test('mavlink: diziler, 64 bit, Buffer ile ham alan ve v1 kısıtı', () => {
  const b = encode('BATTERY_STATUS', { id: 0, voltages: [12600, 65535], current_battery: -1, battery_remaining: 77, voltages_ext: [1, 2, 3, 4] }, { sysid: 1, compid: 1 });
  const m = decodeOne(b.toString('hex'));
  assert.deepStrictEqual(m.fields.voltages, [12600, 65535, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(m.fields.voltages_ext, [1, 2, 3, 4]);
  assert.strictEqual(m.fields.current_battery, -1);

  const t = decodeOne(encode('SYSTEM_TIME', { time_unix_usec: 1732350000123456, time_boot_ms: 5000 }).toString('hex'));
  assert.strictEqual(t.fields.time_unix_usec, 1732350000123456);
  const big = decodeOne(encode('SYSTEM_TIME', { time_unix_usec: 0xffffffffffffffffn }).toString('hex'));
  assert.strictEqual(big.fields.time_unix_usec, 2 ** 64); // güvenli aralık dışı: yaklaşık değer

  // PX4 tarzı: int32 değeri float alanına bayt bayt (−1 = NaN bit düzeni; bozulmadan taşınmalı)
  const raw = Buffer.alloc(4);
  raw.writeInt32LE(-1);
  const ps = decodeOne(encode('PARAM_SET', { target_system: 1, target_component: 1, param_id: 'CA_ROTOR_COUNT', param_value: raw, param_type: 6 }).toString('hex'));
  assert.strictEqual(ps.payload.readInt32LE(0), -1);
  assert.strictEqual(ps.fields.param_id, 'CA_ROTOR_COUNT'); // 16 baytın tamamı dolu, NUL yok

  assert.throws(() => encode('AUTOPILOT_STATE_FOR_GIMBAL_DEVICE', {}, { version: 1 }), /v1/);
  assert.throws(() => encode('NO_SUCH_MESSAGE', {}), /unknown/);
});

test('mavlink: akış çözücü — bölünmüş veri, çöp baytlar, bozuk CRC, imza, bilinmeyen kimlik, kayıp sayımı', () => {
  const p = new MavParser();
  const a = hex(VEC.hb_v2);                       // seq 7, 1/1
  const b = encode('ATTITUDE', { roll: 0.1 }, { sysid: 1, compid: 1, seq: 8 });
  const c = encode('VFR_HUD', { alt: 10 }, { sysid: 1, compid: 1, seq: 12 }); // 9, 10, 11 kayıp
  const bad = Buffer.from(b); bad[12] ^= 0xff;    // CRC tutmaz

  // İmzalı çerçeve: uyumsuzluk bayrağı 0x01 + 13 baytlık imza (CRC bayrağı da kapsar)
  const signed = Buffer.concat([encode('HEARTBEAT', { type: 2, autopilot: 3 }, { sysid: 1, compid: 1, seq: 13 }), Buffer.alloc(13, 0xaa)]);
  signed[2] = 0x01;
  const len = signed[1];
  let crc = crcX25(signed, 1, 10 + len);
  crc = crcX25(Buffer.from([mav.MESSAGES.HEARTBEAT.crcExtra]), 0, 1, crc);
  signed.writeUInt16LE(crc, 10 + len);

  // Bilinmeyen ileti kimliği (v2, kimlik 59999)
  const unk = Buffer.from([0xfd, 3, 0, 0, 14, 1, 1, 0x5f, 0xea, 0x00, 1, 2, 3, 0, 0]);

  const stream = Buffer.concat([Buffer.from([0x00, 0x11, 0xfe, 0x22]), a, Buffer.from([0x55, 0xfd]), b, bad, c, signed, unk, hex(VEC.hb_v1)]);
  const out = [];
  for (let i = 0; i < stream.length; i += 7) out.push(...p.push(stream.subarray(i, i + 7))); // 7'şer baytlık parçalar
  assert.deepStrictEqual(out.map((m) => m.name), ['HEARTBEAT', 'ATTITUDE', 'VFR_HUD', 'HEARTBEAT', 'UNKNOWN_59999', 'HEARTBEAT']);
  assert.strictEqual(out[3].signed, true);
  assert.strictEqual(out[3].raw.length, 12 + len + 13);
  assert.strictEqual(out[4].fields, null);
  assert.strictEqual(out[4].msgid, 59999);
  assert.strictEqual(out[5].version, 1);
  assert.ok(p.stats.crcErrors >= 1);
  // seq: 7, 8, 12 (3 kayıp), 13, 14, sonra v1 çerçevesi seq 7 (248 "kayıp" — sayaç sarması)
  assert.strictEqual(p.stats.lost, 3 + ((7 - 14 - 1) & 0xff));
  assert.strictEqual(p.stats.frames, 6);

  // Tek tek bayt beslemesi de aynı sonucu verir
  const p2 = new MavParser();
  let n = 0;
  for (const byte of Buffer.concat([a, b, c])) n += p2.push(Buffer.from([byte])).length;
  assert.strictEqual(n, 3);
  assert.strictEqual(p2.stats.lost, 3);
});

// ---------------------------------------------------------------- Taşıyıcılar

function collect(link) {
  const parser = new MavParser();
  const names = [];
  link.on('data', (d) => { for (const m of parser.push(d)) names.push(m.name); });
  return names;
}
const gcsHeartbeat = () => encode('HEARTBEAT', { type: 6, autopilot: 8, system_status: 4, mavlink_version: 3 });

test('link: tcp — sahte araca bağlanır, veri alır ve gönderir', async () => {
  const sim = await createSim({ tcp: 0, heartbeatMs: 100 }).start();
  const link = createLink({ type: 'tcp', host: '127.0.0.1', port: sim.tcpPort });
  try {
    assert.strictEqual(link.describe(), `tcp 127.0.0.1:${sim.tcpPort}`);
    assert.strictEqual(link.write(gcsHeartbeat()), false, 'kapalıyken yazılamaz');
    const names = collect(link);
    let opened = 0;
    link.on('open', () => opened++);
    await link.open();
    assert.strictEqual(link.isOpen, true);
    assert.strictEqual(opened, 1);
    assert.strictEqual(link.write(encode('COMMAND_LONG', { target_system: 1, target_component: 1, command: 400, param1: 1 })), true);
    await waitFor(() => names.includes('HEARTBEAT') && names.includes('COMMAND_ACK'), 3000, 'tcp data');
    assert.strictEqual(sim.state.armed, true);
    let closed = 0;
    link.on('close', () => closed++);
    link.close();
    assert.strictEqual(link.isOpen, false);
    assert.strictEqual(closed, 1);
  } finally { link.close(); await sim.stop(); }
});

test('link: tcp — kapalı kapıya bağlanma reddedilir (connect_failed)', async () => {
  const tmp = dgram.createSocket('udp4');
  await new Promise((r) => tmp.bind(0, '127.0.0.1', r));
  const port = tmp.address().port; // TCP'de bu kapıyı dinleyen yok
  tmp.close();
  const link = createLink({ type: 'tcp', host: '127.0.0.1', port });
  await assert.rejects(link.open(), (e) => e.code === 'connect_failed');
  assert.strictEqual(link.isOpen, false);
  link.close();
});

test('link: udp — dinleyen araca gönderir, yanıtları aynı soketten alır', async () => {
  const sim = await createSim({ udpListen: 0, heartbeatMs: 100 }).start();
  const link = createLink({ type: 'udp', host: '127.0.0.1', port: sim.udpPort });
  try {
    assert.strictEqual(link.describe(), `udp → 127.0.0.1:${sim.udpPort}`);
    const names = collect(link);
    await link.open();
    assert.strictEqual(link.isOpen, true);
    assert.strictEqual(link.write(gcsHeartbeat()), true); // araç bizi bu paketle öğrenir
    await waitFor(() => names.includes('HEARTBEAT') && names.includes('ATTITUDE'), 3000, 'udp data');
  } finally { link.close(); await sim.stop(); }
});

test('link: udpin — kapıyı dinler, karşı ucu ilk paketten öğrenir; dolu kapı port_in_use', async () => {
  const link = createLink({ type: 'udpin', localPort: 0 });
  let sim = null;
  try {
    assert.strictEqual(createLink({ type: 'udpin' }).describe(), 'udp ← :14550');
    const names = collect(link);
    await link.open();
    const port = link.localPort;
    assert.ok(port > 0);
    assert.strictEqual(link.describe(), `udp ← :${port}`);
    assert.strictEqual(link.write(gcsHeartbeat()), false, 'karşı uç bilinmeden yazılamaz');
    sim = await createSim({ udp: { host: '127.0.0.1', port }, heartbeatMs: 100 }).start();
    await waitFor(() => names.includes('HEARTBEAT'), 3000, 'udpin data');
    assert.strictEqual(link.write(encode('COMMAND_LONG', { target_system: 1, target_component: 1, command: 400, param1: 1 })), true);
    await waitFor(() => names.includes('COMMAND_ACK'), 3000, 'udpin reply');
    assert.strictEqual(sim.state.armed, true);

    const second = createLink({ type: 'udpin', localPort: port });
    await assert.rejects(second.open(), (e) => e.code === 'port_in_use');
    assert.strictEqual(second.isOpen, false);
  } finally { link.close(); if (sim) await sim.stop(); }
});

test('link: seri — listSerialPorts dizi döner; bilinmeyen tür hata verir', async () => {
  const ports = await listSerialPorts();
  assert.ok(Array.isArray(ports));
  for (const p of ports) assert.strictEqual(typeof p.path, 'string');
  const serial = createLink({ type: 'serial', serialPort: 'COM5', baud: '57600' });
  assert.strictEqual(serial.describe(), 'COM5 @ 57600');
  assert.strictEqual(createLink({ type: 'serial', serialPort: 'COM5' }).describe(), 'COM5 @ 115200');
  assert.strictEqual(serial.write(Buffer.from([1])), false);
  assert.throws(() => createLink({ type: 'bluetooth' }), (e) => e.code === 'unsupported');
});

// ---------------------------------------------------------------- Araç (uçtan uca)

const FAST = { linkTimeoutMs: 900, paramGapMs: 250 };

test('vehicle: sahte ArduCopter ile uçtan uca (TCP)', async (t) => {
  const sim = await createSim({ tcp: 0, heartbeatMs: 150, calStepMs: 15, dropParams: [3, 17, 18, 40] }).start();
  const v = new MavVehicle({ type: 'tcp', host: '127.0.0.1', port: sim.tcpPort }, { ...FAST, streamRate: 5 });
  const log = [];
  const texts = [];
  const cals = [];
  const states = [];
  const paramEvents = [];
  let paramCount = 0;
  let messages = 0;
  v.on('log', (batch) => { assert.ok(Array.isArray(batch)); log.push(...batch); });
  v.on('statustext', (s) => texts.push(s));
  v.on('calibration', (c) => cals.push(c));
  v.on('state', (s) => states.push({ t: Date.now(), s }));
  v.on('params', (p) => paramEvents.push(p));
  v.on('param', () => paramCount++);
  v.on('message', () => messages++);
  t.after(async () => { v.disconnect(); await sim.stop(); });

  await t.test('bağlantı, yazılım/araç/kip algılama', async () => {
    assert.strictEqual(v.snapshot().connected, false);
    assert.deepStrictEqual(await v.connect(), { ok: true });
    await waitFor(() => v.snapshot().linked, 3000, 'linked');
    const s = v.snapshot();
    assert.strictEqual(s.connected, true);
    assert.strictEqual(s.link, `tcp 127.0.0.1:${sim.tcpPort}`);
    assert.strictEqual(s.error, null);
    assert.strictEqual(s.firmware, 'ardupilot');
    assert.strictEqual(s.vehicle, 'copter');
    assert.strictEqual(s.mavType, 2);
    assert.strictEqual(s.autopilot, 3);
    assert.deepStrictEqual([s.sysid, s.compid], [1, 1]);
    assert.strictEqual(s.armed, false);
    assert.strictEqual(s.mode, 'STABILIZE');
    assert.strictEqual(s.systemStatus, 'STANDBY');
    assert.ok(s.modes.some((m) => m.id === 5 && m.name === 'LOITER'));
    await waitFor(() => v.snapshot().version === '4.5.7', 3000, 'version');
    // Akış istekleri araca ulaştı
    await waitFor(() => sim.calls.filter((c) => c.name === 'REQUEST_DATA_STREAM').length >= 7 && sim.state.intervals[30] === 100000, 3000, 'stream requests');
    assert.strictEqual(sim.state.streams[10], 5);
  });

  await t.test('telemetri dolar', async () => {
    await waitFor(() => { const tl = v.snapshot().telemetry; return tl.roll !== null && tl.lat !== null && tl.voltage !== null && tl.gpsFix !== null && tl.rc.length === 18 && tl.servo.length === 16 && tl.homeLat !== null && tl.groundspeed !== null && tl.vibration && tl.ekfOk !== null && tl.wpDist !== null; }, 5000, 'telemetry');
    const s = v.snapshot();
    const tl = s.telemetry;
    assert.ok(Math.abs(tl.lat - 39.9255) < 0.01 && Math.abs(tl.lon - 32.8663) < 0.01);
    assert.ok(Math.abs(tl.homeLat - 39.9255) < 1e-6 && Math.abs(tl.homeLon - 32.8663) < 1e-6);
    assert.ok(tl.altRel >= 0 && tl.altRel <= 60.5);
    assert.ok(Math.abs(tl.roll) < 20 && tl.yaw >= 0 && tl.yaw < 360);
    assert.ok(tl.voltage > 13 && tl.voltage < 17.5);
    assert.strictEqual(tl.gpsFix, 3);
    assert.strictEqual(tl.gpsFixName, '3D_FIX');
    assert.strictEqual(tl.sats, 14);
    assert.strictEqual(tl.hdop, 0.85);
    assert.strictEqual(tl.rssi, 210);
    assert.strictEqual(tl.ekfOk, true);
    assert.ok(tl.rc[0] > 1300 && tl.rc[0] < 1700);
    assert.ok(tl.groundspeed > 5 && tl.heading >= 0 && tl.heading <= 360);
    assert.strictEqual(tl.load, 18.2);
    assert.ok(tl.time > 0);
    assert.ok(s.sensors.present > 0 && s.sensors.list.length > 20);
    const gyro = s.sensors.list.find((x) => x.name === 'SENSOR_3D_GYRO');
    assert.deepStrictEqual([gyro.present, gyro.enabled, gyro.healthy], [true, true, true]);
    assert.ok(s.stats.rxMsgs > 10 && s.stats.rxBytes > 100 && s.stats.txMsgs > 5);
    assert.strictEqual(s.stats.lost, 0);
    assert.ok(messages > 10);
    assert.doesNotThrow(() => JSON.stringify(s)); // pencerelere gönderilebilir düz nesne
  });

  await t.test('parametreler: düşen paketlere karşın tam indirilir', async () => {
    assert.strictEqual(v.snapshot().frame, null);
    const [r, again] = await Promise.all([v.fetchParams(), v.fetchParams()]);
    assert.deepStrictEqual(r, { ok: true, total: sim.params.size, received: sim.params.size });
    assert.strictEqual(again, r, 'eşzamanlı çağrılar aynı sonucu paylaşır');
    const list = v.getParams();
    assert.strictEqual(list.length, sim.params.size);
    assert.deepStrictEqual(list.map((p) => p.name), [...sim.params.keys()].sort());
    const fc = list.find((p) => p.name === 'FRAME_CLASS');
    assert.deepStrictEqual({ value: fc.value, type: fc.type }, { value: 1, type: 2 });
    assert.ok(Math.abs(list.find((p) => p.name === 'ATC_RAT_RLL_P').value - 0.135) < 1e-6);
    // Eksik dört indeks tek tek istendi
    const reads = sim.calls.filter((c) => c.name === 'PARAM_REQUEST_READ').map((c) => c.params[0]).sort((a, b) => a - b);
    assert.deepStrictEqual(reads, [3, 17, 18, 40]);
    assert.ok(paramCount >= sim.params.size);
    const last = paramEvents[paramEvents.length - 1];
    assert.deepStrictEqual(last, { total: sim.params.size, received: sim.params.size, loading: false, done: true });
    assert.ok(paramEvents.some((p) => p.loading && !p.done));
    assert.deepStrictEqual(v.snapshot().params, { total: sim.params.size, received: sim.params.size, loading: false });
  });

  await t.test('gövde: QUAD X, 4 motor, dönüş yönleri doğru', () => {
    const f = v.snapshot().frame;
    assert.strictEqual(f.class, 1);
    assert.strictEqual(f.type, 1);
    assert.strictEqual(f.name, 'QUAD X');
    assert.strictEqual(f.motors.length, 4);
    const byN = Object.fromEntries(f.motors.map((m) => [m.n, m]));
    // ArduCopter QUAD X: 1 ön sağ (CCW, A), 2 arka sol (CCW, C), 3 ön sol (CW, D), 4 arka sağ (CW, B)
    assert.deepStrictEqual(byN[1], { n: 1, testOrder: 1, x: 1, y: 1, dir: 'ccw' });
    assert.deepStrictEqual(byN[2], { n: 2, testOrder: 3, x: -1, y: -1, dir: 'ccw' });
    assert.deepStrictEqual(byN[3], { n: 3, testOrder: 4, x: -1, y: 1, dir: 'cw' });
    assert.deepStrictEqual(byN[4], { n: 4, testOrder: 2, x: 1, y: -1, dir: 'cw' });
  });

  await t.test('setParam gidiş-dönüş, reddedilen değer, saveRcLimits', async () => {
    assert.deepStrictEqual(await v.setParam('RC1_MIN', 1011), { ok: true, value: 1011 });
    assert.strictEqual(sim.params.get('RC1_MIN').value, 1011);
    assert.strictEqual(v.getParams().find((p) => p.name === 'RC1_MIN').value, 1011);
    const r = await v.setParam('ATC_RAT_PIT_P', 0.1234);
    assert.strictEqual(r.ok, true);
    assert.ok(Math.abs(r.value - 0.1234) < 1e-6);
    assert.deepStrictEqual(sim.calls.filter((c) => c.name === 'PARAM_SET')[0].params, ['RC1_MIN', 1011, 4]); // tür araçtan öğrenildi (INT16)

    const rc = await v.saveRcLimits([1001, 1002], [2001, null], [1501]);
    assert.deepStrictEqual(rc, { ok: true, written: 4, failed: [] });
    assert.deepStrictEqual(['RC1_MIN', 'RC2_MIN', 'RC1_MAX', 'RC2_MAX', 'RC1_TRIM'].map((n) => sim.params.get(n).value), [1001, 1002, 2001, 1900, 1501]);

    // FRAME_TYPE değişince yerleşim yeniden türetilir
    assert.strictEqual((await v.setParam('FRAME_TYPE', 0)).ok, true);
    assert.strictEqual(v.snapshot().frame.name, 'QUAD PLUS');
    assert.strictEqual((await v.setParam('FRAME_TYPE', 1)).ok, true);
    assert.strictEqual(v.snapshot().frame.name, 'QUAD X');
    assert.deepStrictEqual(await v.setParam('', 1), { ok: false, error: 'invalid' });
  });

  await t.test('kurma / çözme ve kip değiştirme', async () => {
    let r = await v.arm(true);
    assert.deepStrictEqual(r, { ok: true, result: 0, resultName: 'MAV_RESULT_ACCEPTED' });
    await waitFor(() => v.snapshot().armed === true, 2000, 'armed');
    assert.strictEqual(v.snapshot().systemStatus, 'ACTIVE');
    assert.deepStrictEqual(sim.calls.filter((c) => c.id === 400).pop().params.slice(0, 2), [1, 0]);
    r = await v.arm(false, true);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(sim.calls.filter((c) => c.id === 400).pop().params.slice(0, 2), [0, 21196]);
    await waitFor(() => v.snapshot().armed === false, 2000, 'disarmed');

    r = await v.setMode('loiter');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, 'LOITER');
    await waitFor(() => v.snapshot().mode === 'LOITER', 2000, 'mode');
    assert.deepStrictEqual(sim.calls.filter((c) => c.id === 176).pop().params.slice(0, 2), [1, 5]);
    assert.deepStrictEqual(await v.setMode('WARP_DRIVE'), { ok: false, error: 'unknown_mode' });
    assert.strictEqual((await v.setMode('STABILIZE')).ok, true);

    // Genel komut: adla, kısa adla, desteklenmeyen ve bilinmeyen
    assert.strictEqual((await v.command('MAV_CMD_DO_SET_HOME', [1])).ok, true);
    assert.strictEqual((await v.command('DO_SET_HOME', [1])).ok, true);
    const un = await v.command(31010, []);
    assert.deepStrictEqual(un, { ok: false, result: 3, resultName: 'MAV_RESULT_UNSUPPORTED', error: 'unsupported' });
    assert.strictEqual((await v.command('NOT_A_COMMAND')).error, 'unknown_command');
  });

  await t.test('motor testi araca ulaşır', async () => {
    const r = await v.motorTest({ motor: 3, throttlePct: 12, seconds: 1 });
    assert.strictEqual(r.ok, true);
    const call = sim.calls.filter((c) => c.id === 209).pop();
    assert.deepStrictEqual(call.params, [3, 0, 12, 1, 1, 2, 0]); // sıra 3, yüzde, %12, 1 sn, 1 motor, kart sırası
    await waitFor(() => texts.some((x) => x.text === 'starting motor test'), 2000, 'motor statustext');
    // Test sırası 3 = çıkış 2: telemetrideki servo değeri yükselir
    await waitFor(() => v.snapshot().telemetry.servo[1] === 1120, 2000, 'servo output');
    assert.strictEqual((await v.motorStop()).ok, true);
    assert.deepStrictEqual(sim.calls.filter((c) => c.id === 209).pop().params.slice(0, 4), [1, 0, 0, 0]);
    const seq = await v.motorTest({ motor: 1, throttlePct: 8, seconds: 0.5, count: 4 });
    assert.strictEqual(seq.ok, true);
    assert.strictEqual(sim.calls.filter((c) => c.id === 209).pop().params[4], 4);
    await v.motorStop();
  });

  await t.test('jiroskop / seviye / barometre kalibrasyonu', async () => {
    cals.length = 0;
    assert.deepStrictEqual(await v.calibrate('gyro'), { ok: true, resultName: 'MAV_RESULT_ACCEPTED' });
    assert.deepStrictEqual(sim.calls.filter((c) => c.id === 241).pop().params, [1, 0, 0, 0, 0, 0, 0]);
    assert.deepStrictEqual(cals.filter((c) => c.kind === 'gyro').map((c) => c.state).filter((s) => s !== 'progress'), ['started', 'done']);
    assert.strictEqual((await v.calibrate('level')).ok, true);
    assert.deepStrictEqual(sim.calls.filter((c) => c.id === 241).pop().params, [0, 0, 0, 0, 2, 0, 0]);
    assert.strictEqual((await v.calibrate('baro')).ok, true);
    assert.deepStrictEqual(sim.calls.filter((c) => c.id === 241).pop().params, [0, 0, 1, 0, 0, 0, 0]);
    assert.deepStrictEqual(await v.calibrate('warp'), { ok: false, error: 'unsupported' });
    assert.deepStrictEqual(await v.calibrate('accelNext'), { ok: false, error: 'not_active' });
  });

  await t.test('ivmeölçer kalibrasyonu: 6 adım olaylarla', async () => {
    cals.length = 0;
    const prompts = [];
    const onCal = (c) => {
      if (c.kind !== 'accel' || c.state !== 'prompt') return;
      prompts.push(c.positionName);
      // Kullanıcı aracı istenen konuma getirip "ileri"ye bastı
      setTimeout(() => { v.calibrate('accelNext', c.position).then((r) => assert.strictEqual(r.ok, true)); }, 5);
    };
    v.on('calibration', onCal);
    const busy = v.calibrate('accel');
    assert.deepStrictEqual(await v.calibrate('gyro'), { ok: false, error: 'busy' });
    const r = await busy;
    v.off('calibration', onCal);
    assert.deepStrictEqual(r, { ok: true, resultName: 'ACCELCAL_VEHICLE_POS_SUCCESS' });
    assert.deepStrictEqual(prompts, ['LEVEL', 'LEFT', 'RIGHT', 'NOSEDOWN', 'NOSEUP', 'BACK']);
    assert.strictEqual(cals[0].state, 'started');
    assert.strictEqual(cals[cals.length - 1].state, 'done');
    assert.ok(cals.some((c) => c.state === 'progress' && /Place vehicle level/.test(c.text)), 'durum metinleri iletilir');
    assert.deepStrictEqual(sim.calls.filter((c) => c.id === 42429).map((c) => c.params[0]), [1, 2, 3, 4, 5, 6]);
    assert.deepStrictEqual(sim.calls.filter((c) => c.id === 241).pop().params, [0, 0, 0, 0, 1, 0, 0]);
  });

  await t.test('pusula kalibrasyonu: ilerleme → bitti', async () => {
    cals.length = 0;
    const r = await v.calibrate('compass');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.resultName, 'MAG_CAL_SUCCESS');
    assert.strictEqual(r.autosaved, true);
    assert.deepStrictEqual(r.compass, [{ id: 0, percent: 100, status: 'SUCCESS', fitness: 7.25, ofs: [31.5, -120.5, 64] }]);
    assert.deepStrictEqual(sim.calls.filter((c) => c.id === 42424).pop().params.slice(0, 3), [0, 1, 1]);
    const progress = cals.filter((c) => c.state === 'progress' && typeof c.percent === 'number').map((c) => c.percent);
    assert.ok(progress.length >= 5, 'ilerleme olayları');
    assert.deepStrictEqual(progress, [...progress].sort((a, b) => a - b));
    assert.strictEqual(progress[progress.length - 1], 100);
    assert.strictEqual(cals[0].state, 'started');
    const done = cals[cals.length - 1];
    assert.strictEqual(done.state, 'done');
    assert.strictEqual(done.kind, 'compass');
    assert.strictEqual(done.compass[0].status, 'SUCCESS');

    // İptal: başlat, biraz ilerlesin, vazgeç
    cals.length = 0;
    const pending = v.calibrate('compass');
    await waitFor(() => cals.some((c) => c.state === 'progress'), 2000, 'compass progress');
    assert.strictEqual((await v.calibrate('compassCancel')).ok, true);
    assert.deepStrictEqual(await pending, { ok: false, error: 'cancelled' });
    assert.strictEqual(cals[cals.length - 1].state, 'cancelled');
    assert.strictEqual(sim.state.magCal, null);
  });

  await t.test('ESC kalibrasyonu (ArduPilot): parametre yazılır, yeniden başlatma gerekir', async () => {
    const r = await v.calibrate('esc');
    assert.deepStrictEqual(r, { ok: true, resultName: 'REBOOT_REQUIRED', rebootRequired: true });
    assert.strictEqual(sim.params.get('ESC_CALIBRATION').value, 3);
    assert.strictEqual((await v.reboot()).ok, true);
    assert.strictEqual(sim.state.rebooted, 1);
  });

  await t.test('durum metinleri: çok parçalı metin birleştirilir', async () => {
    assert.ok(texts.some((x) => x.text === 'ArduCopter V4.5.7 (sim)' && x.severityName === 'INFO'));
    const long = 'PreArm: ' + 'çok uzun bir uyarı metni, parçalara bölünür; '.repeat(4) + 'son.';
    assert.ok(Buffer.byteLength(long) > 150);
    texts.length = 0;
    sim.statustext(long, 4);
    sim.statustext('kısa', 2);
    sim.statustext('x'.repeat(100), 6); // tam 2 dolu parça + boş bitiş parçası
    await waitFor(() => texts.length >= 3, 3000, 'statustexts');
    assert.strictEqual(texts.length, 3);
    assert.deepStrictEqual([texts[0].text, texts[0].severity, texts[0].severityName], [long, 4, 'WARNING']);
    assert.deepStrictEqual([texts[1].text, texts[1].severityName], ['kısa', 'CRITICAL']);
    assert.strictEqual(texts[2].text, 'x'.repeat(100));
    assert.ok(texts[0].t > 0);
  });

  await t.test('günlük: gelen ve giden bütün iletiler; durum olayı ≤ 5 Hz', async () => {
    await waitFor(() => log.some((e) => e.dir === 'tx' && e.name === 'COMMAND_LONG') && log.some((e) => e.dir === 'rx' && e.name === 'COMMAND_ACK'), 2000, 'log flush');
    const rx = log.filter((e) => e.dir === 'rx');
    const tx = log.filter((e) => e.dir === 'tx');
    for (const n of ['HEARTBEAT', 'ATTITUDE', 'PARAM_VALUE', 'COMMAND_ACK', 'STATUSTEXT', 'MAG_CAL_PROGRESS', 'COMMAND_LONG']) assert.ok(rx.some((e) => e.name === n), `rx ${n}`);
    for (const n of ['HEARTBEAT', 'COMMAND_LONG', 'PARAM_REQUEST_LIST', 'PARAM_REQUEST_READ', 'PARAM_SET', 'REQUEST_DATA_STREAM']) assert.ok(tx.some((e) => e.name === n), `tx ${n}`);
    const hb = rx.find((e) => e.name === 'HEARTBEAT');
    assert.deepStrictEqual([hb.sysid, hb.compid, hb.id], [1, 1, 0]);
    assert.match(hb.text, /^custom_mode=\d+ type=2 autopilot=3 base_mode=\d+ system_status=\d mavlink_version=3$/);
    const txHb = tx.find((e) => e.name === 'HEARTBEAT');
    assert.deepStrictEqual([txHb.sysid, txHb.compid], [255, 190]);
    const att = rx.find((e) => e.name === 'ATTITUDE');
    assert.match(att.text, / roll=-?\d+(\.\d{1,6})?(e-\d+)? pitch=/);
    const arm = tx.find((e) => e.name === 'COMMAND_LONG' && /command=400/.test(e.text));
    assert.match(arm.text, /param1=1 /);
    assert.ok(log.every((e) => typeof e.t === 'number' && typeof e.text === 'string'));
    // Aracın gönderdiği her ileti günlükte: sayılar tutmalı
    assert.strictEqual(rx.length + (v._logQueue || []).filter((e) => e.dir === 'rx').length, v.snapshot().stats.rxMsgs);
    assert.strictEqual(tx.length + (v._logQueue || []).filter((e) => e.dir === 'tx').length, v.snapshot().stats.txMsgs);
    // Art arda iki durum olayı arasında en az ~200 ms
    assert.ok(states.length > 5);
    for (let i = 1; i < states.length; i++) assert.ok(states[i].t - states[i - 1].t >= 150, `state aralığı ${states[i].t - states[i - 1].t} ms`);
  });

  await t.test('bağlantı kopması algılanır, dönünce akışlar yeniden istenir', async () => {
    assert.strictEqual(v.snapshot().linked, true);
    sim.setSilent(true); // araç sustu (telemetri radyosu koptu)
    const t0 = Date.now();
    await waitFor(() => v.snapshot().linked === false, 4000, 'link loss');
    assert.ok(Date.now() - t0 >= 500, 'zaman aşımından önce kopmuş sayılmamalı');
    assert.strictEqual(v.snapshot().connected, true);
    const before = sim.calls.filter((c) => c.name === 'REQUEST_DATA_STREAM').length;
    sim.setSilent(false);
    await waitFor(() => v.snapshot().linked === true, 3000, 'link back');
    await waitFor(() => sim.calls.filter((c) => c.name === 'REQUEST_DATA_STREAM').length >= before + 7, 2000, 'streams re-requested');
  });

  await t.test('araç kapanınca (sim.stop) bağlantı kopar; disconnect her şeyi temizler', async () => {
    await sim.stop();
    await waitFor(() => v.snapshot().linked === false, 4000, 'link loss after stop');
    const r = await v.arm(true);
    assert.strictEqual(r.ok, false);
    const pending = v.fetchParams();
    v.disconnect();
    assert.strictEqual((await pending).ok, false);
    const s = v.snapshot();
    assert.deepStrictEqual([s.connected, s.linked], [false, false]);
    assert.strictEqual(v.timers.size, 0);
    assert.deepStrictEqual(await v.command(400, [1]), { ok: false, result: null, resultName: null, error: 'not_connected' });
    assert.strictEqual((await v.setParam('RC1_MIN', 1000)).error, 'not_connected');
    assert.strictEqual((await v.calibrate('gyro')).error, 'not_connected');
  });
});

test('vehicle: UDP dinleme (udpin) ile bağlanır; GCS/kamera kalp atışları araç sayılmaz', async () => {
  const v = new MavVehicle({ type: 'udpin', localPort: 0 }, { ...FAST, gcsSysid: 250 });
  let sim = null;
  try {
    assert.deepStrictEqual(await v.connect(), { ok: true });
    const port = v.link.localPort;
    // Önce başka bir yer istasyonu ve bir kamera bileşeni konuşur: araç olarak seçilmemeli
    const other = dgram.createSocket('udp4');
    const sendTo = (buf) => new Promise((r) => other.send(buf, port, '127.0.0.1', r));
    await sendTo(encode('HEARTBEAT', { type: 6, autopilot: 8, system_status: 4, mavlink_version: 3 }, { sysid: 254, compid: 190 }));
    await sendTo(encode('HEARTBEAT', { type: 30, autopilot: 8, system_status: 4, mavlink_version: 3 }, { sysid: 1, compid: 100 }));
    await sendTo(encode('HEARTBEAT', { type: 26, autopilot: 3, system_status: 4, mavlink_version: 3 }, { sysid: 1, compid: 154 }));
    await new Promise((r) => setTimeout(r, 60));
    other.close();
    assert.strictEqual(v.snapshot().linked, false);
    assert.strictEqual(v.snapshot().sysid, null);

    sim = await createSim({ udp: { host: '127.0.0.1', port }, heartbeatMs: 150, sysid: 7, denyArm: true }).start();
    await waitFor(() => v.snapshot().linked, 3000, 'linked over udpin');
    const s = v.snapshot();
    assert.deepStrictEqual([s.sysid, s.compid, s.firmware, s.vehicle], [7, 1, 'ardupilot', 'copter']);
    assert.strictEqual(s.link, `udp ← :${port}`);
    // Kurma reddedilir (kurma öncesi denetim), zorla kurma kabul edilir (ArduPilot: 2989)
    const denied = await v.arm(true);
    assert.deepStrictEqual(denied, { ok: false, result: 4, resultName: 'MAV_RESULT_FAILED', error: 'failed' });
    assert.strictEqual((await v.arm(true, true)).ok, true);
    assert.strictEqual(sim.calls.filter((c) => c.id === 400).pop().params[1], 2989);
    await waitFor(() => v.snapshot().armed, 2000, 'armed');
    // Giden iletiler yapılandırılan GCS kimliğini taşır
    await waitFor(() => v.snapshot().telemetry.roll !== null, 3000, 'telemetry over udp');
  } finally { v.disconnect(); if (sim) await sim.stop(); }
});

test('vehicle: UDP (gönderen) ile bağlanır; bağlantı hatası { ok:false } döner', async () => {
  const sim = await createSim({ udpListen: 0, heartbeatMs: 150 }).start();
  const v = new MavVehicle({ type: 'udp', host: '127.0.0.1', port: sim.udpPort }, FAST);
  try {
    assert.strictEqual((await v.connect()).ok, true);
    await waitFor(() => v.snapshot().linked && v.snapshot().telemetry.lat !== null, 4000, 'linked over udp');
    assert.strictEqual(v.snapshot().mode, 'STABILIZE');
  } finally { v.disconnect(); await sim.stop(); }

  // Kapalı TCP kapısı: reddetmez, hata koduyla çözülür
  const dead = new MavVehicle({ type: 'tcp', host: '127.0.0.1', port: sim.udpPort }, FAST);
  const r = await dead.connect();
  assert.deepStrictEqual(r, { ok: false, error: 'connect_failed' });
  assert.strictEqual(dead.snapshot().error, 'connect_failed');
  assert.strictEqual(dead.snapshot().connected, false);
  dead.disconnect();
  assert.strictEqual(dead.timers.size, 0);

  const bad = new MavVehicle({ type: 'carrier-pigeon' });
  assert.deepStrictEqual(await bad.connect(), { ok: false, error: 'unsupported' });
  assert.strictEqual(bad.snapshot().link, '');
  bad.disconnect();
});

test('vehicle: PX4 — kip adları, bayt bayt parametre kodlaması, CA_ROTOR yerleşimi, [cal] metinleri', async () => {
  // Küçük bir PX4 taklidi: yalnızca bu sınamanın gerektirdiği kadar
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  const parser = new MavParser();
  let peer = null;
  let seq = 0;
  const got = [];
  const tx = (name, fields) => { if (peer) sock.send(encode(name, fields, { sysid: 1, compid: 1, seq: seq++ & 0xff }), peer.port, peer.address); };
  const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
  const store = [['CA_ROTOR_COUNT', 4, 6], ['CA_ROTOR0_PX', 0.15, 9], ['CA_ROTOR0_PY', 0.15, 9], ['CA_ROTOR0_KM', 0.05, 9], ['CA_ROTOR1_PX', -0.15, 9], ['CA_ROTOR1_PY', -0.15, 9], ['CA_ROTOR1_KM', 0.05, 9], ['CA_ROTOR2_PX', 0.15, 9], ['CA_ROTOR2_PY', -0.15, 9], ['CA_ROTOR2_KM', -0.05, 9], ['CA_ROTOR3_PX', -0.15, 9], ['CA_ROTOR3_PY', 0.15, 9], ['CA_ROTOR3_KM', -0.05, 9], ['COM_RC_LOSS_T', -1, 6]];
  const sendParam = (i) => tx('PARAM_VALUE', { param_id: store[i][0], param_value: store[i][2] === 6 ? i32(store[i][1]) : store[i][1], param_type: store[i][2], param_count: store.length, param_index: i });
  sock.on('message', (d, rinfo) => {
    peer = rinfo;
    for (const m of parser.push(d)) {
      got.push(m);
      if (m.name === 'PARAM_REQUEST_LIST') for (let i = 0; i < store.length; i++) sendParam(i);
      if (m.name === 'PARAM_SET') {
        const i = store.findIndex((p) => p[0] === m.fields.param_id);
        store[i][1] = store[i][2] === 6 ? m.payload.readInt32LE(0) : m.fields.param_value;
        sendParam(i);
      }
      if (m.name === 'COMMAND_LONG') {
        tx('COMMAND_ACK', { command: m.fields.command, result: 0 });
        if (m.fields.command === 241 && m.fields.param1 === 1) {
          for (const s of ['[cal] calibration started: 2 gyro', '[cal] progress <20>', '[cal] progress <100>', '[cal] calibration done: gyro']) tx('STATUSTEXT', { severity: 6, text: s });
        }
      }
    }
  });
  const hb = setInterval(() => tx('HEARTBEAT', { type: 2, autopilot: 12, base_mode: 81, custom_mode: (4 << 16) | (3 << 24), system_status: 3, mavlink_version: 3 }), 100);
  const v = new MavVehicle({ type: 'udp', host: '127.0.0.1', port: sock.address().port }, FAST);
  const cals = [];
  v.on('calibration', (c) => cals.push(c));
  try {
    await v.connect();
    await waitFor(() => v.snapshot().linked, 3000, 'px4 linked');
    let s = v.snapshot();
    assert.strictEqual(s.firmware, 'px4');
    assert.strictEqual(s.mode, 'Hold');
    assert.ok(s.modes.some((m) => m.name === 'Position' && m.id === 3 << 16));
    // PX4'te akışlar SET_MESSAGE_INTERVAL ile istenir, REQUEST_DATA_STREAM gönderilmez
    await waitFor(() => got.some((m) => m.name === 'COMMAND_LONG' && m.fields.command === 511 && m.fields.param1 === 33), 2000, 'px4 intervals');
    assert.ok(!got.some((m) => m.name === 'REQUEST_DATA_STREAM'));

    assert.strictEqual((await v.fetchParams()).ok, true);
    const params = Object.fromEntries(v.getParams().map((p) => [p.name, p.value]));
    assert.strictEqual(params.CA_ROTOR_COUNT, 4);
    assert.strictEqual(params.COM_RC_LOSS_T, -1); // −1 float olarak NaN bit düzenidir; bayt bayt okunmalı
    s = v.snapshot();
    assert.strictEqual(s.frame.motors.length, 4);
    assert.deepStrictEqual(s.frame.motors[0], { n: 1, testOrder: 1, x: 1, y: 1, dir: 'ccw' });  // ön sağ
    assert.deepStrictEqual(s.frame.motors[2], { n: 3, testOrder: 3, x: -1, y: 1, dir: 'cw' });  // ön sol

    assert.deepStrictEqual(await v.setParam('COM_RC_LOSS_T', -7), { ok: true, value: -7 });
    assert.strictEqual(store[13][1], -7);
    assert.deepStrictEqual(await v.setParam('CA_ROTOR0_PX', 0.2), { ok: true, value: Math.fround(0.2) });

    assert.strictEqual((await v.setMode('Position')).ok, true);
    const sm = got.filter((m) => m.name === 'COMMAND_LONG' && m.fields.command === 176).pop().fields;
    assert.deepStrictEqual([sm.param1, sm.param2, sm.param3], [1, 3, 0]);

    await v.motorTest({ motor: 2, throttlePct: 10, seconds: 1 });
    const at = got.filter((m) => m.name === 'COMMAND_LONG' && m.fields.command === 310).pop().fields;
    assert.deepStrictEqual([Math.round(at.param1 * 100), at.param2, at.param5], [10, 1, 1102]);

    assert.deepStrictEqual(await v.calibrate('gyro'), { ok: true, resultName: 'DONE' });
    assert.deepStrictEqual(cals.map((c) => c.state), ['started', 'progress', 'progress', 'progress', 'done']);
    assert.deepStrictEqual(cals.filter((c) => c.percent !== undefined).map((c) => c.percent), [20, 100]);
  } finally { clearInterval(hb); v.disconnect(); sock.close(); }
});
