-- Relax funnel_actuals.stage_key CHECK so 'lead' and 'mql' can be stored.
-- Required for historical-year backfills where lead-level data is not
-- available (e.g. 2025 pre-Sourced). For years where real leads do exist
-- in the leads table, lead and MQL counts continue to come from
-- leads.marketing_sourced_date and leads.stage_history; funnel_actuals
-- rows for these stages are only meaningful when no underlying lead data
-- is present for the (channel, year, quarter) cell.
--
-- The new constraint is a strict superset of the old one. Existing rows
-- are unaffected (none have stage_key='lead' or 'mql' today, by virtue
-- of the prior constraint).
--
-- Pair with the seed migration 2026-05-19_seed_2025_channels_and_actuals.sql
-- which inserts the 2025 channel rows and the 32 lead/MQL actuals.

BEGIN;

ALTER TABLE funnel_actuals
  DROP CONSTRAINT IF EXISTS funnel_actuals_stage_key_check;

ALTER TABLE funnel_actuals
  ADD CONSTRAINT funnel_actuals_stage_key_check
  CHECK (stage_key IN ('lead','mql','hpp','opp','pursuit','closeWon','closeLost'));

COMMIT;

NOTIFY pgrst, 'reload schema';
