'use strict';

// Ana ekranın "Dronlar" ve "Uçuşlar" bölümleri: kartlar, dron ekleme/düzenleme formu, yeni uçuş penceresi.
// Dron bağlantısı Mission Planner'daki gibi tanımlanır: seri port, TCP, UDP (karşıya gönder), UDP dinle.

const FW_ICON = { ardupilot: 'upload', px4: 'upload', betaflight: 'bolt', sitl: 'monitor' };
const droneBriefs = new Map(); // dronId → { connected, linked, armed, mode }

// --- Dron formu ---------------------------------------------------------------------------------
async function editDrone(drone) {
  let d = { ...DRONE.defaults(), ...(drone || {}) };
  const cols = 3;
  const body = h(`<div class="cf"><div class="field"><label>${esc(t('dr.name'))}</label><input class="input" data-k="name" maxlength="120" placeholder="${esc(t('dr.namePh'))}"></div>
    <div class="cf-grid" style="--cols:${cols}"></div><small class="hint" data-note></small></div>`);
  const grid = body.querySelector('.cf-grid');
  const input = (k) => body.querySelector(`[data-k="${k}"]`);
  for (const f of DRONE.FIELDS) {
    const span = Math.min(f.span || 1, cols);
    let node;
    if (f.type === 'bool') node = h(`<label class="check cf-f" data-f="${f.key}" style="grid-column:span ${span}"><input type="checkbox" data-k="${f.key}"><span><span class="lbl">${esc(t(`dr.f.${f.key}`))}</span><small class="hnt">${esc(tOpt(`dr.h.${f.key}`, ''))}</small></span></label>`);
    else {
      let ctl;
      if (f.type === 'select') ctl = `<select class="input" data-k="${f.key}">${f.opts.map((v) => `<option value="${esc(v)}">${esc(f.raw ? v : t(`dr.o.${f.key}.${v}`))}</option>`).join('')}</select>`;
      else if (f.type === 'textarea') ctl = `<textarea class="input" data-k="${f.key}" rows="${f.rows || 2}"></textarea>`;
      else if (f.type === 'number') ctl = f.unit ? `<div class="unit-wrap"><input class="input" type="number" data-k="${f.key}" min="${f.min}" max="${f.max}"><span>${esc(f.unit)}</span></div>` : `<input class="input" type="number" data-k="${f.key}" min="${f.min}" max="${f.max}">`;
      else if (f.key === 'serialPort') ctl = `<div class="src-pick"><input class="input mono" data-k="serialPort" list="drPorts" spellcheck="false" placeholder="COM5"><datalist id="drPorts"></datalist><button class="btn" type="button" data-scan>${icon('refresh')}${esc(t('dr.scan'))}</button></div>`;
      else ctl = `<input class="input ${f.mono ? 'mono' : ''}" data-k="${f.key}" spellcheck="false">`;
      node = h(`<div class="field cf-f" data-f="${f.key}" style="grid-column:span ${f.type === 'textarea' ? cols : span}"><label>${esc(t(`dr.f.${f.key}`))}</label>${ctl}<small class="hint hnt">${esc(tOpt(`dr.h.${f.key}`, ''))}</small></div>`);
    }
    enhanceNumbers(node);
    grid.appendChild(node);
  }
  const scan = async () => {
    const ports = await window.api.dronePorts();
    body.querySelector('#drPorts').innerHTML = ports.map((p) => `<option value="${esc(p.path)}">${esc(p.friendly || p.manufacturer || '')}</option>`).join('');
    if (ports.length && !input('serialPort').value) { input('serialPort').value = ports[0].path; read(); }
    return ports;
  };
  body.querySelector('[data-scan]').onclick = async () => { const p = await scan(); toast(p.length ? t('dr.portsFound', { n: p.length }) : t('dr.noPorts'), { type: p.length ? 'ok' : 'err', sub: p.map((x) => x.path).join(', ') }); };
  const write = () => {
    input('name').value = d.name || '';
    for (const f of DRONE.FIELDS) { const i = input(f.key); if (f.type === 'bool') i.checked = !!d[f.key]; else i.value = d[f.key] ?? ''; }
  };
  const paint = () => {
    for (const f of DRONE.FIELDS) body.querySelector(`[data-f="${f.key}"]`).classList.toggle('hidden', !!f.when && !f.when(d));
    for (const n of body.querySelectorAll('.hnt')) n.classList.toggle('hidden', !n.textContent);
    body.querySelector('[data-note]').textContent = tOpt(`dr.note.${d.firmware}`, '');
  };
  function read() {
    d.name = input('name').value;
    for (const f of DRONE.FIELDS) { const i = input(f.key); d[f.key] = f.type === 'bool' ? i.checked : f.type === 'number' ? (i.value === '' ? f.def : Number(i.value)) : i.value; }
  }
  body.addEventListener('change', (e) => {
    const k = e.target.dataset && e.target.dataset.k;
    const before = { ...d };
    read();
    // Yazılım ya da bağlantı türü değişince önerilen değerler (port vb.) uygulanır
    if (k === 'firmware' && DRONE.PRESETS[d.firmware]) Object.assign(d, DRONE.PRESETS[d.firmware], DRONE.PRESETS[DRONE.PRESETS[d.firmware].linkType] && d.firmware !== 'sitl' ? {} : {});
    if (k === 'linkType' && before.linkType !== d.linkType && DRONE.PRESETS[d.linkType]) Object.assign(d, DRONE.PRESETS[d.linkType]);
    if (k === 'firmware' || k === 'linkType') write();
    paint();
    e.target.classList.remove('invalid');
  });
  write(); paint();
  if (d.linkType === 'serial') scan();
  return openModal({
    title: drone ? t('dr.editTitle') : t('dr.newTitle'), iconName: drone ? 'gear' : 'plus', width: 760, body,
    buttons: [{ label: t('common.cancel'), value: null }, {
      label: t('common.save'), cls: 'primary',
      onClick: async () => {
        read();
        const r = await window.api.saveDrone({ ...d, id: drone ? drone.id : undefined });
        if (!r.ok) { body.querySelectorAll('.invalid').forEach((x) => x.classList.remove('invalid')); for (const k of r.invalid || []) { const i = input(k); if (i) i.classList.add('invalid'); } toast(t('cf.invalid'), { type: 'err' }); return false; }
        return r.id;
      },
    }],
  });
}

