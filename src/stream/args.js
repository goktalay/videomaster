'use strict';

// Bağlantı ayarlarından ffmpeg komut satırını üretir (giriş, görüntü/ses çıktıları, kayıt).

const SCHEMA = require('../schema');

// "a b 'c d'" → ['a', 'b', 'c d']
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const enc = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
const cred = (c) => (c.username ? `${enc(c.username)}${c.password ? ':' + enc(c.password) : ''}@` : '');
const hostPart = (h) => (String(h).includes(':') && !String(h).startsWith('[') ? `[${h}]` : h);

// Ham RTP için alanlardan SDP üret
function sdpFromFields(c) {
  const host = c.host && !/^(@|0\.0\.0\.0)$/.test(c.host) ? c.host : '0.0.0.0';
  const fam = host.includes(':') ? 'IP6' : 'IP4';
  const lines = ['v=0', `o=- 0 0 IN ${fam} ${host}`, 's=Video Master', `c=IN ${fam} ${host}`, 't=0 0'];
  if (c.rtpVideoCodec && c.rtpVideoCodec !== 'none') {
    lines.push(`m=video ${c.port} RTP/AVP ${c.rtpVideoPt}`, `a=rtpmap:${c.rtpVideoPt} ${c.rtpVideoCodec}/${c.rtpVideoRate}`);
    const fmtp = c.rtpVideoFmtp || (c.rtpVideoCodec === 'H264' ? 'packetization-mode=1' : '');
    if (fmtp) lines.push(`a=fmtp:${c.rtpVideoPt} ${fmtp}`);
  }
  if (c.rtpAudioCodec && c.rtpAudioCodec !== 'none') {
    const ch = c.rtpAudioChannels > 1 || c.rtpAudioCodec === 'opus' ? `/${c.rtpAudioCodec === 'opus' ? 2 : c.rtpAudioChannels}` : '';
    lines.push(`m=audio ${c.rtpAudioPort} RTP/AVP ${c.rtpAudioPt}`, `a=rtpmap:${c.rtpAudioPt} ${c.rtpAudioCodec}/${c.rtpAudioRate}${ch}`);
    if (c.rtpAudioFmtp) lines.push(`a=fmtp:${c.rtpAudioPt} ${c.rtpAudioFmtp}`);
  }
  return lines.join('\r\n') + '\r\n';
}

// SDP'deki ortamlar: [{ type, port, host, proto }] — host: ortam ya da oturum düzeyindeki c= adresi
function planSdp(text) {
  const medias = [];
  let sessionHost = '';
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = /^c=IN IP[46] ([^\s/]+)/.exec(line))) { if (cur) cur.host = m[1]; else sessionHost = m[1]; }
    else if ((m = /^m=(\w+) (\d+)(?:\/\d+)? (\S+)/.exec(line))) { cur = { type: m[1], port: Number(m[2]), proto: m[3], host: null }; medias.push(cur); }
  }
  for (const x of medias) if (!x.host) x.host = sessionHost;
  return medias.filter((x) => x.port > 0);
}

// ffmpeg'e verilecek SDP: adresler 127.0.0.1, portlar aktarıcının tüketici portları
function rewriteSdp(text, ports) {
  let i = 0;
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^c=/.test(line)) { out.push('c=IN IP4 127.0.0.1'); continue; }
    if (/^o=/.test(line)) { out.push('o=- 0 0 IN IP4 127.0.0.1'); continue; }
    if (/^a=(source-filter|rtcp):/.test(line)) continue;
    const m = /^m=(\w+) (\d+)(?:\/\d+)? (.*)$/.exec(line);
    if (m && Number(m[2]) > 0) { out.push(`m=${m[1]} ${ports[i++]} ${m[3]}`); continue; }
    out.push(line);
  }
  if (!out.some((l) => /^c=/.test(l))) {
    const at = out.findIndex((l) => /^(t|m)=/.test(l));
    out.splice(at < 0 ? out.length : at, 0, 'c=IN IP4 127.0.0.1');
  }
  return out.join('\r\n') + '\r\n';
}

