'use strict';

// Kamera modelleri: tanımların bütünlüğü (her komutun sürücüde karşılığı ve Türkçe/İngilizce metni var),
// CPDD075CCT çerçeveleri (belgedeki örneklerle bayt bayt) ve sahte bir UDP kamerayla uçtan uca kontrol.

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const I18N = require('../src/i18n');
const SCHEMA = require('../src/schema');
const CAMERAS = require('../src/models');
const cpdd = require('../src/models/cpdd075cct.driver');
const { hex } = require('../src/models/driver');
const sky = require('../src/models/skydroid.driver');
const net = require('net');

const bytes = (s) => Buffer.from(s.trim().split(/\s+/).map((x) => parseInt(x, 16)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Örnek bağımsız değişkenler: tanımdaki alanların varsayılanları
function sampleArgs(c) {
  const a = {};
  if (c.type === 'form') for (const f of c.fields) a[f.name] = f.def;
  if (c.type === 'select') { a[c.arg] = c.def; if (c.extra) a[c.extra.name] = c.extra.def; }
  if (c.type === 'pick') { a.x = 10; a.y = -20; }
  if (c.type === 'json') a.text = '{"getEd":""}';
  if (c.type === 'raw') { a.hex = '71 00 00 00 00'; a.text = c.placeholder; }
  return a;
}

test('modeller: her model şemaya eklenir, sürücüsü vardır, metinleri Türkçe ve İngilizcede tamdır', () => {
  assert.ok(CAMERAS.DEFS.length >= 1);
  const modelField = SCHEMA.FIELD_BY_KEY.model;
  assert.deepStrictEqual(modelField.opts, ['generic', ...CAMERAS.DEFS.map((d) => d.id)]);
  for (const def of CAMERAS.DEFS) {
    assert.ok(CAMERAS.hasDriver(def.id), `${def.id}: sürücü`);
    const keys = new Set([`o.model.${def.id}`]);
    const K = (s) => keys.add(`cam.${def.id}.${s}`);
    for (const f of def.fields) keys.add(`f.${f.key}`);
    for (const g of def.panel) {
      K(`g.${g.id}`);
      for (const c of g.controls) {
        if (c.type === 'buttons' || c.type === 'holds') for (const it of c.items) { K(it.cmd); if (it.confirm) K(`${it.cmd}.confirm`); }
        else if (c.type !== 'joystick' && c.type !== 'pick') K(c.cmd);
        if (c.confirm) K(`${c.cmd}.confirm`);
        if (c.type === 'form') for (const f of c.fields) K(f.name);
        if (c.type === 'select') {
          if (!c.labels && !c.raw) for (const v of c.options) K(`${c.cmd}.${v}`);
          if (c.extra) { K(c.extra.name); if (!c.extra.labels) for (const v of c.extra.options) K(`${c.extra.name}.${v}`); }
        }
      }
    }
    for (const [key] of def.status || []) K(`s.${key}`);
    for (const [key] of def.selfTest || []) K(`t.${key}`);
    for (const lang of ['tr', 'en']) {
      const missing = [...keys].filter((k) => !(k in I18N.STRINGS[lang]));
      assert.deepStrictEqual(missing, [], `${def.id} / ${lang}: eksik metinler`);
    }
  }
});

test('modeller: paneldeki her komut sürücüde tanımlı (yerel olanlar dış adres üretir)', async () => {
  for (const def of CAMERAS.DEFS) {
    const conn = SCHEMA.normalize({ ...SCHEMA.applyModel(SCHEMA.defaults('rtsp'), def.id), protocol: 'rtsp', name: 'x', host: '127.0.0.1', camCtrlHost: '127.0.0.1', camLocalPort: 0 });
    const drv = CAMERAS.createDriver(conn);
    await drv.connect();
    try {
      for (const g of def.panel) for (const c of g.controls) {
        const items = c.items || [c];
        for (const it of items) {
          if (it.local) { assert.ok(CAMERAS.external(conn, it.cmd), `${def.id}: ${it.cmd} dış adres`); continue; }
          if (c.type === 'joystick' || c.type === 'holds') {
            const r = drv.hold(it.cmd, c.type === 'joystick' ? { yaw: 5, pitch: -5 } : {});
            // TCP ile yönetilen kamera bu sınamada yok: "bağlı değil" komutun tanındığını gösterir
            assert.ok(r.ok || r.error === 'not_connected', `${def.id}: ${it.cmd} (basılı) → ${JSON.stringify(r)}`);
            drv.hold(it.cmd, null);
          } else {
            const r = await drv.exec(it.cmd, sampleArgs(c));
            assert.ok(r && (r.ok || r.error === 'not_connected'), `${def.id}: ${it.cmd} → ${JSON.stringify(r)}`);
            drv.queue = []; // sıradaki çerçeveler bu sınamada gönderilmesin
          }
        }
      }
      assert.strictEqual((await drv.exec('boyle-komut-yok', {})).error, 'bad_args');
    } finally { drv.disconnect(); }
  }
});

test('şema: model seçimi varsayılanları uygular, girilen adresi korur; RTSP dışında model yoktur', () => {
  const base = SCHEMA.defaults('rtsp');
  assert.strictEqual(base.model, 'generic');
  assert.strictEqual(SCHEMA.modelOf(base), null);
  const p = SCHEMA.applyModel(base, 'cpdd075cct', 'generic');
  assert.strictEqual(p.host, '192.168.144.108');
  assert.strictEqual(p.path, '/live/0');
  assert.strictEqual(p.camCtrlPort, 9554);
  assert.strictEqual(p.camLocalPort, 7001);
  const kept = SCHEMA.applyModel({ ...base, host: '10.0.0.5', path: '/live/1' }, 'cpdd075cct', 'generic');
  assert.ok(!('host' in kept) && !('path' in kept));
  const c = SCHEMA.normalize({ protocol: 'rtsp', name: 'kamera', host: '10.0.0.5', model: 'cpdd075cct', camCtrlPort: 9000 });
  assert.strictEqual(c.model, 'cpdd075cct');
  assert.strictEqual(c.camCtrlPort, 9000);
  assert.strictEqual(c.camFtpUser, 'ftp2');
  assert.strictEqual(SCHEMA.modelOf(c).id, 'cpdd075cct');
  assert.ok(SCHEMA.tabVisible('camera', c));
  assert.ok(!SCHEMA.tabVisible('camera', base));
  assert.strictEqual(SCHEMA.normalize({ protocol: 'udp', model: 'cpdd075cct' }).model, 'generic');
  assert.strictEqual(SCHEMA.normalize({ protocol: 'rtsp', model: 'yok' }).model, 'generic');
  assert.ok(SCHEMA.CONNECTION_KEYS.includes('model') && SCHEMA.CONNECTION_KEYS.includes('camCtrlPort'));
});

test('CPDD075CCT: komut çerçeveleri belgedeki örneklerle aynı', () => {
  // Belge §5: JSON sorgu ve IP ayarı örnekleri
  assert.strictEqual(hex(cpdd.buildFrame(cpdd.encode('ipQuery')[0])),
    'FB 2C 90 11 00 00 00 7B 22 73 68 22 3A 22 69 66 63 6F 6E 66 69 67 22 7D 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 A3 F0');
  assert.strictEqual(hex(cpdd.buildFrame(cpdd.encode('ipSet', { ip: '192.168.8.101' })[0])),
    'FB 2C 90 19 00 00 00 7B 22 73 65 74 69 70 22 3A 22 31 39 32 2E 31 36 38 2E 38 2E 31 30 31 22 7D 00 00 00 00 00 00 00 00 00 00 ED F0');
  const f = (cmd, a) => cpdd.buildFrame(cpdd.encode(cmd, a)[0]);
  const head = (b) => hex(b.subarray(2, 7));
  assert.strictEqual(f('center').length, 44);
  assert.strictEqual(head(f('center')), '71 00 00 00 00');
  assert.strictEqual(f('center')[42], 0x71); // XOR(3…42)
  assert.strictEqual(f('center')[43], 0xF0);
  assert.strictEqual(head(f('videoSource', { source: 3 })), '25 03 00 00 00');
  assert.strictEqual(head(f('bitrate', { level: 8, stream: 2 })), '2F 08 02 00 00');
  assert.strictEqual(head(f('recordStart')), '33 01 00 00 00');
  assert.strictEqual(head(f('recordStop')), '33 02 00 00 00');
  assert.strictEqual(head(f('burst', { interval: 1000 })), '34 E8 03 00 00');
  assert.strictEqual(head(f('trackPoint', { x: -960, y: 540 })), '3A 40 FC 1C 02');
  assert.strictEqual(hex(f('trackPoint', { x: -960, y: 540 }).subarray(37, 42)), '00 40 FC 1C 02'); // Tablo 5: koordinatlar 39–42'de de
  assert.strictEqual(head(f('trackNumber', { number: 300 })), '93 01 2C 01 00');
  assert.strictEqual(head(f('zoomSet', { factor: 2.5 })), '45 00 01 19 00');
  assert.strictEqual(head(f('zoomIn')), '45 01 00 00 00');
  assert.strictEqual(head(f('templateCustom', { width: 48, height: 40 })), '23 00 00 30 28');
  assert.strictEqual(head(f('guideFrame', { yaw: 0, pitch: -90 })), '72 FF 7F D7 5C'); // 32767 ve 32767 − 9000
  assert.strictEqual(head(f('guideInertial', { yaw: 150, pitch: 0 })), '80 97 BA FF 7F');
  assert.strictEqual(head(f('scanYaw', { mid: -10, range: 30 })), '77 F6 FF 1E 00');
  assert.strictEqual(head(f('scanSpeed', { yaw: 5, pitch: 0 })), '79 05 00 00 00');
  assert.strictEqual(head(f('calibrate', { step: 2, kind: 3 })), 'FA 02 03 00 00');
  assert.strictEqual(head(f('calibrate', { step: 10, kind: 3 })), 'FA 0A 00 00 00');
  assert.strictEqual(head(f('tempRoiClear')), '5D FF FF FF FF');
  const roi = cpdd.encode('tempRoi', { x: 100, y: 200, w: 300, h: 400 }).map((x) => head(cpdd.buildFrame(x)));
  assert.deepStrictEqual(roi, ['5D 64 00 C8 00', '5D 2C 81 90 01']);
  // Joystick: 38. bayt 70H, hızlar int16 (düşük bayt önce)
  const joy = cpdd.buildFrame({ code: 0, joy: { yaw: -20, pitch: 100 } });
  assert.strictEqual(hex(joy.subarray(37, 42)), '70 EC FF 64 00');
  assert.strictEqual(hex(cpdd.buildFrame({}).subarray(2, 43)), Array(41).fill('00').join(' '));
  // Geçersiz değerler reddedilir
  assert.strictEqual(cpdd.encode('ipSet', { ip: 'abc' }), null);
  assert.strictEqual(cpdd.encode('encoding', { value: 'H266+2M' }), null);
  assert.strictEqual(cpdd.encode('json', { text: 'x'.repeat(36) }), null);
});

test('CPDD075CCT: geri bildirim çerçevesi çözülür (JSON yanıtı ve durum)', () => {
  const json = bytes('FC 2C FF 7B 22 65 63 68 6F 22 3A 22 6F 6B 22 2C 22 69 70 22 3A 22 31 39 32 2E 31 36 38 2E 38 2E 31 30 31 22 7D 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 EA F0');
  assert.deepStrictEqual(cpdd.parseFeedback(json), { json: '{"echo":"ok","ip":"192.168.8.101"}' });
  const b = Buffer.alloc(64);
  b[0] = 0xFC; b[1] = 0x2C; b[2] = 4; b[3] = 0xFF;
  b.writeUInt16LE(0x10 | 0x40 | (1 << 9) | (3 << 12), 4);
  b[8] = 7;
  b.writeInt16LE(-1234, 9); b.writeInt16LE(4500, 11); b.writeInt16LE(12, 13);
  b[15] = 21; b.writeUInt16LE(1500, 16); b[21] = 37; b[22] = 64;
  b.writeUInt16LE(42 | (1 << 13), 27);
  b.writeFloatLE(32.5, 29); b.writeFloatLE(39.75, 33); b.writeInt16LE(-12, 37);
  b[47] = 1; b[48] = 4; b.writeInt16LE(64, 54); b.writeInt16LE(48, 56); b.writeInt16LE(-150, 58);
  let x = 0; for (let i = 2; i <= 61; i++) x ^= b[i];
  b[62] = x; b[63] = 0xF0;
  const { status: s } = cpdd.parseFeedback(b);
  assert.strictEqual(s.loadType, 4);
  assert.deepStrictEqual(s.selfTest, { visible: true, ir: true, gyro: 3, motor: 3, proc: true, ready: true });
  assert.deepStrictEqual([s.recording, s.tfCard, s.lock, s.channel, s.servo], [true, true, 1, 3, 7]);
  assert.deepStrictEqual([s.yaw, s.pitch, s.roll], [-12.34, 45, 0.12]);
  assert.deepStrictEqual([s.version, s.laser, s.tfUsed, s.tfTotal, s.targetId, s.targetType], [21, 1500, 37, 64, 42, 1]);
  assert.deepStrictEqual([s.targetLon, s.targetLat, s.targetAlt, s.display, s.zoom, s.boxW, s.boxH, s.offYaw], [32.5, 39.75, -12, 1, 4, 64, 48, -1.5]);
  b[30] ^= 1; // bozuk sağlama
  assert.strictEqual(cpdd.parseFeedback(b), null);
});

test('CPDD075CCT: sahte kamerayla 25 Hz çerçeve akışı, komut darbesi, joystick, JSON yanıtı ve durum', async () => {
  const camera = dgram.createSocket('udp4');
  await new Promise((r) => camera.bind(0, '127.0.0.1', r));
  const got = [];
  let peer = null;
  camera.on('message', (m, rinfo) => { got.push({ at: Date.now(), m: Buffer.from(m) }); peer = rinfo; });
  const conn = SCHEMA.normalize({ protocol: 'rtsp', name: 'x', host: '127.0.0.1', model: 'cpdd075cct', camCtrlHost: '127.0.0.1', camCtrlPort: camera.address().port, camLocalPort: 0 });
  const drv = CAMERAS.createDriver(conn);
  const replies = []; const statuses = []; const states = [];
  drv.on('reply', (r) => replies.push(r.text));
  drv.on('status', (s) => statuses.push(s));
  drv.on('state', (s) => states.push(s));
  try {
    assert.strictEqual((await drv.exec('center')).error, 'not_connected');
    const st = await drv.connect();
    assert.ok(st.connected && !st.linked && st.local > 0);
    await wait(260);
    // Boşta: sıfır komutlu çerçeveler yaklaşık 40 ms aralıkla
    assert.ok(got.length >= 4 && got.length <= 9, `boşta çerçeve sayısı ${got.length}`);
    assert.ok(got.every((g) => g.m.length === 44 && g.m[0] === 0xFB && g.m[1] === 0x2C && g.m[2] === 0 && g.m[43] === 0xF0));

    // Komut darbesi: birkaç çerçeve boyunca gönderilir, sonra alanlar sıfıra döner (kenar algılama)
    got.length = 0;
    assert.deepStrictEqual(await drv.exec('lookDown'), { ok: true });
    assert.deepStrictEqual(await drv.exec('videoSource', { source: 1 }), { ok: true });
    await wait(700);
    const codes = got.map((g) => g.m[2]);
    const runs = codes.filter((c, i) => i === 0 || codes[i - 1] !== c);
    assert.deepStrictEqual(runs, [0x73, 0, 0x25, 0], `darbe sırası ${codes.map((c) => c.toString(16)).join(' ')}`);
    assert.strictEqual(codes.filter((c) => c === 0x73).length, 4);
    assert.strictEqual(got.find((g) => g.m[2] === 0x25).m[3], 1);

    // Joystick: bırakılana kadar her çerçevede; pencere tazelemezse kendiliğinden bırakılır
    got.length = 0;
    drv.hold('joystick', { yaw: 30, pitch: -10 });
    await wait(200);
    assert.ok(got.length >= 3 && got.every((g) => g.m[37] === 0x70 && g.m.readInt16LE(38) === 30 && g.m.readInt16LE(40) === -10));
    await wait(1100); // tazeleme yok → bırakıldı
    assert.strictEqual(got[got.length - 1].m[37], 0);
    drv.hold('joystick', { yaw: 5, pitch: 0 });
    await wait(100);
    drv.hold('joystick', null);
    await wait(80); // yoldaki son çerçeve gelsin
    got.length = 0;
    await wait(120);
    assert.ok(got.length && got.every((g) => g.m[37] === 0));

    // Yakınlaştırma basılı tutulur; bırakınca "dur" (45 00 …) darbesi gider
    got.length = 0;
    drv.hold('zoomIn', {});
    await wait(160);
    drv.hold('zoomIn', null);
    await wait(360);
    const z = got.map((g) => `${g.m[2].toString(16)}:${g.m[3]}`);
    assert.ok(z.includes('45:1') && z.includes('45:0') && z.indexOf('45:0') > z.lastIndexOf('45:1'), z.join(' '));

    // Kamera yanıtları: durum çerçevesi ve JSON
    const fb = Buffer.alloc(64);
    fb[0] = 0xFC; fb[1] = 0x2C; fb[2] = 4; fb[8] = 2; fb.writeInt16LE(900, 9);
    let x = 0; for (let i = 2; i <= 61; i++) x ^= fb[i];
    fb[62] = x; fb[63] = 0xF0;
    const js = bytes('FC 2C FF 7B 22 65 63 68 6F 22 3A 22 6F 6B 22 7D 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 C6 F0');
    camera.send(fb, peer.port, '127.0.0.1');
    camera.send(Buffer.concat([js, js]), peer.port, '127.0.0.1'); // yinelenen yanıt bir kez bildirilir
    await wait(150);
    assert.strictEqual(statuses.length, 1);
    assert.deepStrictEqual([statuses[0].servo, statuses[0].yaw], [2, 9]);
    assert.deepStrictEqual(replies, ['{"echo":"ok"}']);
    assert.ok(drv.snapshot().linked);
    assert.ok(states.some((s) => s.linked));
  } finally {
    drv.disconnect();
    camera.close();
  }
  assert.strictEqual(drv.snapshot().connected, false);
});

test('Skydroid: "#TP" çerçeveleri resmî SDK örnekleriyle aynı', () => {
  const one = (cmd, a, o) => sky.encode(cmd, a, o)[0];
  assert.strictEqual(sky.seal('#TPUG2wPTZ05'), '#TPUG2wPTZ056F');
  assert.strictEqual(one('center'), '#TPUG2wPTZ056F');
  assert.strictEqual(one('stop'), '#TPUG2wPTZ006A');
  assert.strictEqual(one('follow'), '#TPUG2wPTZ0670');
  assert.strictEqual(one('lock'), '#TPUG2wPTZ0771');
  assert.deepStrictEqual(sky.encode('goto', { yaw: 30, pitch: -90 }), ['#TPUG6wGAY0BB8103E', '#TPUG6wGAPDCD8104C']); // gotoYaw(30), gotoPitch(-90)
  assert.strictEqual(one('goto', { yaw: 30, pitch: 0 }, { invertYaw: true }).slice(0, 14), '#TPUG6wGAYF448');
  assert.strictEqual(one('lookDown'), '#TPUG6wGAPDCD8104C');
  // Hız: 0,5 °/s adım, int8
  assert.strictEqual(sky.tp('G', 'w', 'GSY', sky.speedByte(10)), '#TPUG2wGSY1464');
  assert.strictEqual(sky.tp('G', 'w', 'GSY', sky.speedByte(-10)), '#TPUG2wGSYEC87');
  assert.strictEqual(sky.tp('G', 'w', 'GSP', sky.speedByte(0)), '#TPUG2wGSP0056');
  assert.strictEqual(sky.speedByte(500), '7F');
  // Kamera komutları CR LF ile biter
  assert.strictEqual(one('photo'), '#TPUD2wCAP013E\r\n');
  assert.strictEqual(one('recordStart'), '#TPUD2wREC0144\r\n');
  assert.strictEqual(one('recordStop'), '#TPUD2wREC0043\r\n');
  assert.strictEqual(one('recordQuery'), '#TPUD2rREC003E\r\n');
  assert.strictEqual(one('zoomIn'), '#TPUD2wDZM0A65\r\n');
  assert.strictEqual(one('zoomOut'), '#TPUD2wDZM0B66\r\n');
  assert.strictEqual(one('zoomSet', { level: 4 }), '#TPUD2wDZM0458\r\n');
  assert.strictEqual(one('palette', { code: '0B' }), '#TPUD2wIMG0B58\r\n');
  assert.strictEqual(one('laserOnce'), '#TPUD2rSLR0055\r\n');
  assert.strictEqual(one('sdQuery'), '#TPUD2rSDC013F\r\n');
  assert.strictEqual(one('versionQuery'), '#TPUD2rVER0051\r\n');
  assert.strictEqual(one('modelQuery'), '#TPUD2rMOD0044\r\n');
  assert.strictEqual(one('recordRes', { res: 3 }), '#TPUD2wVID034F\r\n');
  assert.strictEqual(one('ext', { osd: 1, led: 0 }), '#tpUD4wEXT0010FD\r\n');
  assert.strictEqual(one('ext', { osd: 0, led: 0 }), '#tpUD4wEXT0000FC\r\n');
  assert.strictEqual(one('timeSync', { date: new Date(2018, 11, 3, 14, 28, 32) }), '#TPUDFwTIM142832.00031218F8\r\n');
  assert.strictEqual(one('raw', { text: '#TPUG2wGAA0A' }), '#TPUG2wGAA0A46');
  assert.strictEqual(sky.encode('raw', { text: 'PTZ05' }), null);
  assert.strictEqual(sky.encode('palette', { code: '02' }), null);
  // Yanıtlar (donanımda gözlenenler): uzunluk hanesine güvenilmez
  assert.deepStrictEqual(sky.parseFrames('#tpDU3rVER0105025A\r\n#TPDU2rREC013F').map((f) => [f.id, f.data]), [['VER', '010502'], ['REC', '01']]);
  // C20 kamerası (ikili)
  assert.strictEqual(hex(sky.C20.zoomIn()), '00 00 00 00 00 00 22 31 00 03 0B 00 01');
  assert.strictEqual(hex(sky.C20.lensStop()), '00 00 00 00 00 00 22 31 00 03 0B 01 01');
  assert.strictEqual(hex(sky.C20.photo().subarray(0, 12)), '00 00 00 00 00 00 33 81 00 20 0A 0C');
  assert.strictEqual(sky.C20.recordStart().length, 42);
});

test('Skydroid C13: sahte UDP kamerayla konum bildirimi, joystick tazeleme ve bırakma, sorgu yanıtı', async () => {
  const camera = dgram.createSocket('udp4');
  await new Promise((r) => camera.bind(0, '127.0.0.1', r));
  const got = [];
  camera.on('message', (m, r) => {
    const text = m.toString('latin1').trim();
    got.push(text);
    if (text.startsWith('#TPUG2wGAA')) camera.send('#tpGU6rGAC04D2FE0C000A' + '00', r.port, r.address);
    if (text.startsWith('#TPUD2rVER')) camera.send('#tpDU3rVER0105025A\r\n', r.port, r.address);
    if (text.startsWith('#TPUD2rSLR')) camera.send(sky.seal('#TPDU4rSLR01F4') + '\r\n', r.port, r.address);
  });
  const conn = SCHEMA.normalize({ protocol: 'rtsp', name: 'x', host: '127.0.0.1', model: 'skydroidc13', camCtrlHost: '127.0.0.1', camCtrlPort: camera.address().port, camLocalPort: 0 });
  assert.strictEqual(conn.path, '');
  const drv = CAMERAS.createDriver(conn);
  const statuses = []; const replies = [];
  drv.on('status', (s) => statuses.push(s));
  drv.on('reply', (r) => replies.push(r.text));
  try {
    await drv.connect();
    await wait(300);
    assert.ok(got.includes('#TPUG2wGAA0A46'), 'konum bildirimi açılır');
    assert.ok(drv.snapshot().linked);
    assert.ok(got.includes('#TPUD2rMOD0044') && got.includes('#TPUD2rVER0051'), 'bağlanınca model ve sürüm sorulur');
    const last = statuses[statuses.length - 1];
    assert.deepStrictEqual([last.yaw, last.pitch, last.roll, last.version], [12.34, -5, 0.1, '1.5.2']);
    got.length = 0;
    drv.hold('joystick', { yaw: 10, pitch: -10 });
    await wait(320);
    const y = got.filter((g) => g === '#TPUG2wGSY1464').length;
    const p = got.filter((g) => g === '#TPUG2wGSPEC7E').length;
    assert.ok(y >= 3 && p >= 3, `hız komutları tazelenir (${y}/${p})`);
    drv.hold('joystick', null);
    await wait(200);
    assert.deepStrictEqual(got.filter((g) => !g.includes('GAA') && !g.includes('rREC') && !g.includes('rDZM')).slice(-3), ['#TPUG2wGSY005F', '#TPUG2wGSP0056', '#TPUG2wPTZ006A']);
    assert.deepStrictEqual(await drv.exec('laserOnce'), { ok: true });
    await wait(200);
    assert.deepStrictEqual(replies, ['SLR 500']);
    assert.strictEqual(drv.snapshot().status.laser, 500);
  } finally { drv.disconnect(); camera.close(); }
});

test('Skydroid C20: gimbal TCP 5000 metin, kamera TCP 8100 ikili; basılı yakınlaştırma bırakılınca durur', async () => {
  const gimbalGot = []; const camGot = [];
  const gimbal = net.createServer((s) => s.on('data', (d) => gimbalGot.push(d.toString('latin1'))));
  const camSrv = net.createServer((s) => s.on('data', (d) => {
    for (let i = 0; i + 10 <= d.length;) { const n = 10 + d.readUInt16BE(i + 8); camGot.push(hex(d.subarray(i, i + Math.min(n, 13)))); i += n; }
  }));
  await new Promise((r) => gimbal.listen(0, '127.0.0.1', r));
  await new Promise((r) => camSrv.listen(0, '127.0.0.1', r));
  const conn = SCHEMA.normalize({ protocol: 'rtsp', name: 'x', host: '127.0.0.1', model: 'skydroidc20', camCtrlHost: '127.0.0.1', camCtrlPort: gimbal.address().port, camCamPort: camSrv.address().port });
  const drv = CAMERAS.createDriver(conn);
  try {
    assert.strictEqual(drv.transport, 'tcp');
    await drv.connect();
    await wait(250);
    assert.ok(drv.snapshot().linked && drv.snapshot().status.camLink);
    assert.deepStrictEqual(await drv.exec('center'), { ok: true });
    drv.hold('zoomIn', {});
    await wait(120);
    drv.hold('zoomIn', null);
    assert.deepStrictEqual(await drv.exec('photo'), { ok: true });
    await wait(150);
    assert.ok(gimbalGot.join('').includes('#TPUG2wPTZ056F'));
    assert.ok(!gimbalGot.join('').includes('CAP'), 'C20 fotoğrafı kamera kanalından gider');
    assert.deepStrictEqual(camGot.filter((x) => x.includes('22 31')), ['00 00 00 00 00 00 22 31 00 03 0B 00 01', '00 00 00 00 00 00 22 31 00 03 0B 01 01']);
    assert.ok(camGot.some((x) => x.startsWith('00 00 00 00 00 00 33 81 00 20 0A 0C')));
  } finally { drv.disconnect(); gimbal.close(); camSrv.close(); }
});
