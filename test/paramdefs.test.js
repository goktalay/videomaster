'use strict';

// Parametre dokümantasyonu: veri dosyaları, örnek (instance) geri dönüşü, Türkçe sözlük (ağ gerektirmez)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const P = require('../src/drone/paramdefs');

const DIR = path.join(__dirname, '..', 'src', 'drone', 'paramdefs');
const label = (list, key, v) => (list.find((x) => x[key] === v) || {}).label;

test('paramdefs: tüm veri dosyaları yüklenir ve boyut hedefi korunur', () => {
  for (const v of ['copter', 'plane', 'rover', 'sub']) {
    const l = P.load('ardupilot', v);
    assert.ok(l.size > 4000, v + ' parametre sayısı');
    assert.ok(l.revision.length > 5);
    assert.ok(l.has('BATT_MONITOR'), v + ' BATT_MONITOR');
  }
  const px4 = P.load('px4');
  assert.ok(px4.size > 1500);
  assert.ok(px4.revision.length > 5);
  // araç eşlemeleri ve önbellek
  assert.strictEqual(P.load('ardupilot', 'heli'), P.load('ardupilot', 'copter'));
  assert.strictEqual(P.load('ardupilot', 'vtol'), P.load('ardupilot', 'plane'));
  assert.strictEqual(P.load('ardupilot', 'bilinmeyen'), P.load('ardupilot', 'copter'));
  assert.strictEqual(P.load('PX4', 'copter'), px4);
  const total = fs.readdirSync(DIR).reduce((n, f) => n + fs.statSync(path.join(DIR, f)).size, 0);
  assert.ok(total < 1.5 * 1024 * 1024, 'toplam boyut ' + total);
});

test('paramdefs: Copter bilinen parametreler anlamlı metadata döndürür', () => {
  const c = P.load('ardupilot', 'copter');
  const fc = c.lookup('FRAME_CLASS', 'en');
  assert.strictEqual(fc.name, 'FRAME_CLASS');
  assert.strictEqual(fc.displayName, 'Frame Class');
  assert.strictEqual(label(fc.values, 'value', 1), 'Quad');
  assert.ok(fc.values.length >= 10);
  assert.strictEqual(fc.rebootRequired, true);
  assert.strictEqual(fc.translated, false);

  const p = c.lookup('ATC_RAT_RLL_P', 'en');
  assert.ok(Array.isArray(p.range) && p.range.length === 2);
  assert.ok(p.range[0] < p.range[1]);
  assert.ok(p.increment > 0);
  assert.match(p.description, /Roll axis rate controller P gain/);
  assert.strictEqual(p.group, 'Attitude Control');

  const bm = c.lookup('BATT_MONITOR', 'en');
  assert.strictEqual(label(bm.values, 'value', 0), 'Disabled');
  assert.strictEqual(label(bm.values, 'value', 4), 'Analog Voltage and Current');

  // eski (4.6 ve öncesi) adlar da çözülür
  const ac = c.lookup('ARMING_CHECK', 'en');
  assert.ok(ac.bits.length >= 10);
  assert.strictEqual(label(ac.bits, 'bit', 1), 'Barometer');
  assert.ok(c.has('ANGLE_MAX') && c.has('WPNAV_SPEED') && c.has('ATC_ANGLE_MAX'));

  assert.strictEqual(c.lookup('BOYLE_BIR_PARAMETRE_YOK', 'en'), null);
  assert.strictEqual(c.has('BOYLE_BIR_PARAMETRE_YOK'), false);
  assert.strictEqual(c.lookup('', 'en'), null);
});

test('paramdefs: örnek (instance) aileleri geri dönüşle çözülür', () => {
  const c = P.load('ardupilot', 'copter');
  const s9 = c.lookup('SERVO9_FUNCTION', 'en');
  assert.strictEqual(s9.name, 'SERVO9_FUNCTION');
  assert.strictEqual(s9.displayName, 'Servo output function');
  assert.strictEqual(label(s9.values, 'value', 33), 'Motor1');
  assert.strictEqual(s9.group, 'Servo Outputs');
  // listede olmayan numara -> şablon
  assert.strictEqual(c.lookup('SERVO40_MIN', 'en').displayName, 'Minimum PWM');
  assert.deepStrictEqual(c.lookup('RC12_MIN', 'en').range, c.lookup('RC1_MIN', 'en').range);
  // öneke bağlı metin gerçek önekle doldurulur
  assert.match(c.lookup('BATT2_LOW_VOLT', 'en').description, /BATT2_LOW_TIMER/);
  assert.match(c.lookup('BATT_LOW_VOLT', 'en').description, /BATT_LOW_TIMER/);
  assert.match(c.lookup('BATTB_LOW_VOLT', 'en').description, /BATTB_LOW_TIMER/);
  assert.doesNotMatch(c.lookup('BATT3_LOW_VOLT', 'tr').description, /\{P\}/);
  assert.ok(c.has('CAN_D2_UC_NODE'));
});

test('paramdefs: PX4 parametreleri', () => {
  const x = P.load('px4');
  const v = x.lookup('MPC_XY_VEL_MAX', 'en');
  assert.strictEqual(v.units, 'm/s');
  assert.ok(v.range[1] > v.range[0]);
  assert.strictEqual(v.group, 'Multicopter Position Control');
  const m = x.lookup('COM_RC_IN_MODE', 'en');
  assert.ok(m.values.length >= 4);
  assert.match(label(m.values, 'value', 0), /RC only/);
  assert.strictEqual(P.describeGroup('MPC', 'en', 'px4'), 'Multicopter Position Control');
});

