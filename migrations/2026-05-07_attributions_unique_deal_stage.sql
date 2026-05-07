-- F-006: Add partial UNIQUE constraint on attributions (deal_id, stage_key)
-- to prevent duplicate downstream rows from any write path.
--
-- BEFORE applying this migration, run this dedup query in Supabase
-- SQL Editor:
--
--   SELECT deal_id, stage_key, COUNT(*) AS dup_count, array_agg(id) AS attribution_ids
--   FROM attributions
--   WHERE deal_id IS NOT NULL AND deal_id <> ''
--   GROUP BY deal_id, stage_key
--   HAVING COUNT(*) > 1
--   ORDER BY dup_count DESC;
--
-- For each row returned, resolve manually via Sourced's Opportunities
-- List Modal Delete button. Then re-run the query until it returns
-- zero rows. ONLY THEN apply this migration.
--
-- Defense-in-depth alongside the UI guard in OpportunitiesListModal
-- (commit 9ae6883). UI prevents accidental clicks; this constraint
-- prevents server-side or bulk-write duplicates.

BEGIN;

CREATE UNIQUE INDEX attributions_deal_stage_uniq
  ON attributions (deal_id, stage_key)
  WHERE deal_id IS NOT NULL AND deal_id <> '';

COMMIT;
