'use strict';

// Uçuş göstergesi (HUD): yapay ufuk ve yunuslama merdiveni, yatış ölçeği, hız ve yükseklik şeritleri,
// yön şeridi, alt bilgi satırı. Video ya da haritanın üstüne saydam çizilir; değerler kareler arasında yumuşatılır.

class FlightHud {
  constructor(canvas) {
    this.canvas = canvas;
    this.target = null;   // son telemetri
    this.state = {};      // { mode, armed, linked }
    this.cur = { roll: 0, pitch: 0, heading: 0, speed: 0, alt: 0, climb: 0 };
    this.cardinals = t('hud.cardinals').split(',');
    this.visible = true;
    this.last = performance.now();
    const loop = (now) => { this.frame(now); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  update(telemetry, state) { this.target = telemetry || null; this.state = state || {}; }
  destroy() { cancelAnimationFrame(this.raf); }

  frame(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    if (!this.visible || !this.target || !this.state.linked) return;
    const tg = this.target;
    const k = 1 - Math.exp(-dt * 12); // yumuşatma
    const lerp = (a, b) => a + (b - a) * k;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const cur = this.cur;
    cur.roll = lerp(cur.roll, num(tg.roll));
    cur.pitch = lerp(cur.pitch, num(tg.pitch));
    const dh = ((num(tg.heading) - cur.heading + 540) % 360) - 180;
    cur.heading = (cur.heading + dh * k + 360) % 360;
    cur.speed = lerp(cur.speed, num(tg.groundspeed));
    cur.alt = lerp(cur.alt, num(tg.altRel));
    cur.climb = lerp(cur.climb, num(tg.climb));

    const u = Math.min(w / 145, h / 100); // ölçü birimi: şeritler dar alanda da sığsın
    const cx = w / 2; const cy = h / 2;
    const FG = '#e8fff4'; const ACC = '#5eead4'; const WARN = '#fbbf24'; const BAD = '#f87171';
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.shadowColor = 'rgba(0,0,0,.85)'; g.shadowBlur = 3 * dpr;
    const font = (px, bold = true) => { g.font = `${bold ? 600 : 400} ${Math.round(px)}px ui-monospace, "Cascadia Mono", Consolas, monospace`; };
    const text = (s, x, y, align = 'center', color = FG) => { g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y); };

    // --- Yapay ufuk + yunuslama merdiveni (ortadaki pencerede) ---
    const R = 30 * u;         // pencere yarıçapı
    const ppd = R / 22;       // derece başına piksel
    g.save();
    g.beginPath(); g.rect(cx - R * 1.25, cy - R, R * 2.5, R * 2); g.clip();
    g.translate(cx, cy); g.rotate((-cur.roll * Math.PI) / 180); g.translate(0, cur.pitch * ppd);
    g.strokeStyle = FG; g.lineWidth = 0.45 * u;
    g.beginPath(); g.moveTo(-R * 3, 0); g.lineTo(-7 * u, 0); g.moveTo(7 * u, 0); g.lineTo(R * 3, 0); g.stroke();
    font(2.6 * u);
    for (let p = -90; p <= 90; p += 5) {
      if (p === 0) continue;
      const y = -p * ppd;
      if (Math.abs(y + cur.pitch * ppd) > R * 1.1) continue;
      const major = p % 10 === 0;
      const half = (major ? 9 : 4.5) * u;
      g.lineWidth = 0.3 * u;
      g.setLineDash(p < 0 ? [1.6 * u, 1.2 * u] : []);
      g.beginPath(); g.moveTo(-half, y); g.lineTo(-2.5 * u, y); g.moveTo(2.5 * u, y); g.lineTo(half, y); g.stroke();
      g.setLineDash([]);
      if (major) { text(String(Math.abs(p)), -half - 3 * u, y); text(String(Math.abs(p)), half + 3 * u, y); }
    }
    g.restore();

    // --- Yatış ölçeği (üst yay) ve gösterge ---
    const RR = R * 1.08;
    g.strokeStyle = FG; g.lineWidth = 0.3 * u;
    g.beginPath(); g.arc(cx, cy, RR, (-150 * Math.PI) / 180, (-30 * Math.PI) / 180); g.stroke();
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const rad = ((a - 90) * Math.PI) / 180; const len = (a % 30 === 0 ? 2.4 : 1.4) * u;
      g.beginPath(); g.moveTo(cx + RR * Math.cos(rad), cy + RR * Math.sin(rad)); g.lineTo(cx + (RR + len) * Math.cos(rad), cy + (RR + len) * Math.sin(rad)); g.stroke();
    }
    g.save(); g.translate(cx, cy); g.rotate((-cur.roll * Math.PI) / 180);
    g.fillStyle = Math.abs(cur.roll) > 45 ? WARN : ACC;
    g.beginPath(); g.moveTo(0, -RR + 0.4 * u); g.lineTo(-1.6 * u, -RR + 3.2 * u); g.lineTo(1.6 * u, -RR + 3.2 * u); g.closePath(); g.fill();
    g.restore();

    // --- Sabit uçak simgesi ---
    g.strokeStyle = ACC; g.lineWidth = 0.6 * u;
    g.beginPath(); g.moveTo(cx - 9 * u, cy); g.lineTo(cx - 3.5 * u, cy); g.lineTo(cx - 2 * u, cy + 1.8 * u); g.moveTo(cx + 9 * u, cy); g.lineTo(cx + 3.5 * u, cy); g.lineTo(cx + 2 * u, cy + 1.8 * u); g.stroke();
    g.fillStyle = ACC; g.beginPath(); g.arc(cx, cy, 0.55 * u, 0, Math.PI * 2); g.fill();

    // --- Şeritler: hız (sol), yükseklik (sağ) ---
    const tape = (x, value, step, unit, label, side) => {
      const th = R * 1.7; const tw = 11 * u; const top = cy - th / 2;
      const left = side < 0 ? x - tw : x;
      g.save();
      g.shadowBlur = 0; g.fillStyle = 'rgba(8,14,24,.42)'; g.fillRect(left, top, tw, th);
      g.beginPath(); g.rect(left, top, tw, th); g.clip();
      g.shadowBlur = 3 * dpr; g.strokeStyle = FG; g.lineWidth = 0.25 * u; font(2.3 * u, false);
      const pps = (th / 2) / (step * 5);
      const first = Math.floor((value - step * 6) / step) * step;
      for (let v = first; v <= value + step * 6; v += step) {
        const y = cy - (v - value) * pps;
        const major = Math.round(v / step) % 2 === 0;
        const tx = side < 0 ? left + tw : left;
        g.beginPath(); g.moveTo(tx, y); g.lineTo(tx - side * (major ? 2.2 : 1.2) * u, y); g.stroke();
        if (major && Math.abs(y - cy) > 4.2 * u) text(String(Math.round(v * 10) / 10), side < 0 ? left + tw - 3 * u : left + 3 * u, y, side < 0 ? 'right' : 'left');
      }
      g.restore();
      // değer kutusu
      const bh = 5.2 * u;
      g.save(); g.shadowBlur = 0; g.fillStyle = 'rgba(8,14,24,.82)'; g.strokeStyle = ACC; g.lineWidth = 0.3 * u;
      g.beginPath(); g.rect(left - 0.6 * u, cy - bh / 2, tw + 1.2 * u, bh); g.fill(); g.stroke(); g.restore();
      font(3.3 * u); text(value.toFixed(Math.abs(value) < 100 ? 1 : 0), left + tw / 2, cy, 'center', FG);
      font(2.1 * u, false); text(`${label} ${unit}`, left + tw / 2, top - 2.2 * u, 'center', ACC);
    };
    const sx = cx - R * 1.45; const ax = cx + R * 1.45;
    tape(sx, cur.speed, 1, 'm/s', t('hud.speed'), -1);
    tape(ax, cur.alt, cur.alt > 200 ? 20 : 5, 'm', t('hud.alt'), 1);
    // tırmanma göstergesi (yükseklik şeridinin sağında)
    const vx = ax + 13 * u; const vh = R * 0.8; const cl = Math.max(-1, Math.min(1, cur.climb / 6));
    g.strokeStyle = FG; g.lineWidth = 0.25 * u; g.beginPath(); g.moveTo(vx, cy - vh); g.lineTo(vx, cy + vh); g.stroke();
    g.strokeStyle = cl >= 0 ? ACC : WARN; g.lineWidth = 1 * u; g.beginPath(); g.moveTo(vx, cy); g.lineTo(vx, cy - cl * vh); g.stroke();
    font(2.1 * u, false); text(`${cur.climb >= 0 ? '+' : ''}${cur.climb.toFixed(1)}`, vx + 1.5 * u, cy - cl * vh, 'left', FG);

    // --- Yön şeridi (üst) ---
    const hw = R * 1.6; const hy = cy - R - 9 * u; const hh = 4.6 * u;
    g.save(); g.shadowBlur = 0; g.fillStyle = 'rgba(8,14,24,.42)'; g.fillRect(cx - hw / 2, hy - hh / 2, hw, hh);
    g.beginPath(); g.rect(cx - hw / 2, hy - hh / 2, hw, hh); g.clip();
    g.shadowBlur = 3 * dpr; g.strokeStyle = FG; g.lineWidth = 0.25 * u; font(2.4 * u);
    const ppdH = hw / 90;
    for (let a = Math.floor((cur.heading - 50) / 5) * 5; a <= cur.heading + 50; a += 5) {
      const x = cx + (a - cur.heading) * ppdH; const n = ((a % 360) + 360) % 360;
      g.beginPath(); g.moveTo(x, hy + hh / 2); g.lineTo(x, hy + hh / 2 - (n % 15 === 0 ? 1.6 : 0.9) * u); g.stroke();
      if (n % 90 === 0) text(this.cardinals[n / 90] || '', x, hy - 0.4 * u, 'center', ACC);
      else if (n % 30 === 0) text(String(n / 10).padStart(2, '0'), x, hy - 0.4 * u);
    }
    g.restore();
    g.fillStyle = ACC; g.beginPath(); g.moveTo(cx, hy + hh / 2 + 0.3 * u); g.lineTo(cx - 1.3 * u, hy + hh / 2 + 2.4 * u); g.lineTo(cx + 1.3 * u, hy + hh / 2 + 2.4 * u); g.closePath(); g.fill();
    font(3 * u); text(`${String(Math.round(cur.heading) % 360).padStart(3, '0')}°`, cx, hy - hh / 2 - 2.6 * u);

    // --- Alt bilgi satırı ---
    const by = cy + R + 7 * u;
    font(3 * u);
    text(this.state.mode || '—', sx - 11 * u, by, 'left', ACC);
    font(2.4 * u);
    text(this.state.armed ? t('dr.armed') : t('dr.disarmed'), sx - 11 * u, by + 4 * u, 'left', this.state.armed ? BAD : FG);
    const v = num(tg.voltage); const pct = tg.batteryPct;
    const batt = `${v ? v.toFixed(1) : '—'} V${Number.isFinite(pct) && pct >= 0 ? ` · ${pct}%` : ''}`;
    text(batt, cx, by, 'center', Number.isFinite(pct) && pct >= 0 && pct < 25 ? BAD : FG);
    text(`GPS ${tg.gpsFixName || '—'}${Number.isFinite(tg.sats) ? ` · ${tg.sats}` : ''}`, cx, by + 4 * u, 'center', num(tg.gpsFix) >= 3 ? FG : WARN);
    const home = FlightHud.distance(tg.lat, tg.lon, tg.homeLat, tg.homeLon);
    text(`${t('hud.home')} ${home === null ? '—' : home >= 1000 ? `${(home / 1000).toFixed(2)} km` : `${Math.round(home)} m`}`, ax + 11 * u, by, 'right');
    text(`${t('tm.throttle')} ${Number.isFinite(tg.throttle) ? Math.round(tg.throttle) : '—'}%`, ax + 11 * u, by + 4 * u, 'right');
  }

  // İki nokta arası uzaklık (m)
  static distance(lat1, lon1, lat2, lon2) {
    if (![lat1, lon1, lat2, lon2].every((v) => Number.isFinite(v)) || (!lat2 && !lon2) || (!lat1 && !lon1)) return null;
    const r = Math.PI / 180; const R = 6371000;
    const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
}
