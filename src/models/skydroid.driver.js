'use strict';

// Skydroid C10 / C10 Pro / C12 / C13 / C20 sürücüsü.
// Kaynak: Skydroid RCSDK v1.9.2 (resmî Android SDK'sı) ve rcsdk-demo belgesi; ArduPilot Skydroid sürücüsü ve
// donanım üzerinde doğrulanmış açık kaynak araçlar. Üreticinin protokol PDF'i yayımlanmadığı için komut tablosu
// SDK'daki karşılıklardan alınmıştır (ayrıntı: docs/kamera-modelleri.md).
//
// "#TP" metin protokolü (C10, C10 Pro, C12, C13 ve C20'nin gimbali):
//   #TP | kaynak 'U' | hedef 'G' gimbal / 'D' kamera / 'M' mercek | veri uzunluğu (1 onaltılık hane) | 'w' yaz / 'r' oku
//   | 3 harfli komut | veri (ASCII; sayılar büyük harf onaltılık) | sağlama: önceki tüm baytların 8 bit toplamı, 2 onaltılık hane
//   Kamera ('D') komutlarının sonuna CR LF eklenir. Yanıtlarda adresler yer değiştirir (DU, GU).
// Taşıma: C10 → TCP 5000; C10 Pro / C12 / C13 → UDP 5000 (yerel port 5000); C20 → gimbal TCP 5000 + kamera TCP 8100 (ikili protokol).
// Hız komutları (GSY/GSP) sürekli tazelenmelidir; bırakılınca hız 0 ve PTZ00 gönderilir.

const { CameraDriver, TcpLink, hex, clamp } = require('./driver');

const TICK_MS = 25;

const PROFILES = {
  skydroidc10: { transport: null, camera: 'tp', zoom: false },
  skydroidc12: { transport: 'udp', camera: 'tp', zoom: true },
  skydroidc13: { transport: 'udp', camera: 'tp', zoom: true },
  skydroidc20: { transport: 'tcp', camera: 'c20', zoom: false },
};

