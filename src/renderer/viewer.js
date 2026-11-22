'use strict';

// Akış penceresi: video, sağda açılır kapanır "Akış ayarları" paneli, altta akış verisi (HEX / ASCII / paketler),
// yanında akış bilgisi (kodek vb.) ve veri hızı grafiği; kayıt, anlık görüntü, ses.

const ID = new URLSearchParams(location.search).get('id');
const $ = (s) => document.querySelector(s);

let conn = null;
let settings = {};
let state = { state: 'idle', running: false };
let stats = null;
let form = null;
let dirty = false;
let avg = { sum: 0, n: 0 };

const player = new FramePlayer($('#canvas'));
const audio = new AudioPlayer();
let chart = null;
let hexView = null;
let cam = null;       // kamera kontrol paneli (model seçiliyse)
let camModel = null;  // panelin kurulduğu model
let camPick = null;   // videoda nokta seçimi açıkken ilgili denetim
let vision = null;    // yapay görü paneli

// --- Üst çubuk ------------------------------------------------------------------
$('#btnShot').innerHTML = icon('camera') + esc(t('vw.snapshot'));
$('#btnShot').title = `${t('vw.snapshot')} (S)`;
$('#btnFull').innerHTML = icon('expand');
$('#btnFull').title = `${t('vw.fullscreen')} (F)`;
$('#btnBottom').innerHTML = icon('panelBottom');
$('#btnBottom').title = `${t('vw.toggleBottom')} (H)`;
$('#btnPanel').innerHTML = icon('panelRight');
$('#btnPanel').title = `${t('vw.togglePanel')} (P)`;
$('#btnFit').innerHTML = icon('crosshair');
$('#panelClose').innerHTML = icon('x');
$('#panelTitle').innerHTML = `${icon('gear')}<b>${esc(t('vw.panelTitle'))}</b>`;
$('#panelApply').textContent = t('vw.apply');
$('#panelRevert').textContent = t('vw.revert');
$('#chartTitle').innerHTML = `${icon('chart')}${esc(t('chart.title'))}`;
const paintThemeBtn = themeButton($('#btnTheme'), () => settings);

$('#btnPlay').onclick = () => togglePlay();
$('#btnRec').onclick = () => toggleRecord();
$('#btnShot').onclick = () => snapshot();
$('#btnFull').onclick = () => toggleFullscreen();
$('#btnBottom').onclick = () => setLayout({ bottomOpen: !settings.bottomOpen });
$('#btnPanel').onclick = () => setLayout({ panelOpen: !settings.panelOpen });
$('#panelClose').onclick = () => setLayout({ panelOpen: false });
$('#btnFit').onclick = () => {
  const order = ['contain', 'cover', 'fill'];
  const next = order[(order.indexOf(conn.fit) + 1) % order.length];
  saveSoft({ fit: next });
};
$('#btnMute').onclick = () => setMuted(!audio.muted);
$('#volume').oninput = (e) => { audio.setVolume(Number(e.target.value) / 100); if (audio.muted && Number(e.target.value) > 0) setMuted(false); paintVolume(); };
$('#volume').onchange = (e) => saveSoft({ volume: Number(e.target.value) });
$('#video').addEventListener('dblclick', () => { if (!camPick) toggleFullscreen(); });
$('#video').addEventListener('click', (e) => pickOnVideo(e));

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-backdrop')) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'r') toggleRecord();
  else if (k === 's') snapshot();
  else if (k === 'm') setMuted(!audio.muted);
  else if (k === 'f' || e.key === 'F11') { e.preventDefault(); toggleFullscreen(); }
  else if (k === 'h') setLayout({ bottomOpen: !settings.bottomOpen });
  else if (k === 'p') setLayout({ panelOpen: !settings.panelOpen });
  else if (e.key === 'Escape' && document.fullscreenElement) document.exitFullscreen();
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#video').requestFullscreen().catch(() => {});
}
document.addEventListener('fullscreenchange', () => setTimeout(() => player.draw(), 50));
new ResizeObserver(() => player.draw()).observe($('#video'));

