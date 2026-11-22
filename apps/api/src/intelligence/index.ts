import { Queue, Worker } from 'bullmq';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireJson } from '../identity/auth.js';
import { account, audit, HttpError, id, transaction } from '../identity/store.js';

const short = z.string().trim().min(1).max(250);
const description = z.string().trim().min(1).max(1800);
const editable = z.strictObject({
  title: short, description, topic: short.nullable(),
  requirementType: z.enum(['mandatory','advisory','conditional']),
  applicability: short.nullable(), effectiveDate: z.iso.date().nullable(), deadline: z.iso.date().nullable(),
  departments: z.array(short).max(12), priority: z.enum(['low','medium','high','critical']).nullable(),
});
const suggestion = editable.extend({
  page: z.number().int().positive(), ordinal: z.number().int().positive(),
  section: short.nullable(), quote: description,
});
const drafts = z.strictObject({ requirements: z.array(suggestion).max(60) });
const extraction = z.strictObject({
  model: short, raw: z.strictObject({ requirements: z.array(z.record(z.string(), z.unknown())).max(60) }),
  grounded: drafts.nullable(), error: short.nullable(),
});
const runColumns = 'a.id,a.document_id,a.status,a.model,a.error,a.created_at,a.finished_at';
const revision = z.number().int().nonnegative();
const citationText = (value: string) => value.replace(/[ \t\r\n\f\v]+/g, ' ').replace(/^ +| +$/g, '');

