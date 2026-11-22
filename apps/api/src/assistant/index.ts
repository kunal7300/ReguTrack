import { Queue,Worker } from 'bullmq';
import { Router,type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireJson } from '../identity/auth.js';
import { account,audit,HttpError,id,transaction } from '../identity/store.js';
import { obScope,scope } from '../work/index.js';

const vector=z.array(z.number().finite()).length(768).refine((values)=>values.some((value)=>value!==0));
const embeddings=z.object({vectors:z.array(vector).min(1).max(32)});
const answer=z.strictObject({
  status:z.enum(['answered','insufficient']),interpretation:z.string().max(2600).nullable(),
  citations:z.array(z.strictObject({sourceId:z.string().max(16),quote:z.string().min(1).max(900)})).max(8),
});
const normalized=(value:string)=>value.replace(/\s+/gu,' ').trim();
const unavailable={ status:'insufficient',interpretation:null,citations:[] };
const sourceJoin=`FROM assistant_documents x JOIN documents d ON d.id=x.document_id
  JOIN regulation_versions v ON v.id=d.version_id JOIN regulations r ON r.id=v.regulation_id`;
type Source={
  type:'regulatory'|'workflow';text:string;title:string;documentId:string;
  regulationId:string;page:number;section:string|null;version:number;obligationId?:string;
};
type IndexJob={documentId:string;generation:string};