// --- Oynatma, kayıt, anlık görüntü ---------------------------------------------------
async function togglePlay() {
  if (state.running) {
    if (state.rec && state.rec.active) {
      const ok = await confirmBox(t('st.stop'), esc(t('rec.stopConfirm')), { okText: t('st.stop'), danger: false });
      if (!ok) return;
    }
    await window.api.streamStop(ID);
  } else await window.api.streamPlay(ID, 'viewer');
}

async function toggleRecord() {
  const btn = $('#btnRec');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    if (state.rec && state.rec.active) {
      const r = await window.api.recStop(ID);
      const file = r && r.files[r.files.length - 1];
      if (file) {
        const el = toast(t('rec.saved'), { type: 'ok', sub: `${file}${r.size ? ` · ${formatSize(r.size).replace(/[⁦⁩]/g, '')}` : ''}`, timeout: 12000 });
        el.style.cursor = 'pointer';
        el.onclick = () => window.api.recReveal(file);
      } else toast(t('rec.empty'), { type: 'err' });
    } else {
      const r = await window.api.recStart(ID);
      if (r && r.error) toast(t('rec.failed'), { type: 'err', sub: streamError(r.error), timeout: 8000 });
    }
  } finally { btn.disabled = false; }
}

async function snapshot() {
  const file = await window.api.streamSaveFrame(ID);
  if (!file) return toast(t('vw.noFrame'), { type: 'err' });
  $('#video').classList.add('flash');
  setTimeout(() => $('#video').classList.remove('flash'), 180);
  const el = toast(t('vw.snapshotSaved'), { type: 'ok', sub: file, timeout: 7000 });
  el.style.cursor = 'pointer';
  el.onclick = () => window.api.recReveal(file);
}

function setMuted(m) { audio.setMuted(m); paintVolume(); }
function paintVolume() {
  $('#btnMute').innerHTML = icon(audio.muted || audio.volume === 0 ? 'volumeOff' : 'volume');
  $('#btnMute').title = `${audio.muted ? t('vw.unmute') : t('vw.mute')} (M)`;
  const has = !!(state.layout && state.layout.audio);
  document.querySelector('.vol').classList.toggle('off', !has);
  document.querySelector('.vol').title = has ? '' : t('vw.noAudio');
}

// Yeniden bağlanma gerektirmeyen küçük ayarlar (sığdırma, ses düzeyi) doğrudan kaydedilir
async function saveSoft(patch) {
  Object.assign(conn, patch);
  applyConn();
  const cur = await window.api.getConnection(ID);
  if (!cur) return;
  const keep = {};
  for (const f of SCHEMA.FIELDS) if (f.type === 'password') keep[`keep_${f.key}`] = true;
  await window.api.saveConnection({ ...cur, ...patch, ...keep, id: ID });
  if (form && !dirty) form.setValues({ ...cur, ...patch });
}

// --- Yerleşim (paneller, ayırıcılar) -----------------------------------------------
function applyLayout() {
  $('#panel').classList.toggle('hidden', !settings.panelOpen);
  $('#splitPanel').classList.toggle('hidden', !settings.panelOpen);
  $('#bottom').classList.toggle('hidden', !settings.bottomOpen);
  $('#splitBottom').classList.toggle('hidden', !settings.bottomOpen);
  $('#btnPanel').classList.toggle('active', !!settings.panelOpen);
  $('#btnBottom').classList.toggle('active', !!settings.bottomOpen);
  $('#panel').style.width = `${settings.panelWidth || 380}px`;
  $('#bottom').style.height = `${settings.bottomHeight || 290}px`;
  $('#side').style.width = `${settings.infoWidth || 380}px`;
  player.draw();
  if (vision) vision.draw();
  if (chart) chart.draw();
  if (hexView) hexView.paint();
}
function setLayout(patch) {
  Object.assign(settings, patch);
  window.api.setSettings(patch);
  applyLayout();
}

