'use strict';

// Cihazda ortak oturum (SSO) — Mastertool sözleşmesi v1 §2. Altı uygulama aynı şekilde uygular.
//
// Ortak kimlik: Windows Kimlik Bilgisi Yöneticisi (kullanıcı kapsamı, DPAPI), @napi-rs/keyring
//   new Entry('Mastertool', 'sso') → {"v":1,"email","user":{"id","name"},"sso_token","master","kdf","at"}
//   master (base64, 32 bayt) şifresiz giren uygulama kendi anahtarını türetebilsin diye paylaşılır;
//   asla dosyaya, günlüğe ya da sunucuya yazılmaz.
// Durum işareti (gizli bilgi yok): %APPDATA%\Mastertool\sso-state.json = {"gen","state":"in"|"out","at"}
//   Değişiklik fs.watch ile, kaçırılırsa 5 sn'lik yoklamayla fark edilir.

const fs = require('fs');
const path = require('path');

const SERVICE = 'Mastertool';
const ACCOUNT = 'sso';
const STATE_FILE = 'sso-state.json';
const POLL_MS = 5000;
// Windows kimlik bilgisi blob'u en çok 2560 bayttır ve keyring parolayı UTF-16 olarak yazar: en çok 1280 karakter.
// Sözleşmedeki "< 2 KB" sınırına bu nedenle karakter olarak 1200 ile uyuyoruz (ad gerekirse kısaltılır).
const MAX_CHARS = 1200;

// Gerçek depo: @napi-rs/keyring. Testlerde aynı arayüzde bellek içi bir depo verilir.
function systemKeyring() {
  const { Entry } = require('@napi-rs/keyring');
  const entry = new Entry(SERVICE, ACCOUNT);
  return {
    get: () => entry.getPassword() ?? null,
    set: (value) => entry.setPassword(value),
    del: () => { try { entry.deletePassword(); } catch { /* zaten yok */ } },
  };
}

function encodeCredential({ email, user, sso_token, master, kdf, at }) {
  const cred = {
    v: 1,
    email: String(email || ''),
    user: { id: user && user.id != null ? user.id : null, name: String((user && user.name) || '') },
    sso_token: String(sso_token || ''),
    master: Buffer.isBuffer(master) ? master.toString('base64') : String(master || ''),
    kdf: kdf ? { alg: kdf.alg, iter: kdf.iter, salt: kdf.salt } : null,
    at: at || Date.now(),
  };
  let json = JSON.stringify(cred);
  if (json.length > MAX_CHARS) {
    cred.user.name = cred.user.name.slice(0, Math.max(0, cred.user.name.length - (json.length - MAX_CHARS)));
    json = JSON.stringify(cred);
  }
  if (json.length > MAX_CHARS) throw Object.assign(new Error('credential_too_large'), { code: 'credential_too_large' });
  return json;
}

function decodeCredential(json) {
  if (!json) return null;
  try {
    const c = JSON.parse(json);
    if (!c || c.v !== 1 || !c.sso_token || typeof c.sso_token !== 'string') return null;
    return c;
  } catch {
    return null;
  }
}

function createSso({ keyring = systemKeyring(), stateDir, now = Date.now, pollMs = POLL_MS } = {}) {
  const stateFile = path.join(stateDir, STATE_FILE);

  function readCredential() {
    try { return decodeCredential(keyring.get()); } catch { return null; }
  }

  function writeCredential(data) {
    keyring.set(encodeCredential({ ...data, at: now() }));
  }

  function deleteCredential() {
    try { keyring.del(); } catch { /* yok sayılır */ }
  }

  function readState() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return { gen: Number(s.gen) || 0, state: s.state === 'in' ? 'in' : 'out', at: Number(s.at) || 0 };
    } catch {
      return { gen: 0, state: 'out', at: 0 };
    }
  }

  // Okuyan uygulama yarım yazılmış dosya görmesin diye geçici dosyaya yazılıp yerine taşınır
  function bumpState(state) {
    const next = { gen: readState().gen + 1, state: state === 'in' ? 'in' : 'out', at: now() };
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
    try {
      fs.renameSync(tmp, stateFile);
    } catch {
      fs.writeFileSync(stateFile, JSON.stringify(next), 'utf8'); // başka bir süreç dosyayı tutuyorsa
      try { fs.unlinkSync(tmp); } catch {}
    }
    return next;
  }

  // Durum değişince (gen ilerleyince) cb(state) çağrılır. Kendi yazdığımız değişiklik de bildirilir;
  // çağıran taraf ortak kimliği yeniden okuyarak ne yapacağına karar verir (bkz. account.js).
  function watch(cb) {
    let lastGen = readState().gen;
    let watcher = null;
    let debounce = null;
    const check = () => {
      const s = readState();
      if (s.gen !== lastGen) {
        lastGen = s.gen;
        cb(s);
      }
    };
    const soon = () => { clearTimeout(debounce); debounce = setTimeout(check, 60); };
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      watcher = fs.watch(stateDir, (_ev, name) => { if (!name || String(name) === STATE_FILE) soon(); });
      watcher.on('error', () => { try { watcher.close(); } catch {} watcher = null; });
    } catch { watcher = null; }
    const timer = setInterval(check, pollMs);
    if (timer.unref) timer.unref();
    return {
      // Kendi yazdığımız durumu "görülmüş" say: aynı değişikliği tekrar işlemeyelim
      seen(gen) { lastGen = Math.max(lastGen, gen); },
      stop() {
        clearInterval(timer);
        clearTimeout(debounce);
        if (watcher) try { watcher.close(); } catch {}
      },
    };
  }

  return { readCredential, writeCredential, deleteCredential, readState, bumpState, watch, stateFile };
}

module.exports = { createSso, encodeCredential, decodeCredential, systemKeyring, SERVICE, ACCOUNT, STATE_FILE, MAX_CHARS };
