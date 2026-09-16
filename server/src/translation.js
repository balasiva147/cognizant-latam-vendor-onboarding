const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const pdfParse = require('pdf-parse');

function safeFileStem(value) {
  return String(value || 'document').normalize('NFKD')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '').toLowerCase().slice(0, 120) || 'document';
}

function splitText(text, maximumCharacters) {
  const paragraphs = text.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  function addPiece(piece) {
    if (!piece) return;
    if (!current) current = piece;
    else if (current.length + piece.length + 2 <= maximumCharacters) current += `\n\n${piece}`;
    else { chunks.push(current); current = piece; }
  }
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maximumCharacters) { addPiece(paragraph); continue; }
    const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [paragraph];
    for (const sentence of sentences) {
      let remaining = sentence.trim();
      while (remaining.length > maximumCharacters) {
        let boundary = remaining.lastIndexOf(' ', maximumCharacters);
        if (boundary < maximumCharacters / 2) boundary = maximumCharacters;
        addPiece(remaining.slice(0, boundary).trim());
        remaining = remaining.slice(boundary).trim();
      }
      addPiece(remaining);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function sourceLanguageFor(job) {
  const communicationLanguage = String(job.communication_language || '').toLowerCase();
  if (job.country_code === 'BR' || communicationLanguage.includes('portugu')) return 'pt-BR';
  if (communicationLanguage.includes('espa') || communicationLanguage.includes('spanish')) return 'es';
  return 'auto';
}

async function readProviderError(response) {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body);
    return parsed.error || parsed.message || parsed.detail || body;
  } catch (_error) {
    return body || `${response.status} ${response.statusText}`;
  }
}

function createEnglishPdf({ documentName, originalFileName, translatedText }) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margins: { top: 54, bottom: 54, left: 54, right: 54 } });
    const buffers = [];
    pdf.on('data', chunk => buffers.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(buffers)));
    pdf.on('error', reject);
    pdf.info.Title = `${documentName} - English translation`;
    pdf.info.Subject = `Demo translation generated from ${originalFileName}`;
    pdf.font('Helvetica-Bold').fontSize(18).fillColor('#12336b').text('English Translation');
    pdf.moveDown(0.45);
    pdf.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text(documentName);
    pdf.font('Helvetica').fontSize(9).fillColor('#64748b').text(`Source file: ${originalFileName}`);
    pdf.moveDown(0.8);
    pdf.font('Helvetica-Oblique').fontSize(9).fillColor('#64748b')
      .text('Demo-generated translation. Refer to the original document for authoritative content.');
    pdf.moveDown(1);
    pdf.font('Helvetica').fontSize(11).fillColor('#111827').text(translatedText, { align: 'left', lineGap: 3 });
    pdf.end();
  });
}

