'use strict';

// CPDD075CCT sürücüsü — "Serial Communication Protocol V2.14" belgesindeki UDP kontrol protokolü.
//
// Komut çerçevesi (dış cihaz → kamera): sabit 44 bayt, 25 Hz (40 ms) aralıkla SÜREKLİ gönderilir.
//   1–2   FB 2C            eşzamanlama
//   3     komut kodu       (Tablo 2)
//   4–7   parametreler     (Tablo 3; çok baytlı değerlerde düşük bayt önce)
//   8–37  uçuş telemetrisi (30 bayt; yoksa 0)   — JSON komutunda (90H) metin 8. bayttan başlar
//   38    joystick komutu  70H = etkin, 00H = kapalı
//   39–40 yön hızı, 41–42 yükseliş hızı (int16, °/s, −100…100)
//   43    3…42. baytların XOR'u
//   44    F0
// Kamera komutlardaki DEĞİŞİMİ (kenarı) algılar: bir komut birkaç çerçeve boyunca gönderilir, sonra alanlar sıfırlanır.
//
// Geri bildirim çerçevesi (kamera → dış cihaz): sabit 64 bayt, 20 ms'de bir. FC 2C … XOR(3…62) F0.
//   3. bayt FF ise çerçeve bir JSON yanıtıdır (metin 4. bayttan başlar).

const { CameraDriver, hex, clamp } = require('./driver');

const FRAME_LEN = 44;
const FEEDBACK_LEN = 64;
const PERIOD_MS = 40;
const PULSE_FRAMES = 4; // bir komutun gönderildiği çerçeve sayısı (160 ms)
const GAP_FRAMES = 2;   // komutlar arasında sıfır çerçeve (kenar algılansın)
const JSON_MAX = 35;    // 8…42. baytlar

const xor = (buf, from, to) => { let x = 0; for (let i = from; i <= to; i++) x ^= buf[i]; return x; };

// f: { code, params:[4 bayt], joy:{yaw,pitch}|null, json:string|null, xy:{x,y}|null }
function buildFrame(f = {}) {
  const b = Buffer.alloc(FRAME_LEN);
  b[0] = 0xFB; b[1] = 0x2C;
  b[2] = (f.code || 0) & 0xFF;
  if (f.json != null) {
    const text = Buffer.from(String(f.json), 'latin1').subarray(0, JSON_MAX);
    b[2] = 0x90;
    b.writeUInt16LE(text.length, 3);
    text.copy(b, 7);
  } else {
    const p = f.params || [];
    for (let i = 0; i < 4; i++) b[3 + i] = (p[i] || 0) & 0xFF;
    if (f.joy) {
      b[37] = 0x70;
      b.writeInt16LE(Math.round(clamp(f.joy.yaw, -100, 100)), 38);
      b.writeInt16LE(Math.round(clamp(f.joy.pitch, -100, 100)), 40);
    } else if (f.xy) { // hedef seçimi: koordinatlar joystick alanında da taşınır (Tablo 5)
      b.writeInt16LE(Math.round(clamp(f.xy.x, -960, 960)), 38);
      b.writeInt16LE(Math.round(clamp(f.xy.y, -540, 540)), 40);
    }
  }
  b[42] = xor(b, 2, 41);
  b[43] = 0xF0;
  return b;
}

const u16 = (v) => { const n = Math.round(v) & 0xFFFF; return [n & 0xFF, n >> 8]; };
const i16 = (v) => u16(Math.round(v) < 0 ? Math.round(v) + 0x10000 : Math.round(v));
const guide = (deg) => u16(Math.round(clamp(deg, -150, 150) * 100) + 32767); // XXXXH − 32767 = 0,01°

// Komut adı → çerçeve(ler). Her öğe { code, params } ya da { json }.
const SIMPLE = {
  videoNext: 0x31, screenshot: 0x32, trackCancel: 0x3B, irPalette: 0x53, sceneComp: 0x55, shutterComp: 0x56,
  center: 0x71, lookDown: 0x73, bookmark: 0x74, lockAzimuth: 0x7A, follow: 0x7B,
  laserOnce: 0x3D, laserStart: 0x3E, laserStop: 0x3F, scanToggle: 0x79, zoomStop: 0x45,
};

