'use strict';

// Betaflight sabit tabloları (bellenim kaynağından alınmıştır; sürümler arasında değişenler ayrı ayrı tutulur).
//   mixer tabloları     : src/main/flight/mixer_init.c (4.5 ile master aynı), mixerMode_e: src/main/flight/mixer.h
//   kurma engelleri     : src/main/fc/runtime_config.c  armingDisableFlagNames[]
//   kutu (box) adları   : src/main/msp/msp_box.c        boxes[] (permanentId → ad)
//   motor protokolleri  : src/main/drivers/motor_types.h motorProtocolTypes_e
//   algılayıcı bitleri  : src/main/msp/msp.c MSP_STATUS_EX

// Karıştırıcı satırı: [gaz, yatış (roll), yunuslama (pitch), sapma (yaw)]. Motor sırası = Betaflight motor numarası (1'den).
// Konum: yatış katsayısı + ise motor soldadır (x = −roll), yunuslama katsayısı + ise motor arkadadır (y = −pitch).
// Yön: mixer.c, yaw_motors_reversed kapalıyken sapmayı ters çevirir; bu durumda sapma katsayısı − olan motor saat yönünde (CW) döner
// (quad X varsayılanı "pervaneler içe": 1 arka-sağ CW, 2 ön-sağ CCW, 3 arka-sol CCW, 4 ön-sol CW).
const QUAD_X = [[1, -1, 1, -1], [1, -1, -1, 1], [1, 1, 1, 1], [1, 1, -1, -1]];
const MIXERS = {
  1: { name: 'TRI', key: 'TRI', motors: [[1, 0, 1.333333, 0], [1, -1, -0.666667, 0], [1, 1, -0.666667, 0]] }, // sapma kuyruk servosuyla
  2: { name: 'QUAD +', key: 'QUADP', motors: [[1, 0, 1, -1], [1, -1, 0, 1], [1, 1, 0, 1], [1, 0, -1, -1]] },
  3: { name: 'QUAD X', key: 'QUADX', motors: QUAD_X },
  4: { name: 'BICOPTER', key: 'BI', motors: [[1, 1, 0, 0], [1, -1, 0, 0]] },
  5: { name: 'GIMBAL', key: 'GIMBAL', motors: null, count: 0 },
  6: { name: 'Y6', key: 'Y6', motors: [[1, 0, 1.333333, 1], [1, -1, -0.666667, -1], [1, 1, -0.666667, -1], [1, 0, 1.333333, -1], [1, -1, -0.666667, 1], [1, 1, -0.666667, 1]] },
  7: { name: 'HEX +', key: 'HEX6', motors: [[1, -0.866025, 0.5, 1], [1, -0.866025, -0.5, -1], [1, 0.866025, 0.5, 1], [1, 0.866025, -0.5, -1], [1, 0, -1, 1], [1, 0, 1, -1]] },
  8: { name: 'FLYING WING', key: 'FLYING_WING', motors: null, count: 1 },
  // Y4: öndeki iki motorun sapma katsayısı 0'dır; yönleri kaynak koddaki açıklamadan (FRONT_R CCW, FRONT_L CW)
  9: { name: 'Y4', key: 'Y4', motors: [[1, 0, 1, -1], [1, -1, -1, 0], [1, 0, 1, 1], [1, 1, -1, 0]], dirs: [undefined, 'ccw', undefined, 'cw'] },
  10: { name: 'HEX X', key: 'HEX6X', motors: [[1, -0.5, 0.866025, 1], [1, -0.5, -0.866025, 1], [1, 0.5, 0.866025, -1], [1, 0.5, -0.866025, -1], [1, -1, 0, -1], [1, 1, 0, 1]] },
  11: { name: 'OCTO X8', key: 'OCTOX8', motors: [[1, -1, 1, -1], [1, -1, -1, 1], [1, 1, 1, 1], [1, 1, -1, -1], [1, -1, 1, 1], [1, -1, -1, -1], [1, 1, 1, -1], [1, 1, -1, 1]] },
  12: { name: 'OCTO FLAT +', key: 'OCTOFLATP', motors: [[1, 0.707107, -0.707107, 1], [1, -0.707107, -0.707107, 1], [1, -0.707107, 0.707107, 1], [1, 0.707107, 0.707107, 1], [1, 0, -1, -1], [1, -1, 0, -1], [1, 0, 1, -1], [1, 1, 0, -1]] },
  13: { name: 'OCTO FLAT X', key: 'OCTOFLATX', motors: [[1, 1, -0.414178, 1], [1, -0.414178, -1, 1], [1, -1, 0.414178, 1], [1, 0.414178, 1, 1], [1, 0.414178, -1, -1], [1, -1, -0.414178, -1], [1, -0.414178, 1, -1], [1, 1, 0.414178, -1]] },
  14: { name: 'AIRPLANE', key: 'AIRPLANE', motors: null, count: 1 },
  15: { name: 'HELI 120 CCPM', key: 'HELI_120_CCPM', motors: null, count: 1 },
  16: { name: 'HELI 90 DEG', key: 'HELI_90_DEG', motors: null, count: 0 },
  17: { name: 'V-TAIL QUAD', key: 'VTAIL4', motors: [[1, -0.58, 0.58, 1], [1, -0.46, -0.39, -0.5], [1, 0.58, 0.58, -1], [1, 0.46, -0.39, 0.5]] },
  // HEX H: 5 ve 6 numaralı (sağ/sol) motorların katsayıları 0'dır; konumları kaynak koddaki açıklamadan
  18: { name: 'HEX H', key: 'HEX6H', motors: [[1, -1, 1, -1], [1, -1, -1, 1], [1, 1, 1, 1], [1, 1, -1, -1], [1, 0, 0, 0], [1, 0, 0, 0]], pos: { 4: [1, 0], 5: [-1, 0] } },
  19: { name: 'PPM TO SERVO', key: 'PPM_TO_SERVO', motors: null, count: 0 },
  20: { name: 'DUALCOPTER', key: 'DUALCOPTER', motors: [[1, 0, 0, -1], [1, 0, 0, 1]], pos: { 0: [-0.5, 0], 1: [0.5, 0] } },
  21: { name: 'SINGLECOPTER', key: 'SINGLECOPTER', motors: null, count: 1 },
  22: { name: 'A-TAIL QUAD', key: 'ATAIL4', motors: [[1, -0.58, 0.58, -1], [1, -0.46, -0.39, 0.5], [1, 0.58, 0.58, 1], [1, 0.46, -0.39, -0.5]] },
  23: { name: 'CUSTOM', key: 'CUSTOM', motors: null },
  24: { name: 'CUSTOM AIRPLANE', key: 'CUSTOMAIRPLANE', motors: null, count: 1 },
  25: { name: 'CUSTOM TRI', key: 'CUSTOMTRI', motors: null, count: 3 },
  26: { name: 'QUAD X 1234', key: 'QUADX1234', motors: [[1, 1, -1, -1], [1, -1, -1, 1], [1, -1, 1, -1], [1, 1, 1, 1]] },
  27: { name: 'OCTO X8 +', key: 'OCTOX8P', motors: [[1, 0, 1, -1], [1, -1, 0, 1], [1, 1, 0, 1], [1, 0, -1, -1], [1, 0, 1, 1], [1, -1, 0, -1], [1, 1, 0, -1], [1, 0, -1, 1]] },
};

