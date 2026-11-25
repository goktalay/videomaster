'use strict';

// Sınamalar ve gösterimler için sahte ArduCopter (MAV_TYPE_QUADROTOR, MAV_AUTOPILOT_ARDUPILOTMEGA). Gerçek MAVLink v2 konuşur.
//   const sim = createSim({ udp: { host: '127.0.0.1', port: 14550 }, tcp: 5760, udpListen: null });
//   await sim.start();  …  await sim.stop();
// Kanallar (istenilenler birlikte açılabilir):
//   udp        yer istasyonunun dinlediği kapıya gönderir (uygulamadaki "UDP dinleme" / udpin ile çalışır)
//   udpListen  bir UDP kapısı dinler, karşı ucu ilk paketten öğrenir (uygulamadaki "UDP" ile çalışır); 0 = boş kapı
//   tcp        TCP sunucusu (SITL gibi 5760); 0 = boş kapı
// Seçenekler: interactive (yerde başlar, komutlara uyar; yoksa daire çizer), simSpeed, noReposition (DO_REPOSITION desteklenmez),
//   sysid, home {lat, lon, alt}, heartbeatMs, telemetryScale (1 = gerçek hızlar), dropParams [indeksler] (ilk listede
//   düşürülür), calStepMs (kalibrasyon adım süresi), silent (hiçbir şey göndermez; bağlantı kopması sınaması için).
// Görev protokolü (görev 0, çit 1, toplanma noktaları 2): noFence (çit/toplanma istekleri MISSION_ACK 3 = desteklenmiyor),
//   dropMissionRequests n (ilk n MISSION_COUNT ve ilk n öğe yok sayılır: yeniden deneme sınaması), legacyMission (öğeler eski
//   MISSION_REQUEST ile istenir; okumada yalnız MISSION_REQUEST yanıtlanır, MISSION_ITEM ile), missionMax (daha uzun liste
//   MISSION_ACK 4 = yer yok), missionRetryMs (öğe yeniden isteme aralığı), unsupported [komut kimlikleri] (MAV_RESULT 3).
//   interactive kipte kuruluyken AUTO (3) + MISSION_START ile görev uçulur.
// Dönen nesne: { start, stop, tcpPort, udpPort, calls [{ name, id, params }], params (Map ad → { value, type }),
//   state, mission ({ 0: [öğe…], 1: […], 2: […] } ham MAVLink alanları), statustext(text, severity), setSilent(on) }

const net = require('net');
const dgram = require('dgram');
const path = require('path');
const { MavParser, encode, COMMANDS } = require(path.join(__dirname, '..', '..', 'src', 'drone', 'mavlink.js'));

const T = { INT8: 2, INT16: 4, INT32: 6, REAL32: 9 };

// Gerçekçi bir ArduCopter parametre kümesi (4.5 varsayılanlarına yakın)
const DEFAULT_PARAMS = [
  ['ACRO_RP_RATE', 360, T.REAL32], ['ACRO_Y_RATE', 202.5, T.REAL32],
  ['ANGLE_MAX', 3000, T.INT16], ['ARMING_CHECK', 1, T.INT32],
  ['ATC_ACCEL_P_MAX', 110000, T.REAL32], ['ATC_ACCEL_R_MAX', 110000, T.REAL32], ['ATC_ACCEL_Y_MAX', 27000, T.REAL32],
  ['ATC_ANG_PIT_P', 4.5, T.REAL32], ['ATC_ANG_RLL_P', 4.5, T.REAL32], ['ATC_ANG_YAW_P', 4.5, T.REAL32],
  ['ATC_RAT_PIT_D', 0.0036, T.REAL32], ['ATC_RAT_PIT_I', 0.135, T.REAL32], ['ATC_RAT_PIT_P', 0.135, T.REAL32],
  ['ATC_RAT_RLL_D', 0.0036, T.REAL32], ['ATC_RAT_RLL_I', 0.135, T.REAL32], ['ATC_RAT_RLL_P', 0.135, T.REAL32],
  ['ATC_RAT_YAW_I', 0.018, T.REAL32], ['ATC_RAT_YAW_P', 0.18, T.REAL32],
  ['BATT_AMP_PERVLT', 17, T.REAL32], ['BATT_CAPACITY', 5200, T.INT32], ['BATT_FS_LOW_ACT', 2, T.INT8],
  ['BATT_LOW_VOLT', 14.0, T.REAL32], ['BATT_MONITOR', 4, T.INT8], ['BATT_VOLT_MULT', 10.1, T.REAL32],
  ['COMPASS_DEC', 0.1, T.REAL32], ['COMPASS_ENABLE', 1, T.INT8], ['COMPASS_OFS_X', 12.5, T.REAL32],
  ['COMPASS_OFS_Y', -48.2, T.REAL32], ['COMPASS_OFS_Z', 103.7, T.REAL32], ['COMPASS_USE', 1, T.INT8],
  ['ESC_CALIBRATION', 0, T.INT8],
  ['FLTMODE1', 0, T.INT8], ['FLTMODE2', 2, T.INT8], ['FLTMODE3', 5, T.INT8], ['FLTMODE4', 6, T.INT8], ['FLTMODE5', 9, T.INT8], ['FLTMODE6', 3, T.INT8],
  ['FRAME_CLASS', 1, T.INT8], ['FRAME_TYPE', 1, T.INT8],
  ['FS_GCS_ENABLE', 0, T.INT8], ['FS_THR_ENABLE', 1, T.INT8], ['FS_THR_VALUE', 975, T.INT16],
  ['INS_ACCOFFS_X', 0.012, T.REAL32], ['INS_ACCOFFS_Y', -0.034, T.REAL32], ['INS_ACCOFFS_Z', 0.105, T.REAL32],
  ['INS_GYRO_FILTER', 20, T.INT16], ['INS_ACCEL_FILTER', 20, T.INT16],
  ['MOT_BAT_VOLT_MAX', 16.8, T.REAL32], ['MOT_BAT_VOLT_MIN', 13.2, T.REAL32], ['MOT_PWM_MAX', 2000, T.INT16], ['MOT_PWM_MIN', 1000, T.INT16],
  ['MOT_SPIN_ARM', 0.1, T.REAL32], ['MOT_SPIN_MIN', 0.15, T.REAL32], ['MOT_THST_HOVER', 0.35, T.REAL32],
  ['PILOT_SPEED_UP', 250, T.INT16],
  ['RC1_MAX', 1900, T.INT16], ['RC1_MIN', 1100, T.INT16], ['RC1_TRIM', 1500, T.INT16],
  ['RC2_MAX', 1900, T.INT16], ['RC2_MIN', 1100, T.INT16], ['RC2_TRIM', 1500, T.INT16],
  ['RC3_MAX', 1900, T.INT16], ['RC3_MIN', 1100, T.INT16], ['RC3_TRIM', 1100, T.INT16],
  ['RC4_MAX', 1900, T.INT16], ['RC4_MIN', 1100, T.INT16], ['RC4_TRIM', 1500, T.INT16],
  ['RTL_ALT', 1500, T.INT32], ['SERIAL0_BAUD', 115, T.INT32], ['SYSID_THISMAV', 1, T.INT16],
  ['WPNAV_ACCEL', 250, T.REAL32], ['WPNAV_RADIUS', 200, T.REAL32], ['WPNAV_SPEED', 1000, T.REAL32],
  ['WPNAV_SPEED_DN', 150, T.REAL32], ['WPNAV_SPEED_UP', 250, T.REAL32],
];