// --- Uçuş formu: kayıtlı dron + kayıtlı kamera ---------------------------------------------------
async function editFlight(flight, data) {
  if (!data.drones.length) { toast(t('fl.needDrone'), { type: 'err' }); return null; }
  const f = { name: '', droneId: data.drones[0].id, cameraId: data.connections[0] ? data.connections[0].id : '', layout: 'mapPip', ...(flight || {}) };
  const body = h(`<div class="cf-grid" style="--cols:2">
    <div class="field" style="grid-column:span 2"><label>${esc(t('fl.name'))}</label><input class="input" data-k="name" maxlength="120" placeholder="${esc(t('fl.namePh'))}"></div>
    <div class="field"><label>${esc(t('fl.drone'))}</label><select class="input" data-k="droneId">${data.drones.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></div>
    <div class="field"><label>${esc(t('fl.camera'))}</label><select class="input" data-k="cameraId"><option value="">${esc(t('fl.noCamera'))}</option>${data.connections.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
    <div class="field" style="grid-column:span 2"><label>${esc(t('fl.layout'))}</label><select class="input" data-k="layout">${DRONE.LAYOUTS.map((l) => `<option value="${l}">${esc(t(`fl.l.${l}`))}</option>`).join('')}</select></div>
  </div>`);
  const input = (k) => body.querySelector(`[data-k="${k}"]`);
  for (const k of ['name', 'droneId', 'cameraId', 'layout']) input(k).value = f[k] || '';
  return openModal({
    title: flight ? t('fl.editTitle') : t('fl.newTitle'), iconName: flight ? 'gear' : 'plus', width: 600, body,
    buttons: [{ label: t('common.cancel'), value: null }, {
      label: t('common.save'), cls: 'primary',
      onClick: async () => {
        const name = input('name').value.trim() || `${(data.drones.find((d) => d.id === input('droneId').value) || {}).name || ''} — ${formatDate(Date.now())}`;
        const r = await window.api.saveFlight({ id: flight ? flight.id : undefined, name, droneId: input('droneId').value, cameraId: input('cameraId').value || null, layout: input('layout').value });
        if (!r.ok) { toast(t('cf.invalid'), { type: 'err' }); return false; }
        return r.id;
      },
    }],
  });
}

// --- Kartlar ----------------------------------------------------------------------------------
function droneChip(id) {
  const b = droneBriefs.get(id);
  if (!b || !b.connected) return `<span class="tag">${esc(t('dr.st.off'))}</span>`;
  if (!b.linked) return `<span class="tag warn">${esc(t('dr.st.waiting'))}</span>`;
  return `<span class="tag ok">${esc(t('dr.st.linked'))}</span>${b.mode ? `<span class="tag">${esc(b.mode)}</span>` : ''}${b.armed ? `<span class="tag err">${esc(t('dr.armed'))}</span>` : ''}`;
}

function droneCard(d, data) {
  const el = h(`<div class="card drone-card" data-id="${esc(d.id)}" style="--c:${DRONE.FW_COLOR[d.firmware] || '#22d3ee'}">
    <div class="drone-art">${droneGlyph()}<div class="quick"><button class="icon-btn" data-a="edit" title="${esc(t('dr.editTitle'))}">${icon('gear')}</button><button class="icon-btn" data-a="open" title="${esc(t('common.open'))}">${icon('expand')}</button></div></div>
    <div class="conn-body"><div class="card-title">${esc(d.name)}</div><div class="card-sub">${esc(DRONE.display(d))}</div>
      <div class="card-foot"><span class="tag proto-tag">${icon(FW_ICON[d.firmware] || 'upload')}${esc(t(`dr.o.firmware.${d.firmware}`))}</span><span data-chip>${droneChip(d.id)}</span></div></div></div>`);
  el.ondblclick = () => window.api.openDrone(d.id);
  el.querySelector('[data-a="open"]').onclick = (e) => { e.stopPropagation(); window.api.openDrone(d.id); };
  el.querySelector('[data-a="edit"]').onclick = (e) => { e.stopPropagation(); editDrone(d); };
  el.oncontextmenu = (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: t('common.open'), icon: 'expand', action: () => window.api.openDrone(d.id) },
      { label: t('dr.editTitle'), icon: 'gear', action: () => editDrone(d) },
      { label: t('fl.newFor'), icon: 'plus', action: async () => { const id = await editFlight({ droneId: d.id }, data); if (id) window.api.openFlight(id); } },
      { label: t('app.duplicate'), icon: 'copy', action: () => window.api.duplicateDrone(d.id) },
      '-',
      { label: t('common.delete'), icon: 'trash', danger: true, action: async () => { if (await confirmBox(t('common.delete'), t('dr.deleteConfirm', { name: esc(d.name) }))) window.api.deleteDrone(d.id); } },
    ]);
  };
  return el;
}

