-- Alerts (stage 6), least privilege for the runtime role (as in 0002, 0004 and 0006).
-- Content is immutable; only delivery timestamps and escalation move forward (alerts_guard).
REVOKE ALL ON alerts FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON alerts TO app;
--> statement-breakpoint
GRANT UPDATE (status, attempted_at, sent_at, delivered_at, acknowledged_at, acknowledged_by, escalate_at, escalated_at) ON alerts TO app;
--> statement-breakpoint
CREATE FUNCTION alerts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_rank integer;
  new_rank integer;
BEGIN
  IF NEW.id <> OLD.id OR NEW.patient_id <> OLD.patient_id OR NEW.recipient_id <> OLD.recipient_id
    OR NEW.evaluation_id <> OLD.evaluation_id OR NEW.rule_id <> OLD.rule_id
    OR NEW.severity <> OLD.severity OR NEW.message <> OLD.message
    OR NEW.suggested_action <> OLD.suggested_action OR NEW.created_at <> OLD.created_at
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.escalation_of IS DISTINCT FROM OLD.escalation_of THEN
    RAISE EXCEPTION 'alert content is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
    OR OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
      OR NEW.acknowledged_by IS DISTINCT FROM OLD.acknowledged_by)
    OR OLD.escalated_at IS NOT NULL AND NEW.escalated_at IS DISTINCT FROM OLD.escalated_at THEN
    RAISE EXCEPTION 'alert timestamps are immutable once set' USING ERRCODE = '42501';
  END IF;
  old_rank := CASE OLD.status WHEN 'pending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END;
  new_rank := CASE NEW.status WHEN 'pending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END;
  IF new_rank < old_rank THEN
    RAISE EXCEPTION 'alert status cannot move backwards' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Trigger functions are never called directly.
REVOKE EXECUTE ON FUNCTION alerts_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER alerts_transition BEFORE UPDATE ON alerts
FOR EACH ROW EXECUTE FUNCTION alerts_guard();
--> statement-breakpoint
CREATE TRIGGER alerts_no_delete BEFORE DELETE ON alerts
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER alerts_no_truncate BEFORE TRUNCATE ON alerts
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
