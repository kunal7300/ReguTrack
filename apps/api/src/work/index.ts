import { Router, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { requireJson } from '../identity/auth.js';
import { account, type Account, audit, HttpError, id, transaction } from '../identity/store.js';

const title = z.string().trim().min(1).max(250);
const description = z.string().trim().min(1).max(3000);
const date = z.iso.date();
const revision = z.number().int().nonnegative();
const offset = z.coerce.number().int().min(0).max(100000).default(0);
const taskStatus = z.enum(['created','assigned','in_progress','evidence_submitted','under_review',
  'rejected','verified','completed','blocked','cancelled']);
const workDate = "(now() AT TIME ZONE 'Asia/Kolkata')::date";
const obligationFields = z.strictObject({
  title, description, departmentId:id, accountableId:id, targetDate:date,
  priority:z.enum(['low','medium','high','critical']), applicability:title.nullable(),
});
const taskFields = z.strictObject({ title,description,dueDate:date });
const editTask = taskFields.partial().extend({
  revision, action:z.enum(['start','block','resume','cancel','complete']).optional(), reason:description.optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'revision' && key !== 'reason'));
const has = (actor: Account, permission: string) => actor.permissions.includes('work.' + permission);
export const manages = (actor: Account, departmentId: string) => has(actor,'manage_obligations') ||
  (has(actor,'manage_department') && actor.departmentId === departmentId);
export const scope = (actor: Account) => [has(actor,'read_all'), has(actor,'read_department'),
  actor.departmentId, has(actor,'read_assigned'),actor.id];
export const taskScope = '($1::boolean OR (o.department_id=$3::uuid AND ($2::boolean OR ($4::boolean AND a.assignee_id=$5::uuid))))';
export const obScope = `($1::boolean OR (o.department_id=$3::uuid AND ($2::boolean OR ($4::boolean AND (o.accountable_id=$5::uuid OR EXISTS (
  SELECT 1 FROM compliance_tasks st JOIN task_assignments sa ON sa.task_id=st.id AND sa.ended_at IS NULL
  WHERE st.obligation_id=o.id AND sa.assignee_id=$5::uuid))))))`;
const obFields = `o.*,o.target_date::text AS target_date,d.name AS department_name,u.name AS accountable_name,
  CASE WHEN EXISTS (SELECT 1 FROM compliance_tasks t WHERE t.obligation_id=o.id AND t.status='blocked') THEN 'blocked'
       WHEN NOT EXISTS (SELECT 1 FROM compliance_tasks t WHERE t.obligation_id=o.id AND t.status<>'cancelled') THEN 'not_started'
       WHEN NOT EXISTS (SELECT 1 FROM compliance_tasks t WHERE t.obligation_id=o.id AND t.status NOT IN ('completed','cancelled')) THEN 'completed'
       WHEN EXISTS (SELECT 1 FROM compliance_tasks t WHERE t.obligation_id=o.id AND t.status NOT IN ('created','assigned','cancelled')) THEN 'in_progress'
       ELSE 'not_started' END AS implementation_status`;
const obJoin = 'FROM compliance_obligations o JOIN departments d ON d.id=o.department_id JOIN users u ON u.id=o.accountable_id';
export const taskJoin = `FROM compliance_tasks t JOIN compliance_obligations o ON o.id=t.obligation_id
  JOIN departments d ON d.id=o.department_id LEFT JOIN task_assignments a ON a.task_id=t.id AND a.ended_at IS NULL
  LEFT JOIN users u ON u.id=a.assignee_id`;
const taskFieldsSql = `t.*,t.due_date::text AS due_date,o.department_id,o.title AS obligation_title,d.name AS department_name,
  a.assignee_id,u.name AS assignee_name,(t.due_date<${workDate} AND t.status NOT IN ('completed','cancelled')) AS overdue`;

async function activeMember(db: PoolClient, userId: string, departmentId: string) {
  const { rowCount } = await db.query('SELECT 1 FROM users WHERE id=$1 AND department_id=$2 AND active FOR SHARE',[userId,departmentId]);
  if (!rowCount) throw new HttpError(400,'Select an active user from the responsible department');
}

export async function lockTask(db: PoolClient, taskId: string, actor: Account, expected?: number) {
  const parameters = [...scope(actor),taskId];
  const where = `${taskJoin} WHERE ${taskScope} AND t.id=$6`;
  const locked = await db.query(`SELECT t.id ${where} FOR UPDATE OF t`,parameters);
  if (!locked.rowCount) throw new HttpError(404,'Task not found');
  const { rows: [task] } = await db.query(
    `SELECT ${taskFieldsSql} ${where}`,parameters);
  if (!task) throw new HttpError(404,'Task not found');
  if (expected !== undefined && expected !== task.revision) throw new HttpError(409,'Task changed. Reload before updating.');
  return task;
}

async function deadlineHistory(pool: Pool, target: string, action: 'task.updated' | 'obligation.updated',
  oldKey: string, newKey: string) {
  const { rows } = await pool.query(`SELECT a.id::text,a.created_at,u.name AS actor,
    a.details->>$3 AS previous,a.details->>$4 AS current,a.details->>'reason' AS reason
    FROM audit_logs a JOIN users u ON u.id=a.actor_id
    WHERE a.target_id=$1 AND a.action=$2 AND a.details ? $3 ORDER BY a.id DESC LIMIT 100`,
    [target,action,oldKey,newKey]);
  return rows;
}

async function isObligationMaker(db: Pool | PoolClient,
  record: {id:string;created_by:string;edited_by:string}, actor: Account) {
  if ([record.created_by,record.edited_by].includes(actor.id)) return true;
  const edited = await db.query(
    "SELECT 1 FROM audit_logs WHERE target_id=$1 AND actor_id=$2 AND action='obligation.updated' LIMIT 1",
    [record.id,actor.id]);
  return Boolean(edited.rowCount);
}

export async function changeStatus(db: PoolClient, task: {id:string;status:string}, to: string, actor: Account, reason?: string) {
  await db.query('INSERT INTO task_status_history(task_id,actor_id,from_status,to_status,reason) VALUES ($1,$2,$3,$4,$5)',
    [task.id,actor.id,task.status,to,reason ?? null]);
  await audit(db,actor.id,'task.status_changed','task',task.id,{ from:task.status,to,reason:reason ?? null });
}

function requireReason(value: string | undefined) {
  if (!value) throw new HttpError(400,'A reason is required');
  return value;
}

export function createWork(pool: Pool, authenticate: RequestHandler) {
  const api = Router();
  const managerOnly: RequestHandler = (_req,res,next) => {
    if (!has(account.parse(res.locals.user),'manage_obligations')) throw new HttpError(403,'Permission required');
    next();
  };
  const canRead: RequestHandler = (_req,res,next) => {
    const actor = account.parse(res.locals.user);
    if (!['read_all','read_department','read_assigned'].some((permission) => has(actor,permission)))
      throw new HttpError(403,'Permission required');
    next();
  };

  api.get('/work/eligible-users',authenticate,async (req,res) => {
    const actor = account.parse(res.locals.user);
    const { departmentId } = z.strictObject({ departmentId:id }).parse(req.query);
    if (!manages(actor,departmentId)) throw new HttpError(403,'Permission required');
    const { rows } = await pool.query('SELECT id,name FROM users WHERE department_id=$1 AND active ORDER BY name,id',[departmentId]);
    res.json({ users:rows });
  });
  api.get('/obligations',authenticate,canRead,async (req,res) => {
    const actor = account.parse(res.locals.user);
    const filter = z.strictObject({ offset,requirementId:id.optional(),gapId:id.optional() }).parse(req.query);
    const { rows } = await pool.query(`SELECT ${obFields} ${obJoin} WHERE ${obScope}
      AND ($6::uuid IS NULL OR o.requirement_id=$6) AND ($7::uuid IS NULL OR o.gap_id=$7)
      ORDER BY o.created_at DESC,o.id LIMIT 26 OFFSET $8`,[...scope(actor),filter.requirementId ?? null,filter.gapId ?? null,filter.offset]);
    res.json({ obligations:rows.slice(0,25),hasMore:rows.length>25 });
  });
  api.get('/obligations/:id',authenticate,canRead,async (req,res) => {
    const actor = account.parse(res.locals.user);
    const { rows:[record] } = await pool.query(`SELECT ${obFields},q.human_result->>'title' AS requirement_title,
      v.regulation_id,g.remediation ${obJoin} JOIN regulatory_requirements q ON q.id=o.requirement_id
      JOIN ai_analysis_runs ar ON ar.id=q.run_id JOIN documents doc ON doc.id=ar.document_id
      JOIN regulation_versions v ON v.id=doc.version_id LEFT JOIN compliance_gaps g ON g.id=o.gap_id
      WHERE ${obScope} AND o.id=$6`,[...scope(actor),id.parse(req.params.id)]);
    if (!record) throw new HttpError(404,'Obligation not found');
    const canApprove = record.approval_state === 'draft' && has(actor,'manage_obligations') &&
      !(await isObligationMaker(pool,record,actor));
    res.json({ ...record,canApprove,
      deadlineHistory:await deadlineHistory(pool,record.id,'obligation.updated','oldTargetDate','newTargetDate') });
  });
  api.post('/obligations',authenticate,managerOnly,requireJson(),async (req,res) => {
    const input = obligationFields.extend({ requirementId:id,gapId:id.nullable().optional() }).parse(req.body);
    const actor = account.parse(res.locals.user);
    const record = await transaction(pool,async (db) => {
      const { rows:[requirement] } = await db.query('SELECT status FROM regulatory_requirements WHERE id=$1',[input.requirementId]);
      if (!requirement) throw new HttpError(404,'Requirement not found');
      if (requirement.status !== 'approved') throw new HttpError(409,'Approve the requirement before creating an obligation');
      if (input.gapId && !(await db.query(`SELECT 1 FROM compliance_gaps WHERE id=$1 AND requirement_id=$2
          AND decision='approved' AND remediation IS NOT NULL`,[input.gapId,input.requirementId])).rowCount)
        throw new HttpError(409,'Select a validated remediation for this requirement');
      await activeMember(db,input.accountableId,input.departmentId);
      const { rows:[created] } = await db.query(`INSERT INTO compliance_obligations(requirement_id,gap_id,title,description,
        department_id,accountable_id,target_date,priority,applicability,created_by,edited_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
        [input.requirementId,input.gapId ?? null,input.title,input.description,input.departmentId,input.accountableId,
          input.targetDate,input.priority,input.applicability,actor.id]);
      await audit(db,actor.id,'obligation.created','obligation',created.id,{previous:null,current:{...input,approvalState:'draft'}});
      return created;
    });
    res.status(201).json(record);
  });
  api.patch('/obligations/:id',authenticate,managerOnly,requireJson(),async (req,res) => {
    const obligationId = id.parse(req.params.id);
    const input = z.union([
      z.strictObject({ revision,action:z.literal('approve') }),
      obligationFields.omit({ departmentId:true }).partial().extend({ revision,reason:description.optional() })
        .refine((value) => Object.keys(value).some((key) => !['revision','reason'].includes(key))),
    ]).parse(req.body);
    const actor = account.parse(res.locals.user);
    await transaction(pool,async (db) => {
      const { rows:[record] } = await db.query('SELECT *,target_date::text AS target_date FROM compliance_obligations WHERE id=$1 FOR UPDATE',[obligationId]);
      if (!record) throw new HttpError(404,'Obligation not found');
      if (record.revision !== input.revision) throw new HttpError(409,'Obligation changed. Reload before updating.');
      if ('action' in input) {
        if (record.approval_state !== 'draft') throw new HttpError(409,'Obligation is already approved');
        if (await isObligationMaker(db,record,actor)) throw new HttpError(403,'Another officer must approve this obligation');
        await activeMember(db,record.accountable_id,record.department_id);
        await db.query(`UPDATE compliance_obligations SET approval_state='approved',approved_by=$2,
          approved_at=now(),revision=revision+1 WHERE id=$1`,[obligationId,actor.id]);
        await audit(db,actor.id,'obligation.approved','obligation',obligationId,{previous:'draft',current:'approved'});
        return;
      }
      if (input.accountableId) await activeMember(db,input.accountableId,record.department_id);
      const dateChanged = input.targetDate !== undefined && input.targetDate !== record.target_date;
      if (dateChanged) requireReason(input.reason);
      if (record.approval_state === 'approved' &&
          [input.title,input.description,input.applicability,input.priority,input.accountableId].some((value) => value !== undefined))
        throw new HttpError(409,'Only the target date can be amended after approval');
      await db.query(`UPDATE compliance_obligations SET title=$2,description=$3,accountable_id=$4,target_date=$5,
        priority=$6,applicability=$7,edited_by=$8,revision=revision+1 WHERE id=$1`,[
        obligationId,input.title ?? record.title,input.description ?? record.description,input.accountableId ?? record.accountable_id,
        input.targetDate ?? record.target_date,input.priority ?? record.priority,
        input.applicability === undefined ? record.applicability : input.applicability,actor.id,
      ]);
      await audit(db,actor.id,'obligation.updated','obligation',obligationId,{
        fields:Object.keys(input).filter((key) => !['revision','reason'].includes(key)),
        previous:{title:record.title,description:record.description,accountableId:record.accountable_id,
          targetDate:record.target_date,priority:record.priority,applicability:record.applicability},
        current:{title:input.title ?? record.title,description:input.description ?? record.description,
          accountableId:input.accountableId ?? record.accountable_id,targetDate:input.targetDate ?? record.target_date,
          priority:input.priority ?? record.priority,
          applicability:input.applicability === undefined ? record.applicability : input.applicability},
        ...(dateChanged ? { oldTargetDate:record.target_date,newTargetDate:input.targetDate,reason:input.reason } : {}),
      });
    });
    res.json({ id:obligationId });
  });

  api.get('/tasks',authenticate,canRead,async (req,res) => {
    const actor = account.parse(res.locals.user);
    const input = z.strictObject({
      offset,obligationId:id.optional(),departmentId:id.optional(),
      mine:z.enum(['true','false']).default('false'),overdue:z.enum(['true','false']).default('false'),status:taskStatus.optional(),
    }).parse(req.query);
    const { rows } = await pool.query(`SELECT ${taskFieldsSql} ${taskJoin} WHERE ${taskScope}
      AND ($6::uuid IS NULL OR t.obligation_id=$6) AND ($7::uuid IS NULL OR o.department_id=$7)
      AND (NOT $8::boolean OR a.assignee_id=$5) AND (NOT $9::boolean OR (t.due_date<${workDate} AND t.status NOT IN ('completed','cancelled')))
      AND ($10::text IS NULL OR t.status=$10) ORDER BY t.due_date,t.id LIMIT 26 OFFSET $11`,
      [...scope(actor),input.obligationId ?? null,input.departmentId ?? null,input.mine==='true',input.overdue==='true',input.status ?? null,input.offset]);
    res.json({ tasks:rows.slice(0,25),hasMore:rows.length>25 });
  });
  api.get('/tasks/:id',authenticate,canRead,async (req,res) => {
    const actor = account.parse(res.locals.user);
    const taskId = id.parse(req.params.id);
    const { rows:[task] } = await pool.query(`SELECT ${taskFieldsSql} ${taskJoin} WHERE ${taskScope} AND t.id=$6`,[...scope(actor),taskId]);
    if (!task) throw new HttpError(404,'Task not found');
    const [comments,history,assignments,maker,deadlines] = await Promise.all([
      pool.query(`SELECT c.id,c.body,c.created_at,u.name AS author FROM task_comments c JOIN users u ON u.id=c.author_id
        WHERE c.task_id=$1 ORDER BY c.created_at DESC,c.id LIMIT 100`,[taskId]),
      pool.query(`SELECT h.id::text,h.from_status,h.to_status,h.reason,h.created_at,u.name AS actor FROM task_status_history h
        JOIN users u ON u.id=h.actor_id WHERE h.task_id=$1 ORDER BY h.id DESC LIMIT 100`,[taskId]),
      pool.query(`SELECT a.id,a.assigned_at,a.ended_at,u.name AS assignee,b.name AS assigned_by FROM task_assignments a
        JOIN users u ON u.id=a.assignee_id JOIN users b ON b.id=a.assigned_by WHERE a.task_id=$1 ORDER BY a.assigned_at DESC LIMIT 100`,[taskId]),
      isMaker(pool,task,actor),
      deadlineHistory(pool,taskId,'task.updated','oldDueDate','newDueDate'),
    ]);
    res.json({ ...task,comments:comments.rows,history:history.rows,assignments:assignments.rows,
      deadlineHistory:deadlines,canReview:manages(actor,task.department_id) && !maker });
  });
  api.post('/tasks',authenticate,canRead,requireJson(),async (req,res) => {
    const actor = account.parse(res.locals.user);
    const input = taskFields.extend({obligationId:id}).parse(req.body);
    const task = await transaction(pool,async (db) => {
      const { rows:[obligation] } = await db.query(`SELECT department_id,approval_state FROM compliance_obligations
         o WHERE ${obScope} AND id=$6 FOR SHARE`,[...scope(actor),input.obligationId]);
      if (!obligation) throw new HttpError(404,'Obligation not found');
      if (!manages(actor,obligation.department_id)) throw new HttpError(403,'Permission required');
      if (obligation.approval_state !== 'approved') throw new HttpError(409,'Approve the obligation before creating tasks');
      const { rows:[record] } = await db.query(`INSERT INTO compliance_tasks(obligation_id,title,description,due_date,created_by)
        VALUES ($1,$2,$3,$4,$5) RETURNING id`,[input.obligationId,input.title,input.description,input.dueDate,actor.id]);
      await db.query("INSERT INTO task_status_history(task_id,actor_id,to_status) VALUES ($1,$2,'created')",[record.id,actor.id]);
      await audit(db,actor.id,'task.created','task',record.id,{previous:null,current:{...input,status:'created'}});
      return record;
    });
    res.status(201).json(task);
  });

  api.patch('/tasks/:id',authenticate,canRead,requireJson(),async (req,res) => {
    const actor = account.parse(res.locals.user);
    const taskId = id.parse(req.params.id);
    const input = editTask.parse(req.body);
    await transaction(pool,async (db) => {
      const task = await lockTask(db,taskId,actor,input.revision);
      const manage = manages(actor,task.department_id);
      const assigned = task.assignee_id === actor.id && actor.departmentId === task.department_id;
      const metadata = [input.title,input.description,input.dueDate].some((value) => value !== undefined);
      if (!manage && !(assigned && input.action === 'start' && !metadata)) throw new HttpError(403,'Permission required');
      if (['completed','cancelled'].includes(task.status)) throw new HttpError(409,'Task is closed');
      if (metadata && ['evidence_submitted','under_review','verified'].includes(task.status))
        throw new HttpError(409,'Task details are locked during and after review');
      const changingDeadline = input.dueDate !== undefined && input.dueDate !== task.due_date;
      if (changingDeadline) requireReason(input.reason);
      let next = task.status;
      let blockedFrom = task.blocked_from;
      if (input.action === 'start' && assigned && ['assigned','rejected'].includes(task.status)) next='in_progress';
      else if (input.action === 'block' && manage && ['assigned','in_progress','rejected'].includes(task.status)) {
        requireReason(input.reason);
        next='blocked'; blockedFrom=task.status;
      } else if (input.action === 'resume' && manage && task.status==='blocked' && task.blocked_from) {
        requireReason(input.reason);
        next=task.blocked_from; blockedFrom=null;
      } else if (input.action === 'cancel' && manage && !['verified','completed'].includes(task.status)) {
        requireReason(input.reason);
        next='cancelled'; blockedFrom=null;
      } else if (input.action === 'complete' && manage && task.status==='verified') next='completed';
      else if (input.action) throw new HttpError(409,'This action is not available for the current task state');
      await db.query(`UPDATE compliance_tasks SET title=$2,description=$3,due_date=$4,status=$5,blocked_from=$6,revision=revision+1
        WHERE id=$1`,[taskId,input.title ?? task.title,input.description ?? task.description,input.dueDate ?? task.due_date,next,blockedFrom]);
      if (next !== task.status) await changeStatus(db,task,next,actor,input.reason);
      if (metadata) await audit(db,actor.id,'task.updated','task',taskId,{
        fields:Object.keys(input).filter((key) => !['revision','reason','action'].includes(key)),
        previous:{title:task.title,description:task.description,dueDate:task.due_date},
        current:{title:input.title ?? task.title,description:input.description ?? task.description,dueDate:input.dueDate ?? task.due_date},
        ...(changingDeadline ? { oldDueDate:task.due_date,newDueDate:input.dueDate,reason:input.reason } : {}),
      });
    });
    res.json({ id:taskId });
  });

  api.post('/tasks/:id/assign',authenticate,canRead,requireJson(),async (req,res) => {
    const actor = account.parse(res.locals.user);
    const taskId = id.parse(req.params.id);
    const input = z.strictObject({ revision,assigneeId:id }).parse(req.body);
    await transaction(pool,async (db) => {
      const task = await lockTask(db,taskId,actor,input.revision);
      if (!manages(actor,task.department_id)) throw new HttpError(403,'Permission required');
      if (!['created','assigned','in_progress','rejected','blocked'].includes(task.status)) throw new HttpError(409,'Task cannot be assigned in this state');
      await activeMember(db,input.assigneeId,task.department_id);
      if (input.assigneeId === task.assignee_id) return;
      await db.query('UPDATE task_assignments SET ended_at=now() WHERE task_id=$1 AND ended_at IS NULL',[taskId]);
      await db.query('INSERT INTO task_assignments(task_id,assignee_id,assigned_by) VALUES ($1,$2,$3)',[taskId,input.assigneeId,actor.id]);
      const next = task.status === 'created' ? 'assigned' : task.status;
      await db.query('UPDATE compliance_tasks SET status=$2,revision=revision+1 WHERE id=$1',[taskId,next]);
      if (next !== task.status) await changeStatus(db,task,next,actor);
      await audit(db,actor.id,'task.assigned','task',taskId,{ before:task.assignee_id,after:input.assigneeId });
    });
    res.json({ id:taskId });
  });

  api.post('/tasks/:id/comments',authenticate,canRead,requireJson(),async (req,res) => {
    const actor = account.parse(res.locals.user);
    const taskId = id.parse(req.params.id);
    const { body } = z.strictObject({ body:description }).parse(req.body);
    const created = await transaction(pool,async (db) => {
      const task = await lockTask(db,taskId,actor);
      if (!manages(actor,task.department_id) && !(task.assignee_id===actor.id && actor.departmentId===task.department_id))
        throw new HttpError(403,'Permission required');
      const { rows:[comment] } = await db.query('INSERT INTO task_comments(task_id,author_id,body) VALUES ($1,$2,$3) RETURNING id',[taskId,actor.id,body]);
      await audit(db,actor.id,'task.commented','task',taskId,{ commentId:comment.id });
      return comment;
    });
    res.status(201).json(created);
  });

  api.post('/tasks/:id/submit',authenticate,canRead,requireJson(),async (req,res) => {
    const actor = account.parse(res.locals.user);
    const taskId = id.parse(req.params.id);
    const { revision:expected,note } = z.strictObject({ revision,note:description }).parse(req.body);
    await transaction(pool,async (db) => {
      const task = await lockTask(db,taskId,actor,expected);
      if (task.assignee_id !== actor.id || actor.departmentId !== task.department_id) throw new HttpError(403,'Only the assigned employee can submit work');
      if (!['in_progress','rejected'].includes(task.status)) throw new HttpError(409,'Task cannot be submitted in this state');
      const rejected = await db.query(`SELECT 1 FROM evidence e
        JOIN LATERAL (SELECT id FROM evidence_versions v WHERE v.evidence_id=e.id ORDER BY number DESC LIMIT 1) v ON true
        JOIN approvals a ON a.evidence_version_id=v.id WHERE e.task_id=$1 AND a.decision='rejected' LIMIT 1`,[taskId]);
      if (rejected.rowCount) throw new HttpError(409,'Upload a new version for each rejected evidence record');
      const nextRevision = task.revision + 1;
      const evidence = await db.query(`UPDATE evidence_versions v SET submission_revision=$2
        FROM evidence e WHERE e.task_id=$1 AND e.id=v.evidence_id AND v.uploaded_by=$3
        AND v.number=(SELECT max(latest.number) FROM evidence_versions latest WHERE latest.evidence_id=e.id)
        AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.evidence_version_id=v.id)`,
        [taskId,nextRevision,actor.id]);
      if (!evidence.rowCount) throw new HttpError(409,'Upload at least one new or pending evidence file before submitting');
      await db.query(`UPDATE compliance_tasks SET status='evidence_submitted',submitted_by=$2,submission_note=$3,
        revision=$4,evidence_submission_revision=$4 WHERE id=$1`,[taskId,actor.id,note,nextRevision]);
      await changeStatus(db,task,'evidence_submitted',actor,note);
    });
    res.json({ id:taskId });
  });

  api.post('/tasks/:id/verify',authenticate,canRead,requireJson(),async (req,res) => {
    const actor = account.parse(res.locals.user);
    const taskId = id.parse(req.params.id);
    const { revision:expected,decision,note } = z.strictObject({
      revision,decision:z.enum(['start_review','verify','reject']),note:description.optional(),
    }).parse(req.body);
    await transaction(pool,async (db) => {
      const task = await lockTask(db,taskId,actor,expected);
      if (!manages(actor,task.department_id)) throw new HttpError(403,'Permission required');
      if (await isMaker(db,task,actor)) throw new HttpError(403,'An independent reviewer must check this work');
      if ((decision === 'start_review' && task.status !== 'evidence_submitted') ||
          (decision !== 'start_review' && task.status !== 'under_review'))
        throw new HttpError(409,'Review action is unavailable in this state');
      if (decision === 'reject') requireReason(note);
      if (decision === 'verify') {
        const { rows:[batch] } = await db.query(`SELECT count(*)::int AS total,
          count(a.id) FILTER (WHERE a.decision='approved')::int AS approved
          FROM evidence_versions v JOIN evidence e ON e.id=v.evidence_id
          LEFT JOIN approvals a ON a.evidence_version_id=v.id WHERE e.task_id=$1 AND v.submission_revision=$2`,
          [taskId,task.evidence_submission_revision]);
        if (!batch.total || batch.approved !== batch.total)
          throw new HttpError(409,'Approve all evidence in this submission before verifying the task');
      }
      const next = {start_review:'under_review',verify:'verified',reject:'rejected'}[decision];
      await db.query('UPDATE compliance_tasks SET status=$2,revision=revision+1 WHERE id=$1',[taskId,next]);
      await changeStatus(db,task,next,actor,note);
    });
    res.json({ id:taskId });
  });
  return api;
}

export async function isMaker(db: Pool | PoolClient, task: {id:string;assignee_id:string|null;submitted_by:string|null}, actor: Account) {
  if ([task.assignee_id,task.submitted_by].includes(actor.id)) return true;
  return Boolean((await db.query(`SELECT 1 FROM task_status_history WHERE task_id=$1 AND actor_id=$2
    AND to_status IN ('in_progress','evidence_submitted') AND from_status <> 'blocked' LIMIT 1`,[task.id,actor.id])).rowCount);
}
