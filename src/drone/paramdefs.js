'use strict';
// Parametre dokümantasyonu yükleyicisi (ArduPilot + PX4).
// Veri: src/drone/paramdefs/*.json.gz — resmi üst akış (upstream) metadatasından üretilir.
// Türkçe: strings.tr.json.gz — anahtar = İngilizce metnin normalize hali
//   (rakam dizileri sırayla {0},{1}… ile değiştirilir; böylece "Motor 1"…"Motor 32" tek kayıt olur).
// Electron ana süreçte (main) kullanılır; tembel (lazy) yükleme + önbellek.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, 'paramdefs');
const VEHICLE_FILES = { copter: 'copter', plane: 'plane', rover: 'rover', sub: 'sub', heli: 'copter', vtol: 'plane' };
// Rakamı ailenin parçası olan (örnek numarası olmayan) önekler
const KEEP_DIGIT_PREFIX = new Set(['EK2', 'EK3']);

const cache = new Map(); // dosya adı -> ayrıştırılmış JSON
const loaders = new Map(); // "firmware/vehicle" -> yükleyici nesnesi
let dictTr = null;
let groupTitles = null;

function readGz(file) {
  if (cache.has(file)) return cache.get(file);
  const buf = zlib.gunzipSync(fs.readFileSync(path.join(DIR, file)));
  const obj = JSON.parse(buf.toString('utf8'));
  cache.set(file, obj);
  return obj;
}

function dictionary(lang) {
  if (lang !== 'tr') return null;
  if (!dictTr) {
    try { dictTr = readGz('strings.tr.json.gz'); } catch (e) { dictTr = {}; }
  }
  return dictTr;
}

function titles() {
  if (!groupTitles) {
    try { groupTitles = JSON.parse(fs.readFileSync(path.join(DIR, 'groups.json'), 'utf8')); } catch (e) { groupTitles = {}; }
  }
  return groupTitles;
}

// İngilizce metni sözlük anahtarına çevirir: rakam dizileri -> {0},{1}…
function templateKey(s) {
  const nums = [];
  const key = s.replace(/\d+/g, (m) => { nums.push(m); return '{' + (nums.length - 1) + '}'; });
  return { key, nums };
}

// Tek bir metni çevirir; bulunamazsa null döner.
function translate(s, lang) {
  const dict = dictionary(lang);
  if (!dict || !s) return null;
  const { key, nums } = templateKey(s);
  const t = dict[key];
  if (typeof t !== 'string' || !t) return null;
  return nums.length ? t.replace(/\{(\d+)\}/g, (m, i) => (nums[i] !== undefined ? nums[i] : m)) : t;
}

function tr(s, lang) {
  if (!s) return '';
  const t = translate(s, lang);
  return t === null ? s : t;
}

// Ağaç grubu: ilk alt çizgiden önceki önek; rakamlı/harfli örnek aileleri birleştirilir.
function groupOf(name) {
  if (typeof name !== 'string') return '';
  const i = name.indexOf('_');
  if (i <= 0) return '';
  let p = name.slice(0, i);
  if (KEEP_DIGIT_PREFIX.has(p)) return p;
  if (/^BATT[A-G]$/.test(p)) return 'BATT';
  const stripped = p.replace(/\d+$/, '');
  return stripped || p;
}

function px4GroupTitle(prefix) {
  // PX4: önekteki parametrelerin en sık geçen "group" başlığı
  const data = readGz('px4.json.gz');
  if (!data._groupByPrefix) {
    const counts = {};
    for (const [name, e] of Object.entries(data.params)) {
      if (!e.g) continue;
      const p = groupOf(name);
      if (!p) continue;
      (counts[p] = counts[p] || {})[e.g] = (counts[p][e.g] || 0) + 1;
    }
    const best = {};
    for (const [p, c] of Object.entries(counts)) best[p] = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
    Object.defineProperty(data, '_groupByPrefix', { value: best, enumerable: false });
  }
  return data._groupByPrefix[prefix] || '';
}

// Grup başlığı. ArduPilot: elle derlenmiş tablo (groups.json — upstream metadatasında kütüphane başlığı yok).
// PX4: metadatadaki "group" alanı. Bilinmiyorsa '' döner.
function describeGroup(prefix, lang, firmware) {
  if (!prefix) return '';
  if (firmware === 'px4') {
    const g = px4GroupTitle(prefix);
    return g ? tr(g, lang) : '';
  }
  const t = titles()[prefix];
  if (!t) return '';
  return (lang === 'tr' && t.tr) || t.en || '';
}

