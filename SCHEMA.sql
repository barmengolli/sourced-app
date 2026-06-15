-- Sourced Database Schema
-- Paste this entire file into the Supabase SQL Editor on first setup.
-- Project: sourced-app
-- Created: 2026-04

-- =============================================================
-- Extensions
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================
-- Channels (taxonomy)
-- =============================================================

CREATE TABLE channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  parent_channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  display_order INTEGER DEFAULT 0,
  hidden BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT channels_name_parent_unique UNIQUE (name, parent_channel_id)
);

CREATE INDEX idx_channels_parent ON channels(parent_channel_id);

-- No base seed. SFDC's Parent Campaign / Campaign Name columns populate the
-- channel tree on first import.

-- =============================================================
-- Leads (the corrected mirror of SFDC)
-- =============================================================

CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity (email is the canonical key, always lowercased)
  email TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,

  -- External system IDs
  sfdc_lead_id TEXT,
  sfdc_contact_id TEXT,
  hubspot_contact_id TEXT,

  -- Person fields
  account TEXT,
  title TEXT,
  country TEXT,
  -- Region: NA / EMEA / APAC / LATAM / Other. Derived from country at import
  -- time but editable per row. No CHECK constraint so the taxonomy can evolve.
  region TEXT,
  owner TEXT,
  lead_source TEXT,

  -- Lifecycle (lead-side only; HPP/Opp/Pursuit/Won are Opportunity record-types,
  -- not lead lifecycle stages — they live on attributions/funnel_projections).
  current_stage TEXT NOT NULL DEFAULT 'lead'
    CHECK (current_stage IN ('lead','mql')),

  -- The bucketing date (editable mirror of Member First Associated Date)
  marketing_sourced_date DATE,

  -- Source channel
  source_channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,

  -- Stage history: array of {stage, entered_at, edited_by, edit_locked, notes}
  stage_history JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Per-field edit locks: {marketing_sourced_date: true, account: false, ...}
  field_locks JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Last raw values from SFDC (for diffing on re-import)
  source_sfdc JSONB NOT NULL DEFAULT '{}'::jsonb,

  notes TEXT,

  -- Event-marketing engagement signals from SFDC's "Event Activation"
  -- field. Closed set: Pre-Event Meeting, Booth Meeting, Session
  -- Attendee, Post-Event Meeting. No CHECK so the taxonomy can grow;
  -- the importer and edit UI validate.
  event_activations TEXT[] NOT NULL DEFAULT '{}',

  -- Bookkeeping
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ,
  last_edited_by TEXT
);

CREATE INDEX idx_leads_email ON leads(email);
CREATE INDEX idx_leads_account ON leads(account);
CREATE INDEX idx_leads_marketing_sourced_date ON leads(marketing_sourced_date);
CREATE INDEX idx_leads_current_stage ON leads(current_stage);
CREATE INDEX idx_leads_source_channel ON leads(source_channel_id);
CREATE INDEX idx_leads_country ON leads(country);
CREATE INDEX idx_leads_owner ON leads(owner);
CREATE INDEX idx_leads_region ON leads(region);
CREATE INDEX idx_leads_stage_history ON leads USING GIN(stage_history);
CREATE INDEX idx_leads_event_activations ON leads USING GIN(event_activations);

-- =============================================================
-- Attributions (deal-level multi-touch journey)
-- =============================================================

CREATE TABLE attributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  deal_id TEXT,  -- shared across stages for the same deal (HPP -> Opp -> Pursuit -> Won)
  stage_key TEXT NOT NULL CHECK (stage_key IN ('hpp','opp','pursuit','closeWon','closeLost')),
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  year INTEGER NOT NULL,
  period_index INTEGER NOT NULL CHECK (period_index BETWEEN 1 AND 4),

  label TEXT,            -- Deal name, e.g. "Acme Corp"
  account TEXT,
  amount NUMERIC(12,2),
  sf_link TEXT,
  -- Region: NA / EMEA / APAC / LATAM / Other. Manually entered in the
  -- Create/Edit modals (defaults to NA in M7 since lead_id is unset).
  region TEXT,

  -- Day the deal entered THIS stage. Velocity between any two stages of
  -- the same deal_id = downstream.stage_entered_at - upstream.stage_entered_at.
  -- Captured by the four create/promote/edit/close-lost paths; defaults
  -- to today when the user does not override.
  stage_entered_at DATE NOT NULL,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_attributions_deal ON attributions(deal_id);
CREATE INDEX idx_attributions_lead ON attributions(lead_id);
CREATE INDEX idx_attributions_stage ON attributions(stage_key);
CREATE INDEX idx_attributions_period ON attributions(year, period_index);
CREATE INDEX idx_attributions_channel ON attributions(channel_id);
CREATE INDEX idx_attributions_region ON attributions(region);
CREATE INDEX idx_attributions_stage_entered_at ON attributions(stage_entered_at);

