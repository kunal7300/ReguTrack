import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api';

export function useResource<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let current = true;
    setData(undefined);
    setError(undefined);
    load().then(
      (value) => { if (current) setData(value); },
      (reason: unknown) => { if (current) setError(reason); },
    );
    return () => { current = false; };
  }, [load]);
  return { data, error };
}

export function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : 'Unable to connect to ReguTrack. Try again.';
}

export function Notice({ children }: { children: ReactNode }) {
  return <p className="notice" role="alert">{children}</p>;
}

export function AccessDenied({ unauthorized = false }: { unauthorized?: boolean }) {
  return (
    <section className="panel">
      <h1>{unauthorized ? 'Sign in required' : 'Access denied'}</h1>
      <p>{unauthorized ? 'Sign in to open this page.' : 'Your role does not grant access to this page.'}</p>
      <a className="button secondary" href={unauthorized ? '#/login' : '#/profile'}>
        {unauthorized ? 'Go to sign in' : 'Back to profile'}
      </a>
    </section>
  );
}

export function Resource<T>({ data, error, children }: {
  data: T | undefined; error: unknown; children: (value: T) => ReactNode;
}) {
  if (error instanceof ApiError && error.status === 403) return <AccessDenied />;
  if (error) return <Notice>{errorMessage(error)}</Notice>;
  return data === undefined ? <p role="status">Loading…</p> : children(data);
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
