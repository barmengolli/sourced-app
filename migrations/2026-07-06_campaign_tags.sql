-- 2026-07-06_campaign_tags.sql
--
-- Campaign-tag layer that unifies the data silos. Each of the four silos names
-- "campaign" differently (6Sense free-text segment, Outreach sequence_name
-- convention, channels by FK), and there is no shared join key. This adds a
-- manual tag layer: a canonical campaign tag (e.g. "L&A") mapped to the assets
-- that belong to it in each silo. Leads and opportunities come for free through
-- the tagged channels (existing FKs); 6Sense and Outreach are tagged directly.
--
--   campaign_tags       - the canonical campaign (name, optional color).
--   campaign_tag_links  - polymorphic map: one tag -> one asset in any silo,
--                         (asset_type, asset_ref) where asset_ref is the channel
--                         UUID, the 6Sense segment string, or the Outreach
--                         sequence_id (all stored as text). UNIQUE(asset_type,
--                         asset_ref) keeps each asset in at most one campaign.
--
-- RUN ORDER: standalone, no dependencies. Apply manually in the Supabase SQL
-- Editor. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS campaign_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_tag_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id UUID NOT NULL REFERENCES campaign_tags(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL
    CHECK (asset_type IN ('channel', 'sixsense_segment', 'outreach_sequence')),
  -- channel UUID | 6Sense segment string | Outreach sequence_id, all as text.
  asset_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- Each asset belongs to at most one campaign (v1 is 1:1, no double-counting).
  CONSTRAINT campaign_tag_links_asset_unique UNIQUE (asset_type, asset_ref)
);

CREATE INDEX IF NOT EXISTS idx_campaign_tag_links_tag
  ON campaign_tag_links(tag_id);

-- RLS: public read, anon write (client-side password gate), matching the rest
-- of the schema.
ALTER TABLE campaign_tags      ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_tag_links ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaign_tags', 'campaign_tag_links']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'Allow public read'
    ) THEN
      EXECUTE format('CREATE POLICY "Allow public read" ON %I FOR SELECT USING (true);', t);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'Allow anon insert'
    ) THEN
      EXECUTE format('CREATE POLICY "Allow anon insert" ON %I FOR INSERT WITH CHECK (true);', t);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'Allow anon update'
    ) THEN
      EXECUTE format('CREATE POLICY "Allow anon update" ON %I FOR UPDATE USING (true) WITH CHECK (true);', t);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'Allow anon delete'
    ) THEN
      EXECUTE format('CREATE POLICY "Allow anon delete" ON %I FOR DELETE USING (true);', t);
    END IF;
  END LOOP;
END $$;

-- Realtime so tagging in one silo updates the Campaigns view (and other mounts)
-- without a refresh. Guarded: adding a table already in the publication errors.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'campaign_tags'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE campaign_tags;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'campaign_tag_links'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE campaign_tag_links;
  END IF;
END $$;

COMMIT;