function splitter(el, axis, get, set) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const base = get();
    el.classList.add('drag');
    const move = (ev) => { set(base - ((axis === 'x' ? ev.clientX : ev.clientY) - start)); applyLayoutLive(); };
    const up = () => {
      el.classList.remove('drag');
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      window.api.setSettings({ panelWidth: settings.panelWidth, bottomHeight: settings.bottomHeight, infoWidth: settings.infoWidth });
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const applyLayoutLive = () => applyLayout();
splitter($('#splitPanel'), 'x', () => settings.panelWidth || 380, (v) => { settings.panelWidth = clamp(v, 300, Math.max(320, innerWidth - 480)); });
splitter($('#splitBottom'), 'y', () => settings.bottomHeight || 290, (v) => { settings.bottomHeight = clamp(v, 140, Math.max(160, innerHeight - 220)); });
splitter($('#splitInfo'), 'x', () => settings.infoWidth || 380, (v) => { settings.infoWidth = clamp(v, 240, 640); });

// --- Durum ---------------------------------------------------------------------
function applyConn() {
  const P = SCHEMA.PROTOCOLS[conn.protocol] || SCHEMA.PROTOCOLS.rtsp;
  document.documentElement.style.setProperty('--c', conn.color || P.color);
  $('#protoIcon').innerHTML = icon(P.icon);
  $('#name').textContent = conn.name;
  $('#url').textContent = conn.display;
  document.title = `${conn.name} — Video Master`;
  player.fit = conn.fit || 'contain';
  player.draw();
  if (vision) vision.draw();
  $('#btnFit').title = `${t('f.fit')}: ${t(`o.fit.${conn.fit || 'contain'}`)}`;
}

function paintState() {
  const s = state.state;
  const chip = $('#state');
  chip.className = `state-chip s-${s}`;
  const label = { idle: t('st.idle'), connecting: t('st.connecting'), playing: t('st.live'), reconnecting: t('st.reconnecting', { n: state.attempts || 1 }), error: t('st.error') }[s] || s;
  chip.innerHTML = `${['connecting', 'reconnecting'].includes(s) ? '<span class="spin"></span>' : '<i></i>'}${esc(label)}`;
  const run = !!state.running;
  $('#btnPlay').innerHTML = icon(run ? 'stop' : 'play') + esc(run ? t('st.stop') : t('st.play'));
  $('#btnPlay').title = `${run ? t('st.stop') : t('st.play')} (Space)`;
  $('#btnPlay').classList.toggle('primary', !run);

  const rec = state.rec && state.rec.active;
  const b = $('#btnRec');
  b.classList.toggle('on', !!rec);
  b.innerHTML = `${icon(rec ? 'stop' : 'record')}<span>${esc(rec ? t('rec.stop') : t('rec.start'))}</span>${rec ? `<span class="rec-time" id="recTime">${formatDuration(Date.now() - state.rec.startedAt)}</span>` : ''}`;
  b.title = `${rec ? t('rec.stop') : t('rec.start')} (R)`;

  const ov = $('#overlay');
  let html = '';
  if (s === 'idle') html = `<button class="big-play" id="ovPlay">${icon('play')}</button><div>${esc(t('st.pressPlay'))}</div>`;
  else if (s === 'connecting') html = `<span class="spin big"></span><div>${esc(t('st.connecting'))}</div><small>${esc(conn ? conn.display : '')}</small>`;
  else if (s === 'reconnecting') html = `<span class="spin big"></span><div>${esc(t('st.reconnecting', { n: state.attempts || 1 }))}</div><small>${esc(streamError(state.error))}</small>`;
  else if (s === 'error') html = `<div class="ov-err">${icon('x')}</div><div>${esc(streamError(state.error))}</div><small>${esc((state.error && state.error.detail) || '')}</small><button class="btn" id="ovRetry">${icon('refresh')}${esc(t('st.retry'))}</button>`;
  else if (s === 'playing' && state.layout && !state.layout.video) html = `<div class="ov-audio">${icon('volume')}</div><div>${esc(t('st.audioOnly'))}</div>`;
  ov.innerHTML = html;
  ov.classList.toggle('hidden', !html);
  ov.classList.toggle('dim', s === 'reconnecting' && player.frames > 0);
  if ($('#ovPlay')) $('#ovPlay').onclick = () => togglePlay();
  if ($('#ovRetry')) $('#ovRetry').onclick = () => window.api.streamPlay(ID, 'viewer');
  if (s === 'idle') { player.clear(); avg = { sum: 0, n: 0 }; }
  if (hexView) hexView.setTapKind(state.tapKind || null);
  paintVolume();
  paintInfo();
}

// --- Akış bilgisi paneli ------------------------------------------------------------
const openSecs = new Set(['status', 'video', 'audio']);
function paintInfo() {
  const box = $('#info');
  const info = state.info;
  const unit = settings.chartUnit || 'bit';
  const row = (k, v) => (v === undefined || v === null || v === '' ? '' : `<div class="kv"><span>${esc(k)}</span><b>${v}</b></div>`);
  const sec = (id, ic, title, body) => (body ? `<details data-sec="${id}" ${openSecs.has(id) ? 'open' : ''}><summary>${icon(ic)}<span>${esc(title)}</span>${icon('chevronDown', 'chev')}</summary><div class="kvs">${body}</div></details>` : '');
  const tap = stats && stats.tap;
  const p = stats ? stats.point : null;
  const ff = (stats && stats.ff) || {};
  let html = '';

  html += sec('status', 'signal', t('info.status'),
    row(t('info.state'), esc($('#state').textContent))
    + row(t('info.uptime'), state.since ? formatDuration(Date.now() - state.since) : '')
    + row(t('info.rate'), p && state.running ? formatRate(p.bps, unit) : '')
    + row(t('info.rateAvg'), avg.n ? formatRate(avg.sum / avg.n, unit) : '')
    + row(t('info.packetRate'), p && p.pps ? `${p.pps} ${esc(t('chart.pps'))}` : '')
    + row(t('info.received'), tap ? formatSize(tap.bytesIn) : '')
    + row(t('info.sent'), tap && tap.bytesOut ? formatSize(tap.bytesOut) : '')
    + row(t('info.fpsShown'), p && state.state === 'playing' ? `${p.fps} fps` : '')
    + row(t('info.framesDropped'), ff.drop ? String(ff.drop) : '')
    + row(t('info.source'), state.tapKind ? esc(t(`hex.kind.${state.tapKind}`)) : ''));

  for (const s of (info ? info.streams : [])) {
    if (s.type === 'video') {
      html += sec('video', 'video', `${t('info.video')} #${s.index}`,
        row(t('info.codec'), esc(`${(s.codec || '').toUpperCase()}${s.profile ? ` (${s.profile})` : ''}`))
        + row(t('info.resolution'), s.width ? `${s.width} × ${s.height}` : '')
        + row(t('info.aspect'), s.dar ? esc(`${s.dar}${s.sar && s.sar !== '1:1' ? ` (SAR ${s.sar})` : ''}`) : '')
        + row(t('info.fps'), s.fps ? `${s.fps} fps` : s.tbr ? `${s.tbr} tbr` : '')
        + row(t('info.pixFmt'), esc(s.pixFmt || ''))
        + row(t('info.color'), esc([s.color, s.range ? t(`info.range.${s.range}`) : ''].filter(Boolean).join(' · ')))
        + row(t('info.scan'), esc(s.scan || ''))
        + row(t('info.bitrate'), s.bitrate ? formatRate(s.bitrate, unit) : '')
        + row(t('info.gop'), tap && tap.keyIntervalMs ? `${(tap.keyIntervalMs / 1000).toFixed(2)} s` : '')
        + row(t('info.timebase'), s.tbn ? `1/${s.tbn}` : '')
        + row(t('info.streamId'), esc(s.id || '')));
    } else if (s.type === 'audio') {
      html += sec('audio', 'audio', `${t('info.audio')} #${s.index}`,
        row(t('info.codec'), esc(`${(s.codec || '').toUpperCase()}${s.profile ? ` (${s.profile})` : ''}`))
        + row(t('info.sampleRate'), s.sampleRate ? `${s.sampleRate} Hz` : '')
        + row(t('info.channels'), esc(s.layout || ''))
        + row(t('info.sampleFmt'), esc(s.sampleFmt || ''))
        + row(t('info.bitrate'), s.bitrate ? formatRate(s.bitrate, unit) : '')
        + row(t('info.language'), esc(s.lang && s.lang !== 'und' ? s.lang : '')));
    } else {
      html += sec(`other${s.index}`, 'file', `${s.type} #${s.index}`, row(t('info.codec'), esc(s.raw || '')));
    }
  }

  if (info) {
    html += sec('container', 'layers', t('info.container'),
      row(t('info.format'), esc(info.format))
      + row(t('info.start'), info.start ? `${info.start.toFixed(3)} s` : '')
      + row(t('info.totalBitrate'), info.bitrate ? formatRate(info.bitrate, unit) : '')
      + row(t('info.programs'), info.programs.length ? esc(info.programs.map((x) => `${x.id}${x.name ? ` ${x.name}` : ''}`).join(', ')) : '')
      + Object.entries(info.metadata || {}).map(([k, v]) => row(k, esc(v))).join('')
      + row(t('info.server'), tap && tap.server ? esc(tap.server) : ''));
  }

  if (tap && tap.rtp.length) {
    html += sec('rtp', 'layers', 'RTP', tap.rtp.map((r) => `<div class="kv-sub">SSRC ${(r.ssrc >>> 0).toString(16).padStart(8, '0')}</div>`
      + row(t('info.payload'), esc(`${r.pt}${r.codec ? ` · ${r.codec}/${r.rate}` : ''}`))
      + row(t('info.packets'), String(r.packets))
      + row(t('info.lost'), `<span class="${r.lost ? 'bad' : ''}">${r.lost} (${r.lossPct}%)</span>`)
      + row(t('info.reordered'), r.reordered ? String(r.reordered) : '')
      + row(t('info.jitter'), `${r.jitter} ms`)).join(''));
  }
  if (tap && tap.ts) {
    html += sec('ts', 'layers', 'MPEG-TS',
      row(t('info.packets'), String(tap.ts.packets))
      + row(t('info.ccErrors'), `<span class="${tap.ts.ccErrors ? 'bad' : ''}">${tap.ts.ccErrors}</span>`)
      + row(t('info.syncLoss'), tap.ts.syncLoss ? String(tap.ts.syncLoss) : '')
      + `<div class="pids">${tap.ts.pids.map((x) => `<span title="${x.packets}${x.ccErrors ? ` · CC ${x.ccErrors}` : ''}" class="${x.ccErrors ? 'bad' : ''}">0x${x.pid.toString(16).padStart(4, '0')}<i>${x.packets}</i></span>`).join('')}</div>`);
  }
  if (state.rec && (state.rec.active || state.rec.files.length)) {
    const f = state.rec.file || state.rec.files[state.rec.files.length - 1];
    html += sec('rec', 'record', t('info.recording'),
      row(t('info.recFile'), f ? `<a data-reveal="${esc(f)}">${esc(f.split(/[\\/]/).pop())}</a>` : '')
      + row(t('info.recSize'), stats && stats.rec && stats.rec.size ? formatSize(stats.rec.size) : state.rec.size ? formatSize(state.rec.size) : '')
      + row(t('info.recTime'), state.rec.active ? formatDuration(Date.now() - state.rec.startedAt) : '')
      + row(t('info.recError'), state.rec.error ? `<span class="bad">${esc(streamError(state.rec.error))}</span>` : ''));
  }
  if (state.sdp) html += `<details data-sec="sdp" ${openSecs.has('sdp') ? 'open' : ''}><summary>${icon('file')}<span>SDP</span>${icon('chevronDown', 'chev')}</summary><pre class="pre">${esc(state.sdp)}</pre></details>`;
  if (state.command) html += `<details data-sec="cmd" ${openSecs.has('cmd') ? 'open' : ''}><summary>${icon('terminal')}<span>${esc(t('info.command'))}</span>${icon('chevronDown', 'chev')}</summary><pre class="pre">${esc(state.command)}</pre></details>`;
  if (!html || (!info && !state.running)) html += `<div class="empty-note">${esc(t('info.empty'))}</div>`;

  const top = box.scrollTop;
  box.innerHTML = html;
  box.scrollTop = top;
}
$('#info').addEventListener('toggle', (e) => {
  const d = e.target.closest('details');
  if (!d) return;
  if (d.open) openSecs.add(d.dataset.sec); else openSecs.delete(d.dataset.sec);
}, true);
$('#info').addEventListener('click', (e) => {
  const a = e.target.closest('[data-reveal]');
  if (a) window.api.recReveal(a.dataset.reveal);
});

// --- Akış ayarları paneli -------------------------------------------------------------
async function buildPanel() {
  const about = await window.api.about();
  const cur = await window.api.getConnection(ID);
  form = buildConnForm(cur, { compact: true, caps: about, onChange: () => { dirty = true; paintPanelFoot(); } });
  $('#panelBody').innerHTML = '';
  $('#panelBody').appendChild(form.el);
  dirty = false;
  paintPanelFoot();
}
function paintPanelFoot() {
  $('#panelApply').disabled = !dirty;
  $('#panelRevert').disabled = !dirty;
  $('#panelNote').textContent = dirty ? t('vw.unsaved') : '';
}
$('#panelApply').onclick = async () => {
  const r = await window.api.saveConnection({ ...form.values(), id: ID });
  if (!r.ok) { form.markInvalid(r.invalid || []); return toast(t('cf.invalid'), { type: 'err' }); }
  dirty = false;
  paintPanelFoot();
  toast(t('vw.applied'), { type: 'ok', timeout: 2200 });
};
$('#panelRevert').onclick = () => buildPanel();

// --- Kamera kontrol paneli (modele özel) ---------------------------------------------
function paintPanelTabs() {
  if (!cam && settings.panelTab === 'camera') settings.panelTab = 'stream';
  const tab = ['camera', 'vision'].includes(settings.panelTab) ? settings.panelTab : 'stream';
  const list = [['stream', 'gear', t('vw.tabStream')]];
  if (cam) list.push(['camera', 'camera', t('vw.tabCamera')]);
  list.push(['vision', 'eye', t('vw.tabVision')]);
  $('#panelTabs').classList.remove('hidden');
  $('#panelTabs').innerHTML = list.map(([v, ic, l]) => `<button type="button" data-v="${v}" class="${tab === v ? 'on' : ''}">${icon(ic)}${esc(l)}</button>`).join('');
  $('#panelBody').classList.toggle('hidden', tab !== 'stream');
  $('#panelFoot').classList.toggle('hidden', tab !== 'stream');
  $('#camBody').classList.toggle('hidden', tab !== 'camera');
  $('#visBody').classList.toggle('hidden', tab !== 'vision');
  const title = tab === 'camera' ? `${t('vw.tabCamera')} — ${SCHEMA.MODEL_BY_ID[camModel].name}` : tab === 'vision' ? t('vw.visionTitle') : t('vw.panelTitle');
  $('#panelTitle').innerHTML = `${icon(tab === 'camera' ? 'camera' : tab === 'vision' ? 'eye' : 'gear')}<b>${esc(title)}</b>`;
}
$('#panelTabs').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.panelTab = b.dataset.v;
  window.api.setSettings({ panelTab: settings.panelTab });
  paintPanelTabs();
};

