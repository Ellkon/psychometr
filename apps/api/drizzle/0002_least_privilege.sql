-- Least privilege for the runtime role: app may only delete care-team links and
-- may update only the columns the code actually changes. A compromised API can
-- then neither wipe patient data nor rewrite roles, owners or credential links.
REVOKE DELETE ON
  users, practitioners, patients, patient_identity,
  patient_invites, patient_devices, sessions, refresh_tokens FROM app;
--> statement-breakpoint
-- care_team keeps UPDATE: assertCanAccessPatient locks memberships FOR SHARE,
-- and app already inserts and deletes links, so UPDATE grants nothing extra.
REVOKE UPDATE ON
  users, practitioners, patients, patient_identity,
  patient_invites, patient_devices, sessions, refresh_tokens FROM app;
--> statement-breakpoint
-- SELECT ... FOR UPDATE needs UPDATE on at least one column; these grants cover
-- every row lock taken by the API as well.
GRANT UPDATE (credential_hash, failed_attempts, locked_until) ON users TO app;
--> statement-breakpoint
GRANT UPDATE (key_version, ciphertext, nonce, auth_tag) ON patient_identity TO app;
--> statement-breakpoint
GRANT UPDATE (status, attempts, used_at) ON patient_invites TO app;
--> statement-breakpoint
GRANT UPDATE (secret_hash, expires_at, revoked_at) ON patient_devices TO app;
--> statement-breakpoint
GRANT UPDATE (idle_expires_at, revoked_at) ON sessions TO app;
--> statement-breakpoint
GRANT UPDATE (used_at) ON refresh_tokens TO app;
--> statement-breakpoint
-- Trigger functions are never called directly.
REVOKE EXECUTE ON FUNCTION reject_append_only_change() FROM PUBLIC;
