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
  market TEXT,
  -- Normalized review evidence derived only from the approved creator names.
  -- It never assigns a channel or approves attribution.
  suggested_bdr_name TEXT
    CHECK (suggested_bdr_name IN ('Dave Cummins', 'Garrett McNally')),
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
  -- Review-evidence columns (Bite 5C2A): raw values, source USER IDS, and
  -- the narrowly approved normalized BDR suggestion above. No canonical
  -- Industry Vertical field is chosen, and no Customer Expansion rule is
  -- applied.
  normalized_record_type_state TEXT
    CHECK (normalized_record_type_state IN ('hpp', 'opp', 'pursuit', 'out_of_scope', 'unknown')),
  is_closed BOOLEAN,
  is_won BOOLEAN,
  saas_revenue NUMERIC(14, 2),
  saas_revenue_usd NUMERIC(14, 2),
  customer_expansion_raw TEXT,
  sales_development_rep_user_id TEXT,
  created_by_user_id TEXT,
  insurance_vertical_raw TEXT,
  industry_vertical_raw TEXT,
  pursuit_industry_vertical_raw TEXT,
  gtm_cube TEXT,
  business_units TEXT,
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
  -- Reviewer-owned corrections. Nightly ingestion refreshes the source
  -- values on sf_opportunities and never writes these columns.
  market_override TEXT,
  commercial_region_override TEXT,
  gtm_cube_override TEXT,
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

-- =============================================================
-- Bite 5C2A: restricted staging-ingestion apply function
-- (docs/opportunity-staging-ingestion.md). Added by
-- migrations/2026-07-27_opportunity_ingestion_apply_fn.sql. SECURITY
-- DEFINER with search_path pinned to pg_catalog and schema-qualified
-- references; revoked from PUBLIC/anon/authenticated, EXECUTE only for
-- service_role. Run-row-first auditing (server-generated values only, so
-- the run row survives malformed payloads); concurrency-safe guarded
-- snapshot upsert (ON CONFLICT DO UPDATE ... WHERE newer); content-conflict
-- guards with complete null-safe audit-identity dedupe; watermarks persist
-- only on full-batch success; sanitized failure diagnostics (never
-- SQLERRM).
-- =============================================================

