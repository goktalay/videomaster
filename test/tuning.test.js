'use strict';

// Dron "Ayarlar" modülünün tanımları (src/drone/tuning.js): metinler, aralıklar, eşlemeler, birim dönüşümleri,
// bağlı (linked) yazımlar, hazır takımlar ve bit maskeleri.
const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/drone/tuning');
const { DEFAULT_PARAMS } = require('./sim/vehicle-sim');

const byId = (id) => T.all().find((s) => s.id === id);
const store = (obj) => { const m = new Map(Object.entries(obj)); const get = (n) => m.get(n); get.map = m; return get; };
const simGet = (over = {}) => store({ ...Object.fromEntries(DEFAULT_PARAMS.map(([n, v]) => [n, v])), ...over });
const copter = (get) => ({ firmware: 'ardupilot', vehicle: 'copter', has: (n) => get(n) !== undefined, modes: [{ id: 0, name: 'Stabilize' }, { id: 5, name: 'Loiter' }, { id: 6, name: 'RTL' }] });
const anyCtx = (firmware, vehicle) => ({ firmware, vehicle, has: () => true, modes: [] });
const both = (o) => o && typeof o.tr === 'string' && o.tr.length > 0 && typeof o.en === 'string' && o.en.length > 0;

test('ayarlar: her ayarın Türkçe ve İngilizce başlığı ile açıklaması var, kimlikler benzersiz', () => {
  const ids = new Set();
  assert.ok(T.all().length >= 60, 'onlarca ayar');
  for (const g of T.GROUPS) {
    assert.ok(both(g.title) && both(g.intro), `grup metni: ${g.id}`);
    assert.ok(g.icon && g.settings.length, `grup: ${g.id}`);
    for (const s of g.settings) {
      assert.ok(!ids.has(s.id), `yinelenen kimlik: ${s.id}`);
      ids.add(s.id);
      assert.ok(both(s.title), `başlık: ${s.id}`);
      assert.ok(both(s.desc), `açıklama: ${s.id}`);
      assert.ok(s.desc.tr.length >= 60, `açıklama yeterince ayrıntılı: ${s.id}`);
      assert.ok(['number', 'select', 'toggle', 'bits', 'preset'].includes(s.kind), `tür: ${s.id}`);
    }
  }
  for (const [k, v] of Object.entries(T.UI)) assert.ok(both(v), `arayüz metni: ${k}`);
});

test('ayarlar: aralıklar, seçenekler ve eşlemeler geçerli', () => {
  for (const s of T.all()) {
    assert.ok(Array.isArray(s.map) && s.map.length, `eşleme: ${s.id}`);
    for (const m of s.map) {
      assert.ok(['ardupilot', 'px4'].includes(m.fw), `yazılım: ${s.id}`);
      assert.ok(m.params.length, `parametre: ${s.id}`);
      for (const x of m.params) assert.match(typeof x === 'string' ? x : x.name, /^[A-Z][A-Z0-9_]{2,15}$/, `parametre adı: ${s.id}`);
      const v = T.view(s, m, { modes: [{ id: 0, name: 'Stabilize' }] });
      if (s.kind === 'number') {
        assert.ok(Number.isFinite(v.min) && Number.isFinite(v.max) && v.min < v.max, `aralık: ${s.id}`);
        assert.ok(v.step > 0 && v.step <= v.max - v.min, `adım: ${s.id}`);
        assert.ok(['speed', 'rate', 'angle', 'altitude', 'time', 'battery', 'bar', 'radius'].includes(v.gauge), `gösterge: ${s.id}`);
        assert.strictEqual(typeof v.unit, 'string', `birim: ${s.id}`);
      }
      if (s.kind === 'select' || s.kind === 'preset') {
        assert.ok(v.options.length >= 1, `seçenek: ${s.id}`);
        for (const o of v.options) assert.ok(both(o.label), `seçenek adı: ${s.id}`);
        assert.strictEqual(new Set(v.options.map((o) => o.value)).size, v.options.length, `seçenek değerleri benzersiz: ${s.id}`);
      }
      if (s.kind === 'preset') {
        assert.deepStrictEqual(Object.keys(m.bundles).sort(), v.options.map((o) => o.value).sort(), `takımlar seçeneklerle eşleşir: ${s.id}`);
        for (const b of Object.values(m.bundles)) assert.ok(m.params.every((n) => n in b), `zorunlu parametre takımda: ${s.id}`);
      }
      if (s.kind === 'bits') for (const b of s.bits) assert.ok(Number.isInteger(b.bit) && b.bit >= 0 && b.bit < 32 && both(b.label), `bit: ${s.id}`);
      if (s.kind === 'toggle') assert.ok(m.params.every((x) => x.on !== undefined && x.off !== undefined), `aç/kapa değerleri: ${s.id}`);
    }
  }
});