// Kaynağa doğrudan bağlanan (aktarıcısız) adres
function directUrl(c) {
  const p = SCHEMA.PROTOCOLS[c.protocol];
  const q = new URLSearchParams();
  switch (c.protocol) {
    case 'custom': return c.url;
    case 'rtsp': return `${c.secure ? 'rtsps' : 'rtsp'}://${cred(c)}${hostPart(c.host)}:${c.port}${c.path || '/'}`;
    case 'rtmp': return `${c.secure ? 'rtmps' : 'rtmp'}://${cred(c)}${hostPart(c.host)}:${c.port}${c.path || '/'}`;
    case 'http': return `${c.secure ? 'https' : 'http'}://${cred(c)}${hostPart(c.host)}:${c.port}${c.path || '/'}`;
    case 'srt': {
      q.set('mode', c.srtMode);
      if (c.srtLatency) q.set('latency', String(c.srtLatency * 1000));
      if (c.srtPassphrase) { q.set('passphrase', c.srtPassphrase); if (c.srtPbkeylen !== '0') q.set('pbkeylen', c.srtPbkeylen); }
      if (c.srtStreamId) q.set('streamid', c.srtStreamId);
      if (c.srtMode !== 'listener') q.set('connect_timeout', String(c.timeout * 1000));
      if (c.bufferSize) q.set('rcvbuf', String(c.bufferSize * 1024));
      return `srt://${hostPart(c.host || '0.0.0.0')}:${c.port}?${q}`;
    }
    case 'tcp': return c.tcpListen ? `tcp://${hostPart(c.host || '0.0.0.0')}:${c.port}?listen=1` : `tcp://${hostPart(c.host)}:${c.port}`;
    case 'udp': {
      q.set('overrun_nonfatal', '1'); q.set('fifo_size', '100000');
      if (c.localAddr) q.set('localaddr', c.localAddr);
      if (c.sources) q.set('sources', c.sources);
      if (c.bufferSize) q.set('buffer_size', String(c.bufferSize * 1024));
      return `udp://${hostPart(c.host || '0.0.0.0')}:${c.port}?${q}`;
    }
    default: return `${p.scheme}://${hostPart(c.host)}:${c.port}`;
  }
}

// Giriş bölümü: ["-seçenek", ..., "-i", adres]
// ep: aktarıcı uçları — { tcpPort } (rtsp / tcp), { udpPort } (udp), { sdpFile } (rtp / sdp); yoksa doğrudan bağlanılır
function inputArgs(c, ep = {}, { hwaccels = null, record = false } = {}) {
  const a = [];
  const us = (sec) => String(Math.round(sec * 1e6));
  const fflags = [];
  if (record) { c = { ...c, lowLatency: false, hwaccel: 'none', threads: 0 }; fflags.push('genpts'); }
  if (c.lowLatency) fflags.push('nobuffer');
  if (c.discardCorrupt) fflags.push('discardcorrupt');
  if (fflags.length) a.push('-fflags', '+' + fflags.join('+'));
  if (c.lowLatency) a.push('-flags', 'low_delay');
  if (c.probeSize) a.push('-probesize', String(c.probeSize * 1024));
  if (c.analyzeDuration) a.push('-analyzeduration', String(c.analyzeDuration * 1000));
  if (c.ignoreErrors) a.push('-err_detect', 'ignore_err');
  if (c.wallclock) a.push('-use_wallclock_as_timestamps', '1');
  if (c.threads) a.push('-threads', String(c.threads));
  if (c.hwaccel && c.hwaccel !== 'none' && (c.hwaccel === 'auto' || !hwaccels || hwaccels.includes(c.hwaccel))) a.push('-hwaccel', c.hwaccel);
  if (c.maxDelay && ['rtsp', 'rtp', 'sdp'].includes(c.protocol)) a.push('-max_delay', String(c.maxDelay * 1000));
  if (c.reorderQueue && ['rtsp', 'rtp', 'sdp'].includes(c.protocol)) a.push('-reorder_queue_size', String(c.reorderQueue));
  if (c.inputFormat && c.inputFormat !== 'auto' && ['udp', 'tcp', 'srt', 'http', 'custom'].includes(c.protocol)) a.push('-f', c.inputFormat);

  let url;
  switch (c.protocol) {
    case 'rtsp': {
      a.push('-rtsp_transport', c.rtspTransport);
      if (c.rtspFilterSrc && c.rtspTransport !== 'tcp') a.push('-rtsp_flags', 'filter_src');
      if (c.allowedMedia !== 'all') a.push('-allowed_media_types', c.allowedMedia);
      if (c.rtspTransport === 'udp' && c.minPort && c.maxPort && c.maxPort > c.minPort) a.push('-min_port', String(c.minPort), '-max_port', String(c.maxPort));
      if (c.bufferSize) a.push('-buffer_size', String(c.bufferSize * 1024));
      if (c.userAgent) a.push('-user_agent', c.userAgent);
      a.push('-timeout', us(c.timeout));
      if (ep.tcpPort) url = `rtsp://${cred(c)}127.0.0.1:${ep.tcpPort}${c.path || '/'}`;
      else { if (c.secure) a.push('-tls_verify', c.tlsVerify ? '1' : '0'); url = directUrl(c); }
      break;
    }
    case 'rtp': case 'sdp':
      a.push('-protocol_whitelist', 'file,udp,rtp,crypto,data');
      if (c.bufferSize) a.push('-buffer_size', String(c.bufferSize * 1024));
      url = ep.sdpFile;
      break;
    case 'udp':
      // Aktarıcıdan okurken ffmpeg içi halka tampon (ayrı iş parçacığı) kapalı: paketler çekirdek tamponunda bekler
      url = ep.udpPort ? `udp://127.0.0.1:${ep.udpPort}?fifo_size=0&buffer_size=${Math.max(c.bufferSize, 4096) * 1024}` : directUrl(c);
      break;
    case 'tcp':
      a.push('-rw_timeout', us(c.timeout));
      url = ep.tcpPort ? `tcp://127.0.0.1:${ep.tcpPort}` : directUrl(c);
      break;
    case 'rtmp':
      if (c.rtmpLive !== 'any') a.push('-rtmp_live', c.rtmpLive);
      if (c.secure) a.push('-tls_verify', c.tlsVerify ? '1' : '0');
      a.push('-rw_timeout', us(c.timeout));
      url = directUrl(c);
      break;
    case 'http': {
      if (c.userAgent) a.push('-user_agent', c.userAgent);
      const headers = String(c.httpHeaders || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[\w-]+\s*:/.test(l));
      if (headers.length) a.push('-headers', headers.join('\r\n') + '\r\n');
      if (c.httpProxy) a.push('-http_proxy', c.httpProxy);
      if (c.secure) a.push('-tls_verify', c.tlsVerify ? '1' : '0');
      a.push('-rw_timeout', us(c.timeout));
      url = directUrl(c);
      break;
    }
    default:
      url = directUrl(c);
  }
  a.push(...splitArgs(c.extraInput));
  a.push('-i', url);
  return a;
}

