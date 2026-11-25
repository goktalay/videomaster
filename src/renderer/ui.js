'use strict';

// Ortak arayüz yardımcıları (ana pencere ve akış penceresi) — SSH Master / FTP Masters / Convert Master ile ortak

// --- Dil ------------------------------------------------------------------------
const LANG = window.api.lang || 'en';
const t = I18N.createT(LANG);
document.documentElement.lang = LANG;
document.documentElement.dir = (I18N.LANGUAGES[LANG] || {}).dir || 'ltr';

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  takeoff: '<path d="M12 17V4M6 10l6-6 6 6M4 21h16"/>',
  route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H14a3.5 3.5 0 0 0 0-7h-4a3.5 3.5 0 0 1 0-7h5.5"/>',
  polygon: '<path d="M12 3 21 9.5 17.5 20h-11L3 9.5z"/>',
  circleIcon: '<circle cx="12" cy="12" r="8.5"/>',
  flag: '<path d="M5 21V4M5 4h12l-2 4 2 4H5"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12"/>',
  redo: '<path d="m15 7 5 5-5 5"/><path d="M20 12H10a6 6 0 0 0 0 12"/>',
  grid: '<path d="M4 6h16M20 6v6H4v6h16"/>',
  cursor: '<path d="m5 3 14 7-6 2-2 6z"/>',
  ruler: '<path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
  eyeTarget: '<circle cx="12" cy="12" r="3"/><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/>',
  land: '<path d="M12 3v13M6 10l6 6 6-6M4 21h16"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  altitude: '<path d="M7 20V4M3 8l4-4 4 4M14 8h7M14 12h5M14 16h7M14 20h5"/>',
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v5M12 17.6v.1"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  move: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  home: '<path d="m3 11 9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  bolt: '<path d="M13 3 4 14h7l-1 7 9-11h-7z"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  drive: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M5 13 7.5 5h9L19 13M7 16.5h.01"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  crosshair: '<circle cx="12" cy="12" r="8"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/>',
  columns:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  rows: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="m12 14 4-5"/><circle cx="12" cy="14" r="1.2"/>',
  swap: '<path d="M7 20V5M3 9l4-4 4 4M17 4v15M13 15l4 4 4-4"/>',
  broom: '<path d="M19 3 11 11M8 12l4 4-2 5-7-7 5-2zM6 17l-2 2"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  cloudOff: '<path d="M3 3l18 18M8.5 5.4A6 6 0 0 1 18 9a4.5 4.5 0 0 1 2.4 8.3M15 18H7a5 5 0 0 1-1.6-9.7"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  audio: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  export: '<path d="M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  hdd: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M5 13 7.5 5h9L19 13M7 16.5h.01"/>',
  checkSquare: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
  reconnect:'<path d="M4 4v6h6M20 20v-6h-6"/><path d="M20 10a8 8 0 0 0-14.3-4.3L4 10M4 14a8 8 0 0 0 14.3 4.3L20 14"/>',
  record: '<circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  volumeOff: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="m17 9 5 5M22 9l-5 5"/>',
  chart: '<path d="M4 19h16M4 15l4-5 4 3 4-7 4 4"/>',
  panelRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  panelBottom: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  signal: '<path d="M5 20v-4M10 20v-8M15 20V8M20 20V4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>',
  paste: '<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V3h6v2M9 11h6M9 15h4"/>',
};

