'use strict';

// Dron oturumları (ana süreç): her bağlı dron için bir araç nesnesi (MAVLink). Pencereler (dron penceresi,
// uçuş penceresi) aynı oturumu paylaşır; durum, telemetri, haberleşme günlüğü ve parametreler olaylarla iletilir.

const DRONE = require('./schema');

// Pencerelerin çağırabildiği araç işlevleri
const METHODS = new Set(['arm', 'setMode', 'motorTest', 'motorStop', 'calibrate', 'reboot', 'saveRcLimits', 'fetchParams', 'setParam', 'command', 'saveParams', 'exitCli', 'cli', 'takeoff', 'land', 'rtl', 'hold', 'goto', 'setAltitude', 'kill', 'replayPlay', 'replaySeek', 'replaySpeed',
  'uploadMission', 'downloadMission', 'clearMission', 'startMission', 'pauseMission', 'resumeMission', 'setMissionCurrent']);

// deps: { getDrone(id), emit(channel, payload), createVehicle(drone) → araç | null, paramDefs(firmware, vehicle) → sözlük | null,
//         recorder? (flightlog: state/text/close — telemetri kaydı; kayıt oynatan araçlar kaydedilmez) }
function createDroneSessions(deps) {
  const sessions = new Map(); // id → { vehicle, drone, recent: [] }

  function get(id) { return sessions.get(id) || null; }

  function open(id) {
    let s = sessions.get(id);
    if (s) return s;
    const drone = deps.getDrone(id);
    if (!drone) return null;
    const vehicle = deps.createVehicle(drone);
    if (!vehicle) return null;
    s = { vehicle, drone, recent: [] };
    sessions.set(id, s);
    const safe = (fn) => (...a) => { try { fn(...a); } catch { /* pencere kapanmış olabilir */ } };
    const rec = deps.recorder && !vehicle.isReplay ? deps.recorder : null;
    s.rec = rec;
    vehicle.on('state', safe((state) => { if (rec) { try { rec.state(id, drone, state); } catch { /* kayıt isteğe bağlı */ } } deps.emit('drone:state', { id, state }); }));
    vehicle.on('log', safe((entries) => {
      // Sonradan açılan pencere için son kayıtlar saklanır
      s.recent.push(...entries);
      if (s.recent.length > 3000) s.recent.splice(0, s.recent.length - 3000);
      deps.emit('drone:log', { id, entries });
    }));
    vehicle.on('statustext', safe((m) => { if (rec) { try { rec.text(id, m); } catch { /* yok */ } } deps.emit('drone:statustext', { id, ...m }); }));
    vehicle.on('params', safe((p) => deps.emit('drone:params', { id, ...p })));
    vehicle.on('param', safe((p) => deps.emit('drone:param', { id, ...p })));
    vehicle.on('calibration', safe((c) => deps.emit('drone:calibration', { id, ...c })));
    vehicle.on('mission', safe((p) => deps.emit('drone:mission', { id, ...p })));
    vehicle.on('cli', safe((c) => deps.emit('drone:cli', { id, ...c })));
    vehicle.on('error', () => {});
    return s;
  }

  async function connect(id) {
    const s = open(id);
    if (!s) return { connected: false, error: deps.getDrone(id) ? 'unsupported_firmware' : 'not_found' };
    try { await s.vehicle.connect(); } catch (e) { return { ...s.vehicle.snapshot(), error: (e && (e.code || e.message)) || 'io' }; }
    return s.vehicle.snapshot();
  }

  function close(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try { s.vehicle.disconnect(); } catch { /* yok */ }
    s.vehicle.removeAllListeners();
    if (s.rec) { try { s.rec.close(id); } catch { /* yok */ } }
    deps.emit('drone:state', { id, state: { connected: false, linked: false } });
  }

  const state = (id) => { const s = get(id); return s ? s.vehicle.snapshot() : null; };
  const recent = (id) => { const s = get(id); return s ? s.recent.slice(-1500) : []; };

  async function call(id, method, args) {
    const s = get(id);
    if (!s) return { ok: false, error: 'not_connected' };
    if (!METHODS.has(method) || typeof s.vehicle[method] !== 'function') return { ok: false, error: 'unsupported' };
    try {
      const r = await s.vehicle[method](...(Array.isArray(args) ? args : []));
      return r === undefined ? { ok: true } : r;
    } catch (e) { return { ok: false, error: 'error', detail: String((e && e.message) || e) }; }
  }

  // Parametre listesi: araçtan okunan değerler + açıklamalar (dil: 'tr' ise Türkçe, yoksa özgün metin)
  function params(id, lang) {
    const s = get(id);
    if (!s) return [];
    const st = s.vehicle.snapshot();
    const defs = deps.paramDefs(st.firmware, st.vehicle);
    return s.vehicle.getParams().map((p) => {
      // Betaflight: açıklama sözlüğü yok; aralık, seçenekler ve varsayılan değer karttan (CLI) gelir
      if (p.range !== undefined || p.values !== undefined || p.def !== undefined) {
        const values = Array.isArray(p.values) && p.values.length ? p.values.map((v) => ({ value: v, label: String(v) })) : [];
        return { name: p.name, value: p.value, type: p.type, index: p.index, text: p.type !== 'number', group: p.name.includes('_') ? p.name.split('_')[0].toUpperCase() : '',
          meta: { displayName: '', description: '', units: '', range: Array.isArray(p.range) ? p.range : null, increment: null, values, bits: [], readOnly: false, rebootRequired: false, def: p.def === undefined || p.def === null ? '' : String(p.def) }, original: '' };
      }
      const meta = defs ? defs.lookup(p.name, lang) : null;
      const orig = defs && lang !== 'en' ? defs.lookup(p.name, 'en') : null;
      return { ...p, group: defs ? defs.groupOf(p.name) : (p.name.includes('_') ? p.name.split('_')[0] : ''), meta, original: orig && meta && orig.description !== meta.description ? orig.description : '' };
    });
  }

  const closeAll = () => { for (const id of [...sessions.keys()]) close(id); };
  const active = () => [...sessions.keys()].filter((id) => { try { return sessions.get(id).vehicle.snapshot().connected; } catch { return false; } });

  return { open, connect, close, state, recent, call, params, closeAll, active, get, DRONE };
}

module.exports = { createDroneSessions, METHODS };
