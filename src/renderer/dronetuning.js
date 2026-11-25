'use strict';

// Dron penceresi "Ayarlar" modülü: aracın temel uçuş ayarları, sade dille ve her biri kendi göstergesiyle.
// Tanımlar ve hesaplar src/drone/tuning.js içindedir (TUNING); burada yalnızca çizim ve etkileşim bulunur.
// drone.js'ten ÖNCE yüklenir; oradaki ortak durumu (P, st, drone, call, ID, moduleId) çalışırken kullanır.

const TN = { group: null, query: '', edits: new Map(), busy: false, groups: [], byId: new Map(), byParam: new Map(), sig: '' };

const tnLang = () => (LANG === 'tr' ? 'tr' : 'en');
const tx = (o, vars) => { let s = TUNING.text(o, tnLang()); if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)); return s; };
const tnNum = (v, digits = 2) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString(tnLang(), { maximumFractionDigits: digits, useGrouping: false }) : '—');
const tnFrac = (v, min, max) => (max > min ? Math.max(0, Math.min(1, (Number(v) - min) / (max - min))) : 0);
const tnGet = (name) => { const p = P.byName.get(name); return p ? p.value : undefined; };
const tnRaw = (v) => (Number.isInteger(v) ? String(v) : String(Number(Number(v).toFixed(4))));

