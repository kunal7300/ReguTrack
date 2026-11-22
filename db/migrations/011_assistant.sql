BEGIN;
CREATE TABLE IF NOT EXISTS assistant_documents (
 document_id uuid PRIMARY KEY REFERENCES documents,
 generation uuid NOT NULL DEFAULT gen_random_uuid(),
 status text NOT NULL CHECK(status IN ('queued','indexing','ready','failed','revoked')),
 approved_by uuid NOT NULL REFERENCES users, approved_at timestamptz NOT NULL DEFAULT now(),
 indexed_at timestamptz, error text
);
CREATE TABLE IF NOT EXISTS assistant_embeddings (
 document_id uuid NOT NULL, page integer NOT NULL, ordinal integer NOT NULL,
 embedding vector(768) NOT NULL,
 PRIMARY KEY(document_id,page,ordinal),
 FOREIGN KEY(document_id,page,ordinal) REFERENCES document_chunks(document_id,page,ordinal) ON DELETE CASCADE
);
INSERT INTO permissions(code,description) VALUES
 ('assistant.use','Ask the read-only regulatory assistant'),
 ('assistant.publish','Authorize and index processed regulatory PDF versions for the assistant') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT code,'assistant.use' FROM roles ON CONFLICT DO NOTHING;
INSERT INTO role_permissions SELECT code,'assistant.publish' FROM roles
 WHERE code IN ('super_admin','chief_compliance_officer','compliance_officer') ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='regutrack_app') THEN
   GRANT SELECT,INSERT,UPDATE ON assistant_documents TO regutrack_app;
   GRANT SELECT,INSERT,UPDATE,DELETE ON assistant_embeddings TO regutrack_app;
 END IF;
END $$;
COMMIT;
