'use strict';

// Dron penceresi: solda modüller (genel bakış, ayarlar, parametreler, motor testi, kalibrasyon), ortada seçili modül,
// altında aranabilir haberleşme günlüğü, sağda temel telemetrinin çizgi grafikleri.

const ID = new URLSearchParams(location.search).get('id');
const $ = (s) => document.querySelector(s);

let drone = null;
let settings = {};
let st = { connected: false, linked: false, telemetry: {} };
let moduleId = 'overview';
const statusTexts = [];
let charts = null;
let log = null;

const BASE_MODULES = [['overview', 'gauge'], ['params', 'rows'], ['motors', 'bolt'], ['calib', 'crosshair']];
// "Ayarlar" (temel uçuş ayarları, bkz. dronetuning.js) yalnızca MAVLink araçlarında, genel bakıştan hemen sonra
const withTuning = (list) => [list[0], ['tuning', 'gear'], ...list.slice(1)];
let MODULES = BASE_MODULES;
const isBf = () => !!drone && drone.firmware === 'betaflight'; // Betaflight: MSP + komut satırı (CLI)
const call = (method, ...args) => window.api.droneCall(ID, method, ...args);
const tm = () => st.telemetry || {};
const sevClass = (s) => (s <= 3 ? 'err' : s === 4 ? 'warn' : '');

// --- Üst çubuk -----------------------------------------------------------------------------------
$('#btnLog').innerHTML = icon('panelBottom');
$('#btnSide').innerHTML = icon('panelRight');
$('#btnLog').title = t('dr.toggleLog');
$('#btnSide').title = t('dr.toggleSide');
$('#logTitle').innerHTML = `${icon('terminal')}${esc(t('dr.log'))}`;
$('#logIco').innerHTML = icon('search');
$('#sideTitle').innerHTML = `${icon('chart')}<b>${esc(t('dr.telemetry'))}</b>`;
const paintThemeBtn = themeButton($('#btnTheme'), () => settings);

$('#btnConnect').onclick = async () => {
  const b = $('#btnConnect');
  b.disabled = true;
  try {
    if (st.connected) await window.api.droneDisconnect(ID);
    else applyState(await window.api.droneConnect(ID));
  } finally { b.disabled = false; }
};
$('#btnArm').onclick = async () => {
  if (!st.linked) return;
  const arm = !st.armed;
  if (arm && !(await confirmBox(t('dr.arm'), esc(t('dr.armConfirm')), { okText: t('dr.arm') }))) return;
  const r = await call('arm', arm, false);
  report(r, arm ? t('dr.arm') : t('dr.disarm'));
};
$('#mode').onchange = async (e) => { const r = await call('setMode', e.target.value); report(r, `${t('dr.mode')}: ${e.target.value}`); paintTop(); };
$('#btnLog').onclick = () => setLayout({ droneLogOpen: settings.droneLogOpen === false });
$('#btnSide').onclick = () => setLayout({ droneSideOpen: settings.droneSideOpen === false });

function report(r, what) {
  if (r && r.ok) toast(what, { type: 'ok', sub: r.resultName && r.resultName !== 'ACCEPTED' ? r.resultName : '', timeout: 2200 });
  else toast(t('dr.failed'), { type: 'err', sub: `${what}${r && (r.resultName || r.error) ? ` — ${tOpt(`dr.err.${r.error}`, r.resultName || r.error)}` : ''}`, timeout: 6000 });
  return r && r.ok;
}

function setLayout(patch) { Object.assign(settings, patch); window.api.setSettings(patch); applyLayout(); }
function applyLayout() {
  const logOn = settings.droneLogOpen !== false;
  const sideOn = settings.droneSideOpen !== false;
  $('#log').classList.toggle('hidden', !logOn); $('#splitLog').classList.toggle('hidden', !logOn);
  $('#side').classList.toggle('hidden', !sideOn); $('#splitSide').classList.toggle('hidden', !sideOn);
  $('#btnLog').classList.toggle('active', logOn); $('#btnSide').classList.toggle('active', sideOn);
  $('#log').style.height = `${settings.droneLogHeight || 240}px`;
  $('#side').style.width = `${settings.droneSideWidth || 300}px`;
}
const clampPx = (v, a, b) => Math.max(a, Math.min(b, v));
dragSplit($('#splitLog'), 'y', () => settings.droneLogHeight || 240, (v) => { settings.droneLogHeight = clampPx(v, 110, innerHeight - 260); applyLayout(); }, () => window.api.setSettings({ droneLogHeight: settings.droneLogHeight }));
dragSplit($('#splitSide'), 'x', () => settings.droneSideWidth || 300, (v) => { settings.droneSideWidth = clampPx(v, 220, 520); applyLayout(); }, () => window.api.setSettings({ droneSideWidth: settings.droneSideWidth }));

function paintTop() {
  document.documentElement.style.setProperty('--c', DRONE.FW_COLOR[drone.firmware] || '#22d3ee');
  $('#fwIcon').innerHTML = icon(drone.firmware === 'betaflight' ? 'bolt' : 'upload');
  $('#name').textContent = drone.name;
  $('#link').textContent = `${t(`dr.o.firmware.${drone.firmware}`)} · ${st.link || DRONE.display(drone)}`;
  document.title = `${drone.name} — Video Master`;
  const chip = $('#state');
  const cls = st.linked ? 'playing' : st.connected ? 'connecting' : st.error ? 'error' : 'idle';
  chip.className = `state-chip s-${cls}`;
  chip.innerHTML = `${st.connected && !st.linked ? '<span class="spin"></span>' : '<i></i>'}${esc(st.linked ? t('dr.st.linked') : st.connected ? t('dr.st.waiting') : st.error ? tOpt(`dr.err.${st.error}`, t('dr.st.error')) : t('dr.st.off'))}`;
  $('#btnConnect').innerHTML = `${icon(st.connected ? 'x' : 'link')}${esc(st.connected ? t('cam.disconnect') : t('cam.connect'))}`;
  $('#btnConnect').classList.toggle('primary', !st.connected);
  const b = $('#btnArm');
  // Betaflight kumandadan kurulur (arm); uçuş kipi de kumanda anahtarlarıyla seçilir
  b.classList.toggle('hidden', isBf());
  $('#mode').classList.toggle('hidden', isBf());
  b.disabled = !st.linked;
  b.className = `btn ${st.armed ? 'danger' : ''} ${isBf() ? 'hidden' : ''}`;
  b.innerHTML = `${icon(st.armed ? 'lock' : 'bolt')}${esc(st.armed ? t('dr.disarm') : t('dr.arm'))}`;
  const sel = $('#mode');
  const modes = st.modes || [];
  const sig = modes.map((m) => m.name).join('|');
  if (sel.dataset.sig !== sig) { sel.dataset.sig = sig; sel.innerHTML = modes.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join(''); }
  if (document.activeElement !== sel && st.mode) { if (![...sel.options].some((o) => o.value === st.mode)) sel.add(new Option(st.mode, st.mode)); sel.value = st.mode; }
  sel.disabled = !st.linked;
  const x = tm();
  $('#chips').innerHTML = st.linked ? [
    st.armed ? `<span class="tag err">${esc(t('dr.armed'))}</span>` : `<span class="tag">${esc(t('dr.disarmed'))}</span>`,
    isBf() && st.mode ? `<span class="tag">${esc(st.mode)}</span>` : '',
    st.cliMode ? `<span class="tag warn">${esc(t('dr.cliMode'))}</span>` : '',
    x.gpsFixName ? `<span class="tag ${x.gpsFix >= 3 ? 'ok' : 'warn'}">GPS ${esc(x.gpsFixName)}${x.sats !== null && x.sats !== undefined ? ` · ${x.sats}` : ''}</span>` : '',
    x.voltage ? `<span class="tag">${fmtNum(x.voltage, 2)} V${x.batteryPct !== null && x.batteryPct !== undefined && x.batteryPct >= 0 ? ` · ${x.batteryPct}%` : ''}</span>` : '',
  ].join('') : '';
}