function createLoader(firmware, vehicleKey) {
  const file = firmware === 'px4' ? 'px4.json.gz' : 'ardupilot-' + vehicleKey + '.json.gz';
  const data = readGz(file);
  const params = data.params;
  const alpha = new Set(data.alpha || []);
  const resolved = new Map();
  const coverageCache = new Map();

  // Örnek numaralarını '#' ile değiştirir (SERVO9_ -> SERVO#_, BATTA_ -> BATT#_)
  function normKey(name) {
    let n = name;
    const m = /^([A-Z]+)([A-Z])_/.exec(n);
    if (m && alpha.has(m[1])) n = m[1] + '#_' + n.slice(m[0].length);
    return n.replace(/\d+/g, '#');
  }

  // '#' eklenmiş adaylar: BATT_MONITOR -> BATT#_MONITOR
  function insertCandidates(n) {
    const out = [];
    for (let i = 1; i <= n.length; i++) {
      if (i === n.length || n[i] === '_') out.push(n.slice(0, i) + '#' + n.slice(i));
    }
    return out;
  }

  // Sıra: birebir -> örnek şablonu -> tabanın şablonu -> ilk örnek -> yok
  function resolve(name) {
    if (typeof name !== 'string' || !name) return null;
    if (resolved.has(name)) return resolved.get(name);
    let key = null;
    if (Object.prototype.hasOwnProperty.call(params, name)) key = name;
    if (!key) {
      const nk = normKey(name);
      const cands = [nk];
      for (const c of insertCandidates(nk)) cands.push(c);
      cands.push(name.replace(/\d+/g, '1'));
      cands.push(name.replace(/\d+/g, ''));
      const m = /^([A-Z]+)([A-Z])_/.exec(name);
      if (m && alpha.has(m[1])) cands.push(m[1] + '_' + name.slice(m[0].length));
      for (const c of cands) {
        if (c !== name && Object.prototype.hasOwnProperty.call(params, c)) { key = c; break; }
      }
    }
    let res = null;
    if (key) {
      const entry = params[key];
      let prefix = '';
      if (entry.p) {
        const sufLen = key.length - entry.p.length;
        // sonek aynıysa gerçek öneki çıkar; değilse şablon önekini rakamsız kullan
        prefix = name.slice(name.length - sufLen) === key.slice(key.length - sufLen)
          ? name.slice(0, name.length - sufLen)
          : entry.p.replace(/#/g, '');
      }
      res = { key, entry, prefix };
    }
    resolved.set(name, res);
    return res;
  }

  function text(s, lang, prefix) {
    if (!s) return '';
    const out = tr(s, lang);
    return out.indexOf('{P}') === -1 ? out : out.split('{P}').join(prefix);
  }

  function lookup(name, lang) {
    const r = resolve(name);
    if (!r) return null;
    const e = r.entry;
    const descSrc = e.d || e.n || '';
    const values = [];
    if (e.v) for (const [k, v] of Object.entries(e.v)) values.push({ value: Number(k), label: text(v, lang, r.prefix) });
    const bits = [];
    if (e.b) for (const [k, v] of Object.entries(e.b)) bits.push({ bit: Number(k), label: text(v, lang, r.prefix) });
    let group;
    if (e.g) group = tr(e.g, lang);
    else {
      const p = groupOf(name);
      group = describeGroup(p, lang, firmware) || p;
    }
    return {
      name,
      displayName: text(e.n, lang, r.prefix),
      description: text(descSrc, lang, r.prefix),
      units: e.u || '',
      range: e.r ? [e.r[0], e.r[1]] : null,
      increment: e.i === undefined ? null : e.i,
      values,
      bits,
      readOnly: !!e.ro,
      rebootRequired: !!e.rb,
      group,
      translated: lang === 'tr' && !!descSrc && translate(descSrc, lang) !== null,
    };
  }

  // Çeviri kapsamı: bu dosyadaki kayıtlar üzerinden (şablon aileleri bir kez sayılır)
  function coverage(lang) {
    const l = lang || 'en';
    if (coverageCache.has(l)) return coverageCache.get(l);
    const strings = new Set();
    let descriptions = 0;
    let descriptionsTranslated = 0;
    const en = l !== 'tr';
    for (const e of Object.values(params)) {
      const d = e.d || e.n;
      if (d) {
        descriptions++;
        if (en || translate(d, l) !== null) descriptionsTranslated++;
      }
      if (e.n) strings.add(e.n);
      if (e.d) strings.add(e.d);
      if (e.g) strings.add(e.g);
      if (e.v) for (const v of Object.values(e.v)) strings.add(v);
      if (e.b) for (const v of Object.values(e.b)) strings.add(v);
    }
    let stringsTranslated = 0;
    for (const s of strings) if (en || translate(s, l) !== null) stringsTranslated++;
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    const out = {
      lang: l,
      descriptions,
      descriptionsTranslated,
      descriptionPercent: pct(descriptionsTranslated, descriptions),
      strings: strings.size,
      stringsTranslated,
      stringPercent: pct(stringsTranslated, strings.size),
    };
    coverageCache.set(l, out);
    return out;
  }

  return {
    firmware,
    vehicle: firmware === 'px4' ? 'px4' : vehicleKey,
    lookup,
    has: (name) => resolve(name) !== null,
    size: data.count || Object.keys(params).length,
    revision: data.revision || '',
    source: data.source || '',
    generated: data.generated || '',
    coverage,
  };
}

// firmware: 'ardupilot' | 'px4'; vehicle: 'copter' | 'plane' | 'rover' | 'sub' | 'heli' | 'vtol' | diğer (-> copter)
function load(firmware, vehicle) {
  const fw = String(firmware || '').toLowerCase() === 'px4' ? 'px4' : 'ardupilot';
  const vk = fw === 'px4' ? 'px4' : (VEHICLE_FILES[String(vehicle || '').toLowerCase()] || 'copter');
  const id = fw + '/' + vk;
  if (!loaders.has(id)) loaders.set(id, createLoader(fw, vk));
  return loaders.get(id);
}

module.exports = { load, groupOf, describeGroup, translate };
