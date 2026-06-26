-- 2026-06-18_sixsense_import_audit.sql
--
-- Import-audit columns on sixsense_snapshots, powering two guardrails on the
-- 6Sense Import tab: an import-history registry and a pre-confirm overwrite
-- warning. Snapshots upsert on (snapshot_date, segment), so picking the wrong
-- month silently overwrites a real month's data; these columns record what
-- file was imported and when so the mistake is visible.
--
--   file_name   - the original uploaded CSV file name (NULL on rows imported
--                 before this column existed).
--   imported_at - explicit import timestamp, set by the app on every upsert
--                 (insert AND re-import), unlike created_at which only reflects
--                 the first insert. Backfilled to created_at for existing rows.
--
-- RUN ORDER: standalone, no dependencies. Apply manually in the Supabase SQL
-- Editor (no migration runner is wired into the app). Idempotent.

ALTER TABLE sixsense_snapshots
  ADD COLUMN IF NOT EXISTS file_name TEXT;

ALTER TABLE sixsense_snapshots
  ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ;

-- Backfill: existing rows get their original insert time as imported_at.
UPDATE sixsense_snapshots
SET imported_at = created_at
WHERE imported_at IS NULL;
