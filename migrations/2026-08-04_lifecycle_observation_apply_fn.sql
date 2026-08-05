-- =============================================================
-- Bite 4G2B1: lifecycle observation ledger, atomic apply function
-- (docs/lead-lifecycle-atomic-apply.md)
--
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
-- Requires 2026-08-04_lifecycle_observation_ledger.sql (applied
-- 2026-08-04), which created the seven sf_lifecycle_* tables.
--
-- WHAT THIS DOES
--   Adds three forward-only idempotency constraints the applied 4G2A
--   schema lacks, then defines sf_apply_lifecycle_observations: a
--   restricted function that applies ONE serialized batch atomically
--   against ONLY the seven sf_lifecycle_* tables.
--
--   It writes no data by itself. Applying this migration creates
--   constraints and a function; it imports nothing, backfills nothing,
--   and touches no existing business table.
--
-- WHY THE THREE CONSTRAINTS ARE NEEDED (they are not cosmetic)
--   1. sf_lifecycle_events had NO unique constraint. Observations already
--      dedupe on (source_object, source_record_id, source_modified_at,
--      content_fingerprint), but events did not, so an exact retry of a
--      batch would insert duplicate events. Because events are append-only
--      by trigger, those duplicates would be PERMANENT and would inflate
--      every downstream transition, return, and requalification count.
--   2. sf_lifecycle_issues had no unique constraint, so the same
--      unresolved conflict re-observed nightly would append one row per
--      night forever.
--   3. sf_lifecycle_events.observation_id was nullable, so an event could
--      land with no audit path back to the evidence that produced it.
--      It stays nullable for the already-applied rows (there are none),
--      but this function never inserts an event without binding it.
--
-- SECURITY (mirrors the Bite 5C2A precedent)
--   SECURITY DEFINER with search_path pinned to pg_catalog and every
--   reference schema-qualified, so a hostile search_path cannot redirect
--   a write. Execution revoked from PUBLIC, anon, and authenticated;
--   granted only to service_role. The browser anon key cannot reach it,
--   and RLS on the seven tables remains enabled with zero policies.
--
-- ATOMICITY AND FAILURE
--   The whole batch succeeds or none of it does. On failure every
--   business write rolls back and exactly one failed run row survives,
--   carrying a NULL watermark and a SANITIZED diagnostic (SQLSTATE plus
--   an allowlisted category). SQLERRM is never persisted: it can embed
--   source values such as a lifecycle string or a Salesforce Id.
--
-- Custom SQLSTATEs raised by this function:
--   LC001  incomplete run refused (either extraction axis incomplete)
--   LC002  same source timestamp with different content (no winner chosen)
--   LC003  identity conflict (two existing people would have been merged)
--   LC004  malformed payload (missing or unusable required field)
--   LC005  unresolvable person handle
-- =============================================================

-- -------------------------------------------------------------
-- 1. Forward-only idempotency constraints
-- -------------------------------------------------------------

-- An event is identified by the observation that evidenced it plus its
-- direction and kind. This is what makes an exact retry a no-op instead
-- of a permanent duplicate.
ALTER TABLE public.sf_lifecycle_events
  ADD COLUMN IF NOT EXISTS event_key TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sf_lifecycle_event_key_unique'
  ) THEN
    ALTER TABLE public.sf_lifecycle_events
      ADD CONSTRAINT sf_lifecycle_event_key_unique UNIQUE (event_key);
  END IF;
END $$;

-- Issues dedupe on the EVIDENCE, not the run, so a standing unresolved
-- conflict is recorded once and re-observed silently.
ALTER TABLE public.sf_lifecycle_issues
  ADD COLUMN IF NOT EXISTS issue_key TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sf_lifecycle_issue_key_unique'
  ) THEN
    ALTER TABLE public.sf_lifecycle_issues
      ADD CONSTRAINT sf_lifecycle_issue_key_unique UNIQUE (issue_key);
  END IF;
END $$;

-- Observation keys are content-addressed by the serializer and agree with
-- the existing sf_lifecycle_observation_dedupe constraint by construction.
ALTER TABLE public.sf_lifecycle_observations
  ADD COLUMN IF NOT EXISTS observation_key TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sf_lifecycle_observation_key_unique'
  ) THEN
    ALTER TABLE public.sf_lifecycle_observations
      ADD CONSTRAINT sf_lifecycle_observation_key_unique UNIQUE (observation_key);
  END IF;
END $$;

-- -------------------------------------------------------------
-- 2. Atomic apply function
-- -------------------------------------------------------------

