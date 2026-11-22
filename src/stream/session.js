'use strict';

// Bir bağlantının canlı oturumu: yerel aktarıcılar (yakalama), görüntüleyici ffmpeg (JPEG kareler + PCM ses),
// yeniden bağlanma, takılma denetimi, istatistik geçmişi ve kayıt.
//
// Olaylar: 'state' (anlık durum), 'frame' (JPEG Buffer), 'audio' (s16le 48 kHz stereo Buffer), 'stats' (yarım saniyede bir)

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const SCHEMA = require('../schema');
const A = require('./args');
const { Tap, RtspDemux } = require('./tap');
const { UdpRelay, TcpRelay, freeUdpPort } = require('./relay');
const { LogParser } = require('./probe');

const EOI = Buffer.from([0xff, 0xd9]);
const TICK_MS = 500;
const HISTORY = 720; // 6 dakika

const netCode = (e) => ({ EADDRINUSE: 'port_in_use', EACCES: 'access', EADDRNOTAVAIL: 'bad_address', ENODEV: 'bad_address', EINVAL: 'bad_address', ECONNREFUSED: 'refused', ETIMEDOUT: 'timeout', ENOTFOUND: 'unreachable', EHOSTUNREACH: 'unreachable', ENETUNREACH: 'unreachable', ECONNRESET: 'io' }[e && e.code] || 'error');

function listenOnce(onData) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => { sock.on('data', onData); sock.on('error', () => {}); });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

class StreamSession extends EventEmitter {
  // deps: { getConnection(), ffmpegPath, tmpDir, hwaccels, getInfo(), setInfo(info), recordDir() }
  constructor(id, deps) {
    super();
    this.id = id;
    this.deps = deps;
    this.state = 'idle';
    this.error = null;
    this.profile = 'card';
    this.running = false;
    this.info = null;
    this.tap = null;
    this.history = [];
    this.attempts = 0;
    this.frames = 0;
    this.framesMark = 0;
    this.fps = 0;
    this.viewer = null;
    this.gen = 0;
    this.input = null;
    this.rec = { wanted: false, proc: null, file: null, files: [], startedAt: 0, size: 0, error: null, dir: null };
    this.timer = null;
    this.retryTimer = null;
    this.command = '';
  }

