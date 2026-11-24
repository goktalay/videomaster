'use strict';

// Betaflight araç oturumu (ana süreç). MSP ile telemetri/komut, CLI (komut satırı) ile adlandırılmış ayarlar.
// Dışa dönük yüzü MavVehicle (vehicle.js) ile aynıdır; aynı dron penceresi ikisiyle de çalışır.
//
//   const v = new BfVehicle({ type: 'serial', serialPort: 'COM5', baud: 115200 }, { streamRate: 4 });
//   await v.connect();            → { ok } | { ok:false, error }
//   v.snapshot();                 → durum özeti (düz nesne)
//
// Olaylar:
//   'state'(snapshot)             en çok 5 Hz
//   'log'([{ t, dir, sysid: 0, compid: 0, id, name, text }])   gelen/giden MSP iletileri ve CLI satırları (name: 'CLI'), en çok 10 Hz toplu
//   'statustext'({ severity, severityName, text, t })    kurma engelleri değişince (4), hatalar (3), kaydetme/yeniden başlatma (6)
//   'params'({ total, received, loading, done })         ayar listesi indirme ilerlemesi
//   'param'({ name, value, type, index })                setParam / CLI "set" ile değişen ayar
//   'calibration'({ kind, state, percent, text })
//   'cli'({ text })               CLI çıktısı (ham parçalar, sırasıyla; komutun yankısı ve "# " istemi ayıklanmış)
//   'error'(err)                  bağlantı hataları (err.code)
// Söz (Promise) dönen bütün işlevler reddetmez; { ok:false, error } ile çözülür.
//
// Betaflight'ta adlandırılmış ayarlara MSP ile erişilemez (4.3–4.5 / 2025.12); bu yüzden ayarlar CLI üzerinden okunur ve yazılır.
// CLI kipindeyken kart MSP'ye yanıt vermez: telemetri yoklaması durur ve snapshot().cliMode true olur.
// CLI'ye bir kez girildiğinde kart, yeniden başlatılana dek kurulamaz (ARMING_DISABLED_CLI; "exit noreboot" ile de kalkmaz).

const { EventEmitter } = require('events');
const { createLink } = require('./link');
const { MSP, mspName, encode, MspParser } = require('./msp');
const BF = require('./bfdata');

const SEVERITY_NAMES = ['EMERGENCY', 'ALERT', 'CRITICAL', 'ERROR', 'WARNING', 'NOTICE', 'INFO', 'DEBUG'];
const PROMPT_RE = /(^|\n)# $/;
// "save", "exit", "defaults", "bl" … yeniden başlatır; "exit noreboot" yalnızca CLI'den çıkar
const REBOOT_RE = /Rebooting/;
const LEFT_RE = /leaving CLI mode, no reboot/;
const CLI_END_RE = /Rebooting|leaving CLI mode, no reboot/;
const NAME_RE = /^[A-Za-z0-9_]+$/;

const round = (v, d) => { const k = 10 ** d; return Math.round(v * k) / k; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function emptyTelemetry() {
  return {
    roll: null, pitch: null, yaw: null, rollRate: null, pitchRate: null, yawRate: null,
    lat: null, lon: null, altMsl: null, altRel: null, vx: null, vy: null, vz: null,
    groundspeed: null, airspeed: null, climb: null, heading: null, throttle: null,
    voltage: null, current: null, batteryPct: null, mahDrawn: null, cells: null,
    gpsFix: null, gpsFixName: null, sats: null, hdop: null, rssi: null,
    rc: [], servo: [], homeLat: null, homeLon: null, homeAlt: null, homeDist: null, homeDir: null,
    wpDist: null, navBearing: null, load: null, vibration: null, ekfOk: null, time: null,
  };
}

// Sınır denetimli küçük-sonlu okuyucu: veri biterse 0 döner (eski sürümler daha kısa yanıt verir)
class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  get left() { return this.b.length - this.o; }
  u8() { const v = this.left >= 1 ? this.b[this.o] : 0; this.o += 1; return v; }
  u16() { const v = this.left >= 2 ? this.b.readUInt16LE(this.o) : 0; this.o += 2; return v; }
  i16() { const v = this.left >= 2 ? this.b.readInt16LE(this.o) : 0; this.o += 2; return v; }
  u32() { const v = this.left >= 4 ? this.b.readUInt32LE(this.o) : 0; this.o += 4; return v; }
  i32() { const v = this.left >= 4 ? this.b.readInt32LE(this.o) : 0; this.o += 4; return v; }
  bytes(n) { const v = this.b.subarray(Math.min(this.o, this.b.length), Math.min(this.o + n, this.b.length)); this.o += n; return v; }
  str(n) { return this.bytes(n).toString('latin1').replace(/\0+$/, ''); }
  pstr() { return this.str(this.u8()); } // uzunluk öneki olan metin
}

function fmtValue(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(round(v, 3));
  if (typeof v === 'string') return /[\s=]/.test(v) || v === '' ? JSON.stringify(v) : v;
  if (Array.isArray(v)) return '[' + (v.length > 20 ? v.slice(0, 20).map(fmtValue).join(',') + ',…' : v.map(fmtValue).join(',')) + ']';
  if (Buffer.isBuffer(v)) return '0x' + v.toString('hex');
  return String(v);
}

function fmtFields(fields) {
  const parts = [];
  for (const k of Object.keys(fields)) parts.push(`${k}=${fmtValue(fields[k])}`);
  return parts.join(' ');
}

// ---- CLI çıktısı çözümleme -------------------------------------------------------------------------
// "get" çıktısı (cli.c cliGet; 4.3 – 2025.x aynı biçim), her ayar için:
//     ad = değer
//     [profile N | rateprofile N | batteryprofile N]
//     Allowed range: A - B | Allowed values: X, Y, … | Array length: N | String length: A - B
//     [Default value: D]            (yalnızca değer varsayılandan farklıysa)
//     (boş satır)
function parseGetOutput(text) {
  const list = [];
  let cur = null;
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  for (const line of lines) {
    let m;
    if (cur && (m = /^(profile|rateprofile|batteryprofile) (\d+)$/.exec(line))) { cur.scope = m[1]; cur.profile = Number(m[2]); continue; }
    if (cur && (m = /^Allowed range: (-?\d+) - (-?\d+)$/.exec(line))) { cur.type = 'number'; cur.range = [Number(m[1]), Number(m[2])]; continue; }
    if (cur && (m = /^Allowed values: (.*)$/.exec(line))) { cur.type = 'enum'; cur.values = m[1].split(',').map((s) => s.trim()).filter(Boolean); continue; }
    if (cur && (m = /^Array length: (\d+)$/.exec(line))) { cur.type = 'array'; cur.length = Number(m[1]); continue; }
    if (cur && (m = /^String length: (\d+) - (\d+)$/.exec(line))) { cur.type = 'text'; cur.minLength = Number(m[1]); cur.maxLength = Number(m[2]); continue; }
    if (cur && (m = /^Default value: (.*)$/.exec(line))) { cur.defRaw = m[1]; continue; }
    if ((m = /^([A-Za-z0-9_]+) = (.*)$/.exec(line))) {
      cur = { name: m[1], raw: m[2], type: null, index: list.length, range: null, values: null, defRaw: null, scope: 'master', profile: null };
      list.push(cur);
    }
  }
  return list.filter((p) => p.type).map((p, i) => finishParam(p, i));
}

// "dump all" yedeği: yalnızca "set ad = değer" satırları (aralık/seçenek bilgisi yoktur; tür değerden kestirilir)
function parseDumpOutput(text) {
  const byName = new Map();
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let scope = 'master';
  let profile = null;
  for (const line of lines) {
    let m;
    if ((m = /^(profile|rateprofile|batteryprofile) (\d+)$/.exec(line))) { scope = m[1]; profile = Number(m[2]); continue; }
    if (!(m = /^set ([A-Za-z0-9_]+) = (.*)$/.exec(line))) continue;
    if (byName.has(m[1])) continue; // profilli ayarlar her profil için yinelenir: ilk görülen (profil 0) alınır
    const raw = m[2];
    const type = /^-?\d+$/.test(raw) ? 'number' : /^-?\d+(,-?\d+)+$/.test(raw) ? 'array' : (raw === 'ON' || raw === 'OFF') ? 'enum' : 'text';
    byName.set(m[1], { name: m[1], raw, type, range: null, values: type === 'enum' ? ['OFF', 'ON'] : null, defRaw: null, scope, profile, guessed: true });
  }
  return [...byName.values()].map((p, i) => finishParam(p, i));
}

function typedValue(type, raw) {
  if (type === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : raw; }
  if (type === 'text') return raw === '-' ? '' : raw; // boş metin "-" olarak yazılır
  return raw;
}

function finishParam(p, index) {
  const out = { name: p.name, value: typedValue(p.type, p.raw), type: p.type, index, range: p.range, values: p.values, def: typedValue(p.type, p.defRaw === null ? p.raw : p.defRaw), scope: p.scope, profile: p.profile };
  if (p.type === 'array') out.length = p.length !== undefined ? p.length : String(p.raw).split(',').length;
  if (p.type === 'text') { out.minLength = p.minLength || 0; out.maxLength = p.maxLength || null; }
  if (p.guessed) out.guessed = true;
  return out;
}

