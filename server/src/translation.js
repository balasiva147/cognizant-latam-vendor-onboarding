const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function safeFileStem(value) {
  return String(value || 'document')
    .normalize('NFKD')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase()
    .slice(0, 120) || 'document';
}

async function readDeepLError(response) {
  const body = await response.text();
  if (body.includes('Zscaler') || response.headers.get('content-type')?.includes('text/html')) {
    return `request blocked by network security (HTTP ${response.status})`;
  }
  try {
    const parsed = JSON.parse(body);
    return parsed.message || parsed.detail || body;
  } catch (_error) {
    return body || `${response.status} ${response.statusText}`;
  }
}

function createTranslationService({ pool, uploadRoot }) {
  const apiKey = process.env.DEEPL_API_KEY;
  const apiUrl = String(process.env.DEEPL_API_URL || 'https://api-free.deepl.com').replace(/\/$/, '');
  const targetLanguage = String(process.env.DEEPL_TARGET_LANGUAGE || 'EN-US').toUpperCase();
  const pollIntervalMs = Number(process.env.DEEPL_POLL_INTERVAL_MS || 1500);
  const pollTimeoutMs = Number(process.env.DEEPL_POLL_TIMEOUT_MS || 180000);

  async function translateJob(job) {
    await pool.execute(
      `UPDATE document_translations
       SET status = 'PROCESSING', attempt_count = attempt_count + 1,
           started_at = CURRENT_TIMESTAMP, last_error = NULL
       WHERE id = ?`,
      [job.translation_id]
    );

    try {
      if (!apiKey) throw new Error('DEEPL_API_KEY is not configured.');

      const sourcePath = path.resolve(uploadRoot, job.source_storage_path);
      if (!sourcePath.startsWith(`${uploadRoot}${path.sep}`)) throw new Error('Invalid source storage path.');
      const sourceBuffer = await fs.promises.readFile(sourcePath);
      const form = new FormData();
      form.append('target_lang', targetLanguage);
      form.append(
        'file',
        new Blob([sourceBuffer], { type: job.source_mime_type || 'application/octet-stream' }),
        job.original_file_name
      );
      if (path.extname(job.original_file_name).toLowerCase() === '.doc') {
        form.append('output_format', 'docx');
      }

      const uploadResponse = await fetch(`${apiUrl}/v2/document`, {
        method: 'POST',
        headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
        body: form
      });
      if (!uploadResponse.ok) throw new Error(`DeepL upload failed: ${await readDeepLError(uploadResponse)}`);

      const providerJob = await uploadResponse.json();
      await pool.execute(
        'UPDATE document_translations SET provider_document_id = ? WHERE id = ?',
        [providerJob.document_id, job.translation_id]
      );

      const deadline = Date.now() + pollTimeoutMs;
      let providerStatus;
      while (Date.now() < deadline) {
        const statusResponse = await fetch(`${apiUrl}/v2/document/${encodeURIComponent(providerJob.document_id)}`, {
          headers: { Authorization: `DeepL-Auth-Key ${apiKey}` }
        });
        if (!statusResponse.ok) throw new Error(`DeepL status failed: ${await readDeepLError(statusResponse)}`);
        providerStatus = await statusResponse.json();
        if (providerStatus.status === 'done') break;
        if (providerStatus.status === 'error') {
          throw new Error(providerStatus.error_message || 'DeepL could not translate the document.');
        }
        await wait(pollIntervalMs);
      }
      if (providerStatus?.status !== 'done') throw new Error('DeepL translation timed out.');

      const downloadBody = new URLSearchParams({ document_key: providerJob.document_key });
      const downloadResponse = await fetch(
        `${apiUrl}/v2/document/${encodeURIComponent(providerJob.document_id)}/result`,
        {
          method: 'POST',
          headers: {
            Authorization: `DeepL-Auth-Key ${apiKey}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: downloadBody
        }
      );
      if (!downloadResponse.ok) throw new Error(`DeepL download failed: ${await readDeepLError(downloadResponse)}`);

      const outputBuffer = Buffer.from(await downloadResponse.arrayBuffer());
      const vendorFolder = path.dirname(path.dirname(job.source_storage_path));
      const translatedFolder = path.resolve(uploadRoot, vendorFolder, 'translated');
      if (!translatedFolder.startsWith(`${uploadRoot}${path.sep}`)) throw new Error('Invalid translated storage path.');
      await fs.promises.mkdir(translatedFolder, { recursive: true });

      const sourceExtension = path.extname(job.original_file_name).toLowerCase();
      const outputExtension = sourceExtension === '.doc' ? '.docx' : sourceExtension;
      const translatedFileName = `${safeFileStem(job.document_name)}-translated-${targetLanguage.toLowerCase()}-v${job.version_number}-${crypto.randomUUID()}${outputExtension}`;
      const relativeStoragePath = path.join(vendorFolder, 'translated', translatedFileName);
      const translatedPath = path.resolve(uploadRoot, relativeStoragePath);
      await fs.promises.writeFile(translatedPath, outputBuffer, { flag: 'wx' });
      const checksum = crypto.createHash('sha256').update(outputBuffer).digest('hex');

      await pool.execute(
        `UPDATE document_translations
         SET status = 'COMPLETED', translated_file_name = ?, storage_path = ?,
             mime_type = ?, size_bytes = ?, sha256 = ?, billed_characters = ?,
             completed_at = CURRENT_TIMESTAMP, last_error = NULL
         WHERE id = ?`,
        [translatedFileName, relativeStoragePath,
          downloadResponse.headers.get('content-type') || job.source_mime_type || 'application/octet-stream',
          outputBuffer.length, checksum, providerStatus.billed_characters || null, job.translation_id]
      );
    } catch (error) {
      const failureMessage = error.cause?.message
        ? `${error.message}: ${error.cause.message}` : String(error.message || error);
      await pool.execute(
        `UPDATE document_translations
         SET status = 'FAILED', last_error = ?, completed_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [failureMessage.slice(0, 2000), job.translation_id]
      );
      throw error;
    }
  }

  async function translateTicket(ticketId) {
    await pool.execute(
      `INSERT IGNORE INTO document_translations
       (document_upload_id, target_language, provider, status)
       SELECT u.id, ?, 'DEEPL', 'PENDING'
       FROM ticket_documents d
       JOIN document_uploads u ON u.id = (
         SELECT latest.id FROM document_uploads latest
         WHERE latest.ticket_document_id = d.id
         ORDER BY latest.version_number DESC LIMIT 1
       )
       WHERE d.ticket_id = ? AND d.status = 'LOCAL_PROCUREMENT_ACCEPTED'`,
      [targetLanguage, ticketId]
    );

    const [jobs] = await pool.execute(
      `SELECT tr.id AS translation_id, d.document_name,
              u.original_file_name, u.storage_path AS source_storage_path,
              u.mime_type AS source_mime_type, u.version_number
       FROM document_translations tr
       JOIN document_uploads u ON u.id = tr.document_upload_id
       JOIN ticket_documents d ON d.id = u.ticket_document_id
       WHERE d.ticket_id = ? AND tr.target_language = ? AND tr.status = 'PENDING'
       ORDER BY d.id`,
      [ticketId, targetLanguage]
    );

    for (const job of jobs) {
      try {
        await translateJob(job);
      } catch (error) {
        console.error(`Translation ${job.translation_id} failed:`, error.message);
      }
    }
  }

  function queueTicket(ticketId) {
    setImmediate(() => {
      translateTicket(ticketId).catch(error => console.error(`Ticket ${ticketId} translation failed:`, error.message));
    });
  }

  return { queueTicket, translateTicket, targetLanguage };
}

module.exports = { createTranslationService };
