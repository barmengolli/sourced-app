-- Multi-tag assets: a channel (or 6Sense segment / Outreach sequence /
-- LinkedIn ad set) may belong to MORE THAN ONE campaign.
--
-- v1 modelled this 1:1 via UNIQUE(asset_type, asset_ref), so tagging an asset to
-- a second campaign MOVED it off the first. Real campaigns share channels, so
-- the key becomes UNIQUE(tag_id, asset_type, asset_ref): an asset may repeat
-- across campaigns, but a campaign cannot claim the same asset twice.
--
-- CONSEQUENCE, INTENTIONAL: once an asset is shared, campaign totals OVERLAP.
-- A shared channel's leads, MQLs and deals count in full for every campaign that
-- claims it, so per-campaign figures no longer sum to a company total. The
-- Campaigns Overview says so in-UI. This is the "full credit, labelled" model
-- Benjamin chose: each campaign's number stands alone and matches Salesforce for
-- the deals it touched.
--
-- RUN ORDER: after 2026-07-07_linkedin_ads.sql. Pair with the code change on the
-- same branch (useCampaignTags / CampaignTagPicker / campaignScorecard): the new
-- linkAsset upserts on (tag_id, asset_type, asset_ref) and ERRORS against the old
-- constraint, so APPLY THIS BEFORE DEPLOYING the code.
--
-- Idempotent: safe to re-run.

BEGIN;

-- 1. Drop the old 1:1 constraint. Look it up by its COLUMNS rather than its name
--    so this works even if the name drifted from the schema baseline (same
--    approach as the asset_type CHECK swap in 2026-07-07_linkedin_ads.sql).
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  WHERE c.conrelid = 'campaign_tag_links'::regclass
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY a.attname)
      FROM unnest(c.conkey) k(attnum)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    ) = ARRAY['asset_ref', 'asset_type']
  LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE campaign_tag_links DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

-- 2. Collapse exact duplicate (tag_id, asset_type, asset_ref) rows before adding
--    the new key. None can exist under the old constraint, but a re-run after a
--    partially-applied migration could produce them.
DELETE FROM campaign_tag_links a
USING campaign_tag_links b
WHERE a.ctid > b.ctid
  AND a.tag_id = b.tag_id
  AND a.asset_type = b.asset_type
  AND a.asset_ref = b.asset_ref;

-- 3. The new key: one link per (campaign, asset).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaign_tag_links_tag_asset_unique'
      AND conrelid = 'campaign_tag_links'::regclass
  ) THEN
    ALTER TABLE campaign_tag_links
      ADD CONSTRAINT campaign_tag_links_tag_asset_unique
      UNIQUE (tag_id, asset_type, asset_ref);
  END IF;
END $$;

-- 4. Reverse lookup "which campaigns claim this asset?" — the hot path for
--    tagsFor() on the Tags page and the scorecard's per-campaign expansion. The
--    dropped constraint in step 1 provided this index implicitly; restore it.
CREATE INDEX IF NOT EXISTS idx_campaign_tag_links_asset
  ON campaign_tag_links (asset_type, asset_ref);

COMMIT;
