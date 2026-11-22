BEGIN;
CREATE TABLE IF NOT EXISTS notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
 kind text NOT NULL, title text NOT NULL, entity_id uuid NOT NULL, route text NOT NULL,
 dedupe_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
 UNIQUE(user_id,dedupe_key)
);
CREATE INDEX IF NOT EXISTS notifications_owner ON notifications(user_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS notification_checkpoint (
 id boolean PRIMARY KEY CHECK(id), audit_id bigint NOT NULL
);
INSERT INTO notification_checkpoint VALUES (true,COALESCE((SELECT max(id) FROM audit_logs),0))
 ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS notification_events (audit_id bigint PRIMARY KEY REFERENCES audit_logs(id));
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='regutrack_app') THEN
   GRANT SELECT,INSERT ON notifications TO regutrack_app;
   GRANT UPDATE(read_at) ON notifications TO regutrack_app;
   GRANT SELECT,UPDATE ON notification_checkpoint TO regutrack_app;
   GRANT SELECT,INSERT ON notification_events TO regutrack_app;
 END IF;
END $$;
COMMIT;
