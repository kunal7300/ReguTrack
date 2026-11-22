import { useCallback, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { accountSchema, departmentsSchema, departmentSchema, request, rolesSchema, type Account } from './api';
import { errorMessage, Field, Notice, Resource, useResource } from './ui';

const usersSchema = z.object({ users: z.array(accountSchema), hasMore: z.boolean() });
const pageSize = 25;
const displayRole = (code: string) => code.split('_').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
const loadDepartments = () => request('/departments', departmentsSchema);
const loadRoles = () => request('/roles', rolesSchema);

function UserEditor({ user, actor, onClose, onSaved }: {
  user?: Account; actor: Account; onClose: () => void; onSaved: (message: string) => void;
}) {
  const departments = useResource(loadDepartments);
  const roles = useResource(loadRoles);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canChangeRoles = user?.id !== actor.id;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    if (canChangeRoles && !form.getAll('roles').length) {
      setError('Select at least one role.');
      return;
    }
    const values = {
      name: form.get('name'), email: form.get('email'), departmentId: form.get('department') || null,
      ...(canChangeRoles ? { roles: form.getAll('roles') } : {}),
      ...(!user ? { password: form.get('password') } : {}),
    };
    setBusy(true);
    try {
      await request(user ? `/users/${user.id}` : '/users', accountSchema, user ? 'PATCH' : 'POST', values);
      onSaved(user ? 'Account updated.' : 'Account created.');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>{user ? 'Edit user' : 'Create user'}</h2>
      <Resource {...departments}>{({ departments: options }) => (
        <Resource {...roles}>{({ roles: roleOptions }) => (
          <form onSubmit={save} className="form-grid">
            <Field label="Full name"><input name="name" maxLength={120} defaultValue={user?.name} required /></Field>
            <Field label="Email"><input name="email" type="email" maxLength={254} defaultValue={user?.email} required /></Field>
            {!user && <Field label="Password">
              <input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" required />
            </Field>}
            <Field label="Department">
              <select name="department" defaultValue={user?.departmentId ?? ''}>
                <option value="">No department</option>
                {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
              </select>
            </Field>
            <fieldset className="checkboxes wide" disabled={!canChangeRoles}>
              <legend>Roles</legend>
              {roleOptions.map((role) => (
                <label key={role.code}><input type="checkbox" name="roles" value={role.code}
                  defaultChecked={user?.roles.includes(role.code)} />{role.name}</label>
              ))}
            </fieldset>
            {error && <div className="wide"><Notice>{error}</Notice></div>}
            <div className="actions wide">
              <button disabled={busy}>{busy ? 'Saving…' : 'Save user'}</button>
              <button type="button" className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
            </div>
          </form>
        )}</Resource>
      )}</Resource>
    </section>
  );
}

export function Users({ actor }: { actor: Account }) {
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [editor, setEditor] = useState<Account | 'new'>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState('');
  const load = useCallback(() => {
    return request(`/users?limit=${pageSize}&offset=${offset}`, usersSchema);
  // Changing the version reloads the current page after a mutation.
  }, [offset, version]);
  const users = useResource(load);
  const departments = useResource(loadDepartments);
  const canManage = actor.permissions.includes('users.manage');

  async function toggle(user: Account) {
    setPending(user.id);
    setError('');
    setMessage('');
    try {
      await request(`/users/${user.id}/status`, accountSchema, 'PATCH', { active: !user.active });
      setMessage(user.active ? 'Account disabled.' : 'Account enabled.');
      setVersion((value) => value + 1);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending('');
    }
  }

  return <>
    <header className="page-head"><h1>Users</h1>
      {canManage && <button onClick={() => setEditor('new')}>Create user</button>}
    </header>
    {error && <Notice>{error}</Notice>}
    {message && <p className="success" role="status">{message}</p>}
    {editor && <UserEditor key={editor === 'new' ? editor : editor.id} actor={actor}
      user={editor === 'new' ? undefined : editor}
      onClose={() => setEditor(undefined)}
      onSaved={(text) => { setEditor(undefined); setMessage(text); setVersion((value) => value + 1); }} />}
    <Resource {...users}>{({ users: rows, hasMore }) => (
      <section className="panel table-panel">
        {!rows.length ? <p>No users found.</p> :
          <table>
            <thead><tr><th>Name</th><th>Department</th><th>Roles</th><th>Status</th>{canManage && <th>Actions</th>}</tr></thead>
            <tbody>{rows.map((user) =>
              <tr key={user.id}>
                <td><strong>{user.name}</strong><small>{user.email}</small></td>
                <td>{user.departmentId ? departments.data?.departments.find(({ id }) => id === user.departmentId)?.name ?? 'Assigned' : '—'}</td>
                <td>{user.roles.map(displayRole).join(', ')}</td>
                <td><span className={user.active ? 'status active' : 'status'}>{user.active ? 'Active' : 'Disabled'}</span></td>
                {canManage && <td><div className="actions">
                  <button className="secondary" onClick={() => setEditor(user)}>Edit</button>
                  {user.id !== actor.id && <button className="secondary" disabled={Boolean(pending)}
                    onClick={() => void toggle(user)}>{pending === user.id ? 'Saving…' : user.active ? 'Disable' : 'Enable'}</button>}
                </div></td>}
              </tr>,
            )}</tbody>
          </table>}
        {(offset > 0 || hasMore) && <div className="actions pagination">
          <button className="secondary" disabled={!offset} onClick={() => setOffset(offset - pageSize)}>Previous</button>
          <button className="secondary" disabled={!hasMore} onClick={() => setOffset(offset + pageSize)}>Next</button>
        </div>}
      </section>
    )}</Resource>
  </>;
}

export function Departments({ actor }: { actor: Account }) {
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => loadDepartments(), [version]);
  const departments = useResource(load);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await request('/departments', departmentSchema, 'POST', { name: form.get('name'), code: form.get('code') });
      setOpen(false);
      setVersion((value) => value + 1);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <header className="page-head"><h1>Departments</h1>
      {actor.permissions.includes('departments.manage') && <button onClick={() => { setOpen(!open); setError(''); }}>
        {open ? 'Cancel' : 'Create department'}
      </button>}
    </header>
    {open && <section className="panel"><h2>Create department</h2>
      <form onSubmit={create} className="form-grid">
        <Field label="Name"><input name="name" maxLength={120} required /></Field>
        <Field label="Code"><input name="code" placeholder="OPERATIONS" pattern="[A-Z][A-Z0-9_\x2d]{1,19}" required /></Field>
        {error && <div className="wide"><Notice>{error}</Notice></div>}
        <div><button disabled={busy}>{busy ? 'Saving…' : 'Save department'}</button></div>
      </form>
    </section>}
    <Resource {...departments}>{({ departments: rows }) => (
      <section className="panel table-panel">
        {rows.length ? <table><thead><tr><th>Name</th><th>Code</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}><td><strong>{row.name}</strong></td><td>{row.code}</td></tr>)}</tbody>
        </table> : <p>No departments found.</p>}
      </section>
    )}</Resource>
  </>;
}

export function Roles() {
  const roles = useResource(loadRoles);
  return <>
    <header className="page-head"><h1>Roles and permissions</h1></header>
    <Resource {...roles}>{({ roles: rows }) => <div className="role-grid">
      {rows.map((role) => <section className="panel" key={role.code}>
        <h2>{role.name}</h2>
        <ul className="grants">{role.permissions.map((permission) =>
          <li key={permission.code}>{permission.description}</li>,
        )}</ul>
      </section>)}
    </div>}</Resource>
  </>;
}

export function Profile({ actor }: { actor: Account }) {
  const departments = useResource(loadDepartments);
  return <>
    <header className="page-head"><h1>Profile</h1></header>
    <section className="panel">
      <dl className="profile">
        <div><dt>Name</dt><dd>{actor.name}</dd></div>
        <div><dt>Email</dt><dd>{actor.email}</dd></div>
        <div><dt>Roles</dt><dd>{actor.roles.map(displayRole).join(', ')}</dd></div>
        <div><dt>Department</dt><dd>{actor.departmentId
          ? departments.data?.departments.find(({ id }) => id === actor.departmentId)?.name ?? 'Assigned'
          : 'No department'}</dd></div>
      </dl>
    </section>
  </>;
}
