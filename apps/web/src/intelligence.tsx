import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { ApiError, fetchPdf, request, type Account } from './api';
import { errorMessage, Field, Notice, Resource, useResource } from './ui';
import { RequirementGap } from './gaps';

const interpretation = z.object({
  title: z.string(), description: z.string(), topic: z.string().nullable(),
  requirementType: z.enum(['mandatory','advisory','conditional']),
  applicability: z.string().nullable(), effectiveDate: z.string().nullable(), deadline: z.string().nullable(),
  departments: z.array(z.string()), priority: z.string().nullable(),
});
const requirement = z.object({
  id: z.uuid(), revision: z.number(), status: z.enum(['pending','revised','approved','rejected']),
  suggestion: interpretation.extend({
    regulationTitle: z.string(), page: z.number(), section: z.string().nullable(),
    quote: z.string(), sourceText: z.string(), citationQuality: z.number(), ocr: z.boolean(),
  }),
  human_result: interpretation.nullable(),
});
const detail = requirement.extend({
  document_id: z.uuid(), model: z.string().nullable(),
  history: z.array(z.object({
    reviewer: z.string(), action: z.string(), revision: z.number(), note: z.string().nullable(),
    created_at: z.string(), human_result: interpretation,
  })),
});
const analysis = z.object({
  runs: z.array(z.object({
    id: z.uuid(), status: z.enum(['queued','running','completed','failed']), error: z.string().nullable(),
    model: z.string().nullable(), created_at: z.string(),
  })),
  requirements: z.array(requirement), hasMore: z.boolean(),
});

function Interpretation({ result }: { result: z.infer<typeof interpretation> }) {
  return <dl className="profile">
    {[
      ['Title', result.title], ['Description', result.description], ['Topic', result.topic],
      ['Requirement type', result.requirementType], ['Applicability', result.applicability],
      ['Effective date', result.effectiveDate], ['Compliance deadline', result.deadline],
      ['Affected departments', result.departments.join(', ')], ['Suggested priority', result.priority],
    ].map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value || 'Unknown'}</dd></div>)}
  </dl>;
}

function RequirementDetail({ record, actor, reload }: {
  record: z.infer<typeof detail>; actor: Account; reload: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const [pdf, setPdf] = useState('');
  useEffect(() => () => { if (pdf) URL.revokeObjectURL(pdf); }, [pdf]);
  const result = record.human_result ?? record.suggestion;
  const reviewable = actor.permissions.includes('intelligence.review') &&
    (record.status === 'pending' || record.status === 'revised');
  async function perform(operation: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await operation();
      setEdit(false);
      reload();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const value = (name: string) => String(fields.get(name) ?? '').trim();
    const optional = (name: string) => value(name) || null;
    void perform(() => request('/requirements/' + record.id, z.object({ id: z.uuid() }), 'PATCH', {
      revision: record.revision, result: {
        title: value('title'), description: value('description'), topic: optional('topic'),
        requirementType: value('requirementType'), applicability: optional('applicability'),
        effectiveDate: optional('effectiveDate'), deadline: optional('deadline'),
        departments: value('departments').split(',').map((item) => item.trim()).filter(Boolean),
        priority: optional('priority'),
      },
    }));
  }
  function decide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (!(submitter instanceof HTMLButtonElement)) return;
    void perform(() => request('/requirements/' + record.id + '/review', z.object({ id: z.uuid() }), 'POST', {
      action: submitter.value, revision: record.revision, note: String(fields.get('note') ?? '').trim() || undefined,
    }));
  }
  return <section className="panel">
    <h2>{result.title}</h2>
    <p><span className="status">{record.status}</span> · {record.suggestion.regulationTitle}</p>
    <details open><summary>Source citation · Page {record.suggestion.page}</summary>
      <p>{record.suggestion.section ?? 'Section unknown'}{record.suggestion.ocr && ' · OCR text'}</p>
      <blockquote className="extracted-text">{record.suggestion.quote}</blockquote>
      {record.suggestion.quote !== record.suggestion.sourceText && <details><summary>Full source chunk</summary>
        <p>{record.suggestion.sourceText}</p></details>}
      <p>Exact match on the recorded page · Citation quality {Math.round(record.suggestion.citationQuality * 100)}%</p>
      {pdf ? <iframe className="pdf-viewer" title="Cited source PDF" src={pdf + '#page=' + record.suggestion.page} />
        : <button className="secondary" onClick={() => {
          void fetchPdf(record.document_id).then((blob) => setPdf(URL.createObjectURL(blob)))
            .catch((reason: unknown) => setError(errorMessage(reason)));
        }}>Open cited PDF page</button>}
    </details>
    <h3 className="extraction">{record.human_result ? 'Human result' : 'AI suggestion'}</h3>
    <Interpretation result={result} />
    {record.human_result && <details className="extraction"><summary>Original AI suggestion</summary>
      <Interpretation result={record.suggestion} />
    </details>}
    {error && <Notice>{error}</Notice>}
    {reviewable && <div className="extraction">
      {edit ? <form className="form-grid" onSubmit={save} key={record.revision}>
        <Field label="Requirement title"><input name="title" defaultValue={result.title} maxLength={250} required /></Field>
        <Field label="Regulatory topic"><input name="topic" defaultValue={result.topic ?? ''} maxLength={250} /></Field>
        <Field label="Description"><textarea name="description" defaultValue={result.description} maxLength={1800} required /></Field>
        <Field label="Requirement type"><select name="requirementType" defaultValue={result.requirementType}>
          <option value="mandatory">Mandatory</option><option value="advisory">Advisory</option><option value="conditional">Conditional</option>
        </select></Field>
        <Field label="Applicability"><input name="applicability" defaultValue={result.applicability ?? ''} maxLength={250} /></Field>
        <Field label="Affected departments (comma separated)"><input name="departments" defaultValue={result.departments.join(', ')} /></Field>
        <Field label="Effective date"><input type="date" name="effectiveDate" defaultValue={result.effectiveDate ?? ''} /></Field>
        <Field label="Compliance deadline"><input type="date" name="deadline" defaultValue={result.deadline ?? ''} /></Field>
        <Field label="Suggested priority"><select name="priority" defaultValue={result.priority ?? ''}>
          <option value="">Unknown</option><option>low</option><option>medium</option><option>high</option><option>critical</option>
        </select></Field>
        <div className="actions wide"><button disabled={busy}>Save revision</button>
          <button className="secondary" type="button" onClick={() => setEdit(false)}>Cancel</button></div>
      </form> : <form className="form-grid" onSubmit={decide}>
        <Field label="Review note"><input name="note" maxLength={250} /></Field>
        <div className="actions wide">
          <button type="button" className="secondary" disabled={busy} onClick={() => setEdit(true)}>Edit suggestion</button>
          <button value="approve" disabled={busy}>Approve</button>
          <button value="reject" className="secondary" disabled={busy}>Reject</button>
        </div>
      </form>}
    </div>}
    {record.status === 'approved' && actor.permissions.includes('gaps.read') &&
      <RequirementGap actor={actor} requirementId={record.id} />}
    {record.status === 'approved' && actor.permissions.includes('work.manage_obligations') &&
      <div className="extraction"><a className="button secondary" href={`#/obligations/new?requirementId=${record.id}`}>Create obligation</a></div>}
    {record.history.length > 0 && <section className="extraction"><h3>Review history</h3>
      {record.history.map((entry) => <details key={entry.revision}>
        <summary>{entry.action} · {entry.reviewer} · {new Date(entry.created_at).toLocaleString()}</summary>
        {entry.note && <p>{entry.note}</p>}
        <Interpretation result={entry.human_result} />
      </details>)}
    </section>}
  </section>;
}

