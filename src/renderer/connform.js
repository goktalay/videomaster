'use strict';

// Bağlantı formu: SCHEMA.FIELDS'ten üretilir. Kayıt penceresinde (sekmeli) ve akış penceresindeki
// "Akış ayarları" panelinde (açılır bölümler) aynı alanlar kullanılır.

const PROTO_ICONS = Object.fromEntries(Object.entries(SCHEMA.PROTOCOLS).map(([k, p]) => [k, p.icon]));

// Etiket ve ipucu: önce modele özel (f.<alan>.<model>), sonra protokole özel, sonra genel metin
function fieldLabel(f, c) { return tOpt(`f.${f.key}.${c.model}`, tOpt(`f.${f.key}.${c.protocol}`, t(`f.${f.key}`))); }
function fieldHint(f, c) { return tOpt(`h.${f.key}.${c.model}`, tOpt(`h.${f.key}.${c.protocol}`, tOpt(`h.${f.key}`, ''))); }
function optionLabel(f, v) {
  const raw = f.raw === true || (Array.isArray(f.raw) && f.raw.includes(v));
  return raw ? `${v}${f.suffix || ''}` : t(`o.${f.key}.${v}`);
}

// opts: { compact, caps: { hwaccels, protocols }, onChange }
function buildConnForm(initial, opts = {}) {
  const compact = !!opts.compact;
  const caps = opts.caps || {};
  let c = { ...SCHEMA.defaults(initial && initial.protocol), ...(initial || {}) };
  const isEdit = !!(initial && initial.id);
  const touched = new Set();
  const cols = compact ? 2 : 3;

  const el = h(`<div class="cf ${compact ? 'compact' : ''}">
    <div class="cf-head">
      <div class="field cf-name"><label>${esc(t('cf.name'))}</label><input class="input" data-k="name" maxlength="120" placeholder="${esc(t('cf.namePh'))}"></div>
      <div class="field cf-paste"><label>${esc(t('cf.paste'))}</label><div class="src-pick"><input class="input" spellcheck="false" data-paste placeholder="rtsp://admin:1234@192.168.1.10:554/stream1"></div></div>
    </div>
    <div class="field"><label>${esc(t('cf.protocol'))}</label><div class="protos"></div><small class="hint cf-proto-hint"></small></div>
    <div class="tabs cf-tabs"></div>
    <div class="cf-panels"></div>
    <div class="cf-test hidden"></div>
  </div>`);
  const q = (s) => el.querySelector(s);
  const input = (k) => el.querySelector(`[data-k="${k}"]`);

  // --- Protokol seçimi ---
  const protos = q('.protos');
  for (const id of SCHEMA.PROTOCOL_IDS) {
    const p = SCHEMA.PROTOCOLS[id];
    const b = h(`<button type="button" class="proto" data-p="${id}" style="--c:${p.color}"><span class="pi">${icon(p.icon)}</span><span><b>${esc(t(`proto.${id}`))}</b><small>${esc(t(`proto.${id}.sub`))}</small></span></button>`);
    b.onclick = () => setProtocol(id);
    protos.appendChild(b);
  }

  // --- Sekmeler ve alanlar ---
  const tabsEl = q('.cf-tabs');
  const panels = q('.cf-panels');
  let activeTab = 'general';
  for (const [id, ic] of SCHEMA.TABS) {
    const fields = SCHEMA.FIELDS.filter((f) => f.tab === id);
    const grid = h(`<div class="cf-grid" style="--cols:${cols}"></div>`);
    for (const f of fields) grid.appendChild(fieldEl(f));
    if (compact) {
      const d = h(`<details class="cf-sec" data-tab="${id}" ${id === 'general' ? 'open' : ''}><summary>${icon(ic)}<span>${esc(t(`tab.${id}`))}</span>${icon('chevronDown', 'chev')}</summary></details>`);
      d.appendChild(grid);
      panels.appendChild(d);
    } else {
      const b = h(`<button type="button" data-tab="${id}">${icon(ic)}<span>${esc(t(`tab.${id}`))}</span></button>`);
      b.onclick = () => showTab(id);
      tabsEl.appendChild(b);
      const p = h(`<div class="tab-panel" data-tab="${id}"></div>`);
      p.appendChild(grid);
      panels.appendChild(p);
    }
  }
  if (compact) tabsEl.remove();

  function fieldEl(f) {
    const span = Math.min(f.span || 1, cols);
    let node;
    if (f.type === 'bool') {
      node = h(`<label class="check cf-f" data-f="${f.key}" style="grid-column:span ${compact ? cols : span}"><input type="checkbox" data-k="${f.key}"><span><span class="lbl"></span><small class="hnt"></small></span></label>`);
    } else {
      let ctl;
      if (f.type === 'select') ctl = `<select class="input" data-k="${f.key}">${f.opts.map((v) => `<option value="${esc(v)}">${esc(optionLabel(f, v))}</option>`).join('')}</select>`;
      else if (f.type === 'textarea') ctl = `<textarea class="input" data-k="${f.key}" rows="${f.rows || 3}" spellcheck="false"></textarea>`;
      else if (f.type === 'password') ctl = `<div class="pw-wrap"><input class="input" type="password" data-k="${f.key}" autocomplete="new-password"><button class="icon-btn" type="button" data-eye>${icon('eye')}</button></div>`;
      else if (f.type === 'number') ctl = f.unit
        ? `<div class="unit-wrap"><input class="input" type="number" data-k="${f.key}" min="${f.min}" max="${f.max}"><span>${esc(f.unit)}</span></div>`
        : `<input class="input" type="number" data-k="${f.key}" min="${f.min}" max="${f.max}">`;
      else ctl = `<input class="input ${f.mono ? 'mono' : ''}" data-k="${f.key}" spellcheck="false">`;
      const wide = f.type === 'textarea' ? cols : span;
      node = h(`<div class="field cf-f" data-f="${f.key}" style="grid-column:span ${wide}"><label class="lbl"></label>${ctl}<small class="hint hnt"></small></div>`);
      const eye = node.querySelector('[data-eye]');
      if (eye) eye.onclick = () => { const i = node.querySelector('input'); i.type = i.type === 'password' ? 'text' : 'password'; eye.innerHTML = icon(i.type === 'password' ? 'eye' : 'eyeOff'); };
    }
    enhanceNumbers(node);
    if (f.key === 'sdpText') {
      const b = h(`<button class="btn sm" type="button" style="justify-self:start">${icon('file')}${esc(t('cf.loadSdp'))}</button>`);
      b.onclick = async () => { const txt = await window.api.pickSdp(); if (txt) { node.querySelector('textarea').value = txt; sync(); } };
      node.appendChild(b);
    }
    if (f.key === 'hwaccel' && Array.isArray(caps.hwaccels)) {
      for (const o of node.querySelectorAll('option')) {
        if (!['none', 'auto'].includes(o.value) && !caps.hwaccels.includes(o.value)) { o.disabled = true; o.textContent += ` — ${t('cf.unavailable')}`; }
      }
    }
    return node;
  }

  function showTab(id) {
    activeTab = id;
    tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    panels.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.tab !== id));
  }

  // --- Değerler ---
  function write() {
    input('name').value = c.name || '';
    for (const f of SCHEMA.FIELDS) {
      const i = input(f.key);
      if (f.type === 'bool') i.checked = !!c[f.key];
      else i.value = c[f.key] ?? '';
      if (f.type === 'password') i.placeholder = isEdit && c[`has_${f.key}`] && !touched.has(f.key) ? t('cf.keepSecret') : '';
    }
  }

  function read() {
    c.name = input('name').value;
    for (const f of SCHEMA.FIELDS) {
      const i = input(f.key);
      c[f.key] = f.type === 'bool' ? i.checked : f.type === 'number' ? (i.value === '' ? f.def : Number(i.value)) : i.value;
    }
    return c;
  }

  // Protokole ve diğer alanlara göre görünürlük, etiketler ve ipuçları
  function paint() {
    protos.querySelectorAll('.proto').forEach((b) => b.classList.toggle('on', b.dataset.p === c.protocol));
    const missing = caps.protocols && caps.protocols.length && ['srt', 'rtmp'].includes(c.protocol) && !caps.protocols.includes(c.protocol);
    q('.cf-proto-hint').textContent = missing ? t('cf.protoMissing') : t(`proto.${c.protocol}.hint`);
    q('.cf-proto-hint').classList.toggle('warn', !!missing);
    for (const f of SCHEMA.FIELDS) {
      const node = el.querySelector(`[data-f="${f.key}"]`);
      node.classList.toggle('hidden', !SCHEMA.visible(f, c));
      node.querySelector('.lbl').textContent = fieldLabel(f, c);
      const hint = fieldHint(f, c);
      const hn = node.querySelector('.hnt');
      hn.textContent = hint;
      hn.classList.toggle('hidden', !hint);
    }
    for (const [id] of SCHEMA.TABS) {
      const on = SCHEMA.tabVisible(id, c);
      const b = tabsEl.querySelector(`[data-tab="${id}"]`);
      if (b) b.classList.toggle('hidden', !on);
      const sec = panels.querySelector(`.cf-sec[data-tab="${id}"]`);
      if (sec) sec.classList.toggle('hidden', !on);
      if (!on && activeTab === id && !compact) showTab('general');
    }
  }

  function setProtocol(id) {
    read();
    const prev = SCHEMA.PROTOCOLS[c.protocol];
    const next = SCHEMA.PROTOCOLS[id];
    // port hâlâ eski protokolün varsayılanıysa yenisinin varsayılanına geçir
    const prevDef = [prev.port, prev.securePort];
    if (!c.port || prevDef.includes(c.port)) c.port = next.port || c.port;
    c.protocol = id;
    if (!next.secureScheme) c.secure = false;
    if (id === 'rtp' && c.rtpVideoCodec === 'none' && c.rtpAudioCodec === 'none') c.rtpVideoCodec = 'H264';
    write();
    paint();
    changed();
  }

  function sync(e) {
    const k = e && e.target && e.target.dataset ? e.target.dataset.k : null;
    if (k) touched.add(k);
    const before = { ...c };
    read();
    if (k === 'secure') {
      const p = SCHEMA.PROTOCOLS[c.protocol];
      if (c.port === (c.secure ? p.port : p.securePort)) { c.port = c.secure ? p.securePort : p.port; input('port').value = c.port; }
    }
    // Kamera modeli seçilince modelin varsayılanları (adres, yol, kontrol portu...) uygulanır; girilmiş bilgiler korunur
    if (k === 'model' && before.model !== c.model) { Object.assign(c, SCHEMA.applyModel(c, c.model, before.model)); write(); if (!compact && SCHEMA.modelOf(c)) toast(t('cf.modelApplied'), { type: 'ok', timeout: 2600 }); }
    // RTP: kodek seçilince yük türü ve saat hızı önerilir
    if (k === 'rtpVideoCodec' && SCHEMA.RTP_VIDEO[c.rtpVideoCodec]) { const d = SCHEMA.RTP_VIDEO[c.rtpVideoCodec]; c.rtpVideoPt = d.pt; c.rtpVideoRate = d.rate; write(); }
    if (k === 'rtpAudioCodec' && SCHEMA.RTP_AUDIO[c.rtpAudioCodec]) { const d = SCHEMA.RTP_AUDIO[c.rtpAudioCodec]; c.rtpAudioPt = d.pt; c.rtpAudioRate = d.rate; c.rtpAudioChannels = d.ch; write(); }
    if (k && el.querySelector(`[data-k="${k}"]`)) el.querySelector(`[data-k="${k}"]`).classList.remove('invalid');
    if (JSON.stringify(before) !== JSON.stringify(c)) { paint(); changed(); }
  }
  const changed = () => { if (opts.onChange) opts.onChange(values()); };
  el.addEventListener('input', sync);
  el.addEventListener('change', sync);

  // Yapıştırılan adresi alanlara dağıt
  const paste = q('[data-paste]');
  const applyPaste = () => {
    const text = paste.value.trim();
    if (!text) return;
    const parsed = SCHEMA.parseUrl(text);
    if (!parsed) { paste.classList.add('invalid'); return; }
    paste.classList.remove('invalid');
    read();
    Object.assign(c, parsed);
    if ('password' in parsed) touched.add('password');
    if (!c.name) c.name = parsed.host || '';
    write();
    paint();
    changed();
    paste.value = '';
    toast(t('cf.pasted'), { type: 'ok', timeout: 1800 });
  };
  paste.addEventListener('paste', () => setTimeout(applyPaste, 0));
  paste.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); applyPaste(); } });
  paste.addEventListener('input', (e) => e.stopPropagation());

  // Boş bırakılan (dokunulmamış) gizli alanlar kayıtlı değerini korur
  function values() {
    read();
    const out = { ...c };
    for (const f of SCHEMA.FIELDS) if (f.type === 'password') out[`keep_${f.key}`] = isEdit && !touched.has(f.key) && !out[f.key];
    return out;
  }

  function markInvalid(keys) {
    el.querySelectorAll('.invalid').forEach((x) => x.classList.remove('invalid'));
    let first = null;
    for (const k of keys) {
      const i = input(k);
      if (!i) continue;
      i.classList.add('invalid');
      if (!first) first = i;
    }
    if (!first) return;
    const f = SCHEMA.FIELD_BY_KEY[first.dataset.k];
    if (f && !compact) showTab(f.tab);
    if (f && compact) { const sec = panels.querySelector(`.cf-sec[data-tab="${f.tab}"]`); if (sec) sec.open = true; }
    first.focus();
  }

  // "Bağlantıyı sına"
  async function test(btn) {
    const box = q('.cf-test');
    box.className = 'cf-test';
    box.innerHTML = `<span class="spin"></span><span>${esc(t('cf.testing'))}</span>`;
    if (btn) btn.disabled = true;
    const r = await window.api.testConnection(values()).catch((e) => ({ ok: false, error: { code: 'error', detail: e.message } }));
    if (btn) btn.disabled = false;
    if (r.invalid) { box.classList.add('hidden'); markInvalid(r.invalid); return r; }
    if (r.ok) {
      const v = r.info && r.info.streams.find((s) => s.type === 'video');
      const a = r.info && r.info.streams.find((s) => s.type === 'audio');
      const parts = [];
      if (v) parts.push(`${v.codec.toUpperCase()}${v.profile ? ` (${v.profile})` : ''} · ${v.width}×${v.height}${v.fps ? ` · ${v.fps} fps` : ''}`);
      if (a) parts.push(`${a.codec.toUpperCase()} · ${a.sampleRate} Hz${a.layout ? ` · ${a.layout}` : ''}`);
      box.classList.add('ok');
      box.innerHTML = `${r.frame ? `<img src="${r.frame}" alt="">` : `<span class="ti">${icon('check')}</span>`}<div><b>${esc(t('cf.testOk'))}</b><small>${esc(parts.join('  |  ') || (r.info ? r.info.format : ''))}</small></div>`;
    } else {
      box.classList.add('err');
      box.innerHTML = `<span class="ti">${icon('x')}</span><div><b>${esc(t('cf.testFail'))}</b><small>${esc(streamError(r.error))}</small></div>`;
    }
    return r;
  }

  write();
  paint();
  if (!compact) showTab('general');
  return { el, values, markInvalid, test, setValues: (next) => { c = { ...SCHEMA.defaults(next.protocol), ...next }; touched.clear(); write(); paint(); } };
}

// Yeni bağlantı / bağlantı ayarları penceresi. Kaydedilirse bağlantı kimliği döner.
async function editConnection(conn, { folderId = null, settings = {} } = {}) {
  const about = await window.api.about();
  const initial = conn ? await window.api.getConnection(conn.id) : { ...SCHEMA.defaults('rtsp'), recFormat: settings.recordFormat || 'mp4', folderId };
  if (!initial) return null;
  const form = buildConnForm(initial, { caps: about });
  return openModal({
    title: conn ? t('cf.editTitle') : t('cf.newTitle'), iconName: conn ? 'gear' : 'plus', width: 820, body: form.el,
    buttons: [
      { label: t('cf.test'), icon: 'flask', left: true, onClick: async (_m, btn) => { await form.test(btn); return false; } },
      { label: t('common.cancel'), value: null },
      {
        label: t('common.save'), cls: 'primary',
        onClick: async () => {
          const v = form.values();
          const r = await window.api.saveConnection({ ...v, id: conn ? conn.id : undefined, folderId: conn ? conn.folderId : folderId });
          if (!r.ok) { form.markInvalid(r.invalid || []); toast(t('cf.invalid'), { type: 'err' }); return false; }
          return r.id;
        },
      },
    ],
  });
}