function encode(cmd, a = {}) {
  if (SIMPLE[cmd] !== undefined) return [{ code: SIMPLE[cmd], params: [0, 0, 0, 0] }];
  switch (cmd) {
    case 'aircraftState': return [{ code: 0x11, params: [...u16(clamp(a.state, 0, 4)), 0, 0] }];
    case 'template': return [{ code: 0x23, params: [clamp(a.size, 1, 4), 0, 0, 0] }];
    case 'templateCustom': return [{ code: 0x23, params: [0, 0, clamp(a.width, 1, 255), clamp(a.height, 1, 255)] }];
    case 'videoSource': return [{ code: 0x25, params: [clamp(a.source, 0, 3), 0, 0, 0] }];
    case 'bitrate': return [{ code: 0x2F, params: [clamp(a.level, 0, 8), clamp(a.stream, 0, 3), 0, 0] }];
    case 'recordStart': return [{ code: 0x33, params: [1, 0, 0, 0] }];
    case 'recordStop': return [{ code: 0x33, params: [2, 0, 0, 0] }];
    case 'burst': return [{ code: 0x34, params: [...u16(clamp(a.interval, 1000, 50000)), 0, 0] }];
    case 'osd': return [{ code: 0x37, params: [clamp(a.mode, 0, 2), 0, 0, 0] }];
    case 'trackPoint': {
      const x = Math.round(clamp(a.x, -960, 960));
      const y = Math.round(clamp(a.y, -540, 540));
      return [{ code: 0x3A, params: [...i16(x), ...i16(y)], xy: { x, y } }];
    }
    case 'trackGreen': return [{ code: 0x93, params: [0, 0, 0, 0] }];
    case 'trackNumber': return [{ code: 0x93, params: [1, ...u16(clamp(a.number, 0, 999)), 0] }];
    case 'zoomIn': return [{ code: 0x45, params: [1, 0, 0, 0] }];
    case 'zoomOut': return [{ code: 0x45, params: [2, 0, 0, 0] }];
    case 'zoomSet': return [{ code: 0x45, params: [0, 1, ...u16(clamp(a.factor, 0.1, 128) * 10)] }];
    case 'photoRes': return [{ code: 0x40, params: [clamp(a.res, 1, 3), 0, 0, 0] }];
    case 'videoRes': return [{ code: 0x41, params: [clamp(a.res, 1, 2), 0, 0, 0] }];
    case 'tempPoint': return [{ code: 0x5C, params: [...u16(clamp(a.x, 1, 1920)), ...u16(clamp(a.y, 1, 1080))] }];
    case 'tempRoi': return [ // önce sol üst köşe (bit15 = 0), sonra genişlik/yükseklik (bit15 = 1)
      { code: 0x5D, params: [...u16(clamp(a.x, 1, 1920)), ...u16(clamp(a.y, 1, 1080))] },
      { code: 0x5D, params: [...u16(clamp(a.w, 1, 1920) | 0x8000), ...u16(clamp(a.h, 1, 1080))] },
    ];
    case 'tempRoiClear': return [{ code: 0x5D, params: [0xFF, 0xFF, 0xFF, 0xFF] }];
    case 'guideFrame': return [{ code: 0x72, params: [...guide(a.yaw), ...guide(a.pitch)] }];
    case 'guideInertial': return [{ code: 0x80, params: [...guide(a.yaw), ...guide(a.pitch)] }];
    case 'scanYaw': return [{ code: 0x77, params: [...i16(clamp(a.mid, -90, 90)), ...u16(clamp(a.range, 0, 90))] }];
    case 'scanPitch': return [{ code: 0x78, params: [...i16(clamp(a.mid, -90, 90)), ...u16(clamp(a.range, 0, 90))] }];
    case 'scanSpeed': return [{ code: 0x79, params: [...u16(clamp(a.yaw, 0, 20)), ...u16(clamp(a.pitch, 0, 20))] }];
    case 'lockFrameAngle': return [{ code: 0x81, params: [Number(a.on) ? 1 : 0, 0, 0, 0] }];
    case 'calibrate': return [{ code: 0xFA, params: [clamp(a.step, 1, 10), Number(a.step) === 2 ? clamp(a.kind, 1, 3) : 0, 0, 0] }];
    case 'ipQuery': return [{ json: '{"sh":"ifconfig"}' }];
    case 'ipSet': return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(a.ip || '').trim()) ? [{ json: `{"setip":"${String(a.ip).trim()}"}` }] : null;
    case 'encodingQuery': return [{ json: '{"getEd":""}' }];
    case 'encoding': return /^H26[45]\+[248]M$/.test(String(a.value)) ? [{ json: `{"setEd":"${a.value}"}` }] : null;
    case 'detectPause': return [{ json: '{"pausedetecor":"1"}' }];
    case 'detectStart': return [{ json: '{"pausedetecor":"0"}' }];
    case 'sensorAngleSet': return [{ json: `{"setSensorAngle":"${Math.round(clamp(a.angle, -90, 90))}"}` }];
    case 'sensorAngleQuery': return [{ json: '{"getSensorAngle":""}' }];
    case 'json': {
      const text = String(a.text || '').trim();
      return text && Buffer.byteLength(text, 'latin1') <= JSON_MAX ? [{ json: text }] : null;
    }
    case 'raw': { // code + 4 parametre baytı (onaltılık)
      const bytes = String(a.hex || '').replace(/0x/gi, '').match(/[0-9a-f]{2}/gi);
      if (!bytes || bytes.length < 1 || bytes.length > 5) return null;
      const n = bytes.map((x) => parseInt(x, 16));
      return [{ code: n[0], params: [n[1] || 0, n[2] || 0, n[3] || 0, n[4] || 0] }];
    }
    default: return null;
  }
}

