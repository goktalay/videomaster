'use strict';

// Kare oynatıcı (JPEG → canvas) ve ses oynatıcı (s16le 48 kHz stereo → Web Audio).
// Kartlarda ve akış penceresinde ortak.

class FramePlayer {
  constructor(canvas, { fit = 'contain' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
    this.fit = fit;
    this.width = 0;
    this.height = 0;
    this.busy = false;
    this.frames = 0;
    this.last = null;
  }

  // Kareyi çizer; bitince true döner (çözülemeyen kare atlanır)
  async push(data) {
    if (this.busy) return false;
    this.busy = true;
    try {
      const bmp = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
      if (this.last) this.last.close();
      this.last = bmp;
      this.width = bmp.width;
      this.height = bmp.height;
      this.draw();
      this.frames++;
      return true;
    } catch {
      return false;
    } finally {
      this.busy = false;
    }
  }

  // Tuvali kutusuna göre boyutlandırır ve son kareyi sığdırma kipine göre çizer
  draw() {
    const bmp = this.last;
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(c.clientWidth * dpr));
    const ch = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const g = this.ctx;
    if (!g) return;
    g.fillStyle = '#000';
    g.fillRect(0, 0, cw, ch);
    if (!bmp) return;
    let w = cw;
    let hh = ch;
    let x = 0;
    let y = 0;
    if (this.fit !== 'fill') {
      const s = this.fit === 'cover' ? Math.max(cw / bmp.width, ch / bmp.height) : Math.min(cw / bmp.width, ch / bmp.height);
      w = bmp.width * s; hh = bmp.height * s; x = (cw - w) / 2; y = (ch - hh) / 2;
    }
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, x, y, w, hh);
  }

  clear() {
    if (this.last) { this.last.close(); this.last = null; }
    this.draw();
  }
}

class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.next = 0;
    this.volume = 1;
    this.muted = false;
    this.level = 0;
  }

  _ensure() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this._apply();
  }

  _apply() { if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume; }
  setVolume(v) { this.volume = Math.max(0, Math.min(2, v)); this._apply(); }
  setMuted(m) { this.muted = !!m; this._apply(); if (!m && this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // data: Uint8Array (s16le, stereo, 48 kHz)
  push(data) {
    this._ensure();
    const n = Math.floor(data.byteLength / 4);
    if (!n) return;
    const view = new DataView(data.buffer, data.byteOffset, n * 4);
    const buf = this.ctx.createBuffer(2, n, 48000);
    const l = buf.getChannelData(0);
    const r = buf.getChannelData(1);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = view.getInt16(i * 4, true) / 32768;
      const b = view.getInt16(i * 4 + 2, true) / 32768;
      l[i] = a; r[i] = b;
      const m = Math.abs(a) > Math.abs(b) ? Math.abs(a) : Math.abs(b);
      if (m > peak) peak = m;
    }
    this.level = Math.max(peak, this.level * 0.85);
    if (this.muted || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    // kuyruk boşaldıysa küçük bir tamponla başla; fazla biriktiyse (gecikme) öne atla
    if (this.next < now + 0.02) this.next = now + 0.08;
    else if (this.next > now + 0.6) this.next = now + 0.08;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(this.next);
    this.next += buf.duration;
  }

  close() { if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; } }
}
