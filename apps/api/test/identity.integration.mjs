import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const require = createRequire(resolve(root, 'package.json'));
const { Pool } = require('pg');
const { createApp } = await import(pathToFileURL(resolve(root, 'apps/api/dist/app.js')));
const { createIdentity } = await import(pathToFileURL(resolve(root, 'apps/api/dist/identity/index.js')));
const password = randomBytes(24).toString('hex');

test('Phase 1 against PostgreSQL: session lifecycle, scopes, grants and audit', async (t) => {
  const schema = 'identity_test_' + randomBytes(8).toString('hex');
  const database = new Pool();
  t.after(() => database.end());
  await database.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ options: `-c search_path=${schema},public` });
  t.after(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });
  const migration = readFileSync(process.env.IDENTITY_MIGRATION ?? 'db/migrations/002_identity.sql', 'utf8');
  await pool.query(migration);
  await pool.query(migration);

  const adminEmail = 'admin@example.test';
  const bootstrap = resolve(root, 'apps/api/dist/identity/bootstrap.js');
  const bootstrapEnv = { ...process.env, PGOPTIONS: `-c search_path=${schema},public` };
  execFileSync(process.execPath, [bootstrap, adminEmail, 'Synthetic Admin'], {
    input: password, env: bootstrapEnv, stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.throws(() => execFileSync(process.execPath, [bootstrap, 'second@example.test', 'Second Admin'], {
    input: password, env: bootstrapEnv, stdio: ['pipe', 'pipe', 'pipe'],
  }), /already exists/);

  const probe = async () => {};
  const server = createApp({ postgres: probe, redis: probe, ai: probe },
    createIdentity(pool, randomBytes(32).toString('hex'), true)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  async function call(path, { method = 'GET', body, token, cookie } = {}) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  async function read(path, options, status) {
    const response = await call(path, options);
    const body = await response.json();
    assert.equal(response.status, status, `${options?.method ?? 'GET'} ${path}: ${JSON.stringify(body)}`);
    return { body, cookie: response.headers.get('set-cookie') };
  }

  const login = (email, secret = password, status = 200) =>
    read('/auth/login', { method: 'POST', body: { email, password: secret } }, status);
  const withCookie = (cookie) => ({ method: 'POST', cookie: cookie.split(';')[0], body: {} });
  assert.equal((await call('/users')).status, 401);
  assert.equal((await call('/auth/logout', { method: 'POST' })).status, 415);
  await login('unknown@example.test', password, 401);
  await login(adminEmail, 'wrong secret', 401);
  const original = await login(adminEmail.toUpperCase());
  assert.match(original.cookie, /HttpOnly/i);
  assert.match(original.cookie, /SameSite=Strict/i);
  assert.match(original.cookie, /Secure/i);
  assert.equal(original.body.expiresIn, 300);
  const raw = original.cookie.split(';')[0].split('=')[1];
  const digest = createHash('sha256').update(raw).digest('hex');
  const stored = await pool.query('SELECT token_hash FROM refresh_tokens');
  assert.deepEqual(stored.rows, [{ token_hash: digest }]);
  const passwordRows = await pool.query('SELECT password_hash FROM users');
  assert.match(passwordRows.rows[0].password_hash, /^\$argon2id\$/);

  const rotated = await read('/auth/refresh', withCookie(original.cookie), 200);
  assert.notEqual(original.cookie, rotated.cookie);
  await read('/auth/refresh', withCookie(original.cookie), 401);
  await read('/auth/me', { token: rotated.body.accessToken }, 401);
  await read('/auth/refresh', withCookie(rotated.cookie), 401);

  const admin = await login(adminEmail);
  const token = admin.body.accessToken;
  const adminId = admin.body.user.id;
  assert.equal((await read('/auth/me', { token }, 200)).body.id, adminId);
  assert.equal((await read('/roles', { token }, 200)).body.roles.length, 6);
  await read('/users/' + adminId + '/status', { method: 'PATCH', token, body: { active: false } }, 403);
  await read('/users/' + adminId, { method: 'PATCH', token, body: { roles: ['internal_auditor'] } }, 403);

  async function createDepartment(code) {
    return (await read('/departments', { method: 'POST', token, body: { code, name: code } }, 201)).body;
  }
  const operations = await createDepartment('OPERATIONS');
  const treasury = await createDepartment('TREASURY');
  await read('/departments', { method: 'POST', token, body: { name: 'Bad', code: 'bad' } }, 400);
  async function createUser(prefix, departmentId, role, status = 201) {
    return (await read('/users', { method: 'POST', token, body: {
      email: `${prefix}@example.test`, name: prefix, password, departmentId, roles: [role],
    } }, status)).body;
  }
  await createUser('unassigned', null, 'department_manager', 400);
  const manager = await createUser('manager', operations.id, 'department_manager');
  const analyst = await createUser('analyst', operations.id, 'department_employee');
  const other = await createUser('other', treasury.id, 'department_employee');
  const auditor = await createUser('auditor', null, 'internal_auditor');
  const managerSession = await login(manager.email);
  const managerToken = managerSession.body.accessToken;
  const employee = await login(analyst.email);
  const auditorSession = await login(auditor.email);

  const scope = await read('/users', { token: managerToken }, 200);
  assert.deepEqual(new Set(scope.body.users.map(({ id }) => id)), new Set([manager.id, analyst.id]));
  const ownDepartment = await read('/departments', { token: managerToken }, 200);
  assert.deepEqual(ownDepartment.body.departments, [operations]);
  await read('/users/' + analyst.id, { token: managerToken }, 200);
  await read('/users/' + other.id, { token: managerToken }, 404);
  await read('/users/' + analyst.id, { method: 'PATCH', token: managerToken, body: { name: 'Denied' } }, 403);
  await read('/roles', { token: managerToken }, 403);
  await read('/users', { token: employee.body.accessToken }, 403);
  await read('/users/' + other.id, { token: auditorSession.body.accessToken }, 200);
  await read('/departments', { method: 'POST', token: auditorSession.body.accessToken, body: { name: 'Denied', code: 'DENIED' } }, 403);

  await read('/users/' + manager.id, { method: 'PATCH', token, body: { departmentId: treasury.id } }, 200);
  await read('/users/' + analyst.id, { token: managerToken }, 404);
  await read('/users/' + other.id, { token: managerToken }, 200);
  await read('/users/' + manager.id + '/status', { method: 'PATCH', token, body: { active: false } }, 200);
  await login(manager.email, password, 401);
  await read('/auth/me', { token: managerToken }, 401);
  await read('/auth/refresh', withCookie(managerSession.cookie), 401);
  await read('/users/' + manager.id + '/status', { method: 'PATCH', token, body: { active: true } }, 200);
  await read('/auth/me', { token: managerToken }, 401);

  assert.equal((await call('/auth/logout', withCookie(admin.cookie))).status, 204);
  await read('/auth/me', { token }, 401);
  const auditRows = await pool.query('SELECT action, details FROM audit_logs');
  for (const action of ['user.bootstrap', 'auth.login', 'auth.login_failed', 'auth.logout', 'auth.refresh_reuse',
    'user.created', 'user.updated', 'user.status_changed', 'department.created']) {
    assert(auditRows.rows.some((row) => row.action === action), action);
  }
  assert(!JSON.stringify(auditRows.rows).includes(password));
  assert(!JSON.stringify(auditRows.rows).includes(raw));
});
