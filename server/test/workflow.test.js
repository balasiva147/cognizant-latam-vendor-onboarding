const test = require('node:test');
const assert = require('node:assert/strict');
const { planReview, createWorkflow } = require('../src/workflow');
const { createAuth } = require('../src/auth');
const { createTranslationService } = require('../src/translation');
const doc = (id, extra={}) => ({ id, latest_upload_id:id*10, document_name:'Document '+id, status:'LOCAL_PROCUREMENT_ACCEPTED', india_status:'PENDING', security_status:'PENDING', translation_status:'COMPLETED', ...extra });
const approve = id => ({ documentId:id, uploadId:id*10, decision:'APPROVED' });
const reject = (id,note='Unreadable') => ({ documentId:id, uploadId:id*10, decision:'REJECTED', note });
test('each stage requires its own role; vendor and out-of-order reviews fail',()=>{
  for(const [stage,role] of [['INDIA','procurement'],['SECURITY','india_procurement'],['LOCAL','corporate_security'],['INDIA','vendor'],['COMPLETED','corporate_security']]) assert.throws(()=>planReview(stage,role,[doc(1)],[approve(1)]),/not awaiting/);
});
test('translation and current upload version are mandatory for downstream reviews',()=>{
  assert.throws(()=>planReview('INDIA','india_procurement',[doc(1,{translation_status:'FAILED'})],[approve(1)]),/not ready/);
  assert.throws(()=>planReview('INDIA','india_procurement',[doc(1)],[{...approve(1),uploadId:9}]),/newer upload/);
  assert.throws(()=>planReview('INDIA','india_procurement',[doc(1)],[approve(2)]),/not available/);
});
test('local approval starts translation only after all requested documents are accepted',()=>{
  const docs=[doc(1,{status:'DOCUMENTS_UPLOADED'}),doc(2,{status:'DOCUMENTS_UPLOADED'})];
  assert.equal(planReview('LOCAL','procurement',docs,[approve(1)]).nextStage,'LOCAL');
  assert.equal(planReview('LOCAL','procurement',docs,[approve(1),approve(2)]).nextStage,'TRANSLATION');
  assert.equal(planReview('LOCAL','procurement',docs,[approve(1),reject(2)]).nextStage,'VENDOR');
});
test('mixed Indian SOA decisions return directly to the vendor and retain separate reasons',()=>{
  const docs=[doc(1),doc(2)];
  assert.equal(planReview('INDIA','india_procurement',docs,[approve(1),reject(2)]).nextStage,'VENDOR');
  const p=planReview('INDIA','india_procurement',docs,[reject(1,'Expired'),reject(2,'Unreadable')]);
  assert.deepEqual(p.rejected.map(d=>d.note),['Expired','Unreadable']);
  assert.throws(()=>planReview('INDIA','india_procurement',docs,[reject(1,'')]),/reason/);
  assert.throws(()=>planReview('INDIA','india_procurement',docs,[approve(1),reject(1)]),/one decision/);
});
test('partial approvals remain in review; all India approvals enter security',()=>{
  assert.equal(planReview('INDIA','india_procurement',[doc(1),doc(2)],[approve(1)]).nextStage,'INDIA');
  assert.equal(planReview('INDIA','india_procurement',[doc(1,{india_status:'APPROVED'}),doc(2)],[approve(2)]).nextStage,'SECURITY');
});
test('security rejection returns directly to the vendor and preserves Indian SOA approval',()=>{
  const unchanged=doc(1,{india_status:'APPROVED',security_status:'APPROVED'});
  assert.equal(planReview('SECURITY','corporate_security',[unchanged,doc(2,{india_status:'APPROVED'})],[reject(2)]).nextStage,'VENDOR');
  const replacement=doc(2,{status:'DOCUMENTS_UPLOADED',translation_status:null});
  assert.equal(planReview('LOCAL','procurement',[unchanged,replacement],[approve(2)]).nextStage,'TRANSLATION');
  assert.equal(planReview('SECURITY','corporate_security',[unchanged,doc(2,{india_status:'APPROVED'})],[approve(2)]).nextStage,'COMPLETED');
});
test('only Indian SOA can create tickets and downstream teams cannot upload',async()=>{
  const auth=createAuth({pool:{},env:{}});
  let indiaCreated=false;
  await auth.authorize({user:{role:'india_procurement'},method:'POST',path:'/tickets',body:{}},{},()=>indiaCreated=true);
  assert.equal(indiaCreated,true);
  for(const [role,path] of [['procurement','/tickets'],['corporate_security','/tickets'],['india_procurement','/ticket-documents/1/upload'],['corporate_security','/ticket-documents/1/upload']]) {
    let status;await auth.authorize({user:{role},method:'POST',path},{status(n){status=n;return this},json(){}},()=>assert.fail());assert.equal(status,403);
  }
  for(const role of ['india_procurement','corporate_security']) for(const path of ['/uploads/1','/translations/1','/tickets']) {
    let allowed=false;await auth.authorize({user:{role},method:'GET',path},{},()=>allowed=true);assert.equal(allowed,true);
  }
});
test('translations return to Indian SOA or Security and email the receiving team',async()=>{
  for(const scenario of [{complete:false,india:'PENDING',next:null,to:null},{complete:true,india:'PENDING',next:'INDIA',to:'india@example.test'},{complete:true,india:'APPROVED',next:'SECURITY',to:'security@example.test'}]) {
    const notified=[];
    const writes=[];const c={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){},execute:async(sql,params)=>{
      if(sql.startsWith('SELECT ticket_number')) return [[{ticket_number:'T',workflow_stage:'TRANSLATION'}]];
      if(sql.startsWith('SELECT d.status')) return [[doc(1,{india_status:scenario.india}),doc(2,{india_status:scenario.india,translation_status:scenario.complete?'COMPLETED':'FAILED'})]];
      writes.push([sql,params]);return [{}];
    }};
    await createTranslationService({pool:{getConnection:async()=>c},uploadRoot:process.cwd(),mail:{queueTeam:n=>notified.push(n)},env:{INDIA_PROCUREMENT_EMAIL:'india@example.test',CORPORATE_SECURITY_EMAIL:'security@example.test'}}).advance(1);
    const transition=writes.find(([sql])=>sql.startsWith('UPDATE onboarding_tickets SET workflow_stage='));
    assert.equal(transition?.[1]?.[0]||null,scenario.next);
    assert.equal(notified[0]?.to||null,scenario.to);
  }
});
test('Indian SOA and Security rejections notify the vendor immediately',async()=>{
  for(const stage of ['INDIA','SECURITY']) {
    const writes=[],queued=[];const docs=[doc(1,{india_status:stage==='SECURITY'?'APPROVED':'PENDING',rejection_reason:'Expired'})];
    const c={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){},execute:async(sql,params)=>{
      if(sql.startsWith('SELECT t.*'))return [[{id:1,vendor_id:1,vendor_email:'vendor@example.test',ticket_number:'T',workflow_stage:stage}]];
      if(sql.startsWith('SELECT d.*'))return [docs];
      writes.push([sql,params]);return [{insertId:123}];
    }};
    const routes={};createWorkflow({pool:{getConnection:async()=>c},mail:{queue:id=>queued.push(id)},translationService:{targetLanguage:'en'},renameRejectedUpload:async()=>{}}).routes({post:(url,fn)=>routes[url]=fn});
    const role=stage==='INDIA'?'india_procurement':'corporate_security';
    let result;await routes['/api/tickets/:ticketNumber/review']({params:{ticketNumber:'T'},user:{role,email:'test@example.test'},body:{decisions:[reject(1)]}},{json:r=>result=r},e=>{throw e});
    assert.equal(result.stage,'VENDOR');assert.equal(queued.length,1);
    const reset=writes.find(([sql])=>sql.includes("status='INIT'"));
    assert.ok(reset);
    if(stage==='SECURITY')assert.doesNotMatch(reset[0],/india_status='PENDING'/);
  }
});

