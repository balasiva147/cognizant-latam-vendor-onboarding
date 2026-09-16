const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createWorkflow } = require('../src/workflow');
const { createTranslationService } = require('../src/translation');

test('MySQL round trip: India and Security corrections, version-bound approvals and final completion', {skip:process.env.RUN_MYSQL_WORKFLOW_TEST!=='1'}, async()=>{
  require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
  const c=await require('mysql2/promise').createConnection({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
  await c.beginTransaction();
  try {
    const [v]=await c.execute("INSERT INTO vendors (legal_name,authorized_person_name,email,registered_address) VALUES ('Workflow rollback test','Test','workflow-test@example.invalid','Test')");
    const number='TEST-'+Date.now();
    const [t]=await c.execute("INSERT INTO onboarding_tickets (ticket_number,vendor_id,country_code,communication_language,status,workflow_stage) VALUES (?,?,'MX','Spanish','DOCUMENTS_UPLOADED','LOCAL')",[number,v.insertId]);
    const ids=[];
    for(const name of ['RFC Tax Certificate','Proof of Address']) {const [d]=await c.execute("INSERT INTO ticket_documents (ticket_id,document_name,status) VALUES (?,?,'DOCUMENTS_UPLOADED')",[t.insertId,name]);ids.push(d.insertId);}
    const upload=async id=>{
      const [[{version}]]=await c.execute('SELECT COALESCE(MAX(version_number),0)+1 AS version FROM document_uploads WHERE ticket_document_id=?',[id]);
      const [u]=await c.execute("INSERT INTO document_uploads (ticket_document_id,version_number,original_file_name,stored_file_name,storage_path,mime_type,size_bytes,sha256,uploaded_by_email) VALUES (?,?,'test.pdf','test.pdf','test-not-on-disk.pdf','application/pdf',1,?,'test@example.invalid')",[id,version,'0'.repeat(64)]);
      await c.execute("INSERT INTO document_translations (document_upload_id,target_language,status) VALUES (?,'en','COMPLETED')",[u.insertId]);
      await c.execute("UPDATE ticket_documents SET status='DOCUMENTS_UPLOADED',rejection_reason=NULL WHERE id=?",[id]);
      return u.insertId;
    };
    const uploads=new Map();for(const id of ids)uploads.set(id,await upload(id));
    // All service commits stay inside this one transaction, which is rolled back.
    const scoped={execute:c.execute.bind(c),beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){}};
    const pool={getConnection:async()=>scoped};const queued=[];const routes={};
    createWorkflow({pool,mail:{queue:id=>queued.push(id)},translationService:{targetLanguage:'en',queueTicket(){}},renameRejectedUpload:async()=>{}}).routes({post:(url,handler)=>routes[url]=handler});
    const translations=createTranslationService({pool,uploadRoot:process.cwd()});
    const review=async(role,decisions)=>{
      let result;
      const response={status(n){throw new Error('Unexpected HTTP '+n)},json(r){result=r}};
      await routes['/api/tickets/:ticketNumber/review']({params:{ticketNumber:number},user:{role,email:role+'@example.invalid'},body:{decisions}},response,e=>{throw e});
      return result.stage;
    };
    const decisions=(list,decision)=>list.map(id=>({documentId:id,uploadId:uploads.get(id),decision,note:decision==='REJECTED'?'Correct document '+id:''}));
    const assertLatestTranslations=async()=>{
      const [visible]=await c.execute(`SELECT d.id AS document_id,u.id AS upload_id,tr.status AS translation_status
        FROM ticket_documents d
        JOIN document_uploads u ON u.id=(SELECT latest.id FROM document_uploads latest WHERE latest.ticket_document_id=d.id ORDER BY latest.version_number DESC LIMIT 1)
        JOIN document_translations tr ON tr.document_upload_id=u.id AND tr.target_language='en'
        WHERE d.ticket_id=? AND d.status='LOCAL_PROCUREMENT_ACCEPTED'`,[t.insertId]);
      assert.equal(visible.length,ids.length);
      for(const row of visible){assert.equal(Number(row.upload_id),Number(uploads.get(Number(row.document_id))));assert.equal(row.translation_status,'COMPLETED');}
    };
    assert.equal(await review('procurement',decisions(ids,'APPROVED')),'TRANSLATION');
    await translations.advance(t.insertId);
    await assertLatestTranslations();
    assert.equal(await review('india_procurement',[...decisions([ids[0]],'APPROVED'),...decisions([ids[1]],'REJECTED')]),'VENDOR');
    assert.equal(queued.length,1);
    const [[unchanged]]=await c.execute('SELECT india_status FROM ticket_documents WHERE id=?',[ids[0]]);
    assert.equal(unchanged.india_status,'APPROVED');
    const cycle=async rejected=>{
      for(const id of rejected)uploads.set(id,await upload(id));
      await c.execute("UPDATE onboarding_tickets SET workflow_stage='LOCAL' WHERE id=?",[t.insertId]);
      assert.equal(await review('procurement',decisions(rejected,'APPROVED')),'TRANSLATION');
      await translations.advance(t.insertId);
      await assertLatestTranslations();
      assert.equal(await review('india_procurement',decisions(rejected,'APPROVED')),'SECURITY');
    };
    await cycle([ids[1]]);
    assert.equal(await review('corporate_security',decisions(ids,'REJECTED')),'VENDOR');
    assert.equal(queued.length,2);
    for(const id of ids)uploads.set(id,await upload(id));
    await c.execute("UPDATE onboarding_tickets SET workflow_stage='LOCAL' WHERE id=?",[t.insertId]);
    assert.equal(await review('procurement',decisions(ids,'APPROVED')),'TRANSLATION');
    await translations.advance(t.insertId);
    await assertLatestTranslations();
    assert.equal(await review('corporate_security',decisions(ids,'APPROVED')),'COMPLETED');
    const [[ticket]]=await c.execute('SELECT workflow_stage FROM onboarding_tickets WHERE id=?',[t.insertId]);
    assert.equal(ticket.workflow_stage,'COMPLETED');
    const [reviews]=await c.execute('SELECT r.* FROM document_review_events r JOIN ticket_documents d ON d.id=r.ticket_document_id WHERE d.ticket_id=?',[t.insertId]);
    assert.ok(reviews.some(r=>r.review_stage==='INDIA'));assert.ok(reviews.some(r=>r.review_stage==='SECURITY'));
  } finally {await c.rollback();await c.end();}
});
