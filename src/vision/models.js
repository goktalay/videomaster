'use strict';

// Yapay görü modellerinin dosyaları (ana süreç): kurulumla model gelmez; her model ilk kullanımdan önce
// modeller klasörüne indirilir. Kullanıcı kendi ONNX modelini adres ya da dosya olarak ekleyebilir.
// Klasör: taşınabilir sürümde exe'nin yanındaki "models", kurulu sürümde program klasörü yazılabiliyorsa oradaki
// "models", değilse kullanıcı veri klasörü.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const CATALOG = require('./catalog');

const MAX_BYTES = 600 * 1024 * 1024;
const safeFile = (s) => String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'model';

// deps: { dir(): string, fetch, getUserModels(): [], setUserModels([]), emit(event, data) }
function createModels(deps) {
  const active = new Map(); // modelId → AbortController

  const dir = () => { const d = deps.dir(); fs.mkdirSync(d, { recursive: true }); return d; };
  const userModels = () => (deps.getUserModels() || []).map(CATALOG.normalizeUserModel).filter(Boolean);
  const all = () => [...Object.values(CATALOG.MODELS), ...userModels()];
  const get = (id) => all().find((m) => m.id === id) || null;
  const filePath = (m, f) => path.join(dir(), m.id, safeFile(f.name));

  function installed(m) {
    return m.files.every((f) => {
      try { const st = fs.statSync(filePath(m, f)); return st.isFile() && st.size > 0 && (!f.size || st.size === f.size); } catch { return false; }
    });
  }

  function list() {
    return all().map((m) => ({
      id: m.id, name: m.name, kind: m.kind, user: !!m.user, license: m.license || '', source: m.source || '', note: m.note || '',
      size: m.files.reduce((n, f) => n + (f.size || 0), 0), installed: installed(m), downloading: active.has(m.id),
      remote: m.files.some((f) => !!f.url), labels: m.user ? m.labels : undefined, inputSize: m.inputSize, decoder: m.decoder,
    }));
  }

  async function fetchFile(m, f, signal, onBytes) {
    const dest = filePath(m, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const res = await deps.fetch(f.url, { redirect: 'follow', signal });
    if (!res.ok || !res.body) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'http' });
    const total = Number(res.headers.get('content-length')) || f.size || 0;
    if (total > MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'too_large' });
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    let got = 0;
    try {
      for await (const chunk of Readable.fromWeb(res.body)) {
        got += chunk.length;
        if (got > MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'too_large' });
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        onBytes(chunk.length, total);
      }
      await new Promise((resolve, reject) => { out.end((e) => (e ? reject(e) : resolve())); });
      const sum = hash.digest('hex');
      if (f.sha256 && sum !== f.sha256) throw Object.assign(new Error('checksum'), { code: 'checksum' });
      if (f.size && got !== f.size && f.sha256) throw Object.assign(new Error('size'), { code: 'checksum' });
      await fs.promises.rename(part, dest);
    } catch (e) {
      out.destroy();
      await fs.promises.rm(part, { force: true }).catch(() => {});
      throw e;
    }
  }

  // Modelin eksik dosyalarını indirir; ilerleme 'progress' olayıyla bildirilir
  async function download(id) {
    const m = get(id);
    if (!m) return { ok: false, error: 'not_found' };
    if (active.has(id)) return { ok: false, error: 'busy' };
    if (installed(m)) return { ok: true };
    const ctl = new AbortController();
    active.set(id, ctl);
    const total = m.files.reduce((n, f) => n + (f.size || 0), 0);
    let done = 0;
    let last = 0;
    const tell = (extra) => deps.emit('progress', { id, done, total, ...extra });
    tell({ state: 'start' });
    try {
      for (const f of m.files) {
        if (!f.url) throw Object.assign(new Error('no url'), { code: 'no_source' });
        try { const st = fs.statSync(filePath(m, f)); if (st.size > 0 && (!f.size || st.size === f.size)) { done += st.size; continue; } } catch { /* yok: indir */ }
        await fetchFile(m, f, ctl.signal, (n) => { done += n; const now = Date.now(); if (now - last > 150) { last = now; tell({ state: 'run' }); } });
      }
      active.delete(id);
      tell({ state: 'done' });
      return { ok: true };
    } catch (e) {
      active.delete(id);
      const error = ctl.signal.aborted ? 'cancelled' : e.code === 'checksum' ? 'checksum' : e.code === 'too_large' ? 'too_large' : e.code === 'no_source' ? 'no_source' : 'download';
      tell({ state: 'error', error });
      return { ok: false, error, detail: e.message };
    }
  }

  function cancel(id) { const c = active.get(id); if (c) c.abort(); }

  async function remove(id) {
    const m = get(id);
    if (!m) return false;
    cancel(id);
    await fs.promises.rm(path.join(dir(), m.id), { recursive: true, force: true }).catch(() => {});
    return true;
  }

  // Çalıştırma için: tanım + dosyaların içeriği
  async function read(id) {
    const m = get(id);
    if (!m || !installed(m)) return null;
    const files = {};
    for (const f of m.files) { const b = await fs.promises.readFile(filePath(m, f)); files[f.name] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    return { def: m, files };
  }

  // Kullanıcı modeli: { name, url | file, labels, inputSize, decoder }. Dosya verilirse modeller klasörüne kopyalanır.
  async function addUser(input) {
    const id = `u_${crypto.randomBytes(5).toString('hex')}`;
    const src = String((input && input.url) || '').trim();
    const file = String((input && input.file) || '').trim();
    if (!src && !file) return { ok: false, error: 'no_source' };
    if (src && !/^https?:\/\//i.test(src)) return { ok: false, error: 'bad_url' };
    const def = CATALOG.normalizeUserModel({ ...input, id, url: src, files: undefined });
    if (!def) return { ok: false, error: 'bad_args' };
    if (file) {
      try {
        const st = await fs.promises.stat(file);
        if (!st.isFile() || st.size > MAX_BYTES) return { ok: false, error: 'too_large' };
        const dest = filePath(def, def.files[0]);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(file, dest);
      } catch { return { ok: false, error: 'io' }; }
    }
    deps.setUserModels([...(deps.getUserModels() || []), { id, name: def.name, url: src, labels: def.labels, inputSize: def.inputSize, decoder: def.decoder }]);
    return { ok: true, id };
  }

  async function removeUser(id) {
    const cur = deps.getUserModels() || [];
    if (!cur.some((m) => m.id === id)) return false;
    await remove(id);
    deps.setUserModels(cur.filter((m) => m.id !== id));
    return true;
  }

  return { dir, list, get, installed: (id) => { const m = get(id); return !!m && installed(m); }, download, cancel, remove, read, addUser, removeUser };
}

module.exports = { createModels };
