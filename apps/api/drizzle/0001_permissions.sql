-- App has no schema ownership or CREATE privileges. Migration role owns DDL.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, practitioners, patients, patient_identity, care_team,
  patient_invites, patient_devices, sessions, refresh_tokens TO app;
--> statement-breakpoint
REVOKE ALL ON audit_events, consents FROM PUBLIC;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events, consents FROM app;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_events, consents TO app;
--> statement-breakpoint
CREATE FUNCTION reject_append_only_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table cannot be changed' USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER consents_immutable BEFORE UPDATE OR DELETE ON consents
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER consents_no_truncate BEFORE TRUNCATE ON consents
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
