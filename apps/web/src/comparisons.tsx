import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { fetchPdf, request, type Account } from './api';
import { errorMessage, Field, Notice, Resource, useResource } from './ui';

const category = z.enum(['added','modified','removed','unchanged']);
const overview = z.object({
  comparisons:z.array(z.object({
    id:z.uuid(),old_number:z.number(),new_number:z.number(),impact_status:z.string(),
    impact_error:z.string().nullable(),model:z.string().nullable(),created_at:z.string(),
  })),
  changes:z.array(z.object({
    id:z.uuid(),category,old_heading:z.string().nullable(),new_heading:z.string().nullable(),decision:z.string().nullable(),
  })),
  counts:z.record(z.string(),z.number()),hasMore:z.boolean(),
});
const section = z.object({
  heading:z.string().nullable(),pages:z.array(z.number()),text:z.string(),changedLines:z.array(z.number()),
});
const detail = z.object({
  id:z.uuid(),category,old_section:section.nullable(),new_section:section.nullable(),
  old_number:z.number(),new_number:z.number(),old_document_id:z.uuid(),new_document_id:z.uuid(),
  signals:z.record(z.string(),z.object({before:z.array(z.string()),after:z.array(z.string())})),
  ai_explanation:z.object({
    summary:z.string(),practicalMeaning:z.string().nullable(),requirements:z.array(z.uuid()),
    requirementTitles:z.array(z.string()).optional(),departments:z.array(z.string()),actionSuggestion:z.string().nullable(),
  }).nullable(),
  decision:z.string().nullable(),
  review_history:z.array(z.object({reviewer:z.string(),decision:z.string(),comment:z.string(),at:z.string()})),
});
const label = (value: string) => value.replaceAll('_',' ');

function Source({ data, version, documentId, previous }: {
  data:z.infer<typeof section> | null; version:number; documentId:string; previous?:boolean;
}) {
  const [pdf,setPdf] = useState('');
  const [error,setError] = useState('');
  useEffect(() => () => { if (pdf) URL.revokeObjectURL(pdf); },[pdf]);
  const changed = new Set(data?.changedLines);
  return <div className="comparison-source">
    <h3>Version {version} · {data?.heading ?? 'Section text'}</h3>
    {data ? <>
      <p>Pages {data.pages.join(', ')}</p>
      <div className="comparison-lines">{data.text.split('\n').map((line,index) =>
        <div key={index} className={changed.has(index) ? previous ? 'diff-old' : 'diff-new' : undefined}>{line || ' '}</div>,
      )}</div>
      {pdf ? <iframe className="pdf-viewer" title={`Version ${version} PDF`} src={pdf + '#page=' + data.pages[0]} />
        : <button className="secondary" onClick={() => void fetchPdf(documentId)
          .then((blob) => setPdf(URL.createObjectURL(blob)))
          .catch((reason:unknown) => setError(errorMessage(reason)))}>View source PDF</button>}
      {error && <Notice>{error}</Notice>}
    </> : <p>This section is absent from this version.</p>}
  </div>;
}

