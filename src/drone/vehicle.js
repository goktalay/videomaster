'use strict';

// MAVLink araç oturumu (ana süreç; bağlı her dron için bir tane). ArduPilot ve PX4 ile konuşur:
// kalp atışı, veri akışı istekleri, telemetri özeti, parametreler, komutlar, motor testi, kalibrasyonlar.
//
//   const v = new MavVehicle({ type: 'udpin', localPort: 14550 }, { gcsSysid: 255, firmwareHint: 'ardupilot', streamRate: 4 });
//   await v.connect();            → { ok } | { ok:false, error }
//   v.snapshot();                 → durum özeti (düz nesne; pencerelere olduğu gibi gönderilebilir)
//
// Olaylar:
//   'state'(snapshot)             en çok 5 Hz
//   'message'(msg)                çözülen her ileti (mavlink.js biçimi)
//   'log'([{ t, dir, sysid, compid, id, name, text }])   gelen ve giden TÜM iletiler, en çok 10 Hz toplu
//   'statustext'({ severity, severityName, text, t })    çok parçalı metinler birleştirilmiş
//   'params'({ total, received, loading, done })         parametre indirme ilerlemesi
//   'param'({ name, value, type, index })                her PARAM_VALUE
//   'calibration'({ kind, state, text, position?, positionName?, percent?, compass? })
//   'error'(err)                  bağlantı hataları (err.code)
// Söz verilen (Promise) dönen bütün işlevler reddetmez; { ok:false, error } ile çözülür.

const { EventEmitter } = require('events');
const mav = require('./mavlink');
const { createLink } = require('./link');
const MOTOR_LAYOUTS = require('./motorlayouts.json').layouts;

const { MavParser, encode, ENUMS, COMMANDS, COMMAND_IDS, enumName } = mav;

// ---- MAVLink sabitleri (mavdefs.json'daki adlarla aynı değerler) ----
const MAV_AUTOPILOT_ARDUPILOT = 3;
const MAV_AUTOPILOT_INVALID = 8;
const MAV_AUTOPILOT_PX4 = 12;
const MAV_TYPE_GCS = 6;
const MAV_MODE_FLAG_CUSTOM = 1;
const MAV_MODE_FLAG_ARMED = 128;
const MAV_RESULT_ACCEPTED = 0;
const MAV_RESULT_UNSUPPORTED = 3;
const MAV_RESULT_IN_PROGRESS = 5;
const PARAM_INDEX_NONE = 65535;

const CMD = {
  SET_MESSAGE_INTERVAL: 511,
  REQUEST_MESSAGE: 512,
  REQUEST_AUTOPILOT_CAPABILITIES: 520,
  DO_SET_MODE: 176,
  DO_SET_HOME: 179,
  DO_MOTOR_TEST: 209,
  ACTUATOR_TEST: 310,
  PREFLIGHT_CALIBRATION: 241,
  PREFLIGHT_REBOOT_SHUTDOWN: 246,
  COMPONENT_ARM_DISARM: 400,
  DO_START_MAG_CAL: 42424,
  DO_ACCEPT_MAG_CAL: 42425,
  DO_CANCEL_MAG_CAL: 42426,
  ACCELCAL_VEHICLE_POS: 42429,
};

const MSG_ID = { SYS_STATUS: 1, GPS_RAW_INT: 24, ATTITUDE: 30, GLOBAL_POSITION_INT: 33, SERVO_OUTPUT_RAW: 36, NAV_CONTROLLER_OUTPUT: 62, RC_CHANNELS: 65, VFR_HUD: 74, BATTERY_STATUS: 147, AUTOPILOT_VERSION: 148, ESTIMATOR_STATUS: 230, VIBRATION: 241, HOME_POSITION: 242, EXTENDED_SYS_STATE: 245 };

// ArduPilot'un zorla kurma/çözme sihirli değerleri (GCS_MAVLink/GCS.h): 2989 = kontrolleri atlayarak kur, 21196 = zorla kur/çöz
const FORCE_ARM_ARDUPILOT = 2989;
const FORCE_ARM_DISARM = 21196;

const ACCEL_POS_SUCCESS = 16777215;
const ACCEL_POS_FAILED = 16777216;
const ACCEL_POS_NAMES = { 1: 'LEVEL', 2: 'LEFT', 3: 'RIGHT', 4: 'NOSEDOWN', 5: 'NOSEUP', 6: 'BACK' };

const MAG_CAL_SUCCESS = 4;
const MAG_CAL_FAILED = 5;

// ---- Uçuş kipi tabloları (custom_mode → ad). Kaynak: ArduPilot <araç>/mode.h ve pymavlink mavutil ----
const MODES_COPTER = { 0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 5: 'LOITER', 6: 'RTL', 7: 'CIRCLE', 9: 'LAND', 11: 'DRIFT', 13: 'SPORT', 14: 'FLIP', 15: 'AUTOTUNE', 16: 'POSHOLD', 17: 'BRAKE', 18: 'THROW', 19: 'AVOID_ADSB', 20: 'GUIDED_NOGPS', 21: 'SMART_RTL', 22: 'FLOWHOLD', 23: 'FOLLOW', 24: 'ZIGZAG', 25: 'SYSTEMID', 26: 'AUTOROTATE', 27: 'AUTO_RTL', 28: 'TURTLE' };
const MODES_PLANE = { 0: 'MANUAL', 1: 'CIRCLE', 2: 'STABILIZE', 3: 'TRAINING', 4: 'ACRO', 5: 'FBWA', 6: 'FBWB', 7: 'CRUISE', 8: 'AUTOTUNE', 10: 'AUTO', 11: 'RTL', 12: 'LOITER', 13: 'TAKEOFF', 14: 'AVOID_ADSB', 15: 'GUIDED', 16: 'INITIALISING', 17: 'QSTABILIZE', 18: 'QHOVER', 19: 'QLOITER', 20: 'QLAND', 21: 'QRTL', 22: 'QAUTOTUNE', 23: 'QACRO', 24: 'THERMAL', 25: 'LOITERALTQLAND', 26: 'AUTOLAND', 27: 'GLIDE' };
const MODES_ROVER = { 0: 'MANUAL', 1: 'ACRO', 3: 'STEERING', 4: 'HOLD', 5: 'LOITER', 6: 'FOLLOW', 7: 'SIMPLE', 8: 'DOCK', 9: 'CIRCLE', 10: 'AUTO', 11: 'RTL', 12: 'SMART_RTL', 15: 'GUIDED', 16: 'INITIALISING' };
const MODES_SUB = { 0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 7: 'CIRCLE', 9: 'SURFACE', 16: 'POSHOLD', 19: 'MANUAL', 20: 'MOTOR_DETECT', 21: 'SURFTRAK' };
const MODES_TRACKER = { 0: 'MANUAL', 1: 'STOP', 2: 'SCAN', 3: 'SERVO_TEST', 4: 'GUIDED', 10: 'AUTO', 16: 'INITIALISING' };

// PX4: custom_mode = ana kip << 16 | alt kip << 24 (px4_custom_mode.h). Adlar QGroundControl'deki gibi.
const PX4_MODES = [
  [1, 0, 'Manual'], [7, 0, 'Stabilized'], [5, 0, 'Acro'], [2, 0, 'Altitude'], [3, 0, 'Position'], [3, 1, 'Orbit'], [3, 2, 'Position Slow'],
  [6, 0, 'Offboard'], [4, 1, 'Ready'], [4, 2, 'Takeoff'], [4, 3, 'Hold'], [4, 4, 'Mission'], [4, 5, 'Return'], [4, 6, 'Land'],
  [4, 8, 'Follow Me'], [4, 9, 'Precision Land'], [4, 10, 'VTOL Takeoff'], [10, 0, 'Termination'],
].map(([main, sub, name]) => ({ id: ((main << 16) | (sub << 24)) >>> 0, name, main, sub }));

// MAV_TYPE → araç sınıfı
const TYPE_CLASS = {
  1: 'plane', 2: 'copter', 3: 'copter', 4: 'heli', 10: 'rover', 11: 'rover', 12: 'sub', 13: 'copter', 14: 'copter', 15: 'copter',
  19: 'vtol', 20: 'vtol', 21: 'vtol', 22: 'vtol', 23: 'vtol', 24: 'vtol', 25: 'vtol', 29: 'copter', 35: 'copter',
};
// Araç sayılmayan bileşen türleri (yer istasyonu, anten izleyici hariç yardımcılar): kalp atışları yok sayılır
const NON_VEHICLE_TYPES = new Set([6, 18, 26, 27, 30, 31, 32, 33, 34, 36, 37, 38, 39, 40, 41, 42]);

