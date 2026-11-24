'use strict';

// Dron ve uçuş kayıtlarının şeması, oturum katmanı (sahte araçla) ve bölüm metinleri.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const I18N = require('../src/i18n');
const DRONE = require('../src/drone/schema');
const { createDroneSessions } = require('../src/drone/sessions');

test('dron şeması: varsayılanlar, sınırlar, doğrulama, bağlantı özeti', () => {
  const d = DRONE.normalize({ name: '  Keşif  ', firmware: 'yok', linkType: 'udpin', localPort: 99999, gcsSysid: 0, streamRate: 500, baud: '123' });
  assert.deepStrictEqual([d.name, d.firmware, d.linkType, d.localPort, d.gcsSysid, d.streamRate, d.baud], ['Keşif', 'ardupilot', 'udpin', 65535, 1, 50, '115200']);
  assert.deepStrictEqual(DRONE.validate(DRONE.normalize({ name: '', linkType: 'serial' })), ['name', 'serialPort']);
  assert.deepStrictEqual(DRONE.validate(DRONE.normalize({ name: 'x', linkType: 'tcp', host: '' })), ['host']);
  assert.deepStrictEqual(DRONE.validate(DRONE.normalize({ name: 'x', linkType: 'udpin' })), []);
  assert.strictEqual(DRONE.display(DRONE.normalize({ linkType: 'serial', serialPort: 'COM5', baud: '57600' })), 'COM5 @ 57600');
  assert.strictEqual(DRONE.display(DRONE.normalize({ linkType: 'tcp', host: '10.0.0.2', port: 5760 })), 'tcp://10.0.0.2:5760');
  assert.strictEqual(DRONE.display(DRONE.normalize({ linkType: 'udpin', localPort: 14550 })), 'udp ← :14550');
  assert.deepStrictEqual(DRONE.linkConfig(DRONE.normalize({ linkType: 'udp', host: '1.2.3.4', port: 14551 })), { retryInitial: true, type: 'udp', serialPort: '', baud: 115200, host: '1.2.3.4', port: 14551, localPort: 0 });
  assert.deepStrictEqual(DRONE.LINKS, ['serial', 'tcp', 'udp', 'udpin']);
  assert.deepStrictEqual(DRONE.FIRMWARES, ['ardupilot', 'px4', 'betaflight', 'sitl']);
  assert.deepStrictEqual(DRONE.PRESETS.sitl, { linkType: 'tcp', host: '127.0.0.1', port: 5760 });
  const f = DRONE.normalizeFlight({ name: ' Uçuş ', droneId: 'd1', cameraId: '', layout: 'yok' });
  assert.deepStrictEqual([f.name, f.droneId, f.cameraId, f.layout], ['Uçuş', 'd1', null, 'mapPip']);
});

test('dron ve uçuş metinleri: alanlar, seçenekler, modüller, yerleşimler Türkçe ve İngilizcede var', () => {
  const keys = ['sec.cameras', 'sec.drones', 'sec.flights', 'hud.cardinals'];
  for (const f of DRONE.FIELDS) { keys.push(`dr.f.${f.key}`); if (f.type === 'select' && !f.raw) for (const v of f.opts) keys.push(`dr.o.${f.key}.${v}`); }
  for (const m of ['overview', 'params', 'motors', 'calib', 'cli']) keys.push(`dr.m.${m}`);
  for (const k of ['accel', 'level', 'gyro', 'compass', 'baro', 'radio', 'esc']) keys.push(`dr.cal.${k}`, `dr.cal.${k}.d`);
  for (const p of ['level', 'left', 'right', 'nosedown', 'noseup', 'back']) keys.push(`dr.pos.${p}`);
  for (const l of DRONE.LAYOUTS) keys.push(`fl.l.${l}`);
  for (const k of ['altRel', 'groundspeed', 'climb', 'roll', 'pitch', 'heading', 'throttle', 'voltage', 'current', 'sats']) keys.push(`tm.${k}`);
  for (const v of ['copter', 'plane', 'rover', 'sub', 'vtol', 'heli', 'other']) keys.push(`dr.v.${v}`);
  for (const lang of ['tr', 'en']) assert.deepStrictEqual(keys.filter((k) => !(k in I18N.STRINGS[lang])), [], `${lang}: eksik metinler`);
  assert.strictEqual(I18N.STRINGS.tr['hud.cardinals'].split(',').length, 4);
});

test('oturumlar: olaylar pencerelere iletilir, yalnızca izinli işlevler çağrılır, parametreler açıklamalarıyla birleşir', async () => {
  class Fake extends EventEmitter {
    constructor() { super(); this.connected = false; this.calls = []; }
    async connect() { this.connected = true; return { ok: true }; }
    disconnect() { this.connected = false; }
    snapshot() { return { connected: this.connected, linked: this.connected, firmware: 'ardupilot', vehicle: 'copter', armed: false, mode: 'LOITER' }; }
    getParams() { return [{ name: 'ATC_RAT_RLL_P', value: 0.135, type: 9, index: 0 }, { name: 'SYSID', value: 1, type: 2, index: 1 }]; }
    async arm(on) { this.calls.push(['arm', on]); return { ok: true, resultName: 'ACCEPTED' }; }
    async secret() { return { ok: true }; }
  }
  const sent = [];
  let made = null;
  const s = createDroneSessions({
    getDrone: (id) => (id === 'd1' ? { id, name: 'x', firmware: 'ardupilot' } : id === 'bf' ? { id, firmware: 'betaflight' } : null),
    emit: (channel, payload) => sent.push([channel, payload]),
    createVehicle: (d) => (d.firmware === 'betaflight' ? null : (made = new Fake())),
    paramDefs: () => ({ lookup: (name, lang) => (name === 'ATC_RAT_RLL_P' ? { description: lang === 'tr' ? 'Yatış P kazancı' : 'Roll P gain' } : null), groupOf: (n) => (n.includes('_') ? n.split('_')[0] : '') }),
  });
  assert.strictEqual((await s.connect('yok')).error, 'not_found');
  assert.strictEqual((await s.connect('bf')).error, 'unsupported_firmware');
  assert.strictEqual((await s.call('d1', 'arm', [true])).error, 'not_connected');
  const st = await s.connect('d1');
  assert.ok(st.connected && st.mode === 'LOITER');
  assert.deepStrictEqual(s.active(), ['d1']);
  made.emit('state', made.snapshot());
  made.emit('log', [{ t: 1, dir: 'rx', name: 'HEARTBEAT', text: '' }]);
  made.emit('statustext', { severity: 4, text: 'PreArm: test' });
  assert.deepStrictEqual(sent.map((x) => x[0]), ['drone:state', 'drone:log', 'drone:statustext']);
  assert.strictEqual(sent[2][1].id, 'd1');
  assert.strictEqual(s.recent('d1').length, 1);
  assert.deepStrictEqual(await s.call('d1', 'arm', [true]), { ok: true, resultName: 'ACCEPTED' });
  assert.strictEqual((await s.call('d1', 'secret', [])).error, 'unsupported');
  assert.strictEqual((await s.call('d1', 'disconnect', [])).error, 'unsupported');
  const p = s.params('d1', 'tr');
  assert.deepStrictEqual([p[0].group, p[0].meta.description, p[0].original, p[1].group, p[1].meta], ['ATC', 'Yatış P kazancı', 'Roll P gain', '', null]);
  s.close('d1');
  assert.strictEqual(made.connected, false);
  assert.strictEqual(s.state('d1'), null);
  assert.deepStrictEqual(sent[sent.length - 1], ['drone:state', { id: 'd1', state: { connected: false, linked: false } }]);
});
