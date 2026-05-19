-- channels.year: makes channels year-aware so attribution modals can
-- filter their dropdown to channels that match the stage's entered-on
-- date (plus evergreen channels with year IS NULL).
--
-- Backfill reads the existing "YYYY -" name prefix that the SFDC
-- import seeded ("2026 - Events", "2026 - Content Syndication", …).
-- Channels without a year prefix stay NULL and are treated as
-- evergreen by the application.
--
-- After this migration, the `year` column is the source of truth for
-- year-filtering. Names keep their prefix purely for human
-- readability.

BEGIN;

ALTER TABLE channels ADD COLUMN year INTEGER;

UPDATE channels
SET year = CAST(SUBSTRING(name FROM '^([0-9]{4}) -') AS INTEGER)
WHERE name ~ '^[0-9]{4} -';

CREATE INDEX IF NOT EXISTS idx_channels_year ON channels (year);

COMMIT;

NOTIFY pgrst, 'reload schema';
