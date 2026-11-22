// Yapay görü: model çıkışlarını çözen saf işlevler (işçide importScripts ile, sınamalarda require ile yüklenir).
// Kutular kaynak görüntünün pikselleriyle [x1, y1, x2, y2, skor, sınıf] olarak döner.
(function (root) {
  'use strict';

  const iou = (a, b) => {
    const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (w <= 0 || h <= 0) return 0;
    const inter = w * h;
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
  };

  // Sınıfa göre açgözlü NMS; skorca sıralı döner
  function nms(boxes, iouThr, maxDet, classAware = true) {
    const sorted = boxes.slice().sort((a, b) => b[4] - a[4]);
    const keep = [];
    for (const b of sorted) {
      if (keep.length >= maxDet) break;
      let ok = true;
      for (const k of keep) if ((!classAware || k[5] === b[5]) && iou(k, b) > iouThr) { ok = false; break; }
      if (ok) keep.push(b);
    }
    return keep;
  }

  // Sığdırma bilgisi: { scale, dx, dy } — model girişindeki nokta → kaynak piksel
  const unmap = (lb, x, y) => [(x - lb.dx) / lb.scale, (y - lb.dy) / lb.scale];
  const clip = (v, max) => Math.max(0, Math.min(max, v));
  function toSource(lb, sw, sh, x1, y1, x2, y2, score, cls) {
    const [a, b] = unmap(lb, x1, y1);
    const [c, d] = unmap(lb, x2, y2);
    return [clip(a, sw), clip(b, sh), clip(c, sw), clip(d, sh), score, cls];
  }

  // Çıkış biçimini boyutlardan kestirir
  function guessLayout(dims, data, size) {
    const d = dims.length === 3 ? dims.slice(1) : dims;
    if (d.length !== 2) return 'yolov8';
    const [a, b] = d;
    if (b === 6 || b === 7) return 'end2end';
    if (a < b) return 'yolov8'; // [4 + sınıf, aday]
    // [aday, 5 + sınıf]: YOLOX ızgara birimleriyle, YOLOv5 pikselle verir
    let maxXY = 0;
    for (let i = 0; i < Math.min(a, 400); i++) maxXY = Math.max(maxXY, data[i * b], data[i * b + 1]);
    return maxXY <= size / 8 + 2 ? 'yolox' : 'yolov5';
  }

  // out: { dims, data }; opt: { layout, size, lb, sw, sh, minScore }
  function decodeDetections(out, opt) {
    const { size, lb, sw, sh, minScore } = opt;
    const data = out.data;
    const dims = out.dims.length === 3 ? out.dims.slice(1) : out.dims;
    const layout = opt.layout && opt.layout !== 'auto' ? opt.layout : guessLayout(out.dims, data, size);
    const res = [];
    if (layout === 'end2end') {
      const [n, c] = dims;
      for (let i = 0; i < n; i++) {
        const o = i * c;
        // 6: x1 y1 x2 y2 skor sınıf · 7: parti x1 y1 x2 y2 sınıf skor
        const [x1, y1, x2, y2, score, cls] = c === 7 ? [data[o + 1], data[o + 2], data[o + 3], data[o + 4], data[o + 6], data[o + 5]] : [data[o], data[o + 1], data[o + 2], data[o + 3], data[o + 4], data[o + 5]];
        if (score >= minScore && x2 > x1 && y2 > y1) res.push(toSource(lb, sw, sh, x1, y1, x2, y2, score, Math.round(cls)));
      }
      return res;
    }
    if (layout === 'yolov8') {
      const [c, n] = dims;
      const nc = c - 4;
      for (let i = 0; i < n; i++) {
        let best = 0; let cls = 0;
        for (let k = 0; k < nc; k++) { const s = data[(4 + k) * n + i]; if (s > best) { best = s; cls = k; } }
        if (best < minScore) continue;
        const cx = data[i]; const cy = data[n + i]; const w = data[2 * n + i]; const h = data[3 * n + i];
        res.push(toSource(lb, sw, sh, cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, best, cls));
      }
      return res;
    }
    // yolox / yolov5: [aday, 5 + sınıf]
    const [n, c] = dims;
    const nc = c - 5;
    let grid = null;
    if (layout === 'yolox') {
      grid = [];
      for (const s of [8, 16, 32]) { const g = Math.floor(size / s); for (let y = 0; y < g; y++) for (let x = 0; x < g; x++) grid.push(x, y, s); }
      if (grid.length / 3 !== n) grid = null; // ızgara uymuyor: çözülmüş kabul et
    }
    for (let i = 0; i < n; i++) {
      const o = i * c;
      const obj = data[o + 4];
      if (obj < minScore) continue;
      let best = 0; let cls = 0;
      for (let k = 0; k < nc; k++) { const s = data[o + 5 + k]; if (s > best) { best = s; cls = k; } }
      const score = nc > 0 ? obj * best : obj;
      if (score < minScore) continue;
      let cx = data[o]; let cy = data[o + 1]; let w = data[o + 2]; let h = data[o + 3];
      if (grid) { const s = grid[i * 3 + 2]; cx = (cx + grid[i * 3]) * s; cy = (cy + grid[i * 3 + 1]) * s; w = Math.exp(w) * s; h = Math.exp(h) * s; }
      res.push(toSource(lb, sw, sh, cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, score, cls));
    }
    return res;
  }

  // Algılayıcı sonuçlarını modüllere dağıtır: outputs = [{ module, classes, thr, top }]
  function routeDetections(boxes, outputs, labels, sw, sh, coco) {
    const items = [];
    for (const o of outputs) {
      let list = boxes.filter((b) => b[4] >= o.thr && (!o.classes || o.classes.includes(b[5])));
      if (o.top) list = list.slice(0, o.top);
      for (const b of list) items.push({ module: o.module, cls: b[5], coco: !!coco, label: labels[b[5]] !== undefined ? labels[b[5]] : `#${b[5]}`, score: b[4], box: [b[0] / sw, b[1] / sh, (b[2] - b[0]) / sw, (b[3] - b[1]) / sh] });
    }
    return items;
  }

  // CTC: en olası dizinlerden yinelenenler ve boşluk (blank) atılır. logits: [T, C] düz dizi
  function ctcDecode(data, T, C, chars, blank = 0) {
    let text = ''; let sum = 0; let n = 0; let prev = -1;
    for (let t = 0; t < T; t++) {
      let best = 0; let bi = 0;
      for (let k = 0; k < C; k++) { const v = data[t * C + k]; if (v > best) { best = v; bi = k; } }
      if (bi !== blank && bi !== prev) { text += chars[bi] !== undefined ? chars[bi] : ''; sum += best; n++; }
      prev = bi;
    }
    return { text, score: n ? sum / n : 0 };
  }

  const api = { iou, nms, guessLayout, decodeDetections, routeDetections, ctcDecode, toSource };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VDECODE = api;
})(typeof self !== 'undefined' ? self : this);
