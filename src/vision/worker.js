'use strict';

// Yapay görü işçisi: ONNX modellerini onnxruntime-web (WASM) ile çalıştırır. Pencereden gelen her kare için
// istenen görevleri (nesne tanıma, poz, yazı okuma, plaka) sırayla yürütür ve sonuçları 0–1 aralığına
// oranlanmış koordinatlarla döndürür. Modeller pencere tarafından dosya içeriği olarak yüklenir (ağa çıkılmaz).

/* global ort, VISION, VDECODE */
importScripts('../vendor/ort/ort.wasm.min.js', 'catalog.js', 'decode.js');

const models = new Map(); // id → { def, session, input, chars, layout }
let canvas = null;
let ctx = null;

function surface(w, h) {
  if (!canvas) { canvas = new OffscreenCanvas(w, h); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return ctx;
}

// RGBA → float32 NCHW. opt: { bgr, scale, mean:[3], std:[3] } (mean/std kanal sırasına göre uygulanır)
function toTensor(img, w, h, opt) {
  const n = w * h;
  const out = new Float32Array(3 * n);
  const d = img.data;
  const scale = opt.scale === undefined ? 1 : opt.scale;
  const mean = opt.mean || [0, 0, 0];
  const std = opt.std || [1, 1, 1];
  const c0 = opt.bgr ? 2 : 0;
  const c2 = opt.bgr ? 0 : 2;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = (d[p + c0] * scale - mean[0]) / std[0];
    out[n + i] = (d[p + 1] * scale - mean[1]) / std[1];
    out[2 * n + i] = (d[p + c2] * scale - mean[2]) / std[2];
  }
  return new ort.Tensor('float32', out, [1, 3, h, w]);
}

// En-boy oranını koruyarak kare girişe sığdırır (boşluk 114). center: ortala (YOLOv8 tarzı) ya da sol üst (YOLOX)
function letterbox(bitmap, size, opt) {
  const g = surface(size, size);
  const scale = Math.min(size / bitmap.width, size / bitmap.height);
  const nw = Math.max(1, Math.round(bitmap.width * scale));
  const nh = Math.max(1, Math.round(bitmap.height * scale));
  const dx = opt.center ? (size - nw) / 2 : 0;
  const dy = opt.center ? (size - nh) / 2 : 0;
  g.fillStyle = 'rgb(114,114,114)';
  g.fillRect(0, 0, size, size);
  g.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, dx, dy, nw, nh);
  return { tensor: toTensor(g.getImageData(0, 0, size, size), size, size, opt), lb: { scale, dx, dy } };
}

// Kaynağın bir bölgesini verilen boyuta gererek alır
function crop(bitmap, x, y, w, h, tw, th) {
  const g = surface(tw, th);
  g.drawImage(bitmap, x, y, w, h, 0, 0, tw, th);
  return g.getImageData(0, 0, tw, th);
}

const firstOut = (res, session) => res[session.outputNames[0]];

// --- Nesne tanıma (hazır ve kullanıcı modelleri) ---
async function detect(bitmap, m, minScore, job) {
  const size = m.def.inputSize || 640;
  const yolox = m.layout === 'yolox';
  const { tensor, lb } = letterbox(bitmap, size, yolox ? { bgr: true, scale: 1, center: false } : { bgr: false, scale: 1 / 255, center: true });
  const out = firstOut(await m.session.run({ [m.input]: tensor }), m.session);
  if (!m.layout || m.layout === 'auto') {
    m.layout = VDECODE.guessLayout(out.dims, out.data, size);
    if (m.layout === 'yolox') return detect(bitmap, m, minScore, job); // YOLOX farklı ön işlem ister: bir kez yeniden çalıştır
  }
  const boxes = VDECODE.decodeDetections(out, { layout: m.layout, size, lb, sw: bitmap.width, sh: bitmap.height, minScore });
  return m.layout === 'end2end' ? boxes.sort((a, b) => b[4] - a[4]).slice(0, job.maxDet) : VDECODE.nms(boxes, job.iou, job.maxDet);
}

// --- Poz (RTMO: NMS ve çözme modelin içinde) ---
async function pose(bitmap, m, task) {
  const size = m.def.inputSize;
  const { tensor, lb } = letterbox(bitmap, size, { bgr: true, scale: 1, center: false });
  const res = await m.session.run({ [m.input]: tensor });
  const dets = res.dets; const kpts = res.keypoints;
  const n = dets.dims[1];
  const sw = bitmap.width; const sh = bitmap.height;
  const out = [];
  for (let i = 0; i < n; i++) {
    const score = dets.data[i * 5 + 4];
    if (score < task.thr) continue;
    const b = [0, 1, 2, 3].map((k) => dets.data[i * 5 + k] / lb.scale);
    const kp = [];
    for (let k = 0; k < 17; k++) { const o = (i * 17 + k) * 3; kp.push([kpts.data[o] / lb.scale / sw, kpts.data[o + 1] / lb.scale / sh, kpts.data[o + 2]]); }
    out.push({ module: task.module, score, box: [b[0] / sw, b[1] / sh, (b[2] - b[0]) / sw, (b[3] - b[1]) / sh], kp });
  }
  return out.sort((a, b) => b.score - a.score);
}

