'use strict';

// MSP (MultiWii Serial Protocol) kodlayıcı ve akış çözücü — Betaflight ile konuşmak için.
// Kaynak: betaflight/src/main/msp/msp_serial.c (çerçeve durum makinesi) ve msp_protocol.h (komut kimlikleri).
//
//   MSP v1 :  '$' 'M' yön  boyut(u8) komut(u8) veri…  xor(boyut, komut, veri)
//   JUMBO  :  boyut = 255 ise ardından gerçek boyut (u16 LE) gelir; sağlama toplamı onu da kapsar (veri ≥ 255 bayt)
//   MSP v2 :  '$' 'X' yön  bayrak(u8) komut(u16 LE) boyut(u16 LE) veri…  crc8_dvb_s2(bayrak … veri)
//   v2/v1  :  komutu 255 olan v1 çerçevesinin verisi bir v2 çerçevesidir (bayrak, komut, boyut, veri, crc8)
//   yön    :  '<' istek (karta), '>' yanıt, '!' hata yanıtı
//
//   encode(cmd, payload?, { dir, version, flags })  → Buffer   (komut > 254 ise kendiliğinden v2)
//   const p = new MspParser({ onText });  p.push(buf) → [{ version, dir, cmd, payload, error, flags }]
//   MSP olmayan baytlar (aynı hattan gelen CLI metni) onText(string) ile ve p.text / p.takeText() üzerinden aktarılır.

const MSP = {
  MSP_API_VERSION: 1,
  MSP_FC_VARIANT: 2,
  MSP_FC_VERSION: 3,
  MSP_BOARD_INFO: 4,
  MSP_BUILD_INFO: 5,
  MSP_NAME: 10,
  MSP_BATTERY_CONFIG: 32,
  MSP_FEATURE_CONFIG: 36,
  MSP_MIXER_CONFIG: 42,
  MSP_REBOOT: 68,              // yapılandırıcıdaki adı MSP_SET_REBOOT
  MSP_ADVANCED_CONFIG: 90,
  MSP_SET_ARMING_DISABLED: 99, // yapılandırıcıdaki adı MSP_ARMING_DISABLE
  MSP_STATUS: 101,
  MSP_RAW_IMU: 102,
  MSP_SERVO: 103,
  MSP_MOTOR: 104,
  MSP_RC: 105,
  MSP_RAW_GPS: 106,
  MSP_COMP_GPS: 107,
  MSP_ATTITUDE: 108,
  MSP_ALTITUDE: 109,
  MSP_ANALOG: 110,
  MSP_BOXNAMES: 116,
  MSP_BOXIDS: 119,
  MSP_MOTOR_3D_CONFIG: 124,
  MSP_BATTERY_STATE: 130,
  MSP_MOTOR_CONFIG: 131,
  MSP_STATUS_EX: 150,
  MSP_UID: 160,
  MSP_ACC_CALIBRATION: 205,
  MSP_MAG_CALIBRATION: 206,
  MSP_SET_MOTOR: 214,
  MSP_EEPROM_WRITE: 250,
  MSP_V2_FRAME: 255,
};
// Yapılandırıcıdaki (betaflight-configurator MSPCodes.js) eş adlar
const ALIASES = { MSP_SET_REBOOT: MSP.MSP_REBOOT, MSP_ARMING_DISABLE: MSP.MSP_SET_ARMING_DISABLED };

const MSP_NAMES = {};
for (const k of Object.keys(MSP)) MSP_NAMES[MSP[k]] = k;
Object.assign(MSP, ALIASES);

const mspName = (cmd) => MSP_NAMES[cmd] || `MSP_${cmd}`;

const JUMBO_LIMIT = 255;

// CRC-8/DVB-S2 (çokterimli 0xD5, başlangıç 0) — "123456789" için 0xBC
const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0xd5) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

function crc8DvbS2(buf, crc = 0, start = 0, end = buf.length) {
  let c = crc & 0xff;
  for (let i = start; i < end; i++) c = CRC8_TABLE[c ^ buf[i]];
  return c;
}

function xorSum(buf, start = 0, end = buf.length) {
  let c = 0;
  for (let i = start; i < end; i++) c ^= buf[i];
  return c;
}

function toBuffer(payload) {
  if (!payload) return Buffer.alloc(0);
  if (Buffer.isBuffer(payload)) return payload;
  return Buffer.from(payload);
}

function dirByte(dir) {
  const d = dir || '<';
  if (d !== '<' && d !== '>' && d !== '!') throw new Error(`bad MSP direction: ${dir}`);
  return d.charCodeAt(0);
}

function encodeV1(cmd, payload, dir = '<') {
  const data = toBuffer(payload);
  if (cmd < 0 || cmd > 255) throw new Error(`MSP v1 command out of range: ${cmd}`);
  if (data.length > 0xffff) throw new Error('MSP v1 payload too large');
  const jumbo = data.length >= JUMBO_LIMIT;
  const head = jumbo ? 7 : 5;
  const out = Buffer.alloc(head + data.length + 1);
  out[0] = 0x24; out[1] = 0x4d; out[2] = dirByte(dir);
  out[3] = jumbo ? JUMBO_LIMIT : data.length;
  out[4] = cmd;
  if (jumbo) out.writeUInt16LE(data.length, 5);
  data.copy(out, head);
  out[out.length - 1] = xorSum(out, 3, out.length - 1);
  return out;
}