// ---- Göstergeler (SVG): renkler CSS sınıflarından gelir, iki temada da okunur ----
const tnGauge = {
  // Yarım daire kadran: hızlar ve dönüş hızları
  dial(v, value) {
    const f = tnFrac(value, v.min, v.max);
    const len = Math.PI * 80;
    const a = Math.PI * (1 - f);
    const nx = 100 + 62 * Math.cos(a); const ny = 100 - 62 * Math.sin(a);
    let ticks = '';
    for (let i = 0; i <= 10; i++) { const b = Math.PI * (1 - i / 10); const r1 = i % 5 ? 90 : 88; ticks += `<line class="g-tick" x1="${(100 + r1 * Math.cos(b)).toFixed(1)}" y1="${(100 - r1 * Math.sin(b)).toFixed(1)}" x2="${(100 + 95 * Math.cos(b)).toFixed(1)}" y2="${(100 - 95 * Math.sin(b)).toFixed(1)}"/>`; }
    const arrow = v.dir === 'up' ? '<path class="g-dir" d="M100 58v-22M92 44l8-9 8 9"/>' : v.dir === 'down' ? '<path class="g-dir" d="M100 36v22M92 50l8 9 8-9"/>' : '';
    return `<svg viewBox="0 0 200 122" class="tn-g g-dial">${ticks}
      <path class="g-track" d="M20 100A80 80 0 0 1 180 100"/>
      <path class="g-fill" d="M20 100A80 80 0 0 1 180 100" stroke-dasharray="${(f * len).toFixed(1)} ${len.toFixed(1)}"/>
      ${arrow}<line class="g-needle" x1="100" y1="100" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"/><circle class="g-hub" cx="100" cy="100" r="6"/>
      <text class="g-lbl" x="20" y="118" text-anchor="middle">${esc(tnNum(v.min))}</text><text class="g-lbl" x="180" y="118" text-anchor="middle">${esc(tnNum(v.max))}</text></svg>`;
  },
  // Yatış açısı: ufuk çizgisine göre yatmış araç
  tilt(v, value) {
    const deg = Math.max(0, Math.min(90, Number(value) || 0));
    const a = (deg * Math.PI) / 180;
    const ex = 100 + 66 * Math.cos(a); const ey = 74 + 66 * Math.sin(a);
    return `<svg viewBox="0 0 200 122" class="tn-g g-tilt">
      <line class="g-horizon" x1="14" y1="74" x2="186" y2="74"/>
      <path class="g-wedge" d="M100 74L166 74A66 66 0 0 1 ${ex.toFixed(1)} ${ey.toFixed(1)}Z"/>
      <g transform="rotate(${deg} 100 74)"><line class="g-arm" x1="46" y1="74" x2="154" y2="74"/>
        <rect class="g-body" x="86" y="66" width="28" height="16" rx="5"/>
        <line class="g-prop" x1="30" y1="65" x2="62" y2="65"/><line class="g-prop" x1="138" y1="65" x2="170" y2="65"/>
        <line class="g-mast" x1="46" y1="74" x2="46" y2="65"/><line class="g-mast" x1="154" y1="74" x2="154" y2="65"/></g></svg>`;
  },
  // Yükseklik: yer çizgisi, dikey ölçek ve o yükseklikteki araç
  altitude(v, value) {
    const f = tnFrac(value, v.min, v.max);
    const gf = v.min < 0 ? tnFrac(0, v.min, v.max) : 0;
    const top = 16; const bottom = 100;
    const y = bottom - f * (bottom - top); const gy = bottom - gf * (bottom - top);
    let ticks = '';
    for (let i = 0; i <= 4; i++) { const ty = bottom - (i / 4) * (bottom - top); ticks += `<line class="g-tick" x1="44" y1="${ty}" x2="50" y2="${ty}"/>`; }
    let hatch = '';
    for (let x = 56; x < 190; x += 12) hatch += `<line class="g-hatch" x1="${x}" y1="${gy + 8}" x2="${x + 7}" y2="${gy + 1}"/>`;
    return `<svg viewBox="0 0 200 122" class="tn-g g-alt">
      <line class="g-axis" x1="50" y1="${top}" x2="50" y2="${bottom}"/>${ticks}
      <text class="g-lbl" x="40" y="${top + 4}" text-anchor="end">${esc(tnNum(v.max))}</text><text class="g-lbl" x="40" y="${bottom + 4}" text-anchor="end">${esc(tnNum(v.min))}</text>
      <line class="g-ground" x1="50" y1="${gy}" x2="192" y2="${gy}"/>${hatch}
      <rect class="g-col" x="${122 - 20}" y="${Math.min(y, gy).toFixed(1)}" width="40" height="${Math.abs(gy - y).toFixed(1)}"/>
      <line class="g-level" x1="50" y1="${y.toFixed(1)}" x2="192" y2="${y.toFixed(1)}"/>
      <g transform="translate(122 ${(y - 7).toFixed(1)})"><line class="g-arm" x1="-18" y1="0" x2="18" y2="0"/><rect class="g-body" x="-7" y="-4" width="14" height="9" rx="3"/>
        <line class="g-prop" x1="-26" y1="-5" x2="-10" y2="-5"/><line class="g-prop" x1="10" y1="-5" x2="26" y2="-5"/></g></svg>`;
  },
  // Süre: zaman çizgisi
  time(v, value) {
    const f = tnFrac(value, v.min, v.max);
    const x = 16 + f * 168;
    let ticks = '';
    for (let i = 0; i <= 8; i++) ticks += `<line class="g-tick" x1="${16 + i * 21}" y1="${i % 4 ? 70 : 66}" x2="${16 + i * 21}" y2="76"/>`;
    return `<svg viewBox="0 0 200 122" class="tn-g g-time">
      <rect class="g-track-r" x="16" y="48" width="168" height="12" rx="6"/><rect class="g-fill-r" x="16" y="48" width="${(f * 168).toFixed(1)}" height="12" rx="6"/>${ticks}
      <g transform="translate(${x.toFixed(1)} 54)"><circle class="g-clock" r="17"/><path class="g-hand" d="M0 -10V0L7 5"/></g>
      <text class="g-lbl" x="16" y="94" text-anchor="start">${esc(tnNum(v.min))} ${esc(v.unit)}</text><text class="g-lbl" x="184" y="94" text-anchor="end">${esc(tnNum(v.max))} ${esc(v.unit)}</text></svg>`;
  },
  // Batarya: doluluk; gerilimde hücre başına 3,0–4,2 V, mAh'te kapasiteye oran, yüzdede doğrudan
  battery(v, value) {
    let f; let label = '';
    const n = Number(value) || 0;
    if (v.unit === 'V') { const c = TUNING.cells(n, tnGet); const per = c ? n / c : 0; f = n > 0 ? tnFrac(per, 3.0, 4.2) : 0; label = n > 0 && c ? `${tnNum(per, 2)} V` : ''; }
    else if (v.unit === 'mAh') { const cap = Number(tnGet('BATT_CAPACITY')) || 0; f = cap > 0 ? tnFrac(n, 0, cap) : tnFrac(n, v.min, v.max); label = cap > 0 && n > 0 ? `%${tnNum((n / cap) * 100, 0)}` : ''; }
    else { f = tnFrac(n, 0, 100); label = `%${tnNum(n, 0)}`; }
    const cls = f < 0.15 ? 'low' : f < 0.4 ? 'mid' : 'high';
    return `<svg viewBox="0 0 200 122" class="tn-g g-batt ${cls}">
      <rect class="g-shell" x="30" y="30" width="128" height="62" rx="10"/><rect class="g-cap" x="160" y="48" width="10" height="26" rx="3"/>
      <rect class="g-fill-r" x="37" y="37" width="${(f * 114).toFixed(1)}" height="48" rx="5"/>
      <text class="g-big" x="94" y="67" text-anchor="middle">${esc(label)}</text></svg>`;
  },
  // Yatay çubuk: iki ucu adlandırılmış ölçek
  bar(v, value) {
    const f = tnFrac(value, v.min, v.max);
    const x = 18 + f * 164;
    const ends = v.ends ? [tx(v.ends[0]), tx(v.ends[1])] : [tnNum(v.min), tnNum(v.max)];
    let ticks = '';
    for (let i = 0; i <= 10; i++) ticks += `<line class="g-tick" x1="${18 + i * 16.4}" y1="74" x2="${18 + i * 16.4}" y2="${i % 5 ? 79 : 83}"/>`;
    return `<svg viewBox="0 0 200 122" class="tn-g g-bar">
      <rect class="g-track-r" x="18" y="52" width="164" height="10" rx="5"/><rect class="g-fill-r" x="18" y="52" width="${(f * 164).toFixed(1)}" height="10" rx="5"/>${ticks}
      <circle class="g-thumb" cx="${x.toFixed(1)}" cy="57" r="10"/>
      <text class="g-lbl" x="18" y="100" text-anchor="start">${esc(ends[0])}</text><text class="g-lbl" x="182" y="100" text-anchor="end">${esc(ends[1])}</text></svg>`;
  },
  // Uzaklık: ev çevresinde daire (logaritmik ölçek) ve sınırdaki araç
  radius(v, value) {
    const lo = Math.max(1, v.min || 1);
    const n = Math.max(lo, Number(value) || 0);
    const f = Number(value) > 0 ? Math.max(0, Math.min(1, Math.log(n / lo) / Math.log(v.max / lo))) : 0;
    const r = 14 + f * 38;
    return `<svg viewBox="0 0 200 122" class="tn-g g-radius">
      <circle class="g-ring-o" cx="100" cy="60" r="52"/><circle class="g-zone" cx="100" cy="60" r="${r.toFixed(1)}"/>
      <line class="g-level" x1="100" y1="60" x2="${(100 + r).toFixed(1)}" y2="60"/>
      <path class="g-home" d="M93 62l7-6 7 6v7h-14z"/>
      <g transform="translate(${(100 + r).toFixed(1)} 60)"><circle class="g-thumb" r="5"/></g>
      <text class="g-lbl" x="100" y="82" text-anchor="middle">${esc(tx(TUNING.UI.home))}</text></svg>`;
  },
};
const TN_GAUGE = { speed: 'dial', rate: 'dial', angle: 'tilt', altitude: 'altitude', time: 'time', battery: 'battery', bar: 'bar', radius: 'radius' };

