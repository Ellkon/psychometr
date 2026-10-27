CREATE TABLE "diagnoses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"code" text,
	"text" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	CONSTRAINT "diagnoses_code_format" CHECK ("diagnoses"."code" ~ '^[A-Z][0-9]{2}(\.[0-9]{1,2})?$'),
	CONSTRAINT "diagnoses_text_length" CHECK (length("diagnoses"."text") between 1 and 300),
	CONSTRAINT "diagnoses_removal" CHECK (("diagnoses"."removed_at" is null) = ("diagnoses"."removed_by" is null))
);
--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_practitioner_id_practitioners_user_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."practitioners"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_removed_by_practitioners_user_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."practitioners"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "diagnoses_submission_idx" ON "diagnoses" USING btree ("practitioner_id","submission_id");--> statement-breakpoint
CREATE INDEX "diagnoses_patient_idx" ON "diagnoses" USING btree ("patient_id","created_at");--> statement-breakpoint
-- Diagnoses (FR-7.4), least privilege for the runtime role (as in 0013).
-- A diagnosis is never edited or deleted; it changes once: the doctor removes it.
REVOKE ALL ON diagnoses FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON diagnoses TO app;
--> statement-breakpoint
GRANT UPDATE (removed_at, removed_by) ON diagnoses TO app;
--> statement-breakpoint
CREATE FUNCTION diagnoses_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'diagnoses cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
    OR NEW.id <> OLD.id OR NEW.patient_id <> OLD.patient_id
    OR NEW.practitioner_id <> OLD.practitioner_id OR NEW.submission_id <> OLD.submission_id
    OR NEW.code IS DISTINCT FROM OLD.code OR NEW.text <> OLD.text
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'invalid diagnosis transition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Trigger functions are never called directly.
REVOKE EXECUTE ON FUNCTION diagnoses_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER diagnoses_transition BEFORE UPDATE ON diagnoses
FOR EACH ROW EXECUTE FUNCTION diagnoses_guard();
--> statement-breakpoint
CREATE TRIGGER diagnoses_no_delete BEFORE DELETE ON diagnoses
FOR EACH ROW EXECUTE FUNCTION diagnoses_guard();
--> statement-breakpoint
CREATE TRIGGER diagnoses_no_truncate BEFORE TRUNCATE ON diagnoses
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
