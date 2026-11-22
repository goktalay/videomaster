'use strict';

// Şema, ffmpeg komut üretimi ve akış verisi yakalayıcısı (ffmpeg gerektirmez)

const test = require('node:test');
const assert = require('node:assert');
const SCHEMA = require('../src/schema');
const A = require('../src/stream/args');
const { Tap, RtspDemux, parseRtp } = require('../src/stream/tap');
const { LogParser } = require('../src/stream/probe');

test('şema: varsayılanlar, temizleme, doğrulama, adres ayrıştırma', () => {
  const c = SCHEMA.normalize({ name: '  Kamera  ', protocol: 'rtsp', host: ' 10.0.0.5 ', port: '99999', path: 'live', rtspTransport: 'bogus', secure: 1, volume: 500 });
  assert.strictEqual(c.name, 'Kamera');
  assert.strictEqual(c.host, '10.0.0.5');
  assert.strictEqual(c.port, 65535);
  assert.strictEqual(c.path, '/live');
  assert.strictEqual(c.rtspTransport, 'tcp');
  assert.strictEqual(c.volume, 200);
  assert.deepStrictEqual(SCHEMA.validate(c), []);
  assert.deepStrictEqual(SCHEMA.validate(SCHEMA.normalize({ name: 'x', protocol: 'rtsp' })), ['host']);
  assert.deepStrictEqual(SCHEMA.validate(SCHEMA.normalize({ name: 'x', protocol: 'udp', port: 1234 })), []);
  assert.deepStrictEqual(SCHEMA.validate(SCHEMA.normalize({ name: 'x', protocol: 'sdp', sdpText: 'v=0' })), ['sdpText']);
  assert.strictEqual(SCHEMA.normalize({ protocol: 'udp', secure: true }).secure, false, 'UDP için TLS yok');

  const u = SCHEMA.parseUrl('rtsps://admin:p%40ss@cam.local/Streaming/Channels/101?x=1');
  assert.deepStrictEqual([u.protocol, u.secure, u.host, u.port, u.username, u.password, u.path], ['rtsp', true, 'cam.local', 322, 'admin', 'p@ss', '/Streaming/Channels/101?x=1']);
  const s = SCHEMA.parseUrl('srt://1.2.3.4:9000?mode=listener&latency=200000&streamid=abc');
  assert.deepStrictEqual([s.protocol, s.srtMode, s.srtLatency, s.srtStreamId], ['srt', 'listener', 200, 'abc']);
  assert.strictEqual(SCHEMA.parseUrl('mmsh://x/y').protocol, 'custom');
  assert.strictEqual(SCHEMA.parseUrl('merhaba'), null);
  assert.strictEqual(SCHEMA.displayUrl({ ...c, username: 'admin', password: 'gizli' }), 'rtsps://admin@10.0.0.5:65535/live');
  assert.ok(!SCHEMA.displayUrl({ protocol: 'custom', url: 'rtsp://u:gizli@h/x' }).includes('gizli'));
  assert.ok(SCHEMA.isMulticast('239.1.1.1') && !SCHEMA.isMulticast('192.168.1.1'));
  // her alan bir sekmeye bağlı ve anahtarlar benzersiz
  const tabs = SCHEMA.TABS.map(([id]) => id);
  assert.ok(SCHEMA.FIELDS.every((f) => tabs.includes(f.tab)));
  assert.strictEqual(new Set(SCHEMA.FIELDS.map((f) => f.key)).size, SCHEMA.FIELDS.length);
});

