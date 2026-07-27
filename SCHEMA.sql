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

  -- Why a deal was closed-lost. Only set on closeLost rows. The UI offers a
  -- required dropdown ("Closed-Lost to Competitor", "Close-Lost In-House");
  -- plain TEXT so the option list can change without a migration. NULL on
  -- pre-existing lost rows until edited.
  lost_reason TEXT,

  -- Which BDR a deal is credited to, for the BDR Quota tracker. Set per deal
  -- in the editor (propagated across the deal's rows like region). Plain TEXT
  -- matching the app's fixed roster. NULL until tagged.
  bdr_name TEXT,

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
CREATE INDEX idx_attributions_bdr_name ON attributions(bdr_name);

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
-- LinkedIn Ads snapshots (weekly, n8n-fed from a Google Sheet)
-- =============================================================
-- One row per (ad set x week). Metrics are PER-WEEK (not cumulative), summed
-- from the sheet's daily line items by n8n. adset_id = adset_name (the export
-- has no numeric id) and is the campaign_tag_links.asset_ref.

CREATE TABLE linkedin_ads_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL,
  year INTEGER NOT NULL,
  week_number INTEGER NOT NULL,
  campaign_id TEXT,
  campaign_name TEXT,
  product TEXT,
  region TEXT,
  adset_id TEXT NOT NULL,
  adset_name TEXT NOT NULL,
  spend NUMERIC(12,2) DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (snapshot_date, adset_id)
);

CREATE INDEX idx_linkedin_year_week ON linkedin_ads_snapshots(year, week_number);
CREATE INDEX idx_linkedin_adset ON linkedin_ads_snapshots(adset_id);
CREATE INDEX idx_linkedin_snapshot_date ON linkedin_ads_snapshots(snapshot_date DESC);

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
  -- Which account set this report covers. 'Target Accounts in CRM' is the
  -- overall report; campaigns (e.g. 'Life & Annuities') are their own values,
  -- chosen on import. Natural key is (snapshot_date, segment).
  segment TEXT NOT NULL DEFAULT 'Target Accounts in CRM',
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
  -- Import audit: the original uploaded file name and the explicit import
  -- timestamp (set on every upsert, unlike created_at which only reflects the
  -- first insert). Power the Import-tab history registry + overwrite warning.
  file_name TEXT,
  imported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(snapshot_date, segment)
);

CREATE INDEX idx_sixsense_year_week ON sixsense_snapshots(year, week_number);
CREATE INDEX idx_sixsense_snapshot_date ON sixsense_snapshots(snapshot_date DESC);
CREATE INDEX idx_sixsense_segment_date ON sixsense_snapshots(segment, snapshot_date DESC);

-- =============================================================
-- BDR quotas
-- =============================================================
-- Annual BDR (sales-development rep) quotas for the BDR Quota tracker. One
-- row per (bdr_name, year, stage_key) holding the target count. Actuals are
-- NOT stored: they're computed live from attributions (deals whose first-touch
-- top-level channel is "Marketing SDR" and whose bdr_name matches). stage_key
-- is 'hpp' (HPP/SQL) or 'opp' (Opp/SAO). bdr_name matches attributions.bdr_name
-- verbatim, so the actual-to-quota join is exact.

CREATE TABLE bdr_quotas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bdr_name TEXT NOT NULL,
  year INTEGER NOT NULL,
  stage_key TEXT NOT NULL CHECK (stage_key IN ('hpp','opp')),
  quota INTEGER,
  edited_at TIMESTAMPTZ DEFAULT NOW(),
  edited_by TEXT,
  UNIQUE(bdr_name, year, stage_key)
);

