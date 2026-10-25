-- Security signals (NFR-2), least privilege for the runtime role.
-- Rows are append-only; only the acknowledgement is set, once.
REVOKE ALL ON security_signals FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON security_signals TO app;
--> statement-breakpoint
GRANT UPDATE (acknowledged_at, acknowledged_by) ON security_signals TO app;
--> statement-breakpoint
CREATE FUNCTION security_signals_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.window_start <> OLD.window_start
    OR NEW.event_count <> OLD.event_count OR NEW.created_at <> OLD.created_at
    OR OLD.acknowledged_at IS NOT NULL THEN
    RAISE EXCEPTION 'security signal is immutable once acknowledged' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Trigger functions are never called directly.
REVOKE EXECUTE ON FUNCTION security_signals_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER security_signals_transition BEFORE UPDATE ON security_signals
FOR EACH ROW EXECUTE FUNCTION security_signals_guard();
--> statement-breakpoint
CREATE TRIGGER security_signals_no_delete BEFORE DELETE ON security_signals
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER security_signals_no_truncate BEFORE TRUNCATE ON security_signals
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
