'use strict';

// Dron ve uçuş pencerelerinin ortak parçaları: küçük çizgi grafik, telemetri grafik sütunu, haberleşme günlüğü.

const fmtNum = (v, digits = 1) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(digits));

// Tek değerin zaman içindeki çizgisi (son `span` saniye). Ölçek kendiliğinden ayarlanır.
class MiniChart {
  constructor(host, { label, unit = '', color = '#22d3ee', digits = 1, span = 60, min = null, max = null }) {
    this.opt = { label, unit, color, digits, span, min, max };
    this.points = []; // [zaman ms, değer]
    this.el = h(`<div class="mini-chart"><div class="mc-head"><span>${esc(label)}</span><b></b></div><canvas></canvas></div>`);
    this.canvas = this.el.querySelector('canvas');
    this.value = this.el.querySelector('b');
    host.appendChild(this.el);
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.canvas);
  }

  push(v, now = Date.now()) {
    const ok = v !== null && v !== undefined && Number.isFinite(Number(v));
    this.value.textContent = ok ? `${Number(v).toFixed(this.opt.digits)}${this.opt.unit ? ` ${this.opt.unit}` : ''}` : '—';
    if (ok) this.points.push([now, Number(v)]);
    const from = now - this.opt.span * 1000;
    while (this.points.length && this.points[0][0] < from) this.points.shift();
    this.draw(now);
  }

  clear() { this.points = []; this.value.textContent = '—'; this.draw(); }

  draw(now = Date.now()) {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const hh = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, hh);
    const css = getComputedStyle(document.documentElement);
    g.strokeStyle = css.getPropertyValue('--border') || '#223';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, hh - 0.5); g.lineTo(w, hh - 0.5); g.stroke();
    const p = this.points;
    if (p.length < 2) return;
    let lo = this.opt.min; let hi = this.opt.max;
    if (lo === null || hi === null) {
      let a = Infinity; let b = -Infinity;
      for (const [, v] of p) { if (v < a) a = v; if (v > b) b = v; }
      const pad = Math.max((b - a) * 0.15, Math.abs(b) * 0.02, 0.5);
      if (lo === null) lo = a - pad;
      if (hi === null) hi = b + pad;
    }
    const x = (tm) => w - ((now - tm) / (this.opt.span * 1000)) * w;
    const y = (v) => hh - 2 * dpr - ((v - lo) / (hi - lo || 1)) * (hh - 4 * dpr);
    g.beginPath();
    p.forEach(([tm, v], i) => (i ? g.lineTo(x(tm), y(v)) : g.moveTo(x(tm), y(v))));
    g.strokeStyle = this.opt.color;
    g.lineWidth = 1.6 * dpr;
    g.lineJoin = 'round';
    g.stroke();
    g.lineTo(x(p[p.length - 1][0]), hh); g.lineTo(x(p[0][0]), hh); g.closePath();
    g.globalAlpha = 0.12; g.fillStyle = this.opt.color; g.fill(); g.globalAlpha = 1;
    if (lo < 0 && hi > 0) { g.strokeStyle = css.getPropertyValue('--border-strong') || '#445'; g.lineWidth = 1; g.setLineDash([3 * dpr, 3 * dpr]); g.beginPath(); g.moveTo(0, y(0)); g.lineTo(w, y(0)); g.stroke(); g.setLineDash([]); }
  }
}

// Temel telemetri: yukarıdan aşağıya çizgi grafikler
const TELEMETRY_CHARTS = [
  ['altRel', 'm', '#22d3ee', 1], ['groundspeed', 'm/s', '#34d399', 1], ['climb', 'm/s', '#a78bfa', 1], ['roll', '°', '#f472b6', 1], ['pitch', '°', '#fb923c', 1],
  ['heading', '°', '#fbbf24', 0, 0, 360], ['throttle', '%', '#60a5fa', 0, 0, 100], ['voltage', 'V', '#a3e635', 2], ['current', 'A', '#f87171', 1], ['sats', '', '#94a3b8', 0],
];
function buildTelemetryCharts(host) {
  const charts = TELEMETRY_CHARTS.map(([key, unit, color, digits, min, max]) => [key, new MiniChart(host, { label: t(`tm.${key}`), unit, color, digits, min: min === undefined ? null : min, max: max === undefined ? null : max })]);
  return {
    push(telemetry) { const now = Date.now(); for (const [key, c] of charts) c.push(telemetry ? telemetry[key] : null, now); },
    clear() { for (const [, c] of charts) c.clear(); },
  };
}