CREATE OR REPLACE FUNCTION public.sf_apply_opportunity_ingestion(
  p_snapshots JSONB DEFAULT '[]'::JSONB,
  p_events JSONB DEFAULT '[]'::JSONB,
  p_reviews JSONB DEFAULT '[]'::JSONB,
  p_run JSONB DEFAULT '{}'::JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_item JSONB;
  v_opp_uuid UUID;
  v_review_id UUID;
  v_run_id UUID;
  v_existing_stamp TIMESTAMPTZ;
  v_existing_hash TEXT;
  v_existing_state TEXT;
  v_audit JSONB;
  v_incoming_stamp TIMESTAMPTZ;
  v_snapshots_applied INTEGER := 0;
  v_snapshots_stale INTEGER := 0;
  v_events_inserted INTEGER := 0;
  v_events_idempotent INTEGER := 0;
  v_reviews_created INTEGER := 0;
  v_reviews_reconciled INTEGER := 0;
  v_reviews_updated INTEGER := 0;
  v_review_events_inserted INTEGER := 0;
  v_review_events_deduped INTEGER := 0;
  v_count INTEGER;
  v_sqlstate TEXT;
  v_category TEXT;
BEGIN
  -- The run row exists FIRST, built ONLY from server-generated values so
  -- it survives any malformed caller payload; every write of this
  -- invocation is traceable to it, success or failure.
  INSERT INTO public.sf_opportunity_sync_runs (source, started_at, status)
  VALUES ('salesforce', pg_catalog.now(), 'running')
  RETURNING id INTO v_run_id;

  BEGIN
    -- Caller-provided run metadata is validated/cast INSIDE the protected
    -- block: invalid values become a sanitized failed run, never a raw
    -- database error without a run row.
    UPDATE public.sf_opportunity_sync_runs SET
      started_at = COALESCE(NULLIF(p_run->>'started_at', '')::TIMESTAMPTZ, started_at),
      rows_discovered = COALESCE((p_run->>'rows_discovered')::INTEGER, 0)
    WHERE id = v_run_id;
    -- 1. Snapshot upserts, CONCURRENCY-SAFE: one guarded statement is the
    -- authority (no unlocked pre-check). The ON CONFLICT DO UPDATE's WHERE
    -- clause allows an update only when the incoming source timestamp is
    -- strictly newer; the conflict arbitration locks the existing row, so
    -- the post-inspection below reads a stable row even under concurrent
    -- invocations, and an older value can never overwrite a newer row.
    FOR v_item IN SELECT * FROM pg_catalog.jsonb_array_elements(COALESCE(p_snapshots, '[]'::JSONB)) LOOP
      v_incoming_stamp := NULLIF(v_item->>'sf_last_modified_at', '')::TIMESTAMPTZ;
      IF v_incoming_stamp IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'SF006',
          MESSAGE = 'snapshot missing source modification timestamp';
      END IF;
      INSERT INTO public.sf_opportunities (
        sf_opportunity_id, record_type_developer_name, record_type_label,
        normalized_record_type_state, stage_name, is_closed, is_won,
        opportunity_name, account_name, amount, amount_currency,
        saas_revenue, saas_revenue_usd, close_date, commercial_region,
        opportunity_owner, primary_campaign_source, customer_expansion_raw,
        sales_development_rep_user_id, created_by_user_id,
        insurance_vertical_raw, industry_vertical_raw,
        pursuit_industry_vertical_raw, gtm_cube, business_units,
        sf_created_at, sf_last_modified_at, content_hash,
        last_seen_at, last_synced_at
      ) VALUES (
        v_item->>'sf_opportunity_id',
        v_item->>'record_type_developer_name',
        v_item->>'record_type_label',
        v_item->>'normalized_record_type_state',
        v_item->>'stage_name',
        (v_item->>'is_closed')::BOOLEAN,
        (v_item->>'is_won')::BOOLEAN,
        v_item->>'opportunity_name',
        v_item->>'account_name',
        NULLIF(v_item->>'amount', '')::NUMERIC,
        v_item->>'amount_currency',
        NULLIF(v_item->>'saas_revenue', '')::NUMERIC,
        NULLIF(v_item->>'saas_revenue_usd', '')::NUMERIC,
        NULLIF(v_item->>'close_date', '')::DATE,
        v_item->>'commercial_region',
        v_item->>'opportunity_owner',
        v_item->>'primary_campaign_source',
        v_item->>'customer_expansion_raw',
        v_item->>'sales_development_rep_user_id',
        v_item->>'created_by_user_id',
        v_item->>'insurance_vertical_raw',
        v_item->>'industry_vertical_raw',
        v_item->>'pursuit_industry_vertical_raw',
        v_item->>'gtm_cube',
        v_item->>'business_units',
        NULLIF(v_item->>'sf_created_at', '')::TIMESTAMPTZ,
        v_incoming_stamp,
        v_item->>'content_hash',
        pg_catalog.now(), pg_catalog.now()
      )
      ON CONFLICT (sf_opportunity_id) DO UPDATE SET
        record_type_developer_name = EXCLUDED.record_type_developer_name,
        record_type_label = EXCLUDED.record_type_label,
        normalized_record_type_state = EXCLUDED.normalized_record_type_state,
        stage_name = EXCLUDED.stage_name,
        is_closed = EXCLUDED.is_closed,
        is_won = EXCLUDED.is_won,
        opportunity_name = EXCLUDED.opportunity_name,
        account_name = EXCLUDED.account_name,
        amount = EXCLUDED.amount,
        amount_currency = EXCLUDED.amount_currency,
        saas_revenue = EXCLUDED.saas_revenue,
        saas_revenue_usd = EXCLUDED.saas_revenue_usd,
        close_date = EXCLUDED.close_date,
        commercial_region = EXCLUDED.commercial_region,
        opportunity_owner = EXCLUDED.opportunity_owner,
        primary_campaign_source = EXCLUDED.primary_campaign_source,
        customer_expansion_raw = EXCLUDED.customer_expansion_raw,
        sales_development_rep_user_id = EXCLUDED.sales_development_rep_user_id,
        created_by_user_id = EXCLUDED.created_by_user_id,
        insurance_vertical_raw = EXCLUDED.insurance_vertical_raw,
        industry_vertical_raw = EXCLUDED.industry_vertical_raw,
        pursuit_industry_vertical_raw = EXCLUDED.pursuit_industry_vertical_raw,
        gtm_cube = EXCLUDED.gtm_cube,
        business_units = EXCLUDED.business_units,
        sf_created_at = EXCLUDED.sf_created_at,
        sf_last_modified_at = EXCLUDED.sf_last_modified_at,
        content_hash = EXCLUDED.content_hash,
        last_seen_at = pg_catalog.now(),
        last_synced_at = pg_catalog.now()
      WHERE public.sf_opportunities.sf_last_modified_at IS NULL
         OR public.sf_opportunities.sf_last_modified_at < EXCLUDED.sf_last_modified_at;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      IF v_count = 1 THEN
        v_snapshots_applied := v_snapshots_applied + 1;
      ELSE
        -- No insert or update happened: inspect the (conflict-locked)
        -- current row to classify the outcome.
        SELECT sf_last_modified_at, content_hash INTO v_existing_stamp, v_existing_hash
          FROM public.sf_opportunities
          WHERE sf_opportunity_id = v_item->>'sf_opportunity_id';
        IF v_existing_stamp IS NOT NULL AND v_existing_stamp > v_incoming_stamp THEN
          v_snapshots_stale := v_snapshots_stale + 1; -- stale data can never overwrite newer staged data
        ELSIF v_existing_hash = v_item->>'content_hash' THEN
          NULL; -- identical timestamp and content: idempotent no-op
        ELSE
          RAISE EXCEPTION USING ERRCODE = 'SF002',
            MESSAGE = 'snapshot content differs at an identical source timestamp';
        END IF;
      END IF;
    END LOOP;

    -- 2. Append-only history events with content verification. A plain
    -- INSERT follows the check so a true race surfaces as a unique
    -- violation and fails the batch instead of being silently skipped.
    FOR v_item IN SELECT * FROM pg_catalog.jsonb_array_elements(COALESCE(p_events, '[]'::JSONB)) LOOP
      SELECT id INTO v_opp_uuid FROM public.sf_opportunities
        WHERE sf_opportunity_id = v_item->>'sf_opportunity_id';
      IF v_opp_uuid IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'SF001',
          MESSAGE = 'event references an unknown staged opportunity';
      END IF;
      SELECT content_hash INTO v_existing_hash FROM public.sf_opportunity_events
        WHERE sf_history_id = v_item->>'sf_history_id';
      IF FOUND THEN
        IF v_existing_hash IS NOT NULL AND v_existing_hash = v_item->>'content_hash' THEN
          v_events_idempotent := v_events_idempotent + 1;
          CONTINUE; -- identical canonical content: idempotent no-op
        END IF;
        RAISE EXCEPTION USING ERRCODE = 'SF003',
          MESSAGE = 'history event content differs for an existing history id';
      END IF;
      INSERT INTO public.sf_opportunity_events (
        sf_opportunity_uuid, sf_opportunity_id, sf_history_id, source_field,
        old_value, new_value, event_kind,
        from_record_type_state, to_record_type_state,
        from_terminal_state, to_terminal_state,
        changed_at, content_hash, sync_run_id
      ) VALUES (
        v_opp_uuid,
        v_item->>'sf_opportunity_id',
        v_item->>'sf_history_id',
        v_item->>'source_field',
        v_item->>'old_value',
        v_item->>'new_value',
        v_item->>'event_kind',
        v_item->>'from_record_type_state',
        v_item->>'to_record_type_state',
        v_item->>'from_terminal_state',
        v_item->>'to_terminal_state',
        (v_item->>'changed_at')::TIMESTAMPTZ,
        v_item->>'content_hash',
        v_run_id
      );
      v_events_inserted := v_events_inserted + 1;
    END LOOP;

    -- 3. Reviews with their coupled audit events. Each item carries an
    -- ARRAY of audit events because one observation can require several
    -- coupled ledger entries (for example review_created PLUS
    -- conflict_observed, or issues_updated PLUS conflict_observed), and an
    -- 'audit_only' item records conflict evidence on an existing review
    -- whose issue codes did not change.
    FOR v_item IN SELECT * FROM pg_catalog.jsonb_array_elements(COALESCE(p_reviews, '[]'::JSONB)) LOOP
      SELECT id INTO v_opp_uuid FROM public.sf_opportunities
        WHERE sf_opportunity_id = v_item->>'sf_opportunity_id';
      IF v_opp_uuid IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'SF001',
          MESSAGE = 'review references an unknown staged opportunity';
      END IF;

      IF v_item->>'kind' = 'create' THEN
        INSERT INTO public.sf_opportunity_reviews (sf_opportunity_uuid, review_state, issue_codes)
        VALUES (
          v_opp_uuid, 'pending',
          ARRAY(SELECT pg_catalog.jsonb_array_elements_text(COALESCE(v_item->'issue_codes', '[]'::JSONB)))
        )
        ON CONFLICT (sf_opportunity_uuid) DO NOTHING;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        IF v_count = 0 THEN
          -- Race: a review already exists. Verify compatibility and skip
          -- BOTH the insert and ALL coupled audit events; a false
          -- review_created (or its companions) must never be recorded
          -- against an older review.
          SELECT review_state INTO v_existing_state FROM public.sf_opportunity_reviews
            WHERE sf_opportunity_uuid = v_opp_uuid;
          IF v_existing_state IS DISTINCT FROM 'pending' THEN
            RAISE EXCEPTION USING ERRCODE = 'SF005',
              MESSAGE = 'review create raced a non-pending review';
          END IF;
          v_reviews_reconciled := v_reviews_reconciled + 1;
          CONTINUE;
        END IF;
        v_reviews_created := v_reviews_created + 1;
      ELSIF v_item->>'kind' = 'update_issues' THEN
        -- Touch ONLY issue_codes, and ONLY on the expected pending row.
        UPDATE public.sf_opportunity_reviews SET
          issue_codes = ARRAY(SELECT pg_catalog.jsonb_array_elements_text(COALESCE(v_item->'issue_codes', '[]'::JSONB)))
        WHERE sf_opportunity_uuid = v_opp_uuid AND review_state = 'pending';
        GET DIAGNOSTICS v_count = ROW_COUNT;
        IF v_count = 0 THEN
          -- Zero rows means the pending expectation failed (a human decided
          -- meanwhile). Never emit the issues_updated audit event.
          RAISE EXCEPTION USING ERRCODE = 'SF005',
            MESSAGE = 'issues update expected a pending review';
        END IF;
        v_reviews_updated := v_reviews_updated + 1;
      ELSIF v_item->>'kind' = 'audit_only' THEN
        -- No projection change: attach conflict evidence to the existing
        -- review. The review must exist; nothing on it is modified.
        SELECT review_state INTO v_existing_state FROM public.sf_opportunity_reviews
          WHERE sf_opportunity_uuid = v_opp_uuid;
        IF NOT FOUND THEN
          RAISE EXCEPTION USING ERRCODE = 'SF005',
            MESSAGE = 'audit-only item expected an existing review';
        END IF;
      ELSE
        RAISE EXCEPTION USING ERRCODE = 'SF007',
          MESSAGE = 'unknown review operation kind';
      END IF;

      SELECT r.id INTO v_review_id FROM public.sf_opportunity_reviews r
        WHERE r.sf_opportunity_uuid = v_opp_uuid;

      -- The coupled audit events, dedupe-verified against the COMPLETE
      -- canonical audit identity: event_type, previous/new state, issue
      -- codes snapshot, actor, History Id, accepted/conflicting content
      -- hashes, and note, all with null-safe equality. occurred_at is
      -- deliberately EXCLUDED: it is observation metadata, and under the
      -- documented idempotency policy the first observation wins. An
      -- existing dedupe key with identical identity is an idempotent skip;
      -- ANY differing field fails rather than being silently ignored.
      FOR v_audit IN SELECT * FROM pg_catalog.jsonb_array_elements(COALESCE(v_item->'audits', '[]'::JSONB)) LOOP
        PERFORM 1 FROM public.sf_opportunity_review_events e
          WHERE e.dedupe_key = v_audit->>'dedupe_key' AND v_audit->>'dedupe_key' IS NOT NULL;
        IF FOUND THEN
          PERFORM 1 FROM public.sf_opportunity_review_events e
            WHERE e.dedupe_key = v_audit->>'dedupe_key'
              AND e.event_type IS NOT DISTINCT FROM v_audit->>'event_type'
              AND e.previous_state IS NOT DISTINCT FROM v_audit->>'previous_state'
              AND e.new_state IS NOT DISTINCT FROM v_audit->>'new_state'
              AND e.issue_codes_snapshot IS NOT DISTINCT FROM ARRAY(SELECT pg_catalog.jsonb_array_elements_text(COALESCE(v_audit->'issue_codes_snapshot', '[]'::JSONB)))
              AND e.actor_type IS NOT DISTINCT FROM v_audit->>'actor_type'
              AND e.actor_id IS NOT DISTINCT FROM v_audit->>'actor_id'
              AND e.sf_history_id IS NOT DISTINCT FROM v_audit->>'sf_history_id'
              AND e.accepted_content_hash IS NOT DISTINCT FROM v_audit->>'accepted_content_hash'
              AND e.conflicting_content_hash IS NOT DISTINCT FROM v_audit->>'conflicting_content_hash'
              AND e.note IS NOT DISTINCT FROM v_audit->>'note';
          IF FOUND THEN
            v_review_events_deduped := v_review_events_deduped + 1;
            CONTINUE;
          END IF;
          RAISE EXCEPTION USING ERRCODE = 'SF004',
            MESSAGE = 'audit event content differs for an existing dedupe key';
        END IF;
        INSERT INTO public.sf_opportunity_review_events (
          review_id, sf_opportunity_uuid, event_type, previous_state, new_state,
          issue_codes_snapshot, actor_type, actor_id, note,
          sf_history_id, accepted_content_hash, conflicting_content_hash,
          dedupe_key, occurred_at
        ) VALUES (
          v_review_id, v_opp_uuid,
          v_audit->>'event_type',
          v_audit->>'previous_state',
          v_audit->>'new_state',
          ARRAY(SELECT pg_catalog.jsonb_array_elements_text(COALESCE(v_audit->'issue_codes_snapshot', '[]'::JSONB))),
          v_audit->>'actor_type',
          v_audit->>'actor_id',
          v_audit->>'note',
          v_audit->>'sf_history_id',
          v_audit->>'accepted_content_hash',
          v_audit->>'conflicting_content_hash',
          v_audit->>'dedupe_key',
          (v_audit->>'occurred_at')::TIMESTAMPTZ
        );
        v_review_events_inserted := v_review_events_inserted + 1;
      END LOOP;
    END LOOP;

    -- 4. Complete success: the SAME run row gains completed status and the
    -- watermarks (status: completed only when every operation succeeded).
    UPDATE public.sf_opportunity_sync_runs SET
      completed_at = pg_catalog.now(),
      status = 'completed',
      watermark_system_modstamp = NULLIF(p_run->>'watermark_system_modstamp', '')::TIMESTAMPTZ,
      watermark_history_created_at = NULLIF(p_run->>'watermark_history_created_at', '')::TIMESTAMPTZ,
      rows_accepted = v_events_inserted,
      duplicates_ignored = v_events_idempotent,
      conflicts = COALESCE((p_run->>'conflicts')::INTEGER, 0),
      sent_to_review = v_reviews_created
    WHERE id = v_run_id;

    RETURN pg_catalog.jsonb_build_object(
      'ok', true,
      'sync_run_id', v_run_id,
      'snapshots_applied', v_snapshots_applied,
      'snapshots_stale_skipped', v_snapshots_stale,
      'events_inserted', v_events_inserted,
      'events_idempotent', v_events_idempotent,
      'reviews_created', v_reviews_created,
      'reviews_reconciled', v_reviews_reconciled,
      'reviews_updated', v_reviews_updated,
      'review_events_inserted', v_review_events_inserted,
      'review_events_deduped', v_review_events_deduped
    );
  EXCEPTION WHEN OTHERS THEN
    -- Every batch write rolls back to this block's savepoint. The SAME run
    -- row records the failure with NULL watermarks and a SANITIZED summary:
    -- SQLSTATE plus an allowlisted category. SQLERRM is never persisted or
    -- returned because engine messages can embed source values.
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
    v_category := CASE
      WHEN v_sqlstate = 'SF001' THEN 'unknown_staged_opportunity'
      WHEN v_sqlstate = 'SF002' THEN 'snapshot_timestamp_conflict'
      WHEN v_sqlstate = 'SF003' THEN 'event_content_conflict'
      WHEN v_sqlstate = 'SF004' THEN 'audit_dedupe_conflict'
      WHEN v_sqlstate = 'SF005' THEN 'review_reconciliation_failed'
      WHEN v_sqlstate = 'SF006' THEN 'invalid_source_timestamp'
      WHEN v_sqlstate = 'SF007' THEN 'unknown_operation_kind'
      WHEN pg_catalog.left(v_sqlstate, 2) = '23' THEN 'constraint_violation'
      WHEN pg_catalog.left(v_sqlstate, 2) = '22' THEN 'data_exception'
      ELSE 'other'
    END;
    UPDATE public.sf_opportunity_sync_runs SET
      completed_at = pg_catalog.now(),
      status = 'failed',
      error_summary = 'sqlstate=' || v_sqlstate || ' category=' || v_category
    WHERE id = v_run_id;
    RETURN pg_catalog.jsonb_build_object(
      'ok', false,
      'sync_run_id', v_run_id,
      'sqlstate', v_sqlstate,
      'category', v_category
    );
  END;
END;
$$;

-- Access boundary: server-side ingestion identity only.
REVOKE ALL ON FUNCTION public.sf_apply_opportunity_ingestion(JSONB, JSONB, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sf_apply_opportunity_ingestion(JSONB, JSONB, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.sf_apply_opportunity_ingestion(JSONB, JSONB, JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sf_apply_opportunity_ingestion(JSONB, JSONB, JSONB, JSONB) TO service_role;

-- Done. Adds evidence columns and one restricted function; writes no data.

-- =============================================================
-- Bite 4G2A: Salesforce lifecycle observation ledger
-- (docs/lead-lifecycle-observation-ledger.md). Added by
-- migrations/2026-08-04_lifecycle_observation_ledger.sql.
-- STATUS: Applied manually to production on 2026-08-04. Created structure
-- only; no lifecycle data was imported.
--
-- Seven tables recording lifecycle OBSERVATIONS going forward, because
-- Bite 4G1 proved the org holds zero lifecycle field history and
-- Salesforce never recreates it retroactively. The first observation of a
-- person is a BASELINE that invents no history; observations are stored on
-- change, with unchanged re-observations counted in the run diagnostics.
-- Observations and events are append-only by trigger; RLS is enabled with
-- NO policies (no browser access); the tables are deliberately excluded
-- from the anon-policy loop and from realtime.
-- =============================================================

-- =============================================================
-- 1. Sync runs (diagnostics + watermarks)
-- =============================================================

CREATE TABLE IF NOT EXISTS sf_lifecycle_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'salesforce' CHECK (source = 'salesforce'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'incomplete')),

  -- Two INDEPENDENT completeness axes: lifecycle extraction and converted
  -- identity extraction fail separately and must be judged separately.
  lifecycle_pages_expected INTEGER,
  lifecycle_pages_completed INTEGER,
  identity_pages_expected INTEGER,
  identity_pages_completed INTEGER,

  -- Watermark for the NEXT incremental run. Populated ONLY on a completed
  -- run; an incomplete or failed run leaves it NULL by contract.
  watermark_system_modstamp TIMESTAMPTZ,

  -- Aggregate diagnostics only. No names, emails, Salesforce Ids, or
  -- source rows are ever written here.
  rows_discovered INTEGER NOT NULL DEFAULT 0,
  lead_records INTEGER NOT NULL DEFAULT 0,
  contact_records INTEGER NOT NULL DEFAULT 0,
  baselines INTEGER NOT NULL DEFAULT 0,
  changes INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  lead_to_mql INTEGER NOT NULL DEFAULT 0,
  mql_to_lead INTEGER NOT NULL DEFAULT 0,
  requalifications INTEGER NOT NULL DEFAULT 0,
  out_of_scope_observations INTEGER NOT NULL DEFAULT 0,
  unknown_values INTEGER NOT NULL DEFAULT 0,
  stale_rows INTEGER NOT NULL DEFAULT 0,
  exact_duplicates INTEGER NOT NULL DEFAULT 0,
  conflicting_rows INTEGER NOT NULL DEFAULT 0,
  identity_links_created INTEGER NOT NULL DEFAULT 0,
  identity_conflicts INTEGER NOT NULL DEFAULT 0,
  malformed_supporting_dates INTEGER NOT NULL DEFAULT 0,

  -- Sanitized failure summary (SQLSTATE + allowlisted category). Never
  -- SQLERRM, which can embed source values.
  error_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A watermark may exist ONLY on a completed run.
  CONSTRAINT sf_lifecycle_runs_watermark_requires_completion
    CHECK (watermark_system_modstamp IS NULL OR status = 'completed')
);

CREATE INDEX IF NOT EXISTS idx_sf_lifecycle_runs_status_started
  ON sf_lifecycle_sync_runs(status, started_at DESC);

-- =============================================================
-- 2. Canonical person
-- =============================================================

CREATE TABLE IF NOT EXISTS sf_lifecycle_persons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The run that first created this person, for provenance.
  created_by_sync_run_id UUID REFERENCES sf_lifecycle_sync_runs(id) ON DELETE RESTRICT
);

-- =============================================================
-- 3. Person aliases (the only identity home for Salesforce Ids)
-- =============================================================

CREATE TABLE IF NOT EXISTS sf_lifecycle_person_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL
    REFERENCES sf_lifecycle_persons(id) ON DELETE RESTRICT,
  source_object TEXT NOT NULL CHECK (source_object IN ('Lead', 'Contact')),
  -- Salesforce record Id: SERVER-SIDE EVIDENCE ONLY. Never exposed to a
  -- browser-facing API in this bite.
  source_record_id TEXT NOT NULL CHECK (length(trim(source_record_id)) > 0),
  -- How this alias was established. 'converted_contact_id' is the ONLY
  -- automatic link: an exact Salesforce relationship. Name, email,
  -- company, and similarity matching are forbidden by contract.
  link_basis TEXT NOT NULL DEFAULT 'source_record'
    CHECK (link_basis IN ('source_record', 'converted_contact_id', 'manual_review')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_sync_run_id UUID REFERENCES sf_lifecycle_sync_runs(id) ON DELETE RESTRICT,

  -- One Salesforce record maps to exactly one canonical person.
  CONSTRAINT sf_lifecycle_alias_source_unique UNIQUE (source_object, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_sf_lifecycle_aliases_person
  ON sf_lifecycle_person_aliases(person_id);

-- =============================================================
-- 4. Observations (APPEND-ONLY)
-- =============================================================

CREATE TABLE IF NOT EXISTS sf_lifecycle_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL
    REFERENCES sf_lifecycle_persons(id) ON DELETE RESTRICT,
  source_object TEXT NOT NULL CHECK (source_object IN ('Lead', 'Contact')),
  source_record_id TEXT NOT NULL CHECK (length(trim(source_record_id)) > 0),

  -- The raw Salesforce picklist value exactly as received, and the
  -- normalized state derived from the Bite 4G1 approved map. 'unknown'
  -- means the value is absent from that map: preserved as evidence and
  -- routed to review, never guessed.
  raw_lifecycle_value TEXT,
  normalized_state TEXT NOT NULL
    CHECK (normalized_state IN ('lead', 'mql', 'out_of_scope', 'unknown')),

  -- Source timestamp (SystemModstamp / LastModifiedDate) and the n8n
  -- observation timestamp. Both full timestamptz.
  source_modified_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,

  -- Canonical fingerprint of the lifecycle-bearing content. Same source
  -- timestamp + same fingerprint is an idempotent no-op; same timestamp +
  -- different fingerprint is a conflict routed to review.
  content_fingerprint TEXT NOT NULL CHECK (length(trim(content_fingerprint)) > 0),

  -- Salesforce provided no lifecycle history (Bite 4G1), so observations
  -- are 'n8n_observed'. 'salesforce_confirmed' is reserved for the day
  -- field history exists and would outrank observations from its
  -- activation date forward.
  provenance TEXT NOT NULL DEFAULT 'n8n_observed'
    CHECK (provenance IN ('n8n_observed', 'salesforce_confirmed')),

  -- TRUE only for the first observation of a person: a baseline that
  -- asserts current standing and invents no history.
  is_baseline BOOLEAN NOT NULL DEFAULT FALSE,

  -- Supporting evidence ONLY. These never create or rewrite an event.
  became_lead_date DATE,
  became_mql_date DATE,

  sync_run_id UUID REFERENCES sf_lifecycle_sync_runs(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Deterministic idempotency: one observation per (record, source
  -- timestamp, content). Reprocessing the same extraction is a no-op.
  CONSTRAINT sf_lifecycle_observation_dedupe
    UNIQUE (source_object, source_record_id, source_modified_at, content_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_sf_lifecycle_observations_person
  ON sf_lifecycle_observations(person_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_sf_lifecycle_observations_run
  ON sf_lifecycle_observations(sync_run_id);

-- =============================================================
-- 5. Derived lifecycle events (APPEND-ONLY)
-- =============================================================

CREATE TABLE IF NOT EXISTS sf_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL
    REFERENCES sf_lifecycle_persons(id) ON DELETE RESTRICT,

  -- NULL from_state means a baseline (the first observation), not a
  -- transition. The Bite 4A calculator owns every non-baseline event.
  from_state TEXT CHECK (from_state IN ('lead', 'mql')),
  to_state TEXT NOT NULL CHECK (to_state IN ('lead', 'mql')),
  event_kind TEXT NOT NULL
    CHECK (event_kind IN ('baseline', 'transition', 'return', 'requalification')),

  -- The day the change is asserted to have happened, when a source
  -- supports one. NULL when only the observation day is known and the
  -- provenance says so.
  effective_date DATE,
  observed_at TIMESTAMPTZ NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'n8n_observed'
    CHECK (provenance IN ('n8n_observed', 'salesforce_confirmed', 'unknown')),

  -- The observation that evidenced this event.
  observation_id UUID REFERENCES sf_lifecycle_observations(id) ON DELETE RESTRICT,
  sync_run_id UUID REFERENCES sf_lifecycle_sync_runs(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A baseline has no from_state; every other kind must have one.
  CONSTRAINT sf_lifecycle_event_baseline_shape
    CHECK (
      (event_kind = 'baseline' AND from_state IS NULL)
      OR (event_kind <> 'baseline' AND from_state IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_sf_lifecycle_events_person
  ON sf_lifecycle_events(person_id, observed_at);

-- =============================================================
-- 6. Current projection (mutable, server-side apply only)
-- =============================================================

CREATE TABLE IF NOT EXISTS sf_lifecycle_state (
  person_id UUID PRIMARY KEY
    REFERENCES sf_lifecycle_persons(id) ON DELETE RESTRICT,
  normalized_state TEXT NOT NULL
    CHECK (normalized_state IN ('lead', 'mql', 'out_of_scope', 'unknown')),
  -- Whether 'mql' was ever observed, so a later Lead-to-MQL can be told
  -- apart as a requalification rather than a first conversion.
  mql_seen_before BOOLEAN NOT NULL DEFAULT FALSE,
  -- Newest source timestamp recorded, for stale-write protection.
  last_source_modified_at TIMESTAMPTZ,
  last_content_fingerprint TEXT,
  last_observed_at TIMESTAMPTZ NOT NULL,
  last_sync_run_id UUID REFERENCES sf_lifecycle_sync_runs(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================
-- 7. Reviewable issues
-- =============================================================

CREATE TABLE IF NOT EXISTS sf_lifecycle_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID REFERENCES sf_lifecycle_persons(id) ON DELETE RESTRICT,
  source_object TEXT CHECK (source_object IN ('Lead', 'Contact')),
  source_record_id TEXT,
  issue_kind TEXT NOT NULL CHECK (issue_kind IN (
    'unknown_lifecycle_value',
    'blank_lifecycle_value',
    'same_timestamp_content_conflict',
    'identity_conflict',
    'malformed_supporting_date',
    'reversed_supporting_dates',
    'duplicate_source_id_across_pages',
    'ambiguous_transition_sequence'
  )),
  review_state TEXT NOT NULL DEFAULT 'open'
    CHECK (review_state IN ('open', 'resolved', 'ignored')),
  detail TEXT,
  sync_run_id UUID REFERENCES sf_lifecycle_sync_runs(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sf_lifecycle_issues_open
  ON sf_lifecycle_issues(review_state, issue_kind);

-- =============================================================
-- 8. Append-only enforcement
-- =============================================================
-- Observations and events are the audit trail. Correcting one requires a
-- reviewed migration that drops the trigger, corrects, and recreates it;
-- that friction is the point.

CREATE OR REPLACE FUNCTION sf_lifecycle_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS append_only_sf_lifecycle_observations ON sf_lifecycle_observations;
CREATE TRIGGER append_only_sf_lifecycle_observations
  BEFORE UPDATE OR DELETE ON sf_lifecycle_observations
  FOR EACH ROW EXECUTE FUNCTION sf_lifecycle_append_only();

DROP TRIGGER IF EXISTS append_only_sf_lifecycle_events ON sf_lifecycle_events;
CREATE TRIGGER append_only_sf_lifecycle_events
  BEFORE UPDATE OR DELETE ON sf_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION sf_lifecycle_append_only();

-- =============================================================
-- Row Level Security: enabled, NO policies on purpose
-- =============================================================
-- The browser anon key gets no access to any of these tables. The future
-- writer is the trusted server-side ingestion identity (service role,
-- which bypasses RLS). Deliberately NOT added to the permissive
-- anon-policy loop and NOT added to the realtime publication.

ALTER TABLE sf_lifecycle_sync_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_lifecycle_persons        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_lifecycle_person_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_lifecycle_observations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_lifecycle_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_lifecycle_state          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_lifecycle_issues         ENABLE ROW LEVEL SECURITY;

-- Done. Nothing above touches existing tables, rows, or policies, and no
-- data is written by this migration.

-- =============================================================
-- Bite 4G2B1: lifecycle observation ledger, atomic apply boundary
-- (docs/lead-lifecycle-atomic-apply.md). Added by
-- migrations/2026-08-04_lifecycle_observation_apply_fn.sql.
-- STATUS: Applied manually to production on 2026-08-05. Verified through
-- direct catalog inspection: all seven sf_lifecycle_* tables exist with
-- RLS enabled, zero policies, and no supabase_realtime membership; all
-- three idempotency key columns and unique constraints exist; both
-- lifecycle functions are SECURITY DEFINER with search_path=pg_catalog
-- and executable only by service_role, not PUBLIC, anon, or
-- authenticated; both append-only triggers are enabled. All seven tables
-- contained zero rows, so this created structure only and imported no
-- lifecycle data. Bite 4G2B2 ingestion remains unstarted and inactive.
--
-- Three idempotency constraints the original 4G2A schema lacked, plus one
-- restricted function. The event key is the load-bearing one: without it
-- an exact retry would insert PERMANENT duplicate events through the
-- append-only trigger, inflating every transition, return, and
-- requalification count downstream.
--
-- The function applies ONE serialized batch atomically against ONLY the
-- seven sf_lifecycle_* tables. It writes no data by itself, imports
-- nothing, and backfills nothing. Ingestion (Bite 4G2B2) does not exist.
-- =============================================================

ALTER TABLE sf_lifecycle_events
  ADD COLUMN IF NOT EXISTS event_key TEXT;
ALTER TABLE sf_lifecycle_events
  ADD CONSTRAINT sf_lifecycle_event_key_unique UNIQUE (event_key);

ALTER TABLE sf_lifecycle_issues
  ADD COLUMN IF NOT EXISTS issue_key TEXT;
ALTER TABLE sf_lifecycle_issues
  ADD CONSTRAINT sf_lifecycle_issue_key_unique UNIQUE (issue_key);

ALTER TABLE sf_lifecycle_observations
  ADD COLUMN IF NOT EXISTS observation_key TEXT;
ALTER TABLE sf_lifecycle_observations
  ADD CONSTRAINT sf_lifecycle_observation_key_unique UNIQUE (observation_key);

-- public.sf_lifecycle_resolve_person(p_ref JSONB, p_handle_map JSONB)
--   RETURNS UUID
--
-- Typed person resolution. A reference states its own kind, so nothing is
-- guessed from an untyped string:
--   new_handle -> resolves ONLY through the batch handle map
--   person_id  -> an existing UUID, validated and confirmed to exist
--   alias      -> the COMPLETE (source_object, source_record_id) identity,
--                 so a Lead and a Contact sharing an id string can never
--                 collide through an id-only lookup
-- Returns NULL when unresolvable; callers raise a sanitized LC005.
--
-- public.sf_apply_lifecycle_observations(
--   p_run JSONB, p_persons JSONB, p_aliases JSONB, p_observations JSONB,
--   p_events JSONB, p_projections JSONB, p_issues JSONB
-- ) RETURNS JSONB
--
-- Applies one serialized batch atomically. The run row is inserted FIRST
-- from server-generated and constant values only, with every
-- caller-controlled cast and validation deferred into the protected block,
-- so a malformed payload still records exactly one failed run row instead
-- of aborting with none. Observation, event, and issue key conflicts
-- verify the COMPLETE canonical identity before being accepted as an exact
-- retry (sync_run_id and created_at excluded under first-observation-wins;
-- issues additionally exclude review_state and detail); differing content
-- raises LC002 and no version is chosen. The projection follows a full
-- ordering truth table in which undated evidence never overwrites a known
-- timestamp and an unprovable order with differing content is a conflict.
--
-- Validated by execution against PostgreSQL 15.18 in a disposable local
-- cluster (not production). Two defects were found and corrected there:
-- an exact retry raised a bogus LC003 because the invocation compared the
-- alias owner against a person the SAME invocation had just speculatively
-- created, and native cast failures (22007, 22P02) were categorized as
-- unexpected_error rather than malformed_payload.
--
-- Both functions: SECURITY DEFINER, SET search_path = pg_catalog, every
-- reference schema-qualified. Revoked from PUBLIC, anon, and
-- authenticated; EXECUTE granted only to service_role. See the migration
-- for the full body, the LC001..LC005 SQLSTATE vocabulary, and the
-- sanitized failure contract (SQLSTATE plus an allowlisted category,
-- never SQLERRM).

-- =============================================================
-- Salesforce CampaignMember daily apply boundary
-- =============================================================
-- Added by migrations/2026-08-11_sfdc_campaign_member_daily_apply.sql.
-- STATUS: Applied manually to production on 2026-08-11. Direct catalog
-- inspection verified postgres ownership, SECURITY DEFINER,
-- search_path=pg_catalog, no EXECUTE for PUBLIC/anon/authenticated, and
-- EXECUTE for service_role only. No CampaignMember batch was invoked and no
-- business data was imported by the migration itself. A separate controlled
-- first invocation on 2026-08-11 processed 2,614 eligible memberships and
-- inserted 2,614 child-campaign touches; 16 missing-email rows were excluded.
--
-- public.sourced_apply_sfdc_campaign_members(p_rows JSONB) RETURNS JSONB
--
-- Applies one fully reconciled CampaignMember batch atomically against
-- channels, leads, and lead_campaign_touches. CampaignMember ID is the
-- membership idempotency key. Exact Salesforce identity takes precedence
-- over normalized email, 15/18-character IDs match by the exact
-- case-sensitive 15-character prefix, and conflicting people fail closed.
-- Existing Marketing edit locks are preserved. The earliest campaign touch
-- remains the primary source unless locked. A person first observed as MQL
-- receives MQL history evidence while retaining the Lead cohort membership,
-- so fast conversion counts as Lead and MQL rather than MQL only.
--
-- SECURITY DEFINER with search_path=pg_catalog. PUBLIC, anon, and
-- authenticated cannot execute it; service_role is the only grantee. The
-- function creates no rows until invoked by the separately disabled n8n
-- workflow. See the migration for the executable body.

-- =============================================================
-- Salesforce CampaignMember legacy-import supersession
-- =============================================================
-- Added by
-- migrations/2026-08-11_sfdc_campaign_touch_import_supersession.sql.
-- STATUS: APPLIED MANUALLY TO PRODUCTION ON 2026-08-11.
-- Verified after application: zero remaining shadows, 2,614 authoritative n8n
-- touches, one intentionally unmatched legacy import, and trigger present.
--
-- An authoritative CampaignMember-keyed n8n touch supersedes an older ID-less
-- import touch only when both resolve to the same canonical person and exact
-- child channel. The production repair migration also removes existing proven
-- shadows; SCHEMA records only the permanent trigger structure.

CREATE OR REPLACE FUNCTION public.sourced_supersede_legacy_import_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user <> 'postgres' THEN
    RETURN NEW;
  END IF;
  IF NEW.source = 'n8n_sync'
     AND NEW.campaign_member_id IS NOT NULL
     AND NEW.channel_id IS NOT NULL THEN
    DELETE FROM public.lead_campaign_touches AS legacy
    WHERE legacy.id <> NEW.id
      AND legacy.source = 'import'
      AND legacy.campaign_member_id IS NULL
      AND legacy.lead_id = NEW.lead_id
      AND legacy.channel_id = NEW.channel_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sourced_supersede_legacy_import_touch() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sourced_supersede_legacy_import_touch() FROM anon;
REVOKE ALL ON FUNCTION public.sourced_supersede_legacy_import_touch() FROM authenticated;

DROP TRIGGER IF EXISTS trg_sourced_supersede_legacy_import_touch
  ON public.lead_campaign_touches;
CREATE TRIGGER trg_sourced_supersede_legacy_import_touch
AFTER INSERT OR UPDATE OF lead_id, channel_id, source, campaign_member_id
ON public.lead_campaign_touches
FOR EACH ROW
EXECUTE FUNCTION public.sourced_supersede_legacy_import_touch();

-- =============================================================
-- Opportunity daily-ingestion v2 contract
-- migrations/2026-08-12_opportunity_daily_ingestion_contract.sql
-- STATUS: PENDING / NOT APPLIED.
-- =============================================================
--
-- public.sf_apply_opportunity_ingestion_v2(JSONB, JSONB, JSONB, JSONB)
-- delegates the atomic planner payload to the applied v1 function, then
-- persists Market and the normalized BDR suggestion only when the accepted
-- source timestamp and content hash still match. The suggestion remains
-- review evidence and never writes source attribution or a channel.
-- public.sf_read_opportunity_ingestion_state() exposes only
-- the protected planner state needed for exact retry/stale/conflict checks.
-- Both are SECURITY DEFINER with search_path=pg_catalog, revoked from
-- PUBLIC/anon/authenticated, and executable only by service_role. See the
-- migration for the full function bodies. The reviewer-owned override
-- columns above are never written by ingestion.