test('ayarlar: resolve yazılıma ve araca göre eşleme seçer, parametresi olmayan ayarı gizler', () => {
  const s = byId('missionSpeed');
  assert.strictEqual(T.resolve(s, anyCtx('ardupilot', 'copter')).params[0].name, 'WPNAV_SPEED');
  assert.strictEqual(T.resolve(s, anyCtx('px4', 'copter')).params[0].name, 'MPC_XY_CRUISE');
  assert.strictEqual(T.resolve(s, anyCtx('ardupilot', 'rover')).params[0].name, 'WP_SPEED');
  // ArduPlane 4.5 adı varsa o, yoksa eski ad (cm/s) kullanılır
  assert.strictEqual(T.resolve(s, anyCtx('ardupilot', 'plane')).params[0].name, 'AIRSPEED_CRUISE');
  const old = T.resolve(s, { firmware: 'ardupilot', vehicle: 'plane', has: (n) => n === 'TRIM_ARSPD_CM' });
  assert.strictEqual(old.params[0].name, 'TRIM_ARSPD_CM');
  assert.strictEqual(old.params[0].scale, 100);
  assert.strictEqual(T.resolve(s, { firmware: 'ardupilot', vehicle: 'copter', has: () => false }), null);
  assert.strictEqual(T.resolve(s, anyCtx('betaflight', 'copter')), null);
  assert.strictEqual(T.resolve(byId('takeoffSpeed'), anyCtx('ardupilot', 'copter')), null, 'yalnızca PX4 ayarı');
  assert.strictEqual(T.resolve(byId('rcLossPwm'), anyCtx('px4', 'copter')), null, 'yalnızca ArduCopter ayarı');
  assert.strictEqual(T.resolve(byId('fltmode1'), { firmware: 'ardupilot', vehicle: 'rover', has: (n) => n === 'MODE1' }).params[0].name, 'MODE1');
});

test('ayarlar: available benzetimli ArduCopter için bütün grupları ve onlarca ayarı verir', () => {
  const get = simGet();
  const groups = T.available(copter(get));
  assert.deepStrictEqual(groups.map((g) => g.id), ['speed', 'takeoff', 'landing', 'rtl', 'failsafe', 'fence', 'feel', 'modes']);
  const n = groups.reduce((a, g) => a + g.items.length, 0);
  assert.ok(n >= 60, `ayar sayısı: ${n}`);
  for (const g of groups) for (const it of g.items) {
    assert.notStrictEqual(T.read(it.setting, it.mapping, get), undefined);
    assert.ok(it.setting.kind === 'preset' || T.read(it.setting, it.mapping, get) !== null, `okunabilir: ${it.setting.id}`);
    assert.deepStrictEqual(T.plan(it.setting, it.mapping, T.read(it.setting, it.mapping, get), get), [], `değişmeyen ayar yazım üretmez: ${it.setting.id}`);
  }
  // Kip seçenekleri araçtan gelen kip listesinden kurulur
  const fm = groups.find((g) => g.id === 'modes').items.find((it) => it.setting.id === 'fltmode3');
  assert.deepStrictEqual(fm.view.options.map((o) => o.value), [0, 5, 6]);
  assert.strictEqual(T.read(fm.setting, fm.mapping, get), 5);
  // PX4'te de kullanılabilir ayarlar var; Betaflight'ta yok
  assert.ok(T.available(anyCtx('px4', 'copter')).reduce((a, g) => a + g.items.length, 0) >= 30);
  assert.deepStrictEqual(T.available(anyCtx('betaflight', 'copter')), []);
});

