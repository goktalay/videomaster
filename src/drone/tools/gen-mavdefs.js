'use strict';

// MAVLink XML tanımlarından (minimal + standard + common + ardupilotmega ve içerdikleri) sıkıştırılmış
// src/drone/mavdefs.json dosyasını üretir. Çalışma zamanında kullanılmaz; yalnızca tanımlar güncellenirken çalıştırılır:
//   node src/drone/tools/gen-mavdefs.js            → XML'leri GitHub'dan indirir
//   node src/drone/tools/gen-mavdefs.js <klasör>   → XML'leri yerel klasörden okur (çevrimdışı)
// Çıktı biçimi (boyut küçük kalsın diye diziler):
//   messages: [ [id, ad, crcExtra, uzantıSayısı, "alan:tip[:dizi],..."] ]   alanlar TEL SIRASINDA (wire order)
//   enums:    { AD: { değer: girişAdı } }
//   commands: { id: [ad, [p1..p7 etiketleri]] }                             (MAV_CMD parametre etiketleri)

const fs = require('fs');
const path = require('path');

const BASE = 'https://raw.githubusercontent.com/mavlink/mavlink/master/message_definitions/v1.0/';
const ROOTS = ['ardupilotmega.xml']; // minimal, standard ve common'ı zaten içerir
const OUT = path.join(__dirname, '..', 'mavdefs.json');

// Ad çözümlemede gereken numaralandırmalar (hepsini almak dosyayı gereksiz büyütür)
const WANTED_ENUMS = [
  'MAV_TYPE', 'MAV_AUTOPILOT', 'MAV_STATE', 'MAV_MODE_FLAG', 'MAV_RESULT', 'MAV_SEVERITY', 'MAV_PARAM_TYPE',
  'GPS_FIX_TYPE', 'MAG_CAL_STATUS', 'ACCELCAL_VEHICLE_POS', 'MOTOR_TEST_ORDER', 'MOTOR_TEST_THROTTLE_TYPE',
  'MAV_FRAME', 'MAV_SYS_STATUS_SENSOR', 'MAV_DATA_STREAM', 'MAV_COMPONENT', 'MAV_LANDED_STATE', 'MAV_BATTERY_CHARGE_STATE',
  'EKF_STATUS_FLAGS', 'MAV_PROTOCOL_CAPABILITY', 'FIRMWARE_VERSION_TYPE',
];

const TYPE_SIZE = {
  uint64_t: 8, int64_t: 8, double: 8, uint32_t: 4, int32_t: 4, float: 4,
  uint16_t: 2, int16_t: 2, uint8_t: 1, int8_t: 1, char: 1,
};
const TYPE_CODE = {
  uint64_t: 'u64', int64_t: 'i64', double: 'f64', uint32_t: 'u32', int32_t: 'i32', float: 'f32',
  uint16_t: 'u16', int16_t: 'i16', uint8_t: 'u8', int8_t: 'i8', char: 'c',
};

function crcAccumulate(byte, crc) {
  let tmp = byte ^ (crc & 0xff);
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}

function crcString(str, crc) {
  for (const b of Buffer.from(str, 'ascii')) crc = crcAccumulate(b, crc);
  return crc;
}