-- Defense-in-depth against duplicate downstream rows. UI guard in
-- OpportunitiesListModal prevents most cases; this constraint catches
-- bulk imports and direct SQL writes. Partial because legacy rows
-- can have NULL or empty deal_id.
CREATE UNIQUE INDEX attributions_deal_stage_uniq
  ON attributions (deal_id, stage_key)
  WHERE deal_id IS NOT NULL AND deal_id <> '';

-- Ordered touches per attribution
CREATE TABLE attribution_touches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_id UUID REFERENCES attributions(id) ON DELETE CASCADE,
  touch_order INTEGER NOT NULL,  -- 1, 2, 3, ...
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  touched_at DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(attribution_id, touch_order)
);

CREATE INDEX idx_touches_attribution ON attribution_touches(attribution_id);
CREATE INDEX idx_touches_channel ON attribution_touches(channel_id);

-- =============================================================
-- Campaign costs (date-range budgets per channel)
-- =============================================================
-- One row per contract / budget allocation. Cost is pro-rated to the
-- selected period at read time so contracts spanning quarter
-- boundaries split correctly. Multiple rows per channel are allowed.

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

-- =============================================================
-- Funnel projections (manually entered, not computed)
-- =============================================================

CREATE TABLE funnel_projections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  period_index INTEGER NOT NULL CHECK (period_index BETWEEN 1 AND 4),
  stage_key TEXT NOT NULL CHECK (stage_key IN ('lead','mql','hpp','opp','pursuit','closeWon','closeLost')),
  projection NUMERIC(10,0),
  edited_at TIMESTAMPTZ DEFAULT NOW(),
  edited_by TEXT,
  UNIQUE(channel_id, year, period_index, stage_key)
);

CREATE INDEX idx_projections_period ON funnel_projections(year, period_index);

-- Manually-entered actuals. For HPP, Opp, Pursuit, Closed Won, and
-- Closed Lost, this is the primary store (with attribution rows
-- preferred when present, per the compute layer). For Lead and MQL,
-- counts are normally computed live from leads.marketing_sourced_date
-- and leads.stage_history; funnel_actuals rows with stage_key in
-- ('lead','mql') are a fallback used for historical-year backfills
-- (e.g. 2025 pre-Sourced) where no lead-level data was imported.
CREATE TABLE funnel_actuals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  period_index INTEGER NOT NULL CHECK (period_index BETWEEN 1 AND 4),
  stage_key TEXT NOT NULL CHECK (stage_key IN ('lead','mql','hpp','opp','pursuit','closeWon','closeLost')),
  actual NUMERIC(10,0),
  edited_at TIMESTAMPTZ DEFAULT NOW(),
  edited_by TEXT,
  UNIQUE(channel_id, year, period_index, stage_key)
);

CREATE INDEX idx_funnel_actuals_period ON funnel_actuals(year, period_index);
CREATE INDEX idx_funnel_actuals_channel ON funnel_actuals(channel_id);

-- =============================================================
-- Cell annotations (port from DataVis 1)
-- =============================================================

CREATE TABLE cell_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  period_index INTEGER NOT NULL,
  stage_key TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('projection','actual')),
  author TEXT,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_comments_cell ON cell_comments(channel_id, year, period_index, stage_key, field);

CREATE TABLE cell_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  period_index INTEGER NOT NULL,
  stage_key TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('projection','actual')),
  url TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_links_cell ON cell_links(channel_id, year, period_index, stage_key, field);

-- =============================================================
-- Outreach snapshots (M9)
-- =============================================================
-- Weekly snapshot per Outreach.io sequence. Populated by the n8n workflow
-- that hits the Outreach API every Monday and upserts here. Region is
-- inferred client-side from sequence_name (regex on the [YYYY] - REGION -
-- prefix), so it is not stored on the row.

CREATE TABLE outreach_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  export_date DATE NOT NULL,
  week_number INTEGER NOT NULL,
  year INTEGER NOT NULL,
  sequence_id INTEGER NOT NULL,
  sequence_name TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  step_count INTEGER DEFAULT 0,
  duration_days INTEGER DEFAULT 0,
  total_sent INTEGER DEFAULT 0,
  delivered INTEGER DEFAULT 0,
  bounced INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  opened INTEGER DEFAULT 0,
  clicked INTEGER DEFAULT 0,
  replied INTEGER DEFAULT 0,
  positive_replies INTEGER DEFAULT 0,
  neutral_replies INTEGER DEFAULT 0,
  negative_replies INTEGER DEFAULT 0,
  opted_out INTEGER DEFAULT 0,
  delivery_rate NUMERIC(5,2) DEFAULT 0,
  open_rate NUMERIC(5,2) DEFAULT 0,
  click_rate NUMERIC(5,2) DEFAULT 0,
  reply_rate NUMERIC(5,2) DEFAULT 0,
  bounce_rate NUMERIC(5,2) DEFAULT 0,
  opt_out_rate NUMERIC(5,2) DEFAULT 0,
  contacted_prospects INTEGER DEFAULT 0,
  replied_prospects INTEGER DEFAULT 0,
  prospects_added INTEGER DEFAULT 0,
  prospects_active INTEGER DEFAULT 0,
  total_tasks INTEGER DEFAULT 0,
  overdue_tasks INTEGER DEFAULT 0,
  outbound_calls INTEGER DEFAULT 0,
  linkedin_tasks_completed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(export_date, sequence_id)
);

