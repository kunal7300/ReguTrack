import { createHash,randomUUID } from 'node:crypto';
import { CreateBucketCommand,DeleteObjectCommand,GetObjectCommand,HeadBucketCommand,PutObjectCommand,S3Client } from '@aws-sdk/client-s3';
import { Router, type RequestHandler, type Request, type Response } from 'express';
import multer from 'multer';
import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { requireJson } from '../identity/auth.js';
import { account, type Account,audit,HttpError,id,transaction } from '../identity/store.js';
import { changeStatus,isMaker,lockTask,manages,obScope,scope,taskJoin,taskScope } from '../work/index.js';

const types = { 'application/pdf':/\.pdf$/i,'image/png':/\.png$/i,'image/jpeg':/\.jpe?g$/i };
const upload = multer({ limits:{fileSize:10 * 1024 * 1024,files:1,fields:2,parts:4} });
const note = z.string().trim().min(1).max(3000);
const title = z.string().trim().min(1).max(250);
const auditColumns = 'a.id::text,a.action,a.actor_id,u.name AS actor,a.target_type,a.target_id,a.details,a.created_at';
const auditJoin = 'FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id';

async function readTask(pool: Pool | PoolClient, actor: Account, taskId: string) {
  const { rows:[task] } = await pool.query(`SELECT t.id,t.status,t.revision,t.evidence_submission_revision,t.obligation_id,
    t.submitted_by,o.department_id,a.assignee_id ${taskJoin} WHERE ${taskScope} AND t.id=$6`,[...scope(actor),taskId]);
  if (!task) throw new HttpError(404,'Task not found');
  return task;
}

async function evidenceTask(pool: Pool, actor: Account, evidenceId: string) {
  const { rows:[record] } = await pool.query(`SELECT e.* ${taskJoin}
    JOIN evidence e ON e.task_id=t.id WHERE ${taskScope} AND e.id=$6`,[...scope(actor),evidenceId]);
  if (!record) throw new HttpError(404,'Evidence not found');
  return record;
}

function canUpload(task: {assignee_id:string;department_id:string;status:string}, actor: Account) {
  return task.assignee_id === actor.id && task.department_id === actor.departmentId &&
    ['in_progress','rejected'].includes(task.status);
}