const r3 = (v) => Math.round(v * 1000) / 1000 + 0; // −0 → 0

// Karıştırıcı kipinden gövde çizimi: { class, type, name, motorCount, motors: [{ n, testOrder, x, y, dir }] }
// x sağ, y ileri, −1..1 (en büyük katsayıya göre ölçeklenir). testOrder: önden başlayıp saat yönünde sıra.
function frameFromMixer(mixerMode, yawReversed, motorCount) {
  const m = MIXERS[mixerMode];
  const rev = !!yawReversed;
  if (!m || !m.motors) {
    const count = Number.isFinite(motorCount) && motorCount > 0 ? motorCount : (m && m.count) || 0;
    return { class: mixerMode, type: rev ? 1 : 0, name: m ? m.name : `MIXER ${mixerMode}`, motorCount: count, motors: [] };
  }
  let scale = 0;
  for (const row of m.motors) scale = Math.max(scale, Math.abs(row[1]), Math.abs(row[2]));
  if (!scale) scale = 1;
  const motors = m.motors.map((row, i) => {
    const fixed = m.pos && m.pos[i];
    const x = fixed ? fixed[0] : -row[1] / scale;
    const y = fixed ? fixed[1] : -row[2] / scale;
    let dir = row[3] === 0 ? null : (row[3] < 0 ? 'cw' : 'ccw');
    if (m.dirs && m.dirs[i]) dir = m.dirs[i];
    if (dir && rev) dir = dir === 'cw' ? 'ccw' : 'cw';
    return { n: i + 1, testOrder: 0, x: r3(x), y: r3(y), dir };
  });
  // Saat yönünde sıra: tam önden (0°) başlayan açı; aynı koldaki (eş eksenli) motorlar numara sırasıyla
  const angle = (mt) => { const a = Math.atan2(mt.x, mt.y) * 180 / Math.PI; return a < -0.001 ? a + 360 : Math.max(0, a); };
  const order = motors.slice().sort((a, b) => (angle(a) - angle(b)) || (a.n - b.n));
  order.forEach((mt, i) => { mt.testOrder = i + 1; });
  return { class: mixerMode, type: rev ? 1 : 0, name: m.name, motorCount: motors.length, motors };
}

