import { Queue, Worker } from 'bullmq';
import { Router,type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { account,HttpError,id,transaction } from '../identity/store.js';

const events = ['obligation.approved','task.assigned','task.status_changed','evidence.approved','evidence.rejected',
  'regulation.pdf_uploaded','intelligence.completed'];
const today = "(now() AT TIME ZONE 'Asia/Kolkata')::date";
const recipients = `SELECT u.id,u.department_id,ARRAY(
  SELECT DISTINCT rp.permission_code FROM user_roles ur JOIN role_permissions rp USING(role_code)
  WHERE ur.user_id=u.id) AS permissions FROM users u WHERE u.active`;

export async function deliverNotifications(pool: Pool) {
  await transaction(pool,async (db) => {
    const { rows:[locked] } = await db.query('SELECT pg_try_advisory_xact_lock(890018) AS acquired');
    if (!locked.acquired) return;
    await db.query(`WITH pending AS MATERIALIZED (
      SELECT a.* FROM audit_logs a CROSS JOIN notification_checkpoint c
      WHERE a.id>c.audit_id AND a.action=ANY($1::text[])
        AND NOT EXISTS(SELECT 1 FROM notification_events n WHERE n.audit_id=a.id)
      ORDER BY a.id LIMIT 250
    ), people AS MATERIALIZED (${recipients}), deliveries AS (
      SELECT p.id AS user_id,'obligation_assigned' AS kind,'A compliance obligation was assigned to you' AS title,
        o.id AS entity_id,'/obligations/'||o.id AS route,a.id AS event_id
      FROM pending a JOIN compliance_obligations o ON o.id=a.target_id
      JOIN people p ON p.id=o.accountable_id AND p.department_id=o.department_id
      WHERE a.action='obligation.approved'
      UNION ALL
      SELECT p.id,'task_assigned','A task was assigned to you',t.id,'/tasks/'||t.id,a.id
      FROM pending a JOIN compliance_tasks t ON t.id=a.target_id JOIN compliance_obligations o ON o.id=t.obligation_id
      JOIN task_assignments ta ON ta.task_id=t.id AND ta.ended_at IS NULL
      JOIN people p ON p.id=ta.assignee_id AND p.department_id=o.department_id
      WHERE a.action='task.assigned' AND a.details->>'after'=p.id::text
      UNION ALL
      SELECT p.id,'evidence_submitted','Task evidence is ready for review',t.id,'/tasks/'||t.id,a.id
      FROM pending a JOIN compliance_tasks t ON t.id=a.target_id JOIN compliance_obligations o ON o.id=t.obligation_id
      JOIN people p ON p.department_id=o.department_id AND 'work.manage_department'=ANY(p.permissions)
      WHERE a.action='task.status_changed' AND a.details->>'to'='evidence_submitted'
        AND t.status IN ('evidence_submitted','under_review') AND p.id<>a.actor_id
      UNION ALL
      SELECT p.id,replace(a.action,'.','_'),CASE a.action WHEN 'evidence.approved' THEN 'A submitted evidence version was approved'
        ELSE 'A submitted evidence version was rejected' END,t.id,'/tasks/'||t.id,a.id
      FROM pending a JOIN evidence e ON e.id=a.target_id JOIN compliance_tasks t ON t.id=e.task_id
      JOIN compliance_obligations o ON o.id=t.obligation_id
      JOIN evidence_versions ev ON ev.evidence_id=e.id AND ev.id::text=a.details->>'versionId'
      JOIN people p ON p.id=ev.uploaded_by AND p.department_id=o.department_id
      WHERE a.action IN ('evidence.approved','evidence.rejected')
      UNION ALL
      SELECT p.id,'regulatory_update','A regulatory PDF version was received',v.regulation_id,'/regulations/'||v.regulation_id,a.id
      FROM pending a JOIN documents d ON d.id=a.target_id JOIN regulation_versions v ON v.id=d.version_id
      JOIN people p ON 'regulations.manage'=ANY(p.permissions) WHERE a.action='regulation.pdf_uploaded'
      UNION ALL
      SELECT p.id,'requirement_review','Extracted requirements are awaiting review',v.regulation_id,'/regulations/'||v.regulation_id,a.id
      FROM pending a JOIN ai_analysis_runs run ON run.id=a.target_id JOIN documents d ON d.id=run.document_id
      JOIN regulation_versions v ON v.id=d.version_id JOIN people p ON 'intelligence.review'=ANY(p.permissions)
      WHERE a.action='intelligence.completed' AND EXISTS(SELECT 1 FROM regulatory_requirements q WHERE q.run_id=run.id AND q.status IN ('pending','revised'))
    ), delivered AS (
      INSERT INTO notifications(user_id,kind,title,entity_id,route,dedupe_key)
      SELECT user_id,kind,title,entity_id,route,'event:'||event_id FROM deliveries ON CONFLICT DO NOTHING
    )
    INSERT INTO notification_events(audit_id) SELECT id FROM pending ON CONFLICT DO NOTHING`,[events]);
    await db.query(`WITH people AS MATERIALIZED (${recipients}), deadlines AS (
      SELECT t.id,t.due_date,ta.assignee_id,o.department_id FROM compliance_tasks t
      JOIN compliance_obligations o ON o.id=t.obligation_id
      LEFT JOIN task_assignments ta ON ta.task_id=t.id AND ta.ended_at IS NULL
      WHERE t.status NOT IN ('completed','cancelled','verified') AND t.due_date<=${today}+3
    ), reminders AS (
      SELECT p.id AS user_id,t.id,t.due_date,CASE WHEN t.due_date<${today} THEN 'task_overdue' ELSE 'task_deadline' END AS kind,
        CASE WHEN t.due_date<${today} THEN 'Your task is overdue' ELSE 'Your task deadline is within three days' END AS title
      FROM deadlines t JOIN people p ON p.id=t.assignee_id AND p.department_id=t.department_id
      UNION ALL
      SELECT p.id,t.id,t.due_date,'task_escalated','A department task is at least two days overdue'
      FROM deadlines t JOIN people p ON p.department_id=t.department_id AND 'work.manage_department'=ANY(p.permissions)
      WHERE t.due_date<=${today}-2
    )
    INSERT INTO notifications(user_id,kind,title,entity_id,route,dedupe_key)
    SELECT user_id,kind,title,id,'/tasks/'||id,kind||':'||id||':'||due_date FROM reminders ON CONFLICT DO NOTHING`);
  });
}

export function startNotifications(pool: Pool, redisUrl: string) {
  const redis=new URL(redisUrl);
  const connection={host:redis.hostname,port:Number(redis.port||6379),username:redis.username||undefined,
    password:redis.password||undefined,db:Number(redis.pathname.slice(1)||0),tls:redis.protocol==='rediss:' ? {} : undefined};
  const queue=new Queue('workflow-notifications',{connection});
  const worker=new Worker('workflow-notifications',()=>deliverNotifications(pool),
    {connection:{...connection,maxRetriesPerRequest:null},concurrency:1});
  queue.on('error',()=>console.error('Notification schedule connection failed'));
  worker.on('error',()=>console.error('Notification worker connection failed'));
  worker.on('failed',()=>console.error('Notification delivery job failed'));
  void queue.upsertJobScheduler('workflow-sweep',{every:30_000},{
    name:'deliver',data:{},opts:{removeOnComplete:20,removeOnFail:20},
  }).catch(()=>console.error('Could not register notification scheduler'));
  return async () => {await worker.close();await queue.close();};
}

export function notificationRoutes(pool:Pool,authenticate:RequestHandler) {
  const router=Router();
  router.get('/notifications',authenticate,async (req,res)=>{
    const actor=account.parse(res.locals.user);
    const {offset}=z.strictObject({offset:z.coerce.number().int().min(0).max(100000).default(0)}).parse(req.query);
    const [items,count]=await Promise.all([
      pool.query(`SELECT id,kind,title,entity_id,route,created_at,read_at FROM notifications WHERE user_id=$1
        ORDER BY created_at DESC,id DESC LIMIT 26 OFFSET $2`,[actor.id,offset]),
      pool.query('SELECT count(*)::int AS unread FROM notifications WHERE user_id=$1 AND read_at IS NULL',[actor.id]),
    ]);
    res.json({notifications:items.rows.slice(0,25),hasMore:items.rows.length>25,unread:count.rows[0].unread});
  });
  router.patch('/notifications/:id/read',authenticate,async (req,res)=>{
    const actor=account.parse(res.locals.user);
    const found=await pool.query('UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at',
      [id.parse(req.params.id),actor.id]);
    if (!found.rowCount) throw new HttpError(404,'Notification not found');
    res.json(found.rows[0]);
  });
  return router;
}
