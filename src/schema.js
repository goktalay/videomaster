// Bağlantı şeması: protokoller, alanlar, varsayılanlar ve doğrulama.
// Hem ana süreçte (require) hem pencerelerde (<script>) çalışır. Kayıt formu ile akış penceresindeki
// "Akış ayarları" paneli aynı alan listesinden üretilir; yeni bir ayar eklemek için FIELDS'e satır eklemek yeter.
(function (root) {
  'use strict';

  // tap: 'wire' = ağdaki gerçek baytlar (yerel aktarıcı üzerinden), 'remux' = ffmpeg'in MPEG-TS kopyası
  const PROTOCOLS = {
    rtsp: { color: '#22d3ee', icon: 'video', port: 554, securePort: 322, scheme: 'rtsp', secureScheme: 'rtsps', tap: 'wire' },
    rtp: { color: '#a78bfa', icon: 'layers', port: 5004, scheme: 'rtp', tap: 'wire' },
    udp: { color: '#34d399', icon: 'bolt', port: 1234, scheme: 'udp', tap: 'wire' },
    srt: { color: '#f472b6', icon: 'lock', port: 9000, scheme: 'srt', tap: 'remux' },
    rtmp: { color: '#fb923c', icon: 'upload', port: 1935, securePort: 443, scheme: 'rtmp', secureScheme: 'rtmps', tap: 'remux' },
    http: { color: '#60a5fa', icon: 'globe', port: 80, securePort: 443, scheme: 'http', secureScheme: 'https', tap: 'remux' },
    tcp: { color: '#fbbf24', icon: 'server', port: 9000, scheme: 'tcp', tap: 'wire' },
    sdp: { color: '#c084fc', icon: 'file', port: 0, scheme: 'sdp', tap: 'wire' },
    custom: { color: '#94a3b8', icon: 'terminal', port: 0, scheme: '', tap: 'remux' },
  };
  const PROTOCOL_IDS = Object.keys(PROTOCOLS);

  const RTP_VIDEO = {
    none: null,
    H264: { pt: 96, rate: 90000 }, H265: { pt: 96, rate: 90000 }, MP2T: { pt: 33, rate: 90000 }, JPEG: { pt: 26, rate: 90000 },
    'MP4V-ES': { pt: 96, rate: 90000 }, MPV: { pt: 32, rate: 90000 }, VP8: { pt: 96, rate: 90000 }, VP9: { pt: 96, rate: 90000 },
    AV1: { pt: 96, rate: 90000 }, H263: { pt: 34, rate: 90000 },
  };
  const RTP_AUDIO = {
    none: null,
    PCMU: { pt: 0, rate: 8000, ch: 1 }, PCMA: { pt: 8, rate: 8000, ch: 1 }, opus: { pt: 97, rate: 48000, ch: 2 },
    'MPEG4-GENERIC': { pt: 97, rate: 48000, ch: 2 }, L16: { pt: 97, rate: 44100, ch: 2 }, MPA: { pt: 14, rate: 90000, ch: 2 },
    G722: { pt: 9, rate: 8000, ch: 1 }, 'MP4A-LATM': { pt: 97, rate: 48000, ch: 2 },
  };

  // Kamera modelleri (src/models): RTSP bağlantısında model seçilince modelin kendi alanları ve kontrol paneli gelir
  const MODELS = (typeof module !== 'undefined' && module.exports) ? require('./models/defs') : (root.CAMERA_MODEL_LIST || Object.values(root.CAMERA_MODELS || {}));
  const MODEL_BY_ID = Object.fromEntries(MODELS.map((m) => [m.id, m]));
  const MODEL_PROTOCOLS = ['rtsp'];
  // Yapay görü ayarları (src/vision): bağlantıyla birlikte saklanır ve senkronlanır
  const VISION = (typeof module !== 'undefined' && module.exports) ? require('./vision/catalog') : root.VISION;

  const P = (...ids) => ids; // okunabilirlik
  const NET = P('rtsp', 'rtp', 'udp', 'srt', 'rtmp', 'http', 'tcp', 'sdp', 'custom');

  // type: text | password | number | select | bool | textarea
  // on: alanın göründüğü protokoller; when: ek koşul (c) => bool; opts: seçenekler (çeviri anahtarı "o.<key>.<değer>", raw ise değer aynen)
  const FIELDS = [
    // --- Bağlantı ---------------------------------------------------------------------------------
    { key: 'host', tab: 'general', type: 'text', def: '', on: P('rtsp', 'rtp', 'udp', 'srt', 'rtmp', 'http', 'tcp'), mono: true, span: 2 },
    { key: 'port', tab: 'general', type: 'number', def: 554, min: 1, max: 65535, on: P('rtsp', 'rtp', 'udp', 'srt', 'rtmp', 'http', 'tcp') },
    { key: 'path', tab: 'general', type: 'text', def: '', on: P('rtsp', 'rtmp', 'http'), mono: true, span: 3 },
    { key: 'username', tab: 'general', type: 'text', def: '', on: P('rtsp', 'rtmp', 'http') },
    { key: 'password', tab: 'general', type: 'password', def: '', on: P('rtsp', 'rtmp', 'http'), span: 2 },
    { key: 'secure', tab: 'general', type: 'bool', def: false, on: P('rtsp', 'rtmp', 'http'), span: 3 },
    { key: 'url', tab: 'general', type: 'text', def: '', on: P('custom'), mono: true, span: 3 },
    { key: 'sdpText', tab: 'general', type: 'textarea', def: '', on: P('sdp'), rows: 9, span: 3 },
    { key: 'autoPlay', tab: 'general', type: 'bool', def: false, span: 3 },
    { key: 'notes', tab: 'general', type: 'textarea', def: '', rows: 2, span: 3 },

    // --- Ağ ---------------------------------------------------------------------------------------
    { key: 'rtspTransport', tab: 'network', type: 'select', def: 'tcp', opts: ['tcp', 'udp', 'udp_multicast', 'http'], on: P('rtsp') },
    { key: 'allowedMedia', tab: 'network', type: 'select', def: 'all', opts: ['all', 'video', 'audio'], on: P('rtsp') },
    { key: 'rtspFilterSrc', tab: 'network', type: 'bool', def: false, on: P('rtsp'), when: (c) => c.rtspTransport !== 'tcp' },
    { key: 'minPort', tab: 'network', type: 'number', def: 0, min: 0, max: 65535, on: P('rtsp'), when: (c) => c.rtspTransport === 'udp' },
    { key: 'maxPort', tab: 'network', type: 'number', def: 0, min: 0, max: 65535, on: P('rtsp'), when: (c) => c.rtspTransport === 'udp' },
    { key: 'localAddr', tab: 'network', type: 'text', def: '', on: P('rtp', 'udp', 'sdp'), mono: true },
    { key: 'sources', tab: 'network', type: 'text', def: '', on: P('rtp', 'udp', 'sdp'), mono: true, span: 2 },
    { key: 'tcpListen', tab: 'network', type: 'bool', def: false, on: P('tcp'), span: 3 },
    { key: 'srtMode', tab: 'network', type: 'select', def: 'caller', opts: ['caller', 'listener', 'rendezvous'], on: P('srt') },
    { key: 'srtLatency', tab: 'network', type: 'number', def: 120, min: 0, max: 60000, unit: 'ms', on: P('srt') },
    { key: 'srtPbkeylen', tab: 'network', type: 'select', def: '0', opts: ['0', '16', '24', '32'], on: P('srt') },
    { key: 'srtPassphrase', tab: 'network', type: 'password', def: '', on: P('srt') },
    { key: 'srtStreamId', tab: 'network', type: 'text', def: '', on: P('srt'), mono: true, span: 2 },
    { key: 'rtmpLive', tab: 'network', type: 'select', def: 'any', opts: ['any', 'live', 'recorded'], on: P('rtmp') },
    { key: 'userAgent', tab: 'network', type: 'text', def: '', on: P('rtsp', 'http'), span: 2 },
    { key: 'httpHeaders', tab: 'network', type: 'textarea', def: '', on: P('http'), rows: 3, span: 3 },
    { key: 'httpProxy', tab: 'network', type: 'text', def: '', on: P('http'), mono: true, span: 3 },
    { key: 'tlsVerify', tab: 'network', type: 'bool', def: false, on: P('rtsp', 'rtmp', 'http'), when: (c) => !!c.secure, span: 3 },
    { key: 'timeout', tab: 'network', type: 'number', def: 10, min: 1, max: 600, unit: 's', on: NET },
    { key: 'stallTimeout', tab: 'network', type: 'number', def: 10, min: 0, max: 600, unit: 's', on: NET },
    { key: 'bufferSize', tab: 'network', type: 'number', def: 0, min: 0, max: 262144, unit: 'KB', on: P('rtsp', 'rtp', 'udp', 'sdp', 'srt') },
    { key: 'reorderQueue', tab: 'network', type: 'number', def: 0, min: 0, max: 5000, on: P('rtsp', 'rtp', 'sdp') },
    { key: 'maxDelay', tab: 'network', type: 'number', def: 0, min: 0, max: 10000, unit: 'ms', on: P('rtsp', 'rtp', 'sdp') },
    { key: 'reconnect', tab: 'network', type: 'bool', def: true, span: 3 },
    { key: 'reconnectDelay', tab: 'network', type: 'number', def: 3, min: 1, max: 600, unit: 's', when: (c) => c.reconnect },
    { key: 'reconnectMax', tab: 'network', type: 'number', def: 0, min: 0, max: 100000, when: (c) => c.reconnect },

    // --- RTP / SDP (ham RTP için oturum tanımı) -------------------------------------------------------
    { key: 'rtpVideoCodec', tab: 'rtp', type: 'select', def: 'H264', opts: Object.keys(RTP_VIDEO), raw: Object.keys(RTP_VIDEO).filter((k) => k !== 'none'), on: P('rtp') },
    { key: 'rtpVideoPt', tab: 'rtp', type: 'number', def: 96, min: 0, max: 127, on: P('rtp'), when: (c) => c.rtpVideoCodec !== 'none' },
    { key: 'rtpVideoRate', tab: 'rtp', type: 'number', def: 90000, min: 1000, max: 1000000, unit: 'Hz', on: P('rtp'), when: (c) => c.rtpVideoCodec !== 'none' },
    { key: 'rtpVideoFmtp', tab: 'rtp', type: 'text', def: '', on: P('rtp'), when: (c) => c.rtpVideoCodec !== 'none', mono: true, span: 3 },
    { key: 'rtpAudioCodec', tab: 'rtp', type: 'select', def: 'none', opts: Object.keys(RTP_AUDIO), raw: Object.keys(RTP_AUDIO).filter((k) => k !== 'none'), on: P('rtp') },
    { key: 'rtpAudioPort', tab: 'rtp', type: 'number', def: 5006, min: 1, max: 65535, on: P('rtp'), when: (c) => c.rtpAudioCodec !== 'none' },
    { key: 'rtpAudioPt', tab: 'rtp', type: 'number', def: 0, min: 0, max: 127, on: P('rtp'), when: (c) => c.rtpAudioCodec !== 'none' },
    { key: 'rtpAudioRate', tab: 'rtp', type: 'number', def: 8000, min: 1000, max: 384000, unit: 'Hz', on: P('rtp'), when: (c) => c.rtpAudioCodec !== 'none' },
    { key: 'rtpAudioChannels', tab: 'rtp', type: 'number', def: 1, min: 1, max: 8, on: P('rtp'), when: (c) => c.rtpAudioCodec !== 'none' },
    { key: 'rtpAudioFmtp', tab: 'rtp', type: 'text', def: '', on: P('rtp'), when: (c) => c.rtpAudioCodec !== 'none', mono: true, span: 3 },
    { key: 'rtpSdpOverride', tab: 'rtp', type: 'textarea', def: '', on: P('rtp'), rows: 6, span: 3 },

    // --- Çözme ve görüntü ---------------------------------------------------------------------------
    { key: 'inputFormat', tab: 'decode', type: 'select', def: 'auto', opts: ['auto', 'mpegts', 'h264', 'hevc', 'mjpeg', 'mpjpeg', 'flv', 'matroska', 'rawvideo'], raw: ['mpegts', 'h264', 'hevc', 'mjpeg', 'mpjpeg', 'flv', 'matroska', 'rawvideo'], on: P('udp', 'tcp', 'srt', 'http', 'custom') },
    { key: 'hwaccel', tab: 'decode', type: 'select', def: 'none', opts: ['none', 'auto', 'd3d11va', 'dxva2', 'qsv', 'cuda', 'vulkan'], raw: ['d3d11va', 'dxva2', 'qsv', 'cuda', 'vulkan'] },
    { key: 'threads', tab: 'decode', type: 'number', def: 0, min: 0, max: 64 },
    { key: 'lowLatency', tab: 'decode', type: 'bool', def: true, span: 3 },
    { key: 'probeSize', tab: 'decode', type: 'number', def: 0, min: 0, max: 102400, unit: 'KB' },
    { key: 'analyzeDuration', tab: 'decode', type: 'number', def: 0, min: 0, max: 60000, unit: 'ms' },
    { key: 'videoStream', tab: 'decode', type: 'number', def: 0, min: 0, max: 63 },
    { key: 'viewHeight', tab: 'decode', type: 'select', def: 'auto', opts: ['auto', 'source', '1080', '720', '480', '360'], raw: ['1080', '720', '480', '360'], suffix: 'p' },
    { key: 'fpsLimit', tab: 'decode', type: 'select', def: 'source', opts: ['source', '30', '25', '15', '10', '5', '1'], raw: ['30', '25', '15', '10', '5', '1'], suffix: ' fps' },
    { key: 'jpegQuality', tab: 'decode', type: 'select', def: 'medium', opts: ['high', 'medium', 'low'] },
    { key: 'fit', tab: 'decode', type: 'select', def: 'contain', opts: ['contain', 'cover', 'fill'] },
    { key: 'rotate', tab: 'decode', type: 'select', def: '0', opts: ['0', '90', '180', '270'], raw: true, suffix: '°' },
    { key: 'deinterlace', tab: 'decode', type: 'bool', def: false },
    { key: 'flipH', tab: 'decode', type: 'bool', def: false },
    { key: 'flipV', tab: 'decode', type: 'bool', def: false },
    { key: 'discardCorrupt', tab: 'decode', type: 'bool', def: true },
    { key: 'ignoreErrors', tab: 'decode', type: 'bool', def: false },
    { key: 'wallclock', tab: 'decode', type: 'bool', def: false },
    { key: 'extraInput', tab: 'decode', type: 'text', def: '', mono: true, span: 3 },

    // --- Ses ------------------------------------------------------------------------------------------
    { key: 'audioEnabled', tab: 'audio', type: 'bool', def: true, span: 3 },
    { key: 'audioStream', tab: 'audio', type: 'number', def: 0, min: 0, max: 63, when: (c) => c.audioEnabled },
    { key: 'volume', tab: 'audio', type: 'number', def: 100, min: 0, max: 200, unit: '%', when: (c) => c.audioEnabled },
    { key: 'startMuted', tab: 'audio', type: 'bool', def: false, when: (c) => c.audioEnabled },

    // --- Akış verisi (HEX / paketler) ----------------------------------------------------------------
    { key: 'capture', tab: 'capture', type: 'select', def: 'auto', opts: ['auto', 'remux', 'off'], span: 2 },
    { key: 'captureBufferKB', tab: 'capture', type: 'select', def: '1024', opts: ['256', '512', '1024', '2048', '4096', '8192'], raw: true, suffix: ' KB', when: (c) => c.capture !== 'off' },

    // --- Kayıt ----------------------------------------------------------------------------------------
    { key: 'recFormat', tab: 'record', type: 'select', def: 'mp4', opts: ['mp4', 'mkv', 'ts', 'mov'] },
    { key: 'recAudio', tab: 'record', type: 'bool', def: true },
    { key: 'recAudioCodec', tab: 'record', type: 'select', def: 'auto', opts: ['auto', 'copy', 'aac'], when: (c) => c.recAudio },
    { key: 'recSegmentMin', tab: 'record', type: 'number', def: 0, min: 0, max: 1440, unit: 'min' },
    { key: 'recName', tab: 'record', type: 'text', def: '{name}_{date}_{time}', mono: true, span: 2 },
  ];
  // Kamera modeli: "Bağlantı" sekmesinin başında; model seçilince "Kamera" sekmesi (modelin kendi alanları) görünür
  FIELDS.unshift({ key: 'model', tab: 'general', type: 'select', def: 'generic', opts: ['generic', ...MODELS.map((m) => m.id)], on: MODEL_PROTOCOLS, span: 3 });

  // Modellerin kendi alanları: aynı anahtarı birden çok model kullanabilir (varsayılanı modele göre değişir)
  for (const m of MODELS) {
    for (const mf of m.fields || []) {
      const have = FIELDS.find((f) => f.key === mf.key);
      if (have) { have.models.push(m.id); continue; }
      const f = { ...mf, tab: 'camera', on: MODEL_PROTOCOLS, models: [m.id] };
      f.when = (c) => f.models.includes(c.model);
      FIELDS.push(f);
    }
  }
  // Modelin alan varsayılanları (model alanları + adres/yol gibi bağlantı varsayılanları)
  function modelFieldDefaults(id) {
    const m = MODEL_BY_ID[id];
    const out = {};
    if (m) for (const mf of m.fields || []) out[mf.key] = mf.def;
    return out;
  }

  const TABS = [
    ['general', 'link'], ['network', 'globe'], ['rtp', 'layers'], ['decode', 'monitor'], ['audio', 'audio'], ['capture', 'terminal'], ['record', 'record'], ['camera', 'camera'],
  ];

  const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
  // Senkronlanan bağlantı alanları (şifre dahil; kütüphane uçtan uca şifrelidir)
  const CONNECTION_KEYS = ['name', 'protocol', 'folderId', 'color', 'createdAt', 'vision', ...FIELDS.map((f) => f.key)];

  function defaults(protocol) {
    const p = PROTOCOLS[protocol] ? protocol : 'rtsp';
    const c = { name: '', protocol: p, folderId: null, color: null };
    for (const f of FIELDS) c[f.key] = f.def;
    c.port = PROTOCOLS[p].port || 0;
    return c;
  }

  const visible = (f, c) => (!f.on || f.on.includes(c.protocol)) && (!f.when || !!f.when(c));
  const tabVisible = (tab, c) => FIELDS.some((f) => f.tab === tab && visible(f, c));

  // Dışarıdan gelen (form, senkron, içe aktarma) veriyi şemaya göre temizler
  function normalize(input) {
    const src = input || {};
    const c = defaults(src.protocol);
    c.name = String(src.name || '').trim().slice(0, 120);
    c.folderId = src.folderId || null;
    c.color = typeof src.color === 'string' && /^#[0-9a-f]{6}$/i.test(src.color) ? src.color : null;
    if (MODEL_BY_ID[src.model] && MODEL_PROTOCOLS.includes(c.protocol)) Object.assign(c, modelFieldDefaults(src.model));
    for (const f of FIELDS) {
      const v = src[f.key];
      if (v === undefined || v === null) continue;
      if (f.type === 'bool') c[f.key] = !!v;
      else if (f.type === 'number') {
        const n = Number(v);
        if (Number.isFinite(n)) c[f.key] = Math.min(f.max, Math.max(f.min, Math.round(n)));
      } else if (f.type === 'select') {
        if (f.opts.includes(String(v))) c[f.key] = String(v);
      } else c[f.key] = String(v).slice(0, f.type === 'textarea' ? 8000 : 2000);
    }
    for (const k of ['host', 'path', 'username', 'url', 'localAddr', 'sources', 'srtStreamId']) c[k] = c[k].trim();
    if (!MODEL_PROTOCOLS.includes(c.protocol)) c.model = 'generic';
    c.vision = VISION.normalizeVision(src.vision);
    if (c.path && !c.path.startsWith('/') && c.protocol !== 'custom') c.path = '/' + c.path;
    if (!PROTOCOLS[c.protocol].secureScheme) c.secure = false;
    return c;
  }

  // rtsp://kullanıcı:şifre@sunucu:554/yol gibi bir adresi alanlara ayırır (yapıştırılan adresler için)
  function parseUrl(text) {
    const m = /^([a-z][a-z0-9+.-]*):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/?#]*)(?::(\d+))?([^\s]*)$/i.exec(String(text || '').trim());
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    const map = { rtsp: ['rtsp', false], rtsps: ['rtsp', true], rtmp: ['rtmp', false], rtmps: ['rtmp', true], http: ['http', false], https: ['http', true],
      udp: ['udp', false], rtp: ['rtp', false], srt: ['srt', false], tcp: ['tcp', false] };
    const hit = map[scheme];
    if (!hit) return { protocol: 'custom', url: text.trim() };
    const [protocol, secure] = hit;
    const out = { protocol, secure, host: (m[4] || '').replace(/^@/, ''), path: m[6] || '' };
    const def = PROTOCOLS[protocol];
    out.port = m[5] ? Number(m[5]) : (secure ? def.securePort : def.port);
    const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    if (m[2] !== undefined) out.username = dec(m[2]);
    if (m[3] !== undefined) out.password = dec(m[3]);
    if (['udp', 'rtp', 'srt', 'tcp'].includes(protocol)) {
      const q = new URLSearchParams((out.path.split('?')[1] || ''));
      out.path = '';
      if (protocol === 'srt') {
        if (q.get('mode')) out.srtMode = q.get('mode');
        if (q.get('streamid')) out.srtStreamId = q.get('streamid');
        if (q.get('passphrase')) out.srtPassphrase = q.get('passphrase');
        if (q.get('latency')) out.srtLatency = Math.round(Number(q.get('latency')) / 1000) || 120;
      }
      if (protocol === 'tcp' && q.has('listen')) out.tcpListen = true;
      if (q.get('localaddr')) out.localAddr = q.get('localaddr');
      if (q.get('sources')) out.sources = q.get('sources');
    }
    return out;
  }

  const isMulticast = (host) => {
    const m = /^(\d+)\.\d+\.\d+\.\d+$/.exec(String(host || ''));
    if (m) return Number(m[1]) >= 224 && Number(m[1]) <= 239;
    return /^ff[0-9a-f]{2}:/i.test(String(host || ''));
  };

  // Karta ve başlığa yazılan, şifresiz adres
  function displayUrl(c) {
    const p = PROTOCOLS[c.protocol] || PROTOCOLS.rtsp;
    if (c.protocol === 'custom') return String(c.url || '').replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:•••@');
    if (c.protocol === 'sdp') {
      const m = /^m=(\w+) (\d+)/m.exec(c.sdpText || '');
      const a = /^c=IN IP[46] ([^\s/]+)/m.exec(c.sdpText || '');
      return `sdp://${a ? a[1] : '0.0.0.0'}${m ? ':' + m[2] : ''}`;
    }
    const scheme = c.secure && p.secureScheme ? p.secureScheme : p.scheme;
    const host = c.host || (['rtp', 'udp'].includes(c.protocol) || (c.protocol === 'tcp' && c.tcpListen) || (c.protocol === 'srt' && c.srtMode === 'listener') ? '@' : '?');
    const user = c.username ? `${c.username}@` : '';
    return `${scheme}://${user}${host}${c.port ? ':' + c.port : ''}${c.path || ''}`;
  }

  // Kaydetmeden önce: eksik zorunlu alanların anahtarları
  function validate(c) {
    const bad = [];
    if (!String(c.name || '').trim()) bad.push('name');
    if (['rtsp', 'rtmp', 'http'].includes(c.protocol) && !c.host) bad.push('host');
    if (c.protocol === 'srt' && c.srtMode !== 'listener' && !c.host) bad.push('host');
    if (c.protocol === 'tcp' && !c.tcpListen && !c.host) bad.push('host');
    if (c.protocol === 'custom' && !c.url) bad.push('url');
    if (c.protocol === 'sdp' && !/^m=/m.test(c.sdpText || '')) bad.push('sdpText');
    if (c.protocol === 'rtp' && c.rtpVideoCodec === 'none' && c.rtpAudioCodec === 'none' && !c.rtpSdpOverride) bad.push('rtpVideoCodec');
    if (c.protocol === 'srt' && c.srtPassphrase && (c.srtPassphrase.length < 10 || c.srtPassphrase.length > 79)) bad.push('srtPassphrase');
    return bad;
  }

  // Model seçilince forma uygulanacak değişiklikler: modelin alan varsayılanları her zaman; adres, port, yol gibi
  // bağlantı varsayılanları yalnızca alan boşsa ya da hâlâ genel/önceki modelin varsayılanındaysa (girilen bilgi korunur)
  function applyModel(c, id, prevId) {
    const m = MODEL_BY_ID[id];
    const prev = MODEL_BY_ID[prevId];
    const patch = { model: m ? id : 'generic', ...modelFieldDefaults(id) };
    if (!m) return patch;
    const base = defaults(c.protocol);
    for (const [k, v] of Object.entries(m.defaults || {})) {
      const cur = c[k];
      const untouched = cur === '' || cur === undefined || cur === null || cur === base[k] || (prev && prev.defaults && cur === prev.defaults[k]);
      if (untouched) patch[k] = v;
    }
    return patch;
  }
  const modelOf = (c) => (c && MODEL_PROTOCOLS.includes(c.protocol) && MODEL_BY_ID[c.model]) || null;

  const api = { MODELS, MODEL_BY_ID, applyModel, modelOf, PROTOCOLS, PROTOCOL_IDS, RTP_VIDEO, RTP_AUDIO, FIELDS, FIELD_BY_KEY, TABS, CONNECTION_KEYS, defaults, normalize, visible, tabVisible, parseUrl, isMulticast, displayUrl, validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SCHEMA = api;
})(typeof self !== 'undefined' ? self : this);
