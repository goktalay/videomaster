'use strict';

// Yerel aktarıcılar: ağdaki gerçek baytları görebilmek için ffmpeg ile kaynak arasına girer.
//  - UdpRelay: UDP / RTP datagramlarını (tek noktaya ya da çok noktaya yayın) alır, yakalayıcıya verir ve
//    127.0.0.1 üzerindeki tüketicilere (görüntüleyici ve kaydedici ffmpeg) çoğaltır.
//  - TcpRelay: 127.0.0.1'de dinler, her yerel bağlantı için kaynağa (düz ya da TLS) bağlanır ve iki yönü de aktarır.

const dgram = require('dgram');
const net = require('net');
const tls = require('tls');

const isV6 = (h) => String(h || '').includes(':');
const isMulticast = (h) => {
  const m = /^(\d+)\./.exec(String(h || ''));
  return m ? Number(m[1]) >= 224 && Number(m[1]) <= 239 : /^ff[0-9a-f]{2}:/i.test(String(h || ''));
};

// ffmpeg'in dinleyeceği boş UDP portu; pair: RTP için çift numaralı port ve bir üstü (RTCP) birlikte boş olmalı.
//
// Port, işletim sisteminin kendiliğinden dağıttığı aralığın (Windows 49152–65535, Linux 32768–60999) DIŞINDAN
// seçilir. "0'a bağlan, portu öğren, kapat" yöntemi Windows'ta güvenilmezdir: serbest kalan port, porta kendiliğinden
// bağlanan bir sonraki sokete (bu uygulamanın kendi soketleri dahil) hemen verilir ve ffmpeg "bind failed (10048)"
// ile açılamaz. Yoklama ffmpeg gibi tüm adreslerde yapılır; verilen portlar bir süre ayrılmış sayılır.
const PORT_MIN = 20000;
const PORT_MAX = 31998;
const reserved = new Set();
function freeUdpPort({ pair = false } = {}) {
  const probe = (port) => new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => { try { sock.close(); } catch { /* kapalı */ } resolve(false); });
    sock.bind({ port, exclusive: true }, () => sock.close(() => resolve(true)));
  });
  const take = (...ports) => {
    for (const p of ports) { reserved.add(p); const t = setTimeout(() => reserved.delete(p), 120000); if (t.unref) t.unref(); }
  };
  return (async () => {
    for (let i = 0; i < 300; i++) {
      const port = PORT_MIN + 2 * Math.floor(Math.random() * ((PORT_MAX - PORT_MIN) / 2 + 1));
      if (reserved.has(port) || reserved.has(port + 1)) continue;
      take(port, port + 1); // yoklama sürerken eşzamanlı çağrılar aynı portu almasın
      if ((await probe(port)) && (!pair || (await probe(port + 1)))) return port;
    }
    throw Object.assign(new Error('boş UDP portu bulunamadı'), { code: 'EADDRINUSE' });
  })();
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

class UdpRelay {
  // opts: { port, host (çok noktaya yayın grubu ya da yerel adres), localAddr, sources, bufferKB, onPacket(buf, rinfo) }
  constructor(opts) {
    this.opts = opts;
    this.targets = new Set();
    this.sock = null;
    this.out = null;
    this.closed = false;
  }