test('komut üretimi: RTSP, SRT, HTTP, UDP aktarıcı, kayıt', () => {
  const rtsp = SCHEMA.normalize({ name: 'k', protocol: 'rtsp', host: 'cam', port: 554, path: '/s1', username: 'a b', password: 'p@:/', rtspTransport: 'udp', minPort: 6000, maxPort: 6100, userAgent: 'VM', maxDelay: 500, reorderQueue: 50, hwaccel: 'cuda' });
  const a = A.inputArgs(rtsp, {}, { hwaccels: ['d3d11va'] });
  assert.strictEqual(a[a.length - 1], 'rtsp://a%20b:p%40%3A%2F@cam:554/s1');
  for (const pair of [['-rtsp_transport', 'udp'], ['-min_port', '6000'], ['-max_port', '6100'], ['-user_agent', 'VM'], ['-max_delay', '500000'], ['-reorder_queue_size', '50'], ['-timeout', '10000000']]) {
    assert.strictEqual(a[a.indexOf(pair[0]) + 1], pair[1], pair[0]);
  }
  assert.ok(!a.includes('-hwaccel'), 'bu bilgisayarda olmayan hızlandırma komuta girmez');
  assert.ok(A.inputArgs(rtsp, { tcpPort: 4000 }).pop().endsWith('@127.0.0.1:4000/s1'), 'aktarıcı üzerinden yerel adres');
  assert.ok(!A.redact(a).join(' ').includes('p%40'), 'şifre gizlenir');

  const srt = A.directUrl(SCHEMA.normalize({ protocol: 'srt', host: 'h', port: 9000, srtMode: 'caller', srtLatency: 250, srtPassphrase: '0123456789ab', srtPbkeylen: '32', srtStreamId: 'live/1' }));
  assert.match(srt, /^srt:\/\/h:9000\?mode=caller&latency=250000&passphrase=0123456789ab&pbkeylen=32&streamid=live%2F1/);
  const http = A.inputArgs(SCHEMA.normalize({ protocol: 'http', host: 'h', port: 443, secure: true, path: '/a.m3u8', httpHeaders: 'X-Key: 1\nbozuk satır\nReferer: https://x', tlsVerify: true }));
  assert.strictEqual(http[http.indexOf('-headers') + 1], 'X-Key: 1\r\nReferer: https://x\r\n');
  assert.strictEqual(http[http.indexOf('-tls_verify') + 1], '1');
  assert.strictEqual(http.pop(), 'https://h:443/a.m3u8');
  assert.match(A.inputArgs(SCHEMA.normalize({ protocol: 'udp', port: 1234 }), { udpPort: 5555 }).pop(), /^udp:\/\/127\.0\.0\.1:5555\?fifo_size=0/);
  assert.match(A.directUrl(SCHEMA.normalize({ protocol: 'tcp', port: 9000, tcpListen: true })), /listen=1$/);

  const c = SCHEMA.normalize({ name: 'Kam/era: 1', protocol: 'rtsp', host: 'h', rotate: '90', deinterlace: true, fpsLimit: '10', viewHeight: '720' });
  assert.strictEqual(A.videoFilter(c, 'full'), "yadif=0:-1:0,transpose=1,fps=10,scale=-2:'min(ih,720)'");
  assert.match(A.videoFilter(c, 'card'), /fps=8,scale=-2:'min\(ih,360\)'$/);
  const out = A.viewOutputs(c, 'full', { video: true, audio: true, vi: 0, ai: 1 }, { audio: 7001, remux: 7002 });
  assert.ok(out.includes('tcp://127.0.0.1:7001') && out.includes('tcp://127.0.0.1:7002') && out.includes('0:a:1'));
  assert.deepStrictEqual(A.viewOutputs(c, 'card', { video: false, audio: false }), ['-map', '0', '-c', 'copy', '-f', 'null', '-']);

  const info = { streams: [{ type: 'video', codec: 'hevc' }, { type: 'audio', codec: 'pcm_mulaw' }] };
  const mp4 = A.recordOutputs({ ...c, recFormat: 'mp4' }, info, 'x.mp4').join(' ');
  assert.match(mp4, /-c:v copy -tag:v hvc1 -c:a aac/);
  assert.match(A.recordOutputs({ ...c, recFormat: 'mkv' }, info, 'x.mkv').join(' '), /-c:v copy -c:a copy .*-f matroska/);
  assert.match(A.recordOutputs({ ...c, recFormat: 'mp4', recSegmentMin: 10 }, info, 'x_%Y.mp4').join(' '), /-f segment -segment_time 600 -segment_format mp4/);
  assert.ok(!A.recordOutputs({ ...c, recAudio: false }, info, 'x.mp4').includes('0:a?'));
  assert.strictEqual(A.recordName(c, new Date(2026, 0, 5, 9, 3, 7)), 'Kam_era_ 1_2026-01-05_09-03-07');
  assert.deepStrictEqual(A.splitArgs(`-a 1 "b c" 'd e'`), ['-a', '1', 'b c', 'd e']);
});

test('SDP: alanlardan üretim, ortamların bulunması, yerel portlara yeniden yazma', () => {
  const c = SCHEMA.normalize({ protocol: 'rtp', host: '239.1.2.3', port: 5004, rtpVideoCodec: 'H265', rtpVideoPt: 98, rtpAudioCodec: 'opus', rtpAudioPort: 5008, rtpAudioPt: 111, rtpAudioRate: 48000 });
  const sdp = A.sdpFromFields(c);
  assert.match(sdp, /m=video 5004 RTP\/AVP 98\r\na=rtpmap:98 H265\/90000/);
  assert.match(sdp, /m=audio 5008 RTP\/AVP 111\r\na=rtpmap:111 opus\/48000\/2/);
  assert.deepStrictEqual(A.planSdp(sdp).map((m) => [m.type, m.port, m.host]), [['video', 5004, '239.1.2.3'], ['audio', 5008, '239.1.2.3']]);
  const local = A.rewriteSdp(sdp + 'a=source-filter: incl IN IP4 * 10.0.0.1\r\n', [7000, 7002]);
  assert.match(local, /c=IN IP4 127\.0\.0\.1/);
  assert.match(local, /m=video 7000 RTP\/AVP 98/);
  assert.match(local, /m=audio 7002 RTP\/AVP 111/);
  assert.ok(!local.includes('239.1.2.3') && !local.includes('source-filter'));
  assert.deepStrictEqual(A.planSdp('v=0\r\nm=video 0 RTP/AVP 96\r\n'), [], 'port 0: kapalı ortam');
});

