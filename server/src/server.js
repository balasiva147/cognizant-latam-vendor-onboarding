const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const port = Number(process.env.PORT || 3000);
const uploadRoot = path.resolve(__dirname, '..', 'uploads');
const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 15) * 1024 * 1024;
fs.mkdirSync(uploadRoot, { recursive: true });

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'vendor_onboarding',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true
});

const allowedExtensions = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.doc', '.docx']);
const storage = multer.diskStorage({
  destination: uploadRoot,
  filename: (_req, file, done) => {
    const extension = path.extname(file.originalname).toLowerCase();
    done(null, `${crypto.randomUUID()}${extension}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter: (_req, file, done) => {
    const extension = path.extname(file.originalname).toLowerCase();
    done(allowedExtensions.has(extension) ? null : new Error('Unsupported file type'), allowedExtensions.has(extension));
  }
});

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:8765' }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) { next(error); }
});

app.post('/api/tickets', async (req, res, next) => {
  const { ticketNumber, vendorName, vendorEmail, address, countryCode, language, documents } = req.body;
  if (![ticketNumber, vendorName, vendorEmail, address, countryCode, language].every(Boolean) || !Array.isArray(documents) || !documents.length) {
    return res.status(400).json({ error: 'Ticket, vendor, country, language, and documents are required.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [vendorResult] = await connection.execute(
      'INSERT INTO vendors (legal_name, email, registered_address) VALUES (?, ?, ?)',
      [vendorName, vendorEmail, address]
    );
    const [ticketResult] = await connection.execute(
      `INSERT INTO onboarding_tickets
       (ticket_number, vendor_id, country_code, communication_language)
       VALUES (?, ?, ?, ?)`,
      [ticketNumber, vendorResult.insertId, String(countryCode).toUpperCase(), language]
    );
    for (const documentName of documents) {
      await connection.execute(
        'INSERT INTO ticket_documents (ticket_id, document_name) VALUES (?, ?)',
        [ticketResult.insertId, documentName]
      );
    }
    await connection.commit();
    res.status(201).json({ id: ticketResult.insertId, ticketNumber });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally { connection.release(); }
});

app.get('/api/tickets/:ticketNumber', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT t.id, t.ticket_number, t.country_code, t.communication_language, t.status,
              v.legal_name, v.email, v.registered_address,
              d.id AS document_id, d.document_name, d.status AS document_status,
              d.rejection_reason, (d.status = 'INIT') AS can_upload,
              u.id AS latest_upload_id, u.original_file_name, u.mime_type,
              u.size_bytes, u.version_number, u.uploaded_at
       FROM onboarding_tickets t
       JOIN vendors v ON v.id = t.vendor_id
       JOIN ticket_documents d ON d.ticket_id = t.id
       LEFT JOIN document_uploads u ON u.id = (
         SELECT du.id FROM document_uploads du
         WHERE du.ticket_document_id = d.id
         ORDER BY du.version_number DESC LIMIT 1
       )
       WHERE t.ticket_number = ?
       ORDER BY d.id`,
      [req.params.ticketNumber]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ticket not found.' });
    res.json(rows);
  } catch (error) { next(error); }
});

app.post('/api/ticket-documents/:documentId/upload', upload.single('document'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'A document file is required.' });
  const uploadedByEmail = req.body.uploadedByEmail;
  if (!uploadedByEmail) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: 'uploadedByEmail is required.' });
  }

  const connection = await pool.getConnection();
  try {
    const bytes = await fs.promises.readFile(req.file.path);
    const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
    await connection.beginTransaction();
    const [documents] = await connection.execute(
      'SELECT id, ticket_id, status FROM ticket_documents WHERE id = ? FOR UPDATE',
      [req.params.documentId]
    );
    if (!documents.length) {
      await connection.rollback();
      fs.rmSync(req.file.path, { force: true });
      return res.status(404).json({ error: 'Requested document not found.' });
    }
    if (documents[0].status !== 'INIT') {
      await connection.rollback();
      fs.rmSync(req.file.path, { force: true });
      return res.status(409).json({ error: 'Only documents in INIT state can receive a new upload.' });
    }
    const [versions] = await connection.execute(
      'SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM document_uploads WHERE ticket_document_id = ?',
      [req.params.documentId]
    );
    const version = versions[0].next_version;
    const [result] = await connection.execute(
      `INSERT INTO document_uploads
       (ticket_document_id, version_number, original_file_name, stored_file_name,
        storage_path, mime_type, size_bytes, sha256, uploaded_by_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.params.documentId, version, req.file.originalname, req.file.filename,
        req.file.filename, req.file.mimetype || 'application/octet-stream', req.file.size,
        checksum, uploadedByEmail]
    );
    await connection.execute(
      `UPDATE ticket_documents SET status = 'DOCUMENTS_UPLOADED', rejection_reason = NULL WHERE id = ?`,
      [req.params.documentId]
    );
    const ticketId = documents[0].ticket_id;
    const [counts] = await connection.execute(
      `SELECT COUNT(*) AS total,
              SUM(status IN ('DOCUMENTS_UPLOADED','LOCAL_PROCUREMENT_ACCEPTED')) AS ready
       FROM ticket_documents WHERE ticket_id = ?`,
      [ticketId]
    );
    const ticketStatus = Number(counts[0].ready) === Number(counts[0].total)
      ? 'DOCUMENTS_UPLOADED' : 'INIT';
    await connection.execute('UPDATE onboarding_tickets SET status = ? WHERE id = ?', [ticketStatus, ticketId]);
    await connection.commit();
    res.status(201).json({ uploadId: result.insertId, version, sha256: checksum, ticketStatus });
  } catch (error) {
    await connection.rollback();
    fs.rmSync(req.file.path, { force: true });
    next(error);
  } finally { connection.release(); }
});

app.get('/api/uploads/:uploadId', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      'SELECT original_file_name, storage_path, mime_type FROM document_uploads WHERE id = ?',
      [req.params.uploadId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Upload not found.' });
    const filePath = path.resolve(uploadRoot, rows[0].storage_path);
    if (!filePath.startsWith(`${uploadRoot}${path.sep}`)) return res.status(400).json({ error: 'Invalid storage path.' });
    res.type(rows[0].mime_type);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].original_file_name)}`);
    res.sendFile(filePath);
  } catch (error) { next(error); }
});

