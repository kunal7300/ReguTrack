import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { z } from 'zod';
import { request, type Account } from './api';
import { errorMessage, Field, Notice, Resource, useResource } from './ui';
import { EntityHistory, TaskEvidence } from './evidence';

const id = z.object({id:z.uuid()});
const deadlines = z.array(z.object({id:z.string(),created_at:z.string(),actor:z.string(),
  previous:z.string(),current:z.string(),reason:z.string()}));
const obligation = id.extend({
  title:z.string(),description:z.string(),requirement_id:z.uuid(),department_id:z.uuid(),accountable_id:z.uuid(),
  department_name:z.string(),accountable_name:z.string(),target_date:z.string(),priority:z.string(),
  applicability:z.string().nullable(),approval_state:z.string(),implementation_status:z.string(),revision:z.number(),
  created_by:z.uuid(),edited_by:z.uuid(),
});
const obligationDetail = obligation.extend({
  requirement_title:z.string(),regulation_id:z.uuid(),remediation:z.object({action:z.string()}).nullable(),
  deadlineHistory:deadlines,canApprove:z.boolean(),
});
const task = id.extend({
  title:z.string(),description:z.string(),obligation_id:z.uuid(),obligation_title:z.string(),
  department_name:z.string(),department_id:z.uuid(),due_date:z.string(),status:z.string(),overdue:z.boolean(),
  assignee_name:z.string().nullable(),assignee_id:z.uuid().nullable(),revision:z.number(),
  submission_note:z.string().nullable(),
});
const taskDetail = task.extend({
  canReview:z.boolean(),
  deadlineHistory:deadlines,
  comments:z.array(id.extend({body:z.string(),author:z.string(),created_at:z.string()})),
  history:z.array(z.object({id:z.string(),from_status:z.string().nullable(),to_status:z.string(),
    reason:z.string().nullable(),actor:z.string(),created_at:z.string()})),
  assignments:z.array(id.extend({assignee:z.string(),assigned_by:z.string(),assigned_at:z.string(),ended_at:z.string().nullable()})),
});
const departments = z.object({departments:z.array(id.extend({name:z.string()}))});
const users = z.object({users:z.array(id.extend({name:z.string()}))});
const loadDepartments = () => request('/departments',departments);
const loadUsers = (departmentId:string) => request('/work/eligible-users?departmentId='+departmentId,users);
const has = (actor:Account,permission:string) => actor.permissions.includes('work.'+permission);
const manage = (actor:Account,departmentId:string) => has(actor,'manage_obligations') ||
  (has(actor,'manage_department') && actor.departmentId===departmentId);
const label = (value:string) => value.replaceAll('_',' ');
const priorities = ['low','medium','high','critical'] as const;
const statuses = ['created','assigned','in_progress','evidence_submitted','under_review','rejected','verified','completed','blocked','cancelled'];

