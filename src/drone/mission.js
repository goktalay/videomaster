'use strict';

// Görev modeli (ana süreç + pencereler ortak kullanır; tarayıcıda window.MISSION).
//   Görev: { name, vehicle, home: { lat, lon, alt } | null, defaults: { alt, speed, frame }, items: [öğe…],
//            fence: { polygons: [{ inclusion, points: [[lat, lon]…] }], circles: [{ inclusion, lat, lon, radius }] },
//            rally: [{ lat, lon, alt }], notes }
//   Öğe:   { type, lat, lon, alt, frame: 'rel' | 'amsl' | 'terrain', p: { … türe özgü değerler } }
// Dönüşümler: MAVLink görev öğeleri (toMav / fromMav), QGroundControl .plan (toPlan / fromPlan), Mission Planner
// .waypoints (toWpl / fromWpl). Üreteçler: alan taraması (survey), koridor taraması (corridor), yapı çevresi (orbit).

(function (root) {
  const FRAME = { amsl: 0, rel: 3, terrain: 10, mission: 2 };
  const FRAME_NAME = { 0: 'amsl', 5: 'amsl', 3: 'rel', 6: 'rel', 10: 'terrain', 11: 'terrain' };

  // Öğe türleri. pos: konumu var; params: [anahtar, MAVLink parametre sırası (1-4), varsayılan, en az, en çok, adım]
  const TYPES = {
    takeoff:     { cmd: 22, pos: false, alt: true, params: [['pitch', 1, 15, 0, 90, 1]] },
    waypoint:    { cmd: 16, pos: true, params: [['hold', 1, 0, 0, 3600, 1], ['radius', 2, 0, 0, 500, 1], ['yaw', 4, null, 0, 360, 1]] },
    spline:      { cmd: 82, pos: true, params: [['hold', 1, 0, 0, 3600, 1]] },
    loiterTime:  { cmd: 19, pos: true, params: [['time', 1, 30, 0, 36000, 1], ['radius', 3, 50, -2000, 2000, 1]] },
    loiterTurns: { cmd: 18, pos: true, params: [['turns', 1, 2, 1, 255, 1], ['radius', 3, 50, -2000, 2000, 1]] },
    loiterUnlim: { cmd: 17, pos: true, params: [['radius', 3, 50, -2000, 2000, 1]] },
    loiterAlt:   { cmd: 31, pos: true, params: [['radius', 2, 50, -2000, 2000, 1]] },
    land:        { cmd: 21, pos: true, optionalPos: true, params: [] },
    rtl:         { cmd: 20, pos: false, params: [] },
    vtolTakeoff: { cmd: 84, pos: false, alt: true, params: [] },
    vtolLand:    { cmd: 85, pos: true, params: [] },
    delay:       { cmd: 93, pos: false, params: [['seconds', 1, 10, 0, 86400, 1]] },
    speed:       { cmd: 178, pos: false, params: [['speed', 2, 5, 0.1, 100, 0.1]], fixed: { 1: 1, 3: -1 } },
    yaw:         { cmd: 115, pos: false, params: [['angle', 1, 0, 0, 360, 1], ['rate', 2, 0, 0, 360, 1], ['relative', 4, 0, 0, 1, 1]] },
    roi:         { cmd: 195, pos: true, params: [] },
    roiNone:     { cmd: 197, pos: false, params: [] },
    jump:        { cmd: 177, pos: false, params: [['item', 1, 1, 1, 9999, 1], ['repeat', 2, 1, -1, 1000, 1]] },
    camTrigDist: { cmd: 206, pos: false, params: [['distance', 1, 25, 0, 10000, 0.5]], fixed: { 3: 1 } },
    camPhoto:    { cmd: 2000, pos: false, params: [['interval', 2, 0, 0, 3600, 0.1], ['count', 3, 1, 0, 10000, 1]] },
    camStop:     { cmd: 2001, pos: false, params: [] },
    videoStart:  { cmd: 2500, pos: false, params: [] },
    videoStop:   { cmd: 2501, pos: false, params: [] },
    gimbal:      { cmd: 205, pos: false, params: [['pitch', 1, -90, -180, 180, 1], ['yaw', 3, 0, -180, 180, 1]], fixed: { 7: 2 } },
    servo:       { cmd: 183, pos: false, params: [['channel', 1, 9, 1, 32, 1], ['pwm', 2, 1500, 500, 2500, 1]] },
    relay:       { cmd: 181, pos: false, params: [['relay', 1, 0, 0, 15, 1], ['on', 2, 1, 0, 1, 1]] },
    gripper:     { cmd: 211, pos: false, params: [['gripper', 1, 1, 1, 8, 1], ['grab', 2, 0, 0, 1, 1]] },
    changeAlt:   { cmd: 113, pos: false, alt: true, params: [['rate', 1, 0, 0, 50, 0.1]] },
    landStart:   { cmd: 189, pos: true, optionalPos: true, params: [] },
  };
  const CMD_TYPE = {};
  for (const [k, v] of Object.entries(TYPES)) CMD_TYPE[v.cmd] = k;
  // Araç sınıfına göre eklenebilir türler
  const AVAILABLE = {
    copter: ['takeoff', 'waypoint', 'spline', 'loiterTime', 'loiterTurns', 'loiterUnlim', 'land', 'rtl', 'delay', 'speed', 'yaw', 'roi', 'roiNone', 'jump', 'camTrigDist', 'camPhoto', 'camStop', 'videoStart', 'videoStop', 'gimbal', 'servo', 'relay', 'gripper', 'changeAlt'],
    plane: ['takeoff', 'waypoint', 'loiterTime', 'loiterTurns', 'loiterUnlim', 'loiterAlt', 'land', 'landStart', 'rtl', 'vtolTakeoff', 'vtolLand', 'delay', 'speed', 'roi', 'roiNone', 'jump', 'camTrigDist', 'camPhoto', 'camStop', 'videoStart', 'videoStop', 'gimbal', 'servo', 'relay', 'gripper', 'changeAlt'],
    rover: ['waypoint', 'loiterTime', 'loiterUnlim', 'rtl', 'delay', 'speed', 'jump', 'camTrigDist', 'camPhoto', 'camStop', 'servo', 'relay', 'gripper'],
    sub: ['waypoint', 'loiterTime', 'loiterUnlim', 'land', 'rtl', 'delay', 'speed', 'yaw', 'jump', 'servo', 'relay', 'gripper'],
  };
  const VEHICLES = Object.keys(AVAILABLE);

  const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const okLat = (v) => Number.isFinite(v) && Math.abs(v) <= 90;
  const okLon = (v) => Number.isFinite(v) && Math.abs(v) <= 180;
  const r7 = (v) => Math.round(v * 1e7) / 1e7;

  function newItem(type, at = {}, defaults = {}) {
    const def = TYPES[type] || TYPES.waypoint;
    const p = {};
    for (const [key, , dv] of def.params) p[key] = dv;
    return { type: TYPES[type] ? type : 'waypoint', lat: def.pos && okLat(at.lat) ? r7(at.lat) : null, lon: def.pos && okLon(at.lon) ? r7(at.lon) : null,
      alt: def.pos || def.alt ? num(at.alt, num(defaults.alt, 50)) : 0, frame: at.frame || defaults.frame || 'rel', p };
  }

  function normalizeItem(src, defaults) {
    const type = TYPES[src && src.type] ? src.type : 'waypoint';
    const def = TYPES[type];
    const it = newItem(type, { lat: num(src.lat, NaN), lon: num(src.lon, NaN), alt: src.alt, frame: FRAME[src.frame] !== undefined && src.frame !== 'mission' ? src.frame : undefined }, defaults);
    it.alt = clamp(num(it.alt), -1000, 100000);
    for (const [key, , dv, lo, hi] of def.params) {
      const v = src.p ? src.p[key] : undefined;
      it.p[key] = v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? dv : clamp(Number(v), lo, hi);
    }
    if (src.group) it.group = String(src.group).slice(0, 24); // üreteçle (tarama vb.) oluşturulan öğeler
    return it;
  }

  function normalize(input) {
    const src = input || {};
    const d = src.defaults || {};
    const defaults = { alt: clamp(num(d.alt, 50), 1, 10000), speed: clamp(num(d.speed, 5), 0.1, 100), frame: ['rel', 'amsl', 'terrain'].includes(d.frame) ? d.frame : 'rel' };
    const h = src.home;
    const fence = src.fence || {};
    const pts = (list) => (Array.isArray(list) ? list : []).map((q) => [num(q && q[0], NaN), num(q && q[1], NaN)]).filter((q) => okLat(q[0]) && okLon(q[1])).map((q) => [r7(q[0]), r7(q[1])]);
    return {
      name: String(src.name || '').trim().slice(0, 120),
      vehicle: VEHICLES.includes(src.vehicle) ? src.vehicle : 'copter',
      home: h && okLat(num(h.lat, NaN)) && okLon(num(h.lon, NaN)) ? { lat: r7(num(h.lat)), lon: r7(num(h.lon)), alt: num(h.alt) } : null,
      defaults,
      items: (Array.isArray(src.items) ? src.items : []).slice(0, 2000).map((it) => normalizeItem(it || {}, defaults)),
      fence: {
        polygons: (Array.isArray(fence.polygons) ? fence.polygons : []).slice(0, 20).map((pg) => ({ inclusion: pg.inclusion !== false, points: pts(pg.points).slice(0, 200) })).filter((pg) => pg.points.length >= 3),
        circles: (Array.isArray(fence.circles) ? fence.circles : []).slice(0, 20).map((c) => ({ inclusion: c.inclusion !== false, lat: num(c.lat, NaN), lon: num(c.lon, NaN), radius: clamp(num(c.radius, 100), 1, 100000) })).filter((c) => okLat(c.lat) && okLon(c.lon)),
      },
      rally: (Array.isArray(src.rally) ? src.rally : []).slice(0, 50).map((q) => ({ lat: num(q.lat, NaN), lon: num(q.lon, NaN), alt: num(q.alt, defaults.alt) })).filter((q) => okLat(q.lat) && okLon(q.lon)),
      notes: String(src.notes || '').slice(0, 4000),
    };
  }
  const KEYS = ['name', 'vehicle', 'home', 'defaults', 'items', 'fence', 'rally', 'notes', 'createdAt'];

  // Uyarılar: [{ code, index? }]
  function validate(m) {
    const out = [];
    if (!m.items.length) out.push({ code: 'empty' });
    m.items.forEach((it, i) => {
      const def = TYPES[it.type];
      if (def.pos && !def.optionalPos && (it.lat === null || it.lon === null)) out.push({ code: 'noPosition', index: i });
      if (it.type === 'jump' && (it.p.item < 1 || it.p.item > m.items.length)) out.push({ code: 'badJump', index: i });
    });
    const firstNav = m.items.find((it) => TYPES[it.type].pos || it.type === 'takeoff' || it.type === 'vtolTakeoff');
    if ((m.vehicle === 'copter' || m.vehicle === 'plane') && firstNav && firstNav.type !== 'takeoff' && firstNav.type !== 'vtolTakeoff') out.push({ code: 'noTakeoff' });
    return out;
  }

  // ---- Coğrafi yardımcılar ----
  const RAD = Math.PI / 180;
  function distance(lat1, lon1, lat2, lon2) {
    const a = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
    const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }
  // Yerel düzlem (metre): küçük alanlar için yeterli
  const toXY = (lat, lon, o) => [(lon - o[1]) * 111320 * Math.cos(o[0] * RAD), (lat - o[0]) * 110540];
  const toLL = (x, y, o) => [r7(o[0] + y / 110540), r7(o[1] + x / (111320 * Math.cos(o[0] * RAD)))];

  // Uçuş yolu: konumu olan öğeler sırayla (ev → … ; RTL eve döner). [{ lat, lon, alt, index }]
  function path(m) {
    const pts = [];
    if (m.home) pts.push({ lat: m.home.lat, lon: m.home.lon, alt: 0, index: -1 });
    m.items.forEach((it, i) => {
      const def = TYPES[it.type];
      if (it.type === 'roi') return;
      if (def.pos && it.lat !== null && it.lon !== null) pts.push({ lat: it.lat, lon: it.lon, alt: it.type === 'land' || it.type === 'vtolLand' ? 0 : it.alt, index: i });
      else if (it.type === 'rtl' && m.home) pts.push({ lat: m.home.lat, lon: m.home.lon, alt: 0, index: i });
    });
    return pts;
  }

  // { count, distance (m), time (sn), maxFromHome (m), maxAlt, minAlt }
  function stats(m) {
    const pts = path(m);
    let dist = 0; let time = 0; let far = 0; let maxAlt = 0;
    let speed = m.defaults.speed;
    const speedAt = {};
    let s = speed;
    m.items.forEach((it, i) => { if (it.type === 'speed') s = it.p.speed; speedAt[i] = s; });
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]; const b = pts[i];
      const d = Math.hypot(distance(a.lat, a.lon, b.lat, b.lon), b.alt - a.alt);
      speed = speedAt[b.index] || m.defaults.speed;
      dist += d; time += d / Math.max(0.1, speed);
    }
    for (const it of m.items) {
      if (it.type === 'takeoff' || it.type === 'vtolTakeoff') time += it.alt / 2.5;
      if (it.type === 'waypoint' || it.type === 'spline') time += it.p.hold || 0;
      if (it.type === 'loiterTime') time += it.p.time;
      if (it.type === 'delay') time += it.p.seconds;
      if (TYPES[it.type].pos || TYPES[it.type].alt) maxAlt = Math.max(maxAlt, it.alt);
    }
    if (m.home) for (const q of pts) far = Math.max(far, distance(m.home.lat, m.home.lon, q.lat, q.lon));
    return { count: m.items.length, distance: Math.round(dist), time: Math.round(time), maxFromHome: Math.round(far), maxAlt };
  }

  // ---- MAVLink ----
  // toMav(görev, { firmware }) → { mission: [öğe…], fence: [öğe…], rally: [öğe…] }
  //   öğe: { seq, frame, command, current, autocontinue, param1..param4, x (derece·1e7), y, z, mission_type }
  //   ArduPilot'ta görevin 0. öğesi ev konumudur; PX4'te ev öğesi yoktur.
  function itemToMav(it) {
    const def = TYPES[it.type];
    const o = { frame: def.pos || def.alt ? FRAME[it.frame] : FRAME.mission, command: def.cmd, current: 0, autocontinue: 1, param1: 0, param2: 0, param3: 0, param4: 0, x: 0, y: 0, z: 0 };
    for (const [key, n] of def.params) { const v = it.p[key]; o[`param${n}`] = v === null || v === undefined ? NaN : v; }
    for (const [n, v] of Object.entries(def.fixed || {})) { if (Number(n) <= 4) o[`param${n}`] = v; else if (Number(n) === 7) o.z = v; }
    if (it.type === 'jump') o.param1 = it.p.item; // seq, yüklerken ev öğesi kaydırması eklenir
    if (def.pos && it.lat !== null && it.lon !== null) { o.x = Math.round(it.lat * 1e7); o.y = Math.round(it.lon * 1e7); }
    if (def.pos || def.alt) o.z = it.alt;
    if (it.type === 'waypoint' && (it.p.yaw === null || it.p.yaw === undefined)) o.param4 = NaN;
    return o;
  }
  function toMav(m, opts = {}) {
    const ardu = (opts.firmware || 'ardupilot') !== 'px4';
    const off = ardu ? 1 : 0;
    const mission = [];
    if (ardu) { const h = m.home || { lat: 0, lon: 0, alt: 0 }; mission.push({ frame: 0, command: 16, current: 0, autocontinue: 1, param1: 0, param2: 0, param3: 0, param4: 0, x: Math.round(h.lat * 1e7), y: Math.round(h.lon * 1e7), z: h.alt || 0 }); }
    for (const it of m.items) { const o = itemToMav(it); if (it.type === 'jump') o.param1 = it.p.item - 1 + off; mission.push(o); }
    mission.forEach((o, i) => { o.seq = i; o.mission_type = 0; });
    if (mission.length > off) mission[off].current = 1;
    const fence = [];
    const fi = (command, p1, lat, lon) => fence.push({ frame: 0, command, current: 0, autocontinue: 1, param1: p1, param2: 0, param3: 0, param4: 0, x: Math.round(lat * 1e7), y: Math.round(lon * 1e7), z: 0 });
    for (const pg of m.fence.polygons) for (const q of pg.points) fi(pg.inclusion ? 5001 : 5002, pg.points.length, q[0], q[1]);
    for (const c of m.fence.circles) fi(c.inclusion ? 5003 : 5004, c.radius, c.lat, c.lon);
    fence.forEach((o, i) => { o.seq = i; o.mission_type = 1; });
    const rally = m.rally.map((q, i) => ({ seq: i, mission_type: 2, frame: 3, command: 5100, current: 0, autocontinue: 1, param1: 0, param2: 0, param3: 0, param4: 0, x: Math.round(q.lat * 1e7), y: Math.round(q.lon * 1e7), z: q.alt }));
    return { mission, fence, rally };
  }

  function itemFromMav(o) {
    const type = CMD_TYPE[o.command];
    if (!type) return null;
    const def = TYPES[type];
    const it = { type, lat: null, lon: null, alt: 0, frame: FRAME_NAME[o.frame] || 'rel', p: {} };
    for (const [key, n, dv] of def.params) { const v = o[`param${n}`]; it.p[key] = Number.isFinite(v) ? v : dv; }
    if (def.pos && (o.x || o.y)) { it.lat = r7(o.x / 1e7); it.lon = r7(o.y / 1e7); }
    if (def.pos || def.alt) it.alt = Number.isFinite(o.z) ? Math.round(o.z * 100) / 100 : 0;
    if (type === 'waypoint' && !Number.isFinite(o.param4)) it.p.yaw = null;
    return it;
  }
  // fromMav({ mission, fence, rally }, { firmware }) → görev (ad ve varsayılanlar boş); tanınmayan komutlar atlanır (skipped)
  function fromMav(sets, opts = {}) {
    const ardu = (opts.firmware || 'ardupilot') !== 'px4';
    const list = (sets.mission || []).slice().sort((a, b) => a.seq - b.seq);
    const m = { name: '', home: null, items: [], fence: { polygons: [], circles: [] }, rally: [] };
    let skipped = 0;
    if (ardu && list.length) { const h = list.shift(); if (h.x || h.y) m.home = { lat: h.x / 1e7, lon: h.y / 1e7, alt: h.z || 0 }; }
    for (const o of list) { const it = itemFromMav(o); if (!it) { skipped++; continue; } if (it.type === 'jump') it.p.item = Math.max(1, it.p.item + (ardu ? 0 : 1)); m.items.push(it); }
    let poly = null;
    for (const o of (sets.fence || []).slice().sort((a, b) => a.seq - b.seq)) {
      if (o.command === 5001 || o.command === 5002) {
        if (!poly || poly.left <= 0 || poly.cmd !== o.command) { poly = { cmd: o.command, left: Math.round(o.param1), pg: { inclusion: o.command === 5001, points: [] } }; m.fence.polygons.push(poly.pg); }
        poly.pg.points.push([o.x / 1e7, o.y / 1e7]); poly.left--;
      } else if (o.command === 5003 || o.command === 5004) m.fence.circles.push({ inclusion: o.command === 5003, lat: o.x / 1e7, lon: o.y / 1e7, radius: o.param1 });
    }
    for (const o of sets.rally || []) if (o.command === 5100) m.rally.push({ lat: o.x / 1e7, lon: o.y / 1e7, alt: o.z });
    const out = normalize(m);
    out.skipped = skipped;
    return out;
  }

  // ---- QGroundControl .plan ----
  function toPlan(m, opts = {}) {
    const fwType = opts.firmware === 'px4' ? 12 : 3;
    const vt = { copter: 2, plane: 1, rover: 10, sub: 12 }[m.vehicle] || 2;
    let id = 1;
    const items = m.items.map((it) => {
      const o = itemToMav(it);
      if (it.type === 'jump') o.param1 = it.p.item;
      const pos = TYPES[it.type].pos && it.lat !== null;
      const nn = (v) => (Number.isFinite(v) ? v : null);
      return { AMSLAltAboveTerrain: null, Altitude: o.z, AltitudeMode: it.frame === 'amsl' ? 2 : it.frame === 'terrain' ? 3 : 1, autoContinue: true, command: o.command, doJumpId: id++, frame: o.frame,
        params: [nn(o.param1), nn(o.param2), nn(o.param3), nn(o.param4), pos ? it.lat : 0, pos ? it.lon : 0, o.z], type: 'SimpleItem' };
    });
    const h = m.home || { lat: 0, lon: 0, alt: 0 };
    return {
      fileType: 'Plan', version: 1, groundStation: 'Video Master',
      geoFence: { version: 2, circles: m.fence.circles.map((c) => ({ circle: { center: [c.lat, c.lon], radius: c.radius }, inclusion: c.inclusion, version: 1 })), polygons: m.fence.polygons.map((pg) => ({ inclusion: pg.inclusion, polygon: pg.points, version: 1 })) },
      mission: { version: 2, firmwareType: fwType, vehicleType: vt, cruiseSpeed: m.defaults.speed, hoverSpeed: m.defaults.speed, globalPlanAltitudeMode: 1, plannedHomePosition: [h.lat, h.lon, h.alt || 0], items },
      rallyPoints: { version: 2, points: m.rally.map((q) => [q.lat, q.lon, q.alt]) },
    };
  }
  function fromPlan(json) {
    const plan = typeof json === 'string' ? JSON.parse(json) : json;
    if (!plan || plan.fileType !== 'Plan' || !plan.mission) throw new Error('not_a_plan');
    const ms = plan.mission;
    const flat = [];
    const walk = (list) => { for (const it of list || []) { if (it.type === 'SimpleItem') flat.push(it); else if (it.TransectStyleComplexItem && it.TransectStyleComplexItem.Items) walk(it.TransectStyleComplexItem.Items); else if (Array.isArray(it.Items)) walk(it.Items); } };
    walk(ms.items);
    const mav = flat.map((it, i) => { const p = it.params || []; const f = (v) => (v === null || v === undefined ? NaN : Number(v));
      return { seq: i, frame: it.frame, command: it.command, param1: f(p[0]), param2: f(p[1]), param3: f(p[2]), param4: f(p[3]), x: Math.round((Number(p[4]) || 0) * 1e7), y: Math.round((Number(p[5]) || 0) * 1e7), z: Number(p[6]) || 0 }; });
    const m = fromMav({ mission: mav }, { firmware: 'px4' }); // .plan'da ev öğesi yoktur
    m.items.forEach((it) => { if (it.type === 'jump') it.p.item = Math.max(1, it.p.item - 1); });
    const h = ms.plannedHomePosition;
    if (Array.isArray(h) && (h[0] || h[1])) m.home = { lat: h[0], lon: h[1], alt: h[2] || 0 };
    m.vehicle = { 1: 'plane', 2: 'copter', 10: 'rover', 12: 'sub', 20: 'plane' }[ms.vehicleType] || 'copter';
    if (ms.cruiseSpeed || ms.hoverSpeed) m.defaults.speed = m.vehicle === 'plane' ? ms.cruiseSpeed || 15 : ms.hoverSpeed || 5;
    const gf = plan.geoFence || {};
    m.fence = { polygons: (gf.polygons || []).map((pg) => ({ inclusion: pg.inclusion !== false, points: pg.polygon || [] })), circles: (gf.circles || []).map((c) => ({ inclusion: c.inclusion !== false, lat: c.circle.center[0], lon: c.circle.center[1], radius: c.circle.radius })) };
    m.rally = ((plan.rallyPoints || {}).points || []).map((q) => ({ lat: q[0], lon: q[1], alt: q[2] }));
    const skipped = m.skipped;
    const out = normalize(m);
    out.skipped = skipped;
    return out;
  }

  // ---- Mission Planner .waypoints (QGC WPL 110) ----
  function toWpl(m) {
    const { mission } = toMav(m, { firmware: 'ardupilot' });
    const f = (v) => (Number.isFinite(v) ? Number(v.toFixed(8)) : 0);
    return ['QGC WPL 110', ...mission.map((o, i) => [i, i === 0 ? 1 : 0, o.frame, o.command, f(o.param1), f(o.param2), f(o.param3), f(o.param4), f(o.x / 1e7), f(o.y / 1e7), f(o.z), 1].join('\t'))].join('\n') + '\n';
  }
  function fromWpl(text) {
    const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!/^QGC WPL \d+/.test(lines[0] || '')) throw new Error('not_wpl');
    const mav = lines.slice(1).map((l) => { const c = l.split(/\s+/).map(Number); return { seq: c[0], frame: c[2], command: c[3], param1: c[4], param2: c[5], param3: c[6], param4: c[7], x: Math.round(c[8] * 1e7), y: Math.round(c[9] * 1e7), z: c[10] }; }).filter((o) => Number.isFinite(o.command));
    const m = fromMav({ mission: mav }, { firmware: 'ardupilot' });
    m.items.forEach((it) => { if (it.type === 'waypoint' && it.p.yaw === 0) it.p.yaw = null; });
    return m;
  }

  // ---- Üreteçler ----
  // Alan taraması: çokgenin içini `spacing` metre aralıklı, `angle` derece yönlü gidiş-dönüş hatlarla doldurur.
  //   polygon: [[lat, lon]…] → [[lat, lon]…] dönüş noktaları (hat başı/sonu). overshoot: hatların çokgen dışına taşması (m)
  function survey({ polygon, spacing = 30, angle = 0, overshoot = 0 }) {
    if (!Array.isArray(polygon) || polygon.length < 3) return [];
    const o = polygon[0];
    const th = angle * RAD;
    // Hatlar x eksenine paralel olacak biçimde döndür (yön: kuzeyden saat yönünde açı)
    const rot = (x, y) => [x * Math.sin(th) + y * Math.cos(th), -x * Math.cos(th) + y * Math.sin(th)];
    const unrot = (u, v) => [u * Math.sin(th) - v * Math.cos(th), u * Math.cos(th) + v * Math.sin(th)];
    const pts = polygon.map((q) => rot(...toXY(q[0], q[1], o)));
    const step = Math.max(1, spacing);
    let lo = Infinity; let hi = -Infinity;
    for (const q of pts) { lo = Math.min(lo, q[1]); hi = Math.max(hi, q[1]); }
    const out = [];
    let flip = false;
    const n = Math.max(1, Math.floor((hi - lo) / step));
    const start = lo + ((hi - lo) - n * step) / 2 + (n * step === hi - lo ? step / 2 : 0);
    for (let v = (hi - lo) <= step ? (lo + hi) / 2 : start; v < hi && out.length < 4000; v += step) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]; const b = pts[(i + 1) % pts.length];
        if ((a[1] <= v && b[1] > v) || (b[1] <= v && a[1] > v)) xs.push(a[0] + ((v - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const seg = [[xs[k] - overshoot, v], [xs[k + 1] + overshoot, v]];
        if (flip) seg.reverse();
        for (const s of seg) out.push(toLL(...unrot(s[0], s[1]), o));
      }
      if (xs.length >= 2) flip = !flip;
      if ((hi - lo) <= step) break;
    }
    return out;
  }

  // Koridor taraması: yol boyunca `width` genişliğinde, `spacing` aralıklı paralel hatlar (gidiş-dönüş)
  function corridor({ line, width = 60, spacing = 30 }) {
    if (!Array.isArray(line) || line.length < 2) return [];
    const o = line[0];
    const xy = line.map((q) => toXY(q[0], q[1], o));
    const n = Math.max(1, Math.round(width / Math.max(1, spacing)));
    const offs = [];
    for (let i = 0; i < n; i++) offs.push(n === 1 ? 0 : -width / 2 + (width / (n - 1)) * i);
    const out = [];
    offs.forEach((d, k) => {
      const row = xy.map((q, i) => {
        const a = xy[Math.max(0, i - 1)]; const b = xy[Math.min(xy.length - 1, i + 1)];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return toLL(q[0] - ((b[1] - a[1]) / len) * d, q[1] + ((b[0] - a[0]) / len) * d, o);
      });
      if (k % 2) row.reverse();
      out.push(...row);
    });
    return out;
  }

  // Yapı / nokta çevresinde daire: merkez çevresinde `radius` yarıçaplı `points` noktalı tur
  function orbit({ lat, lon, radius = 40, points = 12, clockwise = true, startAngle = 0 }) {
    const out = [];
    const n = clamp(Math.round(points), 3, 72);
    for (let i = 0; i <= n; i++) { const a = (startAngle + (clockwise ? 1 : -1) * (360 / n) * i) * RAD; out.push(toLL(Math.sin(a) * radius, Math.cos(a) * radius, [lat, lon])); }
    return out;
  }

  // Nokta çokgenin içinde mi (coğrafi çit denetimi için)
  function inside(lat, lon, points) {
    let c = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i]; const b = points[j];
      if ((a[0] > lat) !== (b[0] > lat) && lon < ((b[1] - a[1]) * (lat - a[0])) / (b[0] - a[0]) + a[1]) c = !c;
    }
    return c;
  }

  const api = { TYPES, CMD_TYPE, AVAILABLE, VEHICLES, KEYS, FRAME, newItem, normalizeItem, normalize, validate, distance, bearing, path, stats, toMav, fromMav, itemToMav, itemFromMav, toPlan, fromPlan, toWpl, fromWpl, survey, corridor, orbit, inside };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MISSION = api;
})(typeof self !== 'undefined' ? self : this);