const MODE_NAMES = { 0: 'Stabilize', 2: 'AltHold', 3: 'Auto', 4: 'Guided', 5: 'Loiter', 6: 'RTL', 9: 'Land', 17: 'Brake' };
const ACCEL_PROMPTS = { 1: 'level', 2: 'on its LEFT side', 3: 'on its RIGHT side', 4: 'nose DOWN', 5: 'nose UP', 6: 'on its BACK' };
const SENSORS = 0x1 | 0x2 | 0x4 | 0x8 | 0x20 | 0x400 | 0x800 | 0x1000 | 0x2000 | 0x4000 | 0x8000 | 0x10000 | 0x200000 | 0x400000; // jiroskop, ivmeölçer, pusula, barometre, GPS, denetleyiciler, RC, AHRS, batarya

function createSim(opts = {}) {
  const sysid = opts.sysid || 1;
  const compid = 1;
  const home = { lat: 39.9255, lon: 32.8663, alt: 890, ...(opts.home || {}) };
  const hbMs = opts.heartbeatMs || 1000;
  const scale = opts.telemetryScale || 1;
  const calStepMs = opts.calStepMs || 300;

  const params = new Map(DEFAULT_PARAMS.map(([name, value, type]) => [name, { value, type }]));
  // manyParams: gerçek araçlardaki gibi çok sayıda grup (arayüz denemeleri için): N grup × 6 parametre
  for (let g = 0; g < (opts.manyParams || 0); g++) for (let i = 0; i < 6; i++) params.set(`G${String(g).padStart(3, '0')}_PARAM${i}`, { value: g + i / 10, type: T.REAL32 });
  const names = () => [...params.keys()];
  const drop = new Set(opts.dropParams || []);

  const state = { pos: opts.interactive ? { n: 0, e: 0, alt: 0, vn: 0, ve: 0, vd: 0, heading: 0, at: Date.now() } : null, target: null, armed: false, mode: 0, boot: Date.now(), seq: 0, silent: !!opts.silent, magCal: null, accelStep: 0, textId: 0, rebooted: 0, intervals: {}, streams: {},
    mission: { 0: [], 1: [], 2: [] }, missionCur: 0, auto: { started: false, seq: 0, entered: false, speed: 0, jumps: {}, holdUntil: 0, hold: null } };
  const calls = [];
  const timers = new Set();
  const channels = []; // { send(buf), close() }
  const sim = { calls, params, state, mission: state.mission, tcpPort: null, udpPort: null };

  let tcpServer = null;
  const tcpClients = new Set();
  let udpOut = null;
  let udpIn = null;
  let udpPeer = null;
  let running = false;

  const later = (fn, ms) => { const h = setTimeout(() => { timers.delete(h); if (running) fn(); }, ms); timers.add(h); return h; };
  const every = (fn, ms) => { const h = setInterval(() => { if (running) fn(); }, ms); timers.add(h); return h; };

  function send(name, fields) {
    if (!running || state.silent) return;
    const buf = encode(name, fields, { sysid, compid, seq: state.seq, version: 2 });
    state.seq = (state.seq + 1) & 0xff;
    for (const s of tcpClients) { try { s.write(buf); } catch { /* yok */ } }
    if (udpOut) { try { udpOut.send(buf, opts.udp.port, opts.udp.host || '127.0.0.1', () => {}); } catch { /* yok */ } }
    if (udpIn && udpPeer) { try { udpIn.send(buf, udpPeer.port, udpPeer.address, () => {}); } catch { /* yok */ } }
  }

  const bootMs = () => (Date.now() - state.boot) >>> 0;

  function statustext(text, severity = 6) {
    const bytes = Buffer.from(String(text), 'utf8');
    if (bytes.length <= 50) { send('STATUSTEXT', { severity, text: bytes }); return; }
    // 50 bayttan uzun metinler parçalanır (id ≠ 0, chunk_seq artar)
    state.textId = (state.textId % 65535) + 1;
    for (let i = 0, n = 0; i < bytes.length; i += 50, n++) send('STATUSTEXT', { severity, text: bytes.subarray(i, i + 50), id: state.textId, chunk_seq: n });
    if (bytes.length % 50 === 0) send('STATUSTEXT', { severity, text: '', id: state.textId, chunk_seq: bytes.length / 50 }); // tam dolu son parçadan sonra boş parça
  }

  // ---- Uçuş benzetimi: ev çevresinde 150 m yarıçaplı daire, 0–60 m arası irtifa ----
  // interactive: araç yerde başlar ve komutlara uyar (kalkış, noktaya git, iniş, eve dönüş); simSpeed hızı çarpar
  const mPerLon = 111320 * Math.cos(home.lat * Math.PI / 180);
  function fly() {
    const now = Date.now();
    const p = state.pos;
    const dt = Math.min((now - p.at) / 1000, 1) * (opts.simSpeed || 1);
    p.at = now;
    let tgt = null;
    if (state.armed) {
      if (state.mode === 9) tgt = { n: p.n, e: p.e, alt: 0 };
      else if (state.mode === 6) { const near = Math.hypot(p.n, p.e) < 1; tgt = { n: 0, e: 0, alt: near ? 0 : Math.max(p.alt, 15) }; }
      else if (state.mode === 4 && state.target) tgt = state.target;
      else if (state.mode === 3) tgt = missionStep(p, now);
    } else if (p.alt > 0) { p.alt = Math.max(0, p.alt - 9 * dt); p.vd = 9; }
    p.vn = 0; p.ve = 0; if (state.armed) p.vd = 0;
    if (tgt) {
      const dn = tgt.n - p.n; const de = tgt.e - p.e; const d = Math.hypot(dn, de);
      if (d > 0.05 && p.alt > 0.5) {
        const v = Math.min(state.mode === 3 && state.auto.speed > 0 ? state.auto.speed : 12, d / Math.max(dt, 1e-3));
        p.vn = (dn / d) * v; p.ve = (de / d) * v;
        p.n += p.vn * dt; p.e += p.ve * dt;
        if (d > 1) p.heading = ((Math.atan2(de, dn) * 180 / Math.PI) + 360) % 360;
      }
      const da = tgt.alt - p.alt;
      if (Math.abs(da) > 0.02) { const v = Math.sign(da) * Math.min(3, Math.abs(da) / Math.max(dt, 1e-3)); p.alt += v * dt; p.vd = -v; }
      if ((state.mode === 9 || state.mode === 6) && tgt.alt === 0 && p.alt <= 0.05) { p.alt = 0; state.armed = false; state.target = null; state.auto.started = false; statustext('Disarming motors', 6); sendHeartbeat(); }
    }
    const speed = Math.hypot(p.vn, p.ve);
    return {
      t: (now - state.boot) / 1000, rel: p.alt, vn: p.vn, ve: p.ve, vd: p.vd, heading: p.heading, speed,
      lat: home.lat + p.n / 111320, lon: home.lon + p.e / mPerLon,
      roll: speed > 0.5 ? 0.05 : 0, pitch: speed > 0.5 ? -0.12 : 0, yaw: p.heading * Math.PI / 180,
    };
  }
  const toLocal = (lat, lon) => ({ n: (lat - home.lat) * 111320, e: (lon - home.lon) * mPerLon });

  // ---- Görev protokolü ----
  let gcs = { sysid: 255, compid: 190 }; // son görev iletisini gönderen yer istasyonu
  let missionRx = null;                  // süren yükleme: { type, count, items, tries, timer }
  const dropLeft = { count: opts.dropMissionRequests || 0, item: opts.dropMissionRequests || 0 };
  const missionRetryMs = opts.missionRetryMs || 250;
  const mTarget = (type) => ({ target_system: gcs.sysid, target_component: gcs.compid, mission_type: type });
  const missionAck = (type, result) => send('MISSION_ACK', { ...mTarget(type), type: result });
  function sendMissionCurrent() {
    send('MISSION_CURRENT', { seq: state.missionCur, total: state.mission[0].length, mission_state: state.auto.started ? (state.mode === 3 ? 3 : 4) : state.mission[0].length ? 2 : 1 });
  }
  function setMissionCurrent(seq) {
    if (!Number.isInteger(seq) || seq < 0 || seq >= state.mission[0].length) return false;
    state.missionCur = seq;
    state.auto.seq = seq;
    state.auto.entered = false;
    sendMissionCurrent();
    return true;
  }
  function missionRequest() {
    const rx = missionRx;
    send(opts.legacyMission ? 'MISSION_REQUEST' : 'MISSION_REQUEST_INT', { ...mTarget(rx.type), seq: rx.items.length });
    clearTimeout(rx.timer); timers.delete(rx.timer);
    rx.timer = later(() => {
      if (missionRx !== rx) return;
      if (rx.tries >= 4) { missionRx = null; missionAck(rx.type, 15); return; } // MAV_MISSION_OPERATION_CANCELLED
      rx.tries++;
      missionRequest();
    }, missionRetryMs);
  }
  function onMissionCount(f) {
    const type = f.mission_type || 0;
    calls.push({ name: 'MISSION_COUNT', id: -1, params: [f.count, type] });
    if (dropLeft.count > 0) { dropLeft.count--; return; }
    if (opts.noFence && type !== 0) { missionAck(type, 3); return; }
    if (!(type in state.mission)) { missionAck(type, 3); return; }
    if (opts.missionMax !== undefined && f.count > opts.missionMax) { missionAck(type, 4); return; } // MAV_MISSION_NO_SPACE
    if (missionRx) { clearTimeout(missionRx.timer); timers.delete(missionRx.timer); }
    if (!f.count) { missionRx = null; storeMission(type, []); missionAck(type, 0); return; }
    missionRx = { type, count: f.count, items: [], tries: 0, timer: null };
    missionRequest();
  }
  function storeMission(type, items) {
    state.mission[type] = items;
    if (type === 0) { state.missionCur = 0; state.auto = { started: false, seq: 0, entered: false, speed: 0, jumps: {}, holdUntil: 0, hold: null }; }
  }
  function onMissionItem(f, int) {
    const rx = missionRx;
    const type = f.mission_type || 0;
    if (!rx || rx.type !== type) return;
    if (dropLeft.item > 0) { dropLeft.item--; return; }
    if (f.seq < rx.items.length) return; // yinelenen öğe
    if (f.seq > rx.items.length) { missionAck(type, 13); return; } // MAV_MISSION_INVALID_SEQUENCE
    rx.items.push({ seq: f.seq, mission_type: type, frame: f.frame, command: f.command, current: f.current, autocontinue: f.autocontinue,
      param1: f.param1, param2: f.param2, param3: f.param3, param4: f.param4, x: int ? f.x : Math.round(f.x * 1e7), y: int ? f.y : Math.round(f.y * 1e7), z: f.z });
    rx.tries = 0;
    if (rx.items.length < rx.count) { missionRequest(); return; }
    clearTimeout(rx.timer); timers.delete(rx.timer);
    missionRx = null;
    storeMission(type, rx.items);
    missionAck(type, 0);
  }
  function sendMissionItem(f, int) {
    const type = f.mission_type || 0;
    if (opts.noFence && type !== 0) { missionAck(type, 3); return; }
    const it = (state.mission[type] || [])[f.seq];
    if (!it) { missionAck(type, 13); return; }
    const { x, y, ...rest } = it;
    if (int) send('MISSION_ITEM_INT', { ...mTarget(type), ...rest, x, y, current: type === 0 && f.seq === state.missionCur ? 1 : 0 });
    else send('MISSION_ITEM', { ...mTarget(type), ...rest, x: x / 1e7, y: y / 1e7, current: type === 0 && f.seq === state.missionCur ? 1 : 0 });
  }

  // Görev uçuşu (interactive, kurulu, AUTO, başlatılmış): etkin öğenin hedefini döndürür; öğe bitince sıradakine geçer.
  //   0. öğe evdir. Kalkış, nokta/eğri/bekleme (nokta gibi), DO_JUMP, DO_CHANGE_SPEED, RTL (kip 6), iniş (kip 9); öteki DO_ komutları atlanır.
  function missionStep(p, now) {
    const a = state.auto;
    if (!a.started) {
      if (a.done) return a.hold; // görev bitti: olduğu yerde bekler
      if (p.alt <= 0.5 || state.mission[0].length < 2) return null; // yerde MISSION_START beklenir
      a.started = true; a.entered = false; // havada AUTO kipine geçince görev kendiliğinden başlar
      if (a.seq < 1) a.seq = 1;
    }
    const list = state.mission[0];
    for (let guard = 0; guard < 100; guard++) {
      const it = list[a.seq];
      if (!it) { a.started = false; a.done = true; a.hold = { n: p.n, e: p.e, alt: p.alt }; sendMissionCurrent(); return a.hold; }
      if (!a.entered) {
        a.entered = true; a.holdUntil = 0; a.hold = { n: p.n, e: p.e, alt: p.alt };
        if (state.missionCur !== a.seq) { state.missionCur = a.seq; sendMissionCurrent(); }
      }
      const advance = () => { a.seq++; a.entered = false; };
      const reached = () => send('MISSION_ITEM_REACHED', { seq: a.seq });
      switch (it.command) {
        case 22: { // NAV_TAKEOFF: bulunduğu yerde z irtifasına tırmanır
          if (Math.abs(p.alt - it.z) < 0.3) { reached(); advance(); break; }
          return { n: a.hold.n, e: a.hold.e, alt: it.z };
        }
        case 16: case 82: case 17: case 18: case 19: { // nokta, eğri, bekleme türleri
          const tgt = it.x || it.y ? { ...toLocal(it.x / 1e7, it.y / 1e7), alt: it.z } : { n: a.hold.n, e: a.hold.e, alt: it.z };
          if (Math.hypot(tgt.n - p.n, tgt.e - p.e) > 0.5 || Math.abs(tgt.alt - p.alt) > 0.3) return tgt;
          if (it.command === 17) return tgt; // süresiz bekleme
          const wait = it.command === 16 || it.command === 19 ? (Number.isFinite(it.param1) ? it.param1 : 0) : 0;
          if (wait > 0) {
            if (!a.holdUntil) a.holdUntil = now + (wait * 1000) / (opts.simSpeed || 1);
            if (now < a.holdUntil) return tgt;
          }
          reached(); advance();
          break;
        }
        case 177: { // DO_JUMP: param1 = hedef seq, param2 = yineleme sayısı (-1 = sonsuz)
          const done = a.jumps[a.seq] || 0;
          if (it.param2 < 0 || done < it.param2) { a.jumps[a.seq] = done + 1; a.seq = Math.round(it.param1); a.entered = false; } else advance();
          break;
        }
        case 178: if (it.param2 > 0) a.speed = it.param2; advance(); break; // DO_CHANGE_SPEED
        case 20: a.started = false; state.mode = 6; sendHeartbeat(); return null; // NAV_RETURN_TO_LAUNCH
        case 21: a.started = false; state.mode = 9; sendHeartbeat(); return null;            // NAV_LAND
        default: advance();
      }
    }
    return a.hold;
  }

  function flight() {
    if (state.pos) return fly();
    const t = (Date.now() - state.boot) / 1000;
    const R = 150;
    const omega = (2 * Math.PI) / 90; // 90 sn'de bir tur
    const a = omega * t;
    const north = R * Math.cos(a);
    const east = R * Math.sin(a);
    const rel = 30 + 30 * Math.sin(t / 20);
    const speed = R * omega;
    const vn = -speed * Math.sin(a);
    const ve = speed * Math.cos(a);
    const vd = -1.5 * Math.cos(t / 20);
    const heading = ((Math.atan2(ve, vn) * 180 / Math.PI) + 360) % 360;
    return {
      t, rel, vn, ve, vd, heading, speed,
      lat: home.lat + north / 111320,
      lon: home.lon + east / (111320 * Math.cos(home.lat * Math.PI / 180)),
      roll: 0.12 * Math.sin(t * 0.7) + 0.08,
      pitch: 0.06 * Math.sin(t * 0.5 + 1),
      yaw: heading * Math.PI / 180,
    };
  }

  const battery = () => {
    const t = (Date.now() - state.boot) / 1000;
    const pct = Math.max(5, 98 - t / 30);
    return { pct: Math.round(pct), mv: Math.round(14000 + pct * 28), ca: state.armed ? 1850 : 60 };
  };

  function sendHeartbeat() {
    send('HEARTBEAT', { type: 2, autopilot: 3, base_mode: 1 | 16 | 64 | (state.armed ? 128 : 0) | (state.mode === 0 ? 0 : 8), custom_mode: state.mode, system_status: state.armed ? 4 : 3, mavlink_version: 3 });
  }

  const TELEMETRY = {
    ATTITUDE() { const f = flight(); send('ATTITUDE', { time_boot_ms: bootMs(), roll: f.roll, pitch: f.pitch, yaw: f.yaw > Math.PI ? f.yaw - 2 * Math.PI : f.yaw, rollspeed: 0.084 * Math.cos(f.t * 0.7), pitchspeed: 0.03 * Math.cos(f.t * 0.5 + 1), yawspeed: 0.0698 }); },
    GLOBAL_POSITION_INT() { const f = flight(); send('GLOBAL_POSITION_INT', { time_boot_ms: bootMs(), lat: Math.round(f.lat * 1e7), lon: Math.round(f.lon * 1e7), alt: Math.round((home.alt + f.rel) * 1000), relative_alt: Math.round(f.rel * 1000), vx: Math.round(f.vn * 100), vy: Math.round(f.ve * 100), vz: Math.round(f.vd * 100), hdg: Math.round(f.heading * 100) }); },
    VFR_HUD() { const f = flight(); send('VFR_HUD', { airspeed: f.speed + 0.4, groundspeed: f.speed, heading: Math.round(f.heading), throttle: state.armed ? 42 : 0, alt: home.alt + f.rel, climb: -f.vd }); },
    SYS_STATUS() { const b = battery(); send('SYS_STATUS', { onboard_control_sensors_present: SENSORS, onboard_control_sensors_enabled: SENSORS, onboard_control_sensors_health: SENSORS, load: 182, voltage_battery: b.mv, current_battery: b.ca, battery_remaining: b.pct }); },
    GPS_RAW_INT() { const f = flight(); send('GPS_RAW_INT', { time_usec: bootMs() * 1000, fix_type: 3, lat: Math.round(f.lat * 1e7), lon: Math.round(f.lon * 1e7), alt: Math.round((home.alt + f.rel) * 1000), eph: 85, epv: 120, vel: Math.round(f.speed * 100), cog: Math.round(f.heading * 100), satellites_visible: 14 }); },
    RC_CHANNELS() {
      const t = (Date.now() - state.boot) / 1000;
      const fields = { time_boot_ms: bootMs(), chancount: 8, rssi: 210 };
      const vals = [1500 + Math.round(120 * Math.sin(t)), 1500 + Math.round(80 * Math.cos(t * 0.8)), state.armed ? 1480 : 1100, 1500, 1300, 1500, 1000, 2000];
      for (let i = 1; i <= 18; i++) fields[`chan${i}_raw`] = i <= 8 ? vals[i - 1] : 0;
      send('RC_CHANNELS', fields);
    },
    SERVO_OUTPUT_RAW() {
      const t = (Date.now() - state.boot) / 1000;
      const fields = { time_usec: bootMs() * 1000, port: 0 };
      for (let i = 1; i <= 16; i++) fields[`servo${i}_raw`] = i <= 4 ? (state.armed ? 1450 + Math.round(40 * Math.sin(t * 3 + i)) : 1000) : 0;
      if (state.motorTest) fields[`servo${state.motorTest.output}_raw`] = state.motorTest.pwm;
      send('SERVO_OUTPUT_RAW', fields);
    },
    BATTERY_STATUS() { const b = battery(); const voltages = new Array(10).fill(65535); voltages[0] = b.mv; send('BATTERY_STATUS', { id: 0, battery_function: 0, type: 1, temperature: 32767, voltages, current_battery: b.ca, current_consumed: 420, energy_consumed: -1, battery_remaining: b.pct }); },
    HOME_POSITION() { send('HOME_POSITION', { latitude: Math.round(home.lat * 1e7), longitude: Math.round(home.lon * 1e7), altitude: Math.round(home.alt * 1000), q: [1, 0, 0, 0] }); },
    NAV_CONTROLLER_OUTPUT() { const f = flight(); send('NAV_CONTROLLER_OUTPUT', { nav_roll: 4.5, nav_pitch: 1.2, nav_bearing: Math.round(f.heading), target_bearing: Math.round(f.heading), wp_dist: 150, alt_error: 0.3, aspd_error: 0, xtrack_error: 0.4 }); },
    VIBRATION() { send('VIBRATION', { time_usec: bootMs() * 1000, vibration_x: 4.1, vibration_y: 5.3, vibration_z: 9.8 }); },
    EKF_STATUS_REPORT() { send('EKF_STATUS_REPORT', { flags: 831, velocity_variance: 0.03, pos_horiz_variance: 0.02, pos_vert_variance: 0.01, compass_variance: 0.05, terrain_alt_variance: 0 }); },
  };
  // Varsayılan hızlar (Hz)
  const RATES = { ATTITUDE: 10, GLOBAL_POSITION_INT: 4, VFR_HUD: 4, SYS_STATUS: 2, GPS_RAW_INT: 2, RC_CHANNELS: 5, SERVO_OUTPUT_RAW: 5, BATTERY_STATUS: 1, HOME_POSITION: 0.5, NAV_CONTROLLER_OUTPUT: 2, VIBRATION: 1, EKF_STATUS_REPORT: 1 };

  function sendParam(name, index) {
    const p = params.get(name);
    if (!p) return;
    send('PARAM_VALUE', { param_id: name, param_value: p.value, param_type: p.type, param_count: params.size, param_index: index === undefined ? 65535 : index });
  }

  function ack(command, result, extra) {
    send('COMMAND_ACK', { command, result, ...(extra || {}) });
  }

  // ---- İvmeölçer kalibrasyonu: 6 konum, her biri için yer istasyonunun onayı beklenir ----
  function accelPrompt(step) {
    state.accelStep = step;
    statustext(`Place vehicle ${ACCEL_PROMPTS[step]} and press any key.`, 2);
    send('COMMAND_LONG', { target_system: 0, target_component: 0, command: 42429, confirmation: 0, param1: step });
  }

  function accelAdvance() {
    const step = state.accelStep;
    state.accelStep = -1; // örnek toplanıyor
    later(() => {
      if (step >= 6) {
        state.accelStep = 0;
        statustext('Calibration successful', 2);
        send('COMMAND_LONG', { target_system: 0, target_component: 0, command: 42429, confirmation: 0, param1: 16777215 });
      } else {
        accelPrompt(step + 1);
      }
    }, calStepMs);
  }

  // ---- Pusula kalibrasyonu: %0 → %100 ilerleme, ardından rapor ----
  function magStart(autosave) {
    magStop();
    const cal = { pct: 0, autosave, timer: null, reported: 0 };
    state.magCal = cal;
    cal.timer = every(() => {
      if (cal.pct < 100) {
        cal.pct = Math.min(100, cal.pct + 10);
        send('MAG_CAL_PROGRESS', { compass_id: 0, cal_mask: 1, cal_status: cal.pct < 30 ? 2 : 3, attempt: 1, completion_pct: cal.pct, completion_mask: new Array(10).fill(cal.pct >= 100 ? 255 : 15), direction_x: 0.3, direction_y: -0.5, direction_z: 0.8 });
        return;
      }
      send('MAG_CAL_REPORT', { compass_id: 0, cal_mask: 1, cal_status: 4, autosaved: cal.autosave ? 1 : 0, fitness: 7.25, ofs_x: 31.5, ofs_y: -120.5, ofs_z: 64, diag_x: 1, diag_y: 1, diag_z: 1, offdiag_x: 0, offdiag_y: 0, offdiag_z: 0 });
      cal.reported++;
      if (cal.autosave || cal.reported > 20) {
        if (cal.autosave) { params.get('COMPASS_OFS_X').value = 31.5; params.get('COMPASS_OFS_Y').value = -120.5; params.get('COMPASS_OFS_Z').value = 64; }
        magStop();
      }
    }, calStepMs);
  }

  function magStop() {
    if (state.magCal) { clearInterval(state.magCal.timer); timers.delete(state.magCal.timer); state.magCal = null; }
  }

  function onCommand(f) {
    const id = f.command;
    const p = [f.param1, f.param2, f.param3, f.param4, f.param5, f.param6, f.param7];
    const def = COMMANDS[id];
    if ((opts.unsupported || []).includes(id)) { calls.push({ name: def ? def.name : `CMD_${id}`, id, params: p }); ack(id, 3); return; }
    calls.push({ name: def ? def.name : `CMD_${id}`, id, params: p, ...(f.frame !== undefined ? { frame: f.frame } : {}) });
    switch (id) {
      case 400: { // MAV_CMD_COMPONENT_ARM_DISARM
        const on = p[0] >= 0.5;
        if (on && opts.denyArm && p[1] !== 2989 && p[1] !== 21196) { statustext('PreArm: Compass not calibrated', 2); ack(id, 4); break; }
        state.armed = on;
        ack(id, 0);
        statustext(on ? 'Arming motors' : 'Disarming motors', 6);
        sendHeartbeat();
        break;
      }
      case 176: // MAV_CMD_DO_SET_MODE
        if (!(Math.round(p[1]) in MODE_NAMES) && Math.round(p[1]) > 28) { ack(id, 4); break; }
        state.mode = Math.round(p[1]);
        ack(id, 0);
        sendHeartbeat();
        break;
      case 209: { // MAV_CMD_DO_MOTOR_TEST
        if (state.armed) { statustext('Motor Test: vehicle armed', 2); ack(id, 4); break; }
        const quadX = { 1: 1, 2: 4, 3: 2, 4: 3 }; // test sırası → çıkış numarası (QUAD X)
        const seq = Math.round(p[0]);
        ack(id, 0);
        if (p[2] > 0 && p[3] > 0) {
          statustext('starting motor test', 6);
          state.motorTest = { output: quadX[seq] || 1, pwm: 1000 + Math.round(p[2] * 10) };
          clearTimeout(state.motorTimer);
          state.motorTimer = later(() => { state.motorTest = null; statustext('finished motor test', 6); }, Math.min(p[3] * 1000, 1500));
        } else {
          state.motorTest = null;
        }
        break;
      }
      case 241: // MAV_CMD_PREFLIGHT_CALIBRATION
        if (state.armed) { ack(id, 4); break; }
        if (p[4] === 1) { ack(id, 0); later(() => accelPrompt(1), Math.min(calStepMs, 100)); break; } // tam ivmeölçer kalibrasyonu
        if (p[0] === 1 || p[2] === 1 || p[4] === 2 || p[4] === 4) {
          // jiroskop / barometre / seviye: kısa bir süre sonra onay
          later(() => {
            ack(id, 0);
            statustext(p[0] === 1 ? 'Gyro calibration complete' : p[2] === 1 ? 'Barometer calibration complete' : 'Trim OK', 6);
          }, Math.min(calStepMs, 150));
          break;
        }
        ack(id, 3);
        break;
      case 42429: // MAV_CMD_ACCELCAL_VEHICLE_POS (yer istasyonu: araç istenen konumda)
        if (state.accelStep > 0 && Math.round(p[0]) === state.accelStep) { ack(id, 0); accelAdvance(); } else ack(id, 4);
        break;
      case 42424: ack(id, 0); magStart(p[2] >= 0.5); break; // MAV_CMD_DO_START_MAG_CAL
      case 42425: // MAV_CMD_DO_ACCEPT_MAG_CAL
        if (state.magCal && state.magCal.pct >= 100) { magStop(); ack(id, 0); } else ack(id, 4);
        break;
      case 42426: magStop(); ack(id, 0); break; // MAV_CMD_DO_CANCEL_MAG_CAL
      case 246: // MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN
        ack(id, 0);
        state.rebooted++;
        state.armed = false;
        state.boot = Date.now();
        statustext('Rebooting', 6);
        break;
      case 511: // MAV_CMD_SET_MESSAGE_INTERVAL
        state.intervals[Math.round(p[0])] = p[1];
        ack(id, 0);
        break;
      case 512: // MAV_CMD_REQUEST_MESSAGE
        if (Math.round(p[0]) === 148) { ack(id, 0); sendVersion(); } else if (Math.round(p[0]) === 242) { ack(id, 0); TELEMETRY.HOME_POSITION(); } else ack(id, 4);
        break;
      case 520: ack(id, 0); sendVersion(); break; // MAV_CMD_REQUEST_AUTOPILOT_CAPABILITIES
      case 179: ack(id, 0); break; // MAV_CMD_DO_SET_HOME
      case 22: { // MAV_CMD_NAV_TAKEOFF (GUIDED kipinde ve kuruluyken)
        if (!state.armed || state.mode !== 4) { statustext('Takeoff: not armed or not in GUIDED', 4); ack(id, 4); break; }
        const cur = state.pos || { n: 0, e: 0 };
        state.target = { n: cur.n, e: cur.e, alt: p[6] };
        ack(id, 0);
        break;
      }
      case 192: { // MAV_CMD_DO_REPOSITION (COMMAND_INT)
        if (opts.noReposition) { ack(id, 3); break; }
        if (!state.armed) { ack(id, 4); break; }
        if (state.mode !== 4) { if (!(Math.round(p[1]) & 1)) { ack(id, 2); break; } state.mode = 4; sendHeartbeat(); }
        state.target = { ...toLocal(p[4], p[5]), alt: p[6], lat: p[4], lon: p[5] };
        ack(id, 0);
        break;
      }
      case 20: state.mode = 6; ack(id, 0); sendHeartbeat(); break; // MAV_CMD_NAV_RETURN_TO_LAUNCH
      case 21: state.mode = 9; ack(id, 0); sendHeartbeat(); break; // MAV_CMD_NAV_LAND
      case 224: ack(id, setMissionCurrent(Math.round(p[0])) ? 0 : 4); break; // MAV_CMD_DO_SET_MISSION_CURRENT
      case 300: { // MAV_CMD_MISSION_START (kurulu ve AUTO kipinde)
        if (!state.armed || state.mode !== 3) { ack(id, 4); break; }
        const a = state.auto;
        a.started = true; a.done = false; a.entered = false; a.jumps = {}; a.speed = 0;
        if (a.seq < 1 || a.seq >= state.mission[0].length) a.seq = 1;
        ack(id, 0);
        break;
      }
      default: ack(id, 3); // MAV_RESULT_UNSUPPORTED
    }
  }

  function sendVersion() {
    // Gerçek ArduPilot gibi sürüm istenince tanıtım metinlerini de gönderir
    statustext('ArduCopter V4.5.7 (sim)', 6);
    statustext('Frame: QUAD/X', 6);
    send('AUTOPILOT_VERSION', { capabilities: 0xf1ef, flight_sw_version: (4 << 24) | (5 << 16) | (7 << 8) | 255, middleware_sw_version: 0, os_sw_version: 0, board_version: 0, flight_custom_version: Buffer.from('a1b2c3d4'), vendor_id: 0x1209, product_id: 0x5741, uid: 0 });
  }

  function onMessage(msg) {
    const f = msg.fields;
    if (!f) return;
    if ('target_system' in f && f.target_system !== 0 && f.target_system !== sysid) return;
    if (/^MISSION_/.test(msg.name)) gcs = { sysid: msg.sysid, compid: msg.compid };
    switch (msg.name) {
      case 'MISSION_COUNT': onMissionCount(f); break;
      case 'MISSION_ITEM_INT': onMissionItem(f, true); break;
      case 'MISSION_ITEM': onMissionItem(f, false); break;
      case 'MISSION_REQUEST_LIST': {
        const type = f.mission_type || 0;
        calls.push({ name: 'MISSION_REQUEST_LIST', id: -1, params: [type] });
        if ((opts.noFence && type !== 0) || !(type in state.mission)) { missionAck(type, 3); break; }
        send('MISSION_COUNT', { ...mTarget(type), count: state.mission[type].length });
        break;
      }
      case 'MISSION_REQUEST_INT': if (!opts.legacyMission) sendMissionItem(f, true); break; // eski yazılım _INT isteğini tanımaz
      case 'MISSION_REQUEST': sendMissionItem(f, !opts.legacyMission); break;
      case 'MISSION_ACK': calls.push({ name: 'MISSION_ACK', id: -1, params: [f.type, f.mission_type || 0] }); break;
      case 'MISSION_CLEAR_ALL': {
        const type = f.mission_type || 0;
        calls.push({ name: 'MISSION_CLEAR_ALL', id: -1, params: [type] });
        if ((opts.noFence && type !== 0) || !(type in state.mission)) { missionAck(type, 3); break; }
        storeMission(type, []);
        missionAck(type, 0);
        break;
      }
      case 'MISSION_SET_CURRENT':
        calls.push({ name: 'MISSION_SET_CURRENT', id: -1, params: [f.seq] });
        setMissionCurrent(f.seq);
        break;
      case 'COMMAND_LONG': onCommand(f); break;
      case 'COMMAND_INT': onCommand({ command: f.command, param1: f.param1, param2: f.param2, param3: f.param3, param4: f.param4, param5: f.x / 1e7, param6: f.y / 1e7, param7: f.z, frame: f.frame }); break;
      case 'SET_POSITION_TARGET_GLOBAL_INT':
        calls.push({ name: 'SET_POSITION_TARGET_GLOBAL_INT', id: -1, params: [f.lat_int, f.lon_int, f.alt, f.coordinate_frame, f.type_mask] });
        if (state.mode === 4) state.target = { ...toLocal(f.lat_int / 1e7, f.lon_int / 1e7), alt: f.alt, lat: f.lat_int / 1e7, lon: f.lon_int / 1e7 };
        break;
      case 'PARAM_REQUEST_LIST': {
        calls.push({ name: 'PARAM_REQUEST_LIST', id: -1, params: [] });
        const list = names();
        const skip = new Set(drop);
        drop.clear(); // yalnızca ilk listede düşürülür
        let i = 0;
        const burst = () => {
          for (let n = 0; n < 12 && i < list.length; n++, i++) if (!skip.has(i)) sendParam(list[i], i);
          if (i < list.length) later(burst, 4);
        };
        burst();
        break;
      }
      case 'PARAM_REQUEST_READ': {
        const list = names();
        calls.push({ name: 'PARAM_REQUEST_READ', id: -1, params: [f.param_index, f.param_id] });
        if (f.param_index >= 0 && f.param_index < list.length) sendParam(list[f.param_index], f.param_index);
        else if (params.has(f.param_id)) sendParam(f.param_id, list.indexOf(f.param_id));
        break;
      }
      case 'PARAM_SET': {
        calls.push({ name: 'PARAM_SET', id: -1, params: [f.param_id, f.param_value, f.param_type] });
        const p = params.get(f.param_id);
        if (!p) break;
        if (!(opts.readOnlyParams || []).includes(f.param_id)) p.value = p.type === T.REAL32 ? Math.fround(f.param_value) : Math.round(f.param_value);
        sendParam(f.param_id, names().indexOf(f.param_id));
        break;
      }
      case 'SET_MODE':
        calls.push({ name: 'SET_MODE', id: -1, params: [f.base_mode, f.custom_mode] });
        state.mode = f.custom_mode;
        sendHeartbeat();
        break;
      case 'REQUEST_DATA_STREAM':
        calls.push({ name: 'REQUEST_DATA_STREAM', id: -1, params: [f.req_stream_id, f.req_message_rate, f.start_stop] });
        state.streams[f.req_stream_id] = f.start_stop ? f.req_message_rate : 0;
        break;
      case 'COMMAND_ACK': // eski tür ivmeölçer onayı (command ≤ 6, result = 1)
        calls.push({ name: 'COMMAND_ACK', id: -1, params: [f.command, f.result] });
        if (state.accelStep > 0 && f.command <= 6 && f.result === 1) accelAdvance();
        break;
      default:
    }
  }

  function feed(parser, data) {
    let msgs;
    try { msgs = parser.push(data); } catch { return; }
    for (const m of msgs) { try { onMessage(m); } catch (err) { if (opts.debug) console.error(err); } }
  }

  sim.start = async () => {
    if (running) return sim;
    running = true;
    state.boot = Date.now();
    if (opts.tcp !== undefined && opts.tcp !== null && opts.tcp !== false) {
      await new Promise((resolve, reject) => {
        tcpServer = net.createServer((sock) => {
          const parser = new MavParser();
          tcpClients.add(sock);
          sock.setNoDelay(true);
          sock.on('data', (d) => feed(parser, d));
          sock.on('error', () => {});
          sock.on('close', () => tcpClients.delete(sock));
        });
        tcpServer.once('error', reject);
        tcpServer.listen(Number(opts.tcp) || 0, opts.tcpHost || '127.0.0.1', () => { sim.tcpPort = tcpServer.address().port; resolve(); });
      });
    }
    if (opts.udp) {
      const parser = new MavParser();
      udpOut = dgram.createSocket('udp4');
      udpOut.on('error', () => {});
      udpOut.on('message', (d) => feed(parser, d));
      await new Promise((resolve) => udpOut.bind(0, resolve));
    }
    if (opts.udpListen !== undefined && opts.udpListen !== null && opts.udpListen !== false) {
      const parser = new MavParser();
      udpIn = dgram.createSocket('udp4');
      udpIn.on('error', () => {});
      udpIn.on('message', (d, rinfo) => { udpPeer = { address: rinfo.address, port: rinfo.port }; feed(parser, d); });
      await new Promise((resolve, reject) => { udpIn.once('error', reject); udpIn.bind(Number(opts.udpListen) || 0, opts.udpHost || '127.0.0.1', () => { sim.udpPort = udpIn.address().port; resolve(); }); });
    }
    every(sendHeartbeat, hbMs);
    for (const name of Object.keys(TELEMETRY)) every(TELEMETRY[name], Math.max(10, Math.round(1000 / (RATES[name] * scale))));
    every(sendMissionCurrent, Math.max(10, Math.round(1000 / scale)));
    sendHeartbeat();
    return sim;
  };

  sim.stop = async () => {
    running = false;
    for (const h of timers) { clearTimeout(h); clearInterval(h); }
    timers.clear();
    state.magCal = null;
    for (const s of tcpClients) { try { s.destroy(); } catch { /* yok */ } }
    tcpClients.clear();
    const closing = [];
    if (tcpServer) { const s = tcpServer; tcpServer = null; closing.push(new Promise((r) => s.close(() => r()))); }
    if (udpOut) { const s = udpOut; udpOut = null; closing.push(new Promise((r) => s.close(() => r()))); }
    if (udpIn) { const s = udpIn; udpIn = null; udpPeer = null; closing.push(new Promise((r) => s.close(() => r()))); }
    await Promise.all(closing);
  };

  sim.statustext = statustext;
  sim.setSilent = (on) => { state.silent = !!on; };
  sim.send = send;
  return sim;
}

module.exports = { createSim, DEFAULT_PARAMS };
