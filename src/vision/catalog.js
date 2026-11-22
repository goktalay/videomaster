// Yapay görü kataloğu: modüller (panelde açılıp kapananlar), hazır modeller ve ayarların şeması.
// Ana süreçte (require), pencerelerde (<script>) ve görü işçisinde (importScripts) aynı dosya kullanılır.
// Hazır modellerin hiçbiri kurulumla gelmez; ilk kullanımdan önce modeller klasörüne indirilir.
(function (root) {
  'use strict';

  const COCO = ['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench',
    'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard',
    'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana',
    'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop',
    'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'];

  const COCO_TR = ['insan', 'bisiklet', 'otomobil', 'motosiklet', 'uçak', 'otobüs', 'tren', 'kamyon', 'tekne', 'trafik ışığı', 'yangın musluğu', 'dur levhası', 'parkmetre', 'bank',
    'kuş', 'kedi', 'köpek', 'at', 'koyun', 'inek', 'fil', 'ayı', 'zebra', 'zürafa', 'sırt çantası', 'şemsiye', 'el çantası', 'kravat', 'bavul', 'frizbi', 'kayak', 'snowboard',
    'top', 'uçurtma', 'beyzbol sopası', 'beyzbol eldiveni', 'kaykay', 'sörf tahtası', 'tenis raketi', 'şişe', 'kadeh', 'fincan', 'çatal', 'bıçak', 'kaşık', 'kâse', 'muz',
    'elma', 'sandviç', 'portakal', 'brokoli', 'havuç', 'sosisli', 'pizza', 'donut', 'pasta', 'sandalye', 'kanepe', 'saksı bitkisi', 'yatak', 'yemek masası', 'klozet', 'televizyon', 'dizüstü bilgisayar',
    'fare', 'kumanda', 'klavye', 'cep telefonu', 'mikrodalga', 'fırın', 'tost makinesi', 'lavabo', 'buzdolabı', 'kitap', 'saat', 'vazo', 'makas', 'oyuncak ayı', 'saç kurutma makinesi', 'diş fırçası'];
  const cocoLabel = (i, lang) => (lang === 'tr' ? COCO_TR[i] : COCO[i]) || `#${i}`;

  // Hazır modeller. Hepsi açık lisanslıdır ve kendi yayın adreslerinden indirilir; sha256 ile doğrulanır.
  // kind: detect | pose | ocrdet | ocrrec | platedet | platerec
  const GH = 'https://github.com';
  const PPU = 'https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';
  const MODELS = {
    det: {
      id: 'det', name: 'YOLOX-Tiny · COCO 80', kind: 'detect', decoder: 'yolox', inputSize: 416, labels: 'coco', license: 'Apache-2.0', source: 'Megvii YOLOX',
      files: [{ name: 'model.onnx', url: `${GH}/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx`, size: 20219662, sha256: '427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7' }],
    },
    pose: {
      id: 'pose', name: 'RTMO-t · 17 nokta', kind: 'pose', inputSize: 416, license: 'Apache-2.0', source: 'OpenMMLab MMPose',
      files: [{ name: 'model.onnx', url: `${GH}/namas191297/rtmo-ort/releases/download/v0.1.0/rtmo_t_416x416_body7.onnx`, size: 27392033, sha256: '823e530e0ab3a7279c24e9678237fd80376d89682c0d80901f41a429b5da6462' }],
    },
    ocrdet: {
      id: 'ocrdet', name: 'PP-OCRv5 mobile · yazı bulma', kind: 'ocrdet', license: 'Apache-2.0', source: 'PaddleOCR',
      files: [{ name: 'model.onnx', url: `${PPU}/detection/PP-OCRv5_mobile_det_infer.onnx`, size: 4748769, sha256: 'd7fe3ea74652890722c0f4d02458b7261d9f5ae6c92904d05707c9eb155c7924' }],
    },
    ocrrec: {
      id: 'ocrrec', name: 'PP-OCRv5 mobile · Latin (Türkçe dahil)', kind: 'ocrrec', license: 'Apache-2.0', source: 'PaddleOCR',
      files: [
        { name: 'model.onnx', url: `${PPU}/recognition/multi/latin/v5/latin_PP-OCRv5_mobile_rec_infer.onnx`, size: 8066518, sha256: '497dbed20b7fd86334c9deb5082c2958982a316bb16e3589ebc6502cd85cae79' },
        { name: 'dict.txt', url: 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/ppocrv5_latin_dict.txt', size: 2616, sha256: 'ccbcc45730b3fbbd9050c5bc74db6a99067141ef1035e3d14889a84a6b9b1aff' },
      ],
    },
    platedet: {
      id: 'platedet', name: 'YOLOv9-t 384 · plaka bulma', kind: 'platedet', decoder: 'end2end', inputSize: 384, labels: ['plate'], license: 'MIT', source: 'ankandrew/open-image-models',
      files: [{ name: 'model.onnx', url: `${GH}/ankandrew/open-image-models/releases/download/assets/yolo-v9-t-384-license-plates-end2end.onnx`, size: 7771218, sha256: '888397b96d761c89db40bc9c305838e8652660f5e282c2cadebbe8d2951a77a8' }],
    },
    platerec: {
      id: 'platerec', name: 'CCT-XS v2 · plaka okuma', kind: 'platerec', license: 'MIT', source: 'ankandrew/fast-plate-ocr',
      alphabet: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_', pad: '_', width: 128, height: 64,
      files: [{ name: 'model.onnx', url: `${GH}/ankandrew/cnn-ocr-lp/releases/download/arg-plates/cct_xs_v2_global.onnx`, size: 3344292, sha256: '8031afb5fdc6b4d80462c9d542f1284ebd2cfddf5dbacd62609848d7e2855f44' }],
    },
  };

  // Modüller: models = gereken modeller; classes = genel algılayıcıdan alınan COCO sınıfları (yoksa hepsi); top = en çok kaç sonuç
  const MODULES = [
    { id: 'pose', icon: 'user', color: '#f472b6', models: ['pose'], sens: 60 },
    { id: 'person', icon: 'user', color: '#22d3ee', models: ['det'], classes: [0], top: 1, sens: 55 },
    { id: 'people', icon: 'user', color: '#34d399', models: ['det'], classes: [0], sens: 55 },
    { id: 'ocr', icon: 'text', color: '#fbbf24', models: ['ocrdet', 'ocrrec'], sens: 40 },
    { id: 'plate', icon: 'hdd', color: '#fb923c', models: ['platedet', 'platerec'], sens: 60 },
    { id: 'vehicle', icon: 'drive', color: '#60a5fa', models: ['det'], classes: [1, 2, 3, 5, 6, 7, 8], sens: 55 },
    { id: 'aircraft', icon: 'upload', color: '#c084fc', models: ['det'], classes: [4], sens: 60 },
    { id: 'animal', icon: 'eye', color: '#a3e635', models: ['det'], classes: [14, 15, 16, 17, 18, 19, 20, 21, 22, 23], sens: 55 },
    { id: 'object', icon: 'layers', color: '#94a3b8', models: ['det'], sens: 50 },
  ];
  const USER_COLORS = ['#f43f5e', '#14b8a6', '#eab308', '#8b5cf6', '#f97316', '#06b6d4'];

  // Sayısal ayarlar (hepsi panelde kaydırıcı): [anahtar, alt, üst, varsayılan]
  const NUMBERS = [['rate', 1, 30, 5], ['iou', 10, 90, 45], ['maxDet', 1, 300, 100], ['threads', 1, 8, 4], ['line', 1, 8, 2], ['font', 9, 28, 13]];
  const FLAGS = [['autoRun', false], ['showLabels', true], ['showScores', true]];
  const DECODERS = ['auto', 'yolox', 'yolov8', 'yolov5', 'end2end'];

  const clampInt = (v, a, b, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : d; };

  // Kullanıcının eklediği nesne tanıma modeli → katalog biçimi
  function normalizeUserModel(m) {
    if (!m || typeof m !== 'object' || !/^u_[a-z0-9]{4,24}$/.test(String(m.id || ''))) return null;
    const name = String(m.name || '').trim().slice(0, 60);
    if (!name) return null;
    const url = /^https?:\/\//i.test(String(m.url || (m.files && m.files[0] && m.files[0].url) || '')) ? String(m.url || m.files[0].url).trim().slice(0, 1000) : '';
    const labels = (Array.isArray(m.labels) ? m.labels : String(m.labels || '').split(/[\n,;]/)).map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 1000);
    return {
      id: m.id, name, kind: 'detect', user: true, decoder: DECODERS.includes(m.decoder) ? m.decoder : 'auto',
      inputSize: clampInt(m.inputSize, 160, 1280, 640), labels, source: url, files: [{ name: 'model.onnx', url }],
    };
  }

  // Kullanıcı modelleri panelde birer modül olarak görünür
  function modulesWith(userModels) {
    const extra = (userModels || []).map(normalizeUserModel).filter(Boolean).map((m, i) => ({ id: m.id, icon: 'flask', color: USER_COLORS[i % USER_COLORS.length], models: [m.id], user: true, name: m.name, sens: 50 }));
    return [...MODULES, ...extra];
  }

  function defaults() {
    const v = { modules: {} };
    for (const [k, , , d] of NUMBERS) v[k] = d;
    for (const [k, d] of FLAGS) v[k] = d;
    return v;
  }

  // Bağlantıya kaydedilen ayarlar: { modules: { <modül>: { on, sens } }, rate, iou, maxDet, threads, line, font, ... }
  function normalizeVision(input) {
    const src = input && typeof input === 'object' ? input : {};
    const v = defaults();
    for (const [k, a, b, d] of NUMBERS) v[k] = clampInt(src[k], a, b, d);
    for (const [k, d] of FLAGS) v[k] = src[k] === undefined ? d : !!src[k];
    const mods = src.modules && typeof src.modules === 'object' ? src.modules : {};
    for (const [id, m] of Object.entries(mods).slice(0, 64)) {
      if (!/^[a-z0-9_]{1,32}$/.test(id) || !m || typeof m !== 'object') continue;
      const base = MODULES.find((x) => x.id === id);
      v.modules[id] = { on: !!m.on, sens: clampInt(m.sens, 1, 99, base ? base.sens : 50) };
    }
    return v;
  }
  const moduleState = (v, mod) => (v.modules && v.modules[mod.id]) || { on: false, sens: mod.sens };

  const api = { COCO, cocoLabel, MODELS, MODULES, NUMBERS, FLAGS, DECODERS, normalizeUserModel, modulesWith, defaults, normalizeVision, moduleState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VISION = api;
})(typeof self !== 'undefined' ? self : this);
