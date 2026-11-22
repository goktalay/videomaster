'use strict';

// Kamera sürücülerinin ortak tabanı: UDP kontrol bağlantısı, bağlantı durumu, olaylar.
// Her model sürücüsü bu sınıftan türer ve şunları tanımlar:
//   onOpen()            bağlantı açılınca (zamanlayıcıları kurar)
//   onClose()           bağlantı kapanınca
//   onMessage(buf)      kameradan gelen her UDP paketi
//   exec(cmd, args)     tek seferlik komut  → { ok } | { ok:false, error }
//   hold(cmd, args)     basılı tutulan komut (joystick, yakınlaştırma); args null ise bırakıldı
// Olaylar: 'state' (bağlantı durumu), 'status' (kameranın bildirdiği değerler), 'reply' (metin yanıtı), 'log' (gönderilen/alınan)

const dgram = require('dgram');
const net = require('net');
const { EventEmitter } = require('events');

const LINK_TIMEOUT_MS = 2500; // bu süre veri gelmezse "yanıt yok"
const HOLD_TIMEOUT_MS = 700;  // pencere tazelemezse basılı komut kendiliğinden bırakılır (pencere kapanırsa kamera dönmeye devam etmesin)

// Kendiliğinden yeniden bağlanan TCP bağlantısı (TCP ile yönetilen kameralar için). Olaylar: up, down, data
class TcpLink extends EventEmitter {
  constructor(host, port) { super(); this.host = host; this.port = port; this.sock = null; this.up = false; this.wanted = false; this.timer = null; }

  open() { this.wanted = true; this._dial(); }

  _dial() {
    if (!this.wanted) return;
    const s = net.connect({ host: this.host, port: this.port });
    this.sock = s;
    s.setNoDelay(true);
    s.setKeepAlive(true, 5000);
    s.on('connect', () => { this.up = true; this.emit('up'); });
    s.on('data', (d) => this.emit('data', d));
    s.on('error', () => {});
    s.on('close', () => {
      if (this.sock !== s) return;
      const was = this.up;
      this.up = false;
      if (was) this.emit('down');
      if (this.wanted) this.timer = setTimeout(() => this._dial(), 2000);
    });
  }

  send(buf) { if (!this.up || !this.sock) return false; this.sock.write(buf); return true; }

  close() {
    this.wanted = false;
    clearTimeout(this.timer);
    const s = this.sock;
    this.sock = null;
    this.up = false;
    if (s) s.destroy();
  }
}

class CameraDriver extends EventEmitter {
  constructor(conn, opts = {}) {
    super();
    this.conn = conn;
    this.host = String(conn.camCtrlHost || conn.host || '').trim();
    this.port = Number(conn.camCtrlPort) || opts.port || 0;
    this.localPort = conn.camLocalPort === undefined || conn.camLocalPort === null ? (opts.localPort || 0) : Number(conn.camLocalPort) || 0;
    this.transport = opts.transport === 'tcp' ? 'tcp' : 'udp';
    this.sock = null;
    this.link = null;
    this.connected = false;
    this.error = null;
    this.fallbackPort = false;
    this.tx = 0;
    this.rx = 0;
    this.lastRx = 0;
    this.linked = false;
    this.status = null;
    this._linkTimer = null;
    this._holdAt = 0;
  }

  snapshot() {
    return {
      connected: this.connected, linked: this.linked, error: this.error, remote: `${this.host}:${this.port}`,
      transport: this.transport, local: this.sock && this.connected ? this.sock.address().port : 0, fallbackPort: this.fallbackPort, tx: this.tx, rx: this.rx, status: this.status,
    };
  }

  _emitState() { this.emit('state', this.snapshot()); }

  async connect() {
    if (this.connected) return this.snapshot();
    this.error = null;
    if (!this.host || !this.port) { this.error = 'bad_address'; this._emitState(); return this.snapshot(); }
    if (this.transport === 'tcp') {
      this.link = new TcpLink(this.host, this.port);
      this.link.on('up', () => { this.linked = true; this._emitState(); try { this.onLink(); } catch { /* yok */ } });
      this.link.on('down', () => { this.linked = false; this._emitState(); });
      this.link.on('data', (buf) => { this.rx++; this.lastRx = Date.now(); try { this.onMessage(buf); } catch { /* bozuk veri */ } });
      this.connected = true;
      this._linkTimer = setInterval(() => this._watchHold(), 250);
      this.link.open();
      this.onOpen();
      this._emitState();
      return this.snapshot();
    }
    const family = net.isIPv6(this.host) ? 'udp6' : 'udp4';
    const open = (port) => new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: family, reuseAddr: false });
      s.once('error', (e) => { try { s.close(); } catch { /* kapalı */ } reject(e); });
      s.bind(port, () => { s.removeAllListeners('error'); resolve(s); });
    });
    try {
      try { this.sock = await open(this.localPort); this.fallbackPort = false; }
      catch (e) {
        if (!this.localPort || !['EADDRINUSE', 'EACCES'].includes(e.code)) throw e;
        this.sock = await open(0); // istenen yerel port dolu: rastgele porttan dene
        this.fallbackPort = true;
      }
    } catch (e) {
      this.error = e.code === 'EADDRINUSE' ? 'port_in_use' : 'io';
      this._emitState();
      return this.snapshot();
    }
    this.sock.on('message', (buf) => {
      this.rx++;
      this.lastRx = Date.now();
      if (!this.linked) { this.linked = true; this._emitState(); try { this.onLink(); } catch { /* yok */ } }
      try { this.onMessage(buf); } catch { /* bozuk paket */ }
    });
    this.sock.on('error', () => { /* ICMP "port unreachable" vb.; bağlantı durumu zaman aşımıyla izlenir */ });
    this.connected = true;
    this._linkTimer = setInterval(() => {
      if (this.linked && Date.now() - this.lastRx > LINK_TIMEOUT_MS) { this.linked = false; this._emitState(); }
      this._watchHold();
    }, 250);
    this.onOpen();
    this._emitState();
    return this.snapshot();
  }

  _watchHold() {
    if (this._holdAt && Date.now() - this._holdAt > HOLD_TIMEOUT_MS) { this._holdAt = 0; try { this.releaseAll(); } catch { /* yok */ } }
  }

  disconnect() {
    if (!this.connected) return;
    try { this.onClose(); } catch { /* yok */ }
    clearInterval(this._linkTimer);
    this.connected = false;
    this.linked = false;
    if (this.link) { this.link.close(); this.link.removeAllListeners(); this.link = null; }
    try { if (this.sock) this.sock.close(); } catch { /* kapalı */ }
    this.sock = null;
    this._emitState();
  }

  send(buf) {
    if (!this.connected) return false;
    if (this.transport === 'tcp') { if (!this.link || !this.link.send(buf)) return false; this.tx++; return true; }
    if (!this.sock) return false;
    this.tx++;
    this.sock.send(buf, this.port, this.host, () => {});
    return true;
  }

  touchHold(active) { this._holdAt = active ? Date.now() : 0; }
  log(dir, text) { this.emit('log', { dir, text, at: Date.now() }); }

  /* eslint-disable class-methods-use-this */
  onOpen() {}
  onLink() {}
  onClose() {}
  onMessage() {}
  releaseAll() {}
  exec() { return { ok: false, error: 'unsupported' }; }
  hold() { return { ok: false, error: 'unsupported' }; }
}

const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(Number(v)) ? Number(v) : 0));

module.exports = { CameraDriver, TcpLink, hex, clamp, LINK_TIMEOUT_MS, HOLD_TIMEOUT_MS };