function icon(name, cls = '') {
  return `<svg class="i ${cls}" viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  // LRI…PDI: sağdan sola dillerde "400 MB" ters ("MB 400") görünmesin
  return `⁦${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}⁩`;
}

function formatDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString(LANG, { dateStyle: 'short', timeStyle: 'short' });
}

function h(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// --- Bağlam menüsü ------------------------------------------------------------
let activeCtx = null;
function closeContextMenu() {
  if (activeCtx) { activeCtx.remove(); activeCtx = null; }
}
function contextMenu(x, y, items) {
  closeContextMenu();
  const menu = h('<div class="ctx"></div>');
  for (const it of items) {
    if (it === '-') { menu.appendChild(h('<hr>')); continue; }
    if (!it) continue;
    const b = h(`<button class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>${it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : ''}</button>`);
    if (it.disabled) b.disabled = true;
    b.addEventListener('click', () => { closeContextMenu(); it.action(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  activeCtx = menu;
}
window.addEventListener('mousedown', (e) => { if (activeCtx && !activeCtx.contains(e.target)) closeContextMenu(); }, true);
window.addEventListener('blur', closeContextMenu);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); });

// --- Bildirimler --------------------------------------------------------------
function toastHost() {
  let el = document.querySelector('.toasts');
  if (!el) { el = h('<div class="toasts"></div>'); document.body.appendChild(el); }
  return el;
}
function toast(title, { type = '', sub = '', timeout = 3500 } = {}) {
  const el = h(`<div class="toast ${type}"><div class="t-body"><div class="t-title">${esc(title)}</div>${sub ? `<div class="t-sub">${esc(sub)}</div>` : ''}</div></div>`);
  toastHost().appendChild(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}

// --- Modal --------------------------------------------------------------------
function openModal({ title, iconName, body, buttons = [], width, onMount }) {
  return new Promise((resolve) => {
    const back = h('<div class="modal-backdrop"></div>');
    const modal = h(`<div class="modal">
      <header>${iconName ? `<span style="color:var(--accent)">${icon(iconName)}</span>` : ''}<h2>${esc(title)}</h2></header>
      <div class="body"></div><footer><span class="spacer"></span></footer></div>`);
    if (width) modal.style.width = `min(${width}px, calc(100vw - 32px))`;
    const bodyEl = modal.querySelector('.body');
    if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.appendChild(body);
    const footer = modal.querySelector('footer');
    const close = (val) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    for (const b of buttons) {
      const btn = h(`<button class="btn ${b.cls || ''}">${b.icon ? icon(b.icon) : ''}${esc(b.label)}</button>`);
      btn.addEventListener('click', async () => {
        if (b.onClick) {
          const r = await b.onClick(modal, btn);
          if (r === false) return;
          close(r === undefined ? b.value : r);
        } else close(b.value);
      });
      if (b.left) footer.insertBefore(btn, footer.querySelector('.spacer')); else footer.appendChild(btn);
    }
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        const primary = [...footer.querySelectorAll('.btn.primary')].pop();
        if (primary) { e.preventDefault(); primary.click(); }
      }
    };
    document.addEventListener('keydown', onKey);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    back.appendChild(modal);
    document.body.appendChild(back);
    if (onMount) onMount(modal, close);
    const first = modal.querySelector('input:not([type=checkbox]),textarea,select');
    if (first) setTimeout(() => first.focus(), 30);
  });
}

async function prompt(title, { label = '', value = '', placeholder = '', okText = t('common.ok'), iconName = 'edit' } = {}) {
  return openModal({
    title, iconName,
    body: `<div class="field"><label>${esc(label)}</label><input class="input" id="pv" value="${esc(value)}" placeholder="${esc(placeholder)}"></div>`,
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: okText, cls: 'primary', onClick: (m) => { const v = m.querySelector('#pv').value.trim(); if (!v) { m.querySelector('#pv').classList.add('invalid'); return false; } return v; } },
    ],
    onMount: (m) => { const i = m.querySelector('#pv'); setTimeout(() => i.select(), 40); },
  });
}

async function confirmBox(title, message, { okText = t('common.delete'), danger = true } = {}) {
  return openModal({
    title, iconName: danger ? 'trash' : 'check',
    body: `<div style="color:var(--text-2);line-height:1.5">${message}</div>`,
    buttons: [
      { label: t('common.giveUp'), value: false },
      { label: okText, cls: danger ? 'primary danger-primary' : 'primary', value: true },
    ],
  });
}

// --- Biçimlendirme (akış) ---------------------------------------------------------
function formatRate(bps, unit = 'bit') {
  if (bps == null || !Number.isFinite(bps)) return '—';
  let n = unit === 'byte' ? bps / 8 : bps;
  const u = unit === 'byte' ? ['B/s', 'KB/s', 'MB/s', 'GB/s'] : ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s'];
  const k = unit === 'byte' ? 1024 : 1000;
  let i = 0;
  while (n >= k && i < u.length - 1) { n /= k; i++; }
  return `\u2066${n < 10 && i ? n.toFixed(2) : n < 100 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}\u2069`;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  const h2 = Math.floor(s / 3600);
  return `${h2 ? p(h2) + ':' : ''}${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

// Çeviri varsa onu, yoksa yedeği döndürür (alan ipuçları gibi isteğe bağlı metinler için)
function tOpt(key, fallback = '') {
  const v = t(key);
  return v === key ? fallback : v;
}

// Akış hatasının kullanıcıya gösterilen metni
function streamError(err) {
  if (!err) return '';
  const base = tOpt(`err.${err.code}`, t('err.ffmpeg'));
  return err.detail && ['ffmpeg', 'error', 'bad_data', 'unsupported', 'io', 'tls'].includes(err.code) ? `${base} ${err.detail}`.trim() : base;
}

// Alt ve üst sınırı bilinen her sayısal alan kaydırıcıyla da değiştirilebilir: [kaydırıcı][sayı kutusu].
// Kutunun değeri kodla değişince (form.write) kaydırıcı da güncellenir.
function enhanceNumbers(root) {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  for (const num of root.querySelectorAll('input[type="number"][min][max]')) {
    if (num.dataset.slider || num.min === '' || num.max === '' || !(Number(num.max) > Number(num.min))) continue;
    num.dataset.slider = '1';
    const box = num.closest('.unit-wrap') || num;
    const wrap = document.createElement('div');
    wrap.className = 'num-slider';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = num.min; range.max = num.max; range.step = num.step || '1';
    range.tabIndex = -1;
    box.replaceWith(wrap);
    wrap.append(range, box);
    const pull = () => { range.value = num.value === '' ? range.min : desc.get.call(num); };
    pull();
    Object.defineProperty(num, 'value', { configurable: true, get() { return desc.get.call(this); }, set(v) { desc.set.call(this, v); pull(); } });
    num.addEventListener('input', pull);
    num.addEventListener('change', pull);
    const push = (type) => (e) => { e.stopPropagation(); desc.set.call(num, range.value); num.dispatchEvent(new Event(type, { bubbles: true })); };
    range.addEventListener('input', push('input'));
    range.addEventListener('change', push('change'));
  }
}
