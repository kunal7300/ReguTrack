import { useCallback, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { request, type Account } from './api';
import { errorMessage, Field, Notice, Resource, useResource } from './ui';

const id = z.object({ id:z.uuid() });
const control = id.extend({ name:z.string(),description:z.string(),department_name:z.string().nullable() });
const controlList = z.object({controls:z.array(control),hasMore:z.boolean()});
const gap = id.extend({
  requirement_id:z.uuid(),regulation_id:z.uuid(),requirement_title:z.string(),regulation_title:z.string(),
  status:z.string(),decision:z.string().nullable(),
});
const gapList = z.object({gaps:z.array(gap),hasMore:z.boolean()});
const detail = gap.extend({
  controls:z.array(control),requirement_description:z.string(),revision:z.number(),
  proposed_status:z.string().nullable(),assessment:z.string().nullable(),remediation_proposal:z.string().nullable(),
  ai_error:z.string().nullable(),
  ai_suggestion:z.object({observation:z.string(),remediation:z.string().nullable(),controlIds:z.array(z.uuid())}).nullable(),
  remediation:z.object({action:z.string(),departmentId:z.uuid().nullable(),dueDate:z.string().nullable()}).nullable(),
  history:z.array(z.object({action:z.string(),actor:z.string(),actorId:z.uuid(),at:z.string(),comment:z.string().optional()})),
});
const label = (value:string) => value.replaceAll('_',' ');
const loadDepartments = () => request('/departments',z.object({
  departments:z.array(id.extend({name:z.string()})),
}));
const mayManage = (actor:Account) => actor.permissions.includes('gaps.manage');

function useSubmission() {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  async function submit(event:FormEvent<HTMLFormElement>, operation:(data:FormData) => Promise<unknown>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try { await operation(data); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return {busy,error,submit};
}

function Paging({ offset, size, more, select }: {offset:number;size:number;more:boolean;select:(value:number) => void}) {
  return (offset > 0 || more) && <div className="actions pagination">
    <button type="button" className="secondary" disabled={!offset} onClick={() => select(offset-size)}>Previous</button>
    <button type="button" className="secondary" disabled={!more} onClick={() => select(offset+size)}>Next</button>
  </div>;
}

function Department({ departments }: {departments:{id:string;name:string}[]}) {
  return <select name="department"><option value="">Unassigned</option>
    {departments.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
  </select>;
}

export function ControlRegister({ actor }: {actor:Account}) {
  const [offset,setOffset] = useState(0);
  const [version,reload] = useState(0);
  const rows = useResource(useCallback(() => request('/controls?offset='+offset,controlList),[offset,version]));
  const departments = useResource(useCallback(() => mayManage(actor)
    ? loadDepartments() : Promise.resolve({departments:[]}),[actor]));
  const form = useSubmission();
  return <>
    <header className="page-head"><h1>Control register</h1></header>
    {mayManage(actor) && <section className="panel"><h2>Add a control</h2>
      <Resource {...departments}>{({departments:options}) =>
        <form className="form-grid" onSubmit={(event) => {
          const element = event.currentTarget;
          void form.submit(event,async (data) => {
            await request('/controls',id,'POST',{
              name:data.get('name'),description:data.get('description'),departmentId:data.get('department') || null,
            });
            element.reset();
            setOffset(0);
            reload((value) => value+1);
          });
        }}>
          <Field label="Control name"><input name="name" required maxLength={250} /></Field>
          <Field label="Owning department"><Department departments={options} /></Field>
          <div className="wide"><Field label="Control description"><textarea name="description" required maxLength={1800} /></Field></div>
          {form.error && <div className="wide"><Notice>{form.error}</Notice></div>}
          <div><button disabled={form.busy}>Add control</button></div>
        </form>}</Resource>
    </section>}
    <Resource {...rows}>{({controls,hasMore}) => <section className="panel table-panel">
      {controls.length ? <table><thead><tr><th>Control</th><th>Description</th><th>Department</th></tr></thead>
        <tbody>{controls.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.description}</td><td>{row.department_name ?? '—'}</td></tr>)}</tbody>
      </table> : <p>No controls registered.</p>}
      <Paging offset={offset} size={50} more={hasMore} select={setOffset} />
    </section>}</Resource>
  </>;
}

export function RequirementGap({ actor,requirementId }: {actor:Account;requirementId:string}) {
  const [open,setOpen] = useState(false);
  const [offset,setOffset] = useState(0);
  const [selected,setSelected] = useState<Map<string,string>>(new Map());
  const existing = useResource(useCallback(() => request('/gaps?requirementId='+requirementId,gapList),[requirementId]));
  const controls = useResource(useCallback(() => open ? request('/controls?offset='+offset,controlList)
    : Promise.resolve({controls:[],hasMore:false}),[open,offset]));
  const form = useSubmission();
  return <div className="extraction">
    <h3>Compliance gap assessment</h3>
    <Resource {...existing}>{({gaps}) => gaps.length
      ? <a className="button secondary" href={`#/gaps/${gaps[0].id}`}>Open assessment</a>
      : mayManage(actor) ? open
        ? <form onSubmit={(event) => void form.submit(event,async (data) => {
          const created=await request('/requirements/'+requirementId+'/gaps',id,'POST',{
            controlIds:[...selected.keys()],includeAi:data.has('ai'),
          });
          location.hash='/gaps/'+created.id;
        })}>
          <Resource {...controls}>{({controls:rows,hasMore}) => <>
            <fieldset className="checkboxes"><legend>Map existing controls</legend>
              {rows.length ? rows.map((row) => <label key={row.id}>
                <input type="checkbox" checked={selected.has(row.id)}
                  disabled={selected.size >= 20 && !selected.has(row.id)} onChange={(event) => {
                    const next=new Map(selected);
                    if (event.currentTarget.checked) next.set(row.id,row.name); else next.delete(row.id);
                    setSelected(next);
                  }} />{row.name}</label>) : <p>No controls registered. You can assess the requirement without a mapping.</p>}
            </fieldset>
            <Paging offset={offset} size={50} more={hasMore} select={setOffset} />
          </>}</Resource>
          {selected.size > 0 && <p>{selected.size} selected · {[...selected.values()].join(', ')}</p>}
          <p><label><input type="checkbox" name="ai" /> Send the approved requirement and selected control descriptions to Gemini for suggestions</label></p>
          {form.error && <Notice>{form.error}</Notice>}
          <button disabled={form.busy}>{form.busy ? 'Creating assessment…' : 'Create assessment'}</button>
        </form> : <button className="secondary" onClick={() => setOpen(true)}>Map controls and assess gap</button>
        : <p>No assessment recorded.</p>}</Resource>
  </div>;
}

export function GapOverview() {
  const [offset,setOffset] = useState(0);
  const rows=useResource(useCallback(() => request('/gaps?offset='+offset,gapList),[offset]));
  return <>
    <header className="page-head"><h1>Compliance gaps</h1></header>
    <Resource {...rows}>{({gaps,hasMore}) => <section className="panel table-panel">
      {gaps.length ? <table><thead><tr><th>Requirement</th><th>Regulation</th><th>Status</th><th>Review</th></tr></thead>
        <tbody>{gaps.map((row) => <tr key={row.id}>
          <td><a href={`#/gaps/${row.id}`}>{row.requirement_title}</a></td><td>{row.regulation_title}</td>
          <td>{label(row.status)}</td><td>{row.decision ?? '—'}</td>
        </tr>)}</tbody></table>
        : <p>No assessments. Open an approved requirement in the regulatory library to create one.</p>}
      <Paging offset={offset} size={25} more={hasMore} select={setOffset} />
    </section>}</Resource>
  </>;
}

function Assessment({ record, actor, reload }: {record:z.infer<typeof detail>;actor:Account;reload:() => void}) {
  const form=useSubmission();
  const reviewer=useSubmission();
  const departments=useResource(useCallback(() => mayManage(actor)
    ? loadDepartments() : Promise.resolve({departments:[]}),[actor]));
  const owner=departments.data?.departments.find((row) => row.id === record.remediation?.departmentId);
  const open=record.proposed_status === 'gap_identified' || record.proposed_status === 'partially_addressed';
  const outcomes=['gap_identified','partially_addressed','fully_addressed','not_applicable'];
  return <>
    <header className="page-head"><h1>{record.requirement_title}</h1></header>
    <section className="panel">
      <p><a href={`#/regulations/${record.regulation_id}`}>{record.regulation_title}</a> · {label(record.status)}</p>
      <p>{record.requirement_description}</p>
      <h2>Mapped controls</h2>
      {record.controls.length ? <ul>{record.controls.map((row) =>
        <li key={row.id}><strong>{row.name}</strong> · {row.description}</li>)}</ul> : <p>No controls mapped.</p>}
      {record.ai_error && <Notice>{record.ai_error}</Notice>}
      {record.ai_suggestion && <section className="extraction"><h2>AI gap suggestion</h2>
        <p>{record.ai_suggestion.observation}</p>
        {record.ai_suggestion.remediation && <p><strong>Suggested remediation</strong> {record.ai_suggestion.remediation}</p>}
        {record.ai_suggestion.controlIds.length > 0 && <p><strong>Referenced controls</strong>{' '}
          {record.controls.filter((item) => record.ai_suggestion?.controlIds.includes(item.id)).map((item) => item.name).join(', ')}</p>}
      </section>}
      {record.assessment && <section className="extraction"><h2>Officer assessment</h2>
        <p>{record.proposed_status && label(record.proposed_status)} · {record.assessment}</p>
        {record.remediation_proposal && <p><strong>Proposed action</strong> {record.remediation_proposal}</p>}
      </section>}
      {record.remediation && <section className="extraction"><h2>Validated remediation</h2>
        <p>{record.remediation.action}</p>
        <p><strong>Owner</strong> {owner?.name ?? (record.remediation.departmentId ? 'Assigned department' : 'Unassigned')} ·
          <strong> Due date</strong> {record.remediation.dueDate ?? 'Not set'}</p>
        {actor.permissions.includes('work.manage_obligations') && <a className="button secondary" href={
          '#/obligations/new?' + new URLSearchParams({requirementId:record.requirement_id,gapId:record.id,
            departmentId:record.remediation.departmentId ?? '',dueDate:record.remediation.dueDate ?? ''})
        }>Create obligation from remediation</a>}
      </section>}
      {record.history.length > 0 && <section className="extraction"><h2>Review history</h2>
        {record.history.map((entry,index) => <p key={index}>{entry.actor} · {entry.action} · {new Date(entry.at).toLocaleString()}
          {entry.comment && <><br />{entry.comment}</>}</p>)}
      </section>}
    </section>
    {mayManage(actor) && record.decision !== 'approved' && <section className="panel"><h2>Submit assessment</h2>
      <form className="form-grid" onSubmit={(event) => void form.submit(event,async (data) => {
        await request('/gaps/'+record.id,id,'PATCH',{
          revision:record.revision,outcome:data.get('outcome'),assessment:data.get('assessment'),
          remediationProposal:String(data.get('proposal') ?? '').trim() || null,
        });
        reload();
      })}>
        <Field label="Assessment outcome"><select name="outcome" defaultValue={record.proposed_status ?? 'gap_identified'}>
          {outcomes.map((value) => <option key={value} value={value}>{label(value)}</option>)}
        </select></Field>
        <div className="wide"><Field label="Assessment rationale"><textarea name="assessment" defaultValue={record.assessment ?? ''} required maxLength={1800} /></Field></div>
        <div className="wide"><Field label="Remediation proposal"><textarea name="proposal" defaultValue={record.remediation_proposal ?? ''} maxLength={1800} /></Field></div>
        {form.error && <div className="wide"><Notice>{form.error}</Notice></div>}
        <div><button disabled={form.busy}>Submit for validation</button></div>
      </form>
    </section>}
    {mayManage(actor) && record.status === 'awaiting_validation' && <section className="panel"><h2>Validate assessment</h2>
      {record.history.at(-1)?.actorId === actor.id &&
        <p>Validation requires a different officer from the one who submitted the assessment.</p>}
      <form className="form-grid" onSubmit={(event) => void reviewer.submit(event,async (data) => {
        await request('/gaps/'+record.id+'/review',id,'POST',{
          revision:record.revision,decision:data.get('decision'),comment:data.get('comment'),
          ownerDepartmentId:data.get('department') || null,dueDate:data.get('dueDate') || null,
        });
        reload();
      })}>
        <Field label="Review decision"><select name="decision"><option value="approved">Approve</option><option value="rejected">Reject</option></select></Field>
        {open && <>
          <Field label="Remediation owner">
            <Resource {...departments}>{({departments:rows}) => <Department departments={rows} />}</Resource>
          </Field>
          <Field label="Remediation due date"><input name="dueDate" type="date" /></Field>
        </>}
        <div className="wide"><Field label="Reviewer comment"><textarea name="comment" required maxLength={1800} /></Field></div>
        {reviewer.error && <div className="wide"><Notice>{reviewer.error}</Notice></div>}
        <div><button disabled={reviewer.busy || record.history.at(-1)?.actorId === actor.id}>Save validation</button></div>
      </form>
    </section>}
  </>;
}

export function GapDetail({ actor,gapId }: {actor:Account;gapId:string}) {
  const [version,reload]=useState(0);
  const data=useResource(useCallback(() => request('/gaps/'+gapId,detail),[gapId,version]));
  return <Resource {...data}>{(record) => <Assessment key={record.revision} record={record} actor={actor}
    reload={() => reload((value) => value+1)} />}</Resource>;
}