CREATE INDEX idx_bdr_quotas_year ON bdr_quotas(year);

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
-- Campaign tags (unifies the silos)
-- =============================================================
-- A manual tag layer mapping a canonical campaign (e.g. "L&A") to the assets
-- that belong to it in each silo. Leads/opps come for free through tagged
-- channels; 6Sense segments and Outreach sequences are tagged directly.
--
-- An asset may belong to SEVERAL campaigns (campaigns share channels). Totals
-- therefore overlap by design: a shared channel's leads and deals count in full
-- for every campaign claiming it, so per-campaign figures do not sum to a
-- company total. See migrations/2026-07-15_campaign_tag_links_multi_tag.sql.

CREATE TABLE campaign_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE campaign_tag_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id UUID NOT NULL REFERENCES campaign_tags(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL
    CHECK (asset_type IN ('channel', 'sixsense_segment', 'outreach_sequence', 'linkedin_adset')),
  -- channel UUID | 6Sense segment string | Outreach sequence_id | LinkedIn
  -- adset_name, all as text.
  asset_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- One link per (campaign, asset): an asset may belong to several campaigns,
  -- but a campaign cannot claim the same asset twice.
  CONSTRAINT campaign_tag_links_tag_asset_unique UNIQUE (tag_id, asset_type, asset_ref)
);

CREATE INDEX idx_campaign_tag_links_tag ON campaign_tag_links(tag_id);
CREATE INDEX idx_campaign_tag_links_asset ON campaign_tag_links(asset_type, asset_ref);

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
ALTER TABLE bdr_quotas              ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_tags           ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_tag_links      ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'channels','leads','attributions','attribution_touches','campaign_costs',
    'funnel_projections','funnel_actuals','cell_comments','cell_links',
    'outreach_snapshots','sixsense_snapshots','bdr_quotas',
    'campaign_tags','campaign_tag_links','linkedin_ads_snapshots'
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
ALTER PUBLICATION supabase_realtime ADD TABLE bdr_quotas;
ALTER PUBLICATION supabase_realtime ADD TABLE campaign_tags;
ALTER PUBLICATION supabase_realtime ADD TABLE campaign_tag_links;
ALTER PUBLICATION supabase_realtime ADD TABLE linkedin_ads_snapshots;

-- Done.

-- =============================================================
-- Bite 5B: Salesforce Opportunity ledger storage
-- (docs/opportunity-ledger-storage.md). Added by
-- migrations/2026-07-24_opportunity_ledger_storage.sql. RLS is enabled
-- with NO policies on purpose: the anon key has no access, these tables
-- are not in the permissive anon-policy loop above and not in the
-- realtime publication. sf_opportunity_events and
-- sf_opportunity_review_events are append-only by trigger.
-- =============================================================

-- =============================================================
-- 1. Sync runs (diagnostics + watermarks)
-- =============================================================

CREATE TABLE IF NOT EXISTS sf_opportunity_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'salesforce' CHECK (source = 'salesforce'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  -- High-water marks for incremental sync: the newest Salesforce
  -- SystemModstamp seen on snapshots and the newest history CreatedDate
  -- seen on events. Initial sync must not rely on Opportunity CreatedDate.
  watermark_system_modstamp TIMESTAMPTZ,
  watermark_history_created_at TIMESTAMPTZ,
  rows_discovered INTEGER NOT NULL DEFAULT 0 CHECK (rows_discovered >= 0),
  rows_accepted INTEGER NOT NULL DEFAULT 0 CHECK (rows_accepted >= 0),
  duplicates_ignored INTEGER NOT NULL DEFAULT 0 CHECK (duplicates_ignored >= 0),
  conflicts INTEGER NOT NULL DEFAULT 0 CHECK (conflicts >= 0),
  sent_to_review INTEGER NOT NULL DEFAULT 0 CHECK (sent_to_review >= 0),
  -- Non-sensitive summary only. Never credentials, tokens, or n8n secrets.
  error_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================
-- 2. Salesforce Opportunity snapshot (one current row per Opportunity)
-- =============================================================

CREATE TABLE IF NOT EXISTS sf_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'salesforce' CHECK (source = 'salesforce'),
  -- The stable external identity and the ONLY automatic linking key.
  sf_opportunity_id TEXT NOT NULL CHECK (length(trim(sf_opportunity_id)) > 0),
  record_type_developer_name TEXT,
  record_type_label TEXT,
  stage_name TEXT,
  opportunity_name TEXT,
  account_name TEXT,
  amount NUMERIC(14, 2),
  amount_currency TEXT,
  close_date DATE,
  commercial_region TEXT,
  opportunity_owner TEXT,
  -- Supporting attribution EVIDENCE only; never treated as a verified
  -- Sourced channel and never a default for approval.
  primary_campaign_source TEXT,
  sf_created_at TIMESTAMPTZ,
  -- Latest SystemModstamp/LastModifiedDate: incremental-sync watermark input.
  sf_last_modified_at TIMESTAMPTZ,
  content_hash TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ,
  -- True when the source record disappears from Salesforce; rows are never
  -- deleted here.
  source_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sf_opportunities_sf_id_unique UNIQUE (sf_opportunity_id)
);

