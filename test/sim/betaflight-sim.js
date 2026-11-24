'use strict';

// Sınamalar ve gösterimler için sahte Betaflight 4.5 uçuş kartı (quad X, 4 motor). Gerçek MSP v1/v2 ve CLI konuşur;
// gerçek Betaflight SITL gibi TCP sunucusudur (SITL: UART1 = 5761).
//   const sim = createBfSim({ port: 0 });
//   await sim.start();  …  await sim.stop();
// Seçenekler: port (0 = boş kapı), gps (true: GPS var ve konum kilitli), rebootMs (yeniden başlatmada kapalı kalma süresi),
//   cliEnterMs ('#' sonrası CLI'ye giriş gecikmesi; gerçek kart 100 ms sessizlik bekler), apiMinor (46 = 4.5; 45 verilirse
//   "exit noreboot" tanınmaz ve "exit" her zaman yeniden başlatır), armingDisableFlags, craftName, silent,
//   noGet ("get" komutu yok: araç "dump all" yedeğine düşer),
//   cliSticky (state.cli true iken gelen yeni bağlantı CLI kipinde başlar — seri hatta CLI'de bırakılmış kart gibi).
// Dönen nesne: { start, stop, port, calls [{ name, … }], settings (Map ad → değer metni), state,
//   setArmed(on), setArmingFlags(bits), setSilent(on), reboot() }
//
// CLI biçimleri betaflight/src/main/cli/cli.c ile aynıdır (4.5): yankı, "\r\n# " istemi, get / set / dump / save / exit çıktıları.
// Ayar listesi gerçek adlar ve aralıklardan seçilmiş küçük bir kümedir (varsayılan değerler yaklaşık).

const net = require('net');
const path = require('path');
const { MSP, encode, MspParser } = require(path.join(__dirname, '..', '..', 'src', 'drone', 'msp.js'));

const T_OFF_ON = ['OFF', 'ON'];
const T_ALIGN = ['DEFAULT', 'CW0', 'CW90', 'CW180', 'CW270', 'CW0FLIP', 'CW90FLIP', 'CW180FLIP', 'CW270FLIP', 'CUSTOM'];
const T_PROTOCOL = ['PWM', 'ONESHOT125', 'ONESHOT42', 'MULTISHOT', 'BRUSHED', 'DSHOT150', 'DSHOT300', 'DSHOT600', 'PROSHOT1000', 'DISABLED'];
const T_FAILSAFE = ['AUTO-LANDING', 'DROP', 'GPS-RESCUE'];
const T_UNIT = ['IMPERIAL', 'METRIC', 'BRITISH'];
const T_RX = ['NONE', 'SPEK2048', 'SBUS', 'SUMD', 'SUMH', 'XB-B', 'XB-B-RJ01', 'IBUS', 'JETIEXBUS', 'CRSF', 'SRXL', 'CUSTOM', 'FPORT', 'SRXL2', 'GHST'];
const T_GPS = ['NMEA', 'UBLOX', 'MSP'];
const T_RATES = ['BETAFLIGHT', 'RACEFLIGHT', 'KISS', 'ACTUAL', 'QUICK'];
const T_RELAX = ['OFF', 'RP', 'RPY', 'RP_INC', 'RPY_INC'];
const T_MAG = ['AUTO', 'NONE', 'HMC5883', 'AK8975', 'AK8963', 'QMC5883', 'LIS3MDL', 'MPU925X_AK8963', 'IST8310'];
const T_BARO = ['AUTO', 'NONE', 'BMP085', 'MS5611', 'BMP280', 'LPS', 'QMP6988', 'BMP388', 'DPS310', '2SMPB_02B'];

