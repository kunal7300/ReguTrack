BEGIN;
CREATE TABLE IF NOT EXISTS regulation_comparisons (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 regulation_id uuid NOT NULL REFERENCES regulations,
 old_version_id uuid NOT NULL REFERENCES regulation_versions,
 new_version_id uuid NOT NULL REFERENCES regulation_versions,
 created_by uuid NOT NULL REFERENCES users,
 created_at timestamptz NOT NULL DEFAULT now(),
 impact_status text NOT NULL CHECK(impact_status IN ('skipped','completed','failed')),
 impact_error text,
 model text,
 CHECK(old_version_id <> new_version_id)
);
CREATE INDEX IF NOT EXISTS comparisons_regulation ON regulation_comparisons(regulation_id,created_at DESC);
CREATE TABLE IF NOT EXISTS regulatory_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 comparison_id uuid NOT NULL REFERENCES regulation_comparisons,
 ordinal integer NOT NULL, category text NOT NULL CHECK(category IN ('added','modified','removed','unchanged')),
 old_section jsonb, new_section jsonb, signals jsonb NOT NULL DEFAULT '{}',
 ai_explanation jsonb,
 decision text CHECK(decision IN ('confirmed','dismissed','needs_follow_up')),
 review_history jsonb NOT NULL DEFAULT '[]',
 UNIQUE(comparison_id,ordinal)
);
INSERT INTO permissions(code,description) VALUES
 ('comparisons.read','Read regulatory version comparisons'),
 ('comparisons.manage','Create regulatory comparisons and review changes') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT code,'comparisons.read' FROM roles ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT code,'comparisons.manage' FROM roles
 WHERE code IN ('super_admin','chief_compliance_officer','compliance_officer') ON CONFLICT DO NOTHING;
COMMIT;
