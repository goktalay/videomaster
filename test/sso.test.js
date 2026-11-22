'use strict';

// Ortak oturum (SSO, Mastertool sözleşmesi v1 §2): ortak kimlik, durum işareti ve iki uygulama arasında
// şifresiz giriş / ailede çıkış (bellek içi kimlik deposu ve sahte sunucuyla)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMock } = require('./mock-server');
const { createSso, encodeCredential, decodeCredential, MAX_CHARS } = require('../src/sso');

let mock;
test.before(async () => {
  mock = createMock();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  process.env.VDM_API = `http://127.0.0.1:${mock.server.address().port}`;
});
test.after(() => mock.server.close());

const load = () => {
  delete require.cache[require.resolve('../src/account')];
  return require('../src/account');
};

// Windows Kimlik Bilgisi Yöneticisi yerine bellek içi depo (tüm "uygulamalar" aynı depoyu görür)
function memKeyring() {
  let value = null;
  return { get: () => value, set: (v) => { value = v; }, del: () => { value = null; }, peek: () => value };
}

function family() {
  const keyring = memKeyring();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvm-mastertool-'));
  return { keyring, stateDir };
}

// Aynı bilgisayardaki bir Mastertool uygulaması (kendi userData klasörü, ortak kimlik ve durum işareti)
function app(fam, name, events = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cvm-${name}-`));
  const store = { folders: [], connections: [], local: {}, syncMeta: {}, settings: { appTheme: 'system', language: null, hexMode: 'hex' } };
  const sso = createSso({ keyring: fam.keyring, stateDir: fam.stateDir, pollMs: 50 });
  const log = [];
  const { createAccount } = load();
  const acc = createAccount({
    userDataDir: dir, appVersion: '1.1.0', encrypt: (s) => s, decrypt: (s) => s,
    getStore: () => store,
    replaceLibrary: ({ folders, connections, settings, syncMeta }) => { Object.assign(store, { folders, connections, syncMeta }); Object.assign(store.settings, settings); },
    persistStore: () => {}, backupAndClearLibrary: () => null, onStatus: () => {}, onUpdate: () => {},
    onSessionExpired: (code) => log.push(['expired', code]),
    sso,
    onSharedLogin: (r) => { log.push(['sharedLogin', r.ok]); if (events.onSharedLogin) events.onSharedLogin(r); },
    onSharedLogout: () => { log.push(['sharedLogout']); acc.endLocal(); if (events.onSharedLogout) events.onSharedLogout(); },
  });
  return { dir, store, acc, sso, log };
}

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('zaman aşımı');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('ortak kimlik: kodlama, sınır ve bozuk veri', () => {
  const json = encodeCredential({ email: 'a@b.c', user: { id: 'u1', name: 'X'.repeat(3000) }, sso_token: 's', master: Buffer.alloc(32, 1), kdf: { alg: 'PBKDF2-SHA256', iter: 310000, salt: 'AA==' } });
  assert.ok(json.length <= MAX_CHARS);
  const c = decodeCredential(json);
  assert.strictEqual(c.v, 1);
  assert.strictEqual(c.master, Buffer.alloc(32, 1).toString('base64'));
  assert.strictEqual(decodeCredential('{bozuk'), null);
  assert.strictEqual(decodeCredential(JSON.stringify({ v: 2, sso_token: 's' })), null);
});

test('durum işareti: gen ilerler, başka süreçteki değişiklik izleyiciye ulaşır, kendi yazdığımız görülmüş sayılır', async () => {
  const fam = family();
  const a = createSso({ keyring: fam.keyring, stateDir: fam.stateDir, pollMs: 50 });
  const b = createSso({ keyring: fam.keyring, stateDir: fam.stateDir, pollMs: 50 });
  assert.deepStrictEqual(a.readState(), { gen: 0, state: 'out', at: 0 });
  const seen = [];
  const w = a.watch((s) => seen.push(s.state));
  w.seen(a.bumpState('in').gen);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepStrictEqual(seen, []);
  b.bumpState('out');
  await waitFor(() => seen.length === 1);
  assert.deepStrictEqual(seen, ['out']);
  assert.strictEqual(a.readState().gen, 2);
  w.stop();
});

test('şifreyle giriş ortak kimliği yazar; diğer uygulama şifresiz girer ve aynı şifreli kütüphaneyi açar', async () => {
  const fam = family();
  const A = app(fam, 'a');
  const B = app(fam, 'b');
  await A.acc.login('test@example.com', 'Test1234!', true);
  const cred = A.sso.readCredential();
  assert.ok(cred && cred.sso_token && cred.master, 'ortak kimlik yazılmalı');
  assert.strictEqual(A.sso.readState().state, 'in');
  // master ve sso_token dosyaya yazılmaz
  const saved = fs.readFileSync(path.join(A.dir, 'account.json'), 'utf8');
  assert.ok(!saved.includes(cred.master));
  assert.ok(!saved.includes(cred.sso_token));

  A.store.connections.push({ ...require('../src/schema').normalize({ name: 'Ortak', protocol: 'udp', port: 1234 }), id: 'p1', createdAt: 1 });
  await A.acc.syncNow();

  assert.strictEqual(B.acc.isLoggedIn(), false);
  const r = await B.acc.loginWithShared();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(B.acc.isLoggedIn(), true);
  await B.acc.syncNow();
  assert.strictEqual(B.acc.state().state, 'ok');
  assert.strictEqual(B.store.connections[0].name, 'Ortak', 'paylaşılan master ile aynı anahtar türetilmeli');
});

test('bir uygulamada çıkış: ortak kimlik silinir, durum "out", diğer uygulama da çıkar; yerel veri kalır', async () => {
  const fam = family();
  const A = app(fam, 'a');
  const B = app(fam, 'b');
  await A.acc.login('test@example.com', 'Test1234!', true);
  await B.acc.loginWithShared();
  A.store.connections.push({ ...require('../src/schema').normalize({ name: 'Yerel', protocol: 'udp' }), id: 'keep', createdAt: 1 });
  A.acc.watchShared();
  const sso = A.sso.readCredential().sso_token;

  await B.acc.logout();
  assert.strictEqual(fam.keyring.peek(), null);
  assert.strictEqual(B.sso.readState().state, 'out');
  await waitFor(() => A.log.some((e) => e[0] === 'sharedLogout'));
  assert.strictEqual(A.acc.isLoggedIn(), false);
  assert.strictEqual(A.store.connections.length, 1, 'yerel projeler silinmez');
  A.acc.stopShared();
  // Sunucu ortak oturumu bitirdi: bu ortak oturumdan açılmış tüm uygulama oturumları geçersiz
  assert.ok(![...mock.state.tokens.values()].includes(sso));
  assert.ok(!mock.state.ssos.has(sso));
});

test('giriş ekranındayken başka uygulamada giriş yapılınca şifresiz girer', async () => {
  const fam = family();
  const A = app(fam, 'a');
  const B = app(fam, 'b');
  A.acc.watchShared();
  await B.acc.login('test@example.com', 'Test1234!', false);
  await waitFor(() => A.acc.isLoggedIn());
  assert.deepStrictEqual(A.log.find((e) => e[0] === 'sharedLogin'), ['sharedLogin', true]);
  A.acc.stopShared();
});

test('ortak oturum sunucuda düşmüşse (401) kimlik silinir ve durum "out" olur', async () => {
  const fam = family();
  const A = app(fam, 'a');
  await A.acc.login('test@example.com', 'Test1234!', true);
  const cred = A.sso.readCredential();
  mock.state.ssos.delete(cred.sso_token);
  const B = app(fam, 'b');
  const r = await B.acc.loginWithShared();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fam.keyring.peek(), null);
  assert.strictEqual(B.sso.readState().state, 'out');
});

test('uygulamada 401 gelince ortak kimlik silinir', async () => {
  const fam = family();
  const A = app(fam, 'a');
  await A.acc.login('test@example.com', 'Test1234!', true);
  mock.state.tokens.clear();
  await A.acc.syncNow();
  assert.strictEqual(A.acc.isLoggedIn(), false);
  assert.deepStrictEqual(A.log.find((e) => e[0] === 'expired'), ['expired', 'session_expired']);
  assert.strictEqual(fam.keyring.peek(), null);
  assert.strictEqual(A.sso.readState().state, 'out');
});

test('app_disabled ortak oturumu atlatmaz; kimlik korunur', async () => {
  const fam = family();
  const A = app(fam, 'a');
  await A.acc.login('test@example.com', 'Test1234!', true);
  mock.state.disabled = true;
  try {
    const B = app(fam, 'b');
    const r = await B.acc.loginWithShared();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'app_disabled');
    assert.ok(fam.keyring.peek(), 'başka uygulamaların ortak kimliği silinmez');
  } finally {
    mock.state.disabled = false;
  }
});

test('şifre başka yerde değiştiyse (kdf tuzu farklı) ortak kimlik eski sayılır', async () => {
  const fam = family();
  const A = app(fam, 'a');
  await A.acc.login('test@example.com', 'Test1234!', true);
  const old = mock.state.kdf;
  mock.state.kdf = { ...old, salt: 'BBECAwQFBgcICQoLDA0ODw==' };
  try {
    const B = app(fam, 'b');
    const r = await B.acc.loginWithShared();
    assert.strictEqual(r.code, 'stale_credential');
    assert.strictEqual(B.acc.isLoggedIn(), false);
  } finally {
    mock.state.kdf = old;
  }
});

test('uygulama kapalıyken ailede çıkış yapıldıysa açılışta oturum kapanır', async () => {
  const fam = family();
  const A = app(fam, 'a');
  await A.acc.login('test@example.com', 'Test1234!', true);
  // A kapanır; başka uygulama çıkış yapar
  fam.keyring.del();
  A.sso.bumpState('out');
  const { createAccount } = load();
  const reopened = createAccount({
    userDataDir: A.dir, appVersion: '1.1.0', encrypt: (s) => s, decrypt: (s) => s, getStore: () => A.store,
    replaceLibrary: () => {}, persistStore: () => {}, backupAndClearLibrary: () => null, onStatus: () => {}, onUpdate: () => {}, onSessionExpired: () => {},
    sso: createSso({ keyring: fam.keyring, stateDir: fam.stateDir }),
  });
  assert.strictEqual(reopened.isLoggedIn(), true);
  assert.strictEqual(reopened.sharedEndedWhileClosed(), true);
  assert.strictEqual(reopened.isLoggedIn(), false);
});