// 64 baytlık geri bildirim çerçevesi → { json } | { status }
function parseFeedback(b) {
  if (!b || b.length < FEEDBACK_LEN || b[0] !== 0xFC || b[1] !== 0x2C || b[63] !== 0xF0) return null;
  if (xor(b, 2, 61) !== b[62]) return null;
  if (b[2] === 0xFF) {
    let end = 3;
    while (end < 62 && b[end] !== 0) end++;
    return { json: b.toString('latin1', 3, end) };
  }
  const st = b.readUInt16LE(4);
  const tgt = b.readUInt16LE(27);
  const self = b[3];
  return { status: {
    loadType: b[2],
    selfTest: { visible: !!(self & 1), ir: !!(self & 2), gyro: (self >> 2) & 3, motor: (self >> 4) & 3, proc: !!(self & 0x40), ready: !!(self & 0x80) },
    recording: !!(st & 0x10), tfCard: !!(st & 0x40), outOfLimit: !!(st & 0x80), lock: (st >> 9) & 3, channel: (st >> 12) & 15,
    status2: b.readUInt16LE(6),
    servo: b[8],
    yaw: b.readInt16LE(9) / 100, pitch: b.readInt16LE(11) / 100, roll: b.readInt16LE(13) / 100,
    version: b[15], laser: b.readUInt16LE(16), frame: b.readUInt16LE(18),
    tfUsed: b[21], tfTotal: b[22],
    attPitch: b.readInt16LE(23) / 100, attRoll: b.readInt16LE(25) / 100,
    targetId: tgt & 0x1FFF, targetType: tgt >> 13,
    targetLon: b.readFloatLE(29), targetLat: b.readFloatLE(33), targetAlt: b.readInt16LE(37),
    gyroYaw: b.readInt16LE(41) / 100, gyroPitch: b.readInt16LE(43) / 100, gyroRoll: b.readInt16LE(45) / 100,
    display: b[47], zoom: b[48],
    losYaw: b.readInt16LE(50) / 100, losPitch: b.readInt16LE(52) / 100,
    boxW: b.readInt16LE(54), boxH: b.readInt16LE(56),
    offYaw: b.readInt16LE(58) / 100, offPitch: b.readInt16LE(60) / 100,
  } };
}

class Cpdd075cct extends CameraDriver {
  constructor(conn) {
    super(conn, { port: 9554, localPort: 7001 });
    this.queue = [];
    this.gap = 0;
    this.held = null;
    this.joy = null;
    this.rxBuf = Buffer.alloc(0);
    this.lastStatusAt = 0;
    this.lastJson = { text: '', at: 0 };
  }

