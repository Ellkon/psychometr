CREATE TYPE "public"."invite_status" AS ENUM('pending', 'used', 'expired', 'blocked', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('doctor', 'patient', 'admin');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"sequence" bigint PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_id" uuid,
	"resource_id" uuid,
	"action" text NOT NULL,
	"previous_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "care_team" (
	"patient_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	CONSTRAINT "care_team_patient_id_practitioner_id_pk" PRIMARY KEY("patient_id","practitioner_id")
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"version" text NOT NULL,
	"text_hash" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"ip_ciphertext" "bytea" NOT NULL,
	"ip_nonce" "bytea" NOT NULL,
	"ip_auth_tag" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "patient_devices_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
CREATE TABLE "patient_identity" (
	"patient_id" uuid PRIMARY KEY NOT NULL,
	"key_version" integer NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	CONSTRAINT "identity_nonce_length" CHECK (octet_length("patient_identity"."nonce") = 12),
	CONSTRAINT "identity_tag_length" CHECK (octet_length("patient_identity"."auth_tag") = 16)
);
--> statement-breakpoint
CREATE TABLE "patient_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"code_hash" text NOT NULL,
	"status" "invite_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invite_attempts_range" CHECK ("patient_invites"."attempts" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patients_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "practitioners" (
	"user_id" uuid PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "user_role" NOT NULL,
	"email" text,
	"credential_hash" text,
	"active" boolean DEFAULT true NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_failed_attempts_nonnegative" CHECK ("users"."failed_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "care_team" ADD CONSTRAINT "care_team_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_team" ADD CONSTRAINT "care_team_practitioner_id_practitioners_user_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."practitioners"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_devices" ADD CONSTRAINT "patient_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_identity" ADD CONSTRAINT "patient_identity_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_invites" ADD CONSTRAINT "patient_invites_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_invites" ADD CONSTRAINT "patient_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_invites" ADD CONSTRAINT "patient_invites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioners" ADD CONSTRAINT "practitioners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_patient_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."patient_devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "care_team_practitioner_idx" ON "care_team" USING btree ("practitioner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consents_patient_version_idx" ON "consents" USING btree ("patient_id","version");--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "patient_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invites_patient_idx" ON "patient_invites" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_pending_invite_per_patient" ON "patient_invites" USING btree ("patient_id") WHERE "patient_invites"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "refresh_tokens_session_idx" ON "refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_device_idx" ON "sessions" USING btree ("device_id");