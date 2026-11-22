// Çeviri motoru. Hem ana süreçte (require) hem pencerelerde (<script>) çalışır.
// Mastertool standardı: 8 dil (tr, en, fr, de, es, ar, zh, ru); sözlükler src/i18n/<dil>.js dosyalarındadır.
// Yeni metin eklerken önce "tr" ve "en"e ekleyin; eksik anahtarlar İngilizceye, o da yoksa anahtarın kendisine düşer.
// Pencerelerde sözlük dosyaları bu dosyadan ÖNCE yüklenmelidir.
(function (root) {
  'use strict';

  const LANGUAGES = {
    tr: { name: 'Türkçe', dir: 'ltr' },
    en: { name: 'English', dir: 'ltr' },
    fr: { name: 'Français', dir: 'ltr' },
    de: { name: 'Deutsch', dir: 'ltr' },
    es: { name: 'Español', dir: 'ltr' },
    ar: { name: 'العربية', dir: 'rtl' },
    zh: { name: '中文', dir: 'ltr' },
    ru: { name: 'Русский', dir: 'ltr' },
  };

  const isNode = typeof module !== 'undefined' && module.exports;
  const STRINGS = isNode
    ? { tr: require('./i18n/tr'), en: require('./i18n/en'), fr: require('./i18n/fr'), de: require('./i18n/de'), es: require('./i18n/es'), ar: require('./i18n/ar'), zh: require('./i18n/zh'), ru: require('./i18n/ru') }
    : (root.I18N_STRINGS || {});

  // Dil kodunu (ör. "tr-TR") desteklenen bir dile çevirir
  function resolveLanguage(code) {
    const c = String(code || '').toLowerCase().split(/[-_]/)[0];
    return LANGUAGES[c] ? c : 'en';
  }

  function createT(lang) {
    const dict = STRINGS[lang] || STRINGS.en || {};
    const en = STRINGS.en || {};
    return function t(key, vars) {
      let s = dict[key] ?? en[key] ?? key;
      if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
      return s;
    };
  }

  const api = { LANGUAGES, STRINGS, resolveLanguage, createT };
  if (isNode) module.exports = api;
  else root.I18N = api;
})(typeof self !== 'undefined' ? self : this);
