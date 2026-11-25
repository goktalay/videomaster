'use strict';

// Telemetri kaydı ve oynatma.
//   Kayıt: dron bağlanınca (araçtan veri gelmeye başlayınca) yeni bir dosya açılır, bağlantı kesilince kapanır; yeniden
//   bağlanınca yeni dosya başlar. Dosya: <klasör>/<dronId>/<YYYYAAGG-SSDDSS>.vmlog.gz — gzip'li, satır başına bir JSON.
//     1. satır  { v: 1, kind: 'vmlog', drone: { id, name, firmware }, startedAt }
//     durum     { t, s: <tam durum> }            ilk kayıt ve aracın değişmeyen bilgileri değiştiğinde
//     telemetri { t, m: <telemetri>, a: kurulu mu, o: kip, y: sistem durumu }
//     ileti     { t, x: { severity, severityName, text } }
//   Oynatma: ReplayVehicle kaydı gerçek araç gibi sunar (state / statustext olayları), böylece uçuş penceresi kaydı
//   canlı uçuş gibi gösterir; duraklatma, hız ve ileri-geri sarma destekler.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const EXT = '.vmlog.gz';
const MIN_GAP_MS = 90;      // en çok ~10 kayıt/sn
const MIN_KEEP_MS = 2000;   // bundan kısa kayıtlar saklanmaz
const safeId = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'drone';
const p2 = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`; };

// Kayıtta tutulmayan (büyük ya da anlık) alanlar
function slim(state) {
  const { stats, params, ...rest } = state; // eslint-disable-line no-unused-vars
  return rest;
}
// Aracın seyrek değişen bilgileri değişti mi? (değişince tam durum yeniden yazılır)
const staticKey = (s) => [s.firmware, s.vehicle, s.sysid, s.version && s.version.text, s.frame && s.frame.name, (s.modes || []).length, s.link].join('|');

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371000; const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// opts: { dir: () => kök klasör, now: () => ms }
function createFlightLog(opts) {
  const now = opts.now || Date.now;
  const active = new Map(); // dronId → kayıt
  const metaCache = new Map();
  const dirOf = (droneId) => path.join(opts.dir(), safeId(droneId));

  function start(id, drone) {
    const startedAt = now();
    const dir = dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, `${stamp(startedAt)}${EXT}`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${stamp(startedAt)}-${n}${EXT}`);
    const gz = zlib.createGzip({ level: 6 });
    const out = fs.createWriteStream(file);
    gz.on('error', () => {}); out.on('error', () => {});
    gz.pipe(out);
    const rec = { file, gz, out, startedAt, last: -Infinity, key: '', lines: 0, flushAt: startedAt, done: null };
    rec.done = new Promise((resolve) => { out.on('close', resolve); out.on('error', resolve); });
    gz.write(`${JSON.stringify({ v: 1, kind: 'vmlog', drone: { id, name: (drone && drone.name) || '', firmware: (drone && drone.firmware) || '' }, startedAt })}\n`);
    active.set(id, rec);
    return rec;
  }

  function write(rec, obj) {
    rec.gz.write(`${JSON.stringify(obj)}\n`);
    rec.lines++;
    const t = now();
    // Program beklenmedik biçimde kapanırsa o ana kadarki veri okunabilsin
    if (t - rec.flushAt > 3000) { rec.flushAt = t; try { rec.gz.flush(zlib.constants.Z_SYNC_FLUSH); } catch { /* kapanıyor */ } }
  }

  // Aracın her durum bildiriminde çağrılır
  function state(id, drone, st) {
    let rec = active.get(id);
    if (!st || !st.linked) { if (rec) close(id); return; }
    if (!rec) rec = start(id, drone);
    const t = now() - rec.startedAt;
    const key = staticKey(st);
    if (key !== rec.key) { rec.key = key; rec.last = t; rec.armed = st.armed; rec.mode = st.mode; write(rec, { t, s: slim(st) }); return; }
    // Kurma ve kip değişimleri aralık beklemeden yazılır
    if (t - rec.last < MIN_GAP_MS && st.armed === rec.armed && st.mode === rec.mode) return;
    rec.last = t; rec.armed = st.armed; rec.mode = st.mode;
    write(rec, { t, m: st.telemetry, a: !!st.armed, o: st.mode, y: st.systemStatus });
  }

  function text(id, m) {
    const rec = active.get(id);
    if (rec && m && m.text) write(rec, { t: now() - rec.startedAt, x: { severity: m.severity, severityName: m.severityName, text: m.text } });
  }

  function close(id) {
    const rec = active.get(id);
    if (!rec) return Promise.resolve(null);
    active.delete(id);
    const dur = now() - rec.startedAt;
    rec.gz.end();
    return rec.done.then(() => {
      if (dur < MIN_KEEP_MS || rec.lines < 2) { try { fs.rmSync(rec.file, { force: true }); } catch { /* yok */ } return null; }
      return rec.file;
    });
  }
  const closeAll = () => Promise.all([...active.keys()].map(close));

  // Yarım kalmış (program kapanırken kesilmiş) dosyalar da okunur
  function parse(file) {
    const raw = zlib.gunzipSync(fs.readFileSync(file), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
    let header = null;
    const records = []; const texts = [];
    let cur = null;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; } // son satır yarım olabilir
      if (o.kind === 'vmlog') { header = o; continue; }
      if (o.x) { texts.push({ t: o.t, ...o.x }); continue; }
      if (o.s) cur = o.s;
      else if (o.m && cur) cur = { ...cur, telemetry: o.m, armed: !!o.a, mode: o.o, systemStatus: o.y };
      else continue;
      records.push({ t: o.t, state: cur });
    }
    if (!header) throw new Error('not a vmlog file');
    return { header, records, texts, durationMs: records.length ? records[records.length - 1].t : 0 };
  }

  function meta(file) {
    const st = fs.statSync(file);
    const key = `${file}|${st.size}|${st.mtimeMs}`;
    if (metaCache.has(key)) return metaCache.get(key);
    let m;
    try {
      const log = parse(file);
      let armedMs = 0; let maxAlt = 0; let dist = 0; let prev = null;
      for (const r of log.records) {
        const x = r.state.telemetry || {};
        if (prev && prev.state.armed) armedMs += r.t - prev.t;
        if (Number.isFinite(x.altRel) && x.altRel > maxAlt) maxAlt = x.altRel;
        const px = prev && prev.state.telemetry;
        if (px && Number.isFinite(x.lat) && Number.isFinite(px.lat) && (x.lat || x.lon) && (px.lat || px.lon)) { const d = distance(px.lat, px.lon, x.lat, x.lon); if (d < 500) dist += d; }
        prev = r;
      }
      m = { file: path.basename(file), size: st.size, startedAt: log.header.startedAt, durationMs: log.durationMs, armedMs, maxAlt: Math.round(maxAlt * 10) / 10, distance: Math.round(dist), records: log.records.length, name: log.header.drone.name };
    } catch { m = { file: path.basename(file), size: st.size, startedAt: st.mtimeMs, durationMs: 0, broken: true }; }
    metaCache.set(key, m);
    return m;
  }

  // Bir dronun kayıtları, yeniden eskiye. Süren kayıt listede "recording" olarak görünür.
  function list(droneId) {
    const dir = dirOf(droneId);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(EXT)); } catch { names = []; }
    const rec = active.get(droneId);
    if (rec && !names.includes(path.basename(rec.file))) names.push(path.basename(rec.file)); // dosya diske henüz açılmamış olabilir
    return names.map((n) => {
      const file = path.join(dir, n);
      if (rec && rec.file === file) return { file: n, size: 0, startedAt: rec.startedAt, durationMs: now() - rec.startedAt, recording: true };
      return meta(file);
    }).sort((a, b) => b.startedAt - a.startedAt);
  }

  // Dosya adı yalnızca o dronun klasörü içinde çözülür
  function resolve(droneId, name) {
    const base = path.basename(String(name || ''));
    if (!base.endsWith(EXT)) return null;
    const file = path.join(dirOf(droneId), base);
    return fs.existsSync(file) ? file : null;
  }
  function read(droneId, name) { const file = resolve(droneId, name); return file ? parse(file) : null; }
  function remove(droneId, name) {
    const file = resolve(droneId, name);
    const rec = active.get(droneId);
    if (!file || (rec && rec.file === file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }

  return { state, text, close, closeAll, list, read, remove, dirOf, parse, isRecording: (id) => active.has(id) };
}

// Kaydı gerçek araç gibi oynatır
class ReplayVehicle extends EventEmitter {
  constructor(log, opts = {}) {
    super();
    this.isReplay = true;
    this.log = log;
    this.tickMs = opts.tickMs || 50;
    this.pos = 0; this.speed = opts.speed || 1; this.playing = false; this.connected = false;
    this.idx = -1; this.textIdx = 0; this.timer = null; this.lastTick = 0;
  }

  get duration() { return this.log.durationMs; }

  connect() {
    this.connected = true;
    this._apply();
    this.replayPlay(true);
    return Promise.resolve({ ok: true });
  }

  disconnect() { this.connected = false; this.playing = false; clearInterval(this.timer); this.timer = null; }

  snapshot() {
    const rec = this.log.records[Math.max(0, this.idx)];
    const base = rec ? rec.state : { telemetry: {}, modes: [] };
    return {
      ...base, connected: this.connected, linked: this.connected && !!rec, error: null, link: 'log',
      replay: { pos: Math.round(this.pos), duration: this.duration, playing: this.playing, speed: this.speed, startedAt: this.log.header.startedAt, name: this.log.header.drone.name },
    };
  }

  getParams() { return []; }

  // Konuma karşılık gelen kaydı bulur ve durumu yayar
  _apply() {
    const r = this.log.records;
    let i = Math.max(0, this.idx);
    if (i >= r.length || (r[i] && r[i].t > this.pos)) i = 0;
    while (i + 1 < r.length && r[i + 1].t <= this.pos) i++;
    this.idx = i;
    const tx = this.log.texts;
    while (this.textIdx < tx.length && tx[this.textIdx].t <= this.pos) { const m = tx[this.textIdx++]; this.emit('statustext', { severity: m.severity, severityName: m.severityName, text: m.text, t: this.log.header.startedAt + m.t }); }
    this.emit('state', this.snapshot());
  }

  _tick() {
    const t = Date.now();
    const dt = t - this.lastTick;
    this.lastTick = t;
    this.pos = Math.min(this.duration, this.pos + dt * this.speed);
    if (this.pos >= this.duration) { this.playing = false; clearInterval(this.timer); this.timer = null; }
    this._apply();
  }

  replayPlay(on = true) {
    const want = !!on;
    if (want && this.pos >= this.duration) { this.pos = 0; this.idx = -1; this.textIdx = 0; }
    this.playing = want && this.connected && this.duration > 0;
    clearInterval(this.timer); this.timer = null;
    if (this.playing) { this.lastTick = Date.now(); this.timer = setInterval(() => this._tick(), this.tickMs); }
    this.emit('state', this.snapshot());
    return { ok: true, ...this._path() };
  }

  replaySpeed(x) {
    const v = Number(x);
    if (!(v > 0) || v > 64) return { ok: false, error: 'invalid' };
    this.speed = v;
    this.emit('state', this.snapshot());
    return { ok: true };
  }

  // Konuma atlar; o ana kadarki iz (harita için) sonuçla birlikte döner
  replaySeek(ms) {
    this.pos = Math.max(0, Math.min(this.duration, Number(ms) || 0));
    this.idx = -1;
    const tx = this.log.texts;
    this.textIdx = 0;
    while (this.textIdx < tx.length && tx[this.textIdx].t <= this.pos) this.textIdx++; // geçmiş iletiler yeniden gösterilmez
    this.lastTick = Date.now();
    this._apply();
    return { ok: true, ...this._path() };
  }

  _path() {
    const pts = [];
    let last = null;
    for (const r of this.log.records) {
      if (r.t > this.pos) break;
      const x = r.state.telemetry || {};
      if (!Number.isFinite(x.lat) || !Number.isFinite(x.lon) || (!x.lat && !x.lon)) continue;
      const alt = Number.isFinite(x.altRel) ? x.altRel : 0;
      if (last && distance(last[1], last[0], x.lat, x.lon) < 0.7 && Math.abs(last[2] - alt) < 0.7) continue;
      last = [x.lon, x.lat, alt];
      pts.push(last);
    }
    return { path: pts.length > 20000 ? pts.slice(-20000) : pts };
  }
}

module.exports = { createFlightLog, ReplayVehicle, EXT };
