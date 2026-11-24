// Dron ve uçuş kayıtlarının şeması. Ana süreçte (require) ve pencerelerde (<script>) kullanılır.
// Dron: uçuş kontrolcüsüne bağlantı (Mission Planner'daki gibi seri port, TCP, UDP, UDP dinleme) ve yazılım türü.
// Uçuş: kayıtlı bir dron ile kayıtlı bir kameranın birlikte izlendiği oturum (harita + video + gösterge).
(function (root) {
  'use strict';

  const FIRMWARES = ['ardupilot', 'px4', 'betaflight', 'sitl'];
  const LINKS = ['serial', 'tcp', 'udp', 'udpin'];
  const BAUDS = ['9600', '19200', '38400', '57600', '115200', '230400', '460800', '500000', '921600', '1000000', '1500000', '2000000'];
  const FW_COLOR = { ardupilot: '#22d3ee', px4: '#60a5fa', betaflight: '#fbbf24', sitl: '#a78bfa' };

  // type: text | number | select | bool | textarea; when: (d) => görünür mü
  const FIELDS = [
    { key: 'firmware', type: 'select', def: 'ardupilot', opts: FIRMWARES, span: 3 },
    { key: 'linkType', type: 'select', def: 'serial', opts: LINKS, span: 3 },
    { key: 'serialPort', type: 'text', def: '', mono: true, span: 2, when: (d) => d.linkType === 'serial' },
    { key: 'baud', type: 'select', def: '115200', opts: BAUDS, raw: true, when: (d) => d.linkType === 'serial' },
    { key: 'host', type: 'text', def: '127.0.0.1', mono: true, span: 2, when: (d) => d.linkType === 'tcp' || d.linkType === 'udp' },
    { key: 'port', type: 'number', def: 5760, min: 1, max: 65535, when: (d) => d.linkType === 'tcp' || d.linkType === 'udp' },
    { key: 'localPort', type: 'number', def: 14550, min: 1, max: 65535, when: (d) => d.linkType === 'udpin' },
    { key: 'gcsSysid', type: 'number', def: 255, min: 1, max: 255 },
    { key: 'streamRate', type: 'number', def: 4, min: 1, max: 50, unit: 'Hz' },
    { key: 'autoConnect', type: 'bool', def: true, span: 3 },
    { key: 'notes', type: 'textarea', def: '', rows: 2, span: 3 },
  ];
  const KEYS = ['name', 'createdAt', ...FIELDS.map((f) => f.key)];

  // Yazılım türü ya da bağlantı türü seçilince önerilen bağlantı değerleri
  const PRESETS = {
    sitl: { linkType: 'tcp', host: '127.0.0.1', port: 5760 },
    tcp: { port: 5760 }, udp: { port: 14550 }, udpin: { localPort: 14550 },
    betaflight: { linkType: 'serial', baud: '115200' },
  };

  function defaults() {
    const d = { name: '' };
    for (const f of FIELDS) d[f.key] = f.def;
    return d;
  }

  function normalize(input) {
    const src = input || {};
    const d = defaults();
    d.name = String(src.name || '').trim().slice(0, 120);
    for (const f of FIELDS) {
      const v = src[f.key];
      if (v === undefined || v === null) continue;
      if (f.type === 'bool') d[f.key] = !!v;
      else if (f.type === 'number') { const n = Number(v); if (Number.isFinite(n)) d[f.key] = Math.min(f.max, Math.max(f.min, Math.round(n))); }
      else if (f.type === 'select') { if (f.opts.includes(String(v))) d[f.key] = String(v); }
      else d[f.key] = String(v).slice(0, f.type === 'textarea' ? 4000 : 300);
    }
    d.serialPort = d.serialPort.trim();
    d.host = d.host.trim();
    return d;
  }

  function validate(d) {
    const bad = [];
    if (!String(d.name || '').trim()) bad.push('name');
    if (d.linkType === 'serial' && !d.serialPort) bad.push('serialPort');
    if ((d.linkType === 'tcp' || d.linkType === 'udp') && !d.host) bad.push('host');
    return bad;
  }

  // Kartta ve başlıkta gösterilen bağlantı özeti
  function display(d) {
    if (d.linkType === 'serial') return `${d.serialPort || '?'} @ ${d.baud}`;
    if (d.linkType === 'udpin') return `udp ← :${d.localPort}`;
    return `${d.linkType}://${d.host || '?'}:${d.port}`;
  }

  // Sürücüye verilen bağlantı ayarı (src/drone/link.js)
  const linkConfig = (d) => ({ retryInitial: true, type: d.linkType, serialPort: d.serialPort, baud: Number(d.baud), host: d.host, port: d.port, localPort: d.linkType === 'udpin' ? d.localPort : 0 });

  // Uçuş: { name, droneId, cameraId, layout }
  const LAYOUTS = ['mapPip', 'videoPip', 'split', 'map', 'video'];
  function normalizeFlight(input) {
    const src = input || {};
    return {
      name: String(src.name || '').trim().slice(0, 120),
      droneId: src.droneId ? String(src.droneId).slice(0, 40) : null,
      cameraId: src.cameraId ? String(src.cameraId).slice(0, 40) : null,
      layout: LAYOUTS.includes(src.layout) ? src.layout : 'mapPip',
      notes: String(src.notes || '').slice(0, 4000),
    };
  }
  const FLIGHT_KEYS = ['name', 'droneId', 'cameraId', 'layout', 'notes', 'createdAt'];

  const api = { FIRMWARES, LINKS, BAUDS, FW_COLOR, FIELDS, KEYS, PRESETS, LAYOUTS, FLIGHT_KEYS, defaults, normalize, validate, display, linkConfig, normalizeFlight };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DRONE = api;
})(typeof self !== 'undefined' ? self : this);
