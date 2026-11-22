'use strict';

// Akış motoru, gerçek ffmpeg ile uçtan uca: UDP (MPEG-TS), ham RTP (SDP), RTSP (TCP, kimlik doğrulamalı) ve kayıt.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { FFMPEG, tmp, source, H264, session, waitFor, udpPort } = require('./helpers');
const { createRtspServer } = require('./rtsp-server');

const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;

test('UDP üzerinden MPEG-TS: kareler, akış bilgisi, TS istatistikleri, hız geçmişi', async () => {
  const port = await udpPort();
  const src = source([...H264, '-c:a', 'aac', '-b:a', '64k', '-f', 'mpegts', `udp://127.0.0.1:${port}?pkt_size=1316`]);
  const s = session({ protocol: 'udp', host: '', port });
  const frames = [];
  s.on('frame', (f) => frames.push(f));
  try {
    await s.start('card');
    await waitFor(() => frames.length >= 5, 25000, 'UDP kareleri');
    assert.ok(isJpeg(frames[0]), 'kare JPEG olmalı');
    assert.strictEqual(s.state, 'playing');
    const v = s.info.streams.find((x) => x.type === 'video');
    assert.strictEqual(v.codec, 'h264');
    assert.strictEqual(v.width, 320);
    assert.ok(s.info.streams.some((x) => x.type === 'audio' && x.codec === 'aac'));
    const st = s.tap.stats();
    assert.ok(st.ts && st.ts.packets > 50, 'TS paketleri sayılmalı');
    assert.strictEqual(st.ts.ccErrors, 0);
    assert.ok(st.ts.pids.length >= 3);
    await waitFor(() => s.history.some((p) => p.bps > 10000), 5000, 'hız geçmişi');
    assert.strictEqual(s.snapshot().tapKind, 'wire');
    const snap = s.tap.snapshot();
    assert.strictEqual(snap.data[snap.packets[0].off - snap.base], 0x47, 'paket TS eşitleme baytıyla başlar');
  } finally { await s.stop(); src.stop(); }
  assert.strictEqual(s.state, 'idle');
});

test('Ham RTP (H.264 + PCMU): SDP üretimi, RTP istatistikleri, pencere profilinde ses', async () => {
  const vp = await udpPort(true);
  const ap = await udpPort(true);
  const src = source(['-map', '0:v', ...H264, '-payload_type', '96', '-f', 'rtp', `rtp://127.0.0.1:${vp}`,
    '-map', '1:a', '-c:a', 'pcm_mulaw', '-ar', '8000', '-ac', '1', '-f', 'rtp', `rtp://127.0.0.1:${ap}`]);
  const s = session({ protocol: 'rtp', host: '', port: vp, rtpVideoCodec: 'H264', rtpVideoPt: 96, rtpAudioCodec: 'PCMU', rtpAudioPort: ap, rtpAudioPt: 0, rtpAudioRate: 8000 });
  let frames = 0;
  let audio = 0;
  s.on('frame', () => frames++);
  s.on('audio', (d) => { audio += d.length; });
  try {
    await s.start('full');
    await waitFor(() => frames >= 5 && audio > 48000, 30000, 'RTP kareleri ve ses');
    assert.ok(s.viewer.layout.audio, 'ses çıktısı akış bilgisinden sonra eklenir');
    const st = s.tap.stats();
    const video = st.rtp.find((r) => r.pt === 96);
    const pcmu = st.rtp.find((r) => r.pt === 0);
    assert.ok(video && video.packets > 20 && video.codec === 'H264');
    assert.ok(pcmu && pcmu.codec === 'PCMU');
    assert.strictEqual(video.lost, 0);
    assert.ok(s.tap.packets.some((p) => p.kind === 'rtp' && /^IDR/.test(p.info || '')), 'IDR karesi paket listesinde görünür');
    assert.ok(st.keyIntervalMs > 500 && st.keyIntervalMs < 2500, `anahtar kare aralığı ~1 sn (${st.keyIntervalMs})`);
  } finally { await s.stop(); src.stop(); }
});