const FRAME_CLASS_NAMES = { 0: 'UNDEFINED', 1: 'QUAD', 2: 'HEXA', 3: 'OCTA', 4: 'OCTAQUAD', 5: 'Y6', 6: 'HELI', 7: 'TRI', 8: 'SINGLE', 9: 'COAX', 10: 'TAILSITTER', 11: 'HELI_DUAL', 12: 'DODECAHEXA', 13: 'HELI_QUAD', 14: 'DECA', 15: 'SCRIPTING_MATRIX', 16: '6DOF_SCRIPTING', 17: 'DYNAMIC_SCRIPTING_MATRIX' };

const INT_PARAM_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8]); // MAV_PARAM_TYPE_UINT8 … INT64

const SENSOR_BITS = Object.keys(ENUMS.MAV_SYS_STATUS_SENSOR || {})
  .map((k) => ({ id: Number(k), name: ENUMS.MAV_SYS_STATUS_SENSOR[k].replace(/^MAV_SYS_STATUS_/, '') }))
  .filter((s) => s.id > 0 && s.id <= 0x80000000)
  .sort((a, b) => a.id - b.id);

const rad2deg = (r) => r * 180 / Math.PI;
const round = (v, d) => { const k = 10 ** d; return Math.round(v * k) / k; };
const shortName = (full, prefix) => (full ? full.replace(prefix, '') : null);

function emptyTelemetry() {
  return {
    roll: null, pitch: null, yaw: null, rollRate: null, pitchRate: null, yawRate: null,
    lat: null, lon: null, altMsl: null, altRel: null, vx: null, vy: null, vz: null,
    groundspeed: null, airspeed: null, climb: null, heading: null, throttle: null,
    voltage: null, current: null, batteryPct: null,
    gpsFix: null, gpsFixName: null, sats: null, hdop: null, rssi: null,
    rc: [], servo: [], homeLat: null, homeLon: null, homeAlt: null,
    wpDist: null, navBearing: null, load: null, vibration: null, ekfOk: null, time: null,
  };
}

// Günlük satırı için alanların kısa "anahtar=değer" gösterimi
function fmtValue(v) {
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    if (!Number.isFinite(v)) return String(v);
    const a = Math.abs(v);
    return String(a >= 1000 ? round(v, 2) : a >= 1 ? round(v, 3) : Number(v.toPrecision(4)));
  }
  if (typeof v === 'string') return /[\s=]/.test(v) || v === '' ? JSON.stringify(v) : v;
  if (Array.isArray(v)) return '[' + (v.length > 20 ? v.slice(0, 20).map(fmtValue).join(',') + ',…' : v.map(fmtValue).join(',')) + ']';
  if (Buffer.isBuffer(v)) return '0x' + v.toString('hex');
  return String(v);
}

function fmtFields(fields) {
  if (!fields) return '';
  const parts = [];
  for (const k of Object.keys(fields)) parts.push(`${k}=${fmtValue(fields[k])}`);
  return parts.join(' ');
}

