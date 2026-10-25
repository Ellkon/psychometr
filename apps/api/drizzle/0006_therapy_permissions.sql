-- Therapy diary (stage 5), least privilege for the runtime role (as in 0002 and 0004).
-- Dose marks and adverse events are append-only; a prescription changes only once,
-- from active to stopped (medication_requests_guard).
REVOKE ALL ON medication_requests, dose_log, adverse_events FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON medication_requests, dose_log, adverse_events TO app;
--> statement-breakpoint
GRANT UPDATE (status, stopped_at, stopped_by) ON medication_requests TO app;
--> statement-breakpoint
CREATE TRIGGER dose_log_immutable BEFORE UPDATE OR DELETE ON dose_log
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER dose_log_no_truncate BEFORE TRUNCATE ON dose_log
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER adverse_events_immutable BEFORE UPDATE OR DELETE ON adverse_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER adverse_events_no_truncate BEFORE TRUNCATE ON adverse_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE FUNCTION medication_requests_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prescriptions cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'stopped' THEN
    RAISE EXCEPTION 'invalid prescription transition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Trigger functions are never called directly.
REVOKE EXECUTE ON FUNCTION medication_requests_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER medication_requests_transition BEFORE UPDATE ON medication_requests
FOR EACH ROW EXECUTE FUNCTION medication_requests_guard();
--> statement-breakpoint
CREATE TRIGGER medication_requests_no_delete BEFORE DELETE ON medication_requests
FOR EACH ROW EXECUTE FUNCTION medication_requests_guard();
--> statement-breakpoint
CREATE TRIGGER medication_requests_no_truncate BEFORE TRUNCATE ON medication_requests
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