const hex2 = (n) => (n & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const hex4 = (n) => (n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

// Çerçeve gövdesine sağlama ekler
function seal(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum = (sum + body.charCodeAt(i)) & 0xFF;
  return body + hex2(sum);
}
// dest: 'G' | 'D' | 'M'; rw: 'w' | 'r'
function tp(dest, rw, id, data, { lower = false } = {}) {
  const d = String(data);
  return seal(`${lower ? '#tp' : '#TP'}U${dest}${d.length.toString(16).toUpperCase()}${rw}${id}${d}`) + (dest === 'G' ? '' : '\r\n');
}
const speedByte = (degPerSec) => hex2(Math.round(clamp(degPerSec / 0.5, -127, 127)));
const angleWord = (deg) => hex4(Math.round(clamp(deg, -90, 90) * 100));

// Gelen metinden çerçeveleri ayırır: { src, dst, rw, id, data }
function parseFrames(text) {
  const out = [];
  for (const m of String(text).matchAll(/#(?:TP|tp)([A-Z])([A-Z])[0-9A-Fa-f]([rw])([A-Z]{3})([^#\r\n]*)/g)) {
    const rest = m[5];
    if (rest.length < 2) continue;
    out.push({ src: m[1], dst: m[2], rw: m[3], id: m[4], data: rest.slice(0, -2) });
  }
  return out;
}
const s16 = (h) => { const n = parseInt(h, 16); return n >= 0x8000 ? n - 0x10000 : n; };

// C20 kamerası (TCP 8100): 00×6 | grup | kimlik | uzunluk (2 bayt, yüksek önce) | veri
function c20Frame(group, id, payload = []) {
  return Buffer.from([0, 0, 0, 0, 0, 0, group, id, (payload.length >> 8) & 0xFF, payload.length & 0xFF, ...payload]);
}
const c20Media = (b1) => { const p = new Array(32).fill(0); p[0] = 0x0A; p[1] = b1; return p; };
const C20 = {
  zoomIn: () => c20Frame(0x22, 0x31, [0x0B, 0x00, 0x01]),
  zoomOut: () => c20Frame(0x22, 0x31, [0x0C, 0x00, 0x01]),
  focusNear: () => c20Frame(0x22, 0x31, [0x0D, 0x00, 0x01]),
  focusFar: () => c20Frame(0x22, 0x31, [0x0E, 0x00, 0x01]),
  lensStop: () => c20Frame(0x22, 0x31, [0x0B, 0x01, 0x01]),
  zoomQuery: () => c20Frame(0x22, 0x4A, [0, 0]),
  photo: () => c20Frame(0x33, 0x81, c20Media(0x0C)),
  recordStart: () => c20Frame(0x33, 0x81, c20Media(0x0B)),
  recordStop: () => c20Frame(0x33, 0x81, c20Media(0x0A)),
  stateQuery: () => c20Frame(0x33, 0x55),
  versionQuery: () => c20Frame(0x11, 0x01),
};

const PALETTES = ['01', '03', '04', '05', '06', '07', '08', '09', '0A', '0B', '0C'];
const TUNE = ['TIB', 'TIC', 'TDI', 'TAS', 'TAR', 'TTR', 'TGM'];

// Komut → gönderilecek "#TP" çerçeveleri (metin). Bilinmeyen komut ya da geçersiz değer: null
function encode(cmd, a = {}, { invertYaw = false } = {}) {
  const ys = invertYaw ? -1 : 1;
  switch (cmd) {
    case 'stop': return [tp('G', 'w', 'PTZ', '00')];
    case 'center': return [tp('G', 'w', 'PTZ', '05')];
    case 'follow': return [tp('G', 'w', 'PTZ', '06')];
    case 'lock': return [tp('G', 'w', 'PTZ', '07')];
    case 'lookDown': return [tp('G', 'w', 'GAP', `${angleWord(-90)}10`)];
    case 'goto': return [tp('G', 'w', 'GAY', `${angleWord(ys * clamp(a.yaw, -90, 90))}10`), tp('G', 'w', 'GAP', `${angleWord(a.pitch)}10`)];
    case 'photo': return [tp('D', 'w', 'CAP', '01')];
    case 'recordStart': return [tp('D', 'w', 'REC', '01')];
    case 'recordStop': return [tp('D', 'w', 'REC', '00')];
    case 'recordQuery': return [tp('D', 'r', 'REC', '00')];
    case 'zoomIn': return [tp('D', 'w', 'DZM', '0A')];
    case 'zoomOut': return [tp('D', 'w', 'DZM', '0B')];
    case 'zoomSet': return [tp('D', 'w', 'DZM', `0${Math.round(clamp(a.level, 0, 4))}`)];
    case 'zoomQuery': return [tp('D', 'r', 'DZM', '00')];
    case 'palette': return PALETTES.includes(String(a.code)) ? [tp('D', 'w', 'IMG', String(a.code))] : null;
    case 'thermalScene': return /^0[0-7C-F]$/.test(String(a.code)) ? [tp('D', 'w', 'TSM', String(a.code))] : null;
    case 'thermalTune': return TUNE.includes(String(a.param)) ? [tp('D', 'w', String(a.param), hex2(Math.round(clamp(a.value, a.param === 'TAS' ? 5 : 0, 100))))] : null;
    case 'laserOnce': return [tp('D', 'r', 'SLR', '00')];
    case 'ext': return [tp('D', 'w', 'EXT', `00${Number(a.osd) ? 1 : 0}${Number(a.led) ? 1 : 0}`, { lower: true })];
    case 'recordRes': return [tp('D', 'w', 'VID', `0${Math.round(clamp(a.res, 0, 3))}`)];
    case 'sdQuery': return [tp('D', 'r', 'SDC', '01')];
    case 'versionQuery': return [tp('D', 'r', 'VER', '00')];
    case 'modelQuery': return [tp('D', 'r', 'MOD', '00')];
    case 'timeSync': {
      const d = a.date instanceof Date ? a.date : new Date();
      const p = (n) => String(n).padStart(2, '0');
      return [tp('D', 'w', 'TIM', `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.00${p(d.getDate())}${p(d.getMonth() + 1)}${p(d.getFullYear() % 100)}`)];
    }
    case 'raw': { // gövde yazılır, sağlama eklenir: #TPUG2wPTZ05
      const body = String(a.text || '').trim();
      if (!/^#(?:TP|tp)U[A-Z][0-9A-F][rw][A-Z]{3}[\x20-\x7e]{0,15}$/.test(body)) return null;
      return [seal(body) + (body[4] === 'G' ? '' : '\r\n')];
    }
    default: return null;
  }
}

class Skydroid extends CameraDriver {
  constructor(conn) {
    const profile = PROFILES[conn.model] || PROFILES.skydroidc12;
    super(conn, { port: 5000, localPort: 5000, transport: profile.transport || (conn.camTransport === 'udp' ? 'udp' : 'tcp') });
    this.profile = profile;
    this.invertYaw = !!conn.camInvertYaw;
    this.queue = [];
    this.joy = null;
    this.joyPhase = 0;
    this.heldZoom = null;
    this.ticks = 0;
    this.expect = new Map(); // komut kimliği → son istek zamanı (yanıtı kullanıcıya göstermek için)
    this.status = {};
    this.cam = null;         // C20: kamera bağlantısı (TCP 8100)
    this.lastStatusAt = 0;
  }

  onOpen() {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.profile.camera === 'c20') {
      this.cam = new TcpLink(this.host, Number(this.conn.camCamPort) || 8100);
      this.cam.on('up', () => { this.status.camLink = true; this.pushStatus(true); this.cam.send(C20.versionQuery()); });
      this.cam.on('down', () => { this.status.camLink = false; this.pushStatus(true); });
      this.cam.on('data', (d) => this.onC20(d));
      this.status.camLink = false;
      this.cam.open();
    }
  }

  onClose() {
    clearInterval(this.timer);
    if (this.connected) for (const f of [tp('G', 'w', 'GSY', '00'), tp('G', 'w', 'GSP', '00')]) this.send(Buffer.from(f, 'latin1'));
    if (this.cam) { this.cam.close(); this.cam.removeAllListeners(); this.cam = null; }
    this.queue = []; this.joy = null; this.heldZoom = null;
  }

  onLink() {
    if (this.profile.camera === 'tp') for (const c of ['modelQuery', 'versionQuery']) this.queue.push(...encode(c));
  }

  releaseAll() {
    if (this.joy) this.queue.push(tp('G', 'w', 'GSY', '00'), tp('G', 'w', 'GSP', '00'), tp('G', 'w', 'PTZ', '00'));
    if (this.heldZoom && this.cam) this.cam.send(C20.lensStop());
    this.joy = null; this.heldZoom = null;
  }

  // 25 ms'de bir: sıradaki komut → joystick hızları (yön ve yükseliş sırayla, her biri 50 ms'de bir) → basılı yakınlaştırma
  tick() {
    this.ticks++;
    if (this.linked || this.transport === 'udp') {
      if (this.ticks % 40 === 1) this.queue.push(tp('G', 'w', 'GAA', '0A')); // konum bildirimini 10 Hz açık tut
      if (this.profile.camera === 'tp' && this.linked) {
        if (this.ticks % 80 === 20) this.queue.push(...encode('recordQuery'));
        if (this.profile.zoom && this.ticks % 120 === 60) this.queue.push(...encode('zoomQuery'));
      }
    }
    let f = this.queue.shift();
    if (!f && this.joy) {
      f = this.joyPhase++ % 2 === 0 ? tp('G', 'w', 'GSY', speedByte((this.invertYaw ? -1 : 1) * this.joy.yaw)) : tp('G', 'w', 'GSP', speedByte(this.joy.pitch));
    } else if (!f && this.heldZoom && this.profile.camera === 'tp' && this.ticks % 3 === 0) f = encode(this.heldZoom)[0];
    if (f) this.send(Buffer.from(f, 'latin1'));
  }

  exec(cmd, args) {
    if (!this.connected) return { ok: false, error: 'not_connected' };
    if (this.profile.camera === 'c20' && C20[cmd] && !['zoomIn', 'zoomOut', 'focusNear', 'focusFar', 'lensStop'].includes(cmd)) {
      if (!this.cam || !this.cam.up) return { ok: false, error: 'not_connected' };
      const b = C20[cmd]();
      this.cam.send(b);
      this.log('tx', hex(b.subarray(0, 16)) + (b.length > 16 ? ' …' : ''));
      return { ok: true };
    }
    const frames = encode(cmd, args || {}, { invertYaw: this.invertYaw });
    if (!frames) return { ok: false, error: 'bad_args' };
    if (this.queue.length > 40) return { ok: false, error: 'busy' };
    for (const f of frames) {
      this.queue.push(f);
      this.log('tx', f.trim());
      if (f[6] === 'r' || cmd === 'raw') this.expect.set(f.slice(7, 10), Date.now());
    }
    return { ok: true };
  }

  hold(cmd, args) {
    if (!this.connected) return { ok: false, error: 'not_connected' };
    if (cmd === 'joystick') {
      const yaw = args ? clamp(args.yaw, -63, 63) : 0;
      const pitch = args ? clamp(args.pitch, -63, 63) : 0;
      const next = args && (yaw || pitch) ? { yaw, pitch } : null;
      if (this.joy && !next) this.queue.push(tp('G', 'w', 'GSY', '00'), tp('G', 'w', 'GSP', '00'), tp('G', 'w', 'PTZ', '00'));
      this.joy = next;
    } else if (['zoomIn', 'zoomOut', 'focusNear', 'focusFar'].includes(cmd)) {
      if (this.profile.camera === 'c20') {
        if (!this.cam || !this.cam.up) return { ok: false, error: 'not_connected' };
        if (args && this.heldZoom !== cmd) this.cam.send(C20[cmd]());
        if (!args && this.heldZoom) this.cam.send(C20.lensStop());
      } else if (!this.profile.zoom || cmd.startsWith('focus')) return { ok: false, error: 'unsupported' };
      this.heldZoom = args ? cmd : null;
    } else return { ok: false, error: 'unsupported' };
    this.touchHold(!!(this.joy || this.heldZoom));
    return { ok: true };
  }

  pushStatus(force) {
    const now = Date.now();
    if (!force && now - this.lastStatusAt < 200) return;
    this.lastStatusAt = now;
    this.emit('status', { ...this.status });
  }

  onMessage(buf) {
    let changed = false;
    let force = false;
    for (const f of parseFrames(buf.toString('latin1'))) {
      const d = f.data;
      const st = this.status;
      if (f.id === 'GAC' && /^[0-9A-Fa-f]{12}/.test(d)) {
        const yaw = s16(d.slice(0, 4)) / 100;
        st.yaw = this.invertYaw ? -yaw : yaw; st.pitch = s16(d.slice(4, 8)) / 100; st.roll = s16(d.slice(8, 12)) / 100;
        changed = true;
        continue;
      }
      let text = `${f.id} ${d}`;
      if (f.id === 'REC' && /^0[01]/.test(d)) { st.recording = d[1] === '1'; text = null; }
      else if (f.id === 'DZM' && /^[0-9A-Fa-f]{2}/.test(d)) { st.zoom = parseInt(d.slice(0, 2), 16); text = `DZM ${st.zoom}`; }
      else if (f.id === 'VER' && /^[0-9A-Fa-f]{6}/.test(d)) { st.version = [0, 2, 4].map((i) => parseInt(d.slice(i, i + 2), 16)).join('.'); text = `VER ${st.version}`; }
      else if (f.id === 'MOD' && d) { st.model = d.trim(); text = `MOD ${st.model}`; }
      else if (f.id === 'SDC' && /^[0-9A-Fa-f]{10}/.test(d)) { st.sd = `${parseInt(d.slice(0, 5), 16)} / ${parseInt(d.slice(5, 10), 16)}`; text = `SDC ${st.sd}`; }
      else if (f.id === 'SLR' && /^[0-9A-Fa-f]{4}/.test(d)) { st.laser = parseInt(d.slice(0, 4), 16); text = `SLR ${st.laser}`; }
      else if (f.id === 'IMG' && d) st.palette = d.slice(0, 2).toUpperCase();
      else if (f.id === 'TSM' && d) st.scene = d.slice(0, 2).toUpperCase();
      changed = true;
      force = true;
      const asked = this.expect.get(f.id);
      if (asked && Date.now() - asked < 5000) {
        this.expect.delete(f.id);
        this.log('rx', `#${f.rw === 'r' ? 'r' : 'w'} ${f.id} ${d}`);
        if (text) this.emit('reply', { text });
      }
    }
    if (changed) this.pushStatus(force);
  }

  onC20(buf) {
    for (let i = 0; i + 10 <= buf.length;) {
      const len = buf.readUInt16BE(i + 8);
      const body = buf.subarray(i + 10, i + 10 + len);
      const key = (buf[i + 6] << 8) | buf[i + 7];
      if (key === 0x1101 && body.length) { this.status.version = body.toString('latin1').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 40); this.pushStatus(true); }
      this.log('rx', hex(buf.subarray(i, Math.min(buf.length, i + 10 + Math.min(len, 12)))));
      i += 10 + len;
    }
  }
}

module.exports = { Driver: Skydroid, tp, seal, encode, parseFrames, c20Frame, C20, speedByte, angleWord, PROFILES };
