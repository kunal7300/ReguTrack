import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { hashPassword } from './auth.js';
import { audit, email, HttpError, name, password, serializeAdministration, transaction } from './store.js';

async function bootstrap() {
  const administrator = {
    email: email.parse(process.argv[2]),
    name: name.parse(process.argv[3]),
    password: password.parse(readFileSync(0, 'utf8').replace(/\r?\n$/, '')),
  };
  const passwordHash = await hashPassword(administrator.password);
  const pool = new Pool();
  try {
    await transaction(pool, async (db) => {
      await serializeAdministration(db);
      const existing = await db.query("SELECT 1 FROM user_roles WHERE role_code = 'super_admin' LIMIT 1");
      if (existing.rowCount) throw new HttpError(409, 'A Super Admin already exists');
      const { rows: [user] } = await db.query(
        'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [administrator.email, administrator.name, passwordHash],
      );
      await db.query("INSERT INTO user_roles (user_id, role_code) VALUES ($1, 'super_admin')", [user.id]);
      await audit(db, null, 'user.bootstrap', 'user', user.id);
    });
    console.log('Super Admin created');
  } finally {
    await pool.end();
  }
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof HttpError ? error.message : 'Bootstrap failed. Check the email, name, password and database.');
  process.exitCode = 1;
});
