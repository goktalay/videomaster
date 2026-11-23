'use strict';

// Dron bağlantı taşıyıcıları (Mission Planner'daki bağlantı türleri): seri port, TCP istemci, UDP (gönderen) ve UDP dinleme.
//   createLink(cfg) → EventEmitter { open(): Promise<void>, close(), write(buf): boolean, isOpen, describe() }
//   Olaylar: 'open', 'close', 'data'(Buffer), 'error'(err — err.code: port_in_use | serial_unavailable | connect_failed | timeout | io)
//   cfg: { type: 'serial'|'tcp'|'udp'|'udpin', serialPort, baud, host, port, localPort }
// serialport paketi yalnızca seri bağlantı açılırken (tembel) yüklenir; kurulu değilse 'serial_unavailable' hatası verilir.

const net = require('net');
const dgram = require('dgram');
const { EventEmitter } = require('events');

const TCP_RETRY_MS = 2000;
const TCP_CONNECT_TIMEOUT_MS = 5000;

function linkError(code, message, cause) {
  const e = new Error(message || code);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

function mapError(err, fallback = 'io') {
  if (!err) return linkError(fallback);
  if (err.code === 'EADDRINUSE') return linkError('port_in_use', err.message, err);
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(err.code)) return linkError('connect_failed', err.message, err);
  if (err.code === 'ETIMEDOUT') return linkError('timeout', err.message, err);
  return linkError(fallback, err.message, err);
}

function loadSerialPort() {
  try { return require('serialport').SerialPort; } catch { return null; }
}

class BaseLink extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.isOpen = false;
    this.wanted = false;
    // Dinleyici yokken 'error' olayı süreci düşürmesin
    this.on('error', () => {});
  }

  _setOpen(on) {
    if (this.isOpen === on) return;
    this.isOpen = on;
    this.emit(on ? 'open' : 'close');
  }
}

// ---- Seri port (8N1) ----
class SerialLink extends BaseLink {
  constructor(cfg) {
    super(cfg);
    this.path = String(cfg.serialPort || '').trim();
    this.baud = Number(cfg.baud) || 115200;
    this.port = null;
  }

  describe() { return `${this.path || '?'} @ ${this.baud}`; }

  open() {
    if (this.port) return Promise.resolve();
    this.wanted = true;
    return new Promise((resolve, reject) => {
      const SerialPort = loadSerialPort();
      if (!SerialPort) { this.wanted = false; reject(linkError('serial_unavailable', 'serialport module is not installed')); return; }
      if (!this.path) { this.wanted = false; reject(linkError('connect_failed', 'serial port not set')); return; }
      let port;
      try {
        port = new SerialPort({ path: this.path, baudRate: this.baud, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false });
      } catch (err) { this.wanted = false; reject(mapError(err, 'connect_failed')); return; }
      this.port = port;
      port.on('data', (d) => this.emit('data', d));
      port.on('error', (err) => this.emit('error', mapError(err)));
      port.on('close', () => {
        if (this.port === port) this.port = null;
        this._setOpen(false);
      });
      port.open((err) => {
        if (err) {
          if (this.port === port) this.port = null;
          this.wanted = false;
          const e = /access denied|busy|EBUSY|EACCES/i.test(err.message) ? linkError('port_in_use', err.message, err) : mapError(err, 'connect_failed');
          reject(e);
          return;
        }
        this._setOpen(true);
        resolve();
      });
    });
  }

  write(buf) {
    if (!this.port || !this.isOpen) return false;
    try { this.port.write(buf); return true; } catch { return false; }
  }

  close() {
    this.wanted = false;
    const p = this.port;
    this.port = null;
    if (p) { try { if (p.isOpen) p.close(() => {}); } catch { /* yok */ } }
    this._setOpen(false);
  }
}

// ---- TCP istemci: bağlantı koparsa istenildiği sürece 2 sn'de bir yeniden dener ----
// open() ilk bağlantı kurulunca çözülür; ilk deneme başarısız olursa reddedilir (cfg.retryInitial verilirse denemeyi sürdürür).
class TcpLink extends BaseLink {
  constructor(cfg) {
    super(cfg);
    this.host = String(cfg.host || '127.0.0.1').trim();
    this.port = Number(cfg.port) || 5760;
    this.sock = null;
    this.timer = null;
  }

  describe() { return `tcp ${this.host}:${this.port}`; }

  open() {
    if (this.wanted) return this.isOpen ? Promise.resolve() : (this.opening || Promise.resolve());
    this.wanted = true;
    this.opening = new Promise((resolve, reject) => { this._dial(resolve, reject); });
    return this.opening;
  }