function rtpPacket({ pt = 96, seq, ts = 0, ssrc = 0x1234, marker = false, payload = Buffer.from([0x65, 1, 2, 3]) }) {
  const h = Buffer.alloc(12);
  h[0] = 0x80; h[1] = (marker ? 0x80 : 0) | pt; h.writeUInt16BE(seq & 0xffff, 2); h.writeUInt32BE(ts >>> 0, 4); h.writeUInt32BE(ssrc, 8);
  return Buffer.concat([h, payload]);
}

test('yakalayıcı: halka tampon, RTP kaybı, NAL türü, anlık görüntü ve temizleme', () => {
  const tap = new Tap({ sizeKB: 64 });
  tap.setPayloadType(96, 'H264', 90000);
  assert.strictEqual(parseRtp(Buffer.from([1, 2, 3])), null);
  let t = 1000;
  for (const seq of [65534, 65535, 0, 1, 4, 5]) tap.addPacket(rtpPacket({ seq, ts: seq * 3000, payload: Buffer.from([seq === 4 ? 0x65 : 0x41, 9, 9]) }), { t: (t += 33) });
  const st = tap.stats();
  assert.strictEqual(st.rtp.length, 1);
  assert.strictEqual(st.rtp[0].packets, 6);
  assert.strictEqual(st.rtp[0].lost, 2, 'sıra numarası sarması kayıp sayılmaz; 2 ve 3 kayıp');
  assert.strictEqual(st.rtp[0].codec, 'H264');
  assert.deepStrictEqual(tap.packets.map((p) => p.info), ['P/B', 'P/B', 'P/B', 'P/B', 'IDR', 'P/B']);
  assert.strictEqual(tap.counters.bytesIn, 6 * 15);
  // FU-A başlangıcı ve RTCP
  tap.addPacket(rtpPacket({ seq: 6, payload: Buffer.from([0x7c, 0x85, 0]) }));
  assert.strictEqual(tap.packets[6].info, 'IDR▸');
  const sr = Buffer.alloc(28); sr[0] = 0x80; sr[1] = 200; sr.writeUInt32BE(0x1234, 4);
  assert.strictEqual(tap.addPacket(sr, { hint: 'rtcp', ch: 1 }).kind, 'rtcp');

  // halka: tampondan büyük yazımda yalnız son 64 KB okunur, paket konumları mutlak kalır
  const big = Buffer.alloc(100 * 1024, 0xab);
  big[big.length - 1] = 0xcd;
  tap.addStream(big, { ts: false });
  const snap = tap.snapshot();
  assert.strictEqual(snap.data.length, 64 * 1024);
  assert.strictEqual(snap.total, tap.total);
  assert.strictEqual(snap.data[snap.data.length - 1], 0xcd);
  assert.strictEqual(snap.base + snap.data.length, tap.total);
  assert.strictEqual(tap.tail(4).data.length, 4);
  const d1 = tap.drain(3);
  assert.strictEqual(d1.packets.length, 3);
  assert.strictEqual(d1.skipped, 6);
  assert.strictEqual(tap.drain().packets.length, 0, 'aynı paket iki kez verilmez');
  tap.clear();
  assert.strictEqual(tap.snapshot().data.length, 0);
  assert.strictEqual(tap.packets.length, 0);
});

test('yakalayıcı: MPEG-TS süreklilik hatası ve TCP içinde yeniden eşitleme', () => {
  const ts = (pid, cc) => { const b = Buffer.alloc(188, 0xff); b[0] = 0x47; b[1] = (pid >> 8) & 0x1f; b[2] = pid & 0xff; b[3] = 0x10 | (cc & 0x0f); return b; };
  const tap = new Tap({ sizeKB: 64 });
  tap.addPacket(Buffer.concat([ts(0x100, 0), ts(0x100, 1), ts(0x101, 5), ts(0x100, 3)]));
  let st = tap.stats().ts;
  assert.strictEqual(st.packets, 4);
  assert.strictEqual(st.ccErrors, 1);
  assert.strictEqual(tap.packets[0].kind, 'ts');
  // TCP: paket sınırına hizalı olmayan parçalar
  const tcp = new Tap({ sizeKB: 64 });
  const stream = Buffer.concat([Buffer.from([1, 2, 3]), ...Array.from({ length: 20 }, (_, i) => ts(0x200, i))]);
  tcp.addStream(stream.subarray(0, 1000));
  tcp.addStream(stream.subarray(1000));
  st = tcp.stats().ts;
  assert.strictEqual(st.packets, 20);
  assert.strictEqual(st.ccErrors, 0);
});