function resolveCommand(nameOrId) {
  if (typeof nameOrId === 'number') return Number.isFinite(nameOrId) ? nameOrId : null;
  const s = String(nameOrId || '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  const up = s.toUpperCase();
  if (up in COMMAND_IDS) return COMMAND_IDS[up];
  if (('MAV_CMD_' + up) in COMMAND_IDS) return COMMAND_IDS['MAV_CMD_' + up];
  return null;
}

class MavVehicle extends EventEmitter {
  constructor(linkCfg, opts = {}) {
    super();
    this.linkCfg = { ...(linkCfg || {}) };
    this.opts = opts || {};
    this.gcsSysid = Number(this.opts.gcsSysid) || 255;
    this.gcsCompid = Number(this.opts.gcsCompid) || 190;
    this.firmwareHint = ['ardupilot', 'px4'].includes(this.opts.firmwareHint) ? this.opts.firmwareHint : null;
    this.streamRate = Math.min(50, Math.max(1, Number(this.opts.streamRate) || 4));
    this.linkTimeoutMs = Number(this.opts.linkTimeoutMs) || 3500;
    this.paramGapMs = Number(this.opts.paramGapMs) || 1500;

    this.link = null;
    this.parser = new MavParser();
    this.timers = new Set();
    this.on('error', () => {}); // dinleyici yoksa süreç düşmesin
    this._reset();
  }

  _reset() {
    this.connected = false;
    this.linked = false;
    this.error = null;
    this.sysid = null;
    this.compid = null;
    this.mavType = null;
    this.autopilot = null;
    this.firmware = this.firmwareHint || 'unknown';
    this.vehicle = 'other';
    this.armed = false;
    this.mode = null;
    this.customMode = null;
    this.baseMode = 0;
    this.systemStatus = null;
    this.version = null;
    this.txVersion = 2;
    this.txSeq = 0;
    this.telemetry = emptyTelemetry();
    this.sensors = { present: null, enabled: null, health: null };
    this.params = new Map();
    this.paramIdx = new Set();
    this.paramTotal = 0;
    this.paramLoading = false;
    this.frame = null;
    this.stats = { rxBytes: 0, txBytes: 0, rxMsgs: 0, txMsgs: 0, lost: 0, msgRate: 0, byteRate: 0 };
    this._rate = { msgs: 0, bytes: 0, at: Date.now() };
    this._lastHb = 0;
    this._lastAttitude = 0;
    this._lastStreamReq = 0;
    this._gotPosition = false;
    this._logQueue = [];
    this._logTimer = null;
    this._stateTimer = null;
    this._lastState = 0;
    this._pendingCmd = new Map();   // komut kimliği → bekleyen
    this._cmdQueue = new Map();     // komut kimliği → sıra (aynı komut üst üste binmesin)
    this._paramWaiters = new Map(); // ad → Set(fn)
    this._paramChain = Promise.resolve();
    this._fetch = null;
    this._paramEmitAt = 0;
    this._cal = null;
    this._texts = new Map();        // "compid:id" → çok parçalı STATUSTEXT
    this._versionAsked = false;
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

  _fail(err) { try { this.emit('error', err); } catch { /* yok */ } }

  _emit(name, payload) { try { this.emit(name, payload); } catch { /* dinleyici hatası oturumu bozmasın */ } }

  get ready() { return !!(this.link && this.link.isOpen && this.sysid !== null); }

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
    this.parser = new MavParser();
    this.link = link;
    link.on('data', (d) => { try { this._onData(d); } catch (err) { this._fail(err); } });
    link.on('error', (err) => {
      if (this.link !== link) return;
      this.error = (err && err.code) || 'io';
      this._fail(err);
      this._touch();
    });
    link.on('open', () => { if (this.link === link) { this.error = null; this._sendHeartbeat(); this._touch(true); } });
    link.on('close', () => {
      if (this.link !== link) return;
      this._setLinked(false);
      if (!link.wanted) { this.connected = false; if (!this.error) this.error = 'link_closed'; }
      this._touch(true);
    });
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
    this._sendHeartbeat();
    this._tick = this._every(() => this._onTick(), 1000);
    this._touch(true);
    return { ok: true };
  }

  disconnect() {
    const link = this.link;
    this.link = null;
    this._clearTimers();
    // Bekleyen her şeyi sonuçlandır
    for (const p of this._pendingCmd.values()) p.finish({ ok: false, result: null, resultName: null, error: 'disconnected' });
    this._pendingCmd.clear();
    for (const set of this._paramWaiters.values()) for (const fn of [...set]) fn(null);
    this._paramWaiters.clear();
    if (this._fetch) this._fetch.finish(false, 'disconnected');
    if (this._cal) this._calFinish('cancelled', { ok: false, error: 'disconnected' });
    for (const t of this._texts.values()) clearTimeout(t.timer);
    this._texts.clear();
    if (link) { try { link.close(); } catch { /* yok */ } }
    this._flushLog();
    this._clearTimers(); // sonuçlandırma sırasında kurulmuş olabilecekler
    this.connected = false;
    this.linked = false;
    this.paramLoading = false;
    this._emit('state', this.snapshot());
  }

  _clearTimers() {
    for (const h of this.timers) { clearTimeout(h); clearInterval(h); }
    this.timers.clear();
    this._logTimer = null;
    this._stateTimer = null;
  }

  _setLinked(on) {
    if (this.linked === on) return;
    this.linked = on;
    if (on) this._requestStreams();
    this._touch(true);
  }

  _onTick() {
    const now = Date.now();
    this._sendHeartbeat();
    if (this.linked && now - this._lastHb > this.linkTimeoutMs) this._setLinked(false);
    // İstek kaybolmuş olabilir: bağlıyken konum/tutum akmıyorsa akışları yeniden iste
    if (this.linked && now - this._lastAttitude > 3000 && now - this._lastStreamReq > 5000) this._requestStreams();
    const dt = (now - this._rate.at) / 1000;
    if (dt > 0) {
      this.stats.msgRate = Math.round((this.stats.rxMsgs - this._rate.msgs) / dt);
      this.stats.byteRate = Math.round((this.stats.rxBytes - this._rate.bytes) / dt);
    }
    this._rate = { msgs: this.stats.rxMsgs, bytes: this.stats.rxBytes, at: now };
    this.stats.lost = this.parser.stats.lost;
    this._touch();
  }

  // ---- Gönderme ----
  _send(name, fields) {
    const link = this.link;
    if (!link || !link.isOpen) return false;
    let buf;
    const seq = this.txSeq;
    try {
      buf = encode(name, fields, { sysid: this.gcsSysid, compid: this.gcsCompid, seq, version: this.txVersion });
    } catch {
      // v1 ile gönderilemeyen ileti (kimlik > 255): v2 olarak dene
      try { buf = encode(name, fields, { sysid: this.gcsSysid, compid: this.gcsCompid, seq, version: 2 }); } catch { return false; }
    }
    if (!link.write(buf)) return false;
    this.txSeq = (this.txSeq + 1) & 0xff;
    this.stats.txBytes += buf.length;
    this.stats.txMsgs++;
    const def = mav.MESSAGES[name];
    this._log('tx', this.gcsSysid, this.gcsCompid, def ? def.id : -1, name, fields);
    return true;
  }

  _sendHeartbeat() {
    this._send('HEARTBEAT', { type: MAV_TYPE_GCS, autopilot: MAV_AUTOPILOT_INVALID, base_mode: 0, custom_mode: 0, system_status: 4, mavlink_version: 3 });
  }

  // Yanıt beklenmeyen komut (akış istekleri gibi)
  _sendCommand(id, p = []) {
    if (this.sysid === null) return false;
    return this._send('COMMAND_LONG', {
      target_system: this.sysid, target_component: this.compid, command: id, confirmation: 0,
      param1: p[0] || 0, param2: p[1] || 0, param3: p[2] || 0, param4: p[3] || 0, param5: p[4] || 0, param6: p[5] || 0, param7: p[6] || 0,
    });
  }

  _setInterval(msgId, hz) { this._sendCommand(CMD.SET_MESSAGE_INTERVAL, [msgId, hz > 0 ? Math.round(1e6 / hz) : -1]); }

  _requestStreams() {
    if (this.sysid === null) return;
    this._lastStreamReq = Date.now();
    const r = this.streamRate;
    if (this.firmware === 'px4') {
      const list = [
        [MSG_ID.ATTITUDE, 10], [MSG_ID.GLOBAL_POSITION_INT, r], [MSG_ID.VFR_HUD, r], [MSG_ID.SYS_STATUS, 2], [MSG_ID.GPS_RAW_INT, 2],
        [MSG_ID.RC_CHANNELS, r], [MSG_ID.SERVO_OUTPUT_RAW, r], [MSG_ID.BATTERY_STATUS, 1], [MSG_ID.HOME_POSITION, 0.5],
        [MSG_ID.NAV_CONTROLLER_OUTPUT, 2], [MSG_ID.VIBRATION, 1], [MSG_ID.ESTIMATOR_STATUS, 1],
      ];
      for (const [id, hz] of list) this._setInterval(id, hz);
    } else {
      // ArduPilot (ve bilinmeyenler): Mission Planner gibi her akış grubunu ayrı ayrı iste
      for (const stream of [1, 2, 3, 6, 10, 11, 12]) {
        this._send('REQUEST_DATA_STREAM', { target_system: this.sysid, target_component: this.compid, req_stream_id: stream, req_message_rate: r, start_stop: 1 });
      }
      this._setInterval(MSG_ID.ATTITUDE, 10);
    }
    if (!this.version) {
      this._sendCommand(CMD.REQUEST_MESSAGE, [MSG_ID.AUTOPILOT_VERSION]);
      if (!this._versionAsked) {
        this._versionAsked = true;
        // Eski yazılımlar REQUEST_MESSAGE'ı tanımaz: yanıt gelmezse eski komutla dene
        this._later(() => { if (!this.version && this.linked) this._sendCommand(CMD.REQUEST_AUTOPILOT_CAPABILITIES, [1]); }, 1500);
      }
    }
    if (this.telemetry.homeLat === null) this._sendCommand(CMD.REQUEST_MESSAGE, [MSG_ID.HOME_POSITION]);
  }

  // ---- Günlük ve durum yayını ----
  _log(dir, sysid, compid, id, name, fields, fallbackText) {
    if (this._logQueue.length > 4000) this._logQueue.splice(0, 2000); // dinleyen yoksa birikmesin
    this._logQueue.push({ t: Date.now(), dir, sysid, compid, id, name, text: fields ? fmtFields(fields) : (fallbackText || '') });
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

  modes() {
    if (this.firmware === 'px4') return PX4_MODES.map((m) => ({ id: m.id, name: m.name }));
    const table = this._modeTable();
    return table ? Object.keys(table).map((k) => ({ id: Number(k), name: table[k] })) : [];
  }

  _modeTable() {
    if (this.firmware !== 'ardupilot') return null;
    if (this.mavType === 5) return MODES_TRACKER;
    switch (this.vehicle) {
      case 'copter': case 'heli': return MODES_COPTER;
      case 'plane': case 'vtol': return MODES_PLANE;
      case 'rover': return MODES_ROVER;
      case 'sub': return MODES_SUB;
      default: return null;
    }
  }

  snapshot() {
    const s = this.sensors;
    const list = s.present === null ? [] : SENSOR_BITS.map((b) => ({
      id: b.id, name: b.name,
      present: (s.present & b.id) !== 0, enabled: (s.enabled & b.id) !== 0, healthy: (s.health & b.id) !== 0,
    }));
    return {
      connected: this.connected,
      linked: this.linked,
      link: this.link ? this.link.describe() : describeCfg(this.linkCfg),
      error: this.error,
      firmware: this.firmware,
      vehicle: this.vehicle,
      mavType: this.mavType,
      autopilot: this.autopilot,
      sysid: this.sysid,
      compid: this.compid,
      armed: this.armed,
      mode: this.mode,
      modes: this.modes(),
      systemStatus: this.systemStatus,
      version: this.version,
      telemetry: { ...this.telemetry, rc: this.telemetry.rc.slice(), servo: this.telemetry.servo.slice(), vibration: this.telemetry.vibration ? this.telemetry.vibration.slice() : null },
      sensors: { present: s.present, enabled: s.enabled, health: s.health, list },
      params: { total: this.paramTotal, received: this.paramIdx.size, loading: this.paramLoading },
      frame: this.frame,
      stats: { ...this.stats },
    };
  }

  // ---- Alma ----
  _onData(chunk) {
    this.stats.rxBytes += chunk.length;
    const msgs = this.parser.push(chunk);
    for (const msg of msgs) {
      this.stats.rxMsgs++;
      this._log('rx', msg.sysid, msg.compid, msg.msgid, msg.name, msg.fields, `len=${msg.raw.length}`);
      try { this._onMessage(msg); } catch (err) { this._fail(err); }
      this._emit('message', msg);
    }
    this.stats.lost = this.parser.stats.lost;
  }

  _onMessage(msg) {
    const f = msg.fields;
    if (!f) return;
    if (msg.name === 'HEARTBEAT') { this._onHeartbeat(msg); return; }
    if (this.sysid === null || msg.sysid !== this.sysid) return;
    if (msg.name === 'STATUSTEXT') { this._onStatusTextMsg(msg); return; } // aracın bütün bileşenlerinden
    if (msg.compid !== this.compid) return;
    const h = HANDLERS[msg.name];
    if (h) {
      h.call(this, f, msg);
      this._touch();
    }
  }

  _onHeartbeat(msg) {
    const f = msg.fields;
    if (msg.sysid === this.gcsSysid && msg.compid === this.gcsCompid) return; // kendi yankımız
    if (f.autopilot === MAV_AUTOPILOT_INVALID || NON_VEHICLE_TYPES.has(f.type)) return; // yer istasyonu, kamera, gimbal, ADSB…
    if (this.sysid === null) {
      this.sysid = msg.sysid;
      this.compid = msg.compid;
    } else if (msg.sysid !== this.sysid) {
      return; // başka bir araç: ilk bulunan izlenir
    } else if (msg.compid !== this.compid) {
      // Aynı araçta birden çok otopilot bileşeni varsa asıl otopilot (bileşen 1) yeğlenir
      if (msg.compid === 1) this.compid = 1; else return;
    }
    this.txVersion = msg.version;
    this.mavType = f.type;
    this.autopilot = f.autopilot;
    this.firmware = f.autopilot === MAV_AUTOPILOT_ARDUPILOT ? 'ardupilot' : f.autopilot === MAV_AUTOPILOT_PX4 ? 'px4' : (this.firmwareHint || 'unknown');
    this.vehicle = TYPE_CLASS[f.type] || 'other';
    this.baseMode = f.base_mode;
    this.customMode = f.custom_mode;
    const armed = (f.base_mode & MAV_MODE_FLAG_ARMED) !== 0;
    const mode = this._modeName(f.base_mode, f.custom_mode);
    const status = shortName(enumName('MAV_STATE', f.system_status), 'MAV_STATE_');
    const changed = armed !== this.armed || mode !== this.mode || status !== this.systemStatus;
    this.armed = armed;
    this.mode = mode;
    this.systemStatus = status;
    this._lastHb = Date.now();
    if (!this.linked) this._setLinked(true);
    this._touch(changed);
  }

  _modeName(baseMode, custom) {
    if (this.firmware === 'px4') {
      const main = (custom >>> 16) & 0xff;
      const sub = (custom >>> 24) & 0xff;
      const m = PX4_MODES.find((x) => x.main === main && x.sub === sub) || (main !== 4 && PX4_MODES.find((x) => x.main === main && x.sub === 0));
      if (m) return m.name;
      if (main === 4 && sub >= 11 && sub <= 18) return `External ${sub - 10}`;
      return `MODE_${main}_${sub}`;
    }
    const table = this._modeTable();
    if (table && table[custom]) return table[custom];
    return `MODE_${custom}`;
  }

  // ---- STATUSTEXT (çok parçalı metinler birleştirilir) ----
  _onStatusTextMsg(msg) {
    const f = msg.fields;
    // Metin baytları ham yükten alınır: parça sınırında bölünmüş çok baytlı karakterler bozulmasın
    let bytes = msg.payload.subarray(1, 51);
    const nul = bytes.indexOf(0);
    const full = nul < 0;
    if (!full) bytes = bytes.subarray(0, nul);
    bytes = Buffer.from(bytes);
    if (!f.id) { this._emitStatusText(f.severity, bytes.toString('utf8')); return; }
    const key = `${msg.compid}:${f.id}`;
    // Aynı bileşenden yarım kalmış başka bir metin varsa önce onu yayınla (sıra korunur)
    for (const [k, t] of this._texts) if (k !== key && k.startsWith(`${msg.compid}:`)) this._flushText(k, t);
    let t = this._texts.get(key);
    if (!t) { t = { severity: f.severity, chunks: new Map(), timer: null }; this._texts.set(key, t); }
    t.chunks.set(f.chunk_seq, bytes);
    this._cancel(t.timer);
    if (!full) this._flushText(key, t);
    else t.timer = this._later(() => this._flushText(key, t), 700); // son parça kaybolduysa eldekini yayınla
  }

  _flushText(key, t) {
    this._cancel(t.timer);
    this._texts.delete(key);
    const seqs = [...t.chunks.keys()].sort((a, b) => a - b);
    this._emitStatusText(t.severity, Buffer.concat(seqs.map((s) => t.chunks.get(s))).toString('utf8'));
  }

  _emitStatusText(severity, text) {
    const entry = { severity, severityName: shortName(enumName('MAV_SEVERITY', severity), 'MAV_SEVERITY_') || String(severity), text, t: Date.now() };
    this._emit('statustext', entry);
    if (this._cal) { try { this._calText(text); } catch (err) { this._fail(err); } }
  }

  // ---- Komutlar ----
  // command('MAV_CMD_DO_SET_MODE' | 'DO_SET_MODE' | 176, [p1..p7], { timeoutMs, retries }) → { ok, result, resultName, error? }
  command(nameOrId, params = [], opts = {}) {
    const id = resolveCommand(nameOrId);
    if (id === null) return Promise.resolve({ ok: false, result: null, resultName: null, error: 'unknown_command' });
    if (!this.ready) return Promise.resolve({ ok: false, result: null, resultName: null, error: 'not_connected' });
    const prev = this._cmdQueue.get(id) || Promise.resolve();
    const run = prev.then(() => this._runCommand(id, Array.isArray(params) ? params : [], opts || {}));
    const tail = run.then(() => { if (this._cmdQueue.get(id) === tail) this._cmdQueue.delete(id); });
    this._cmdQueue.set(id, tail);
    return run;
  }

  _runCommand(id, p, { timeoutMs = 3000, retries = 2, progressTimeoutMs = 30000 }) {
    return new Promise((resolve) => {
      if (!this.ready) { resolve({ ok: false, result: null, resultName: null, error: 'not_connected' }); return; }
      let attempt = 0;
      const pending = {
        timer: null,
        inProgress: false,
        finish: (r) => {
          this._cancel(pending.timer);
          if (this._pendingCmd.get(id) === pending) this._pendingCmd.delete(id);
          resolve(r);
        },
        ack: (result, f) => {
          if (result === MAV_RESULT_IN_PROGRESS) {
            // Araç çalışıyor: yeniden gönderme, sonucu daha uzun bekle
            pending.inProgress = true;
            this._cancel(pending.timer);
            pending.timer = this._later(() => pending.finish({ ok: false, result: null, resultName: null, error: 'timeout' }), progressTimeoutMs);
            if (this._cal && f && f.progress <= 100) this._calEvent('progress', { percent: f.progress });
            return;
          }
          const resultName = enumName('MAV_RESULT', result);
          const r = { ok: result === MAV_RESULT_ACCEPTED, result, resultName };
          if (!r.ok) r.error = (shortName(resultName, 'MAV_RESULT_') || `result_${result}`).toLowerCase();
          pending.finish(r);
        },
      };
      this._pendingCmd.set(id, pending);
      const send = () => {
        const sent = this._send('COMMAND_LONG', {
          target_system: this.sysid, target_component: this.compid, command: id, confirmation: Math.min(attempt, 255),
          param1: Number(p[0]) || 0, param2: Number(p[1]) || 0, param3: Number(p[2]) || 0, param4: Number(p[3]) || 0,
          param5: Number(p[4]) || 0, param6: Number(p[5]) || 0, param7: Number(p[6]) || 0,
        });
        if (!sent) { pending.finish({ ok: false, result: null, resultName: null, error: 'not_connected' }); return; }
        pending.timer = this._later(() => {
          if (attempt >= retries) { pending.finish({ ok: false, result: null, resultName: null, error: 'timeout' }); return; }
          attempt++;
          send();
        }, timeoutMs);
      };
      send();
    });
  }

  // ---- Kurma / kip ----
  arm(on = true, force = false) {
    let magic = 0;
    if (force) magic = on && this.firmware === 'ardupilot' ? FORCE_ARM_ARDUPILOT : FORCE_ARM_DISARM;
    return this.command(CMD.COMPONENT_ARM_DISARM, [on ? 1 : 0, magic]);
  }

  async setMode(name) {
    if (!this.ready) return { ok: false, error: 'not_connected' };
    const want = String(name === undefined || name === null ? '' : name).trim().toLowerCase();
    const list = this.modes();
    const m = list.find((x) => x.name.toLowerCase() === want) || (/^\d+$/.test(want) ? list.find((x) => x.id === Number(want)) || { id: Number(want), name: `MODE_${want}` } : null);
    if (!m) return { ok: false, error: 'unknown_mode' };
    const base = MAV_MODE_FLAG_CUSTOM;
    const p = this.firmware === 'px4' ? [base, (m.id >>> 16) & 0xff, (m.id >>> 24) & 0xff] : [base, m.id];
    const r = await this.command(CMD.DO_SET_MODE, p, { retries: 1 });
    if (r.ok) return { ...r, mode: m.name };
    if (r.result !== null && r.result !== MAV_RESULT_UNSUPPORTED) return r; // araç açıkça reddetti
    // Yedek yol: eski SET_MODE iletisi; sonucu kalp atışındaki kipten anlaşılır
    this._send('SET_MODE', { target_system: this.sysid, base_mode: base | (this.armed ? MAV_MODE_FLAG_ARMED : 0), custom_mode: m.id });
    const ok = await this._waitFor(() => this.customMode === m.id, 2500);
    return ok ? { ok: true, result: null, resultName: null, mode: m.name } : { ok: false, result: r.result, resultName: r.resultName, error: r.error || 'timeout' };
  }

  // Koşul sağlanana dek (ya da süre dolana dek) bekler
  _waitFor(test, ms) {
    return new Promise((resolve) => {
      const start = Date.now();
      const step = () => {
        let ok = false;
        try { ok = !!test(); } catch { ok = false; }
        if (ok) { resolve(true); return; }
        if (!this.link || Date.now() - start >= ms) { resolve(false); return; }
        this._later(step, 50);
      };
      step();
    });
  }

  reboot() { return this.command(CMD.PREFLIGHT_REBOOT_SHUTDOWN, [1], { retries: 0 }); }

  // Bulunulan konumu ev konumu yap
  setHomeHere() { return this.command(CMD.DO_SET_HOME, [1]); }

  // ---- Motor testi ----
  // ArduPilot: motor = test sırası (1 = A, 2 = B …; frame.motors[].testOrder). PX4: motor = motor numarası (frame.motors[].n).
  motorTest({ motor = 1, throttlePct = 5, seconds = 2, count = 1 } = {}) {
    const m = Math.max(1, Math.round(Number(motor) || 1));
    const pct = Math.min(100, Math.max(0, Number(throttlePct) || 0));
    const secs = Math.max(0, Number(seconds) || 0);
    if (this.firmware === 'px4') {
      // param5: 1000 üstü değerler PX4'ün iç çıkış işlevi (101 = Motor1) → 1100 + motor. Süre PX4'te en çok 3 sn.
      return this.command(CMD.ACTUATOR_TEST, [pct / 100, secs, 0, 0, 1100 + m]);
    }
    // param2 = 0 (MOTOR_TEST_THROTTLE_PERCENT), param6 = 2 (MOTOR_TEST_ORDER_BOARD)
    return this.command(CMD.DO_MOTOR_TEST, [m, 0, pct, secs, Math.max(1, Math.round(Number(count) || 1)), 2]);
  }

  async motorStop() {
    if (this.firmware === 'px4') {
      const n = this.frame && this.frame.motors.length ? this.frame.motors.length : 4;
      let last = { ok: true };
      for (let i = 1; i <= n; i++) last = await this.command(CMD.ACTUATOR_TEST, [0, 0, 0, 0, 1100 + i], { retries: 0, timeoutMs: 1000 }); // süre 0 = denetimi bırak
      return last;
    }
    return this.command(CMD.DO_MOTOR_TEST, [1, 0, 0, 0, 1, 2]); // gaz 0, süre 0 → test biter
  }

  // ---- Parametreler ----
  getParams() {
    return [...this.params.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((p) => ({ ...p }));
  }

  _paramProgress(done) {
    return { total: this.paramTotal, received: this.paramIdx.size, loading: this.paramLoading, done: !!done };
  }

  fetchParams() {
    if (this._fetch) return this._fetch.promise;
    if (!this.ready) return Promise.resolve({ ok: false, error: 'not_connected', total: this.paramTotal, received: this.paramIdx.size });
    const fetch = { rounds: 0, noProgress: 0, lastRx: Date.now(), lastCount: 0, timer: null };
    fetch.promise = new Promise((resolve) => { fetch.resolve = resolve; });
    fetch.finish = (ok, error) => {
      if (this._fetch !== fetch) return;
      this._cancel(fetch.timer);
      this._fetch = null;
      this.paramLoading = false;
      this._deriveFrame();
      this._emit('params', this._paramProgress(true));
      this._touch(true);
      const r = { ok, total: this.paramTotal, received: this.paramIdx.size };
      if (!ok) r.error = error || 'incomplete';
      fetch.resolve(r);
    };
    this._fetch = fetch;
    this.params.clear();
    this.paramIdx.clear();
    this.paramTotal = 0;
    this.paramLoading = true;
    const requestList = () => this._send('PARAM_REQUEST_LIST', { target_system: this.sysid, target_component: this.compid });
    requestList();
    this._emit('params', this._paramProgress(false));
    this._touch(true);
    fetch.timer = this._every(() => {
      const total = this.paramTotal;
      const got = this.paramIdx.size;
      if (total > 0 && got >= total) { fetch.finish(true); return; }
      const now = Date.now();
      if (now - fetch.lastRx < this.paramGapMs) return;
      // Akış durdu: eksikleri yeniden iste. Art arda 5 tur hiç ilerleme olmazsa vazgeç.
      fetch.rounds++;
      fetch.noProgress = got > fetch.lastCount ? 0 : fetch.noProgress + 1;
      fetch.lastCount = got;
      if (fetch.noProgress >= 5 || fetch.rounds > 60) { fetch.finish(false, got ? 'incomplete' : 'timeout'); return; }
      fetch.lastRx = now;
      if (!total || got < total / 2) { requestList(); return; }
      let asked = 0;
      for (let i = 0; i < total && asked < 150; i++) {
        if (this.paramIdx.has(i)) continue;
        this._send('PARAM_REQUEST_READ', { target_system: this.sysid, target_component: this.compid, param_id: '', param_index: i });
        asked++;
      }
    }, 100);
    return fetch.promise;
  }

  _onParamValue(f, msg) {
    const name = f.param_id;
    if (!name || name.startsWith('_HASH_CHECK')) return; // PX4'ün önbellek özeti
    const type = f.param_type;
    let value = f.param_value;
    if (this.firmware === 'px4' && INT_PARAM_TYPES.has(type)) {
      // PX4 tamsayıları float alanına bayt bayt koyar
      value = type === 5 ? msg.payload.readUInt32LE(0) : msg.payload.readInt32LE(0);
    }
    const old = this.params.get(name);
    const hasIndex = f.param_index !== PARAM_INDEX_NONE;
    const p = { name, value, type, index: hasIndex ? f.param_index : (old ? old.index : -1) };
    this.params.set(name, p);
    if (hasIndex) {
      this.paramIdx.add(f.param_index);
      if (f.param_count > 0) this.paramTotal = f.param_count;
    }
    if (this._fetch) this._fetch.lastRx = Date.now();
    this._emit('param', { ...p });
    const waiters = this._paramWaiters.get(name);
    if (waiters) for (const fn of [...waiters]) fn(p);
    if (this.paramLoading) {
      const now = Date.now();
      if (now - this._paramEmitAt >= 100) { this._paramEmitAt = now; this._emit('params', this._paramProgress(false)); }
    } else if (/^(Q_)?FRAME_(CLASS|TYPE)$|^CA_ROTOR/.test(name)) {
      this._deriveFrame();
    }
  }

  // Adı verilen parametrenin bir sonraki PARAM_VALUE iletisini bekler (accept(p) true dönene dek); süre dolarsa null
  _waitParam(name, ms, accept) {
    return new Promise((resolve) => {
      let set = this._paramWaiters.get(name);
      if (!set) { set = new Set(); this._paramWaiters.set(name, set); }
      let timer = null;
      const fn = (p) => {
        if (p && accept && !accept(p)) return;
        this._cancel(timer);
        set.delete(fn);
        if (!set.size && this._paramWaiters.get(name) === set) this._paramWaiters.delete(name);
        resolve(p);
      };
      set.add(fn);
      timer = this._later(() => fn(null), ms);
    });
  }

  // setParam('RC1_MIN', 1100) → { ok, value } (araç değeri yuvarlar ya da reddederse ok:false, value = araçtaki değer)
  setParam(name, value) {
    const run = this._paramChain.then(() => this._setParam(String(name || '').trim(), Number(value)));
    this._paramChain = run.then(() => {}, () => {});
    return run.catch((err) => ({ ok: false, error: 'error', detail: String((err && err.message) || err) }));
  }

  async _setParam(name, value) {
    if (!this.ready) return { ok: false, error: 'not_connected' };
    if (!name || !Number.isFinite(value)) return { ok: false, error: 'invalid' };
    const px4 = this.firmware === 'px4';
    let known = this.params.get(name);
    if (!known && px4) {
      // PX4'te tür bilinmeden yazılamaz (tamsayılar bayt bayt kodlanır): önce parametreyi oku
      for (let i = 0; i < 3 && !known; i++) {
        this._send('PARAM_REQUEST_READ', { target_system: this.sysid, target_component: this.compid, param_id: name, param_index: -1 });
        known = await this._waitParam(name, 1000);
      }
      if (!known) return { ok: false, error: 'unknown_param' };
    }
    const type = known ? known.type : 9; // MAV_PARAM_TYPE_REAL32
    const isInt = INT_PARAM_TYPES.has(type);
    let wire = value;
    if (px4 && isInt) {
      wire = Buffer.alloc(4);
      if (type === 5) wire.writeUInt32LE(Math.min(0xffffffff, Math.max(0, Math.round(value)))); else wire.writeInt32LE(Math.min(0x7fffffff, Math.max(-0x80000000, Math.round(value))));
    }
    const target = isInt ? Math.round(value) : value;
    const same = (v) => v === target || Math.fround(v) === Math.fround(target) || Math.abs(v - target) <= 1e-6 * Math.max(1, Math.abs(v), Math.abs(target));
    let seen = null;
    let mismatches = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this._send('PARAM_SET', { target_system: this.sysid, target_component: this.compid, param_id: name, param_value: wire, param_type: type })) return { ok: false, error: 'not_connected' };
      let attemptSeen = null;
      const got = await this._waitParam(name, 1000, (p) => { attemptSeen = p; return same(p.value); });
      if (got) return { ok: true, value: got.value };
      if (!this.link) return { ok: false, error: 'disconnected' };
      if (attemptSeen) { seen = attemptSeen; mismatches++; if (mismatches >= 2) break; } // araç başka değer bildiriyor: reddedildi
    }
    return seen ? { ok: false, value: seen.value, error: 'rejected' } : { ok: false, error: 'timeout' };
  }

  // Kumanda kalibrasyonu sonucu: RCn_MIN / RCn_MAX / RCn_TRIM yazılır (dizi indeksi 0 = kanal 1; null olanlar atlanır)
  async saveRcLimits(mins = [], maxs = [], trims = []) {
    if (!this.ready) return { ok: false, error: 'not_connected' };
    const failed = [];
    let written = 0;
    const n = Math.max(mins.length || 0, maxs.length || 0, trims.length || 0);
    for (let i = 0; i < n; i++) {
      for (const [suffix, arr] of [['MIN', mins], ['MAX', maxs], ['TRIM', trims]]) {
        const v = arr ? arr[i] : null;
        if (v === null || v === undefined || !Number.isFinite(Number(v))) continue;
        const name = `RC${i + 1}_${suffix}`;
        const r = await this.setParam(name, Math.round(Number(v)));
        if (r.ok) written++; else failed.push(name);
      }
    }
    return failed.length ? { ok: false, written, failed, error: 'partial' } : { ok: true, written, failed };
  }

  // ---- Gövde / motor yerleşimi ----
  _deriveFrame() {
    let frame = null;
    try { frame = this.firmware === 'px4' ? this._framePx4() : this._frameArdupilot(); } catch { frame = null; }
    this.frame = frame;
    this._touch();
  }

  _frameArdupilot() {
    if (this.firmware !== 'ardupilot') return null;
    const val = (n) => { const p = this.params.get(n); return p ? Math.round(p.value) : null; };
    let cls = null; let type = null;
    if (this.vehicle === 'copter') { cls = val('FRAME_CLASS'); type = val('FRAME_TYPE'); }
    else if ((this.vehicle === 'plane' || this.vehicle === 'vtol') && val('Q_ENABLE') > 0) { cls = val('Q_FRAME_CLASS'); type = val('Q_FRAME_TYPE'); } // QuadPlane
    if (cls === null) return null;
    if (type === null) type = 0;
    const exact = MOTOR_LAYOUTS.find((l) => l.class === cls && l.type === type);
    const className = FRAME_CLASS_NAMES[cls] || `CLASS_${cls}`;
    if (!exact) return { class: cls, type, name: className, motors: [] }; // helikopter, tek rotor, betikle tanımlanan gövdeler…
    return { class: cls, type, name: exact.name, motors: exact.motors.map((m) => ({ ...m })) };
  }

  _framePx4() {
    const val = (n) => { const p = this.params.get(n); return p ? p.value : null; };
    const count = val('CA_ROTOR_COUNT');
    if (!count || count < 1) return null;
    const motors = [];
    let max = 0;
    for (let i = 0; i < count; i++) {
      const px = val(`CA_ROTOR${i}_PX`) || 0; // ileri (+)
      const py = val(`CA_ROTOR${i}_PY`) || 0; // sağ (+)
      const km = val(`CA_ROTOR${i}_KM`);
      max = Math.max(max, Math.abs(px), Math.abs(py));
      motors.push({ n: i + 1, testOrder: i + 1, x: py, y: px, dir: km === null || km === 0 ? null : km > 0 ? 'ccw' : 'cw' }); // KM > 0 → saat yönünün tersi
    }
    for (const m of motors) { m.x = max ? round(m.x / max, 3) : 0; m.y = max ? round(m.y / max, 3) : 0; }
    const airframe = val('CA_AIRFRAME');
    return { class: airframe === null ? null : Math.round(airframe), type: null, name: `${count} rotor`, motors };
  }

  // ---- Kalibrasyonlar ----
  // calibrate(kind, arg) → { ok, resultName?, error? }; ilerleme 'calibration' olaylarıyla gelir.
  //   kind: gyro | baro | level | accel | compass | esc | airspeed          (başlatır; iş bitince çözülür)
  //         accelNext (arg = konum 1..6, verilmezse son istenen) | compassAccept | compassCancel | cancel
  calibrate(kind, arg) {
    const run = async () => {
      if (!this.ready) return { ok: false, error: 'not_connected' };
      switch (kind) {
        case 'accelNext': return this._accelNext(arg);
        case 'compassAccept': return this.command(CMD.DO_ACCEPT_MAG_CAL, [0]);
        case 'compassCancel': return this._calCancel('compass');
        case 'cancel': return this._calCancel(null);
        case 'gyro': case 'baro': case 'level': case 'accel': case 'compass': case 'esc': case 'airspeed': break;
        default: return { ok: false, error: 'unsupported' };
      }
      if (this._cal) return { ok: false, error: 'busy' };
      return this.firmware === 'px4' ? this._calPx4(kind) : this._calArdupilot(kind);
    };
    return run().catch((err) => ({ ok: false, error: 'error', detail: String((err && err.message) || err) }));
  }

  _calBegin(kind, idleMs) {
    const cal = { kind, idleMs, timer: null, position: null, compass: new Map(), reports: new Map(), percent: null };
    cal.promise = new Promise((resolve) => { cal.resolve = resolve; });
    this._cal = cal;
    this._calEvent('started', {});
    this._calIdle();
    return cal;
  }

  // Hareketsizlik süresi: bu kadar süre araçtan haber gelmezse kalibrasyon başarısız sayılır
  _calIdle() {
    const cal = this._cal;
    if (!cal) return;
    this._cancel(cal.timer);
    cal.timer = this._later(() => { if (this._cal === cal) this._calFinish('failed', { ok: false, error: 'timeout' }, 'timeout'); }, cal.idleMs);
  }

  _calEvent(state, extra) {
    const cal = this._cal;
    if (!cal) return;
    this._emit('calibration', { kind: cal.kind, state, text: '', ...extra });
  }

  _calFinish(state, result, text, extra) {
    const cal = this._cal;
    if (!cal) return;
    this._cancel(cal.timer);
    this._cancel(cal.settle);
    this._emit('calibration', { kind: cal.kind, state, text: text || '', ...(extra || {}) });
    this._cal = null;
    cal.resolve(result);
  }

  async _calCancel(only) {
    const cal = this._cal;
    if (only && cal && cal.kind !== only) return { ok: false, error: 'not_active' };
    let r = { ok: true };
    if (this.firmware === 'px4') r = await this.command(CMD.PREFLIGHT_CALIBRATION, [0, 0, 0, 0, 0, 0, 0], { retries: 1 }); // hepsi 0 = iptal
    else if (only === 'compass' || (cal && cal.kind === 'compass')) r = await this.command(CMD.DO_CANCEL_MAG_CAL, [0]);
    if (this._cal === cal && cal) this._calFinish('cancelled', { ok: false, error: 'cancelled' });
    return r;
  }

  async _calArdupilot(kind) {
    if (kind === 'esc') {
      // ArduCopter: ESC_CALIBRATION=3 yazılır; kalibrasyon bir sonraki açılışta yapılır
      this._calBegin(kind, 15000);
      const cal = this._cal;
      const r = await this.setParam('ESC_CALIBRATION', 3);
      const res = r.ok ? { ok: true, resultName: 'REBOOT_REQUIRED', rebootRequired: true } : { ok: false, error: r.error || 'failed' };
      if (this._cal === cal) this._calFinish(r.ok ? 'done' : 'failed', res, r.ok ? 'reboot_required' : (r.error || 'failed'), r.ok ? { rebootRequired: true } : {});
      return res;
    }
    if (kind === 'compass') {
      const cal = this._calBegin(kind, 60000);
      // param1 = 0 (bütün pusulalar), param2 = 1 (başarısızsa yeniden dene), param3 = 1 (kendiliğinden kaydet)
      const r = await this.command(CMD.DO_START_MAG_CAL, [0, 1, 1, 0, 0]);
      if (!r.ok) { if (this._cal === cal) this._calFinish('failed', r, r.error); return r; }
      return cal.promise;
    }
    if (kind === 'accel') {
      const cal = this._calBegin(kind, 120000);
      // Tam (6 konumlu) kalibrasyon önce jiroskobu kalibre eder; onay birkaç saniye sürebilir
      const r = await this.command(CMD.PREFLIGHT_CALIBRATION, [0, 0, 0, 0, 1], { timeoutMs: 15000, retries: 0 });
      if (!r.ok) { if (this._cal === cal) this._calFinish('failed', r, r.error); return r; }
      if (this._cal === cal) this._calIdle();
      return cal.promise;
    }
    // Tek adımlı olanlar: araç iş bitince onay gönderir. ArduPilot'ta hava hızı sıfırlaması barometre kalibrasyonuyla birlikte yapılır (param3).
    const p = { gyro: [1], baro: [0, 0, 1], airspeed: [0, 0, 1], level: [0, 0, 0, 0, 2] }[kind];
    const cal = this._calBegin(kind, 40000);
    const r = await this.command(CMD.PREFLIGHT_CALIBRATION, p, { timeoutMs: 12000, retries: 1 });
    const res = r.ok ? { ok: true, resultName: r.resultName } : r;
    if (this._cal === cal) this._calFinish(r.ok ? 'done' : 'failed', res, r.ok ? '' : r.error);
    return res;
  }

  async _calPx4(kind) {
    // PX4: komut yalnızca başlatır; ilerleme ve sonuç "[cal] …" durum metinleriyle gelir
    const p = { gyro: [1], compass: [0, 1], baro: [0, 0, 1], accel: [0, 0, 0, 0, 1], level: [0, 0, 0, 0, 2], airspeed: [0, 0, 0, 0, 0, 2], esc: [0, 0, 0, 0, 0, 0, 1] }[kind];
    const cal = this._calBegin(kind, 90000);
    const r = await this.command(CMD.PREFLIGHT_CALIBRATION, p, { retries: 1 });
    if (!r.ok) { if (this._cal === cal) this._calFinish('failed', r, r.error); return r; }
    return cal.promise;
  }

  // Araç istenen konuma getirildi: ArduPilot'a bildir (Mission Planner gibi MAV_CMD_ACCELCAL_VEHICLE_POS, param1 = konum)
  async _accelNext(position) {
    const cal = this._cal;
    if (!cal || cal.kind !== 'accel') return { ok: false, error: 'not_active' };
    if (this.firmware === 'px4') return { ok: true }; // PX4 konumu kendisi algılar
    const pos = Number(position) || cal.position;
    if (!pos) return { ok: false, error: 'no_prompt' };
    const r = await this.command(CMD.ACCELCAL_VEHICLE_POS, [pos], { timeoutMs: 2000, retries: 0 });
    if (r.result === MAV_RESULT_UNSUPPORTED) {
      // Eski ArduPilot: yer istasyonundan COMMAND_ACK bekler (AP_AccelCal::handle_command_ack: command ≤ 6, result = 1)
      this._send('COMMAND_ACK', { command: pos, result: 1, target_system: this.sysid, target_component: this.compid });
      if (this._cal === cal) this._calIdle();
      return { ok: true, result: null, resultName: null, legacy: true };
    }
    if (r.ok && this._cal === cal) { this._calIdle(); this._calEvent('progress', { position: pos, positionName: ACCEL_POS_NAMES[pos] || null, text: 'sampling' }); }
    return r;
  }

  // Araçtan gelen COMMAND_LONG (ArduPilot ivmeölçer kalibrasyonu konum istekleri)
  _onCommandLong(f) {
    if (f.command !== CMD.ACCELCAL_VEHICLE_POS) return;
    const cal = this._cal;
    if (!cal || cal.kind !== 'accel') return;
    const pos = Math.round(f.param1);
    if (pos === ACCEL_POS_SUCCESS) { this._calFinish('done', { ok: true, resultName: 'ACCELCAL_VEHICLE_POS_SUCCESS' }); return; }
    if (pos === ACCEL_POS_FAILED) { this._calFinish('failed', { ok: false, resultName: 'ACCELCAL_VEHICLE_POS_FAILED', error: 'failed' }); return; }
    this._calIdle();
    if (pos === cal.position) return; // aynı istek yinelendi
    cal.position = pos;
    this._calEvent('prompt', { position: pos, positionName: ACCEL_POS_NAMES[pos] || null });
  }

  _onMagCalProgress(f) {
    const cal = this._cal;
    if (!cal || cal.kind !== 'compass') return;
    this._calIdle();
    cal.reports.delete(f.compass_id); // yeniden deneme başladıysa eski rapor geçersiz
    cal.compass.set(f.compass_id, { id: f.compass_id, percent: f.completion_pct, status: shortName(enumName('MAG_CAL_STATUS', f.cal_status), 'MAG_CAL_') || String(f.cal_status), fitness: null, ofs: null });
    this._calEvent('progress', this._compassInfo(cal));
  }

  _onMagCalReport(f) {
    const cal = this._cal;
    if (!cal || cal.kind !== 'compass') return;
    if (f.cal_status < MAG_CAL_SUCCESS) return; // henüz bitmedi
    this._calIdle();
    const entry = { id: f.compass_id, percent: f.cal_status === MAG_CAL_SUCCESS ? 100 : (cal.compass.get(f.compass_id) || {}).percent || 0, status: shortName(enumName('MAG_CAL_STATUS', f.cal_status), 'MAG_CAL_') || String(f.cal_status), fitness: round(f.fitness, 2), ofs: [round(f.ofs_x, 1), round(f.ofs_y, 1), round(f.ofs_z, 1)], autosaved: !!f.autosaved, ok: f.cal_status === MAG_CAL_SUCCESS };
    cal.compass.set(f.compass_id, entry);
    cal.reports.set(f.compass_id, entry);
    // Bütün pusulaların raporu gelince bitir (kısa bir bekleme: diğer pusulaların raporu arkadan gelebilir)
    if ([...cal.compass.keys()].every((id) => cal.reports.has(id)) && !cal.settle) {
      cal.settle = this._later(() => {
        if (this._cal !== cal) return;
        cal.settle = null;
        if (![...cal.compass.keys()].every((id) => cal.reports.has(id))) return;
        const all = [...cal.reports.values()];
        const ok = all.every((c) => c.ok);
        const info = this._compassInfo(cal);
        if (ok) this._calFinish('done', { ok: true, resultName: 'MAG_CAL_SUCCESS', compass: info.compass, autosaved: all.every((c) => c.autosaved) }, '', info);
        else this._calFinish('failed', { ok: false, resultName: 'MAG_CAL_' + all.find((c) => !c.ok).status, error: 'failed', compass: info.compass }, '', info);
      }, 250);
    }
  }

  _compassInfo(cal) {
    const compass = [...cal.compass.values()].sort((a, b) => a.id - b.id).map((c) => ({ id: c.id, percent: c.percent, status: c.status, fitness: c.fitness, ofs: c.ofs }));
    const percent = compass.length ? Math.min(...compass.map((c) => c.percent)) : 0;
    return { percent, compass };
  }

  // Kalibrasyon sürerken gelen durum metinleri
  _calText(text) {
    const cal = this._cal;
    if (!cal) return;
    const m = /^\[cal\]\s*(.*)$/i.exec(text);
    if (m) {
      // PX4 (commander/calibration_messages.h)
      const body = m[1];
      let x;
      this._calIdle();
      if ((x = /^calibration started:\s*\d*\s*(.*)$/i.exec(body))) this._calEvent('progress', { text: body, sensor: x[1] });
      else if ((x = /^progress <(\d+)>/i.exec(body))) { cal.percent = Number(x[1]); this._calEvent('progress', { text: body, percent: cal.percent }); }
      else if ((x = /^calibration done:?\s*(.*)$/i.exec(body))) this._calFinish('done', { ok: true, resultName: 'DONE' }, body);
      else if ((x = /^calibration failed:?\s*(.*)$/i.exec(body))) this._calFinish('failed', { ok: false, resultName: 'FAILED', error: 'failed', detail: x[1] }, body);
      else if (/^calibration cancelled/i.test(body)) this._calFinish('cancelled', { ok: false, error: 'cancelled' }, body);
      else if ((x = /^pending:\s*(.*)$/i.exec(body))) this._calEvent('prompt', { text: body, pending: x[1].trim().split(/\s+/).filter(Boolean) });
      else if ((x = /^(\S+) orientation detected/i.exec(body))) this._calEvent('progress', { text: body, positionName: x[1].toUpperCase() });
      else if ((x = /^(\S+) side done/i.exec(body))) this._calEvent('prompt', { text: body, doneSide: x[1].toUpperCase() });
      else this._calEvent('progress', { text: body });
      return;
    }
    if (this.firmware === 'px4') return;
    // ArduPilot: ilgili metinler ilerleme olarak iletilir; eski sürümlerde sonuç da metinle gelir
    this._calEvent('progress', { text, ...(cal.position ? { position: cal.position, positionName: ACCEL_POS_NAMES[cal.position] || null } : {}) });
    if (cal.kind === 'accel') {
      if (/calibration successful/i.test(text)) this._calFinish('done', { ok: true, resultName: 'ACCELCAL_VEHICLE_POS_SUCCESS' }, text);
      else if (/calibration failed/i.test(text)) this._calFinish('failed', { ok: false, resultName: 'ACCELCAL_VEHICLE_POS_FAILED', error: 'failed' }, text);
    }
  }
}

function describeCfg(cfg) {
  try { return createLink(cfg).describe(); } catch { return ''; }
}

// ---- Telemetri iletileri (this = araç) ----
const HANDLERS = {
  ATTITUDE(f) {
    const t = this.telemetry;
    t.roll = round(rad2deg(f.roll), 2); t.pitch = round(rad2deg(f.pitch), 2);
    t.yaw = round((rad2deg(f.yaw) + 360) % 360, 2);
    t.rollRate = round(rad2deg(f.rollspeed), 2); t.pitchRate = round(rad2deg(f.pitchspeed), 2); t.yawRate = round(rad2deg(f.yawspeed), 2);
    t.time = Date.now();
    this._lastAttitude = t.time;
  },
  GLOBAL_POSITION_INT(f) {
    const t = this.telemetry;
    if (f.lat !== 0 || f.lon !== 0) { t.lat = f.lat / 1e7; t.lon = f.lon / 1e7; this._gotPosition = true; }
    t.altMsl = f.alt / 1000; t.altRel = f.relative_alt / 1000;
    t.vx = f.vx / 100; t.vy = f.vy / 100; t.vz = f.vz / 100;
    if (f.hdg !== 65535) t.heading = f.hdg / 100;
    if (t.groundspeed === null) t.groundspeed = round(Math.hypot(t.vx, t.vy), 2);
    t.time = Date.now();
  },
  VFR_HUD(f) {
    const t = this.telemetry;
    t.airspeed = round(f.airspeed, 2); t.groundspeed = round(f.groundspeed, 2); t.climb = round(f.climb, 2);
    t.throttle = f.throttle;
    if (t.heading === null) t.heading = f.heading;
    if (t.altMsl === null) t.altMsl = round(f.alt, 2);
  },
  SYS_STATUS(f) {
    const t = this.telemetry;
    this.sensors = { present: f.onboard_control_sensors_present >>> 0, enabled: f.onboard_control_sensors_enabled >>> 0, health: f.onboard_control_sensors_health >>> 0 };
    if (f.voltage_battery !== 65535) t.voltage = f.voltage_battery / 1000;
    if (f.current_battery !== -1) t.current = f.current_battery / 100;
    if (f.battery_remaining !== -1) t.batteryPct = f.battery_remaining;
    t.load = f.load / 10;
  },
  BATTERY_STATUS(f) {
    if (f.id !== 0) return; // ana batarya
    const t = this.telemetry;
    const cells = f.voltages.filter((v) => v !== 65535);
    // SYS_STATUS yoksa hücre toplamı kullanılır (ArduPilot 65 V üstünü birden çok "hücreye" böler)
    if (t.voltage === null && cells.length) t.voltage = cells.reduce((a, b) => a + b, 0) / 1000;
    if (f.current_battery !== -1 && t.current === null) t.current = f.current_battery / 100;
    if (f.battery_remaining !== -1 && t.batteryPct === null) t.batteryPct = f.battery_remaining;
  },
  GPS_RAW_INT(f) {
    const t = this.telemetry;
    t.gpsFix = f.fix_type;
    t.gpsFixName = shortName(enumName('GPS_FIX_TYPE', f.fix_type), 'GPS_FIX_TYPE_');
    t.sats = f.satellites_visible === 255 ? null : f.satellites_visible;
    t.hdop = f.eph === 65535 ? null : f.eph / 100;
    // Konum kestirimi (GLOBAL_POSITION_INT) henüz yoksa ham GPS konumu
    if (!this._gotPosition && f.fix_type >= 2 && (f.lat !== 0 || f.lon !== 0)) { t.lat = f.lat / 1e7; t.lon = f.lon / 1e7; if (t.altMsl === null) t.altMsl = f.alt / 1000; }
  },
  RC_CHANNELS(f) {
    const t = this.telemetry;
    const rc = [];
    for (let i = 1; i <= 18; i++) { const v = f[`chan${i}_raw`]; rc.push(v === 65535 ? 0 : v); }
    t.rc = rc;
    t.rssi = f.rssi === 255 ? null : f.rssi;
  },
  RC_CHANNELS_RAW(f) {
    const t = this.telemetry;
    if (t.rc.length > 8) return; // RC_CHANNELS geliyorsa o kullanılır
    const rc = [];
    for (let i = 1; i <= 8; i++) { const v = f[`chan${i}_raw`]; rc.push(v === 65535 ? 0 : v); }
    t.rc = rc;
    t.rssi = f.rssi === 255 ? null : f.rssi;
  },
  SERVO_OUTPUT_RAW(f) {
    if (f.port !== 0) return;
    const servo = [];
    for (let i = 1; i <= 16; i++) servo.push(f[`servo${i}_raw`] || 0);
    this.telemetry.servo = servo;
  },
  HOME_POSITION(f) {
    const t = this.telemetry;
    t.homeLat = f.latitude / 1e7; t.homeLon = f.longitude / 1e7; t.homeAlt = f.altitude / 1000;
  },
  NAV_CONTROLLER_OUTPUT(f) {
    this.telemetry.wpDist = f.wp_dist;
    this.telemetry.navBearing = f.nav_bearing;
  },
  VIBRATION(f) {
    this.telemetry.vibration = [round(f.vibration_x, 2), round(f.vibration_y, 2), round(f.vibration_z, 2)];
  },
  EKF_STATUS_REPORT(f) {
    // ArduPilot: tutum çözümü var (bit 0), başlatılmış (bit 10 yok) ve sapmalar Mission Planner'ın kırmızı eşiğinin (0.8) altında
    const bad = [f.velocity_variance, f.pos_horiz_variance, f.pos_vert_variance, f.compass_variance].some((v) => v >= 0.8);
    this.telemetry.ekfOk = (f.flags & 1) !== 0 && (f.flags & 1024) === 0 && !bad;
  },
  ESTIMATOR_STATUS(f) {
    if (this.firmware === 'ardupilot') return; // ArduPilot için EKF_STATUS_REPORT kullanılır
    this.telemetry.ekfOk = (f.flags & 1) !== 0;
  },
  AUTOPILOT_VERSION(f) {
    const v = f.flight_sw_version >>> 0;
    if (!v) return;
    const type = v & 0xff;
    const suffix = this.firmware === 'ardupilot' ? ({ 0: '-dev', 64: '-alpha', 128: '-beta', 192: '-rc', 255: '' }[type] ?? '') : (type === 255 ? '' : type >= 192 ? '-rc' : type >= 128 ? '-beta' : type >= 64 ? '-alpha' : '-dev');
    this.version = `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}${suffix}`;
  },
  COMMAND_ACK(f) {
    const p = this._pendingCmd.get(f.command);
    if (p) p.ack(f.result, f);
  },
  COMMAND_LONG(f) { this._onCommandLong(f); },
  PARAM_VALUE(f, msg) { this._onParamValue(f, msg); },
  MAG_CAL_PROGRESS(f) { this._onMagCalProgress(f); },
  MAG_CAL_REPORT(f) { this._onMagCalReport(f); },
};

module.exports = { MavVehicle, CMD, ACCEL_POS_NAMES };
