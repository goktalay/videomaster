'use strict';

// Akan verinin boyutu: tek serili, tek eksenli çizgi grafik (tuval). İmleçle üzerine gelince o anın değeri gösterilir.
// Noktalar: { t (ms), bps, pps, fps }. Birim: 'bit' | 'byte'.

class RateChart {
  constructor(host, { unit = 'bit', range = 60 } = {}) {
    this.host = host;
    this.unit = unit;
    this.range = range; // saniye
    this.points = [];
    this.hover = null;
    host.classList.add('chart');
    host.innerHTML = '<canvas></canvas><div class="chart-tip hidden"></div>';
    this.canvas = host.querySelector('canvas');
    this.tip = host.querySelector('.chart-tip');
    this.ctx = this.canvas.getContext('2d');
    this.canvas.addEventListener('mousemove', (e) => { this.hover = e.offsetX; this.draw(); });
    this.canvas.addEventListener('mouseleave', () => { this.hover = null; this.tip.classList.add('hidden'); this.draw(); });
    new ResizeObserver(() => this.draw()).observe(host);
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => this.draw());
  }

  set(points) { this.points = points.slice(-1500); this.draw(); }
  add(p) { this.points.push(p); if (this.points.length > 1500) this.points.shift(); this.draw(); }
  setUnit(u) { this.unit = u; this.draw(); }
  setRange(r) { this.range = r; this.draw(); }

  // Eksen için "güzel" üst sınır ve adım (1 · 2 · 5 × 10ⁿ)
  static nice(max, k) {
    if (max <= 0) return { top: k, step: k / 4 };
    const raw = max / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    return { top: Math.ceil(max / step) * step, step };
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(this.host);
    const col = (n) => css.getPropertyValue(n).trim();
    const ink3 = col('--text-3');
    const grid = col('--border');
    const line = col('--accent');
    const pad = { l: 72, r: 12, t: 10, b: 20 };
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;
    if (pw < 40 || ph < 30) return;

    const now = this.points.length ? this.points[this.points.length - 1].t : Date.now();
    const t0 = now - this.range * 1000;
    const pts = this.points.filter((p) => p.t >= t0 - 1000);
    const val = (p) => (this.unit === 'byte' ? p.bps / 8 : p.bps);
    const max = pts.reduce((m, p) => Math.max(m, val(p)), 0);
    const { top, step } = RateChart.nice(max, this.unit === 'byte' ? 1024 : 1000);
    const X = (tt) => pad.l + ((tt - t0) / (this.range * 1000)) * pw;
    const Y = (v) => pad.t + ph - (v / top) * ph;

    // ızgara ve eksen etiketleri (geri planda, soluk)
    g.font = `11px ${css.fontFamily}`;
    g.textBaseline = 'middle';
    g.lineWidth = 1;
    for (let v = 0; v <= top + step / 2; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      g.strokeStyle = grid;
      g.globalAlpha = v === 0 ? 1 : 0.55;
      g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = ink3;
      g.textAlign = 'right';
      g.fillText(formatRate(this.unit === 'byte' ? v * 8 : v, this.unit).replace(/[⁦⁩]/g, ''), pad.l - 6, y);
    }
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    const tickEvery = this.range <= 60 ? 15 : this.range <= 120 ? 30 : 60;
    for (let s = 0; s <= this.range; s += tickEvery) {
      const x = X(now - s * 1000);
      g.fillStyle = ink3;
      g.fillText(s === 0 ? t('chart.now') : `-${s >= 60 ? `${s / 60} ${t('chart.min')}` : `${s} ${t('chart.sec')}`}`, Math.min(W - pad.r - 14, Math.max(pad.l + 14, x)), H - 5);
    }

    if (pts.length < 2) {
      g.fillStyle = ink3; g.textAlign = 'center';
      g.fillText(t('chart.empty'), pad.l + pw / 2, pad.t + ph / 2);
      return;
    }

    g.save();
    g.beginPath(); g.rect(pad.l, pad.t - 2, pw, ph + 3); g.clip();
    // alan dolgusu
    const grad = g.createLinearGradient(0, pad.t, 0, pad.t + ph);
    grad.addColorStop(0, line + '55');
    grad.addColorStop(1, line + '00');
    g.beginPath();
    pts.forEach((p, i) => { const x = X(p.t); const y = Y(val(p)); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.lineTo(X(pts[pts.length - 1].t), pad.t + ph);
    g.lineTo(X(pts[0].t), pad.t + ph);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
    // çizgi
    g.beginPath();
    pts.forEach((p, i) => { const x = X(p.t); const y = Y(val(p)); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.strokeStyle = line; g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round';
    g.stroke();
    g.restore();

    // imleç ve ipucu
    if (this.hover !== null && this.hover >= pad.l && this.hover <= W - pad.r) {
      const tt = t0 + ((this.hover - pad.l) / pw) * this.range * 1000;
      let best = pts[0];
      for (const p of pts) if (Math.abs(p.t - tt) < Math.abs(best.t - tt)) best = p;
      const x = X(best.t);
      const y = Y(val(best));
      g.strokeStyle = ink3; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(Math.round(x) + 0.5, pad.t); g.lineTo(Math.round(x) + 0.5, pad.t + ph); g.stroke();
      g.setLineDash([]);
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fillStyle = line; g.fill();
      g.lineWidth = 2; g.strokeStyle = col('--surface'); g.stroke();
      const time = new Date(best.t).toLocaleTimeString(LANG);
      this.tip.innerHTML = `<b>${formatRate(best.bps, this.unit)}</b><span>${esc(time)}</span><span>${best.pps} ${esc(t('chart.pps'))} · ${best.fps} fps</span>`;
      this.tip.classList.remove('hidden');
      const tw = this.tip.offsetWidth;
      this.tip.style.left = `${Math.min(W - tw - 4, Math.max(4, x + 10 + tw > W ? x - tw - 10 : x + 10))}px`;
      this.tip.style.top = `${Math.max(2, Math.min(H - this.tip.offsetHeight - 2, y - 20))}px`;
    }
  }
}