export function createEvidence(pool: Pool, config: {
  endpoint:string;accessKeyId:string;secretAccessKey:string;aiUrl:string;token:string;bucket?:string;
}, authenticate: RequestHandler) {
  const api = Router();
  const Bucket = config.bucket ?? 'task-evidence';
  const store = new S3Client({ endpoint:config.endpoint,region:'us-east-1',forcePathStyle:true,
    credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey} });

  async function ensureBucket() {
    try { await store.send(new HeadBucketCommand({Bucket})); }
    catch (error) {
      if ((error as { $metadata?:{httpStatusCode?:number} }).$metadata?.httpStatusCode !== 404) throw error;
      try { await store.send(new CreateBucketCommand({Bucket})); }
      catch (creationError) {
        if (!(creationError instanceof Error) || creationError.name !== 'BucketAlreadyOwnedByYou') throw creationError;
      }
    }
  }

  const uploader: RequestHandler = async (req,res,next) => {
    const actor = account.parse(res.locals.user);
    const task = await readTask(pool,actor,id.parse(req.params.id));
    if (!canUpload(task,actor)) throw new HttpError(403,'Assigned employees can upload while working or resubmitting');
    next();
  };

  api.post('/tasks/:id/evidence',authenticate,uploader,upload.single('file'),async (req:Request,res:Response) => {
    const taskId = id.parse(req.params.id);
    const actor = account.parse(res.locals.user);
    const input = z.union([z.strictObject({title}),z.strictObject({evidenceId:id})]).parse(req.body);
    const file = req.file;
    const mime = file?.mimetype as keyof typeof types | undefined;
    if (!file?.size || !mime || !Object.hasOwn(types,mime) || !types[mime].test(file.originalname))
      throw new HttpError(400,'Select a PDF, PNG, or JPEG file');
    let validation;
    try {
      validation = await fetch(new URL('/internal/evidence/validate',config.aiUrl),{
        method:'POST',headers:{'Content-Type':mime,Authorization:'Bearer ' + config.token},
        body:Buffer.from(file.buffer),signal:AbortSignal.timeout(12_000),
      });
    } catch { throw new HttpError(503,'Evidence validator is unavailable'); }
    if (validation.status === 422) throw new HttpError(422,'Evidence is damaged, encrypted, or exceeds file limits');
    if (!validation.ok) throw new HttpError(503,'Evidence validator is unavailable');

    const hash = createHash('sha256').update(file.buffer).digest('hex');
    const key = randomUUID();
    const filename = file.originalname.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,250);
    await ensureBucket();
    await store.send(new PutObjectCommand({Bucket,Key:key,Body:file.buffer,ContentType:mime}));
    let result;
    try {
      result = await transaction(pool,async (db) => {
        const task = await lockTask(db,taskId,actor);
        if (!canUpload(task,actor)) throw new HttpError(403,'Evidence can no longer be uploaded to this task');
        let evidenceId;
        if ('evidenceId' in input) {
          if (!(await db.query('SELECT 1 FROM evidence WHERE id=$1 AND task_id=$2',[input.evidenceId,taskId])).rowCount)
            throw new HttpError(404,'Evidence record not found for this task');
          evidenceId = input.evidenceId;
        } else {
          const { rows:[created] } = await db.query('INSERT INTO evidence(task_id,title,created_by) VALUES ($1,$2,$3) RETURNING id',
            [taskId,input.title,actor.id]);
          evidenceId = created.id;
        }
        if ((await db.query(`SELECT 1 FROM evidence_versions v JOIN evidence e ON e.id=v.evidence_id
          WHERE e.task_id=$1 AND v.sha256=$2`,[taskId,hash])).rowCount)
          throw new HttpError(409,'This file is already attached to the task');
        const { rows:[version] } = await db.query(`INSERT INTO evidence_versions(evidence_id,number,filename,mime,bytes,sha256,object_key,uploaded_by)
          SELECT $1,COALESCE(max(number),0)+1,$2,$3,$4,$5,$6,$7 FROM evidence_versions WHERE evidence_id=$1 RETURNING id,number`,
          [evidenceId,filename,mime,file.size,hash,key,actor.id]);
        await audit(db,actor.id,'evidence.uploaded','evidence',evidenceId,{
          taskId,versionId:version.id,previous:version.number > 1 ? {version:version.number-1} : null,
          current:{version:version.number,filename,sha256:hash,bytes:file.size},
        });
        return {id:evidenceId,versionId:version.id,number:version.number};
      });
    } catch (error) {
      if (error instanceof HttpError || (typeof error === 'object' && error !== null && 'code' in error &&
          typeof error.code === 'string' && error.code.startsWith('23'))) {
        await store.send(new DeleteObjectCommand({Bucket,Key:key})).catch(() => console.error('Evidence cleanup failed'));
      }
      throw error;
    }
    res.status(201).json(result);
  });

  api.get('/tasks/:id/evidence',authenticate,async (req,res) => {
    const taskId = id.parse(req.params.id);
    const actor = account.parse(res.locals.user);
    const task = await readTask(pool,actor,taskId);
    const { rows } = await pool.query(`SELECT e.id,e.title,e.created_at,v.id AS latest_version_id,v.number,v.filename,
      v.submission_revision,a.decision FROM evidence e
      JOIN LATERAL (SELECT * FROM evidence_versions x WHERE x.evidence_id=e.id ORDER BY number DESC LIMIT 1) v ON true
      LEFT JOIN approvals a ON a.evidence_version_id=v.id WHERE e.task_id=$1 ORDER BY e.created_at DESC,e.id`,[taskId]);
    res.json({ evidence:rows,canUpload:canUpload(task,actor),submissionRevision:task.evidence_submission_revision });
  });
  api.get('/evidence/:id',authenticate,async (req,res) => {
    const actor = account.parse(res.locals.user);
    const record = await evidenceTask(pool,actor,id.parse(req.params.id));
    const task = await readTask(pool,actor,record.task_id);
    const { rows } = await pool.query(`SELECT v.id,v.number,v.filename,v.mime,v.bytes,v.sha256,v.uploaded_by,
      v.created_at,v.submission_revision,up.name AS uploader,a.reviewer_id,r.name AS reviewer,
      a.decision,a.comment,a.created_at AS reviewed_at FROM evidence_versions v
      JOIN users up ON up.id=v.uploaded_by LEFT JOIN approvals a ON a.evidence_version_id=v.id
      LEFT JOIN users r ON r.id=a.reviewer_id WHERE v.evidence_id=$1 ORDER BY v.number DESC`,[record.id]);
    res.json({ ...record,versions:rows,taskRevision:task.revision,
      canReview:task.status === 'under_review' && manages(actor,task.department_id) && !(await isMaker(pool,task,actor)),
      submissionRevision:task.evidence_submission_revision });
  });
  api.get('/evidence/:id/download',authenticate,async (req,res) => {
    const actor = account.parse(res.locals.user);
    const record = await evidenceTask(pool,actor,id.parse(req.params.id));
    const { versionId } = z.strictObject({versionId:id}).parse(req.query);
    const { rows:[version] } = await pool.query('SELECT object_key,filename,mime FROM evidence_versions WHERE id=$1 AND evidence_id=$2',
      [versionId,record.id]);
    if (!version) throw new HttpError(404,'Evidence version not found');
    const file = await store.send(new GetObjectCommand({Bucket,Key:version.object_key}));
    if (!file.Body) throw new HttpError(404,'Stored evidence not found');
    await audit(pool,actor.id,'evidence.downloaded','evidence',record.id,{taskId:record.task_id,versionId});
    res.attachment(version.filename).type(version.mime).set('X-Content-Type-Options','nosniff')
      .send(Buffer.from(await file.Body.transformToByteArray()));
  });

  function decision(action: 'approved' | 'rejected'): RequestHandler {
    return async (req,res) => {
      const actor = account.parse(res.locals.user);
      const record = await evidenceTask(pool,actor,id.parse(req.params.id));
      const input = z.strictObject({versionId:id,revision:z.number().int().nonnegative(),comment:note}).parse(req.body);
      await transaction(pool,async (db) => {
        const task = await lockTask(db,record.task_id,actor,input.revision);
        if (!manages(actor,task.department_id) || await isMaker(db,task,actor)) throw new HttpError(403,'An independent reviewer is required');
        if (task.status !== 'under_review' || task.evidence_submission_revision === null)
          throw new HttpError(409,'Start reviewing the task before deciding evidence');
        const { rows:[version] } = await db.query('SELECT * FROM evidence_versions WHERE id=$1 AND evidence_id=$2',[input.versionId,record.id]);
        if (!version) throw new HttpError(404,'Evidence version not found');
        if (version.uploaded_by === actor.id) throw new HttpError(403,'You cannot review evidence you uploaded');
        if (version.submission_revision !== task.evidence_submission_revision) throw new HttpError(409,'Evidence is outside the current submission');
        const { rows:[approval] } = await db.query(`INSERT INTO approvals(evidence_version_id,reviewer_id,decision,comment)
          VALUES ($1,$2,$3,$4) ON CONFLICT(evidence_version_id) DO NOTHING RETURNING id`,
          [version.id,actor.id,action,input.comment]);
        if (!approval) throw new HttpError(409,'This evidence version already has a decision');
        await db.query('UPDATE compliance_tasks SET revision=revision+1,status=$2 WHERE id=$1',[task.id,action==='rejected' ? 'rejected' : task.status]);
        if (action === 'rejected') await changeStatus(db,task,'rejected',actor,input.comment);
        await audit(db,actor.id,'evidence.'+action,'evidence',record.id,{
          taskId:task.id,versionId:version.id,approvalId:approval.id,previous:'pending',current:action,comment:input.comment,
        });
      });
      res.json({id:record.id,decision:action});
    };
  }
  api.post('/evidence/:id/approve',authenticate,requireJson(),decision('approved'));
  api.post('/evidence/:id/reject',authenticate,requireJson(),decision('rejected'));

  api.get('/audit-logs',authenticate,async (req,res) => {
    const actor = account.parse(res.locals.user);
    if (!actor.permissions.includes('audit.read')) throw new HttpError(403,'Permission required');
    const input = z.strictObject({
      before:z.string().regex(/^[1-9][0-9]{0,18}$/).refine((value)=>BigInt(value)<=9223372036854775807n).optional(),
      targetId:id.optional(),action:z.string().trim().min(1).max(120).optional(),
    }).parse(req.query);
    const { rows } = await pool.query(`SELECT ${auditColumns} ${auditJoin}
      WHERE ($1::bigint IS NULL OR a.id<$1) AND ($2::uuid IS NULL OR a.target_id=$2)
      AND ($3::text IS NULL OR a.action=$3) ORDER BY a.id DESC LIMIT 51`,
      [input.before ?? null,input.targetId ?? null,input.action ?? null]);
    res.json({events:rows.slice(0,50),next:rows.length>50 ? rows[49].id : null});
  });
  const lineageSql = `FROM compliance_obligations o JOIN regulatory_requirements q ON q.id=o.requirement_id
    JOIN ai_analysis_runs ar ON ar.id=q.run_id JOIN documents d ON d.id=ar.document_id
    JOIN regulation_versions v ON v.id=d.version_id`;
  api.get('/obligations/:id/history',authenticate,async (req,res) => {
    const actor = account.parse(res.locals.user);
    const obligationId = id.parse(req.params.id);
    const { rows:[record] } = await pool.query(`SELECT o.id,o.requirement_id,o.gap_id,o.approved_by,o.created_by,v.regulation_id,
      ar.document_id ${lineageSql} WHERE ${obScope} AND o.id=$6`,[...scope(actor),obligationId]);
    if (!record) throw new HttpError(404,'Obligation not found');
    const { rows } = await pool.query(`SELECT ${auditColumns} ${auditJoin} WHERE a.target_type='obligation'
      AND a.target_id=$1 ORDER BY a.id DESC LIMIT 100`,[obligationId]);
    res.json({lineage:record,events:rows});
  });
  api.get('/tasks/:id/history',authenticate,async (req,res) => {
    const actor = account.parse(res.locals.user);
    const task = await readTask(pool,actor,id.parse(req.params.id));
    const [events,lineage] = await Promise.all([
      pool.query(`SELECT ${auditColumns} ${auditJoin} WHERE (a.target_type='task' AND a.target_id=$1)
        OR (a.target_type='evidence' AND EXISTS(SELECT 1 FROM evidence e WHERE e.id=a.target_id AND e.task_id=$1))
        ORDER BY a.id DESC LIMIT 100`,[task.id]),
      pool.query(`SELECT o.requirement_id,o.gap_id,v.regulation_id,ar.document_id ${lineageSql} WHERE o.id=$1`,[task.obligation_id]),
    ]);
    res.json({lineage:{...lineage.rows[0],obligation_id:task.obligation_id,assignee_id:task.assignee_id,
      submitted_by:task.submitted_by},events:events.rows});
  });
  return {router:api,close:() => store.destroy()};
}