-- -------------------------------------------------------------
-- Typed person resolution helper.
--
-- A person reference states its own kind, so resolution is never a guess
-- from an untyped string:
--
--   new_handle -> resolves ONLY through this batch's handle map. A handle
--                 that is not in the map is an error, never a lookup.
--   person_id  -> an existing internal UUID, validated and loaded directly.
--   alias      -> the COMPLETE (source_object, source_record_id) identity.
--                 Never source_record_id alone, so a Lead and a Contact
--                 sharing an id string can never collide.
--
-- Returns NULL when the reference cannot be resolved. Callers turn that
-- into a sanitized LC005 and fail the batch; nothing is ever guessed.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sf_lifecycle_resolve_person(
  p_ref JSONB,
  p_handle_map JSONB
) RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $resolve$
DECLARE
  v_kind TEXT;
  v_id UUID;
BEGIN
  IF p_ref IS NULL OR jsonb_typeof(p_ref) <> 'object' THEN
    RETURN NULL;
  END IF;
  v_kind := p_ref ->> 'kind';

  IF v_kind = 'new_handle' THEN
    -- Batch-local only. No fallback to any table lookup.
    RETURN NULLIF(p_handle_map ->> (p_ref ->> 'handle'), '')::UUID;
  END IF;

  IF v_kind = 'person_id' THEN
    BEGIN
      v_id := (p_ref ->> 'personId')::UUID;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;  -- not a valid UUID: refuse rather than guess
    END;
    PERFORM 1 FROM public.sf_lifecycle_persons WHERE id = v_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    RETURN v_id;
  END IF;

  IF v_kind = 'alias' THEN
    -- COMPLETE identity: both columns, and no LIMIT, because the unique
    -- constraint already guarantees at most one row.
    SELECT person_id INTO v_id
    FROM public.sf_lifecycle_person_aliases
    WHERE source_object = (p_ref ->> 'sourceObject')
      AND source_record_id = (p_ref ->> 'sourceRecordId');
    RETURN v_id;
  END IF;

  RETURN NULL;
END;
$resolve$;

