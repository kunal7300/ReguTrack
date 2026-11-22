BEGIN;
CREATE TABLE IF NOT EXISTS control_register (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE,
 description text NOT NULL, department_id uuid REFERENCES departments,
 created_by uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS control_requirement_mappings (
 requirement_id uuid NOT NULL REFERENCES regulatory_requirements,
 control_id uuid NOT NULL REFERENCES control_register,
 mapped_by uuid NOT NULL REFERENCES users, mapped_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(requirement_id,control_id)
);
CREATE TABLE IF NOT EXISTS compliance_gaps (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid NOT NULL UNIQUE REFERENCES regulatory_requirements,
 created_by uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL CHECK(status IN ('not_assessed','gap_identified','partially_addressed','fully_addressed','not_applicable','awaiting_validation')),
 proposed_status text CHECK(proposed_status IN ('gap_identified','partially_addressed','fully_addressed','not_applicable')),
 assessment text, remediation_proposal text, ai_suggestion jsonb, ai_error text,
 decision text CHECK(decision IN ('approved','rejected')), remediation jsonb,
 revision integer NOT NULL DEFAULT 0, history jsonb NOT NULL DEFAULT '[]'
);
INSERT INTO permissions(code,description) VALUES
 ('gaps.read','Read compliance controls and assessments'),
 ('gaps.manage','Register controls, assess and validate gaps') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT code,'gaps.read' FROM roles
 WHERE code IN ('super_admin','chief_compliance_officer','compliance_officer','internal_auditor') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT code,'gaps.manage' FROM roles
 WHERE code IN ('super_admin','chief_compliance_officer','compliance_officer') ON CONFLICT DO NOTHING;
COMMIT;