// Haberleşme günlüğü: gelen/giden her ileti; arama (boşlukla ayrılmış sözcükler, "-sözcük" dışarıda bırakır)
function buildCommLog({ rows, search, dir, pause, clear, count }) {
  const MAX = 8000;
  const SHOWN = 400;
  let entries = [];
  let paused = false;
  let dirFilter = 'all';
  let dirty = false;
  search.placeholder = t('dr.logSearchPh');
  search.title = t('dr.logSearchHint');
  const paintDir = () => { dir.innerHTML = [['all', t('dr.logAll')], ['rx', t('dr.logRx')], ['tx', t('dr.logTx')]].map(([v, l]) => `<button type="button" data-v="${v}" class="${dirFilter === v ? 'on' : ''}">${esc(l)}</button>`).join(''); };
  const paintPause = () => { pause.innerHTML = `${icon(paused ? 'play' : 'pause')}${esc(paused ? t('dr.logResume') : t('dr.logPause'))}`; };
  clear.innerHTML = `${icon('broom')}${esc(t('cam.clear'))}`;
  const time = (ms) => { const d = new Date(ms); return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`; };

  function paint() {
    dirty = false;
    const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const must = terms.filter((x) => !x.startsWith('-'));
    const not = terms.filter((x) => x.startsWith('-') && x.length > 1).map((x) => x.slice(1));
    const out = [];
    let matched = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (dirFilter !== 'all' && e.dir !== dirFilter) continue;
      if (must.length || not.length) {
        const hay = `${e.name} ${e.text}`.toLowerCase();
        if (!must.every((m) => hay.includes(m)) || not.some((m) => hay.includes(m))) continue;
      }
      matched++;
      if (out.length < SHOWN) out.push(e);
    }
    out.reverse();
    const stick = rows.scrollTop + rows.clientHeight >= rows.scrollHeight - 30;
    rows.innerHTML = out.length ? out.map((e) => `<div class="lg ${e.dir}"><time>${time(e.t)}</time><b>${e.dir === 'tx' ? '→' : '←'}</b><i>${e.sysid}/${e.compid}</i><span class="n">${esc(e.name)}</span><span class="x">${esc(e.text)}</span></div>`).join('') : `<div class="empty-note">${esc(entries.length ? t('dr.logNoMatch') : t('dr.logEmpty'))}</div>`;
    if (stick) rows.scrollTop = rows.scrollHeight;
    count.textContent = t('dr.logCount', { shown: out.length, total: matched });
  }
  setInterval(() => { if (dirty && !paused) paint(); }, 200);

  search.addEventListener('input', paint);
  dir.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; dirFilter = b.dataset.v; paintDir(); paint(); };
  pause.onclick = () => { paused = !paused; paintPause(); if (!paused) paint(); };
  clear.onclick = () => { entries = []; paint(); };
  paintDir(); paintPause(); paint();
  return {
    add(list) { entries.push(...list); if (entries.length > MAX) entries.splice(0, entries.length - MAX); dirty = true; },
    paint,
  };
}

// Ayırıcı: sürükleyerek boyut değiştirme (axis: 'x' | 'y'; get/set piksel)
function dragSplit(el, axis, get, set, done) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const base = get();
    el.classList.add('drag');
    const move = (ev) => set(base - ((axis === 'x' ? ev.clientX : ev.clientY) - start));
    const up = () => { el.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); if (done) done(); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
}
