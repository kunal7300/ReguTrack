import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const require = createRequire(resolve(root, 'package.json'));
const { Pool } = require('pg');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand, DeleteBucketCommand } = require('@aws-sdk/client-s3');
const fromApi = (path) => import(pathToFileURL(resolve(root, 'apps/api/dist', path)));
const { createApp } = await fromApi('app.js');
const { createIdentity } = await fromApi('identity/index.js');
const { hashPassword } = await fromApi('identity/auth.js');
const { createRegulations } = await fromApi('regulatory/index.js');
const { createIntelligence } = await fromApi('intelligence/index.js');
const { createComparisons } = await fromApi('comparisons/index.js');
const { createGaps } = await fromApi('gaps/index.js');
const { createWork } = await fromApi('work/index.js');
const { createEvidence } = await fromApi('evidence/index.js');
const { visibilityRoutes } = await fromApi('visibility/index.js');
const { notificationRoutes,deliverNotifications } = await fromApi('visibility/notifications.js');
const { createAssistant } = await fromApi('assistant/index.js');
const { Router } = require('express');

function pdf(label, paragraph = '') {
  const stream = label ? `BT /F1 16 Tf 40 250 Td (${label}) Tj 0 -25 Td (${paragraph}) Tj ET\n` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 620 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += 'xref\n0 6\n0000000000 65535 f \n';
  for (const offset of offsets) body += String(offset).padStart(10, '0') + ' 00000 n \n';
  body += `trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body));
}

test('synthetic PDFs pass through authenticated upload, object storage, queue and extraction', async (t) => {
  const suffix = randomBytes(8).toString('hex');
  const schema = 'regulations_test_' + suffix;
  const bucket = 'regulations-test-' + suffix;
  const admin = new Pool();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ options: `-c search_path=${schema},public` });
  const options = {
    redisUrl: process.env.REDIS_URL, aiUrl: process.env.AI_URL, pdfToken: process.env.PDF_SERVICE_TOKEN,
    endpoint: process.env.S3_ENDPOINT, accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY, bucket, queueName: bucket,
  };
  const storage = new S3Client({
    endpoint: options.endpoint, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  });
  let pipeline;
  let intelligence;
  let assistant;
  let evidence;
  let provider;
  let server;
  let uploaded = false;
  t.after(async () => {
    try {
      if (server) await new Promise((done) => server.close(done));
      await pipeline?.close();
      await intelligence?.close();
      await assistant?.close();
      evidence?.close();
      if (provider) await new Promise((done) => provider.close(done));
      if (uploaded) {
        const objects = await storage.send(new ListObjectsV2Command({ Bucket: bucket }));
        for (const object of objects.Contents ?? []) {
          await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
        }
        await storage.send(new DeleteBucketCommand({ Bucket: bucket }));
      }
    } finally {
      storage.destroy();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  for (const migration of ['002_identity.sql', '003_regulations.sql', '004_intelligence.sql', '005_comparisons.sql', '006_gaps.sql','007_work.sql','008_evidence.sql','010_notifications.sql','011_assistant.sql']) {
    await pool.query(readFileSync(resolve(process.env.REGULATIONS_MIGRATIONS ?? 'db/migrations', migration), 'utf8'));
  }
  const password = randomBytes(20).toString('hex');
  const hash = await hashPassword(password);
  for (const role of ['super_admin','internal_auditor','compliance_officer']) {
    const { rows: [user] } = await pool.query(
      'INSERT INTO users(email,name,password_hash) VALUES ($1,$2,$3) RETURNING id', [role + '@example.test', role, hash]);
    await pool.query('INSERT INTO user_roles VALUES ($1,$2)', [user.id,role]);
  }
  pipeline = createRegulations(pool, options);
  const extracted = {
    title: 'Synthetic requirement', description: 'Synthetic test interpretation', topic: null,
    requirementType: 'mandatory', applicability: null, effectiveDate: null, deadline: null,
    departments: [], priority: null, page: 1, ordinal: 1,
    section: 'SYNTHETIC TEST HEADING', quote: 'SYNTHETIC TEST HEADING',
  };
  provider = createServer((request,response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      response.setHeader('Content-Type','application/json');
      if (request.url === '/internal/assistant/embed') {
        response.end(JSON.stringify({vectors:JSON.parse(body).texts.map(()=>Array(768).fill(1))}));
        return;
      }
      if (request.url === '/internal/assistant/answer') {
        const {question,sources}=JSON.parse(body);
        const source=sources.find(({text})=>text.includes('Effective from')) ?? sources[0];
        response.end(JSON.stringify({status:'answered',interpretation:'Synthetic grounded answer',
          citations:[{sourceId:source.id,quote:question.includes('fabricated')?'Invented evidence':source.text.slice(0,180)}]}));
        return;
      }
      if (request.url === '/internal/gaps/suggest') {
        const { controls } = JSON.parse(body);
        response.end(JSON.stringify({
          observation:'Synthetic coverage gap',remediation:'Record verification evidence',
          controlIds:controls.map(({id}) => id),
        }));
        return;
      }
      response.end(JSON.stringify({
        model:'synthetic-response',raw:{requirements:[extracted]},
        grounded:{requirements:[extracted,{...extracted,title:'Synthetic rejection'}]},error:null,
      }));
    });
  }).listen(0,'127.0.0.1');
  await once(provider,'listening');
  intelligence = createIntelligence(pool,{
    redisUrl:options.redisUrl,aiUrl:'http://127.0.0.1:' + provider.address().port,
    token:options.pdfToken,queueName:bucket + '-ai',
  });
  const liveAssistant = process.env.PHASE9_LIVE_AI === 'true';
  assistant = createAssistant(pool,{redisUrl:options.redisUrl,token:options.pdfToken,
    aiUrl:liveAssistant?options.aiUrl:'http://127.0.0.1:'+provider.address().port,queueName:bucket+'-rag'});
  const probe = async () => {};
  server = createApp({ postgres: probe, redis: probe, ai: probe },
    createIdentity(pool, randomBytes(32).toString('hex'), false,
      (auth) => Router().use(pipeline.router(auth),intelligence.router(auth),
        createComparisons(pool,options.aiUrl,options.pdfToken,auth),
        createGaps(pool,process.env.PHASE5_LIVE_AI === 'true' ? options.aiUrl :
          'http://127.0.0.1:' + provider.address().port,options.pdfToken,auth),
        createWork(pool,auth),(evidence=createEvidence(pool,{...options,token:options.pdfToken},auth)).router,
        visibilityRoutes(pool,auth),notificationRoutes(pool,auth),assistant.router(auth)))).listen(0,'127.0.0.1');
  await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  let token;
  async function call(path, status, payload, auth = token, method = payload ? 'POST' : 'GET') {
    const headers = {};
    if (auth) headers.Authorization = 'Bearer ' + auth;
    if (payload && !(payload instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + path, {
      method, headers,
      body: payload instanceof FormData ? payload : payload ? JSON.stringify(payload) : undefined,
    });
    assert.equal(response.status,status, `${path} ${await response.clone().text().then((value) => value.slice(0,300))}`);
    return response;
  }
  await call('/regulations',401);
  const auditor = await (await call('/auth/login',200,{email:'internal_auditor@example.test',password})).json();
  await call('/regulatory-sources',403,{name:'Synthetic test',url:'https://example.test/'},auditor.accessToken);
  token = (await (await call('/auth/login',200,{email:'super_admin@example.test',password})).json()).accessToken;
  const source = await (await call('/regulatory-sources',201,{name:'Synthetic test',url:'https://example.test/'})).json();
  const record = await (await call('/regulations',201,{title:'Synthetic test circular',kind:'circular',sourceId:source.id})).json();
  const path = '/regulations/' + record.id;
  async function upload(data, status) {
    const form = new FormData();
    form.set('regulationId',record.id);
    form.set('sourceUrl','https://example.test/synthetic');
    form.set('pdf',new Blob([data],{type:'application/pdf'}),'synthetic.pdf');
    return (await call('/regulations/upload',status,form)).json();
  }
  async function waitFor(documentId) {
    for (let i = 0; i < 40; i++) {
      const { documents } = await (await call(path + '/documents',200)).json();
      const found = documents.find(({ id }) => id === documentId);
      if (['processed','failed'].includes(found?.status)) return found;
      await setTimeout(300);
    }
    assert.fail('PDF processing did not finish');
  }
  await upload(new Uint8Array([1,2,3]),422);
  const original = pdf('SYNTHETIC TEST HEADING','This applies to banks. Effective from 1 January 2027.');
  const document = await upload(original,202);
  uploaded = true;
  await upload(original,409);
  const first = await waitFor(document.id);
  assert.equal(first.status,'processed',first.error);
  assert.equal(first.page_count,1);
  const { chunks } = await (await call('/regulatory-documents/' + document.id + '/chunks?page=1',200)).json();
  assert.deepEqual(chunks[0],{page:1,ordinal:1,heading:'SYNTHETIC TEST HEADING',text:'SYNTHETIC TEST HEADING',ocr:false});
  const served = await call('/regulatory-documents/' + document.id + '/pdf',200);
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()),original);
  const blank = await upload(pdf(''),202);
  const failure = await waitFor(blank.id);
  assert.equal(failure.status,'failed');
  assert.match(failure.error,/extractable/i);
  const history = await (await call(path + '/versions',200)).json();
  assert.deepEqual(history.versions.map(({number}) => number),[2,1]);

  await call(path + '/analyze',409,{ documentId: blank.id });
  await call(path + '/analyze',403,{ documentId: document.id },auditor.accessToken);
  await call(path + '/analyze',202,{ documentId: document.id });
  let suggestions = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    const overview = await (await call(path + '/requirements?documentId=' + document.id,200)).json();
    assert.notEqual(overview.runs[0].status,'failed',overview.runs[0].error);
    if (overview.runs[0].status === 'completed') {
      suggestions = overview.requirements;
      break;
    }
    await setTimeout(200);
  }
  assert.equal(suggestions.length,2);
  await deliverNotifications(pool);
  const pending = suggestions.find(({suggestion}) => suggestion.title === extracted.title);
  const rejected = suggestions.find(({suggestion}) => suggestion.title === 'Synthetic rejection');
  assert.equal(pending.status,'pending');
  assert.equal(pending.suggestion.page,1);
  assert.equal(pending.suggestion.sourceText,extracted.quote);
  const requirementPath = '/requirements/' + pending.id;
  await call(requirementPath + '/review',403,{ action:'approve',revision:0 },auditor.accessToken);
  const { page,ordinal,section,quote,...result } = extracted;
  await call(requirementPath,200,{ revision:0,result:{...result,title:'Human revision'} },token,'PATCH');
  await call(requirementPath + '/review',409,{ action:'approve',revision:0 });
  await call(requirementPath + '/review',403,{ action:'approve',revision:1 });
  const checker = await (await call('/auth/login',200,{email:'compliance_officer@example.test',password})).json();
  await call(requirementPath + '/review',200,{ action:'approve',revision:1 },checker.accessToken);
  await call('/requirements/' + rejected.id + '/review',200,{ action:'reject',revision:0,note:'Synthetic test' });
  const reviewed = await (await call(requirementPath,200)).json();
  assert.equal(reviewed.status,'approved');
  assert.equal(reviewed.human_result.title,'Human revision');
  assert.equal(reviewed.suggestion.title,extracted.title);
  assert.deepEqual(reviewed.history.map(({action})=>action),['approve','revise']);
  const saved = await pool.query('SELECT raw_output FROM ai_analysis_runs WHERE id=$1',[reviewed.run_id]);
  assert.deepEqual(saved.rows[0].raw_output,{requirements:[extracted]});

  const newer = await upload(pdf('SYNTHETIC TEST HEADING','This applies to payment banks. Effective from 1 March 2027.'),202);
  const current = await waitFor(newer.id);
  assert.equal(current.status,'processed',current.error);
  const pair = { oldVersionId:first.version_id,newVersionId:current.version_id,
    includeImpact:process.env.PHASE4_LIVE_IMPACT === 'true' };
  await call(path + '/compare',403,pair,auditor.accessToken);
  await call(path + '/compare',400,{oldVersionId:pair.newVersionId,newVersionId:pair.oldVersionId});
  const comparison = await (await call(path + '/compare',201,pair)).json();
  const diff = await (await call(path + '/changes?comparisonId=' + comparison.id,200)).json();
  assert.equal(diff.counts.modified,1);
  assert.equal(diff.comparisons[0].impact_status,pair.includeImpact ? 'completed' : 'skipped',diff.comparisons[0].impact_error);
  const changePath = '/changes/' + diff.changes[0].id;
  const change = await (await call(changePath,200)).json();
  assert.match(change.old_section.text,/1 January 2027/);
  assert.match(change.new_section.text,/1 March 2027/);
  assert.deepEqual(change.new_section.changedLines,[1]);
  assert.deepEqual(change.new_section.pages,[1]);
  assert.deepEqual(Object.keys(change.signals).sort(),['applicability','effective_date']);
  if (pair.includeImpact) assert.ok(change.ai_explanation?.summary);
  const decision = {decision:'confirmed',comment:'Synthetic comparison checked',revision:0};
  await call(changePath + '/review',403,decision,auditor.accessToken);
  await call(changePath + '/review',200,decision,checker.accessToken);
  await call(changePath + '/review',409,decision);
  const decided = await (await call(changePath,200)).json();
  assert.equal(decided.decision,'confirmed');
  assert.equal(decided.review_history[0].comment,decision.comment);

  const controlInput={name:'Synthetic access management policy',description:'The policy describes access roles.',departmentId:null};
  await call('/controls',403,controlInput,auditor.accessToken);
  const control = await (await call('/controls',201,controlInput)).json();
  const mapping = {controlIds:[control.id],includeAi:true};
  await call('/requirements/' + rejected.id + '/gaps',409,mapping);
  const gap = await (await call(requirementPath + '/gaps',201,mapping)).json();
  await call(requirementPath + '/gaps',409,mapping);
  const gapPath = '/gaps/' + gap.id;
  const preliminary = await (await call(gapPath,200,undefined,auditor.accessToken)).json();
  assert.equal(preliminary.status,'not_assessed');
  assert.equal(preliminary.controls[0].id,control.id);
  assert.ok(preliminary.ai_suggestion?.observation,preliminary.ai_error);
  assert.equal(preliminary.remediation,null);
  const district = await (await call('/departments',201,{name:'Synthetic IT Security',code:'ITSEC'})).json();
  const proposal = {revision:0,outcome:'gap_identified',assessment:'No verification artifact',remediationProposal:'Record access review evidence'};
  await call(gapPath,200,proposal,token,'PATCH');
  const rejection = {revision:1,decision:'rejected',comment:'Provide a clearer rationale'};
  await call(gapPath + '/review',403,rejection);
  await call(gapPath + '/review',200,rejection,checker.accessToken);
  const rejectedGap = await (await call(gapPath,200)).json();
  assert.equal(rejectedGap.decision,'rejected');
  assert.equal(rejectedGap.remediation,null);
  await call(gapPath,200,{...proposal,revision:2,assessment:'No retained access review artifacts'},token,'PATCH');
  const validation = {revision:3,decision:'approved',comment:'Verified proposal',ownerDepartmentId:district.id,dueDate:'2027-02-01'};
  await call(gapPath + '/review',403,validation,auditor.accessToken);
  await call(gapPath + '/review',200,validation,checker.accessToken);
  const validated = await (await call(gapPath,200)).json();
  assert.equal(validated.status,'gap_identified');
  assert.equal(validated.remediation.action,proposal.remediationProposal);
  assert.equal(validated.remediation.departmentId,district.id);
  assert.equal(validated.history.length,4);
  assert.equal((await (await call('/gaps?requirementId=' + pending.id,200)).json()).gaps[0].decision,'approved');

  const otherDept = await (await call('/departments',201,{name:'Synthetic Operations',code:'OPS'})).json();
  async function staff(email, role, departmentId) {
    const member = await (await call('/users',201,{ email,name:email.split('@')[0],password,departmentId,roles:[role] })).json();
    const visit = await (await call('/auth/login',200,{email,password})).json();
    return { id:member.id, token:visit.accessToken };
  }
  const manager = await staff('manager@example.test','department_manager',district.id);
  const employee = await staff('employee@example.test','department_employee',district.id);
  const outsider = await staff('outsider@example.test','department_manager',otherDept.id);
  const implementation = { requirementId:pending.id,gapId:gap.id,title:'Synthetic access control implementation',
    description:'Implement and record access reviews',departmentId:district.id,accountableId:manager.id,
    targetDate:'2027-04-01',priority:'high',applicability:null };
  await call('/obligations',409,{...implementation,requirementId:rejected.id,gapId:null});
  await call('/obligations',403,implementation,manager.token);
  const obligation = await (await call('/obligations',201,implementation)).json();
  const obligationPath = '/obligations/' + obligation.id;
  const planned = { obligationId:obligation.id,title:'Synthetic evidence checks',description:'Record access review',dueDate:'2000-01-01' };
  await call('/tasks',409,planned,manager.token);
  await call(obligationPath,403,{revision:0,action:'approve'},token,'PATCH');
  await call(obligationPath,200,{revision:0,action:'approve'},checker.accessToken,'PATCH');
  await call(obligationPath,400,{revision:1,targetDate:'2027-04-03'},token,'PATCH');
  await call(obligationPath,200,{revision:1,targetDate:'2027-04-03',reason:'Synthetic extension'},token,'PATCH');
  assert.equal((await (await call(obligationPath,200,undefined,manager.token)).json()).deadlineHistory[0].reason,'Synthetic extension');
  await call(obligationPath,404,undefined,outsider.token);
  const task = await (await call('/tasks',201,planned,manager.token)).json();
  const taskPath = '/tasks/' + task.id;
  await call(taskPath,404,undefined,employee.token);
  await call(taskPath + '/assign',404,{revision:0,assigneeId:employee.id},outsider.token);
  await call(taskPath + '/assign',400,{revision:0,assigneeId:outsider.id},manager.token);
  await call(taskPath + '/assign',200,{revision:0,assigneeId:employee.id},manager.token);
  assert.equal((await (await call('/tasks?mine=true&overdue=true',200,undefined,employee.token)).json()).tasks[0].id,task.id);
  await call(taskPath,403,{revision:1,dueDate:'2000-01-02',reason:'Unauthorized'},employee.token,'PATCH');
  await call(taskPath,400,{revision:1,dueDate:'2000-01-02'},manager.token,'PATCH');
  await call(taskPath,200,{revision:1,dueDate:'2000-01-02',reason:'Synthetic amendment'},manager.token,'PATCH');
  await call(taskPath,200,{revision:2,action:'start'},employee.token,'PATCH');
  await call(taskPath + '/comments',201,{body:'Synthetic update'},employee.token);
  await call(taskPath,200,{revision:3,action:'block',reason:'Synthetic dependency'},manager.token,'PATCH');
  await call(taskPath,200,{revision:4,action:'resume',reason:'Dependency cleared'},manager.token,'PATCH');
  await call(taskPath + '/submit',409,{revision:5,note:'Evidence is required'},employee.token);
  async function attach(path,auth,status,bytes,metadata) {
    const form = new FormData();
    form.set('file',new Blob([bytes],{type:'application/pdf'}),'evidence.pdf');
    for (const [key,value] of Object.entries(metadata)) form.set(key,value);
    return call(path + '/evidence',status,form,auth);
  }
  await attach(taskPath,outsider.token,404,original,{title:'Unauthorized evidence'});
  await attach(taskPath,employee.token,422,new Uint8Array([1,2,3]),{title:'Invalid evidence'});
  const firstEvidence = await (await attach(taskPath,employee.token,201,original,{title:'Synthetic work evidence'})).json();
  await attach(taskPath,employee.token,409,original,{title:'Duplicate evidence'});
  const evidencePath = '/evidence/' + firstEvidence.id;
  await call(evidencePath,404,undefined,outsider.token);
  const readEvidence = await call(evidencePath + '/download?versionId=' + firstEvidence.versionId,200,undefined,auditor.accessToken);
  assert.deepEqual(new Uint8Array(await readEvidence.arrayBuffer()),original);
  await call(taskPath + '/submit',200,{revision:5,note:'First submission'},employee.token);
  await deliverNotifications(pool);
  const managerInbox = await (await call('/notifications',200,undefined,manager.token)).json();
  assert.ok(managerInbox.notifications.some(({kind})=>kind==='evidence_submitted'));
  await call(taskPath + '/verify',409,{revision:6,decision:'verify'},manager.token);
  await call(taskPath + '/verify',200,{revision:6,decision:'start_review'},manager.token);
  await call(taskPath + '/verify',409,{revision:7,decision:'verify'},manager.token);
  await call(evidencePath + '/approve',403,{versionId:firstEvidence.versionId,revision:7,comment:'Unauthorized'},employee.token);
  await call(evidencePath + '/reject',200,{versionId:firstEvidence.versionId,revision:7,comment:'Test resubmission'},manager.token);
  await call(taskPath + '/submit',409,{revision:8,note:'Replacement is required'},employee.token);
  const replacement = await (await attach(taskPath,employee.token,201,pdf('SYNTHETIC REPLACEMENT'),{evidenceId:firstEvidence.id})).json();
  assert.equal(replacement.number,2);
  await call(taskPath + '/submit',200,{revision:8,note:'Revised submission'},employee.token);
  await call(taskPath + '/verify',403,{revision:9,decision:'start_review'},auditor.accessToken);
  await call(taskPath + '/verify',200,{revision:9,decision:'start_review'},manager.token);
  await call(evidencePath + '/approve',409,{versionId:firstEvidence.versionId,revision:10,comment:'Superseded'},manager.token);
  await call(evidencePath + '/approve',200,{versionId:replacement.versionId,revision:10,comment:'Validated revision'},manager.token);
  await call(taskPath + '/verify',200,{revision:11,decision:'verify'},manager.token);
  await call(taskPath,200,{revision:12,action:'complete'},manager.token,'PATCH');
  const done = await (await call(taskPath,200,undefined,employee.token)).json();
  assert.equal(done.status,'completed');
  assert.equal(done.deadlineHistory[0].reason,'Synthetic amendment');
  assert.equal(done.comments[0].body,'Synthetic update');
  assert.equal(done.history[0].from_status,'verified');
  assert.equal((await (await call(obligationPath,200,undefined,employee.token)).json()).implementation_status,'completed');
  const trace = await (await call(taskPath + '/history',200,undefined,auditor.accessToken)).json();
  assert.equal(trace.lineage.requirement_id,pending.id);
  assert.equal(trace.lineage.assignee_id,employee.id);
  assert.equal(trace.lineage.obligation_id,obligation.id);
  assert.ok(trace.events.some(({action}) => action==='evidence.approved'));
  const obTrace = await (await call(obligationPath + '/history',200,undefined,auditor.accessToken)).json();
  assert.equal(obTrace.lineage.document_id,document.id);
  assert.ok(obTrace.events.some(({action}) => action==='obligation.approved'));
  const evidenceHistory = await (await call(evidencePath,200,undefined,auditor.accessToken)).json();
  assert.deepEqual(evidenceHistory.versions.map(({decision})=>decision),['approved','rejected']);
  await call('/audit-logs',403,undefined,employee.token);
  const audit = await (await call('/audit-logs?action=evidence.approved&targetId='+firstEvidence.id,200,undefined,auditor.accessToken)).json();
  assert.deepEqual(audit.events[0].details.current,'approved');
  await assert.rejects(pool.query("UPDATE audit_logs SET action='tampered' WHERE false"),{code:'42501'});

  const second = await (await call('/tasks',201,{...planned,title:'Synthetic maker-checker test'},manager.token)).json();
  const secondPath='/tasks/' + second.id;
  await call(secondPath + '/assign',200,{revision:0,assigneeId:manager.id},manager.token);
  await call(secondPath,200,{revision:1,action:'start'},manager.token,'PATCH');
  await attach(secondPath,manager.token,201,pdf('SYNTHETIC MAKER EVIDENCE'),{title:'Manager authored evidence'});
  await call(secondPath + '/submit',200,{revision:2,note:'Manager authored this work'},manager.token);
  await call(secondPath + '/verify',403,{revision:3,decision:'start_review'},manager.token);
  await call(secondPath,200,{revision:3,action:'cancel',reason:'Synthetic test closed'},manager.token,'PATCH');
  const edited = await (await call('/obligations',201,{...implementation,title:'Synthetic edited draft'})).json();
  const editPath = '/obligations/' + edited.id;
  await call(editPath,200,{revision:0,description:'Checker edits the draft'},checker.accessToken,'PATCH');
  await call(editPath,200,{revision:1,title:'Creator edits again'},token,'PATCH');
  assert.equal((await (await call(editPath,200,undefined,checker.accessToken)).json()).canApprove,false);
  await call(editPath,403,{revision:2,action:'approve'},checker.accessToken,'PATCH');

  const overdueTask = await (await call('/tasks',201,{...planned,title:'=Synthetic export formula test'},manager.token)).json();
  await call('/tasks/' + overdueTask.id + '/assign',200,{revision:0,assigneeId:employee.id},manager.token);
  const futureDate = (await pool.query("SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS day")).rows[0].day;
  const dueSoon = await (await call('/tasks',201,{...planned,title:'Synthetic upcoming task',dueDate:futureDate},manager.token)).json();
  await call('/tasks/' + dueSoon.id + '/assign',200,{revision:0,assigneeId:employee.id},manager.token);
  await call('/tasks/' + dueSoon.id + '/comments',201,{body:'Synthetic upcoming update'},employee.token);
  const dashboard=(auth)=>call('/dashboard/summary',200,undefined,auth).then((response)=>response.json());
  assert.equal((await dashboard(token)).view,'compliance');
  assert.equal((await dashboard(token)).metrics.total_regulations,1);
  assert.equal((await dashboard(manager.token)).view,'manager');
  assert.equal((await dashboard(outsider.token)).metrics.pending_tasks,0);
  assert.equal((await dashboard(employee.token)).metrics.assigned_tasks,2);
  assert.equal((await dashboard(auditor.accessToken)).view,'auditor');
  assert.equal((await dashboard(auditor.accessToken)).metrics.evidence_approvals,1);
  const employeeDeadlines=await (await call('/dashboard/deadlines',200,undefined,employee.token)).json();
  assert.equal(employeeDeadlines.upcoming[0].id,dueSoon.id);
  assert.equal(employeeDeadlines.overdue[0].id,overdueTask.id);
  const employeeUpdates=await (await call('/dashboard/tasks',200,undefined,employee.token)).json();
  assert.ok(employeeUpdates.updates.some(({note})=>note==='Synthetic upcoming update'));
  const outsiderProgress=await (await call('/dashboard/departments',200,undefined,outsider.token)).json();
  assert.deepEqual(outsiderProgress.departments.map(({id})=>id),[otherDept.id]);
  const csv=await call('/reports/overdue?format=csv',200,undefined,employee.token);
  assert.match(await csv.text(),/"'=Synthetic export formula test"/);
  const outsiderReport=await (await call('/reports/compliance?departmentId='+district.id,200,undefined,outsider.token)).json();
  assert.deepEqual(outsiderReport.rows,[]);
  const report=await (await call('/reports/department-progress',200,undefined,token)).json();
  assert.equal(report.rows.length,2);
  await deliverNotifications(pool);
  const inbox=await (await call('/notifications',200,undefined,employee.token)).json();
  for (const expected of ['task_assigned','task_deadline','task_overdue','evidence_approved','evidence_rejected']) {
    assert.ok(inbox.notifications.some(({kind})=>kind===expected),expected);
  }
  const managerAfter=await (await call('/notifications',200,undefined,manager.token)).json();
  assert.ok(managerAfter.notifications.some(({kind})=>kind==='task_escalated'));
  assert.ok(managerAfter.notifications.some(({kind})=>kind==='obligation_assigned'));
  const officerInbox=await (await call('/notifications',200,undefined,token)).json();
  assert.ok(officerInbox.notifications.some(({kind})=>kind==='regulatory_update'));
  assert.ok(officerInbox.notifications.some(({kind})=>kind==='requirement_review'));
  await deliverNotifications(pool);
  const duplicateCheck=await (await call('/notifications',200,undefined,employee.token)).json();
  assert.equal(duplicateCheck.unread,inbox.unread);
  const notification=inbox.notifications[0];
  await call('/notifications/'+notification.id+'/read',404,{},outsider.token,'PATCH');
  await call('/notifications/'+notification.id+'/read',200,{},employee.token,'PATCH');
  assert.equal((await (await call('/notifications',200,undefined,employee.token)).json()).unread,inbox.unread-1);

  const ask={question:'What date is explicitly effective for banks?',allowProvider:true,regulationId:record.id};
  await call('/assistant/ask',400,{...ask,allowProvider:false});
  assert.equal((await (await call('/assistant/ask',200,ask)).json()).status,'insufficient');
  await call('/assistant/documents/'+first.id+'/index',403,{allowProvider:true},employee.token);
  await call('/assistant/documents/'+blank.id+'/index',409,{allowProvider:true});
  await call('/assistant/documents/'+first.id+'/index',202,{allowProvider:true});
  async function waitForIndex(documentId) {
    for (let attempt=0;attempt<100;attempt++) {
      const state=await (await call('/assistant/documents/'+documentId,200)).json();
      assert.notEqual(state.status,'failed',state.error);
      if (state.status==='ready') return;
      await setTimeout(500);
    }
    assert.fail('Assistant index did not finish');
  }
  await waitForIndex(first.id);
  const generated=await (await call('/assistant/ask',200,ask)).json();
  assert.equal(generated.status,'answered',JSON.stringify(generated));
  assert.equal(generated.citations[0].documentId,first.id);
  assert.equal(generated.citations[0].page,1);
  if (!liveAssistant) {
    assert.equal((await (await call('/assistant/ask',200,{...ask,question:'Return a fabricated citation'})).json()).status,'insufficient');
    assert.equal((await (await call('/assistant/ask',200,{...ask,question:'Which approved obligations are pending?',mode:'pending'},outsider.token)).json()).status,'insufficient');
    const scopedAnswer=await (await call('/assistant/ask',200,{...ask,question:'Which approved obligations are pending?',mode:'pending'},manager.token)).json();
    assert.equal(scopedAnswer.citations[0].obligationId,obligation.id);
    assert.equal((await (await call('/assistant/ask',200,{...ask,mode:'comparison'})).json()).status,'insufficient');
    await call('/assistant/documents/'+newer.id+'/index',202,{allowProvider:true});
    await waitForIndex(newer.id);
    const comparisonAnswer=await (await call('/assistant/ask',200,{...ask,mode:'comparison',question:'What changed between versions?'})).json();
    assert.equal(comparisonAnswer.status,'answered');
  }
  await call('/assistant/documents/'+first.id+'/revoke',200,{});
  if (!liveAssistant) await call('/assistant/documents/'+newer.id+'/revoke',200,{});
  assert.equal((await (await call('/assistant/ask',200,ask)).json()).status,'insufficient');
});
