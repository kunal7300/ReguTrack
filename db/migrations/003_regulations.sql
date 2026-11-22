BEGIN;
CREATE TABLE IF NOT EXISTS regulatory_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, url text NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS regulations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, kind text NOT NULL
 CHECK (kind IN ('circular','notification','master_direction','master_circular','amendment')),
 source_id uuid REFERENCES regulatory_sources, reference text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS regulation_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), regulation_id uuid NOT NULL REFERENCES regulations,
 number integer NOT NULL CHECK (number > 0), source_url text, version_note text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(regulation_id, number)
);
CREATE TABLE IF NOT EXISTS documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version_id uuid NOT NULL UNIQUE REFERENCES regulation_versions,
 object_key text NOT NULL UNIQUE, filename text NOT NULL, bytes integer NOT NULL CHECK(bytes > 0),
 sha256 text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'queued'
 CHECK(status IN ('queued','processing','processed','failed')), error text, page_count integer,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS document_chunks (
 document_id uuid NOT NULL REFERENCES documents, page integer NOT NULL CHECK(page > 0),
 ordinal integer NOT NULL CHECK(ordinal > 0), heading text, text text NOT NULL,
 ocr boolean NOT NULL, PRIMARY KEY(document_id,page,ordinal)
);
INSERT INTO permissions(code,description) VALUES
 ('regulations.read','Read the regulatory library'),('regulations.manage','Manage regulatory records and sources')
 ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code,permission_code)
 SELECT code,'regulations.read' FROM roles ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code,permission_code)
 SELECT code,'regulations.manage' FROM roles WHERE code IN
 ('super_admin','chief_compliance_officer','compliance_officer') ON CONFLICT DO NOTHING;
COMMIT;
