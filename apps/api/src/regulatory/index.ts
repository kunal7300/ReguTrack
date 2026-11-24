import { createHash, randomUUID } from 'node:crypto';
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Queue, Worker } from 'bullmq';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import type { Pool } from 'pg';
import { z } from 'zod';
import { account, audit, HttpError, id, transaction } from '../identity/store.js';

const text = z.string().trim().min(1).max(250);
const webUrl = z.url({ protocol: /^https?$/ }).max(2048);
const sourceInput = z.strictObject({ name: text, url: webUrl });
const regulationInput = z.strictObject({
  title: text, kind: z.enum(['circular','notification','master_direction','master_circular','amendment']),
  sourceId: id.nullable().optional(), reference: text.optional(),
});
const uploadInput = z.strictObject({
  regulationId: id, sourceUrl: webUrl.optional(), versionNote: text.optional(),
});
const extraction = z.object({
  pages: z.number().int().min(1).max(150),
  chunks: z.array(z.object({
    page: z.number().int().positive(), ordinal: z.number().int().positive(),
    heading: z.string().nullable(), text: z.string().min(1).max(1800), ocr: z.boolean(),
  })).min(1).max(20000),
}).refine(({ pages, chunks }) => chunks.every((chunk) => chunk.page <= pages));
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 3, parts: 5 } });
const publicDocument = 'd.id, d.version_id, d.filename, d.bytes, d.sha256, d.status, d.error, d.page_count, d.created_at';

