CREATE TABLE "contact_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"preferred_time" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"contact_id" uuid,
	CONSTRAINT "contact_requests_reason" CHECK ("contact_requests"."reason" in ('medication', 'side_effect', 'worse', 'other')),
	CONSTRAINT "contact_requests_time" CHECK ("contact_requests"."preferred_time" in ('morning', 'day', 'evening', 'any')),
	CONSTRAINT "contact_requests_resolution" CHECK (("contact_requests"."resolved_at" is null) = ("contact_requests"."contact_id" is null))
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"contacted_at" timestamp with time zone NOT NULL,
	"note" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contacts_channel" CHECK ("contacts"."channel" in ('phone', 'message', 'visit')),
	CONSTRAINT "contacts_note_length" CHECK (length("contacts"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_source_valid";--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "contact_request_id" uuid;--> statement-breakpoint
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_practitioner_id_practitioners_user_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."practitioners"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_requests_submission_idx" ON "contact_requests" USING btree ("patient_id","submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_requests_open_idx" ON "contact_requests" USING btree ("patient_id") WHERE "contact_requests"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_submission_idx" ON "contacts" USING btree ("practitioner_id","submission_id");--> statement-breakpoint
CREATE INDEX "contacts_patient_idx" ON "contacts" USING btree ("patient_id","contacted_at");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_contact_request_id_contact_requests_id_fk" FOREIGN KEY ("contact_request_id") REFERENCES "public"."contact_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_source_valid" CHECK (("alerts"."source" = 'rule' and "alerts"."severity" = 'critical' and "alerts"."evaluation_id" is not null and "alerts"."rule_id" is not null and "alerts"."adverse_event_id" is null and "alerts"."contact_request_id" is null)
        or ("alerts"."source" = 'adverse_event' and "alerts"."severity" = 'warning' and "alerts"."adverse_event_id" is not null and "alerts"."evaluation_id" is null and "alerts"."rule_id" is null and "alerts"."contact_request_id" is null and "alerts"."escalate_at" is null and "alerts"."escalation_of" is null)
        or ("alerts"."source" = 'contact_request' and "alerts"."severity" = 'warning' and "alerts"."contact_request_id" is not null and "alerts"."evaluation_id" is null and "alerts"."rule_id" is null and "alerts"."adverse_event_id" is null));
--> statement-breakpoint
-- Contacts between visits (FR-12), least privilege for the runtime role (as in 0006).
-- Contacts are append-only. A contact request changes once: it is resolved by a contact.
REVOKE ALL ON contact_requests, contacts FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON contact_requests, contacts TO app;
--> statement-breakpoint
GRANT UPDATE (resolved_at, contact_id) ON contact_requests TO app;
--> statement-breakpoint
CREATE TRIGGER contacts_immutable BEFORE UPDATE OR DELETE ON contacts
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER contacts_no_truncate BEFORE TRUNCATE ON contacts
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE FUNCTION contact_requests_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contact requests cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.resolved_at IS NOT NULL OR NEW.resolved_at IS NULL
    OR NEW.id <> OLD.id OR NEW.patient_id <> OLD.patient_id
    OR NEW.submission_id <> OLD.submission_id OR NEW.reason <> OLD.reason
    OR NEW.preferred_time <> OLD.preferred_time OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'invalid contact request transition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Trigger functions are never called directly.
REVOKE EXECUTE ON FUNCTION contact_requests_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER contact_requests_transition BEFORE UPDATE ON contact_requests
FOR EACH ROW EXECUTE FUNCTION contact_requests_guard();
--> statement-breakpoint
CREATE TRIGGER contact_requests_no_delete BEFORE DELETE ON contact_requests
FOR EACH ROW EXECUTE FUNCTION contact_requests_guard();
--> statement-breakpoint
CREATE TRIGGER contact_requests_no_truncate BEFORE TRUNCATE ON contact_requests
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
-- alerts_guard from 0012 plus the new contact_request_id column.
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
    OR NEW.contact_request_id IS DISTINCT FROM OLD.contact_request_id
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
REVOKE EXECUTE ON FUNCTION alerts_guard() FROM PUBLIC;
