'use strict';

// Ortak harita kurulumu ve ayarları (uçuş penceresi + görev düzenleyici).
//   MapKit.create(): Cesium küresini kurar; Cesium açılamazsa (WebGL yok vb.) WebGL'siz 2B haritaya düşer.
//   MapKit.dialog(): harita kaynağı, arazi, sahne ayarları ve çevrimdışı harita (görünen bölgeyi indirme, önbellek).
// Ayarlar bütün haritalarda ortaktır: mapSource, mapTerrain, mapScene, cesiumToken.

const MapKit = (() => {
  let sourceList = null;
  const fmtB = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`);
  const fmtT = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} sa ${Math.round((s % 3600) / 60)} dk` : s >= 60 ? `${Math.round(s / 60)} dk` : `${Math.max(1, Math.round(s))} sn`);
  async function sources() { if (!sourceList) sourceList = await window.api.tilesList(); return sourceList; }
  const sourceOf = (s) => { const id = s.mapSource || (s.flightStyle === 'street' ? 'osm' : 'esri'); return (sourceList || []).some((x) => x.id === id) ? id : 'esri'; };
  const terrainOf = (s) => (['off', 'arcgis', 'ion'].includes(s.mapTerrain) ? s.mapTerrain : 'arcgis');

  // → { map, flat (2B yedek mi), Marker }
  async function create({ container, center, zoom, settings, topDown = false, clamp = false, onFallback }) {
    const list = await sources();
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    const common = { container: el, center, zoom, sources: list, source: sourceOf(settings) };
    if (await GlobeMap.load()) {
      try {
        const map = new GlobeMap({ ...common, topDown, clamp, token: typeof settings.cesiumToken === 'string' ? settings.cesiumToken : '', terrain: terrainOf(settings), scene: settings.mapScene || {} });
        return { map, flat: false, Marker: GlobeMarker };
      } catch (e) { console.warn('Cesium haritası açılamadı, 2B haritaya geçiliyor:', e && e.message); el.innerHTML = ''; el.classList.remove('globe-map'); }
    }
    if (onFallback) onFallback();
    return { map: new FlatMap({ ...common, dblZoom: !topDown }), flat: true, Marker: FlatMarker };
  }

  // Harita ayarları penceresi. settings nesnesi yerinde güncellenir ve kaydedilir.
  function dialog({ map, flat, settings }) {
    const sc = { atmosphere: true, fog: true, lighting: false, fxaa: true, exaggeration: 1, scale: 1, ...(settings.mapScene || {}) };
    const save = (patch) => { Object.assign(settings, patch); window.api.setSettings(patch); };
    const chk = (id, label, on) => `<label class="ms-check"><input type="checkbox" data-sc="${id}" ${on ? 'checked' : ''}><span>${esc(label)}</span></label>`;
    let running = false; let started = 0;
    const off = window.api.onTilesProgress((p) => paintProgress(p));
    function paintProgress(p) {
      const bar = document.querySelector('[data-mk-bar] i'); const txt = document.querySelector('[data-mk-prog]');
      if (!bar || !txt || !p || !p.total) return;
      bar.style.width = `${(p.done / p.total) * 100}%`;
      const dt = (Date.now() - started) / 1000; const rate = dt > 1 ? p.done / dt : 0;
      txt.textContent = `${p.done} / ${p.total}${p.failed ? ` · ${t('mk.failed', { n: p.failed })}` : ''}${rate && p.active ? ` · ${rate.toFixed(0)} ${t('mk.perSec')} · ${t('mk.left', { time: fmtT((p.total - p.done) / rate) })}` : ''}`;
    }
    const promise = openModal({
      title: t('mk.title'), iconName: 'layers', width: 560,
      body: `<div class="op-form mk">
        <div class="field"><label>${esc(t('mk.source'))}</label><select class="input" data-mk="source"></select></div>
        ${flat ? `<div class="ms-note">${esc(t('mk.flatNote'))}</div>` : `<div class="field"><label>${esc(t('mk.terrain'))}</label><select class="input" data-mk="terrain">
            <option value="off">${esc(t('mk.terrain.off'))}</option><option value="arcgis">${esc(t('mk.terrain.arcgis'))}</option><option value="ion">${esc(t('mk.terrain.ion'))}</option></select></div>
          <div class="field" data-mk-tokrow><label>${esc(t('mk.token'))}</label><input class="input mono" type="password" data-mk="token" autocomplete="off" spellcheck="false" placeholder="eyJ…" value="${esc(settings.cesiumToken || '')}"><div class="ms-note">${esc(t('mk.tokenNote'))}</div></div>
          <div class="field"><label>${esc(t('mk.exaggeration'))}</label><input class="input" type="number" data-sc="exaggeration" min="1" max="5" step="0.5" value="${sc.exaggeration}"></div>
          <div class="mk-checks">${chk('atmosphere', t('mk.atmosphere'), sc.atmosphere)}${chk('fog', t('mk.fog'), sc.fog)}${chk('lighting', t('mk.lighting'), sc.lighting)}${chk('fxaa', t('mk.fxaa'), sc.fxaa)}</div>
          <div class="field"><label>${esc(t('mk.scale'))}</label><input class="input" type="number" data-sc="scale" min="0.5" max="2" step="0.25" value="${sc.scale}"></div>`}
        <div class="mk-sec">${icon('download')}<b>${esc(t('mk.offline'))}</b><span style="flex:1"></span><span data-mk-total></span></div>
        <div class="ms-note">${esc(t('mk.offlineNote'))}</div>
        <div class="mk-row"><div class="field"><label>${esc(t('mk.zFrom'))}</label><select class="input" data-mk="z1"></select></div><div class="field"><label>${esc(t('mk.zTo'))}</label><select class="input" data-mk="z2"></select></div>
          <button class="btn primary" data-mk-dl>${icon('download')}${esc(t('mk.download'))}</button><button class="btn hidden" data-mk-cancel>${icon('x')}${esc(t('common.cancel'))}</button></div>
        <div class="ms-off-bar" data-mk-bar><i></i></div><div class="ms-note" data-mk-prog></div>
        <div class="mk-table" data-mk-table></div></div>`,
      buttons: [{ label: t('mk.clear'), left: true, cls: 'danger', onClick: async (m) => { if (!running && await confirmBox(t('mk.clear'), esc(t('mk.clearConfirm')), { okText: t('mk.clear') })) { await window.api.tilesClear(); stats(m); } return false; } }, { label: t('common.close'), value: null }],
      onMount: (m) => {
        enhanceNumbers(m);
        const q = (k) => m.querySelector(`[data-mk="${k}"]`);
        sources().then((list) => { q('source').innerHTML = list.map((s) => `<option value="${s.id}" ${s.id === map.source ? 'selected' : ''}>${esc(s.name)}${s.custom ? ' *' : ''}</option>`).join(''); zooms(); });
        const zooms = () => { const mx = ((sourceList || []).find((s) => s.id === q('source').value) || { maxzoom: 19 }).maxzoom; const o = (sel) => Array.from({ length: mx - 2 }, (_, i) => i + 3).map((z) => `<option ${z === sel ? 'selected' : ''}>${z}</option>`).join(''); const a = Math.min(Number(q('z1').value) || 10, mx); const b = Math.min(Number(q('z2').value) || 16, mx); q('z1').innerHTML = o(a); q('z2').innerHTML = o(Math.max(a, b)); };
        q('source').onchange = () => { map.setSource(q('source').value); save({ mapSource: q('source').value }); zooms(); };
        if (!flat) {
          q('terrain').value = settings.mapTerrain && ['off', 'arcgis', 'ion'].includes(settings.mapTerrain) ? settings.mapTerrain : 'arcgis';
          const tok = () => m.querySelector('[data-mk-tokrow]').classList.toggle('hidden', q('terrain').value !== 'ion');
          tok();
          q('terrain').onchange = () => { tok(); if (q('terrain').value === 'ion' && !q('token').value.trim()) return; save({ mapTerrain: q('terrain').value }); map.setTerrain(q('terrain').value); };
          q('token').onchange = () => { const v = q('token').value.trim(); save({ cesiumToken: v, mapTerrain: 'ion' }); map.token = v; map.setTerrain('ion'); };
          m.addEventListener('change', (e) => { const k = e.target.dataset && e.target.dataset.sc; if (!k) return; sc[k] = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value); map.setScene(sc); save({ mapScene: { ...sc } }); });
          m.addEventListener('input', (e) => { const k = e.target.dataset && e.target.dataset.sc; if (k && e.target.type !== 'checkbox') { sc[k] = Number(e.target.value); map.setScene(sc); } });
        }
        const dl = m.querySelector('[data-mk-dl]'); const cancel = m.querySelector('[data-mk-cancel]');
        const busy = (on) => { running = on; dl.disabled = on; cancel.classList.toggle('hidden', !on); };
        cancel.onclick = () => window.api.tilesCancel();
        dl.onclick = async () => {
          const bbox = map.getBounds();
          const prog = m.querySelector('[data-mk-prog]');
          if (!bbox) { prog.textContent = t('mk.noView'); return; }
          const query = { source: q('source').value, bbox, zmin: Math.min(Number(q('z1').value), Number(q('z2').value)), zmax: Math.max(Number(q('z1').value), Number(q('z2').value)) };
          const est = await window.api.tilesEstimate(query);
          if (est.over) { prog.textContent = t('mk.over', { n: est.total.toLocaleString(), limit: est.limit.toLocaleString() }); return; }
          if (!await confirmBox(t('mk.download'), esc(t('mk.confirm', { n: est.total.toLocaleString(), time: fmtT(est.seconds), size: fmtB(est.bytes) })), { okText: t('mk.download'), danger: false })) return;
          busy(true); started = Date.now(); m.querySelector('[data-mk-bar] i').style.width = '0';
          const res = await window.api.tilesDownload(query);
          busy(false);
          prog.textContent = res && res.ok ? t('mk.done', { n: (res.total - res.failed).toLocaleString(), failed: res.failed }) : res && res.cancelled ? t('mk.cancelled', { n: res.done }) : res && res.error === 'busy' ? t('mk.busy') : t('dr.failed');
          stats(m);
        };
        stats(m);
      },
    });
    promise.then(() => off());
    async function stats(m) {
      const st = await window.api.tilesStats();
      const tot = m.querySelector('[data-mk-total]'); const tb = m.querySelector('[data-mk-table]');
      if (!tot || !tb) return;
      tot.textContent = t('mk.total', { n: st.files.toLocaleString(), size: fmtB(st.bytes) });
      const rows = Object.entries(st.sources);
      tb.innerHTML = rows.length ? `<div class="mk-tr head"><span>${esc(t('mk.col.source'))}</span><span>${esc(t('mk.col.tiles'))}</span><span>${esc(t('mk.col.size'))}</span><span>${esc(t('mk.col.zoom'))}</span><span>${esc(t('mk.col.last'))}</span><span></span></div>${rows.map(([id, s]) => `<div class="mk-tr"><span>${esc(s.name)}</span><span>${s.count.toLocaleString()}</span><span>${fmtB(s.bytes)}</span><span>${s.zmin}–${s.zmax}</span><span>${s.last ? new Date(s.last).toLocaleDateString() : ''}</span><button class="icon-btn" data-del="${id}" title="${esc(t('common.delete'))}">${icon('trash')}</button></div>`).join('')}` : '';
      tb.onclick = async (e) => { const b = e.target.closest('[data-del]'); if (b && !running) { await window.api.tilesClear(b.dataset.del); stats(m); } };
      if (st.download && st.download.active) { running = true; started = started || Date.now(); paintProgress(st.download); }
    }
    return promise;
  }

  return { create, dialog, sources, sourceOf };
})();