const JPEG_Q = { high: '2', medium: '5', low: '10' };

// Görüntü süzgeçleri. profile: 'card' (ana ekrandaki küçük önizleme) | 'full' (akış penceresi)
function videoFilter(c, profile) {
  const f = [];
  if (c.deinterlace) f.push('yadif=0:-1:0');
  if (c.rotate === '90') f.push('transpose=1');
  else if (c.rotate === '180') f.push('hflip', 'vflip');
  else if (c.rotate === '270') f.push('transpose=2');
  if (c.flipH) f.push('hflip');
  if (c.flipV) f.push('vflip');
  if (profile === 'card') f.push('fps=8', "scale=-2:'min(ih,360)'");
  else {
    if (c.fpsLimit !== 'source') f.push(`fps=${c.fpsLimit}`);
    if (c.viewHeight !== 'source') f.push(`scale=-2:'min(ih,${c.viewHeight === 'auto' ? 1080 : c.viewHeight})'`);
  }
  return f.join(',');
}

// Görüntüleyici çıktıları. layout: { video: bool, audio: bool }; ports: { audio, remux } (yerel TCP)
function viewOutputs(c, profile, layout, ports = {}) {
  const a = [];
  if (ports.remux) a.push('-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', `tcp://127.0.0.1:${ports.remux}`);
  if (layout.video) {
    const vf = videoFilter(c, profile);
    a.push('-map', `0:v:${layout.vi ?? (c.videoStream || 0)}`);
    if (vf) a.push('-vf', vf);
    a.push('-c:v', 'mjpeg', '-q:v', profile === 'card' ? '7' : JPEG_Q[c.jpegQuality] || '5', '-an', '-sn', '-dn', '-flush_packets', '1', '-f', 'mjpeg', 'pipe:1');
  }
  if (layout.audio && ports.audio) {
    a.push('-map', `0:a:${layout.ai ?? (c.audioStream || 0)}`, '-vn', '-sn', '-dn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-flush_packets', '1', '-f', 's16le', `tcp://127.0.0.1:${ports.audio}`);
  }
  // Hiç çıktı yoksa (ör. kartta yalnız sesli akış) bağlantıyı ve istatistikleri canlı tutan boş çıktı
  if (!a.length) a.push('-map', '0', '-c', 'copy', '-f', 'null', '-');
  return a;
}

