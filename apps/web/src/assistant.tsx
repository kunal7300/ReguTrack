import { useCallback,useEffect,useState,type FormEvent } from 'react';
import { z } from 'zod';
import { ApiError,fetchPdf,request,type Account } from './api';
import { errorMessage,Field,Notice,Resource,useResource } from './ui';

const state=z.object({status:z.enum(['unpublished','queued','indexing','ready','failed','revoked']),
  indexed_at:z.string().nullable().optional(),error:z.string().nullable().optional()});
const citation=z.object({
  type:z.enum(['regulatory','workflow']),title:z.string(),documentId:z.uuid(),regulationId:z.uuid(),
  page:z.number(),section:z.string().nullable(),version:z.number(),quote:z.string(),obligationId:z.uuid().optional(),
});
const result=z.object({
  status:z.enum(['answered','insufficient']),interpretation:z.string().nullable(),citations:z.array(citation),
});
const catalog=z.object({regulations:z.array(z.object({id:z.uuid(),title:z.string()}))});
const catalogRequest=()=>request('/assistant/sources',catalog);

export function AssistantIndex({ actor,documentId,regulationId }: {actor:Account;documentId:string;regulationId:string}) {
  const [record,setRecord]=useState<z.infer<typeof state>>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [version,reload]=useState(0);
  const [consent,setConsent]=useState(false);
  useEffect(()=>{
    let current=true;
    let timer:ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const next=await request('/assistant/documents/'+documentId,state);
        if (!current) return;
        setRecord(next);
        if (next.status==='queued' || next.status==='indexing') timer=setTimeout(load,1800);
      } catch (reason) { if (current) setError(errorMessage(reason)); }
    }
    void load();
    return ()=>{current=false;clearTimeout(timer);};
  },[documentId,version]);
  async function action(type:'index'|'revoke') {
    setError('');
    setBusy(true);
    try {
      const next=await request('/assistant/documents/'+documentId+'/'+type,state,'POST',type==='index'?{allowProvider:true}:{});
      setRecord(next);
      setConsent(false);
      reload((value)=>value+1);
    } catch (reason) {
      if (type==='index' && reason instanceof ApiError && reason.status===409 &&
          reason.message.includes('already indexed or queued')) {
        setConsent(false);
        reload((value)=>value+1);
      } else {
        setError(errorMessage(reason));
      }
    }
    finally {setBusy(false);}
  }
  const manager=actor.permissions.includes('assistant.publish');
  return <section className="panel">
    <h2>Assistant source</h2>
    {record ? <p>Status: <strong>{record.status==='ready'?'Approved and indexed':record.status}</strong></p>
      : !error && <p role="status">Checking source status…</p>}
    {record?.error && <Notice>{record.error}</Notice>}
    {error && <Notice>{error}</Notice>}
    {manager && record && (['unpublished','failed','revoked'].includes(record.status) ?
      <div className="actions">
        <label><input type="checkbox" checked={consent} onChange={(event)=>setConsent(event.currentTarget.checked)}/>
          {' '}Approve this PDF version and send its extracted text to Gemini for indexing</label>
        <button disabled={busy || !consent} onClick={()=>void action('index')}>Approve and index</button>
      </div> : <button className="secondary" disabled={busy} onClick={()=>void action('revoke')}>Revoke assistant access</button>)}
    {record?.status==='ready' && <div className="extraction"><a href={`#/assistant?regulationId=${regulationId}`}>Ask about this regulation</a></div>}
  </section>;
}

