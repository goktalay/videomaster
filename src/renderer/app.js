'use strict';

// Ana pencere: bağlantı kartları (kart üstünde oynatma), klasörler, Yeni (bağlantı formu), ayarlar

let data = { folders: [], connections: [], settings: {} };
let currentFolder = null;
let query = '';
let selectedId = null;
const states = new Map();   // bağlantıId -> oturum durumu
const rates = new Map();    // bağlantıId -> son istatistik
const players = new Map();  // bağlantıId -> FramePlayer (görünen kartlar)
const subscribed = new Set();
const thumbVer = new Map();

const $ = (s) => document.querySelector(s);

// --- Başlangıç ---------------------------------------------------------------
$('.search-ico').innerHTML = icon('search');
$('#btnSettings').innerHTML = icon('gear');
$('#btnSettings').title = t('app.settings');
$('#btnNewFolder').innerHTML = icon('folderPlus') + esc(t('common.newFolder'));
$('#btnNew').innerHTML = icon('plus') + esc(t('common.new'));
$('#btnNew').title = t('app.newConnection') + ' (Ctrl+N)';
$('#search').placeholder = t('app.searchPh');
const paintThemeBtn = themeButton($('#btnTheme'), () => data.settings || {});
mountMastertool($('.topbar .actions'));

$('#btnSettings').onclick = () => openSettings(data.settings || {});
$('#content').addEventListener('mousedown', (e) => {
  if (!e.target.closest('.card, .new-card')) { selectedId = null; updateSelectionUI(); }
});
$('#btnNewFolder').onclick = () => newFolder();
$('#btnNew').onclick = () => newConnection();
$('#search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); render(); });

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-backdrop')) return;
  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newConnection(); }
  if (e.key === 'Escape' && document.activeElement === $('#search')) { $('#search').value = ''; query = ''; render(); $('#search').blur(); }
  if (e.key === 'Backspace' && !inInput && currentFolder) goFolder(folderById(currentFolder)?.parentId || null);
  const sel = data.connections.find((c) => c.id === selectedId);
  if (sel && !inInput) {
    if (e.key === 'Enter') window.api.openConnection(sel.id);
    if (e.key === ' ') { e.preventDefault(); togglePlay(sel); }
    if (e.key === 'Delete') deleteConnection(sel);
    if (e.key === 'F2') editExisting(sel);
  }
});

window.api.onStoreChanged((d) => { data = d; render(); paintThemeBtn(); });

// --- Akış olayları ---------------------------------------------------------------
const isRunning = (id) => { const s = states.get(id); return !!(s && s.running); };

window.api.onStreamState((st) => {
  const prev = states.get(st.id);
  states.set(st.id, st);
  if (!st.running) rates.delete(st.id);
  // kayıt bittiğinde dosyayı bildir
  if (prev && prev.rec && prev.rec.active && st.rec && !st.rec.active && st.rec.files.length) recordDone(st);
  paintCard(st.id);
  reconcile();
  paintStats();
});

window.api.onStreamStats((s) => {
  rates.set(s.id, s);
  const el = cardEl(s.id);
  if (!el) return;
  const live = el.querySelector('.live-rate');
  if (live) live.textContent = s.state === 'playing' ? formatRate(s.point.bps, data.settings.chartUnit) : '';
  const rec = el.querySelector('.rec-time');
  if (rec && s.rec) rec.textContent = formatDuration(Date.now() - s.rec.startedAt);
});

window.api.onStreamFrame(async ({ id, data: jpeg }) => {
  const p = players.get(id);
  if (p) await p.push(jpeg);
  window.api.streamAck(id);
});

window.api.onThumbChanged(({ id, v }) => {
  thumbVer.set(id, v);
  const img = cardEl(id) && cardEl(id).querySelector('.poster');
  if (img) { img.src = `vdm://thumb/${id}?v=${v}`; img.classList.remove('hidden'); }
});

