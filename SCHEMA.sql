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
  name TEXT NOT NULL UNIQUE,
  display_order INTEGER DEFAULT 0,
  hidden BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed with EIS Group's current channel taxonomy. Edit as needed.
INSERT INTO channels (name, display_order) VALUES
  ('Content Syndication', 10),
  ('LinkedIn Ads', 20),
  ('BDR Outreach', 30),
  ('Website', 40),
  ('Events', 50),
  ('Webinars', 60),
  ('6sense Display', 70),
  ('Email Nurture', 80),
  ('Referral', 90),
  ('Other', 999);

-- =============================================================
-- Campaigns
-- =============================================================

CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  parent_campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  start_date DATE,
  end_date DATE,
  owner TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_campaigns_parent ON campaigns(parent_campaign_id);
CREATE INDEX idx_campaigns_dates ON campaigns(start_date, end_date);

-- Campaign-Channel many-to-many
CREATE TABLE campaign_channels (
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (campaign_id, channel_id)
);

-- Quarterly spend per campaign
CREATE TABLE campaign_spend (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  period_index INTEGER NOT NULL CHECK (period_index BETWEEN 1 AND 4),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, year, period_index)
);

CREATE INDEX idx_campaign_spend_period ON campaign_spend(year, period_index);

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
  owner TEXT,
  lead_source TEXT,

  -- Lifecycle
  current_stage TEXT NOT NULL DEFAULT 'lead'
    CHECK (current_stage IN ('lead','mql','hpp','opp','pursuit','closeWon','cold','disqualified')),

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
CREATE INDEX idx_leads_stage_history ON leads USING GIN(stage_history);

-- Lead-Campaign membership (M2M with metadata)
CREATE TABLE lead_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  joined_at DATE NOT NULL,
  reason TEXT,  -- 'form_fill', 'event_scan', 'bdr_added', 'manual', 'ad_click', 'list_upload'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(lead_id, campaign_id, joined_at)
);

CREATE INDEX idx_lead_campaigns_lead ON lead_campaigns(lead_id);
CREATE INDEX idx_lead_campaigns_campaign ON lead_campaigns(campaign_id);
CREATE INDEX idx_lead_campaigns_joined_at ON lead_campaigns(joined_at);

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

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_attributions_deal ON attributions(deal_id);
CREATE INDEX idx_attributions_lead ON attributions(lead_id);
CREATE INDEX idx_attributions_stage ON attributions(stage_key);
CREATE INDEX idx_attributions_period ON attributions(year, period_index);
CREATE INDEX idx_attributions_channel ON attributions(channel_id);

-- Ordered touches per attribution
CREATE TABLE attribution_touches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_id UUID REFERENCES attributions(id) ON DELETE CASCADE,
  touch_order INTEGER NOT NULL,  -- 1, 2, 3, ...
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  touched_at DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(attribution_id, touch_order)
);

CREATE INDEX idx_touches_attribution ON attribution_touches(attribution_id);
CREATE INDEX idx_touches_channel ON attribution_touches(channel_id);
CREATE INDEX idx_touches_campaign ON attribution_touches(campaign_id);

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
-- Updated-at triggers
-- =============================================================

CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_timestamp_campaigns BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

CREATE TRIGGER set_timestamp_campaign_spend BEFORE UPDATE ON campaign_spend
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

CREATE TRIGGER set_timestamp_leads BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

CREATE TRIGGER set_timestamp_attributions BEFORE UPDATE ON attributions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

-- =============================================================
-- Row Level Security
-- =============================================================
-- Pattern mirrors DataVis 1: public read, anon write (gated by client password).
-- Replace with proper auth (Supabase Auth or custom claims) in v2.

ALTER TABLE channels                ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns               ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_channels       ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_spend          ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_campaigns          ENABLE ROW LEVEL SECURITY;
ALTER TABLE attributions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribution_touches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE funnel_projections      ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_comments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_links              ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'channels','campaigns','campaign_channels','campaign_spend',
    'leads','lead_campaigns','attributions','attribution_touches',
    'funnel_projections','cell_comments','cell_links'
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
ALTER PUBLICATION supabase_realtime ADD TABLE campaigns;
ALTER PUBLICATION supabase_realtime ADD TABLE campaign_spend;
ALTER PUBLICATION supabase_realtime ADD TABLE attributions;
ALTER PUBLICATION supabase_realtime ADD TABLE attribution_touches;
ALTER PUBLICATION supabase_realtime ADD TABLE funnel_projections;

-- Done.