CREATE INDEX IF NOT EXISTS idx_sf_opportunities_modified
  ON sf_opportunities (sf_last_modified_at);

-- =============================================================
-- 3. Append-only history events
-- =============================================================

CREATE TABLE IF NOT EXISTS sf_opportunity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: history must never be cascade-deleted by snapshot removal.
  sf_opportunity_uuid UUID NOT NULL
    REFERENCES sf_opportunities(id) ON DELETE RESTRICT,
  -- Denormalized for traceability alongside the internal FK.
  sf_opportunity_id TEXT NOT NULL CHECK (length(trim(sf_opportunity_id)) > 0),
  -- The event idempotency key. Exact duplicates are ignored by ingestion;
  -- a same-ID row with different content is a review conflict and must
  -- NEVER replace this row (no UPDATE-based upsert exists on this table).
  sf_history_id TEXT NOT NULL CHECK (length(trim(sf_history_id)) > 0),
  source_field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('record_type', 'stage', 'other')),
  -- Normalized states for the two ledgers. 'unknown' preserves unmapped
  -- source values as diagnostics; it can never silently become a visible
  -- funnel state (Bite 5A routes it to review).
  from_record_type_state TEXT
    CHECK (from_record_type_state IN ('hpp', 'opp', 'pursuit', 'out_of_scope', 'unknown')),
  to_record_type_state TEXT
    CHECK (to_record_type_state IN ('hpp', 'opp', 'pursuit', 'out_of_scope', 'unknown')),
  from_terminal_state TEXT
    CHECK (from_terminal_state IN ('open', 'won', 'lost', 'disqualified', 'nurture', 'unknown')),
  to_terminal_state TEXT
    CHECK (to_terminal_state IN ('open', 'won', 'lost', 'disqualified', 'nurture', 'unknown')),
  -- Salesforce history CreatedDate as a FULL timestamp with timezone.
  changed_at TIMESTAMPTZ NOT NULL,
  content_hash TEXT,
  sync_run_id UUID REFERENCES sf_opportunity_sync_runs(id) ON DELETE SET NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The History ID unique constraint doubles as its lookup index.
  CONSTRAINT sf_opportunity_events_history_id_unique UNIQUE (sf_history_id)
);

CREATE INDEX IF NOT EXISTS idx_sf_opportunity_events_opp_changed
  ON sf_opportunity_events (sf_opportunity_uuid, changed_at);
CREATE INDEX IF NOT EXISTS idx_sf_opportunity_events_kind
  ON sf_opportunity_events (event_kind);

-- Append-only enforcement: UPDATE and DELETE are rejected at the database
-- level, matching the schema's existing trigger convention. Shared by the
-- history ledger and the review audit trail below.
CREATE OR REPLACE FUNCTION sf_opportunity_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS append_only_sf_opportunity_events ON sf_opportunity_events;
CREATE TRIGGER append_only_sf_opportunity_events
  BEFORE UPDATE OR DELETE ON sf_opportunity_events
  FOR EACH ROW EXECUTE FUNCTION sf_opportunity_append_only();

