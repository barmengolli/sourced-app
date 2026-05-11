-- Add stage_entered_at to attributions for velocity tracking. Backfill
-- existing rows with created_at::date as an approximation: the day the
-- attribution was inserted into Sourced, which is close to but not
-- identical to when the deal actually entered the stage in SFDC.
-- Users can correct individual records via AttributionEditorModal.

BEGIN;

ALTER TABLE attributions
  ADD COLUMN stage_entered_at DATE;

UPDATE attributions
  SET stage_entered_at = created_at::date
  WHERE stage_entered_at IS NULL;

ALTER TABLE attributions
  ALTER COLUMN stage_entered_at SET NOT NULL;

CREATE INDEX idx_attributions_stage_entered_at
  ON attributions (stage_entered_at);

COMMIT;