export function createRegulations(pool: Pool, options: {
  redisUrl: string; aiUrl: string; pdfToken: string;
  endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string; queueName?: string;
  region?: string;
}) {
  const redis = new URL(options.redisUrl);
  const connection = {
    host: redis.hostname, port: Number(redis.port || '6379'),
    username: redis.username || undefined, password: redis.password || undefined,
    db: Number(redis.pathname.slice(1) || '0'), tls: redis.protocol === 'rediss:' ? {} : undefined,
  };
  const queueName = options.queueName ?? 'regulatory-pdf';
  const queue = new Queue<{ documentId: string }>(queueName, { connection: { ...connection, enableOfflineQueue: false } });
  const store = new S3Client({
    endpoint: options.endpoint, region: options.region ?? 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  });
  const Bucket = options.bucket;
  queue.on('error', () => console.error('PDF queue connection failed'));

  async function ensureBucket() {
    try {
      await store.send(new HeadBucketCommand({ Bucket }));
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
      try {
        await store.send(new CreateBucketCommand({ Bucket }));
      } catch (creationError) {
        if (!(creationError instanceof Error) || creationError.name !== 'BucketAlreadyOwnedByYou') throw creationError;
      }
    }
  }

  async function pdfRequest(action: 'validate' | 'extract', pdf: Uint8Array) {
    return fetch(new URL('/internal/pdf/' + action, options.aiUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/pdf', Authorization: 'Bearer ' + options.pdfToken },
      body: Buffer.from(pdf), signal: AbortSignal.timeout(action === 'validate' ? 10_000 : 300_000),
    });
  }

  const worker = new Worker<{ documentId: string }>(queueName, async ({ data }) => {
    const { documentId } = data;
    const { rows: [document] } = await pool.query(
      "UPDATE documents SET status = 'processing', error = NULL WHERE id = $1 AND status IN ('queued','processing') RETURNING object_key",
      [documentId],
    );
    if (!document) return;
    try {
      const result = await store.send(new GetObjectCommand({ Bucket, Key: document.object_key }));
      if (!result.Body) throw new Error('Missing PDF');
      const response = await pdfRequest('extract', await result.Body.transformToByteArray());
      if (response.status === 422) {
        const error = z.object({ detail: z.string().max(250) }).safeParse(await response.json());
        throw new HttpError(422, error.data?.detail ?? 'Unable to extract text from the PDF');
      }
      if (!response.ok) throw new Error('PDF extraction service failed');
      const extracted = extraction.parse(await response.json());
      await transaction(pool, async (db) => {
        await db.query('DELETE FROM document_chunks WHERE document_id = $1', [documentId]);
        await db.query(`INSERT INTO document_chunks (document_id,page,ordinal,heading,text,ocr)
          SELECT $1,page,ordinal,heading,text,ocr FROM jsonb_to_recordset($2::jsonb)
          AS chunk(page integer, ordinal integer, heading text, text text, ocr boolean)`,
          [documentId, JSON.stringify(extracted.chunks)]);
        await db.query("UPDATE documents SET status = 'processed', page_count = $2 WHERE id = $1", [documentId, extracted.pages]);
        await audit(db, null, 'regulation.pdf_processed', 'document', documentId, { pages: extracted.pages });
      });
    } catch (error) {
      await transaction(pool, async (db) => {
        const message = error instanceof HttpError ? error.message : 'PDF extraction failed';
        const updated = await db.query(
          "UPDATE documents SET status = 'failed', error = $2 WHERE id = $1 AND status = 'processing'", [documentId, message]);
        if (updated.rowCount) await audit(db, null, 'regulation.pdf_failed', 'document', documentId);
      });
      throw error;
    }
  }, { connection: { ...connection, maxRetriesPerRequest: null }, concurrency: 1 });
  worker.on('error', () => console.error('PDF worker connection failed'));

  function enqueue(documentId: string) {
    return queue.add('extract', { documentId }, { jobId: documentId, removeOnComplete: true, removeOnFail: true });
  }
  let reconciling = false;
  const reconcile = setInterval(async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      const pending = await pool.query("SELECT id FROM documents WHERE status IN ('queued','processing') ORDER BY created_at LIMIT 100");
      await Promise.all(pending.rows.map(({ id }) => enqueue(id)));
    } catch {
      console.error('PDF job reconciliation failed');
    } finally {
      reconciling = false;
    }
  }, 5000);
  reconcile.unref();

  function router(authenticate: RequestHandler) {
    const api = Router();
    const authorized = (permission: string): RequestHandler => (_request, response, next) => {
      if (!account.parse(response.locals.user).permissions.includes(permission)) throw new HttpError(403, 'Permission required');
      next();
    };
    const read = [authenticate, authorized('regulations.read')];
    const write = [authenticate, authorized('regulations.manage')];
    api.get('/regulatory-sources', read, async (_req: Request, res: Response) => {
      res.json({ sources: (await pool.query('SELECT id,name,url FROM regulatory_sources ORDER BY name,id')).rows });
    });
    api.post('/regulatory-sources', write, async (req: Request, res: Response) => {
      const {name,url} = sourceInput.parse(req.body);
      const source = await transaction(pool, async (db) => {
        const { rows: [created] } = await db.query('INSERT INTO regulatory_sources(name,url) VALUES ($1,$2) RETURNING id,name,url',[name,url]);
        await audit(db, res.locals.user.id, 'regulatory_source.created', 'regulatory_source', created.id);
        return created;
      });
      res.status(201).json(source);
    });
    api.get('/regulations', read, async (req: Request, res: Response) => {
      const { offset } = z.strictObject({ offset: z.coerce.number().int().min(0).max(1000000).default(0) }).parse(req.query);
      const { rows } = await pool.query(`SELECT r.*, s.name AS source_name FROM regulations r
        LEFT JOIN regulatory_sources s ON s.id = r.source_id ORDER BY r.created_at DESC,r.id LIMIT 51 OFFSET $1`, [offset]);
      res.json({ regulations: rows.slice(0,50), hasMore: rows.length > 50 });
    });
    api.post('/regulations', write, async (req: Request, res: Response) => {
      const {title, kind, sourceId, reference} = regulationInput.parse(req.body);
      const regulation = await transaction(pool, async (db) => {
        if (sourceId && !(await db.query('SELECT 1 FROM regulatory_sources WHERE id=$1',[sourceId])).rowCount)
          throw new HttpError(400,'Source does not exist');
        const { rows: [record] } = await db.query(
          'INSERT INTO regulations(title,kind,source_id,reference) VALUES ($1,$2,$3,$4) RETURNING *',[title,kind,sourceId,reference]);
        await audit(db, res.locals.user.id, 'regulation.created', 'regulation', record.id);
        return record;
      });
      res.status(201).json(regulation);
    });
    api.post('/regulations/upload', write, upload.single('pdf'), async (req: Request, res: Response) => {
      const {regulationId, sourceUrl, versionNote} = uploadInput.parse(req.body);
      const file = req.file;
      if (!file || file.mimetype !== 'application/pdf' || !file.originalname.toLowerCase().endsWith('.pdf'))
        throw new HttpError(400,'Select a PDF file');
      if (!(await pool.query('SELECT 1 FROM regulations WHERE id=$1',[regulationId])).rowCount)
        throw new HttpError(404,'Regulation not found');
      const sha = createHash('sha256').update(file.buffer).digest('hex');
      if ((await pool.query('SELECT 1 FROM documents WHERE sha256=$1',[sha])).rowCount)
        throw new HttpError(409,'This PDF is already in the library');
      const validation = await pdfRequest('validate', file.buffer);
      if (validation.status === 422) throw new HttpError(422,'Invalid, encrypted, damaged, or oversized PDF');
      if (!validation.ok) throw new HttpError(503,'PDF validation service is unavailable');
      const key = randomUUID() + '.pdf';
      await ensureBucket();
      await store.send(new PutObjectCommand({ Bucket, Key: key, Body: file.buffer, ContentType: 'application/pdf' }));
      const filename = file.originalname.replace(/[\u0000-\u001f\u007f]/g, '').slice(0,250);
      let document;
      try {
        document = await transaction(pool, async (db) => {
          await db.query('SELECT pg_advisory_xact_lock(890009,hashtext($1))',[regulationId]);
          const { rows: [version] } = await db.query(
            `INSERT INTO regulation_versions(regulation_id,number,source_url,version_note)
             SELECT $1, COALESCE(MAX(number),0)+1,$2,$3 FROM regulation_versions WHERE regulation_id=$1 RETURNING id`,
            [regulationId,sourceUrl,versionNote]);
          const { rows: [record] } = await db.query(
            'INSERT INTO documents(version_id,object_key,filename,bytes,sha256) VALUES ($1,$2,$3,$4,$5) RETURNING id,version_id,filename,bytes,sha256,status',
            [version.id,key,filename,file.size,sha]);
          await audit(db, res.locals.user.id, 'regulation.pdf_uploaded', 'document', record.id, { regulationId, versionId: version.id });
          return record;
        });
      } catch (error) {
        if ((error as {code?: string}).code === '23505') {
          await store.send(new DeleteObjectCommand({Bucket,Key:key})).catch(() => console.error('PDF cleanup failed'));
          throw new HttpError(409,'This PDF is already in the library');
        }
        throw error;
      }
      void enqueue(document.id).catch(() => console.error('PDF queued for reconciliation'));
      res.status(202).json(document);
    });
    async function getRegulation(regulationId: string) {
      const { rows: [regulation] } = await pool.query(`SELECT r.*, s.name AS source_name, s.url AS source_url
        FROM regulations r LEFT JOIN regulatory_sources s ON s.id=r.source_id WHERE r.id=$1`,[regulationId]);
      if (!regulation) throw new HttpError(404,'Regulation not found');
      return regulation;
    }
    api.get('/regulations/:id', read, async (req: Request, res: Response) => {
      res.json(await getRegulation(id.parse(req.params.id)));
    });
    api.get('/regulations/:id/versions', read, async (req: Request, res: Response) => {
      const regulation = await getRegulation(id.parse(req.params.id));
      res.json({ versions: (await pool.query('SELECT * FROM regulation_versions WHERE regulation_id=$1 ORDER BY number DESC',[regulation.id])).rows });
    });
    api.get('/regulations/:id/documents', read, async (req: Request, res: Response) => {
      const regulation = await getRegulation(id.parse(req.params.id));
      res.json({ documents: (await pool.query(`SELECT ${publicDocument} FROM documents d
        JOIN regulation_versions v ON v.id=d.version_id WHERE v.regulation_id=$1 ORDER BY v.number DESC`,[regulation.id])).rows });
    });
    api.get('/regulatory-documents/:id/chunks', read, async (req: Request, res: Response) => {
      const documentId = id.parse(req.params.id);
      const { page } = z.strictObject({ page: z.coerce.number().int().min(1).max(150) }).parse(req.query);
      res.json({ chunks: (await pool.query(
        'SELECT page,ordinal,heading,text,ocr FROM document_chunks WHERE document_id=$1 AND page=$2 ORDER BY ordinal',[documentId,page])).rows });
    });
    api.get('/regulatory-documents/:id/pdf', read, async (req: Request, res: Response) => {
      const { rows: [record] } = await pool.query('SELECT object_key FROM documents WHERE id=$1',[id.parse(req.params.id)]);
      if (!record) throw new HttpError(404,'Document not found');
      const result = await store.send(new GetObjectCommand({ Bucket, Key: record.object_key }));
      if (!result.Body) throw new HttpError(404,'PDF not found');
      res.set('X-Content-Type-Options','nosniff').type('application/pdf').send(Buffer.from(await result.Body.transformToByteArray()));
    });
    return api;
  }

  return {
    router,
    async close() { clearInterval(reconcile); await worker.close(); await queue.close(); store.destroy(); },
  };
}
