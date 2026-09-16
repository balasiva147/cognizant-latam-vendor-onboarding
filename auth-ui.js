let authMode = 'login';
let invitedEmail = '';
function authLogin() {
  if (authMode === 'registered') {
    return `<div class="login"><section class="login-art"><div class="brand">Cognizant · LATAM vendor services</div><h1>Vendor onboarding, without the waiting.</h1><p>One workspace for SOA, Corporate Security, and invited vendors.</p></section><section class="login-form"><div class="login-box"><div role="status"><h2>Check your email</h2><p>Your registration request was received. Please check your email to complete the registration process.</p><p>Open the confirmation link sent to <strong>${esc(invitedEmail)}</strong>. If you cannot find it, check your spam folder.</p></div><p>Already registered? Sign in or reset your password.</p><button class="btn primary" data-auth="login">Back to sign in</button><button class="mini" data-auth="recover">Forgot password?</button></div></section></div>`;
  }
  const title = { login: 'Welcome back', register: 'Create account', recover: 'Reset password', password: 'Choose a new password' }[authMode];
  return `<div class="login"><section class="login-art"><div class="brand">Cognizant · LATAM vendor services</div><h1>Vendor onboarding, without the waiting.</h1><p>One workspace for SOA, Corporate Security, and invited vendors.</p></section><section class="login-form"><div class="login-box"><h2>${title}</h2><p>Use your invited vendor email or designated team email.</p><form id="loginForm">
    ${authMode === 'password' ? '' : `<div class="field"><label for="email">Email address</label><input id="email" type="email" required autocomplete="email" value="${esc(invitedEmail)}"></div>`}
    ${authMode === 'recover' ? '' : `<div class="field"><label for="password">Password</label><input id="password" type="password" required minlength="8" autocomplete="${authMode === 'login' ? 'current-password' : 'new-password'}"></div>`}
    ${['register', 'password'].includes(authMode) ? '<div class="field"><label for="confirmPassword">Confirm password</label><input id="confirmPassword" type="password" required minlength="8" autocomplete="new-password"></div>' : ''}
    <button class="btn primary">${{ login: 'Sign in', register: 'Register', recover: 'Send reset email', password: 'Save password' }[authMode]}</button></form><p id="authMessage" role="status"></p><button class="mini" data-auth="login">Sign in</button> <button class="mini" data-auth="register">Create account</button> <button class="mini" data-auth="recover">Forgot password?</button></div></section></div>`;
}
function bindAuth() {
  document.querySelectorAll('[data-auth]').forEach(b => b.onclick = () => { authMode = b.dataset.auth; render(); });
  document.getElementById('loginForm')?.addEventListener('submit', submitAuth);
  document.getElementById('logout')?.addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); state.role = null; state.user = null; state.tickets = []; state.mails = []; authMode = 'login'; render(); }
    catch (e) { toast(e.message); }
  });
}
async function enter(user) { state.role = user.role; state.user = user.email; await loadData(); render(); }
async function submitAuth(e) {
  e.preventDefault();
  const button = e.target.querySelector('button'); button.disabled = true;
  const email = document.getElementById('email')?.value || '';
  const password = document.getElementById('password')?.value || '';
  try {
    const confirm = document.getElementById('confirmPassword');
    if (confirm && confirm.value !== password) throw new Error('Passwords do not match.');
    const result = await api('/auth/' + authMode, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (authMode === 'login') await enter(result);
    else if (authMode === 'register') { invitedEmail = email.trim(); authMode = 'registered'; render(); }
    else { if (authMode === 'password') { authMode = 'login'; render(); } document.getElementById('authMessage').textContent = result.message; }
  } catch (error) { const message = document.getElementById('authMessage'); if (message) message.textContent = error.message; else toast(error.message); }
  finally { button.disabled = false; }
}
async function openFile(path) {
  const win = window.open('about:blank', '_blank'); if (win) win.opener = null;
  try {
    const r = await fetch(API + path, { credentials: 'include' });
    if (!r.ok) throw new Error('Unable to open document. Your session may have expired.');
    const data = await r.blob();
    const inline = ['application/pdf', 'image/png', 'image/jpeg'].includes(data.type);
    const url = URL.createObjectURL(inline ? data : new Blob([data], { type: 'application/octet-stream' }));
    if (inline && win) win.location = url;
    else { win?.close(); const link = document.createElement('a'); link.href = url; link.download = 'vendor-document'; link.click(); }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { win?.close(); toast(e.message); }
}
function authOutbox() {
  const m = modal(`<aside class="outbox"><div class="modal-head"><h3>Email notifications</h3><button class="close">×</button></div>${state.mails.map(x => `<article class="mail"><small>To: ${esc(x.to)} · ${esc(x.status)}</small><h4>${esc(x.subject)}</h4><p>${esc(x.body)}</p>${state.role === 'india_procurement' && ['FAILED', 'PENDING'].includes(x.status) ? `<button class="mini retryMail" data-id="${x.id}">Retry email</button>` : ''}</article>`).join('') || '<p>No notifications yet.</p>'}<button class="mini refreshMail">Refresh status</button></aside>`);
  m.querySelector('.refreshMail').onclick = async () => { try { await loadData(); m.remove(); authOutbox(); } catch (e) { toast(e.message); } };
  m.querySelectorAll('.retryMail').forEach(b => b.onclick = async () => { b.disabled = true; try { await api('/notifications/' + b.dataset.id + '/retry', { method: 'POST' }); toast('Email queued. Refresh status shortly.'); } catch (e) { toast(e.message); b.disabled = false; } });
}
async function bootAuth() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const access = hash.get('access_token'), refresh = hash.get('refresh_token'), type = hash.get('type');
  invitedEmail = hash.get('invite') || '';
  const error = hash.get('error_description');
  history.replaceState(null, '', location.pathname); render();
  try {
    if (access && refresh) {
      const user = await api('/auth/callback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: access, refresh_token: refresh }) });
      if (type === 'recovery' || type === 'invite') { authMode = 'password'; render(); } else await enter(user);
    } else {
      if (invitedEmail) { authMode = 'register'; render(); }
      try { await enter(await api('/auth/me')); } catch (_) { state.role = null; render(); }
      const config = await api('/auth/config');
      if (!config.configured) { const message = document.getElementById('authMessage'); if (message) message.textContent = 'Authentication setup is pending. Configure server/.env and restart the backend.'; }
    }
    if (error) toast(error);
  } catch (e) { state.role = null; render(); document.getElementById('authMessage').textContent = e.message; }
}
bootAuth();