// --- Yazı okuma: DB yazı bulma + CTC yazı tanıma (yatay satırlar) ---
const OCR_LIMIT = 736;
const OCR_MAX_LINES = 40;
function textBoxes(prob, W, H, boxThr) {
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = prob[i] > 0.3 ? 1 : 0;
  const stack = new Int32Array(W * H);
  const boxes = [];
  for (let start = 0; start < W * H; start++) {
    if (mask[start] !== 1) continue;
    let top = 0; stack[top++] = start; mask[start] = 2;
    let minX = W; let maxX = 0; let minY = H; let maxY = 0; let sum = 0; let count = 0;
    while (top) {
      const p = stack[--top];
      const x = p % W; const y = (p - x) / W;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      sum += prob[p]; count++;
      if (x > 0 && mask[p - 1] === 1) { mask[p - 1] = 2; stack[top++] = p - 1; }
      if (x < W - 1 && mask[p + 1] === 1) { mask[p + 1] = 2; stack[top++] = p + 1; }
      if (y > 0 && mask[p - W] === 1) { mask[p - W] = 2; stack[top++] = p - W; }
      if (y < H - 1 && mask[p + W] === 1) { mask[p + W] = 2; stack[top++] = p + W; }
    }
    const bw = maxX - minX + 1; const bh = maxY - minY + 1;
    if (Math.min(bw, bh) < 3) continue;
    const score = sum / count;
    if (score < boxThr) continue;
    const d = (bw * bh * 1.5) / (2 * (bw + bh)); // "unclip": küçülmüş yazı bölgesini genişlet
    boxes.push({ x: Math.max(0, minX - d), y: Math.max(0, minY - d), w: Math.min(W, maxX + 1 + d) - Math.max(0, minX - d), h: Math.min(H, maxY + 1 + d) - Math.max(0, minY - d), score });
  }
  return boxes;
}

async function ocr(bitmap, det, rec, task) {
  const sw = bitmap.width; const sh = bitmap.height;
  const r = Math.min(1, OCR_LIMIT / Math.max(sw, sh));
  const W = Math.max(32, Math.round((sw * r) / 32) * 32);
  const H = Math.max(32, Math.round((sh * r) / 32) * 32);
  const img = crop(bitmap, 0, 0, sw, sh, W, H);
  const probT = firstOut(await det.session.run({ [det.input]: toTensor(img, W, H, { bgr: true, scale: 1 / 255, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] }) }), det.session);
  let boxes = textBoxes(probT.data, W, H, task.thr).sort((a, b) => b.score - a.score).slice(0, OCR_MAX_LINES);
  boxes.sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.h, b.h) / 2 ? a.y - b.y : a.x - b.x));
  const out = [];
  for (const b of boxes) {
    const x = (b.x / W) * sw; const y = (b.y / H) * sh; const w = (b.w / W) * sw; const h = (b.h / H) * sh;
    if (w < 4 || h < 4 || h > w * 1.5) continue; // dikey yazı desteklenmez
    const tw = Math.min(1280, Math.max(16, Math.ceil((48 * w) / h)));
    const t = firstOut(await rec.session.run({ [rec.input]: toTensor(crop(bitmap, x, y, w, h, tw, 48), tw, 48, { bgr: true, scale: 1 / 255, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] }) }), rec.session);
    const { text, score } = VDECODE.ctcDecode(t.data, t.dims[1], t.dims[2], rec.chars, 0);
    const clean = text.trim();
    if (clean && score >= 0.5) out.push({ module: task.module, text: clean, score, box: [x / sw, y / sh, w / sw, h / sh] });
  }
  return out;
}

