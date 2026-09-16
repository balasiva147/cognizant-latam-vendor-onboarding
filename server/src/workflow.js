const STAGES = { procurement: 'LOCAL', india_procurement: 'INDIA', corporate_security: 'SECURITY' };
function fail(message, status = 409) { const e = new Error(message); e.status = status; throw e; }
function planReview(stage, role, documents, decisions) {
  if (STAGES[role] !== stage) fail('This request is not awaiting your team review.', 403);
  if (!Array.isArray(decisions) || !decisions.length) fail('Select at least one document.', 400);
  const seen = new Set();
  const field = stage === 'INDIA' ? 'india_status' : 'security_status';
  const updates = decisions.map(item => {
    if (!item || typeof item !== 'object') fail('Invalid document decision.', 400);
    const id = Number(item.documentId), decision = String(item.decision || '').toUpperCase();
    const note = String(item.note || '').trim();
    if (!Number.isSafeInteger(id) || seen.has(id) || !['APPROVED','REJECTED','LOCAL_PROCUREMENT_ACCEPTED'].includes(decision) || note.length > 1000 || (decision === 'REJECTED' && !note)) fail('Each selected document needs one decision and each rejection needs a reason (maximum 1000 characters).', 400);
    seen.add(id);
    const doc = documents.find(d => Number(d.id) === id);
    if (!doc || !doc.latest_upload_id) fail('Document is not available for review.', 400);
    if (stage === 'LOCAL' ? doc.status !== 'DOCUMENTS_UPLOADED' : doc.status !== 'LOCAL_PROCUREMENT_ACCEPTED' || doc[field] !== 'PENDING' || doc.translation_status !== 'COMPLETED') fail('Document has changed or is not ready. Refresh the request.');
    if (!Number.isSafeInteger(Number(item.uploadId)) || Number(item.uploadId) !== Number(doc.latest_upload_id)) fail('A newer upload exists or its version is missing. Refresh before reviewing.');
    return { ...doc, decision: decision === 'REJECTED' ? 'REJECTED' : 'APPROVED', note };
  });
  const next = documents.map(doc => {
    const item = updates.find(x => Number(x.id) === Number(doc.id));
    if (!item) return doc;
    return stage === 'LOCAL' ? { ...doc, status: item.decision === 'REJECTED' ? 'INIT' : 'LOCAL_PROCUREMENT_ACCEPTED' } : { ...doc, [field]: item.decision };
  });
  const rejected = updates.filter(d => d.decision === 'REJECTED');
  let nextStage = stage;
  if (rejected.length) nextStage = 'VENDOR';
  else if (stage === 'LOCAL' && next.every(d => d.status === 'LOCAL_PROCUREMENT_ACCEPTED')) nextStage = 'TRANSLATION';
  else if (stage === 'INDIA' && next.every(d => d.india_status === 'APPROVED')) nextStage = 'SECURITY';
  else if (stage === 'SECURITY' && next.every(d => d.security_status === 'APPROVED')) nextStage = 'COMPLETED';
  return { updates, rejected, nextStage };
}

