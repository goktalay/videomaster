'use strict';

// Yapay görü: akış penceresindeki "Yapay görü" paneli, analiz döngüsü (işçi: ../vision/worker.js) ve video üstü çizim.
// Modüller ve modeller src/vision/catalog.js'te tanımlıdır; modeller ilk kullanımdan önce indirilir.

// --- Analiz motoru: kareleri işçiye yollar, gereken modelleri yükler -------------------------------------
class VisionEngine {
  constructor({ getBitmap, onResult, onState }) {
    this.getBitmap = getBitmap;
    this.onResult = onResult;
    this.onState = onState;
    this.worker = null;
    this.ready = null;
    this.loaded = new Set();
    this.loading = new Map();
    this.running = false;
    this.job = null;
    this.rate = 5;
    this.threads = 4;
    this.seq = 0;
    this.pending = new Map();
    this.timer = null;
    this.error = null;
  }

  call(msg, transfer) {
    return new Promise((resolve, reject) => {
      const seq = ++this.seq;
      this.pending.set(seq, { resolve, reject });
      this.worker.postMessage({ ...msg, seq }, transfer || []);
    });
  }

  async boot() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.worker = new Worker('../vision/worker.js');
      this.worker.onmessage = (e) => {
        const p = this.pending.get(e.data.seq);
        if (!p) return;
        this.pending.delete(e.data.seq);
        if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
      };
      this.worker.onerror = (e) => { this.fail(e.message || 'worker'); };
      const wasm = await window.api.visionRuntime();
      await this.call({ type: 'init', wasm, threads: this.threads }, [wasm]);
    })();
    return this.ready;
  }

  fail(message) {
    this.error = message;
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
    this.stop();
  }

  async ensure(id) {
    if (this.loaded.has(id)) return true;
    if (this.loading.has(id)) return this.loading.get(id);
    const p = (async () => {
      const m = await window.api.visionRead(id);
      if (!m) return false;
      await this.call({ type: 'load', id, def: m.def, files: m.files }, Object.values(m.files));
      this.loaded.add(id);
      return true;
    })().finally(() => this.loading.delete(id));
    this.loading.set(id, p);
    return p;
  }

  // Silinen ya da değişen model bellekten atılır
  async unload(id) {
    if (!this.worker || !this.loaded.has(id)) return;
    this.loaded.delete(id);
    await this.call({ type: 'unload', id }).catch(() => {});
  }

  setJob(job, rate) { this.job = job; this.rate = rate; }

  start() {
    if (this.running) return;
    this.running = true;
    this.error = null;
    this.onState();
    this.tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.onState();
  }

  async tick() {
    if (!this.running) return;
    const t0 = performance.now();
    try {
      const job = this.job;
      if (job && job.tasks.length) {
        await this.boot();
        for (const id of job.models) if (!(await this.ensure(id))) throw new Error(`model:${id}`);
        const bitmap = await this.getBitmap();
        if (bitmap && this.running) {
          const r = await this.call({ type: 'run', bitmap, job }, [bitmap]);
          if (this.running) this.onResult(r.result);
        }
      }
    } catch (e) {
      if (this.running) { this.error = e.message; this.running = false; this.onState(); }
      return;
    }
    // Sonraki analiz: istenen hıza göre; işlemci video çözmeye de kalsın diye en az kısa bir ara verilir
    const took = performance.now() - t0;
    if (this.running) this.timer = setTimeout(() => this.tick(), Math.max(15, took * 0.1, 1000 / this.rate - took));
  }

  destroy() { this.stop(); if (this.worker) this.worker.terminate(); this.worker = null; this.ready = null; this.loaded.clear(); }
}

