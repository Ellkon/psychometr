CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"response_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"scale_id" text NOT NULL,
	"score" integer NOT NULL,
	"max_score" integer NOT NULL,
	"band_label" text NOT NULL,
	"safety_signal" boolean DEFAULT false NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	CONSTRAINT "observations_response_id_unique" UNIQUE("response_id"),
	CONSTRAINT "observations_score_range" CHECK ("observations"."score" between 0 and "observations"."max_score")
);
--> statement-breakpoint
CREATE TABLE "questionnaire_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"scale_id" text NOT NULL,
	"scale_version" text NOT NULL,
	"answers" jsonb NOT NULL,
	"functional_answer" integer,
	"answered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "responses_functional_range" CHECK ("questionnaire_responses"."functional_answer" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "rule_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" text NOT NULL,
	"severity" text NOT NULL,
	"source_id" text NOT NULL,
	"source_location" text NOT NULL,
	"message" text NOT NULL,
	"suggested_action" text NOT NULL,
	"facts" jsonb NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rule_evaluations_severity" CHECK ("rule_evaluations"."severity" in ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "scale_schedules" (
	"patient_id" uuid NOT NULL,
	"scale_id" text NOT NULL,
	"interval_days" integer NOT NULL,
	"window_days" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "scale_schedules_patient_id_scale_id_pk" PRIMARY KEY("patient_id","scale_id"),
	CONSTRAINT "schedule_interval_range" CHECK ("scale_schedules"."interval_days" between 1 and 365),
	CONSTRAINT "schedule_window_range" CHECK ("scale_schedules"."window_days" between 1 and 90)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"status" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	CONSTRAINT "tasks_evaluation_id_unique" UNIQUE("evaluation_id"),
	CONSTRAINT "tasks_status" CHECK ("tasks"."status" in ('requested', 'accepted', 'rejected')),
	CONSTRAINT "tasks_decision_consistent" CHECK (("tasks"."status" = 'requested' and "tasks"."decided_at" is null) or ("tasks"."status" <> 'requested' and "tasks"."decided_at" is not null)),
	CONSTRAINT "tasks_comment_length" CHECK ("tasks"."comment" is null or length("tasks"."comment") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_response_id_questionnaire_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."questionnaire_responses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_responses" ADD CONSTRAINT "questionnaire_responses_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_evaluations" ADD CONSTRAINT "rule_evaluations_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scale_schedules" ADD CONSTRAINT "scale_schedules_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scale_schedules" ADD CONSTRAINT "scale_schedules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_evaluation_id_rule_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."rule_evaluations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observations_patient_scale_idx" ON "observations" USING btree ("patient_id","scale_id","effective_at");--> statement-breakpoint
CREATE INDEX "responses_patient_scale_idx" ON "questionnaire_responses" USING btree ("patient_id","scale_id","answered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "responses_patient_submission_idx" ON "questionnaire_responses" USING btree ("patient_id","submission_id");--> statement-breakpoint
CREATE INDEX "rule_evaluations_patient_idx" ON "rule_evaluations" USING btree ("patient_id","triggered_at");--> statement-breakpoint
CREATE INDEX "tasks_patient_status_idx" ON "tasks" USING btree ("patient_id","status");