// ---- Kurma (arm) engelleri: MSP_STATUS_EX içindeki bit sırası ----
// 4.3 / 4.4 (API ≤ 1.45)
const ARMING_FLAGS_44 = ['NOGYRO', 'FAILSAFE', 'RXLOSS', 'BADRX', 'BOXFAILSAFE', 'RUNAWAY', 'CRASH', 'THROTTLE', 'ANGLE', 'BOOTGRACE', 'NOPREARM', 'LOAD', 'CALIB', 'CLI', 'CMS', 'BST', 'MSP', 'PARALYZE', 'GPS', 'RESCUE_SW', 'RPMFILTER', 'REBOOT_REQD', 'DSHOT_BBANG', 'NO_ACC_CAL', 'MOTOR_PROTO', 'ARMSWITCH'];
// 4.5 (API 1.46)
const ARMING_FLAGS_45 = ['NOGYRO', 'FAILSAFE', 'RXLOSS', 'NOT_DISARMED', 'BOXFAILSAFE', 'RUNAWAY', 'CRASH', 'THROTTLE', 'ANGLE', 'BOOTGRACE', 'NOPREARM', 'LOAD', 'CALIB', 'CLI', 'CMS', 'BST', 'MSP', 'PARALYZE', 'GPS', 'RESCUE_SW', 'DSHOT_TELEM', 'REBOOT_REQD', 'DSHOT_BBANG', 'NO_ACC_CAL', 'MOTOR_PROTO', 'ARMSWITCH'];
// master (2025.12 sonrası geliştirme dalı, 30 bayrak)
const ARMING_FLAGS_MASTER = ['NOGYRO', 'FAILSAFE', 'RXLOSS', 'NOT_DISARMED', 'BOXFAILSAFE', 'RUNAWAY', 'CRASH', 'THROTTLE', 'ANGLE', 'BOOTGRACE', 'NOPREARM', 'LOAD', 'CALIB', 'CLI', 'CMS', 'BST', 'MSP', 'PARALYZE', 'GPS', 'RESCUE_SW', 'DSHOT_TELEM', 'REBOOT_REQD', 'DSHOT_BBANG', 'NO_ACC_CAL', 'MOTOR_PROTO', 'FLIP_SWITCH', 'ALT_HOLD_SW', 'POS_HOLD_SW', 'AUTOPILOT_SW', 'ARM_SWITCH'];

const ARMING_BIT = { CLI: 13, MSP: 16 }; // bütün sürümlerde aynı konumda

// count: MSP_STATUS_EX'in bildirdiği bayrak sayısı; apiMinor: MSP API 1.x
function armingFlagNames(flags, count, apiMinor) {
  let table;
  if (count === ARMING_FLAGS_MASTER.length) table = ARMING_FLAGS_MASTER;
  else if (count === 26 || !count) table = apiMinor !== null && apiMinor !== undefined && apiMinor < 46 ? ARMING_FLAGS_44 : ARMING_FLAGS_45;
  else {
    // Bilinmeyen sürüm: ilk 25 bayrak ortak, sonuncusu her zaman kurma anahtarı; aradakiler adsız
    table = [];
    for (let i = 0; i < count; i++) table.push(i < 25 ? ARMING_FLAGS_45[i] : i === count - 1 ? 'ARMSWITCH' : `FLAG_${i}`);
  }
  const out = [];
  const n = Math.min(32, Math.max(count || table.length, table.length));
  for (let i = 0; i < n; i++) if ((flags >>> i) & 1) out.push(table[i] || `FLAG_${i}`);
  return out;
}

