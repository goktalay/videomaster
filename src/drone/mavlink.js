'use strict';

// MAVLink v1 (0xFE) ve v2 (0xFD) çerçeve çözücü/kodlayıcı. Tanımlar mavdefs.json'dan gelir
// (tools/gen-mavdefs.js ile resmî XML'lerden üretilir: minimal + standard + common + ardupilotmega).
//   MavParser.push(buf) → [{ version, seq, sysid, compid, msgid, name, fields, raw, payload }]
//   encode(name, fields, { sysid, compid, seq, version }) → Buffer
// Notlar:
//  - char[N] alanları ilk NUL'a kadar okunur (UTF-8); boşluklar KIRPILMAZ (STATUSTEXT parçaları birleştirilirken gerekir).
//  - 64 bit tamsayılar güvenli aralıktaysa (±2^53) tam Number, değilse BigInt→Number yaklaşık değeridir (alt bitler kaybolur).
//  - Diziler JS dizisi olarak döner. Bilinmeyen ileti kimlikleri CRC doğrulanamadan "UNKNOWN_<id>" adıyla, fields=null döner.
//  - payload: sıfırla tam boya doldurulmuş ham yük (PX4'ün param_value içine bayt bayt koyduğu tamsayılar gibi durumlar için).

const DEFS = require('./mavdefs.json');

const MAGIC_V1 = 0xfe;
const MAGIC_V2 = 0xfd;
const IFLAG_SIGNED = 0x01;
const SIGNATURE_LEN = 13;

const TYPES = {
  u8: { size: 1, read: (b, o) => b.readUInt8(o), write: (b, o, v) => b.writeUInt8(clampInt(v, 0, 0xff), o) },
  i8: { size: 1, read: (b, o) => b.readInt8(o), write: (b, o, v) => b.writeInt8(clampInt(v, -0x80, 0x7f), o) },
  c: { size: 1, read: (b, o) => b.readUInt8(o), write: (b, o, v) => b.writeUInt8(clampInt(v, 0, 0xff), o) },
  u16: { size: 2, read: (b, o) => b.readUInt16LE(o), write: (b, o, v) => b.writeUInt16LE(clampInt(v, 0, 0xffff), o) },
  i16: { size: 2, read: (b, o) => b.readInt16LE(o), write: (b, o, v) => b.writeInt16LE(clampInt(v, -0x8000, 0x7fff), o) },
  u32: { size: 4, read: (b, o) => b.readUInt32LE(o), write: (b, o, v) => b.writeUInt32LE(clampInt(v, 0, 0xffffffff), o) },
  i32: { size: 4, read: (b, o) => b.readInt32LE(o), write: (b, o, v) => b.writeInt32LE(clampInt(v, -0x80000000, 0x7fffffff), o) },
  f32: { size: 4, read: (b, o) => b.readFloatLE(o), write: (b, o, v) => b.writeFloatLE(toFloat(v), o) },
  f64: { size: 8, read: (b, o) => b.readDoubleLE(o), write: (b, o, v) => b.writeDoubleLE(toFloat(v), o) },
  u64: { size: 8, read: (b, o) => Number(b.readBigUInt64LE(o)), write: (b, o, v) => b.writeBigUInt64LE(BigInt.asUintN(64, toBig(v)), o) },
  i64: { size: 8, read: (b, o) => Number(b.readBigInt64LE(o)), write: (b, o, v) => b.writeBigInt64LE(BigInt.asIntN(64, toBig(v)), o) },
};

function clampInt(v, min, max) {
  let n = typeof v === 'bigint' ? Number(v) : Number(v);
  if (!Number.isFinite(n)) n = 0;
  n = Math.round(n);
  return n < min ? min : n > max ? max : n;
}
function toFloat(v) { const n = typeof v === 'bigint' ? Number(v) : Number(v); return typeof v === 'number' || !Number.isNaN(n) ? n : 0; }
function toBig(v) {
  if (typeof v === 'bigint') return v;
  const n = Number(v);
  return Number.isFinite(n) ? BigInt(Math.round(n)) : 0n;
}

// X.25 (CRC-16/MCRF4XX) — MAVLink sağlama toplamı
function crcAccumulate(byte, crc) {
  let tmp = byte ^ (crc & 0xff);
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}

function crcX25(buf, start = 0, end = buf.length, crc = 0xffff) {
  for (let i = start; i < end; i++) crc = crcAccumulate(buf[i], crc);
  return crc;
}

// ---- Tanım tabloları ----
const MESSAGES = Object.create(null);       // ad → tanım
const MESSAGES_BY_ID = Object.create(null); // kimlik → tanım

