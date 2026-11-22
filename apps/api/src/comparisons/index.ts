import { Router, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireJson } from '../identity/auth.js';
import { account, audit, HttpError, id, transaction } from '../identity/store.js';

const section = z.object({ heading: z.string().nullable(), pages: z.array(z.number().int().positive()), text: z.string() });
const impact = z.object({
  ordinal: z.number().int().positive(), summary: z.string(), practicalMeaning: z.string().nullable(),
  requirements: z.array(id), departments: z.array(z.string()), actionSuggestion: z.string().nullable(),
});
const result = z.object({
  changes: z.array(z.object({
    category: z.enum(['added','modified','removed','unchanged']), old: section.nullable(), new: section.nullable(),
    signals: z.record(z.string(),z.object({ before:z.array(z.string()), after:z.array(z.string()) })),
    oldChanged: z.array(z.number().int().nonnegative()), newChanged: z.array(z.number().int().nonnegative()),
  })).max(650),
  impacts: z.array(impact).max(40),
  impactStatus: z.enum(['skipped','completed','failed']), impactError: z.string().nullable(),
  model: z.string().nullable(),
});

export function createComparisons(pool: Pool, aiUrl: string, token: string, authenticate: RequestHandler) {
  const api = Router();
  const permission = (action: 'read' | 'manage'): RequestHandler => (_request, response, next) => {
    if (!account.parse(response.locals.user).permissions.includes('comparisons.' + action))
      throw new HttpError(403,'Permission required');
    next();
  };

  api.post('/regulations/:id/compare',authenticate,permission('manage'),requireJson(),async (req,res) => {
    const regulation = id.parse(req.params.id);
    const input = z.strictObject({
      oldVersionId:id, newVersionId:id, includeImpact:z.boolean().default(false),
    }).parse(req.body);
    if (input.oldVersionId === input.newVersionId) throw new HttpError(400,'Select two different versions');
    const { rows: versions } = await pool.query(
      `SELECT v.id,v.number,d.id AS document_id,d.status FROM regulation_versions v
       JOIN documents d ON d.version_id=v.id WHERE v.regulation_id=$1 AND v.id=ANY($2::uuid[]) ORDER BY v.number`,
      [regulation,[input.oldVersionId,input.newVersionId]]);
    if (versions.length !== 2) throw new HttpError(404,'Both versions must belong to this regulation');
    if (versions[0].id !== input.oldVersionId) throw new HttpError(400,'Select the older version first');
    if (versions.some(({ status }) => status !== 'processed')) throw new HttpError(409,'Both versions must be processed');

    async function chunks(documentId: string) {
      return (await pool.query(
        'SELECT page,ordinal,heading,text,ocr FROM document_chunks WHERE document_id=$1 ORDER BY page,ordinal',[documentId])).rows;
    }
    const [old,newer,requirements] = await Promise.all([
      chunks(versions[0].document_id), chunks(versions[1].document_id),
      input.includeImpact ? pool.query(`SELECT q.id, q.human_result->>'title' AS title,
        q.human_result->>'description' AS description FROM regulatory_requirements q
        JOIN ai_analysis_runs a ON a.id=q.run_id WHERE a.document_id=$1 AND q.status='approved'
        ORDER BY q.created_at DESC,q.id LIMIT 30`,[versions[0].document_id]).then(({rows}) => rows) : [],
    ]);
    const body = JSON.stringify({ old,new:newer,includeImpact:input.includeImpact,requirements });
    if (Buffer.byteLength(body) > 4_000_000) throw new HttpError(413,'Comparison input exceeds size limit');
    let response;
    try {
      response = await fetch(new URL('/internal/regulations/compare',aiUrl), {
        method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ' + token},
        body,signal:AbortSignal.timeout(85_000),
      });
    } catch {
      throw new HttpError(503,'Comparison service unavailable');
    }
    if (response.status === 422) throw new HttpError(422,'Comparison input is missing text or exceeds section limits');
    if (!response.ok) throw new HttpError(503,'Comparison service unavailable');
    const parsed = result.safeParse(await response.json());
    if (!parsed.success) throw new HttpError(502,'Comparison service returned invalid output');
    const data = parsed.data;
    const requirementTitles = new Map<string,string>(requirements.map(({id,title}) => [id,title]));
    const impactMap = new Map(data.impacts.map((item) => [item.ordinal,{
      ...item, requirementTitles:item.requirements.map((id) => requirementTitles.get(id)).filter((title) => title !== undefined),
    }]));
    const created = await transaction(pool,async (db) => {
      const { rows: [record] } = await db.query(`INSERT INTO regulation_comparisons
        (regulation_id,old_version_id,new_version_id,created_by,impact_status,impact_error,model)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [regulation,input.oldVersionId,input.newVersionId,res.locals.user.id,data.impactStatus,data.impactError,data.model]);
      const rows = data.changes.map((change,index) => ({
        ordinal:index + 1,category:change.category,
        old_section:change.old && {...change.old,changedLines:change.oldChanged},
        new_section:change.new && {...change.new,changedLines:change.newChanged},
        signals:change.signals,ai_explanation:impactMap.get(index + 1) ?? null,
      }));
      await db.query(`INSERT INTO regulatory_changes
        (comparison_id,ordinal,category,old_section,new_section,signals,ai_explanation)
        SELECT $1,ordinal,category,old_section,new_section,signals,ai_explanation FROM jsonb_to_recordset($2::jsonb)
        AS change(ordinal integer,category text,old_section jsonb,new_section jsonb,signals jsonb,ai_explanation jsonb)`,
        [record.id,JSON.stringify(rows)]);
      await audit(db,res.locals.user.id,'comparison.created','comparison',record.id,
        { oldVersionId:input.oldVersionId,newVersionId:input.newVersionId,impactStatus:data.impactStatus });
      return record;
    });
    res.status(201).json(created);
  });

  api.get('/regulations/:id/changes',authenticate,permission('read'),async (req,res) => {
    const regulation = id.parse(req.params.id);
    const input = z.strictObject({
      comparisonId:id.optional(),offset:z.coerce.number().int().min(0).max(10000).default(0),
      includeUnchanged:z.enum(['true','false']).default('false'),
    }).parse(req.query);
    if (!(await pool.query('SELECT 1 FROM regulations WHERE id=$1',[regulation])).rowCount)
      throw new HttpError(404,'Regulation not found');
    const { rows: comparisons } = await pool.query(`SELECT c.id,c.old_version_id,c.new_version_id,c.impact_status,
      c.impact_error,c.model,c.created_at,o.number AS old_number,n.number AS new_number
      FROM regulation_comparisons c JOIN regulation_versions o ON o.id=c.old_version_id
      JOIN regulation_versions n ON n.id=c.new_version_id
      WHERE c.regulation_id=$1 ORDER BY c.created_at DESC,c.id LIMIT 50`,[regulation]);
    const selected = input.comparisonId ?? comparisons[0]?.id;
    if (!selected) {
      res.json({ comparisons,changes:[],hasMore:false,counts:{} });
      return;
    }
    if (!(await pool.query('SELECT 1 FROM regulation_comparisons WHERE id=$1 AND regulation_id=$2',[selected,regulation])).rowCount)
      throw new HttpError(404,'Comparison not found');
    const [changes,counts] = await Promise.all([
      pool.query(`SELECT id,ordinal,category,decision,signals,old_section->>'heading' AS old_heading,
        new_section->>'heading' AS new_heading FROM regulatory_changes WHERE comparison_id=$1
        AND ($2::boolean OR category <> 'unchanged') ORDER BY ordinal LIMIT 26 OFFSET $3`,
        [selected,input.includeUnchanged === 'true',input.offset]),
      pool.query('SELECT category,count(*)::integer AS count FROM regulatory_changes WHERE comparison_id=$1 GROUP BY category',[selected]),
    ]);
    res.json({ comparisons,changes:changes.rows.slice(0,25),hasMore:changes.rows.length > 25,
      counts:Object.fromEntries(counts.rows.map(({category,count}) => [category,count])) });
  });

  api.get('/changes/:id',authenticate,permission('read'),async (req,res) => {
    const { rows: [record] } = await pool.query(`SELECT r.*,c.old_version_id,c.new_version_id,o.number AS old_number,
      n.number AS new_number,od.id AS old_document_id,nd.id AS new_document_id
      FROM regulatory_changes r JOIN regulation_comparisons c ON c.id=r.comparison_id
      JOIN regulation_versions o ON o.id=c.old_version_id JOIN regulation_versions n ON n.id=c.new_version_id
      JOIN documents od ON od.version_id=o.id JOIN documents nd ON nd.version_id=n.id WHERE r.id=$1`,
      [id.parse(req.params.id)]);
    if (!record) throw new HttpError(404,'Change not found');
    res.json(record);
  });

  api.post('/changes/:id/review',authenticate,permission('manage'),requireJson(),async (req,res) => {
    const changeId = id.parse(req.params.id);
    const { decision,comment,revision } = z.strictObject({
      decision:z.enum(['confirmed','dismissed','needs_follow_up']),
      comment:z.string().trim().min(1).max(1200),revision:z.number().int().nonnegative(),
    }).parse(req.body);
    const result = await transaction(pool,async (db) => {
      const actor = account.parse(res.locals.user);
      const { rows: [change] } = await db.query('SELECT category,jsonb_array_length(review_history) AS revision FROM regulatory_changes WHERE id=$1 FOR UPDATE',[changeId]);
      if (!change) throw new HttpError(404,'Change not found');
      if (change.category === 'unchanged') throw new HttpError(409,'Unchanged sections do not require a decision');
      if (change.revision !== revision) throw new HttpError(409,'Another reviewer updated this change. Reload before reviewing.');
      const entry = { reviewerId:actor.id,reviewer:actor.name,decision,comment,at:new Date().toISOString() };
      await db.query('UPDATE regulatory_changes SET decision=$2, review_history=review_history || $3::jsonb WHERE id=$1',
        [changeId,decision,JSON.stringify([entry])]);
      await audit(db,actor.id,'comparison.reviewed','regulatory_change',changeId,{ decision,revision:revision + 1 });
      return { id:changeId,decision };
    });
    res.json(result);
  });
  return api;
}
