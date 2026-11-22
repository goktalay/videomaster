'use strict';

// Hesap ve uçtan uca şifreli senkron: test vektörü, şifreleme, iki cihaz arasında bağlantı senkronu (sahte sunucuyla)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMock } = require('./mock-server');

let mock;
let base;
test.before(async () => {
  mock = createMock();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${mock.server.address().port}`;
  process.env.VDM_API = base;
});
test.after(() => mock.server.close());

const load = () => {
  delete require.cache[require.resolve('../src/account')];
  return require('../src/account');
};

test('sözleşme test vektörü', async () => {
  const { deriveKeys } = load();
  const k = await deriveKeys('Test1234!', { alg: 'PBKDF2-SHA256', iter: 310000, salt: 'AAECAwQFBgcICQoLDA0ODw==' });
  assert.strictEqual(k.authHash, 'mLBQ6HQqD19kX/VavErWYq+7tM4mCmGfic7GuQQlBMY=');
  assert.strictEqual(k.encKey.length, 32);
  // kütüphane anahtarı uygulamaya özgüdür (HKDF bilgisi "vdm-enc-v1"): Convert Master'ın anahtarından farklı olmalı
  assert.notStrictEqual(k.encKey.subarray(0, 8).toString('hex'), '44199cbf68e39ac9');
});

test('şifreleme gidiş-dönüş ve bozuk blob', () => {
  const { encryptLibrary, decryptLibrary } = load();
  const key = Buffer.alloc(32, 7);
  const blob = encryptLibrary(key, { schema: 1, items: [{ id: 'a' }] });
  assert.deepStrictEqual(decryptLibrary(key, blob), { schema: 1, items: [{ id: 'a' }] });
  assert.throws(() => decryptLibrary(Buffer.alloc(32, 8), blob), /decrypt_failed/);
});

function device(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vdm-${name}-`));
  const store = { folders: [], connections: [], local: {}, syncMeta: {}, settings: { appTheme: 'dark', language: null, hexMode: 'hex' } };
  const { createAccount } = load();
  const acc = createAccount({
    userDataDir: dir, appVersion: '1.0.0', encrypt: (s) => s, decrypt: (s) => s,
    getStore: () => store,
    replaceLibrary: ({ folders, connections, settings, syncMeta }) => { Object.assign(store, { folders, connections, syncMeta }); Object.assign(store.settings, settings); },
    persistStore: () => {}, backupAndClearLibrary: () => null, onStatus: () => {}, onSessionExpired: () => {}, onUpdate: () => {},
  });
  return { store, acc };
}

test('iki cihaz: bağlantı tanımı (şifresiyle) senkronlanır, cihaza özgü kayıtlar senkronlanmaz', async () => {
  const SCHEMA = require('../src/schema');
  const A = device('a');
  const B = device('b');
  await A.acc.login('test@example.com', 'Test1234!', true);
  await B.acc.login('test@example.com', 'Test1234!', true);
  A.store.connections.push({ ...SCHEMA.normalize({ name: 'Otopark', protocol: 'rtsp', host: '10.0.0.8', port: 554, path: '/ch1', username: 'admin', password: 'gizli-123', rtspTransport: 'udp' }), id: 'c1', createdAt: 1 });
  A.store.local.c1 = { recordDir: 'D:\\Kayit', info: { format: 'rtsp' } };
  await A.acc.syncNow();
  assert.strictEqual(A.acc.state().state, 'ok');
  await B.acc.syncNow();
  assert.strictEqual(B.store.connections.length, 1);
  const c = B.store.connections[0];
  assert.strictEqual(c.name, 'Otopark');
  assert.strictEqual(c.password, 'gizli-123');
  assert.strictEqual(c.rtspTransport, 'udp');
  assert.strictEqual(c.port, 554);
  assert.strictEqual(B.store.local.c1, undefined, 'kayıt klasörü cihaza özgü kalmalı');
  // Sunucudaki blob açık metin içermez
  const raw = Buffer.from(mock.state.blob, 'base64').toString('latin1');
  assert.ok(!raw.includes('Otopark') && !raw.includes('gizli-123'));
  // B yeniden adlandırır, A görür; B siler, A'dan da gider
  B.store.connections[0].name = 'Otopark 2';
  await B.acc.syncNow();
  await A.acc.syncNow();
  assert.strictEqual(A.store.connections[0].name, 'Otopark 2');
  assert.strictEqual(A.store.local.c1.recordDir, 'D:\\Kayit');
  B.store.connections = [];
  await B.acc.syncNow();
  await A.acc.syncNow();
  assert.strictEqual(A.store.connections.length, 0);
});
