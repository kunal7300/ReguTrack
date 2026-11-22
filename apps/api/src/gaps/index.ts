import { Router, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { requireJson } from '../identity/auth.js';
import { account, audit, HttpError, id, transaction } from '../identity/store.js';

const short = z.string().trim().min(1).max(250);
const text = z.string().trim().min(1).max(1800);
const revision = z.number().int().nonnegative();
const outcomes = z.enum(['gap_identified','partially_addressed','fully_addressed','not_applicable']);
const controlIds = z.array(id).max(20).refine((items) => new Set(items).size === items.length);
const suggestion = z.strictObject({ observation:text, remediation:text.nullable(), controlIds });
const pagination = z.strictObject({ offset:z.coerce.number().int().min(0).max(100000).default(0) });
const labels = `q.human_result->>'title' AS requirement_title,r.title AS regulation_title,
  a.document_id,v.regulation_id`;
const linkage = `JOIN regulatory_requirements q ON q.id=g.requirement_id
  JOIN ai_analysis_runs a ON a.id=q.run_id JOIN documents d ON d.id=a.document_id
  JOIN regulation_versions v ON v.id=d.version_id JOIN regulations r ON r.id=v.regulation_id`;

async function checkDepartment(db: PoolClient, departmentId: string | null) {
  if (departmentId && !(await db.query('SELECT 1 FROM departments WHERE id=$1',[departmentId])).rowCount)
    throw new HttpError(400,'Department does not exist');
}

async function selectedControls(pool: Pool | PoolClient, ids: string[]) {
  const { rows } = await pool.query('SELECT id,name,description FROM control_register WHERE id=ANY($1::uuid[]) ORDER BY name,id',[ids]);
  if (rows.length !== ids.length) throw new HttpError(400,'One or more controls do not exist');
  return rows;
}

export function createGaps(pool: Pool, aiUrl: string, token: string, authenticate: RequestHandler) {
  const api = Router();
  const permission = (action: 'read' | 'manage'): RequestHandler => (_req,res,next) => {
    if (!account.parse(res.locals.user).permissions.includes('gaps.' + action)) throw new HttpError(403,'Permission required');
    next();
  };
  api.get('/controls',authenticate,permission('read'),async (req,res) => {
    const { offset } = pagination.parse(req.query);
    const { rows } = await pool.query(`SELECT c.id,c.name,c.description,c.department_id,d.name AS department_name
      FROM control_register c LEFT JOIN departments d ON d.id=c.department_id ORDER BY c.name,c.id LIMIT 51 OFFSET $1`,[offset]);
    res.json({ controls:rows.slice(0,50),hasMore:rows.length > 50 });
  });
  api.post('/controls',authenticate,permission('manage'),requireJson(),async (req,res) => {
    const input = z.strictObject({ name:short, description:text, departmentId:id.nullable() }).parse(req.body);
    const control = await transaction(pool,async (db) => {
      await checkDepartment(db,input.departmentId);
      const { rows:[record] } = await db.query(`INSERT INTO control_register(name,description,department_id,created_by)
        VALUES ($1,$2,$3,$4) RETURNING id`,[input.name,input.description,input.departmentId,res.locals.user.id]);
      await audit(db,res.locals.user.id,'control.created','control',record.id);
      return record;
    });
    res.status(201).json(control);
  });

  api.post('/requirements/:id/gaps',authenticate,permission('manage'),requireJson(),async (req,res) => {
    const requirementId = id.parse(req.params.id);
    const input = z.strictObject({ controlIds,includeAi:z.boolean().default(false) }).parse(req.body);
    const { rows:[requirement] } = await pool.query('SELECT status,human_result FROM regulatory_requirements WHERE id=$1',[requirementId]);
    if (!requirement) throw new HttpError(404,'Requirement not found');
    if (requirement.status !== 'approved') throw new HttpError(409,'Approve the requirement before assessing a gap');
    if ((await pool.query('SELECT 1 FROM compliance_gaps WHERE requirement_id=$1',[requirementId])).rowCount)
      throw new HttpError(409,'An assessment already exists for this requirement');
    const controls = await selectedControls(pool,input.controlIds);
    let ai: z.infer<typeof suggestion> | null = null;
    let aiError: string | null = null;
    if (input.includeAi) {
      try {
        const result = requirement.human_result;
        const evidence = [result.title,result.description,result.applicability].filter(Boolean).join('\n');
        const response = await fetch(new URL('/internal/gaps/suggest',aiUrl),{
          method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ' + token},
          body:JSON.stringify({ requirement:evidence,controls }),signal:AbortSignal.timeout(75_000),
        });
        if (!response.ok) throw new Error('Suggestion unavailable');
        const proposed = suggestion.parse(await response.json());
        if (proposed.controlIds.some((control) => !input.controlIds.includes(control))) throw new Error('Unknown control citation');
        ai = proposed;
      } catch {
        aiError = 'Gemini suggestion unavailable. Continue with a manual assessment.';
      }
    }
    const created = await transaction(pool,async (db) => {
      const { rows:[record] } = await db.query(`INSERT INTO compliance_gaps(requirement_id,created_by,status,ai_suggestion,ai_error)
        VALUES ($1,$2,'not_assessed',$3,$4) RETURNING id`,[requirementId,res.locals.user.id,ai,aiError]);
      await db.query(`INSERT INTO control_requirement_mappings(requirement_id,control_id,mapped_by)
        SELECT $1,control_id,$3 FROM unnest($2::uuid[]) AS controls(control_id)`,[requirementId,input.controlIds,res.locals.user.id]);
      await audit(db,res.locals.user.id,'gap.created','gap',record.id,{ requirementId,controlIds:input.controlIds,aiRequested:input.includeAi });
      return record;
    });
    res.status(201).json(created);
  });

  api.get('/gaps',authenticate,permission('read'),async (req,res) => {
    const input = pagination.extend({ requirementId:id.optional() }).parse(req.query);
    const { rows } = await pool.query(`SELECT g.id,g.status,g.decision,g.requirement_id,${labels} FROM compliance_gaps g ${linkage}
      WHERE ($1::uuid IS NULL OR g.requirement_id=$1) ORDER BY g.created_at DESC,g.id LIMIT 26 OFFSET $2`,
      [input.requirementId ?? null,input.offset]);
    res.json({ gaps:rows.slice(0,25),hasMore:rows.length > 25 });
  });

  api.get('/gaps/:id',authenticate,permission('read'),async (req,res) => {
    const { rows:[record] } = await pool.query(`SELECT g.*,${labels},q.human_result->>'description' AS requirement_description
      FROM compliance_gaps g ${linkage} WHERE g.id=$1`,[id.parse(req.params.id)]);
    if (!record) throw new HttpError(404,'Assessment not found');
    const { rows:controls } = await pool.query(`SELECT c.id,c.name,c.description,d.name AS department_name
      FROM control_requirement_mappings m JOIN control_register c ON c.id=m.control_id
      LEFT JOIN departments d ON d.id=c.department_id WHERE m.requirement_id=$1 ORDER BY c.name,c.id`,[record.requirement_id]);
    res.json({ ...record,controls });
  });

  api.patch('/gaps/:id',authenticate,permission('manage'),requireJson(),async (req,res) => {
    const gap = id.parse(req.params.id);
    const input = z.strictObject({ revision, outcome:outcomes, assessment:text, remediationProposal:text.nullable() }).parse(req.body);
    if ((input.outcome === 'gap_identified' || input.outcome === 'partially_addressed') && !input.remediationProposal)
      throw new HttpError(400,'Enter a remediation proposal for an open gap');
    const data = await transaction(pool,async (db) => {
      const { rows:[record] } = await db.query('SELECT revision,decision FROM compliance_gaps WHERE id=$1 FOR UPDATE',[gap]);
      if (!record) throw new HttpError(404,'Assessment not found');
      if (record.revision !== input.revision) throw new HttpError(409,'Assessment changed. Reload before editing.');
      if (record.decision === 'approved') throw new HttpError(409,'This assessment is already validated');
      const event = { action:'submitted', actorId:res.locals.user.id, actor:res.locals.user.name,
        at:new Date().toISOString(),outcome:input.outcome,assessment:input.assessment,remediationProposal:input.remediationProposal };
      await db.query(`UPDATE compliance_gaps SET status='awaiting_validation',proposed_status=$2,assessment=$3,
        remediation_proposal=$4,decision=NULL,revision=revision+1,history=history || $5::jsonb WHERE id=$1`,
        [gap,input.outcome,input.assessment,input.remediationProposal,JSON.stringify([event])]);
      await audit(db,res.locals.user.id,'gap.submitted','gap',gap,{ outcome:input.outcome });
      return { id:gap };
    });
    res.json(data);
  });

  api.post('/gaps/:id/review',authenticate,permission('manage'),requireJson(),async (req,res) => {
    const gap = id.parse(req.params.id);
    const input = z.strictObject({
      revision,decision:z.enum(['approved','rejected']),comment:text,
      ownerDepartmentId:id.nullable().optional(),dueDate:z.iso.date().nullable().optional(),
    }).parse(req.body);
    const result = await transaction(pool,async (db) => {
      const actor = account.parse(res.locals.user);
      const { rows:[record] } = await db.query('SELECT * FROM compliance_gaps WHERE id=$1 FOR UPDATE',[gap]);
      if (!record) throw new HttpError(404,'Assessment not found');
      if (record.revision !== input.revision || record.status !== 'awaiting_validation')
        throw new HttpError(409,'Assessment is no longer awaiting this review');
      if (record.history.at(-1)?.actorId === actor.id) throw new HttpError(403,'Another officer must validate this assessment');
      let remediation = null;
      if (input.decision === 'approved' && ['gap_identified','partially_addressed'].includes(record.proposed_status)) {
        await checkDepartment(db,input.ownerDepartmentId ?? null);
        remediation = { action:record.remediation_proposal,departmentId:input.ownerDepartmentId ?? null,
          dueDate:input.dueDate ?? null,validatedBy:actor.id,validatedAt:new Date().toISOString() };
      }
      const event = { action:input.decision,actorId:actor.id,actor:actor.name,at:new Date().toISOString(),comment:input.comment };
      await db.query(`UPDATE compliance_gaps SET status=$2,decision=$3,remediation=$4,revision=revision+1,
        history=history || $5::jsonb WHERE id=$1`,[gap,input.decision === 'approved' ? record.proposed_status : 'not_assessed',
        input.decision,remediation,JSON.stringify([event])]);
      await audit(db,actor.id,'gap.' + input.decision,'gap',gap,{ remediationCreated:remediation !== null });
      return { id:gap };
    });
    res.json(result);
  });
  return api;
}
