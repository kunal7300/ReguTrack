import { Router,type RequestHandler,type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { account,type Account,HttpError,id } from '../identity/store.js';
import { obScope,scope,taskJoin,taskScope } from '../work/index.js';

const today = "(now() AT TIME ZONE 'Asia/Kolkata')::date";
const open = "t.status NOT IN ('completed','cancelled')";
const overdue = `${open} AND t.due_date<${today}`;
const complete = "(EXISTS(SELECT 1 FROM compliance_tasks x WHERE x.obligation_id=o.id AND x.status='completed') AND NOT EXISTS(SELECT 1 FROM compliance_tasks x WHERE x.obligation_id=o.id AND x.status NOT IN ('completed','cancelled')))";
const workFilter=z.strictObject({
  offset:z.coerce.number().int().min(0).max(100000).default(0),
  departmentId:id.optional(),format:z.enum(['json','csv']).default('json'),
});
const roleName = (actor:Account) => {
  const roles=actor.roles;
  if (roles.includes('super_admin') || roles.includes('chief_compliance_officer') || roles.includes('compliance_officer')) return 'compliance';
  if (roles.includes('internal_auditor') && actor.permissions.includes('work.read_all')) return 'auditor';
  return roles.includes('department_manager') ? 'manager' : 'employee';
};

function csvCell(value:unknown) {
  const text=String(value ?? '');
  const safe=/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"','""') + '"';
}
function report(response:Response,format:string,filename:string,rows:Record<string,unknown>[],columns:string[],hasMore=false) {
  if (format==='csv') {
    response.attachment(filename+'.csv').type('text/csv; charset=utf-8').send(
      [columns.map(csvCell).join(','), ...rows.map((row)=>columns.map((column)=>csvCell(row[column])).join(','))].join('\r\n'));
    return;
  }
  response.json({rows,hasMore});
}

export function visibilityRoutes(pool:Pool,authenticate:RequestHandler) {
  const api=Router();
  const visible:RequestHandler=(_req,res,next)=>{
    const actor=account.parse(res.locals.user);
    if (!actor.permissions.some((permission)=>['work.read_all','work.read_department','work.read_assigned'].includes(permission)))
      throw new HttpError(403,'Permission required');
    next();
  };

  api.get('/dashboard/summary',authenticate,visible,async (_req,res)=>{
    const actor=account.parse(res.locals.user);
    const view=roleName(actor);
    const global=actor.permissions.includes('work.read_all');
    const [obligations,tasks,evidence,updates]=await Promise.all([
      pool.query(`SELECT count(*) FILTER(WHERE o.approval_state='approved' AND NOT ${complete})::int AS active_obligations,
        count(*) FILTER(WHERE o.approval_state='approved' AND ${complete})::int AS completed_obligations,
        count(*) FILTER(WHERE o.approval_state='approved' AND NOT ${complete} AND o.priority IN ('high','critical'))::int AS high_priority
        FROM compliance_obligations o WHERE ${obScope}`,scope(actor)),
      pool.query(`SELECT count(*) FILTER(WHERE ${open})::int AS pending_tasks,
        count(*) FILTER(WHERE ${overdue})::int AS overdue_tasks,
        count(*) FILTER(WHERE ${open} AND t.due_date BETWEEN ${today} AND ${today}+7)::int AS upcoming_deadlines,
        count(*) FILTER(WHERE a.assignee_id=$5 AND ${open})::int AS assigned_tasks,
        count(DISTINCT a.assignee_id) FILTER(WHERE ${open})::int AS assigned_employees,
        count(*) FILTER(WHERE t.status IN ('in_progress','rejected'))::int AS awaiting_evidence,
        count(*) FILTER(WHERE t.status='completed')::int AS completed_tasks,
        count(*) FILTER(WHERE t.status<>'cancelled')::int AS total_tasks ${taskJoin} WHERE ${taskScope}`,scope(actor)),
      pool.query(`SELECT count(DISTINCT e.id)::int AS evidence_records,
        count(*) FILTER(WHERE p.decision='approved')::int AS evidence_approvals,
        count(*) FILTER(WHERE p.decision='rejected')::int AS rejected_evidence,
        count(*) FILTER(WHERE p.id IS NULL AND ev.submission_revision=t.evidence_submission_revision
          AND t.status IN ('evidence_submitted','under_review'))::int AS evidence_awaiting_review
        ${taskJoin} JOIN evidence e ON e.task_id=t.id JOIN evidence_versions ev ON ev.evidence_id=e.id
        LEFT JOIN approvals p ON p.evidence_version_id=ev.id WHERE ${taskScope}`,scope(actor)),
      global && view==='compliance' ? pool.query(`SELECT (SELECT count(*)::int FROM regulations) AS total_regulations,
        (SELECT count(*)::int FROM regulation_versions WHERE created_at>=now()-interval '30 days') AS new_regulatory_updates,
        (SELECT count(*)::int FROM regulatory_requirements) AS extracted_requirements,
        (SELECT count(*)::int FROM regulatory_requirements WHERE status IN ('pending','revised')) AS awaiting_review`) : null,
    ]);
    const data={...obligations.rows[0],...tasks.rows[0],...evidence.rows[0],...updates?.rows[0]};
    res.json({view,metrics:{...data,completion_rate:data.total_tasks ? Math.round(100*data.completed_tasks/data.total_tasks) : 0}});
  });

  async function progress(actor:Account,departmentId:string|null,limit:number,offset:number) {
    return (await pool.query(`WITH visible_obligations AS (
       SELECT o.department_id,count(*) FILTER(WHERE o.approval_state='approved' AND NOT ${complete})::int AS active_obligations,
        count(*) FILTER(WHERE o.approval_state='approved' AND ${complete})::int AS completed_obligations
       FROM compliance_obligations o WHERE ${obScope} GROUP BY o.department_id
     ), visible_tasks AS (
       SELECT o.department_id,count(*) FILTER(WHERE ${open})::int AS pending_tasks,
        count(*) FILTER(WHERE ${overdue})::int AS overdue_tasks,
        count(*) FILTER(WHERE t.status='completed')::int AS completed_tasks,
        count(*) FILTER(WHERE t.status<>'cancelled')::int AS total_tasks
       ${taskJoin} WHERE ${taskScope} GROUP BY o.department_id
     ) SELECT d.id,d.name AS department, COALESCE(vo.active_obligations,0) AS active_obligations,
      COALESCE(vo.completed_obligations,0) AS completed_obligations,COALESCE(vt.pending_tasks,0) AS pending_tasks,
      COALESCE(vt.overdue_tasks,0) AS overdue_tasks, COALESCE(vt.completed_tasks,0) AS completed_tasks,
      COALESCE(vt.total_tasks,0) AS total_tasks,
      COALESCE(round(vt.completed_tasks*100.0/NULLIF(vt.total_tasks,0))::int,0) AS completion_rate
     FROM departments d LEFT JOIN visible_obligations vo ON vo.department_id=d.id
     LEFT JOIN visible_tasks vt ON vt.department_id=d.id
     WHERE ($1::boolean OR ($2::boolean AND d.id=$3) OR vo.department_id IS NOT NULL OR vt.department_id IS NOT NULL)
      AND ($6::uuid IS NULL OR d.id=$6)
     ORDER BY d.name,d.id LIMIT $7 OFFSET $8`,[...scope(actor),departmentId,limit,offset])).rows;
  }

  async function taskRows(actor:Account,filter:string,departmentId:string|null,limit:number,offset:number) {
    return (await pool.query(`SELECT t.id,t.title,t.due_date::text AS due_date,t.status,o.id AS obligation_id,
      d.name AS department,u.name AS assignee,(${overdue}) AS overdue ${taskJoin}
      WHERE ${taskScope} AND ($6::uuid IS NULL OR o.department_id=$6) AND (${filter})
      ORDER BY t.due_date,t.id LIMIT $7 OFFSET $8`,[...scope(actor),departmentId,limit,offset])).rows;
  }

  api.get('/dashboard/departments',authenticate,visible,async (_req,res)=>{
    const actor=account.parse(res.locals.user);
    res.json({departments:await progress(actor,null,100,0)});
  });
  api.get('/dashboard/tasks',authenticate,visible,async (req,res)=>{
    const actor=account.parse(res.locals.user);
    const {offset}=z.strictObject({offset:workFilter.shape.offset}).parse(req.query);
    const [rows,updates,decisions]=await Promise.all([
      taskRows(actor,roleName(actor)==='auditor' ? "t.status='completed'" : open,null,26,offset),
      pool.query(`SELECT t.id AS task_id,t.title,e.note,e.kind,e.created_at,e.actor ${taskJoin}
        CROSS JOIN LATERAL (
          SELECT c.body AS note,'comment' AS kind,c.created_at,p.name AS actor FROM task_comments c
          JOIN users p ON p.id=c.author_id WHERE c.task_id=t.id
          UNION ALL
          SELECT h.to_status,'status',h.created_at,p.name FROM task_status_history h
          JOIN users p ON p.id=h.actor_id WHERE h.task_id=t.id
        ) e WHERE ${taskScope} ORDER BY e.created_at DESC,t.id LIMIT 12`,scope(actor)),
      roleName(actor)==='auditor' ? pool.query(`SELECT approve.id,t.id AS task_id,e.title,approve.decision,
        approve.created_at,reviewer.name AS reviewer ${taskJoin} JOIN evidence e ON e.task_id=t.id
        JOIN evidence_versions v ON v.evidence_id=e.id JOIN approvals approve ON approve.evidence_version_id=v.id
        JOIN users reviewer ON reviewer.id=approve.reviewer_id WHERE ${taskScope}
        ORDER BY approve.created_at DESC,approve.id LIMIT 12`,scope(actor)) : null,
    ]);
    res.json({tasks:rows.slice(0,25),hasMore:rows.length>25,updates:updates.rows,evidenceDecisions:decisions?.rows ?? []});
  });
  api.get('/dashboard/deadlines',authenticate,visible,async (_req,res)=>{
    const actor=account.parse(res.locals.user);
    const [upcoming,late,obligations,priority]=await Promise.all([
      taskRows(actor,`${open} AND t.due_date BETWEEN ${today} AND ${today}+7`,null,15,0),
      taskRows(actor,overdue,null,15,0),
      pool.query(`SELECT o.id,o.title,o.target_date::text AS target_date,o.priority,d.name AS department
        FROM compliance_obligations o JOIN departments d ON d.id=o.department_id
        WHERE ${obScope} AND o.approval_state='approved' AND NOT ${complete}
        AND o.target_date BETWEEN ${today} AND ${today}+7 ORDER BY o.target_date,o.id LIMIT 15`,scope(actor)),
      roleName(actor)==='compliance' ? pool.query(`SELECT o.id,o.title,o.target_date::text AS target_date,o.priority,d.name AS department
        FROM compliance_obligations o JOIN departments d ON d.id=o.department_id
        WHERE ${obScope} AND o.approval_state='approved' AND NOT ${complete}
        AND o.priority IN ('high','critical') ORDER BY o.target_date,o.id LIMIT 15`,scope(actor)) : null,
    ]);
    res.json({upcoming,overdue:late,obligations:obligations.rows,highPriority:priority?.rows ?? []});
  });

  api.get('/reports/compliance',authenticate,visible,async (req,res)=>{
    const actor=account.parse(res.locals.user);
    const filter=workFilter.parse(req.query);
    const size=filter.format==='csv'?500:25;
    const {rows}=await pool.query(`SELECT o.id,o.title,d.name AS department,u.name AS accountable,
      o.target_date::text AS target_date,o.priority,o.approval_state,(${complete}) AS completed,
      q.human_result->>'title' AS requirement,r.title AS regulation
      FROM compliance_obligations o JOIN departments d ON d.id=o.department_id JOIN users u ON u.id=o.accountable_id
      JOIN regulatory_requirements q ON q.id=o.requirement_id JOIN ai_analysis_runs ar ON ar.id=q.run_id
      JOIN documents doc ON doc.id=ar.document_id JOIN regulation_versions v ON v.id=doc.version_id
      JOIN regulations r ON r.id=v.regulation_id
      WHERE ${obScope} AND ($6::uuid IS NULL OR o.department_id=$6) ORDER BY o.target_date,o.id LIMIT $7 OFFSET $8`,
      [...scope(actor),filter.departmentId ?? null,size+1,filter.offset]);
    report(res,filter.format,'compliance',rows.slice(0,size),
      ['id','title','department','accountable','target_date','priority','approval_state','completed','requirement','regulation'],rows.length>size);
  });
  api.get('/reports/overdue',authenticate,visible,async (req,res)=>{
    const actor=account.parse(res.locals.user);
    const filter=workFilter.parse(req.query);
    const size=filter.format==='csv'?500:25;
    const rows=await taskRows(actor,overdue,filter.departmentId ?? null,size+1,filter.offset);
    report(res,filter.format,'overdue',rows.slice(0,size),['id','obligation_id','title','department','assignee','due_date','status'],rows.length>size);
  });
  api.get('/reports/department-progress',authenticate,visible,async (req,res)=>{
    const actor=account.parse(res.locals.user);
    const filter=workFilter.parse(req.query);
    const size=filter.format==='csv'?500:25;
    const rows=await progress(actor,filter.departmentId ?? null,size+1,filter.offset);
    report(res,filter.format,'department-progress',rows.slice(0,size),
      ['id','department','active_obligations','completed_obligations','pending_tasks','overdue_tasks','completed_tasks','total_tasks','completion_rate'],rows.length>size);
  });
  return api;
}
