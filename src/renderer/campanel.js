'use strict';

// Kamera kontrol paneli: seçili kamera modelinin tanımındaki (src/models/<model>.js → panel) bölümlerden üretilir.
// Denetim türleri: joystick, buttons, holds (basılı tutulan), form, select, pick (videoda nokta seçimi), json, raw.
// Metinler modelin kendi sözlüğünden gelir: cam.<model>.<komut>, cam.<model>.g.<bölüm>, cam.<model>.s.<durum alanı>...

// opts: { id, def, conn, onPick(control|null) }  → { el, setState, setStatus, addLog, reply, setConn, pickDone, destroy }
function buildCamPanel(opts) {
  const { id, def } = opts;
  let conn = opts.conn;
  let camState = null;
  let picking = null;
  const K = (s) => `cam.${def.id}.${s}`;
  const L = (s, fallback) => tOpt(K(s), fallback === undefined ? s : fallback);
  const openGroups = new Set(def.panel.filter((g) => g.open).map((g) => g.id));
  const logs = [];

  const el = h(`<div class="cam">
    <div class="cam-link">
      <span class="state-chip" data-chip></span>
      <span class="cam-remote mono" data-remote></span>
      <span style="flex:1"></span>
      <button class="btn sm" type="button" data-conn></button>
    </div>
    <div class="cam-warn hidden" data-warn></div>
    <div class="cam-tests" data-tests></div>
    <details class="cf-sec cam-sec" data-g="_status" open><summary>${icon('signal')}<span>${esc(t('cam.status'))}</span>${icon('chevronDown', 'chev')}</summary><div class="kvs cam-status" data-status></div></details>
    <div data-groups></div>
    <details class="cf-sec cam-sec" data-g="_log"><summary>${icon('terminal')}<span>${esc(t('cam.log'))}</span>${icon('chevronDown', 'chev')}</summary>
      <div class="cam-log" data-log></div><button class="btn sm" type="button" data-clear style="margin:6px 0 2px">${icon('broom')}${esc(t('cam.clear'))}</button></details>
  </div>`);
  const q = (s) => el.querySelector(s);

  // --- Komut gönderme ---
  async function run(cmd, args, confirmKey) {
    if (confirmKey) {
      const ok = await confirmBox(L(cmd), esc(L(confirmKey, t('cam.confirm'))), { okText: t('cam.send'), danger: false });
      if (!ok) return null;
    }
    const r = await window.api.camExec(id, cmd, args || {});
    if (!r || !r.ok) {
      const code = (r && r.error) || 'error';
      toast(tOpt(`cam.err.${code}`, t('cam.err.error')), { type: 'err', sub: L(cmd), timeout: 4200 });
    } else if (r.opened) toast(t('cam.opened'), { type: 'ok', sub: r.opened, timeout: 3200 });
    return r;
  }

  // Basılı tutulan komutlar: bırakılana kadar 200 ms'de bir tazelenir (ana süreç tazelenmeyeni kendisi bırakır)
  let holdTimer = null;
  let holdCmd = null;
  function holdStart(cmd, getArgs) {
    holdStop();
    holdCmd = cmd;
    const send = () => window.api.camHold(id, cmd, getArgs());
    send();
    holdTimer = setInterval(send, 200);
  }
  function holdStop() {
    if (!holdCmd) return;
    clearInterval(holdTimer);
    window.api.camHold(id, holdCmd, null);
    holdCmd = null;
  }
  addEventListener('blur', holdStop);

  // --- Denetimler ---
  const numInput = (f) => `<label class="cam-in"><span>${esc(L(f.name))}</span>${f.options
    ? `<select class="input" data-n="${f.name}">${f.options.map((v, i) => `<option value="${esc(v)}" ${v === f.def ? 'selected' : ''}>${esc(f.labels ? f.labels[i] : f.raw ? String(v) : L(`${f.name}.${v}`, String(v)))}</option>`).join('')}</select>`
    : f.text
    ? `<input class="input mono" data-n="${f.name}" value="${esc(f.def ?? '')}" spellcheck="false">`
    : `<span class="unit-wrap"><input class="input" type="number" data-n="${f.name}" min="${f.min}" max="${f.max}" step="${f.step || 1}" value="${f.def ?? 0}">${f.unit ? `<span>${esc(f.unit)}</span>` : ''}</span>`}</label>`;
  const readFields = (node, fields) => {
    const out = {};
    for (const f of fields) {
      const i = node.querySelector(`[data-n="${f.name}"]`);
      if (f.options) { const hit = f.options.find((v) => String(v) === i.value); out[f.name] = hit === undefined ? i.value : hit; }
      else if (f.text) out[f.name] = i.value.trim();
      else {
        let v = Number(i.value);
        if (!Number.isFinite(v)) v = f.def ?? 0;
        v = Math.max(f.min, Math.min(f.max, v));
        i.value = String(v);
        out[f.name] = v;
      }
    }
    return out;
  };
  const optLabel = (cmd, c, v, idx) => (c.labels ? c.labels[idx] : c.raw ? String(v) : L(`${cmd}.${v}`, String(v)));

  function control(c) {
    if (c.type === 'buttons' || c.type === 'holds') {
      const node = h('<div class="cam-btns"></div>');
      for (const it of c.items) {
        const b = h(`<button class="btn sm ${c.type === 'holds' ? 'hold' : ''}" type="button" data-cmd="${it.cmd}">${icon(it.icon || 'bolt')}<span>${esc(L(it.cmd))}</span></button>`);
        if (c.type === 'holds') {
          b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('on'); holdStart(it.cmd, () => ({})); });
          const up = () => { b.classList.remove('on'); holdStop(); };
          b.addEventListener('pointerup', up);
          b.addEventListener('pointercancel', up);
          b.addEventListener('lostpointercapture', up);
        } else b.onclick = () => run(it.cmd, {}, it.confirm ? `${it.cmd}.confirm` : null);
        if (!it.local) b.dataset.needs = '1';
        node.appendChild(b);
      }
      return node;
    }
    if (c.type === 'form') {
      const node = h(`<div class="cam-form"><div class="cam-title">${esc(L(c.cmd))}</div><div class="cam-row">${c.fields.map(numInput).join('')}<button class="btn sm primary" type="button" data-needs="1">${esc(t('cam.send'))}</button></div></div>`);
      const go = () => run(c.cmd, readFields(node, c.fields), c.confirm ? `${c.cmd}.confirm` : null);
      node.querySelector('button').onclick = go;
      node.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      return node;
    }
    if (c.type === 'select') {
      const x = c.extra;
      const node = h(`<div class="cam-form"><div class="cam-title">${esc(L(c.cmd))}</div><div class="cam-row">
        <select class="input" data-main>${c.options.map((v, i) => `<option value="${esc(v)}" ${v === c.def ? 'selected' : ''}>${esc(optLabel(c.cmd, c, v, i))}</option>`).join('')}</select>
        ${x ? `<label class="cam-in"><span>${esc(L(x.name))}</span><select class="input" data-extra>${x.options.map((v, i) => `<option value="${esc(v)}" ${v === x.def ? 'selected' : ''}>${esc(optLabel(x.name, x, v, i))}</option>`).join('')}</select></label>` : ''}
        <button class="btn sm primary" type="button" data-needs="1">${esc(t('cam.send'))}</button></div></div>`);
      const val = (sel, list) => { const hit = list.find((v) => String(v) === sel.value); return hit === undefined ? sel.value : hit; };
      node.querySelector('button').onclick = () => {
        const args = { [c.arg]: val(node.querySelector('[data-main]'), c.options) };
        if (x) args[x.name] = val(node.querySelector('[data-extra]'), x.options);
        run(c.cmd, args, c.confirm ? `${c.cmd}.confirm` : null);
      };
      return node;
    }
    if (c.type === 'pick') {
      const node = h(`<div class="cam-form"><button class="btn sm cam-pick" type="button" data-needs="1">${icon('crosshair')}<span>${esc(L('pick', t('cam.pick')))}</span></button><small class="hint">${esc(L('pickHint', t('cam.pickHint')))}</small></div>`);
      const b = node.querySelector('button');
      b.onclick = () => {
        picking = picking === c ? null : c;
        el.querySelectorAll('.cam-pick').forEach((x) => x.classList.toggle('on', x === b && !!picking));
        opts.onPick(picking);
      };
      return node;
    }
    if (c.type === 'joystick') {
      const node = h(`<div class="cam-joy"><div class="joy-pad" data-needs="1"><i class="jx u">${icon('up')}</i><i class="jx r">${icon('up')}</i><i class="jx d">${icon('up')}</i><i class="jx l">${icon('up')}</i><span class="joy-knob"></span></div>
        <div class="joy-side"><label class="cam-in"><span>${esc(t('cam.speed'))}</span><span class="unit-wrap"><input class="input" type="number" data-speed min="1" max="${c.max || 100}" value="${Number(conn[c.speedKey]) || 20}"><span>${esc(c.unit || '°/s')}</span></span></label>
        <div class="joy-val mono" data-joyval>0 / 0</div><small class="hint">${esc(t('cam.joyHint'))}</small></div></div>`);
      const pad = node.querySelector('.joy-pad');
      const knob = node.querySelector('.joy-knob');
      const out = node.querySelector('[data-joyval]');
      let vec = { yaw: 0, pitch: 0 };
      const speed = () => Math.max(1, Math.min(c.max || 100, Number(node.querySelector('[data-speed]').value) || 20));
      const move = (e) => {
        const r = pad.getBoundingClientRect();
        const R = r.width / 2;
        let dx = (e.clientX - (r.left + R)) / (R - 14);
        let dy = (e.clientY - (r.top + R)) / (R - 14);
        const len = Math.hypot(dx, dy);
        if (len > 1) { dx /= len; dy /= len; }
        const dead = (v) => (Math.abs(v) < 0.12 ? 0 : v);
        knob.style.transform = `translate(${dx * (R - 14)}px, ${dy * (R - 14)}px)`;
        vec = { yaw: Math.round(dead(dx) * speed()), pitch: Math.round(-dead(dy) * speed()) };
        out.textContent = `${vec.yaw} / ${vec.pitch}`;
      };
      const up = () => {
        if (!pad.classList.contains('on')) return;
        pad.classList.remove('on');
        knob.style.transform = '';
        vec = { yaw: 0, pitch: 0 };
        out.textContent = '0 / 0';
        holdStop();
      };
      pad.addEventListener('pointerdown', (e) => {
        if (pad.classList.contains('off')) return;
        e.preventDefault();
        pad.setPointerCapture(e.pointerId);
        pad.classList.add('on');
        move(e);
        holdStart(c.cmd, () => vec);
      });
      pad.addEventListener('pointermove', (e) => { if (pad.classList.contains('on')) move(e); });
      pad.addEventListener('pointerup', up);
      pad.addEventListener('pointercancel', up);
      pad.addEventListener('lostpointercapture', up);
      return node;
    }
    if (c.type === 'json' || c.type === 'raw') {
      const ph = c.type === 'json' ? (c.placeholder || '{"sh":"ifconfig"}') : (c.placeholder || '71 00 00 00 00');
      const node = h(`<div class="cam-form"><div class="cam-title">${esc(L(c.cmd))}</div><div class="cam-row"><input class="input mono grow" spellcheck="false" ${c.max ? `maxlength="${c.max}"` : ''} placeholder="${esc(ph)}"><button class="btn sm primary" type="button" data-needs="1">${esc(t('cam.send'))}</button></div>${c.type === 'raw' ? `<small class="hint">${esc(L('rawHint', t('cam.rawHint')))}</small>` : ''}</div>`);
      const i = node.querySelector('input');
      const go = () => { if (i.value.trim()) run(c.cmd, c.type === 'json' || c.as === 'text' ? { text: i.value.trim() } : { hex: i.value.trim() }); };
      node.querySelector('button').onclick = go;
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      return node;
    }
    return h('<div></div>');
  }

  const groups = q('[data-groups]');
  for (const g of def.panel) {
    const d = h(`<details class="cf-sec cam-sec" data-g="${g.id}" ${openGroups.has(g.id) ? 'open' : ''}><summary>${icon(g.icon || 'gear')}<span>${esc(L(`g.${g.id}`))}</span>${icon('chevronDown', 'chev')}</summary><div class="cam-ctl"></div></details>`);
    for (const c of g.controls) d.querySelector('.cam-ctl').appendChild(control(c));
    groups.appendChild(d);
  }

  // --- Bağlantı durumu ---
  q('[data-conn]').onclick = async () => {
    const b = q('[data-conn]');
    b.disabled = true;
    try {
      if (camState && camState.connected) await window.api.camDisconnect(id);
      else setState(await window.api.camConnect(id));
    } finally { b.disabled = false; }
  };

  function setState(st) {
    camState = st || null;
    const on = !!(st && st.connected);
    const linked = on && st.linked;
    const chip = q('[data-chip]');
    chip.className = `state-chip s-${linked ? 'playing' : on ? 'connecting' : st && st.error ? 'error' : 'idle'}`;
    chip.innerHTML = `${on && !linked ? '<span class="spin"></span>' : '<i></i>'}${esc(linked ? t('cam.st.linked') : on ? t('cam.st.waiting') : st && st.error ? tOpt(`cam.err.${st.error}`, t('cam.err.error')) : t('cam.st.off'))}`;
    q('[data-remote]').textContent = st && st.remote ? st.remote : `${conn.camCtrlHost || conn.host || ''}${conn.camCtrlPort ? `:${conn.camCtrlPort}` : ''}`;
    q('[data-conn]').innerHTML = `${icon(on ? 'x' : 'link')}${esc(on ? t('cam.disconnect') : t('cam.connect'))}`;
    q('[data-conn]').classList.toggle('primary', !on);
    const warn = q('[data-warn]');
    const msg = on && st.fallbackPort ? t('cam.portFallback', { port: conn.camLocalPort, local: st.local }) : '';
    warn.textContent = msg;
    warn.classList.toggle('hidden', !msg);
    el.querySelectorAll('[data-needs]').forEach((n) => { if (n.tagName === 'BUTTON') n.disabled = !on; else n.classList.toggle('off', !on); });
    if (!on) { holdStop(); if (picking) { picking = null; el.querySelectorAll('.cam-pick').forEach((x) => x.classList.remove('on')); opts.onPick(null); } }
    if (!linked) setStatus(null);
  }

  // --- Kameranın bildirdiği durum ---
  const fmt = (kind, key, v) => {
    if (v === undefined || v === null) return '';
    if (kind === 'enum') return esc(L(`e.${key}.${v}`, String(v)));
    if (kind === 'deg') return `${Number(v).toFixed(2)}°`;
    if (kind === 'x') return `${v}×`;
    if (kind === 'm') return `${v} m`;
    if (kind === 'px') return `${v} px`;
    if (kind === 'pct') return `${v} %`;
    if (kind === 'gb') return `${v} GB`;
    if (kind === 'geo') return v ? Number(v).toFixed(6) : '';
    if (kind === 'bool') return v ? esc(t('cam.yes')) : esc(t('cam.no'));
    return esc(String(v));
  };
  let lastStatusHtml = '';
  function setStatus(s) {
    const tests = q('[data-tests]');
    if (!s) {
      if (lastStatusHtml !== '-') { q('[data-status]').innerHTML = `<div class="empty-note">${esc(t('cam.noStatus'))}</div>`; tests.innerHTML = ''; lastStatusHtml = '-'; }
      return;
    }
    const html = (def.status || []).map(([key, kind]) => {
      const v = fmt(kind, key, s[key]);
      return v === '' ? '' : `<div class="kv"><span>${esc(L(`s.${key}`))}</span><b>${v}</b></div>`;
    }).join('');
    if (html !== lastStatusHtml) { q('[data-status]').innerHTML = html; lastStatusHtml = html; }
    if (def.selfTest && s.selfTest) {
      const th = def.selfTest.map(([key, good]) => `<span class="cam-test ${s.selfTest[key] === good ? 'ok' : 'bad'}">${icon(s.selfTest[key] === good ? 'check' : 'x')}${esc(L(`t.${key}`))}</span>`).join('');
      if (tests.dataset.h !== th) { tests.innerHTML = th; tests.dataset.h = th; }
    }
  }

  // --- Günlük ---
  function paintLog() {
    const box = q('[data-log]');
    box.innerHTML = logs.length ? logs.map((l) => `<div class="${l.dir}"><time>${new Date(l.at).toLocaleTimeString()}</time><b>${l.dir === 'tx' ? '→' : '←'}</b><span>${esc(l.text)}</span></div>`).join('') : `<div class="empty-note">${esc(t('cam.logEmpty'))}</div>`;
    box.scrollTop = box.scrollHeight;
  }
  function addLog(l) {
    logs.push(l);
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    paintLog();
  }
  q('[data-clear]').onclick = () => { logs.length = 0; paintLog(); };
  function reply(r) {
    const el2 = toast(t('cam.reply'), { type: 'ok', sub: r.text, timeout: 9000 });
    el2.style.cursor = 'pointer';
    el2.onclick = () => window.api.copyText(r.text);
  }

  paintLog();
  setState(null);
  return {
    el, setState, setStatus, addLog, reply,
    setConn: (c) => { conn = c; if (!camState || !camState.connected) setState(camState); },
    pickDone: () => {},
    run,
    destroy: () => { holdStop(); removeEventListener('blur', holdStop); },
  };
}
