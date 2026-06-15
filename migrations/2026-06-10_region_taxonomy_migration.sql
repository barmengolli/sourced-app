-- 2026-06-10_region_taxonomy_migration.sql
--
-- EIS region taxonomy migration. Replaces the legacy NA/EMEA/APAC/LATAM
-- regions with the EIS definitions (mirroring the SFDC Region picklist
-- verbatim):
--
--   'NA'                  US, Canada, Mexico
--   'EMEA cont & LATAM'   Continental Europe, Africa, Latin America
--   'UK&IRE, ME, Japan'   UK, Ireland, Middle East, Japan + all APAC
--   'Other'               unmapped / null countries
--
-- Keep the CASE expression below in sync with COUNTRY_TO_REGION in
-- src/constants/regions.ts.
--
-- RUN ORDER: deploy the code change (prompts/2026-06-10_eis-region-taxonomy.md)
-- first, then run this. Between deploy and this migration, old stored
-- values render as 'Other' in the UI (regionFilter coerces unknowns).
--
-- NOTE on field_locks: leads with a locked region field are updated
-- anyway. The lock protected a manual correction under the OLD
-- taxonomy; old keys are obsolete, so re-deriving from country is
-- correct for every row. Locks themselves are left untouched.
--
-- Outreach tabs are NOT affected (outreach_snapshots regions derive
-- from sequence names and intentionally keep the legacy scheme).

-- ============================================================
-- PRE-FLIGHT: current distribution. Save the output for comparison.
-- ============================================================

SELECT 'leads' AS tbl, region, COUNT(*) AS n
FROM leads GROUP BY region
UNION ALL
SELECT 'attributions', region, COUNT(*)
FROM attributions GROUP BY region
ORDER BY tbl, region;

-- Countries that will land in 'Other' (review before running; if any
-- real country shows up here, add it to the CASE below AND to
-- COUNTRY_TO_REGION in regions.ts before proceeding):

SELECT TRIM(country) AS country, COUNT(*) AS n
FROM leads
WHERE TRIM(COALESCE(country, '')) NOT IN (
  'United States','Canada','Mexico','Bermuda',
  'France','Germany','Switzerland','Belgium','Netherlands','Italy',
  'Spain','Finland','Sweden','Norway','Denmark','Portugal','Poland',
  'South Africa','Brazil','Argentina','Chile','Colombia',
  'United Kingdom','Ireland','United Arab Emirates','Saudi Arabia',
  'Japan','India','China','Australia','New Zealand','Singapore',
  'Malaysia','Fiji'
)
GROUP BY TRIM(country)
ORDER BY n DESC;

-- ============================================================
-- STEP 1: leads — re-derive region from country
-- ============================================================

BEGIN;

UPDATE leads
SET region = CASE
  WHEN TRIM(COALESCE(country, '')) IN
    ('United States','Canada','Mexico','Bermuda')
    THEN 'NA'
  WHEN TRIM(COALESCE(country, '')) IN
    ('France','Germany','Switzerland','Belgium','Netherlands','Italy',
     'Spain','Finland','Sweden','Norway','Denmark','Portugal','Poland',
     'South Africa','Brazil','Argentina','Chile','Colombia')
    THEN 'EMEA cont & LATAM'
  WHEN TRIM(COALESCE(country, '')) IN
    ('United Kingdom','Ireland','United Arab Emirates','Saudi Arabia',
     'Japan','India','China','Australia','New Zealand','Singapore',
     'Malaysia','Fiji')
    THEN 'UK&IRE, ME, Japan'
  ELSE 'Other'
END;

-- Verification: should show ONLY the four new keys.
SELECT region, COUNT(*) FROM leads GROUP BY region ORDER BY region;

-- If the distribution looks right:
COMMIT;
-- If not:
-- ROLLBACK;

-- ============================================================
-- STEP 2: attributions — unambiguous auto-maps
-- (NA stays NA; Other stays Other)
-- ============================================================

BEGIN;

UPDATE attributions
SET region = 'EMEA cont & LATAM'
WHERE region = 'LATAM';

UPDATE attributions
SET region = 'UK&IRE, ME, Japan'
WHERE region = 'APAC';

-- Verification: only NA / EMEA cont & LATAM / UK&IRE, ME, Japan /
-- Other / EMEA should remain (EMEA is resolved in step 3).
SELECT region, COUNT(*) FROM attributions GROUP BY region ORDER BY region;

COMMIT;
-- ROLLBACK;

-- ============================================================
-- STEP 3: attributions — EMEA review list (manual assignment)
-- ============================================================
-- Old EMEA splits across both new buckets, and attributions carry no
-- country. Review each deal and assign by account geography.

SELECT DISTINCT deal_id, label, account, sf_link,
       array_agg(stage_key) OVER (PARTITION BY deal_id) AS stages
FROM attributions
WHERE region = 'EMEA'
ORDER BY account;

-- Then assign each deal_id to one of the two buckets. Templates
-- (fill in the deal_id lists, run inside BEGIN/COMMIT):
--
-- BEGIN;
-- UPDATE attributions SET region = 'EMEA cont & LATAM'
-- WHERE region = 'EMEA' AND deal_id IN ('<deal-id-1>', '<deal-id-2>');
--
-- UPDATE attributions SET region = 'UK&IRE, ME, Japan'
-- WHERE region = 'EMEA' AND deal_id IN ('<deal-id-3>');
--
-- -- Final check: zero rows on legacy keys anywhere.
-- SELECT region, COUNT(*) FROM attributions
-- WHERE region IN ('EMEA','APAC','LATAM') GROUP BY region;
-- COMMIT;