test('paramdefs: Türkçe arama çevrilmiş, farklı ve boş olmayan metin döndürür', () => {
  const c = P.load('ardupilot', 'copter');
  for (const n of ['FRAME_CLASS', 'ATC_RAT_RLL_P', 'BATT_MONITOR', 'ARMING_CHECK', 'SERVO9_FUNCTION']) {
    const en = c.lookup(n, 'en');
    const tr = c.lookup(n, 'tr');
    assert.strictEqual(tr.translated, true, n);
    assert.ok(tr.description.length > 0 && tr.displayName.length > 0, n);
    assert.notStrictEqual(tr.description, en.description, n);
    assert.notStrictEqual(tr.displayName, en.displayName, n);
    // sayısal alanlar dile bağlı değildir
    assert.deepStrictEqual(tr.range, en.range);
    assert.strictEqual(tr.values.length, en.values.length);
    assert.strictEqual(tr.bits.length, en.bits.length);
  }
  assert.strictEqual(c.lookup('FRAME_CLASS', 'tr').displayName, 'Gövde Sınıfı');
  assert.strictEqual(label(c.lookup('FRAME_CLASS', 'tr').values, 'value', 1), 'Quad');
  assert.strictEqual(label(c.lookup('BATT_MONITOR', 'tr').values, 'value', 0), 'Devre dışı');
  assert.strictEqual(label(c.lookup('ARMING_CHECK', 'tr').bits, 'bit', 1), 'Barometre');
  assert.match(c.lookup('ARMING_CHECK', 'tr').description, /ARMING_CHECK/);
  assert.match(c.lookup('ARMING_CHECK', 'tr').description, /72/);
  // şablonlu çeviri: sayılar ve önek korunur
  assert.match(c.lookup('BATT2_LOW_VOLT', 'tr').description, /BATT2_LOW_TIMER/);
  assert.match(c.lookup('RC9_MAX', 'tr').description, /1000.*1500.*2000/);
  // bilinmeyen dil -> İngilizce
  assert.strictEqual(c.lookup('FRAME_CLASS', 'de').displayName, 'Frame Class');
});

test('paramdefs: groupOf ve describeGroup', () => {
  assert.strictEqual(P.groupOf('SERVO1_FUNCTION'), 'SERVO');
  assert.strictEqual(P.groupOf('BATT2_MONITOR'), 'BATT');
  assert.strictEqual(P.groupOf('BATTA_MONITOR'), 'BATT');
  assert.strictEqual(P.groupOf('BATT_MONITOR'), 'BATT');
  assert.strictEqual(P.groupOf('RC10_OPTION'), 'RC');
  assert.strictEqual(P.groupOf('ATC_RAT_RLL_P'), 'ATC');
  assert.strictEqual(P.groupOf('EK3_SRC1_POSXY'), 'EK3');
  assert.strictEqual(P.groupOf('EK2_ENABLE'), 'EK2');
  assert.strictEqual(P.groupOf('Q_A_RAT_RLL_P'), 'Q');
  assert.strictEqual(P.groupOf('MPC_XY_VEL_MAX'), 'MPC');
  assert.strictEqual(P.groupOf('FORMAT'), '');
  assert.strictEqual(P.groupOf(''), '');
  assert.strictEqual(P.groupOf(null), '');
  assert.strictEqual(P.describeGroup('BATT', 'en'), 'Battery Monitor');
  assert.strictEqual(P.describeGroup('BATT', 'tr'), 'Batarya Monitörü');
  assert.strictEqual(P.describeGroup('YOKBOYLE', 'tr'), '');
  assert.strictEqual(P.describeGroup('', 'tr'), '');
});

test('paramdefs: Türkçe kapsam raporlanan değerlerin altına düşmez', () => {
  const c = P.load('ardupilot', 'copter').coverage('tr');
  assert.strictEqual(c.descriptionPercent, 100);
  assert.strictEqual(c.stringPercent, 100);
  assert.strictEqual(c.descriptionsTranslated, c.descriptions);
  const min = { plane: [85, 85], rover: [100, 100], sub: [100, 100] };
  for (const [v, [d, s]] of Object.entries(min)) {
    const k = P.load('ardupilot', v).coverage('tr');
    assert.ok(k.descriptionPercent >= d, v + ' açıklama ' + k.descriptionPercent);
    assert.ok(k.stringPercent >= s, v + ' metin ' + k.stringPercent);
  }
  const en = P.load('ardupilot', 'copter').coverage('en');
  assert.strictEqual(en.descriptionPercent, 100);
});

test('paramdefs: sözlük bütünlüğü (boş çeviri yok, yer tutucular tutarlı)', () => {
  const dict = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, 'strings.tr.json.gz'))).toString('utf8'));
  const keys = Object.keys(dict);
  assert.ok(keys.length > 5000);
  for (const k of keys) {
    const v = dict[k];
    assert.ok(typeof v === 'string' && v.trim().length > 0, 'boş çeviri: ' + k);
    assert.ok(!/\d/.test(k.replace(/\{\d+\}/g, '')), 'anahtar şablon biçiminde olmalı: ' + k);
    const kp = (k.match(/\{\d+\}/g) || []);
    for (const ph of v.match(/\{\d+\}/g) || []) assert.ok(kp.includes(ph), 'bilinmeyen yer tutucu ' + ph + ' : ' + k);
    assert.strictEqual((v.match(/\{P\}/g) || []).length, (k.match(/\{P\}/g) || []).length, '{P} sayısı: ' + k);
  }
});
