CREATE TABLE "security_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"event_count" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	CONSTRAINT "security_signals_kind" CHECK ("security_signals"."kind" in ('access_denied_spike', 'auth_failure_spike'))
);
--> statement-breakpoint
ALTER TABLE "security_signals" ADD CONSTRAINT "security_signals_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "security_signals_window_idx" ON "security_signals" USING btree ("kind","window_start");--> statement-breakpoint
CREATE INDEX "audit_events_action_time_idx" ON "audit_events" USING btree ("action","occurred_at");