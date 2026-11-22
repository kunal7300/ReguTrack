import { useCallback,useEffect,useState,type FormEvent } from 'react';
import { z } from 'zod';
import { fetchReport,request } from './api';
import { errorMessage,Field,Notice,Resource,useResource } from './ui';

const task=z.object({
  id:z.uuid(), title:z.string(), due_date:z.string(),status:z.string(),
  department:z.string(),assignee:z.string().nullable(),obligation_id:z.uuid(),overdue:z.boolean(),
});
const department=z.object({
  id:z.uuid(),department:z.string(),pending_tasks:z.number(),overdue_tasks:z.number(),
  completed_tasks:z.number(),total_tasks:z.number(),completion_rate:z.number(),
});
const summary=z.object({
  view:z.enum(['compliance','manager','employee','auditor']),metrics:z.record(z.string(),z.number()),
});
const taskFeed=z.object({
  tasks:z.array(task),hasMore:z.boolean(),
  updates:z.array(z.object({task_id:z.uuid(),title:z.string(),note:z.string(),kind:z.string(),created_at:z.string(),actor:z.string()})),
  evidenceDecisions:z.array(z.object({id:z.uuid(),task_id:z.uuid(),title:z.string(),decision:z.string(),reviewer:z.string(),created_at:z.string()})),
});
const obligationTarget=z.object({id:z.uuid(),title:z.string(),target_date:z.string(),department:z.string()});
const deadlineFeed=z.object({
  upcoming:z.array(task),overdue:z.array(task),
  obligations:z.array(obligationTarget),highPriority:z.array(obligationTarget),
});
const inbox=z.object({
  unread:z.number(),hasMore:z.boolean(),notifications:z.array(z.object({
    id:z.uuid(),title:z.string(),route:z.string(),created_at:z.string(),read_at:z.string().nullable(),
  })),
});
const titles={
  compliance:'Compliance dashboard',manager:'Department dashboard',employee:'My work dashboard',auditor:'Auditor dashboard',
};
const metrics={
  compliance:[['total_regulations','Regulations'],['new_regulatory_updates','New uploads (30 days)'],
    ['extracted_requirements','Extracted requirements'],['awaiting_review','Requirements awaiting review'],
    ['active_obligations','Active obligations'],['completed_obligations','Completed obligations'],
    ['pending_tasks','Pending tasks'],['overdue_tasks','Overdue tasks'],['high_priority','High-priority obligations'],
    ['upcoming_deadlines','Task deadlines in 7 days']],
  manager:[['active_obligations','Active obligations'],['assigned_employees','Assigned employees'],
    ['pending_tasks','Pending tasks'],['overdue_tasks','Overdue tasks'],['evidence_awaiting_review','Evidence awaiting review'],
    ['completion_rate','Task completion rate']],
  employee:[['assigned_tasks','My open tasks'],['upcoming_deadlines','Deadlines in 7 days'],
    ['overdue_tasks','Overdue tasks'],['awaiting_evidence','Tasks awaiting evidence'],['rejected_evidence','Rejected evidence versions']],
  auditor:[['completed_obligations','Completed obligations'],['evidence_records','Evidence records'],
    ['evidence_approvals','Evidence approvals'],['rejected_evidence','Evidence rejections']],
} as const;
const loadSummary=()=>request('/dashboard/summary',summary);
const loadDepartments=()=>request('/dashboard/departments',z.object({departments:z.array(department)}));
const loadDeadlines=()=>request('/dashboard/deadlines',deadlineFeed);
const pretty=(value:string)=>value.replaceAll('_',' ');

