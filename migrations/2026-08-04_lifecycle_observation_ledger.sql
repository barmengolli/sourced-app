-- 2026-08-04_lifecycle_observation_ledger.sql
--
-- Bite 4G2A: storage for the lifecycle observation ledger
-- (docs/lead-lifecycle-observation-ledger.md). Seven new tables, no change
-- to any existing table or row:
--
--   sf_lifecycle_sync_runs        - one row per sync attempt: status, page
--                                   accounting, aggregate diagnostics, and
--                                   the watermark the run proposes.
--   sf_lifecycle_persons          - the canonical internal person. Carries
--                                   NO Salesforce identifier itself.
--   sf_lifecycle_person_aliases   - one row per Salesforce source record
--                                   (Lead or Contact) pointing at a
--                                   canonical person. The only place a
--                                   Salesforce Id lives as identity.
--   sf_lifecycle_observations     - APPEND-ONLY. The first baseline
--                                   observation per person plus every
--                                   materially changed observation.
--   sf_lifecycle_events           - APPEND-ONLY. Derived lifecycle events
--                                   (baseline, transition, return,
--                                   requalification).
--   sf_lifecycle_state            - the mutable CURRENT projection: one row
--                                   per person with their latest state.
--   sf_lifecycle_issues           - reviewable conflicts and ambiguities.
--
-- WHY THIS EXISTS: Bite 4G1 proved the Salesforce org holds ZERO
-- lifecycle-history rows for Hubspot_lead_lifecycle__c on both Lead and
-- Contact, and Salesforce never recreates field history retroactively. The
-- past is unrecoverable, so this ledger records observations going forward.
--
-- Deliberate properties:
--   - Forward-only and idempotent (IF NOT EXISTS everywhere). No DROP of
--     any existing object, no INSERT/UPDATE/DELETE against any existing
--     table, no backfill, no attribution change, no funnel write.
--   - The FIRST observation of a person is a BASELINE, never a transition.
--     It asserts where they stand now and invents no history. The planner
--     (src/lib/lifecycleObservationPlanner.ts) enforces this; the storage
--     records it via sf_lifecycle_observations.is_baseline.
--   - Observations are stored on CHANGE, not nightly. Unchanged
--     re-observations are counted in sf_lifecycle_sync_runs rather than
--     inserting an identical row per person per night.
--   - sf_lifecycle_observations and sf_lifecycle_events are enforced
--     append-only by trigger, using the same mechanism as the Bite 5B
--     opportunity ledger. An administrative correction requires a reviewed
--     migration that drops the trigger, corrects, and recreates it.
--   - Foreign keys use RESTRICT so nothing can delete a person or alias out
--     from under the audit trail. Nothing cascades from observations or
--     events.
--   - RLS is ENABLED on all seven tables with NO policies, so the browser
--     anon key can neither read nor write them. The future writer is the
--     trusted server-side ingestion identity (service role, bypasses RLS).
--     Deliberately NOT added to the permissive anon-policy loop and NOT
--     added to the realtime publication.
--   - Watermarks live only on a COMPLETED run row; a failed or incomplete
--     run can never advance one.
--
-- RUN ORDER: standalone, no dependencies on other pending migrations.
-- STATUS: Applied manually to production on 2026-08-04. Created structure
-- only; no lifecycle data was imported.

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

  -- NULL from_state means a baseline: the state the person was FIRST
  -- OBSERVED in, not movement into it. A (NULL -> 'mql') baseline means
  -- "first observed as MQL", NOT "observed moving from Lead to MQL":
  -- whatever happened before the baseline is unknown and stays unknown.
  -- Only a later observed change is a transition, return, or
  -- requalification, and the Bite 4A calculator owns all of those.
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