// Değerin altındaki küçük açıklama: sıfırın özel anlamı, km/sa karşılığı, hücre gerilimi, tam tur süresi
function tnCaption(v, value) {
  const n = Number(value);
  if (v.zero && n === 0) return tx(v.zero);
  if (!Number.isFinite(n)) return '';
  if (v.unit === 'm/s') return tx(TUNING.UI.kmh, { n: tnNum(n * 3.6, 1) });
  if (v.unit === '°/s' && n > 0) return tx(TUNING.UI.turn, { n: tnNum(360 / n, 1) });
  if (v.unit === 'V' && n > 0) { const c = TUNING.cells(n, tnGet); return c ? tx(TUNING.UI.cellInfo, { n: tnNum(n / c, 2), c }) : ''; }
  if (v.unit === 'mAh' && v.gauge === 'battery') { const cap = Number(tnGet('BATT_CAPACITY')) || 0; return cap > 0 && n > 0 ? tx(TUNING.UI.pctCapacity, { n: tnNum((n / cap) * 100, 0) }) : ''; }
  return '';
}

const tuningModule = {
  mount(host) {
    this.host = host;
    host.appendChild(h('<div class="tn" data-tn></div>'));
    const root = host.firstElementChild;
    root.addEventListener('input', (e) => this.onInput(e));
    root.addEventListener('change', (e) => this.onChange(e));
    root.addEventListener('click', (e) => this.onClick(e));
    TN.sig = this.signature();
    this.paint();
    if (!P.list.length && st.linked && !P.loading) modules.params.reload(false);
  },

  alive() { return !!(this.host && this.host.isConnected && moduleId === 'tuning'); },
  root() { return this.host.querySelector('[data-tn]'); },

  ctx() {
    return { firmware: st.firmware && st.firmware !== 'unknown' ? st.firmware : drone.firmware, vehicle: st.vehicle || 'copter', has: (n) => P.byName.has(n), modes: st.modes || [] };
  },
  signature() {
    const c = this.ctx();
    return [c.firmware, c.vehicle, st.linked ? 1 : 0, P.list.length, P.loading ? 1 : 0, c.modes.map((m) => m.id).join(',')].join('|');
  },
  // Durum her telemetri iletisinde gelir; yalnızca ayarları etkileyen bir şey değiştiyse yeniden çizilir
  stateChanged() {
    if (!this.alive()) return;
    const sig = this.signature();
    if (sig !== TN.sig) { TN.sig = sig; this.paint(); }
  },
  // Parametre okuma ilerlemesi
  progress() {
    if (!this.alive()) return;
    const bar = this.host.querySelector('[data-tn-bar] i');
    if (!bar) { if (!P.list.length) { TN.sig = this.signature(); this.paint(); } return; }
    bar.style.width = `${P.progress && P.progress.total ? Math.min(100, (P.progress.received / P.progress.total) * 100) : 4}%`;
    const info = this.host.querySelector('[data-tn-info]');
    if (info) info.textContent = tx(TUNING.UI.reading, { n: P.progress ? P.progress.received : 0, total: P.progress && P.progress.total ? P.progress.total : '?' });
  },
  // Parametre listesi yenilendi
  reloaded() { if (this.alive()) { TN.sig = this.signature(); this.paint(); } },

  // Başka yerden (parametre modülü, kumanda, araç) değişen parametre: düzenlenmeyen kartlar araçtaki değere döner
  paramChanged(name) {
    if (!this.alive() || TN.busy) return;
    for (const id of TN.byParam.get(name) || []) {
      const el = this.cardEl(id);
      if (!el) continue;
      if (TN.edits.has(id) || el.contains(document.activeElement)) this.sync(id);
      else this.rebuild(id);
    }
    this.paintFoot();
  },

  value(id) {
    if (TN.edits.has(id)) return TN.edits.get(id);
    const it = TN.byId.get(id);
    return it ? TUNING.read(it.setting, it.mapping, tnGet) : null;
  },
  writes(id) {
    const it = TN.byId.get(id);
    return it && TN.edits.has(id) ? TUNING.plan(it.setting, it.mapping, TN.edits.get(id), tnGet) : [];
  },
  cardEl(id) { return this.host.querySelector(`.tn-card[data-s="${CSS.escape(id)}"]`); },

  paint() {
    if (!this.alive()) return;
    const root = this.root();
    const U = TUNING.UI;
    if (!P.list.length) {
      const loading = P.loading;
      root.className = 'tn tn-empty';
      root.innerHTML = `<div class="tn-blank">${icon('gear')}
        <h3>${esc(tx(U.needParams))}</h3>
        <p data-tn-info>${esc(loading ? tx(U.reading, { n: P.progress ? P.progress.received : 0, total: P.progress && P.progress.total ? P.progress.total : '?' }) : st.linked ? tx(U.needParamsSub) : tx(U.notLinked))}</p>
        ${loading ? '<div class="vis-bar" data-tn-bar><i style="width:4%"></i></div>' : `<button class="btn primary" data-fetch ${st.linked ? '' : 'disabled'}>${icon('refresh')}${esc(tx(U.readParams))}</button>`}
      </div>`;
      if (loading) this.progress();
      return;
    }
    TN.groups = TUNING.available(this.ctx());
    TN.byId = new Map(); TN.byParam = new Map();
    for (const g of TN.groups) for (const it of g.items) {
      TN.byId.set(it.setting.id, it);
      for (const n of TUNING.paramNames(it.setting, it.mapping)) { if (!TN.byParam.has(n)) TN.byParam.set(n, []); TN.byParam.get(n).push(it.setting.id); }
    }
    for (const id of [...TN.edits.keys()]) if (!TN.byId.has(id)) TN.edits.delete(id);
    if (!TN.groups.length) { root.className = 'tn tn-empty'; root.innerHTML = `<div class="tn-blank">${icon('gear')}<h3>${esc(tx(U.none))}</h3></div>`; return; }
    if (!TN.groups.some((g) => g.id === TN.group)) TN.group = TN.groups[0].id;
    const keepScroll = root.querySelector('.tn-scroll') ? root.querySelector('.tn-scroll').scrollTop : 0;
    const hadFocus = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-tn-q]');
    root.className = `tn${TN.busy ? ' busy' : ''}`;
    root.innerHTML = `<aside class="tn-side">
        <div class="search tn-search"><span class="search-ico">${icon('search')}</span><input data-tn-q spellcheck="false" placeholder="${esc(tx(U.search))}" value="${esc(TN.query)}"></div>
        <div class="tn-groups" data-tn-groups></div>
      </aside>
      <div class="tn-main"><div class="tn-scroll" data-tn-scroll></div>
        <footer class="tn-foot hidden" data-tn-foot></footer></div>`;
    this.paintGroups();
    this.paintMain();
    this.paintFoot();
    root.querySelector('.tn-scroll').scrollTop = keepScroll;
    if (hadFocus) { const q = root.querySelector('[data-tn-q]'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  },

  shown(g) { return TN.query ? g.items.filter((it) => TUNING.matches(it, TN.query)) : g.items; },

  paintGroups() {
    const box = this.host.querySelector('[data-tn-groups]');
    if (!box) return;
    box.innerHTML = TN.groups.map((g) => {
      const n = this.shown(g).length;
      const dirty = g.items.filter((it) => TN.edits.has(it.setting.id)).length;
      return `<button type="button" data-g="${esc(g.id)}" class="${!TN.query && TN.group === g.id ? 'on' : ''} ${TN.query && !n ? 'dim' : ''}">${icon(g.icon)}<span>${esc(tx(g.title))}</span>${dirty ? `<em title="${esc(tx(TUNING.UI.changed))}">${dirty}</em>` : ''}<i>${n}</i></button>`;
    }).join('');
  },

  paintMain() {
    const box = this.host.querySelector('[data-tn-scroll]');
    if (!box) return;
    const U = TUNING.UI;
    const grid = (items) => `<div class="tn-grid">${items.map((it) => this.card(it)).join('')}</div>`;
    if (TN.query) {
      const parts = TN.groups.map((g) => [g, this.shown(g)]).filter(([, l]) => l.length);
      box.innerHTML = parts.length ? `<header class="tn-head"><h2>${icon('search')}<span>${esc(tx(U.results))}</span></h2></header>${parts.map(([g, l]) => `<h3 class="tn-sub">${icon(g.icon)}<span>${esc(tx(g.title))}</span><i>${l.length}</i></h3>${grid(l)}`).join('')}` : `<div class="empty-note">${esc(tx(U.noMatch))}</div>`;
    } else {
      const g = TN.groups.find((x) => x.id === TN.group);
      box.innerHTML = `<header class="tn-head"><h2>${icon(g.icon)}<span>${esc(tx(g.title))}</span></h2><p>${esc(tx(g.intro))}</p></header>${grid(g.items)}`;
    }
    enhanceNumbers(box);
    for (const id of TN.edits.keys()) if (this.cardEl(id)) this.sync(id, true);
  },

  // ---- Kart ----
  card(it) {
    const v = it.view; const id = it.setting.id;
    const value = this.value(id);
    const U = TUNING.UI;
    return `<article class="tn-card k-${v.kind} ${v.wide ? 'wide' : ''} ${TN.edits.has(id) ? 'dirty' : ''}" data-s="${esc(id)}">
      <header><h4>${esc(tx(v.title))}</h4><span class="tn-badge">${esc(tx(U.changed))}</span></header>
      <div class="tn-vis" data-vis>${this.vis(it, value)}</div>
      <div class="tn-ctl" data-ctl>${this.control(it, value)}</div>
      <p class="tn-desc">${esc(tx(v.desc))}</p>
      <details class="tn-plan" data-plan><summary><span data-plan-title>${this.planTitle(it)}</span>${icon('chevronDown', 'chev')}</summary><div class="tn-plan-rows" data-plan-rows>${this.planRows(it)}</div></details>
      <div class="tn-acts" data-acts><button class="btn sm" type="button" data-revert>${icon('history')}${esc(tx(U.revert))}</button><button class="btn sm primary" type="button" data-apply>${icon('upload')}${esc(tx(U.apply))}</button></div>
    </article>`;
  },

  // Gösterge + büyük değer (sayısal ayarlar); kip anahtarı konumu; aç/kapa durumu
  vis(it, value) {
    const v = it.view;
    if (v.kind === 'number') {
      const g = tnGauge[TN_GAUGE[v.gauge] || 'bar'](v, value === null ? v.min : value);
      const cap = tnCaption(v, value);
      return `${g}<div class="tn-val"><div><b>${esc(value === null ? '—' : tnNum(value, Math.max(2, TUNING.decimals(v.step))))}</b><span>${esc(v.unit || '')}</span></div><small>${esc(cap)}</small></div>`;
    }
    if (v.gauge === 'switch') {
      let cells = '';
      for (let i = 1; i <= 6; i++) cells += `<i class="${i === v.position ? 'on' : ''}">${i}</i>`;
      const opt = (v.options || []).find((x) => x.value === value);
      return `<div class="tn-sw">${cells}</div><div class="tn-val"><div><b class="txt">${esc(opt ? tx(opt.label) : value === null ? '—' : String(value))}</b></div><small>${v.pwm ? esc(tx(TUNING.UI.pwmBand, { n: v.pwm })) : ''}</small></div>`;
    }
    return '';
  },

  control(it, value) {
    const v = it.view; const U = TUNING.UI;
    if (v.kind === 'number') {
      const input = `<input class="input mono" type="number" data-num min="${v.min}" max="${v.max}" step="${v.step}" value="${value === null ? '' : esc(tnRaw(value))}">`;
      return v.unit ? `<span class="unit-wrap">${input}<span>${esc(v.unit)}</span></span>` : input;
    }
    if (v.kind === 'toggle') return `<label class="tn-switch"><input type="checkbox" data-tgl ${value ? 'checked' : ''}><i></i><b data-tgl-text>${esc(tx(value ? U.on : U.off))}</b></label>`;
    if (v.kind === 'bits') {
      const mask = Number(value) >>> 0;
      return `<div class="tn-bits">${v.bits.map((b) => `<label class="check"><input type="checkbox" data-bit="${b.bit}" ${mask & (2 ** b.bit) ? 'checked' : ''}><span>${esc(tx(b.label))}</span></label>`).join('')}</div>`;
    }
    const options = [...(v.options || [])];
    if (v.kind === 'preset' && value === null) options.push({ value: null, label: U.custom, note: U.customNote, fixed: true });
    else if (v.kind === 'select' && value !== null && !options.some((x) => x.value === value)) options.push({ value, label: { tr: String(value), en: String(value) }, note: U.notInList });
    if (v.kind === 'select' && options.length > 8) return `<select class="input" data-sel>${options.map((x) => `<option value="${esc(x.value)}" ${x.value === value ? 'selected' : ''}>${esc(tx(x.label))}</option>`).join('')}</select>`;
    return `<div class="tn-opts">${options.map((x) => `<button type="button" class="tn-opt ${x.value === value ? 'on' : ''}" data-v="${esc(String(x.value))}" data-t="${typeof x.value}" ${x.fixed ? 'data-fixed disabled' : ''}><b>${esc(tx(x.label))}</b>${x.note ? `<small>${esc(tx(x.note))}</small>` : ''}</button>`).join('')}</div>`;
  },

  planTitle(it) {
    const id = it.setting.id; const U = TUNING.UI;
    return TN.edits.has(id) ? `${esc(tx(U.willChange))} <i>${this.writes(id).length}</i>` : `${esc(tx(U.bound))} <i>${TUNING.paramNames(it.setting, it.mapping).filter((n) => P.byName.has(n)).length}</i>`;
  },
  planRows(it) {
    const id = it.setting.id; const U = TUNING.UI;
    if (!TN.edits.has(id)) return TUNING.paramNames(it.setting, it.mapping).filter((n) => P.byName.has(n)).map((n) => `<div class="tn-pw"><b class="mono">${esc(n)}</b><span class="mono">${esc(tnRaw(tnGet(n)))}</span></div>`).join('');
    const writes = this.writes(id);
    const warn = TUNING.risk(it.setting, it.mapping, TN.edits.get(id));
    return `${warn ? `<div class="tn-risk">${icon('alert')}<span>${esc(tx(warn))}</span></div>` : ''}${writes.length ? writes.map((w) => `<div class="tn-pw ${w.why ? 'linked' : ''}"><b class="mono">${esc(w.name)}</b><span class="mono">${esc(tnRaw(w.from))} → <b>${esc(tnRaw(w.value))}</b></span>${w.why ? `<small>${icon('link')}<span>${esc(tx(w.why))}</span></small>` : ''}</div>`).join('') : `<div class="tn-pw none">${esc(tx(U.noWrites))}</div>`}`;
  },

  // Kartın denetimi yerinde kalır (odak ve sürükleme bozulmaz); gösterge, değer, plan ve düğmeler güncellenir
  sync(id, quiet) {
    const el = this.cardEl(id); const it = TN.byId.get(id);
    if (!el || !it) return;
    const v = it.view; const value = this.value(id);
    const dirty = TN.edits.has(id);
    const was = el.classList.contains('dirty');
    el.classList.toggle('dirty', dirty);
    el.querySelector('[data-vis]').innerHTML = this.vis(it, value);
    if (v.kind === 'toggle') { el.querySelector('[data-tgl]').checked = !!value; el.querySelector('[data-tgl-text]').textContent = tx(value ? TUNING.UI.on : TUNING.UI.off); }
    else if (v.kind === 'bits') for (const c of el.querySelectorAll('[data-bit]')) c.checked = !!((Number(value) >>> 0) & (2 ** Number(c.dataset.bit)));
    else if (v.kind === 'number') { const num = el.querySelector('[data-num]'); if (!dirty && document.activeElement !== num && value !== null) num.value = tnRaw(value); }
    else if (el.querySelector('[data-sel]')) el.querySelector('[data-sel]').value = String(value);
    else for (const b of el.querySelectorAll('.tn-opt')) b.classList.toggle('on', !b.dataset.fixed ? b.dataset.v === String(value) : value === null);
    el.querySelector('[data-plan-title]').innerHTML = this.planTitle(it);
    el.querySelector('[data-plan-rows]').innerHTML = this.planRows(it);
    if (dirty && (!was || quiet)) el.querySelector('[data-plan]').open = true;
  },

  rebuild(id) {
    const el = this.cardEl(id); const it = TN.byId.get(id);
    if (!el || !it) return;
    const n = h(this.card(it));
    enhanceNumbers(n);
    el.replaceWith(n);
  },

  setEdit(id, value) {
    const it = TN.byId.get(id);
    if (!it || TN.busy) return;
    const orig = TUNING.read(it.setting, it.mapping, tnGet);
    if (TUNING.equal(value, orig)) TN.edits.delete(id); else TN.edits.set(id, value);
    this.sync(id);
    this.paintFoot();
    this.paintGroups();
  },

  paintFoot() {
    const foot = this.host.querySelector('[data-tn-foot]');
    if (!foot) return;
    const U = TUNING.UI;
    const n = TN.edits.size;
    foot.classList.toggle('hidden', !n);
    if (!n) return;
    const names = new Set();
    for (const id of TN.edits.keys()) for (const w of this.writes(id)) names.add(w.name);
    foot.innerHTML = `<span class="tn-foot-info">${icon('edit')}<b>${esc(tx(U.nChanged, { n }))}</b><small>${esc(TN.busy ? tx(U.busy) : tx(U.nWrites, { n: names.size }))}</small></span><span style="flex:1"></span>
      <button class="btn" type="button" data-discard ${TN.busy ? 'disabled' : ''}>${icon('x')}${esc(tx(U.discard))}</button><button class="btn primary" type="button" data-apply-all ${TN.busy ? 'disabled' : ''}>${icon('upload')}${esc(tx(U.applyAll))}</button>`;
  },

  // ---- Olaylar ----
  onInput(e) {
    const q = e.target.closest('[data-tn-q]');
    if (q) { TN.query = q.value.trim(); this.paintGroups(); this.paintMain(); return; }
    const num = e.target.closest('[data-num]');
    if (num) { const v = Number(num.value); if (num.value !== '' && Number.isFinite(v)) this.setEdit(num.closest('.tn-card').dataset.s, v); }
  },
  onChange(e) {
    const card = e.target.closest('.tn-card');
    if (!card) return;
    const id = card.dataset.s; const it = TN.byId.get(id);
    if (!it) return;
    if (e.target.matches('[data-num]')) {
      // Elle yazılan değer aralığa çekilir; boş bırakılırsa araçtaki değere dönülür
      const c = e.target.value === '' ? null : TUNING.clamp(it.view, e.target.value);
      if (c === null) { TN.edits.delete(id); this.rebuild(id); this.paintFoot(); this.paintGroups(); return; }
      if (Number(e.target.value) !== c) e.target.value = String(c);
      this.setEdit(id, c);
    } else if (e.target.matches('[data-tgl]')) this.setEdit(id, e.target.checked);
    else if (e.target.matches('[data-sel]')) this.setEdit(id, Number(e.target.value));
    else if (e.target.matches('[data-bit]')) {
      let mask = Number(this.value(id)) >>> 0;
      const m = 2 ** Number(e.target.dataset.bit);
      mask = e.target.checked ? (mask | m) >>> 0 : (mask & ~m) >>> 0;
      this.setEdit(id, mask);
    }
  },
  async onClick(e) {
    if (e.target.closest('[data-fetch]')) { await modules.params.fetch(); return; }
    const g = e.target.closest('[data-tn-groups] [data-g]');
    if (g) { TN.group = g.dataset.g; TN.query = ''; const q = this.host.querySelector('[data-tn-q]'); if (q) q.value = ''; this.paintGroups(); this.paintMain(); this.host.querySelector('[data-tn-scroll]').scrollTop = 0; return; }
    if (e.target.closest('[data-apply-all]')) return this.apply([...TN.edits.keys()]);
    if (e.target.closest('[data-discard]')) { TN.edits.clear(); this.paintGroups(); this.paintMain(); this.paintFoot(); return; }
    const card = e.target.closest('.tn-card');
    if (!card) return;
    const id = card.dataset.s;
    const opt = e.target.closest('.tn-opt');
    if (opt && !opt.dataset.fixed) return this.setEdit(id, opt.dataset.t === 'number' ? Number(opt.dataset.v) : opt.dataset.v);
    if (e.target.closest('[data-revert]')) { TN.edits.delete(id); this.rebuild(id); this.paintFoot(); this.paintGroups(); return; }
    if (e.target.closest('[data-apply]')) return this.apply([id]);
  },

  // Seçilen ayarları araca yazar: parametreler sırayla gönderilir, yazılamayanlar bildirilir (kart değişmiş kalır)
  async apply(ids) {
    if (TN.busy || !needLink()) return;
    const U = TUNING.UI;
    const jobs = ids.filter((id) => TN.edits.has(id) && TN.byId.has(id)).map((id) => ({ id, it: TN.byId.get(id), value: TN.edits.get(id) }));
    if (!jobs.length) return;
    const risks = jobs.map((j) => ({ j, r: TUNING.risk(j.it.setting, j.it.mapping, j.value) })).filter((x) => x.r);
    if (risks.length) {
      const ok = await openModal({
        title: tx(U.riskTitle), iconName: 'alert', width: 520,
        body: `<div class="tn-confirm">${risks.map((x) => `<div><b>${esc(tx(x.j.it.view.title))}</b><p>${esc(tx(x.r))}</p></div>`).join('')}<p class="ask">${esc(tx(U.riskAsk))}</p></div>`,
        buttons: [{ label: t('common.giveUp'), value: false }, { label: tx(U.apply), cls: 'primary danger-primary', value: true }],
      });
      if (!ok) return;
    }
    TN.busy = true;
    this.root().classList.add('busy');
    this.paintFoot();
    let written = 0; const failed = [];
    for (const j of jobs) {
      // Plan her ayar için yazmadan hemen önce yeniden hesaplanır (önceki yazımlar değerleri değiştirmiş olabilir)
      let ok = true;
      for (const w of TUNING.plan(j.it.setting, j.it.mapping, j.value, tnGet)) {
        const r = await call('setParam', w.name, w.value);
        const p = P.byName.get(w.name);
        if (r && r.ok) { written++; if (p) p.value = r.value; } else { ok = false; failed.push(w.name); if (p && r && Number.isFinite(r.value)) p.value = r.value; }
      }
      if (ok) TN.edits.delete(j.id);
    }
    TN.busy = false;
    if (failed.length) toast(t('dr.failed'), { type: 'err', sub: `${tx(U.failedParams)}: ${failed.join(', ')}`, timeout: 7000 });
    else toast(tx(U.applied), { type: 'ok', sub: tx(U.appliedN, { n: written }), timeout: 2500 });
    if (this.alive()) this.paint();
  },
};
