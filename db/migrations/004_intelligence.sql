BEGIN;
CREATE TABLE IF NOT EXISTS ai_analysis_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_id uuid NOT NULL REFERENCES documents,
 requested_by uuid NOT NULL REFERENCES users, status text NOT NULL DEFAULT 'queued'
 CHECK (status IN ('queued','running','completed','failed')),
 model text, raw_output jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_analysis_one_active ON ai_analysis_runs(document_id)
 WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS regulatory_requirements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES ai_analysis_runs,
 suggestion jsonb NOT NULL, status text NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','revised','approved','rejected')),
 revision integer NOT NULL DEFAULT 0, human_result jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS requirements_run ON regulatory_requirements(run_id);
CREATE TABLE IF NOT EXISTS requirement_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid NOT NULL REFERENCES regulatory_requirements,
 reviewer_id uuid NOT NULL REFERENCES users, action text NOT NULL CHECK(action IN ('revise','approve','reject')),
 revision integer NOT NULL, human_result jsonb NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(requirement_id,revision)
);
INSERT INTO permissions(code,description) VALUES
 ('intelligence.read','Read regulatory analysis and requirement history'),
 ('intelligence.analyze','Request grounded AI extraction'),
 ('intelligence.review','Revise and decide regulatory requirements') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code,permission_code)
 SELECT code,'intelligence.read' FROM roles ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code,permission_code)
 SELECT code,permission FROM roles CROSS JOIN (VALUES ('intelligence.analyze'),('intelligence.review')) p(permission)
 WHERE code IN ('super_admin','chief_compliance_officer','compliance_officer') ON CONFLICT DO NOTHING;
COMMIT;
