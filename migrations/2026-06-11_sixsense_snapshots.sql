-- 2026-06-11_sixsense_snapshots.sql
--
-- 6sense "Activities By Source" summary snapshots. EIS has no 6sense API
-- access, so the MOps lead exports the summary view manually and imports it
-- into Sourced (in-app CSV importer for v1; an n8n + Google Sheet path may
-- write to this same table later, distinguished by the `source` column).
--
-- One row per import, keyed by the analysis-window end date. Re-importing the
-- same window upserts (UNIQUE on snapshot_date). Sourced computes reach % and
-- engagement % (count / total_accounts) and week-over-week deltas in-app, so
-- only raw counts are stored. Metrics that 6sense shows as "--" (e.g. G2
-- Intent, TrustRadius Intent when not licensed) are stored NULL.
--
-- Modeled on outreach_snapshots: UUID pk, dated natural key, permissive RLS
-- (public read, anon write), realtime publication.
--
-- RUN ORDER: standalone, no dependencies. Apply manually in the Supabase SQL
-- Editor (no migration runner is wired into the app).

BEGIN;

CREATE TABLE IF NOT EXISTS sixsense_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL,
  window_start DATE,
  window_end DATE,
  year INTEGER NOT NULL,
  week_number INTEGER NOT NULL,
  -- Headline counts
  total_accounts INTEGER DEFAULT 0,
  accounts_with_activity INTEGER DEFAULT 0,
  no_activity INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  intent INTEGER DEFAULT 0,
  engagement INTEGER DEFAULT 0,
  -- Reach breakdown
  crm_map_campaigns_reached INTEGER DEFAULT 0,
  sales_reached INTEGER DEFAULT 0,
  sixsense_campaigns_reached INTEGER DEFAULT 0,
  external_campaigns_reached INTEGER DEFAULT 0,
  linkedin_campaigns_reached INTEGER DEFAULT 0,
  ai_emails_reached INTEGER DEFAULT 0,
  -- Intent breakdown (G2 / TrustRadius often NULL when not licensed)
  sixsense_keyword_research INTEGER DEFAULT 0,
  bombora_topics INTEGER DEFAULT 0,
  g2_intent INTEGER,
  trustradius_intent INTEGER,
  -- Engagement breakdown
  anonymous_web_engaged INTEGER DEFAULT 0,
  known_web_engaged INTEGER DEFAULT 0,
  crm_map_campaigns_engaged INTEGER DEFAULT 0,
  sales_engaged INTEGER DEFAULT 0,
  sixsense_campaigns_engaged INTEGER DEFAULT 0,
  external_campaigns_engaged INTEGER DEFAULT 0,
  linkedin_campaigns_engaged INTEGER DEFAULT 0,
  attended_webinars INTEGER DEFAULT 0,
  attended_trade_shows INTEGER DEFAULT 0,
  attended_field_events INTEGER DEFAULT 0,
  ai_emails_engaged INTEGER DEFAULT 0,
  source TEXT DEFAULT 'csv-import',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_sixsense_year_week
  ON sixsense_snapshots(year, week_number);
CREATE INDEX IF NOT EXISTS idx_sixsense_snapshot_date
  ON sixsense_snapshots(snapshot_date DESC);

ALTER TABLE sixsense_snapshots ENABLE ROW LEVEL SECURITY;

-- Guarded policy creation so re-running the migration is safe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sixsense_snapshots' AND policyname = 'Allow public read') THEN
    CREATE POLICY "Allow public read" ON sixsense_snapshots FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sixsense_snapshots' AND policyname = 'Allow anon insert') THEN
    CREATE POLICY "Allow anon insert" ON sixsense_snapshots FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sixsense_snapshots' AND policyname = 'Allow anon update') THEN
    CREATE POLICY "Allow anon update" ON sixsense_snapshots FOR UPDATE USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sixsense_snapshots' AND policyname = 'Allow anon delete') THEN
    CREATE POLICY "Allow anon delete" ON sixsense_snapshots FOR DELETE USING (true);
  END IF;
END $$;

-- Add to realtime publication if not already a member.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'sixsense_snapshots'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE sixsense_snapshots;
  END IF;
END $$;

COMMIT;
