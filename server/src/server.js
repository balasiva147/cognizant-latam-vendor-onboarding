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
              d.rejection_reason,
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
      'SELECT id FROM ticket_documents WHERE id = ? FOR UPDATE',
      [req.params.documentId]
    );
    if (!documents.length) {
      await connection.rollback();
      fs.rmSync(req.file.path, { force: true });
      return res.status(404).json({ error: 'Requested document not found.' });
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
      `UPDATE ticket_documents SET status = 'UPLOADED', rejection_reason = NULL WHERE id = ?`,
      [req.params.documentId]
    );
    await connection.execute(
      `UPDATE onboarding_tickets t JOIN ticket_documents d ON d.ticket_id = t.id
       SET t.status = 'UNDER_REVIEW' WHERE d.id = ?`,
      [req.params.documentId]
    );
    await connection.commit();
    res.status(201).json({ uploadId: result.insertId, version, sha256: checksum });
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
  const { decision, note, reviewedByEmail } = req.body;
  if (!['APPROVED', 'REJECTED'].includes(decision) || !reviewedByEmail || (decision === 'REJECTED' && !note)) {
    return res.status(400).json({ error: 'A valid decision, reviewer, and rejection note when rejected are required.' });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [uploads] = await connection.execute(
      `SELECT id FROM document_uploads WHERE ticket_document_id = ?
       ORDER BY version_number DESC LIMIT 1`,
      [req.params.documentId]
    );
    if (!uploads.length) {
      await connection.rollback();
      return res.status(409).json({ error: 'No upload is available to review.' });
    }
    await connection.execute(
      `UPDATE ticket_documents SET status = ?, rejection_reason = ? WHERE id = ?`,
      [decision, decision === 'REJECTED' ? note : null, req.params.documentId]
    );
    await connection.execute(
      `INSERT INTO document_review_events
       (ticket_document_id, document_upload_id, decision, review_note, reviewed_by_email)
       VALUES (?, ?, ?, ?, ?)`,
      [req.params.documentId, uploads[0].id, decision, note || null, reviewedByEmail]
    );
    const [ticketRows] = await connection.execute(
      `SELECT t.id FROM onboarding_tickets t
       JOIN ticket_documents d ON d.ticket_id = t.id WHERE d.id = ?`,
      [req.params.documentId]
    );
    const ticketId = ticketRows[0].id;
    const [counts] = await connection.execute(
      `SELECT COUNT(*) total,
              SUM(status = 'APPROVED') approved,
              SUM(status = 'REJECTED') rejected
       FROM ticket_documents WHERE ticket_id = ?`,
      [ticketId]
    );
    const nextStatus = Number(counts[0].approved) === Number(counts[0].total)
      ? 'APPROVED' : Number(counts[0].rejected) > 0 ? 'CHANGES_REQUESTED' : 'UNDER_REVIEW';
    await connection.execute('UPDATE onboarding_tickets SET status = ? WHERE id = ?', [nextStatus, ticketId]);
    await connection.commit();
    res.json({ documentId: Number(req.params.documentId), decision, ticketStatus: nextStatus });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally { connection.release(); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File exceeds the ${process.env.MAX_UPLOAD_MB || 15} MB demo limit.` });
  }
  res.status(500).json({ error: error.message || 'Unexpected server error.' });
});

app.listen(port, () => console.log(`Vendor onboarding API listening on http://127.0.0.1:${port}`));