function createWorkflow({ pool, mail, translationService, renameRejectedUpload, env = process.env }) {
  async function event(c, ticketId, stage, action, email, details) {
    await c.execute('INSERT INTO workflow_events (ticket_id, stage, action, actor_email, details) VALUES (?, ?, ?, ?, ?)', [ticketId, stage, action, email, JSON.stringify(details)]);
  }
  async function notify(c, ticket, rejected, stage) {
    const reviewer = stage === 'INDIA' ? 'Indian SOA' : stage === 'SECURITY' ? 'Corporate Security' : 'Local SOA';
    const [n] = await c.execute(`INSERT INTO vendor_notifications (ticket_id,vendor_id,notification_type,subject,message,rejected_documents) VALUES (?,?,'DOCUMENTS_REJECTED',?,?,?)`, [ticket.id, ticket.vendor_id, `Correct documents for ${ticket.ticket_number}`, `${reviewer} requests corrected documents. Sign in to view rejection reasons and upload replacements.`, JSON.stringify(rejected.map(d => ({ documentId: d.id, documentName: d.document_name, rejectionText: d.note || d.rejection_reason })))]);
    return n.insertId;
  }
  async function transaction(req, res, next) {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [tickets] = await c.execute('SELECT t.*,v.email AS vendor_email FROM onboarding_tickets t JOIN vendors v ON v.id=t.vendor_id WHERE t.ticket_number=? FOR UPDATE', [req.params.ticketNumber]);
      const ticket = tickets[0];
      if (!ticket) fail('Request not found.', 404);
      const [docs] = await c.execute(`SELECT d.*, u.id AS latest_upload_id, u.storage_path, u.stored_file_name, u.version_number, tr.status AS translation_status
        FROM ticket_documents d LEFT JOIN document_uploads u ON u.id=(SELECT id FROM document_uploads WHERE ticket_document_id=d.id ORDER BY version_number DESC LIMIT 1)
        LEFT JOIN document_translations tr ON tr.document_upload_id=u.id AND tr.target_language=? WHERE d.ticket_id=? FOR UPDATE`, [translationService.targetLanguage, ticket.id]);
      let notificationId = null;
      const plan = planReview(ticket.workflow_stage, req.user.role, docs, req.body.decisions);
      const { nextStage, rejected } = plan;
      for (const d of plan.updates) {
        const local = ticket.workflow_stage === 'LOCAL';
        if (d.decision === 'REJECTED') await renameRejectedUpload(c, { ...d, id: d.latest_upload_id });
        if (local) {
          await c.execute('UPDATE ticket_documents SET status=?, rejection_reason=? WHERE id=?', [d.decision === 'APPROVED' ? 'LOCAL_PROCUREMENT_ACCEPTED' : 'INIT', d.decision === 'REJECTED' ? d.note : null, d.id]);
        } else if (d.decision === 'REJECTED' && ticket.workflow_stage === 'INDIA') {
          await c.execute("UPDATE ticket_documents SET status='INIT',india_status='PENDING',security_status='PENDING',rejection_reason=? WHERE id=?", [d.note, d.id]);
        } else if (d.decision === 'REJECTED') {
          await c.execute("UPDATE ticket_documents SET status='INIT',security_status='PENDING',rejection_reason=? WHERE id=?", [d.note, d.id]);
        } else {
          const column = ticket.workflow_stage === 'INDIA' ? 'india_status' : 'security_status';
          await c.execute(`UPDATE ticket_documents SET ${column}='APPROVED',rejection_reason=NULL WHERE id=?`, [d.id]);
        }
        const decision = d.decision === 'REJECTED' ? 'REJECTED' : local ? 'LOCAL_PROCUREMENT_ACCEPTED' : ticket.workflow_stage === 'INDIA' ? 'INDIA_PROCUREMENT_ACCEPTED' : 'SECURITY_ACCEPTED';
        await c.execute('INSERT INTO document_review_events (ticket_document_id,document_upload_id,decision,review_note,reviewed_by_email,review_stage) VALUES (?,?,?,?,?,?)', [d.id, d.latest_upload_id, decision, d.note || null, req.user.email, ticket.workflow_stage]);
      }
      if (rejected.length) notificationId = await notify(c, ticket, rejected, ticket.workflow_stage);
      await event(c, ticket.id, ticket.workflow_stage, rejected.length ? 'DOCUMENTS_REJECTED' : 'REVIEW_SAVED', req.user.email, plan.updates.map(d => ({ documentId: d.id, uploadId: d.latest_upload_id, name: d.document_name, decision: d.decision, reason: d.note })));
      const status = nextStage === 'VENDOR' ? 'INIT' : nextStage === 'LOCAL' ? 'DOCUMENTS_UPLOADED' : 'LOCAL_PROCUREMENT_ACCEPTED';
      await c.execute('UPDATE onboarding_tickets SET workflow_stage=?,status=? WHERE id=?', [nextStage, status, ticket.id]);
      await c.commit();
      if (notificationId) mail.queue(notificationId);
      if (nextStage === 'TRANSLATION') translationService.queueTicket(ticket.id);
      if (ticket.workflow_stage === 'INDIA' && nextStage === 'SECURITY') {
        mail.queueTeam?.({
          to: env.CORPORATE_SECURITY_EMAIL,
          subject: `Documents ready for Corporate Security review — ${ticket.ticket_number}`,
          message: `Indian SOA approved all documents for ${ticket.ticket_number}. The request is ready for Corporate Security review.`
        });
      }
      if (nextStage === 'COMPLETED') {
        const completion = `Corporate Security approved all documents for ${ticket.ticket_number}. Vendor onboarding document review is complete.`;
        for (const to of [ticket.vendor_email, env.PROCUREMENT_ADMIN_EMAIL, env.INDIA_PROCUREMENT_EMAIL]) {
          mail.queueTeam?.({ to, subject: `Vendor document review completed — ${ticket.ticket_number}`, message: completion });
        }
      }
      res.json({ stage: nextStage, translationQueued: nextStage === 'TRANSLATION', notificationId });
    } catch (e) { await c.rollback(); if (e.status) res.status(e.status).json({ error: e.message }); else next(e); }
    finally { c.release(); }
  }
  function routes(app) {
    app.post('/api/tickets/:ticketNumber/review', (req,res,next) => transaction(req,res,next).catch(next));
    app.post('/api/tickets/:ticketNumber/request-replacements', (_req,res) => res.status(410).json({ error: 'Rejected documents are now sent directly to the vendor.' }));
  }
  return { routes };
}
module.exports = { createWorkflow, planReview, STAGES };
