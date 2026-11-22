import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { fetchPdf, request, type Account } from './api';
import { Intelligence } from './intelligence';
import { Comparisons } from './comparisons';
import { AssistantIndex } from './assistant';
import { errorMessage, Field, Notice, Resource, useResource } from './ui';

const kinds = {
  circular: 'RBI circular', notification: 'RBI notification', master_direction: 'Master Direction',
  master_circular: 'Master Circular', amendment: 'Regulatory amendment',
};
const regulation = z.object({
  id: z.uuid(), title: z.string(), kind: z.string(), reference: z.string().nullable(),
  source_name: z.string().nullable().optional(), source_url: z.string().nullable().optional(),
});
const source = z.object({ id: z.uuid(), name: z.string(), url: z.url() });
const sourceList = z.object({ sources: z.array(source) });
const version = z.object({
  id: z.uuid(), number: z.number(), source_url: z.string().nullable(), version_note: z.string().nullable(), created_at: z.string(),
});
const documentRecord = z.object({
  id: z.uuid(), version_id: z.uuid(), filename: z.string(), status: z.enum(['queued','processing','processed','failed']),
  bytes: z.number(), sha256: z.string(), error: z.string().nullable(), page_count: z.number().nullable(),
});
const documentList = z.object({ documents: z.array(documentRecord) });
const chunkList = z.object({ chunks: z.array(z.object({
  page: z.number(), ordinal: z.number(), heading: z.string().nullable(), text: z.string(), ocr: z.boolean(),
})) });
const loadSources = () => request('/regulatory-sources', sourceList);
const kindLabel = (kind: string) => kinds[kind as keyof typeof kinds] ?? kind;
const canManage = (actor: Account) => actor.permissions.includes('regulations.manage');

async function submit(event: FormEvent<HTMLFormElement>, operation: (data: FormData) => Promise<void>,
  setError: (message: string) => void, setBusy: (busy: boolean) => void) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  setError('');
  setBusy(true);
  try {
    await operation(data);
  } catch (error) {
    setError(errorMessage(error));
  } finally {
    setBusy(false);
  }
}

export function Sources({ actor }: { actor: Account }) {
  const [revision, reload] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sources = useResource(useCallback(loadSources, [revision]));
  return <>
    <header className="page-head"><h1>Regulatory sources</h1></header>
    {canManage(actor) && <section className="panel"><h2>Add source</h2>
      <form className="form-grid" onSubmit={(event) => {
        const form = event.currentTarget;
        void submit(event, async (data) => {
          await request('/regulatory-sources', source, 'POST', { name: data.get('name'), url: data.get('url') });
          form.reset();
          reload((value) => value + 1);
        }, setError, setBusy);
      }}>
        <Field label="Source name"><input name="name" maxLength={250} required /></Field>
        <Field label="Source URL"><input name="url" type="url" maxLength={2048} required /></Field>
        {error && <div className="wide"><Notice>{error}</Notice></div>}
        <div><button disabled={busy}>Add source</button></div>
      </form>
    </section>}
    <Resource {...sources}>{({ sources: rows }) => <section className="panel table-panel">
      {rows.length ? <table><thead><tr><th>Source</th><th>Recorded URL</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.url}</td></tr>)}</tbody>
      </table> : <p>No sources recorded.</p>}
    </section>}</Resource>
  </>;
}

export function Library({ actor }: { actor: Account }) {
  const [offset, setOffset] = useState(0);
  const listing = useResource(useCallback(() => request('/regulations?offset=' + offset,
    z.object({ regulations: z.array(regulation), hasMore: z.boolean() })), [offset]));
  return <>
    <header className="page-head"><h1>Regulatory library</h1>
      {canManage(actor) && <a className="button" href="#/regulations/new">Add regulation</a>}
    </header>
    <Resource {...listing}>{({ regulations, hasMore }) => <section className="panel table-panel">
      {regulations.length ? <table><thead><tr><th>Title</th><th>Type</th><th>Reference</th><th>Source</th></tr></thead>
        <tbody>{regulations.map((row) => <tr key={row.id}>
          <td><a href={`#/regulations/${row.id}`}>{row.title}</a></td><td>{kindLabel(row.kind)}</td>
          <td>{row.reference ?? '—'}</td><td>{row.source_name ?? '—'}</td>
        </tr>)}</tbody>
      </table> : <p>No regulations recorded.</p>}
      {(offset > 0 || hasMore) && <div className="actions pagination">
        <button className="secondary" disabled={!offset} onClick={() => setOffset(offset - 50)}>Previous</button>
        <button className="secondary" disabled={!hasMore} onClick={() => setOffset(offset + 50)}>Next</button>
      </div>}
    </section>}</Resource>
  </>;
}