  _dial(resolve, reject) {
    if (!this.wanted) return;
    let settled = false;
    let lastErr = null;
    const s = net.connect({ host: this.host, port: this.port });
    this.sock = s;
    s.setNoDelay(true);
    s.setKeepAlive(true, 5000);
    const guard = setTimeout(() => { lastErr = linkError('timeout', 'connect timeout'); s.destroy(); }, TCP_CONNECT_TIMEOUT_MS);
    s.on('connect', () => {
      clearTimeout(guard);
      settled = true;
      this._setOpen(true);
      if (resolve) resolve();
    });
    s.on('data', (d) => this.emit('data', d));
    s.on('error', (err) => { lastErr = mapError(err, 'connect_failed'); this.emit('error', lastErr); });
    s.on('close', () => {
      clearTimeout(guard);
      if (this.sock !== s) return;
      this.sock = null;
      this._setOpen(false);
      if (!settled && reject && !this.cfg.retryInitial) {
        // İlk deneme başarısız: çağırana bildir, yeniden deneme yok
        this.wanted = false;
        reject(lastErr || linkError('connect_failed', 'connection closed'));
        return;
      }
      if (this.wanted) {
        const cont = settled ? [null, null] : [resolve, reject];
        this.timer = setTimeout(() => { this.timer = null; this._dial(cont[0], cont[1]); }, TCP_RETRY_MS);
      }
    });
  }

  write(buf) {
    if (!this.sock || !this.isOpen) return false;
    try { this.sock.write(buf); return true; } catch { return false; }
  }

  close() {
    this.wanted = false;
    this.opening = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const s = this.sock;
    this.sock = null;
    if (s) { try { s.destroy(); } catch { /* yok */ } }
    this._setOpen(false);
  }
}

// ---- UDP: 'udp' → host:port'a gönderir, yanıtları aynı soketten alır; 'udpin' → localPort'u dinler, karşı ucu ilk paketten öğrenir ----
class UdpLink extends BaseLink {
  constructor(cfg, listen) {
    super(cfg);
    this.listen = listen;
    this.host = String(cfg.host || '127.0.0.1').trim();
    this.port = Number(cfg.port) || 14550;
    const lp = cfg.localPort === undefined || cfg.localPort === null || cfg.localPort === '' ? null : Number(cfg.localPort);
    this.localPort = listen ? (lp === null || !Number.isFinite(lp) ? 14550 : lp) : (lp || 0);
    this.sock = null;
    this.peer = listen ? null : { address: this.host, port: this.port };
  }

  describe() { return this.listen ? `udp ← :${this.localPort}` : `udp → ${this.host}:${this.port}`; }

  open() {
    if (this.sock) return Promise.resolve();
    this.wanted = true;
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      this.sock = s;
      let bound = false;
      s.on('error', (err) => {
        const e = mapError(err);
        if (!bound) {
          if (this.sock === s) this.sock = null;
          this.wanted = false;
          try { s.close(); } catch { /* yok */ }
          reject(e);
          return;
        }
        this.emit('error', e); // ör. karşı uç kapalıyken ICMP "port unreachable"
      });
      s.on('message', (msg, rinfo) => {
        // Dinleme kipinde yanıtlar en son paket gönderen uca gider
        if (this.listen) this.peer = { address: rinfo.address, port: rinfo.port };
        this.emit('data', msg);
      });
      s.on('close', () => {
        if (this.sock === s) this.sock = null;
        this._setOpen(false);
      });
      s.bind(this.localPort, this.listen ? '0.0.0.0' : undefined, () => {
        bound = true;
        try { this.localPort = s.address().port; } catch { /* yok */ }
        this._setOpen(true);
        resolve();
      });
    });
  }

  write(buf) {
    if (!this.sock || !this.isOpen || !this.peer) return false;
    try { this.sock.send(buf, this.peer.port, this.peer.address, () => {}); return true; } catch { return false; }
  }

  close() {
    this.wanted = false;
    const s = this.sock;
    this.sock = null;
    if (this.listen) this.peer = null;
    if (s) { try { s.close(); } catch { /* yok */ } }
    this._setOpen(false);
  }
}

function createLink(cfg) {
  const c = cfg || {};
  switch (c.type) {
    case 'serial': return new SerialLink(c);
    case 'tcp': return new TcpLink(c);
    case 'udp': return new UdpLink(c, false);
    case 'udpin': return new UdpLink(c, true);
    default: throw linkError('unsupported', `unknown link type: ${c.type}`);
  }
}

// Bilgisayardaki seri portlar; serialport yüklenemezse boş dizi
async function listSerialPorts() {
  const SerialPort = loadSerialPort();
  if (!SerialPort) return [];
  try {
    const list = await SerialPort.list();
    return list.map((p) => {
      const label = p.friendlyName || [p.manufacturer, p.pnpId].filter(Boolean)[0] || '';
      return {
        path: p.path,
        manufacturer: p.manufacturer || '',
        vendorId: p.vendorId || '',
        productId: p.productId || '',
        friendly: label && !label.includes(p.path) ? `${p.path} — ${label}` : (label || p.path),
      };
    });
  } catch { return []; }
}

module.exports = { createLink, listSerialPorts };
