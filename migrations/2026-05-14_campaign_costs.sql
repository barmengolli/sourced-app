-- campaign_costs stores date-range budgets per channel. Pro-rated to
-- the selected period by the application (compute.ts), so contracts
-- crossing quarter boundaries cost-split correctly.
--
-- amount is USD. start_date / end_date are inclusive day-resolution.
-- Multiple rows per channel are allowed: each contract gets its own
-- row. Cost is NOT region-scoped at the DB layer; the Spend report
-- displays the full pro-rated cost regardless of region filter.

BEGIN;

CREATE TABLE campaign_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (end_date >= start_date)
);

CREATE INDEX idx_campaign_costs_channel ON campaign_costs (channel_id);
CREATE INDEX idx_campaign_costs_dates ON campaign_costs (start_date, end_date);

ALTER TABLE campaign_costs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON campaign_costs FOR SELECT USING (true);
CREATE POLICY "Allow anon insert" ON campaign_costs FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update" ON campaign_costs FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon delete" ON campaign_costs FOR DELETE USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE campaign_costs;

CREATE TRIGGER set_timestamp_campaign_costs BEFORE UPDATE ON campaign_costs
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

COMMIT;
