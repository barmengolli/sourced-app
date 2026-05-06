-- Add Closed Lost as a 7th terminal stage that runs in parallel to Closed
-- Won. Updates the stage_key CHECK constraints on the three tables that
-- pin the allowed values, leaving the schema otherwise untouched. Existing
-- rows are unaffected; the new constraint is a strict superset of the old
-- one. Application-level guards in useAttributions.markLost prevent
-- close-lost from a terminal source row.

BEGIN;

ALTER TABLE attributions
  DROP CONSTRAINT IF EXISTS attributions_stage_key_check;
ALTER TABLE attributions
  ADD CONSTRAINT attributions_stage_key_check
  CHECK (stage_key IN ('hpp','opp','pursuit','closeWon','closeLost'));

ALTER TABLE funnel_projections
  DROP CONSTRAINT IF EXISTS funnel_projections_stage_key_check;
ALTER TABLE funnel_projections
  ADD CONSTRAINT funnel_projections_stage_key_check
  CHECK (stage_key IN ('lead','mql','hpp','opp','pursuit','closeWon','closeLost'));

ALTER TABLE funnel_actuals
  DROP CONSTRAINT IF EXISTS funnel_actuals_stage_key_check;
ALTER TABLE funnel_actuals
  ADD CONSTRAINT funnel_actuals_stage_key_check
  CHECK (stage_key IN ('hpp','opp','pursuit','closeWon','closeLost'));

COMMIT;
