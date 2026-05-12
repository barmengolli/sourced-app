-- Backfill: append a stage_history MQL entry to any lead whose
-- current_stage is 'mql' but whose stage_history has no 'mql' entry.
--
-- This fixes the legacy under-counting caused by the importer's
-- previous behavior of updating current_stage without seeding
-- stage_history on re-import. After this backfill, the funnel
-- grid's MQL count will catch up to SFDC's reported MQL count
-- for affected leads.
--
-- entered_at is set to CURRENT_DATE as a best-effort default,
-- since the actual MQL transition date isn't recoverable from
-- existing data. Users can manually correct individual leads via
-- the Leads page UI if a more accurate date is known.
--
-- BEFORE applying, preview the affected count:
--
--   SELECT COUNT(*) AS will_backfill
--   FROM leads
--   WHERE current_stage = 'mql'
--     AND NOT EXISTS (
--       SELECT 1 FROM jsonb_array_elements(stage_history) entry
--       WHERE entry->>'stage' = 'mql'
--     );

BEGIN;

UPDATE leads
SET stage_history = stage_history || jsonb_build_array(
  jsonb_build_object(
    'stage', 'mql',
    'entered_at', CURRENT_DATE::text,
    'edited_by', 'manual-backfill-2026-05-12',
    'edit_locked', false
  )
),
last_edited_by = 'manual-backfill-2026-05-12',
updated_at = now()
WHERE current_stage = 'mql'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(stage_history) entry
    WHERE entry->>'stage' = 'mql'
  );

-- Verify zero remaining mismatches after the backfill.
SELECT COUNT(*) AS remaining_after_backfill
FROM leads
WHERE current_stage = 'mql'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(stage_history) entry
    WHERE entry->>'stage' = 'mql'
  );

COMMIT;