  start() {
    const { port, host, localAddr, sources, bufferKB } = this.opts;
    const v6 = isV6(host) || isV6(localAddr);
    const multi = isMulticast(host);
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: v6 ? 'udp6' : 'udp4', reuseAddr: true });
      this.sock = sock;
      // Gönderim soketi hemen bir porta bağlanır. İlk pakete bırakılırsa işletim sistemi ona, az önce yoklanıp
      // ffmpeg için ayrılan portu verebilir (Windows serbest kalan portu hemen yeniden dağıtır) ve ffmpeg bağlanamaz.
      this.out = dgram.createSocket('udp4');
      this.out.on('error', () => {});
      const outReady = new Promise((ok) => { this.out.once('listening', ok); this.out.once('error', ok); });
      this.out.bind({ port: 0, address: '127.0.0.1', exclusive: true });
      let bound = false;
      sock.on('error', (e) => {
        if (!bound) { this.close(); reject(e); } else if (this.opts.onError) this.opts.onError(e);
      });
      sock.on('message', (msg, rinfo) => {
        if (this.opts.onPacket) this.opts.onPacket(msg, rinfo);
        for (const p of this.targets) this.out.send(msg, p, '127.0.0.1');
      });
      // Çok noktaya yayında grup adresine bağlanmak Windows'ta çalışmaz: her zaman "tüm adresler"e bağlan
      const bindAddr = !multi && host && !/^(0\.0\.0\.0|::|@)$/.test(host) ? host : undefined;
      const onBound = () => {
        bound = true;
        try { sock.setRecvBufferSize((bufferKB > 0 ? bufferKB : 2048) * 1024); } catch { /* işletim sistemi sınırı */ }
        if (multi) {
          try {
            const list = String(sources || '').split(/[,\s]+/).filter(Boolean);
            if (list.length) for (const s of list) sock.addSourceSpecificMembership(s, host, localAddr || undefined);
            else sock.addMembership(host, localAddr || undefined);
          } catch (e) { this.close(); return reject(e); }
        }
        const port = sock.address().port;
        outReady.then(() => resolve(port));
      };
      let fellBack = false;
      sock.removeAllListeners('error');
      sock.on('error', (e) => {
        if (bound) { if (this.opts.onError) this.opts.onError(e); return; }
        // verilen adres bu bilgisayara ait değilse (gönderenin adresi yazılmış olabilir) tüm adreslerde dinle
        if (bindAddr && !fellBack && e.code === 'EADDRNOTAVAIL') { fellBack = true; sock.bind({ port, exclusive: false }, onBound); return; }
        this.close();
        reject(e);
      });
      sock.bind({ port, address: bindAddr, exclusive: false }, onBound);
    });
  }

  addTarget(port) { this.targets.add(port); }
  removeTarget(port) { this.targets.delete(port); }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const s of [this.sock, this.out]) { try { if (s) s.close(); } catch { /* zaten kapalı */ } }
  }
}

class TcpRelay {
  // opts: { host, port, secure, tlsVerify, timeoutMs, onData(dir, chunk, conn), onOpen(conn), onClose(conn), onError(err) }
  constructor(opts) {
    this.opts = opts;
    this.server = null;
    this.conns = new Set();
    this.seq = 0;
  }

  listen() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((client) => this._accept(client));
      this.server = server;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { this.port = server.address().port; resolve(this.port); });
    });
  }

  _accept(client) {
    const o = this.opts;
    const conn = { id: ++this.seq, client, upstream: null };
    this.conns.add(conn);
    client.setNoDelay(true);
    client.pause();
    const connectOpts = { host: o.host, port: o.port };
    const upstream = o.secure
      ? tls.connect({ ...connectOpts, servername: net.isIP(o.host) ? undefined : o.host, rejectUnauthorized: !!o.tlsVerify })
      : net.connect(connectOpts);
    conn.upstream = upstream;
    upstream.setNoDelay(true);
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.conns.delete(conn);
      client.destroy();
      upstream.destroy();
      if (err && o.onError) o.onError(err);
      if (o.onClose) o.onClose(conn);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), o.timeoutMs || 10000);
    upstream.once(o.secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      if (o.onOpen) o.onOpen(conn);
      client.resume();
    });
    upstream.on('data', (chunk) => {
      if (o.onData) o.onData('in', chunk, conn);
      if (!client.write(chunk)) { upstream.pause(); client.once('drain', () => upstream.resume()); }
    });
    client.on('data', (chunk) => {
      if (o.onData) o.onData('out', chunk, conn);
      if (!upstream.write(chunk)) { client.pause(); upstream.once('drain', () => client.resume()); }
    });
    upstream.on('error', (e) => finish(e));
    client.on('error', () => finish());
    upstream.on('close', () => finish());
    client.on('close', () => finish());
  }

  close() {
    for (const c of this.conns) { c.client.destroy(); if (c.upstream) c.upstream.destroy(); }
    this.conns.clear();
    if (this.server) { try { this.server.close(); } catch { /* kapalı */ } this.server = null; }
  }
}

module.exports = { UdpRelay, TcpRelay, freeUdpPort, freeTcpPort, isMulticast };
