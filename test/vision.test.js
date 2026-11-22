'use strict';

// Yapay görü: katalog bütünlüğü, ayar şeması, çıkış çözücüler ve model indirme/yönetimi (yerel sunucuyla).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const I18N = require('../src/i18n');
const SCHEMA = require('../src/schema');
const VISION = require('../src/vision/catalog');
const D = require('../src/vision/decode');
const { createModels } = require('../src/vision/models');

test('katalog: her modülün modelleri tanımlı, adresleri ve sağlamaları tam, metinleri Türkçe ve İngilizcede var', () => {
  assert.deepStrictEqual(VISION.MODULES.map((m) => m.id), ['pose', 'person', 'people', 'ocr', 'plate', 'vehicle', 'aircraft', 'animal', 'object']);
  const keys = [];
  for (const m of VISION.MODULES) {
    for (const id of m.models) assert.ok(VISION.MODELS[id], `${m.id}: ${id} modeli`);
    keys.push(`vis.m.${m.id}`, `vis.d.${m.id}`);
  }
  for (const m of Object.values(VISION.MODELS)) {
    keys.push(`vis.k.${m.kind}`);
    assert.ok(m.license, `${m.id}: lisans`);
    assert.ok(m.files.length && m.files[0].name === 'model.onnx');
    for (const f of m.files) {
      assert.match(f.url, /^https:\/\/(github\.com|media\.githubusercontent\.com|raw\.githubusercontent\.com|huggingface\.co)\//, `${m.id}: adres`);
      if (!f.loose) assert.match(f.sha256, /^[0-9a-f]{64}$/, `${m.id}: sha256`);
      assert.ok(f.size > 1000, `${m.id}: boyut`);
    }
  }
  for (const [k] of VISION.NUMBERS) keys.push(`vis.n.${k}`);
  for (const [k] of VISION.FLAGS) keys.push(`vis.f.${k}`);
  for (const d of VISION.DECODERS) keys.push(`vis.dec.${d}`);
  for (const e of ['download', 'checksum', 'too_large', 'no_source', 'bad_url', 'bad_args', 'io', 'busy', 'not_found']) keys.push(`vis.err.${e}`);
  for (const lang of ['tr', 'en']) assert.deepStrictEqual(keys.filter((k) => !(k in I18N.STRINGS[lang])), [], `${lang}: eksik metinler`);
  assert.strictEqual(VISION.COCO.length, 80);
  assert.strictEqual(VISION.cocoLabel(0, 'tr'), 'insan');
  assert.strictEqual(VISION.cocoLabel(4, 'en'), 'airplane');
  assert.strictEqual(VISION.cocoLabel(4, 'de'), 'airplane');
});

test('ayarlar: sınırlar uygulanır, bilinmeyen alanlar atılır, bağlantıyla birlikte saklanır', () => {
  const d = VISION.normalizeVision(null);
  assert.deepStrictEqual([d.rate, d.iou, d.maxDet, d.threads, d.line, d.font, d.autoRun, d.showLabels], [5, 45, 100, 4, 2, 13, false, true]);
  const v = VISION.normalizeVision({ rate: 99, iou: 1, threads: 'x', modules: { pose: { on: 1, sens: 250 }, plate: { on: 0 }, 'kötü ad': { on: true }, u_ab12cd: { on: true, sens: 30 } }, extra: 1 });
  assert.deepStrictEqual([v.rate, v.iou, v.threads], [30, 10, 4]);
  assert.deepStrictEqual(v.modules, { pose: { on: true, sens: 99 }, plate: { on: false, sens: 60 }, u_ab12cd: { on: true, sens: 30 } });
  assert.ok(!('extra' in v));
  const c = SCHEMA.normalize({ protocol: 'rtsp', name: 'x', vision: { modules: { ocr: { on: true, sens: 70 } } } });
  assert.deepStrictEqual(c.vision.modules, { ocr: { on: true, sens: 70 } });
  assert.ok(SCHEMA.CONNECTION_KEYS.includes('vision'));
  // Sayısal her ayarın alt ve üst sınırı var (panelde kaydırıcı)
  for (const [, a, b, def] of VISION.NUMBERS) assert.ok(a < b && def >= a && def <= b);
});

test('kullanıcı modeli: tanım doğrulanır ve panelde modül olur', () => {
  assert.strictEqual(VISION.normalizeUserModel({ id: 'x', name: 'a' }), null);
  assert.strictEqual(VISION.normalizeUserModel({ id: 'u_abcd12', name: '' }), null);
  const m = VISION.normalizeUserModel({ id: 'u_abcd12', name: ' Dron ', url: 'https://example.com/d.onnx', labels: 'drone, helicopter\nbird', inputSize: 5000, decoder: 'yok' });
  assert.deepStrictEqual([m.name, m.kind, m.user, m.decoder, m.inputSize], ['Dron', 'detect', true, 'auto', 1280]);
  assert.deepStrictEqual(m.labels, ['drone', 'helicopter', 'bird']);
  assert.strictEqual(m.files[0].url, 'https://example.com/d.onnx');
  assert.strictEqual(VISION.normalizeUserModel({ id: 'u_abcd12', name: 'x', url: 'ftp://a/b' }).files[0].url, '');
  const mods = VISION.modulesWith([m]);
  assert.strictEqual(mods.length, 10);
  assert.deepStrictEqual([mods[9].id, mods[9].name, mods[9].models[0], mods[9].user], ['u_abcd12', 'Dron', 'u_abcd12', true]);
});

test('çözücüler: YOLOX ızgarası, YOLOv8 ve uçtan uca biçimler, NMS, modüllere dağıtma, CTC', () => {
  // YOLOX 416: 52×52 + 26×26 + 13×13 = 3549 aday. Adım 8, hücre (10, 5): merkez (84, 44), 32×16 piksel
  const n = 3549; const c = 85;
  const data = new Float32Array(n * c);
  const i = 5 * 52 + 10;
  data.set([0.5, 0.5, Math.log(4), Math.log(2), 0.9], i * c); data[i * c + 5 + 2] = 0.8; // otomobil
  const j = 52 * 52 + 3 * 26 + 4; // adım 16, hücre (4, 3)
  data.set([0, 0, Math.log(2), Math.log(2), 0.95], j * c); data[j * c + 5] = 0.9;        // insan
  const lb = { scale: 0.5, dx: 0, dy: 0 }; // kaynak 832×832 → 416
  const out = { dims: [1, n, c], data };
  assert.strictEqual(D.guessLayout(out.dims, data, 416), 'yolox');
  const boxes = D.nms(D.decodeDetections(out, { layout: 'auto', size: 416, lb, sw: 832, sh: 832, minScore: 0.3 }), 0.45, 100);
  assert.strictEqual(boxes.length, 2);
  assert.deepStrictEqual(boxes[0].map((v) => Math.round(v * 100) / 100), [96, 64, 160, 128, 0.85, 0]); // 0,95 × 0,9
  assert.deepStrictEqual(boxes[1].map((v) => Math.round(v * 100) / 100), [136, 72, 200, 104, 0.72, 2]);
  // Modüllere dağıtma: sınıf süzgeci, eşik, "en çok 1"
  const items = D.routeDetections(boxes, [{ module: 'person', classes: [0], thr: 0.5, top: 1 }, { module: 'vehicle', classes: [2, 5], thr: 0.8, top: 0 }, { module: 'object', classes: null, thr: 0.3, top: 0 }], VISION.COCO, 832, 832, true);
  assert.deepStrictEqual(items.map((x) => `${x.module}:${x.label}`), ['person:person', 'object:person', 'object:car']);
  assert.deepStrictEqual(items[0].box.map((v) => Math.round(v * 1000) / 1000), [0.115, 0.077, 0.077, 0.077]);

  // YOLOv8: [1, 4 + sınıf, aday]; ortalanmış sığdırma (dx, dy)
  const n8 = 8400; const d8 = new Float32Array(6 * n8);
  d8[7] = 320; d8[n8 + 7] = 320; d8[2 * n8 + 7] = 100; d8[3 * n8 + 7] = 50; d8[5 * n8 + 7] = 0.77;
  const o8 = { dims: [1, 6, n8], data: d8 };
  assert.strictEqual(D.guessLayout(o8.dims, d8, 640), 'yolov8');
  const b8 = D.decodeDetections(o8, { layout: 'auto', size: 640, lb: { scale: 0.5, dx: 0, dy: 140 }, sw: 1280, sh: 720, minScore: 0.25 });
  assert.deepStrictEqual(b8.map((b) => b.map((v) => Math.round(v * 100) / 100)), [[540, 310, 740, 410, 0.77, 1]]);

  // Uçtan uca, 7 sütun: parti x1 y1 x2 y2 sınıf skor (plaka bulucu)
  const e7 = { dims: [2, 7], data: new Float32Array([0, 10, 20, 110, 60, 0, 0.9, 0, 0, 0, 5, 5, 0, 0.1]) };
  assert.strictEqual(D.guessLayout(e7.dims, e7.data, 384), 'end2end');
  assert.deepStrictEqual(D.decodeDetections(e7, { layout: 'end2end', size: 384, lb: { scale: 1, dx: 0, dy: 0 }, sw: 384, sh: 384, minScore: 0.25 }).map((b) => b.slice(0, 4)), [[10, 20, 110, 60]]);
  const e6 = { dims: [1, 1, 6], data: new Float32Array([1, 2, 3, 4, 0.5, 3]) };
  assert.deepStrictEqual(D.decodeDetections(e6, { layout: 'auto', size: 640, lb: { scale: 1, dx: 0, dy: 0 }, sw: 640, sh: 640, minScore: 0.25 }), [[1, 2, 3, 4, 0.5, 3]]);

  // NMS: aynı sınıfta çakışan kutulardan yüksek skorlu kalır; farklı sınıflar ayrı tutulur
  const kept = D.nms([[0, 0, 10, 10, 0.9, 1], [1, 1, 10, 10, 0.8, 1], [1, 1, 10, 10, 0.7, 2], [50, 50, 60, 60, 0.6, 1]], 0.45, 10);
  assert.deepStrictEqual(kept.map((b) => b[4]), [0.9, 0.7, 0.6]);
  assert.strictEqual(D.nms([[0, 0, 10, 10, 0.9, 1], [50, 50, 60, 60, 0.6, 1]], 0.45, 1).length, 1);

  // CTC: yinelenenler ve boşluk atılır; sözlük = [boşluk] + satırlar + [' ']
  const chars = ['', 'A', 'Ş', ' '];
  const seq = [1, 1, 0, 1, 2, 2, 3, 0, 2];
  const logits = new Float32Array(seq.length * 4);
  seq.forEach((k, t) => { logits[t * 4 + k] = 0.9; });
  const r = D.ctcDecode(logits, seq.length, 4, chars, 0);
  assert.strictEqual(r.text, 'AAŞ Ş');
  assert.ok(Math.abs(r.score - 0.9) < 1e-6);
});

test('modeller: indirme (sağlama doğrulaması, ilerleme), kullanıcı modeli ekleme ve silme', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-models-'));
  const body = crypto.randomBytes(300000);
  const srv = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/m.onnx' }); return res.end(); }
    if (req.url === '/m.onnx') { res.writeHead(200, { 'Content-Length': body.length }); return res.end(body); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let user = [];
  const events = [];
  const models = createModels({ dir: () => dir, fetch, getUserModels: () => user, setUserModels: (l) => { user = l; }, emit: (e, d) => events.push(d) });
  try {
    // Hazır modeller başta inmemiş görünür
    const list = models.list();
    assert.deepStrictEqual(list.map((m) => m.id), ['det', 'pose', 'ocrdet', 'ocrrec', 'aircraft', 'platedet', 'platerec']);
    assert.ok(list.every((m) => !m.installed && m.remote && m.size > 0));
    assert.strictEqual(await models.read('det'), null);

    // Kullanıcı modeli: adresle eklenir, ilk kullanımdan önce indirilir (yönlendirme izlenir)
    const a = await models.addUser({ name: 'Dron', url: `${base}/redirect`, labels: 'drone,bird', inputSize: 320 });
    assert.ok(a.ok && /^u_[0-9a-f]{10}$/.test(a.id));
    assert.strictEqual(models.installed(a.id), false);
    const r = await models.download(a.id);
    assert.deepStrictEqual(r, { ok: true });
    assert.ok(models.installed(a.id));
    assert.ok(events.some((e) => e.state === 'start') && events.some((e) => e.state === 'done' && e.done === body.length));
    const got = await models.read(a.id);
    assert.deepStrictEqual([got.def.name, got.def.inputSize, got.def.labels.join()], ['Dron', 320, 'drone,bird']);
    assert.ok(Buffer.from(got.files['model.onnx']).equals(body));
    assert.ok(fs.existsSync(path.join(dir, a.id, 'model.onnx')) && !fs.existsSync(path.join(dir, a.id, 'model.onnx.part')));

    // Dosyadan ekleme: modeller klasörüne kopyalanır
    const local = path.join(dir, 'kendi.onnx');
    fs.writeFileSync(local, body.subarray(0, 1000));
    const b = await models.addUser({ name: 'Yerel', file: local });
    assert.ok(b.ok && models.installed(b.id));
    assert.strictEqual(models.list().find((m) => m.id === b.id).remote, false);

    // Geçersiz girişler
    assert.strictEqual((await models.addUser({ name: 'x' })).error, 'no_source');
    assert.strictEqual((await models.addUser({ name: 'x', url: 'ftp://a/b.onnx' })).error, 'bad_url');
    assert.strictEqual((await models.addUser({ name: '', url: `${base}/m.onnx` })).error, 'bad_args');
    assert.strictEqual((await models.download('yok')).error, 'not_found');

    // Bulunamayan adres: hata bildirilir, yarım dosya kalmaz
    const c = await models.addUser({ name: 'Kırık', url: `${base}/yok.onnx` });
    assert.strictEqual((await models.download(c.id)).error, 'download');
    assert.ok(!models.installed(c.id) && !fs.existsSync(path.join(dir, c.id, 'model.onnx.part')));

    // Silme ve kaldırma
    assert.ok(await models.remove(a.id));
    assert.ok(!models.installed(a.id) && user.some((m) => m.id === a.id));
    assert.ok(await models.removeUser(b.id));
    assert.ok(!user.some((m) => m.id === b.id) && !fs.existsSync(path.join(dir, b.id)));
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('modeller: sağlaması tutmayan indirme reddedilir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-models-'));
  const real = VISION.MODELS.ocrrec.files[1]; // küçük sözlük dosyası
  const fake = (url) => Promise.resolve(new Response(url === real.url ? 'bozuk içerik' : Buffer.alloc(10), { status: 200 }));
  const models = createModels({ dir: () => dir, fetch: fake, getUserModels: () => [], setUserModels: () => {}, emit: () => {} });
  try {
    const r = await models.download('ocrrec');
    assert.strictEqual(r.error, 'checksum');
    assert.strictEqual(models.installed('ocrrec'), false);
    assert.deepStrictEqual(fs.existsSync(path.join(dir, 'ocrrec')) ? fs.readdirSync(path.join(dir, 'ocrrec')) : [], []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