test('ayarlar: read ve plan birim dönüşümleri (m/s ↔ cm/s, m ↔ cm, ° ↔ santiderece, s ↔ ms, % ↔ oran)', () => {
  const get = simGet();
  const ctx = copter(get);
  const rp = (id, c = ctx, g = get) => { const s = byId(id); const m = T.resolve(s, c); return { s, m, read: () => T.read(s, m, g), plan: (v) => T.plan(s, m, v, g) }; };

  const speed = rp('missionSpeed');
  assert.strictEqual(speed.read(), 10);
  assert.deepStrictEqual(speed.plan(8), [{ name: 'WPNAV_SPEED', value: 800, from: 1000 }]);

  const rtl = rp('rtlAlt');
  assert.strictEqual(rtl.read(), 15);
  assert.deepStrictEqual(rtl.plan(30), [{ name: 'RTL_ALT', value: 3000, from: 1500 }]);

  const lean = rp('maxLean');
  assert.strictEqual(lean.read(), 30);
  assert.deepStrictEqual(lean.plan(45), [{ name: 'ANGLE_MAX', value: 4500, from: 3000 }]);
  assert.deepStrictEqual(lean.plan(30), [], 'aynı değer yazılmaz');

  const wait = rp('rtlLoiterTime');
  assert.strictEqual(wait.read(), 5);
  assert.deepStrictEqual(wait.plan(12), [{ name: 'RTL_LOIT_TIME', value: 12000, from: 5000 }]);

  assert.strictEqual(rp('landSpeed').read(), 0.5);
  assert.deepStrictEqual(rp('landSpeed').plan(0.35), [{ name: 'LAND_SPEED', value: 35, from: 50 }]);
  assert.strictEqual(rp('pilotYawRate').read(), 202.5, 'adım dışı değer yuvarlanmaz');

  // float32'den gelen 0.15000000596 → 0.15; aynı değer yeniden yazılmaz
  const f32 = simGet({ ATC_INPUT_TC: Math.fround(0.15) });
  const tc = rp('inputSmooth', copter(f32), f32);
  assert.strictEqual(tc.read(), 0.15);
  assert.deepStrictEqual(tc.plan(0.15), []);
  assert.deepStrictEqual(tc.plan(0.2).map((w) => [w.name, w.value]), [['ATC_INPUT_TC', 0.2]]);

  // PX4: doğrudan m/s; yüzde ↔ 0–1 oran
  const px = store({ MPC_XY_CRUISE: 5, MPC_XY_VEL_MAX: 12, BAT_LOW_THR: Math.fround(0.15) });
  const pctx = { firmware: 'px4', vehicle: 'copter', has: (n) => px(n) !== undefined };
  assert.strictEqual(rp('missionSpeed', pctx, px).read(), 5);
  assert.deepStrictEqual(rp('missionSpeed', pctx, px).plan(8), [{ name: 'MPC_XY_CRUISE', value: 8, from: 5 }]);
  assert.strictEqual(rp('battLowPct', pctx, px).read(), 15);
  assert.deepStrictEqual(rp('battLowPct', pctx, px).plan(20).map((w) => [w.name, w.value]), [['BAT_LOW_THR', 0.2]]);

  // ArduPlane eski adıyla: cm/s
  const pl = store({ TRIM_ARSPD_CM: 1800 });
  const plctx = { firmware: 'ardupilot', vehicle: 'plane', has: (n) => pl(n) !== undefined };
  assert.strictEqual(rp('missionSpeed', plctx, pl).read(), 18);
  assert.deepStrictEqual(rp('missionSpeed', plctx, pl).plan(22), [{ name: 'TRIM_ARSPD_CM', value: 2200, from: 1800 }]);
});