const COPY_VIDEO = {
  mp4: ['h264', 'hevc', 'mpeg4', 'mjpeg', 'av1', 'vp9', 'mpeg2video', 'mpeg1video'],
  mov: ['h264', 'hevc', 'mpeg4', 'mjpeg', 'prores', 'mpeg2video'],
  ts: ['h264', 'hevc', 'mpeg2video', 'mpeg1video', 'mpeg4', 'av1'],
};
const COPY_AUDIO = {
  mp4: ['aac', 'mp3', 'ac3', 'eac3', 'alac', 'mp2'],
  mov: ['aac', 'mp3', 'ac3', 'alac', 'pcm_s16le', 'pcm_s16be', 'pcm_mulaw', 'pcm_alaw'],
  ts: ['aac', 'mp3', 'mp2', 'ac3', 'eac3', 'opus'],
};
const MUXER = { mp4: 'mp4', mkv: 'matroska', ts: 'mpegts', mov: 'mov' };

// Kayıt çıktısı. info: bilinen akış bilgisi (yoksa güvenli varsayımlar); file: tam yol (bölümlüyse strftime kalıbı)
function recordOutputs(c, info, file) {
  const fmt = MUXER[c.recFormat] ? c.recFormat : 'mp4';
  const streams = (info && info.streams) || [];
  const v = streams.filter((s) => s.type === 'video')[c.videoStream || 0] || streams.find((s) => s.type === 'video');
  const au = streams.filter((s) => s.type === 'audio')[c.audioStream || 0] || streams.find((s) => s.type === 'audio');
  const a = [];
  const hasVideo = !info || !!v;
  const hasAudio = c.recAudio && (!info || !!au);
  if (hasVideo) a.push('-map', '0:v?');
  if (hasAudio) a.push('-map', '0:a?');
  if (hasVideo) {
    const ok = fmt === 'mkv' || !v || COPY_VIDEO[fmt].includes(v.codec);
    if (ok) { a.push('-c:v', 'copy'); if (v && v.codec === 'hevc' && (fmt === 'mp4' || fmt === 'mov')) a.push('-tag:v', 'hvc1'); }
    else a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p');
  }
  if (hasAudio) {
    const mode = c.recAudioCodec || 'auto';
    const copyOk = fmt === 'mkv' || (au && COPY_AUDIO[fmt].includes(au.codec));
    if (mode === 'copy' || (mode === 'auto' && copyOk)) a.push('-c:a', 'copy');
    else a.push('-c:a', 'aac', '-b:a', '128k');
  }
  a.push('-sn', '-dn');
  if (c.recSegmentMin > 0) {
    a.push('-f', 'segment', '-segment_time', String(c.recSegmentMin * 60), '-segment_format', MUXER[fmt], '-reset_timestamps', '1', '-strftime', '1');
    if (fmt === 'mp4' || fmt === 'mov') a.push('-segment_format_options', 'movflags=+faststart');
  } else {
    if (fmt === 'mp4' || fmt === 'mov') a.push('-movflags', '+faststart');
    a.push('-f', MUXER[fmt]);
  }
  a.push('-y', file);
  return a;
}

// Dosya adı kalıbı: {name} {date} {time} {protocol}; Windows'ta geçersiz karakterler temizlenir
function recordName(c, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f%]/g, '_').replace(/[. ]+$/, '').trim();
  const base = (c.recName || '{name}_{date}_{time}')
    .replace(/\{name\}/g, safe(c.name || 'stream')).replace(/\{date\}/g, date).replace(/\{time\}/g, time).replace(/\{protocol\}/g, c.protocol);
  return safe(base).slice(0, 150) || `stream_${date}_${time}`;
}

// Günlükte ve arayüzde gösterilecek komut: şifreler gizlenir
function redact(args) {
  return args.map((x) => String(x).replace(/(\/\/[^:@/\s]+):[^@/\s]+@/, '$1:•••@').replace(/(passphrase=)[^&\s]+/, '$1•••'));
}

module.exports = { splitArgs, sdpFromFields, planSdp, rewriteSdp, directUrl, inputArgs, videoFilter, viewOutputs, recordOutputs, recordName, redact, MUXER };
