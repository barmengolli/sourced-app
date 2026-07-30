-- 2026-07-30_touch_seed_descendant_cleanup.sql
--
-- Bite 4D.1 one-time cleanup (docs/lead-multi-attribution-program.md).
-- The Bite 4D full report import superseded backfill seeds only on an
-- EXACT (lead, channel) match, so a precise child-level import touch never
-- superseded its coarse parent-level seed (confirmed pairs include
-- '2026 - Events' -> '2026 - Transformation Summit',
-- '2026 - Marketing SDR' -> '2026 - Vitech Campaign'). Left in place,
-- Bite 4E would double-count those leads inside one channel family. The
-- importer rule is generalized in code in this same bite; this migration
-- repairs the rows the 4D import already wrote.
--
-- Order matters: the locked-date repair runs BEFORE the seed delete so
-- Marketing's manual Q1 date corrections move onto the surviving import
-- touch before the seed carrying them disappears.
--
-- Seeds whose lead is absent from the report (legitimate historical
-- memberships, ~507 rows) are intentionally NOT touched.
--
-- EXPECTED PRE-FLIGHT VALUES (production diagnostics, 2026-07-30):
--   surviving_seeds          = 751
--   descendant_superseded    = 244
-- Compare the live pre-flight output against these BEFORE COMMIT; if they
-- differ materially, ROLLBACK and investigate.
--
-- ROLLBACK: run ROLLBACK; instead of COMMIT;. After COMMIT the deleted
-- seeds are recoverable only from the 4C seed rule (one per lead from
-- leads.source_channel_id/marketing_sourced_date), which remains guarded
-- and re-runnable from the 4C migration if ever needed.
--
-- RUN ORDER: requires 2026-07-29_lead_campaign_touches.sql (applied) and
-- the Bite 4D full report import (done 2026-07-30). Apply manually in the
-- Supabase SQL Editor. Idempotent: a re-run finds zero rows to repair or
-- delete.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Pre-flight counts (expected: 751 / 244)
-- ---------------------------------------------------------------------------

WITH RECURSIVE channel_family AS (
  -- (ancestor, descendant) closure over the channels tree, self included.
  -- UNION (not UNION ALL) so corrupt cyclic parentage cannot loop forever.
  SELECT id AS ancestor_id, id AS descendant_id FROM channels
  UNION
  SELECT f.ancestor_id, c.id
  FROM channel_family f
  JOIN channels c ON c.parent_channel_id = f.descendant_id
)
SELECT
  (SELECT COUNT(*) FROM lead_campaign_touches WHERE source = 'backfill') AS surviving_seeds,
  (
    SELECT COUNT(*)
    FROM lead_campaign_touches s
    WHERE s.source = 'backfill'
      AND s.channel_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM lead_campaign_touches t
        JOIN channel_family f
          ON f.ancestor_id = s.channel_id AND f.descendant_id = t.channel_id
        WHERE t.lead_id = s.lead_id
          AND t.source <> 'backfill'
          AND (t.campaign_member_id IS NOT NULL OR t.campaign_id IS NOT NULL)
      )
  ) AS descendant_superseded;

-- ---------------------------------------------------------------------------
-- 2. Locked-date repair FIRST: move Marketing's corrected date onto the
--    import touch that is about to supersede the seed carrying it. Only
--    for locked leads, only where the dates actually differ, and the
--    report's date is preserved in raw.sfdc_touch_date.
-- ---------------------------------------------------------------------------

WITH RECURSIVE channel_family AS (
  SELECT id AS ancestor_id, id AS descendant_id FROM channels
  UNION
  SELECT f.ancestor_id, c.id
  FROM channel_family f
  JOIN channels c ON c.parent_channel_id = f.descendant_id
)
UPDATE lead_campaign_touches t
SET touch_date = l.marketing_sourced_date,
    raw = t.raw || jsonb_build_object('sfdc_touch_date', t.touch_date)
FROM leads l,
     lead_campaign_touches s,
     channel_family f
WHERE l.id = t.lead_id
  AND l.field_locks->>'marketing_sourced_date' = 'true'
  AND l.marketing_sourced_date IS NOT NULL
  -- t is an identity-carrying import touch...
  AND t.source <> 'backfill'
  AND (t.campaign_member_id IS NOT NULL OR t.campaign_id IS NOT NULL)
  -- ...that supersedes this lead's seed via the descendant walk...
  AND s.source = 'backfill'
  AND s.lead_id = l.id
  AND s.channel_id IS NOT NULL
  AND f.ancestor_id = s.channel_id
  AND f.descendant_id = t.channel_id
  -- ...and the correction is actually different from the report date.
  AND t.touch_date IS DISTINCT FROM l.marketing_sourced_date;

-- ---------------------------------------------------------------------------
-- 3. Delete the descendant-superseded seeds.
-- ---------------------------------------------------------------------------

WITH RECURSIVE channel_family AS (
  SELECT id AS ancestor_id, id AS descendant_id FROM channels
  UNION
  SELECT f.ancestor_id, c.id
  FROM channel_family f
  JOIN channels c ON c.parent_channel_id = f.descendant_id
)
DELETE FROM lead_campaign_touches s
WHERE s.source = 'backfill'
  AND s.channel_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM lead_campaign_touches t
    JOIN channel_family f
      ON f.ancestor_id = s.channel_id AND f.descendant_id = t.channel_id
    WHERE t.lead_id = s.lead_id
      AND t.source <> 'backfill'
      AND (t.campaign_member_id IS NOT NULL OR t.campaign_id IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 4. Verification (expected: ~507 / 0 / 0). Compare BEFORE COMMIT.
-- ---------------------------------------------------------------------------

WITH RECURSIVE channel_family AS (
  SELECT id AS ancestor_id, id AS descendant_id FROM channels
  UNION
  SELECT f.ancestor_id, c.id
  FROM channel_family f
  JOIN channels c ON c.parent_channel_id = f.descendant_id
)
SELECT
  (SELECT COUNT(*) FROM lead_campaign_touches WHERE source = 'backfill') AS surviving_seeds,
  (
    SELECT COUNT(*)
    FROM lead_campaign_touches s
    WHERE s.source = 'backfill'
      AND s.channel_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM lead_campaign_touches t
        JOIN channel_family f
          ON f.ancestor_id = s.channel_id AND f.descendant_id = t.channel_id
        WHERE t.lead_id = s.lead_id
          AND t.source <> 'backfill'
          AND (t.campaign_member_id IS NOT NULL OR t.campaign_id IS NOT NULL)
      )
  ) AS seeds_with_same_family_touch_remaining,
  (
    -- No lead that had a touch loses all of them: by construction deletion
    -- required a surviving import touch, so this must be 0.
    SELECT COUNT(*)
    FROM leads l
    WHERE l.source_channel_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM lead_campaign_touches t WHERE t.lead_id = l.id
      )
  ) AS leads_with_zero_touches;

COMMIT;