test('ayarlar: plan bağlı (linked) yazımları gerekçesiyle ekler, gereksizse eklemez', () => {
  const s = byId('missionSpeed');
  const get = simGet(); // WPNAV_ACCEL 250, ANGLE_MAX 3000
  const m = T.resolve(s, copter(get));
  // 10 → 12 m/s: gereken ivme 300 > 250 → WPNAV_ACCEL de yükselir
  const w = T.plan(s, m, 12, get);
  assert.deepStrictEqual(w.map((x) => [x.name, x.value, x.from]), [['WPNAV_SPEED', 1200, 1000], ['WPNAV_ACCEL', 300, 250]]);
  assert.strictEqual(w[0].why, undefined);
  assert.ok(both(w[1].why), 'bağlı yazımın iki dilde gerekçesi var');
  // Hız düşürülünce ek yazım yok
  assert.deepStrictEqual(T.plan(s, m, 6, get).map((x) => x.name), ['WPNAV_SPEED']);
  // Yüksek hız + küçük yatış açısı: ANGLE_MAX da yükselir; ivme üst sınırı 500
  const low = simGet({ ANGLE_MAX: 2000 });
  assert.deepStrictEqual(T.plan(s, m, 20, low).map((x) => [x.name, x.value]), [['WPNAV_SPEED', 2000], ['WPNAV_ACCEL', 500], ['ANGLE_MAX', 3000]]);
  // Araçta olmayan bağlı parametre atlanır
  const bare = store({ WPNAV_SPEED: 1000 });
  assert.deepStrictEqual(T.plan(s, m, 20, bare).map((x) => x.name), ['WPNAV_SPEED']);

  // PX4: görev hızı üst sınırı aşarsa sınır da yükselir
  const px = store({ MPC_XY_CRUISE: 5, MPC_XY_VEL_MAX: 12 });
  const pm = T.resolve(s, { firmware: 'px4', vehicle: 'copter', has: (n) => px(n) !== undefined });
  assert.deepStrictEqual(T.plan(s, pm, 15, px).map((x) => [x.name, x.value, !!x.why]), [['MPC_XY_CRUISE', 15, false], ['MPC_XY_VEL_MAX', 15, true]]);
  assert.deepStrictEqual(T.plan(s, pm, 10, px).map((x) => x.name), ['MPC_XY_CRUISE']);

  // Batarya: kritik eşik düşük eşiğin üstüne çıkarsa düşük eşik de yükselir (ve tersi)
  const crit = byId('battCritVolt');
  const cm = T.resolve(crit, copter(get));
  assert.deepStrictEqual(T.plan(crit, cm, 14.2, get).map((x) => [x.name, x.value]), [['BATT_CRT_VOLT', 14.2], ['BATT_LOW_VOLT', 14.7]]);
  assert.deepStrictEqual(T.plan(crit, cm, 13.5, get).map((x) => x.name), ['BATT_CRT_VOLT']);
  const lowV = byId('battLowVolt');
  assert.deepStrictEqual(T.plan(lowV, T.resolve(lowV, copter(get)), 13, get).map((x) => [x.name, x.value]), [['BATT_LOW_VOLT', 13], ['BATT_CRT_VOLT', 12.5]]);
});

