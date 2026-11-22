'use strict';

// Giriş ekranı: uygulama hesap girişi olmadan açılmaz.

const $ = (s) => document.querySelector(s);

document.body.appendChild(mastertoolButton()).classList.add('login-mt'); // sağ üst köşe

$('#subtitle').textContent = t('auth.subtitle');
$('#lEmail').textContent = t('auth.email');
$('#lPassword').textContent = t('auth.password');
$('#lRemember').textContent = t('auth.remember');
$('#forgot').textContent = t('auth.forgot');
$('#noAccount').textContent = t('auth.noAccount');
$('#register').textContent = t('auth.register');
$('#submit').textContent = t('auth.submit');
$('#eye').innerHTML = icon('eye');
$('#eye').title = t('common.show');

for (const [code, l] of Object.entries(I18N.LANGUAGES)) {
  $('#lang').appendChild(h(`<option value="${code}" ${code === LANG ? 'selected' : ''}>${esc(l.name)}</option>`));
}
$('#lang').onchange = (e) => window.api.setSettings({ language: e.target.value }); // ana süreç bu pencereyi yeniden yükler

$('#eye').onclick = () => {
  const p = $('#password');
  p.type = p.type === 'password' ? 'text' : 'password';
  $('#eye').innerHTML = icon(p.type === 'password' ? 'eye' : 'eyeOff');
};
$('#forgot').onclick = (e) => { e.preventDefault(); window.api.openWeb('forgot'); };
$('#register').onclick = (e) => { e.preventDefault(); window.api.openWeb('register'); };

const ERRORS = {
  bad_credentials: 'auth.errBadCredentials',
  unverified: 'auth.errUnverified',
  suspended: 'auth.errSuspended',
  rate_limited: 'auth.errRateLimited',
  offline: 'auth.errOffline',
  session_expired: 'auth.errSessionExpired',
  app_disabled: 'auth.errAppDisabled',
  wrong_app: 'auth.errWrongApp',
};

function showError(msg) {
  $('#error').textContent = msg;
  $('#error').classList.toggle('hidden', !msg);
}

window.api.accountState().then((st) => {
  $('#ver').textContent = `v${st.appVersion}`;
  if (st.email) $('#email').value = st.email;
  if (st.notice) { $('#notice').textContent = st.notice; $('#notice').classList.remove('hidden'); }
  (st.email ? $('#password') : $('#email')).focus();
});

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#email').value.trim();
  const password = $('#password').value;
  $('#email').classList.toggle('invalid', !email);
  $('#password').classList.toggle('invalid', !password);
  if (!email || !password) return showError(t('auth.errRequired'));

  showError('');
  const btn = $('#submit');
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${esc(t('auth.working'))}`;
  const res = await window.api.login(email, password, $('#remember').checked);
  if (res.ok) return; // ana süreç bu pencereyi kapatıp ana pencereyi açar
  btn.disabled = false;
  btn.textContent = t('auth.submit');
  showError(ERRORS[res.code] ? t(ERRORS[res.code]) : t('auth.errServer', { msg: res.message || res.code }));
  if (res.code === 'bad_credentials') { $('#password').select(); }
});
