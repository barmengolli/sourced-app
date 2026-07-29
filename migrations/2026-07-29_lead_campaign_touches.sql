-- 2026-07-29_lead_campaign_touches.sql
--
-- Bite 4C of the lead multi-attribution program
-- (docs/lead-multi-attribution-program.md): the storage table for the
-- Bite 4A `LeadCampaignTouch` contract (src/lib/campaignAttribution.ts,
-- docs/funnel-source-contract.md section 5). One row per campaign
-- membership touch; a person in three campaigns has three rows. Nothing
-- reads this table yet: after this migration is applied every dashboard
-- number is IDENTICAL to before. The importer starts writing touches in
-- Bite 4D and compute switches to them in Bite 4E.
--
-- Idempotency keys, mirroring dedupeTouches (4A):
--   - Preferred: the Salesforce CampaignMember Id (UNIQUE where non-null).
--   - Natural-key fallback for rows without one (report exports):
--     (lead_id, campaign_id, touch_date) with NULL touch_date collapsed to
--     the same sentinel bucket the contract uses for 'unknown'.
--   - Backfill seed rows carry no campaign identity (they are the primary
--     source mirrored from leads.source_channel_id) and are outside the
--     natural-key domain; the seed itself is guarded so re-running this
--     migration cannot duplicate them.
--
-- ROLLBACK: `DROP TABLE lead_campaign_touches;` is safe while nothing
-- reads the table (true until Bite 4D/4E deploy).
--
-- RUN ORDER: standalone, no dependencies beyond leads/channels. Apply
-- manually in the Supabase SQL Editor. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS lead_campaign_touches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- SFDC CampaignMember Id; NULL for report-export and backfill rows.
  campaign_member_id TEXT,
  -- SFDC Campaign Id (sub-campaign level); nullable.
  campaign_id TEXT,
  -- Nullable until resolved to a Sourced channel.
  channel_id UUID REFERENCES channels(id),
  -- Member First Associated Date when known.
  touch_date DATE,
  -- Provenance as delivered by the source.
  parent_campaign TEXT,
  sub_campaign TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL CHECK (source IN ('import', 'n8n_sync', 'backfill', 'manual')),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_campaign_touches_lead
  ON lead_campaign_touches(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_campaign_touches_channel
  ON lead_campaign_touches(channel_id);
CREATE INDEX IF NOT EXISTS idx_lead_campaign_touches_touch_date
  ON lead_campaign_touches(touch_date);

-- Preferred idempotency key: the CampaignMember Id, unique where present.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_campaign_touches_member_id
  ON lead_campaign_touches(campaign_member_id)
  WHERE campaign_member_id IS NOT NULL;

-- Natural-key fallback matching dedupeTouches: lead + campaign + touch
-- date, where a NULL touch_date collapses to one 'unknown' bucket exactly
-- as the contract's key does. Only rows WITH campaign identity participate
-- (the contract rejects touches without one; backfill seed rows have none).
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_campaign_touches_natural_key
  ON lead_campaign_touches(lead_id, campaign_id, COALESCE(touch_date, DATE '0001-01-01'))
  WHERE campaign_member_id IS NULL AND campaign_id IS NOT NULL;

-- RLS: public read, anon write (client-side password gate), mirroring the
-- existing leads policies exactly.
ALTER TABLE lead_campaign_touches ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_campaign_touches']
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

-- Realtime, guarded like the other tables in the publication.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'lead_campaign_touches'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE lead_campaign_touches;
  END IF;
END $$;

-- Seed backfill: one touch per existing lead from its primary source
-- (source_channel_id, marketing_sourced_date). Guarded so re-running the
-- migration cannot duplicate seed rows.
INSERT INTO lead_campaign_touches
  (lead_id, channel_id, touch_date, source, raw)
SELECT id, source_channel_id, marketing_sourced_date, 'backfill',
       jsonb_build_object('note', 'seeded from leads.source_channel_id (primary source)')
FROM leads
WHERE source_channel_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM lead_campaign_touches t
    WHERE t.lead_id = leads.id AND t.source = 'backfill'
  );

-- verification: seeded touches = leads with a source channel
SELECT
  (SELECT COUNT(*) FROM lead_campaign_touches WHERE source = 'backfill') AS touches,
  (SELECT COUNT(*) FROM leads WHERE source_channel_id IS NOT NULL) AS leads_with_channel;

COMMIT;