export function createAssistant(pool:Pool,config:{aiUrl:string;token:string;redisUrl:string;queueName?:string}) {
  const redis=new URL(config.redisUrl);
  const connection={host:redis.hostname,port:Number(redis.port||6379),username:redis.username||undefined,
    password:redis.password||undefined,db:Number(redis.pathname.slice(1)||0),tls:redis.protocol==='rediss:' ? {} : undefined};
  const queueName=config.queueName ?? 'assistant-index';
  const queue=new Queue<IndexJob>(queueName,{connection:{...connection,enableOfflineQueue:false}});

  async function provider(action:'embed'|'answer',payload:object) {
    try {
      const response=await fetch(new URL('/internal/assistant/'+action,config.aiUrl),{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.token},
        body:JSON.stringify(payload),signal:AbortSignal.timeout(65_000),
      });
      if (!response.ok) throw new Error('Provider unavailable');
      return await response.json() as unknown;
    } catch {
      throw new HttpError(503,'Gemini assistant service unavailable');
    }
  }

  const worker=new Worker<IndexJob>(queueName,async ({data:{documentId,generation}})=>{
    const changed=await pool.query(`UPDATE assistant_documents SET status='indexing' WHERE document_id=$1 AND generation=$2
      AND status IN ('queued','indexing')`,[documentId,generation]);
    if (!changed.rowCount) return;
    try {
      const {rows}=await pool.query(`SELECT page,ordinal,heading,text FROM document_chunks
        WHERE document_id=$1 ORDER BY page,ordinal LIMIT 2001`,[documentId]);
      if (!rows.length || rows.length>2000) throw new HttpError(422,'Indexing supports 1 to 2,000 extracted chunks per version');
      for (let index=0;index<rows.length;index+=32) {
        const batch=rows.slice(index,index+32);
        const {vectors}=embeddings.parse(await provider('embed',{query:false,texts:batch.map(({heading,text})=>
          heading && heading!==text ? heading+'\n'+text : text)}));
        if (vectors.length!==batch.length) throw new HttpError(502,'Gemini embedding count did not match the indexed text');
        const written=await transaction(pool,async (db)=>{
          const current=await db.query("SELECT 1 FROM assistant_documents WHERE document_id=$1 AND generation=$2 AND status='indexing' FOR UPDATE",
            [documentId,generation]);
          if (!current.rowCount) return false;
          await db.query(`INSERT INTO assistant_embeddings(document_id,page,ordinal,embedding)
            SELECT $1,embedded.page,embedded.ordinal,embedded.vector::vector
            FROM jsonb_to_recordset($2::jsonb) AS embedded(page integer,ordinal integer,vector text)
            ON CONFLICT(document_id,page,ordinal) DO UPDATE SET embedding=EXCLUDED.embedding`,
            [documentId,JSON.stringify(batch.map(({page,ordinal},i)=>({page,ordinal,vector:JSON.stringify(vectors[i])})))]);
          return true;
        });
        if (!written) return;
      }
      await transaction(pool,async (db)=>{
        const set=await db.query("UPDATE assistant_documents SET status='ready',indexed_at=now(),error=NULL WHERE document_id=$1 AND generation=$2 AND status='indexing'",[documentId,generation]);
        if (set.rowCount) await audit(db,null,'assistant.indexed','document',documentId,{chunks:rows.length});
      });
    } catch (error) {
      await transaction(pool,async (db)=>{
        const set=await db.query("UPDATE assistant_documents SET status='failed',error=$3 WHERE document_id=$1 AND generation=$2 AND status='indexing'",
          [documentId,generation,error instanceof HttpError ? error.message : 'Document indexing failed']);
        if (set.rowCount) await audit(db,null,'assistant.index_failed','document',documentId);
      });
    }
  },{connection:{...connection,maxRetriesPerRequest:null},concurrency:1});
  worker.on('error',()=>console.error('Assistant index worker unavailable'));
  queue.on('error',()=>console.error('Assistant index queue unavailable'));
  function enqueue(job:IndexJob) {
    return queue.add('index',job,{jobId:job.generation,removeOnComplete:true,removeOnFail:true});
  }
  let scanning=false;
  const timer=setInterval(async ()=>{
    if (scanning) return;
    scanning=true;
    try {
      const {rows}=await pool.query(`SELECT document_id AS "documentId",generation FROM assistant_documents
        WHERE status IN ('queued','indexing') ORDER BY approved_at LIMIT 50`);
      await Promise.all(rows.map(enqueue));
    } catch { console.error('Assistant index reconciliation failed'); }
    finally {scanning=false;}
  },5000);
  timer.unref();

  function router(authenticate:RequestHandler) {
    const api=Router();
    const permission=(publish=false):RequestHandler=>(_req,res,next)=>{
      const actor=account.parse(res.locals.user);
      if (!actor.permissions.includes('regulations.read') ||
          !actor.permissions.includes(publish?'assistant.publish':'assistant.use'))
        throw new HttpError(403,'Permission required');
      next();
    };
    api.get('/assistant/sources',authenticate,permission(),async (_req,res)=>{
      const {rows}=await pool.query(`SELECT DISTINCT r.id,r.title ${sourceJoin}
        WHERE x.status='ready' AND d.status='processed' ORDER BY r.title,r.id LIMIT 500`);
      res.json({regulations:rows});
    });
    api.get('/assistant/documents/:id',authenticate,permission(),async (req,res)=>{
      const documentId=id.parse(req.params.id);
      const {rows:[record]}=await pool.query('SELECT status,indexed_at,error FROM assistant_documents WHERE document_id=$1',[documentId]);
      res.json(record ?? {status:'unpublished',indexed_at:null,error:null});
    });
    api.post('/assistant/documents/:id/index',authenticate,permission(true),requireJson(),async (req,res)=>{
      const documentId=id.parse(req.params.id);
      z.strictObject({allowProvider:z.literal(true)}).parse(req.body);
      const job=await transaction(pool,async (db)=>{
        const {rows:[doc]}=await db.query('SELECT status FROM documents WHERE id=$1 FOR UPDATE',[documentId]);
        if (!doc) throw new HttpError(404,'Document not found');
        if (doc.status!=='processed') throw new HttpError(409,'Process the PDF before indexing it');
        const current=await db.query("SELECT 1 FROM assistant_documents WHERE document_id=$1 AND status IN ('queued','indexing','ready')",[documentId]);
        if (current.rowCount) throw new HttpError(409,'Version is already indexed or queued');
        await db.query('DELETE FROM assistant_embeddings WHERE document_id=$1',[documentId]);
        const {rows:[item]}=await db.query(`INSERT INTO assistant_documents(document_id,status,approved_by) VALUES ($1,'queued',$2)
          ON CONFLICT(document_id) DO UPDATE SET status='queued',generation=gen_random_uuid(),approved_by=$2,approved_at=now(),indexed_at=NULL,error=NULL
          RETURNING document_id AS "documentId",generation`,[documentId,res.locals.user.id]);
        await audit(db,res.locals.user.id,'assistant.approved_for_index','document',documentId);
        return item as IndexJob;
      });
      void enqueue(job).catch(()=>console.error('Assistant index queued for reconciliation'));
      res.status(202).json({status:'queued'});
    });
    api.post('/assistant/documents/:id/revoke',authenticate,permission(true),requireJson(),async (req,res)=>{
      const documentId=id.parse(req.params.id);
      z.strictObject({}).parse(req.body);
      await transaction(pool,async (db)=>{
        await db.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE',[documentId]);
        const done=await db.query("UPDATE assistant_documents SET status='revoked',generation=gen_random_uuid(),indexed_at=NULL,error=NULL WHERE document_id=$1 AND status<>'revoked'",[documentId]);
        if (!done.rowCount) throw new HttpError(404,'Published version not found');
        await db.query('DELETE FROM assistant_embeddings WHERE document_id=$1',[documentId]);
        await audit(db,res.locals.user.id,'assistant.revoked','document',documentId);
      });
      res.json({status:'revoked'});
    });

    api.post('/assistant/ask',authenticate,permission(),requireJson(),async (req,res)=>{
      const input=z.strictObject({
        question:z.string().trim().min(1).max(1000),allowProvider:z.literal(true),
        mode:z.enum(['regulatory','comparison','pending']).default('regulatory'),regulationId:id.optional(),
      }).parse(req.body);
      const actor=account.parse(res.locals.user);
      const params=[input.regulationId ?? null];
      const {rowCount}=await pool.query(`SELECT 1 ${sourceJoin}
        WHERE x.status='ready' AND d.status='processed' AND ($1::uuid IS NULL OR r.id=$1) LIMIT 1`,params);
      if (!rowCount) {res.json(unavailable);return;}
      let sources:Source[]=[];
      if (input.mode==='pending') {
        if (!actor.permissions.some((grant)=>['work.read_all','work.read_department','work.read_assigned'].includes(grant)))
          throw new HttpError(403,'Permission required');
        const {rows}=await pool.query(`SELECT o.id AS "obligationId",r.id AS "regulationId",d.id AS "documentId",
          r.title,v.number AS version,(q.suggestion->>'page')::integer AS page,q.suggestion->>'section' AS section,
          'Approved pending obligation: '||o.title||'. Department: '||dep.name||'. Target date: '||o.target_date||
          '. Source requirement: '||(q.human_result->>'title') AS text
          FROM compliance_obligations o JOIN departments dep ON dep.id=o.department_id
          JOIN regulatory_requirements q ON q.id=o.requirement_id JOIN ai_analysis_runs a ON a.id=q.run_id
          JOIN documents d ON d.id=a.document_id JOIN assistant_documents x ON x.document_id=d.id
          JOIN regulation_versions v ON v.id=d.version_id JOIN regulations r ON r.id=v.regulation_id
          WHERE ${obScope} AND o.approval_state='approved' AND q.status='approved' AND x.status='ready'
            AND d.status='processed' AND ($6::uuid IS NULL OR r.id=$6) AND (
              NOT EXISTS(SELECT 1 FROM compliance_tasks t WHERE t.obligation_id=o.id AND t.status='completed')
              OR EXISTS(SELECT 1 FROM compliance_tasks t WHERE t.obligation_id=o.id AND t.status NOT IN ('completed','cancelled'))
            ) ORDER BY o.target_date,o.id LIMIT 10`,[...scope(actor),...params]);
        sources=rows.map((item)=>({...item,type:'workflow'}));
      } else if (input.mode==='comparison') {
        if (!input.regulationId) throw new HttpError(400,'Select a regulation for comparison questions');
        const {rows}=await pool.query(`WITH pair AS (
          SELECT c.id,c.regulation_id,c.old_version_id,c.new_version_id,od.id AS old_doc,nd.id AS new_doc
          FROM regulation_comparisons c JOIN documents od ON od.version_id=c.old_version_id
          JOIN documents nd ON nd.version_id=c.new_version_id JOIN assistant_documents ox ON ox.document_id=od.id
          JOIN assistant_documents nx ON nx.document_id=nd.id WHERE c.regulation_id=$1 AND ox.status='ready' AND nx.status='ready'
          AND od.status='processed' AND nd.status='processed' ORDER BY c.created_at DESC,c.id LIMIT 1
        ) SELECT r.id AS "regulationId",s.doc AS "documentId",r.title,v.number AS version,
          (s.section->'pages'->>0)::integer AS page,s.section->>'heading' AS section,left(s.section->>'text',3500) AS text
          FROM pair p JOIN regulations r ON r.id=p.regulation_id JOIN regulatory_changes c ON c.comparison_id=p.id
          CROSS JOIN LATERAL (VALUES (p.old_version_id,p.old_doc,c.old_section),(p.new_version_id,p.new_doc,c.new_section)) s(version,doc,section)
          JOIN regulation_versions v ON v.id=s.version
          WHERE c.category<>'unchanged' AND s.section IS NOT NULL ORDER BY c.ordinal,v.number LIMIT 12`,params);
        sources=rows.map((item)=>({...item,type:'regulatory'}));
      } else {
        const {vectors:[query]}=embeddings.parse(await provider('embed',{query:true,texts:[input.question]}));
        const {rows}=await pool.query(`WITH allowed AS MATERIALIZED (
          SELECT d.id AS "documentId",r.id AS "regulationId",r.title,v.number AS version
          ${sourceJoin} WHERE x.status='ready' AND d.status='processed' AND ($1::uuid IS NULL OR r.id=$1)
        ), ranked AS (
          SELECT p.*,c.page,c.heading AS section,c.text,1-(e.embedding <=> $2::vector) AS similarity,
            ts_rank(to_tsvector('english',c.text),plainto_tsquery('english',$3)) AS lexical
          FROM allowed p JOIN assistant_embeddings e ON e.document_id=p."documentId"
          JOIN document_chunks c ON (c.document_id,c.page,c.ordinal)=(e.document_id,e.page,e.ordinal)
        ) SELECT * FROM ranked WHERE similarity>=0.48 OR lexical>0 ORDER BY (similarity+LEAST(lexical,0.25)) DESC,"documentId",page LIMIT 10`,
          [...params,JSON.stringify(query),input.question]);
        sources=rows.map((item)=>({...item,type:'regulatory'}));
      }
      if (!sources.length) {res.json(unavailable);return;}
      const evidence=sources.map((item,index)=>({id:'S'+(index+1),text:item.text,
        label:`${item.type==='workflow' ? 'Internal workflow record for' : 'Regulatory excerpt from'} ${item.title}, version ${item.version}, PDF page ${item.page}`}));
      const result=answer.parse(await provider('answer',{question:input.question,sources:evidence}));
      if (result.status!=='answered' || !result.interpretation?.trim() || !result.citations.length) {
        res.json(unavailable);return;
      }
      const map=new Map(evidence.map(({id},index)=>[id,sources[index]]));
      const citations=result.citations.map(({sourceId,quote})=>{
        const source=map.get(sourceId);
        const exact=normalized(quote);
        if (!source || !exact || !normalized(source.text).includes(exact)) return null;
        return {...source,quote:exact};
      });
      if (citations.some((item)=>item===null)) {res.json(unavailable);return;}
      const docIds=[...new Set(citations.flatMap((item)=>item ? [item.documentId] : []))];
      const stillAllowed=await pool.query("SELECT document_id FROM assistant_documents WHERE status='ready' AND document_id=ANY($1::uuid[])",[docIds]);
      if (stillAllowed.rowCount!==docIds.length) {res.json(unavailable);return;}
      const obligationIds=[...new Set(citations.flatMap((item)=>item?.obligationId ? [item.obligationId] : []))];
      if (obligationIds.length) {
        const accessible=await pool.query(`SELECT o.id FROM compliance_obligations o WHERE ${obScope}
          AND o.approval_state='approved' AND o.id=ANY($6::uuid[])`,[...scope(actor),obligationIds]);
        if (accessible.rowCount!==obligationIds.length) {res.json(unavailable);return;}
      }
      res.json({status:'answered',interpretation:result.interpretation,citations});
    });
    return api;
  }
  return {router,async close(){clearInterval(timer);await worker.close();await queue.close();}};
}
