import { Router, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { hashPassword, requireJson } from './auth.js';
import {
  account, accountColumns, type Account, audit, email, getAccount, HttpError, id,
  name, password, serializeAdministration, transaction,
} from './store.js';

const roleCode = z.enum([
  'super_admin', 'chief_compliance_officer', 'compliance_officer',
  'department_manager', 'department_employee', 'internal_auditor',
]);
const roleCodes = z.array(roleCode).min(1).max(6).refine((roles) => new Set(roles).size === roles.length);
const newUser = z.strictObject({ email, name, password, departmentId: id.nullable(), roles: roleCodes });
const userChanges = newUser.omit({ password: true }).partial().refine((value) => Object.keys(value).length > 0);
const statusInput = z.strictObject({ active: z.boolean() });
const department = z.object({
  id, name, code: z.string().regex(/^[A-Z][A-Z0-9_-]{1,19}$/),
});
const departmentInput = department.omit({ id: true }).strict();
const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const roleDetails = z.object({
  code: roleCode, name, permissions: z.array(z.object({ code: z.string(), description: z.string() })),
});

const identity = (value: unknown) => account.parse(value);

function permit(...permissions: string[]): RequestHandler {
  return (_request, response, next) => {
    const actor = identity(response.locals.user);
    if (!permissions.some((permission) => actor.permissions.includes(permission))) {
      throw new HttpError(403, 'You do not have permission for this action');
    }
    next();
  };
}

function directoryScope(actor: Account) {
  return actor.permissions.includes('users.read_all') ? null : actor.departmentId;
}

async function validateAssignment(db: PoolClient, departmentId: string | null, roles: string[]) {
  if (!departmentId && roles.some((role) => role === 'department_manager' || role === 'department_employee')) {
    throw new HttpError(400, 'Department Managers and Employees must have a department');
  }
  if (departmentId && !(await db.query('SELECT 1 FROM departments WHERE id = $1', [departmentId])).rowCount) {
    throw new HttpError(400, 'Department does not exist');
  }
}

async function setRoles(db: PoolClient, userId: string, roles: string[]) {
  await db.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
  await db.query('INSERT INTO user_roles (user_id, role_code) SELECT $1, unnest($2::text[])', [userId, roles]);
}

async function assertAdministratorRemains(db: PoolClient) {
  const { rowCount } = await db.query(
    "SELECT 1 FROM users JOIN user_roles ON id = user_id WHERE role_code = 'super_admin' AND active LIMIT 1",
  );
  if (!rowCount) throw new HttpError(409, 'An active Super Admin is required');
}

async function manage<T>(
  pool: Pool, actorId: string, permission: string, operation: (db: PoolClient) => Promise<T>,
) {
  return transaction(pool, async (db) => {
    await serializeAdministration(db);
    const actor = await getAccount(db, actorId);
    if (!actor?.active || !actor.permissions.includes(permission)) {
      throw new HttpError(403, 'You do not have permission for this action');
    }
    return operation(db);
  });
}

export function createAdmin(pool: Pool, authenticate: RequestHandler) {
  const router = Router();
  const readUsers = permit('users.read_all', 'users.read_department');
  const manageUsers = permit('users.manage');

  router.get('/users', authenticate, readUsers, async (request, response) => {
    const actor = identity(response.locals.user);
    const { limit, offset } = listQuery.parse(request.query);
    const { rows } = await pool.query(
      `SELECT ${accountColumns} FROM users u
       WHERE ($1::boolean OR u.department_id = $2)
       ORDER BY u.name, u.id LIMIT $3 OFFSET $4`,
      [actor.permissions.includes('users.read_all'), directoryScope(actor), limit + 1, offset],
    );
    response.json({ users: z.array(account).parse(rows.slice(0, limit)), hasMore: rows.length > limit });
  });

  router.get('/users/:id', authenticate, readUsers, async (request, response) => {
    const actor = identity(response.locals.user);
    const user = await getAccount(pool, id.parse(request.params.id));
    if (!user || (!actor.permissions.includes('users.read_all') &&
      (!actor.departmentId || actor.departmentId !== user.departmentId))) {
      throw new HttpError(404, 'User not found');
    }
    response.json(user);
  });

  router.post('/users', authenticate, manageUsers, requireJson(), async (request, response) => {
    const actor = identity(response.locals.user);
    const input = newUser.parse(request.body);
    const passwordHash = await hashPassword(input.password);
    const user = await manage(pool, actor.id, 'users.manage', async (db) => {
      await validateAssignment(db, input.departmentId, input.roles);
      const { rows: [created] } = await db.query(
        'INSERT INTO users (email, name, password_hash, department_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [input.email, input.name, passwordHash, input.departmentId],
      );
      await setRoles(db, created.id, input.roles);
      await audit(db, actor.id, 'user.created', 'user', created.id, {
        roles: input.roles, departmentId: input.departmentId,
      });
      return account.parse(await getAccount(db, created.id));
    });
    response.status(201).json(user);
  });

  router.patch('/users/:id', authenticate, manageUsers, requireJson(), async (request, response) => {
    const actor = identity(response.locals.user);
    const targetId = id.parse(request.params.id);
    const input = userChanges.parse(request.body);
    if (actor.id === targetId && input.roles) throw new HttpError(403, 'You cannot change your own roles');
    const user = await manage(pool, actor.id, 'users.manage', async (db) => {
      await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [targetId]);
      const before = await getAccount(db, targetId);
      if (!before) throw new HttpError(404, 'User not found');
      const departmentId = input.departmentId === undefined ? before.departmentId : input.departmentId;
      await validateAssignment(db, departmentId, input.roles ?? before.roles);
      await db.query(
        'UPDATE users SET email = $2, name = $3, department_id = $4, updated_at = now() WHERE id = $1',
        [targetId, input.email ?? before.email, input.name ?? before.name, departmentId],
      );
      if (input.roles) await setRoles(db, targetId, input.roles);
      await assertAdministratorRemains(db);
      const after = account.parse(await getAccount(db, targetId));
      await audit(db, actor.id, 'user.updated', 'user', targetId, {
        fields: Object.keys(input), rolesBefore: before.roles, rolesAfter: after.roles,
        departmentBefore: before.departmentId, departmentAfter: after.departmentId,
      });
      return after;
    });
    response.json(user);
  });

  router.patch('/users/:id/status', authenticate, manageUsers, requireJson(), async (request, response) => {
    const actor = identity(response.locals.user);
    const targetId = id.parse(request.params.id);
    const { active } = statusInput.parse(request.body);
    if (actor.id === targetId && !active) throw new HttpError(403, 'You cannot disable your own account');
    const user = await manage(pool, actor.id, 'users.manage', async (db) => {
      const before = (await db.query('SELECT active FROM users WHERE id = $1 FOR UPDATE', [targetId])).rows[0];
      if (!before) throw new HttpError(404, 'User not found');
      if (before.active !== active) {
        await db.query('UPDATE users SET active = $2, updated_at = now() WHERE id = $1', [targetId, active]);
        await assertAdministratorRemains(db);
        if (!active) {
          await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [targetId]);
        }
        await audit(db, actor.id, 'user.status_changed', 'user', targetId, { before: before.active, after: active });
      }
      return account.parse(await getAccount(db, targetId));
    });
    response.json(user);
  });

  router.get('/roles', authenticate, permit('roles.read'), async (_request, response) => {
    const { rows } = await pool.query(`SELECT r.code, r.name,
      COALESCE(jsonb_agg(jsonb_build_object('code', p.code, 'description', p.description)
        ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '[]') AS permissions
      FROM roles r LEFT JOIN role_permissions rp ON rp.role_code = r.code
      LEFT JOIN permissions p ON p.code = rp.permission_code GROUP BY r.code, r.name ORDER BY r.name`);
    response.json({ roles: z.array(roleDetails).parse(rows) });
  });

  router.get('/departments', authenticate, permit('departments.read_all', 'departments.read_own'), async (_request, response) => {
    const actor = identity(response.locals.user);
    const { rows } = await pool.query(
      'SELECT id, name, code FROM departments WHERE ($1::boolean OR id = $2) ORDER BY name, id',
      [actor.permissions.includes('departments.read_all'), actor.departmentId],
    );
    response.json({ departments: z.array(department).parse(rows) });
  });

  router.post('/departments', authenticate, permit('departments.manage'), requireJson(), async (request, response) => {
    const actor = identity(response.locals.user);
    const input = departmentInput.parse(request.body);
    const created = await manage(pool, actor.id, 'departments.manage', async (db) => {
      const { rows: [record] } = await db.query(
        'INSERT INTO departments (name, code) VALUES ($1, $2) RETURNING id, name, code', [input.name, input.code],
      );
      const result = department.parse(record);
      await audit(db, actor.id, 'department.created', 'department', result.id, { code: result.code });
      return result;
    });
    response.status(201).json(created);
  });
  return router;
}