test('RTSP (TCP, Basic kimlik): sinyalleşme günlüğü, araya eklemeli RTP, profil değişimi, kayıt', async () => {
  const vp = await udpPort(true);
  const ap = await udpPort(true);
  const sdpFile = path.join(tmp, 'src.sdp');
  const src = source(['-map', '0:v', ...H264, '-f', 'rtp', `rtp://127.0.0.1:${vp}`,
    '-map', '1:a', '-c:a', 'pcm_mulaw', '-ar', '8000', '-ac', '1', '-f', 'rtp', `rtp://127.0.0.1:${ap}`, '-sdp_file', sdpFile]);
  await waitFor(() => fs.existsSync(sdpFile) && fs.statSync(sdpFile).size > 50, 10000, 'kaynak SDP');
  src.stop(); // portları sunucu dinleyecek: SDP alındı, kaynağı sunucu açıldıktan sonra yeniden başlat
  await new Promise((r) => setTimeout(r, 300));
  const sdp = fs.readFileSync(sdpFile, 'utf8').replace(/^SDP:\s*/m, '');
  const srv = createRtspServer({ sdp, ports: [vp, ap], auth: 'admin:s3cr:et/x' });
  const port = await srv.listen();
  const src2 = source(['-map', '0:v', ...H264, '-f', 'rtp', `rtp://127.0.0.1:${vp}`,
    '-map', '1:a', '-c:a', 'pcm_mulaw', '-ar', '8000', '-ac', '1', '-f', 'rtp', `rtp://127.0.0.1:${ap}`]);
  const s = session({ protocol: 'rtsp', host: '127.0.0.1', port, path: '/live/ch1', username: 'admin', password: 's3cr:et/x', recFormat: 'mp4' });
  let frames = 0;
  let big = 0;
  s.on('frame', (f) => { frames++; big = Math.max(big, f.length); });
  try {
    await s.start('card');
    await waitFor(() => frames >= 5, 30000, 'RTSP kareleri');
    assert.strictEqual(s.snapshot().tapKind, 'wire');
    const msgs = s.tap.messages.map((m) => `${m.dir} ${m.text.split('\r\n')[0]}`);
    assert.ok(msgs.some((m) => /^out DESCRIBE rtsp:\/\/127\.0\.0\.1/.test(m)), 'giden DESCRIBE görünür');
    assert.ok(msgs.some((m) => /^in RTSP\/1\.0 401/.test(m)) && msgs.some((m) => /^out PLAY/.test(m)), msgs.join(' | '));
    assert.strictEqual(s.tap.server, 'MiniRTSP/1.0');
    assert.match(s.tap.sdp, /a=rtpmap:96 H264\/90000/);
    assert.ok(s.tap.packets.some((p) => p.kind === 'rtp' && p.ch === 0 && p.codec === 'H264'));
    assert.ok(!s.command.includes('s3cr'), 'komut satırında şifre görünmez');

    // kart → pencere: tam çözünürlük ve ses
    const cardSize = big;
    let audio = 0;
    s.on('audio', (d) => { audio += d.length; });
    big = 0;
    await s.setProfile('full');
    await waitFor(() => audio > 20000 && big > 0, 30000, 'pencere profili');
    assert.ok(cardSize > 0);

    // kayıt: ikinci bağlantı, yeniden kodlamadan MP4 (G.711 ses AAC'ye çevrilir)
    const r0 = await s.startRecording();
    assert.ok(r0.active && r0.file.endsWith('.mp4'));
    await new Promise((r) => setTimeout(r, 4500));
    assert.strictEqual(s.state, 'playing', 'kayıt sırasında görüntü sürer');
    const r1 = await s.stopRecording();
    assert.strictEqual(r1.active, false);
    assert.strictEqual(r1.files.length, 1);
    const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', r1.files[0]], { encoding: 'utf8' }).stderr;
    assert.match(probe, /Video: h264/);
    assert.match(probe, /Audio: aac/);
    const dur = /Duration: 00:00:(\d+\.\d+)/.exec(probe);
    assert.ok(dur && Number(dur[1]) > 1.5, `kayıt süresi: ${dur && dur[1]}`);
  } finally { await s.stop(); src2.stop(); srv.close(); }
});

test('Ulaşılamayan RTSP sunucusu: hata kodu ve yeniden bağlanma sınırı', async () => {
  const s = session({ protocol: 'rtsp', host: '127.0.0.1', port: 1, path: '/x', reconnect: true, reconnectMax: 1, reconnectDelay: 1, timeout: 3 });
  const states = [];
  s.on('state', (st) => states.push(st.state));
  await s.start('card');
  await waitFor(() => s.state === 'error', 20000, 'hata durumu');
  assert.strictEqual(s.error.code, 'refused');
  assert.ok(states.includes('reconnecting'));
  assert.strictEqual(s.running, false);
  await s.stop();
});

test('Kaynak kesilince takılma algılanır, kaynak dönünce görüntü geri gelir', async () => {
  const port = await udpPort();
  const out = [...H264, '-an', '-f', 'mpegts', `udp://127.0.0.1:${port}?pkt_size=1316`];
  let src = source(out);
  const s = session({ protocol: 'udp', host: '', port, stallTimeout: 2 });
  let frames = 0;
  s.on('frame', () => frames++);
  try {
    await s.start('card');
    await waitFor(() => frames >= 3, 25000, 'ilk kareler');
    src.stop();
    await waitFor(() => s.state === 'reconnecting', 15000, 'takılma');
    assert.strictEqual(s.error.code, 'stalled');
    src = source(out);
    const before = frames;
    await waitFor(() => frames > before + 3 && s.state === 'playing', 30000, 'yeniden oynatma');
  } finally { await s.stop(); src.stop(); }
});
