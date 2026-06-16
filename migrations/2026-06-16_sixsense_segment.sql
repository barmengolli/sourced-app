-- 2026-06-16_sixsense_segment.sql
--
-- Adds a `segment` dimension to sixsense_snapshots so the 6Sense
-- "Activities By Source" summary can be tracked per campaign in addition to
-- the overall report. The overall report is segment = 'Target Accounts in
-- CRM'; each campaign (e.g. "Life & Annuities") is its own segment value,
-- chosen from a dropdown on import.
--
-- The natural key changes from (snapshot_date) to (snapshot_date, segment) so
-- the same week can hold one row per segment. Existing rows are the overall
-- report, so they backfill to 'Target Accounts in CRM'.
--
-- RUN ORDER: standalone, after the original sixsense_snapshots migration.
-- Apply manually in the Supabase SQL Editor. Idempotent.

BEGIN;

-- 1. Add the column (nullable first so the backfill can run).
ALTER TABLE sixsense_snapshots
  ADD COLUMN IF NOT EXISTS segment TEXT;

-- 2. Backfill existing rows: they are the overall report.
UPDATE sixsense_snapshots
SET segment = 'Target Accounts in CRM'
WHERE segment IS NULL;

-- 3. Default + NOT NULL now that every row has a value.
ALTER TABLE sixsense_snapshots
  ALTER COLUMN segment SET DEFAULT 'Target Accounts in CRM';
ALTER TABLE sixsense_snapshots
  ALTER COLUMN segment SET NOT NULL;

-- 4. Swap the unique key: drop any single-column UNIQUE on snapshot_date,
--    add the compound (snapshot_date, segment). Find the constraint by its
--    columns rather than a hardcoded name so this is robust.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  WHERE c.conrelid = 'sixsense_snapshots'::regclass
    AND c.contype = 'u'
    AND c.conkey = ARRAY[
      (SELECT attnum FROM pg_attribute
       WHERE attrelid = 'sixsense_snapshots'::regclass AND attname = 'snapshot_date')
    ]
  LIMIT 1;
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE sixsense_snapshots DROP CONSTRAINT %I', con_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'sixsense_snapshots'::regclass
      AND contype = 'u'
      AND conname = 'sixsense_snapshots_snapshot_date_segment_key'
  ) THEN
    ALTER TABLE sixsense_snapshots
      ADD CONSTRAINT sixsense_snapshots_snapshot_date_segment_key
      UNIQUE (snapshot_date, segment);
  END IF;
END $$;

-- 5. Index for the per-segment dashboard reads.
CREATE INDEX IF NOT EXISTS idx_sixsense_segment_date
  ON sixsense_snapshots(segment, snapshot_date DESC);

COMMIT;
