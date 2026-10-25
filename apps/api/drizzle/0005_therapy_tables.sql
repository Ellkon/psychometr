CREATE TABLE "adverse_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"medication_request_id" uuid,
	"description" text NOT NULL,
	"severity" text NOT NULL,
	"started_on" date NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "adverse_events_severity" CHECK ("adverse_events"."severity" in ('mild', 'moderate', 'severe')),
	CONSTRAINT "adverse_events_description_length" CHECK (length("adverse_events"."description") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "dose_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"medication_request_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dose_log_status" CHECK ("dose_log"."status" in ('taken', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "medication_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"grls_reg_number" text,
	"drug_text" text NOT NULL,
	"dose_text" text NOT NULL,
	"dose_times" jsonb NOT NULL,
	"time_zone" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"stopped_at" timestamp with time zone,
	"stopped_by" uuid,
	CONSTRAINT "medication_requests_status" CHECK ("medication_requests"."status" in ('active', 'stopped')),
	CONSTRAINT "medication_requests_stop_consistent" CHECK (("medication_requests"."status" = 'active' and "medication_requests"."stopped_at" is null) or ("medication_requests"."status" = 'stopped' and "medication_requests"."stopped_at" is not null)),
	CONSTRAINT "medication_requests_period" CHECK ("medication_requests"."ends_on" is null or "medication_requests"."ends_on" >= "medication_requests"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "adverse_events" ADD CONSTRAINT "adverse_events_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adverse_events" ADD CONSTRAINT "adverse_events_medication_request_id_medication_requests_id_fk" FOREIGN KEY ("medication_request_id") REFERENCES "public"."medication_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dose_log" ADD CONSTRAINT "dose_log_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dose_log" ADD CONSTRAINT "dose_log_medication_request_id_medication_requests_id_fk" FOREIGN KEY ("medication_request_id") REFERENCES "public"."medication_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_requests" ADD CONSTRAINT "medication_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_requests" ADD CONSTRAINT "medication_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_requests" ADD CONSTRAINT "medication_requests_stopped_by_users_id_fk" FOREIGN KEY ("stopped_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adverse_events_submission_idx" ON "adverse_events" USING btree ("patient_id","submission_id");--> statement-breakpoint
CREATE INDEX "adverse_events_patient_idx" ON "adverse_events" USING btree ("patient_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dose_log_slot_idx" ON "dose_log" USING btree ("medication_request_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "dose_log_patient_idx" ON "dose_log" USING btree ("patient_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "medication_requests_patient_idx" ON "medication_requests" USING btree ("patient_id","status");--> statement-breakpoint
CREATE INDEX "audit_events_resource_actor_idx" ON "audit_events" USING btree ("resource_id","actor_id");