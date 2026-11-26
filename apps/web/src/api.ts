import { z } from 'zod';

export const accountSchema = z.object({
  id: z.uuid(), email: z.email(), name: z.string(), departmentId: z.uuid().nullable(),
  active: z.boolean(), roles: z.array(z.string()), permissions: z.array(z.string()),
});
export const departmentsSchema = z.object({
  departments: z.array(z.object({ id: z.uuid(), name: z.string(), code: z.string() })),
});
export const departmentSchema = departmentsSchema.shape.departments.element;
export const rolesSchema = z.object({
  roles: z.array(z.object({
    code: z.string(), name: z.string(),
    permissions: z.array(z.object({ code: z.string(), description: z.string() })),
  })),
});
const sessionSchema = z.object({ user: accountSchema, accessToken: z.string(), expiresIn: z.number() });
export type Account = z.infer<typeof accountSchema>;
type Session = z.infer<typeof sessionSchema>;
let session: Session | null | undefined;
const listeners = new Set<() => void>();
let refreshing: Promise<Session | null> | undefined;

export function getSession() {
  return session;
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function setSession(value: Session | null) {
  session = value;
  listeners.forEach((listener) => listener());
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const errorSchema = z.object({
  error: z.string(),
  issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
});

async function requireSuccess(response: Response) {
  if (response.ok) return;
  const result = errorSchema.safeParse(await response.json().catch(() => null));
  const issue = result.data?.issues?.[0];
  const message = issue
    ? [issue.path.join('.'), issue.message].filter(Boolean).join(' — ')
    : result.data?.error ?? 'Unable to complete the request';
  throw new ApiError(response.status, message);
}

function send(path: string, method = 'GET', body?: unknown, token?: string, signal?: AbortSignal) {
  const headers = new Headers({ Accept: 'application/json' });
  if (body !== undefined && !(body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch('/api/v1' + path, {
    method, headers, credentials: 'same-origin', cache: 'no-store', signal,
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
}

async function withSessionLock<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(90_000);
  try {
    if (!navigator.locks) return await operation(signal);
    return await navigator.locks.request('regutrack-session', { signal }, () => operation(signal));
  } catch (error) {
    if (signal.aborted) throw new ApiError(408, 'The server took too long to respond. Please try again.');
    throw error;
  }
}

export async function login(email: string, password: string) {
  // Complete any pending refresh before switching the account in this tab.
  if (refreshing) await refreshing.catch(() => {});
  return withSessionLock(async (signal) => {
    const response = await send('/auth/login', 'POST', { email, password }, undefined, signal);
    await requireSuccess(response);
    setSession(sessionSchema.parse(await response.json()));
  });
}

export function refreshSession() {
  refreshing ??= withSessionLock(async (signal) => {
    const response = await send('/auth/refresh', 'POST', {}, undefined, signal);
    if (response.status === 401) {
      setSession(null);
      return null;
    }
    await requireSuccess(response);
    const next = sessionSchema.parse(await response.json());
    setSession(next);
    return next;
  }).finally(() => { refreshing = undefined; });
  return refreshing;
}

export async function logout() {
  return withSessionLock(async (signal) => {
    const response = await send('/auth/logout', 'POST', {}, undefined, signal);
    await requireSuccess(response);
    setSession(null);
  });
}

async function authenticatedRequest(path: string, method = 'GET', body?: unknown) {
  const previous = session;
  if (!previous) throw new ApiError(401, 'Sign in required');
  let response = await send(path, method, body, previous.accessToken);
  if (response.status === 401) {
    const next = session !== previous ? session : await refreshSession();
    if (next) response = await send(path, method, body, next.accessToken);
  }
  await requireSuccess(response);
  return response;
}

export async function request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
  const response = await authenticatedRequest(path, method, body);
  return schema.parse(await response.json());
}

export async function fetchPdf(documentId: string) {
  const response = await authenticatedRequest('/regulatory-documents/' + documentId + '/pdf');
  return response.blob();
}

export async function fetchEvidence(evidenceId: string, versionId: string) {
  const response = await authenticatedRequest('/evidence/' + evidenceId + '/download?versionId=' + versionId);
  return response.blob();
}

export async function fetchReport(path: string) {
  return (await authenticatedRequest(path)).blob();
}