function recordDone(st) {
  const file = st.rec.files[st.rec.files.length - 1];
  const el = toast(t('rec.saved'), { type: 'ok', sub: file, timeout: 12000 });
  el.style.cursor = 'pointer';
  el.onclick = () => window.api.recReveal(file);
}

// Görünen ve oynayan kartların karelerine abone ol; görünmeyenlerden çık
function reconcile() {
  const want = new Set([...players.keys()].filter((id) => isRunning(id)));
  for (const id of want) if (!subscribed.has(id)) { subscribed.add(id); window.api.streamSubscribe(id, true); }
  for (const id of [...subscribed]) if (!want.has(id)) { subscribed.delete(id); window.api.streamSubscribe(id, false); }
}

// --- Hesap rozeti ve senkron durumu ---------------------------------------------
let lastErrorShown = null;
onAcct((st) => {
  const b = $('#btnAccount');
  const name = (st.user && (st.user.name || st.user.email)) || st.email || '?';
  b.querySelector('.ac-avatar').textContent = name.trim().slice(0, 1).toUpperCase();
  const s = !st.syncEnabled || st.state === 'off' ? 'off' : st.state || 'idle';
  b.className = `account-chip s-${s}`;
  b.querySelector('.ac-sync').innerHTML = s === 'syncing' ? '<span class="spin"></span>' : icon(['off', 'offline', 'error'].includes(s) ? 'cloudOff' : 'cloud');
  b.title = `${(st.user && st.user.email) || st.email || ''}\n${syncText(st)}`;
  if (st.state === 'error' && st.error !== lastErrorShown) {
    lastErrorShown = st.error;
    toast(syncText(st), { type: 'err', timeout: 9000 });
  }
  if (st.state === 'ok') lastErrorShown = null;
});

$('#btnAccount').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  contextMenu(r.right - 260, r.bottom + 6, [
    { label: (acct.user && acct.user.email) || acct.email || '', icon: 'user', disabled: true, action: () => {} },
    { label: syncText(acct), icon: acct.syncEnabled ? 'cloud' : 'cloudOff', disabled: true, action: () => {} },
    '-',
    { label: t('acct.syncNow'), icon: 'refresh', disabled: !acct.syncEnabled, action: () => window.api.syncNow() },
    { label: t('acct.myAccount'), icon: 'open', action: () => window.api.openWeb('account') },
    { label: t('app.settings'), icon: 'gear', action: () => openSettings(data.settings || {}) },
    '-',
    { label: t('acct.logout'), icon: 'logout', danger: true, action: logout },
  ]);
};

// Yeni sürüm bildirimi: exe hesabın kişiye özel bağlantısından indirilir
window.api.onUpdateAvailable(({ version }) => {
  const bar = $('#updateBar');
  bar.innerHTML = `${icon('download')}<span>${esc(t('update.available', { version }))} — ${esc(t('update.hint'))}</span>
    <button class="btn sm primary" data-a="open">${esc(t('update.open'))}</button>
    <button class="icon-btn" data-a="close" title="${esc(t('common.cancel'))}">${icon('x')}</button>`;
  bar.classList.remove('hidden');
  bar.querySelector('[data-a="open"]').onclick = () => window.api.openWeb('account');
  bar.querySelector('[data-a="close"]').onclick = () => bar.classList.add('hidden');
});

window.api.onLibraryBackup((file) => toast(t('acct.backupNotice'), { sub: file, timeout: 12000 }));
Promise.all([window.api.getStore(), window.api.streamStates()]).then(([d, list]) => {
  data = d;
  for (const st of list) states.set(st.id, st);
  render();
  paintThemeBtn();
});

// --- Yardımcılar -------------------------------------------------------------
const folderById = (id) => data.folders.find((f) => f.id === id);
const sortByName = (a, b) => a.name.localeCompare(b.name, LANG, { sensitivity: 'base' });
const cardEl = (id) => document.querySelector(`.conn-card[data-id="${id}"]`);
const colorOf = (c) => c.color || (SCHEMA.PROTOCOLS[c.protocol] || SCHEMA.PROTOCOLS.rtsp).color;