export function Intelligence({ actor, regulationId, documentId, initialRequirementId = '' }: {
  actor: Account; regulationId: string; documentId: string; initialRequirementId?: string;
}) {
  const [data, setData] = useState<z.infer<typeof analysis>>();
  const [loadError, setLoadError] = useState<unknown>();
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(initialRequirementId);
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((value) => value + 1);
  const path = '/regulations/' + regulationId;
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const next = await request(path + '/requirements?documentId=' + documentId + '&offset=' + offset, analysis);
        if (!current) return;
        setData(next);
        setLoadError(undefined);
        if (next.runs.some(({status}) => status === 'queued' || status === 'running')) timer = setTimeout(load,1500);
      } catch (reason) { if (current) setLoadError(reason); }
    }
    void load();
    return () => { current = false; clearTimeout(timer); };
  }, [path,documentId,offset,version]);
  const selectedRecord = useResource(useCallback(() => selected
    ? request('/requirements/' + selected,detail) : Promise.resolve(null), [selected,version]));
  const running = data?.runs.some(({status}) => status === 'queued' || status === 'running');
  async function start() {
    setActionError('');
    setBusy(true);
    try {
      await request(path + '/analyze',z.object({ id: z.uuid() }),'POST',{ documentId });
      setOffset(0);
      reload();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && reason.message.includes('already in progress')) reload();
      else setActionError(errorMessage(reason));
    }
    finally { setBusy(false); }
  }
  return <>
    <section className="panel">
      <header className="page-head"><h2>AI analysis for this version</h2>
        {actor.permissions.includes('intelligence.analyze') &&
          <button disabled={busy || running} onClick={() => void start()}>{running ? 'Analysis in progress' : 'Analyze document'}</button>}
      </header>
      {actionError && <Notice>{actionError}</Notice>}
      <Resource data={data} error={loadError}>{({runs,requirements,hasMore}) => <>
        {runs.length ? <ul>{runs.map((run) => <li key={run.id}>
          {new Date(run.created_at).toLocaleString()} · <strong>{run.status}</strong>
          {run.error && ' · ' + run.error}
        </li>)}</ul> : <p>No analysis runs for this version.</p>}
        <h3 className="extraction">Extracted requirements</h3>
        {requirements.length ? <table><thead><tr><th>Requirement</th><th>Page</th><th>Review status</th></tr></thead>
          <tbody>{requirements.map((row) => <tr key={row.id}>
            <td><button className="secondary" onClick={() => setSelected(row.id)}>
              {(row.human_result ?? row.suggestion).title}
            </button></td><td>{row.suggestion.page}</td><td>{row.status}</td>
          </tr>)}</tbody>
        </table> : <p>No extracted requirements on this page.</p>}
        {(offset > 0 || hasMore) && <div className="actions pagination">
          <button className="secondary" disabled={offset === 0} onClick={() => setOffset(offset - 25)}>Previous</button>
          <button className="secondary" disabled={!hasMore} onClick={() => setOffset(offset + 25)}>Next</button>
        </div>}
      </>}</Resource>
    </section>
    {selected && <Resource {...selectedRecord}>{(record) => record &&
      <RequirementDetail key={record.id + ':' + record.revision} record={record}
        actor={actor} reload={reload} />}
    </Resource>}
  </>;
}
