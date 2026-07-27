-- 2026-07-27_opportunity_ingestion_apply_fn.sql
--
-- Bite 5C2A: review-evidence columns plus the restricted, atomic apply
-- function for the staging-ingestion plan
-- (docs/opportunity-staging-ingestion.md). NOT YET APPLIED.
--
-- Part 1 extends public.sf_opportunities with the review-evidence columns
-- the future Queue needs so a candidate can be reviewed WITHOUT querying
-- raw Salesforce again. Raw values and source USER IDS only: configured
-- employee names are never stored, no canonical Industry Vertical field is
-- chosen, and no Customer Expansion rule is applied.
--
-- Part 2 defines public.sf_apply_opportunity_ingestion. One call applies
-- one planned batch against ONLY the protected sf_opportunity_* tables:
--   - the sync-run row is created FIRST (status running) from
--     server-generated values ONLY, so it exists even when the caller
--     payload is malformed; caller metadata is cast inside the protected
--     block, and the run id tags every inserted history event, so all
--     writes (and all failures) trace to exactly one run row;
--   - snapshot upserts are CONCURRENCY-SAFE: a single
--     INSERT ... ON CONFLICT DO UPDATE whose WHERE clause permits the
--     update only when the incoming SystemModstamp is strictly newer is
--     the sole authority (no unlocked pre-check); when nothing was
--     written, the conflict-locked current row is inspected: newer
--     current row means a counted stale no-op, identical timestamp and
--     content means an idempotent no-op, identical timestamp with
--     DIFFERENT content fails the batch;
--   - append-only event inserts verify content: an existing History Id
--     with identical canonical content hash is an idempotent no-op, an
--     existing Id with DIFFERENT content FAILS the atomic batch (never
--     silently ignored, never updated: the append-only triggers stay
--     authoritative);
--   - review items carry an ARRAY of coupled audit events (a single
--     observation can require review_created PLUS conflict_observed, or
--     issues_updated PLUS conflict_observed; kind 'audit_only' attaches
--     conflict evidence to an existing review without touching it): a
--     create that lost a race to an existing compatible pending review
--     skips BOTH the insert and ALL its audit events (no false
--     review_created); an issues update REQUIRES the expected pending row
--     (zero rows updated fails) and touches ONLY issue_codes, never
--     channel_id, lead_id, notes, reviewed_by, BDR selection, or human
--     state; audit dedupe compares the COMPLETE canonical identity
--     (event_type, states, issue codes, actor, History Id, content
--     hashes, note) with null-safe equality, occurred_at excluded as
--     observation metadata (first observation wins); any difference
--     fails rather than being silently ignored;
--   - on complete success the SAME run row is updated to completed with
--     the watermarks; on ANY failure every batch write rolls back to the
--     nested block's savepoint and the run row is updated to failed with
--     NULL watermarks and a SANITIZED summary (SQLSTATE plus an
--     allowlisted category; never SQLERRM, which can embed source values).
--     Exactly one run row exists per invocation, and a failed run can
--     never advance either watermark. Callers MUST treat ok:false as
--     workflow failure.
--
-- Access: SECURITY DEFINER with search_path pinned to pg_catalog and every
-- table reference schema-qualified; revoked from PUBLIC, anon, and
-- authenticated; EXECUTE granted only to service_role. A narrower
-- dedicated ingestion role remains an explicit unresolved infrastructure
-- decision. Nothing here weakens RLS or the append-only triggers.
--
-- Custom SQLSTATEs raised by this function:
--   SF001 unknown staged opportunity   SF002 snapshot timestamp conflict
--   SF003 event content conflict       SF004 audit dedupe conflict
--   SF005 review reconciliation failed SF006 invalid source timestamp
--   SF007 unknown operation kind
--
-- RUN ORDER: requires 2026-07-24_opportunity_ledger_storage.sql (applied).
-- Apply manually in the Supabase SQL Editor after review. NOT YET APPLIED.

-- =============================================================
-- 1. Review-evidence columns on the snapshot
-- =============================================================

ALTER TABLE public.sf_opportunities
  ADD COLUMN IF NOT EXISTS normalized_record_type_state TEXT
    CHECK (normalized_record_type_state IN ('hpp', 'opp', 'pursuit', 'out_of_scope', 'unknown')),
  ADD COLUMN IF NOT EXISTS is_closed BOOLEAN,
  ADD COLUMN IF NOT EXISTS is_won BOOLEAN,
  ADD COLUMN IF NOT EXISTS saas_revenue NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS saas_revenue_usd NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS customer_expansion_raw TEXT,
  ADD COLUMN IF NOT EXISTS sales_development_rep_user_id TEXT,
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS insurance_vertical_raw TEXT,
  ADD COLUMN IF NOT EXISTS industry_vertical_raw TEXT,
  ADD COLUMN IF NOT EXISTS pursuit_industry_vertical_raw TEXT,
  ADD COLUMN IF NOT EXISTS gtm_cube TEXT,
  ADD COLUMN IF NOT EXISTS business_units TEXT;

-- =============================================================
-- 2. The restricted atomic apply function
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