test('ayarlar: hazır takımlar belgelenen parametre demetini üretir ve araçtaki değerlerden tanınır', () => {
  const s = byId('flightStyle');
  const get = simGet();
  const m = T.resolve(s, copter(get));
  assert.strictEqual(T.read(s, m, get), 'normal', 'benzetimli araç fabrika değerlerinde');
  // Sakin: bütün demet (değişenler) yazılır
  const calm = T.plan(s, m, 'calm', get);
  assert.deepStrictEqual(Object.fromEntries(calm.map((w) => [w.name, w.value])), { WPNAV_SPEED: 500, WPNAV_SPEED_UP: 150, WPNAV_SPEED_DN: 100, WPNAV_ACCEL: 100, LOIT_SPEED: 500, LOIT_ACC_MAX: 250, ANGLE_MAX: 2000, PILOT_SPEED_UP: 150 });
  assert.ok(calm.every((w) => w.from === get(w.name)));
  for (const w of calm) get.map.set(w.name, w.value);
  assert.strictEqual(T.read(s, m, get), 'calm');
  assert.deepStrictEqual(T.plan(s, m, 'calm', get), []);
  // Hızlı: demetin tamamı değişir; tek tek ayarlar yeni değerleri gösterir
  const fast = T.plan(s, m, 'fast', get);
  assert.strictEqual(fast.length, 8);
  for (const w of fast) get.map.set(w.name, w.value);
  assert.strictEqual(T.read(s, m, get), 'fast');
  assert.strictEqual(T.read(byId('missionSpeed'), T.resolve(byId('missionSpeed'), copter(get)), get), 15);
  assert.strictEqual(T.read(byId('maxLean'), T.resolve(byId('maxLean'), copter(get)), get), 40);
  // Tek bir değer oynarsa takım "özel" olur
  get.map.set('ANGLE_MAX', 3500);
  assert.strictEqual(T.read(s, m, get), null);
  // Araçta olmayan parametre takımdan atlanır
  const few = store({ WPNAV_SPEED: 1000, ANGLE_MAX: 3000 });
  assert.deepStrictEqual(T.plan(s, m, 'veryfast', few).map((w) => [w.name, w.value]), [['WPNAV_SPEED', 2000], ['ANGLE_MAX', 4500]]);

  // İniş karakteri
  const land = byId('landStyle');
  const g2 = simGet();
  const lm = T.resolve(land, copter(g2));
  assert.strictEqual(T.read(land, lm, g2), 'normal');
  assert.deepStrictEqual(T.plan(land, lm, 'soft', g2).map((w) => [w.name, w.value]), [['LAND_SPEED', 30], ['LAND_SPEED_HIGH', 100], ['LAND_ALT_LOW', 1500]]);
});

test('ayarlar: bit maskeleri ve aç/kapa ayarları okunur ve yazılır', () => {
  const get = simGet(); // FENCE_TYPE 7, FENCE_ENABLE 0, ARMING_CHECK 1, FS_OPTIONS 16
  const ctx = copter(get);
  const type = byId('fenceType');
  const tm = T.resolve(type, ctx);
  assert.strictEqual(T.read(type, tm, get), 7);
  assert.deepStrictEqual(T.plan(type, tm, 7 | 8, get), [{ name: 'FENCE_TYPE', value: 15, from: 7 }]);
  assert.deepStrictEqual(T.plan(type, tm, 3, get), [{ name: 'FENCE_TYPE', value: 3, from: 7 }]);
  assert.strictEqual(T.read(byId('fsOptions'), T.resolve(byId('fsOptions'), ctx), get), 16);

  const en = byId('fenceEnable');
  const em = T.resolve(en, ctx);
  assert.strictEqual(T.read(en, em, get), false);
  assert.deepStrictEqual(T.plan(en, em, true, get), [{ name: 'FENCE_ENABLE', value: 1, from: 0 }]);
  assert.deepStrictEqual(T.plan(en, em, false, get), []);

  // ARMING_CHECK: özel bit maskesi "açık" sayılır ve açıkken ona dokunulmaz; kapatmak 0 yazar ve uyarı gerektirir
  const arm = byId('armingCheck');
  const custom = simGet({ ARMING_CHECK: 72 });
  const am = T.resolve(arm, copter(custom));
  assert.strictEqual(T.read(arm, am, custom), true);
  assert.deepStrictEqual(T.plan(arm, am, true, custom), []);
  assert.deepStrictEqual(T.plan(arm, am, false, custom), [{ name: 'ARMING_CHECK', value: 0, from: 72 }]);
  assert.ok(both(T.risk(arm, am, false)));
  assert.strictEqual(T.risk(arm, am, true), null);
});

