'use strict';

// Mastertool hesabı ve uçtan uca şifreli bağlantı kütüphanesi senkronu (videomaster.app, sözleşme v1).
// SSH Master / FTP Masters / Convert Master'daki account.js'in Video Master uyarlaması: uçlar APP_API altında,
// şifreleme anahtarı ENC_INFO. Uygulama kodu sunucuda farklı tanımlanırsa yalnız bu iki sabit değişir.
// Senkronlanan: bağlantı tanımları (adres, kimlik bilgileri ve tüm akış ayarları), klasörler ve genel ayarlar.
// Senkronlanmayan: kayıt dosyaları, kayıt klasörü, pencere düzeni ve son akış bilgisi (cihaza özgü).
//
// Anahtarlar istemcide türetilir; sunucu ne şifreyi ne de şifreleme anahtarını görür:
//   master   = PBKDF2-SHA256(şifre, salt, iter, 32B)
//   encKey   = HKDF-SHA256(master, salt = boş, info = "vdm-enc-v1", 32B)   → AES-256-GCM
//   authHash = base64(PBKDF2-SHA256(master, şifre, 1, 32B))                → girişte gönderilen tek değer
// Kütüphane blob'u: base64(iv12 ‖ şifreli metin ‖ tag16), açık metni { schema: 1, items: [...] }.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const SCHEMA = require('./schema');

const APP_API = '/api/vm';       // Mastertool sunucusundaki uygulama öneki (Convert Master: /api/cv)
const APP_CODE = 'vm';           // hesap sayfalarına geçilen uygulama kodu
const ENC_INFO = 'vdm-enc-v1';   // HKDF bilgisi: kütüphane anahtarı uygulamaya özgüdür
const API_BASES = process.env.VDM_API ? [process.env.VDM_API] : ['https://videomaster.app', 'https://mastertool.download'];
const SYNC_DEBOUNCE_MS = 3000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BLOB_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Kriptografi
// ---------------------------------------------------------------------------
const pbkdf2 = (pass, salt, iter, len) =>
  new Promise((resolve, reject) => crypto.pbkdf2(pass, salt, iter, len, 'sha256', (e, k) => (e ? reject(e) : resolve(k))));

async function deriveKeys(password, kdf) {
  if (!kdf || kdf.alg !== 'PBKDF2-SHA256') throw Object.assign(new Error('unsupported_kdf'), { code: 'unsupported_kdf' });
  const pw = Buffer.from(password, 'utf8');
  const master = await pbkdf2(pw, Buffer.from(kdf.salt, 'base64'), kdf.iter, 32);
  const authHash = (await pbkdf2(master, pw, 1, 32)).toString('base64');
  const encKey = encKeyFromMaster(master);
  // master yalnız ortak oturum (SSO) kimliğine yazılmak üzere döner; dosyaya ya da günlüğe yazılmaz
  return { authHash, encKey, master };
}

// Ortak oturumla şifresiz giren uygulama anahtarını paylaşılan master'dan türetir
function encKeyFromMaster(master) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(ENC_INFO), 32));
}

function encryptLibrary(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

function decryptLibrary(key, blob) {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < 29) throw Object.assign(new Error('decrypt_failed'), { code: 'decrypt_failed' });
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const pt = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch {
    throw Object.assign(new Error('decrypt_failed'), { code: 'decrypt_failed' });
  }
}

// Anahtar sırası sabit JSON (içerik değişti mi karşılaştırması için)
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const hashOf = (data) => crypto.createHash('sha256').update(stable(data)).digest('base64');

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// Asıl adres videomaster.app; DNS hazır olana dek aynı API mastertool.download'da da var. Ağ hatasında
// (ya da JSON olmayan 404/5xx yanıtında) sıradaki adres denenir ve çalışan adres hatırlanır.
let baseIndex = 0;
const apiBase = () => API_BASES[baseIndex];

async function api(method, route, opts = {}) {
  let lastErr;
  for (let n = 0; n < API_BASES.length; n++) {
    const i = (baseIndex + n) % API_BASES.length;
    try {
      const out = await apiAt(API_BASES[i], method, route, opts);
      baseIndex = i;
      return out;
    } catch (e) {
      lastErr = e;
      if (!e.retryOther) throw e;
    }
  }
  throw lastErr;
}