async function load(name, dir) {
  if (dir) return fs.readFileSync(path.join(dir, name), 'utf8');
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.text();
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

// "2**3", "0x10" gibi değerleri de sayıya çevirir
function parseValue(v) {
  v = String(v).trim();
  const pow = /^(\d+)\s*\*\*\s*(\d+)$/.exec(v);
  if (pow) return Math.pow(Number(pow[1]), Number(pow[2]));
  return Number(v);
}

function parseDialect(xml, messages, enums, commands) {
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');

  const enumRe = /<enum\b([^>]*)>([\s\S]*?)<\/enum>/g;
  let m;
  while ((m = enumRe.exec(xml))) {
    const ename = attr(m[1], 'name');
    const isCmd = ename === 'MAV_CMD';
    if (!isCmd && !WANTED_ENUMS.includes(ename)) continue;
    const entryRe = /<entry\b([^>]*?)(\/>|>([\s\S]*?)<\/entry>)/g;
    let e;
    while ((e = entryRe.exec(m[2]))) {
      const value = parseValue(attr(e[1], 'value'));
      const name = attr(e[1], 'name');
      if (!Number.isFinite(value) || !name) continue;
      if (isCmd) {
        const labels = ['', '', '', '', '', '', ''];
        const paramRe = /<param\b([^>]*?)(\/>|>([\s\S]*?)<\/param>)/g;
        let p;
        while ((p = paramRe.exec(e[3] || ''))) {
          const idx = Number(attr(p[1], 'index'));
          if (!(idx >= 1 && idx <= 7)) continue;
          if (attr(p[1], 'reserved') === 'true') continue;
          let label = attr(p[1], 'label');
          if (!label) {
            // etiket yoksa açıklamanın ilk birkaç sözcüğü
            const d = (p[3] || '').replace(/\s+/g, ' ').trim();
            label = /^(empty|reserved|unused)/i.test(d) ? '' : d.split(/[.:(;]/)[0].trim().slice(0, 28);
          }
          labels[idx - 1] = label;
        }
        commands[value] = [name, labels];
      } else {
        (enums[ename] = enums[ename] || {})[value] = name;
      }
    }
  }

  const msgRe = /<message\b([^>]*)>([\s\S]*?)<\/message>/g;
  while ((m = msgRe.exec(xml))) {
    const id = Number(attr(m[1], 'id'));
    const name = attr(m[1], 'name');
    const body = m[2];
    const extAt = body.search(/<extensions\s*\/>/);
    const base = [];
    const ext = [];
    const fieldRe = /<field\b([^>]*?)(\/>|>)/g;
    let f;
    while ((f = fieldRe.exec(body))) {
      let type = attr(f[1], 'type');
      const fname = attr(f[1], 'name');
      let len = 0;
      const arr = /^(\w+)\[(\d+)\]$/.exec(type);
      if (arr) { type = arr[1]; len = Number(arr[2]); }
      if (type === 'uint8_t_mavlink_version') type = 'uint8_t';
      if (!TYPE_SIZE[type]) throw new Error(`${name}.${fname}: bilinmeyen tip ${type}`);
      (extAt >= 0 && f.index > extAt ? ext : base).push({ name: fname, type, len });
    }
    // Tel sırası: uzantı olmayan alanlar tip boyutuna göre büyükten küçüğe (kararlı sıralama), uzantılar XML sırasında sonda
    const sorted = base.map((x, i) => ({ x, i })).sort((a, b) => (TYPE_SIZE[b.x.type] - TYPE_SIZE[a.x.type]) || (a.i - b.i)).map((o) => o.x);
    // CRC_EXTRA: "AD " + her alan için "tip ad " (+ dizi ise uzunluk baytı); uzantılar katılmaz
    let crc = crcString(name + ' ', 0xffff);
    for (const fl of sorted) {
      crc = crcString(fl.type + ' ', crc);
      crc = crcString(fl.name + ' ', crc);
      if (fl.len) crc = crcAccumulate(fl.len, crc);
    }
    const crcExtra = (crc & 0xff) ^ (crc >> 8);
    const spec = sorted.concat(ext).map((fl) => `${fl.name}:${TYPE_CODE[fl.type]}${fl.len ? ':' + fl.len : ''}`).join(',');
    messages.set(id, [id, name, crcExtra, ext.length, spec]);
  }
}

async function main() {
  const dir = process.argv[2] || null;
  const seen = new Set();
  const order = [];
  const skipped = [];
  // include'ları derinlik öncelikli çöz; içerilen dosya, içerenden önce işlenir
  async function visit(name) {
    if (seen.has(name)) return;
    seen.add(name);
    let xml;
    try { xml = await load(name, dir); } catch (err) { skipped.push(`${name} (${err.message})`); return; }
    const incRe = /<include>([^<]+)<\/include>/g;
    let m;
    while ((m = incRe.exec(xml))) await visit(m[1].trim());
    order.push({ name, xml });
  }
  for (const r of ROOTS) await visit(r);

  const messages = new Map();
  const enums = {};
  const commands = {};
  for (const d of order) parseDialect(d.xml, messages, enums, commands);

  const out = {
    source: 'mavlink/mavlink message_definitions/v1.0',
    dialects: order.map((d) => d.name.replace(/\.xml$/, '')),
    messages: [...messages.values()].sort((a, b) => a[0] - b[0]),
    enums,
    commands,
  };
  // Her ileti kendi satırında: fark (diff) okunabilir kalsın
  const json = '{\n'
    + `"source":${JSON.stringify(out.source)},\n`
    + `"dialects":${JSON.stringify(out.dialects)},\n`
    + '"messages":[\n' + out.messages.map((x) => JSON.stringify(x)).join(',\n') + '\n],\n'
    + '"enums":{\n' + Object.keys(enums).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(enums[k])}`).join(',\n') + '\n},\n'
    + '"commands":{\n' + Object.keys(commands).map((k) => `${JSON.stringify(k)}:${JSON.stringify(commands[k])}`).join(',\n') + '\n}\n'
    + '}\n';
  fs.writeFileSync(OUT, json);
  console.log(`${OUT}: ${out.messages.length} ileti, ${Object.keys(enums).length} enum, ${Object.keys(commands).length} komut, ${(json.length / 1024).toFixed(0)} KB`);
  if (skipped.length) console.log('Atlanan dosyalar: ' + skipped.join(', '));
}

main().catch((err) => { console.error(err); process.exit(1); });