test('approval handoffs email Security and final completion emails related parties',async()=>{
  for(const stage of ['INDIA','SECURITY']) {
    const notified=[];
    const current=doc(1,{india_status:stage==='SECURITY'?'APPROVED':'PENDING'});
    const c={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){},execute:async(sql)=>{
      if(sql.startsWith('SELECT t.*'))return [[{id:1,vendor_id:1,vendor_email:'vendor@example.test',ticket_number:'T',workflow_stage:stage}]];
      if(sql.startsWith('SELECT d.*'))return [[current]];
      return [{insertId:1}];
    }};
    const routes={};
    createWorkflow({pool:{getConnection:async()=>c},mail:{queue(){},queueTeam:n=>notified.push(n)},translationService:{targetLanguage:'en',queueTicket(){}},renameRejectedUpload:async()=>{},env:{PROCUREMENT_ADMIN_EMAIL:'local@example.test',INDIA_PROCUREMENT_EMAIL:'india@example.test',CORPORATE_SECURITY_EMAIL:'security@example.test'}}).routes({post:(url,fn)=>routes[url]=fn});
    let result;const role=stage==='INDIA'?'india_procurement':'corporate_security';
    await routes['/api/tickets/:ticketNumber/review']({params:{ticketNumber:'T'},user:{role,email:'reviewer@example.test'},body:{decisions:[approve(1)]}},{json:r=>result=r},e=>{throw e});
    if(stage==='INDIA') {
      assert.equal(result.stage,'SECURITY');
      assert.deepEqual(notified.map(n=>n.to),['security@example.test']);
    } else {
      assert.equal(result.stage,'COMPLETED');
      assert.deepEqual(notified.map(n=>n.to),['vendor@example.test','local@example.test','india@example.test']);
    }
  }
});
