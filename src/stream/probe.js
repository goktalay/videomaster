'use strict';

// ffmpeg'in günlüğünden (stderr) akış bilgisi ve canlı istatistik çıkarır.

// Parantez içindeki virgülleri bölmeden ayır: "h264 (High), yuv420p(tv, bt709), 1920x1080"
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const kNum = (s) => { const m = /^([\d.]+)(k?)$/.exec(s); return m ? Number(m[1]) * (m[2] ? 1000 : 1) : null; };

function parseStreamLine(line) {
  const m = /^\s*Stream #(\d+):(\d+)(?:\[(0x[0-9a-f]+)\])?(?:\(([^)]*)\))?: (Video|Audio|Data|Subtitle|Attachment): (.*)$/i.exec(line);
  if (!m) return null;
  const s = { index: Number(m[2]), type: m[5].toLowerCase(), raw: m[6].trim() };
  if (m[3]) s.id = m[3];
  if (m[4]) s.lang = m[4];
  let rest = m[6].replace(/\s*\((default|forced|dub|original|comment|lyrics|karaoke|hearing impaired|visual impaired|clean effects|attached pic|timed thumbnails|non-diegetic|captions|descriptions|metadata|dependent|still image)\)/gi, '');
  const parts = splitTop(rest);
  const head = /^(\S+)(?:\s+\(([^)]*)\))?(?:\s+\(([^)]*)\))?/.exec(parts[0] || '');
  if (head) {
    s.codec = head[1];
    for (const g of [head[2], head[3]]) {
      if (!g) continue;
      if (/ \/ 0x/.test(g)) s.tag = g.split(' / ')[0]; else s.profile = g;
    }
  }
  for (const p of parts.slice(1)) {
    let x;
    if (s.type === 'video') {
      if ((x = /^(\d+)x(\d+)(?:\s+\[SAR (\d+:\d+) DAR (\d+:\d+)\])?/.exec(p))) { s.width = Number(x[1]); s.height = Number(x[2]); if (x[3]) { s.sar = x[3]; s.dar = x[4]; } }
      else if ((x = /^([\d.]+k?) fps$/.exec(p))) s.fps = kNum(x[1]);
      else if ((x = /^([\d.]+k?) tbr$/.exec(p))) s.tbr = kNum(x[1]);
      else if ((x = /^([\d.]+k?) tbn$/.exec(p))) s.tbn = kNum(x[1]);
      else if ((x = /^(\d+) kb\/s$/.exec(p))) s.bitrate = Number(x[1]) * 1000;
      else if (!s.pixFmt && /^[a-z0-9]+(\(.*\))?$/i.test(p) && !/^\d/.test(p)) {
        const y = /^([a-z0-9]+)(?:\((.*)\))?$/i.exec(p);
        s.pixFmt = y[1];
        if (y[2]) {
          const bits = y[2].split(',').map((v) => v.trim());
          for (const b of bits) {
            if (b === 'tv' || b === 'pc') s.range = b === 'pc' ? 'full' : 'limited';
            else if (/progressive|top first|bottom first|top coded|bottom coded/.test(b)) s.scan = b;
            else if (b && b !== 'unknown') s.color = s.color ? `${s.color}, ${b}` : b;
          }
        }
      }
    } else if (s.type === 'audio') {
      if ((x = /^(\d+) Hz$/.exec(p))) s.sampleRate = Number(x[1]);
      else if ((x = /^(\d+) kb\/s$/.exec(p))) s.bitrate = Number(x[1]) * 1000;
      else if (/^(mono|stereo|\d+ channels|[\d.]+(\(.*\))?|quad|hexagonal|octagonal|downmix)/.test(p) && !s.layout) s.layout = p;
      else if (/^(u8|s16|s32|s64|flt|dbl)p?(\s|$|\()/.test(p)) s.sampleFmt = p.split(/[ (]/)[0];
    }
  }
  if (s.type === 'audio' && s.layout) s.channels = s.layout === 'mono' ? 1 : s.layout === 'stereo' ? 2 : (/^(\d+) channels/.exec(s.layout) || [])[1] ? Number(/^(\d+) channels/.exec(s.layout)[1]) : (/^(\d)\.(\d)/.exec(s.layout) ? Number(RegExp.$1) + Number(RegExp.$2) : undefined);
  return s;
}

// Satır satır beslenir; "Input #0 …" bölümü bitince info.complete olur
class LogParser {
  constructor() {
    this.info = null;
    this.inInput = false;
    this.inMeta = false;
    this.program = null;
    this.stats = {};
    this.tail = [];
  }

  line(text) {
    const line = text.replace(/\s+$/, '');
    if (!line) return;
    let m;
    if (/^frame=\s*\d+/.test(line)) {
      const g = (re) => { const x = re.exec(line); return x ? x[1] : null; };
      const speed = g(/speed=\s*([\d.]+)x/);
      this.stats = {
        frame: Number(g(/^frame=\s*(\d+)/)), fps: Number(g(/fps=\s*([\d.]+)/)) || 0, time: g(/time=\s*(-?[\d:.]+)/),
        dup: Number(g(/dup=\s*(\d+)/)) || 0, drop: Number(g(/drop=\s*(\d+)/)) || 0, speed: speed ? Number(speed) : null,
      };
      return;
    }
    if (/^size=/.test(line)) return; // yalnız ses çıktısı olan çalıştırmanın istatistiği
    this.tail.push(line);
    if (this.tail.length > 40) this.tail.shift();

    if ((m = /^Input #0, ([^,]+(?:,[^,]+)*?), from '(.*)':$/.exec(line))) {
      this.info = { format: m[1], streams: [], metadata: {}, programs: [], complete: false };
      this.inInput = true; this.inMeta = false; this.program = null;
      return;
    }
    if (!this.inInput) return;
    if (/^(Output #|Stream mapping:|Press \[q\]|\[.*\] |Input #[1-9])/.test(line) || /^[A-Za-z]/.test(line)) {
      // girintisiz satır: giriş bölümü bitti
      if (!/^\s/.test(line)) { this.inInput = false; this.info.complete = true; return; }
    }
    if ((m = /^\s+Duration: ([^,]+), start: ([^,]+), bitrate: (.+)$/.exec(line))) {
      this.info.duration = m[1] === 'N/A' ? null : m[1];
      this.info.start = Number(m[2]) || 0;
      const b = /^(\d+) kb\/s/.exec(m[3]);
      this.info.bitrate = b ? Number(b[1]) * 1000 : null;
      this.inMeta = false;
      return;
    }
    if ((m = /^\s+Program (\d+)\s*(.*)$/.exec(line))) { this.program = { id: Number(m[1]), name: m[2] || '', streams: [] }; this.info.programs.push(this.program); this.inMeta = false; return; }
    if (/^\s+Metadata:\s*$/.test(line)) { this.inMeta = true; return; }
    const s = parseStreamLine(line);
    if (s) { this.info.streams.push(s); if (this.program) this.program.streams.push(s.index); this.inMeta = false; this.lastStream = s; return; }
    if (this.inMeta && (m = /^\s+([\w .-]+?)\s*:\s(.*)$/.exec(line))) {
      const target = this.lastStream && /^\s{6,}/.test(line) ? (this.lastStream.metadata || (this.lastStream.metadata = {})) : this.program && /^\s{6,}/.test(line) ? (this.program.metadata || (this.program.metadata = {})) : this.info.metadata;
      if (Object.keys(target).length < 24) target[m[1].trim()] = m[2].trim();
    }
  }

  // Kullanıcıya gösterilecek hata nedeni (kod + ham satır)
  failure() {
    const text = this.tail.join('\n');
    const pick = (re) => { const x = this.tail.slice().reverse().find((l) => re.test(l)); return x ? x.replace(/^\[[^\]]+\]\s*/, '').trim() : ''; };
    const table = [
      ['unauthorized', /401 Unauthorized|403 Forbidden|authorization failed|Unauthorized/i],
      ['not_found', /404 Not Found|Server returned 404|454 Session Not Found/i],
      ['refused', /Connection refused/i],
      ['timeout', /timed out|Connection timeout|ETIMEDOUT/i],
      ['unreachable', /No route to host|Network is unreachable|Failed to resolve|Name or service not known|getaddrinfo|Unknown error occurred|Host is unreachable/i],
      ['no_stream', /matches no streams|does not contain any stream|Output file .* does not contain/i],
      ['bad_data', /Invalid data found when processing input|could not find codec parameters|Could not find codec parameters/i],
      ['unsupported', /Protocol not found|Unknown input format|Unsupported|not implemented|Unrecognized option|Option .* not found/i],
      ['tls', /certificate|handshake|TLS|tls/],
      ['io', /Input\/output error|End of file|Connection reset|Broken pipe|I\/O error/i],
    ];
    for (const [code, re] of table) if (re.test(text)) return { code, detail: pick(re) };
    const last = this.tail.slice().reverse().find((l) => /error|failed|invalid|unable|cannot/i.test(l)) || this.tail[this.tail.length - 1] || '';
    return { code: 'ffmpeg', detail: last.replace(/^\[[^\]]+\]\s*/, '').trim() };
  }
}

module.exports = { LogParser, parseStreamLine, splitTop };