// ---- Kutular (uçuş kipleri ve anahtarlar): kalıcı kimlik → ad ----
const BOX_NAMES = {
  0: 'ARM', 1: 'ANGLE', 2: 'HORIZON', 3: 'ALTHOLD', 4: 'ANTI GRAVITY', 5: 'MAG', 6: 'HEADFREE', 7: 'HEADADJ', 8: 'CAMSTAB',
  11: 'POS HOLD', 12: 'PASSTHRU', 13: 'BEEPER', 15: 'LEDLOW', 17: 'CALIB', 19: 'OSD DISABLE', 20: 'TELEMETRY',
  23: 'SERVO1', 24: 'SERVO2', 25: 'SERVO3', 26: 'BLACKBOX', 27: 'FAILSAFE', 28: 'AIR MODE', 29: '3D DISABLE', 30: 'FPV ANGLE MIX',
  31: 'BLACKBOX ERASE', 32: 'CAMERA CONTROL 1', 33: 'CAMERA CONTROL 2', 34: 'CAMERA CONTROL 3', 35: 'FLIP OVER AFTER CRASH',
  36: 'PREARM', 37: 'GPS BEEP SATELLITE COUNT', 39: 'VTX PIT MODE', 40: 'USER1', 41: 'USER2', 42: 'USER3', 43: 'USER4',
  44: 'PID AUDIO', 45: 'PARALYZE', 46: 'GPS RESCUE', 47: 'ACRO TRAINER', 48: 'VTX CONTROL DISABLE', 49: 'LAUNCH CONTROL',
  50: 'MSP OVERRIDE', 51: 'STICK COMMANDS DISABLE', 52: 'BEEPER MUTE', 53: 'READY', 54: 'LAP TIMER RESET', 55: 'CHIRP',
  56: 'AUTOPILOT', 57: 'WP CAPTURE', 58: 'LAUNCH',
};
const BOX_ARM = 0;
// Uçuş kipi sayılan kutular (görüntülenen kip adı bunlardan oluşur) ve kısa adları
const MODE_BOXES = { 1: 'ANGLE', 2: 'HORIZON', 3: 'ALTHOLD', 5: 'MAG', 6: 'HEADFREE', 11: 'POSHOLD', 12: 'PASSTHRU', 27: 'FAILSAFE', 35: 'TURTLE', 46: 'GPS_RESCUE', 56: 'AUTOPILOT' };
// Bunlardan hiçbiri etkin değilse araç ACRO (yalnızca açısal hız) kipindedir
const PRIMARY_MODE_BOXES = new Set([1, 2, 3, 11, 12, 27, 35, 46, 56]);

// ---- Motor protokolü (MSP_ADVANCED_CONFIG) ----
const MOTOR_PROTOCOLS = ['PWM', 'ONESHOT125', 'ONESHOT42', 'MULTISHOT', 'BRUSHED', 'DSHOT150', 'DSHOT300', 'DSHOT600', 'PROSHOT1000', 'DISABLED', 'DRONECAN'];
const isDshot = (protocol) => protocol >= 5 && protocol <= 8; // DSHOT150/300/600 ve PROSHOT1000 (yapılandırıcı da bunları sayısal sayar)
const MOTOR_PROTOCOL_DISABLED = 9;
// Sayısal protokollerde MSP_SET_MOTOR değer aralığı (yapılandırıcı motors.js): 1000 = dur, 2000 = tam gaz, 3D'de orta nokta 1500
const DSHOT_RANGE = { idle: 1000, max: 2000, neutral3d: 1500 };

const FEATURE_3D = 1 << 12;

// MSP_STATUS_EX algılayıcı bitleri (OPTICALFLOW ve PITOT yalnızca yeni sürümlerde)
const SENSORS = [
  { id: 32, name: 'GYRO' }, { id: 1, name: 'ACC' }, { id: 2, name: 'BARO' }, { id: 4, name: 'MAG' },
  { id: 8, name: 'GPS' }, { id: 16, name: 'RANGEFINDER' }, { id: 64, name: 'OPTICALFLOW' }, { id: 128, name: 'PITOT' },
];
const SENSOR_MAG = 4;

// MSP_BOARD_INFO yapılandırma sorunları
const PROBLEM_ACC_NEEDS_CALIBRATION = 1;
const PROBLEM_MOTOR_PROTOCOL_DISABLED = 2;

module.exports = {
  MIXERS, frameFromMixer, armingFlagNames, ARMING_BIT, ARMING_FLAGS_44, ARMING_FLAGS_45, ARMING_FLAGS_MASTER,
  BOX_NAMES, BOX_ARM, MODE_BOXES, PRIMARY_MODE_BOXES,
  MOTOR_PROTOCOLS, MOTOR_PROTOCOL_DISABLED, isDshot, DSHOT_RANGE, FEATURE_3D, SENSORS, SENSOR_MAG,
  PROBLEM_ACC_NEEDS_CALIBRATION, PROBLEM_MOTOR_PROTOCOL_DISABLED,
};