function setPick(control) {
  camPick = control;
  $('#video').classList.toggle('picking', !!control);
}

// Model değiştiyse panel yeniden kurulur; model kaldırıldıysa panel kapanır
async function syncCamPanel(first) {
  const def = SCHEMA.modelOf(conn);
  const id = def ? def.id : null;
  if (id !== camModel) {
    if (cam) { cam.destroy(); cam = null; setPick(null); await window.api.camDisconnect(ID); }
    camModel = id;
    $('#camBody').innerHTML = '';
    if (def) {
      cam = buildCamPanel({ id: ID, def, conn, onPick: setPick });
      $('#camBody').appendChild(cam.el);
      if (first) settings.panelTab = settings.panelTab || 'camera';
      const st = await window.api.camState(ID);
      cam.setState(st && st.connected ? st : conn.camAutoConnect ? await window.api.camConnect(ID) : null);
    }
  } else if (cam) cam.setConn(conn);
  paintPanelTabs();
}

// Videoda tıklanan nokta → kameranın görüntü uzayında merkeze göre piksel (çevirme ve döndürme geri alınır)
function pickOnVideo(e) {
  if (!camPick || !cam) return;
  if (!player.last) return toast(t('cam.noVideo'), { type: 'err' });
  const c = $('#canvas');
  const r = c.getBoundingClientRect();
  let w = r.width; let hh = r.height; let x0 = 0; let y0 = 0;
  if (player.fit !== 'fill') {
    const k = player.fit === 'cover' ? Math.max(r.width / player.width, r.height / player.height) : Math.min(r.width / player.width, r.height / player.height);
    w = player.width * k; hh = player.height * k; x0 = (r.width - w) / 2; y0 = (r.height - hh) / 2;
  }
  let u = (e.clientX - r.left - x0) / w;
  let v = (e.clientY - r.top - y0) / hh;
  if (u < 0 || u > 1 || v < 0 || v > 1) return;
  if (conn.flipH) u = 1 - u;
  if (conn.flipV) v = 1 - v;
  if (conn.rotate === '90') [u, v] = [v, 1 - u];
  else if (conn.rotate === '180') [u, v] = [1 - u, 1 - v];
  else if (conn.rotate === '270') [u, v] = [1 - v, u];
  const sp = camPick.space || { w: 1920, h: 1080 };
  const x = Math.round((u - 0.5) * sp.w);
  let y = Math.round((v - 0.5) * sp.h);
  if (camPick.invertKey && conn[camPick.invertKey]) y = -y;
  const mark = h('<span class="pick-mark"></span>');
  mark.style.left = `${e.clientX - $('#video').getBoundingClientRect().left}px`;
  mark.style.top = `${e.clientY - $('#video').getBoundingClientRect().top}px`;
  $('#video').appendChild(mark);
  setTimeout(() => mark.remove(), 900);
  cam.run(camPick.cmd, { x, y });
}