test('RTSP ayrıştırıcı: iletiler, gövde, araya eklemeli çerçeveler; SDP ve sunucu bilgisi', () => {
  const frames = [];
  const msgs = [];
  const d = new RtspDemux((ch, payload) => frames.push([ch, payload.length]), (m) => msgs.push(m), () => assert.fail('ham veri beklenmiyor'));
  const sdp = 'v=0\r\nm=video 0 RTP/AVP 97\r\na=rtpmap:97 H265/90000\r\n';
  const describe = `RTSP/1.0 200 OK\r\nCSeq: 2\r\nServer: Kamera/1.0\r\nContent-Type: application/sdp\r\nContent-Length: ${sdp.length}\r\n\r\n${sdp}`;
  const frame = Buffer.concat([Buffer.from([0x24, 0, 0, 5]), Buffer.from('abcde')]);
  const all = Buffer.concat([Buffer.from(describe, 'latin1'), frame, Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 3\r\n\r\n'), frame]);
  for (let i = 0; i < all.length; i += 7) d.feed(all.subarray(i, i + 7)); // küçük parçalar halinde
  assert.strictEqual(msgs.length, 2);
  assert.ok(msgs[0].endsWith(sdp));
  assert.deepStrictEqual(frames, [[0, 5], [0, 5]]);

  const tap = new Tap();
  tap.addMessage('DESCRIBE rtsp://x RTSP/1.0\r\nCSeq: 2\r\n\r\n', { dir: 'out' });
  tap.addMessage(msgs[0], { dir: 'in' });
  assert.strictEqual(tap.server, 'Kamera/1.0');
  assert.match(tap.sdp, /^v=0/);
  assert.strictEqual(tap.payloadTypes[97].codec, 'H265');
  assert.strictEqual(tap.counters.packetsOut, 1);
  assert.strictEqual(tap.drain().messages.length, 2);
});

test('ffmpeg günlüğü: akış bilgisi, istatistik satırı, hata sınıflandırma', () => {
  const p = new LogParser();
  for (const l of ["Input #0, mpegts, from 'udp://x':", '  Duration: N/A, start: 1.400000, bitrate: N/A', '  Program 1 ', '    Metadata:', '      service_name    : Kanal 1',
    '  Stream #0:0[0x100]: Video: hevc (Main 10) ([36][0][0][0] / 0x0024), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160 [SAR 1:1 DAR 16:9], 50 fps, 50 tbr, 90k tbn',
    '  Stream #0:1[0x101](tur): Audio: ac3 ([129][0][0][0] / 0x0081), 48000 Hz, 5.1(side), fltp, 384 kb/s', 'Stream mapping:',
    'frame=  120 fps= 50 q=5.0 size=N/A time=00:00:02.40 bitrate=N/A dup=1 drop=4 speed=1.02x']) p.line(l);
  assert.ok(p.info.complete);
  assert.strictEqual(p.info.format, 'mpegts');
  const [v, a] = p.info.streams;
  assert.deepStrictEqual([v.codec, v.profile, v.width, v.height, v.fps, v.pixFmt, v.range, v.id], ['hevc', 'Main 10', 3840, 2160, 50, 'yuv420p10le', 'limited', '0x100']);
  assert.deepStrictEqual([a.codec, a.sampleRate, a.channels, a.bitrate, a.lang], ['ac3', 48000, 6, 384000, 'tur']);
  assert.strictEqual(p.info.programs[0].id, 1);
  assert.deepStrictEqual(p.stats, { frame: 120, fps: 50, time: '00:00:02.40', dup: 1, drop: 4, speed: 1.02 });
  const fail = (line) => { const q = new LogParser(); q.line(line); return q.failure().code; };
  assert.strictEqual(fail('[rtsp @ 0x1] method DESCRIBE failed: 401 Unauthorized'), 'unauthorized');
  assert.strictEqual(fail('[tcp @ 0x1] Connection to tcp://1.2.3.4:554 failed: Connection refused'), 'refused');
  assert.strictEqual(fail('rtsp://x: Server returned 404 Not Found'), 'not_found');
  assert.strictEqual(fail("Stream map '0:v:0' matches no streams."), 'no_stream');
  assert.strictEqual(fail('udp://x: Invalid data found when processing input'), 'bad_data');
});