function folderPath(id) {
  const out = [];
  let f = folderById(id);
  while (f) { out.unshift(f); f = folderById(f.parentId); }
  return out;
}

function countIn(folderId) {
  let n = data.connections.filter((c) => (c.folderId || null) === folderId).length;
  for (const sub of data.folders.filter((f) => (f.parentId || null) === folderId)) n += countIn(sub.id);
  return n;
}

function goFolder(id) {
  currentFolder = id && folderById(id) ? id : null;
  selectedId = null;
  render();
}

function updateSelectionUI() {
  document.querySelectorAll('.conn-card').forEach((x) => x.classList.toggle('selected', x.dataset.id === selectedId));
}

function paintStats() {
  const n = data.connections.length;
  const live = [...states.values()].filter((s) => s.running).length;
  $('#stats').textContent = n ? t('app.stats', { c: n, f: data.folders.length }) + (live ? ` · ${t('app.liveCount', { n: live })}` : '') : t('app.welcome');
}

// --- Çizim -------------------------------------------------------------------
function render() {
  if (currentFolder && !folderById(currentFolder)) currentFolder = null;
  renderCrumbs();
  renderGrid();
  updateSelectionUI();
  paintStats();
  reconcile();
}

function renderCrumbs() {
  const el = $('#crumbs');
  el.innerHTML = '';
  if (query) {
    el.appendChild(h(`<span class="crumb current">${icon('search')} ${esc(t('app.results', { q: query }))}</span>`));
    return;
  }
  const parts = [{ id: null, name: t('app.all') }, ...folderPath(currentFolder)];
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    const c = h(`<span class="crumb ${last ? 'current' : ''}">${i === 0 ? icon('home') : icon('folder')}${esc(p.name)}</span>`);
    if (!last) {
      c.onclick = () => goFolder(p.id);
      makeDropTarget(c, p.id);
    }
    el.appendChild(c);
    if (!last) el.appendChild(h(`<span class="crumb-sep">${icon('chevronRight')}</span>`));
  });
}

function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  players.clear();

  if (!data.connections.length && !data.folders.length) {
    const w = h(`<div class="welcome"><div class="new-card">
      <div class="plus">${icon('plus')}</div>
      <div class="lbl">${esc(t('common.new'))}</div>
      <div class="hint">${t('app.welcomeHint')}</div>
    </div></div>`);
    w.querySelector('.new-card').onclick = () => newConnection();
    grid.appendChild(w);
    return;
  }

  let folders;
  let conns;
  if (query) {
    folders = data.folders.filter((f) => f.name.toLowerCase().includes(query));
    conns = data.connections.filter((c) => [c.name, c.display, c.protocol, c.notes, t(`proto.${c.protocol}`)].some((v) => String(v || '').toLowerCase().includes(query)));
  } else {
    folders = data.folders.filter((f) => (f.parentId || null) === currentFolder);
    conns = data.connections.filter((c) => (c.folderId || null) === currentFolder);
  }
  folders.sort(sortByName);
  conns.sort(sortByName);

  if (folders.length) {
    grid.appendChild(h(`<div class="section-title">${esc(t('app.folders'))}</div>`));
    for (const f of folders) grid.appendChild(folderCard(f));
  }
  grid.appendChild(h(`<div class="section-title">${esc(t('app.connections'))}${conns.length ? `<span class="hint">${esc(t('app.dblHint'))}</span>` : ''}</div>`));
  for (const c of conns) grid.appendChild(connCard(c));

  if (!query) {
    const n = h(`<div class="new-card conn-new"><div class="plus">${icon('plus')}</div><div class="lbl">${esc(t('common.new'))}</div></div>`);
    n.onclick = () => newConnection();
    grid.appendChild(n);
  } else if (!conns.length && !folders.length) {
    grid.appendChild(h(`<div class="empty-note" style="grid-column:1/-1">${esc(t('app.noMatch'))}</div>`));
  }
}

