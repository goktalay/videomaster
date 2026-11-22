'use strict';

const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, nativeTheme, protocol, Tray, Menu, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const I18N = require('./i18n');
const SCHEMA = require('./schema');
const { createAccount, apiBase, APP_CODE } = require('./account');
const { createSso } = require('./sso');
const { StreamSession } = require('./stream/session');
const CAMERAS = require('./models');
const VISION = require('./vision/catalog');
const { createModels } = require('./vision/models');

// Arayüz dili: ayarlarda seçilen ya da sistem dili (desteklenmiyorsa İngilizce)
let t = I18N.createT('en');
const currentLang = () => (store && store.settings.language) || I18N.resolveLanguage(app.getLocale());
function applyLanguage() { t = I18N.createT(currentLang()); }

const APP_NAME = 'Video Master';
// Ses, kullanıcı tıklaması beklenmeden başlayabilsin (akış penceresi açılınca oynatılır)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Yapay görü (WASM) birden çok iş parçacığı kullanabilsin
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const userDir = (...p) => path.join(app.getPath('userData'), ...p);

// Kart küçük resimleri: vdm://thumb/<bağlantıId>
protocol.registerSchemesAsPrivileged([{ scheme: 'vdm', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// ffmpeg: kurulumla gelen (asar dışına açılmış) ikili; VDM_FFMPEG ile başka bir derleme kullanılabilir
function ffmpegPath() {
  if (process.env.VDM_FFMPEG) return process.env.VDM_FFMPEG;
  try { return String(require('ffmpeg-static') || '').replace('app.asar', 'app.asar.unpacked'); } catch { return 'ffmpeg'; }
}
const caps = { version: '', hwaccels: [], protocols: [] };
function detectCaps() {
  const run = (args) => new Promise((resolve) => execFile(ffmpegPath(), ['-hide_banner', ...args], { windowsHide: true, timeout: 15000 }, (_e, out, err) => resolve(String(out || '') + String(err || ''))));
  return Promise.all([run(['-version']), run(['-hwaccels']), run(['-protocols'])]).then(([v, h, p]) => {
    caps.version = (/ffmpeg version (\S+)/.exec(v) || [])[1] || '';
    caps.hwaccels = h.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !/:$/.test(x) && /^[a-z0-9_]+$/.test(x));
    const input = (p.split(/Output:/)[0] || '').split(/\r?\n/).map((x) => x.trim()).filter((x) => /^[a-z0-9]+$/.test(x));
    caps.protocols = input;
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Kalıcı depo (userData/store.json)
// ---------------------------------------------------------------------------
const storePath = () => userDir('store.json');

const defaultStore = () => ({
  folders: [],      // { id, name, parentId }
  connections: [],  // bağlantı tanımları (senkronlanır); şifreler DPAPI ile şifreli tutulur
  local: {},        // cihaza özgü: bağlantıId -> { info }
  syncMeta: {},     // senkron: öğe id -> { kind, hash, updated_at, rev, device, deleted }
  settings: {
    appTheme: 'system',      // 'dark' | 'light' | 'system'
    language: null,          // null = sistem dili
    openAtLogin: false,      // Windows oturumu açılınca başlat (cihaza özgü)
    minimizeToTray: false,
    closeToTray: false,
    recordDir: '',           // boşsa Videolar\Video Master (cihaza özgü)
    hexMode: 'hex',          // hex | ascii | bin | dec | b64
    hexBytesPerRow: 16,
    chartUnit: 'bit',        // bit | byte
    recordFormat: 'mp4',     // yeni bağlantılarda kayıt biçimi
    // akış penceresi düzeni (cihaza özgü, sessiz kaydedilir)
    panelTab: '', panelOpen: true, panelWidth: 380, bottomOpen: true, bottomHeight: 290, infoWidth: 380, chartRange: 60, cardSize: 'm',
  },
});

let store = null;
const uid = () => crypto.randomBytes(8).toString('hex');

function loadStore() {
  applyLanguage();
  try {
    store = { ...defaultStore(), ...JSON.parse(fs.readFileSync(storePath(), 'utf8')) };
    store.settings = { ...defaultStore().settings, ...(store.settings || {}) };
    if (!store.syncMeta) store.syncMeta = {};
    if (!store.local) store.local = {};
    if (!Array.isArray(store.connections)) store.connections = [];
  } catch {
    store = defaultStore();
  }
  applyAppTheme();
  applyLanguage();
}

function applyAppTheme() {
  const v = store.settings.appTheme;
  nativeTheme.themeSource = v === 'dark' || v === 'light' ? v : 'system';
}
const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#0b0f17' : '#eef2f7');

let saveTimer = null;
// Kütüphane değişikliği kaydedilir ve (3 sn sonra) senkron tetiklenir; cihaza özgü kayıtlar için { sync: false }
function saveStore({ sync = true } = {}) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStore, 150);
  if (sync && account) account.onLocalChange();
}
function writeStore() {
  saveTimer = null;
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
}

function encrypt(text) {
  if (!text) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64');
  return 'b64:' + Buffer.from(text, 'utf8').toString('base64');
}
function decrypt(value) {
  if (!value) return '';
  try {
    if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    if (value.startsWith('b64:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
  } catch { return ''; }
  return value;
}

// Bağlantıdaki gizli alanlar depoda şifreli durur
const SECRETS = ['password', 'srtPassphrase'];
// (özel adres de kullanıcı adı / şifre içerebildiği için şifrelenir)
const lockConn = (c) => { const o = { ...c }; for (const k of SECRETS) o[k] = encrypt(o[k] || ''); if (o.protocol === 'custom') o.url = encrypt(o.url || ''); return o; };
const plainConn = (c) => { const o = { ...c }; for (const k of SECRETS) o[k] = decrypt(o[k] || ''); if (o.protocol === 'custom') o.url = decrypt(o.url || ''); return o; };
const getConn = (id) => store.connections.find((x) => x.id === id);
const getLocal = (id) => store.local[id] || (store.local[id] = {});

function publicConn(c) {
  const o = plainConn(c);
  o.display = SCHEMA.displayUrl(o);
  for (const k of SECRETS) { o[`has_${k}`] = !!o[k]; o[k] = ''; }
  if (o.protocol === 'custom') o.url = o.display; // özel adresteki şifre pencerelere gitmez
  const loc = store.local[c.id];
  o.lastInfo = loc && loc.info ? summarize(loc.info) : null;
  return o;
}

// Kartta gösterilen kısa akış özeti
function summarize(info) {
  const v = (info.streams || []).find((s) => s.type === 'video');
  const a = (info.streams || []).find((s) => s.type === 'audio');
  return { video: v ? { codec: v.codec, width: v.width, height: v.height, fps: v.fps } : null, audio: a ? { codec: a.codec, sampleRate: a.sampleRate } : null };
}

function publicStore() {
  return { folders: store.folders, settings: store.settings, connections: store.connections.map(publicConn) };
}

function broadcast(channel, data) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, data);
}
function broadcastStore() {
  if (tray) tray.setContextMenu(buildTrayMenu());
  broadcast('store:changed', publicStore());
}

// ---------------------------------------------------------------------------
// Mastertool hesabı (mastertool.download) ve uçtan uca şifreli senkron
// ---------------------------------------------------------------------------
let account = null;
let loginWindow = null;
let loginNotice = null;

function initAccount() {
  // Mastertool ortak oturumu: kimlik Windows Kimlik Bilgisi Yöneticisi'nde, durum işareti %APPDATA%\Mastertool altında
  let sso = null;
  try { sso = createSso({ stateDir: path.join(app.getPath('appData'), 'Mastertool') }); } catch { sso = null; }
  account = createAccount({
    sso,
    onSharedLogin: (r) => enterApp(r.backupFile),
    onSharedLogout: () => sharedLogout(),
    userDataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    encrypt,
    decrypt,
    // Senkron katmanı bağlantıları şifreleri çözülmüş görür (blob uçtan uca şifrelenir)
    getStore: () => ({ folders: store.folders, settings: store.settings, syncMeta: store.syncMeta, connections: store.connections.map(plainConn) }),
    replaceLibrary: ({ folders, connections, settings, syncMeta }) => {
      const prevLang = currentLang();
      const before = new Map(store.connections.map((c) => [c.id, JSON.stringify(plainConn(c))]));
      store.folders = folders;
      store.connections = connections.map(lockConn);
      store.syncMeta = syncMeta;
      Object.assign(store.settings, settings);
      writeStore();
      applyAppTheme();
      applyLanguage();
      broadcastStore();
      for (const [id, s] of sessions) {
        const c = getConn(id);
        if (!c) { closeViewer(id); dropSession(id); } // başka cihazda silindi
        else if (s.running && before.get(id) !== JSON.stringify(plainConn(c))) s.reload().catch(() => {});
      }
      for (const [id, w] of viewers) {
        const c = getConn(id);
        if (!c) { w.forceClose = true; w.destroy(); } else w.webContents.send('connection:changed', publicConn(c));
      }
      if (currentLang() !== prevLang && mainWindow) mainWindow.webContents.reload();
    },
    persistStore: writeStore,
    backupAndClearLibrary: () => {
      const hasData = store.connections.length || store.folders.length;
      let file = null;
      if (hasData) {
        file = userDir(`store-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
      }
      Object.assign(store, { folders: [], connections: [], local: {}, syncMeta: {} });
      writeStore();
      return file;
    },
    onStatus: (st) => broadcast('account:status', st),
    onSessionExpired: (code) =>
      showLogin(t(code === 'app_disabled' ? 'auth.errAppDisabled' : code === 'wrong_app' ? 'auth.errWrongApp' : 'auth.errSessionExpired')),
    onUpdate: (info) => mainWindow && mainWindow.webContents.send('app:update', info),
  });
}

// Giriş tamam (şifreyle ya da ortak oturumla): ana pencereyi aç, giriş penceresini kapat
function enterApp(backupFile) {
  loginNotice = null;
  pendingLogout = false;
  const fresh = !mainWindow;
  if (fresh) createMainWindow();
  if (loginWindow) loginWindow.destroy();
  if (backupFile) {
    const send = () => mainWindow && mainWindow.webContents.send('account:backup', backupFile);
    if (fresh) mainWindow.webContents.once('did-finish-load', send); else send();
  }
  if (!fresh) broadcastStore();
  account.start();
}

const anyBusy = () => [...sessions.values()].some((s) => s.rec.wanted);

// Başka bir Mastertool uygulamasında çıkış yapıldı. Bağlantılar ve kayıt dosyaları silinmez.
// Süren kayıt varsa kullanıcıya sorulur: şimdi kapat ya da kayıt bitince kapat.
let pendingLogout = false;
function sharedLogout() {
  if (pendingLogout) return;
  account.endLocal('signed_out_elsewhere');
  const notice = t('auth.signedOutElsewhere');
  if (!anyBusy()) return showLogin(notice);
  pendingLogout = true;
  const parent = BrowserWindow.getFocusedWindow() || mainWindow || undefined;
  const choice = dialog.showMessageBoxSync(parent, {
    type: 'question', buttons: [t('auth.logoutNow'), t('auth.logoutWhenDone')], defaultId: 1, cancelId: 1,
    title: APP_NAME, message: notice, detail: t('auth.logoutBusy'),
  });
  if (choice === 0) { pendingLogout = false; return showLogin(notice); }
  const timer = setInterval(() => {
    if (!pendingLogout) return clearInterval(timer); // bu arada yeniden giriş yapıldı
    if (anyBusy()) return;
    clearInterval(timer);
    pendingLogout = false;
    showLogin(notice);
  }, 2000);
}

// ---------------------------------------------------------------------------
// Pencereler
// ---------------------------------------------------------------------------
let mainWindow = null;
const viewers = new Map(); // bağlantıId -> BrowserWindow
const webPreferences = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false };

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 440, height: 640, resizable: false, maximizable: false, backgroundColor: windowBg(),
    title: APP_NAME, icon: ICON, autoHideMenuBar: true, webPreferences,
  });
  loginWindow.setMenuBarVisibility(false);
  loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  loginWindow.on('closed', () => (loginWindow = null));
}

// Oturum yoksa ya da düştüyse: giriş ekranını aç, diğer tüm pencereleri kapat (akışlar ve kayıtlar durur)
function showLogin(notice) {
  loginNotice = notice || null;
  if (!loginWindow) createLoginWindow();
  else loginWindow.focus();
  destroyTray();
  stopAllSessions();
  for (const w of BrowserWindow.getAllWindows()) if (w !== loginWindow) { w.forceClose = true; w.destroy(); }
  viewers.clear();
  mainWindow = null;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1240, height: 800, minWidth: 780, minHeight: 520, backgroundColor: windowBg(),
    title: APP_NAME, icon: ICON, autoHideMenuBar: true, webPreferences,
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('minimize', (e) => {
    if (!store.settings.minimizeToTray) return;
    e.preventDefault();
    hideToTray();
  });
  mainWindow.on('close', (e) => {
    if (store.settings.closeToTray && !isQuitting) {
      e.preventDefault();
      return hideToTray();
    }
    if (anyBusy() && !isQuitting && !mainWindow.forceClose) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question', buttons: [t('main.closeAnyway'), t('common.cancel')], defaultId: 1, cancelId: 1, title: APP_NAME, message: t('main.closeRecording'),
      });
      if (choice !== 0) e.preventDefault();
    }
  });
  mainWindow.on('show', destroyTray);
  mainWindow.on('closed', () => {
    mainWindow = null;
    // Ana pencere kapanınca akış pencereleri de kapanır (uygulama biter)
    for (const w of viewers.values()) { w.forceClose = true; w.destroy(); }
  });
  autoPlay();
}

// "Uygulama açılınca oynat" işaretli bağlantılar (oturum başına bir kez)
let autoPlayed = false;
function autoPlay() {
  if (autoPlayed) return;
  autoPlayed = true;
  for (const c of store.connections) if (c.autoPlay) playSession(c.id, 'card').catch(() => {});
}

// ---------------------------------------------------------------------------
// Sistem tepsisi
// ---------------------------------------------------------------------------
let tray = null;
let isQuitting = false;

function hideToTray() {
  ensureTray();
  mainWindow.hide();
  if (!store.settings.trayHintShown) {
    store.settings.trayHintShown = true;
    saveStore({ sync: false });
    tray.displayBalloon({ iconType: 'info', title: t('main.balloonTitle'), content: t('main.balloonBody') });
  }
}

function buildTrayMenu() {
  const list = store.connections.slice().sort((a, b) => a.name.localeCompare(b.name, currentLang()))
    .map((c) => ({ label: c.name, click: () => openViewer(c.id) }));
  return Menu.buildFromTemplate([
    { label: t('main.trayShow'), click: showMainWindow },
    { type: 'separator' },
    { label: t('main.trayConnections'), submenu: list.length ? list : [{ label: t('main.trayNone'), enabled: false }] },
    { type: 'separator' },
    { label: t('main.trayQuit'), click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function ensureTray() {
  if (tray) { tray.setContextMenu(buildTrayMenu()); return; }
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16, quality: 'best' }));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
}

// Tepsiden, Master Tool tepsi uygulamasından ya da ikinci kez çalıştırılınca: gizli/simge durumundaki pencereyi göster
function showMainWindow() {
  if (!account || (!account.isLoggedIn() && !pendingLogout)) {
    if (!loginWindow) return showLogin(loginNotice);
    if (loginWindow.isMinimized()) loginWindow.restore();
    loginWindow.show();
    loginWindow.focus();
    return;
  }
  if (!mainWindow) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openViewer(id) {
  if (!account || !account.isLoggedIn()) return;
  const c = getConn(id);
  if (!c) return;
  const existing = viewers.get(id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 940, minHeight: 600, backgroundColor: windowBg(),
    title: `${c.name} — ${APP_NAME}`, icon: ICON, autoHideMenuBar: true, webPreferences,
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`vdm://app/renderer/viewer.html?id=${encodeURIComponent(id)}`);
  viewers.set(id, win);
  win.on('closed', () => {
    viewers.delete(id);
    camClose(id);
    const s = sessions.get(id);
    if (!s) return;
    dropSubscriber(id);
    // Karttan başlatıldıysa ya da kayıt sürüyorsa akış kartta devam eder; yoksa durur
    if (s.running && (s.origin === 'card' || s.rec.wanted)) { s.origin = 'card'; s.setProfile('card').catch(() => {}); }
    else if (s.running) s.stop().catch(() => {});
  });
}

function closeViewer(id) {
  const w = viewers.get(id);
  if (w && !w.isDestroyed()) { w.forceClose = true; w.destroy(); }
  viewers.delete(id);
}

// ---------------------------------------------------------------------------
// Akış oturumları
// ---------------------------------------------------------------------------
const sessions = new Map();   // bağlantıId -> StreamSession
const cameras = new Map();    // bağlantıId -> kamera sürücüsü (src/models)
const subscribers = new Map(); // bağlantıId -> Map(webContentsId -> { wc, busy, pending, minGap, last, sentAt })
const lastFrames = new Map();  // bağlantıId -> JPEG (anlık görüntü ve kart küçük resmi için)

const recordRoot = () => store.settings.recordDir || path.join(app.getPath('videos'), APP_NAME);
const safeName = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 80) || 'stream';
const thumbPath = (id) => userDir('thumbs', `${id}.jpg`);

function getSession(id) {
  let s = sessions.get(id);
  if (s) return s;
  s = new StreamSession(id, {
    getConnection: () => { const c = getConn(id); return c ? SCHEMA.normalize(plainConn(c)) : null; },
    ffmpegPath: ffmpegPath(),
    tmpDir: userDir('tmp'),
    hwaccels: caps.hwaccels,
    getInfo: () => (store.local[id] || {}).info || null,
    setInfo: (info) => {
      const loc = getLocal(id);
      const changed = JSON.stringify(summarize(info)) !== JSON.stringify(loc.info ? summarize(loc.info) : null);
      loc.info = info;
      saveStore({ sync: false });
      if (changed) broadcastStore();
    },
    recordDir: (c) => path.join(recordRoot(), safeName(c.name)),
  });
  s.origin = 'card';
  s.on('state', (st) => {
    broadcast('stream:state', st);
    if (st.state === 'idle' || st.state === 'error') saveThumb(id);
  });
  s.on('stats', (st) => broadcast('stream:stats', st));
  s.on('frame', (frame) => deliverFrame(id, frame));
  s.on('audio', (pcm) => {
    const w = viewers.get(id);
    if (w && !w.isDestroyed()) w.webContents.send('stream:audio', { id, data: pcm });
  });
  s.on('error', () => {});
  sessions.set(id, s);
  return s;
}

function dropSession(id) {
  const s = sessions.get(id);
  sessions.delete(id);
  subscribers.delete(id);
  lastFrames.delete(id);
  if (s) { s.removeAllListeners('frame'); s.stop().catch(() => {}); }
}

function stopAllSessions() {
  for (const id of [...cameras.keys()]) camClose(id);
  for (const s of sessions.values()) s.stop().catch(() => {});
  sessions.clear();
  subscribers.clear();
}

async function playSession(id, origin) {
  if (!getConn(id)) return null;
  const s = getSession(id);
  if (origin === 'card') s.origin = 'card';
  else if (!s.running) s.origin = 'viewer';
  await s.start(viewers.has(id) ? 'full' : 'card');
  return s.snapshot();
}

// Kareler pencerelere onaylı gönderilir: pencere önceki kareyi çizmeden yenisi yollanmaz, aradakiler atlanır
function deliverFrame(id, frame) {
  lastFrames.set(id, frame);
  const subs = subscribers.get(id);
  if (!subs) return;
  const now = Date.now();
  for (const [wid, sub] of subs) {
    if (sub.wc.isDestroyed()) { subs.delete(wid); continue; }
    if (sub.busy && now - sub.sentAt < 1500) { sub.pending = frame; continue; }
    if (sub.minGap && now - sub.last < sub.minGap) { sub.pending = null; continue; }
    sendFrame(id, sub, frame, now);
  }
}
function sendFrame(id, sub, frame, now) {
  sub.busy = true; sub.pending = null; sub.sentAt = now; sub.last = now;
  sub.wc.send('stream:frame', { id, data: frame });
}
function dropSubscriber(id, wc) {
  const subs = subscribers.get(id);
  if (!subs) return;
  if (wc) subs.delete(wc.id);
  for (const [wid, sub] of subs) if (sub.wc.isDestroyed()) subs.delete(wid);
}

async function saveThumb(id) {
  const frame = lastFrames.get(id);
  if (!frame) return;
  try {
    await fs.promises.mkdir(userDir('thumbs'), { recursive: true });
    await fs.promises.writeFile(thumbPath(id), frame);
    broadcast('thumb:changed', { id, v: Date.now() });
  } catch { /* küçük resim isteğe bağlı */ }
}

function registerThumbProtocol() {
  protocol.handle('vdm', async (req) => {
    const u = new URL(req.url);
    // vdm://app/<src altındaki yol>: akış penceresi buradan yüklenir. COOP/COEP başlıkları sayfayı "cross-origin isolated"
    // yapar; yapay görü (WASM) ancak böyle birden çok iş parçacığı kullanabilir.
    if (u.host === 'app') {
      const file = path.normalize(path.join(__dirname, decodeURIComponent(u.pathname)));
      if (!file.startsWith(__dirname + path.sep)) return new Response('forbidden', { status: 403 });
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
      try {
        return new Response(await fs.promises.readFile(file), { status: 200, headers: {
          'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache',
          'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin',
        } });
      } catch { return new Response('not found', { status: 404 }); }
    }
    const id = u.pathname.replace(/^\//, '').replace(/[^a-z0-9]/gi, '');
    if (u.host !== 'thumb' || !id) return new Response('not found', { status: 404 });
    try {
      const data = await fs.promises.readFile(thumbPath(id));
      return new Response(data, { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' } });
    } catch { return new Response(null, { status: 204 }); } // küçük resim henüz yok: konsolu hatayla doldurma
  });
}

// ---------------------------------------------------------------------------
// IPC — hesap
// ---------------------------------------------------------------------------
ipcMain.handle('account:state', () => ({ ...account.state(), notice: loginNotice, appVersion: app.getVersion() }));

ipcMain.handle('account:login', async (_e, { email, password, remember }) => {
  try {
    const { backupFile } = await account.login(email, password, remember);
    enterApp(backupFile);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code || 'error', message: e.message };
  }
});

ipcMain.handle('account:logout', async (event) => {
  if (anyBusy()) {
    const choice = dialog.showMessageBoxSync(BrowserWindow.fromWebContents(event.sender) || undefined, {
      type: 'question', buttons: [t('acct.logout'), t('common.cancel')], defaultId: 1, cancelId: 1,
      title: APP_NAME, message: t('auth.logoutBusy'),
    });
    if (choice !== 0) return;
  }
  pendingLogout = false;
  await Promise.all([...sessions.values()].map((s) => s.stopRecording().catch(() => {})));
  await account.logout(); // ortak kimliği siler: diğer Mastertool uygulamalarında da çıkış yapılır
  showLogin();
});
ipcMain.handle('account:syncNow', () => account.syncNow());
ipcMain.handle('account:setSync', async (_e, on) => {
  try { await account.setSyncEnabled(on); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; }
});
ipcMain.handle('account:deleteRemote', async () => {
  try { await account.deleteRemote(); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; }
});

// Mastertool düğmesi: portal, uygulamanın dili ve o anki gece/gündüz temasıyla tarayıcıda açılır
ipcMain.handle('app:openMastertool', () => {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  shell.openExternal(`https://mastertool.download/?lang=${encodeURIComponent(currentLang())}&theme=${theme}`);
});

// Hesap sayfaları varsayılan tarayıcıda açılır (yalnız bu adresler)
ipcMain.handle('account:openWeb', (_e, page) => {
  const allowed = { forgot: '/sifremi-unuttum', register: '/kayit', account: '/hesabim' };
  if (!allowed[page]) return;
  const q = new URLSearchParams({ lang: currentLang(), theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', app: APP_CODE });
  shell.openExternal(`${apiBase()}${allowed[page]}?${q}`);
});

// Windows oturumu açılınca başlat (yalnız paketlenmiş uygulamada; geliştirmede electron.exe kaydedilmesin)
function applyOpenAtLogin() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!store.settings.openAtLogin, args: ['--hidden'] });
}

ipcMain.handle('app:about', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  ffmpeg: caps.version,
  hwaccels: caps.hwaccels,
  protocols: caps.protocols,
  recordDir: recordRoot(),
  dataDir: app.getPath('userData'),
  openAtLogin: app.isPackaged ? app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin : !!store.settings.openAtLogin,
}));

ipcMain.handle('app:checkUpdate', async () => {
  try {
    return { ok: true, ...(await account.checkUpdate({ manual: true })) };
  } catch (e) {
    return { ok: false, code: e.code || 'error', message: e.message };
  }
});

// Chromium/Electron lisans dosyaları kurulum klasöründe durur
ipcMain.handle('app:openLicenses', () => {
  const file = path.join(path.dirname(process.execPath), 'LICENSES.chromium.html');
  if (fs.existsSync(file)) return shell.openPath(file);
  return shell.openExternal('https://www.electronjs.org/docs/latest#license');
});
ipcMain.on('app:lang', (e) => { e.returnValue = currentLang(); });
ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });
ipcMain.handle('app:showMain', () => showMainWindow());
ipcMain.handle('app:copy', (_e, text) => clipboard.writeText(String(text || '')));

// ---------------------------------------------------------------------------
// IPC — depo, bağlantılar, klasörler
// ---------------------------------------------------------------------------
ipcMain.handle('store:get', () => publicStore());

// Yeniden bağlanma gerektirmeyen alanlar (görünüm, kayıt tercihleri, notlar)
const isCamKey = (k) => k === 'model' || /^cam[A-Z]/.test(k);
const SOFT_KEYS = new Set(['name', 'notes', 'folderId', 'color', 'autoPlay', 'fit', 'volume', 'startMuted', 'recFormat', 'recAudio', 'recAudioCodec', 'recSegmentMin', 'recName', 'createdAt', 'id']);

function saveConnection(form) {
  let prev = form.id ? getConn(form.id) : null;
  const before = prev ? plainConn(prev) : null;
  const input = { ...form };
  // Boş bırakılan gizli alan "değiştirme" demektir (pencerelere şifre gönderilmez)
  if (before) for (const k of SECRETS) if (input[k] === '' && input[`keep_${k}`]) input[k] = before[k];
  if (before && before.protocol === 'custom' && input.protocol === 'custom' && input.url === SCHEMA.displayUrl(before)) input.url = before.url;
  const c = SCHEMA.normalize(input);
  if (!c.name) c.name = t('main.untitled');
  const bad = SCHEMA.validate(c);
  if (bad.length) return { ok: false, invalid: bad };
  const id = prev ? prev.id : uid();
  c.vision = prev ? prev.vision : VISION.normalizeVision(form.vision);
  const next = lockConn({ ...c, id, createdAt: prev ? prev.createdAt : Date.now(), folderId: form.folderId ?? (prev ? prev.folderId : null) ?? null });
  if (prev) store.connections[store.connections.indexOf(prev)] = next; else store.connections.push(next);
  saveStore();
  broadcastStore();
  const w = viewers.get(id);
  if (w && !w.isDestroyed()) { w.setTitle(`${c.name} — ${APP_NAME}`); w.webContents.send('connection:changed', publicConn(next)); }
  // Çalışan oturum: ağ ya da çözme ayarı değiştiyse yeni ayarlarla yeniden bağlan
  const s = sessions.get(id);
  if (s && before) {
    const hard = Object.keys(c).some((k) => !SOFT_KEYS.has(k) && !isCamKey(k) && JSON.stringify(c[k]) !== JSON.stringify(before[k]));
    if (hard && s.running) s.reload().catch(() => {});
    else s.conn = SCHEMA.normalize(plainConn(next));
  }
  // Kamera kontrolü: model, adres ya da kontrol ayarı değiştiyse bağlantı yeni ayarlarla yeniden kurulur
  if (before && cameras.has(id) && ['host', ...Object.keys(c).filter(isCamKey)].some((k) => JSON.stringify(c[k]) !== JSON.stringify(before[k]))) {
    const was = cameras.get(id).connected;
    camClose(id);
    if (was && SCHEMA.modelOf(c)) camOpen(id);
  }
  return { ok: true, id };
}

ipcMain.handle('connection:save', (_e, form) => saveConnection(form || {}));
// Düzenleme formu için: gizli alanlar dışında tüm alanlar (şifre yerine "kayıtlı" bilgisi)
ipcMain.handle('connection:get', (_e, id) => { const c = getConn(id); return c ? publicConn(c) : null; });

ipcMain.handle('connection:delete', async (_e, id) => {
  closeViewer(id);
  dropSession(id);
  store.connections = store.connections.filter((c) => c.id !== id);
  delete store.local[id];
  saveStore();
  broadcastStore();
  fs.promises.rm(thumbPath(id), { force: true }).catch(() => {});
});

ipcMain.handle('connection:duplicate', (_e, id) => {
  const c = getConn(id);
  if (!c) return;
  store.connections.push({ ...JSON.parse(JSON.stringify(c)), id: uid(), name: c.name + t('main.copySuffix'), createdAt: Date.now(), autoPlay: false });
  saveStore();
  broadcastStore();
});

ipcMain.handle('connection:move', (_e, { id, folderId }) => {
  const c = getConn(id);
  if (c) c.folderId = folderId || null;
  saveStore();
  broadcastStore();
});

ipcMain.handle('connection:open', (_e, id) => openViewer(id));

// "Bağlantıyı sına": kaydetmeden geçici bir oturumla bağlanır; akış bilgisi ve bir kare döner
ipcMain.handle('connection:test', async (_e, form) => {
  const input = { ...form };
  const prev = form.id ? getConn(form.id) : null;
  if (prev) { const before = plainConn(prev); for (const k of SECRETS) if (input[k] === '' && input[`keep_${k}`]) input[k] = before[k]; if (input.protocol === 'custom' && input.url === SCHEMA.displayUrl(before)) input.url = before.url; }
  const c = SCHEMA.normalize({ ...input, name: input.name || 'test', reconnect: false, capture: 'off' });
  const bad = SCHEMA.validate(c);
  if (bad.length) return { ok: false, invalid: bad };
  let info = null;
  const s = new StreamSession(`test-${uid()}`, {
    getConnection: () => c, ffmpegPath: ffmpegPath(), tmpDir: userDir('tmp'), hwaccels: caps.hwaccels,
    getInfo: () => info, setInfo: (i) => { info = i; }, recordDir: () => userDir('tmp'),
  });
  s.on('error', () => {});
  let frame = null;
  s.on('frame', (f) => { frame = f; });
  const limit = (c.timeout + 15) * 1000;
  try {
    await s.start('card');
    const t0 = Date.now();
    // kare gelene, hata oluşana ya da (yalnız sesli akışta) bilgi alınana dek bekle
    await new Promise((resolve) => {
      const tick = setInterval(() => {
        const audioOnly = info && !info.streams.some((x) => x.type === 'video');
        if (frame || s.state === 'error' || audioOnly || Date.now() - t0 > limit) { clearInterval(tick); resolve(); }
      }, 100);
    });
    const ok = !!frame || !!(info && info.streams.length && s.state !== 'error');
    return { ok, info, error: ok ? null : (s.error || { code: 'timeout', detail: '' }), frame: frame ? `data:image/jpeg;base64,${frame.toString('base64')}` : null, command: s.command };
  } finally {
    s.stop().catch(() => {});
  }
});

ipcMain.handle('folder:save', (_e, { id, name, parentId }) => {
  let f = id ? store.folders.find((x) => x.id === id) : null;
  if (!f) {
    f = { id: uid(), parentId: parentId || null };
    store.folders.push(f);
  }
  f.name = String(name).trim();
  saveStore();
  broadcastStore();
  return f.id;
});

ipcMain.handle('folder:move', (_e, { id, parentId }) => {
  let p = parentId;
  while (p) {
    if (p === id) return false;
    p = (store.folders.find((x) => x.id === p) || {}).parentId;
  }
  const f = store.folders.find((x) => x.id === id);
  if (f) f.parentId = parentId || null;
  saveStore();
  broadcastStore();
  return true;
});

ipcMain.handle('folder:delete', (_e, id) => {
  const f = store.folders.find((x) => x.id === id);
  if (!f) return;
  for (const c of store.connections) if (c.folderId === id) c.folderId = f.parentId || null;
  for (const sub of store.folders) if (sub.parentId === id) sub.parentId = f.parentId || null;
  store.folders = store.folders.filter((x) => x.id !== id);
  saveStore();
  broadcastStore();
});

// Görünüm ayarları (panel boyutları vb.) sessizce kaydedilir, yayınlanmaz ve senkronlanmaz
const QUIET_SETTINGS = ['visionModels', 'panelTab', 'panelOpen', 'panelWidth', 'bottomOpen', 'bottomHeight', 'infoWidth', 'chartRange', 'cardSize', 'openAtLogin', 'minimizeToTray', 'closeToTray', 'trayHintShown', 'recordDir'];

ipcMain.handle('settings:set', (_e, patch) => {
  Object.assign(store.settings, patch);
  const loud = Object.keys(patch).some((k) => !QUIET_SETTINGS.includes(k));
  saveStore({ sync: loud });
  if ('appTheme' in patch) applyAppTheme();
  if ('openAtLogin' in patch) applyOpenAtLogin();
  if ('language' in patch) {
    applyLanguage();
    if (tray) tray.setContextMenu(buildTrayMenu());
    if (mainWindow) mainWindow.webContents.reload();
    if (loginWindow) loginWindow.webContents.reload();
    return;
  }
  if (loud || ['minimizeToTray', 'closeToTray', 'recordDir', 'cardSize'].some((k) => k in patch)) broadcastStore();
});

ipcMain.handle('dialog:pickDir', async (event, defaultPath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(win, { title: t('main.pickRecordDir'), defaultPath: defaultPath || recordRoot(), properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickSdp', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(win, { title: t('main.pickSdp'), properties: ['openFile'], filters: [{ name: 'SDP', extensions: ['sdp', 'txt'] }, { name: '*', extensions: ['*'] }] });
  if (r.canceled) return null;
  try { return (await fs.promises.readFile(r.filePaths[0], 'utf8')).slice(0, 8000); } catch { return null; }
});

// ---------------------------------------------------------------------------
// IPC — akış
// ---------------------------------------------------------------------------
ipcMain.handle('stream:states', () => [...sessions.values()].map((s) => s.snapshot()));
ipcMain.handle('stream:state', (_e, id) => (sessions.has(id) ? sessions.get(id).snapshot() : null));
ipcMain.handle('stream:play', (event, { id, origin }) => playSession(id, origin || 'card'));
ipcMain.handle('stream:stop', async (_e, id) => {
  const s = sessions.get(id);
  if (!s) return null;
  const rec = s.rec.wanted ? s.recState() : null;
  await s.stop();
  return { rec };
});
ipcMain.handle('stream:restart', async (_e, id) => {
  const s = sessions.get(id);
  if (!s) return;
  if (s.running) await s.reload(); else await playSession(id, s.origin);
});
ipcMain.handle('stream:history', (_e, id) => (sessions.has(id) ? sessions.get(id).history : []));

ipcMain.handle('stream:subscribe', (event, { id, on }) => {
  const wc = event.sender;
  if (!on) return dropSubscriber(id, wc);
  let subs = subscribers.get(id);
  if (!subs) { subs = new Map(); subscribers.set(id, subs); }
  // Ana pencere (kartlar) saniyede en çok ~10 kare alır; akış penceresi sınırsız
  const isViewer = viewers.get(id) && viewers.get(id).webContents === wc;
  subs.set(wc.id, { wc, busy: false, pending: null, minGap: isViewer ? 0 : 90, last: 0, sentAt: 0 });
  const frame = lastFrames.get(id);
  const s = sessions.get(id);
  if (frame && s && s.running) sendFrame(id, subs.get(wc.id), frame, Date.now());
});
ipcMain.on('stream:ack', (event, id) => {
  const subs = subscribers.get(id);
  const sub = subs && subs.get(event.sender.id);
  if (!sub) return;
  sub.busy = false;
  if (sub.pending) sendFrame(id, sub, sub.pending, Date.now());
});

// Anlık görüntü: son kareyi kayıt klasörüne JPEG olarak yazar
ipcMain.handle('stream:saveFrame', async (_e, id) => {
  const frame = lastFrames.get(id);
  const c = getConn(id);
  if (!frame || !c) return null;
  const dir = path.join(recordRoot(), safeName(c.name));
  await fs.promises.mkdir(dir, { recursive: true });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const file = path.join(dir, `${safeName(c.name)}_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}.jpg`);
  await fs.promises.writeFile(file, frame);
  return file;
});

// Kayıt
ipcMain.handle('rec:start', async (_e, id) => {
  if (!getConn(id)) return null;
  const s = getSession(id);
  return s.startRecording();
});
ipcMain.handle('rec:stop', async (_e, id) => {
  const s = sessions.get(id);
  return s ? s.stopRecording() : null;
});
ipcMain.handle('rec:reveal', (_e, file) => {
  if (!file) return shell.openPath(recordRoot());
  if (/%/.test(file) || !fs.existsSync(file)) return shell.openPath(path.dirname(file));
  shell.showItemInFolder(file);
});
ipcMain.handle('rec:openFile', (_e, file) => (file && fs.existsSync(file) ? shell.openPath(file) : null));
ipcMain.handle('rec:openDir', async (_e, id) => {
  const c = id ? getConn(id) : null;
  const dir = c ? path.join(recordRoot(), safeName(c.name)) : recordRoot();
  await fs.promises.mkdir(dir, { recursive: true });
  shell.openPath(dir);
});

// Akış verisi (HEX / paketler)
const tapOf = (id) => { const s = sessions.get(id); return s ? s.tap : null; };
ipcMain.handle('tap:tail', (_e, { id, bytes }) => {
  const tap = tapOf(id);
  if (!tap) return null;
  const n = Math.min(65536, Math.max(64, Number(bytes) || 2048));
  const { base, data } = tap.tail(n);
  return { base, data, total: tap.total, ...tap.drain(120) };
});
ipcMain.handle('tap:snapshot', (_e, id) => { const tap = tapOf(id); return tap ? tap.snapshot() : null; });
ipcMain.handle('tap:clear', (_e, id) => { const tap = tapOf(id); if (tap) tap.clear(); });
ipcMain.handle('tap:save', async (event, { id, base, length }) => {
  const tap = tapOf(id);
  const c = getConn(id);
  if (!tap || !c) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showSaveDialog(win, {
    title: t('main.saveDump'), defaultPath: path.join(app.getPath('documents'), `${safeName(c.name)}-dump.bin`),
    filters: [{ name: 'BIN', extensions: ['bin'] }],
  });
  if (res.canceled || !res.filePath) return null;
  const { data } = length ? tap.read(base, base + length) : tap.snapshot();
  await fs.promises.writeFile(res.filePath, data);
  return res.filePath;
});

// ---------------------------------------------------------------------------
// Yapay görü: modeller (indirme, kullanıcı modelleri), kameraya özel ayarlar, ayar dosyası
// ---------------------------------------------------------------------------
// Modeller klasörü: taşınabilir sürümde exe'nin yanı; kurulu sürümde program klasörü yazılabiliyorsa orası, değilse veri klasörü
let modelsDirCache = null;
function modelsDir() {
  if (process.env.VDM_MODELS) return process.env.VDM_MODELS;
  if (modelsDirCache) return modelsDirCache;
  const candidates = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'VideoMaster-models'));
  if (app.isPackaged) candidates.push(path.join(path.dirname(process.execPath), 'models'));
  candidates.push(userDir('models'));
  for (const d of candidates) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); const probe = path.join(d, '.w'); fs.writeFileSync(probe, ''); fs.rmSync(probe); modelsDirCache = d; return d; } catch { /* yazılamıyor: sıradaki */ }
  }
  modelsDirCache = userDir('models');
  return modelsDirCache;
}
const visionModels = createModels({
  dir: modelsDir,
  fetch: (url, opts) => require('electron').net.fetch(url, opts),
  getUserModels: () => store.settings.visionModels || [],
  setUserModels: (list) => { store.settings.visionModels = list; saveStore({ sync: false }); broadcast('vision:models', null); },
  emit: (event, data) => { broadcast(`vision:${event}`, data); if (data.state === 'done' || data.state === 'error') broadcast('vision:models', null); },
});

function setVision(id, vision) {
  const prev = getConn(id);
  if (!prev) return null;
  const v = VISION.normalizeVision(vision);
  store.connections[store.connections.indexOf(prev)] = { ...prev, vision: v };
  saveStore();
  return v;
}

ipcMain.handle('vision:models', () => ({ dir: modelsDir(), models: visionModels.list() }));
ipcMain.handle('vision:download', (_e, id) => visionModels.download(String(id)));
ipcMain.handle('vision:cancel', (_e, id) => visionModels.cancel(String(id)));
ipcMain.handle('vision:remove', async (_e, id) => { const r = await visionModels.remove(String(id)); broadcast('vision:models', null); return r; });
ipcMain.handle('vision:read', (_e, id) => visionModels.read(String(id)));
ipcMain.handle('vision:addModel', (_e, input) => visionModels.addUser(input || {}));
ipcMain.handle('vision:removeModel', (_e, id) => visionModels.removeUser(String(id)));
ipcMain.handle('vision:openDir', () => shell.openPath(modelsDir()));
ipcMain.handle('vision:pickModel', async (event) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: t('vis.pickModel'), properties: ['openFile'], filters: [{ name: 'ONNX', extensions: ['onnx'] }] });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});
ipcMain.handle('vision:runtime', async () => {
  const b = await fs.promises.readFile(path.join(__dirname, 'vendor', 'ort', 'ort-wasm-simd-threaded.wasm'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
});
ipcMain.handle('vision:set', (_e, { id, vision }) => setVision(id, vision));
// Ayar dosyası: yapay görü ayarları (ve kullanılan kullanıcı modellerinin tanımları) başka kameralara uygulanabilsin
ipcMain.handle('vision:export', async (event, id) => {
  const c = getConn(id);
  if (!c) return null;
  const vision = VISION.normalizeVision(c.vision);
  const used = (store.settings.visionModels || []).filter((m) => vision.modules[m.id]);
  const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: t('vis.exportTitle'), defaultPath: path.join(app.getPath('documents'), `${safeName(c.name)}.vmvision.json`), filters: [{ name: 'Video Master', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.promises.writeFile(res.filePath, JSON.stringify({ type: 'videomaster-vision', version: 1, app: app.getVersion(), vision, models: used }, null, 2));
  return res.filePath;
});
ipcMain.handle('vision:import', async (event, id) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: t('vis.importTitle'), properties: ['openFile'], filters: [{ name: 'Video Master', extensions: ['json'] }] });
  if (res.canceled || !res.filePaths.length) return null;
  try {
    const data = JSON.parse(await fs.promises.readFile(res.filePaths[0], 'utf8'));
    if (!data || data.type !== 'videomaster-vision' || !data.vision) return { ok: false, error: 'bad_file' };
    // Dosyadaki kullanıcı modelleri bu bilgisayarda yoksa tanımları eklenir (adresi olanlar indirilebilir)
    const have = store.settings.visionModels || [];
    const add = (Array.isArray(data.models) ? data.models : []).map(VISION.normalizeUserModel).filter((m) => m && !have.some((x) => x.id === m.id))
      .map((m) => ({ id: m.id, name: m.name, url: m.files[0].url || '', labels: m.labels, inputSize: m.inputSize, decoder: m.decoder }));
    if (add.length) { store.settings.visionModels = [...have, ...add]; broadcast('vision:models', null); }
    return { ok: true, vision: setVision(id, data.vision), file: res.filePaths[0] };
  } catch { return { ok: false, error: 'bad_file' }; }
});

// ---------------------------------------------------------------------------
// Kamera kontrolü (modele özel sürücüler: src/models). Sürücü akış penceresiyle yaşar.
// ---------------------------------------------------------------------------
function camSend(id, channel, data) {
  const w = viewers.get(id);
  if (w && !w.isDestroyed()) w.webContents.send(channel, { id, ...data });
}

async function camOpen(id) {
  const c = getConn(id);
  if (!c) return null;
  const conn = SCHEMA.normalize(plainConn(c));
  if (!SCHEMA.modelOf(conn)) return null;
  let drv = cameras.get(id);
  if (!drv) {
    drv = CAMERAS.createDriver(conn);
    if (!drv) return null;
    cameras.set(id, drv);
    drv.on('state', (st) => camSend(id, 'cam:state', { state: st }));
    drv.on('status', (status) => camSend(id, 'cam:status', { status }));
    drv.on('reply', (r) => camSend(id, 'cam:reply', r));
    drv.on('log', (l) => camSend(id, 'cam:log', l));
  }
  return drv.connect();
}

function camClose(id) {
  const drv = cameras.get(id);
  if (!drv) return;
  cameras.delete(id);
  drv.disconnect();
  drv.removeAllListeners();
  camSend(id, 'cam:state', { state: drv.snapshot() });
}

ipcMain.handle('cam:connect', (_e, id) => camOpen(id));
ipcMain.handle('cam:disconnect', (_e, id) => { camClose(id); return null; });
ipcMain.handle('cam:state', (_e, id) => (cameras.has(id) ? cameras.get(id).snapshot() : null));
ipcMain.handle('cam:exec', async (_e, { id, cmd, args }) => {
  const c = getConn(id);
  if (!c) return { ok: false, error: 'not_found' };
  // Aygıtın web/FTP arayüzü gibi yerel işlemler (ağa komut gönderilmez)
  const url = CAMERAS.external(SCHEMA.normalize(plainConn(c)), String(cmd));
  if (url) {
    if (!/^(ftp|https?):\/\//i.test(url)) return { ok: false, error: 'unsupported' };
    await shell.openExternal(url).catch(() => {});
    return { ok: true, opened: url.replace(/\/\/[^@/]*@/, '//') };
  }
  const drv = cameras.get(id);
  if (!drv || !drv.connected) return { ok: false, error: 'not_connected' };
  try { return await drv.exec(String(cmd), args || {}); } catch (e) { return { ok: false, error: 'error', detail: e.message }; }
});
ipcMain.on('cam:hold', (_e, { id, cmd, args }) => {
  const drv = cameras.get(id);
  if (drv && drv.connected) { try { drv.hold(String(cmd), args || null); } catch { /* yok */ } }
});

// ---------------------------------------------------------------------------
app.setAppUserModelId('com.videomaster.app');

app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => e.preventDefault());
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.on('before-quit', () => (isQuitting = true));

  app.whenReady().then(async () => {
    registerThumbProtocol();
    loadStore();
    initAccount();
    detectCaps();
    fs.promises.rm(userDir('tmp'), { recursive: true, force: true }).catch(() => {});
    // Uygulama girişsiz açılmaz. "Beni hatırla" ile saklı oturum varsa doğrudan açılır
    // (çevrimdışıyken yerel kütüphaneyle), oturum sunucuda düşmüşse giriş ekranına dönülür.
    // Uygulama kapalıyken başka bir Mastertool uygulamasında çıkış yapıldıysa bu oturum da kapanır
    if (account.sharedEndedWhileClosed()) loginNotice = t('auth.signedOutElsewhere');
    // Kendi oturumu yoksa ortak oturumla (başka bir Mastertool uygulamasında giriş yapılmış) şifresiz gir
    let backupFile = null;
    if (!account.isLoggedIn()) {
      const r = await account.loginWithShared();
      if (r.ok) backupFile = r.backupFile;
      else if (r.code === 'app_disabled') loginNotice = t('auth.errAppDisabled');
    }
    account.watchShared();
    if (account.isLoggedIn()) {
      createMainWindow();
      // Windows oturumuyla başlatıldıysa ve tepsiye küçültme açıksa doğrudan tepside başla
      if (process.argv.includes('--hidden') && store.settings.minimizeToTray) mainWindow.once('ready-to-show', () => hideToTray());
      if (backupFile) mainWindow.webContents.once('did-finish-load', () => mainWindow && mainWindow.webContents.send('account:backup', backupFile));
      account.start();
    } else {
      createLoginWindow();
    }
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && showMainWindow());
  });

  // Çıkarken süren kayıtlar düzgün kapatılır (dosyalar sonlandırılır)
  let finishing = false;
  app.on('will-quit', (e) => {
    if (finishing || !sessions.size) return;
    finishing = true;
    e.preventDefault();
    Promise.all([...sessions.values()].map((s) => s.stop().catch(() => {}))).finally(() => { sessions.clear(); app.quit(); });
  });

  app.on('window-all-closed', () => {
    destroyTray();
    if (account) account.stopShared();
    if (saveTimer) { clearTimeout(saveTimer); writeStore(); }
    app.quit();
  });
}
