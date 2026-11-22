BEGIN;
SELECT pg_advisory_xact_lock(713201);

CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_-]{1,19}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  password_hash text NOT NULL,
  department_id uuid REFERENCES departments(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_department_idx ON users (department_id);
CREATE TABLE IF NOT EXISTS roles (
  code text PRIMARY KEY,
  name text NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS permissions (
  code text PRIMARY KEY,
  description text NOT NULL
);
CREATE TABLE IF NOT EXISTS user_roles (
  user_id uuid NOT NULL REFERENCES users(id),
  role_code text NOT NULL REFERENCES roles(code),
  PRIMARY KEY (user_id, role_code)
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_code text NOT NULL REFERENCES roles(code),
  permission_code text NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (role_code, permission_code)
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  session_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_live_session_idx
  ON refresh_tokens(session_id) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_type text,
  target_id uuid,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO roles (code, name) VALUES
  ('super_admin', 'Super Admin'),
  ('chief_compliance_officer', 'Chief Compliance Officer'),
  ('compliance_officer', 'Compliance Officer'),
  ('department_manager', 'Department Manager'),
  ('department_employee', 'Department Employee'),
  ('internal_auditor', 'Internal Auditor')
ON CONFLICT DO NOTHING;

INSERT INTO permissions (code, description) VALUES
  ('users.read_all', 'Read the bank-wide user directory'),
  ('users.read_department', 'Read users in the assigned department'),
  ('users.manage', 'Create, edit, and change account status'),
  ('roles.read', 'Read the role and permission catalog'),
  ('departments.read_all', 'Read all departments'),
  ('departments.read_own', 'Read the assigned department'),
  ('departments.manage', 'Create departments')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'super_admin', code FROM permissions
WHERE code IN ('users.read_all', 'users.read_department', 'users.manage', 'roles.read',
              'departments.read_all', 'departments.read_own', 'departments.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT role_code, permission_code
FROM (VALUES
  ('chief_compliance_officer', 'users.read_all'),
  ('chief_compliance_officer', 'departments.read_all'),
  ('chief_compliance_officer', 'roles.read'),
  ('compliance_officer', 'departments.read_all'),
  ('department_manager', 'users.read_department'),
  ('department_manager', 'departments.read_own'),
  ('department_employee', 'departments.read_own'),
  ('internal_auditor', 'users.read_all'),
  ('internal_auditor', 'departments.read_all'),
  ('internal_auditor', 'roles.read')
) AS grants(role_code, permission_code)
ON CONFLICT DO NOTHING;
COMMIT;
