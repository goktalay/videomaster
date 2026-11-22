// Tanıtım ekran görüntüleri: sahte hesap sunucusu + sınama kaynakları (ffmpeg) + Electron.
// Kullanım (Linux, xvfb): VDM_FFMPEG=/usr/bin/ffmpeg xvfb-run -a -s "-screen 0 1920x1200x24" node scripts/screenshots.js
// Çıktı: docs/screenshots/*.png (Türkçe), docs/screenshots/en/*.png ve manifest.json (Mastertool sitesi bunları kullanır).
const path = require('path');
const { _electron: electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const APP = path.join(__dirname, '..');
const FF = process.env.VDM_FFMPEG || 'ffmpeg';
process.env.VDM_FFMPEG = FF;
const { source, H264, waitFor, udpPort } = require(APP + '/test/helpers');
const { createRtspServer } = require(APP + '/test/rtsp-server');
const { createMock } = require(APP + '/test/mock-server');
const SCHEMA = require(APP + '/src/schema');
const ROOT = path.join(APP, 'docs', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BIG = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25'];

async function run(LANG, THEME) {
  const OUT = LANG === 'tr' ? ROOT : path.join(ROOT, LANG);
  fs.mkdirSync(OUT, { recursive: true });
  const T = THEME === 'dark' ? 'gece' : 'gunduz';
  const shot = (w, name) => w.screenshot({ path: path.join(OUT, name + '-' + T + '.png') });
  const mock = createMock();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${mock.server.address().port}`;
  // kaynaklar
  const { spawn } = require('child_process');
  const ff = (args) => spawn(FF, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'ignore' });
  const udp = await udpPort();
  const vp = await udpPort(true); const ap = await udpPort(true);
  const sdpFile = path.join(os.tmpdir(), `e2e-${Date.now()}.sdp`);
  const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '50', '-bf', '0', '-pix_fmt', 'yuv420p', '-b:v', '1800k'];
  const p0 = ff(['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-map', '0:v', ...enc, '-f', 'rtp', `rtp://127.0.0.1:${vp}`, '-map', '1:a', '-c:a', 'pcm_mulaw', '-ar', '8000', '-ac', '1', '-f', 'rtp', `rtp://127.0.0.1:${ap}`, '-sdp_file', sdpFile]);
  await waitFor(() => fs.existsSync(sdpFile) && fs.statSync(sdpFile).size > 50, 10000);
  p0.kill('SIGKILL'); await sleep(300);
  const srv = createRtspServer({ sdp: fs.readFileSync(sdpFile, 'utf8'), ports: [vp, ap], auth: 'admin:1234' });
  const rtspPort = await srv.listen();
  const procs = [
    ff(['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-map', '0:v', ...enc, '-f', 'rtp', `rtp://127.0.0.1:${vp}`, '-map', '1:a', '-c:a', 'pcm_mulaw', '-ar', '8000', '-ac', '1', '-f', 'rtp', `rtp://127.0.0.1:${ap}`]),
    ff(['-re', '-f', 'lavfi', '-i', 'smptehdbars=size=960x540:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', ...enc, '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts', `udp://127.0.0.1:${udp}?pkt_size=1316`]),
  ];
  // kullanıcı verisi
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-e2e-'));
  const conns = [
    { id: 'c1', name: LANG === 'tr' ? 'Giriş kapısı' : 'Main entrance', protocol: 'rtsp', host: '127.0.0.1', port: rtspPort, path: '/Streaming/Channels/101', username: 'admin', password: '1234' },
    { id: 'c2', name: LANG === 'tr' ? 'Yayın çıkışı (IPTV)' : 'Broadcast feed (IPTV)', protocol: 'udp', host: '', port: udp },
    { id: 'c3', name: LANG === 'tr' ? 'Otopark kamerası' : 'Parking camera', protocol: 'rtsp', host: '10.255.255.1', port: 554, path: '/live/ch0', reconnect: false, timeout: 2 },
    { id: 'c4', name: 'Studio SRT', protocol: 'srt', host: 'ingest.example.com', port: 9000 },
  ].map((c) => ({ ...SCHEMA.normalize(c), id: c.id, createdAt: Date.now(), password: c.password ? 'b64:' + Buffer.from(c.password).toString('base64') : '' }));
  fs.writeFileSync(path.join(userData, 'store.json'), JSON.stringify({ folders: [{ id: 'f1', name: LANG === 'tr' ? 'Bina kameraları' : 'Building cameras', parentId: null }], connections: conns, local: {}, syncMeta: {}, settings: { appTheme: THEME, language: LANG } }));

  const app = await electron.launch({ colorScheme: THEME, executablePath: require(path.join(APP, 'node_modules', 'electron')), args: [APP, `--user-data-dir=${userData}`, '--no-sandbox'], env: { ...process.env, VDM_API: api, VDM_FFMPEG: FF } });
  const size = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => { if (w.isResizable()) w.setContentSize(1600, 1000); }));
  const login = await app.firstWindow();
  await login.waitForSelector('#email');
  await login.fill('#email', 'test@example.com');
  await login.fill('#password', 'Test1234!');
  const [main] = await Promise.all([app.waitForEvent('window'), login.click('#submit')]);
  await main.waitForSelector('.conn-card');
  await size();
  await main.click('.conn-card[data-id="c1"] .play-btn');
  await main.click('.conn-card[data-id="c2"] .play-btn');
  await main.click('.conn-card[data-id="c3"] .play-btn');
  await main.waitForSelector('.conn-card[data-id="c1"].playing', { timeout: 30000 });
  await main.waitForSelector('.conn-card[data-id="c2"].playing', { timeout: 30000 });
  await sleep(4000);
  await shot(main, '01-ana-ekran');
  await main.click('#btnNew');
  await main.waitForSelector('.cf');
  await main.fill('[data-paste]', 'rtsp://admin:gizli@192.168.1.64:554/Streaming/Channels/101');
  await main.press('[data-paste]', 'Enter');
  await sleep(2200);
  await shot(main, '02-yeni-baglanti');
  await main.click('.cf-tabs [data-tab="network"]'); await sleep(200);
  await shot(main, '03-ag-ayarlari');
  await main.keyboard.press('Escape');
  const [viewer] = await Promise.all([app.waitForEvent('window'), main.dblclick('.conn-card[data-id="c1"] .conn-body')]);
  await viewer.waitForSelector('.state-chip.s-playing', { timeout: 30000 });
  await size();
  await sleep(7000);
  await viewer.click('#btnRec'); await sleep(5000);
  await shot(viewer, '04-akis-penceresi');
  await viewer.click('#btnRec');
  await viewer.waitForSelector('.toast.ok', { timeout: 15000 });
  await viewer.click('[data-r="source"] [data-v="packets"]'); await sleep(1500);
  await viewer.click('.hv-pk.key >> nth=-1').catch(() => viewer.click('.hv-pk >> nth=-1')); await sleep(6500);
  await shot(viewer, '05-paketler');
  await viewer.click('[data-r="source"] [data-v="messages"]'); await sleep(600);
  await shot(viewer, '06-rtsp-sinyallesme');
  await app.close();
  for (const p of procs) p.kill('SIGKILL');
  srv.close(); mock.server.close();
}

