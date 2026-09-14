const nodemailer = require('nodemailer');

function createMail({ pool, env = process.env, transportFactory = nodemailer.createTransport }) {
  const active = new Set();
  const configured = Boolean(env.SMTP_USER && env.SMTP_PASS);
  const transport = configured ? transportFactory({
    host: env.SMTP_HOST || 'smtp.gmail.com', port: Number(env.SMTP_PORT || 465),
    secure: env.SMTP_SECURE !== 'false', auth: { user: env.SMTP_USER, pass: env.SMTP_PASS.replace(/\s/g, '') },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000, dnsTimeout: 10000
  }) : null;
  async function deliver(id) {
    if (active.has(String(id))) return;
    active.add(String(id));
    try {
      const [rows] = await pool.execute('SELECT n.*, v.email FROM vendor_notifications n JOIN vendors v ON v.id=n.vendor_id WHERE n.id=?', [id]);
      const row = rows[0];
      if (!row || ['SENT', 'READ'].includes(row.delivery_status)) return;
      if (!transport) throw new Error('SMTP is not configured');
      const docs = typeof row.rejected_documents === 'string' ? JSON.parse(row.rejected_documents) : row.rejected_documents;
      const details = (docs || []).map(d => `- ${d.documentName}${d.rejectionText ? ': ' + d.rejectionText : ''}`).join('\n');
      const url = new URL(env.APP_BASE_URL || 'http://127.0.0.1:8765/');
      url.hash = 'invite=' + encodeURIComponent(row.email);
      await transport.sendMail({ from: env.SMTP_FROM || env.SMTP_USER, to: row.email, subject: row.subject,
        text: `${row.message}\n\n${details}\n\nRegister with this email address or sign in to view your request:\n${url.href}\n\nFor a new account, verify your email using the separate confirmation email before signing in.` });
      await pool.execute("UPDATE vendor_notifications SET delivery_status='SENT', sent_at=CURRENT_TIMESTAMP WHERE id=?", [id]);
    } catch (_) {
      await pool.execute("UPDATE vendor_notifications SET delivery_status='FAILED' WHERE id=?", [id]);
      console.error('Email delivery failed for notification', id, '(check SMTP settings and network connectivity).');
    } finally { active.delete(String(id)); }
  }
  function queue(id) { if (id) deliver(id).catch(() => console.error('Unable to persist notification delivery status')); }
  return { queue, deliver, transport };
}
module.exports = { createMail };
