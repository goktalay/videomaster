'use strict';

// Akış verisi görünümü: HEX / ASCII / ikili / ondalık / Base64 kipleri; sürekli akış, paket listesi ve
// sinyalleşme (RTSP) iletileri. Canlıyken tamponun sonu izlenir; duraklatınca tamponun tamamında gezilir.

const HV_ROW = 18; // satır yüksekliği (px)
const hex2 = (n) => (n < 16 ? '0' : '') + n.toString(16);
const printable = (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
const escCh = (ch) => (ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch);

class HexView {
  constructor(host, { id, settings = {} }) {
    this.host = host;
    this.id = id;
    this.mode = settings.hexMode || 'hex';
    this.bpr = Number(settings.hexBytesPerRow) || 16;
    this.source = 'stream';
    this.paused = false;
    this.view = { base: 0, data: new Uint8Array(0) };
    this.snap = null;
    this.packets = [];
    this.messages = [];
    this.selected = null;
    this.total = 0;
    this.tapKind = null;
    this.skipped = 0;
    host.classList.add('hv');
    host.innerHTML = `
      <div class="hv-bar">
        <div class="seg sm" data-r="mode">${['hex', 'ascii', 'bin', 'dec', 'b64'].map((m) => `<button type="button" data-v="${m}" title="${esc(t(`hex.mode.${m}`))}">${esc(t(`hex.short.${m}`))}</button>`).join('')}</div>
        <div class="seg sm" data-r="source">
          <button type="button" data-v="stream">${esc(t('hex.stream'))}</button>
          <button type="button" data-v="packets">${esc(t('hex.packets'))}</button>
          <button type="button" data-v="messages">${esc(t('hex.messages'))}</button>
        </div>
        <select class="input sm" data-r="bpr" title="${esc(t('set.hexBytes'))}">${[8, 16, 24, 32].map((n) => `<option value="${n}">${n}</option>`).join('')}</select>
        <button class="btn sm" data-r="pause"></button>
        <button class="icon-btn" data-r="copy" title="${esc(t('hex.copy'))}">${icon('copy')}</button>
        <button class="icon-btn" data-r="save" title="${esc(t('hex.save'))}">${icon('download')}</button>
        <button class="icon-btn" data-r="clear" title="${esc(t('hex.clear'))}">${icon('broom')}</button>
        <span style="flex:1"></span>
        <span class="hv-status"></span>
      </div>
      <div class="hv-body">
        <div class="hv-list hidden"><div class="hv-list-in"><div class="hv-rows"></div></div></div>
        <div class="hv-data"><div class="hv-data-in"><pre class="hv-rows"></pre></div><div class="hv-empty hidden"></div></div>
        <pre class="hv-text hidden"></pre>
      </div>`;
    const r = (n) => host.querySelector(`[data-r="${n}"]`);
    this.el = { mode: r('mode'), source: r('source'), bpr: r('bpr'), pause: r('pause'), status: host.querySelector('.hv-status'),
      list: host.querySelector('.hv-list'), listIn: host.querySelector('.hv-list-in'), listRows: host.querySelector('.hv-list .hv-rows'),
      data: host.querySelector('.hv-data'), dataIn: host.querySelector('.hv-data-in'), rows: host.querySelector('.hv-data .hv-rows'),
      empty: host.querySelector('.hv-empty'), text: host.querySelector('.hv-text') };
    this.el.bpr.value = String(this.bpr);
    this.el.mode.onclick = (e) => { const b = e.target.closest('button'); if (b) { this.mode = b.dataset.v; window.api.setSettings({ hexMode: this.mode }); this.paint(); } };
    this.el.source.onclick = (e) => { const b = e.target.closest('button'); if (b) this.setSource(b.dataset.v); };
    this.el.bpr.onchange = () => { this.bpr = Number(this.el.bpr.value); window.api.setSettings({ hexBytesPerRow: this.bpr }); this.paint(); };
    this.el.pause.onclick = () => this.setPaused(!this.paused);
    r('clear').onclick = async () => { await window.api.tapClear(this.id); this.packets = []; this.messages = []; this.selected = null; this.snap = null; this.view = { base: 0, data: new Uint8Array(0) }; if (this.paused) await this.setPaused(false); this.paint(); };
    r('save').onclick = async () => {
      const whole = !(this.source === 'packets' && this.selected);
      const file = await window.api.tapSave(this.id, whole ? 0 : this.view.base, whole ? 0 : this.view.data.length);
      if (file) toast(t('hex.saved'), { type: 'ok', sub: file });
    };
    r('copy').onclick = () => {
      const text = this.source === 'messages' ? this.el.text.textContent : this.rowsText(0, Math.min(this.rowCount(), 4096), false);
      window.api.copyText(text);
      toast(t('hex.copied'), { type: 'ok', timeout: 1500 });
    };
    this.el.data.addEventListener('scroll', () => this.paintData());
    this.el.list.addEventListener('scroll', () => this.paintList());
    this.el.listRows.addEventListener('click', (e) => {
      const row = e.target.closest('[data-i]');
      if (row) this.select(Number(row.dataset.i));
    });
    new ResizeObserver(() => this.paint()).observe(host);
    this.timer = setInterval(() => this.poll(), 250);
    this.paint();
  }

  destroy() { clearInterval(this.timer); }

  // --- Veri ---------------------------------------------------------------------
  // Kipin bir satırda gösterdiği bayt sayısı
  rowBytes() {
    if (this.mode === 'ascii') return this.bpr * 4;
    if (this.mode === 'bin') return Math.max(4, Math.min(8, this.bpr / 2));
    if (this.mode === 'b64') return 48;
    return this.bpr;
  }
  rowCount() { return Math.ceil(this.view.data.length / this.rowBytes()); }
  visibleRows() { return Math.max(4, Math.floor(this.el.data.clientHeight / HV_ROW)); }

  async poll() {
    if (this.paused || !this.host.offsetParent || this.polling) return;
    this.polling = true;
    try {
      const want = this.visibleRows() * this.rowBytes();
      const r = await window.api.tapTail(this.id, want);
      if (!r || this.paused) { if (!r) { this.total = 0; this.paintStatus(); } return; }
      this.total = r.total;
      if (r.packets.length) {
        this.packets.push(...r.packets);
        if (this.packets.length > 1500) this.packets.splice(0, this.packets.length - 1500);
      }
      this.skipped += r.skipped || 0;
      if (r.messages.length) { this.messages.push(...r.messages); if (this.messages.length > 300) this.messages.splice(0, this.messages.length - 300); }
      if (this.source === 'stream') {
        // satırlar kaymasın diye başlangıç satır sınırına hizalanır
        const rb = this.rowBytes();
        const cut = (rb - (r.base % rb)) % rb;
        this.view = { base: r.base + cut, data: r.data.subarray(cut) };
        this.paintData(true);
      } else if (this.source === 'packets') {
        this.paintList(true);
      } else if (r.messages.length) this.paintList(true);
      this.paintStatus();
    } catch { /* pencere kapanırken */ } finally { this.polling = false; }
  }

  async setPaused(p) {
    this.paused = p;
    if (p) {
      this.snap = await window.api.tapSnapshot(this.id);
      if (this.snap) {
        this.total = this.snap.total;
        this.packets = this.snap.packets;
        this.messages = this.snap.messages;
        if (this.source === 'stream') { this.view = { base: this.snap.base, data: this.snap.data }; }
      }
    } else { this.snap = null; this.selected = null; this.skipped = 0; }
    this.paint();
    if (p && this.source === 'stream') this.el.data.scrollTop = this.el.data.scrollHeight;
  }

  async setSource(s) {
    this.source = s;
    this.selected = null;
    if (s === 'stream' && this.paused && this.snap) this.view = { base: this.snap.base, data: this.snap.data };
    if (s !== 'stream' && !this.paused) this.view = { base: 0, data: new Uint8Array(0) };
    this.paint();
    if (s === 'messages') this.select(this.messages.length - 1);
  }

  // Paket ya da ileti seçimi: paket baytlarını göstermek için akış duraklatılır
  async select(i) {
    if (this.source === 'messages') {
      this.selected = this.messages[i] || null;
      this.el.text.textContent = this.selected ? this.selected.text : '';
      return this.paintList();
    }
    const live = this.packets[i];
    if (!live) return;
    if (!this.paused) {
      await this.setPaused(true);
      i = this.packets.findIndex((p) => p.n === live.n);
      if (i < 0) i = 0; // paket tampondan çıkmış: tamponda duran en eski paketi göster
      if (!this.packets[i]) return this.paint();
    }
    const p = this.packets[i];
    this.selected = p;
    const start = p.off - this.snap.base;
    this.view = start >= 0 ? { base: p.off, data: this.snap.data.subarray(start, start + p.len) } : { base: p.off, data: new Uint8Array(0) };
    this.el.data.scrollTop = 0;
    this.paint();
  }

  // --- Çizim --------------------------------------------------------------------
  rowsText(first, count, html) {
    const { base, data } = this.view;
    const rb = this.rowBytes();
    const out = [];
    for (let r = first; r < first + count; r++) {
      const s = r * rb;
      if (s >= data.length) break;
      const e = Math.min(data.length, s + rb);
      const off = ((base + s) >>> 0).toString(16).padStart(8, '0');
      let body = '';
      let side = '';
      if (this.mode === 'hex') {
        for (let i = s; i < s + rb; i++) { body += (i < e ? hex2(data[i]) : '  ') + ((i - s) % 8 === 7 ? '  ' : ' '); if (i < e) side += html ? escCh(printable(data[i])) : printable(data[i]); }
      } else if (this.mode === 'ascii') {
        for (let i = s; i < e; i++) body += html ? escCh(printable(data[i])) : printable(data[i]);
      } else if (this.mode === 'bin') {
        for (let i = s; i < s + rb; i++) { body += (i < e ? data[i].toString(2).padStart(8, '0') : '        ') + ' '; if (i < e) side += html ? escCh(printable(data[i])) : printable(data[i]); }
      } else if (this.mode === 'dec') {
        for (let i = s; i < s + rb; i++) { body += (i < e ? String(data[i]).padStart(3, ' ') : '   ') + ((i - s) % 8 === 7 ? '  ' : ' '); if (i < e) side += html ? escCh(printable(data[i])) : printable(data[i]); }
      } else {
        let bin = '';
        for (let i = s; i < e; i++) bin += String.fromCharCode(data[i]);
        body = btoa(bin);
      }
      out.push(html ? `<span class="o">${off}</span>  ${body}${side ? `<span class="a">${side}</span>` : ''}` : `${off}  ${body}${side ? ' ' + side : ''}`);
    }
    return out.join('\n');
  }

  paintData(live = false) {
    const rows = this.rowCount();
    const vis = this.visibleRows();
    const scroll = this.paused || this.source === 'packets';
    this.el.data.classList.toggle('scroll', scroll);
    let first = 0;
    if (scroll) {
      this.el.dataIn.style.height = `${rows * HV_ROW}px`;
      first = Math.max(0, Math.floor(this.el.data.scrollTop / HV_ROW) - 2);
      this.el.rows.style.transform = `translateY(${first * HV_ROW}px)`;
      this.el.rows.innerHTML = this.rowsText(first, vis + 6, true);
    } else {
      this.el.dataIn.style.height = '';
      this.el.rows.style.transform = '';
      first = Math.max(0, rows - vis);
      this.el.rows.innerHTML = this.rowsText(first, vis, true);
    }
    const empty = !this.view.data.length;
    this.el.empty.textContent = this.total || live ? t('hex.waiting') : t('hex.noData');
    this.el.empty.classList.toggle('hidden', !empty);
  }

  packetRow(p, i) {
    const d = new Date(p.t);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    let info = p.info || '';
    if (p.kind === 'rtp') info = `PT ${p.pt}${p.codec ? ' ' + p.codec : ''} · seq ${p.seq} · ts ${p.ts}${p.m ? ' · M' : ''}${p.info ? ' · ' + p.info : ''}`;
    else if (p.kind === 'rtcp') info = `${p.info} · SSRC ${(p.ssrc >>> 0).toString(16)}`;
    return `<div class="hv-pk ${this.selected && this.selected.n === p.n ? 'on' : ''} k-${p.kind} ${/^IDR|^CRA/.test(p.info || '') ? 'key' : ''}" data-i="${i}">
      <span class="n">${p.n}</span><span class="tm">${time}</span><span class="dr ${p.dir}">${p.dir === 'out' ? '↑' : '↓'}</span>
      <span class="kd">${esc(p.kind.toUpperCase())}${p.ch != null ? ` <i>ch${p.ch}</i>` : ''}</span><span class="ln">${p.len}</span><span class="in">${esc(info)}</span></div>`;
  }

  messageRow(m, i) {
    const first = m.text.split(/\r?\n/, 1)[0];
    const d = new Date(m.t);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    return `<div class="hv-pk ${this.selected && this.selected.n === m.n ? 'on' : ''} k-rtsp" data-i="${i}"><span class="tm">${time}</span><span class="dr ${m.dir}">${m.dir === 'out' ? '↑' : '↓'}</span><span class="in">${esc(first)}</span></div>`;
  }

  paintList(follow = false) {
    const items = this.source === 'messages' ? this.messages : this.packets;
    const box = this.el.list;
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - HV_ROW * 2;
    this.el.listIn.style.height = `${items.length * HV_ROW}px`;
    if (follow && atEnd && !this.paused) box.scrollTop = box.scrollHeight;
    const first = Math.max(0, Math.floor(box.scrollTop / HV_ROW) - 3);
    const count = Math.ceil(box.clientHeight / HV_ROW) + 8;
    this.el.listRows.style.transform = `translateY(${first * HV_ROW}px)`;
    let html = '';
    for (let i = first; i < Math.min(items.length, first + count); i++) html += this.source === 'messages' ? this.messageRow(items[i], i) : this.packetRow(items[i], i);
    this.el.listRows.innerHTML = html || `<div class="hv-none">${esc(this.source === 'messages' ? t('hex.noMessages') : t('hex.noPackets'))}</div>`;
  }

  paintStatus() {
    const kind = this.tapKind ? t(`hex.kind.${this.tapKind}`) : t('hex.kind.none');
    this.el.status.innerHTML = `<b>${formatSize(this.total)}</b> · ${esc(kind)}${this.paused ? ` · <span class="warn">${esc(t('hex.paused'))}</span>` : ''}`;
    this.el.status.title = this.tapKind ? t(`hex.kindHint.${this.tapKind}`) : '';
  }

  setTapKind(k) { if (k !== this.tapKind) { this.tapKind = k; this.paintStatus(); } }

  paint() {
    this.el.mode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === this.mode));
    this.el.source.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === this.source));
    this.el.pause.innerHTML = this.paused ? `${icon('play')}${esc(t('hex.resume'))}` : `${icon('pause')}${esc(t('hex.pause'))}`;
    this.el.pause.classList.toggle('primary', this.paused);
    this.el.bpr.disabled = this.mode === 'b64';
    const s = this.source;
    this.el.list.classList.toggle('hidden', s === 'stream');
    // paket seçilmeden liste tüm genişliği kullanır; seçilince yanında baytları açılır
    this.el.data.classList.toggle('hidden', s === 'messages' || (s === 'packets' && !this.selected));
    this.el.list.classList.toggle('wide', s === 'packets' && !this.selected);
    this.el.text.classList.toggle('hidden', s !== 'messages');
    this.el.mode.classList.toggle('disabled', s === 'messages');
    if (s !== 'stream') this.paintList();
    if (s !== 'messages') this.paintData();
    this.paintStatus();
  }
}