REVOKE ALL ON FUNCTION public.sf_lifecycle_resolve_person(JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sf_lifecycle_resolve_person(JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.sf_lifecycle_resolve_person(JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sf_lifecycle_resolve_person(JSONB, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.sf_apply_lifecycle_observations(
  p_run JSONB,
  p_persons JSONB,
  p_aliases JSONB,
  p_observations JSONB,
  p_events JSONB,
  p_projections JSONB,
  p_issues JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_run_id UUID;
  v_sync_run_id TEXT;
  v_started_at TIMESTAMPTZ;
  v_lc_expected INT;
  v_lc_completed INT;
  v_id_expected INT;
  v_id_completed INT;
  v_watermark TIMESTAMPTZ;
  v_lifecycle_complete BOOLEAN;
  v_identity_complete BOOLEAN;
  v_handle_map JSONB := '{}'::JSONB;
  v_rec RECORD;
  v_person_id UUID;
  v_existing_person UUID;
  v_obs_id UUID;
  v_obs_map JSONB := '{}'::JSONB;
  v_existing_state RECORD;
  v_existing_obs RECORD;
  v_existing_evt RECORD;
  v_existing_iss RECORD;
  v_counts JSONB := '{}'::JSONB;
  v_persons_created INT := 0;
  v_aliases_created INT := 0;
  v_observations_inserted INT := 0;
  v_events_inserted INT := 0;
  v_projections_updated INT := 0;
  v_issues_recorded INT := 0;
  v_sqlstate TEXT;
  v_category TEXT;
BEGIN
  -- ---------------------------------------------------------
  -- Run row GENUINELY first: server-generated and constant values ONLY.
  --
  -- Nothing caller-controlled is read, validated, or cast before this
  -- INSERT. That ordering is the whole point: a malformed payload (a
  -- blank syncRunId, an unparseable timestamp, a non-integer page count)
  -- must still leave exactly ONE run row recording the failed attempt.
  -- If any caller value were cast here, a bad cast would abort the
  -- function with zero rows and the attempt would vanish silently.
  --
  -- Page counts and started_at are corrected from the payload INSIDE the
  -- protected block below, once they have been safely validated.
  -- ---------------------------------------------------------
  INSERT INTO public.sf_lifecycle_sync_runs (
    status,
    started_at,
    lifecycle_pages_expected,
    lifecycle_pages_completed,
    identity_pages_expected,
    identity_pages_completed,
    watermark_system_modstamp
  ) VALUES (
    'running',
    pg_catalog.now(),
    0, 0, 0, 0,
    NULL
  )
  RETURNING id INTO v_run_id;

  BEGIN
    -- -------------------------------------------------------
    -- ALL caller-controlled validation and casting happens here, inside
    -- the protected block, so every failure below is recorded on the run
    -- row created above rather than aborting the function.
    -- -------------------------------------------------------
    v_sync_run_id := p_run ->> 'syncRunId';
    IF v_sync_run_id IS NULL OR btrim(v_sync_run_id) = '' THEN
      RAISE EXCEPTION USING ERRCODE = 'LC004',
        MESSAGE = 'payload missing syncRunId';
    END IF;

    -- Casts that can fail on malformed input, now safely inside the block.
    v_started_at := COALESCE((p_run ->> 'runStartedAt')::TIMESTAMPTZ, pg_catalog.now());
    v_lc_expected := COALESCE((p_run ->> 'lifecyclePagesExpected')::INT, 0);
    v_lc_completed := COALESCE((p_run ->> 'lifecyclePagesCompleted')::INT, 0);
    v_id_expected := COALESCE((p_run ->> 'identityPagesExpected')::INT, 0);
    v_id_completed := COALESCE((p_run ->> 'identityPagesCompleted')::INT, 0);

    UPDATE public.sf_lifecycle_sync_runs
    SET started_at = v_started_at,
        lifecycle_pages_expected = v_lc_expected,
        lifecycle_pages_completed = v_lc_completed,
        identity_pages_expected = v_id_expected,
        identity_pages_completed = v_id_completed
    WHERE id = v_run_id;
    -- -------------------------------------------------------
    -- Completeness gate. An incomplete run may never apply state.
    -- -------------------------------------------------------
    v_lifecycle_complete := COALESCE((p_run ->> 'lifecycleExtractionComplete')::BOOLEAN, FALSE);
    v_identity_complete  := COALESCE((p_run ->> 'identityExtractionComplete')::BOOLEAN, FALSE);

    IF NOT v_lifecycle_complete OR NOT v_identity_complete THEN
      RAISE EXCEPTION USING ERRCODE = 'LC001',
        MESSAGE = 'incomplete extraction: apply refused';
    END IF;

    -- -------------------------------------------------------
    -- Persons. The database assigns real UUIDs; temporary handles from
    -- the planner are mapped here and never stored in a column.
    -- Deterministic order (handle) avoids deadlocks between concurrent
    -- batches.
    -- -------------------------------------------------------
    FOR v_rec IN
      SELECT value ->> 'handle' AS handle
      FROM jsonb_array_elements(COALESCE(p_persons, '[]'::JSONB))
      ORDER BY 1
    LOOP
      IF v_rec.handle IS NULL OR btrim(v_rec.handle) = '' THEN
        RAISE EXCEPTION USING ERRCODE = 'LC004', MESSAGE = 'person handle missing';
      END IF;
      INSERT INTO public.sf_lifecycle_persons (created_by_sync_run_id)
      VALUES (v_run_id)
      RETURNING id INTO v_person_id;
      v_handle_map := jsonb_set(v_handle_map, ARRAY[v_rec.handle], to_jsonb(v_person_id::TEXT));
      v_persons_created := v_persons_created + 1;
    END LOOP;

    -- -------------------------------------------------------
    -- Aliases. Identity comes ONLY from an exact source record or an
    -- exact ConvertedContactId link. Never from a name, email, company,
    -- or similarity of any kind.
    --
    -- Race handling: the alias unique constraint is the authority, not an
    -- unlocked pre-read. On conflict we re-read the winner's person_id
    -- and adopt it. If that person differs from the one this batch was
    -- going to use, two existing people would be merged, which is
    -- unrecoverable, so the batch fails for human review instead.
    -- -------------------------------------------------------
    FOR v_rec IN
      SELECT value ->> 'personHandle' AS handle,
             value -> 'personRef' AS person_ref,
             value ->> 'sourceObject' AS source_object,
             value ->> 'sourceRecordId' AS source_record_id,
             value ->> 'linkBasis' AS link_basis
      FROM jsonb_array_elements(COALESCE(p_aliases, '[]'::JSONB))
      ORDER BY 2, 3
    LOOP
      -- Typed person resolution. NEVER an id-only lookup: a bare
      -- source_record_id could match a Lead and a Contact and LIMIT 1
      -- would pick an arbitrary winner, silently attaching evidence to
      -- the wrong person. The reference states its own kind.
      v_person_id := public.sf_lifecycle_resolve_person(v_rec.person_ref, v_handle_map);

      SELECT person_id INTO v_existing_person
      FROM public.sf_lifecycle_person_aliases
      WHERE source_object = v_rec.source_object
        AND source_record_id = v_rec.source_record_id
      FOR UPDATE;

      IF FOUND THEN
        -- The alias is already bound. Whether this is a conflict depends
        -- on what the batch's reference actually denotes:
        --
        --   new_handle -> this invocation speculatively minted a person
        --      for a record that turns out to already be linked, i.e. an
        --      EXACT RETRY. The minted person is not a second real
        --      person, so adopting the existing one is correct and the
        --      speculative row is discarded below. Treating this as a
        --      merge conflict would make every retry fail.
        --   person_id / alias -> the batch names a person that ALREADY
        --      existed before this invocation. If that differs from the
        --      alias owner, two real people would be merged, which is
        --      unrecoverable, so refuse.
        IF (v_rec.person_ref ->> 'kind') <> 'new_handle'
           AND v_person_id IS NOT NULL
           AND v_existing_person <> v_person_id THEN
          RAISE EXCEPTION USING ERRCODE = 'LC003',
            MESSAGE = 'identity conflict: refusing to merge two existing people';
        END IF;

        -- Adopt the established owner and discard the speculative person
        -- so a retry leaves no orphan behind.
        IF (v_rec.person_ref ->> 'kind') = 'new_handle'
           AND v_person_id IS NOT NULL
           AND v_person_id <> v_existing_person THEN
          DELETE FROM public.sf_lifecycle_persons
          WHERE id = v_person_id
            AND NOT EXISTS (
              SELECT 1 FROM public.sf_lifecycle_person_aliases a WHERE a.person_id = v_person_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.sf_lifecycle_observations o WHERE o.person_id = v_person_id
            );
          v_persons_created := v_persons_created - 1;
        END IF;

        v_person_id := v_existing_person;
        v_handle_map := jsonb_set(v_handle_map, ARRAY[v_rec.handle], to_jsonb(v_person_id::TEXT));
        CONTINUE;  -- already linked, idempotent
      END IF;

      IF v_person_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'LC005',
          MESSAGE = 'unresolvable person handle for alias';
      END IF;

      INSERT INTO public.sf_lifecycle_person_aliases
        (person_id, source_object, source_record_id, link_basis, created_by_sync_run_id)
      VALUES (v_person_id, v_rec.source_object, v_rec.source_record_id, v_rec.link_basis, v_run_id)
      ON CONFLICT ON CONSTRAINT sf_lifecycle_alias_source_unique DO NOTHING;

      IF NOT FOUND THEN
        -- Lost a race. Adopt the winner, or fail if it would merge people.
        SELECT person_id INTO v_existing_person
        FROM public.sf_lifecycle_person_aliases
        WHERE source_object = v_rec.source_object
          AND source_record_id = v_rec.source_record_id;
        IF (v_rec.person_ref ->> 'kind') <> 'new_handle'
           AND v_existing_person <> v_person_id THEN
          RAISE EXCEPTION USING ERRCODE = 'LC003',
            MESSAGE = 'identity conflict: concurrent alias resolves to a different person';
        END IF;
        -- Lost race on a speculative person: adopt the winner.
        v_person_id := v_existing_person;
        v_handle_map := jsonb_set(v_handle_map, ARRAY[v_rec.handle], to_jsonb(v_person_id::TEXT));
      ELSE
        v_aliases_created := v_aliases_created + 1;
      END IF;
    END LOOP;

    -- -------------------------------------------------------
    -- Observations. APPEND-ONLY: never updated, never deleted.
    --
    -- Exact retry (same key) is an idempotent no-op. Same source
    -- timestamp with DIFFERENT content is a conflict: the function
    -- refuses rather than choosing a winner.
    -- -------------------------------------------------------
    FOR v_rec IN
      SELECT value ->> 'observationKey' AS observation_key,
             value -> 'personRef' AS person_ref,
             value ->> 'personHandle' AS handle,
             value ->> 'sourceObject' AS source_object,
             value ->> 'sourceRecordId' AS source_record_id,
             value ->> 'rawLifecycleValue' AS raw_value,
             value ->> 'normalizedState' AS normalized_state,
             (value ->> 'sourceModifiedAt')::TIMESTAMPTZ AS source_modified_at,
             (value ->> 'observedAt')::TIMESTAMPTZ AS observed_at,
             value ->> 'contentFingerprint' AS content_fingerprint,
             value ->> 'provenance' AS provenance,
             (value ->> 'isBaseline')::BOOLEAN AS is_baseline,
             value ->> 'becameLeadDate' AS became_lead_date,
             value ->> 'becameMqlDate' AS became_mql_date
      FROM jsonb_array_elements(COALESCE(p_observations, '[]'::JSONB))
      ORDER BY 1
    LOOP
      v_person_id := public.sf_lifecycle_resolve_person(v_rec.person_ref, v_handle_map);
      IF v_person_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'LC005',
          MESSAGE = 'unresolvable person reference for observation';
      END IF;
      v_handle_map := jsonb_set(v_handle_map, ARRAY[v_rec.handle], to_jsonb(v_person_id::TEXT));

      -- Same source timestamp, different content: never auto-resolved.
      IF EXISTS (
        SELECT 1 FROM public.sf_lifecycle_observations o
        WHERE o.source_object = v_rec.source_object
          AND o.source_record_id = v_rec.source_record_id
          AND o.source_modified_at IS NOT DISTINCT FROM v_rec.source_modified_at
          AND o.content_fingerprint <> v_rec.content_fingerprint
      ) THEN
        RAISE EXCEPTION USING ERRCODE = 'LC002',
          MESSAGE = 'same source timestamp with different content';
      END IF;

      INSERT INTO public.sf_lifecycle_observations (
        observation_key, person_id, source_object, source_record_id,
        raw_lifecycle_value, normalized_state, source_modified_at,
        observed_at, content_fingerprint, provenance, is_baseline,
        became_lead_date, became_mql_date, sync_run_id
      ) VALUES (
        v_rec.observation_key, v_person_id, v_rec.source_object, v_rec.source_record_id,
        v_rec.raw_value, v_rec.normalized_state, v_rec.source_modified_at,
        v_rec.observed_at, v_rec.content_fingerprint, v_rec.provenance, v_rec.is_baseline,
        NULLIF(v_rec.became_lead_date, '')::DATE, NULLIF(v_rec.became_mql_date, '')::DATE,
        v_run_id
      )
      ON CONFLICT ON CONSTRAINT sf_lifecycle_observation_key_unique DO NOTHING
      RETURNING id INTO v_obs_id;

      IF v_obs_id IS NULL THEN
        -- Key already present. A matching key is NOT proof of a matching
        -- row, so verify the COMPLETE canonical identity with null-safe
        -- comparisons before treating this as an exact retry.
        --
        -- Deliberately EXCLUDED from canonical identity (first
        -- observation wins): sync_run_id and created_at. Those record
        -- WHICH run first saw the evidence, not what the evidence says,
        -- so a later run re-observing identical content must not be
        -- treated as a conflict.
        SELECT * INTO v_existing_obs
        FROM public.sf_lifecycle_observations
        WHERE observation_key = v_rec.observation_key
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION USING ERRCODE = 'LC004',
            MESSAGE = 'observation key conflict with no readable row';
        END IF;

        IF v_existing_obs.person_id           IS DISTINCT FROM v_person_id
           OR v_existing_obs.source_object     IS DISTINCT FROM v_rec.source_object
           OR v_existing_obs.source_record_id  IS DISTINCT FROM v_rec.source_record_id
           OR v_existing_obs.raw_lifecycle_value IS DISTINCT FROM v_rec.raw_value
           OR v_existing_obs.normalized_state  IS DISTINCT FROM v_rec.normalized_state
           OR v_existing_obs.source_modified_at IS DISTINCT FROM v_rec.source_modified_at
           OR v_existing_obs.content_fingerprint IS DISTINCT FROM v_rec.content_fingerprint
           OR v_existing_obs.provenance        IS DISTINCT FROM v_rec.provenance
           OR v_existing_obs.is_baseline       IS DISTINCT FROM v_rec.is_baseline
           OR v_existing_obs.became_lead_date  IS DISTINCT FROM NULLIF(v_rec.became_lead_date, '')::DATE
           OR v_existing_obs.became_mql_date   IS DISTINCT FROM NULLIF(v_rec.became_mql_date, '')::DATE
        THEN
          RAISE EXCEPTION USING ERRCODE = 'LC002',
            MESSAGE = 'observation key reused with different canonical content';
        END IF;

        -- Verified exact retry: adopt the existing row so events bind.
        -- The append-only row is NEVER updated.
        v_obs_id := v_existing_obs.id;
      ELSE
        v_observations_inserted := v_observations_inserted + 1;
      END IF;

      v_obs_map := jsonb_set(v_obs_map, ARRAY[v_rec.observation_key], to_jsonb(v_obs_id::TEXT));
    END LOOP;

    -- -------------------------------------------------------
    -- Events. APPEND-ONLY. Each is bound explicitly to the observation
    -- that evidenced it, never by position.
    --
    -- The baseline invariant is enforced here as well as by the table's
    -- shape constraint: a baseline has a NULL from_state, everything else
    -- must have one. A (NULL -> 'mql') baseline is preserved exactly and
    -- is never rewritten as (NULL -> 'lead') or reinterpreted as a
    -- transition.
    -- -------------------------------------------------------
    FOR v_rec IN
      SELECT value ->> 'eventKey' AS event_key,
             value -> 'personRef' AS person_ref,
             value ->> 'personHandle' AS handle,
             value ->> 'observationKey' AS observation_key,
             value ->> 'eventKind' AS event_kind,
             value ->> 'fromState' AS from_state,
             value ->> 'toState' AS to_state,
             value ->> 'effectiveDate' AS effective_date,
             (value ->> 'observedAt')::TIMESTAMPTZ AS observed_at,
             value ->> 'provenance' AS provenance
      FROM jsonb_array_elements(COALESCE(p_events, '[]'::JSONB))
      ORDER BY 1
    LOOP
      v_person_id := public.sf_lifecycle_resolve_person(v_rec.person_ref, v_handle_map);
      IF v_person_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'LC005',
          MESSAGE = 'unresolvable person reference for event';
      END IF;

      v_obs_id := NULLIF(v_obs_map ->> v_rec.observation_key, '')::UUID;
      IF v_obs_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'LC004',
          MESSAGE = 'event is not bound to an observation in this batch';
      END IF;

      IF v_rec.event_kind = 'baseline' AND v_rec.from_state IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'LC004',
          MESSAGE = 'baseline event carries a from_state';
      END IF;
      IF v_rec.event_kind <> 'baseline' AND v_rec.from_state IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'LC004',
          MESSAGE = 'non-baseline event is missing its from_state';
      END IF;

      INSERT INTO public.sf_lifecycle_events (
        event_key, person_id, from_state, to_state, event_kind,
        effective_date, observed_at, provenance, observation_id, sync_run_id
      ) VALUES (
        v_rec.event_key, v_person_id, v_rec.from_state, v_rec.to_state, v_rec.event_kind,
        NULLIF(v_rec.effective_date, '')::DATE, v_rec.observed_at, v_rec.provenance,
        v_obs_id, v_run_id
      )
      ON CONFLICT ON CONSTRAINT sf_lifecycle_event_key_unique DO NOTHING;

      IF FOUND THEN
        v_events_inserted := v_events_inserted + 1;
      ELSE
        -- Key present: verify the complete canonical identity before
        -- accepting this as an exact retry. sync_run_id and created_at
        -- are excluded (first observation wins). The append-only row is
        -- never updated either way.
        SELECT * INTO v_existing_evt
        FROM public.sf_lifecycle_events
        WHERE event_key = v_rec.event_key
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION USING ERRCODE = 'LC004',
            MESSAGE = 'event key conflict with no readable row';
        END IF;

        IF v_existing_evt.person_id      IS DISTINCT FROM v_person_id
           OR v_existing_evt.from_state   IS DISTINCT FROM v_rec.from_state
           OR v_existing_evt.to_state     IS DISTINCT FROM v_rec.to_state
           OR v_existing_evt.event_kind   IS DISTINCT FROM v_rec.event_kind
           OR v_existing_evt.effective_date IS DISTINCT FROM NULLIF(v_rec.effective_date, '')::DATE
           OR v_existing_evt.provenance   IS DISTINCT FROM v_rec.provenance
           OR v_existing_evt.observation_id IS DISTINCT FROM v_obs_id
        THEN
          RAISE EXCEPTION USING ERRCODE = 'LC002',
            MESSAGE = 'event key reused with different canonical content';
        END IF;
      END IF;
    END LOOP;

    -- -------------------------------------------------------
    -- Projection. The ONLY mutable table. Stale evidence can never
    -- overwrite newer state: the guard is a strictly-newer comparison
    -- under a row lock, not an unlocked read.
    -- -------------------------------------------------------
    FOR v_rec IN
      SELECT value ->> 'personHandle' AS handle,
             value -> 'personRef' AS person_ref,
             value ->> 'normalizedState' AS normalized_state,
             (value ->> 'mqlSeenBefore')::BOOLEAN AS mql_seen_before,
             (value ->> 'sourceModifiedAt')::TIMESTAMPTZ AS source_modified_at,
             value ->> 'contentFingerprint' AS content_fingerprint,
             (value ->> 'observedAt')::TIMESTAMPTZ AS observed_at
      FROM jsonb_array_elements(COALESCE(p_projections, '[]'::JSONB))
      ORDER BY 1
    LOOP
      v_person_id := public.sf_lifecycle_resolve_person(v_rec.person_ref, v_handle_map);
      IF v_person_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'LC005',
          MESSAGE = 'unresolvable person reference for projection';
      END IF;

      SELECT * INTO v_existing_state
      FROM public.sf_lifecycle_state
      WHERE person_id = v_person_id
      FOR UPDATE;

      IF NOT FOUND THEN
        INSERT INTO public.sf_lifecycle_state (
          person_id, normalized_state, mql_seen_before,
          last_source_modified_at, last_content_fingerprint,
          last_observed_at, last_sync_run_id
        ) VALUES (
          v_person_id, v_rec.normalized_state, COALESCE(v_rec.mql_seen_before, FALSE),
          v_rec.source_modified_at, v_rec.content_fingerprint,
          v_rec.observed_at, v_run_id
        );
        v_projections_updated := v_projections_updated + 1;
      -- Ordering truth table. Undated evidence proves LESS than dated
      -- evidence, so it may never overwrite a known timestamp, and two
      -- rows whose order cannot be proven are a conflict rather than a
      -- silent last-writer-wins. Comparisons are on TIMESTAMPTZ instants,
      -- so '+0000' and 'Z' are the same moment.
      --
      --   existing known, incoming older      -> stale no-op
      --   existing known, incoming NULL       -> no-op (never overwrite)
      --   existing NULL,  incoming known      -> accept
      --   both known, incoming newer          -> accept
      --   same instant, same fingerprint      -> idempotent no-op
      --   same instant, different fingerprint -> LC002 conflict
      --   both NULL, same fingerprint         -> idempotent no-op
      --   both NULL, different fingerprint    -> LC002 conflict
      ELSIF v_rec.source_modified_at IS NOT DISTINCT FROM v_existing_state.last_source_modified_at THEN
        -- Same instant (or both undated): order cannot break the tie, so
        -- content decides. Identical content is an idempotent no-op;
        -- different content is a conflict with NO winner chosen.
        IF v_rec.content_fingerprint IS DISTINCT FROM v_existing_state.last_content_fingerprint THEN
          RAISE EXCEPTION USING ERRCODE = 'LC002',
            MESSAGE = 'projection: indistinguishable ordering with differing content';
        END IF;
        -- identical: no-op
      ELSIF v_rec.source_modified_at IS NULL THEN
        -- Undated incoming against a KNOWN existing timestamp: no-op.
        NULL;
      ELSIF v_existing_state.last_source_modified_at IS NULL
         OR v_rec.source_modified_at > v_existing_state.last_source_modified_at THEN
        UPDATE public.sf_lifecycle_state
        SET normalized_state = v_rec.normalized_state,
            -- Once mql has been seen it stays seen: a later Lead-to-MQL
            -- is a requalification, not a first conversion.
            mql_seen_before = v_existing_state.mql_seen_before
                              OR COALESCE(v_rec.mql_seen_before, FALSE),
            -- Non-NULL on this branch by the guard above.
            last_source_modified_at = v_rec.source_modified_at,
            last_content_fingerprint = v_rec.content_fingerprint,
            last_observed_at = v_rec.observed_at,
            last_sync_run_id = v_run_id,
            updated_at = now()
        WHERE person_id = v_person_id;
        v_projections_updated := v_projections_updated + 1;
      END IF;
      -- Otherwise the incoming evidence is stale: no-op, by design.
    END LOOP;

    -- -------------------------------------------------------
    -- Issues. Deduped on the evidence, so a standing unresolved conflict
    -- is recorded once rather than once per night.
    -- -------------------------------------------------------
    FOR v_rec IN
      SELECT value ->> 'issueKey' AS issue_key,
             value -> 'personRef' AS person_ref,
             value ->> 'personHandle' AS handle,
             value ->> 'sourceObject' AS source_object,
             value ->> 'sourceRecordId' AS source_record_id,
             value ->> 'issueKind' AS issue_kind,
             value ->> 'detail' AS detail
      FROM jsonb_array_elements(COALESCE(p_issues, '[]'::JSONB))
      ORDER BY 1
    LOOP
      v_person_id := CASE
        WHEN v_rec.person_ref IS NULL THEN NULL
        ELSE public.sf_lifecycle_resolve_person(v_rec.person_ref, v_handle_map)
      END;

      INSERT INTO public.sf_lifecycle_issues (
        issue_key, person_id, source_object, source_record_id,
        issue_kind, detail, sync_run_id
      ) VALUES (
        v_rec.issue_key, v_person_id, v_rec.source_object, v_rec.source_record_id,
        v_rec.issue_kind, v_rec.detail, v_run_id
      )
      ON CONFLICT ON CONSTRAINT sf_lifecycle_issue_key_unique DO NOTHING;

      IF FOUND THEN
        v_issues_recorded := v_issues_recorded + 1;
      ELSE
        -- Key present: verify canonical identity. review_state, detail,
        -- sync_run_id, created_at, and updated_at are EXCLUDED: a human
        -- may have resolved the issue, and the detail wording may change,
        -- without that making the same standing evidence a conflict.
        SELECT * INTO v_existing_iss
        FROM public.sf_lifecycle_issues
        WHERE issue_key = v_rec.issue_key
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION USING ERRCODE = 'LC004',
            MESSAGE = 'issue key conflict with no readable row';
        END IF;

        IF v_existing_iss.issue_kind        IS DISTINCT FROM v_rec.issue_kind
           OR v_existing_iss.source_object   IS DISTINCT FROM v_rec.source_object
           OR v_existing_iss.source_record_id IS DISTINCT FROM v_rec.source_record_id
           OR v_existing_iss.person_id       IS DISTINCT FROM v_person_id
        THEN
          RAISE EXCEPTION USING ERRCODE = 'LC002',
            MESSAGE = 'issue key reused with different canonical content';
        END IF;
      END IF;
    END LOOP;

    -- -------------------------------------------------------
    -- Success. The watermark persists ONLY here, on a completed run,
    -- after every operation above succeeded.
    -- -------------------------------------------------------
    v_watermark := NULLIF(p_run ->> 'proposedWatermarkSystemModstamp', '')::TIMESTAMPTZ;

    UPDATE public.sf_lifecycle_sync_runs
    SET status = 'completed',
        completed_at = now(),
        watermark_system_modstamp = v_watermark
    WHERE id = v_run_id;

    v_counts := jsonb_build_object(
      'persons_created', v_persons_created,
      'aliases_created', v_aliases_created,
      'observations_inserted', v_observations_inserted,
      'events_inserted', v_events_inserted,
      'projections_updated', v_projections_updated,
      'issues_recorded', v_issues_recorded
    );

    RETURN jsonb_build_object(
      'outcome', 'success',
      'sync_run_id', v_run_id,
      'watermark_advanced', v_watermark IS NOT NULL,
      'counts', v_counts
    );

  EXCEPTION WHEN OTHERS THEN
    -- All business writes above roll back to the savepoint opened by this
    -- block. The run row created before it survives and records the
    -- failure with a SANITIZED diagnostic: SQLSTATE plus an allowlisted
    -- category. SQLERRM is deliberately never persisted, because it can
    -- embed a lifecycle value, a Salesforce Id, or other source data.
    v_sqlstate := SQLSTATE;
    v_category := CASE v_sqlstate
      WHEN 'LC001' THEN 'incomplete_run_refused'
      WHEN 'LC002' THEN 'same_timestamp_content_conflict'
      WHEN 'LC003' THEN 'identity_conflict'
      WHEN 'LC004' THEN 'malformed_payload'
      WHEN 'LC005' THEN 'unresolvable_person_handle'
      -- Bad caller-supplied literals surface as native cast errors.
      -- They are malformed payload, not an unexpected internal fault, and
      -- were observed in PostgreSQL 15 execution testing: 22007 from an
      -- unparseable timestamp, 22P02 from a non-integer page count.
      WHEN '22007' THEN 'malformed_payload'
      WHEN '22P02' THEN 'malformed_payload'
      WHEN '22008' THEN 'malformed_payload'
      WHEN '23505' THEN 'unique_violation'
      WHEN '23503' THEN 'foreign_key_violation'
      WHEN '23514' THEN 'check_violation'
      ELSE 'unexpected_error'
    END;

    UPDATE public.sf_lifecycle_sync_runs
    SET status = CASE WHEN v_sqlstate = 'LC001' THEN 'incomplete' ELSE 'failed' END,
        completed_at = now(),
        watermark_system_modstamp = NULL,
        -- TEXT column: SQLSTATE plus an allowlisted category ONLY. Both
        -- values are drawn from fixed vocabularies above, so nothing
        -- source-derived can reach this column.
        error_summary = v_sqlstate || ' ' || v_category
    WHERE id = v_run_id;

    RETURN jsonb_build_object(
      'outcome', CASE WHEN v_sqlstate = 'LC001' THEN 'incomplete' ELSE 'failure' END,
      'sync_run_id', v_run_id,
      'watermark_advanced', FALSE,
      'sqlstate', v_sqlstate,
      'category', v_category
    );
  END;
END;
$$;

-- -------------------------------------------------------------
-- 3. Permissions: service_role only.
-- -------------------------------------------------------------

REVOKE ALL ON FUNCTION public.sf_apply_lifecycle_observations(JSONB, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sf_apply_lifecycle_observations(JSONB, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.sf_apply_lifecycle_observations(JSONB, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sf_apply_lifecycle_observations(JSONB, JSONB, JSONB, JSONB, JSONB, JSONB, JSONB) TO service_role;

-- Done. Adds three idempotency constraints and one restricted function.
-- Writes no data; imports nothing; backfills nothing.
