import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

export type Database = Pool | PoolClient;

export const email = z.email().max(254).transform((value) => value.toLowerCase());
export const name = z.string().trim().min(1).max(120);
export const password = z.string().min(12).max(128);
export const id = z.uuid();

export const account = z.object({
  id,
  email: z.email(),
  name,
  departmentId: id.nullable(),
  active: z.boolean(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
});
export type Account = z.infer<typeof account>;

export const accountColumns = `u.id, u.email, u.name, u.department_id AS "departmentId", u.active,
  ARRAY(SELECT ur.role_code FROM user_roles ur WHERE ur.user_id = u.id ORDER BY ur.role_code) AS roles,
  ARRAY(SELECT DISTINCT rp.permission_code FROM user_roles ur
        JOIN role_permissions rp USING (role_code) WHERE ur.user_id = u.id
        ORDER BY rp.permission_code) AS permissions`;

export async function getAccount(db: Database, userId: string) {
  const result = await db.query(`SELECT ${accountColumns} FROM users u WHERE u.id = $1`, [userId]);
  return result.rows.length ? account.parse(result.rows[0]) : undefined;
}

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function audit(
  db: Database, actorId: string | null, action: string, targetType: string,
  targetId: string | null, details: Record<string, unknown> = {},
) {
  await db.query(
    'INSERT INTO audit_logs (actor_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)',
    [actorId, action, targetType, targetId, details],
  );
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export const argonOptions = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export async function serializeAdministration(db: Database) {
  await db.query('SELECT pg_advisory_xact_lock(713202)');
}
