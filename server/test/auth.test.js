const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAuth } = require('../src/auth');
const { createMail } = require('../src/mail');
const http = require('node:http');
const { handler } = require('../../start-frontend');
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'test', PROCUREMENT_ADMIN_EMAIL: 'admin@example.test' };
const origin = 'http://127.0.0.1:8765';

test('verified sessions, logout, origin validation, and rejection of unverified accounts', async t => {
  const user = { id: 'test-id', email: 'admin@example.test', email_confirmed_at: '2026-01-01' };
  const auth = createAuth({ pool: {}, env, clientFactory: () => ({ auth: {
    signInWithPassword: async () => ({ data: { user, session: { access_token: 'valid', refresh_token: 'refresh', expires_at: Date.now() / 1000 + 3600 } } }),
    getUser: async () => ({ data: { user } })
  } }) });
  const app = express(); app.use(express.json()); app.use('/api', auth.guardOrigin); auth.routes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port + '/api/auth';
  const post = (path, cookie) => fetch(base + path, { method: 'POST', headers: { origin, 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ email: user.email, password: 'not-a-real-password' }) });
  assert.equal((await fetch(base + '/me')).status, 401);
  assert.equal((await fetch(base + '/login', { method: 'POST' })).status, 403);
  const login = await post('/login'); assert.equal(login.status, 200);
  assert.equal((await login.json()).role, 'procurement');
  const cookieHeader = login.headers.get('set-cookie'); assert.match(cookieHeader, /HttpOnly/);
  const cookie = cookieHeader.match(/vendor_session=[a-f0-9]+/)[0];
  assert.equal((await fetch(base + '/me', { headers: { cookie } })).status, 200);
  await post('/logout', cookie);
  assert.equal((await fetch(base + '/me', { headers: { cookie } })).status, 401);
  user.email_confirmed_at = null;
  assert.equal((await post('/login')).status, 400);
});

test('vendors cannot read another vendor resources, forge filters, or review documents', async () => {
  const auth = createAuth({ pool: { execute: async () => [[{ email: 'other@example.test' }]] }, env });
  for (const path of ['/tickets/TICKET', '/uploads/1', '/translations/1', '/ticket-documents/1/upload']) {
    let status;
    await auth.authorize({ path, method: path.endsWith('upload') ? 'POST' : 'GET', user: { role: 'vendor', email: 'vendor@example.test' } }, { status(n) { status = n; return this; }, json() {} }, () => assert.fail('Access must be denied'));
    assert.equal(status, 404);
  }
  let status;
  await auth.authorize({ path: '/tickets/TICKET/review', method: 'POST', user: { role: 'vendor', email: 'vendor@example.test' } }, { status(n) { status = n; return this; }, json() {} }, () => assert.fail());
  assert.equal(status, 403);
  const req = { path: '/tickets', method: 'GET', query: { email: 'other@example.test' }, user: { role: 'vendor', email: 'vendor@example.test' } };
  await auth.authorize(req, {}, () => {});
  assert.equal(req.vendorEmail, 'vendor@example.test');
});

test('missing SMTP records FAILED instead of claiming an email was sent', async () => {
  const writes = [];
  const mail = createMail({ env: {}, pool: { execute: async (sql, params) => {
    if (sql.startsWith('SELECT')) return [[{ id: 1, delivery_status: 'PENDING', email: 'test@example.test' }]];
    writes.push([sql, params]); return [];
  } } });
  await mail.deliver(1);
  assert.match(writes[0][0], /FAILED/);
});

test('email includes each rejection reason and marks SMTP acceptance as SENT', async () => {
  let sent, updated;
  const mail = createMail({ env: { SMTP_USER: 'sender@example.test', SMTP_PASS: 'test' }, transportFactory: () => ({ sendMail: async message => { sent = message; } }), pool: { execute: async sql => {
    if (sql.startsWith('SELECT')) return [[{ email: 'vendor@example.test', delivery_status: 'PENDING', subject: 'Correct documents', message: 'Upload replacements', rejected_documents: [{ documentName: 'Tax certificate', rejectionText: 'Expired' }, { documentName: 'Address', rejectionText: 'Unreadable' }] }]];
    updated = sql; return [];
  } } });
  await mail.deliver(2);
  assert.equal(sent.to, 'vendor@example.test');
  assert.match(sent.text, /Tax certificate: Expired/);
  assert.match(sent.text, /Address: Unreadable/);
  assert.match(sent.text, /#invite=vendor%40example.test/);
  assert.match(updated, /delivery_status='SENT'/);
});

test('frontend server never serves repository secrets, uploads, or traversal paths', async t => {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/auth-ui.js')).status, 200);
  for (const path of ['/server/.env', '/server/uploads/document.pdf', '/.git/config', '/%2e%2e/server/.env']) assert.equal((await fetch(base + path)).status, 404);
});
