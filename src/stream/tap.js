'use strict';

// Akış verisi yakalayıcı: son N kilobaytı halka tamponda tutar, paketleri (RTP / RTCP / MPEG-TS / RTSP) çözümler,
// hız ve kayıp istatistiklerini üretir. HEX / ASCII görünümü, paket listesi ve boyut grafiği buradan beslenir.

const H264_NAL = { 1: 'P/B', 5: 'IDR', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD', 24: 'STAP-A', 28: 'FU-A', 29: 'FU-B' };
const H265_NAL = { 19: 'IDR', 20: 'IDR', 21: 'CRA', 32: 'VPS', 33: 'SPS', 34: 'PPS', 35: 'AUD', 39: 'SEI', 40: 'SEI', 48: 'AP', 49: 'FU' };
const RTCP_TYPES = { 200: 'SR', 201: 'RR', 202: 'SDES', 203: 'BYE', 204: 'APP', 205: 'RTPFB', 206: 'PSFB', 207: 'XR' };
const STATIC_PT = { 0: 'PCMU', 3: 'GSM', 8: 'PCMA', 9: 'G722', 10: 'L16', 11: 'L16', 14: 'MPA', 26: 'JPEG', 32: 'MPV', 33: 'MP2T', 34: 'H263' };

// RTP başlığı (RFC 3550). Geçersizse null.
function parseRtp(buf) {
  if (buf.length < 12 || (buf[0] >> 6) !== 2) return null;
  const pt = buf[1] & 0x7f;
  if (pt >= 72 && pt <= 76) return null; // RTCP ile çakışan aralık
  const cc = buf[0] & 0x0f;
  let off = 12 + cc * 4;
  if (buf[0] & 0x10) { // uzantı
    if (buf.length < off + 4) return null;
    off += 4 + buf.readUInt16BE(off + 2) * 4;
  }
  if (off > buf.length) return null;
  return { pt, marker: !!(buf[1] & 0x80), seq: buf.readUInt16BE(2), ts: buf.readUInt32BE(4), ssrc: buf.readUInt32BE(8), payloadOffset: off, padding: !!(buf[0] & 0x20) };
}

function parseRtcp(buf) {
  if (buf.length < 8 || (buf[0] >> 6) !== 2) return null;
  const type = buf[1];
  if (type < 192 || type > 223) return null;
  return { type, name: RTCP_TYPES[type] || `RTCP ${type}`, ssrc: buf.readUInt32BE(4) };
}

// RTP yükünden NAL türü (H.264 / H.265); codec bilinmiyorsa null
function nalName(codec, buf, off) {
  if (off >= buf.length) return null;
  if (codec === 'H264') {
    let t = buf[off] & 0x1f;
    let part = '';
    if (t === 28 && off + 1 < buf.length) { part = buf[off + 1] & 0x80 ? '▸' : buf[off + 1] & 0x40 ? '◂' : '·'; t = buf[off + 1] & 0x1f; }
    else if (t === 24 && off + 3 < buf.length) t = buf[off + 3] & 0x1f;
    return (H264_NAL[t] || `NAL ${t}`) + part;
  }
  if (codec === 'H265') {
    let t = (buf[off] >> 1) & 0x3f;
    let part = '';
    if (t === 49 && off + 2 < buf.length) { part = buf[off + 2] & 0x80 ? '▸' : buf[off + 2] & 0x40 ? '◂' : '·'; t = buf[off + 2] & 0x3f; }
    else if (t === 48 && off + 4 < buf.length) t = (buf[off + 4] >> 1) & 0x3f;
    return (H265_NAL[t] || (t < 10 ? 'P/B' : `NAL ${t}`)) + part;
  }
  return null;
}

const isKey = (nal) => !!nal && /^(IDR|CRA)/.test(nal) && !/[·◂]$/.test(nal);

class Tap {
  constructor({ sizeKB = 1024, maxPackets = 6000 } = {}) {
    this.size = Math.max(64, sizeKB) * 1024;
    this.ring = Buffer.alloc(this.size);
    this.total = 0;            // yazılan toplam bayt (mutlak konum)
    this.floor = 0;            // "Temizle"den sonra okunabilir en eski konum
    this.packets = [];         // { n, t, off, len, dir, kind, ... }
    this.maxPackets = maxPackets;
    this.packetSeq = 0;
    this.messages = [];        // sinyalleşme (RTSP) iletileri { n, t, dir, text }
    this.messageSeq = 0;
    this.kind = 'data';
    this.payloadTypes = {};    // pt -> { codec, rate } (SDP'den)
    this.rtp = new Map();      // ssrc -> istatistik
    this.ts = { packets: 0, ccErrors: 0, syncLoss: 0, pids: new Map() };
    this.tsCarry = null;
    this.counters = { bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsOut: 0 };
    this.mark = { bytesIn: 0, bytesOut: 0, packetsIn: 0, t: Date.now() };
    this.sdp = '';
    this.server = '';
    this.lastKeyAt = 0;
    this.keyIntervalMs = 0;
    this.drainedPacket = 0;
    this.drainedMessage = 0;
  }

  setPayloadType(pt, codec, rate) { this.payloadTypes[pt] = { codec: String(codec || '').toUpperCase(), rate: Number(rate) || 90000 }; }

  // SDP'deki rtpmap satırlarından yük türlerini öğren
  learnSdp(text) {
    this.sdp = String(text || '');
    for (const m of this.sdp.matchAll(/^a=rtpmap:(\d+) ([^/\s]+)\/(\d+)/gm)) this.setPayloadType(Number(m[1]), m[2], Number(m[3]));
  }

  _append(buf) {
    const off = this.total;
    let src = buf;
    if (src.length > this.size) src = src.subarray(src.length - this.size);
    const pos = (this.total + (buf.length - src.length)) % this.size;
    const first = Math.min(src.length, this.size - pos);
    src.copy(this.ring, pos, 0, first);
    if (first < src.length) src.copy(this.ring, 0, first);
    this.total += buf.length;
    return off;
  }

  _push(meta) {
    meta.n = ++this.packetSeq;
    this.packets.push(meta);
    if (this.packets.length > this.maxPackets) this.packets.splice(0, this.packets.length - this.maxPackets);
    return meta;
  }

  _count(dir, len) {
    if (dir === 'out') { this.counters.bytesOut += len; this.counters.packetsOut++; } else { this.counters.bytesIn += len; this.counters.packetsIn++; }
  }

  // Bir datagram ya da çerçevelenmiş paket (UDP, RTSP araya eklemeli kanal). hint: 'rtp' | 'rtcp' | 'ts' | 'auto'
  addPacket(buf, { dir = 'in', hint = 'auto', ch = null, t = Date.now() } = {}) {
    this._count(dir, buf.length);
    const meta = { t, off: this._append(buf), len: buf.length, dir, kind: 'data' };
    if (ch !== null) meta.ch = ch;
    const rtcp = hint === 'rtcp' || hint === 'auto' ? parseRtcp(buf) : null;
    if (rtcp) {
      meta.kind = 'rtcp'; meta.info = rtcp.name; meta.ssrc = rtcp.ssrc;
      return this._push(meta);
    }
    const rtp = hint === 'rtp' || hint === 'auto' ? parseRtp(buf) : null;
    if (rtp && hint !== 'ts' && !(hint === 'auto' && buf[0] === 0x47 && buf.length % 188 === 0)) {
      meta.kind = 'rtp'; meta.pt = rtp.pt; meta.seq = rtp.seq; meta.ts = rtp.ts; meta.ssrc = rtp.ssrc; meta.m = rtp.marker;
      const known = this.payloadTypes[rtp.pt] || (STATIC_PT[rtp.pt] ? { codec: STATIC_PT[rtp.pt], rate: rtp.pt === 0 || rtp.pt === 8 || rtp.pt === 9 ? 8000 : 90000 } : null);
      if (known) meta.codec = known.codec;
      if (dir === 'in') this._rtpStats(rtp, known, t, buf.length);
      if (known && known.codec === 'MP2T') this._scanTs(buf.subarray(rtp.payloadOffset), true);
      else if (known) {
        const nal = nalName(known.codec, buf, rtp.payloadOffset);
        if (nal) { meta.info = nal; if (isKey(nal) && dir === 'in') this._key(t); }
      }
      return this._push(meta);
    }
    if (buf[0] === 0x47 && buf.length >= 188) { meta.kind = 'ts'; meta.info = this._scanTs(buf, true); }
    return this._push(meta);
  }

  // Sürekli bayt akışı (TCP üzerinden MPEG-TS, ffmpeg kopyası). Paket listesine parça olarak düşer.
  addStream(buf, { dir = 'in', t = Date.now(), ts = true } = {}) {
    this._count(dir, buf.length);
    const meta = { t, off: this._append(buf), len: buf.length, dir, kind: 'data' };
    if (ts && dir === 'in') { const info = this._scanTs(buf, false); if (info) { meta.kind = 'ts'; meta.info = info; } }
    return this._push(meta);
  }

  // Sinyalleşme iletisi (RTSP istek / yanıt): halkaya ve ileti günlüğüne
  addMessage(text, { dir = 'in', t = Date.now() } = {}) {
    const buf = Buffer.from(text, 'latin1');
    this._count(dir, buf.length);
    const first = text.split(/\r?\n/, 1)[0];
    this._push({ t, off: this._append(buf), len: buf.length, dir, kind: 'rtsp', info: first.slice(0, 80) });
    this.messages.push({ n: ++this.messageSeq, t, dir, text });
    if (this.messages.length > 300) this.messages.splice(0, this.messages.length - 300);
    if (dir === 'in') {
      const srv = /^Server:\s*(.+)$/im.exec(text);
      if (srv) this.server = srv[1].trim();
      if (/^Content-Type:\s*application\/sdp/im.test(text)) {
        const i = text.search(/\r?\n\r?\n/);
        if (i >= 0) this.learnSdp(text.slice(i).trim());
      }
    }
  }

  _key(t) {
    if (this.lastKeyAt && t - this.lastKeyAt > 150) this.keyIntervalMs = t - this.lastKeyAt;
    if (!this.lastKeyAt || t - this.lastKeyAt > 150) this.lastKeyAt = t;
  }

  _rtpStats(rtp, known, t, len) {
    let s = this.rtp.get(rtp.ssrc);
    if (!s) {
      if (this.rtp.size > 16) this.rtp.clear();
      s = { ssrc: rtp.ssrc, pt: rtp.pt, codec: known ? known.codec : '', rate: known ? known.rate : 90000, packets: 0, bytes: 0, lost: 0, reordered: 0, lastSeq: null, jitter: 0, transit: null, firstAt: t };
      this.rtp.set(rtp.ssrc, s);
    }
    s.packets++; s.bytes += len; s.pt = rtp.pt; s.lastAt = t;
    if (s.lastSeq !== null) {
      const d = (rtp.seq - s.lastSeq + 65536) % 65536;
      if (d === 0) s.reordered++;
      else if (d < 3000) { s.lost += d - 1; s.lastSeq = rtp.seq; }
      else if (d > 62536) s.reordered++;   // geç gelen eski paket
      else s.lastSeq = rtp.seq;            // sıra atladı (yeniden başlama)
    } else s.lastSeq = rtp.seq;
    // Varışlar arası titreşim (RFC 3550 §6.4.1), milisaniye
    const transit = t - (rtp.ts / s.rate) * 1000;
    if (s.transit !== null) {
      const dd = Math.abs(transit - s.transit);
      if (dd < 5000) s.jitter += (dd - s.jitter) / 16;
    }
    s.transit = transit;
  }

  // MPEG-TS paketlerini say; süreklilik sayacı hatalarını bul. aligned: tampon 0x47 ile başlar ve 188'in katıdır
  _scanTs(buf, aligned) {
    let data = buf;
    if (!aligned) {
      if (this.tsCarry && this.tsCarry.length) data = Buffer.concat([this.tsCarry, buf]);
      let i = 0;
      // eşitleme: art arda üç paket başlangıcı 0x47 olmalı
      while (i + 376 < data.length && !(data[i] === 0x47 && data[i + 188] === 0x47 && data[i + 376] === 0x47)) i++;
      if (i + 376 >= data.length) {
        if (data.length > 188 * 8) { this.tsCarry = null; if (this.ts.packets) this.ts.syncLoss++; return null; }
        this.tsCarry = Buffer.from(data);
        return null;
      }
      data = data.subarray(i);
    }
    let n = 0;
    let i = 0;
    const pidsSeen = new Set();
    for (; i + 188 <= data.length; i += 188) {
      if (data[i] !== 0x47) { this.ts.syncLoss++; break; }
      const pid = ((data[i + 1] & 0x1f) << 8) | data[i + 2];
      const afc = (data[i + 3] >> 4) & 3;
      const cc = data[i + 3] & 0x0f;
      let p = this.ts.pids.get(pid);
      if (!p) {
        if (this.ts.pids.size > 256) this.ts.pids.clear();
        p = { pid, packets: 0, ccErrors: 0, cc: null };
        this.ts.pids.set(pid, p);
      }
      p.packets++;
      if (pid !== 0x1fff && (afc & 1)) {
        if (p.cc !== null && ((p.cc + 1) & 0x0f) !== cc && p.cc !== cc) { p.ccErrors++; this.ts.ccErrors++; }
        p.cc = cc;
      }
      pidsSeen.add(pid);
      n++;
    }
    if (!aligned) this.tsCarry = i < data.length ? Buffer.from(data.subarray(i)) : null;
    this.ts.packets += n;
    if (!n) return null;
    const list = [...pidsSeen].slice(0, 4).map((x) => '0x' + x.toString(16)).join(' ');
    return `TS ×${n} PID ${list}${pidsSeen.size > 4 ? '…' : ''}`;
  }

  // Son örneklemeden bu yana geçen sürenin hızları (grafik için)
  sample(now = Date.now()) {
    const dt = Math.max(1, now - this.mark.t) / 1000;
    const out = {
      bps: Math.round(((this.counters.bytesIn - this.mark.bytesIn) * 8) / dt),
      bpsOut: Math.round(((this.counters.bytesOut - this.mark.bytesOut) * 8) / dt),
      pps: Math.round((this.counters.packetsIn - this.mark.packetsIn) / dt),
    };
    this.mark = { bytesIn: this.counters.bytesIn, bytesOut: this.counters.bytesOut, packetsIn: this.counters.packetsIn, t: now };
    return out;
  }

  stats() {
    return {
      ...this.counters,
      total: this.total,
      bufferSize: this.size,
      server: this.server,
      sdp: this.sdp,
      keyIntervalMs: this.keyIntervalMs,
      rtp: [...this.rtp.values()].map((s) => ({
        ssrc: s.ssrc, pt: s.pt, codec: s.codec, rate: s.rate, packets: s.packets, bytes: s.bytes, lost: s.lost, reordered: s.reordered,
        jitter: Math.round(s.jitter * 10) / 10, lossPct: s.packets + s.lost ? Math.round((s.lost / (s.packets + s.lost)) * 10000) / 100 : 0,
      })),
      ts: this.ts.packets ? {
        packets: this.ts.packets, ccErrors: this.ts.ccErrors, syncLoss: this.ts.syncLoss,
        pids: [...this.ts.pids.values()].sort((a, b) => b.packets - a.packets).slice(0, 24).map((p) => ({ pid: p.pid, packets: p.packets, ccErrors: p.ccErrors })),
      } : null,
    };
  }

  // Halkadaki [from, to) mutlak aralığını kopyala (taşan kısım kırpılır)
  read(from, to) {
    const start = Math.max(from, this.total - this.size, this.floor);
    const end = Math.min(to, this.total);
    if (end <= start) return { base: start, data: Buffer.alloc(0) };
    const out = Buffer.allocUnsafe(end - start);
    const pos = start % this.size;
    const first = Math.min(out.length, this.size - pos);
    this.ring.copy(out, 0, pos, pos + first);
    if (first < out.length) this.ring.copy(out, first, 0, out.length - first);
    return { base: start, data: out };
  }

  tail(n) { return this.read(this.total - n, this.total); }

  // Duraklatılan görünüm için: tamponun tamamı ve içindeki paketler
  snapshot() {
    const { base, data } = this.read(this.total - this.size, this.total);
    return { base, data, total: this.total, packets: this.packets.filter((p) => p.off >= base), messages: this.messages.slice() };
  }

  // Canlı görünüm için: son çağrıdan beri gelen paketler ve iletiler (en çok limit kadar; fazlası atlanır)
  drain(limit = 150) {
    let fresh = [];
    let i = this.packets.length;
    while (i > 0 && this.packets[i - 1].n > this.drainedPacket) i--;
    fresh = this.packets.slice(i);
    const skipped = Math.max(0, fresh.length - limit);
    if (skipped) fresh = fresh.slice(-limit);
    if (this.packets.length) this.drainedPacket = this.packets[this.packets.length - 1].n;
    const msgs = this.messages.filter((m) => m.n > this.drainedMessage);
    if (this.messages.length) this.drainedMessage = this.messages[this.messages.length - 1].n;
    return { packets: fresh, skipped, messages: msgs };
  }

  clear() {
    this.packets = [];
    this.messages = [];
    this.floor = this.total; // mutlak konum korunur; yalnız okunabilir aralık sıfırlanır
  }
}

// RTSP bayt akışını (tek yön) iletilere ve araya eklemeli ($) ikili çerçevelere ayırır
class RtspDemux {
  constructor(onFrame, onMessage, onRaw) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.onMessage = onMessage;
    this.onRaw = onRaw;       // RTSP olmayan içerik (HTTP tüneli vb.)
    this.broken = false;
  }

  feed(chunk) {
    if (this.broken) return this.onRaw(chunk);
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (!this.buf.length) return;
      if (this.buf[0] === 0x24) { // '$' kanal(1) uzunluk(2)
        if (this.buf.length < 4) return;
        const len = this.buf.readUInt16BE(2);
        if (this.buf.length < 4 + len) return;
        this.onFrame(this.buf[1], this.buf.subarray(4, 4 + len), this.buf.subarray(0, 4 + len));
        this.buf = this.buf.subarray(4 + len);
        continue;
      }
      // metin iletisi: başlıklar \r\n\r\n ile biter, gövde Content-Length kadar
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.buf.length > 65536 || !/^[A-Z_]{3,16}[ /]/.test(this.buf.subarray(0, 17).toString('latin1'))) {
          if (this.buf.length > 16) { this.broken = true; const b = this.buf; this.buf = Buffer.alloc(0); return this.onRaw(b); }
        }
        return;
      }
      const head = this.buf.subarray(0, end + 4).toString('latin1');
      const m = /^Content-Length:\s*(\d+)/im.exec(head);
      const bodyLen = m ? Number(m[1]) : 0;
      if (this.buf.length < end + 4 + bodyLen) return;
      this.onMessage(this.buf.subarray(0, end + 4 + bodyLen).toString('latin1'));
      this.buf = this.buf.subarray(end + 4 + bodyLen);
    }
  }
}

module.exports = { Tap, RtspDemux, parseRtp, parseRtcp, nalName };