function Change({ record, manage, refresh }: { record:z.infer<typeof detail>; manage:boolean; refresh:() => void }) {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  async function review(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await request('/changes/' + record.id + '/review',z.object({id:z.uuid()}),'POST',{
        decision:form.get('decision'),comment:form.get('comment'),revision:record.review_history.length,
      });
      refresh();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  const impact = record.ai_explanation;
  return <section className="panel">
    <h2>{label(record.category)} section</h2>
    <div className="comparison-columns">
      <Source data={record.old_section} documentId={record.old_document_id} version={record.old_number} previous />
      <Source data={record.new_section} documentId={record.new_document_id} version={record.new_number} />
    </div>
    {Object.entries(record.signals).map(([signal,values]) => <section className="extraction" key={signal}>
      <h3>Changed {label(signal)} wording</h3>
      <p><strong>Previous</strong> {values.before.join(' · ')}</p>
      <p><strong>Current</strong> {values.after.join(' · ')}</p>
    </section>)}
    {impact && <section className="extraction">
      <h3>AI impact suggestion</h3><p>{impact.summary}</p>
      <dl className="profile">
        <div><dt>Possible practical meaning</dt><dd>{impact.practicalMeaning ?? 'Unknown'}</dd></div>
        <div><dt>Potentially affected approved requirements</dt><dd>{impact.requirementTitles?.join(', ') || 'None identified'}</dd></div>
        <div><dt>Departments to review</dt><dd>{impact.departments.join(', ') || 'None suggested'}</dd></div>
        <div><dt>Possible new action</dt><dd>{impact.actionSuggestion ?? 'None suggested'}</dd></div>
      </dl>
    </section>}
    {record.review_history.length > 0 && <section className="extraction"><h3>Review history</h3>
      {record.review_history.map((entry,index) => <p key={index}>
        <strong>{label(entry.decision)}</strong> · {entry.reviewer} · {new Date(entry.at).toLocaleString()}<br />{entry.comment}
      </p>)}
    </section>}
    {manage && record.category !== 'unchanged' && <form className="form-grid extraction" onSubmit={review}>
      <Field label="Reviewer decision"><select name="decision" defaultValue={record.decision ?? 'needs_follow_up'}>
        <option value="confirmed">Confirm change</option><option value="dismissed">Dismiss change</option>
        <option value="needs_follow_up">Needs follow-up</option>
      </select></Field>
      <Field label="Review comment"><input name="comment" maxLength={1200} required /></Field>
      {error && <div className="wide"><Notice>{error}</Notice></div>}
      <div className="wide"><button disabled={busy}>Save review</button></div>
    </form>}
  </section>;
}

export function Comparisons({ actor,regulationId,versions }: {
  actor:Account; regulationId:string; versions:{id:string;number:number}[];
}) {
  const [selected,setSelected] = useState('');
  const [change,setChange] = useState('');
  const [offset,setOffset] = useState(0);
  const [unchanged,setUnchanged] = useState(false);
  const [refresh,setRefresh] = useState(0);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const manage=actor.permissions.includes('comparisons.manage');
  const root='/regulations/' + regulationId;
  const data=useResource(useCallback(() => {
    const query = new URLSearchParams({offset:String(offset),includeUnchanged:String(unchanged)});
    if (selected) query.set('comparisonId',selected);
    return request(root + '/changes?' + query,overview);
  },[root,selected,offset,unchanged,refresh]));
  const current=useResource(useCallback(() => change ? request('/changes/' + change,detail) : Promise.resolve(null),[change,refresh]));

  async function compare(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    try {
      const response=await request(root + '/compare',z.object({id:z.uuid()}),'POST',{
        oldVersionId:form.get('oldVersionId'),newVersionId:form.get('newVersionId'),includeImpact:form.has('impact'),
      });
      setSelected(response.id);
      setChange('');
      setOffset(0);
      setRefresh((value) => value + 1);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  return <>
    <section className="panel">
      <h2>Compare versions</h2>
      {manage && versions.length >= 2 && <form className="form-grid" onSubmit={compare}>
        <Field label="Previous version"><select name="oldVersionId" defaultValue={versions[1].id}>
          {versions.map(({id,number}) => <option key={id} value={id}>Version {number}</option>)}
        </select></Field>
        <Field label="Current version"><select name="newVersionId" defaultValue={versions[0].id}>
          {versions.map(({id,number}) => <option key={id} value={id}>Version {number}</option>)}
        </select></Field>
        <label className="wide"><input name="impact" type="checkbox" /> Send changed excerpts and approved requirement summaries to Gemini for impact suggestions</label>
        {error && <div className="wide"><Notice>{error}</Notice></div>}
        <div className="wide"><button disabled={busy}>{busy ? 'Comparing…' : 'Compare versions'}</button></div>
      </form>}
      {versions.length < 2 && <p>Upload and process two versions to compare them.</p>}
      <Resource {...data}>{({comparisons,changes,hasMore,counts}) => {
        const active=comparisons.find(({id}) => id===selected) ?? comparisons[0];
        if (!active) return <p>No saved comparisons.</p>;
        return <div className="extraction">
          <Field label="Saved comparison"><select value={active.id} onChange={(event) => {
            setSelected(event.currentTarget.value); setOffset(0); setChange('');
          }}>
            {comparisons.map((item) => <option key={item.id} value={item.id}>
              Version {item.old_number} → {item.new_number} · {new Date(item.created_at).toLocaleString()}
            </option>)}
          </select></Field>
          <p>{(['added','modified','removed','unchanged'] as const).map((key) => `${counts[key] ?? 0} ${key}`).join(' · ')}</p>
          <p>AI impact {active.impact_status}{active.model && ' · ' + active.model}</p>
          {active.impact_error && <Notice>{active.impact_error}</Notice>}
          <label><input type="checkbox" checked={unchanged} onChange={(event) => {
            setUnchanged(event.currentTarget.checked); setOffset(0); setChange('');
          }} /> Show unchanged sections</label>
          {changes.length ? <table><thead><tr><th>Section</th><th>Change</th><th>Decision</th></tr></thead><tbody>
            {changes.map((row) => <tr key={row.id}><td><button className="secondary" onClick={() => setChange(row.id)}>
              {row.new_heading ?? row.old_heading ?? 'Section text'}
            </button></td><td><span className={'change-' + row.category}>{row.category}</span></td>
              <td>{row.decision ? label(row.decision) : '—'}</td></tr>)}
          </tbody></table> : <p>No sections match this view.</p>}
          {(offset > 0 || hasMore) && <div className="actions pagination">
            <button className="secondary" disabled={!offset} onClick={() => setOffset(offset-25)}>Previous</button>
            <button className="secondary" disabled={!hasMore} onClick={() => setOffset(offset+25)}>Next</button>
          </div>}
        </div>;
      }}</Resource>
    </section>
    {change && <Resource {...current}>{(record) => record && <Change key={record.id + ':' + record.review_history.length}
      record={record} manage={manage} refresh={() => setRefresh((value) => value+1)} />}</Resource>}
  </>;
}