for (const [id, name, crcExtra, extCount, spec] of DEFS.messages) {
  const fields = [];
  let offset = 0;
  const parts = spec ? spec.split(',') : [];
  parts.forEach((p, i) => {
    const [fname, type, len] = p.split(':');
    const count = len ? Number(len) : 0;
    const t = TYPES[type];
    const f = { name: fname, type, size: t.size, length: count, offset, extension: i >= parts.length - extCount };
    offset += t.size * (count || 1);
    fields.push(f);
  });
  const baseLength = fields.filter((f) => !f.extension).reduce((n, f) => n + f.size * (f.length || 1), 0);
  const def = { id, name, crcExtra, fields, length: offset, baseLength };
  MESSAGES[name] = def;
  MESSAGES_BY_ID[id] = def;
}

const ENUMS = DEFS.enums; // { AD: { değer: girişAdı } }

// MAV_CMD: kimlik → { id, name, params: [7 etiket] } ve ad → kimlik
const COMMANDS = Object.create(null);
const COMMAND_IDS = Object.create(null);
ENUMS.MAV_CMD = {};
for (const k of Object.keys(DEFS.commands)) {
  const [name, params] = DEFS.commands[k];
  COMMANDS[k] = { id: Number(k), name, params };
  COMMAND_IDS[name] = Number(k);
  ENUMS.MAV_CMD[k] = name;
}

// Numaralandırma değerinin adı; bilinmiyorsa null
function enumName(enumType, value) {
  const e = ENUMS[enumType];
  if (!e || value === null || value === undefined) return null;
  return e[value] || null;
}

// Numaralandırma girişinin değeri (ad → sayı); bilinmiyorsa null
const enumReverse = Object.create(null);
function enumValue(enumType, name) {
  const e = ENUMS[enumType];
  if (!e) return null;
  let rev = enumReverse[enumType];
  if (!rev) {
    rev = enumReverse[enumType] = Object.create(null);
    for (const k of Object.keys(e)) rev[e[k]] = Number(k);
  }
  return name in rev ? rev[name] : null;
}

// ---- Çözme ----
function decodePayload(def, payload) {
  const out = {};
  for (const f of def.fields) {
    const t = TYPES[f.type];
    if (f.type === 'c' && f.length) {
      let end = payload.indexOf(0, f.offset);
      if (end < 0 || end > f.offset + f.length) end = f.offset + f.length;
      out[f.name] = payload.toString('utf8', f.offset, end);
    } else if (f.length) {
      const arr = new Array(f.length);
      for (let i = 0; i < f.length; i++) arr[i] = t.read(payload, f.offset + i * t.size);
      out[f.name] = arr;
    } else {
      out[f.name] = t.read(payload, f.offset);
    }
  }
  return out;
}

class MavParser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.lastSeq = new Map(); // "sysid:compid" → son sıra numarası
    this.stats = { frames: 0, crcErrors: 0, lost: 0, garbage: 0, unknown: 0 };
  }

  reset() { this.buf = Buffer.alloc(0); this.lastSeq.clear(); }

  // Gelen baytları ekler, tamamlanan iletileri döndürür. Bozuk/çöp baytlarda bir sonraki başlangıç baytına kadar atlar.
  push(chunk) {
    const out = [];
    if (!chunk || !chunk.length) return out;
    let buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let pos = 0;
    while (pos < buf.length) {
      const magic = buf[pos];
      if (magic !== MAGIC_V1 && magic !== MAGIC_V2) { pos++; this.stats.garbage++; continue; }
      const v2 = magic === MAGIC_V2;
      const headerLen = v2 ? 10 : 6;
      if (buf.length - pos < headerLen) break; // başlık henüz tam değil
      const len = buf[pos + 1];
      const incompat = v2 ? buf[pos + 2] : 0;
      if (v2 && (incompat & ~IFLAG_SIGNED)) { pos++; this.stats.garbage++; continue; } // anlaşılmayan uyumsuzluk bayrağı: çerçeve değil
      const signed = v2 && (incompat & IFLAG_SIGNED) !== 0;
      const total = headerLen + len + 2 + (signed ? SIGNATURE_LEN : 0);
      if (buf.length - pos < total) break; // çerçeve henüz tam değil

      let seq; let sysid; let compid; let msgid;
      if (v2) {
        seq = buf[pos + 4]; sysid = buf[pos + 5]; compid = buf[pos + 6];
        msgid = buf[pos + 7] | (buf[pos + 8] << 8) | (buf[pos + 9] << 16);
      } else {
        seq = buf[pos + 2]; sysid = buf[pos + 3]; compid = buf[pos + 4]; msgid = buf[pos + 5];
      }
      const def = MESSAGES_BY_ID[msgid];
      const crcPos = pos + headerLen + len;
      if (def) {
        let crc = crcX25(buf, pos + 1, crcPos);
        crc = crcAccumulate(def.crcExtra, crc);
        if (crc !== (buf[crcPos] | (buf[crcPos + 1] << 8))) {
          // Sağlama tutmadı: bu bayt gerçek başlangıç değildi; bir bayt ilerleyip yeniden eşitlen
          this.stats.crcErrors++;
          pos++;
          continue;
        }
      } else {
        this.stats.unknown++;
      }

      const raw = Buffer.from(buf.subarray(pos, pos + total));
      let fields = null;
      let payload = null;
      if (def) {
        // v2'de sondaki sıfırlar kırpılmış olabilir; v1'de uzantı alanları yoktur → sıfırla tam boya tamamla
        payload = Buffer.alloc(Math.max(def.length, len));
        buf.copy(payload, 0, pos + headerLen, crcPos);
        try { fields = decodePayload(def, payload); } catch { fields = null; }
      }
      const key = sysid * 256 + compid;
      const last = this.lastSeq.get(key);
      if (last !== undefined) this.stats.lost += (seq - last - 1) & 0xff;
      this.lastSeq.set(key, seq);
      this.stats.frames++;
      out.push({ version: v2 ? 2 : 1, seq, sysid, compid, msgid, name: def ? def.name : `UNKNOWN_${msgid}`, fields, raw, payload, signed });
      pos += total;
    }
    this.buf = pos < buf.length ? Buffer.from(buf.subarray(pos)) : Buffer.alloc(0);
    return out;
  }
}