// --- Plaka: plaka bulma + sabit haneli plaka okuma ---
async function plates(bitmap, det, rec, task, job) {
  const sw = bitmap.width; const sh = bitmap.height;
  const boxes = await detect(bitmap, det, task.thr, job);
  const { alphabet, pad, width, height } = rec.def;
  const out = [];
  for (const b of boxes.slice(0, 12)) {
    const w = b[2] - b[0]; const h = b[3] - b[1];
    if (w < 8 || h < 4) continue;
    const img = crop(bitmap, b[0], b[1], w, h, width, height);
    const data = new Uint8Array(width * height * 3);
    for (let i = 0, p = 0; i < width * height; i++, p += 4) { data[i * 3] = img.data[p]; data[i * 3 + 1] = img.data[p + 1]; data[i * 3 + 2] = img.data[p + 2]; }
    const res = await rec.session.run({ [rec.input]: new ort.Tensor('uint8', data, [1, height, width, 3]) });
    const t = res.plate || firstOut(res, rec.session);
    const slots = t.dims[t.dims.length - 2]; const C = t.dims[t.dims.length - 1];
    let text = ''; let sum = 0; let n = 0;
    for (let s = 0; s < slots; s++) {
      let best = 0; let bi = 0;
      for (let k = 0; k < C; k++) { const v = t.data[s * C + k]; if (v > best) { best = v; bi = k; } }
      const ch = alphabet[bi];
      if (ch !== pad) { text += ch; sum += best; n++; }
    }
    if (text.length >= 4) out.push({ module: task.module, text, score: Math.min(b[4], n ? sum / n : 0), box: [b[0] / sw, b[1] / sh, w / sw, h / sh] });
  }
  return out;
}

async function run(bitmap, job) {
  const t0 = performance.now();
  const result = { items: [], poses: [], texts: [], width: bitmap.width, height: bitmap.height, ms: 0, times: [], threads: ort.env.wasm.numThreads };
  const need = (id) => { const m = models.get(id); if (!m) throw new Error(`model:${id}`); return m; };
  for (const task of job.tasks) {
    const t1 = performance.now();
    if (task.type === 'detect') {
      const m = need(task.model);
      const minScore = Math.min(...task.outputs.map((o) => o.thr));
      const boxes = await detect(bitmap, m, minScore, job);
      const coco = m.def.labels === 'coco';
      const items = VDECODE.routeDetections(boxes, task.outputs, coco ? VISION.COCO : (m.def.labels || []), bitmap.width, bitmap.height, coco);
      for (const it of items) it.model = task.model;
      result.items.push(...items);
    } else if (task.type === 'pose') result.poses.push(...(await pose(bitmap, need(task.model), task)).slice(0, job.maxDet));
    else if (task.type === 'ocr') result.texts.push(...await ocr(bitmap, need(task.det), need(task.rec), task));
    else if (task.type === 'plate') result.texts.push(...await plates(bitmap, need(task.det), need(task.rec), task, job));
    result.times.push([task.type === 'detect' ? task.model : task.type, Math.round(performance.now() - t1)]);
  }
  result.ms = performance.now() - t0;
  return result;
}

async function load(id, def, files) {
  const old = models.get(id);
  if (old) { models.delete(id); try { await old.session.release(); } catch { /* yok */ } }
  const session = await ort.InferenceSession.create(new Uint8Array(files['model.onnx']), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const m = { def, session, input: session.inputNames[0], layout: def.decoder || 'auto', chars: null };
  // Nesne tanıma modelinin giriş boyutu sabitse modelin kendisinden okunur (tanımdaki değer yerine)
  try {
    const shape = session.inputMetadata && session.inputMetadata[0] && session.inputMetadata[0].shape;
    if (def.kind === 'detect' && shape && shape.length === 4 && Number.isInteger(shape[2]) && shape[2] === shape[3] && shape[2] >= 32) m.def = { ...def, inputSize: shape[2] };
  } catch { /* eski çalışma zamanı: tanımdaki boyut kullanılır */ }
  if (files['dict.txt']) {
    const lines = new TextDecoder('utf-8').decode(files['dict.txt']).split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    m.chars = ['', ...lines.map((l) => l.replace(/\r$/, '')), ' ']; // 0 = boşluk (blank), son = ara
  }
  models.set(id, m);
}

let chain = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      if (msg.type === 'init') {
        ort.env.wasm.wasmBinary = msg.wasm;
        ort.env.wasm.wasmPaths = new URL('../vendor/ort/', self.location.href).href;
        ort.env.wasm.numThreads = typeof SharedArrayBuffer === 'function' ? Math.max(1, Math.min(msg.threads || 1, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1; // çekirdeklerin yarısı: video çözme ve arayüz aç kalmasın
        ort.env.logLevel = 'error';
        self.postMessage({ seq: msg.seq, threads: ort.env.wasm.numThreads });
      } else if (msg.type === 'load') {
        await load(msg.id, msg.def, msg.files);
        self.postMessage({ seq: msg.seq });
      } else if (msg.type === 'unload') {
        const m = models.get(msg.id);
        models.delete(msg.id);
        if (m) try { await m.session.release(); } catch { /* yok */ }
        self.postMessage({ seq: msg.seq });
      } else if (msg.type === 'run') {
        try { self.postMessage({ seq: msg.seq, result: await run(msg.bitmap, msg.job) }); } finally { msg.bitmap.close(); }
      }
    } catch (err) {
      self.postMessage({ seq: msg.seq, error: String((err && err.message) || err).slice(0, 300) });
    }
  });
};