// --- Modül gezinmesi -----------------------------------------------------------------------------
function paintNav() {
  $('#nav').innerHTML = MODULES.map(([id, ic]) => `<button type="button" data-m="${id}" class="${moduleId === id ? 'on' : ''}">${icon(ic)}<span>${esc(t(`dr.m.${id}`))}</span></button>`).join('');
}
$('#nav').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; moduleId = b.dataset.m; window.api.setSettings({ droneModule: moduleId }); paintNav(); showModule(); };

const modules = {};
modules.tuning = tuningModule;
function showModule() {
  const host = $('#module');
  host.innerHTML = '';
  host.className = `dr-module m-${moduleId}`;
  modules[moduleId].mount(host);
}
const needLink = () => (st.linked ? true : (toast(t('dr.needLink'), { type: 'err' }), false));

// --- Genel bakış ---------------------------------------------------------------------------------
modules.overview = {
  mount(host) {
    host.appendChild(h(`<div class="dr-over">
      <div class="dr-cards" data-cards></div>
      <div class="dr-two">
        <div class="dr-box"><h3>${icon('check')}${esc(t('dr.sensors'))}</h3><div class="dr-sensors" data-sensors></div><div class="dr-armflags" data-armflags></div></div>
        <div class="dr-box"><h3>${icon('text')}${esc(t('dr.messages'))}</h3><div class="dr-msgs" data-msgs></div></div>
      </div>
      <div class="cam-btns dr-actions"><button class="btn sm" data-a="reboot">${icon('refresh')}<span>${esc(t('dr.reboot'))}</span></button></div>
    </div>`));
    host.querySelector('[data-a="reboot"]').onclick = async () => { if (needLink() && await confirmBox(t('dr.reboot'), esc(t('dr.rebootConfirm')), { okText: t('dr.reboot') })) report(await call('reboot'), t('dr.reboot')); };
    this.host = host;
    this.update();
    this.messages();
  },
  update() {
    const host = this.host;
    if (!host || !host.isConnected || moduleId !== 'overview') return;
    const x = tm();
    const card = (label, value, sub = '') => `<div class="dr-card"><span>${esc(label)}</span><b>${value}</b><small>${sub}</small></div>`;
    host.querySelector('[data-cards]').innerHTML = [
      card(t('dr.c.vehicle'), esc(st.linked ? `${t(`dr.v.${st.vehicle || 'other'}`)}` : '—'), esc([st.firmware && st.firmware !== 'unknown' ? st.firmware.toUpperCase() : '', st.version || ''].filter(Boolean).join(' · '))),
      card(t('dr.c.mode'), esc(st.mode || '—'), esc(st.armed ? t('dr.armed') : t('dr.disarmed'))),
      card(t('dr.c.frame'), esc(st.frame ? st.frame.name : '—'), st.frame ? esc(t('dr.motorCount', { n: st.frame.motors.length })) : ''),
      card(t('tm.altRel'), `${fmtNum(x.altRel)} m`, `${esc(t('dr.c.msl'))} ${fmtNum(x.altMsl)} m`),
      card(t('tm.groundspeed'), `${fmtNum(x.groundspeed)} m/s`, `${esc(t('tm.climb'))} ${fmtNum(x.climb)} m/s`),
      card(t('dr.c.attitude'), `${fmtNum(x.roll, 0)}° / ${fmtNum(x.pitch, 0)}°`, `${esc(t('tm.heading'))} ${fmtNum(x.heading, 0)}°`),
      card('GPS', esc(x.gpsFixName || '—'), `${x.sats ?? '—'} ${esc(t('dr.c.sats'))}${x.hdop ? ` · HDOP ${fmtNum(x.hdop, 2)}` : ''}`),
      card(t('dr.c.position'), x.lat ? `${fmtNum(x.lat, 6)}` : '—', x.lon ? `${fmtNum(x.lon, 6)}` : ''),
      card(t('dr.c.battery'), `${fmtNum(x.voltage, 2)} V`, `${fmtNum(x.current)} A${x.batteryPct >= 0 && x.batteryPct !== null && x.batteryPct !== undefined ? ` · ${x.batteryPct}%` : ''}`),
      card(t('dr.c.link'), esc(st.stats ? `${st.stats.msgRate || 0} ${t('dr.c.msgRate')}` : '—'), st.stats ? `${esc(t('dr.c.lost'))} ${st.stats.lost || 0}${x.rssi ? ` · RSSI ${x.rssi}` : ''}` : ''),
    ].join('');
    const list = (st.sensors && st.sensors.list) || [];
    this.flags();
    host.querySelector('[data-sensors]').innerHTML = list.filter((s) => s.present).map((s) => `<span class="cam-test ${!s.enabled ? '' : s.healthy ? 'ok' : 'bad'}">${icon(!s.enabled ? 'pause' : s.healthy ? 'check' : 'x')}${esc(String(s.name).replace(/^SENSOR_/, '').replace(/_/g, ' '))}</span>`).join('') || `<div class="empty-note">${esc(t('dr.noData'))}</div>`;
  },
  flags() {
    const box = this.host && this.host.isConnected && this.host.querySelector('[data-armflags]');
    if (!box) return;
    const list = st.armingDisabled || [];
    box.innerHTML = list.length ? `<small>${esc(t('dr.armBlocked'))}</small><div class="dr-sensors">${list.map((f) => `<span class="cam-test bad">${icon('x')}${esc(String(f).replace(/_/g, ' '))}</span>`).join('')}</div>` : '';
  },
  messages() {
    const box = this.host && this.host.isConnected && this.host.querySelector('[data-msgs]');
    if (!box) return;
    box.innerHTML = statusTexts.length ? statusTexts.slice(-80).map((m) => `<div class="${sevClass(m.severity)}"><time>${new Date(m.t).toLocaleTimeString([], { hour12: false })}</time><span>${esc(m.text)}</span></div>`).join('') : `<div class="empty-note">${esc(t('dr.noMessages'))}</div>`;
    box.scrollTop = box.scrollHeight;
  },
};