function useSubmit() {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  async function submit(event:FormEvent<HTMLFormElement>, work:(fields:FormData,button:string) => Promise<void>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    setBusy(true);
    setError('');
    try { await work(fields,submitter instanceof HTMLButtonElement ? submitter.value : ''); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  return { busy,error,submit };
}

function Form({ children,onSave,className='form-grid' }: {
  children:(busy:boolean)=>ReactNode; onSave:(fields:FormData,button:string)=>Promise<void>; className?:string;
}) {
  const {busy,error,submit}=useSubmit();
  return <form className={className} onSubmit={(event) => void submit(event,onSave)}>
    {children(busy)}
    {error && <div className="wide"><Notice>{error}</Notice></div>}
  </form>;
}

function Pages({offset,size,more,move}: {offset:number;size:number;more:boolean;move:(value:number)=>void}) {
  return (offset > 0 || more) && <div className="actions pagination">
    <button className="secondary" disabled={!offset} onClick={()=>move(offset-size)}>Previous</button>
    <button className="secondary" disabled={!more} onClick={()=>move(offset+size)}>Next</button>
  </div>;
}

function DeadlineHistory({ records }: {records:z.infer<typeof deadlines>}) {
  return records.length > 0 && <details className="extraction"><summary>Deadline changes</summary>
    {records.map((item)=><p key={item.id}>{item.previous} → {item.current} · {item.actor} · {new Date(item.created_at).toLocaleString()}
      <br/>{item.reason}</p>)}
  </details>;
}

function Person({departmentId,name,initial}: {departmentId:string;name:string;initial?:string}) {
  const options = useResource(useCallback(() => departmentId ? loadUsers(departmentId) : Promise.resolve({users:[]}),[departmentId]));
  return <Resource {...options}>{({users:choices}) => <>
    <select name={name} defaultValue={initial ?? ''} required>
      <option value="" disabled>Select an active department user</option>
      {choices.map((user) => <option value={user.id} key={user.id}>{user.name}</option>)}
    </select>
    {!choices.length && <small>No active users in this department.</small>}
  </>}</Resource>;
}

export function CreateObligation({ query }: {query:string}) {
  const params = new URLSearchParams(query);
  const requirementId = params.get('requirementId');
  const gapId = params.get('gapId');
  const initialDepartment=params.get('departmentId') ?? '';
  const [departmentId,setDepartment] = useState(initialDepartment);
  const list = useResource(loadDepartments);
  const source = useResource(useCallback(() => gapId
    ? request('/gaps/'+gapId,z.object({remediation:z.object({action:z.string()}).nullable()}))
    : Promise.resolve({remediation:null}),[gapId]));
  return <section className="panel">
    <h1>Create obligation</h1>
    <p>{gapId ? 'From validated remediation' : 'From approved requirement'}</p>
    {!requirementId ? <Notice>Open an approved requirement or a validated gap to create an obligation.</Notice>
      : <Resource {...source}>{({remediation}) => <Resource {...list}>{({departments:choices}) => <Form onSave={async (fields) => {
        const record = await request('/obligations',id,'POST',{
          requirementId,gapId,title:fields.get('title'),description:fields.get('description'),departmentId,
          accountableId:fields.get('accountableId'),targetDate:fields.get('targetDate'),priority:fields.get('priority'),
          applicability:String(fields.get('applicability') ?? '').trim() || null,
        });
        location.hash='/obligations/'+record.id;
      }}>{(busy) => <>
        <Field label="Obligation title"><input name="title" required maxLength={250} /></Field>
        <Field label="Responsible department"><select name="departmentId" value={departmentId} required
          onChange={(event)=>setDepartment(event.currentTarget.value)}>
          <option value="" disabled>Select department</option>
          {choices.map((row)=><option key={row.id} value={row.id}>{row.name}</option>)}
        </select></Field>
        <div className="wide"><Field label="Implementation description"><textarea name="description"
          defaultValue={remediation?.action ?? ''} required maxLength={3000} /></Field></div>
        {departmentId && <Field label="Accountable officer"><Person departmentId={departmentId} key={departmentId} name="accountableId" /></Field>}
        <Field label="Target date"><input name="targetDate" type="date" defaultValue={params.get('dueDate') ?? ''} required /></Field>
        <Field label="Priority"><select name="priority" defaultValue="medium">{priorities.map((value)=><option key={value}>{value}</option>)}</select></Field>
        <Field label="Applicability"><input name="applicability" maxLength={250} /></Field>
        <div><button disabled={busy || !departmentId}>Create draft obligation</button></div>
      </>}</Form>}</Resource>}</Resource>}
  </section>;
}

export function Obligations({ actor }: {actor:Account}) {
  const [offset,move]=useState(0);
  const data=useResource(useCallback(() => request('/obligations?offset='+offset,
    z.object({obligations:z.array(obligation),hasMore:z.boolean()})),[offset]));
  return <>
    <header className="page-head"><h1>Compliance obligations</h1></header>
    <Resource {...data}>{({obligations,hasMore}) => <section className="panel table-panel">
      {obligations.length ? <table><thead><tr><th>Title</th><th>Department</th><th>Target</th><th>Approval</th><th>Implementation</th></tr></thead>
        <tbody>{obligations.map((row)=><tr key={row.id}>
          <td><a href={`#/obligations/${row.id}`}>{row.title}</a></td>
          <td>{row.department_name}</td><td>{row.target_date}</td><td>{row.approval_state}</td><td>{label(row.implementation_status)}</td>
        </tr>)}</tbody></table> : <p>{has(actor,'manage_obligations')
          ? 'Open an approved requirement or validated gap to create an obligation.' : 'No obligations are available in your scope.'}</p>}
      <Pages offset={offset} size={25} more={hasMore} move={move} />
    </section>}</Resource>
  </>;
}

function TaskRows({ rows }: { rows:z.infer<typeof task>[] }) {
  return rows.length ? <table>
    <thead><tr><th>Task</th><th>Department</th><th>Assignee</th><th>Due date</th><th>Status</th></tr></thead>
    <tbody>{rows.map((row)=><tr key={row.id}>
      <td><a href={`#/tasks/${row.id}`}>{row.title}</a></td><td>{row.department_name}</td><td>{row.assignee_name ?? 'Unassigned'}</td>
      <td>{row.due_date}{row.overdue && <small className="change-removed">Overdue</small>}</td><td>{label(row.status)}</td>
    </tr>)}</tbody>
  </table> : <p>No tasks match this view.</p>;
}

function TaskListing({ filter }: {filter:string}) {
  const [offset,move]=useState(0);
  const data=useResource(useCallback(() => request('/tasks?offset='+offset+filter,
    z.object({tasks:z.array(task),hasMore:z.boolean()})),[filter,offset]));
  return <Resource {...data}>{({tasks,hasMore}) => <section className="panel table-panel">
    <TaskRows rows={tasks} /><Pages offset={offset} size={25} more={hasMore} move={move} />
  </section>}</Resource>;
}

export function TaskBoard({ actor }: {actor:Account}) {
  const [mode,setMode]=useState('all');
  const [selected,setSelected]=useState('');
  const [status,setStatus]=useState('');
  const canFilter=has(actor,'read_all') || has(actor,'read_department');
  const choices=useResource(useCallback(() => canFilter ? loadDepartments() : Promise.resolve({departments:[]}),[canFilter]));
  const query=new URLSearchParams();
  if (mode==='mine') query.set('mine','true');
  if (mode==='overdue') query.set('overdue','true');
  if (selected) query.set('departmentId',selected);
  if (status) query.set('status',status);
  const filter='&'+query.toString();
  return <>
    <header className="page-head"><h1>Task board</h1></header>
    <section className="panel">
      <div className="actions">{[['all','Department work'],['mine','My tasks'],['overdue','Overdue']].map(([value,name]) =>
        <button className={mode===value ? '' : 'secondary'} key={value} aria-pressed={mode===value} onClick={()=>setMode(value)}>{name}</button>,
      )}</div>
      <div className="form-grid extraction">
        {canFilter && <Resource {...choices}>{({departments:rows}) =>
          <Field label="Department"><select value={selected} onChange={(event)=>setSelected(event.currentTarget.value)}>
            <option value="">All available</option>{rows.map((row)=><option key={row.id} value={row.id}>{row.name}</option>)}
          </select></Field>}</Resource>}
        <Field label="Status"><select value={status} onChange={(event)=>setStatus(event.currentTarget.value)}>
          <option value="">All statuses</option>{statuses.map((value)=><option key={value} value={value}>{label(value)}</option>)}
        </select></Field>
      </div>
    </section>
    <TaskListing key={filter} filter={filter} />
  </>;
}

function ObligationRecord({record,actor,reload}: {
  record:z.infer<typeof obligationDetail>;actor:Account;reload:()=>void;
}) {
  const officer=has(actor,'manage_obligations');
  const approved=record.approval_state==='approved';
  const [editing,setEditing]=useState(false);
  const [creating,setCreating]=useState(false);
  const path='/obligations/'+record.id;
  async function save(fields:FormData) {
    const targetDate=fields.get('targetDate');
    const payload = {
      revision:record.revision,targetDate,reason:String(fields.get('reason') ?? '').trim() || undefined,
      ...(!approved ? {
        title:fields.get('title'),description:fields.get('description'),
        accountableId:fields.get('accountableId'),priority:fields.get('priority'),
        applicability:String(fields.get('applicability') ?? '').trim() || null,
      } : {}),
    };
    await request(path,id,'PATCH',payload);
    setEditing(false);
    reload();
  }
  return <>
    <header className="page-head"><h1>{record.title}</h1></header>
    <section className="panel">
      <p>{record.description}</p>
      <dl className="profile">
        <div><dt>Approved requirement</dt><dd><a href={`#/regulations/${record.regulation_id}`}>{record.requirement_title}</a></dd></div>
        <div><dt>Department and accountable officer</dt><dd>{record.department_name} · {record.accountable_name}</dd></div>
        <div><dt>Target date and priority</dt><dd>{record.target_date} · {record.priority}</dd></div>
        <div><dt>Approval and implementation</dt><dd>{record.approval_state} · {label(record.implementation_status)}</dd></div>
        <div><dt>Applicability</dt><dd>{record.applicability ?? 'Unknown'}</dd></div>
        {record.remediation && <div><dt>Validated remediation</dt><dd>{record.remediation.action}</dd></div>}
      </dl>
      <DeadlineHistory records={record.deadlineHistory} />
      {officer && <div className="extraction">
        <button className="secondary" onClick={()=>setEditing(!editing)}>{editing ? 'Close edit' : approved ? 'Amend target date' : 'Edit draft'}</button>
        {editing && <div className="extraction"><Form onSave={save}>{(busy)=><>
          {!approved && <>
            <Field label="Title"><input name="title" defaultValue={record.title} required maxLength={250}/></Field>
            <Field label="Accountable officer"><Person name="accountableId" departmentId={record.department_id} initial={record.accountable_id}/></Field>
            <Field label="Description"><textarea name="description" defaultValue={record.description} required maxLength={3000}/></Field>
            <Field label="Priority"><select name="priority" defaultValue={record.priority}>{priorities.map((value)=><option key={value}>{value}</option>)}</select></Field>
            <Field label="Applicability"><input name="applicability" defaultValue={record.applicability ?? ''} maxLength={250}/></Field>
          </>}
          <Field label="Target date"><input name="targetDate" type="date" defaultValue={record.target_date} required/></Field>
          <Field label="Reason for changing target date"><input name="reason" maxLength={3000}/></Field>
          <div><button disabled={busy}>Save obligation</button></div>
        </>}</Form></div>}
        {!approved && (!record.canApprove ? <p>A different officer must approve this obligation.</p>
          : <Form className="actions extraction" onSave={async () => {
            await request(path,id,'PATCH',{revision:record.revision,action:'approve'});
            reload();
          }}>{(busy)=><button disabled={busy}>Approve obligation</button>}</Form>)}
      </div>}
    </section>
    <section className="panel">
      <header className="page-head"><h2>Department tasks</h2>
        {approved && manage(actor,record.department_id) && <button className="secondary" onClick={()=>setCreating(!creating)}>
          {creating ? 'Close task form' : 'Create task'}
        </button>}
      </header>
      {creating && <Form onSave={async (fields) => {
        const created=await request('/tasks',id,'POST',{
          obligationId:record.id,title:fields.get('title'),description:fields.get('description'),dueDate:fields.get('dueDate'),
        });
        location.hash='/tasks/'+created.id;
      }}>{(busy)=><>
        <Field label="Task title"><input name="title" required maxLength={250}/></Field>
        <Field label="Due date"><input name="dueDate" type="date" defaultValue={record.target_date} required/></Field>
        <Field label="Task description"><textarea name="description" required maxLength={3000}/></Field>
        <div className="wide"><button disabled={busy}>Save task</button></div>
      </>}</Form>}
    </section>
    <TaskListing filter={'&obligationId='+record.id} />
    <EntityHistory path={path} />
  </>;
}

export function ObligationDetail({actor,obligationId}: {actor:Account;obligationId:string}) {
  const [version,setVersion]=useState(0);
  const data=useResource(useCallback(() => request('/obligations/'+obligationId,obligationDetail),[obligationId,version]));
  return <Resource {...data}>{(record)=><ObligationRecord actor={actor} record={record} key={record.revision}
    reload={()=>setVersion((value)=>value+1)} />}</Resource>;
}

function TaskRecord({record,actor,reload}: {record:z.infer<typeof taskDetail>;actor:Account;reload:()=>void}) {
  const manager=manage(actor,record.department_id);
  const own=record.assignee_id===actor.id && actor.departmentId===record.department_id;
  const available=['created','assigned','in_progress','rejected','blocked'].includes(record.status);
  const editable=available && manager;
  const path='/tasks/'+record.id;
  async function save(suffix:string,data:object,method='POST') {
    await request(path+suffix,id,method,data);
    reload();
  }
  const start=own && ['assigned','rejected'].includes(record.status);
  const managerActions = manager ? [
    ...(['assigned','in_progress','rejected'].includes(record.status) ? ['block'] : []),
    ...(record.status==='blocked' ? ['resume'] : []),
    ...(!['verified','completed','cancelled'].includes(record.status) ? ['cancel'] : []),
    ...(record.status==='verified' ? ['complete'] : []),
  ] : [];
  const actions=[...(start ? ['start'] : []),...managerActions];
  return <>
    <header className="page-head"><h1>{record.title}</h1></header>
    <section className="panel">
      <p><a href={`#/obligations/${record.obligation_id}`}>{record.obligation_title}</a> · {record.department_name}</p>
      <p>{record.description}</p>
      <p>{label(record.status)} · {record.assignee_name ?? 'Unassigned'} · Due {record.due_date}
        {record.overdue && <strong className="change-removed"> · Overdue</strong>}</p>
      {record.submission_note && <p><strong>Submission note</strong> {record.submission_note}</p>}
      {actions.length > 0 && <Form onSave={(fields,action) => save('',{
        revision:record.revision,action,reason:String(fields.get('reason') ?? '').trim() || undefined,
      },'PATCH')}>{(busy)=><>
        {managerActions.some((action)=>['block','resume','cancel'].includes(action)) &&
          <Field label="Reason for blocking, resuming, or cancelling"><input name="reason" maxLength={3000}/></Field>}
        <div className="actions wide">{actions.map((action)=><button value={action} disabled={busy} key={action}>{label(action)}</button>)}</div>
      </>}</Form>}
    </section>
    {editable && <section className="panel"><h2>Assignment and deadline</h2>
      <Form onSave={(fields)=>save('/assign',{revision:record.revision,assigneeId:fields.get('assigneeId')})}>{(busy)=><>
        <Field label="Assign to"><Person departmentId={record.department_id} name="assigneeId" initial={record.assignee_id ?? undefined}/></Field>
        <div><button disabled={busy}>Save assignment</button></div>
      </>}</Form>
      <div className="extraction"><Form onSave={(fields)=>save('',{
        revision:record.revision,dueDate:fields.get('dueDate'),reason:String(fields.get('reason') ?? '').trim() || undefined,
        title:fields.get('title'),description:fields.get('description'),
      },'PATCH')}>{(busy)=><>
        <Field label="Task title"><input name="title" defaultValue={record.title} required maxLength={250}/></Field>
        <Field label="Description"><textarea name="description" defaultValue={record.description} required maxLength={3000}/></Field>
        <Field label="Due date"><input name="dueDate" type="date" defaultValue={record.due_date} required/></Field>
        <Field label="Reason for changing due date"><input name="reason" maxLength={3000}/></Field>
        <div><button disabled={busy}>Save task details</button></div>
      </>}</Form></div>
    </section>}
    <TaskEvidence taskId={record.id} changed={reload} />
    {own && ['in_progress','rejected'].includes(record.status) && <section className="panel">
      <h2>Submit work for review</h2>
      <p>Upload evidence before submitting work.</p>
      <Form onSave={(fields)=>save('/submit',{revision:record.revision,note:fields.get('note')})}>{(busy)=><>
        <div className="wide"><Field label="Submission note"><textarea name="note" required maxLength={3000}/></Field></div>
        <div><button disabled={busy}>Submit work</button></div>
      </>}</Form>
    </section>}
    {manager && ['evidence_submitted','under_review'].includes(record.status) && <section className="panel"><h2>Manager review</h2>
      {!record.canReview ? <p>An independent reviewer must check this work.</p> :
        <Form onSave={(fields,decision)=>save('/verify',{
          revision:record.revision,decision,note:String(fields.get('note') ?? '').trim() || undefined,
        })}>{(busy)=><>
          <div className="wide"><Field label="Review note"><textarea name="note" maxLength={3000}/></Field></div>
          <div className="actions wide">{record.status==='evidence_submitted'
            ? <button value="start_review" disabled={busy}>Start review</button>
            : <><button value="verify" disabled={busy}>Verify work</button>
              <button value="reject" className="secondary" disabled={busy}>Reject for resubmission</button></>}</div>
        </>}</Form>}
    </section>}
    <section className="panel"><h2>Task comments</h2>
      {(manager || own) && <Form onSave={async (fields) => { await save('/comments',{body:fields.get('comment')}); }}>{(busy)=><>
        <div className="wide"><Field label="Comment"><textarea name="comment" required maxLength={3000}/></Field></div>
        <div><button disabled={busy}>Add comment</button></div>
      </>}</Form>}
      {record.comments.length ? record.comments.map((item)=><p key={item.id}><strong>{item.author}</strong> · {new Date(item.created_at).toLocaleString()}<br/>{item.body}</p>)
        : <p>No comments.</p>}
    </section>
    <section className="panel"><h2>Task history</h2>
      <DeadlineHistory records={record.deadlineHistory} />
      {record.history.map((item)=><p key={item.id}><strong>{label(item.to_status)}</strong> · {item.actor} · {new Date(item.created_at).toLocaleString()}
        {item.reason && <><br/>{item.reason}</>}</p>)}
      {record.assignments.length > 0 && <details><summary>Assignment history</summary>
        {record.assignments.map((item)=><p key={item.id}>{item.assignee} · Assigned by {item.assigned_by} · {new Date(item.assigned_at).toLocaleString()}
          {item.ended_at && ' · Ended ' + new Date(item.ended_at).toLocaleString()}</p>)}
      </details>}
    </section>
    <EntityHistory path={path} />
  </>;
}
export function TaskDetail({actor,taskId}: {actor:Account;taskId:string}) {
  const [version,setVersion]=useState(0);
  const data=useResource(useCallback(() => request('/tasks/'+taskId,taskDetail),[taskId,version]));
  return <Resource {...data}>{(record)=><TaskRecord actor={actor} record={record} key={version} reload={()=>setVersion((value)=>value+1)} />}</Resource>;
}