async function apiAt(base, method, route, { token, body, timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(base + route, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } catch {
    throw Object.assign(new ApiError(0, 'offline', 'offline'), { retryOther: true });
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = await res.json(); } catch { /* boş gövde */ }
  if (!res.ok) {
    const code = (json && (json.code || json.detail)) || `http_${res.status}`;
    const err = new ApiError(res.status, code, json && json.message);
    err.body = json;
    if (!json && [404, 502, 503, 504, 521, 522, 523, 530].includes(res.status)) err.retryOther = true;
    throw err;
  }
  return json || {};
}

// ---------------------------------------------------------------------------
// Hesap + senkron yöneticisi
// ---------------------------------------------------------------------------
function createAccount(deps) {
  // deps: { userDataDir, appVersion, encrypt, decrypt, getStore, replaceLibrary, persistStore, backupAndClearLibrary,
  //         onStatus, onSessionExpired, onUpdate, sso, onSharedLogin, onSharedLogout }
  //
  // Ortak oturum (SSO, Mastertool sözleşmesi v1 §2): şifreyle giriş ortak kimliği (Windows Kimlik Bilgisi
  // Yöneticisi) yazar; ortak kimlik varken açılan uygulama /auth/sso ile şifresiz girer. Herhangi bir
  // Mastertool uygulamasında çıkış ortak kimliği siler ve durum işaretini "out" yapar; diğerleri de kapanır.
  const sso = deps.sso || null;
  const ssoRef = (t) => (t ? crypto.createHash('sha256').update(String(t)).digest('base64') : null);
  const file = path.join(deps.userDataDir, 'account.json');

  // Kalıcı alanlar (token ve anahtar yalnız "Beni hatırla" seçiliyse ve DPAPI ile şifreli yazılır)
  let saved = { deviceId: crypto.randomUUID(), email: '', remember: true, lastUserId: null };
  try { saved = { ...saved, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* ilk açılış */ }

  // Oturum (bellekte)
  let session = null; // { token, user, encKey: Buffer, kdfSalt, syncEnabled, ssoRef }
  if (saved.token && saved.encKey) {
    try {
      session = {
        token: deps.decrypt(saved.token),
        encKey: Buffer.from(deps.decrypt(saved.encKey), 'base64'),
        user: saved.user,
        kdfSalt: saved.kdfSalt,
        syncEnabled: saved.syncEnabled !== false,
        ssoRef: saved.ssoRef || null,
      };
    } catch { session = null; }
  }

  const status = { state: 'idle', lastSyncAt: saved.lastSyncAt || null, error: null, libraryVersion: saved.libraryVersion ?? null };

  function persist() {
    const out = { ...saved };
    if (session && saved.remember) {
      out.token = deps.encrypt(session.token);
      out.encKey = deps.encrypt(session.encKey.toString('base64'));
      out.user = session.user;
      out.kdfSalt = session.kdfSalt;
      out.syncEnabled = session.syncEnabled;
      out.ssoRef = session.ssoRef || null; // ortak oturumun özeti (sso_token'ın kendisi değil)
    } else {
      delete out.token; delete out.encKey; delete out.ssoRef;
    }
    out.lastSyncAt = status.lastSyncAt;
    out.libraryVersion = status.libraryVersion;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  }

  function publicState() {
    return {
      loggedIn: !!session,
      user: session ? session.user : null,
      email: saved.email,
      syncEnabled: session ? session.syncEnabled : false,
      ...status,
    };
  }

  function setStatus(patch) {
    Object.assign(status, patch);
    deps.onStatus(publicState());
  }

  const deviceName = () => `${os.hostname()} (Windows)`.slice(0, 120);

  // --- Kimlik doğrulama ----------------------------------------------------
  async function login(email, password, remember) {
    email = String(email || '').trim().toLowerCase();
    const pre = await api('POST', APP_API + '/auth/prelogin', { body: { email } });
    let keys = await deriveKeys(password, pre.kdf);
    const res = await api('POST', APP_API + '/auth/login', {
      body: { email, auth_hash: keys.authHash, device: deviceName(), app_version: String(deps.appVersion).slice(0, 30), sso: true },
    });
    // Sunucu girişte güncel kdf'yi döner; tuz farklıysa (şifre başka yerde değişmiş) anahtarı yeniden türet
    const kdf = res.kdf || pre.kdf;
    if (res.kdf && res.kdf.salt !== pre.kdf.salt) keys = await deriveKeys(password, res.kdf);

    const backupFile = beginSession(res, { email, encKey: keys.encKey, kdfSalt: kdf.salt, remember: !!remember, ssoToken: res.sso_token });
    // Ortak kimliği yaz ve diğer Mastertool uygulamalarına "giriş yapıldı" de
    if (sso && res.sso_token) {
      try {
        sso.writeCredential({ email, user: res.user, sso_token: res.sso_token, master: keys.master, kdf });
        markShared('in');
      } catch { /* kimlik deposu kullanılamıyorsa yalnız bu uygulamada oturum açık kalır */ }
    }
    keys.master.fill(0);
    return { backupFile };
  }

  // Yeni oturumu kur (şifreyle ya da ortak oturumla); farklı hesaba geçişte yerel kütüphaneyi yedekler
  function beginSession(res, { email, encKey, kdfSalt, remember, ssoToken }) {
    let backupFile = null;
    if (saved.lastUserId && saved.lastUserId !== res.user.id) backupFile = deps.backupAndClearLibrary();
    session = { token: res.token, user: res.user, encKey, kdfSalt, syncEnabled: res.sync_enabled !== false, ssoRef: ssoRef(ssoToken) };
    saved.email = email || (res.user && res.user.email) || saved.email;
    saved.remember = remember;
    saved.lastUserId = res.user.id;
    if (backupFile) { status.libraryVersion = null; status.lastSyncAt = null; }
    persist();
    setStatus({ error: null });
    return backupFile;
  }

  // Ortak kimlikle şifresiz giriş. Dönen: { ok, code, backupFile }
  async function loginWithShared() {
    if (!sso) return { ok: false, code: 'no_sso' };
    const cred = sso.readCredential();
    if (!cred) return { ok: false, code: 'no_credential' };
    let res;
    try {
      res = await api('POST', APP_API + '/auth/sso', {
        body: { sso_token: cred.sso_token, device: deviceName(), app_version: String(deps.appVersion).slice(0, 30) }, timeout: 8000,
      });
    } catch (e) {
      // Ortak oturum sunucuda düşmüş: kimliği sil, ailenin geri kalanına da bildir
      if (e.status === 401) { sso.deleteCredential(); markShared('out'); }
      return { ok: false, code: e.code || 'error', message: e.message };
    }
    const kdf = res.kdf || cred.kdf;
    // Şifre başka yerde değiştiyse paylaşılan master eski tuzdan türetilmiştir: şifreyle giriş gerekir
    if (!cred.master || (cred.kdf && kdf && cred.kdf.salt !== kdf.salt)) return { ok: false, code: 'stale_credential' };
    const master = Buffer.from(cred.master, 'base64');
    const encKey = encKeyFromMaster(master);
    master.fill(0);
    const backupFile = beginSession(res, { email: cred.email, encKey, kdfSalt: kdf && kdf.salt, remember: true, ssoToken: cred.sso_token });
    return { ok: true, backupFile };
  }

  // Durum işaretini ilerlet; kendi yazdığımızı izleyicide "görülmüş" say
  function markShared(state) {
    if (!sso) return;
    try { const s = sso.bumpState(state); if (watcher) watcher.seen(s.gen); } catch { /* işaret yazılamadı */ }
  }

  async function logout() {
    const token = session && session.token;
    session = null;
    stopTimers();
    persist();
    setStatus({ state: 'idle', error: null });
    // Ortak oturum ailede kapanır: kimliği sil, durumu "out" yap (sunucu da sso_ended ile tüm aileyi kapatır)
    if (sso) { sso.deleteCredential(); markShared('out'); }
    if (token) await api('POST', APP_API + '/auth/logout', { token, timeout: 8000 }).catch(() => {});
  }

  // Başka bir Mastertool uygulamasında giriş/çıkış: ortak kimliği okuyup karar ver
  // state: durum işaretindeki "in" / "out" (yoksa okunur). Çağrılar sırayla işlenir.
  let watcher = null;
  let syncing = Promise.resolve();
  function syncShared(state) {
    syncing = syncing.then(() => doSyncShared(state)).catch(() => {});
    return syncing;
  }
  async function doSyncShared(state) {
    if (!sso) return;
    const st = state || sso.readState().state;
    const cred = sso.readCredential();
    if (cred) {
      if (session && session.ssoRef === ssoRef(cred.sso_token)) return; // aynı ortak oturum
      const r = await loginWithShared();
      if (r.ok && deps.onSharedLogin) deps.onSharedLogin(r);
      return;
    }
    // Ortak kimlik silinmiş ve işaret "out": ailede çıkış yapıldı. ("in" iken kimlik okunamıyorsa dokunma.)
    if (st === 'out' && session && deps.onSharedLogout) deps.onSharedLogout();
  }

  // Açılışta: bu oturum ortak oturumdan geldiyse ve uygulama kapalıyken ailede çıkış yapıldıysa yerelde kapat
  function sharedEndedWhileClosed() {
    if (!sso || !session || !session.ssoRef) return false;
    if (sso.readCredential()) return false;
    if (sso.readState().state !== 'out') return false;
    endLocal();
    return true;
  }

  // Ana süreç ortak çıkışı uygular (süren kayıt bittikten sonra da olabilir); sunucuya çıkış gönderilmez
  function endLocal(code = 'signed_out_elsewhere') {
    session = null;
    stopTimers();
    persist();
    setStatus({ state: 'idle', error: code });
  }

  function watchShared() {
    if (!sso || watcher) return;
    watcher = sso.watch((st) => { syncShared(st.state); });
  }
  function stopShared() { if (watcher) { watcher.stop(); watcher = null; } }

  // Oturum sunucuda geçersiz: 401 session_expired, ya da 403 app_disabled (yönetici bu hesapta
  // Video Master'ı kapattı) / wrong_app (başka uygulamanın oturumu). Yerel kütüphane korunur.
  function expire(code = 'session_expired') {
    // Oturum düştüyse ortak kimlik de geçersizdir (şifre değişimi, askıya alma, Oturumlar'dan kapatma)
    if (code === 'session_expired' && sso) { sso.deleteCredential(); markShared('out'); }
    session = null;
    stopTimers();
    persist();
    setStatus({ state: 'idle', error: code });
    deps.onSessionExpired(code);
  }

  async function authed(method, route, body) {
    if (!session) throw new ApiError(401, 'session_expired');
    try {
      return await api(method, route, { token: session.token, body });
    } catch (e) {
      if (e.status === 401) expire('session_expired');
      else if (e.status === 403 && ['app_disabled', 'wrong_app'].includes(e.code)) expire(e.code);
      throw e;
    }
  }

  // --- Yerel kütüphane ↔ senkron öğeleri ------------------------------------
  // Her öğe: { id, kind, updated_at, rev, device, deleted, data }
  const meta = () => {
    const st = deps.getStore();
    if (!st.syncMeta) st.syncMeta = {};
    return st.syncMeta;
  };

  // Senkronlanan bağlantı alanları (sözleşme: kind "connection"). deps.getStore() bağlantıları şifreleri çözülmüş
  // verir; blob uçtan uca şifreli olduğu için kimlik bilgileri de taşınır. Cihaza özgü kayıtlar (store.local) gönderilmez.
  const CONNECTION_FIELDS = SCHEMA.CONNECTION_KEYS;
  const SETTINGS_FIELDS = ['appTheme', 'language', 'hexMode', 'hexBytesPerRow', 'chartUnit', 'recordFormat'];
  const SETTINGS_ID = 'settings';

  // Yerel deponun o anki halinden öğe verileri
  function currentData() {
    const st = deps.getStore();
    const out = new Map();
    for (const p of st.connections) {
      const data = {};
      for (const k of CONNECTION_FIELDS) data[k] = p[k] ?? null;
      out.set(p.id, { kind: 'connection', data });
    }
    for (const f of st.folders) out.set(f.id, { kind: 'folder', data: { name: f.name, parentId: f.parentId || null } });
    const settings = {};
    for (const k of SETTINGS_FIELDS) settings[k] = st.settings[k] ?? null;
    out.set(SETTINGS_ID, { kind: 'settings', data: settings });
    return out;
  }

  // Değişen/eklenen/silinen yerel öğelerin zaman damgasını ve rev'ini ilerlet
  function refreshMeta() {
    const m = meta();
    const now = Date.now();
    const cur = currentData();
    let changed = false;
    for (const [id, { kind, data }] of cur) {
      const h = hashOf(data);
      const old = m[id];
      if (!old || old.deleted || old.hash !== h) {
        // Bu cihazın ayarları ilk kez kayda geçiyorsa (yeni kurulum ya da yeni hesap) en eski zamanı alır;
        // böylece hesapta kayıtlı ayarlar varsayılan değerlerin üzerine yazılmaz, yoksa bunlar yüklenir.
        const fresh = id === SETTINGS_ID && !old;
        m[id] = { kind, hash: h, updated_at: fresh ? 0 : now, rev: (old ? old.rev : 0) + 1, device: saved.deviceId, deleted: false };
        changed = true;
      }
    }
    for (const [id, old] of Object.entries(m)) {
      if (!cur.has(id) && !old.deleted) {
        m[id] = { ...old, hash: null, deleted: true, updated_at: now, rev: old.rev + 1, device: saved.deviceId };
        changed = true;
      }
      if (m[id].deleted && now - m[id].updated_at > TOMBSTONE_TTL_MS) { delete m[id]; changed = true; }
    }
    return { cur, changed };
  }

  function localItems() {
    const { cur, changed } = refreshMeta();
    if (changed) deps.persistStore(); // zaman damgaları hemen diske; yoksa yeniden açılışta tekrar "değişti" sayılır
    const m = meta();
    return Object.entries(m).map(([id, x]) => ({
      id, kind: x.kind, updated_at: x.updated_at, rev: x.rev, device: x.device, deleted: !!x.deleted,
      data: x.deleted ? null : cur.get(id).data,
    }));
  }

  // Aynı id'de: büyük updated_at → büyük rev → büyük cihaz id'si kazanır (deterministik)
  const newer = (a, b) =>
    a.updated_at !== b.updated_at ? a.updated_at > b.updated_at : (a.rev || 0) !== (b.rev || 0) ? (a.rev || 0) > (b.rev || 0) : String(a.device || '') > String(b.device || '');

  function merge(a, b) {
    const map = new Map();
    for (const it of [...a, ...b]) {
      const prev = map.get(it.id);
      if (!prev || newer(it, prev)) map.set(it.id, it);
    }
    const now = Date.now();
    return [...map.values()].filter((it) => !(it.deleted && now - it.updated_at > TOMBSTONE_TTL_MS));
  }

  const itemsKey = (items) => stable([...items].sort((x, y) => (x.id < y.id ? -1 : 1)).map((x) => [x.id, x.updated_at, x.rev, x.deleted]));

  // Birleştirilmiş öğeleri yerel depoya uygula (cihaza özgü kayıtlar store.local'da olduğu için korunur)
  function applyItems(items) {
    const st = deps.getStore();
    const oldConnections = new Map(st.connections.map((x) => [x.id, x]));
    const live = items.filter((x) => !x.deleted && x.data);

    const folders = live.filter((x) => x.kind === 'folder').map((x) => ({ id: x.id, name: x.data.name, parentId: x.data.parentId || null }));
    const connections = live.filter((x) => x.kind === 'connection').map((x) => {
      const d = x.data;
      const old = oldConnections.get(x.id) || {};
      const p = { ...SCHEMA.normalize(d), id: x.id };
      p.createdAt = d.createdAt || old.createdAt || Date.now();
      return p;
    });
    const s = live.find((x) => x.kind === 'settings');
    const settings = {};
    if (s) for (const k of SETTINGS_FIELDS) if (k in s.data) settings[k] = s.data[k];

    const m = {};
    for (const it of items) {
      m[it.id] = { kind: it.kind, hash: null, updated_at: it.updated_at, rev: it.rev || 0, device: it.device, deleted: !!it.deleted };
    }
    deps.replaceLibrary({ folders, connections, settings, syncMeta: m });
    // Uygulanan verinin özetini kaydet ki yerel değişiklik sanılmasın
    const cur = currentData();
    for (const [id, x] of Object.entries(m)) if (!x.deleted && cur.has(id)) x.hash = hashOf(cur.get(id).data);
    deps.persistStore();
  }

  // --- Senkron döngüsü --------------------------------------------------------
  let running = null;
  let again = false;

  async function syncOnce() {
    if (!session) return;
    if (!session.syncEnabled) { setStatus({ state: 'off', error: null }); return; }
    setStatus({ state: 'syncing', error: null });
    try {
      const local = localItems();
      let remote = await authed('GET', APP_API + '/library');
      for (let attempt = 0; attempt < 4; attempt++) {
        let remoteItems = [];
        if (remote.blob) {
          const lib = decryptLibrary(session.encKey, remote.blob);
          remoteItems = Array.isArray(lib.items) ? lib.items : [];
        }
        // Bu cihazın ayarları hiç senkronlanmamışsa (updated_at 0) hesaptaki ayarlar kazanır
        const remoteHasSettings = remoteItems.some((x) => x.id === SETTINGS_ID && !x.deleted);
        const merged = merge(remoteHasSettings ? local.filter((x) => !(x.id === SETTINGS_ID && !x.updated_at)) : local, remoteItems);
        if (itemsKey(merged) !== itemsKey(local)) applyItems(merged);
        if (remote.blob && itemsKey(merged) === itemsKey(remoteItems)) {
          status.libraryVersion = remote.version;
          break; // sunucu zaten güncel
        }
        const blob = encryptLibrary(session.encKey, { schema: 1, items: merged });
        if (Buffer.byteLength(blob) > MAX_BLOB_BYTES) throw new ApiError(413, 'too_large');
        try {
          const put = await authed('PUT', APP_API + '/library', { base_version: remote.version ?? null, blob });
          status.libraryVersion = put.version;
          break;
        } catch (e) {
          if (e.status !== 409 || !e.body) throw e;
          remote = { version: e.body.version, blob: e.body.blob }; // çakışma: sunucudaki yeni hali birleştirip tekrar dene
          local.splice(0, local.length, ...merged);
        }
      }
      status.lastSyncAt = Date.now();
      persist();
      setStatus({ state: 'ok', error: null });
    } catch (e) {
      const code = e.code || 'error';
      if (code === 'session_expired') return;
      setStatus({ state: code === 'offline' ? 'offline' : 'error', error: code, errorMessage: e.message });
    }
  }

  function syncNow() {
    if (!session) return Promise.resolve();
    if (running) { again = true; return running; }
    running = syncOnce().finally(() => {
      running = null;
      if (again) { again = false; syncNow(); }
    });
    return running;
  }

  let debounce = null;
  let interval = null;
  function onLocalChange() {
    if (!session || !session.syncEnabled) return;
    clearTimeout(debounce);
    debounce = setTimeout(syncNow, SYNC_DEBOUNCE_MS);
  }
  function startTimers() {
    stopTimers();
    interval = setInterval(syncNow, SYNC_INTERVAL_MS);
  }
  function stopTimers() {
    clearTimeout(debounce);
    clearInterval(interval);
    debounce = interval = null;
  }

  // Açılış: oturum geçerli mi, senkron açık mı, yeni sürüm var mı
  async function start() {
    if (!session) return;
    startTimers();
    try {
      const me = await authed('GET', APP_API + '/me');
      session.user = me.user || session.user;
      session.syncEnabled = me.sync_enabled !== false;
      if (me.kdf && session.kdfSalt && me.kdf.salt !== session.kdfSalt) return expire(); // şifre başka yerde değişti
      persist();
    } catch (e) {
      if (e.status === 401 || e.status === 403) return;
      setStatus({ state: e.code === 'offline' ? 'offline' : 'error', error: e.code });
    }
    await syncNow();
    checkUpdate();
  }

  async function setSyncEnabled(on) {
    await authed('PUT', APP_API + '/settings', { sync_enabled: !!on });
    session.syncEnabled = !!on;
    persist();
    setStatus({ state: on ? 'idle' : 'off' });
    if (on) syncNow();
  }

  async function deleteRemote() {
    await authed('DELETE', APP_API + '/library');
    await setSyncEnabled(false);
    status.libraryVersion = null;
    // Sunucu kopyası gitti; yerel öğeler bir sonraki açılışta yeniden yüklenebilsin diye meta korunur
    persist();
  }

  async function checkUpdate({ manual = false } = {}) {
    try {
      const r = await authed('GET', APP_API + '/releases/latest');
      const newer = !!(r && r.version && compareVersions(r.version, deps.appVersion) > 0);
      if (newer) deps.onUpdate({ version: r.version, notes: r.notes || '' });
      return { latest: (r && r.version) || null, current: deps.appVersion, newer };
    } catch (e) {
      if (manual) throw e;
      return null; // açılıştaki bildirim isteğe bağlı
    }
  }

  return {
    isLoggedIn: () => !!session,
    state: publicState,
    login, logout, start, syncNow, loginWithShared, syncShared, sharedEndedWhileClosed, watchShared, stopShared, endLocal, onLocalChange, setSyncEnabled, deleteRemote, checkUpdate,
    // testler için
    _merge: merge,
  };
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

module.exports = { createAccount, deriveKeys, encKeyFromMaster, encryptLibrary, decryptLibrary, compareVersions, apiBase, APP_API, APP_CODE };