  // --- Durum -------------------------------------------------------------------------------------
  _setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('state', this.snapshot());
  }

  snapshot() {
    return {
      id: this.id, state: this.state, error: this.error, running: this.running, profile: this.profile, attempts: this.attempts,
      since: this.playingSince || 0, info: this.info, layout: this.viewer ? this.viewer.layout : null,
      tapKind: this.input ? this.input.tapKind : null, sdp: this.tap ? this.tap.sdp : '', command: this.command, rec: this.recState(),
    };
  }

  recState() {
    const r = this.rec;
    return { active: r.wanted, file: r.file, files: r.files.slice(), startedAt: r.startedAt, size: r.size, error: r.error, dir: r.dir };
  }

  // --- Başlat / durdur -----------------------------------------------------------------------------
  async start(profile = 'card') {
    if (this.running) return this.setProfile(profile);
    this.running = true;
    this.profile = profile;
    this.attempts = 0;
    this.history = [];
    this.conn = this.deps.getConnection();
    this.info = null;
    if (!this.timer) this.timer = setInterval(() => this._tick(), TICK_MS);
    await this._connect();
  }

  async stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.timer);
    this.timer = null;
    await this.stopRecording();
    await this._killViewer();
    this._closeInput();
    this.playingSince = 0;
    this._setState('idle');
  }

  // Kart önizlemesi ↔ akış penceresi: çözünürlük ve ses değiştiği için görüntüleyici yeniden başlar
  async setProfile(profile) {
    if (profile === this.profile) return;
    this.profile = profile;
    if (this.running && this.viewer) await this._restartViewer();
    else this.emit('state', this.snapshot());
  }

  // Ayarlar değişti: oturumu yeni ayarlarla baştan kur
  async reload() {
    if (!this.running) return;
    const profile = this.profile;
    const recording = this.rec.wanted;
    await this.stop();
    await this.start(profile);
    if (recording) await this.startRecording();
  }

  async _connect() {
    if (!this.running) return;
    const c = this.conn;
    if (!c) { this.running = false; return this._setState('error', { code: 'error', detail: 'connection not found' }); }
    this._setState(this.attempts ? 'reconnecting' : 'connecting', this.attempts ? this.error : null);
    try {
      await this._ensureInput(c);
    } catch (e) {
      return this._failed({ code: e.vmCode || netCode(e), detail: e.message });
    }
    if (!this.running) return;
    await this._spawnViewer();
  }

  _failed(failure) {
    const c = this.conn || {};
    this.playingSince = 0;
    if (this.running && c.reconnect && (!c.reconnectMax || this.attempts < c.reconnectMax)) {
      this.attempts++;
      this._setState('reconnecting', failure);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this._connect(), Math.max(1, c.reconnectDelay || 3) * 1000);
    } else {
      this.running = false;
      this._closeInput();
      this._setState('error', failure);
    }
  }

  // --- Giriş: aktarıcılar ve yakalayıcı -----------------------------------------------------------------
  async _ensureInput(c) {
    if (this.input) return;
    const proto = SCHEMA.PROTOCOLS[c.protocol];
    const datagram = ['udp', 'rtp', 'sdp'].includes(c.protocol);
    const relayCapable = proto.tap === 'wire' && !(c.protocol === 'tcp' && c.tcpListen);
    const useRelay = relayCapable && (datagram || c.capture === 'auto');
    const wantTap = c.capture !== 'off' || datagram;
    this.tap = wantTap ? new Tap({ sizeKB: Number(c.captureBufferKB) || 1024 }) : null;
    const tap = this.tap;
    const input = { kind: 'direct', remux: false, tapKind: null, tcp: null, tcpRec: null, udp: [], sdpText: '', view: {}, rec: null };

    if (!useRelay) {
      input.remux = !!tap;
      input.tapKind = tap ? 'remux' : null;
    } else if (c.protocol === 'rtsp') {
      input.kind = 'tcp';
      input.tapKind = 'wire';
      // RTP TCP içinde gelmiyorsa (UDP / çok noktaya yayın) ortam baytları için ffmpeg kopyası da eklenir
      input.remux = c.rtspTransport !== 'tcp';
      input.tcp = new TcpRelay({
        host: c.host, port: c.port, secure: c.secure, tlsVerify: c.tlsVerify, timeoutMs: c.timeout * 1000,
        onOpen: (conn) => {
          const mk = (dir) => new RtspDemux(
            (ch, payload) => tap.addPacket(payload, { dir, ch, hint: ch % 2 ? 'rtcp' : 'rtp' }),
            (msg) => tap.addMessage(msg, { dir }),
            (raw) => tap.addStream(raw, { dir, ts: false }),
          );
          conn.demux = { in: mk('in'), out: mk('out') };
        },
        onData: (dir, chunk, conn) => { if (conn.demux) conn.demux[dir].feed(chunk); },
        onError: (e) => { this.relayError = { code: netCode(e), detail: e.message }; },
      });
      input.view.tcpPort = await input.tcp.listen();
    } else if (c.protocol === 'tcp') {
      input.kind = 'tcp';
      input.tapKind = 'wire';
      input.tcp = new TcpRelay({
        host: c.host, port: c.port, timeoutMs: c.timeout * 1000,
        onData: (dir, chunk) => tap.addStream(chunk, { dir, ts: dir === 'in' }),
        onError: (e) => { this.relayError = { code: netCode(e), detail: e.message }; },
      });
      input.view.tcpPort = await input.tcp.listen();
    } else if (c.protocol === 'udp') {
      input.kind = 'udp';
      input.tapKind = 'wire';
      const relay = new UdpRelay({ port: c.port, host: c.host, localAddr: c.localAddr, sources: c.sources, bufferKB: c.bufferSize, onPacket: (buf) => tap.addPacket(buf, { hint: 'auto' }) });
      input.udp.push({ relay });
      await relay.start();
      input.view.udpPort = await freeUdpPort();
      relay.addTarget(input.view.udpPort);
    } else { // rtp, sdp
      input.kind = 'sdp';
      input.tapKind = 'wire';
      input.sdpText = c.protocol === 'sdp' ? c.sdpText : (String(c.rtpSdpOverride || '').trim() || A.sdpFromFields(c));
      const medias = A.planSdp(input.sdpText);
      if (!medias.length) throw Object.assign(new Error('SDP: m= satırı yok'), { vmCode: 'bad_sdp' });
      tap.learnSdp(input.sdpText);
      const ports = [];
      this.input = input; // hata olursa _closeInput açılan soketleri kapatabilsin
      for (const m of medias) {
        const relay = new UdpRelay({ port: m.port, host: m.host || c.host, localAddr: c.localAddr, sources: c.sources, bufferKB: c.bufferSize, onPacket: (buf) => tap.addPacket(buf, { hint: 'auto' }) });
        input.udp.push({ relay });
        await relay.start();
        const p = await freeUdpPort({ pair: true });
        relay.addTarget(p);
        ports.push(p);
      }
      fs.mkdirSync(this.deps.tmpDir, { recursive: true });
      input.view.sdpFile = path.join(this.deps.tmpDir, `${this.id}-view.sdp`);
      fs.writeFileSync(input.view.sdpFile, A.rewriteSdp(input.sdpText, ports), 'utf8');
      input.view.ports = ports;
    }
    this.input = input;
  }

  _closeInput() {
    const i = this.input;
    this.input = null;
    if (!i) return;
    if (i.tcp) i.tcp.close();
    if (i.tcpRec) i.tcpRec.close();
    for (const u of i.udp) u.relay.close();
    for (const f of [i.view && i.view.sdpFile, i.rec && i.rec.sdpFile]) if (f) fs.promises.rm(f, { force: true }).catch(() => {});
  }

  // --- Görüntüleyici ffmpeg --------------------------------------------------------------------------
  _layout(c, info) {
    const full = this.profile === 'full';
    if (!info) return { video: c.allowedMedia !== 'audio', audio: false, vi: c.videoStream || 0, ai: 0 };
    const vs = info.streams.filter((s) => s.type === 'video' && s.codec !== 'none' && s.width);
    const as = info.streams.filter((s) => s.type === 'audio' && s.sampleRate);
    return {
      video: vs.length > 0, vi: Math.min(c.videoStream || 0, Math.max(0, vs.length - 1)),
      audio: full && !!c.audioEnabled && as.length > 0, ai: Math.min(c.audioStream || 0, Math.max(0, as.length - 1)),
    };
  }

  async _spawnViewer() {
    const c = this.conn;
    const input = this.input;
    if (!this.running || !input) return;
    const gen = ++this.gen;
    const info = this.info || this.deps.getInfo();
    const layout = this._layout(c, info);
    const v = { gen, layout, proc: null, parser: new LogParser(), servers: [], buf: null, scan: 0, restarting: false, killed: false, spawnAt: Date.now(), gotInfo: false };
    this.viewer = v;
    this.relayError = null;
    const ports = {};
    try {
      if (layout.audio) { const s = await listenOnce((d) => { if (this.gen === gen) { this.lastActivity = Date.now(); if (!layout.video) this._playing(); this.emit('audio', d); } }); v.servers.push(s); ports.audio = s.address().port; }
      if (input.remux && this.tap) { const tap = this.tap; const s = await listenOnce((d) => tap.addStream(d, { ts: true })); v.servers.push(s); ports.remux = s.address().port; }
    } catch (e) {
      return this._failed({ code: netCode(e), detail: e.message });
    }
    if (this.gen !== gen || !this.running) { for (const s of v.servers) s.close(); return; }

    const args = ['-hide_banner', '-loglevel', 'info', '-stats', '-stats_period', '1',
      ...A.inputArgs(c, input.view, { hwaccels: this.deps.hwaccels }),
      ...A.viewOutputs(c, this.profile, layout, ports)];
    this.command = 'ffmpeg ' + A.redact(args).join(' ');
    let proc;
    try {
      proc = spawn(this.deps.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return this._failed({ code: 'ffmpeg_missing', detail: e.message });
    }
    v.proc = proc;
    proc.stdin.on('error', () => {});
    proc.on('error', (e) => { if (this.gen === gen) { v.spawnError = e; } });
    let rest = '';
    proc.stderr.on('data', (d) => {
      const lines = (rest + d.toString('utf8')).split(/\r|\n/);
      rest = lines.pop();
      for (const l of lines) v.parser.line(l);
      if (!v.gotInfo && v.parser.info && v.parser.info.complete && this.gen === gen) { v.gotInfo = true; this._onInfo(v.parser.info); }
    });
    proc.stdout.on('data', (d) => { if (this.gen === gen) this._onVideo(v, d); });
    proc.on('close', (code) => {
      for (const s of v.servers) { try { s.close(); } catch { /* kapalı */ } }
      if (v.onExit) v.onExit();
      if (this.gen !== gen) return;
      this.viewer = null;
      if (v.restarting) return void this._spawnViewer();
      if (v.killed && !v.failure) return;
      if (!this.running) return;
      let failure = v.failure || (v.spawnError ? { code: 'ffmpeg_missing', detail: v.spawnError.message } : v.parser.failure());
      if (this.relayError && ['ffmpeg', 'io', 'bad_data', 'timeout'].includes(failure.code)) failure = this.relayError;
      if (code === 0 && failure.code === 'ffmpeg') failure = { code: 'ended', detail: '' };
      this._failed(failure);
    });
    this.emit('state', this.snapshot());
  }

  _onInfo(info) {
    const c = this.conn;
    this.info = info;
    this.deps.setInfo(info);
    const v = this.viewer;
    const want = this._layout(c, info);
    if (v && (want.video !== v.layout.video || want.audio !== v.layout.audio || (want.video && want.vi !== v.layout.vi) || (want.audio && want.ai !== v.layout.ai))) {
      v.restarting = true; // akışın gerçek yapısına göre çıktıları yeniden kur
      this._kill(v);
    }
    this.emit('state', this.snapshot());
  }

  _playing() {
    if (this.state === 'playing') return;
    this.attempts = 0;
    this.playingSince = Date.now();
    this._setState('playing');
  }

  _onVideo(v, chunk) {
    v.buf = v.buf && v.buf.length ? Buffer.concat([v.buf, chunk]) : chunk;
    for (;;) {
      if (v.buf.length >= 2 && !(v.buf[0] === 0xff && v.buf[1] === 0xd8)) {
        const soi = v.buf.indexOf(Buffer.from([0xff, 0xd8]));
        if (soi < 0) { v.buf = null; v.scan = 0; return; }
        v.buf = v.buf.subarray(soi); v.scan = 0;
      }
      const end = v.buf.indexOf(EOI, v.scan);
      if (end < 0) { v.scan = Math.max(0, v.buf.length - 1); return; }
      const frame = Buffer.from(v.buf.subarray(0, end + 2));
      v.buf = v.buf.subarray(end + 2);
      v.scan = 0;
      this.frames++;
      this.lastActivity = Date.now();
      this._playing();
      this.emit('frame', frame);
      if (!v.buf.length) { v.buf = null; return; }
    }
  }

  _kill(v) {
    if (!v || !v.proc || v.killed) return;
    v.killed = true;
    try { v.proc.kill('SIGKILL'); } catch { /* bitmiş */ }
  }

  _killViewer() {
    const v = this.viewer;
    this.gen++;
    this.viewer = null;
    if (!v || !v.proc || v.proc.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => { v.onExit = resolve; this._kill(v); setTimeout(resolve, 3000); });
  }

  async _restartViewer() {
    await this._killViewer();
    if (!this.running) return;
    clearTimeout(this.retryTimer);
    if (this.state !== 'playing') this._setState('connecting');
    await this._spawnViewer();
  }

  // --- Yarım saniyelik vuruş: istatistik, takılma denetimi ------------------------------------------------
  _tick() {
    const now = Date.now();
    const c = this.conn || {};
    this.fps = Math.round(((this.frames - this.framesMark) * 1000) / TICK_MS);
    this.framesMark = this.frames;
    this.fpsAvg = this.fpsAvg ? this.fpsAvg * 0.7 + this.fps * 0.3 : this.fps;
    const s = this.tap ? this.tap.sample(now) : { bps: 0, bpsOut: 0, pps: 0 };
    const point = { t: now, bps: s.bps, pps: s.pps, fps: Math.round(this.fpsAvg * 10) / 10 };
    this.history.push(point);
    if (this.history.length > HISTORY) this.history.shift();

    const v = this.viewer;
    if (v && !v.killed && this.running) {
      const stall = (c.stallTimeout || 0) * 1000;
      const listener = ['udp', 'rtp', 'sdp'].includes(c.protocol) || (c.protocol === 'tcp' && c.tcpListen) || (c.protocol === 'srt' && c.srtMode !== 'caller');
      if (this.state === 'playing' && stall && now - (this.lastActivity || now) > stall) {
        v.failure = { code: 'stalled', detail: '' };
        this._kill(v);
      } else if (this.state !== 'playing' && !listener && now - v.spawnAt > ((c.timeout || 10) + 20) * 1000) {
        v.failure = { code: 'timeout', detail: '' };
        this._kill(v);
      }
    }
    if (this.rec.wanted && this.rec.file && !/%/.test(this.rec.file) && (this.tickN = (this.tickN || 0) + 1) % 2 === 0) {
      fs.promises.stat(this.rec.file).then((st) => { this.rec.size = st.size; }).catch(() => {});
    }
    this.emit('stats', {
      id: this.id, state: this.state, point, frames: this.frames, ff: v ? v.parser.stats : {}, tap: this.tap ? { ...this.tap.stats(), sdp: undefined } : null,
      rec: this.rec.wanted ? this.recState() : null, since: this.playingSince || 0,
    });
  }

  // --- Kayıt: kaynağa ikinci bir bağlantıyla, yeniden kodlamadan dosyaya yazar ---------------------------
  async startRecording() {
    if (this.rec.wanted) return this.recState();
    if (!this.running) await this.start(this.profile);
    this.rec = { wanted: true, proc: null, file: null, files: [], startedAt: Date.now(), size: 0, error: null, dir: null };
    await this._spawnRecorder();
    return this.recState();
  }

  async _recEndpoint() {
    const i = this.input;
    const c = this.conn;
    if (!i || i.kind === 'direct') return {};
    if (i.rec) return i.rec;
    const ep = {};
    if (i.kind === 'tcp') {
      i.tcpRec = new TcpRelay({ host: c.host, port: c.port, secure: c.secure, tlsVerify: c.tlsVerify, timeoutMs: c.timeout * 1000 });
      ep.tcpPort = await i.tcpRec.listen();
    } else if (i.kind === 'udp') {
      ep.udpPort = await freeUdpPort();
      i.udp[0].relay.addTarget(ep.udpPort);
    } else {
      const ports = [];
      for (const u of i.udp) { const p = await freeUdpPort({ pair: true }); u.relay.addTarget(p); ports.push(p); }
      ep.sdpFile = path.join(this.deps.tmpDir, `${this.id}-rec.sdp`);
      fs.writeFileSync(ep.sdpFile, A.rewriteSdp(i.sdpText, ports), 'utf8');
    }
    i.rec = ep;
    return ep;
  }

  async _spawnRecorder() {
    const r = this.rec;
    const c = this.conn;
    if (!r.wanted || !c) return;
    try {
      if (!this.input) await this._ensureInput(c);
      const ep = await this._recEndpoint();
      const dir = this.deps.recordDir(c);
      fs.mkdirSync(dir, { recursive: true });
      r.dir = dir;
      const ext = A.MUXER[c.recFormat] ? c.recFormat : 'mp4';
      let base = A.recordName(c);
      if (c.recSegmentMin > 0) base += '_%Y%m%d-%H%M%S';
      else { let n = 1; const b0 = base; while (fs.existsSync(path.join(dir, `${base}.${ext}`))) base = `${b0}_${++n}`; }
      const file = path.join(dir, `${base}.${ext}`);
      const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-stats_period', '1',
        ...A.inputArgs(c, ep, { record: true }), ...A.recordOutputs(c, this.info || this.deps.getInfo(), file)];
      const proc = spawn(this.deps.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      const parser = new LogParser();
      r.proc = proc; r.file = file; r.files.push(file); r.error = null;
      proc.stdin.on('error', () => {});
      let rest = '';
      proc.stderr.on('data', (d) => {
        const lines = (rest + d.toString('utf8')).split(/\r|\n/);
        rest = lines.pop();
        for (const l of lines) parser.line(l);
      });
      proc.on('error', (e) => { r.error = { code: 'ffmpeg_missing', detail: e.message }; });
      proc.on('close', () => {
        if (r.proc === proc) r.proc = null;
        if (r.onExit) r.onExit();
        if (this.rec !== r || !r.wanted) return;
        // kaynak koptu: açık kalan dosya korunur, kayıt yeni dosyayla sürdürülür
        r.error = r.error || parser.failure();
        this.emit('state', this.snapshot());
        clearTimeout(r.retry);
        r.retry = setTimeout(() => this._spawnRecorder(), Math.max(1, c.reconnectDelay || 3) * 1000);
      });
      this.emit('state', this.snapshot());
    } catch (e) {
      r.error = { code: e.vmCode || netCode(e), detail: e.message };
      r.wanted = false;
      this.emit('state', this.snapshot());
    }
  }

  // Kaydı düzgün kapatır (dosya sonlandırılır). Dönen: { files, dir }
  async stopRecording() {
    const r = this.rec;
    if (!r.wanted && !r.proc) return this.recState();
    r.wanted = false;
    clearTimeout(r.retry);
    const proc = r.proc;
    if (proc && proc.exitCode === null) {
      await new Promise((resolve) => {
        r.onExit = resolve;
        try { proc.stdin.write('q\n'); proc.stdin.end(); } catch { /* kapalı */ }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* bitmiş */ } }, 8000);
        setTimeout(resolve, 9000);
      });
    }
    try { if (r.file && !/%/.test(r.file)) r.size = fs.statSync(r.file).size; } catch { /* dosya oluşmadı */ }
    // hiç veri yazılamadan biten boş dosyaları listeden çıkar
    r.files = r.files.filter((f) => { if (/%/.test(f)) return true; try { const st = fs.statSync(f); if (st.size > 0) return true; fs.rmSync(f, { force: true }); } catch { /* yok */ } return false; });
    const i = this.input;
    if (i && i.rec) {
      if (i.rec.udpPort) i.udp[0].relay.removeTarget(i.rec.udpPort);
      if (i.rec.sdpFile) fs.promises.rm(i.rec.sdpFile, { force: true }).catch(() => {});
      if (i.tcpRec) { i.tcpRec.close(); i.tcpRec = null; }
      if (i.kind === 'sdp') for (const u of i.udp) u.relay.targets = new Set([...u.relay.targets].filter((p) => (i.view.ports || []).includes(p)));
      i.rec = null;
    }
    this.emit('state', this.snapshot());
    return this.recState();
  }
}

module.exports = { StreamSession };