CREATE INDEX idx_outreach_year_week ON outreach_snapshots(year, week_number);
CREATE INDEX idx_outreach_sequence ON outreach_snapshots(sequence_id);
CREATE INDEX idx_outreach_export_date ON outreach_snapshots(export_date DESC);

-- =============================================================
-- 6sense snapshots
-- =============================================================
-- "Activities By Source" summary snapshot. EIS has no 6sense API access, so
-- the summary view is exported manually and imported via the in-app 6sense
-- CSV importer (an n8n + Google Sheet path may write here later, tagged via
-- `source`). One row per import, keyed by the analysis-window end date.
-- Re-importing the same window upserts. Only raw counts are stored; reach %
-- and engagement % (count / total_accounts) and week-over-week deltas are
-- computed in-app. Metrics 6sense shows as "--" (e.g. unlicensed G2 /
-- TrustRadius intent) are stored NULL.

CREATE TABLE sixsense_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL,
  window_start DATE,
  window_end DATE,
  year INTEGER NOT NULL,
  week_number INTEGER NOT NULL,
  total_accounts INTEGER DEFAULT 0,
  accounts_with_activity INTEGER DEFAULT 0,
  no_activity INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  intent INTEGER DEFAULT 0,
  engagement INTEGER DEFAULT 0,
  crm_map_campaigns_reached INTEGER DEFAULT 0,
  sales_reached INTEGER DEFAULT 0,
  sixsense_campaigns_reached INTEGER DEFAULT 0,
  external_campaigns_reached INTEGER DEFAULT 0,
  linkedin_campaigns_reached INTEGER DEFAULT 0,
  ai_emails_reached INTEGER DEFAULT 0,
  sixsense_keyword_research INTEGER DEFAULT 0,
  bombora_topics INTEGER DEFAULT 0,
  g2_intent INTEGER,
  trustradius_intent INTEGER,
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

CREATE INDEX idx_sixsense_year_week ON sixsense_snapshots(year, week_number);
CREATE INDEX idx_sixsense_snapshot_date ON sixsense_snapshots(snapshot_date DESC);

-- =============================================================
-- Updated-at triggers
-- =============================================================

CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_timestamp_leads BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

CREATE TRIGGER set_timestamp_attributions BEFORE UPDATE ON attributions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

CREATE TRIGGER set_timestamp_campaign_costs BEFORE UPDATE ON campaign_costs
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

-- =============================================================
-- Row Level Security
-- =============================================================
-- Pattern mirrors DataVis 1: public read, anon write (gated by client password).
-- Replace with proper auth (Supabase Auth or custom claims) in v2.

ALTER TABLE channels                ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE attributions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribution_touches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_costs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE funnel_projections      ENABLE ROW LEVEL SECURITY;
ALTER TABLE funnel_actuals          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_comments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_links              ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_snapshots      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sixsense_snapshots      ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'channels','leads','attributions','attribution_touches','campaign_costs',
    'funnel_projections','funnel_actuals','cell_comments','cell_links',
    'outreach_snapshots','sixsense_snapshots'
  ]
  LOOP
    EXECUTE format('CREATE POLICY "Allow public read" ON %I FOR SELECT USING (true);', t);
    EXECUTE format('CREATE POLICY "Allow anon insert" ON %I FOR INSERT WITH CHECK (true);', t);
    EXECUTE format('CREATE POLICY "Allow anon update" ON %I FOR UPDATE USING (true) WITH CHECK (true);', t);
    EXECUTE format('CREATE POLICY "Allow anon delete" ON %I FOR DELETE USING (true);', t);
  END LOOP;
END $$;

-- =============================================================
-- Realtime subscriptions
-- =============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE leads;
ALTER PUBLICATION supabase_realtime ADD TABLE channels;
ALTER PUBLICATION supabase_realtime ADD TABLE attributions;
ALTER PUBLICATION supabase_realtime ADD TABLE attribution_touches;
ALTER PUBLICATION supabase_realtime ADD TABLE campaign_costs;
ALTER PUBLICATION supabase_realtime ADD TABLE funnel_projections;
ALTER PUBLICATION supabase_realtime ADD TABLE funnel_actuals;
ALTER PUBLICATION supabase_realtime ADD TABLE outreach_snapshots;
ALTER PUBLICATION supabase_realtime ADD TABLE sixsense_snapshots;

-- Done.
