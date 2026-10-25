-- Clinical tables (stages 3–4), least privilege for the runtime role (as in 0002).
-- Answers, scores and rule journal are append-only; schedules and tasks may change
-- only the columns the code updates; tasks may change state only once (tasks_guard).
REVOKE ALL ON scale_schedules, questionnaire_responses, observations, rule_evaluations, tasks
  FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON scale_schedules, questionnaire_responses, observations, rule_evaluations, tasks
  TO app;
--> statement-breakpoint
GRANT UPDATE (interval_days, window_days, active, updated_at, updated_by) ON scale_schedules TO app;
--> statement-breakpoint
GRANT UPDATE (status, comment, decided_at, decided_by) ON tasks TO app;
--> statement-breakpoint
CREATE TRIGGER questionnaire_responses_immutable BEFORE UPDATE OR DELETE ON questionnaire_responses
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER questionnaire_responses_no_truncate BEFORE TRUNCATE ON questionnaire_responses
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER observations_immutable BEFORE UPDATE OR DELETE ON observations
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER observations_no_truncate BEFORE TRUNCATE ON observations
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER rule_evaluations_immutable BEFORE UPDATE OR DELETE ON rule_evaluations
FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE TRIGGER rule_evaluations_no_truncate BEFORE TRUNCATE ON rule_evaluations
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
--> statement-breakpoint
CREATE FUNCTION tasks_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tasks cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'requested' THEN
    RAISE EXCEPTION 'task is already decided' USING ERRCODE = '42501';
  END IF;
  IF NEW.patient_id <> OLD.patient_id OR NEW.evaluation_id <> OLD.evaluation_id THEN
    RAISE EXCEPTION 'task identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'invalid task transition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Trigger functions are never called directly.
REVOKE EXECUTE ON FUNCTION tasks_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER tasks_transition BEFORE UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION tasks_guard();
--> statement-breakpoint
CREATE TRIGGER tasks_no_delete BEFORE DELETE ON tasks
FOR EACH ROW EXECUTE FUNCTION tasks_guard();
--> statement-breakpoint
CREATE TRIGGER tasks_no_truncate BEFORE TRUNCATE ON tasks
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