function Citation({item,index}:{item:z.infer<typeof citation>;index:number}) {
  const [pdf,setPdf]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>()=>{if(pdf) URL.revokeObjectURL(pdf);},[pdf]);
  async function open() {
    setBusy(true);
    try {setPdf(URL.createObjectURL(await fetchPdf(item.documentId)));}
    catch (reason) {setError(errorMessage(reason));}
    finally {setBusy(false);}
  }
  return <li className="panel">
    <h3>{index+1}. {item.title} · Version {item.version}</h3>
    <p>PDF page {item.page}{item.section && ' · '+item.section}</p>
    <p><strong>{item.type==='workflow'?'Internal workflow record':'Regulatory source excerpt'}</strong></p>
    <blockquote className="extracted-text">{item.quote}</blockquote>
    <div className="actions extraction">
      {item.obligationId && <a href={`#/obligations/${item.obligationId}`}>Open obligation</a>}
      <a href={`#/regulations/${item.regulationId}?documentId=${item.documentId}`}>Open document version</a>
      {pdf ? <a href={pdf+'#page='+item.page} target="_blank" rel="noreferrer">Open PDF page {item.page}</a>
        : <button className="secondary" disabled={busy} onClick={()=>void open()}>View cited PDF page</button>}
    </div>
    {error && <Notice>{error}</Notice>}
    {pdf && <iframe className="pdf-viewer" title={item.title+' PDF page '+item.page} src={pdf+'#page='+item.page}/>}
  </li>;
}

export function AssistantPage({query}:{query?:string}) {
  const initial=new URLSearchParams(query).get('regulationId') ?? '';
  const sources=useResource(useCallback(catalogRequest,[]));
  const [selection,setSelection]=useState(initial);
  const [mode,setMode]=useState('regulatory');
  const [response,setResponse]=useState<z.infer<typeof result>>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  async function ask(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values=new FormData(event.currentTarget);
    setResponse(undefined);
    setError('');
    setBusy(true);
    try {
      const data=await request('/assistant/ask',result,'POST',{
        question:values.get('question'),mode,regulationId:selection||undefined,allowProvider:values.has('consent'),
      });
      setResponse(data);
    } catch (reason) {setError(errorMessage(reason));}
    finally {setBusy(false);}
  }
  return <>
    <header className="page-head"><h1>Compliance assistant</h1></header>
    <section className="panel">
      <p>Ask about approved sources, saved version comparisons, or pending obligations within your access scope.</p>
      <Resource {...sources}>{({regulations})=><form className="form-grid" onSubmit={(event)=>void ask(event)}>
        <Field label="Source type"><select name="mode" value={mode} onChange={(event)=>setMode(event.currentTarget.value)}>
          <option value="regulatory">Regulatory text</option><option value="comparison">Saved version comparisons</option>
          <option value="pending">Approved pending obligations</option>
        </select></Field>
        <Field label="Regulation"><select name="regulationId" value={selection} required={mode==='comparison'}
          onChange={(event)=>setSelection(event.currentTarget.value)}>
          <option value="">{mode==='comparison'?'Select a regulation':'All approved sources'}</option>
          {regulations.map((row)=><option key={row.id} value={row.id}>{row.title}</option>)}
        </select></Field>
        {!regulations.length && <p className="wide">No PDF versions are approved and indexed yet.</p>}
        <div className="wide"><Field label="Question"><textarea name="question" maxLength={1000} rows={3} required
          placeholder="What does the regulation say about access reviews?"/></Field></div>
        <label className="wide"><input name="consent" type="checkbox" required/>
          {' '}Send this question and relevant authorized excerpts or workflow records to Gemini</label>
        <div><button disabled={busy}>{busy?'Checking sources…':'Ask assistant'}</button></div>
      </form>}</Resource>
      {error && <Notice>{error}</Notice>}
    </section>
    {response && (response.status==='insufficient'
      ? <section className="panel"><h2>No reliable source found</h2><p>Choose an indexed regulation or ask a more specific question.</p></section>
      : <>
        <section className="panel"><h2>AI interpretation</h2><p className="assistant-answer">{response.interpretation}</p></section>
        <section className="extraction"><h2>Verified citations</h2>
          <ol className="assistant-citations">{response.citations.map((item,index)=>
            <Citation item={item} index={index} key={item.documentId+':'+item.page+':'+index}/>)}</ol>
        </section>
      </>)}
  </>;
}
