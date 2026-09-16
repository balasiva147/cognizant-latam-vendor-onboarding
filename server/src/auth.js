const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const normalizeEmail = value => String(value || '').trim().toLowerCase();
function createAuth({ pool, env = process.env, clientFactory = createClient }) {
  const origin = new URL(env.APP_BASE_URL || 'http://127.0.0.1:8765/').origin;
  const redirectTo = `${origin}/`;
  const configured = Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY && env.PROCUREMENT_ADMIN_EMAIL);
  const client = () => {
    if (!configured) throw new Error('Configure Supabase and PROCUREMENT_ADMIN_EMAIL in server/.env, then restart the backend.');
    return clientFactory(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  };
  const sessions = new Map();
  const attempts = new Map();
  const cookieName = 'vendor_session';
  function sid(req) { return (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1); }
  function clear(req, res) { sessions.delete(sid(req)); res.clearCookie(cookieName, { path: '/api', sameSite: 'lax', httpOnly: true }); }
  const teamRoles = new Map();
  for (const [key, role] of [['PROCUREMENT_ADMIN_EMAIL','procurement'],['INDIA_PROCUREMENT_EMAIL','india_procurement'],['CORPORATE_SECURITY_EMAIL','corporate_security']]) {
    const email = normalizeEmail(env[key]);
    if (email) { if (teamRoles.has(email)) throw new Error('Each procurement/security team must use a distinct email.'); teamRoles.set(email, role); }
  }
  async function identity(user) {
    if (!user?.email_confirmed_at || !user.email) throw new Error('Verify your email before signing in.');
    const email = normalizeEmail(user.email);
    if (teamRoles.has(email)) return { id: user.id, email, role: teamRoles.get(email) };
    const [rows] = await pool.execute('SELECT id FROM vendors WHERE LOWER(email) = ? LIMIT 1', [email]);
    if (!rows.length) throw new Error('No vendor invitation exists for this email.');
    return { id: user.id, email, role: 'vendor' };
  }
  async function save(req, res, data) {
    const user = await identity(data.user);
    clear(req, res);
    const key = crypto.randomBytes(32).toString('hex');
    sessions.set(key, { access: data.session.access_token, refresh: data.session.refresh_token, expires: data.session.expires_at * 1000, deadline: Date.now() + 8 * 3600000 });
    res.cookie(cookieName, key, { httpOnly: true, sameSite: 'lax', secure: origin.startsWith('https:'), path: '/api', maxAge: 8 * 3600000 });
    return user;
  }
  async function requireUser(req, res, next) {
    try {
      const entry = sessions.get(sid(req));
      if (!entry || entry.deadline < Date.now()) { clear(req, res); return res.status(401).json({ error: 'Please sign in.' }); }
      const auth = client().auth;
      if (entry.expires < Date.now() + 30000) {
        if (!entry.refreshing) entry.refreshing = (async () => {
          const { data, error } = await auth.refreshSession({ refresh_token: entry.refresh });
          if (error) throw error;
          Object.assign(entry, { access: data.session.access_token, refresh: data.session.refresh_token, expires: data.session.expires_at * 1000 });
        })().finally(() => { entry.refreshing = null; });
        await entry.refreshing;
      }
      const { data, error } = await auth.getUser(entry.access);
      if (error) throw error;
      req.user = await identity(data.user);
      next();
    } catch (_) { clear(req, res); res.status(401).json({ error: 'Session expired or account unavailable. Please sign in again.' }); }
  }
  function guardOrigin(req, res, next) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== origin) return res.status(403).json({ error: 'Request origin is not allowed.' });
    next();
  }
  function limited(req, res, next) {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    const key = req.ip;
    const value = attempts.get(key) || { count: 0, until: now + 15 * 60000 };
    attempts.set(key, value);
    if (++value.count > 30) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    next();
  }
  function routes(app) {
    app.get('/api/auth/config', (_req, res) => res.json({ configured }));
    app.post('/api/auth/login', limited, async (req, res) => {
      try {
        const { data, error } = await client().auth.signInWithPassword({ email: normalizeEmail(req.body.email), password: req.body.password || '' });
        if (error) throw error;
        res.json(await save(req, res, data));
      } catch (error) { res.status(400).json({ error: configured ? 'Sign-in failed. Check your credentials and email verification.' : error.message }); }
    });
    app.post('/api/auth/register', limited, async (req, res) => {
      try {
        const email = normalizeEmail(req.body.email);
        if (typeof req.body.password !== 'string' || req.body.password.length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
        if (!teamRoles.has(email)) {
          const [rows] = await pool.execute('SELECT id FROM vendors WHERE LOWER(email) = ? LIMIT 1', [email]);
          if (!rows.length) return res.status(403).json({ error: 'Use the email address from your vendor invitation.' });
        }
        const { error } = await client().auth.signUp({ email, password: req.body.password, options: { emailRedirectTo: redirectTo } });
        if (error) throw error;
        res.json({ message: 'Check your email to confirm your account. If already registered, sign in or reset your password.' });
      } catch (error) { res.status(400).json({ error: configured ? 'Registration could not complete. Check email settings or try again later.' : error.message }); }
    });
    app.post('/api/auth/recover', limited, async (req, res) => {
      try {
        const { error } = await client().auth.resetPasswordForEmail(normalizeEmail(req.body.email), { redirectTo });
        if (error) throw error;
        res.json({ message: 'If the account exists, a password-reset email will arrive shortly.' });
      } catch (_) { res.status(400).json({ error: 'Unable to request password reset. Check email configuration.' }); }
    });
    app.post('/api/auth/callback', limited, async (req, res) => {
      try {
        const { data, error } = await client().auth.setSession({ access_token: req.body.access_token, refresh_token: req.body.refresh_token });
        if (error) throw error;
        res.json(await save(req, res, data));
      } catch (_) { res.status(400).json({ error: 'This verification link is invalid or expired. Please sign in or request another reset.' }); }
    });
    app.post('/api/auth/password', requireUser, async (req, res) => {
      try {
        if (typeof req.body.password !== 'string' || req.body.password.length < 8) return res.status(400).json({ error: 'Use at least 8 characters.' });
        const entry = sessions.get(sid(req));
        const auth = client().auth;
        const sessionResult = await auth.setSession({ access_token: entry.access, refresh_token: entry.refresh });
        if (sessionResult.error) throw sessionResult.error;
        const { error } = await auth.updateUser({ password: req.body.password });
        if (error) throw error;
        clear(req, res);
        res.json({ message: 'Password saved. Sign in with your new password.' });
      } catch (_) { res.status(400).json({ error: 'Password could not be updated. Request a new reset link.' }); }
    });
    app.post('/api/auth/logout', (req, res) => { clear(req, res); res.json({ ok: true }); });
    app.get('/api/auth/me', requireUser, (req, res) => res.json(req.user));
  }
  async function authorize(req, res, next) {
    try {
      if (req.user.role === 'procurement') {
        if (/^\/ticket-documents\/[^/]+\/upload$/.test(req.path)) return res.status(403).json({ error: 'Only the vendor can upload documents.' });
        if (req.method === 'POST' && req.path === '/tickets') return res.status(403).json({ error: 'Only Indian SOA can create vendor document requests.' });
        if (req.body) req.body.reviewedByEmail = req.user.email;
        return next();
      }
      if (['india_procurement','corporate_security'].includes(req.user.role)) {
        const read = req.method === 'GET' && (/^\/tickets(?:\/[^/]+)?$/.test(req.path) || /^\/(uploads|translations)\/\d+$/.test(req.path) || req.path === '/notifications');
        const review = req.method === 'POST' && /^\/tickets\/[^/]+\/review$/.test(req.path);
        const indianSOAAction = req.user.role === 'india_procurement' && req.method === 'POST' && (req.path === '/tickets' || /^\/notifications\/\d+\/retry$/.test(req.path));
        if (!read && !review && !indianSOAAction) return res.status(403).json({ error: 'This action is not available for your team.' });
        if (req.body) req.body.reviewedByEmail = req.user.email;
        return next();
      }
      const path = req.path;
      if (req.method === 'GET' && ['/tickets', '/notifications'].includes(path)) { req.vendorEmail = req.user.email; return next(); }
      let sql, value;
      let match;
      const base = 'SELECT v.email FROM vendors v JOIN onboarding_tickets t ON t.vendor_id=v.id ';
      if (req.method === 'GET' && (match = path.match(/^\/tickets\/([^/]+)$/))) { sql = base + 'WHERE t.ticket_number=?'; value = decodeURIComponent(match[1]); }
      else if (req.method === 'POST' && (match = path.match(/^\/ticket-documents\/(\d+)\/upload$/))) { sql = base + 'JOIN ticket_documents d ON d.ticket_id=t.id WHERE d.id=?'; value = match[1]; }
      else if (req.method === 'GET' && (match = path.match(/^\/uploads\/(\d+)$/))) { sql = base + 'JOIN ticket_documents d ON d.ticket_id=t.id JOIN document_uploads u ON u.ticket_document_id=d.id WHERE u.id=?'; value = match[1]; }
      else if (req.method === 'GET' && (match = path.match(/^\/translations\/(\d+)$/))) { sql = base + 'JOIN ticket_documents d ON d.ticket_id=t.id JOIN document_uploads u ON u.ticket_document_id=d.id JOIN document_translations tr ON tr.document_upload_id=u.id WHERE tr.id=?'; value = match[1]; }
      else if (req.method === 'GET' && (match = path.match(/^\/vendors\/([^/]+)\/notifications$/))) {
        return normalizeEmail(decodeURIComponent(match[1])) === req.user.email ? next() : res.status(403).json({ error: 'Access denied.' });
      } else return res.status(403).json({ error: 'Procurement access required.' });
      const [rows] = await pool.execute(sql, [value]);
      if (!rows.length || normalizeEmail(rows[0].email) !== req.user.email) return res.status(404).json({ error: 'Resource not found.' });
      next();
    } catch (error) { next(error); }
  }
  const cleanup = setInterval(() => { for (const [key, entry] of sessions) if (entry.deadline < Date.now()) sessions.delete(key); }, 60000);
  cleanup.unref();
  return { routes, requireUser, authorize, guardOrigin };
}
module.exports = { createAuth, normalizeEmail };