-- =============================================================
-- 4. Salesforce-to-Sourced deal link
-- =============================================================

CREATE TABLE IF NOT EXISTS sf_opportunity_deal_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sf_opportunity_uuid UUID NOT NULL
    REFERENCES sf_opportunities(id) ON DELETE RESTRICT,
  -- attributions.deal_id is TEXT in this schema; the link stores the same
  -- type. No attribution row is created or modified by this bite.
  deal_id TEXT NOT NULL CHECK (length(trim(deal_id)) > 0),
  link_state TEXT NOT NULL DEFAULT 'active'
    CHECK (link_state IN ('active', 'retired')),
  -- exact_sf_opportunity_id is the ONLY automatic method. Name or account
  -- similarity may only ever produce a review suggestion, never a link.
  link_method TEXT NOT NULL
    CHECK (link_method IN ('exact_sf_opportunity_id', 'manual_review')),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Free-text placeholder until real authentication lands.
  linked_by TEXT,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1:1 while active, in both directions; retired rows stay for audit.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_deal_links_active_sf
  ON sf_opportunity_deal_links (sf_opportunity_uuid) WHERE link_state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_deal_links_active_deal
  ON sf_opportunity_deal_links (deal_id) WHERE link_state = 'active';

-- =============================================================
-- 5. Import-review inbox
-- =============================================================

CREATE TABLE IF NOT EXISTS sf_opportunity_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sf_opportunity_uuid UUID NOT NULL
    REFERENCES sf_opportunities(id) ON DELETE RESTRICT,
  review_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_state IN ('pending', 'approved', 'linked', 'ignored', 'blocked', 'resolved')),
  -- Constrained set, not free JSON: every code must be from the allowed
  -- list. Application-level meaning lives in opportunityImportStorage.ts.
  issue_codes TEXT[] NOT NULL DEFAULT '{}',
  CONSTRAINT sf_opportunity_reviews_issue_codes_valid CHECK (
    issue_codes <@ ARRAY[
      'missing_channel',
      'missing_region',
      'missing_required_field',
      'unknown_record_type',
      'unknown_stage_value',
      'conflicting_history_id',
      'ambiguous_same_timestamp',
      'incomplete_history',
      'possible_existing_deal',
      'invalid_source_row'
    ]::TEXT[]
  ),
  -- A channel selection is MANDATORY before approval (application-enforced;
  -- the column is nullable because pending rows have none yet). There is no
  -- default or fallback channel.
  channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
  -- Lead linking is OPTIONAL, matching the existing HPP contract.
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  -- Matches the attributions.bdr_name convention.
  bdr_name TEXT,
  reviewer_note TEXT,
  reviewed_at TIMESTAMPTZ,
  -- Free-text placeholder compatible with future SSO identities.
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sf_opportunity_reviews_one_per_opp UNIQUE (sf_opportunity_uuid)
);

CREATE INDEX IF NOT EXISTS idx_sf_opportunity_reviews_state
  ON sf_opportunity_reviews (review_state);

-- =============================================================
-- 6. Append-only review audit trail
-- =============================================================
-- sf_opportunity_reviews above is the mutable CURRENT projection; this
-- table is the permanent record of every meaningful review action. A
-- future authenticated review API must write the projection update and its
-- audit event together transactionally; the pure helpers in
-- src/lib/opportunityImportStorage.ts construct both as one result.