function encodeV2(cmd, payload, dir = '<', flags = 0) {
  const data = toBuffer(payload);
  if (cmd < 0 || cmd > 0xffff) throw new Error(`MSP v2 command out of range: ${cmd}`);
  if (data.length > 0xffff) throw new Error('MSP v2 payload too large');
  const out = Buffer.alloc(8 + data.length + 1);
  out[0] = 0x24; out[1] = 0x58; out[2] = dirByte(dir);
  out[3] = flags & 0xff;
  out.writeUInt16LE(cmd, 4);
  out.writeUInt16LE(data.length, 6);
  data.copy(out, 8);
  out[out.length - 1] = crc8DvbS2(out, 0, 3, out.length - 1);
  return out;
}

function encode(cmd, payload, opts = {}) {
  const version = opts.version || (cmd > 254 ? 2 : 1);
  return version === 2 ? encodeV2(cmd, payload, opts.dir, opts.flags) : encodeV1(cmd, payload, opts.dir);
}

const DIRS = { 0x3c: '<', 0x3e: '>', 0x21: '!' };

class MspParser {
  // onText(str): MSP olmayan baytlar (latin1 metin). maxPayload: bozuk başlık yüzünden sonsuza dek beklememek için üst sınır.
  constructor(opts = {}) {
    this.onText = typeof opts.onText === 'function' ? opts.onText : null;
    this.maxPayload = opts.maxPayload || 8192;
    this.maxText = opts.maxText || 65536;
    this.textMode = false; // true: çözme yapılmaz, her şey metindir (kart CLI kipindeyken MSP göndermez)
    this.reset();
  }

  reset() {
    this.buf = Buffer.alloc(0);
    this.text = '';
    this.stats = { frames: 0, errors: 0, textBytes: 0 };
  }

  takeText() {
    const t = this.text;
    this.text = '';
    return t;
  }

  _text(bytes) {
    if (!bytes.length) return;
    const s = bytes.toString('latin1');
    this.stats.textBytes += bytes.length;
    this.text = (this.text + s).slice(-this.maxText);
    if (this.onText) this.onText(s);
  }

  // Yarım kalmış olası çerçeve başını da metin olarak boşaltır (hat sessizleşince çağrılabilir)
  flush() {
    if (!this.buf.length) return;
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    this._text(rest);
  }

  push(chunk) {
    const frames = [];
    if (!chunk || !chunk.length) return frames;
    if (this.textMode) {
      if (this.buf.length) { const rest = this.buf; this.buf = Buffer.alloc(0); this._text(rest); }
      this._text(chunk);
      return frames;
    }
    let buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let i = 0;
    const n = buf.length;
    for (;;) {
      const s = buf.indexOf(0x24, i);
      if (s < 0) { this._text(buf.subarray(i)); i = n; break; }
      if (s > i) this._text(buf.subarray(i, s));
      i = s;
      if (n - i < 3) break; // başlık tamamlanmadı
      const magic = buf[i + 1];
      const dir = DIRS[buf[i + 2]];
      if ((magic !== 0x4d && magic !== 0x58) || !dir) { this._text(buf.subarray(i, i + 1)); i += 1; continue; }

      let total; // çerçevenin tamamı (bayt)
      let frame = null;
      if (magic === 0x4d) {
        if (n - i < 5) break;
        let size = buf[i + 3];
        const cmd = buf[i + 4];
        let head = 5;
        if (size === JUMBO_LIMIT) {
          if (n - i < 7) break;
          size = buf.readUInt16LE(i + 5);
          head = 7;
        }
        if (size > this.maxPayload) { this.stats.errors++; i += 3; continue; }
        total = head + size + 1;
        if (n - i < total) break;
        if (xorSum(buf, i + 3, i + total - 1) === buf[i + total - 1]) {
          const payload = Buffer.from(buf.subarray(i + head, i + head + size));
          frame = { version: 1, dir, cmd, payload, error: dir === '!', flags: 0 };
          // v1 içine sarılmış v2 çerçevesi
          if (cmd === MSP.MSP_V2_FRAME && size >= 6) {
            const innerSize = payload.readUInt16LE(3);
            if (innerSize + 6 === size && crc8DvbS2(payload, 0, 0, size - 1) === payload[size - 1]) {
              frame = { version: 2, dir, cmd: payload.readUInt16LE(1), payload: Buffer.from(payload.subarray(5, 5 + innerSize)), error: dir === '!', flags: payload[0], overV1: true };
            } else frame = null;
          }
        }
      } else {
        if (n - i < 8) break;
        const size = buf.readUInt16LE(i + 6);
        if (size > this.maxPayload) { this.stats.errors++; i += 3; continue; }
        total = 8 + size + 1;
        if (n - i < total) break;
        if (crc8DvbS2(buf, 0, i + 3, i + total - 1) === buf[i + total - 1]) {
          frame = { version: 2, dir, cmd: buf.readUInt16LE(i + 4), payload: Buffer.from(buf.subarray(i + 8, i + 8 + size)), error: dir === '!', flags: buf[i + 3] };
        }
      }
      if (frame) {
        this.stats.frames++;
        frames.push(frame);
        i += total;
        continue;
      }
      // Sağlama toplamı tutmadı: bozuk çerçeveyi at; içinde yeni bir '$' varsa oradan yeniden eşitlen
      this.stats.errors++;
      const next = buf.indexOf(0x24, i + 1);
      i = next >= 0 && next < i + total ? next : i + total;
    }
    this.buf = i < n ? Buffer.from(buf.subarray(i)) : Buffer.alloc(0);
    return frames;
  }
}

module.exports = { MSP, MSP_NAMES, mspName, encode, encodeV1, encodeV2, crc8DvbS2, xorSum, MspParser, JUMBO_LIMIT };
