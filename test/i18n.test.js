'use strict';

// Sözlükler: kodda kullanılan her anahtar Türkçe ve İngilizcede var; diller arasında yer tutucular tutarlı;
// şemadaki her alanın etiketi ve her seçeneğin metni tanımlı.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const I18N = require('../src/i18n');
const SCHEMA = require('../src/schema');

const SRC = path.join(__dirname, '..', 'src');
const files = ['main.js', ...fs.readdirSync(path.join(SRC, 'renderer')).filter((f) => f.endsWith('.js')).map((f) => `renderer/${f}`)];

function usedKeys() {
  const keys = new Set();
  for (const f of files) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const m of text.matchAll(/\bt(?:Opt)?\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]);
  }
  for (const [id] of SCHEMA.TABS) keys.add(`tab.${id}`);
  for (const id of SCHEMA.PROTOCOL_IDS) { keys.add(`proto.${id}`); keys.add(`proto.${id}.sub`); keys.add(`proto.${id}.hint`); }
  for (const f of SCHEMA.FIELDS) {
    keys.add(`f.${f.key}`);
    if (f.type === 'select') for (const v of f.opts) if (!(f.raw === true || (Array.isArray(f.raw) && f.raw.includes(v)))) keys.add(`o.${f.key}.${v}`);
  }
  for (const m of ['hex', 'ascii', 'bin', 'dec', 'b64']) { keys.add(`hex.mode.${m}`); keys.add(`hex.short.${m}`); }
  for (const k of ['wire', 'remux', 'none']) keys.add(`hex.kind.${k}`);
  for (const c of ['unauthorized', 'not_found', 'refused', 'timeout', 'unreachable', 'no_stream', 'bad_data', 'unsupported', 'tls', 'io', 'ffmpeg', 'stalled', 'ended', 'port_in_use', 'access', 'bad_address', 'bad_sdp', 'ffmpeg_missing', 'error']) keys.add(`err.${c}`);
  return [...keys];
}

test('kodda kullanılan her anahtar Türkçe ve İngilizcede tanımlı', () => {
  for (const lang of ['tr', 'en']) {
    const missing = usedKeys().filter((k) => !(k in I18N.STRINGS[lang]));
    assert.deepStrictEqual(missing, [], `${lang}: eksik anahtarlar`);
  }
});

test('sekiz dil yüklenir; yer tutucular ve HTML etiketleri İngilizceyle aynı', () => {
  const en = I18N.STRINGS.en;
  const marks = (s) => (String(s).match(/\{\w+\}|<\/?\w+>/g) || []).sort().join(' ');
  for (const lang of Object.keys(I18N.LANGUAGES)) {
    const dict = I18N.STRINGS[lang];
    assert.ok(dict && Object.keys(dict).length > 100, `${lang} sözlüğü`);
    const bad = Object.keys(dict).filter((k) => k in en && marks(dict[k]) !== marks(en[k]));
    assert.deepStrictEqual(bad, [], `${lang}: yer tutucu uyuşmazlığı`);
  }
});

test('çeviri: değişkenler, İngilizceye ve anahtara düşme, dil çözümleme', () => {
  const tr = I18N.createT('tr');
  assert.strictEqual(tr('app.stats', { c: 3, f: 1 }), '3 bağlantı · 1 klasör');
  assert.strictEqual(tr('yok.boyle.anahtar'), 'yok.boyle.anahtar');
  assert.strictEqual(I18N.resolveLanguage('tr-TR'), 'tr');
  assert.strictEqual(I18N.resolveLanguage('ja'), 'en');
  assert.strictEqual(I18N.LANGUAGES.ar.dir, 'rtl');
});