function folderCard(f) {
  const n = countIn(f.id);
  const el = h(`<div class="card folder-card" draggable="true">
    <div class="avatar">${icon('folder')}</div>
    <div style="min-width:0">
      <div class="card-title">${esc(f.name)}</div>
      <div class="card-sub">${esc(t('app.folderCount', { n }))}</div>
    </div></div>`);
  el.addEventListener('dblclick', () => { $('#search').value = ''; query = ''; goFolder(f.id); });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: t('common.open'), icon: 'open', action: () => goFolder(f.id) },
      { label: t('app.newConnectionHere'), icon: 'plus', action: () => newConnection(f.id) },
      { label: t('app.newSubfolder'), icon: 'folderPlus', action: () => newFolder(f.id) },
      '-',
      { label: t('common.rename'), icon: 'edit', action: () => renameFolder(f) },
      { label: t('common.moveEllipsis'), icon: 'move', action: () => moveDialog({ type: 'folder', item: f }) },
      '-',
      { label: t('common.delete'), icon: 'trash', danger: true, action: () => deleteFolder(f) },
    ]);
  });
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-vdm', JSON.stringify({ type: 'folder', id: f.id }));
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  makeDropTarget(el, f.id);
  return el;
}

// Bağlantı kartı: üstte görüntü alanı (oynat düğmesi kartın üstünde), altta ad, adres ve etiketler
function connCard(c) {
  const P = SCHEMA.PROTOCOLS[c.protocol] || SCHEMA.PROTOCOLS.rtsp;
  const where = query && c.folderId ? folderPath(c.folderId).map((f) => f.name).join(' / ') : '';
  const el = h(`<div class="card conn-card" data-id="${esc(c.id)}" draggable="true" style="--c:${colorOf(c)}">
    <div class="thumb">
      <img class="poster hidden" alt="" draggable="false">
      <canvas></canvas>
      <div class="thumb-idle">${icon(P.icon)}</div>
      <div class="thumb-state"></div>
      <button class="play-btn" data-a="play"></button>
      <div class="badges"><span class="badge live hidden"><i></i>${esc(t('st.live'))}</span><span class="badge rec hidden"><i></i>REC <span class="rec-time"></span></span><span class="live-rate"></span></div>
      <div class="quick">
        <button class="icon-btn" data-a="edit" title="${esc(t('app.connSettings'))}">${icon('gear')}</button>
        <button class="icon-btn" data-a="open" title="${esc(t('app.openViewer'))}">${icon('expand')}</button>
      </div>
    </div>
    <div class="conn-body">
      <div class="card-title">${esc(c.name)}</div>
      <div class="card-sub" title="${esc(c.display)}">${esc(c.display)}</div>
      <div class="card-foot">
        <span class="tag proto-tag">${icon(P.icon)}${esc(t(`proto.${c.protocol}`))}</span>
        ${c.lastInfo && c.lastInfo.video ? `<span class="tag">${esc((c.lastInfo.video.codec || '').toUpperCase())} ${c.lastInfo.video.height ? `${c.lastInfo.video.height}p` : ''}</span>` : ''}
        ${c.lastInfo && c.lastInfo.audio ? `<span class="tag" title="${esc((c.lastInfo.audio.codec || '').toUpperCase())}">${icon('volume')}</span>` : ''}
        ${c.autoPlay ? `<span class="tag" title="${esc(t('f.autoPlay'))}">${icon('bolt')}</span>` : ''}
        ${where ? `<span class="tag">${icon('folder')}${esc(where)}</span>` : ''}
      </div>
    </div></div>`);
  const poster = el.querySelector('.poster');
  poster.onload = () => poster.classList.remove('hidden');
  poster.onerror = () => poster.classList.add('hidden');
  poster.src = `vdm://thumb/${c.id}?v=${thumbVer.get(c.id) || 0}`;
  players.set(c.id, new FramePlayer(el.querySelector('canvas'), { fit: 'cover' }));

  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'play') return togglePlay(c);
    if (a === 'open') return window.api.openConnection(c.id);
    if (a === 'edit') return editExisting(c);
    selectedId = c.id;
    updateSelectionUI();
  });
  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-a]')) return;
    window.api.openConnection(c.id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selectedId = c.id;
    updateSelectionUI();
    const st = states.get(c.id);
    const run = isRunning(c.id);
    contextMenu(e.clientX, e.clientY, [
      { label: run ? t('st.stop') : t('st.play'), icon: run ? 'stop' : 'play', kbd: 'Space', action: () => togglePlay(c) },
      { label: t('app.openViewer'), icon: 'expand', kbd: 'Enter', action: () => window.api.openConnection(c.id) },
      st && st.rec && st.rec.active
        ? { label: t('rec.stop'), icon: 'stop', action: () => window.api.recStop(c.id) }
        : { label: t('rec.start'), icon: 'record', action: () => window.api.recStart(c.id) },
      { label: t('rec.openDir'), icon: 'folder', action: () => window.api.recOpenDir(c.id) },
      '-',
      { label: t('app.connSettings'), icon: 'gear', kbd: 'F2', action: () => editExisting(c) },
      { label: t('app.copyUrl'), icon: 'copy', action: () => { window.api.copyText(c.display); toast(t('hex.copied'), { type: 'ok', timeout: 1500 }); } },
      { label: t('app.duplicate'), icon: 'copy', action: () => window.api.duplicateConnection(c.id) },
      { label: t('app.moveToFolder'), icon: 'move', action: () => moveDialog({ type: 'connection', item: c }) },
      '-',
      { label: t('common.delete'), icon: 'trash', danger: true, kbd: 'Del', action: () => deleteConnection(c) },
    ]);
  });
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-vdm', JSON.stringify({ type: 'connection', id: c.id }));
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  paintCard(c.id, el);
  return el;
}