window.api.onCamState((m) => { if (m.id === ID && cam) cam.setState(m.state); });
window.api.onCamStatus((m) => { if (m.id === ID && cam) cam.setStatus(m.status); });
window.api.onCamReply((m) => { if (m.id === ID && cam) cam.reply(m); });
window.api.onCamLog((m) => { if (m.id === ID && cam) cam.addLog(m); });

// --- Olaylar --------------------------------------------------------------------
window.api.onStreamState((st) => {
  if (st.id !== ID) return;
  state = st;
  paintState();
});

let infoTick = 0;
window.api.onStreamStats((s) => {
  if (s.id !== ID) return;
  stats = s;
  if (chart) chart.add(s.point);
  if (s.state === 'playing') { avg.sum += s.point.bps; avg.n++; }
  $('#chartNow').innerHTML = state.running ? formatRate(s.point.bps, settings.chartUnit) : '';
  const rt = $('#recTime');
  if (rt && s.rec) rt.textContent = formatDuration(Date.now() - s.rec.startedAt);
  $('#osd').textContent = s.state === 'playing' && player.width ? `${player.width}×${player.height} · ${s.point.fps} fps · ${formatRate(s.point.bps, settings.chartUnit).replace(/[⁦⁩]/g, '')}` : '';
  if (++infoTick % 2 === 0) paintInfo();
});