// --- Parametreler: ağaç, arama, açıklamalar (Türkçe/özgün), yazma, dosyaya kaydetme/yükleme ----------
const P = { list: [], byName: new Map(), edits: new Map(), open: new Set(), query: '', onlyChanged: false, loading: false, progress: null };
modules.params = {
  mount(host) {
    host.appendChild(h(`<div class="dr-params">
      <div class="dr-bar">
        <div class="search"><span class="search-ico">${icon('search')}</span><input data-q spellcheck="false" placeholder="${esc(t('dr.p.searchPh'))}"></div>
        <button class="btn sm" data-a="fetch">${icon('refresh')}${esc(t('dr.p.fetch'))}</button>
        <button class="btn sm primary" data-a="write" disabled></button>
        <button class="btn sm" data-a="save">${icon('download')}${esc(t('dr.p.save'))}</button>
        <button class="btn sm" data-a="load">${icon('open')}${esc(t('dr.p.load'))}</button>
        <button class="btn sm ${isBf() ? '' : 'hidden'}" data-a="commit">${icon('check')}${esc(t('dr.p.commit'))}</button>
        <button class="btn sm ${isBf() ? '' : 'hidden'}" data-a="exitcli">${icon('x')}${esc(t('dr.p.exitCli'))}</button>
        <label class="check sm"><input type="checkbox" data-changed><span>${esc(t('dr.p.onlyChanged'))}</span></label>
        <span style="flex:1"></span><span class="dr-p-info" data-info></span>
      </div>
      <div class="vis-bar hidden" data-bar><i></i></div>
      ${isBf() ? `<div class="dr-note slim">${icon('info')}<div><p>${esc(t('dr.p.bfNote'))}</p></div></div>` : ''}
      <div class="dr-tree" data-tree></div>
    </div>`));
    this.host = host;
    const q = host.querySelector('[data-q]');
    q.value = P.query;
    q.addEventListener('input', () => { P.query = q.value.trim().toLowerCase(); this.paint(); });
    host.querySelector('[data-changed]').checked = P.onlyChanged;
    host.querySelector('[data-changed]').onchange = (e) => { P.onlyChanged = e.target.checked; this.paint(); };
    host.querySelector('[data-a="fetch"]').onclick = () => this.fetch();
    host.querySelector('[data-a="write"]').onclick = () => this.writeAll();
    host.querySelector('[data-a="save"]').onclick = () => this.exportFile();
    host.querySelector('[data-a="load"]').onclick = () => this.importFile();
    host.querySelector('[data-a="commit"]').onclick = async () => {
      if (!needLink() || !(await confirmBox(t('dr.p.commit'), esc(t('dr.p.commitConfirm')), { okText: t('dr.p.commit'), danger: false }))) return;
      if (P.edits.size) await this.writeAll(true);
      report(await call('saveParams'), t('dr.p.commit'));
    };
    host.querySelector('[data-a="exitcli"]').onclick = async () => { if (needLink() && await confirmBox(t('dr.p.exitCli'), esc(t('dr.p.exitConfirm')), { okText: t('dr.p.exitCli'), danger: false })) report(await call('exitCli'), t('dr.p.exitCli')); };
    const tree = host.querySelector('[data-tree]');
    tree.addEventListener('toggle', (e) => {
      const d = e.target.closest('details[data-g]');
      if (!d) return;
      if (d.open) { P.open.add(d.dataset.g); if (!d.dataset.filled) this.fill(d); } else P.open.delete(d.dataset.g);
    }, true);
    tree.addEventListener('change', (e) => this.edited(e));
    tree.addEventListener('click', (e) => this.clicked(e));
    this.paint();
    if (!P.list.length && st.linked && !P.loading) this.reload(false);
  },

  async reload(fetchIfEmpty) {
    P.list = await window.api.droneParams(ID);
    P.byName = new Map(P.list.map((p) => [p.name, p]));
    if (!P.list.length && fetchIfEmpty) return this.fetch();
    this.paint();
    modules.tuning.reloaded();
  },

  async fetch() {
    if (!needLink() || P.loading) return;
    P.loading = true; P.progress = { received: 0, total: 0 };
    this.paint();
    modules.tuning.stateChanged();
    const r = await call('fetchParams');
    P.loading = false; P.progress = null;
    if (!r || !r.ok) toast(t('dr.p.fetchFailed'), { type: 'err', sub: r && r.total ? `${r.received} / ${r.total}` : '' });
    await this.reload(false);
  },

  groups() {
    const q = P.query;
    const match = (p) => {
      if (P.onlyChanged && !P.edits.has(p.name)) return false;
      if (!q) return true;
      const m = p.meta || {};
      return p.name.toLowerCase().includes(q) || String(m.displayName || '').toLowerCase().includes(q) || String(m.description || '').toLowerCase().includes(q) || String(p.original || '').toLowerCase().includes(q);
    };
    const by = new Map();
    for (const p of P.list) { if (!match(p)) continue; const g = p.group || t('dr.p.general'); if (!by.has(g)) by.set(g, []); by.get(g).push(p); }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  },

  paint() {
    const host = this.host;
    if (!host || !host.isConnected || moduleId !== 'params') return;
    const bar = host.querySelector('[data-bar]');
    bar.classList.toggle('hidden', !P.loading);
    if (P.progress) bar.firstElementChild.style.width = `${P.progress.total ? Math.min(100, (P.progress.received / P.progress.total) * 100) : 4}%`;
    const groups = this.groups();
    const shown = groups.reduce((n, [, l]) => n + l.length, 0);
    host.querySelector('[data-info]').textContent = P.loading ? t('dr.p.loading', { n: P.progress ? P.progress.received : 0, total: P.progress ? P.progress.total || '?' : '?' }) : P.list.length ? t('dr.p.count', { shown, total: P.list.length }) : '';
    const w = host.querySelector('[data-a="write"]');
    w.disabled = !P.edits.size;
    w.innerHTML = `${icon('upload')}${esc(t('dr.p.write', { n: P.edits.size }))}`;
    const tree = host.querySelector('[data-tree]');
    if (!P.list.length) { tree.innerHTML = `<div class="empty-note">${esc(P.loading ? t('dr.p.loading', { n: P.progress ? P.progress.received : 0, total: P.progress && P.progress.total ? P.progress.total : '?' }) : st.linked ? t('dr.p.empty') : t('dr.needLink'))}</div>`; return; }
    if (!groups.length) { tree.innerHTML = `<div class="empty-note">${esc(t('dr.p.noMatch'))}</div>`; return; }
    // Aramada ya da az sonuçta gruplar açık gelir; yoksa yalnızca kullanıcının açtıkları doldurulur
    const expand = !!P.query || P.onlyChanged || shown <= 60;
    const top = tree.scrollTop;
    tree.innerHTML = groups.map(([g, l]) => `<details class="cf-sec dr-group" data-g="${esc(g)}" ${expand || P.open.has(g) ? 'open' : ''}><summary>${icon('folder')}<span>${esc(g)}</span><i>${l.length}</i>${icon('chevronDown', 'chev')}</summary><div class="dr-rows"></div></details>`).join('');
    this.current = new Map(groups);
    for (const d of tree.querySelectorAll('details[open]')) this.fill(d);
    tree.scrollTop = top;
  },

  fill(d) {
    const list = (this.current && this.current.get(d.dataset.g)) || [];
    d.dataset.filled = '1';
    d.querySelector('.dr-rows').innerHTML = list.slice(0, 400).map((p) => this.row(p)).join('');
    enhanceNumbers(d);
  },

  row(p) {
    const m = p.meta || {};
    const edited = P.edits.has(p.name);
    const value = edited ? P.edits.get(p.name) : p.value;
    const shownVal = p.text ? String(value) : Number.isInteger(value) ? String(value) : String(Number(Number(value).toFixed(6)));
    const same = (a, b) => (p.text ? String(a) === String(b) : Number(a) === Number(b));
    let editor;
    if (m.values && m.values.length) {
      const has = m.values.some((v) => same(v.value, value));
      editor = `<select class="input" data-p="${esc(p.name)}">${has ? '' : `<option value="${esc(shownVal)}" selected>${esc(shownVal)}</option>`}${m.values.map((v) => `<option value="${esc(v.value)}" ${same(v.value, value) ? 'selected' : ''}>${esc(String(v.value) === String(v.label) ? v.label : `${v.value} — ${v.label}`)}</option>`).join('')}</select>`;
    } else if (p.text) {
      editor = `<input class="input mono" data-p="${esc(p.name)}" value="${esc(shownVal)}" spellcheck="false">`;
    } else {
      const ranged = m.range && Number.isFinite(m.range[0]) && Number.isFinite(m.range[1]) && m.range[1] > m.range[0] && Number(value) >= m.range[0] && Number(value) <= m.range[1];
      const input = `<input class="input mono" type="number" data-p="${esc(p.name)}" value="${esc(shownVal)}" step="${m.increment || 'any'}" ${ranged ? `min="${m.range[0]}" max="${m.range[1]}"` : ''}>`;
      editor = m.units ? `<span class="unit-wrap">${input}<span>${esc(m.units)}</span></span>` : input;
      if (m.bits && m.bits.length) editor += `<button class="btn sm" type="button" data-bits="${esc(p.name)}">${icon('checkSquare')}${esc(t('dr.p.bits'))}</button>`;
    }
    const facts = [m.range ? `${t('dr.p.range')}: ${m.range[0]} … ${m.range[1]}` : '', m.def ? `${t('dr.p.default')}: ${m.def}` : '', m.rebootRequired ? t('dr.p.reboot') : '', m.readOnly ? t('dr.p.readOnly') : ''].filter(Boolean).join(' · ');
    const bits = m.bits && m.bits.length ? m.bits.filter((b) => (Number(value) >>> 0) & (1 << b.bit)).map((b) => b.label).join(', ') : '';
    return `<div class="dr-param ${edited ? 'edited' : ''}" data-row="${esc(p.name)}">
      <div class="dr-p-name"><b class="mono">${esc(p.name)}</b>${m.displayName ? `<span>${esc(m.displayName)}</span>` : ''}</div>
      <div class="dr-p-edit">${editor}${edited ? `<button class="icon-btn" data-undo="${esc(p.name)}" title="${esc(t('dr.p.undo'))}">${icon('history')}</button><button class="btn sm primary" data-write="${esc(p.name)}">${esc(t('dr.p.writeOne'))}</button>` : ''}</div>
      <div class="dr-p-desc">${m.description ? esc(m.description) : p.text !== undefined ? '' : `<i>${esc(t('dr.p.noDesc'))}</i>`}${bits ? `<small>${esc(bits)}</small>` : ''}${facts ? `<small>${esc(facts)}</small>` : ''}${p.original ? `<details class="dr-orig"><summary>${esc(t('dr.p.original'))}</summary>${esc(p.original)}</details>` : ''}</div>
    </div>`;
  },

  refreshRow(name) {
    const row = this.host && this.host.querySelector(`[data-row="${CSS.escape(name)}"]`);
    const p = P.byName.get(name);
    if (row && p) { const n = h(this.row(p)); enhanceNumbers(n); row.replaceWith(n); }
    const w = this.host && this.host.querySelector('[data-a="write"]');
    if (w) { w.disabled = !P.edits.size; w.innerHTML = `${icon('upload')}${esc(t('dr.p.write', { n: P.edits.size }))}`; }
  },

  edited(e) {
    const name = e.target.dataset && e.target.dataset.p;
    if (!name) return;
    const p = P.byName.get(name);
    if (!p) return;
    const v = p.text ? e.target.value.trim() : Number(e.target.value);
    if (!p.text && !Number.isFinite(v)) return;
    if (String(v) === String(p.value)) P.edits.delete(name); else P.edits.set(name, v);
    this.refreshRow(name);
  },

  async clicked(e) {
    const undo = e.target.closest('[data-undo]');
    const write = e.target.closest('[data-write]');
    const bits = e.target.closest('[data-bits]');
    if (undo) { P.edits.delete(undo.dataset.undo); this.refreshRow(undo.dataset.undo); }
    else if (write) await this.writeOne(write.dataset.write, true);
    else if (bits) this.bitsDialog(bits.dataset.bits);
  },

  async writeOne(name, announce) {
    if (!P.edits.has(name) || !needLink()) return false;
    const r = await call('setParam', name, P.edits.get(name));
    const p = P.byName.get(name);
    if (r && r.ok) { if (p) p.value = r.value; P.edits.delete(name); if (announce) toast(t('dr.p.written'), { type: 'ok', sub: `${name} = ${r.value}`, timeout: 2000 }); }
    else if (announce) toast(t('dr.p.writeFailed'), { type: 'err', sub: name });
    this.refreshRow(name);
    return !!(r && r.ok);
  },

  async writeAll(silent) {
    const names = [...P.edits.keys()];
    if (!names.length || !needLink()) return;
    if (!silent && !(await confirmBox(t('dr.p.write', { n: names.length }), `<div class="dr-confirm">${names.slice(0, 40).map((n) => `<div><b class="mono">${esc(n)}</b> ${esc(String(P.byName.get(n) ? P.byName.get(n).value : ''))} → <b>${esc(String(P.edits.get(n)))}</b></div>`).join('')}${names.length > 40 ? '<div>…</div>' : ''}</div>`, { okText: t('dr.p.writeOne'), danger: false }))) return;
    let ok = 0;
    for (const n of names) if (await this.writeOne(n, false)) ok++;
    toast(ok === names.length ? t('dr.p.written') : t('dr.p.writeFailed'), { type: ok === names.length ? 'ok' : 'err', sub: `${ok} / ${names.length}` });
    this.paint();
  },

  bitsDialog(name) {
    const p = P.byName.get(name);
    if (!p || !p.meta) return;
    const value = (P.edits.has(name) ? P.edits.get(name) : p.value) >>> 0;
    const body = h(`<div class="dr-bits">${p.meta.bits.map((b) => `<label class="check"><input type="checkbox" data-bit="${b.bit}" ${value & (1 << b.bit) ? 'checked' : ''}><span><span class="lbl">${esc(b.label)}</span><small class="hnt">bit ${b.bit} · ${2 ** b.bit}</small></span></label>`).join('')}</div>`);
    openModal({
      title: name, iconName: 'checkSquare', width: 520, body,
      buttons: [{ label: t('common.cancel'), value: null }, { label: t('common.ok'), cls: 'primary', onClick: () => {
        let v = value;
        for (const i of body.querySelectorAll('[data-bit]')) { const m = 2 ** Number(i.dataset.bit); v = i.checked ? (v | m) >>> 0 : (v & ~m) >>> 0; }
        if (v === p.value) P.edits.delete(name); else P.edits.set(name, v);
        this.refreshRow(name);
        return true;
      } }],
    });
  },

  async exportFile() {
    if (!P.list.length) return toast(t('dr.p.empty'), { type: 'err' });
    const line = (p) => (isBf() ? `set ${p.name} = ${p.value}` : `${p.name},${Number.isInteger(p.value) ? p.value : Number(Number(p.value).toFixed(6))}`);
    const f = await window.api.droneParamsExport(ID, P.list.map(line).join('\n') + '\n');
    if (f) toast(t('dr.p.saved'), { type: 'ok', sub: f, timeout: 5000 });
  },

  // Dosyadaki değerler düzenleme olarak yüklenir; yazmadan önce farklar gözden geçirilir
  async importFile() {
    if (!P.list.length) return toast(t('dr.p.empty'), { type: 'err' });
    const r = await window.api.droneParamsImport();
    if (!r) return;
    let n = 0; let unknown = 0;
    for (const line of r.text.split(/\r?\n/)) {
      // Mission Planner biçimi (AD,DEĞER) ya da Betaflight CLI biçimi (set ad = değer)
      const m = isBf() ? /^\s*set\s+([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line) : /^\s*([A-Za-z0-9_]+)\s*[,\s=]\s*(-?[0-9.eE+-]+)/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      const p = P.byName.get(m[1].toUpperCase()) || P.byName.get(m[1]) || P.byName.get(m[1].toLowerCase());
      if (!p) { unknown++; continue; }
      if (p.text) { if (String(m[2]) !== String(p.value)) { P.edits.set(p.name, m[2]); n++; } continue; }
      const v = Number(m[2]);
      if (Number.isFinite(v) && Math.abs(v - p.value) > 1e-6 * Math.max(1, Math.abs(p.value))) { P.edits.set(p.name, v); n++; }
    }
    P.onlyChanged = n > 0;
    if (this.host) this.host.querySelector('[data-changed]').checked = P.onlyChanged;
    this.paint();
    toast(t('dr.p.loaded', { n }), { type: 'ok', sub: unknown ? t('dr.p.unknown', { n: unknown }) : r.file, timeout: 6000 });
  },
};

// --- Motor testi ---------------------------------------------------------------------------------
const M = { throttle: 8, seconds: 2, safe: false, manualCount: 4, active: null };
modules.motors = {
  mount(host) {
    host.appendChild(h(`<div class="dr-motors">
      <div class="dr-frame" data-frame></div>
      <div class="dr-motor-side">
        <div class="dr-warn">${icon('info')}<div><b>${esc(t('dr.mt.warnTitle'))}</b><p>${esc(tOpt(`dr.mt.warn.${drone.firmware}`, t('dr.mt.warn')))}</p></div></div>
        <label class="check"><input type="checkbox" data-safe ${M.safe ? 'checked' : ''}><span><span class="lbl">${esc(t('dr.mt.safe'))}</span></span></label>
        <label class="cam-in"><span>${esc(t('dr.mt.throttle'))}</span><span class="unit-wrap"><input class="input" type="number" data-thr min="1" max="100" value="${M.throttle}"><span>%</span></span></label>
        <label class="cam-in"><span>${esc(t('dr.mt.seconds'))}</span><span class="unit-wrap"><input class="input" type="number" data-sec min="1" max="30" value="${M.seconds}"><span>s</span></span></label>
        <label class="cam-in hidden" data-manual><span>${esc(t('dr.mt.count'))}</span><input class="input" type="number" data-count min="1" max="12" value="${M.manualCount}"></label>
        <div class="cam-btns"><button class="btn sm" data-a="all">${icon('play')}<span>${esc(t('dr.mt.all'))}</span></button><button class="btn sm danger" data-a="stop">${icon('stop')}<span>${esc(t('dr.mt.stop'))}</span></button></div>
        <small class="hint" data-frameinfo></small>
      </div></div>`));
    enhanceNumbers(host);
    this.host = host;
    host.querySelector('[data-safe]').onchange = (e) => { M.safe = e.target.checked; this.paint(); };
    host.querySelector('[data-thr]').addEventListener('input', (e) => { M.throttle = clampPx(Math.round(Number(e.target.value) || 8), 1, 100); });
    host.querySelector('[data-sec]').addEventListener('input', (e) => { M.seconds = clampPx(Math.round(Number(e.target.value) || 2), 1, 30); });
    host.querySelector('[data-count]').addEventListener('input', (e) => { M.manualCount = clampPx(Math.round(Number(e.target.value) || 4), 1, 12); this.paint(); });
    host.querySelector('[data-a="stop"]').onclick = async () => { M.active = null; this.paint(); report(await call('motorStop'), t('dr.mt.stop')); };
    host.querySelector('[data-a="all"]').onclick = () => this.sequence();
    host.querySelector('[data-frame]').addEventListener('click', (e) => { const b = e.target.closest('[data-motor]'); if (b) this.test(Number(b.dataset.motor)); });
    this.paint();
    if (!isBf() && st.linked && !st.frame && st.params && !st.params.received && !st.params.loading) call('fetchParams'); // çerçeve yapısı parametrelerden okunur
  },

  motors() {
    if (st.frame && st.frame.motors && st.frame.motors.length) return { known: true, list: st.frame.motors };
    // Yapı okunamadıysa: seçilen sayıda motor, çember üzerinde
    const n = M.manualCount;
    return { known: false, list: Array.from({ length: n }, (_, i) => ({ n: i + 1, testOrder: i + 1, x: Math.sin((i / n) * 2 * Math.PI + Math.PI / n), y: Math.cos((i / n) * 2 * Math.PI + Math.PI / n), dir: null })) };
  },

  paint() {
    const host = this.host;
    if (!host || !host.isConnected || moduleId !== 'motors') return;
    const { known, list } = this.motors();
    const sig = `${known}|${list.map((m) => `${m.n},${m.x},${m.y},${m.dir}`).join(';')}|${M.active}|${M.safe}|${st.linked}`;
    if (this.sig === sig) return;
    this.sig = sig;
    host.querySelector('[data-manual]').classList.toggle('hidden', known);
    host.querySelector('[data-frameinfo]').textContent = known ? `${st.frame.name} · ${t('dr.motorCount', { n: list.length })}` : t('dr.mt.unknownFrame');
    const S = 420; const C = S / 2; const R = 150;
    const px = (m) => [C + m.x * R, C - m.y * R];
    const letter = (o) => String.fromCharCode(64 + o);
    const arc = (cx, cy, dir) => {
      const r = 36; const a0 = dir === 'cw' ? -140 : -40; const a1 = dir === 'cw' ? -40 : -140;
      const pt = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
      const [x0, y0] = pt(a0); const [x1, y1] = pt(a1);
      return `<path d="M${x0} ${y0} A${r} ${r} 0 0 ${dir === 'cw' ? 1 : 0} ${x1} ${y1}" class="rot ${dir}" marker-end="url(#arr-${dir})"/>`;
    };
    host.querySelector('[data-frame]').innerHTML = `<svg viewBox="0 0 ${S} ${S}" class="${M.safe && st.linked ? '' : 'locked'}">
      <defs><marker id="arr-cw" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 5 L0 10 z" class="ah cw"/></marker>
      <marker id="arr-ccw" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 5 L0 10 z" class="ah ccw"/></marker></defs>
      ${list.map((m) => { const [x, y] = px(m); return `<line x1="${C}" y1="${C}" x2="${x}" y2="${y}" class="arm"/>`; }).join('')}
      <rect x="${C - 30}" y="${C - 38}" width="60" height="76" rx="16" class="body"/><path d="M${C} ${C - 62} l-12 20 h24 z" class="nose"/><text x="${C}" y="${C - 70}" class="fwd">${esc(t('dr.mt.front'))}</text>
      ${list.map((m) => { const [x, y] = px(m); return `<g class="motor ${M.active === m.testOrder ? 'on' : ''}" data-motor="${m.testOrder}"><circle cx="${x}" cy="${y}" r="30"/>${m.dir ? arc(x, y, m.dir) : ''}<text x="${x}" y="${y + 2}" class="ml">${letter(m.testOrder)}</text><text x="${x}" y="${y + 19}" class="mn">${m.n}</text></g>`; }).join('')}
    </svg><div class="dr-legend"><span><i class="cw"></i>${esc(t('dr.mt.cw'))}</span><span><i class="ccw"></i>${esc(t('dr.mt.ccw'))}</span><span>${esc(t('dr.mt.legend'))}</span></div>`;
  },

  // ArduPilot test sırasıyla, Betaflight motor numarasıyla çağrılır
  motorArg(order) { if (!isBf()) return order; const m = this.motors().list.find((x) => x.testOrder === order); return m ? m.n : order; },

  ready() {
    if (!needLink()) return false;
    if (!M.safe) { toast(t('dr.mt.needSafe'), { type: 'err' }); return false; }
    return true;
  },

  async test(order) {
    if (!this.ready()) return;
    M.active = order; this.paint();
    const r = await call('motorTest', { motor: this.motorArg(order), throttlePct: M.throttle, seconds: M.seconds });
    if (!(r && r.ok)) report(r, t('dr.m.motors'));
    setTimeout(() => { if (M.active === order) { M.active = null; this.paint(); } }, M.seconds * 1000);
  },

  async sequence() {
    if (!this.ready()) return;
    for (const m of this.motors().list.slice().sort((a, b) => a.testOrder - b.testOrder)) {
      if (moduleId !== 'motors' || !M.safe) break;
      M.active = m.testOrder; this.paint();
      const r = await call('motorTest', { motor: this.motorArg(m.testOrder), throttlePct: M.throttle, seconds: M.seconds });
      if (!(r && r.ok)) { report(r, t('dr.m.motors')); break; }
      await new Promise((res) => setTimeout(res, M.seconds * 1000 + 600));
      if (M.active !== m.testOrder) break; // durduruldu
    }
    M.active = null; this.paint();
  },
};

// --- Kalibrasyonlar ------------------------------------------------------------------------------
const CAL = { text: {}, state: {}, accelPos: null, compass: [], rc: null };
const ACCEL_POS = { 1: 'level', 2: 'left', 3: 'right', 4: 'nosedown', 5: 'noseup', 6: 'back' };
const ALL_CAL_KINDS = [['accel', 'layers'], ['level', 'rows'], ['gyro', 'refresh'], ['compass', 'globe'], ['baro', 'gauge'], ['radio', 'signal'], ['esc', 'bolt']];
let CAL_KINDS = ALL_CAL_KINDS;
modules.calib = {
  mount(host) {
    host.appendChild(h(`<div class="dr-calib">${CAL_KINDS.map(([k, ic]) => `<div class="dr-box dr-cal" data-cal="${k}"><h3>${icon(ic)}${esc(tOpt(`dr.cal.${k}.${drone.firmware}`, t(`dr.cal.${k}`)))}</h3><p>${esc(tOpt(`dr.cal.${k}.${drone.firmware}.d`, t(`dr.cal.${k}.d`)))}</p><div class="dr-cal-body" data-body></div><div class="dr-cal-state" data-state></div><div class="cam-btns" data-btns></div></div>`).join('')}</div>`));
    this.host = host;
    host.addEventListener('click', (e) => { const b = e.target.closest('[data-do]'); if (b) this.act(b.dataset.do); });
    this.paint();
  },

  async act(what) {
    if (what !== 'radioStop' && what !== 'radioStart' && !needLink()) return;
    const start = async (kind, label, confirmKey) => {
      if (confirmKey && !(await confirmBox(label, esc(t(confirmKey)), { okText: t('dr.cal.start'), danger: false }))) return;
      CAL.state[kind] = 'started'; CAL.text[kind] = t('dr.cal.running'); this.paint();
      const r = await call('calibrate', kind);
      if (!r || !r.ok) { CAL.state[kind] = 'failed'; CAL.text[kind] = (r && (r.resultName || r.error)) || t('dr.failed'); }
      else if ((['gyro', 'level', 'baro'].includes(kind) || isBf()) && CAL.state[kind] === 'started') { CAL.state[kind] = 'done'; CAL.text[kind] = t('dr.cal.done'); }
      this.paint();
    };
    if (['gyro', 'level', 'baro'].includes(what)) return start(what, t(`dr.cal.${what}`));
    if (what === 'accel') { CAL.accelPos = null; return start('accel', t('dr.cal.accel')); }
    if (what === 'accelNext') { const pos = CAL.accelPos; CAL.accelPos = null; this.paint(); return call('calibrate', 'accelNext', pos); }
    if (what === 'compass') { CAL.compass = []; return start('compass', t('dr.cal.compass')); }
    if (what === 'compassAccept') return report(await call('calibrate', 'compassAccept'), t('dr.cal.accept'));
    if (what === 'compassCancel') { const r = await call('calibrate', 'compassCancel'); CAL.state.compass = 'cancelled'; CAL.text.compass = t('dr.cal.cancelled'); this.paint(); return r; }
    if (what === 'esc') return start('esc', t('dr.cal.esc'), 'dr.cal.esc.confirm');
    if (what === 'radioStart') { CAL.rc = { min: Array(16).fill(Infinity), max: Array(16).fill(-Infinity) }; CAL.text.radio = t('dr.cal.radio.moving'); return this.paint(); }
    if (what === 'radioStop') { CAL.rc = null; CAL.text.radio = ''; return this.paint(); }
    if (what === 'radioSave') {
      const rc = tm().rc || [];
      const n = Math.min(rc.filter((v) => v > 0).length, 16);
      const mins = []; const maxs = []; const trims = [];
      for (let i = 0; i < n; i++) { mins.push(Number.isFinite(CAL.rc.min[i]) ? CAL.rc.min[i] : 1100); maxs.push(Number.isFinite(CAL.rc.max[i]) ? CAL.rc.max[i] : 1900); trims.push(i === 2 ? mins[i] : rc[i]); } // gaz kanalında orta nokta = en düşük
      const r = await call('saveRcLimits', mins, maxs, trims);
      CAL.rc = null; CAL.text.radio = r && r.ok ? t('dr.cal.done') : t('dr.failed');
      this.paint();
      return report(r, t('dr.cal.radio'));
    }
    return null;
  },

  event(c) {
    const kind = c.kind === 'accelNext' ? 'accel' : String(c.kind || '').startsWith('compass') ? 'compass' : c.kind;
    if (!kind) return;
    CAL.state[kind] = c.state;
    if (c.text) CAL.text[kind] = c.text;
    else if (c.state === 'done') CAL.text[kind] = t('dr.cal.done');
    else if (c.state === 'failed') CAL.text[kind] = t('dr.failed');
    if (kind === 'accel') CAL.accelPos = c.state === 'prompt' ? (c.position ?? null) : null;
    if (kind === 'compass' && c.compass) CAL.compass = c.compass;
    this.paint();
  },

  paint() {
    const host = this.host;
    if (!host || !host.isConnected || moduleId !== 'calib') return;
    const btn = (what, label, cls = '') => `<button class="btn sm ${cls}" data-do="${what}">${esc(label)}</button>`;
    for (const [k] of CAL_KINDS) {
      const box = host.querySelector(`[data-cal="${k}"]`);
      const state = CAL.state[k] || '';
      const stEl = box.querySelector('[data-state]');
      stEl.className = `dr-cal-state ${state}`;
      stEl.textContent = CAL.text[k] || '';
      let body = ''; let btns = btn(k, t('dr.cal.start'), 'primary');
      if (k === 'accel' && state === 'prompt') {
        const name = ACCEL_POS[CAL.accelPos] || (typeof CAL.accelPos === 'string' ? CAL.accelPos.toLowerCase() : '');
        body = `<div class="dr-pos"><b>${esc(tOpt(`dr.pos.${name}`, CAL.text.accel || ''))}</b><span>${esc(t('dr.cal.accel.hold'))}</span></div>`;
        btns = btn('accelNext', t('dr.cal.next'), 'primary');
      } else if (k === 'compass') {
        body = CAL.compass.map((c) => `<div class="dr-compass"><span>${esc(t('dr.cal.compassN', { n: (c.id ?? 0) + 1 }))}</span><div class="vis-bar"><i style="width:${Math.max(0, Math.min(100, c.percent || 0))}%"></i></div><small>${c.fitness !== undefined && c.fitness !== null ? `${esc(t('dr.cal.fitness'))} ${fmtNum(c.fitness, 1)}` : `${Math.round(c.percent || 0)}%`}${c.ofs ? ` · ${c.ofs.map((v) => Math.round(v)).join(', ')}` : ''}</small></div>`).join('');
        if (state === 'started' || state === 'progress') btns = btn('compassCancel', t('common.cancel'));
        else if (state === 'done' && CAL.compass.length && !isBf()) btns = btn('compassAccept', t('dr.cal.accept'), 'primary') + btn('compass', t('dr.cal.again'));
      } else if (k === 'radio') {
        const rc = (tm().rc || []).slice(0, 16);
        const live = rc.filter((v) => v > 0).length;
        if (CAL.rc) rc.forEach((v, i) => { if (v > 0) { CAL.rc.min[i] = Math.min(CAL.rc.min[i], v); CAL.rc.max[i] = Math.max(CAL.rc.max[i], v); } });
        body = live ? `<div class="dr-rc">${rc.slice(0, Math.max(live, 4)).map((v, i) => {
          const pct = (x) => Math.max(0, Math.min(100, ((x - 800) / 1400) * 100));
          const range = CAL.rc && Number.isFinite(CAL.rc.min[i]) ? `<em style="left:${pct(CAL.rc.min[i])}%;width:${Math.max(0, pct(CAL.rc.max[i]) - pct(CAL.rc.min[i]))}%"></em>` : '';
          return `<div><span>CH${i + 1}</span><div class="rc-bar">${range}<i style="left:${pct(v)}%"></i></div><b>${v || '—'}</b></div>`;
        }).join('')}</div>` : `<div class="empty-note">${esc(t('dr.cal.radio.none'))}</div>`;
        btns = CAL.rc ? btn('radioSave', t('dr.cal.radio.save'), 'primary') + btn('radioStop', t('common.cancel')) : btn('radioStart', t('dr.cal.start'), 'primary');
      }
      const bodyEl = box.querySelector('[data-body]');
      if (bodyEl.innerHTML !== body) bodyEl.innerHTML = body;
      const btnEl = box.querySelector('[data-btns]');
      if (btnEl.dataset.sig !== btns) { btnEl.dataset.sig = btns; btnEl.innerHTML = btns; }
    }
  },
};

// --- Betaflight komut satırı (CLI): kartın bütün ayarlarına doğrudan erişim -------------------------
const CLI = { text: '', history: [], at: 0 };
modules.cli = {
  mount(host) {
    host.appendChild(h(`<div class="dr-cli">
      <div class="dr-note slim">${icon('info')}<div><p>${esc(t('dr.cli.note'))}</p></div></div>
      <pre class="dr-cli-out" data-out></pre>
      <div class="dr-cli-in"><span class="mono">#</span><input class="input mono" data-in spellcheck="false" autocomplete="off" placeholder="${esc(t('dr.cli.ph'))}"><button class="btn sm primary" data-send>${esc(t('cam.send'))}</button></div>
      <div class="cam-btns dr-cli-quick">${['status', 'version', 'diff all', 'dump', 'get', 'resource', 'tasks', 'help'].map((c) => `<button class="btn sm" data-cmd="${c}">${c}</button>`).join('')}
        <button class="btn sm" data-cmd="save">${esc(t('dr.p.commit'))}</button><button class="btn sm" data-clear>${icon('broom')}${esc(t('cam.clear'))}</button></div>
    </div>`));
    this.host = host;
    const input = host.querySelector('[data-in]');
    const send = async (line) => {
      const cmd = String(line || '').trim();
      if (!cmd || !needLink()) return;
      if (cmd === 'save' && !(await confirmBox(t('dr.p.commit'), esc(t('dr.p.commitConfirm')), { okText: t('dr.p.commit'), danger: false }))) return;
      CLI.history.push(cmd); CLI.at = CLI.history.length;
      input.value = '';
      this.append(`# ${cmd}\n`);
      const r = cmd === 'save' ? await call('saveParams') : await call('cli', cmd);
      if (r && !r.ok) this.append(`! ${tOpt(`dr.err.${r.error}`, r.error || t('dr.failed'))}\n`);
    };
    host.querySelector('[data-send]').onclick = () => send(input.value);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send(input.value); }
      else if (e.key === 'ArrowUp' && CLI.at > 0) { e.preventDefault(); input.value = CLI.history[--CLI.at]; }
      else if (e.key === 'ArrowDown') { e.preventDefault(); CLI.at = Math.min(CLI.history.length, CLI.at + 1); input.value = CLI.history[CLI.at] || ''; }
    });
    host.querySelector('.dr-cli-quick').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.clear !== undefined) { CLI.text = ''; this.paint(); } else send(b.dataset.cmd);
    });
    this.paint();
    input.focus();
  },
  append(text) {
    CLI.text = (CLI.text + String(text).replace(/\r/g, '')).slice(-200000);
    this.paint();
  },
  paint() {
    const out = this.host && this.host.isConnected && moduleId === 'cli' && this.host.querySelector('[data-out]');
    if (!out) return;
    out.textContent = CLI.text;
    out.scrollTop = out.scrollHeight;
  },
};

