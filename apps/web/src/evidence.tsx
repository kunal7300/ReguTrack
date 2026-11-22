import { useCallback,useState,type FormEvent } from 'react';
import { z } from 'zod';
import { fetchEvidence,request } from './api';
import { errorMessage,Field,Notice,Resource,useResource } from './ui';

const id = z.object({id:z.uuid()});
const list = z.object({
  evidence:z.array(id.extend({
    title:z.string(),filename:z.string(),number:z.number(),decision:z.string().nullable(),
  })),
  canUpload:z.boolean(),
});
const evidenceDetail = id.extend({
  title:z.string(),canReview:z.boolean(),taskRevision:z.number(),submissionRevision:z.number().nullable(),
  versions:z.array(id.extend({
    number:z.number(),filename:z.string(),uploader:z.string(),created_at:z.string(),sha256:z.string(),
    bytes:z.number(),submission_revision:z.number().nullable(),decision:z.string().nullable(),
    reviewer:z.string().nullable(),comment:z.string().nullable(),reviewed_at:z.string().nullable(),
  })),
});
const auditEvent = z.object({
  id:z.string(),actor_id:z.uuid().nullable(),actor:z.string().nullable(),action:z.string(),
  target_type:z.string().nullable(),target_id:z.uuid().nullable(),created_at:z.string(),
  details:z.record(z.string(),z.unknown()),
});
const auditList = z.object({events:z.array(auditEvent),next:z.string().nullable()});
const historySchema = z.object({events:z.array(auditEvent),lineage:z.object({
  regulation_id:z.uuid(),document_id:z.uuid(),requirement_id:z.uuid(),obligation_id:z.uuid().optional(),
})});