function flightCard(f, data) {
  const drone = data.drones.find((d) => d.id === f.droneId);
  const cam = data.connections.find((c) => c.id === f.cameraId);
  const el = h(`<div class="card drone-card flight-card" data-id="${esc(f.id)}" style="--c:#34d399">
    <div class="drone-art map">${icon('globe')}<div class="quick"><button class="icon-btn" data-a="edit">${icon('gear')}</button><button class="icon-btn" data-a="open">${icon('expand')}</button></div></div>
    <div class="conn-body"><div class="card-title">${esc(f.name)}</div><div class="card-sub">${esc(formatDate(f.createdAt))}</div>
      <div class="card-foot"><span class="tag proto-tag ${drone ? '' : 'err'}">${icon('upload')}${esc(drone ? drone.name : t('fl.droneGone'))}</span>${cam ? `<span class="tag">${icon('video')}${esc(cam.name)}</span>` : ''}</div></div></div>`);
  const open = () => (drone ? window.api.openFlight(f.id) : toast(t('fl.droneGone'), { type: 'err' }));
  el.ondblclick = open;
  el.querySelector('[data-a="open"]').onclick = (e) => { e.stopPropagation(); open(); };
  el.querySelector('[data-a="edit"]').onclick = (e) => { e.stopPropagation(); editFlight(f, data); };
  el.oncontextmenu = (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: t('common.open'), icon: 'expand', action: open },
      { label: t('fl.editTitle'), icon: 'gear', action: () => editFlight(f, data) },
      '-',
      { label: t('common.delete'), icon: 'trash', danger: true, action: async () => { if (await confirmBox(t('common.delete'), t('fl.deleteConfirm', { name: esc(f.name) }))) window.api.deleteFlight(f.id); } },
    ]);
  };
  return el;
}

// Dört pervaneli dron simgesi (kartlarda ve motor testinde kullanılan çizimle aynı dil)
function droneGlyph() {
  return `<svg viewBox="0 0 120 80" class="drone-glyph" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
    <path d="M38 26 L82 54 M82 26 L38 54"/><rect x="50" y="32" width="20" height="16" rx="5" fill="currentColor" stroke="none" opacity=".9"/>
    <circle cx="34" cy="23" r="13"/><circle cx="86" cy="23" r="13"/><circle cx="34" cy="57" r="13"/><circle cx="86" cy="57" r="13"/></svg>`;
}

// Bölüm ızgarası: grid öğesine dron ya da uçuş kartlarını çizer
function renderSection(grid, section, data, query) {
  grid.innerHTML = '';
  const match = (...v) => !query || v.some((x) => String(x || '').toLowerCase().includes(query));
  const add = (label, onNew) => { const n = h(`<div class="new-card conn-new"><div class="plus">${icon('plus')}</div><div class="lbl">${esc(label)}</div></div>`); n.onclick = onNew; grid.appendChild(n); };
  if (section === 'drones') {
    const list = data.drones.filter((d) => match(d.name, DRONE.display(d), d.firmware, d.notes)).sort((a, b) => a.name.localeCompare(b.name));
    grid.appendChild(h(`<div class="section-title">${esc(t('sec.drones'))}${list.length ? `<span class="hint">${esc(t('dr.dblHint'))}</span>` : `<span class="hint">${esc(t('dr.emptyHint'))}</span>`}</div>`));
    for (const d of list) grid.appendChild(droneCard(d, data));
    if (!query) add(t('dr.newTitle'), () => editDrone(null));
  } else {
    const list = data.flights.filter((f) => match(f.name, (data.drones.find((d) => d.id === f.droneId) || {}).name)).sort((a, b) => b.createdAt - a.createdAt);
    grid.appendChild(h(`<div class="section-title">${esc(t('sec.flights'))}${list.length ? `<span class="hint">${esc(t('fl.dblHint'))}</span>` : `<span class="hint">${esc(t('fl.emptyHint'))}</span>`}</div>`));
    for (const f of list) grid.appendChild(flightCard(f, data));
    if (!query) add(t('fl.newTitle'), async () => { const id = await editFlight(null, data); if (id) window.api.openFlight(id); });
  }
}
