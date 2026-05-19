-- Seed 2025 channels and historical lead/MQL actuals + projections.
--
-- Context: Sourced was bootstrapped with 2026 channels only. We never
-- imported 2025 SFDC campaign-member data because the project did not
-- exist yet. This migration seeds the 2025 channels (year-tagged via
-- the year-aware-channels feature) and the quarterly Lead and MQL
-- counts as funnel_actuals rows, so the Marketing Funnel grid shows a
-- 2025 view for historical comparison and so 2025-originated deals
-- (e.g. Assurant NZ) can attribute their first touch to the correct
-- 2025 channel.
--
-- Source data: /Marketing Ops Cowork/2025 Funnel - Sheet1.csv
-- (Lead and MQL columns only; HPPs, Opps, Pursuits intentionally omitted.)
--
-- Channel set: 5 top-level channels, no sub-channels (sub-channels did
-- not exist in 2025). 2025 - Sales Generated has no Lead/MQL data; it
-- is created for completeness so 2025 sales-sourced deals have a
-- destination.
--
-- Projections were captured annually in the source spreadsheet; we
-- split them evenly across the four quarters here. Q4 absorbs any
-- rounding so each channel's annual total matches the source.
--
-- Prerequisites:
-- 1. 2026-05-19_channels_year.sql applied (year column on channels).
-- 2. 2026-05-19_funnel_actuals_lead_mql.sql applied (relaxes stage_key
--    CHECK so 'lead' and 'mql' inserts are accepted).

BEGIN;

-- =============================================================
-- 1. Channels (top-level, year-tagged 2025).
-- =============================================================
INSERT INTO channels (name, parent_channel_id, year, display_order, hidden)
VALUES
  ('2025 - Content Syndication', NULL, 2025, 0, false),
  ('2025 - Website',             NULL, 2025, 0, false),
  ('2025 - Events',              NULL, 2025, 0, false),
  ('2025 - Marketing SDR',       NULL, 2025, 0, false),
  ('2025 - Sales Generated',     NULL, 2025, 0, false)
ON CONFLICT (name, parent_channel_id) DO UPDATE
  SET year = EXCLUDED.year;

-- =============================================================
-- 2. Lead and MQL actuals per (channel, quarter).
--    32 rows: 4 channels × 4 quarters × 2 stages.
--    Sales Generated has no Lead/MQL rows.
-- =============================================================
INSERT INTO funnel_actuals (channel_id, year, period_index, stage_key, actual, edited_by)
VALUES
  -- 2025 - Content Syndication (annual: 664 leads, 510 MQLs)
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 1, 'lead',   0, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 2, 'lead', 245, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 3, 'lead', 287, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 4, 'lead', 132, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 1, 'mql',    0, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 2, 'mql',  201, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 3, 'mql',  217, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 4, 'mql',   92, 'historical-seed'),
  -- 2025 - Website (annual: 259 leads, 61 MQLs)
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 1, 'lead', 79, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 2, 'lead', 66, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 3, 'lead', 80, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 4, 'lead', 34, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 1, 'mql',  21, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 2, 'mql',   8, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 3, 'mql',  23, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 4, 'mql',   9, 'historical-seed'),
  -- 2025 - Events (annual: 1061 leads, 475 MQLs)
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 1, 'lead', 158, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 2, 'lead', 400, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 3, 'lead', 236, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 4, 'lead', 267, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 1, 'mql',   16, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 2, 'mql',  181, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 3, 'mql',   37, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 4, 'mql',  241, 'historical-seed'),
  -- 2025 - Marketing SDR (annual: 508 leads, 22 MQLs)
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 1, 'lead', 203, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 2, 'lead',  70, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 3, 'lead', 176, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 4, 'lead',  59, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 1, 'mql',   13, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 2, 'mql',    1, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 3, 'mql',    2, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 4, 'mql',    6, 'historical-seed')
ON CONFLICT (channel_id, year, period_index, stage_key) DO UPDATE
  SET actual    = EXCLUDED.actual,
      edited_at = NOW(),
      edited_by = EXCLUDED.edited_by;

-- =============================================================
-- 3. Annual projections, split evenly across quarters.
--    Q4 absorbs the rounding remainder so each channel's annual
--    total matches the source spreadsheet exactly.
--
--    Source totals:
--      Content Syndication: 540 leads / 162 MQLs
--      Website:             300 leads / 120 MQLs
--      Events:             1170 leads / 351 MQLs
--      Marketing SDR:      1040 leads / 104 MQLs
--      Sales Generated:     N/A (no projection)
-- =============================================================
INSERT INTO funnel_projections (channel_id, year, period_index, stage_key, projection, edited_by)
VALUES
  -- Content Syndication: 540/4 = 135 (clean), 162/4 = 40.5 -> 41/41/40/40
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 1, 'lead', 135, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 2, 'lead', 135, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 3, 'lead', 135, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 4, 'lead', 135, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 1, 'mql',   41, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 2, 'mql',   41, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 3, 'mql',   40, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Content Syndication' AND parent_channel_id IS NULL), 2025, 4, 'mql',   40, 'historical-seed'),
  -- Website: 300/4 = 75 (clean), 120/4 = 30 (clean)
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 1, 'lead', 75, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 2, 'lead', 75, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 3, 'lead', 75, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 4, 'lead', 75, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 1, 'mql',  30, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 2, 'mql',  30, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 3, 'mql',  30, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Website' AND parent_channel_id IS NULL), 2025, 4, 'mql',  30, 'historical-seed'),
  -- Events: 1170/4 = 292.5 -> 293/293/292/292, 351/4 = 87.75 -> 88/88/88/87
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 1, 'lead', 293, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 2, 'lead', 293, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 3, 'lead', 292, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 4, 'lead', 292, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 1, 'mql',   88, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 2, 'mql',   88, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 3, 'mql',   88, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Events' AND parent_channel_id IS NULL), 2025, 4, 'mql',   87, 'historical-seed'),
  -- Marketing SDR: 1040/4 = 260 (clean), 104/4 = 26 (clean)
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 1, 'lead', 260, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 2, 'lead', 260, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 3, 'lead', 260, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 4, 'lead', 260, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 1, 'mql',   26, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 2, 'mql',   26, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 3, 'mql',   26, 'historical-seed'),
  ((SELECT id FROM channels WHERE name='2025 - Marketing SDR' AND parent_channel_id IS NULL), 2025, 4, 'mql',   26, 'historical-seed')
ON CONFLICT (channel_id, year, period_index, stage_key) DO UPDATE
  SET projection = EXCLUDED.projection,
      edited_at  = NOW(),
      edited_by  = EXCLUDED.edited_by;

COMMIT;

-- =============================================================
-- Verification queries (run after COMMIT):
-- =============================================================
-- 1. Channels created:
--   SELECT name, year FROM channels WHERE year = 2025 ORDER BY name;
--
-- 2. Actuals seeded (expect 32 rows, totals tie out):
--   SELECT c.name, fa.stage_key, SUM(fa.actual) AS total
--   FROM funnel_actuals fa
--   JOIN channels c ON c.id = fa.channel_id
--   WHERE fa.year = 2025
--   GROUP BY c.name, fa.stage_key
--   ORDER BY c.name, fa.stage_key;
--
-- 3. Projections seeded (expect 32 rows, annual totals match source):
--   SELECT c.name, fp.stage_key, SUM(fp.projection) AS total
--   FROM funnel_projections fp
--   JOIN channels c ON c.id = fp.channel_id
--   WHERE fp.year = 2025
--   GROUP BY c.name, fp.stage_key
--   ORDER BY c.name, fp.stage_key;