CREATE TABLE IF NOT EXISTS sf_opportunity_review_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL
    REFERENCES sf_opportunity_reviews(id) ON DELETE RESTRICT,
  sf_opportunity_uuid UUID NOT NULL
    REFERENCES sf_opportunities(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'review_created', 'issues_updated', 'state_transition',
    'approval_recorded', 'link_recorded', 'conflict_observed',
    'note_added', 'reopened'
  )),
  previous_state TEXT
    CHECK (previous_state IN ('pending', 'approved', 'linked', 'ignored', 'blocked', 'resolved')),
  new_state TEXT
    CHECK (new_state IN ('pending', 'approved', 'linked', 'ignored', 'blocked', 'resolved')),
  -- The issue codes in force when the action happened, same constrained set
  -- as the projection.
  issue_codes_snapshot TEXT[] NOT NULL DEFAULT '{}',
  CONSTRAINT sf_review_events_issue_codes_valid CHECK (
    issue_codes_snapshot <@ ARRAY[
      'missing_channel',
      'missing_region',
      'missing_required_field',
      'unknown_record_type',
      'unknown_stage_value',
      'conflicting_history_id',
      'ambiguous_same_timestamp',
      'incomplete_history',
      'possible_existing_deal',
      'invalid_source_row'
    ]::TEXT[]
  ),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'reviewer', 'ingestion')),
  -- Future SSO identity placeholder; free text until real auth exists.
  actor_id TEXT,
  -- Non-sensitive context only; never raw payloads or customer records.
  note TEXT,
  -- Evidence references: the Salesforce History ID involved and content
  -- hashes of the accepted versus conflicting versions. Hashes, not
  -- payloads, so audit rows carry no unnecessary PII.
  sf_history_id TEXT,
  accepted_content_hash TEXT,
  conflicting_content_hash TEXT,
  -- Optional idempotency key so the SAME ingestion conflict does not create
  -- a duplicate audit event on every nightly sync. Unique when present.
  dedupe_key TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_review_events_dedupe
  ON sf_opportunity_review_events (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sf_review_events_review_time
  ON sf_opportunity_review_events (review_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_sf_review_events_opp_time
  ON sf_opportunity_review_events (sf_opportunity_uuid, occurred_at);
CREATE INDEX IF NOT EXISTS idx_sf_review_events_type
  ON sf_opportunity_review_events (event_type);

DROP TRIGGER IF EXISTS append_only_sf_opportunity_review_events ON sf_opportunity_review_events;
CREATE TRIGGER append_only_sf_opportunity_review_events
  BEFORE UPDATE OR DELETE ON sf_opportunity_review_events
  FOR EACH ROW EXECUTE FUNCTION sf_opportunity_append_only();

-- =============================================================
-- updated_at triggers (existing schema convention)
-- =============================================================

DROP TRIGGER IF EXISTS set_timestamp_sf_opportunities ON sf_opportunities;
CREATE TRIGGER set_timestamp_sf_opportunities BEFORE UPDATE ON sf_opportunities
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

DROP TRIGGER IF EXISTS set_timestamp_sf_opportunity_deal_links ON sf_opportunity_deal_links;
CREATE TRIGGER set_timestamp_sf_opportunity_deal_links BEFORE UPDATE ON sf_opportunity_deal_links
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

DROP TRIGGER IF EXISTS set_timestamp_sf_opportunity_reviews ON sf_opportunity_reviews;
CREATE TRIGGER set_timestamp_sf_opportunity_reviews BEFORE UPDATE ON sf_opportunity_reviews
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

-- =============================================================
-- Row Level Security: enabled, NO policies on purpose
-- =============================================================
-- The browser anon key gets no access to any of these tables. The trusted
-- server-side/n8n ingestion identity uses the service role (bypasses RLS);
-- a future authenticated review API will add its own scoped policies in a
-- separate reviewed migration. Deliberately NOT added to the permissive
-- anon-policy loop and NOT added to the realtime publication.

ALTER TABLE sf_opportunity_sync_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_opportunities             ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_opportunity_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_opportunity_deal_links    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_opportunity_reviews       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_opportunity_review_events ENABLE ROW LEVEL SECURITY;

-- Done. Nothing above touches existing tables, rows, or policies.