  onOpen() { this.timer = setInterval(() => this.tick(), PERIOD_MS); }
  onClose() { clearInterval(this.timer); this.queue = []; this.held = null; this.joy = null; }
  releaseAll() { if (this.held) this.queue.push({ ...encode('zoomStop')[0], left: PULSE_FRAMES }); this.held = null; this.joy = null; }

  // 25 Hz: sıradaki komut → ara boşluk → basılı tutulan komut → boş çerçeve; joystick her çerçeveye eklenir
  tick() {
    let f = { code: 0, params: [0, 0, 0, 0] };
    const cur = this.queue[0];
    if (this.gap > 0) this.gap--;
    else if (cur) {
      f = cur;
      if (--cur.left <= 0) { this.queue.shift(); this.gap = GAP_FRAMES; }
    } else if (this.held) f = this.held;
    this.send(buildFrame(f.json != null ? f : { ...f, joy: this.joy }));
  }

  exec(cmd, args) {
    const frames = encode(cmd, args || {});
    if (!frames) return { ok: false, error: 'bad_args' };
    if (!this.connected) return { ok: false, error: 'not_connected' };
    if (this.queue.length > 24) return { ok: false, error: 'busy' };
    for (const f of frames) {
      this.queue.push({ ...f, left: PULSE_FRAMES });
      this.log('tx', f.json != null ? f.json : hex(buildFrame(f)));
    }
    return { ok: true };
  }

  hold(cmd, args) {
    if (!this.connected) return { ok: false, error: 'not_connected' };
    if (cmd === 'joystick') {
      const yaw = args ? clamp(args.yaw, -100, 100) : 0;
      const pitch = args ? clamp(args.pitch, -100, 100) : 0;
      this.joy = args && (yaw || pitch) ? { yaw, pitch } : null;
    } else if (cmd === 'zoomIn' || cmd === 'zoomOut') {
      if (args) this.held = encode(cmd)[0];
      else if (this.held) { this.held = null; this.queue.push({ ...encode('zoomStop')[0], left: PULSE_FRAMES }); }
    } else return { ok: false, error: 'unsupported' };
    this.touchHold(!!(this.joy || this.held));
    return { ok: true };
  }

  onMessage(buf) {
    this.rxBuf = this.rxBuf.length ? Buffer.concat([this.rxBuf, buf]) : buf;
    while (this.rxBuf.length >= FEEDBACK_LEN) {
      const at = this.rxBuf.indexOf(Buffer.from([0xFC, 0x2C]));
      if (at < 0) { this.rxBuf = Buffer.alloc(0); return; }
      if (at > 0) this.rxBuf = this.rxBuf.subarray(at);
      if (this.rxBuf.length < FEEDBACK_LEN) break;
      const r = parseFeedback(this.rxBuf.subarray(0, FEEDBACK_LEN));
      this.rxBuf = this.rxBuf.subarray(r ? FEEDBACK_LEN : 2);
      if (!r) continue;
      const now = Date.now();
      if (r.json != null) {
        if (r.json !== this.lastJson.text || now - this.lastJson.at > 1500) { this.emit('reply', { text: r.json }); this.log('rx', r.json); }
        this.lastJson = { text: r.json, at: now };
      } else {
        this.status = r.status;
        if (now - this.lastStatusAt >= 200) { this.lastStatusAt = now; this.emit('status', r.status); }
      }
    }
    if (this.rxBuf.length > 4096) this.rxBuf = Buffer.alloc(0);
  }

  // Karttaki dosyalar: kameranın FTP paylaşımı
  static external(cmd, conn) {
    if (cmd !== 'openFtp') return null;
    const host = String(conn.camCtrlHost || conn.host || '').trim();
    if (!host) return null;
    const user = encodeURIComponent(conn.camFtpUser || 'ftp2');
    const pass = encodeURIComponent(conn.camFtpPass || '');
    return `ftp://${user}${pass ? `:${pass}` : ''}@${host}/`;
  }
}

module.exports = { Driver: Cpdd075cct, buildFrame, parseFeedback, encode, FRAME_LEN, FEEDBACK_LEN, PERIOD_MS };