export function createIntelligence(pool: Pool, config: { redisUrl: string; aiUrl: string; token: string; queueName?: string }) {
  const redis = new URL(config.redisUrl);
  const connection = {
    host: redis.hostname, port: Number(redis.port || '6379'),
    username: redis.username || undefined, password: redis.password || undefined,
    db: Number(redis.pathname.slice(1) || '0'), tls: redis.protocol === 'rediss:' ? {} : undefined,
  };
  const queueName = config.queueName ?? 'regulatory-analysis';
  const queue = new Queue<{ runId: string }>(queueName, { connection: { ...connection, enableOfflineQueue: false } });
  const worker = new Worker<{ runId: string }>(queueName, async ({ data: { runId } }) => {
    const { rows: [run] } = await pool.query(
      `UPDATE ai_analysis_runs a SET status='running' FROM documents d, regulation_versions v, regulations r
       WHERE a.id=$1 AND a.status IN ('queued','running') AND d.id=a.document_id
       AND v.id=d.version_id AND r.id=v.regulation_id RETURNING a.document_id,r.title`, [runId]);
    if (!run) return;
    let original: z.infer<typeof extraction> | undefined;
    try {
      const { rows: chunks } = await pool.query(
        'SELECT page,ordinal,heading,text,ocr FROM document_chunks WHERE document_id=$1 ORDER BY page,ordinal', [run.document_id]);
      if (!chunks.length) throw new HttpError(422,'No extracted text is available');
      if (chunks.reduce((size, chunk) => size + chunk.text.length, 0) > 120_000)
        throw new HttpError(422,'Document exceeds the 120,000-character analysis limit');
      const response = await fetch(new URL('/internal/intelligence/analyze',config.aiUrl), {
        method: 'POST', headers: {'Content-Type':'application/json',Authorization:'Bearer ' + config.token},
        body: JSON.stringify({ title: run.title, chunks }), signal: AbortSignal.timeout(90_000),
      }).catch((error: unknown) => {
        if (error instanceof Error && ['TimeoutError','AbortError'].includes(error.name))
          throw new HttpError(504,'The analysis service timed out. Try again shortly.');
        throw new HttpError(503,'The analysis service could not be reached. Try again shortly.');
      });
      if (!response.ok) {
        const result = z.object({ detail: short }).safeParse(await response.json().catch(() => null));
        throw new HttpError(response.status,result.data?.detail ?? 'Gemini extraction failed');
      }
      const parsed = extraction.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new HttpError(502,'The analysis service returned an invalid result');
      original = parsed.data;
      const { model, raw, grounded, error: warning } = original;
      if (!grounded) throw new HttpError(422,original.error ?? 'Citation verification failed');
      const results = grounded.requirements.map((draft) => {
        const page = chunks.filter((chunk) => chunk.page === draft.page && chunk.ordinal >= draft.ordinal);
        const [first] = page;
        const lines = page.map((chunk) => citationText(chunk.text));
        const quote = citationText(draft.quote);
        const start = lines.join(' ').indexOf(quote);
        if (!first || first.ordinal !== draft.ordinal || !quote || start < 0 ||
            start >= lines[0].length || (draft.section && draft.section !== first.heading))
          throw new HttpError(422,'A suggestion cited text absent from the recorded source');
        let length = 0;
        const cited = page.filter((_chunk, index) => {
          const included = length < start + quote.length;
          length += lines[index].length + 1;
          return included;
        });
        const ocr = cited.some((chunk) => chunk.ocr);
        return { ...draft, quote, regulationTitle: run.title,
          sourceText: cited.map((chunk) => chunk.text).join('\n'), ocr,
          citationQuality: (7 + (ocr ? 0 : 2) + (draft.section ? 1 : 0)) / 10 };
      });
      await transaction(pool,async (db) => {
        const updated = await db.query(
          "UPDATE ai_analysis_runs SET status='completed',model=$2,raw_output=$3,error=$4,finished_at=now() WHERE id=$1 AND status='running'",
          [runId,model,raw,warning]);
        if (!updated.rowCount) return;
        for (const item of results) await db.query('INSERT INTO regulatory_requirements(run_id,suggestion) VALUES ($1,$2)',[runId,item]);
        await audit(db,null,'intelligence.completed','analysis_run',runId,{ count: results.length });
      });
    } catch (error) {
      await transaction(pool,async (db) => {
        const updated = await db.query(
          "UPDATE ai_analysis_runs SET status='failed',error=$2,model=$3,raw_output=$4,finished_at=now() WHERE id=$1 AND status='running'",
          [runId,error instanceof HttpError ? error.message : 'AI analysis failed',original?.model ?? null,original?.raw ?? null]);
        if (updated.rowCount) await audit(db,null,'intelligence.failed','analysis_run',runId);
      });
    }
  }, { connection: { ...connection, maxRetriesPerRequest: null }, concurrency: 1 });
  queue.on('error', () => console.error('Analysis queue unavailable'));
  worker.on('error', () => console.error('Analysis worker unavailable'));
  function enqueue(runId: string) {
    return queue.add('analyze',{ runId },{ jobId: runId, removeOnComplete: true, removeOnFail: true });
  }
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const { rows } = await pool.query("SELECT id FROM ai_analysis_runs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 100");
      await Promise.all(rows.map(({id}) => enqueue(id)));
    } catch {
      console.error('Analysis queue reconciliation failed');
    } finally {
      busy = false;
    }
  }, 5000);
  timer.unref();

  function router(authenticate: RequestHandler) {
    const api = Router();
    const permission = (code: string): RequestHandler => (_req,res,next) => {
      if (!account.parse(res.locals.user).permissions.includes('intelligence.' + code)) throw new HttpError(403,'Permission required');
      next();
    };
    api.post('/regulations/:id/analyze',authenticate,permission('analyze'),requireJson(),async (req,res) => {
      const regulationId = id.parse(req.params.id);
      const { documentId } = z.strictObject({ documentId: id }).parse(req.body);
      const run = await transaction(pool,async (db) => {
        const { rows: [document] } = await db.query(
          'SELECT d.status FROM documents d JOIN regulation_versions v ON v.id=d.version_id WHERE d.id=$1 AND v.regulation_id=$2',
          [documentId,regulationId]);
        if (!document) throw new HttpError(404,'Document not found');
        if (document.status !== 'processed') throw new HttpError(409,'Process the document before analyzing it');
        const { rows: [created] } = await db.query(`INSERT INTO ai_analysis_runs(document_id,requested_by)
          VALUES ($1,$2) ON CONFLICT (document_id) WHERE status IN ('queued','running') DO NOTHING RETURNING id,status`,
          [documentId,res.locals.user.id]);
        if (!created) throw new HttpError(409,'Analysis is already in progress for this document');
        await audit(db,res.locals.user.id,'intelligence.requested','analysis_run', created.id,{ documentId });
        return created;
      });
      void enqueue(run.id).catch(() => console.error('Analysis queued for reconciliation'));
      res.status(202).json(run);
    });

    api.get('/regulations/:id/requirements',authenticate,permission('read'),async (req,res) => {
      const regulationId = id.parse(req.params.id);
      const query = z.strictObject({
        documentId: id.optional(), offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
      }).parse(req.query);
      if (!(await pool.query('SELECT 1 FROM regulations WHERE id=$1',[regulationId])).rowCount)
        throw new HttpError(404,'Regulation not found');
      const linkage = `FROM ai_analysis_runs a JOIN documents d ON d.id=a.document_id
        JOIN regulation_versions v ON v.id=d.version_id`;
      const scope = 'WHERE v.regulation_id=$1 AND ($2::uuid IS NULL OR d.id=$2)';
      const params = [regulationId,query.documentId ?? null];
      const [runs, requirements] = await Promise.all([
        pool.query(`SELECT ${runColumns} ${linkage} ${scope} ORDER BY a.created_at DESC,a.id LIMIT 20`,params),
        pool.query(`SELECT q.*,a.document_id ${linkage} JOIN regulatory_requirements q ON q.run_id=a.id
          ${scope} ORDER BY q.created_at DESC,q.id LIMIT 26 OFFSET $3`,[...params,query.offset]),
      ]);
      res.json({ runs:runs.rows, requirements:requirements.rows.slice(0,25), hasMore:requirements.rows.length > 25 });
    });

    api.get('/requirements/:id',authenticate,permission('read'),async (req,res) => {
      const requirementId = id.parse(req.params.id);
      const { rows: [record] } = await pool.query(`SELECT q.*,a.document_id,a.model FROM regulatory_requirements q
        JOIN ai_analysis_runs a ON a.id=q.run_id WHERE q.id=$1`,[requirementId]);
      if (!record) throw new HttpError(404,'Requirement not found');
      const history = await pool.query(`SELECT h.action,h.revision,h.human_result,h.note,h.created_at,u.name AS reviewer
        FROM requirement_reviews h JOIN users u ON u.id=h.reviewer_id WHERE h.requirement_id=$1 ORDER BY h.revision DESC`,[requirementId]);
      res.json({ ...record, history:history.rows });
    });

    async function review(req: Request,res: Response, mode: 'revise' | 'decide') {
      const requirementId = id.parse(req.params.id);
      const change = mode === 'revise'
        ? { ...z.strictObject({ revision, result: editable }).parse(req.body), action: 'revise' as const, note: null }
        : { ...z.strictObject({ revision, action: z.enum(['approve','reject']), note: short.optional() }).parse(req.body), result: null };
      const result = await transaction(pool,async (db) => {
        const actor = account.parse(res.locals.user);
        const { rows: [record] } = await db.query('SELECT * FROM regulatory_requirements WHERE id=$1 FOR UPDATE',[requirementId]);
        if (!record) throw new HttpError(404,'Requirement not found');
        if (record.revision !== change.revision) throw new HttpError(409,'Requirement changed. Reload it before reviewing.');
        if (record.status === 'approved' || record.status === 'rejected')
          throw new HttpError(409,'This requirement already has a final decision');
        if (change.action === 'approve') {
          const { rows: [previous] } = await db.query(
            'SELECT reviewer_id FROM requirement_reviews WHERE requirement_id=$1 AND revision=$2',
            [requirementId,record.revision]);
          if (previous?.reviewer_id === actor.id) throw new HttpError(403,'Another reviewer must approve this revision');
        }
        const proposed = suggestion.parse({
          ...Object.fromEntries(Object.keys(suggestion.shape).map((key) => [key, record.suggestion[key]])),
        });
        const { page, ordinal, section, quote, ...interpretation } = proposed;
        const human = change.result ?? record.human_result ?? interpretation;
        const status = { revise:'revised', approve:'approved', reject:'rejected' }[change.action];
        const nextRevision = record.revision + 1;
        const { rows: [updated] } = await db.query(`UPDATE regulatory_requirements SET status=$2,revision=$3,human_result=$4
          WHERE id=$1 RETURNING id,status,revision`,[requirementId,status,nextRevision,human]);
        await db.query(`INSERT INTO requirement_reviews(requirement_id,reviewer_id,action,revision,human_result,note)
          VALUES ($1,$2,$3,$4,$5,$6)`,[requirementId,actor.id,change.action,nextRevision,human,change.note ?? null]);
        await audit(db,actor.id,'intelligence.' + change.action,'requirement',requirementId,{ revision: nextRevision });
        return updated;
      });
      res.json(result);
    }
    api.patch('/requirements/:id',authenticate,permission('review'),requireJson(),(req,res) => review(req,res,'revise'));
    api.post('/requirements/:id/review',authenticate,permission('review'),requireJson(),(req,res) => review(req,res,'decide'));
    return api;
  }

  return { router, async close() { clearInterval(timer); await worker.close(); await queue.close(); } };
}