// ---- Kodlama ----
// fields içinde olmayan alanlar 0; metinler sıfırla doldurulur. Skaler bir alana Buffer verilirse baytları aynen yazılır
// (PX4 parametrelerinde int32'nin float alanına bayt bayt konması için).
function encode(name, fields = {}, opts = {}) {
  const def = typeof name === 'number' ? MESSAGES_BY_ID[name] : MESSAGES[name];
  if (!def) throw new Error(`unknown MAVLink message: ${name}`);
  const { sysid = 255, compid = 190, seq = 0, version = 2 } = opts;
  const payload = Buffer.alloc(def.length);
  for (const f of def.fields) {
    const v = fields ? fields[f.name] : undefined;
    if (v === undefined || v === null) continue;
    const t = TYPES[f.type];
    if (f.type === 'c' && f.length) {
      const src = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8');
      src.copy(payload, f.offset, 0, Math.min(src.length, f.length));
    } else if (f.length) {
      const n = Math.min(f.length, v.length || 0);
      for (let i = 0; i < n; i++) t.write(payload, f.offset + i * t.size, v[i]);
    } else if (Buffer.isBuffer(v)) {
      v.copy(payload, f.offset, 0, Math.min(v.length, t.size));
    } else {
      t.write(payload, f.offset, v);
    }
  }

  if (version === 1) {
    if (def.id > 255) throw new Error(`${def.name} cannot be sent as MAVLink v1`);
    const len = def.baseLength; // v1'de uzantı alanları gönderilmez
    const out = Buffer.alloc(6 + len + 2);
    out[0] = MAGIC_V1; out[1] = len; out[2] = seq & 0xff; out[3] = sysid; out[4] = compid; out[5] = def.id;
    payload.copy(out, 6, 0, len);
    const crc = crcAccumulate(def.crcExtra, crcX25(out, 1, 6 + len));
    out.writeUInt16LE(crc, 6 + len);
    return out;
  }

  // v2: sondaki sıfır baytlar kırpılır (en az 1 bayt kalır)
  let len = payload.length;
  while (len > 1 && payload[len - 1] === 0) len--;
  const out = Buffer.alloc(10 + len + 2);
  out[0] = MAGIC_V2; out[1] = len; out[2] = 0; out[3] = 0; out[4] = seq & 0xff; out[5] = sysid; out[6] = compid;
  out[7] = def.id & 0xff; out[8] = (def.id >> 8) & 0xff; out[9] = (def.id >> 16) & 0xff;
  payload.copy(out, 10, 0, len);
  const crc = crcAccumulate(def.crcExtra, crcX25(out, 1, 10 + len));
  out.writeUInt16LE(crc, 10 + len);
  return out;
}

module.exports = { MavParser, encode, MESSAGES, MESSAGES_BY_ID, ENUMS, COMMANDS, COMMAND_IDS, enumName, enumValue, crcX25 };