window.api.onStreamFrame(async ({ id, data }) => {
  if (id !== ID) return;
  await player.push(data);
  window.api.streamAck(ID);
});
window.api.onStreamAudio(({ id, data }) => { if (id === ID) audio.push(data); });

window.api.onConnectionChanged((c) => {
  if (c.id !== ID) return;
  conn = c;
  applyConn();
  if (!dirty && form) form.setValues(c);
  syncCamPanel(false);
});
window.api.onStoreChanged((d) => {
  const unit = settings.chartUnit;
  const layout = { panelTab: settings.panelTab, panelOpen: settings.panelOpen, bottomOpen: settings.bottomOpen, panelWidth: settings.panelWidth, bottomHeight: settings.bottomHeight, infoWidth: settings.infoWidth, chartRange: settings.chartRange };
  settings = { ...d.settings, ...layout };
  paintThemeBtn();
  if (unit !== settings.chartUnit) paintChartControls();
});

function paintChartControls() {
  $('#chartRange').innerHTML = [[30, `30 ${t('chart.sec')}`], [60, `1 ${t('chart.min')}`], [300, `5 ${t('chart.min')}`]].map(([v, l]) => `<button type="button" data-v="${v}" class="${Number(settings.chartRange) === v ? 'on' : ''}">${esc(l)}</button>`).join('');
  $('#chartUnit').innerHTML = [['bit', 'bit/s'], ['byte', 'B/s']].map(([v, l]) => `<button type="button" data-v="${v}" class="${(settings.chartUnit || 'bit') === v ? 'on' : ''}">${l}</button>`).join('');
  if (chart) { chart.setUnit(settings.chartUnit || 'bit'); chart.setRange(Number(settings.chartRange) || 60); }
}
$('#chartRange').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; settings.chartRange = Number(b.dataset.v); window.api.setSettings({ chartRange: settings.chartRange }); paintChartControls(); };
$('#chartUnit').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; settings.chartUnit = b.dataset.v; window.api.setSettings({ chartUnit: settings.chartUnit }); paintChartControls(); paintInfo(); };

