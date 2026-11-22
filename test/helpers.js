'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SCHEMA = require('../src/schema');
const { StreamSession } = require('../src/stream/session');
const { freeUdpPort } = require('../src/stream/relay');

const FFMPEG = process.env.VDM_FFMPEG || require('ffmpeg-static');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-test-'));

// Sınama kaynağı: renk çubukları + 440 Hz ton, gerçek zamanlı
function source(outputs) {
  const args = ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', ...outputs];
  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  return { proc, stop: () => proc.kill('SIGKILL'), err: () => err };
}
const H264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '15', '-bf', '0', '-pix_fmt', 'yuv420p'];

function session(conn, extra = {}) {
  const c = SCHEMA.normalize({ name: 'Test', reconnectDelay: 1, ...conn });
  let info = null;
  const s = new StreamSession('t' + Math.random().toString(16).slice(2, 8), {
    getConnection: () => c, ffmpegPath: FFMPEG, tmpDir: path.join(tmp, 'tmp'), hwaccels: [],
    getInfo: () => info, setInfo: (i) => { info = i; }, recordDir: () => path.join(tmp, 'rec'), ...extra,
  });
  s.on('error', () => {});
  return s;
}

function waitFor(fn, ms = 20000, label = 'koşul') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error(`zaman aşımı: ${label}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

// Boş port: UDP ve TCP için ayrı ayrı sorulabilir
const udpPort = (pair) => freeUdpPort({ pair });

module.exports = { FFMPEG, tmp, source, H264, session, waitFor, udpPort };