function TaskLinks({rows}:{rows:z.infer<typeof task>[]}) {
  return rows.length>0 ? <ul className="dashboard-list">
    {rows.map((item)=><li key={item.id}><a href={`#/tasks/${item.id}`}>{item.title}</a>
      <small>{item.department} · {pretty(item.status)} · Due {item.due_date}</small></li>)}
  </ul> : <p>No matching tasks.</p>;
}
function TaskPanel({auditor}:{auditor:boolean}) {
  const [offset,setOffset]=useState(0);
  const tasks=useResource(useCallback(()=>request('/dashboard/tasks?offset='+offset,taskFeed),[offset]));
  return <Resource {...tasks}>{({tasks:rows,updates,hasMore,evidenceDecisions})=><div className="dashboard-grid">
    <section className="panel"><h2>{auditor ? 'Completed tasks and evidence' : 'Open tasks'}</h2>
      <TaskLinks rows={rows}/>
      <Pagination offset={offset} more={hasMore} move={setOffset}/>
    </section>
    {auditor && <section className="panel"><h2>Recent evidence decisions</h2>
      {evidenceDecisions.length ? <ul className="dashboard-list">{evidenceDecisions.map((item)=><li key={item.id}>
        <a href={`#/tasks/${item.task_id}`}>{item.title}</a>
        <small>{item.decision} · {item.reviewer} · {new Date(item.created_at).toLocaleString()}</small>
      </li>)}</ul> : <p>No evidence decisions recorded.</p>}
    </section>}
    <section className="panel"><h2>Recent comments and updates</h2>
      {updates.length ? <ul className="dashboard-list">{updates.map((item,index)=><li key={index}>
        <a href={`#/tasks/${item.task_id}`}>{item.title}</a>
        <small>{item.actor} · {new Date(item.created_at).toLocaleString()}</small>
        <p>{item.kind==='status' ? pretty(item.note) : item.note}</p>
      </li>)}</ul> : <p>No recent updates.</p>}
    </section>
  </div>}</Resource>;
}
function Pagination({offset,more,move}:{offset:number;more:boolean;move:(value:number)=>void}) {
  return (offset>0 || more) && <div className="actions pagination">
    <button className="secondary" disabled={!offset} onClick={()=>move(offset-25)}>Previous</button>
    <button className="secondary" disabled={!more} onClick={()=>move(offset+25)}>Next</button>
  </div>;
}

function Deadlines() {
  const data=useResource(loadDeadlines);
  return <Resource {...data}>{({upcoming,overdue,obligations,highPriority})=><div className="dashboard-grid">
    <section className="panel"><h2>Upcoming deadlines</h2><TaskLinks rows={upcoming}/>
      {obligations.length>0 && <><h3>Obligation targets</h3><ul className="dashboard-list">
        {obligations.map((item)=><li key={item.id}><a href={`#/obligations/${item.id}`}>{item.title}</a>
          <small>{item.department} · Target {item.target_date}</small></li>)}</ul></>}
    </section>
    <section className="panel"><h2>Overdue tasks</h2><TaskLinks rows={overdue}/></section>
    {highPriority.length>0 && <section className="panel"><h2>High-priority obligations</h2><ul className="dashboard-list">
      {highPriority.map((item)=><li key={item.id}><a href={`#/obligations/${item.id}`}>{item.title}</a>
        <small>{item.department} · Target {item.target_date}</small></li>)}
    </ul></section>}
  </div>}</Resource>;
}
function DepartmentProgress() {
  const data=useResource(loadDepartments);
  return <section className="panel"><header className="page-head"><h2>Department progress</h2>
    <a href="#/reports">View reports</a></header>
    <Resource {...data}>{({departments})=>departments.length ? <ul className="dashboard-list">
      {departments.map((item)=><li key={item.id}>
        <div className="page-head"><strong>{item.department}</strong><span>{item.completed_tasks} / {item.total_tasks} completed</span></div>
        <progress max={100} value={item.completion_rate} aria-label={item.department+' task completion'}/>
        <small>{item.completion_rate}% complete · {item.pending_tasks} pending · {item.overdue_tasks} overdue</small>
      </li>)}
    </ul> : <p>No department data.</p>}</Resource>
  </section>;
}
export function Dashboard() {
  const data=useResource(loadSummary);
  return <Resource {...data}>{({view,metrics:values})=><>
    <header className="page-head"><h1>{titles[view]}</h1>
      {view==='auditor' && <a className="button secondary" href="#/audit-logs">Search audit log</a>}
    </header>
    <div className="metric-grid">{metrics[view].map(([key,name])=><div className="panel metric" key={key}>
      <span>{name}</span><strong>{values[key] ?? 0}{key==='completion_rate' && '%'}</strong>
    </div>)}</div>
    {view==='compliance' && <DepartmentProgress/>}
    {view!=='auditor' && <Deadlines/>}
    <TaskPanel auditor={view==='auditor'}/>
  </>}</Resource>;
}

export function NotificationBadge({actorId}:{actorId:string}) {
  const [unread,setUnread]=useState(0);
  useEffect(()=>{
    let current=true;
    async function update() {
      try {
        const data=await request('/notifications',inbox);
        if (current) setUnread(data.unread);
      } catch { /* The inbox reports request failures. */ }
    }
    void update();
    const timer=window.setInterval(()=>void update(),30_000);
    window.addEventListener('regutrack-notification-read',update);
    return ()=>{current=false;clearInterval(timer);window.removeEventListener('regutrack-notification-read',update);};
  },[actorId]);
  return unread>0 ? <span className="notification-count" aria-label={unread+' unread'}>{unread>99?'99+':unread}</span> : null;
}