// --- Durum ve olaylar ----------------------------------------------------------------------------
function applyState(next) {
  if (!next) return;
  const wasLinked = st.linked;
  st = { telemetry: {}, ...next };
  paintTop();
  if (charts && st.linked) charts.push(st.telemetry);
  if (moduleId === 'overview') modules.overview.update();
  else if (moduleId === 'motors') modules.motors.paint();
  else if (moduleId === 'calib' && (CAL.rc || true)) modules.calib.paint();
  else if (moduleId === 'tuning') modules.tuning.stateChanged();
  // Bağlanınca parametreler bir kez okunur (gövde yapısı ve motor düzeni de bunlardan çıkar)
  if (!isBf() && st.linked && !wasLinked && st.params && !st.params.received && !st.params.loading && !P.loading) {
    P.loading = true; P.progress = { received: 0, total: 0 };
    modules.tuning.stateChanged();
    call('fetchParams').then(() => { P.loading = false; P.progress = null; modules.params.reload(false); });
  }
}

window.api.onDroneState((m) => { if (m.id === ID) applyState(m.state); });
window.api.onDroneLog((m) => { if (m.id === ID && log) log.add(m.entries); });
window.api.onDroneStatustext((m) => {
  if (m.id !== ID) return;
  statusTexts.push({ severity: m.severity, text: m.text, t: m.t || Date.now() });
  if (statusTexts.length > 300) statusTexts.shift();
  if (m.severity <= 4) toast(m.text, { type: m.severity <= 3 ? 'err' : '', timeout: 5000 });
  modules.overview.messages();
});
window.api.onDroneParams((m) => {
  if (m.id !== ID) return;
  P.progress = { received: m.received, total: m.total };
  P.loading = !!m.loading && !m.done;
  if (m.done) modules.params.reload(false); else { modules.params.paint(); modules.tuning.progress(); }
});
window.api.onDroneParam((m) => {
  if (m.id !== ID) return;
  const p = P.byName.get(m.name);
  if (p && p.value !== m.value) { p.value = m.value; if (!P.edits.has(m.name) && moduleId === 'params') modules.params.refreshRow(m.name); modules.tuning.paramChanged(m.name); }
});
window.api.onDroneCalibration((m) => { if (m.id === ID) modules.calib.event(m); });
window.api.onDroneCli((m) => { if (m.id === ID) modules.cli.append(m.text || ''); });
window.api.onDroneChanged((d) => { if (d.id === ID) { drone = d; paintTop(); } });
window.api.onStoreChanged((d) => { const keep = {}; for (const k of ['droneLogOpen', 'droneSideOpen', 'droneLogHeight', 'droneSideWidth', 'droneModule']) keep[k] = settings[k]; settings = { ...d.settings, ...keep }; paintThemeBtn(); });

// --- Başlangıç -----------------------------------------------------------------------------------
(async () => {
  const [store, d] = await Promise.all([window.api.getStore(), window.api.getDrone(ID)]);
  if (!d) return window.close();
  settings = store.settings;
  drone = d;
  if (!isBf()) MODULES = withTuning(BASE_MODULES);
  if (isBf()) { MODULES = [...BASE_MODULES, ['cli', 'terminal']]; CAL_KINDS = ALL_CAL_KINDS.filter(([k]) => k === 'accel' || k === 'compass'); }
  if (MODULES.some(([m]) => m === settings.droneModule)) moduleId = settings.droneModule;
  charts = buildTelemetryCharts($('#charts'));
  log = buildCommLog({ rows: $('#logRows'), search: $('#logSearch'), dir: $('#logDir'), pause: $('#logPause'), clear: $('#logClear'), count: $('#logCount') });
  paintThemeBtn();
  applyLayout();
  paintNav();
  paintTop();
  showModule();
  log.add(await window.api.droneRecent(ID));
  const cur = await window.api.droneState(ID);
  if (cur && cur.connected) applyState(cur);
  else if (drone.autoConnect) applyState(await window.api.droneConnect(ID));
})();