function useAction() {
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  async function run(action:()=>Promise<void>) {
    setError('');
    setBusy(true);
    try { await action(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  return {error,busy,run};
}

function EvidenceDetail({record,changed}: {record:z.infer<typeof evidenceDetail>;changed:()=>void}) {
  const operation=useAction();
  function review(event:FormEvent<HTMLFormElement>,versionId:string) {
    event.preventDefault();
    const data=new FormData(event.currentTarget);
    const submitter=(event.nativeEvent as SubmitEvent).submitter;
    if (!(submitter instanceof HTMLButtonElement)) return;
    void operation.run(async () => {
      await request('/evidence/'+record.id+'/'+submitter.value,id,'POST',{
        versionId,revision:record.taskRevision,comment:data.get('comment'),
      });
      changed();
    });
  }
  async function download(versionId:string,filename:string) {
    const url=URL.createObjectURL(await fetchEvidence(record.id,versionId));
    const link=document.createElement('a');
    link.href=url;
    link.download=filename;
    link.click();
    window.setTimeout(()=>URL.revokeObjectURL(url),30_000);
  }
  return <div className="extraction">
    <h3>{record.title} · Version history</h3>
    {operation.error && <Notice>{operation.error}</Notice>}
    {record.versions.map((row)=><section className="evidence-version" key={row.id}>
      <h4>Version {row.number} · {row.filename}</h4>
      <p>{row.decision ?? (row.submission_revision===null ? 'Not submitted' : 'Pending decision')} ·
        {' '}{row.uploader} · {new Date(row.created_at).toLocaleString()} · {Math.ceil(row.bytes/1024)} KiB</p>
      <p className="checksum"><strong>SHA-256</strong> {row.sha256}</p>
      <button className="secondary" disabled={operation.busy} onClick={()=>void operation.run(()=>download(row.id,row.filename))}>Download evidence</button>
      {row.reviewer && <p><strong>{row.reviewer}</strong> · {row.reviewed_at && new Date(row.reviewed_at).toLocaleString()}<br/>{row.comment}</p>}
      {record.canReview && !row.decision && row.submission_revision!==null &&
        row.submission_revision===record.submissionRevision && <form className="form-grid extraction" onSubmit={(event)=>review(event,row.id)}>
        <div className="wide"><Field label="Evidence review comment"><textarea name="comment" required maxLength={3000}/></Field></div>
        <div className="actions wide">
          <button value="approve" disabled={operation.busy}>Approve evidence</button>
          <button value="reject" disabled={operation.busy} className="secondary">Reject evidence</button>
        </div>
      </form>}
    </section>)}
  </div>;
}

export function TaskEvidence({taskId,changed}: {taskId:string;changed:()=>void}) {
  const [selected,setSelected]=useState('');
  const [replacement,setReplacement]=useState('');
  const [version,setVersion]=useState(0);
  const operation=useAction();
  const listing=useResource(useCallback(()=>request('/tasks/'+taskId+'/evidence',list),[taskId,version]));
  const details=useResource(useCallback(()=>selected ? request('/evidence/'+selected,evidenceDetail) : Promise.resolve(null),[selected,version]));
  function fileUpload(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=event.currentTarget;
    const fields=new FormData(form);
    fields.delete('record');
    if (replacement) fields.set('evidenceId',replacement);
    void operation.run(async () => {
      const created=await request('/tasks/'+taskId+'/evidence',id,'POST',fields);
      form.reset();
      setReplacement('');
      setSelected(created.id);
      setVersion((value)=>value+1);
    });
  }
  return <section className="panel">
    <h2>Task evidence</h2>
    <Resource {...listing}>{({evidence,canUpload})=><>
      {evidence.length ? <table><thead><tr><th>Evidence</th><th>Latest version</th><th>Decision</th></tr></thead>
        <tbody>{evidence.map((row)=><tr key={row.id}><td><button className="secondary" onClick={()=>setSelected(row.id)}>
          {row.title}</button></td><td>{row.number} · {row.filename}</td><td>{row.decision ?? 'Pending'}</td></tr>)}</tbody>
      </table> : <p>No evidence attached.</p>}
      {canUpload && <form className="form-grid extraction" onSubmit={fileUpload}>
        <Field label="Evidence record"><select name="record" value={replacement} onChange={(event)=>setReplacement(event.currentTarget.value)}>
          <option value="">New evidence record</option>
          {evidence.map((row)=><option key={row.id} value={row.id}>New version of {row.title}</option>)}
        </select></Field>
        {!replacement && <Field label="Evidence title"><input name="title" required maxLength={250}/></Field>}
        <Field label="PDF, PNG, or JPEG (up to 10 MiB)">
          <input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg" required/>
        </Field>
        <div><button disabled={operation.busy}>Upload evidence</button></div>
        {operation.error && <div className="wide"><Notice>{operation.error}</Notice></div>}
      </form>}
    </>}</Resource>
    {selected && <Resource {...details}>{(record)=>record && <EvidenceDetail record={record} key={record.id+':'+record.taskRevision}
      changed={()=>{setVersion((value)=>value+1);changed();}}/>}</Resource>}
  </section>;
}

function AuditEvents({events}:{events:z.infer<typeof auditEvent>[]}) {
  return events.length ? <table>
    <thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Entity</th><th>Details</th></tr></thead>
    <tbody>{events.map((event)=><tr key={event.id}>
      <td>{new Date(event.created_at).toLocaleString()}</td><td>{event.action}</td><td>{event.actor ?? 'System'}</td>
      <td>{event.target_type ?? '—'}</td><td><details><summary>View event</summary>
        {event.target_id && <p>Entity {event.target_id}</p>}
        {event.actor_id && <p>Actor {event.actor_id}</p>}
        <pre className="audit-details">{JSON.stringify(event.details,null,2)}</pre>
      </details></td>
    </tr>)}</tbody>
  </table> : <p>No matching events.</p>;
}

export function AuditLog() {
  const [cursors,advance]=useState<string[]>([]);
  const [filter,setFilter]=useState<{action:string;targetId:string}>({action:'',targetId:''});
  const before=cursors.at(-1);
  const data=useResource(useCallback(()=>{
    const query=new URLSearchParams();
    if (before) query.set('before',before);
    if (filter.action) query.set('action',filter.action);
    if (filter.targetId) query.set('targetId',filter.targetId);
    return request('/audit-logs?'+query,auditList);
  },[before,filter]));
  return <>
    <header className="page-head"><h1>Audit log</h1></header>
    <section className="panel"><form className="form-grid" onSubmit={(event)=>{
      event.preventDefault();
      const form=new FormData(event.currentTarget);
      setFilter({action:String(form.get('action')).trim(),targetId:String(form.get('targetId')).trim()});
      advance([]);
    }}>
      <Field label="Action"><input name="action" placeholder="evidence.approved" maxLength={120}/></Field>
      <Field label="Entity ID"><input name="targetId" maxLength={36}/></Field>
      <div><button>Filter events</button></div>
    </form></section>
    <Resource {...data}>{({events,next})=><section className="panel table-panel">
      <AuditEvents events={events}/>
      {(cursors.length>0 || next) && <div className="actions pagination">
        <button className="secondary" disabled={!cursors.length} onClick={()=>advance(cursors.slice(0,-1))}>Newer</button>
        <button className="secondary" disabled={!next} onClick={()=>{if(next) advance([...cursors,next]);}}>Older</button>
      </div>}
    </section>}</Resource>
  </>;
}

export function EntityHistory({path}: {path:string}) {
  const [open,setOpen]=useState(false);
  const data=useResource(useCallback(()=>open ? request(path+'/history',historySchema) : Promise.resolve(null),[path,open]));
  return <section className="panel table-panel">
    <h2>Audit history</h2>
    {!open ? <button className="secondary" onClick={()=>setOpen(true)}>Show audit history</button>
      : <Resource {...data}>{(result)=>result && <>
        <p>Source: <a href={`#/regulations/${result.lineage.regulation_id}?documentId=${result.lineage.document_id}&requirementId=${result.lineage.requirement_id}`}>
          View original regulatory requirement</a>
          {result.lineage.obligation_id && <> · <a href={`#/obligations/${result.lineage.obligation_id}`}>View obligation</a></>}</p>
        <AuditEvents events={result.events}/>
      </>}</Resource>}
  </section>;
}