// --- Başlangıç ------------------------------------------------------------------
(async () => {
  const [store, c] = await Promise.all([window.api.getStore(), window.api.getConnection(ID)]);
  if (!c) return window.close();
  settings = store.settings;
  conn = c;
  applyConn();
  paintThemeBtn();
  audio.setVolume((c.volume ?? 100) / 100);
  audio.setMuted(!!c.startMuted);
  $('#volume').value = String(c.volume ?? 100);
  chart = new RateChart($('#chart'), { unit: settings.chartUnit || 'bit', range: Number(settings.chartRange) || 60 });
  hexView = new HexView($('#hex'), { id: ID, settings });
  paintChartControls();
  applyLayout();
  await buildPanel();
  await syncCamPanel(true);
  vision = buildVisionPanel({ id: ID, conn, canvas: $('#visionCanvas'), player });
  $('#visBody').appendChild(vision.el);
  paintPanelTabs();
  state = (await window.api.streamState(ID)) || state;
  chart.set(await window.api.streamHistory(ID));
  paintState();
  await window.api.streamSubscribe(ID, true);
  // Pencere açılınca akış başlar (kartta oynuyorsa tam çözünürlüğe ve sese geçer)
  const st = await window.api.streamPlay(ID, 'viewer');
  if (st) { state = st; paintState(); }
})();
