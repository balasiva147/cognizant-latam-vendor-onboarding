const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mysql = require('mysql2/promise');
const { createTranslationService } = require('./translation');
const { createAuth } = require('./auth');
const { createMail } = require('./mail');
const { createWorkflow } = require('./workflow');
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
const mail = createMail({ pool });
const translationService = createTranslationService({ pool, uploadRoot, mail });
const auth = createAuth({ pool });

const allowedExtensions = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.doc', '.docx']);
const activeDocumentNames = new Set(['RFC Tax Certificate', 'Proof of Address']);
const countryDocumentNames = new Map([
  ['BR', new Set(['Proof of Address'])],
  ['MX', new Set(['RFC Tax Certificate', 'Proof of Address'])],
  ['CO', new Set(['Proof of Address'])],
  ['AR', new Set(['RFC Tax Certificate', 'Proof of Address'])],
  ['CL', new Set(['Proof of Address'])],
  ['PE', new Set(['RFC Tax Certificate', 'Proof of Address'])]
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter: (_req, file, done) => {
    const extension = path.extname(file.originalname).toLowerCase();
    done(allowedExtensions.has(extension) ? null : new Error('Unsupported file type'), allowedExtensions.has(extension));
  }
});

function safeFolderName(value) {
  const safe = String(value || 'vendor')
    .normalize('NFKD')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  return safe.slice(0, 100) || 'vendor';
}

function safeFileStem(value) {
  return safeFolderName(value).replace(/\s+/g, '-').toLowerCase();
}

async function renameRejectedUpload(connection, uploadRow) {
  if (!uploadRow?.storage_path || uploadRow.stored_file_name.includes('-rejected-v')) return;
  const extension = path.extname(uploadRow.stored_file_name);
  const stem = path.basename(uploadRow.stored_file_name, extension);
  const rejectedName = `${stem}-rejected-v${uploadRow.version_number}${extension}`;
  const oldPath = path.resolve(uploadRoot, uploadRow.storage_path);
  const newRelativePath = path.join(path.dirname(uploadRow.storage_path), rejectedName);
  const newPath = path.resolve(uploadRoot, newRelativePath);
  if (!oldPath.startsWith(`${uploadRoot}${path.sep}`) || !newPath.startsWith(`${uploadRoot}${path.sep}`)) {
    throw new Error('Invalid upload storage path.');
  }
  await fs.promises.rename(oldPath, newPath);
  await connection.execute(
    'UPDATE document_uploads SET stored_file_name = ?, storage_path = ? WHERE id = ?',
    [rejectedName, newRelativePath, uploadRow.id]
  );
}