function createTranslationService({ pool, uploadRoot, mail, env = process.env }) {
  const apiUrl = String(process.env.LIBRETRANSLATE_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');
  const apiKey = String(process.env.LIBRETRANSLATE_API_KEY || '').trim();
  const targetLanguage = String(process.env.LIBRETRANSLATE_TARGET_LANGUAGE || 'en').toLowerCase();
  const maximumChunkCharacters = Number(process.env.LIBRETRANSLATE_CHUNK_CHARACTERS || 4000);
  const requestTimeoutMs = Number(process.env.LIBRETRANSLATE_TIMEOUT_MS || 120000);

  async function translateText(text, sourceLanguage) {
    const translatedChunks = [];
    for (const chunk of splitText(text, maximumChunkCharacters)) {
      const body = { q: chunk, source: sourceLanguage, target: targetLanguage, format: 'text' };
      if (apiKey) body.api_key = apiKey;
      const response = await fetch(`${apiUrl}/translate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(requestTimeoutMs)
      });
      if (!response.ok) {
        throw new Error(`LibreTranslate request failed (HTTP ${response.status}): ${await readProviderError(response)}`);
      }
      const result = await response.json();
      if (!result.translatedText) throw new Error('LibreTranslate returned no translated text.');
      translatedChunks.push(result.translatedText);
    }
    return translatedChunks.join('\n\n');
  }

  async function translateJob(job) {
    await pool.execute(
      `UPDATE document_translations
       SET provider = 'LIBRETRANSLATE', status = 'PROCESSING', attempt_count = attempt_count + 1,
           started_at = CURRENT_TIMESTAMP, completed_at = NULL, last_error = NULL WHERE id = ?`,
      [job.translation_id]
    );
    try {
      if (path.extname(job.original_file_name).toLowerCase() !== '.pdf') {
        throw new Error('Local demo translation currently supports PDF uploads only.');
      }
      const sourcePath = path.resolve(uploadRoot, job.source_storage_path);
      if (!sourcePath.startsWith(`${uploadRoot}${path.sep}`)) throw new Error('Invalid source storage path.');
      const sourceBuffer = await fs.promises.readFile(sourcePath);
      const parsed = await pdfParse(sourceBuffer);
      const sourceText = String(parsed.text || '').replace(/\u0000/g, '').trim();
      if (sourceText.length < 20) {
        throw new Error('No readable text was found in the PDF. This file appears scanned and requires OCR.');
      }
      const translatedText = await translateText(sourceText, sourceLanguageFor(job));
      const outputBuffer = await createEnglishPdf({
        documentName: job.document_name, originalFileName: job.original_file_name, translatedText
      });
      const vendorFolder = path.dirname(path.dirname(job.source_storage_path));
      const translatedFolder = path.resolve(uploadRoot, vendorFolder, 'translated');
      if (!translatedFolder.startsWith(`${uploadRoot}${path.sep}`)) throw new Error('Invalid translated storage path.');
      await fs.promises.mkdir(translatedFolder, { recursive: true });
      const translatedFileName = `${safeFileStem(job.document_name)}-translated-en-v${job.version_number}-${crypto.randomUUID()}.pdf`;
      const relativeStoragePath = path.join(vendorFolder, 'translated', translatedFileName);
      const translatedPath = path.resolve(uploadRoot, relativeStoragePath);
      await fs.promises.writeFile(translatedPath, outputBuffer, { flag: 'wx' });
      const checksum = crypto.createHash('sha256').update(outputBuffer).digest('hex');
      await pool.execute(
        `UPDATE document_translations
         SET status = 'COMPLETED', translated_file_name = ?, storage_path = ?, mime_type = 'application/pdf',
             size_bytes = ?, sha256 = ?, billed_characters = ?, completed_at = CURRENT_TIMESTAMP, last_error = NULL
         WHERE id = ?`,
        [translatedFileName, relativeStoragePath, outputBuffer.length, checksum, sourceText.length, job.translation_id]
      );
    } catch (error) {
      const failureMessage = error.cause?.message ? `${error.message}: ${error.cause.message}` : String(error.message || error);
      await pool.execute(
        `UPDATE document_translations SET status = 'FAILED', last_error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [failureMessage.slice(0, 2000), job.translation_id]
      );
      throw error;
    }
  }

  async function translateTicket(ticketId, retryFailed = false) {
    await pool.execute(
      `INSERT INTO document_translations (document_upload_id, target_language, provider, status)
       SELECT u.id, ?, 'LIBRETRANSLATE', 'PENDING'
       FROM ticket_documents d
       JOIN document_uploads u ON u.id = (
         SELECT latest.id FROM document_uploads latest WHERE latest.ticket_document_id = d.id
         ORDER BY latest.version_number DESC LIMIT 1)
       WHERE d.ticket_id = ? AND d.status = 'LOCAL_PROCUREMENT_ACCEPTED'
       ON DUPLICATE KEY UPDATE
         provider = IF(document_translations.status = 'FAILED', 'LIBRETRANSLATE', document_translations.provider),
         status = IF(document_translations.status = 'FAILED' AND ?, 'PENDING', document_translations.status),
         last_error = IF(document_translations.status = 'PENDING' AND ?, NULL, document_translations.last_error)`,
      [targetLanguage, ticketId, retryFailed, retryFailed]
    );
    const [jobs] = await pool.execute(
      `SELECT tr.id AS translation_id, d.document_name, t.country_code, t.communication_language,
              u.original_file_name,
              u.storage_path AS source_storage_path, u.mime_type AS source_mime_type, u.version_number
       FROM document_translations tr
       JOIN document_uploads u ON u.id = tr.document_upload_id
       JOIN ticket_documents d ON d.id = u.ticket_document_id
       JOIN onboarding_tickets t ON t.id = d.ticket_id
       WHERE d.ticket_id = ? AND tr.target_language = ? AND tr.status = 'PENDING' ORDER BY d.id`,
      [ticketId, targetLanguage]
    );
    for (const job of jobs) {
      try { await translateJob(job); }
      catch (error) { console.error(`Translation ${job.translation_id} failed:`, error.message); }
    }
  }

  async function advance(ticketId) {
    const c = await pool.getConnection();
    let notification = null;
    try {
      await c.beginTransaction();
      const [tickets] = await c.execute('SELECT ticket_number,workflow_stage FROM onboarding_tickets WHERE id=? FOR UPDATE', [ticketId]);
      if (tickets[0]?.workflow_stage === 'TRANSLATION') {
        const [docs] = await c.execute(`SELECT d.status,d.india_status,tr.status AS translation_status FROM ticket_documents d
          LEFT JOIN document_uploads u ON u.id=(SELECT id FROM document_uploads WHERE ticket_document_id=d.id ORDER BY version_number DESC LIMIT 1)
          LEFT JOIN document_translations tr ON tr.document_upload_id=u.id AND tr.target_language=? WHERE d.ticket_id=?`, [targetLanguage,ticketId]);
        if (docs.length && docs.every(d => d.status === 'LOCAL_PROCUREMENT_ACCEPTED' && d.translation_status === 'COMPLETED')) {
          const nextStage = docs.every(d => d.india_status === 'APPROVED') ? 'SECURITY' : 'INDIA';
          await c.execute('UPDATE onboarding_tickets SET workflow_stage=? WHERE id=?', [nextStage, ticketId]);
          await c.execute("INSERT INTO workflow_events (ticket_id,stage,action,actor_email,details) VALUES (?,'TRANSLATION','TRANSLATIONS_COMPLETED','system',?)", [ticketId, JSON.stringify({ nextStage })]);
          const reference = tickets[0].ticket_number || ticketId;
          notification = nextStage === 'SECURITY'
            ? { to: env.CORPORATE_SECURITY_EMAIL, subject: `Documents ready for Corporate Security review — ${reference}`, message: `Corrected vendor documents for ${reference} passed Local SOA review and translation. They are ready for Corporate Security review.` }
            : { to: env.INDIA_PROCUREMENT_EMAIL, subject: `Documents ready for Indian SOA review — ${reference}`, message: `Vendor documents for ${reference} passed Local SOA review and translation. They are ready for Indian SOA review.` };
        }
      }
      await c.commit();
      if (notification) mail?.queueTeam(notification);
    } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
  }
  const active = new Set();
  async function resume() {
    const [tickets] = await pool.execute("SELECT id FROM onboarding_tickets WHERE workflow_stage='TRANSLATION'");
    // A single local demo backend owns these jobs. Recover interrupted work.
    await pool.execute("UPDATE document_translations SET status='PENDING' WHERE status='PROCESSING'");
    for (const ticket of tickets) queueTicket(ticket.id);
  }
  function queueTicket(ticketId, retryFailed = false) {
    if (active.has(String(ticketId))) return;
    active.add(String(ticketId));
    setImmediate(() => translateTicket(ticketId, retryFailed)
      .then(() => advance(ticketId))
      .catch(error => console.error(`Ticket ${ticketId} translation failed:`, error.message))
      .finally(() => active.delete(String(ticketId))));
  }
  return { queueTicket, translateTicket, targetLanguage, advance, resume };
}

module.exports = { createTranslationService, sourceLanguageFor, splitText };