// --- Panel ---------------------------------------------------------------------------------------------
// opts: { id, conn, video: <section>, canvas: <canvas#visionCanvas>, player }
function buildVisionPanel(opts) {
  const { id, player } = opts;
  let conn = opts.conn;
  let cfg = VISION.normalizeVision(conn.vision);
  let models = [];
  let modelsDir = '';
  let modules = VISION.modulesWith([]);
  let last = null;
  const progress = new Map(); // modelId → { done, total }
  const open = new Set(['modules', 'results']);
  const sizeText = (n) => (n ? formatSize(n).replace(/[⁦⁩]/g, '') : '');
  const modName = (m) => (m.user ? m.name : t(`vis.m.${m.id}`));
  const modelOf = (mid) => models.find((x) => x.id === mid);

  const el = h(`<div class="vis">
    <div class="vis-top"><button class="btn primary" type="button" data-run></button><span class="state-chip" data-chip></span></div>
    <div class="cam-warn hidden" data-err></div>
    <details class="cf-sec" data-s="modules"><summary>${icon('eye')}<span>${esc(t('vis.modules'))}</span>${icon('chevronDown', 'chev')}</summary><div class="vis-mods" data-mods></div></details>
    <details class="cf-sec" data-s="results"><summary>${icon('text')}<span>${esc(t('vis.results'))}</span>${icon('chevronDown', 'chev')}</summary><div class="vis-res" data-res></div></details>
    <details class="cf-sec" data-s="settings"><summary>${icon('gear')}<span>${esc(t('vis.settings'))}</span>${icon('chevronDown', 'chev')}</summary><div class="vis-set" data-set></div></details>
    <details class="cf-sec" data-s="models"><summary>${icon('download')}<span>${esc(t('vis.models'))}</span>${icon('chevronDown', 'chev')}</summary><div class="vis-models" data-models></div></details>
    <details class="cf-sec" data-s="file"><summary>${icon('file')}<span>${esc(t('vis.file'))}</span>${icon('chevronDown', 'chev')}</summary>
      <div class="vis-set"><small class="hint">${esc(t('vis.fileHint'))}</small><div class="cam-btns">
        <button class="btn sm" type="button" data-export>${icon('export')}<span>${esc(t('vis.export'))}</span></button>
        <button class="btn sm" type="button" data-import>${icon('open')}<span>${esc(t('vis.import'))}</span></button></div></div></details>
  </div>`);
  const q = (s) => el.querySelector(s);
  for (const d of el.querySelectorAll('details[data-s]')) {
    d.open = open.has(d.dataset.s);
    d.addEventListener('toggle', () => { if (d.open) open.add(d.dataset.s); else open.delete(d.dataset.s); });
  }

  // --- Motor ---
  const engine = new VisionEngine({
    getBitmap: () => (player.last ? createImageBitmap(player.last) : null),
    onResult: (r) => { last = r; draw(); paintResults(); paintChip(); },
    onState: () => { paintChip(); if (!engine.running) { last = null; draw(); paintResults(); } },
  });

  const activeModules = () => modules.filter((m) => VISION.moduleState(cfg, m).on && m.models.every((mid) => { const x = modelOf(mid); return x && x.installed; }));

  // Açık modüllerden iş tanımı: genel algılayıcı bir kez çalışır, sonuçları modüllere dağıtılır
  function buildJob() {
    const tasks = [];
    const need = new Set();
    const thr = (m) => (100 - VISION.moduleState(cfg, m).sens) / 100;
    const act = activeModules();
    const det = act.filter((m) => !m.user && m.models[0] === 'det');
    if (det.length) { tasks.push({ type: 'detect', model: 'det', outputs: det.map((m) => ({ module: m.id, classes: m.classes || null, thr: thr(m), top: m.top || 0 })) }); need.add('det'); }
    for (const m of act) {
      if (m.user) { tasks.push({ type: 'detect', model: m.id, outputs: [{ module: m.id, classes: null, thr: thr(m), top: 0 }] }); need.add(m.id); }
      else if (m.id === 'pose') { tasks.push({ type: 'pose', model: 'pose', module: 'pose', thr: thr(m) }); need.add('pose'); }
      else if (m.id === 'ocr') { tasks.push({ type: 'ocr', det: 'ocrdet', rec: 'ocrrec', module: 'ocr', thr: thr(m) }); need.add('ocrdet'); need.add('ocrrec'); }
      else if (m.id === 'plate') { tasks.push({ type: 'plate', det: 'platedet', rec: 'platerec', module: 'plate', thr: thr(m) }); need.add('platedet'); need.add('platerec'); }
    }
    return { tasks, models: [...need], iou: cfg.iou / 100, maxDet: cfg.maxDet };
  }
  function applyJob() {
    engine.threads = cfg.threads;
    engine.setJob(buildJob(), cfg.rate);
  }

  // --- Kaydetme (kameraya özel) ---
  let saveTimer = null;
  function changed() {
    applyJob();
    draw();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => window.api.visionSet(id, cfg), 400);
  }

  // --- Durum ---
  function paintChip() {
    const b = q('[data-run]');
    b.innerHTML = `${icon(engine.running ? 'stop' : 'play')}${esc(engine.running ? t('vis.stop') : t('vis.start'))}`;
    b.classList.toggle('primary', !engine.running);
    const chip = q('[data-chip]');
    const n = activeModules().length;
    chip.className = `state-chip s-${engine.error ? 'error' : engine.running ? (last ? 'playing' : 'connecting') : 'idle'}`;
    chip.innerHTML = `${engine.running && !last ? '<span class="spin"></span>' : '<i></i>'}${esc(engine.error ? t('vis.failed') : engine.running ? (last ? t('vis.running', { ms: Math.round(last.ms), n }) : t('vis.loading')) : t('vis.idle', { n }))}`;
    chip.title = last && engine.running ? `${last.times.map(([k, ms]) => `${k}: ${ms} ms`).join(' · ')} · ${last.threads}T` : '';
    const err = q('[data-err]');
    err.textContent = engine.error ? `${t('vis.failed')}: ${engine.error}` : '';
    err.classList.toggle('hidden', !engine.error);
  }
  q('[data-run]').onclick = () => {
    if (engine.running) return engine.stop();
    if (!activeModules().length) return toast(t('vis.noModule'), { type: 'err' });
    if (!player.last) return toast(t('cam.noVideo'), { type: 'err' });
    applyJob();
    engine.start();
  };

  // --- Modüller ---
  function paintModules() {
    const box = q('[data-mods]');
    box.innerHTML = '';
    for (const m of modules) {
      const st = VISION.moduleState(cfg, m);
      const need = m.models.map(modelOf);
      const missing = need.filter((x) => x && !x.installed);
      const unknown = need.some((x) => !x);
      const busy = m.models.some((mid) => progress.has(mid));
      const size = missing.reduce((n, x) => n + (x.size || 0), 0);
      const row = h(`<div class="vis-mod ${st.on ? 'on' : ''}" style="--mc:${m.color}">
        <label class="vis-switch"><input type="checkbox" ${st.on ? 'checked' : ''} ${missing.length || unknown ? 'disabled' : ''}><i></i></label>
        <div class="vis-mod-main"><div class="vis-mod-name">${icon(m.icon)}<b>${esc(modName(m))}</b><span class="vis-count" data-count="${m.id}"></span></div>
          <small class="hint">${esc(m.user ? t('vis.userModel') : t(`vis.d.${m.id}`))}</small>
          <div class="vis-need"></div>
          <div class="vis-sens ${st.on ? '' : 'hidden'}"><span>${esc(t('vis.sens'))}</span><span class="unit-wrap"><input class="input" type="number" min="1" max="99" value="${st.sens}"><span>%</span></span></div>
        </div></div>`);
      const needBox = row.querySelector('.vis-need');
      if (busy) {
        const done = m.models.reduce((n, mid) => n + ((progress.get(mid) || {}).done || 0), 0);
        const total = m.models.reduce((n, mid) => n + ((progress.get(mid) || {}).total || 0), 0);
        needBox.innerHTML = `<div class="vis-bar"><i style="width:${total ? Math.min(100, (done / total) * 100) : 5}%"></i></div><small>${esc(t('vis.downloading'))} ${esc(sizeText(done))}${total ? ` / ${esc(sizeText(total))}` : ''}</small>`;
      } else if (missing.length) {
        const canGet = missing.every((x) => x.remote);
        needBox.innerHTML = `<small class="warn">${esc(canGet ? t('vis.needModel') : t('vis.noSource'))}</small>${canGet ? `<button class="btn sm primary" type="button">${icon('download')}${esc(t('vis.download'))}${size ? ` (${esc(sizeText(size))})` : ''}</button>` : ''}`;
        const b = needBox.querySelector('button');
        if (b) b.onclick = () => { for (const x of missing) downloadModel(x.id); };
      }
      row.querySelector('input[type=checkbox]').onchange = (e) => {
        cfg.modules[m.id] = { on: e.target.checked, sens: st.sens };
        paintModules(); paintChip(); changed();
      };
      const sens = row.querySelector('input[type=number]');
      enhanceNumbers(row);
      sens.addEventListener('input', () => {
        const v = Math.max(1, Math.min(99, Math.round(Number(sens.value) || st.sens)));
        cfg.modules[m.id] = { on: VISION.moduleState(cfg, m).on, sens: v };
        changed();
      });
      box.appendChild(row);
    }
    paintCounts();
  }

  async function downloadModel(mid) {
    if (progress.has(mid)) return;
    progress.set(mid, { done: 0, total: (modelOf(mid) || {}).size || 0 });
    paintModules(); paintModels();
    const r = await window.api.visionDownload(mid);
    progress.delete(mid);
    if (!r.ok && r.error !== 'cancelled') toast(t('vis.downloadFailed'), { type: 'err', sub: tOpt(`vis.err.${r.error}`, r.detail || r.error), timeout: 7000 });
    await refreshModels();
  }

  // --- Sonuçlar ---
  function paintCounts() {
    for (const s of el.querySelectorAll('[data-count]')) {
      const mid = s.dataset.count;
      const n = last ? last.items.filter((x) => x.module === mid).length + last.poses.filter((x) => x.module === mid).length + last.texts.filter((x) => x.module === mid).length : 0;
      s.textContent = last && engine.running && VISION.moduleState(cfg, { id: mid, sens: 50 }).on ? String(n) : '';
    }
  }
  const labelText = (it) => (it.cls >= 0 && it.coco ? (VISION.cocoLabel ? VISION.cocoLabel(it.cls, LANG) : it.label) : it.label);
  function paintResults() {
    paintCounts();
    const box = q('[data-res]');
    if (!last || !engine.running) { box.innerHTML = `<div class="empty-note">${esc(t('vis.noResults'))}</div>`; return; }
    let html = '';
    for (const m of modules) {
      if (!VISION.moduleState(cfg, m).on) continue;
      const texts = last.texts.filter((x) => x.module === m.id);
      const items = last.items.filter((x) => x.module === m.id);
      const poses = last.poses.filter((x) => x.module === m.id);
      let body = '';
      if (texts.length) body = texts.map((x) => `<a class="vis-text" data-copy="${esc(x.text)}" title="${esc(t('vis.copy'))}">${esc(x.text)}<i>${Math.round(x.score * 100)}%</i></a>`).join('');
      else if (items.length) {
        const by = new Map();
        for (const it of items) { const k = labelText(it); by.set(k, (by.get(k) || 0) + 1); }
        body = [...by.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="vis-tag">${esc(k)}<i>${n}</i></span>`).join('');
      } else if (poses.length) body = `<span class="vis-tag">${esc(t('vis.m.pose'))}<i>${poses.length}</i></span>`;
      html += `<div class="vis-res-row" style="--mc:${m.color}"><b>${esc(modName(m))}</b><div>${body || `<small class="hint">${esc(t('vis.none'))}</small>`}</div></div>`;
    }
    box.innerHTML = html || `<div class="empty-note">${esc(t('vis.noResults'))}</div>`;
  }
  q('[data-res]').addEventListener('click', (e) => {
    const a = e.target.closest('[data-copy]');
    if (a) { window.api.copyText(a.dataset.copy); toast(t('vis.copied'), { type: 'ok', sub: a.dataset.copy, timeout: 1800 }); }
  });

  // --- Ayarlar (sayısal olanların hepsi kaydırıcı) ---
  function paintSettings() {
    const box = q('[data-set]');
    box.innerHTML = VISION.NUMBERS.map(([k, a, b]) => `<label class="cam-in"><span>${esc(t(`vis.n.${k}`))}</span><span class="unit-wrap"><input class="input" type="number" data-vn="${k}" min="${a}" max="${b}" value="${cfg[k]}"><span>${esc(tOpt(`vis.u.${k}`, ''))}</span></span></label>`).join('')
      + VISION.FLAGS.map(([k]) => `<label class="check"><input type="checkbox" data-vf="${k}" ${cfg[k] ? 'checked' : ''}><span><span class="lbl">${esc(t(`vis.f.${k}`))}</span></span></label>`).join('')
      + `<small class="hint">${esc(t('vis.threadsHint'))}</small>`;
    enhanceNumbers(box);
  }
  q('[data-set]').addEventListener('input', (e) => {
    const n = e.target.dataset.vn;
    const f = e.target.dataset.vf;
    if (n) { const [, a, b, d] = VISION.NUMBERS.find((x) => x[0] === n); const v = Math.round(Number(e.target.value)); cfg[n] = Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d; }
    else if (f) cfg[f] = e.target.checked;
    else return;
    changed();
  });

  // --- Modeller ---
  function paintModels() {
    const box = q('[data-models]');
    box.innerHTML = models.map((m) => {
      const p = progress.get(m.id);
      const state = p ? `<div class="vis-bar"><i style="width:${p.total ? Math.min(100, (p.done / p.total) * 100) : 5}%"></i></div>` : '';
      const btn = p ? `<button class="btn sm" data-act="cancel" data-id="${m.id}">${icon('x')}${esc(t('common.cancel'))}</button>`
        : m.installed ? `<button class="btn sm" data-act="remove" data-id="${m.id}">${icon('trash')}${esc(t('vis.remove'))}</button>`
          : m.remote ? `<button class="btn sm primary" data-act="get" data-id="${m.id}">${icon('download')}${esc(t('vis.download'))}</button>` : '';
      return `<div class="vis-model"><div><b>${esc(m.name)}</b>${m.user ? `<span class="vis-tag">${esc(t('vis.user'))}</span>` : ''}
        <small>${esc([t(`vis.k.${m.kind}`), sizeText(m.size), m.license, m.installed ? t('vis.installed') : t('vis.notInstalled')].filter(Boolean).join(' · '))}</small>${state}</div>
        <div class="vis-model-btns">${btn}${m.user ? `<button class="icon-btn" data-act="drop" data-id="${m.id}" title="${esc(t('vis.dropModel'))}">${icon('x')}</button>` : ''}</div></div>`;
    }).join('') + `<div class="cam-btns"><button class="btn sm" type="button" data-act="add">${icon('plus')}<span>${esc(t('vis.addModel'))}</span></button>
      <button class="btn sm" type="button" data-act="dir">${icon('folder')}<span>${esc(t('vis.openDir'))}</span></button></div><small class="hint mono vis-dir">${esc(modelsDir)}</small>`;
  }
  q('[data-models]').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const mid = b.dataset.id;
    if (b.dataset.act === 'get') downloadModel(mid);
    else if (b.dataset.act === 'cancel') window.api.visionCancel(mid);
    else if (b.dataset.act === 'dir') window.api.visionOpenDir();
    else if (b.dataset.act === 'add') addModel();
    else if (b.dataset.act === 'remove') { await engine.unload(mid); await window.api.visionRemove(mid); refreshModels(); }
    else if (b.dataset.act === 'drop') {
      if (!(await confirmBox(t('vis.dropModel'), esc(t('vis.dropConfirm', { name: (modelOf(mid) || {}).name || '' })), { okText: t('common.delete') }))) return;
      await engine.unload(mid);
      delete cfg.modules[mid];
      await window.api.visionRemoveModel(mid);
      changed();
    }
  });

  // Kullanıcı modeli ekleme: ONNX nesne tanıma modeli (adres ya da dosya)
  async function addModel() {
    let file = '';
    const body = h(`<div class="cf-grid" style="--cols:2">
      <div class="field" style="grid-column:span 2"><label>${esc(t('vis.am.name'))}</label><input class="input" data-a="name" maxlength="60"></div>
      <div class="field" style="grid-column:span 2"><label>${esc(t('vis.am.url'))}</label><div class="src-pick"><input class="input mono" data-a="url" spellcheck="false" placeholder="https://…/model.onnx"><button class="btn" type="button" data-pick>${icon('open')}${esc(t('vis.am.pick'))}</button></div><small class="hint">${esc(t('vis.am.urlHint'))}</small></div>
      <div class="field"><label>${esc(t('vis.am.size'))}</label><div class="unit-wrap"><input class="input" type="number" data-a="inputSize" min="160" max="1280" step="32" value="640"><span>px</span></div></div>
      <div class="field"><label>${esc(t('vis.am.decoder'))}</label><select class="input" data-a="decoder">${VISION.DECODERS.map((d) => `<option value="${d}">${esc(t(`vis.dec.${d}`))}</option>`).join('')}</select></div>
      <div class="field" style="grid-column:span 2"><label>${esc(t('vis.am.labels'))}</label><textarea class="input" data-a="labels" rows="4" spellcheck="false" placeholder="person, car, …"></textarea><small class="hint">${esc(t('vis.am.labelsHint'))}</small></div>
    </div>`);
    enhanceNumbers(body);
    const val = (k) => body.querySelector(`[data-a="${k}"]`).value;
    body.querySelector('[data-pick]').onclick = async () => {
      const f = await window.api.visionPickModel();
      if (!f) return;
      file = f;
      body.querySelector('[data-a="url"]').value = f;
      if (!val('name')) body.querySelector('[data-a="name"]').value = f.split(/[\\/]/).pop().replace(/\.onnx$/i, '');
    };
    const added = await openModal({
      title: t('vis.addModel'), iconName: 'plus', width: 620, body,
      buttons: [{ label: t('common.cancel'), value: null }, {
        label: t('common.save'), cls: 'primary',
        onClick: async () => {
          const src = val('url').trim();
          const isFile = file && src === file;
          const r = await window.api.visionAddModel({ name: val('name'), url: isFile ? '' : src, file: isFile ? file : '', labels: val('labels'), inputSize: Number(val('inputSize')), decoder: val('decoder') });
          if (!r.ok) { toast(tOpt(`vis.err.${r.error}`, t('vis.err.bad_args')), { type: 'err' }); return false; }
          return r.id;
        },
      }],
    });
    if (added) { await refreshModels(); open.add('modules'); toast(t('vis.modelAdded'), { type: 'ok' }); }
  }

  async function refreshModels() {
    const r = await window.api.visionModels();
    models = r.models;
    modelsDir = r.dir;
    modules = VISION.modulesWith(models.filter((m) => m.user));
    paintModules(); paintModels(); paintChip(); applyJob();
  }

  // --- Ayar dosyası ---
  q('[data-export]').onclick = async () => {
    await window.api.visionSet(id, cfg);
    const f = await window.api.visionExport(id);
    if (f) toast(t('vis.exported'), { type: 'ok', sub: f, timeout: 6000 });
  };
  q('[data-import]').onclick = async () => {
    const r = await window.api.visionImport(id);
    if (!r) return;
    if (!r.ok) return toast(t('vis.badFile'), { type: 'err' });
    cfg = VISION.normalizeVision(r.vision);
    await refreshModels();
    paintSettings();
    draw();
    toast(t('vis.imported'), { type: 'ok', sub: r.file, timeout: 5000 });
  };

  // --- Video üstü çizim ---
  const SKELETON = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [0, 1], [0, 2], [1, 3], [2, 4]];
  function draw() {
    const c = opts.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(c.clientWidth * dpr));
    const ch = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, cw, ch);
    if (!last || !engine.running || !player.width) return;
    let w = cw; let hh = ch; let x0 = 0; let y0 = 0;
    if (player.fit !== 'fill') {
      const k = player.fit === 'cover' ? Math.max(cw / player.width, ch / player.height) : Math.min(cw / player.width, ch / player.height);
      w = player.width * k; hh = player.height * k; x0 = (cw - w) / 2; y0 = (ch - hh) / 2;
    }
    const color = Object.fromEntries(modules.map((m) => [m.id, m.color]));
    const X = (v) => x0 + v * w;
    const Y = (v) => y0 + v * hh;
    const lw = cfg.line * dpr;
    g.lineWidth = lw;
    g.font = `600 ${cfg.font * dpr}px system-ui, sans-serif`;
    g.textBaseline = 'top';
    const tag = (text, x, y, col) => {
      if (!cfg.showLabels || !text) return;
      const tw = g.measureText(text).width + 8 * dpr;
      const th = (cfg.font + 5) * dpr;
      const ty = y - th < 0 ? y : y - th;
      g.fillStyle = col; g.fillRect(x - lw / 2, ty, tw, th);
      g.fillStyle = '#0b1220'; g.fillText(text, x + 3 * dpr, ty + 2 * dpr);
    };
    const pct = (s) => (cfg.showScores ? ` ${Math.round(s * 100)}%` : '');
    for (const it of last.items) {
      const col = color[it.module] || '#fff';
      g.strokeStyle = col;
      g.strokeRect(X(it.box[0]), Y(it.box[1]), it.box[2] * w, it.box[3] * hh);
      tag(`${labelText(it)}${pct(it.score)}`, X(it.box[0]), Y(it.box[1]), col);
    }
    for (const tx of last.texts) {
      const col = color[tx.module] || '#fff';
      g.strokeStyle = col;
      if (tx.quad) { g.beginPath(); tx.quad.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.closePath(); g.stroke(); }
      else g.strokeRect(X(tx.box[0]), Y(tx.box[1]), tx.box[2] * w, tx.box[3] * hh);
      tag(`${tx.text}${pct(tx.score)}`, X(tx.box[0]), Y(tx.box[1]), col);
    }
    for (const p of last.poses) {
      const col = color[p.module] || '#fff';
      g.strokeStyle = col; g.fillStyle = col;
      const ok = (i) => p.kp[i] && p.kp[i][2] >= 0.3;
      for (const [a, b] of SKELETON) if (ok(a) && ok(b)) { g.beginPath(); g.moveTo(X(p.kp[a][0]), Y(p.kp[a][1])); g.lineTo(X(p.kp[b][0]), Y(p.kp[b][1])); g.stroke(); }
      for (let i = 0; i < p.kp.length; i++) if (ok(i)) { g.beginPath(); g.arc(X(p.kp[i][0]), Y(p.kp[i][1]), lw * 1.6, 0, Math.PI * 2); g.fill(); }
      if (p.box) tag(`${t('vis.m.pose')}${pct(p.score)}`, X(p.box[0]), Y(p.box[1]), col);
    }
  }
  const ro = new ResizeObserver(() => draw());
  ro.observe(opts.canvas);

  const offProgress = window.api.onVisionProgress((p) => {
    if (p.state === 'done' || p.state === 'error') progress.delete(p.id); else progress.set(p.id, { done: p.done, total: p.total });
    paintModules(); paintModels();
  });
  const offModels = window.api.onVisionModels(() => refreshModels());

  paintSettings();
  paintResults();
  paintChip();
  refreshModels().then(() => { if (cfg.autoRun && activeModules().length) { const wait = setInterval(() => { if (player.last) { clearInterval(wait); applyJob(); engine.start(); } }, 500); setTimeout(() => clearInterval(wait), 60000); } });

  return {
    el, draw,
    setConn: (c) => { conn = c; },
    destroy: () => { engine.destroy(); ro.disconnect(); offProgress(); offModels(); },
    engine,
  };
}
