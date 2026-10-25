ALTER TABLE "alerts" DROP CONSTRAINT "alerts_severity_valid";--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "evaluation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "rule_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "source" text DEFAULT 'rule' NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "adverse_event_id" uuid;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_adverse_event_id_adverse_events_id_fk" FOREIGN KEY ("adverse_event_id") REFERENCES "public"."adverse_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_source_valid" CHECK (("alerts"."source" = 'rule' and "alerts"."severity" = 'critical' and "alerts"."evaluation_id" is not null and "alerts"."rule_id" is not null and "alerts"."adverse_event_id" is null)
        or ("alerts"."source" = 'adverse_event' and "alerts"."severity" = 'warning' and "alerts"."adverse_event_id" is not null and "alerts"."evaluation_id" is null and "alerts"."rule_id" is null and "alerts"."escalate_at" is null and "alerts"."escalation_of" is null));--> statement-breakpoint
-- Adverse event notifications (FR-6, owner decision 2026-10-25): source, rule_id and
-- evaluation_id are nullable now, so the guard compares with IS DISTINCT FROM and covers the
-- new columns. Body otherwise unchanged from 0008.
CREATE OR REPLACE FUNCTION alerts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_rank integer;
  new_rank integer;
BEGIN
  IF NEW.id <> OLD.id OR NEW.patient_id <> OLD.patient_id OR NEW.recipient_id <> OLD.recipient_id
    OR NEW.source <> OLD.source
    OR NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id
    OR NEW.adverse_event_id IS DISTINCT FROM OLD.adverse_event_id
    OR NEW.rule_id IS DISTINCT FROM OLD.rule_id
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
-- CREATE OR REPLACE keeps the 0008 revoke, but state it again: trigger functions are never called.
REVOKE EXECUTE ON FUNCTION alerts_guard() FROM PUBLIC;