// Kartın canlı durumu: oynat/durdur düğmesi, durum yazısı, CANLI / REC rozetleri
function paintCard(id, el = cardEl(id)) {
  if (!el) return;
  const st = states.get(id) || { state: 'idle', running: false };
  const run = !!st.running;
  el.classList.toggle('running', run);
  el.classList.toggle('playing', st.state === 'playing');
  el.classList.toggle('errored', st.state === 'error');
  const btn = el.querySelector('.play-btn');
  btn.innerHTML = icon(run ? 'stop' : 'play');
  btn.title = run ? t('st.stop') : t('st.play');
  const label = el.querySelector('.thumb-state');
  let text = '';
  if (st.state === 'connecting') text = `<span class="spin"></span>${esc(t('st.connecting'))}`;
  else if (st.state === 'reconnecting') text = `<span class="spin"></span>${esc(t('st.reconnecting', { n: st.attempts }))}<small>${esc(streamError(st.error))}</small>`;
  else if (st.state === 'error') text = `${icon('x')}${esc(streamError(st.error))}`;
  else if (st.state === 'playing' && st.layout && !st.layout.video) text = `${icon('volume')}${esc(t('st.audioOnly'))}`;
  label.innerHTML = text;
  label.classList.toggle('hidden', !text);
  el.querySelector('.badge.live').classList.toggle('hidden', st.state !== 'playing');
  el.querySelector('.badge.rec').classList.toggle('hidden', !(st.rec && st.rec.active));
  if (!run) { el.querySelector('.live-rate').textContent = ''; const p = players.get(id); if (p && st.state !== 'error') p.clear(); }
}

async function togglePlay(c) {
  const st = states.get(c.id);
  if (st && st.running) {
    if (st.rec && st.rec.active) {
      const ok = await confirmBox(t('st.stop'), esc(t('rec.stopConfirm')), { okText: t('st.stop'), danger: false });
      if (!ok) return;
    }
    await window.api.streamStop(c.id);
  } else await window.api.streamPlay(c.id, 'card');
}