const MANIFEST = [
  ['01-ana-ekran', 'Bağlantılar', 'Kartın üstündeki oynat düğmesi videoyu kartta oynatır; CANLI rozeti ve anlık veri hızı'],
  ['02-yeni-baglanti', 'Yeni bağlantı', 'Protokolü seçin; yapıştırılan adres alanlara kendiliğinden dağılır'],
  ['03-ag-ayarlari', 'Ağ ayarları', 'RTP taşıma, zaman aşımı, tamponlar ve yeniden bağlanma'],
  ['04-akis-penceresi', 'Akış penceresi', 'Video, HEX görünümü, veri hızı grafiği, akış bilgisi, akış ayarları ve kayıt'],
  ['05-paketler', 'Paket listesi', 'RTP sıra numarası, zaman damgası ve NAL türü; seçilen paketin baytları'],
  ['06-rtsp-sinyallesme', 'RTSP sinyalleşmesi', 'Sunucuyla alışverişin tamamı: istekler ve yanıtlar'],
];

(async () => {
  for (const lang of ['tr', 'en']) for (const theme of ['dark', 'light']) { console.log(lang, theme); await run(lang, theme); }
  const items = [];
  // galeri gece / gündüz dönüşümlü; ana ekran ve akış penceresi kahraman görseli için iki temada
  MANIFEST.forEach(([stem, title, caption], i) => {
    const themes = i === 0 || i === 3 ? ['gece', 'gunduz'] : [i % 2 ? 'gunduz' : 'gece'];
    for (const t of themes) items.push({ file: `${stem}-${t}.png`, theme: t === 'gece' ? 'dark' : 'light', title, caption });
  });
  const keep = new Set(items.map((x) => x.file));
  for (const dir of [ROOT, path.join(ROOT, 'en')]) for (const f of fs.readdirSync(dir)) if (f.endsWith('.png') && !keep.has(f)) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(ROOT, 'manifest.json'), JSON.stringify(items, null, 2) + '\n');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