const app = express();
app.use(cors({ origin: new URL(process.env.APP_BASE_URL || process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:8765').origin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use('/api', auth.guardOrigin);
auth.routes(app);

app.get('/api/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) { next(error); }
});

app.use('/api', auth.requireUser, auth.authorize);
app.post('/api/notifications/:notificationId/retry', async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT id FROM vendor_notifications WHERE id=?', [req.params.notificationId]);
    if (!rows.length) return res.status(404).json({ error: 'Notification not found.' });
    mail.queue(req.params.notificationId);
    res.status(202).json({ message: 'Email delivery queued.' });
  } catch (error) { next(error); }
});

app.post('/api/tickets', async (req, res, next) => {
  const { ticketNumber, vendorName, authorizedPersonName, vendorEmail, address, countryCode, language, documents } = req.body;
  if (![ticketNumber, vendorName, authorizedPersonName, vendorEmail, address, countryCode, language].every(value => String(value || '').trim()) || !Array.isArray(documents) || !documents.length) {
    return res.status(400).json({ error: 'Ticket, vendor legal name, owner or authorized person, email, address, country, language, and documents are required.' });
  }
  if (documents.some(documentName => !activeDocumentNames.has(documentName))) {
    return res.status(400).json({ error: 'Only RFC Tax Certificate and Proof of Address are available in this demo.' });
  }
  const countryDocuments = countryDocumentNames.get(String(countryCode).toUpperCase());
  if (!countryDocuments || documents.some(documentName => !countryDocuments.has(documentName))) {
    return res.status(400).json({ error: 'One or more documents are not configured for the selected country.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [vendorResult] = await connection.execute(
      'INSERT INTO vendors (legal_name, authorized_person_name, email, registered_address) VALUES (?, ?, ?, ?)',
      [vendorName.trim(), authorizedPersonName.trim(), vendorEmail.trim(), address.trim()]
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
    const [notification] = await connection.execute(
      `INSERT INTO vendor_notifications
       (ticket_id, vendor_id, notification_type, subject, message, rejected_documents)
       VALUES (?, ?, 'DOCUMENTS_REQUESTED', ?, ?, ?)`,
      [ticketResult.insertId, vendorResult.insertId,
        `Documents requested for ${ticketNumber}`,
        `Cognizant Indian SOA requested ${documents.length} documents. Sign in to upload them.`,
        JSON.stringify(documents.map(documentName => ({ documentName })))]
    );
    await connection.commit();
    mail.queue(notification.insertId);
    res.status(201).json({ id: ticketResult.insertId, ticketNumber });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally { connection.release(); }
});

app.get('/api/tickets', async (req, res, next) => {
  try {
    const parameters = [];
    const email = req.vendorEmail || req.query.email;
    const emailFilter = email ? 'WHERE LOWER(v.email) = LOWER(?)' : '';
    if (email) parameters.push(email);
    const [rows] = await pool.execute(
      `SELECT t.ticket_number, t.country_code, t.communication_language, t.status, t.workflow_stage,
              t.created_at, v.legal_name, v.authorized_person_name, v.email, v.registered_address,
              d.id AS document_id, d.document_name, d.status AS document_status,
              d.india_status, d.security_status, d.rejection_reason,
              u.id AS latest_upload_id, u.original_file_name, u.mime_type,
              u.size_bytes, u.version_number, u.uploaded_at,
              tr.id AS translation_id, tr.status AS translation_status,
              tr.target_language AS translation_target_language,
              tr.translated_file_name, tr.last_error AS translation_error,
              tr.completed_at AS translation_completed_at
       FROM onboarding_tickets t
       JOIN vendors v ON v.id = t.vendor_id
       JOIN ticket_documents d ON d.ticket_id = t.id
       LEFT JOIN document_uploads u ON u.id = (
         SELECT du.id FROM document_uploads du
         WHERE du.ticket_document_id = d.id
         ORDER BY du.version_number DESC LIMIT 1
       )
       LEFT JOIN document_translations tr
         ON tr.document_upload_id = u.id AND tr.target_language = ?
        AND d.status = 'LOCAL_PROCUREMENT_ACCEPTED'
       ${emailFilter}
       ORDER BY t.created_at DESC, d.id`,
      [translationService.targetLanguage, ...parameters]
    );
    const tickets = new Map();
    for (const row of rows) {
      if (!tickets.has(row.ticket_number)) {
        tickets.set(row.ticket_number, {
          ticketNumber: row.ticket_number,
          vendorName: row.legal_name,
          authorizedPersonName: row.authorized_person_name,
          vendorEmail: row.email,
          address: row.registered_address,
          countryCode: row.country_code,
          language: row.communication_language,
          status: row.status,
          workflowStage: row.workflow_stage,
          createdAt: row.created_at,
          documents: []
        });
      }
      tickets.get(row.ticket_number).documents.push({
        id: Number(row.document_id),
        name: row.document_name,
        status: row.document_status,
        indiaStatus: row.india_status, securityStatus: row.security_status,
        rejectionReason: row.rejection_reason,
        latestUploadId: row.latest_upload_id ? Number(row.latest_upload_id) : null,
        fileName: row.original_file_name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes ? Number(row.size_bytes) : null,
        version: row.version_number ? Number(row.version_number) : 0,
        uploadedAt: row.uploaded_at,
        translation: row.translation_id ? {
          id: Number(row.translation_id),
          status: row.translation_status,
          targetLanguage: row.translation_target_language,
          fileName: row.translated_file_name,
          error: row.translation_error,
          completedAt: row.translation_completed_at
        } : null
      });
    }
    const [events] = await pool.execute(`SELECT e.*, t.ticket_number FROM workflow_events e JOIN onboarding_tickets t ON t.id=e.ticket_id JOIN vendors v ON v.id=t.vendor_id ${emailFilter} ORDER BY e.id`, parameters);
    for (const ticket of tickets.values()) ticket.history = events.filter(e => e.ticket_number === ticket.ticketNumber);
    res.json([...tickets.values()]);
  } catch (error) { next(error); }
});

app.get('/api/tickets/:ticketNumber', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT t.id, t.ticket_number, t.country_code, t.communication_language, t.status, t.workflow_stage,
              v.legal_name, v.authorized_person_name, v.email, v.registered_address,
              d.id AS document_id, d.document_name, d.status AS document_status,
              d.india_status, d.security_status, d.rejection_reason, (d.status = 'INIT') AS can_upload,
              u.id AS latest_upload_id, u.original_file_name, u.mime_type,
              u.size_bytes, u.version_number, u.uploaded_at,
              tr.id AS translation_id, tr.status AS translation_status,
              tr.target_language AS translation_target_language,
              tr.translated_file_name, tr.last_error AS translation_error,
              tr.completed_at AS translation_completed_at
       FROM onboarding_tickets t
       JOIN vendors v ON v.id = t.vendor_id
       JOIN ticket_documents d ON d.ticket_id = t.id
       LEFT JOIN document_uploads u ON u.id = (
         SELECT du.id FROM document_uploads du
         WHERE du.ticket_document_id = d.id
         ORDER BY du.version_number DESC LIMIT 1
       )
       LEFT JOIN document_translations tr
         ON tr.document_upload_id = u.id AND tr.target_language = ?
        AND d.status = 'LOCAL_PROCUREMENT_ACCEPTED'
       WHERE t.ticket_number = ?
       ORDER BY d.id`,
      [translationService.targetLanguage, req.params.ticketNumber]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ticket not found.' });
    res.json(rows);
  } catch (error) { next(error); }
});

app.post('/api/ticket-documents/:documentId/upload', upload.single('document'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'A document file is required.' });
  const uploadedByEmail = req.user.email;
  if (!uploadedByEmail) return res.status(400).json({ error: 'uploadedByEmail is required.' });

  const connection = await pool.getConnection();
  let savedPath = null;
  try {
    const checksum = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    await connection.beginTransaction();
    const [locks] = await connection.execute('SELECT t.id,t.ticket_number,t.workflow_stage FROM onboarding_tickets t JOIN ticket_documents d ON d.ticket_id=t.id WHERE d.id=? FOR UPDATE', [req.params.documentId]);
    if (!locks.length || locks[0].workflow_stage !== 'VENDOR') { await connection.rollback(); return res.status(409).json({ error: 'This request is not currently awaiting a vendor upload.' }); }
    const [documents] = await connection.execute(
      `SELECT d.id, d.ticket_id, d.status, d.document_name,
              v.id AS vendor_id, v.legal_name
       FROM ticket_documents d
       JOIN onboarding_tickets t ON t.id = d.ticket_id
       JOIN vendors v ON v.id = t.vendor_id
       WHERE d.id = ? FOR UPDATE`,
      [req.params.documentId]
    );
    if (!documents.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Requested document not found.' });
    }
    if (documents[0].status !== 'INIT') {
      await connection.rollback();
      return res.status(409).json({ error: 'Only documents in INIT state can receive a new upload.' });
    }
    const [versions] = await connection.execute(
      'SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM document_uploads WHERE ticket_document_id = ?',
      [req.params.documentId]
    );
    const version = versions[0].next_version;
    const vendorFolder = `${documents[0].vendor_id}-${safeFolderName(documents[0].legal_name)}`;
    const originalsFolder = path.join(uploadRoot, vendorFolder, 'originals');
    await fs.promises.mkdir(originalsFolder, { recursive: true });
    const extension = path.extname(req.file.originalname).toLowerCase();
    const storedFileName = `${safeFileStem(documents[0].document_name)}-v${version}-${crypto.randomUUID()}${extension}`;
    const relativeStoragePath = path.join(vendorFolder, 'originals', storedFileName);
    savedPath = path.resolve(uploadRoot, relativeStoragePath);
    if (!savedPath.startsWith(`${uploadRoot}${path.sep}`)) throw new Error('Invalid upload destination.');
    await fs.promises.writeFile(savedPath, req.file.buffer, { flag: 'wx' });
    const [result] = await connection.execute(
      `INSERT INTO document_uploads
       (ticket_document_id, version_number, original_file_name, stored_file_name,
        storage_path, mime_type, size_bytes, sha256, uploaded_by_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.params.documentId, version, req.file.originalname, storedFileName,
        relativeStoragePath, req.file.mimetype || 'application/octet-stream', req.file.size,
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
    await connection.execute('UPDATE onboarding_tickets SET status = ?,workflow_stage=? WHERE id = ?', [ticketStatus, ticketStatus === 'DOCUMENTS_UPLOADED' ? 'LOCAL' : 'VENDOR', ticketId]);
    await connection.execute("INSERT INTO workflow_events (ticket_id,stage,action,actor_email,details) VALUES (?,'VENDOR','DOCUMENT_UPLOADED',?,?)", [ticketId, uploadedByEmail, JSON.stringify({ documentId: Number(req.params.documentId), version })]);
    if (ticketStatus === 'DOCUMENTS_UPLOADED') {
      await connection.execute("INSERT INTO workflow_events (ticket_id,stage,action,actor_email,details) VALUES (?,'VENDOR','LOCAL_SOA_NOTIFIED','system',?)", [ticketId, JSON.stringify({ recipient: process.env.PROCUREMENT_ADMIN_EMAIL || null })]);
    }
    await connection.commit();
    if (ticketStatus === 'DOCUMENTS_UPLOADED') {
      mail.queueTeam({
        to: process.env.PROCUREMENT_ADMIN_EMAIL,
        subject: `Documents ready for Local SOA review — ${locks[0].ticket_number}`,
        message: `The vendor uploaded all currently requested documents for ${locks[0].ticket_number}. The request is ready for Local SOA review.`
      });
    }
    res.status(201).json({ uploadId: result.insertId, version, sha256: checksum, ticketStatus });
  } catch (error) {
    await connection.rollback();
    if (savedPath) fs.rmSync(savedPath, { force: true });
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
    const safeTypes = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
    res.type(safeTypes[path.extname(rows[0].original_file_name).toLowerCase()] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox");
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].original_file_name)}`);
    res.sendFile(filePath);
  } catch (error) { next(error); }
});

app.get('/api/translations/:translationId', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT tr.translated_file_name, tr.storage_path, tr.mime_type
       FROM document_translations tr
       JOIN document_uploads u ON u.id=tr.document_upload_id
       JOIN ticket_documents d ON d.id=u.ticket_document_id
       WHERE tr.id = ? AND tr.status = 'COMPLETED'
         AND d.status = 'LOCAL_PROCUREMENT_ACCEPTED'
         AND u.id=(SELECT latest.id FROM document_uploads latest
                   WHERE latest.ticket_document_id=d.id
                   ORDER BY latest.version_number DESC LIMIT 1)`,
      [req.params.translationId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Completed translation not found.' });
    const filePath = path.resolve(uploadRoot, rows[0].storage_path);
    if (!filePath.startsWith(`${uploadRoot}${path.sep}`)) return res.status(400).json({ error: 'Invalid storage path.' });
    res.type(rows[0].mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].translated_file_name)}`);
    res.sendFile(filePath);
  } catch (error) { next(error); }
});

app.post('/api/tickets/:ticketNumber/translations/retry', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, status,workflow_stage FROM onboarding_tickets WHERE ticket_number = ?',
      [req.params.ticketNumber]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ticket not found.' });
    if (rows[0].workflow_stage !== 'TRANSLATION') {
      return res.status(409).json({ error: 'Translations can start only after all documents are approved.' });
    }
    translationService.queueTicket(rows[0].id, true);
    res.status(202).json({ ticketNumber: req.params.ticketNumber, translationQueued: true });
  } catch (error) { next(error); }
});

app.post('/api/ticket-documents/:documentId/review', async (req, res, next) => {
  return res.status(410).json({ error: 'Use Submit review on the ticket to save decisions together.' });
});

createWorkflow({ pool, mail, translationService, renameRejectedUpload }).routes(app);

app.get('/api/notifications', async (req, res, next) => {
  try {
    const parameters = [];
    const email = req.vendorEmail || req.query.email;
    const emailFilter = email ? 'WHERE LOWER(v.email) = LOWER(?)' : '';
    if (email) parameters.push(email);
    const [rows] = await pool.execute(
      `SELECT n.id, t.ticket_number, n.notification_type, n.subject, n.message,
              n.rejected_documents, n.delivery_status, n.created_at, n.sent_at, n.read_at,
              v.email AS vendor_email
       FROM vendor_notifications n
       JOIN vendors v ON v.id = n.vendor_id
       JOIN onboarding_tickets t ON t.id = n.ticket_id
       ${emailFilter}
       ORDER BY n.created_at DESC`,
      parameters
    );
    res.json(rows);
  } catch (error) { next(error); }
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
  console.error('Request failed:', error.code || error.name);
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File exceeds the ${process.env.MAX_UPLOAD_MB || 15} MB demo limit.` });
  }
  res.status(500).json({ error: 'Request failed. Check backend configuration and database availability.' });
});

translationService.resume().catch(error => console.error('Workflow recovery requires migration 006:', error.code || error.name));
app.listen(port, '127.0.0.1', () => console.log(`Vendor onboarding API listening on http://127.0.0.1:${port}`));
