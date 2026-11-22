BEGIN;
CREATE TABLE IF NOT EXISTS compliance_obligations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 requirement_id uuid NOT NULL REFERENCES regulatory_requirements,
 gap_id uuid REFERENCES compliance_gaps,
 title text NOT NULL, description text NOT NULL,
 department_id uuid NOT NULL REFERENCES departments,
 accountable_id uuid NOT NULL REFERENCES users, target_date date NOT NULL,
 priority text NOT NULL CHECK(priority IN ('low','medium','high','critical')),
 applicability text,
 approval_state text NOT NULL DEFAULT 'draft' CHECK(approval_state IN ('draft','approved')),
 created_by uuid NOT NULL REFERENCES users, edited_by uuid NOT NULL REFERENCES users,
 approved_by uuid REFERENCES users, approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), revision integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS obligations_department ON compliance_obligations(department_id);
CREATE INDEX IF NOT EXISTS obligations_requirement ON compliance_obligations(requirement_id);
CREATE TABLE IF NOT EXISTS compliance_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 obligation_id uuid NOT NULL REFERENCES compliance_obligations,
 title text NOT NULL, description text NOT NULL, due_date date NOT NULL,
 status text NOT NULL DEFAULT 'created' CHECK(status IN
 ('created','assigned','in_progress','evidence_submitted','under_review','rejected','verified','completed','blocked','cancelled')),
 blocked_from text CHECK(blocked_from IN ('assigned','in_progress','rejected')),
 submitted_by uuid REFERENCES users,
 submission_note text, created_by uuid NOT NULL REFERENCES users,
 created_at timestamptz NOT NULL DEFAULT now(), revision integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_obligation ON compliance_tasks(obligation_id);
CREATE TABLE IF NOT EXISTS task_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES compliance_tasks,
 assignee_id uuid NOT NULL REFERENCES users, assigned_by uuid NOT NULL REFERENCES users,
 assigned_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS task_current_assignment ON task_assignments(task_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS task_assignee ON task_assignments(assignee_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS task_comments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES compliance_tasks,
 author_id uuid NOT NULL REFERENCES users, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS task_status_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, task_id uuid NOT NULL REFERENCES compliance_tasks,
 actor_id uuid NOT NULL REFERENCES users, from_status text, to_status text NOT NULL,
 reason text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_history_lookup ON task_status_history(task_id,id DESC);
CREATE INDEX IF NOT EXISTS work_audit_target ON audit_logs(target_id,action)
 WHERE action IN ('obligation.updated','task.updated');
INSERT INTO permissions(code,description) VALUES
 ('work.read_all','Read all obligations and department tasks'),
 ('work.read_department','Read work for the assigned department'),
 ('work.read_assigned','Read assigned tasks and their obligations'),
 ('work.manage_obligations','Create and approve compliance obligations'),
 ('work.manage_department','Assign and review department work') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT code,'work.read_all' FROM roles
 WHERE code IN ('super_admin','chief_compliance_officer','compliance_officer','internal_auditor') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT code,'work.manage_obligations' FROM roles
 WHERE code IN ('super_admin','chief_compliance_officer','compliance_officer') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT code,permission FROM roles
 CROSS JOIN (VALUES ('work.read_department'),('work.manage_department')) AS grant_options(permission)
 WHERE code='department_manager' ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT code,'work.read_assigned' FROM roles
 WHERE code='department_employee' ON CONFLICT DO NOTHING;
COMMIT;
