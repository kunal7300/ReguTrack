import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Departments, Profile, Roles, Users } from './admin';
import { getSession, login, logout, refreshSession, subscribe } from './api';
import { AccessDenied, errorMessage, Field, Notice } from './ui';
import { Library, NewRegulation, RegulationDetail, Sources, UploadPdf } from './regulatory';
import { ControlRegister, GapDetail, GapOverview } from './gaps';
import { CreateObligation, ObligationDetail, Obligations, TaskBoard, TaskDetail } from './work';
import { AuditLog } from './evidence';
import { Dashboard,NotificationBadge,Notifications,Reports } from './visibility';
import { AssistantPage } from './assistant';
import './style.css';

const pages = [
  { path: '/dashboard', title: 'Dashboard', permissions: ['work.read_all','work.read_department','work.read_assigned'] },
  { path: '/notifications', title: 'Notifications', permissions: [] },
  { path: '/assistant', title: 'Compliance assistant', permissions: ['assistant.use'] },
  { path: '/regulations', title: 'Regulatory library', permissions: ['regulations.read'] },
  { path: '/regulatory-sources', title: 'Regulatory sources', permissions: ['regulations.read'] },
  { path: '/controls', title: 'Control register', permissions: ['gaps.read'] },
  { path: '/gaps', title: 'Compliance gaps', permissions: ['gaps.read'] },
  { path: '/obligations', title: 'Obligations', permissions: ['work.read_all','work.read_department','work.read_assigned'] },
  { path: '/tasks', title: 'Task board', permissions: ['work.read_all','work.read_department','work.read_assigned'] },
  { path: '/reports', title: 'Reports', permissions: ['work.read_all','work.read_department','work.read_assigned'] },
  { path: '/audit-logs', title: 'Audit log', permissions: ['audit.read'] },
  { path: '/profile', title: 'Profile', permissions: [] },
  { path: '/users', title: 'Users', permissions: ['users.read_all', 'users.read_department'] },
  { path: '/departments', title: 'Departments', permissions: ['departments.read_all', 'departments.read_own'] },
  { path: '/roles', title: 'Roles and permissions', permissions: ['roles.read'] },
];

function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await login(String(form.get('email')), String(form.get('password')));
      location.hash = '/';
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel">
    <h1>Sign in</h1>
    <form onSubmit={signIn} className="login-form">
      <Field label="Work email"><input name="email" type="email" maxLength={254} autoComplete="username" required /></Field>
      <Field label="Password"><input name="password" type="password" maxLength={128} autoComplete="current-password" required /></Field>
      {error && <Notice>{error}</Notice>}
      <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <a href="#/forgot-password">Forgot password?</a>
    </form>
  </section>;
}

function App() {
  const session = useSyncExternalStore(subscribe, getSession);
  const [path, setPath] = useState(() => location.hash.slice(1) || '/');
  const [restoreError, setRestoreError] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [signingOut, setSigningOut] = useState(false);

  function restore() {
    setRestoreError('');
    void refreshSession().catch((reason: unknown) => setRestoreError(errorMessage(reason)));
  }

  useEffect(() => {
    const navigate = () => setPath(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', navigate);
    restore();
    return () => window.removeEventListener('hashchange', navigate);
  }, []);

  async function signOut() {
    setLogoutError('');
    setSigningOut(true);
    try {
      await logout();
      location.hash = '/login';
    } catch (reason) {
      setLogoutError(errorMessage(reason));
    } finally {
      setSigningOut(false);
    }
  }

  if (!session) {
    return <main className="auth-shell">
      <div className="brand">ReguTrack</div>
      {session === undefined ? <section className="panel">
        {restoreError ? <><Notice>{restoreError}</Notice><button onClick={restore}>Retry</button></>
          : <p role="status">Checking session…</p>}
      </section> : path === '/forgot-password' ? <section className="panel">
        <h1>Forgot password</h1>
        <p>Contact your ReguTrack administrator for help recovering your account.</p>
        <a className="button secondary" href="#/login">Back to sign in</a>
      </section> : ['/', '/login'].includes(path) ? <Login /> : <AccessDenied unauthorized />}
    </main>;
  }

  const actor = session.user;
  const visiblePages = pages.filter(({ permissions }) => !permissions.length ||
    permissions.some((permission) => actor.permissions.includes(permission)));
  const home = visiblePages.some((page) => page.path==='/dashboard') ? '/dashboard' : '/profile';
  const current = ['/', '/login', '/forgot-password'].includes(path) ? home : path;
  const [route,query] = current.split('?');
  const regulationPath = /^\/regulations\/([\da-f-]{36})(\/upload)?$/i.exec(route);
  const gapPath = /^\/gaps\/([\da-f-]{36})$/i.exec(current);
  const obligationPath = /^\/obligations\/([\da-f-]{36})$/i.exec(current);
  const taskPath = /^\/tasks\/([\da-f-]{36})$/i.exec(current);
  const creatingObligation = current.split('?')[0] === '/obligations/new';
  const libraryPath = regulationPath || current === '/regulations/new' ? '/regulations'
    : gapPath ? '/gaps' : obligationPath || creatingObligation ? '/obligations' : taskPath ? '/tasks' : route;
  const needsManagement = current === '/regulations/new' || Boolean(regulationPath?.[2]);
  const allowed = visiblePages.some((page) => page.path === libraryPath) &&
    (!needsManagement || actor.permissions.includes('regulations.manage')) &&
    (!creatingObligation || actor.permissions.includes('work.manage_obligations'));
  return <div className="layout">
    <aside className="sidebar">
      <a className="brand" href={'#'+home}>ReguTrack</a>
      <nav aria-label="Main navigation">
        {visiblePages.map((page) => <a key={page.path} href={`#${page.path}`}
          aria-current={libraryPath === page.path ? 'page' : undefined}>{page.title}
          {page.path==='/notifications' && <NotificationBadge key={actor.id} actorId={actor.id}/>}</a>)}
      </nav>
      <div className="sidebar-footer">
        <strong>{actor.name}</strong>
        <button className="secondary" onClick={() => void signOut()} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </aside>
    <main className="content" key={current}>
      {logoutError && <Notice>{logoutError}</Notice>}
      {!allowed ? <AccessDenied />
        : current === '/dashboard' ? <Dashboard />
        : current === '/notifications' ? <Notifications />
        : current === '/reports' ? <Reports />
        : route === '/assistant' ? <AssistantPage query={query} />
        : current === '/regulations' ? <Library actor={actor} />
        : current === '/regulatory-sources' ? <Sources actor={actor} />
        : current === '/regulations/new' ? <NewRegulation />
        : regulationPath?.[2] ? <UploadPdf regulationId={regulationPath[1]} />
        : regulationPath ? <RegulationDetail actor={actor} regulationId={regulationPath[1]} query={query} />
        : current === '/controls' ? <ControlRegister actor={actor} />
        : current === '/gaps' ? <GapOverview />
        : gapPath ? <GapDetail actor={actor} gapId={gapPath[1]} />
        : current === '/obligations' ? <Obligations actor={actor} />
        : creatingObligation ? <CreateObligation query={current.split('?')[1] ?? ''} />
        : obligationPath ? <ObligationDetail actor={actor} obligationId={obligationPath[1]} />
        : current === '/tasks' ? <TaskBoard actor={actor} />
        : taskPath ? <TaskDetail actor={actor} taskId={taskPath[1]} />
        : current === '/audit-logs' ? <AuditLog />
        : current === '/users' ? <Users actor={actor} />
        : current === '/departments' ? <Departments actor={actor} />
        : current === '/roles' ? <Roles />
        : <Profile actor={actor} />}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