app.post('/api/ticket-documents/:documentId/review', async (req, res, next) => {
  const { note, reviewedByEmail } = req.body;
  const decision = req.body.decision === 'APPROVED'
    ? 'LOCAL_PROCUREMENT_ACCEPTED' : req.body.decision;
  if (!['LOCAL_PROCUREMENT_ACCEPTED', 'REJECTED'].includes(decision) || !reviewedByEmail || (decision === 'REJECTED' && !note)) {
    return res.status(400).json({ error: 'A valid decision, reviewer, and rejection note when rejected are required.' });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [uploads] = await connection.execute(
      `SELECT u.id FROM document_uploads u
       JOIN ticket_documents d ON d.id = u.ticket_document_id
       WHERE u.ticket_document_id = ? AND d.status = 'DOCUMENTS_UPLOADED'
       ORDER BY u.version_number DESC LIMIT 1`,
      [req.params.documentId]
    );
    if (!uploads.length) {
      await connection.rollback();
      return res.status(409).json({ error: 'No unreviewed upload is available.' });
    }
    await connection.execute(
      `UPDATE ticket_documents SET status = ?, rejection_reason = ? WHERE id = ?`,
      [decision === 'REJECTED' ? 'INIT' : 'LOCAL_PROCUREMENT_ACCEPTED', decision === 'REJECTED' ? note : null, req.params.documentId]
    );
    await connection.execute(
      `INSERT INTO document_review_events
       (ticket_document_id, document_upload_id, decision, review_note, reviewed_by_email)
       VALUES (?, ?, ?, ?, ?)`,
      [req.params.documentId, uploads[0].id, decision, note || null, reviewedByEmail]
    );
    const [ticketRows] = await connection.execute(
      `SELECT t.id, t.ticket_number, t.vendor_id FROM onboarding_tickets t
       JOIN ticket_documents d ON d.ticket_id = t.id WHERE d.id = ?`,
      [req.params.documentId]
    );
    const ticketId = ticketRows[0].id;
    const [counts] = await connection.execute(
      `SELECT COUNT(*) total,
              SUM(status = 'LOCAL_PROCUREMENT_ACCEPTED') accepted,
              SUM(status = 'INIT') init_count
       FROM ticket_documents WHERE ticket_id = ?`,
      [ticketId]
    );
    const nextStatus = Number(counts[0].accepted) === Number(counts[0].total)
      ? 'LOCAL_PROCUREMENT_ACCEPTED'
      : Number(counts[0].init_count) > 0 ? 'INIT' : 'DOCUMENTS_UPLOADED';
    await connection.execute('UPDATE onboarding_tickets SET status = ? WHERE id = ?', [nextStatus, ticketId]);
    if (decision === 'REJECTED') {
      const [documentRows] = await connection.execute(
        'SELECT document_name FROM ticket_documents WHERE id = ?',
        [req.params.documentId]
      );
      const rejectedDocuments = [{
        documentId: Number(req.params.documentId),
        documentName: documentRows[0].document_name,
        rejectionText: note
      }];
      await connection.execute(
        `INSERT INTO vendor_notifications
         (ticket_id, vendor_id, notification_type, subject, message, rejected_documents)
         VALUES (?, ?, 'DOCUMENTS_REJECTED', ?, ?, ?)`,
        [ticketId, ticketRows[0].vendor_id,
          `Documents rejected for ${ticketRows[0].ticket_number}`,
          'Local Procurement requested corrected documents. Sign in to review the comments and upload new versions.',
          JSON.stringify(rejectedDocuments)]
      );
    }
    await connection.commit();
    res.json({ documentId: Number(req.params.documentId), decision, ticketStatus: nextStatus });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally { connection.release(); }
});

app.post('/api/tickets/:ticketNumber/review', async (req, res, next) => {
  const { decisions, reviewedByEmail } = req.body;
  if (!reviewedByEmail || !Array.isArray(decisions) || !decisions.length) {
    return res.status(400).json({ error: 'Reviewer and at least one document decision are required.' });
  }
  const normalized = decisions.map(item => ({
    documentId: Number(item.documentId),
    decision: item.decision === 'APPROVED' ? 'LOCAL_PROCUREMENT_ACCEPTED' : item.decision,
    note: String(item.note || '').trim()
  }));
  if (new Set(normalized.map(item => item.documentId)).size !== normalized.length ||
      normalized.some(item => !Number.isInteger(item.documentId) ||
        !['LOCAL_PROCUREMENT_ACCEPTED', 'REJECTED'].includes(item.decision) ||
        (item.decision === 'REJECTED' && !item.note))) {
    return res.status(400).json({ error: 'Each document needs one valid decision and rejected documents need text.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [tickets] = await connection.execute(
      `SELECT id, vendor_id, ticket_number FROM onboarding_tickets
       WHERE ticket_number = ? FOR UPDATE`,
      [req.params.ticketNumber]
    );
    if (!tickets.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Ticket not found.' });
    }
    const ticket = tickets[0];
    const [documents] = await connection.execute(
      `SELECT d.id, d.document_name, d.status,
              (SELECT u.id FROM document_uploads u
               WHERE u.ticket_document_id = d.id
               ORDER BY u.version_number DESC LIMIT 1) AS latest_upload_id
       FROM ticket_documents d WHERE d.ticket_id = ? FOR UPDATE`,
      [ticket.id]
    );
    const byId = new Map(documents.map(document => [Number(document.id), document]));
    const rejectedDocuments = [];

    for (const item of normalized) {
      const document = byId.get(item.documentId);
      if (!document) {
        await connection.rollback();
        return res.status(400).json({ error: `Document ${item.documentId} does not belong to this ticket.` });
      }
      if (document.status !== 'DOCUMENTS_UPLOADED' || !document.latest_upload_id) {
        await connection.rollback();
        return res.status(409).json({ error: `${document.document_name} has no unreviewed upload.` });
      }
      const documentStatus = item.decision === 'REJECTED' ? 'INIT' : 'LOCAL_PROCUREMENT_ACCEPTED';
      await connection.execute(
        'UPDATE ticket_documents SET status = ?, rejection_reason = ? WHERE id = ?',
        [documentStatus, item.decision === 'REJECTED' ? item.note : null, item.documentId]
      );
      await connection.execute(
        `INSERT INTO document_review_events
         (ticket_document_id, document_upload_id, decision, review_note, reviewed_by_email)
         VALUES (?, ?, ?, ?, ?)`,
        [item.documentId, document.latest_upload_id, item.decision, item.note || null, reviewedByEmail]
      );
      if (item.decision === 'REJECTED') {
        rejectedDocuments.push({
          documentId: item.documentId,
          documentName: document.document_name,
          rejectionText: item.note
        });
      }
    }

    const [counts] = await connection.execute(
      `SELECT COUNT(*) total,
              SUM(status = 'LOCAL_PROCUREMENT_ACCEPTED') accepted,
              SUM(status = 'INIT') init_count
       FROM ticket_documents WHERE ticket_id = ?`,
      [ticket.id]
    );
    const ticketStatus = Number(counts[0].accepted) === Number(counts[0].total)
      ? 'LOCAL_PROCUREMENT_ACCEPTED'
      : Number(counts[0].init_count) > 0 ? 'INIT' : 'DOCUMENTS_UPLOADED';
    await connection.execute(
      'UPDATE onboarding_tickets SET status = ? WHERE id = ?',
      [ticketStatus, ticket.id]
    );

    let notificationId = null;
    if (rejectedDocuments.length) {
      const names = rejectedDocuments.map(document => document.documentName).join(', ');
      const [notification] = await connection.execute(
        `INSERT INTO vendor_notifications
         (ticket_id, vendor_id, notification_type, subject, message, rejected_documents)
         VALUES (?, ?, 'DOCUMENTS_REJECTED', ?, ?, ?)`,
        [ticket.id, ticket.vendor_id,
          `Documents rejected for ${ticket.ticket_number}`,
          `Local Procurement rejected: ${names}. Sign in to view comments and upload corrected versions.`,
          JSON.stringify(rejectedDocuments)]
      );
      notificationId = notification.insertId;
    }

    await connection.commit();
    res.json({
      ticketNumber: ticket.ticket_number,
      ticketStatus,
      rejectedDocuments,
      notificationId
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally { connection.release(); }
});

app.get('/api/vendors/:email/notifications', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT n.id, t.ticket_number, n.notification_type, n.subject, n.message,
              n.rejected_documents, n.delivery_status, n.created_at, n.sent_at, n.read_at
       FROM vendor_notifications n
       JOIN vendors v ON v.id = n.vendor_id
       JOIN onboarding_tickets t ON t.id = n.ticket_id
       WHERE v.email = ?
       ORDER BY n.created_at DESC`,
      [req.params.email]
    );
    res.json(rows);
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File exceeds the ${process.env.MAX_UPLOAD_MB || 15} MB demo limit.` });
  }
  res.status(500).json({ error: error.message || 'Unexpected server error.' });
});

app.listen(port, () => console.log(`Vendor onboarding API listening on http://127.0.0.1:${port}`));
