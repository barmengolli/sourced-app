-- 2026-07-24_opportunity_ledger_storage.sql
--
-- Bite 5B: storage for the Opportunity movement contract (Bite 5A,
-- docs/opportunity-stage-history-contract.md and
-- docs/opportunity-ledger-storage.md). Five new tables, no changes to any
-- existing table or row:
--
--   sf_opportunity_sync_runs   - import-run diagnostics and watermarks.
--   sf_opportunities           - latest Salesforce Opportunity snapshot,
--                                one row per Salesforce Opportunity ID.
--   sf_opportunity_events      - APPEND-ONLY Salesforce field-history
--                                events (record type + stage), idempotent
--                                on the Salesforce History ID.
--   sf_opportunity_deal_links  - at-most-one active mapping between a
--                                Salesforce Opportunity and an existing
--                                Sourced deal_id (attributions.deal_id).
--   sf_opportunity_reviews     - the import-review inbox: one row per
--                                Salesforce Opportunity needing a human
--                                decision before it can enter the funnel.
--
-- Deliberate properties:
--   - Forward-only and idempotent (IF NOT EXISTS everywhere); no DROP of
--     existing objects, no UPDATE/DELETE/INSERT against any existing table,
--     no attribution backfill, no automatic links, no live funnel writes.
--   - Derived HPP/Opportunity/Pursuit milestone dates are NOT stored: the
--     Bite 5A calculation remains the only path from events to milestones
--     and velocity.
--   - RLS is ENABLED on all five tables and NO policies are created, so the
--     browser anon key can neither read nor write them. Future writers are
--     the trusted server-side/n8n ingestion identity (service role, which
--     bypasses RLS) and a future authenticated review API with its own
--     scoped policies. These tables are intentionally NOT added to the
--     anon-policy loop or the realtime publication.
--   - sf_opportunity_events is enforced append-only by trigger (the same
--     trigger mechanism the schema already uses for timestamps). An
--     administrative correction requires a reviewed migration that drops
--     the trigger, corrects, and recreates it; that is intentional.
--
-- RUN ORDER: standalone, no dependencies on other pending migrations.
-- Apply manually in the Supabase SQL Editor (no migration runner is wired
-- into the app). NOT YET APPLIED.

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
-- level, matching the schema's existing trigger convention.
CREATE OR REPLACE FUNCTION sf_opportunity_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'sf_opportunity_events is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS append_only_sf_opportunity_events ON sf_opportunity_events;
CREATE TRIGGER append_only_sf_opportunity_events
  BEFORE UPDATE OR DELETE ON sf_opportunity_events
  FOR EACH ROW EXECUTE FUNCTION sf_opportunity_events_append_only();

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

ALTER TABLE sf_opportunity_sync_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_opportunities          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_opportunity_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_opportunity_deal_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE sf_opportunity_reviews    ENABLE ROW LEVEL SECURITY;

-- Done. Nothing above touches existing tables, rows, or policies.