test('ayarlar: güvenliği etkileyen değerler uyarı üretir', () => {
  const ctx = anyCtx('ardupilot', 'copter');
  const r = (id, v, c = ctx) => { const s = byId(id); return T.risk(s, T.resolve(s, c), v); };
  assert.ok(both(r('rcLoss', 0)));
  assert.strictEqual(r('rcLoss', 1), null);
  assert.ok(both(r('gcsLoss', 0)));
  assert.ok(both(r('fenceEnable', false)));
  assert.strictEqual(r('fenceEnable', true), null);
  assert.ok(both(r('battLowAct', 0)));
  assert.ok(both(r('battCritAct', 5)));
  assert.strictEqual(r('battLowAct', 2), null);
  assert.strictEqual(r('missionSpeed', 20), null);
  // PX4 eşlemesinin kendi uyarısı: sonlandırma seçenekleri
  assert.ok(both(r('rcLoss', 5, anyCtx('px4', 'copter'))));
  assert.strictEqual(r('rcLoss', 2, anyCtx('px4', 'copter')), null);
});

test('ayarlar: yardımcılar — text, clamp, equal, matches, cells, paramNames', () => {
  assert.strictEqual(T.text({ tr: 'Hız', en: 'Speed' }, 'tr'), 'Hız');
  assert.strictEqual(T.text({ tr: 'Hız', en: 'Speed' }, 'de'), 'Speed');
  assert.strictEqual(T.text(null, 'tr'), '');
  const v = T.view(byId('missionSpeed'), T.resolve(byId('missionSpeed'), anyCtx('ardupilot', 'copter')), {});
  assert.strictEqual(T.clamp(v, 99), 20);
  assert.strictEqual(T.clamp(v, -3), 0.5);
  assert.strictEqual(T.clamp(v, '7.5'), 7.5);
  assert.strictEqual(T.clamp(v, 'x'), null);
  assert.ok(T.equal(0.1 + 0.2, 0.3) && T.equal('calm', 'calm') && T.equal(true, true));
  assert.ok(!T.equal(8, 8.5) && !T.equal(null, 0) && !T.equal('calm', 'fast'));
  // Eşleme aralığı ve açıklamayı değiştirebilir (PX4 görev hızı en az 3 m/s)
  assert.strictEqual(T.view(byId('missionSpeed'), T.resolve(byId('missionSpeed'), anyCtx('px4', 'copter')), {}).min, 3);

  const item = (id) => { const s = byId(id); const m = T.resolve(s, anyCtx('ardupilot', 'copter')); return { setting: s, mapping: m, view: T.view(s, m, {}) }; };
  assert.ok(T.matches(item('rtlAlt'), 'dönüş'));
  assert.ok(T.matches(item('rtlAlt'), 'rtl_alt'));
  assert.ok(T.matches(item('rtlAlt'), 'Return altitude'));
  assert.ok(T.matches(item('flightStyle'), 'LOIT_SPEED'), 'takımdaki parametre adıyla bulunur');
  assert.ok(!T.matches(item('rtlAlt'), 'pusula'));
  assert.ok(T.matches(item('rtlAlt'), ''));

  assert.strictEqual(T.cells(14.0, null), 4);
  assert.strictEqual(T.cells(21.0, null), 6);
  assert.strictEqual(T.cells(9.9, null), 3);
  assert.strictEqual(T.cells(14.0, store({ MOT_BAT_VOLT_MAX: 25.2 })), 6);
  assert.strictEqual(T.cells(0, null), 0);
  assert.ok(T.paramNames(byId('flightStyle'), T.resolve(byId('flightStyle'), anyCtx('ardupilot', 'copter'))).includes('ANGLE_MAX'));
});