// [ad, tür, varsayılan, ek]  tür: 'u' sayı (ek = [min, max]), 'l' seçenek (ek = tablo), 'a' dizi (ek = uzunluk), 's' metin (ek = [min, max])
// kapsam: 'p' = profile, 'r' = rateprofile (get çıktısında "profile 0" / "rateprofile 0" satırı eklenir)
const SETTINGS = [
  ['gyro_lpf1_static_hz', 'u', '250', [0, 1000]],
  ['gyro_lpf2_static_hz', 'u', '500', [0, 1000]],
  ['dyn_notch_count', 'u', '3', [0, 5]],
  ['gyro_calib_duration', 'u', '125', [50, 3000]],
  ['acc_calibration', 'a', '0,0,0,0', 4],
  ['align_mag', 'l', 'DEFAULT', T_ALIGN],
  ['mag_hardware', 'l', 'AUTO', T_MAG],
  ['baro_hardware', 'l', 'AUTO', T_BARO],
  ['min_check', 'u', '1050', [750, 2250]],
  ['max_check', 'u', '1900', [750, 2250]],
  ['rssi_channel', 'u', '0', [0, 18]],
  ['serialrx_provider', 'l', 'CRSF', T_RX],
  ['motor_pwm_protocol', 'l', 'DSHOT600', T_PROTOCOL],
  ['dshot_bidir', 'l', 'OFF', T_OFF_ON],
  ['motor_poles', 'u', '14', [4, 255]],
  ['min_throttle', 'u', '1070', [750, 2250]],
  ['max_throttle', 'u', '2000', [750, 2250]],
  ['min_command', 'u', '1000', [750, 2250]],
  ['dshot_idle_value', 'u', '550', [0, 2000]],
  ['failsafe_delay', 'u', '15', [1, 200]],
  ['failsafe_procedure', 'l', 'DROP', T_FAILSAFE],
  ['bat_capacity', 'u', '1500', [0, 20000]],
  ['vbat_max_cell_voltage', 'u', '430', [100, 500]],
  ['vbat_min_cell_voltage', 'u', '330', [100, 500]],
  ['vbat_warning_cell_voltage', 'u', '350', [100, 500]],
  ['yaw_motors_reversed', 'l', 'OFF', T_OFF_ON],
  ['small_angle', 'u', '25', [0, 180]],
  ['auto_disarm_delay', 'u', '5', [0, 60]],
  ['gps_provider', 'l', 'UBLOX', T_GPS],
  ['gps_rescue_min_sats', 'u', '8', [5, 50]],
  ['pid_process_denom', 'u', '2', [1, 16]],
  ['deadband', 'u', '0', [0, 32]],
  ['yaw_deadband', 'u', '0', [0, 100]],
  ['osd_units', 'l', 'METRIC', T_UNIT],
  ['vtx_power', 'u', '1', [0, 7]],
  ['craft_name', 's', 'SIMQUAD', [1, 16]],
  ['pilot_name', 's', '-', [1, 16]],
  ['roll_rc_rate', 'u', '7', [1, 255], 'r'],
  ['roll_srate', 'u', '67', [0, 255], 'r'],
  ['rates_type', 'l', 'ACTUAL', T_RATES, 'r'],
  ['thr_mid', 'u', '50', [0, 100], 'r'],
  ['thr_expo', 'u', '0', [0, 100], 'r'],
  ['p_pitch', 'u', '47', [0, 250], 'p'],
  ['p_roll', 'u', '45', [0, 250], 'p'],
  ['i_roll', 'u', '80', [0, 250], 'p'],
  ['d_roll', 'u', '40', [0, 250], 'p'],
  ['f_roll', 'u', '120', [0, 1000], 'p'],
  ['p_yaw', 'u', '45', [0, 250], 'p'],
  ['anti_gravity_gain', 'u', '80', [0, 250], 'p'],
  ['iterm_relax', 'l', 'RP', T_RELAX, 'p'],
  ['angle_limit', 'u', '60', [10, 85], 'p'],
].map(([name, kind, def, extra, scope]) => ({ name, kind, def, extra, scope: scope || 'm' }));
const SETTING_BY_NAME = new Map(SETTINGS.map((s) => [s.name, s]));

// Kurma engeli bitleri (runtime_config.h, 4.5)
const ARM = { RXLOSS: 1 << 2, THROTTLE: 1 << 7, BOOTGRACE: 1 << 9, CALIB: 1 << 12, CLI: 1 << 13, MSP: 1 << 16, ARMSWITCH: 1 << 25 };
// Etkin kutular (kalıcı kimlikler): bit sırası MSP_STATUS_EX bayraklarıyla aynıdır
const BOX_IDS = [0, 1, 2, 13, 27, 28, 35, 36];
const BOX_NAMES = ['ARM', 'ANGLE', 'HORIZON', 'BEEPER', 'FAILSAFE', 'AIR MODE', 'FLIP OVER AFTER CRASH', 'PREARM'];

const CLI_COMMANDS = ['batch', 'defaults', 'diff', 'dump', 'exit', 'get', 'help', 'profile', 'rateprofile', 'save', 'set', 'status', 'version'];

