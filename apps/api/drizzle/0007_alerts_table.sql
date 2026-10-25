CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"suggested_action" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"escalation_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"escalate_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	CONSTRAINT "alerts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "alerts_status_valid" CHECK ("alerts"."status" in ('pending', 'sent', 'delivered', 'acknowledged')),
	CONSTRAINT "alerts_severity_valid" CHECK ("alerts"."severity" = 'critical')
);
--> statement-breakpoint
ALTER TABLE "care_team" ADD COLUMN "assigned_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_recipient_id_practitioners_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."practitioners"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_evaluation_id_rule_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."rule_evaluations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_escalation_of_alerts_id_fk" FOREIGN KEY ("escalation_of") REFERENCES "public"."alerts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_recipient_idx" ON "alerts" USING btree ("recipient_id","status");--> statement-breakpoint
CREATE INDEX "alerts_escalation_idx" ON "alerts" USING btree ("escalate_at");