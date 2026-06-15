-- 2026-06-12_bdr_quotas.sql
--
-- Annual BDR quotas for the BDR Quota tracker. One row per (bdr_name, year,
-- stage_key) holding the target count. Actuals are NOT stored here: they're
-- computed live from attributions (deals whose first-touch top-level channel
-- is "Marketing SDR" and whose bdr_name matches). This table only holds the
-- targets the gauges measure against.
--
-- stage_key is 'hpp' (HPP / SQL) or 'opp' (Opp / SAO) — the two metrics the
-- BDR Qualification sheet tracks. bdr_name matches attributions.bdr_name
-- verbatim (the app's fixed roster), so the actual-to-quota join is exact.
--
-- Modeled on funnel_actuals: permissive RLS (public read, anon write),
-- realtime publication. Idempotent.
--
-- RUN ORDER: standalone, no dependencies. Apply manually in the Supabase SQL
-- Editor (no migration runner is wired into the app).

BEGIN;

CREATE TABLE IF NOT EXISTS bdr_quotas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bdr_name TEXT NOT NULL,
  year INTEGER NOT NULL,
  stage_key TEXT NOT NULL CHECK (stage_key IN ('hpp','opp')),
  quota INTEGER,
  edited_at TIMESTAMPTZ DEFAULT NOW(),
  edited_by TEXT,
  UNIQUE(bdr_name, year, stage_key)
);

CREATE INDEX IF NOT EXISTS idx_bdr_quotas_year ON bdr_quotas(year);

ALTER TABLE bdr_quotas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bdr_quotas' AND policyname = 'Allow public read') THEN
    CREATE POLICY "Allow public read" ON bdr_quotas FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bdr_quotas' AND policyname = 'Allow anon insert') THEN
    CREATE POLICY "Allow anon insert" ON bdr_quotas FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bdr_quotas' AND policyname = 'Allow anon update') THEN
    CREATE POLICY "Allow anon update" ON bdr_quotas FOR UPDATE USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bdr_quotas' AND policyname = 'Allow anon delete') THEN
    CREATE POLICY "Allow anon delete" ON bdr_quotas FOR DELETE USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'bdr_quotas'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE bdr_quotas;
  END IF;
END $$;

COMMIT;