export function NewRegulation() {
  const sources = useResource(loadSources);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <section className="panel"><h1>Add regulation</h1>
    <Resource {...sources}>{({ sources: rows }) => (
      <form className="form-grid login-form" onSubmit={(event) => void submit(event, async (data) => {
        const created = await request('/regulations', regulation, 'POST', {
          title: data.get('title'), kind: data.get('kind'), sourceId: data.get('source') || null,
          reference: data.get('reference') || undefined,
        });
        location.hash = `/regulations/${created.id}/upload`;
      }, setError, setBusy)}>
        <Field label="Title"><input name="title" maxLength={250} required /></Field>
        <Field label="Document type"><select name="kind">{Object.entries(kinds).map(([key, label]) =>
          <option key={key} value={key}>{label}</option>)}</select></Field>
        <Field label="Reference"><input name="reference" maxLength={250} /></Field>
        <Field label="Recorded source"><select name="source"><option value="">Unknown</option>
          {rows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>
        {error && <div className="wide"><Notice>{error}</Notice></div>}
        <div><button disabled={busy}>Continue to upload</button></div>
      </form>
    )}</Resource>
  </section>;
}

export function UploadPdf({ regulationId }: { regulationId: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const details = useResource(useCallback(() => request('/regulations/' + regulationId, regulation), [regulationId]));
  return <Resource {...details}>{(record) => <section className="panel">
    <h1>Upload PDF version</h1><p>{record.title}</p>
    <form className="form-grid" onSubmit={(event) => void submit(event, async (data) => {
      const pdf = data.get('pdf');
      if (!(pdf instanceof File) || pdf.size > 10 * 1024 * 1024) {
        setError('Select a PDF up to 10 MiB.');
        return;
      }
      data.set('regulationId', regulationId);
      if (!data.get('sourceUrl')) data.delete('sourceUrl');
      if (!data.get('versionNote')) data.delete('versionNote');
      await request('/regulations/upload', z.object({ id: z.uuid() }), 'POST', data);
      location.hash = '/regulations/' + regulationId;
    }, setError, setBusy)}>
      <Field label="PDF file (up to 10 MiB)"><input type="file" name="pdf" accept="application/pdf,.pdf" required /></Field>
      <Field label="Version source URL"><input type="url" name="sourceUrl" maxLength={2048} /></Field>
      <Field label="Version note"><input name="versionNote" maxLength={250} /></Field>
      {error && <div className="wide"><Notice>{error}</Notice></div>}
      <div className="actions wide"><button disabled={busy}>{busy ? 'Uploading…' : 'Upload PDF'}</button>
        <a href={`#/regulations/${regulationId}`}>Cancel</a></div>
    </form>
  </section>}</Resource>;
}

function DocumentPreview({ record }: { record: z.infer<typeof documentRecord> }) {
  const [page, setPage] = useState(1);
  const [pdfUrl, setPdfUrl] = useState('');
  const [pdfError, setPdfError] = useState('');
  const [opening, setOpening] = useState(false);
  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);
  const chunks = useResource(useCallback(() => record.status === 'processed'
    ? request(`/regulatory-documents/${record.id}/chunks?page=${page}`, chunkList)
    : Promise.resolve({ chunks: [] }), [record.id, record.status, page]));
  async function openPdf() {
    setOpening(true);
    setPdfError('');
    try {
      setPdfUrl(URL.createObjectURL(await fetchPdf(record.id)));
    } catch (error) {
      setPdfError(errorMessage(error));
    } finally {
      setOpening(false);
    }
  }
  return <section className="panel">
    <h2>{record.filename}</h2>
    <p><strong>Status</strong> {record.status} · {Math.ceil(record.bytes / 1024)} KiB
      {record.page_count !== null && ` · ${record.page_count} pages`}</p>
    <p className="checksum"><strong>SHA-256</strong> {record.sha256}</p>
    {record.error && <Notice>{record.error}</Notice>}
    {pdfError && <Notice>{pdfError}</Notice>}
    {pdfUrl ? <><a href={pdfUrl} target="_blank" rel="noreferrer">Open original PDF in a new tab</a>
      <iframe title={record.filename} src={pdfUrl} className="pdf-viewer" /></>
      : <button className="secondary" disabled={opening} onClick={() => void openPdf()}>
        {opening ? 'Opening…' : 'View PDF'}
      </button>}
    {record.status === 'processed' && <div className="extraction">
      <h2>Extracted text</h2>
      <div className="actions">
        <button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous page</button>
        <span>Page {page} of {record.page_count}</span>
        <button className="secondary" disabled={page >= (record.page_count ?? 0)} onClick={() => setPage(page + 1)}>Next page</button>
      </div>
      <Resource {...chunks}>{({ chunks: rows }) => rows.length ? <div className="extracted-text">
        {rows.map((chunk, index) => <div key={chunk.ordinal}>
          {chunk.heading && chunk.heading !== rows[index - 1]?.heading && <h3>{chunk.heading}</h3>}
          <div>{chunk.text}</div>
        </div>)}
        {rows.some((chunk) => chunk.ocr) && <p className="status">OCR text</p>}
      </div> : <p>No text on this page.</p>}</Resource>
    </div>}
  </section>;
}

export function RegulationDetail({ actor, regulationId, query }: { actor: Account; regulationId: string; query?: string }) {
  const source = new URLSearchParams(query);
  const [selected, setSelected] = useState('');
  const base = '/regulations/' + regulationId;
  const details = useResource(useCallback(() => request(base, regulation), [base]));
  const versions = useResource(useCallback(() => request(base + '/versions',
    z.object({ versions: z.array(version) })), [base]));
  const [documents, setDocuments] = useState<z.infer<typeof documentList>>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const value = await request(base + '/documents', documentList);
        if (!active) return;
        setDocuments(value);
        setError(undefined);
        if (value.documents.some(({ status }) => status === 'queued' || status === 'processing')) timer = setTimeout(load, 1500);
      } catch (reason) {
        if (active) setError(reason);
      }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [base]);
  const sourceDocument = source.get('documentId');
  const activeDocument = documents?.documents.find((item) => selected
    ? item.version_id === selected : item.id === sourceDocument) ?? documents?.documents[0];
  return <Resource {...details}>{(record) => <>
    <header className="page-head"><h1>{record.title}</h1>
      {canManage(actor) && <a className="button" href={`#/regulations/${regulationId}/upload`}>Upload version</a>}
    </header>
    <section className="panel">
      <p>{kindLabel(record.kind)} {record.reference && `· ${record.reference}`}</p>
      <p><strong>Recorded source</strong> {record.source_name ?? 'Unknown'} {record.source_url && `· ${record.source_url}`}</p>
    </section>
    <Resource {...versions}>{({ versions: rows }) => <section className="panel table-panel">
      <h2>Version history</h2>
      {rows.length ? <table><thead><tr><th>Version</th><th>Uploaded</th><th>Source URL</th><th>Note</th><th>Status</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>
          <td><button className="secondary" aria-pressed={activeDocument?.version_id === row.id}
            onClick={() => setSelected(row.id)}>Version {row.number}</button></td>
          <td>{new Date(row.created_at).toLocaleDateString()}</td><td>{row.source_url ?? '—'}</td>
          <td>{row.version_note ?? '—'}</td>
          <td>{documents?.documents.find((document) => document.version_id === row.id)?.status ?? 'Loading…'}</td>
        </tr>)}</tbody>
      </table> : <p>No versions uploaded.</p>}
    </section>}</Resource>
    <Resource data={documents} error={error}>{() => activeDocument &&
      <DocumentPreview key={activeDocument.id} record={activeDocument} />}</Resource>
    {activeDocument?.status === 'processed' && actor.permissions.includes('intelligence.read') &&
      <Intelligence key={activeDocument.id} actor={actor} regulationId={regulationId} documentId={activeDocument.id}
        initialRequirementId={activeDocument.id === sourceDocument ? source.get('requirementId') ?? '' : ''} />}
    {activeDocument?.status==='processed' && actor.permissions.includes('assistant.use') &&
      <AssistantIndex key={activeDocument.id} actor={actor} documentId={activeDocument.id} regulationId={regulationId}/>}
    {actor.permissions.includes('comparisons.read') && versions.data && documents &&
      <Comparisons actor={actor} regulationId={regulationId} versions={versions.data.versions.filter((version) =>
        documents.documents.some((document) => document.version_id === version.id && document.status === 'processed'))} />}
  </>}</Resource>;
}
