-- A revoked session stays revoked (security review D1): role app may set revoked_at, never
-- clear it, so a compromised API cannot bring a revoked session back.
CREATE FUNCTION sessions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'a revoked session cannot be restored' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Trigger functions are never called directly.
REVOKE EXECUTE ON FUNCTION sessions_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER sessions_revocation BEFORE UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION sessions_guard();
