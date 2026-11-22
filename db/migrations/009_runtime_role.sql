BEGIN;
\getenv work_db_password REGUTRACK_DB_APP_PASSWORD
SELECT 'CREATE ROLE regutrack_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='regutrack_app')
\gexec
SELECT format('ALTER ROLE regutrack_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
 :'work_db_password')
\gexec
GRANT USAGE ON SCHEMA public TO regutrack_app;
REVOKE CREATE ON SCHEMA public FROM regutrack_app;
GRANT SELECT ON roles,permissions,role_permissions,audit_logs TO regutrack_app;
GRANT SELECT,INSERT ON departments,regulatory_sources,regulations,regulation_versions,requirement_reviews,
  regulation_comparisons,control_register,control_requirement_mappings,task_comments,task_status_history,evidence,approvals TO regutrack_app;
GRANT SELECT,INSERT,UPDATE ON users,refresh_tokens,documents,ai_analysis_runs,regulatory_requirements,
  regulatory_changes,compliance_gaps,compliance_obligations,compliance_tasks,task_assignments,evidence_versions TO regutrack_app;
GRANT SELECT,INSERT,DELETE ON user_roles,document_chunks TO regutrack_app;
GRANT INSERT ON audit_logs TO regutrack_app;
GRANT USAGE ON SEQUENCE audit_logs_id_seq,task_status_history_id_seq TO regutrack_app;
REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON audit_logs FROM regutrack_app;
COMMIT;