export function Notifications() {
  const [offset,setOffset]=useState(0);
  const [version,reload]=useState(0);
  const [error,setError]=useState('');
  const data=useResource(useCallback(()=>request('/notifications?offset='+offset,inbox),[offset,version]));
  async function read(id:string) {
    setError('');
    try {
      await request('/notifications/'+id+'/read',z.object({id:z.uuid()}),'PATCH',{});
      reload((value)=>value+1);
      window.dispatchEvent(new Event('regutrack-notification-read'));
    } catch (reason) {setError(errorMessage(reason));}
  }
  return <>
    <header className="page-head"><h1>Notifications</h1>
      <button className="secondary" onClick={()=>reload((value)=>value+1)}>Refresh inbox</button>
    </header>
    {error && <Notice>{error}</Notice>}
    <Resource {...data}>{({notifications,hasMore,unread})=><section className="panel">
      <h2>{unread} unread</h2>
      {notifications.length ? <ul className="dashboard-list">
        {notifications.map((item)=><li key={item.id}><div className="page-head">
          <a href={'#'+item.route}>{item.title}</a>
          {!item.read_at && <button className="secondary" onClick={()=>void read(item.id)}>Mark as read</button>}
        </div><small>{new Date(item.created_at).toLocaleString()}</small></li>)}
      </ul> : <p>No notifications yet.</p>}
      <Pagination offset={offset} more={hasMore} move={setOffset}/>
    </section>}</Resource>
  </>;
}

const reportKinds=[
  {id:'compliance',name:'Compliance',columns:['title','department','accountable','target_date','priority','approval_state','completed','requirement','regulation']},
  {id:'overdue',name:'Overdue tasks',columns:['title','department','assignee','due_date','status']},
  {id:'department-progress',name:'Department progress',columns:['department','active_obligations','completed_obligations',
    'pending_tasks','overdue_tasks','completed_tasks','completion_rate']},
] as const;
const reportSchema=z.object({rows:z.array(z.record(z.string(),z.union([z.string(),z.number(),z.boolean(),z.null()]))),hasMore:z.boolean()});
export function Reports() {
  const [kind,setKind]=useState(0);
  const [offset,move]=useState(0);
  const [dept,setDept]=useState('');
  const [downloading,setDownloading]=useState(false);
  const [error,setError]=useState('');
  const current=reportKinds[kind];
  const path='/reports/'+current.id;
  const query=dept?'&departmentId='+dept:'';
  const report=useResource(useCallback(()=>request(path+'?offset='+offset+query,reportSchema),[path,offset,query]));
  const options=useResource(loadDepartments);
  async function download() {
    setDownloading(true);
    setError('');
    try {
      const url=URL.createObjectURL(await fetchReport(path+'?format=csv&offset='+offset+query));
      const link=document.createElement('a');
      link.href=url;
      link.download=current.id+'.csv';
      link.click();
      window.setTimeout(()=>URL.revokeObjectURL(url),30_000);
    } catch (reason) {setError(errorMessage(reason));}
    finally {setDownloading(false);}
  }
  function filter(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data=new FormData(event.currentTarget);
    setKind(Number(data.get('report')));
    setDept(String(data.get('dept') ?? ''));
    move(0);
  }
  return <>
    <header className="page-head"><h1>Compliance reports</h1></header>
    <section className="panel"><form className="form-grid" onSubmit={filter}>
      <Field label="Report"><select name="report" defaultValue={kind}>
        {reportKinds.map((item,index)=><option key={item.id} value={index}>{item.name}</option>)}
      </select></Field>
      <Field label="Department"><select name="dept" defaultValue={dept}><option value="">All available</option>
        {options.data?.departments.map((item)=><option key={item.id} value={item.id}>{item.department}</option>)}
      </select></Field>
      <div className="actions wide"><button>Apply filters</button>
        <button type="button" className="secondary" disabled={downloading} onClick={()=>void download()}>Download CSV</button>
      </div>
    </form>{error && <Notice>{error}</Notice>}</section>
    <Resource {...report}>{({rows,hasMore})=><section className="panel table-panel">
      {rows.length ? <table><thead><tr>{current.columns.map((column)=><th key={column}>{pretty(column)}</th>)}</tr></thead>
        <tbody>{rows.map((row,index)=><tr key={String(row.id ?? index)}>
          {current.columns.map((column)=><td key={column}>{column==='title' && typeof row.id==='string'
            ? <a href={(kind===0?'#/obligations/':'#/tasks/')+row.id}>{String(row[column])}</a>
            : column==='completed' ? row[column] ? 'Yes' : 'No'
              : column==='completion_rate' ? String(row[column])+'%' : pretty(String(row[column] ?? '—'))}</td>)}
        </tr>)}</tbody></table> : <p>No records match this report.</p>}
      <Pagination offset={offset} more={hasMore} move={move}/>
    </section>}</Resource>
  </>;
}
