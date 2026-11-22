BEGIN;
CREATE TABLE IF NOT EXISTS evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES compliance_tasks,
 title text NOT NULL, created_by uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evidence_task ON evidence(task_id,created_at);
CREATE TABLE IF NOT EXISTS evidence_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), evidence_id uuid NOT NULL REFERENCES evidence,
 number integer NOT NULL CHECK(number>0), filename text NOT NULL, mime text NOT NULL, bytes integer NOT NULL CHECK(bytes>0),
 sha256 text NOT NULL, object_key text NOT NULL UNIQUE, uploaded_by uuid NOT NULL REFERENCES users,
 created_at timestamptz NOT NULL DEFAULT now(), submission_revision integer,
 UNIQUE(evidence_id,number), UNIQUE(evidence_id,sha256)
);
CREATE TABLE IF NOT EXISTS approvals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), evidence_version_id uuid NOT NULL UNIQUE REFERENCES evidence_versions,
 reviewer_id uuid NOT NULL REFERENCES users, decision text NOT NULL CHECK(decision IN ('approved','rejected')),
 comment text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE compliance_tasks ADD COLUMN IF NOT EXISTS evidence_submission_revision integer;
INSERT INTO permissions(code,description) VALUES ('audit.read','Read the full security and workflow audit trail') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT code,'audit.read' FROM roles WHERE code IN ('super_admin','internal_auditor') ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS audit_entity ON audit_logs(target_type,target_id,id DESC);
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Audit events are append-only' USING ERRCODE='42501';
END;
$$;
DROP TRIGGER IF EXISTS audit_immutable ON audit_logs;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
 FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
REVOKE UPDATE,DELETE,TRUNCATE ON audit_logs FROM PUBLIC;
COMMIT;