function createBfSim(opts = {}) {
  const apiMinor = opts.apiMinor || 46;
  const rebootMs = opts.rebootMs === undefined ? 300 : opts.rebootMs;
  const cliEnterMs = opts.cliEnterMs === undefined ? 20 : opts.cliEnterMs;
  const gps = !!opts.gps;
  const baseFlags = opts.armingDisableFlags === undefined ? (ARM.RXLOSS | ARM.ARMSWITCH) : opts.armingDisableFlags;

  const settings = new Map(SETTINGS.map((s) => [s.name, s.def]));
  if (opts.craftName) settings.set('craft_name', opts.craftName);
  let saved = new Map(settings); // EEPROM'daki kopya
  const calls = [];
  const state = {
    armed: false, angle: false, armingDisableFlags: baseFlags, cli: false, rebooted: 0, boot: Date.now(), silent: !!opts.silent,
    motors: [1000, 1000, 1000, 1000, 0, 0, 0, 0], mspArmingDisabled: false, accCal: 0, magCal: 0, batch: null, saves: 0,
  };
  const sim = { calls, settings, state, port: null };

  let server = null;
  let running = false;
  const clients = new Set();
  const timers = new Set();
  const later = (fn, ms) => { const h = setTimeout(() => { timers.delete(h); fn(); }, ms); timers.add(h); return h; };

  const num = (name) => Number(settings.get(name)) || 0;

  // ---- MSP yanıtları ----
  function w(parts) {
    // [['u8', v], ['u16', v], ['i16', v], ['u32', v], ['i32', v], ['s', metin], ['b', Buffer]]
    const bufs = parts.map(([t, v]) => {
      let b;
      switch (t) {
        case 'u8': b = Buffer.alloc(1); b.writeUInt8(v & 0xff); return b;
        case 'u16': b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b;
        case 'i16': b = Buffer.alloc(2); b.writeInt16LE(v); return b;
        case 'u32': b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b;
        case 'i32': b = Buffer.alloc(4); b.writeInt32LE(v | 0); return b;
        case 's': return Buffer.from(String(v), 'latin1');
        default: return v;
      }
    });
    return Buffer.concat(bufs);
  }
  const pstr = (s) => [['u8', s.length], ['s', s]];

  function armingFlags() {
    let f = state.armingDisableFlags;
    if (Date.now() - state.boot < (opts.bootGraceMs || 0)) f |= ARM.BOOTGRACE;
    if (state.cliEver) f |= ARM.CLI;           // CLI'ye bir kez girildiyse yeniden başlatılana dek kalır
    if (state.mspArmingDisabled) f |= ARM.MSP;
    if (state.accCal > Date.now()) f |= ARM.CALIB;
    return f >>> 0;
  }

  function reply(cmd, payload) {
    const t = (Date.now() - state.boot) / 1000;
    switch (cmd) {
      case MSP.MSP_API_VERSION: return w([['u8', 0], ['u8', 1], ['u8', apiMinor]]);
      case MSP.MSP_FC_VARIANT: return Buffer.from('BTFL');
      case MSP.MSP_FC_VERSION: return w([['u8', 4], ['u8', apiMinor >= 46 ? 5 : 4], ['u8', 1]]);
      case MSP.MSP_BOARD_INFO:
        return w([['s', 'S405'], ['u16', 0], ['u8', 2], ['u8', 0x01 | 0x02], ...pstr('STM32F405'), ...pstr('SPEEDYBEEF405V4'), ...pstr('SPBE'),
          ['b', Buffer.alloc(32)], ['u8', 1], ['u8', 2], ['u16', 8000], ['u32', 0]]);
      case MSP.MSP_BUILD_INFO: return w([['s', 'Jul 27 2024'], ['s', '07:59:19'], ['s', '77d01ba'], ['u32', 0]]);
      case MSP.MSP_NAME: { const n = settings.get('craft_name'); return Buffer.from(n === '-' ? '' : n, 'latin1'); }
      case MSP.MSP_UID: return w([['u32', 0x00250031], ['u32', 0x33385117], ['u32', 0x39343437]]);
      case MSP.MSP_FEATURE_CONFIG: return w([['u32', (1 << 3) | (1 << 10) | (1 << 18) | (1 << 22) | (gps ? 1 << 7 : 0)]]); // RX_SERIAL, TELEMETRY, OSD, AIRMODE
      case MSP.MSP_MIXER_CONFIG: return w([['u8', 3], ['u8', settings.get('yaw_motors_reversed') === 'ON' ? 1 : 0]]);     // QUADX
      case MSP.MSP_MOTOR_CONFIG: return w([['u16', num('min_throttle')], ['u16', num('max_throttle')], ['u16', num('min_command')], ['u8', 4], ['u8', num('motor_poles')], ['u8', 0], ['u8', 0]]);
      case MSP.MSP_ADVANCED_CONFIG:
        return w([['u8', 1], ['u8', num('pid_process_denom')], ['u8', 0], ['u8', Math.max(0, T_PROTOCOL.indexOf(settings.get('motor_pwm_protocol')))], ['u16', 480], ['u16', num('dshot_idle_value')],
          ['u8', 0], ['u8', 0], ['u8', 0], ['u8', 0], ['u8', 48], ['u16', num('gyro_calib_duration')], ['u16', 0], ['u8', 2], ['u8', 0], ['u8', 100]]);
      case MSP.MSP_BATTERY_CONFIG: {
        const mn = num('vbat_min_cell_voltage'); const mx = num('vbat_max_cell_voltage'); const wn = num('vbat_warning_cell_voltage');
        return w([['u8', Math.floor((mn + 5) / 10)], ['u8', Math.floor((mx + 5) / 10)], ['u8', Math.floor((wn + 5) / 10)], ['u16', num('bat_capacity')], ['u8', 1], ['u8', 1], ['u16', mn], ['u16', mx], ['u16', wn]]);
      }
      case MSP.MSP_BOXIDS: return payload.length && payload[0] > 0 ? Buffer.alloc(0) : Buffer.from(BOX_IDS);
      case MSP.MSP_BOXNAMES: return payload.length && payload[0] > 0 ? Buffer.alloc(0) : Buffer.from(BOX_NAMES.map((n) => `${n};`).join(''), 'latin1');
      case MSP.MSP_STATUS:
      case MSP.MSP_STATUS_EX: {
        const sensors = 1 | (1 << 1) | (1 << 2) | (gps ? 1 << 3 : 0) | (1 << 5); // ACC, BARO, MAG, (GPS), GYRO
        const flags = (state.armed ? 1 : 0) | (state.angle ? 2 : 0);
        const head = [['u16', 125], ['u16', 0], ['u16', sensors], ['u32', flags], ['u8', 0], ['u16', 12 + Math.round(3 * Math.sin(t))]];
        if (cmd === MSP.MSP_STATUS) return w([...head, ['u16', 0], ['u8', 0], ['u8', 26], ['u32', armingFlags()], ['u8', 0]]);
        return w([...head, ['u8', 4], ['u8', 0], ['u8', 0], ['u8', 26], ['u32', armingFlags()], ['u8', 0], ['u16', 41]]);
      }
      case MSP.MSP_ATTITUDE: return w([['i16', Math.round(150 * Math.sin(t * 1.3))], ['i16', Math.round(80 * Math.cos(t * 0.9))], ['i16', Math.round((t * 12) % 360)]]);
      case MSP.MSP_ALTITUDE: return w([['i32', Math.round(1250 + 100 * Math.sin(t / 2))], ['i16', Math.round(50 * Math.cos(t / 2))]]);
      case MSP.MSP_ANALOG: return w([['u8', 158], ['u16', 320], ['u16', 870], ['i16', 1234], ['u16', 1582]]);
      case MSP.MSP_BATTERY_STATE: return w([['u8', 4], ['u16', num('bat_capacity')], ['u8', 158], ['u16', 320], ['i16', 1234], ['u8', 0], ['u16', 1582]]);
      case MSP.MSP_RC: return w([1500, 1500, 1500, state.armed ? 1350 : 1000, 1000, 2000, 1500, 1500, ...new Array(8).fill(1500)].map((v) => ['u16', v]));
      case MSP.MSP_MOTOR: return w(state.motors.map((v, i) => ['u16', state.armed && i < 4 ? 1300 + i * 10 : v]));
      case MSP.MSP_RAW_GPS:
        if (!gps) return w([['u8', 0], ['u8', 0], ['i32', 0], ['i32', 0], ['u16', 0], ['u16', 0], ['u16', 0], ['u16', 0]]);
        return w([['u8', 2], ['u8', 14], ['i32', 399255000 + Math.round(200 * Math.sin(t / 5))], ['i32', 328663000], ['u16', 905], ['u16', 320], ['u16', 870], ['u16', 135]]);
      case MSP.MSP_COMP_GPS: return w([['u16', gps ? 42 : 0], ['i16', gps ? 180 : 0], ['u8', 1]]);
      case MSP.MSP_ACC_CALIBRATION:
        calls.push({ name: 'MSP_ACC_CALIBRATION' });
        if (!state.armed) state.accCal = Date.now() + 400;
        return Buffer.alloc(0);
      case MSP.MSP_MAG_CALIBRATION:
        calls.push({ name: 'MSP_MAG_CALIBRATION' });
        if (!state.armed) state.magCal = Date.now() + 30000;
        return Buffer.alloc(0);
      case MSP.MSP_SET_ARMING_DISABLED:
        calls.push({ name: 'MSP_SET_ARMING_DISABLED', disabled: payload[0] ? 1 : 0, runawayOff: payload[1] ? 1 : 0 });
        state.mspArmingDisabled = !!payload[0];
        if (state.mspArmingDisabled) state.armed = false;
        return Buffer.alloc(0);
      case MSP.MSP_SET_MOTOR: {
        if (payload.length < 8) return null; // getMotorCount() × 2 bayttan azsa hata
        const values = [];
        for (let i = 0; i + 1 < payload.length && i < 16; i += 2) values.push(payload.readUInt16LE(i));
        calls.push({ name: 'MSP_SET_MOTOR', values, t: Date.now() });
        for (let i = 0; i < 4; i++) state.motors[i] = values[i];
        return Buffer.alloc(0);
      }
      case MSP.MSP_REBOOT:
        if (state.armed) return null;
        calls.push({ name: 'MSP_REBOOT', mode: payload.length ? payload[0] : 0 });
        later(() => reboot(), 5); // yanıt gönderildikten sonra
        return w([['u8', payload.length ? payload[0] : 0]]);
      default: return null; // bilinmeyen komut → '!' yanıtı
    }
  }

  // ---- CLI (cli.c ile aynı davranış) ----
  function rangeLine(s) {
    switch (s.kind) {
      case 'u': return `Allowed range: ${s.extra[0]} - ${s.extra[1]}`;
      case 'l': return `Allowed values: ${s.extra.join(', ')}`;
      case 'a': return `Array length: ${s.extra}`;
      default: return `String length: ${s.extra[0]} - ${s.extra[1]}`;
    }
  }

  function cliGet(arg, cmdName) {
    let out = '';
    let matched = 0;
    const needle = arg.toLowerCase();
    for (const s of SETTINGS) {
      if (!s.name.includes(needle)) continue;
      if (matched > 0) out += '\r\n';
      out += `${s.name} = ${settings.get(s.name)}\r\n`;
      if (s.scope === 'p') out += 'profile 0\r\n'; else if (s.scope === 'r') out += 'rateprofile 0\r\n';
      out += `${rangeLine(s)}\r\n`;
      if (settings.get(s.name) !== s.def) out += `Default value: ${s.def}\r\n`;
      matched++;
    }
    if (!matched) out += `###ERROR IN ${cmdName}: INVALID NAME: ${arg}###\r\n`;
    return out;
  }

  function cliError(cmdName, text) {
    if (state.batch) state.batch.error = true;
    return `###ERROR IN ${cmdName}: ${text}###\r\n`;
  }

  function cliSet(arg) {
    if (arg === '' || arg === '*') {
      let out = 'Current settings: \r\n';
      for (const s of SETTINGS) out += `${s.name} = ${settings.get(s.name)}${arg === '*' && s.kind === 'u' ? ` ${s.extra[0]} ${s.extra[1]}` : ''}\r\n`;
      return out;
    }
    const eq = arg.indexOf('=');
    if (eq < 0) return cliGet(arg, 'set');
    const name = arg.slice(0, eq).trim().toLowerCase();
    const value = arg.slice(eq + 1).trim();
    const s = SETTING_BY_NAME.get(name);
    if (!s) return cliError('set', `INVALID NAME: ${arg}`);
    let next = null;
    if (s.kind === 'u') {
      const v = parseInt(value, 10) || 0; // atoi
      if (v >= s.extra[0] && v <= s.extra[1]) next = String(v);
    } else if (s.kind === 'l') {
      const i = s.extra.findIndex((x) => x.toLowerCase() === value.toLowerCase());
      if (i >= 0) next = s.extra[i];
    } else if (s.kind === 'a') {
      const parts = value.split(',').map((x) => parseInt(x, 10) || 0);
      const cur = settings.get(name).split(',');
      for (let i = 0; i < s.extra && i < parts.length; i++) cur[i] = String(parts[i]);
      next = cur.join(',');
    } else {
      if (value.length > 0 && value.length <= s.extra[1]) next = value;
      else return cliError('set', `STRING MUST BE 1-${s.extra[1]} CHARACTERS OR '-' FOR EMPTY`);
    }
    if (next === null) return `${cliError('set', 'INVALID VALUE')}${rangeLine(s)}\r\n`;
    settings.set(name, next);
    return `${name} set to ${next}`;
  }

  const versionLine = () => `# Betaflight / STM32F405 (S405) 4.${apiMinor >= 46 ? 5 : 4}.1 Jul 27 2024 / 07:59:19 (77d01ba3b) MSP API: 1.${apiMinor}\r\n# board: manufacturer_id: SPBE, board_name: SPEEDYBEEF405V4\r\n`;

  function cliDump(arg, diff) {
    let out = `\r\n# version\r\n${versionLine()}`;
    out += '\r\n# start the command batch\r\nbatch start\r\n\r\n';
    out += 'board_name SPEEDYBEEF405V4\r\nmanufacturer_id SPBE\r\n';
    const section = (title, scope) => {
      const rows = SETTINGS.filter((s) => s.scope === scope && (!diff || settings.get(s.name) !== s.def));
      if (!rows.length && diff) return '';
      return `\r\n# ${title}\r\n${rows.map((s) => `set ${s.name} = ${settings.get(s.name)}\r\n`).join('')}`;
    };
    out += '\r\n# feature\r\nfeature OSD\r\n';
    out += section('master', 'm');
    if (/all/i.test(arg)) {
      out += `\r\nprofile 0\r\n${section('profile 0', 'p')}`;
      out += `\r\nrateprofile 0\r\n${section('rateprofile 0', 'r')}`;
      out += '\r\n# end the command batch\r\nbatch end\r\n';
    }
    return out;
  }

  function cliStatus() {
    return 'MCU F40X Clock=168MHz (PLLP-HSE), Vref=3.30V, Core temp=41degC\r\n'
      + 'Stack size: 2048, Stack address: 0x1000fff0\r\n'
      + 'Configuration: CONFIGURED, size: 3653, max available: 16384\r\n'
      + 'Devices detected: SPI:1, I2C:1\r\n'
      + 'Gyros detected: gyro 1 locked dma\r\n'
      + 'GYRO=ICM42688P, ACC=ICM42688P, BARO=DPS310\r\n'
      + 'OSD: MSP (53 x 20)\r\n'
      + 'BUILD KEY: 0123456789abcdef0123456789abcdef (4.5.1)\r\n'
      + `System Uptime: ${Math.round((Date.now() - state.boot) / 1000)} seconds, Current Time: 2026-11-24T10:00:00.000+00:00\r\n`
      + 'CPU:12%, cycle time: 125, GYRO rate: 8000, RX rate: 15, System rate: 9\r\n'
      + 'Voltage: 1582 * 0.01V (4S battery - OK)\r\n'
      + 'I2C Errors: 0\r\n'
      + `Arming disable flags:${state.armingDisableFlags & ARM.RXLOSS ? ' RXLOSS' : ''} CLI${state.mspArmingDisabled ? ' MSP' : ''}\r\n`;
  }

  // Dönen: { out, after }  after: 'reboot' | 'leave' | null
  function cliCommand(line) {
    const sp = line.search(/\s/);
    const name = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const arg = sp < 0 ? '' : line.slice(sp + 1).trim();
    switch (name) {
      case 'get': if (opts.noGet) return { out: "###ERROR IN input: UNKNOWN COMMAND, TRY 'HELP'###" }; return { out: cliGet(arg, 'get') };
      case 'set': return { out: cliSet(arg) };
      case 'dump': return { out: cliDump(arg, false) };
      case 'diff': return { out: cliDump(arg, true) };
      case 'status': return { out: cliStatus() };
      case 'version': return { out: versionLine() };
      case 'profile': return { out: 'profile 0\r\n' };
      case 'rateprofile': return { out: 'rateprofile 0\r\n' };
      case 'help': return { out: CLI_COMMANDS.map((c) => `${c}\r\n`).join('') };
      case 'batch':
        if (/^start/i.test(arg)) { state.batch = state.batch || { error: false }; return { out: 'Command batch started\r\n' }; }
        if (/^end/i.test(arg)) {
          const bad = state.batch && state.batch.error;
          state.batch = null;
          return { out: bad ? '###ERROR IN batch: ERRORS WERE DETECTED - PLEASE REVIEW BEFORE CONTINUING###\r\n' : 'Command batch ended\r\n' };
        }
        return { out: cliError('batch', 'Invalid option') };
      case 'save': {
        if (state.batch && state.batch.error) {
          state.batch = null;
          return { out: "###ERROR IN save: ERRORS WERE DETECTED - PLEASE REVIEW BEFORE CONTINUING###\r\n###ERROR IN save: PLEASE FIX ERRORS THEN 'SAVE'###\r\n" };
        }
        saved = new Map(settings);
        state.saves++;
        const noreboot = apiMinor >= 46 && arg.toLowerCase() === 'noreboot';
        return { out: '\r\n# saving\r\n', after: noreboot ? null : 'reboot' };
      }
      case 'defaults':
        for (const s of SETTINGS) settings.set(s.name, s.def);
        if (/nosave/i.test(arg)) return { out: '\r\n# resetting to defaults\r\n' };
        saved = new Map(settings);
        return { out: '\r\n# resetting to defaults\r\n', after: 'reboot' };
      case 'exit': {
        // 4.5+: "exit noreboot" yeniden başlatmadan çıkar; eski sürümlerde bağımsız değişken yok sayılır ve hep yeniden başlar
        const noreboot = apiMinor >= 46 && arg.toLowerCase() === 'noreboot';
        return noreboot ? { out: '\r\n# leaving CLI mode, no reboot\r\n', after: 'leave' } : { out: '\r\n# leaving CLI mode, unsaved changes lost\r\n', after: 'reboot' };
      }
      default: return { out: "###ERROR IN input: UNKNOWN COMMAND, TRY 'HELP'###" };
    }
  }

  function cliEnter(conn) {
    if (conn.closed || conn.cli) return;
    conn.cli = true;
    conn.line = '';
    state.cli = true;
    state.cliEver = true;
    state.batch = null;
    send(conn, "\r\nEntering CLI Mode, type 'exit' to reboot, or 'help'\r\n\r\n# ");
  }

  function cliChar(conn, c) {
    if (c === 0x0a || c === 0x0d) {
      if (!conn.line.length) return;
      let out = '\r\n'; // satır sonu yankısı
      let line = conn.line;
      conn.line = '';
      const hash = line.indexOf('#');
      if (hash >= 0) line = line.slice(0, hash); // açıklama
      line = line.replace(/ +$/, '');
      let after = null;
      if (line.length) {
        calls.push({ name: 'CLI', line });
        const r = cliCommand(line);
        out += r.out;
        after = r.after || null;
      }
      if (after === 'reboot') {
        send(conn, `${out}\r\nRebooting`);
        later(() => reboot(), 5);
        conn.dead = true; // yeniden başlayana dek başka bir şey işlenmez
        return;
      }
      if (after === 'leave') {
        send(conn, out);
        conn.cli = false;
        state.cli = false;
        for (let i = 0; i < 4; i++) state.motors[i] = 1000; // mixerResetDisarmedMotors()
        return;
      }
      send(conn, `${out}\r\n# `);
      return;
    }
    if (c === 0x7f) { if (conn.line.length) { conn.line = conn.line.slice(0, -1); send(conn, '\b \b'); } return; }
    if (c >= 32 && c <= 126 && conn.line.length < 255) {
      if (!conn.line.length && c === 0x20) return; // baştaki boşluklar yok sayılır
      conn.line += String.fromCharCode(c);
      send(conn, String.fromCharCode(c)); // yankı
    }
  }

  // ---- Bağlantılar ----
  function send(conn, data) {
    if (conn.closed || state.silent) return;
    try { conn.sock.write(typeof data === 'string' ? Buffer.from(data, 'latin1') : data); } catch { /* yok */ }
  }

  function onFrame(conn, f) {
    if (f.dir !== '<') return;
    const payload = reply(f.cmd, f.payload);
    if (payload === null) send(conn, encode(f.cmd, null, { dir: '!', version: f.version }));
    else send(conn, encode(f.cmd, payload, { dir: '>', version: f.version }));
  }

  function onData(conn, chunk) {
    if (conn.dead) return;
    let rest = chunk;
    // CLI kipinde her bayt satır düzenleyicisine gider (MSP çözülmez)
    if (conn.cli) {
      for (let i = 0; i < rest.length; i++) {
        if (conn.dead) return;
        if (!conn.cli) { rest = rest.subarray(i); return onData(conn, rest); }
        cliChar(conn, rest[i]);
      }
      return undefined;
    }
    const frames = conn.parser.push(rest);
    for (const f of frames) onFrame(conn, f);
    return undefined;
  }

  function onText(conn, s) {
    // MSP dışı bayt: '#' → 100 ms sessizlikten sonra CLI (kuruluyken değerlendirilmez)
    if (conn.cli || state.armed) return;
    if (s.includes('#') && !conn.pendingCli) {
      conn.pendingCli = later(() => { conn.pendingCli = null; cliEnter(conn); }, cliEnterMs);
    }
  }

  function accept(sock) {
    const conn = { sock, cli: false, line: '', closed: false, dead: false, pendingCli: null, parser: null };
    conn.parser = new MspParser({ onText: (s) => onText(conn, s) });
    if (opts.cliSticky && state.cli) conn.cli = true; // seri hattaki gibi: kart CLI'de kalmış
    clients.add(conn);
    sock.setNoDelay(true);
    sock.on('data', (d) => { try { onData(conn, d); } catch { /* yok */ } });
    sock.on('error', () => {});
    sock.on('close', () => { conn.closed = true; clients.delete(conn); });
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      const srv = net.createServer(accept);
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        srv.removeListener('error', reject);
        srv.on('error', () => {});
        server = srv;
        sim.port = srv.address().port;
        resolve();
      });
    });
  }

  function closeServer() {
    const srv = server;
    server = null;
    for (const c of clients) { c.closed = true; try { c.sock.destroy(); } catch { /* yok */ } }
    clients.clear();
    return new Promise((resolve) => { if (srv) srv.close(() => resolve()); else resolve(); });
  }

  // Yeniden başlatma: bağlantılar düşer, kart bir süre yanıt vermez, RAM'deki ayarlar EEPROM'dakine döner
  function reboot() {
    if (!running) return;
    state.rebooted++;
    for (const [k, v] of saved) settings.set(k, v);
    state.cli = false;
    state.cliEver = false;
    state.batch = null;
    state.armed = false;
    state.mspArmingDisabled = false;
    state.accCal = 0;
    state.magCal = 0;
    state.motors = [1000, 1000, 1000, 1000, 0, 0, 0, 0];
    const port = sim.port;
    closeServer().then(() => {
      later(async () => {
        if (!running) return;
        state.boot = Date.now();
        for (let i = 0; i < 20 && running; i++) {
          try { await listen(port); return; } catch { await new Promise((r) => { later(r, 50); }); }
        }
      }, rebootMs);
    });
  }

  sim.start = async () => {
    if (running) return sim;
    running = true;
    state.boot = Date.now();
    await listen(opts.port || 0);
    return sim;
  };

  sim.stop = async () => {
    running = false;
    for (const h of timers) clearTimeout(h);
    timers.clear();
    await closeServer();
  };

  sim.reboot = reboot;
  sim.setArmed = (on) => { state.armed = !!on; if (on) state.armingDisableFlags = 0; };
  sim.setArmingFlags = (bits) => { state.armingDisableFlags = bits >>> 0; };
  sim.setSilent = (on) => { state.silent = !!on; };
  sim.ARM = ARM;
  return sim;
}

module.exports = { createBfSim, SETTINGS };

// Doğrudan çalıştırma: node test/sim/betaflight-sim.js [kapı]   (uygulamada TCP 127.0.0.1:5761 ile bağlanılır)
if (require.main === module) {
  const port = Number(process.argv[2]) || 5761;
  createBfSim({ port, gps: true }).start().then((s) => { console.log(`Betaflight sim: tcp 127.0.0.1:${s.port}`); });
}