// Sürükle-bırak: bağlantı/klasörü bir klasöre (veya üst seviyeye) taşı
function makeDropTarget(el, folderId) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('application/x-vdm')) return;
    depth++;
    el.classList.add('drop');
  });
  el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('drop'); } });
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('application/x-vdm')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  });
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    el.classList.remove('drop');
    const d = JSON.parse(e.dataTransfer.getData('application/x-vdm') || '{}');
    if (d.type === 'connection') {
      await window.api.moveConnection(d.id, folderId);
      toast(t('app.connMoved'), { type: 'ok', sub: folderId ? folderById(folderId).name : t('app.all') });
    } else if (d.type === 'folder' && d.id !== folderId) {
      const ok = await window.api.moveFolder(d.id, folderId);
      if (!ok) toast(t('app.folderIntoSelf'), { type: 'err' });
    }
  });
}

// --- Bağlantılar ---------------------------------------------------------------
async function newConnection(folderId = currentFolder) {
  const id = await editConnection(null, { folderId: typeof folderId === 'string' ? folderId : currentFolder, settings: data.settings });
  if (id) {
    toast(t('app.connSaved'), { type: 'ok', sub: t('app.playHint') });
    selectedId = id;
    updateSelectionUI();
  }
}

async function editExisting(c) {
  const id = await editConnection(c, { settings: data.settings });
  if (id) toast(t('common.saved'), { type: 'ok' });
}

async function deleteConnection(c) {
  const ok = await confirmBox(t('app.deleteConn'), t('app.deleteConnMsg', { name: esc(c.name) }));
  if (ok) { await window.api.deleteConnection(c.id); states.delete(c.id); if (selectedId === c.id) selectedId = null; }
}

// --- Klasör işlemleri ----------------------------------------------------------
async function newFolder(parentId = currentFolder) {
  const name = await prompt(t('common.newFolder'), { label: t('common.folderName'), placeholder: t('app.folderPh'), okText: t('common.create'), iconName: 'folderPlus' });
  if (name) await window.api.saveFolder({ name, parentId: typeof parentId === 'string' ? parentId : currentFolder });
}

async function renameFolder(f) {
  const name = await prompt(t('app.renameFolder'), { label: t('common.folderName'), value: f.name, okText: t('common.save') });
  if (name) await window.api.saveFolder({ id: f.id, name });
}

async function deleteFolder(f) {
  const n = countIn(f.id);
  const ok = await confirmBox(t('app.deleteFolder'), t('app.deleteFolderMsg', { name: esc(f.name) }) + (n ? t('app.deleteFolderConns', { n }) : ''));
  if (ok) await window.api.deleteFolder(f.id);
}

function folderOptions(selected, excludeId) {
  const out = [`<option value="">${esc(t('app.rootFolder'))}</option>`];
  const walk = (parentId, depth) => {
    for (const f of data.folders.filter((x) => (x.parentId || null) === parentId).sort(sortByName)) {
      if (f.id === excludeId) continue;
      out.push(`<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${'&nbsp;&nbsp;&nbsp;'.repeat(depth)}${esc(f.name)}</option>`);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  return out.join('');
}

async function moveDialog({ type, item }) {
  const current = type === 'connection' ? item.folderId : item.parentId;
  const target = await openModal({
    title: t('app.moveTitle', { name: item.name }), iconName: 'move',
    body: `<div class="field"><label>${esc(t('app.targetFolder'))}</label><select class="input" id="mv">${folderOptions(current, type === 'folder' ? item.id : null)}</select></div>`,
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('common.move'), cls: 'primary', onClick: (m) => ({ v: m.querySelector('#mv').value || null }) },
    ],
  });
  if (!target) return;
  if (type === 'connection') await window.api.moveConnection(item.id, target.v);
  else if (!(await window.api.moveFolder(item.id, target.v))) toast(t('app.folderIntoSelf'), { type: 'err' });
}
