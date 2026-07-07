-- 2026-07-07_linkedin_ads.sql
--
-- LinkedIn Ads silo. A consultant drops weekly ad performance into a Google
-- Sheet; an n8n workflow sums the daily line items into one row per (ad set x
-- week) and upserts here. Sourced reads it for a LinkedIn Ads dashboard and,
-- when an ad set is tagged with a campaign tag, in the Campaigns tab.
--
-- Grain: one row per ad set per week. Metrics are PER-WEEK (this week's spend/
-- impressions/clicks), NOT cumulative like outreach_snapshots, so the app sums
-- rows directly for a period (no delta math). Rates (CTR/CPC/CPM) are derived
-- on read, never stored.
--
-- The Google export has no numeric ad-set ID, so the Ad Set Name is the stable
-- key: adset_id = adset_name. This is also the campaign_tag_links.asset_ref.
--
-- Also extends campaign_tag_links.asset_type to allow 'linkedin_adset'.
--
-- RUN ORDER: after 2026-07-06_campaign_tags.sql. Apply manually in the Supabase
-- SQL Editor. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS linkedin_ads_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL,          -- the week's date (ISO), from the sheet's Week column
  year INTEGER NOT NULL,
  week_number INTEGER NOT NULL,         -- ISO week number
  campaign_id TEXT,                     -- LinkedIn campaign id
  campaign_name TEXT,
  product TEXT,                         -- Awareness / P&C / Life / Vitech / PET / ...
  region TEXT,                          -- USA / UK / Japan / France / ...
  adset_id TEXT NOT NULL,               -- = Ad Set Name (no numeric id in the export)
  adset_name TEXT NOT NULL,
  -- Per-week delivery metrics (summed from the week's daily rows by n8n).
  spend NUMERIC(12,2) DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (snapshot_date, adset_id)      -- one weekly row per ad set; re-imports upsert
);

CREATE INDEX IF NOT EXISTS idx_linkedin_year_week
  ON linkedin_ads_snapshots(year, week_number);
CREATE INDEX IF NOT EXISTS idx_linkedin_adset
  ON linkedin_ads_snapshots(adset_id);
CREATE INDEX IF NOT EXISTS idx_linkedin_snapshot_date
  ON linkedin_ads_snapshots(snapshot_date DESC);

-- RLS: public read, anon write (client-side password gate).
ALTER TABLE linkedin_ads_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'linkedin_ads_snapshots' AND policyname = 'Allow public read') THEN
    CREATE POLICY "Allow public read" ON linkedin_ads_snapshots FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'linkedin_ads_snapshots' AND policyname = 'Allow anon insert') THEN
    CREATE POLICY "Allow anon insert" ON linkedin_ads_snapshots FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'linkedin_ads_snapshots' AND policyname = 'Allow anon update') THEN
    CREATE POLICY "Allow anon update" ON linkedin_ads_snapshots FOR UPDATE USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'linkedin_ads_snapshots' AND policyname = 'Allow anon delete') THEN
    CREATE POLICY "Allow anon delete" ON linkedin_ads_snapshots FOR DELETE USING (true);
  END IF;
END $$;

-- Realtime.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'linkedin_ads_snapshots') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE linkedin_ads_snapshots;
  END IF;
END $$;

-- Extend the campaign-tag asset types to include LinkedIn ad sets. Drop the old
-- CHECK by column lookup (robust to its name), then add the widened one.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  WHERE c.conrelid = 'campaign_tag_links'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%asset_type%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE campaign_tag_links DROP CONSTRAINT %I', con_name);
  END IF;

  ALTER TABLE campaign_tag_links
    ADD CONSTRAINT campaign_tag_links_asset_type_check
    CHECK (asset_type IN ('channel', 'sixsense_segment', 'outreach_sequence', 'linkedin_adset'));
END $$;

COMMIT;
