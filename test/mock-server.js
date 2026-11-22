'use strict';

// Geliştirme ve testler için /api/vm sahte sunucusu (bellekte). Kullanım:
//   node test/mock-server.js 8787   →   VDM_API=http://127.0.0.1:8787 npm start
// Hesap: test@example.com / Test1234!

const http = require('http');
const { deriveKeys } = require('../src/account');

const SALT = 'AAECAwQFBgcICQoLDA0ODw==';
const KDF = { alg: 'PBKDF2-SHA256', iter: 310000, salt: SALT };

function createMock() {
  // tokens: uygulama oturumu → bağlı olduğu ortak oturum (sso_token) ya da null; ssos: geçerli ortak oturumlar
  const state = { version: 0, blob: null, sync: true, tokens: new Map(), ssos: new Set(), puts: 0, disabled: false, kdf: KDF };
  let n = 0;
  const issue = (sso) => { const t = `tok-${++n}-${Date.now()}`; state.tokens.set(t, sso || null); return t; };
  let authHash = null;
  const ready = deriveKeys('Test1234!', KDF).then((k) => { authHash = k.authHash; });
  const user = { id: 'u1', email: 'test@example.com', name: 'Test' };

  const server = http.createServer(async (req, res) => {
    await ready;
    let body = '';
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : {};
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const authed = () => (state.tokens.has(bearer) ? true : (send(401, { code: 'session_expired' }), false));
    const url = req.url.split('?')[0];
    if (url === '/api/vm/auth/prelogin') return send(200, { kdf: KDF });
    if (url === '/api/vm/auth/login') {
      if (json.email !== user.email || json.auth_hash !== authHash) return send(401, { code: 'bad_credentials' });
      if (state.disabled) return send(403, { code: 'app_disabled' });
      let sso = null;
      if (json.sso === true) { sso = `sso-${++n}-${Date.now()}`; state.ssos.add(sso); }
      return send(200, { token: issue(sso), ...(sso ? { sso_token: sso } : {}), user, sync_enabled: state.sync, kdf: state.kdf });
    }
    if (url === '/api/vm/auth/sso') {
      if (!state.ssos.has(json.sso_token)) return send(401, { code: 'session_expired' });
      if (state.disabled) return send(403, { code: 'app_disabled' });
      return send(200, { token: issue(json.sso_token), user, sync_enabled: state.sync, kdf: state.kdf });
    }
    // sso_token uygulama uçlarında kullanılamaz
    if (state.ssos.has(bearer)) return send(403, { code: 'wrong_app' });
    if (url === '/api/vm/auth/logout') {
      const sso = state.tokens.get(bearer);
      state.tokens.delete(bearer);
      // Ortak oturumla açılmış oturumdan çıkış tüm aileyi kapatır
      if (sso) { state.ssos.delete(sso); for (const [t, s2] of state.tokens) if (s2 === sso) state.tokens.delete(t); }
      return send(200, { ok: true, sso_ended: !!sso });
    }
    if (!authed()) return;
    if (url === '/api/vm/me') return send(200, { user, sync_enabled: state.sync, kdf: KDF });
    if (url === '/api/vm/settings') { state.sync = !!json.sync_enabled; return send(200, { sync_enabled: state.sync }); }
    if (url === '/api/vm/releases/latest') return send(200, { version: '0.0.1' });
    if (url === '/api/vm/library') {
      if (req.method === 'GET') return send(200, { version: state.blob ? state.version : null, blob: state.blob });
      if (req.method === 'DELETE') { state.blob = null; state.version = 0; return send(200, {}); }
      if (req.method === 'PUT') {
        if ((json.base_version ?? null) !== (state.blob ? state.version : null)) return send(409, { code: 'conflict', version: state.version, blob: state.blob });
        state.version += 1;
        state.blob = json.blob;
        state.puts++;
        return send(200, { version: state.version });
      }
    }
    send(404, { code: 'not_found' });
  });
  return { server, state };
}

if (require.main === module) {
  const port = Number(process.argv[2]) || 8787;
  createMock().server.listen(port, '127.0.0.1', () => console.log(`mock /api/vm http://127.0.0.1:${port}`));
}

module.exports = { createMock, KDF };