// Komutun yankısını ve sondaki istemi ayıklar
function cleanCliOutput(raw, line) {
  let text = String(raw || '').replace(/\r/g, '');
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  if (first.trim() === line.trim()) text = nl < 0 ? '' : text.slice(nl + 1);
  text = text.replace(/\n# $/, '').replace(/^# $/, '');
  return text.replace(/\n+$/, '');
}

function describeCfg(cfg) {
  try { return createLink(cfg).describe(); } catch { return ''; }
}

class BfVehicle extends EventEmitter {
  constructor(linkCfg, opts = {}) {
    super();
    this.linkCfg = { ...(linkCfg || {}) };
    this.opts = opts || {};
    this.streamRate = clamp(Number(this.opts.streamRate) || 4, 1, 50);
    this.linkTimeoutMs = Number(this.opts.linkTimeoutMs) || 3500;
    this.replyTimeoutMs = Number(this.opts.replyTimeoutMs) || 500;
    this.rebootWaitMs = Number(this.opts.rebootWaitMs) || 15000;   // yeniden başlatma sonrası bağlantının dönmesi için süre
    this.rebootSettleMs = this.opts.rebootSettleMs === undefined ? 400 : Number(this.opts.rebootSettleMs);
    this.cliSettleMs = Number(this.opts.cliSettleMs) || 80;        // "# " isteminden sonra bu kadar sessizlik = komut bitti
    this.accCalMs = Number(this.opts.accCalMs) || 2000;            // yapılandırıcıdaki bekleme (400 örnek, < 1 sn sürer)
    this.magCalMs = Number(this.opts.magCalMs) || 30000;           // compass.c CALIBRATION_TIME_US = 30 sn

    this.link = null;
    this.parser = new MspParser({ onText: (s) => this._onText(s) });
    this.timers = new Set();
    this._sleepers = new Set();
    this.on('error', () => {}); // dinleyici yoksa süreç düşmesin
    this._reset();
  }

  _reset() {
    this.connected = false;
    this.linked = false;
    this.error = null;
    this.firmware = 'betaflight';
    this.vehicle = 'copter';
    this.variant = null;        // 'BTFL'
    this.apiVersion = null;     // '1.46'
    this.apiMinor = null;
    this.version = null;        // '4.5.1'
    this.board = null;          // hedef/kart adı
    this.boardInfo = null;
    this.buildInfo = null;
    this.craftName = null;
    this.uid = null;
    this.armed = false;
    this.mode = null;
    this.boxes = [];            // etkin kutu adları
    this.boxIds = null;         // MSP_BOXIDS: bit sırası → kalıcı kimlik
    this.boxNames = null;       // MSP_BOXNAMES (kullanıcı adları dahil)
    this.features = 0;
    this.mixerMode = null;
    this.yawReversed = false;
    this.motorCfg = null;       // { minThrottle, maxThrottle, minCommand, motorCount, … }
    this.motorProtocol = null;
    this.motor3d = null;
    this.batteryCfg = null;
    this.sensorBits = null;
    this.armingFlags = null;
    this.armingFlagCount = 0;
    this.armingDisabled = [];
    this.rebootRequired = false;
    this.cliMode = false;
    this.unsaved = 0;
    this.rebooting = false;
    this.telemetry = emptyTelemetry();
    this.params = new Map();
    this.paramTotal = 0;
    this.paramLoading = false;
    this._paramRx = 0;
    this.frame = null;
    this.stats = { rxBytes: 0, txBytes: 0, rxMsgs: 0, txMsgs: 0, lost: 0, msgRate: 0, byteRate: 0, timeouts: 0 };
    this._rate = { msgs: 0, bytes: 0, at: Date.now() };
    this._lastRx = 0;
    this._epoch = (this._epoch || 0) + 1; // eski oturumdan kalan döngüler kendini bıraksın
    this._identified = false;
    this._identLoop = false;
    this._queue = [];           // bekleyen MSP istekleri (kullanıcı komutları ve kimlik sorguları)
    this._inflight = null;
    this._mspPaused = false;    // CLI'ye girilirken / CLI kipinde
    this._idleWaiters = [];
    this._polls = null;
    this._pollTimer = null;
    this._collector = null;     // CLI çıktısını toplayan
    this._cliChain = Promise.resolve();
    this._stray = '';           // MSP kipindeyken gelen MSP dışı metin (CLI kipini sezmek için)
    this._reboot = null;        // yeniden başlatma bekleyişi (Promise)
    this._fetch = null;
    this._cal = null;
    this._motor = null;         // { timer, armingBlocked }
    this._logQueue = [];
    this._logTimer = null;
    this._stateTimer = null;
    this._lastState = 0;
    this._homeFromArm = false;
  }

  // ---- Zamanlayıcı yardımcıları: disconnect() hepsini temizler ----
  _later(fn, ms) {
    const h = setTimeout(() => { this.timers.delete(h); try { fn(); } catch (err) { this._fail(err); } }, ms);
    this.timers.add(h);
    return h;
  }

  _every(fn, ms) {
    const h = setInterval(() => { try { fn(); } catch (err) { this._fail(err); } }, ms);
    this.timers.add(h);
    return h;
  }

  _cancel(h) {
    if (!h) return;
    clearTimeout(h);
    clearInterval(h);
    this.timers.delete(h);
  }

  // Bekleme; disconnect() bekleyenleri hemen uyandırır (asılı söz kalmasın)
  _sleep(ms) {
    return new Promise((resolve) => {
      const s = { resolve, timer: null };
      s.timer = setTimeout(() => { this._sleepers.delete(s); resolve(); }, ms);
      this._sleepers.add(s);
    });
  }

  _clearTimers() {
    for (const h of this.timers) { clearTimeout(h); clearInterval(h); }
    this.timers.clear();
    for (const s of this._sleepers) { clearTimeout(s.timer); s.resolve(); }
    this._sleepers.clear();
    this._logTimer = null;
    this._stateTimer = null;
    this._pollTimer = null;
  }

  _fail(err) { try { this.emit('error', err); } catch { /* yok */ } }

  _emit(name, payload) { try { this.emit(name, payload); } catch { /* dinleyici hatası oturumu bozmasın */ } }

  get ready() { return !!(this.link && this.link.isOpen); }

  // ---- Bağlantı ----
  async connect() {
    if (this.link) return { ok: true };
    let link;
    try { link = createLink(this.linkCfg); } catch (err) {
      this.error = err.code || 'unsupported';
      this._touch(true);
      return { ok: false, error: this.error };
    }
    this._reset();
    this.parser.reset();
    this.parser.textMode = false;
    this.link = link;
    link.on('data', (d) => { try { this._onData(d); } catch (err) { this._fail(err); } });
    link.on('error', (err) => {
      if (this.link !== link) return;
      this.error = (err && err.code) || 'io';
      this._fail(err);
      this._touch();
    });
    link.on('open', () => { if (this.link === link) { try { this._onLinkOpen(); } catch (err) { this._fail(err); } } });
    link.on('close', () => { if (this.link === link) { try { this._onLinkClose(link); } catch (err) { this._fail(err); } } });
    try {
      await link.open();
    } catch (err) {
      if (this.link === link) this.link = null;
      try { link.close(); } catch { /* yok */ }
      this.error = (err && err.code) || 'io';
      this._touch(true);
      return { ok: false, error: this.error };
    }
    if (this.link !== link) return { ok: false, error: 'disconnected' }; // açılırken disconnect() çağrıldı
    this.connected = true;
    this.error = null;
    this._tick = this._every(() => this._onTick(), 500);
    this._touch(true);
    this._identifyLoop();
    return { ok: true };
  }

  disconnect() {
    const link = this.link;
    // Elden gelen son temizlik: çalışan motor testini durdur, kurma engelimizi kaldır, CLI'den yeniden başlatmadan çık
    if (link && link.isOpen) {
      try {
        if (this.cliMode) {
          if (this._supportsNoReboot()) link.write(Buffer.from('exit noreboot\n', 'latin1'));
        } else if (this._motor) {
          link.write(encode(MSP.MSP_SET_MOTOR, this._motorPayload(null, 0)));
          if (this._motor.armingBlocked) link.write(encode(MSP.MSP_SET_ARMING_DISABLED, Buffer.from([0, 0])));
        }
      } catch { /* yok */ }
    }
    this.link = null;
    this._epoch++;
    this._motor = null;
    this._failPending('disconnected');
    if (this._collector) this._collector.finish('closed');
    if (this._fetch) this._fetch.abort = true;
    if (this._cal) this._calFinish('cancelled', { ok: false, error: 'disconnected' });
    if (link) { try { link.close(); } catch { /* yok */ } }
    this._flushLog();
    this._clearTimers();
    this.connected = false;
    this.linked = false;
    this.cliMode = false;
    this.rebooting = false;
    this.paramLoading = false;
    this._mspPaused = false;
    this._identified = false;
    this.parser.textMode = false;
    this._emit('state', this.snapshot());
  }

  _onLinkOpen() {
    this._epoch++;
    this.error = null;
    this.parser.reset(); // yeniden bağlanınca yarım çerçeve kalmasın
    this.parser.textMode = false;
    this._touch(true);
    if (!this._reboot) this._identifyLoop();
  }

  _onLinkClose(link) {
    this._epoch++;
    this._failPending('link_closed');
    if (this._collector) this._collector.finish('closed');
    this._leaveCliState();
    this._identified = false;
    this._motor = null;
    this._setLinked(false);
    const serial = this.linkCfg.type === 'serial';
    if (serial && !this._reboot && this.connected) {
      // USB seri port, kart yeniden başlayınca kapanır: bir süre yeniden açmayı dene
      this._startRebootWait('link');
    } else if (!link.wanted && !this._reboot) {
      this.connected = false;
      if (!this.error) this.error = 'link_closed';
    }
    this._touch(true);
  }

  _setLinked(on) {
    if (this.linked === on) return;
    this.linked = on;
    this._touch(true);
  }

  _onTick() {
    const now = Date.now();
    // CLI kipinde kart kendiliğinden bir şey göndermez: bağlantı açık oldukça bağlı sayılır
    if (this.linked && !this.cliMode && !this._mspPaused && now - this._lastRx > this.linkTimeoutMs) {
      this._setLinked(false);
      this._identified = false;
      if (!this._reboot) this._identifyLoop();
    }
    const dt = (now - this._rate.at) / 1000;
    if (dt >= 1) {
      this.stats.msgRate = Math.round((this.stats.rxMsgs - this._rate.msgs) / dt);
      this.stats.byteRate = Math.round((this.stats.rxBytes - this._rate.bytes) / dt);
      this._rate = { msgs: this.stats.rxMsgs, bytes: this.stats.rxBytes, at: now };
    }
    if (this.armed && this._motor) this.motorStop(); // test sırasında kurulduysa testi bırak
    this._pump();
    this._touch();
  }

  // ---- Günlük ve durum yayını ----
  _log(dir, id, name, text) {
    if (this._logQueue.length > 4000) this._logQueue.splice(0, 2000); // dinleyen yoksa birikmesin
    this._logQueue.push({ t: Date.now(), dir, sysid: 0, compid: 0, id, name, text: text || '' });
    if (!this._logTimer) this._logTimer = this._later(() => { this._logTimer = null; this._flushLog(); }, 100);
  }

  _flushLog() {
    if (!this._logQueue.length) return;
    const batch = this._logQueue;
    this._logQueue = [];
    this._emit('log', batch);
  }

  // Durum değişti: en çok 5 Hz 'state' olayı
  _touch(urgent) {
    if (this._stateTimer) return;
    const wait = Math.max(urgent ? 0 : 20, 200 - (Date.now() - this._lastState));
    this._stateTimer = setTimeout(() => {
      this.timers.delete(this._stateTimer);
      this._stateTimer = null;
      this._lastState = Date.now();
      this._emit('state', this.snapshot());
    }, wait);
    this.timers.add(this._stateTimer);
  }

  _statusText(severity, text) {
    this._emit('statustext', { severity, severityName: SEVERITY_NAMES[severity] || String(severity), text, t: Date.now() });
  }

  modes() { return []; } // uçuş kipi kumanda anahtarlarıyla seçilir

  snapshot() {
    const bits = this.sensorBits;
    const list = bits === null ? [] : BF.SENSORS.filter((s) => s.id <= 32 || (bits & s.id)).map((s) => {
      const on = (bits & s.id) !== 0;
      return { id: s.id, name: s.name, present: on, enabled: on, healthy: on };
    });
    const t = this.telemetry;
    return {
      connected: this.connected,
      linked: this.linked,
      link: this.link ? this.link.describe() : describeCfg(this.linkCfg),
      error: this.error,
      firmware: 'betaflight',
      vehicle: 'copter',
      variant: this.variant,
      armed: this.armed,
      mode: this.mode,
      modes: [],
      boxes: this.boxes.slice(),
      systemStatus: this.rebooting ? 'BOOT' : this.cliMode ? 'CLI' : !this.linked ? null : this.armed ? 'ACTIVE' : 'STANDBY',
      version: this.version,
      board: this.board,
      boardInfo: this.boardInfo ? { ...this.boardInfo } : null,
      craftName: this.craftName,
      apiVersion: this.apiVersion,
      uid: this.uid,
      telemetry: { ...t, rc: t.rc.slice(), servo: t.servo.slice() },
      sensors: { present: bits, enabled: bits, health: bits, list },
      armingDisabled: this.armingDisabled.slice(),
      rebootRequired: this.rebootRequired,
      params: { total: this.paramTotal, received: this.paramLoading ? this._paramRx : this.params.size, loading: this.paramLoading },
      frame: this.frame ? { ...this.frame, motors: this.frame.motors.map((m) => ({ ...m })) } : null,
      cliMode: this.cliMode,
      unsaved: this.unsaved,
      rebooting: this.rebooting,
      motorTest: !!this._motor,
      stats: { ...this.stats },
    };
  }

  // ---- Gönderme / alma ----
  _write(buf) {
    if (!this.link || !this.link.write(buf)) return false;
    this.stats.txBytes += buf.length;
    return true;
  }

  _onData(chunk) {
    this.stats.rxBytes += chunk.length;
    const frames = this.parser.push(chunk);
    for (const f of frames) {
      try { this._onFrame(f); } catch (err) { this._fail(err); }
    }
  }

  // MSP dışı baytlar: CLI kipinde komut çıktısı; değilse yalnızca CLI kipini sezmek için tutulur
  _onText(s) {
    if (this.parser.textMode) {
      this._lastRx = Date.now();
      if (this._collector) this._collector.data(s);
      else if (this.cliMode) this._emit('cli', { text: s });
      return;
    }
    this._stray = (this._stray + s).slice(-256);
  }

  _onFrame(f) {
    if (f.dir === '<') return; // başka bir yer istasyonunun isteği (yankı): yok say
    this.stats.rxMsgs++;
    this._lastRx = Date.now();
    this._stray = '';
    const name = mspName(f.cmd);
    let fields = null;
    if (!f.error) {
      const h = HANDLERS[f.cmd];
      if (h) { try { fields = h.call(this, new Reader(f.payload), f.payload); } catch (err) { this._fail(err); } }
    }
    this._log('rx', f.cmd, name, f.error ? 'error' : fields ? fmtFields(fields) : (f.payload.length ? `len=${f.payload.length}` : 'ack'));
    const req = this._inflight;
    if (req && req.cmd === f.cmd) this._finish(req, f.error ? { ok: false, error: 'rejected' } : { ok: true, payload: f.payload });
    if (!this.linked && this._identified) this._setLinked(true);
    this._touch();
  }

  // Tek seferde bir istek; yanıt gelmezse zaman aşımı ve yineleme. Kullanıcı komutları sıradadır, telemetri boşta yoklanır.
  _request(cmd, payload, opts = {}) {
    return new Promise((resolve) => {
      if (!this.ready) { resolve({ ok: false, error: 'not_connected' }); return; }
      if (this._mspPaused) { resolve({ ok: false, error: 'cli_mode' }); return; }
      this._queue.push({ cmd, payload: payload || null, timeoutMs: opts.timeoutMs || 800, retries: opts.retries === undefined ? 2 : opts.retries, tries: 0, resolve, timer: null });
      this._pump();
    });
  }

  _pump() {
    if (this._inflight || this._mspPaused || !this.ready) return;
    let req = this._queue.shift();
    if (!req) req = this._nextPoll();
    if (!req) return;
    this._inflight = req;
    this._sendReq(req);
  }

  _sendReq(req) {
    req.tries++;
    const buf = encode(req.cmd, req.payload);
    if (!this._write(buf)) { this._finish(req, { ok: false, error: 'not_connected' }); return; }
    this.stats.txMsgs++;
    this._log('tx', req.cmd, mspName(req.cmd), req.payload && req.payload.length ? `data=0x${req.payload.toString('hex')}` : '');
    req.timer = this._later(() => {
      req.timer = null;
      if (this._inflight !== req) return;
      this.stats.timeouts++;
      if (req.tries <= req.retries) this._sendReq(req); else this._finish(req, { ok: false, error: 'timeout' });
    }, req.timeoutMs);
  }

  _finish(req, result) {
    this._cancel(req.timer);
    req.timer = null;
    if (this._inflight === req) this._inflight = null;
    try { req.resolve(result); } catch (err) { this._fail(err); }
    if (!this._inflight) {
      const waiters = this._idleWaiters;
      this._idleWaiters = [];
      for (const w of waiters) w();
    }
    this._pump();
  }

  _failPending(error) {
    const queue = this._queue;
    this._queue = [];
    for (const r of queue) { try { r.resolve({ ok: false, error }); } catch { /* yok */ } }
    const req = this._inflight;
    if (req) { this._cancel(req.timer); this._inflight = null; try { req.resolve({ ok: false, error }); } catch { /* yok */ } }
    const waiters = this._idleWaiters;
    this._idleWaiters = [];
    for (const w of waiters) w();
  }

  _idle() {
    if (!this._inflight) return Promise.resolve();
    return new Promise((resolve) => { this._idleWaiters.push(resolve); });
  }

  // ---- Telemetri yoklaması: tutum ve kumanda ~10 Hz, ötekiler streamRate ----
  _buildPolls() {
    const slow = Math.round(1000 / this.streamRate);
    const fast = Math.min(100, slow);
    const now = Date.now();
    const gps = this.sensorBits === null || (this.sensorBits & 8) !== 0;
    const items = [
      { cmd: MSP.MSP_ATTITUDE, every: fast },
      { cmd: MSP.MSP_RC, every: fast },
      { cmd: MSP.MSP_STATUS_EX, every: slow },
      { cmd: MSP.MSP_ANALOG, every: slow },
      { cmd: MSP.MSP_ALTITUDE, every: slow },
      { cmd: MSP.MSP_MOTOR, every: slow },
      { cmd: MSP.MSP_RAW_GPS, every: slow, gps: true },
      { cmd: MSP.MSP_BATTERY_STATE, every: Math.max(slow, 1000) },
      { cmd: MSP.MSP_COMP_GPS, every: Math.max(slow, 1000), gps: true },
    ];
    this._polls = items.map((p, i) => ({ ...p, next: now + i * 7, fails: 0, off: !!p.gps && !gps }));
  }

  _nextPoll() {
    if (!this._identified || !this._polls) return null;
    const now = Date.now();
    let best = null;
    let soonest = Infinity;
    for (const p of this._polls) {
      if (p.off) continue;
      if (p.next <= now) { if (!best || p.next < best.next) best = p; } else if (p.next < soonest) soonest = p.next;
    }
    if (!best) {
      if (soonest !== Infinity && !this._pollTimer) {
        this._pollTimer = this._later(() => { this._pollTimer = null; this._pump(); }, Math.max(1, soonest - now));
      }
      return null;
    }
    best.next = Math.max(best.next + best.every, now + best.every / 2);
    return {
      cmd: best.cmd, payload: null, timeoutMs: this.replyTimeoutMs, retries: 0, tries: 0, timer: null,
      resolve: (r) => {
        if (r.ok) best.fails = 0;
        else if (r.error === 'rejected' && ++best.fails >= 3) best.off = true; // bu derlemede yok (ör. GPS'siz)
      },
    };
  }

  // ---- Kimlik ve yapılandırma okuma ----
  // Bağlantı açıkken kart yanıt verene dek MSP_API_VERSION yoklar; yanıt gelince geri kalanı okur.
  async _identifyLoop() {
    if (this._identLoop) return;
    this._identLoop = true;
    try {
      const link = this.link;
      const epoch = this._epoch;
      const alive = () => this.link === link && link.isOpen && this._epoch === epoch && !this._reboot && !this._mspPaused;
      while (alive() && !this._identified) {
        const ok = await this._identifyOnce();
        if (ok || !alive()) break;
        this.parser.flush(); // yarım kalmış "çerçeve başı" aslında yankı olabilir: metne dök
        // Yanıt yok ama isteğimiz yankılanıyorsa kart CLI kipinde kalmış demektir (önceki oturum çıkmamış)
        if (this._stray.includes('$M<')) { this._adoptCli(); break; }
        await this._sleep(300);
      }
    } catch (err) { this._fail(err); } finally { this._identLoop = false; }
    // Döngü sürerken bağlantı kapanıp açıldıysa yeniden başlat
    if (this.ready && !this._identified && !this._reboot && !this._mspPaused && !this.cliMode) this._later(() => this._identifyLoop(), 50);
  }

  async _identifyOnce() {
    const epoch = this._epoch;
    const r = await this._request(MSP.MSP_API_VERSION, null, { timeoutMs: 600, retries: 0 });
    if (!r.ok || epoch !== this._epoch) return false;
    const q = (cmd, payload) => this._request(cmd, payload, { timeoutMs: 800, retries: 1 });
    await q(MSP.MSP_FC_VARIANT);
    await q(MSP.MSP_FC_VERSION);
    await q(MSP.MSP_BOARD_INFO);
    await q(MSP.MSP_BUILD_INFO);
    await q(MSP.MSP_NAME);
    await q(MSP.MSP_UID);
    await q(MSP.MSP_FEATURE_CONFIG);
    await q(MSP.MSP_MIXER_CONFIG);
    await q(MSP.MSP_MOTOR_CONFIG);
    await q(MSP.MSP_ADVANCED_CONFIG);
    if (this.features & BF.FEATURE_3D) await q(MSP.MSP_MOTOR_3D_CONFIG);
    await q(MSP.MSP_BATTERY_CONFIG);
    await this._readBoxes(q);
    await q(MSP.MSP_STATUS_EX);
    if (epoch !== this._epoch || !this.ready) return false;
    this._deriveFrame();
    if (this.variant && this.variant !== 'BTFL') this._statusText(4, `Not a Betaflight controller (${this.variant}); some data may be wrong`);
    this._buildPolls();
    this._identified = true;
    this._lastRx = Date.now();
    this._setLinked(true);
    this._touch(true);
    this._pump();
    return true;
  }

  // Kutu kimlikleri ve adları 32'lik sayfalarla gelir (eski sürümler sayfa numarasını yok sayar ve hepsini gönderir)
  async _readBoxes(q) {
    const ids = [];
    let names = [];
    let first = null;
    for (let page = 0; page < 4; page++) {
      const r = await q(MSP.MSP_BOXIDS, page ? Buffer.from([page]) : null);
      if (!r.ok) break;
      if (page && first && r.payload.equals(first)) break;
      if (!page) first = r.payload;
      for (const b of r.payload) ids.push(b);
      if (r.payload.length !== 32) break;
    }
    first = null;
    for (let page = 0; page < 4; page++) {
      const r = await q(MSP.MSP_BOXNAMES, page ? Buffer.from([page]) : null);
      if (!r.ok) break;
      if (page && first && r.payload.equals(first)) break;
      if (!page) first = r.payload;
      const part = r.payload.toString('latin1').split(';').filter((s) => s !== '');
      names = names.concat(part);
      if (part.length !== 32) break;
    }
    this.boxIds = ids.length ? ids : null;
    this.boxNames = names.length === ids.length && names.length ? names : null;
  }

  _deriveFrame() {
    if (this.mixerMode === null) { this.frame = null; return; }
    this.frame = BF.frameFromMixer(this.mixerMode, this.yawReversed, this.motorCfg ? this.motorCfg.motorCount : null);
  }

  // ---- CLI ----
  _supportsNoReboot() { return this.apiMinor !== null && this.apiMinor >= 46; } // "exit noreboot" / "save noreboot": 4.5 ve sonrası

  _cliExec(fn) {
    const run = this._cliChain.then(fn, fn);
    this._cliChain = run.then(() => {}, () => {});
    return run.catch((err) => ({ ok: false, error: 'error', detail: String((err && err.message) || err) }));
  }

  _leaveCliState() {
    const was = this.cliMode;
    this.cliMode = false;
    this._mspPaused = false;
    this.parser.textMode = false;
    this._stray = '';
    if (was) this._touch(true);
  }

  // Kart zaten CLI kipindeyse (bağlanırken sezildi) oturumu sahiplen ve sürümü CLI'den öğren
  _adoptCli() {
    this._mspPaused = true;
    this._failPending('cli_mode');
    this.parser.textMode = true;
    this.cliMode = true;
    this._lastRx = Date.now();
    this._setLinked(true);
    this._statusText(4, 'Flight controller is in CLI mode; exit the CLI to resume telemetry');
    this._touch(true);
    this._cliExec(async () => {
      this._write(Buffer.from('\n', 'latin1')); // yankılanan MSP baytlarını satır olarak kapat (bilinmeyen komut hatası verir)
      await this._collect({ timeoutMs: 1500, idleMs: 600 });
      const r = await this._cliRun('version', { timeoutMs: 3000 });
      const m = /MSP API: (\d+)\.(\d+)/.exec(r.text);
      if (m) { this.apiVersion = `${m[1]}.${m[2]}`; this.apiMinor = Number(m[2]); }
      const v = /^# (\S+) \/ (\S+) \((\S+)\) (\S+)/m.exec(r.text);
      if (v) { this.board = this.board || v[2]; this.version = this.version || v[4]; }
      this._touch(true);
      return { ok: true };
    });
  }

  // CLI çıktısı toplayıcı: istem ("\r\n# ") görülüp hat sessizleşince, 'until' eşleşince ya da zaman aşımında biter
  _collect({ timeoutMs = 8000, idleMs = 3000, until = null, onData = null } = {}) {
    return new Promise((resolve) => {
      const c = { text: '', done: false, total: null, idle: null, settle: null };
      c.finish = (reason) => {
        if (c.done) return;
        c.done = true;
        this._cancel(c.total); this._cancel(c.idle); this._cancel(c.settle);
        if (this._collector === c) this._collector = null;
        resolve({ raw: c.text, reason });
      };
      c.data = (s) => {
        c.text += s;
        if (onData) { try { onData(s); } catch (err) { this._fail(err); } }
        this._cancel(c.settle); c.settle = null;
        this._cancel(c.idle);
        c.idle = this._later(() => c.finish(c.text ? 'idle' : 'timeout'), idleMs);
        const tail = c.text.length > 240 ? c.text.slice(-240) : c.text; // uzun çıktıda her parçada baştan taranmasın
        if (until && until.test(tail)) { c.settle = this._later(() => c.finish('match'), this.cliSettleMs); return; }
        if (PROMPT_RE.test(tail)) c.settle = this._later(() => c.finish('prompt'), this.cliSettleMs);
      };
      c.total = this._later(() => c.finish('timeout'), timeoutMs);
      c.idle = this._later(() => c.finish(c.text ? 'idle' : 'timeout'), idleMs);
      this._collector = c;
    });
  }

  async _cliEnter() {
    if (this.cliMode) return { ok: true };
    if (!this.ready) return { ok: false, error: 'not_connected' };
    if (this._reboot) return { ok: false, error: 'rebooting' };
    if (this.armed) return { ok: false, error: 'armed' }; // kuruluyken kart '#' karakterini değerlendirmez
    if (this._motor) await this.motorStop();
    const link = this.link;
    this._mspPaused = true;
    // Sıradaki istekleri iptal et, gönderilmiş olanın yanıtını bekle; kart '#' sonrası 100 ms sessizlik ister
    const queue = this._queue;
    this._queue = [];
    for (const r of queue) { try { r.resolve({ ok: false, error: 'cli_mode' }); } catch { /* yok */ } }
    await this._idle();
    await this._sleep(30);
    if (this.link !== link || !link.isOpen) { this._mspPaused = false; return { ok: false, error: 'not_connected' }; }
    this.parser.flush();
    this.parser.textMode = true;
    this._log('tx', 0, 'CLI', '#');
    this._write(Buffer.from('#', 'latin1'));
    let r = await this._collect({ timeoutMs: 2000, idleMs: 1500 });
    if (r.reason !== 'prompt' && this.link === link && link.isOpen) {
      // İstem gelmedi: belki zaten CLI'deydik; boş satırla istem iste
      this._write(Buffer.from('\n', 'latin1'));
      r = await this._collect({ timeoutMs: 1500, idleMs: 1000 });
    }
    if (r.reason !== 'prompt') {
      if (this.link === link) { this.parser.textMode = false; this._mspPaused = false; this._pump(); }
      return { ok: false, error: this.link === link && link.isOpen ? 'cli_timeout' : 'not_connected' };
    }
    this.cliMode = true;
    this._lastRx = Date.now();
    const banner = r.raw.replace(/\r/g, '').replace(/\n# $/, '').trim();
    if (banner) this._log('rx', 0, 'CLI', banner.split('\n').pop());
    this._touch(true);
    return { ok: true };
  }

  // Bir satır gönderir, istem gelene dek çıktıyı toplar. stream: çıktı 'cli' olayıyla da akıtılır.
  async _cliRun(line, opts = {}) {
    const { timeoutMs = 8000, idleMs = 3000, stream = false, until = CLI_END_RE, quiet = false, onData = null } = opts;
    let pending = '';
    let echoDone = false;
    const feed = (s) => {
      if (onData) onData(s);
      if (!stream) return;
      pending += s.replace(/\r/g, '');
      if (!echoDone) {
        const nl = pending.indexOf('\n');
        if (nl < 0) return;
        if (pending.slice(0, nl).trim() === line.trim()) pending = pending.slice(nl + 1);
        echoDone = true;
      }
      // Sondaki olası istemi ("\n# ") alıkoy: komut bitince atılır
      const cut = pending.lastIndexOf('\n');
      const tail = cut < 0 ? pending : pending.slice(cut + 1);
      const hold = tail === '' || tail === '#' || tail === '# ';
      const out = hold ? (cut < 0 ? '' : pending.slice(0, cut)) : pending;
      if (out) { this._emit('cli', { text: out }); pending = pending.slice(out.length); }
    };
    this._log('tx', 0, 'CLI', line);
    const wait = this._collect({ timeoutMs, idleMs, until, onData: feed });
    if (!this._write(Buffer.from(`${line}\n`, 'latin1'))) {
      if (this._collector) this._collector.finish('closed');
      await wait;
      return { text: '', raw: '', reason: 'closed' };
    }
    const r = await wait;
    const text = cleanCliOutput(r.raw, line);
    if (stream) {
      const rest = r.reason === 'prompt' ? pending.replace(/\n?#? ?$/, '') : pending;
      this._emit('cli', { text: `${echoDone ? rest : ''}\n` });
    }
    if (!quiet) {
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      for (const l of lines.slice(0, 200)) this._log('rx', 0, 'CLI', l);
      if (lines.length > 200) this._log('rx', 0, 'CLI', `… ${lines.length - 200} more lines`);
    } else {
      this._log('rx', 0, 'CLI', `${text ? text.split('\n').length : 0} lines, ${r.raw.length} bytes`);
    }
    return { text, raw: r.raw, reason: r.reason };
  }

  // Keyfi bir CLI satırı ("tam denetim"). → { ok, text, reboot?, exited?, partial? }
  cli(line) {
    const cmd = String(line === undefined || line === null ? '' : line).replace(/[\r\n]+/g, ' ').trim();
    if (!cmd) return Promise.resolve({ ok: false, error: 'invalid' });
    return this._cliExec(async () => {
      const e = await this._cliEnter();
      if (!e.ok) return e;
      const long = /^(dump|diff|get|help|resource|set\s*$|timer|dma|tasks)/i.test(cmd);
      const r = await this._cliRun(cmd, { stream: true, timeoutMs: long ? 90000 : 10000, idleMs: long ? 5000 : 3000 });
      if (r.reason === 'closed' && !REBOOT_RE.test(r.raw)) return { ok: false, error: 'not_connected', text: r.text };
      if (REBOOT_RE.test(r.raw)) {
        this.unsaved = 0; // kaydedildi ya da yitti
        this._statusText(6, 'Flight controller is rebooting');
        this._startRebootWait('cli');
        return { ok: true, text: r.text, reboot: true };
      }
      if (LEFT_RE.test(r.raw)) {
        this._leaveCliState();
        this._lastRx = Date.now();
        this._identified = false; // RAM'deki ayarlar değişmiş olabilir: yapılandırmayı yeniden oku
        this._identifyLoop();
        return { ok: true, text: r.text, exited: true };
      }
      this._trackSet(cmd, r.text);
      if (r.reason === 'timeout' && !r.text) return { ok: false, error: 'timeout', text: '' };
      const out = { ok: true, text: r.text };
      if (r.reason !== 'prompt') out.partial = true;
      return out;
    });
  }

  // Konsoldan yazılan "set ad = değer" de önbelleğe ve kaydedilmemiş sayacına yansısın
  _trackSet(cmd, text) {
    const m = /^set\s+([A-Za-z0-9_]+)\s*=/i.exec(cmd);
    if (!m) return;
    const ok = new RegExp(`^${m[1]} set to (.*)$`, 'im').exec(text);
    if (!ok) return;
    this.unsaved++;
    const p = this.params.get(m[1].toLowerCase()) || this.params.get(m[1]);
    if (p) { p.value = typedValue(p.type, ok[1].trim()); this._emit('param', { name: p.name, value: p.value, type: p.type, index: p.index }); }
    this._touch();
  }

  // CLI'den çıkar. 4.5+ (API ≥ 1.46): "exit noreboot" — yeniden başlatmaz, RAM'deki kaydedilmemiş değişiklikler kalır,
  // kurma engeli (CLI) yeniden başlatılana dek sürer. Daha eski sürümlerde "exit" her zaman yeniden başlatır.
  // exitCli({ reboot: true }) her sürümde yeniden başlatarak çıkar (kaydedilmemiş değişiklikler yiter).
  exitCli(opts = {}) {
    return this._cliExec(async () => {
      if (!this.cliMode) return { ok: true, rebooted: false };
      if (!this.ready) return { ok: false, error: 'not_connected' };
      const soft = !opts.reboot && this._supportsNoReboot();
      const r = await this._cliRun(soft ? 'exit noreboot' : 'exit', { timeoutMs: 3000, idleMs: 1200 });
      if (soft && !REBOOT_RE.test(r.raw)) {
        this._leaveCliState();
        this._lastRx = Date.now();
        this._identified = false; // RAM'deki ayarlar değişmiş olabilir: yapılandırmayı yeniden oku
        this._identifyLoop();
        return { ok: true, rebooted: false };
      }
      this.unsaved = 0;
      this._statusText(6, 'Leaving CLI: flight controller is rebooting');
      const w = await this._startRebootWait('exit');
      return w.ok ? { ok: true, rebooted: true } : { ...w, rebooted: true };
    });
  }

  // ---- Yeniden başlatma: bağlantının dönmesini bekle, yeniden tanı ----
  _startRebootWait(reason) {
    if (this._reboot) { if (reason !== 'link') this._rebootReason = reason; return this._reboot; }
    const link = this.link;
    if (!link) return Promise.resolve({ ok: false, error: 'not_connected' });
    this._rebootReason = reason;
    this._epoch++;
    this.rebooting = true;
    this._identified = false;
    this._failPending('rebooting');
    if (this._collector) this._collector.finish('closed');
    this._leaveCliState();
    this._motor = null;
    this._setLinked(false);
    this._touch(true);
    const serial = this.linkCfg.type === 'serial';
    const run = async () => {
      const start = Date.now();
      await this._sleep(this.rebootSettleMs);
      while (this.link === link && Date.now() - start < this.rebootWaitMs) {
        if (!link.isOpen) {
          if (serial) { try { await link.open(); } catch { /* port henüz yok */ } }
          if (!link.isOpen) { await this._sleep(300); continue; }
        }
        if (await this._identifyOnce()) return { ok: true };
        await this._sleep(200);
      }
      return { ok: false, error: this.link === link ? 'reboot_timeout' : 'disconnected' };
    };
    const p = run().catch((err) => ({ ok: false, error: 'error', detail: String((err && err.message) || err) })).then((r) => {
      if (this._reboot === p) this._reboot = null;
      if (this.link !== link) return r;
      this.rebooting = false;
      if (r.ok) {
        this.error = null;
        if (this._rebootReason !== 'link') this._statusText(6, 'Flight controller is back online');
      } else {
        this._statusText(3, 'Flight controller did not come back after reboot');
        if (!link.isOpen && serial) { this.connected = false; this.error = 'link_closed'; }
        else if (this.ready) this._identifyLoop();
      }
      this._touch(true);
      return r;
    });
    this._reboot = p;
    return p;
  }

  // MSP_REBOOT (yapılandırıcıdaki MSP_SET_REBOOT). CLI kipindeyken MSP işlenmediğinden "exit" ile yeniden başlatılır.
  reboot() {
    const run = async () => {
      if (!this.ready) return { ok: false, error: 'not_connected' };
      if (this._reboot) return this._reboot;
      if (this.cliMode) return this.exitCli({ reboot: true });
      if (this.armed) return { ok: false, error: 'armed' };
      if (this._motor) await this.motorStop();
      const r = await this._request(MSP.MSP_REBOOT, Buffer.from([0]), { timeoutMs: 1000, retries: 0 }); // 0 = bellenime yeniden başla
      if (!r.ok && r.error === 'rejected') return { ok: false, error: 'rejected' };
      if (!r.ok && r.error !== 'timeout' && r.error !== 'link_closed') return r;
      this._statusText(6, 'Flight controller is rebooting');
      return this._startRebootWait('reboot');
    };
    return run().catch((err) => ({ ok: false, error: 'error', detail: String((err && err.message) || err) }));
  }

  // ---- Ayarlar (CLI üzerinden) ----
  getParams() {
    return [...this.params.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((p) => ({ ...p, range: p.range ? p.range.slice() : null, values: p.values ? p.values.slice() : null }));
  }

  _paramProgress(done) {
    return { total: this.paramTotal, received: this.paramLoading ? this._paramRx : this.params.size, loading: this.paramLoading, done: !!done };
  }

  // CLI'ye girer, "get" ile bütün ayarları (değer, aralık/seçenekler, varsayılan) okur. Çıktı beklenen biçimde değilse "dump all".
  // 4.5+ sürümlerde iş bitince CLI'den yeniden başlatmadan çıkar (opts.stay ile CLI'de kalır); eskilerde CLI'de kalır
  // (çıkmak yeniden başlatır) — arayüz exitCli() / saveParams() çağırmalıdır.
  fetchParams(opts = {}) {
    if (this._fetch) return this._fetch.promise;
    if (!this.ready) return Promise.resolve({ ok: false, error: 'not_connected', total: this.paramTotal, received: this.params.size });
    const fetch = { abort: false };
    this._fetch = fetch;
    fetch.promise = this._cliExec(async () => {
      const wasCli = this.cliMode;
      const e = await this._cliEnter();
      if (!e.ok) return { ...e, total: this.paramTotal, received: this.params.size };
      this.paramLoading = true;
      this._paramRx = 0;
      this._emit('params', this._paramProgress(false));
      this._touch(true);
      let lastEmit = 0;
      let tail = '';
      const count = (re) => (s) => {
        // İlerleme: gelen "ad = değer" satırlarını say (parça sınırına dikkat)
        const text = tail + s;
        const cut = text.lastIndexOf('\n');
        if (cut < 0) { tail = text; return; }
        tail = text.slice(cut + 1);
        const m = text.slice(0, cut).match(re);
        if (m) this._paramRx += m.length;
        const now = Date.now();
        if (now - lastEmit >= 200) { lastEmit = now; this._emit('params', this._paramProgress(false)); this._touch(); }
      };
      let r = await this._cliRun('get', { quiet: true, timeoutMs: 120000, idleMs: 5000, onData: count(/^[A-Za-z0-9_]+ = /gm) });
      let list = parseGetOutput(r.text);
      if (list.length < 5 && !fetch.abort && this.ready && this.cliMode) {
        this._paramRx = 0; tail = '';
        r = await this._cliRun('dump all', { quiet: true, timeoutMs: 120000, idleMs: 5000, onData: count(/^set [A-Za-z0-9_]+ = /gm) });
        list = parseDumpOutput(r.text);
      }
      const ok = list.length > 0 && r.reason === 'prompt';
      if (list.length) {
        this.params = new Map(list.map((p) => [p.name, p]));
        this.paramTotal = list.length;
      }
      this.paramLoading = false;
      this._emit('params', this._paramProgress(true));
      this._touch(true);
      const out = { ok, total: this.paramTotal, received: list.length };
      if (!ok) out.error = fetch.abort ? 'disconnected' : r.reason === 'closed' ? 'not_connected' : list.length ? 'incomplete' : 'timeout';
      // CLI'ye bu çağrı girdiyse ve yeniden başlatmadan çıkılabiliyorsa telemetriye dön
      if (!wasCli && !opts.stay && this.cliMode && !this.unsaved && this._supportsNoReboot() && this.ready) {
        const x = await this._cliRun('exit noreboot', { timeoutMs: 3000, idleMs: 1200, quiet: true });
        if (REBOOT_RE.test(x.raw)) this._startRebootWait('exit');
        else { this._leaveCliState(); this._lastRx = Date.now(); this._pump(); }
      }
      return out;
    }).then((r) => { if (this._fetch === fetch) this._fetch = null; this.paramLoading = false; return r; });
    return fetch.promise;
  }

  // "set ad = değer". → { ok:true, value } | { ok:false, error: 'invalid'|'unknown_param'|'rejected'|'timeout'|…, detail }
  // Değişiklik RAM'dedir; kalıcı olması için saveParams() gerekir (CLI açık kalır, snapshot().unsaved artar).
  setParam(name, value) {
    const n = String(name === undefined || name === null ? '' : name).trim();
    // '#' satırın kalanını açıklama yapar; '?' ve sekme etkileşimli CLI'de tamamlamayı tetikler: değer içinde kullanılamaz
    let v = Array.isArray(value) ? value.join(',') : typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : String(value === undefined || value === null ? '' : value).trim();
    if (!NAME_RE.test(n) || /[\r\n\t#?]/.test(v) || (typeof value === 'number' && !Number.isFinite(value))) return Promise.resolve({ ok: false, error: 'invalid' });
    const known = this.params.get(n);
    if (v === '') { if (known && known.type === 'text') v = '-'; else return Promise.resolve({ ok: false, error: 'invalid' }); }
    if (known && known.type === 'number' && /^-?\d+\.0*$/.test(v)) v = String(Math.round(Number(v)));
    return this._cliExec(async () => {
      const e = await this._cliEnter();
      if (!e.ok) return e;
      const r = await this._cliRun(`set ${n} = ${v}`, { timeoutMs: 4000, idleMs: 2000 });
      const text = r.text;
      const okm = /^(\S+) set to (.*)$/m.exec(text);
      if (okm) {
        const p = this.params.get(okm[1]) || known;
        const raw = okm[2].trim();
        const val = p ? typedValue(p.type, raw) : (/^-?\d+$/.test(raw) ? Number(raw) : raw);
        if (p) p.value = val;
        this.unsaved++;
        this._emit('param', { name: okm[1], value: val, type: p ? p.type : (typeof val === 'number' ? 'number' : 'text'), index: p ? p.index : -1 });
        this._touch();
        return { ok: true, value: val };
      }
      const err = /###ERROR IN [^:]*: (.*?)###/.exec(text);
      if (err) {
        const after = text.slice(text.indexOf(err[0]) + err[0].length).trim();
        const detail = [err[1], after].filter(Boolean).join(' — ');
        const error = /INVALID NAME/.test(err[1]) ? 'unknown_param' : 'rejected';
        return { ok: false, error, detail };
      }
      if (r.reason === 'closed') return { ok: false, error: 'not_connected' };
      return { ok: false, error: r.reason === 'prompt' ? 'rejected' : 'timeout', detail: text };
    });
  }

  // "save": EEPROM'a yazar ve kartı yeniden başlatır; bağlantının dönmesi beklenir ve kart yeniden tanınır.
  saveParams() {
    return this._cliExec(async () => {
      const e = await this._cliEnter();
      if (!e.ok) return e;
      const r = await this._cliRun('save', { timeoutMs: 8000, idleMs: 4000, until: REBOOT_RE });
      const err = /###ERROR IN [^:]*: (.*?)###/.exec(r.text);
      if (err && !REBOOT_RE.test(r.raw)) return { ok: false, error: 'rejected', detail: err[1] }; // ör. hatalı "batch"
      if (r.reason === 'prompt' && !REBOOT_RE.test(r.raw) && !/saving/.test(r.raw)) return { ok: false, error: 'rejected', detail: r.text };
      this.unsaved = 0;
      this._statusText(6, 'Settings saved; flight controller is rebooting');
      return this._startRebootWait('save');
    });
  }

  // ---- Komutlar: Betaflight kumandadan kurulur, kip anahtarla seçilir ----
  command() { return Promise.resolve({ ok: false, error: 'unsupported' }); }
  arm() { return Promise.resolve({ ok: false, error: 'unsupported' }); }
  setMode() { return Promise.resolve({ ok: false, error: 'unsupported' }); }
  saveRcLimits() { return Promise.resolve({ ok: false, error: 'unsupported' }); }

  // ---- Motor testi (MSP_SET_MOTOR) ----
  // Değer aralığı (yapılandırıcı motors.js): DSHOT/PROSHOT'ta 1000 (dur) … 2000; analog protokollerde min_command … max_throttle;
  // 3D açıkken durma değeri orta noktadır (DSHOT 1500 / 3d_neutral) ve test yalnızca ileri yöndedir.
  _motorRange() {
    const cfg = this.motorCfg || { minCommand: 1000, maxThrottle: 2000 };
    const dshot = this.motorProtocol === null ? cfg.minCommand === 1000 : BF.isDshot(this.motorProtocol);
    let idle = dshot ? BF.DSHOT_RANGE.idle : cfg.minCommand;
    const max = dshot ? BF.DSHOT_RANGE.max : cfg.maxThrottle;
    if (this.features & BF.FEATURE_3D) {
      const n = this.motor3d ? this.motor3d.neutral : 1500;
      idle = dshot ? BF.DSHOT_RANGE.neutral3d : (n > 1575 || n < 1425 ? 1500 : n);
    }
    return { idle, max: Math.max(max, idle) };
  }

  _motorCount() {
    if (this.motorCfg && this.motorCfg.motorCount > 0) return this.motorCfg.motorCount;
    if (this.frame && this.frame.motors.length) return this.frame.motors.length;
    return 4;
  }

  // Kart getMotorCount() kadar değer okur; hep 8 değer gönderilir (fazlası yok sayılır, eksiği yeni sürümlerde hata)
  _motorPayload(motor, value) {
    const { idle } = this._motorRange();
    const buf = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) buf.writeUInt16LE(motor !== null && i === motor - 1 ? value : idle, i * 2);
    return buf;
  }

  // motor: Betaflight motor numarası (1'den). Ötekiler durma değerinde tutulur; süre dolunca kendiliğinden durur.
  // Test süresince kurma MSP ile engellenir (MSP_SET_ARMING_DISABLED): kumandadan kurulursa karıştırıcı motorları devralırdı.
  motorTest({ motor = 1, throttlePct = 5, seconds = 2 } = {}) {
    const run = async () => {
      if (!this.ready) return { ok: false, error: 'not_connected' };
      if (this.cliMode || this._mspPaused) return { ok: false, error: 'cli_mode' };
      if (!this._identified) return { ok: false, error: 'not_ready' };
      if (this.armed) return { ok: false, error: 'armed' };
      const m = Math.round(Number(motor) || 0);
      const count = this._motorCount();
      if (m < 1 || m > count || m > 8) return { ok: false, error: 'invalid' };
      if (this.motorProtocol === BF.MOTOR_PROTOCOL_DISABLED || (this.boardInfo && (this.boardInfo.configurationProblems & BF.PROBLEM_MOTOR_PROTOCOL_DISABLED))) return { ok: false, error: 'motor_protocol_disabled' };
      const pct = clamp(Number(throttlePct) || 0, 0, 100);
      const secs = clamp(Number(seconds) || 0, 0, 60);
      if (pct === 0 || secs === 0) return this.motorStop();
      const { idle, max } = this._motorRange();
      const value = Math.round(idle + (max - idle) * pct / 100);
      if (!this._motor) this._motor = { timer: null, armingBlocked: false };
      const mt = this._motor;
      if (!mt.armingBlocked) {
        const a = await this._request(MSP.MSP_SET_ARMING_DISABLED, Buffer.from([1, 0]), { timeoutMs: 800, retries: 2 });
        if (this._motor !== mt) return { ok: false, error: 'cancelled' };
        if (!a.ok) { this._motor = null; return { ok: false, error: a.error }; }
        mt.armingBlocked = true;
      }
      if (this.armed) { await this.motorStop(); return { ok: false, error: 'armed' }; }
      const r = await this._request(MSP.MSP_SET_MOTOR, this._motorPayload(m, value), { timeoutMs: 800, retries: 2 });
      if (this._motor !== mt) return { ok: false, error: 'cancelled' };
      if (!r.ok) { await this.motorStop(); return { ok: false, error: r.error }; }
      this._cancel(mt.timer);
      mt.timer = this._later(() => { mt.timer = null; this.motorStop(); }, secs * 1000);
      this._touch(true);
      return { ok: true, motor: m, value, seconds: secs };
    };
    return run().catch((err) => ({ ok: false, error: 'error', detail: String((err && err.message) || err) }));
  }

  motorStop() {
    const run = async () => {
      const mt = this._motor;
      if (mt) { this._cancel(mt.timer); mt.timer = null; }
      this._motor = null;
      if (!this.ready) return { ok: false, error: 'not_connected' };
      if (this.cliMode || this._mspPaused) return { ok: false, error: 'cli_mode' };
      const r = await this._request(MSP.MSP_SET_MOTOR, this._motorPayload(null, 0), { timeoutMs: 800, retries: 3 });
      if (mt && mt.armingBlocked && !this._motor) await this._request(MSP.MSP_SET_ARMING_DISABLED, Buffer.from([0, 0]), { timeoutMs: 800, retries: 2 });
      this._touch(true);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    };
    return run().catch((err) => ({ ok: false, error: 'error', detail: String((err && err.message) || err) }));
  }

  // ---- Kalibrasyon ----
  // 'accel'   → MSP_ACC_CALIBRATION: araç düz ve hareketsiz; 400 örnek (< 1 sn), sonuç kart tarafından kaydedilir.
  // 'compass' → MSP_MAG_CALIBRATION: kart hareketi bekler (en çok 15 sn), sonra 30 sn boyunca her eksende döndürülür; sonuç kaydedilir.
  // Kart ilerleme bildirmez: olaylar süreye göre üretilir. 'cancel' yalnızca bekleyişi bitirir (kart kendi süresini tamamlar).
  calibrate(kind) {
    const run = async () => {
      if (kind === 'cancel' || kind === 'compassCancel') {
        if (this._cal) this._calFinish('cancelled', { ok: false, error: 'cancelled' });
        return { ok: true };
      }
      if (kind !== 'accel' && kind !== 'compass') return { ok: false, error: 'unsupported' };
      if (!this.ready) return { ok: false, error: 'not_connected' };
      if (this.cliMode || this._mspPaused) return { ok: false, error: 'cli_mode' };
      if (this.armed) return { ok: false, error: 'armed' }; // kart kuruluyken isteği sessizce yok sayar
      if (this._cal) return { ok: false, error: 'busy' };
      if (kind === 'compass' && this.sensorBits !== null && !(this.sensorBits & BF.SENSOR_MAG)) return { ok: false, error: 'no_compass' };
      const cal = { kind, timer: null, total: kind === 'accel' ? this.accCalMs : this.magCalMs, start: 0 };
      cal.promise = new Promise((resolve) => { cal.resolve = resolve; });
      this._cal = cal;
      const r = await this._request(kind === 'accel' ? MSP.MSP_ACC_CALIBRATION : MSP.MSP_MAG_CALIBRATION, null, { timeoutMs: 1000, retries: 1 });
      if (this._cal !== cal) return cal.promise;
      if (!r.ok) { this._cal = null; this._emit('calibration', { kind, state: 'failed', percent: 0, text: r.error }); return { ok: false, error: r.error }; }
      cal.start = Date.now();
      const text = kind === 'accel' ? 'Keep the craft level and still' : 'Rotate the craft around all axes';
      this._emit('calibration', { kind, state: 'started', percent: 0, text });
      const step = clamp(Math.round(cal.total / 20), 50, 1000);
      cal.timer = this._every(() => {
        const el = Date.now() - cal.start;
        if (el >= cal.total) { this._calFinish('done', { ok: true }, kind === 'accel' ? 'Accelerometer calibrated' : 'Compass calibration finished'); return; }
        this._emit('calibration', { kind, state: 'progress', percent: Math.min(99, Math.round(el / cal.total * 100)), text });
      }, step);
      return cal.promise;
    };
    return run().catch((err) => ({ ok: false, error: 'error', detail: String((err && err.message) || err) }));
  }

  _calFinish(state, result, text) {
    const cal = this._cal;
    if (!cal) return;
    this._cancel(cal.timer);
    this._cal = null;
    this._emit('calibration', { kind: cal.kind, state, percent: state === 'done' ? 100 : null, text: text || '' });
    cal.resolve(result);
  }

  // ---- Durum türetme ----
  _applyStatus(boxBits, armFlags, armCount) {
    const ids = this.boxIds;
    const active = [];
    let armed = false;
    const modeNames = [];
    let primary = false;
    const n = ids ? ids.length : 1;
    for (let i = 0; i < n; i++) {
      if (!boxBits(i)) continue;
      const id = ids ? ids[i] : BF.BOX_ARM; // kutu listesi yoksa: ilk kutu her zaman ARM'dır
      if (id === BF.BOX_ARM) { armed = true; continue; }
      active.push((this.boxNames && this.boxNames[i]) || BF.BOX_NAMES[id] || `BOX${id}`);
      if (BF.MODE_BOXES[id]) { modeNames.push(BF.MODE_BOXES[id]); if (BF.PRIMARY_MODE_BOXES.has(id)) primary = true; }
    }
    if (!primary) modeNames.unshift('ACRO');
    const wasArmed = this.armed;
    this.armed = armed;
    this.boxes = active;
    this.mode = modeNames.join('+');
    // Betaflight ev konumunu kurulurken alır
    const t = this.telemetry;
    if (armed && !wasArmed && t.gpsFix >= 3 && t.lat !== null) { t.homeLat = t.lat; t.homeLon = t.lon; this._homeFromArm = true; }

    const prev = this.armingFlags;
    this.armingFlags = armFlags;
    this.armingFlagCount = armCount;
    this.armingDisabled = BF.armingFlagNames(armFlags, armCount, this.apiMinor);
    if (prev !== armFlags) {
      // Motor testi için kendi koyduğumuz MSP engeli bildirim konusu değildir
      const own = (1 << BF.ARMING_BIT.MSP) >>> 0;
      const quiet = prev !== null && ((prev ^ armFlags) >>> 0) === own && (this._motor || !(armFlags & own));
      if (!quiet) {
        if (this.armingDisabled.length) this._statusText(4, `Arming disabled: ${this.armingDisabled.join(', ')}`);
        else if (prev !== null) this._statusText(6, 'Arming allowed');
      }
      this._touch(true);
    }
    if (armed !== wasArmed) this._touch(true);
  }
}

// ---- MSP yanıtları (this = araç; r = Reader). Dönen nesne günlükte "anahtar=değer" olarak gösterilir ----
const HANDLERS = {
  [MSP.MSP_API_VERSION](r) {
    const proto = r.u8(); const major = r.u8(); const minor = r.u8();
    this.apiVersion = `${major}.${minor}`;
    this.apiMinor = major === 1 ? minor : major * 100 + minor;
    return { protocol: proto, api: this.apiVersion };
  },
  [MSP.MSP_FC_VARIANT](r) {
    this.variant = r.str(4);
    return { variant: this.variant };
  },
  [MSP.MSP_FC_VERSION](r) {
    const a = r.u8(); const b = r.u8(); const c = r.u8();
    // API 1.47+ (2025.12 ve sonrası): yıl-2000, ay, yama + sürüm metni
    let text = r.left > 1 ? r.pstr() : '';
    if (!/^\d+\.\d+/.test(text)) text = a >= 25 ? `${2000 + a}.${b}.${c}` : `${a}.${b}.${c}`;
    this.version = text;
    return { version: text };
  },
  [MSP.MSP_BOARD_INFO](r) {
    const id = r.str(4);
    const hwRev = r.u16();
    const boardType = r.u8();
    const caps = r.u8();
    const target = r.pstr();
    const boardName = r.pstr();
    const manufacturer = r.pstr();
    r.bytes(32); // imza
    const mcu = r.u8();
    const configState = r.u8();
    const sampleRate = r.u16();
    const problems = r.u32();
    this.boardInfo = { identifier: id, target, boardName, manufacturer, hardwareRevision: hwRev, boardType, capabilities: caps, mcuTypeId: mcu, configurationState: configState, gyroSampleRateHz: sampleRate, configurationProblems: problems };
    this.board = boardName || target || id;
    return { id, target, board: boardName, manufacturer, problems };
  },
  [MSP.MSP_BUILD_INFO](r) {
    const date = r.str(11); const time = r.str(8); const rev = r.str(7);
    this.buildInfo = { date, time, revision: rev };
    return { date, time, rev };
  },
  [MSP.MSP_NAME](r, payload) {
    this.craftName = payload.toString('latin1').replace(/\0.*$/, '');
    return { name: this.craftName };
  },
  [MSP.MSP_UID](r) {
    const a = r.u32(); const b = r.u32(); const c = r.u32();
    this.uid = [a, b, c].map((v) => v.toString(16).padStart(8, '0')).join('');
    return { uid: this.uid };
  },
  [MSP.MSP_FEATURE_CONFIG](r) {
    this.features = r.u32();
    return { features: `0x${this.features.toString(16)}` };
  },
  [MSP.MSP_MIXER_CONFIG](r) {
    this.mixerMode = r.u8();
    this.yawReversed = r.u8() !== 0;
    if (this._identified) this._deriveFrame();
    return { mixer: this.mixerMode, yaw_motors_reversed: this.yawReversed ? 1 : 0 };
  },
  [MSP.MSP_MOTOR_CONFIG](r) {
    const minThrottle = r.u16(); const maxThrottle = r.u16(); const minCommand = r.u16();
    const motorCount = r.u8(); const poles = r.u8(); const dshotTelemetry = r.u8(); const escSensor = r.u8();
    this.motorCfg = { minThrottle, maxThrottle, minCommand, motorCount, motorPoles: poles, dshotTelemetry: !!dshotTelemetry, escSensor: !!escSensor };
    return { min_throttle: minThrottle, max_throttle: maxThrottle, min_command: minCommand, motors: motorCount, poles };
  },
  [MSP.MSP_ADVANCED_CONFIG](r, payload) {
    if (payload.length < 4) return { len: payload.length };
    r.u8(); const pidDenom = r.u8(); r.u8();
    this.motorProtocol = r.u8();
    const rate = r.u16();
    return { pid_denom: pidDenom, protocol: BF.MOTOR_PROTOCOLS[this.motorProtocol] || this.motorProtocol, pwm_rate: rate };
  },
  [MSP.MSP_MOTOR_3D_CONFIG](r) {
    const low = r.u16(); const high = r.u16(); const neutral = r.u16();
    this.motor3d = { deadbandLow: low, deadbandHigh: high, neutral };
    return { low, high, neutral };
  },
  [MSP.MSP_BATTERY_CONFIG](r, payload) {
    const minCell = r.u8() / 10; const maxCell = r.u8() / 10; const warnCell = r.u8() / 10;
    const capacity = r.u16(); const vSource = r.u8(); const iSource = r.u8();
    const cfg = { minCell, maxCell, warnCell, capacity, voltageMeterSource: vSource, currentMeterSource: iSource };
    if (payload.length >= 13) { cfg.minCell = r.u16() / 100; cfg.maxCell = r.u16() / 100; cfg.warnCell = r.u16() / 100; }
    this.batteryCfg = cfg;
    return { min_cell: cfg.minCell, max_cell: cfg.maxCell, warn_cell: cfg.warnCell, capacity };
  },
  [MSP.MSP_BOXIDS](r, payload) { return { ids: [...payload] }; },
  [MSP.MSP_BOXNAMES](r, payload) { return { names: payload.toString('latin1') }; },
  [MSP.MSP_STATUS_EX](r, payload) {
    const cycle = r.u16(); const i2c = r.u16(); const sensors = r.u16();
    const flags = r.u32(); const profile = r.u8(); const load = r.u16();
    r.u8(); const rateProfile = r.u8();
    const extraCount = r.u8() & 0x0f;
    const extra = r.bytes(extraCount);
    const armCount = r.u8(); const armFlags = r.u32();
    const cfgState = r.u8();
    const hasTemp = payload.length >= r.o + 2;
    const cpuTemp = hasTemp ? r.u16() : null;
    this.sensorBits = sensors;
    this.rebootRequired = (cfgState & 1) !== 0;
    this.telemetry.load = load;
    this.telemetry.time = Date.now();
    const bit = (i) => (i < 32 ? ((flags >>> i) & 1) !== 0 : ((extra[(i - 32) >> 3] || 0) >> ((i - 32) & 7) & 1) !== 0);
    this._applyStatus(bit, armFlags, armCount);
    const out = { cycle, i2c_errors: i2c, sensors, mode_flags: `0x${flags.toString(16)}`, profile, rate_profile: rateProfile, load, arming_disable: `0x${armFlags.toString(16)}` };
    if (cpuTemp !== null) out.cpu_temp = cpuTemp;
    return out;
  },
  [MSP.MSP_ATTITUDE](r) {
    const roll = r.i16() / 10; const pitch = r.i16() / 10; const yaw = r.i16();
    const t = this.telemetry;
    t.roll = roll;
    t.pitch = -pitch + 0; // Betaflight'ta + yunuslama burun aşağıdır (telemetry/mavlink.c de ters çevirir)
    t.yaw = ((yaw % 360) + 360) % 360;
    t.heading = t.yaw;
    t.time = Date.now();
    return { roll, pitch, yaw };
  },
  [MSP.MSP_ALTITUDE](r) {
    const alt = r.i32() / 100; const vario = r.i16() / 100;
    this.telemetry.altRel = alt;
    this.telemetry.climb = vario;
    return { alt, vario };
  },
  [MSP.MSP_ANALOG](r, payload) {
    const legacy = r.u8() / 10; const mah = r.u16(); const rssi = r.u16(); const amps = r.i16() / 100;
    const volts = payload.length >= 9 ? r.u16() / 100 : legacy;
    const t = this.telemetry;
    t.voltage = volts;
    t.current = amps;
    t.mahDrawn = mah;
    t.rssi = Math.round(rssi / 1023 * 100); // 0–1023 → yüzde
    this._battery();
    return { voltage: volts, mah, rssi, amps };
  },
  [MSP.MSP_BATTERY_STATE](r, payload) {
    const cells = r.u8(); const capacity = r.u16(); const legacy = r.u8() / 10; const mah = r.u16(); const amps = r.i16() / 100; const state = r.u8();
    const volts = payload.length >= 11 ? r.u16() / 100 : legacy;
    const t = this.telemetry;
    t.cells = cells || null;
    t.voltage = volts;
    t.current = amps;
    t.mahDrawn = mah;
    if (this.batteryCfg) this.batteryCfg.capacity = capacity; else this.batteryCfg = { capacity, minCell: 3.3, maxCell: 4.3, warnCell: 3.5 };
    this._battery();
    return { cells, capacity, voltage: volts, mah, amps, state };
  },
  [MSP.MSP_RC](r, payload) {
    const rc = [];
    for (let i = 0; i + 1 < payload.length && i < 36; i += 2) rc.push(payload.readUInt16LE(i));
    const t = this.telemetry;
    t.rc = rc;
    // MSP_RC sırası her zaman AETR'dir (yatış, yunuslama, sapma, gaz): gaz 4. kanal
    if (rc.length >= 4) t.throttle = clamp(Math.round((rc[3] - 1000) / 10), 0, 100);
    return { ch: rc };
  },
  [MSP.MSP_MOTOR](r, payload) {
    const out = [];
    for (let i = 0; i + 1 < payload.length && i < 16; i += 2) out.push(payload.readUInt16LE(i));
    const n = this._motorCount();
    this.telemetry.servo = this.motorCfg || this.frame ? out.slice(0, Math.max(n, 1)) : out;
    return { motor: out };
  },
  [MSP.MSP_RAW_GPS](r, payload) {
    const fix = r.u8(); const sats = r.u8(); const lat = r.i32() / 1e7; const lon = r.i32() / 1e7;
    const alt = r.u16(); const speed = r.u16() / 100; const course = r.u16() / 10;
    const pdop = payload.length >= 18 ? r.u16() / 100 : null;
    const hdop = payload.length >= 20 ? r.u16() / 100 : null; // API 1.49+
    const t = this.telemetry;
    t.gpsFix = fix ? 3 : 1;
    t.gpsFixName = fix ? '3D_FIX' : 'NO_FIX';
    t.sats = sats;
    t.hdop = hdop !== null ? hdop : pdop; // eski sürümler yalnızca PDOP verir
    if (fix) { t.lat = lat; t.lon = lon; t.altMsl = alt; t.groundspeed = speed; }
    return { fix, sats, lat, lon, alt, speed, course, pdop };
  },
  [MSP.MSP_COMP_GPS](r) {
    const dist = r.u16(); const dir = r.i16(); const update = r.u8();
    const t = this.telemetry;
    t.homeDist = dist;
    t.homeDir = dir;
    // Ev konumu doğrudan verilmez: uzaklık ve yönden kestirilir (kurulurken alınan konum varsa o kullanılır)
    if (!this._homeFromArm && dist > 0 && t.gpsFix >= 3 && t.lat !== null) {
      const b = dir * Math.PI / 180;
      t.homeLat = round(t.lat + (dist * Math.cos(b)) / 111320, 7);
      t.homeLon = round(t.lon + (dist * Math.sin(b)) / (111320 * Math.max(0.01, Math.cos(t.lat * Math.PI / 180))), 7);
    }
    return { home_dist: dist, home_dir: dir, update };
  },
};

// Batarya yüzdesi: kapasite biliniyorsa tüketimden, yoksa hücre geriliminden (hücre sayısı biliniyorsa)
BfVehicle.prototype._battery = function _battery() {
  const t = this.telemetry;
  const cfg = this.batteryCfg;
  let pct = null;
  if (cfg && cfg.capacity > 0 && t.mahDrawn !== null) pct = 100 * (1 - t.mahDrawn / cfg.capacity);
  else if (cfg && t.cells && t.voltage && cfg.maxCell > cfg.minCell) pct = 100 * (t.voltage / t.cells - cfg.minCell) / (cfg.maxCell - cfg.minCell);
  t.batteryPct = pct === null ? null : clamp(Math.round(pct), 0, 100);
};

module.exports = { BfVehicle, parseGetOutput, parseDumpOutput, cleanCliOutput };
