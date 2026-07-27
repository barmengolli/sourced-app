-- 2026-07-27_opportunity_ingestion_apply_fn.sql
--
-- Bite 5C2A: restricted, atomic apply function for the staging-ingestion
-- plan (docs/opportunity-staging-ingestion.md). NOT YET APPLIED.
--
-- One call applies one planned batch as ONE transaction against ONLY the
-- protected sf_opportunity_* tables:
--   - snapshot upserts (insert or content-hash-changed update),
--   - append-only event inserts (conflict-safe; an existing History Id is
--     skipped, NEVER updated: the append-only triggers stay authoritative),
--   - review creations (create-if-absent) and pending-review issue updates,
--   - append-only review audit events (dedupe-key conflict-safe),
--   - exactly one sf_opportunity_sync_runs row per call.
--
-- Failure semantics: the batch body runs inside a nested block. Any error
-- rolls back EVERY batch write to the block's savepoint, then a FAILED run
-- row is recorded with a non-sensitive error summary and NULL watermarks.
-- Watermarks are therefore persisted only on the completed row of a fully
-- successful batch (status: completed only when every operation succeeded);
-- incremental runs read their next lower bound from the newest completed
-- run.
--
-- Access: SECURITY DEFINER with a pinned search_path, revoked from PUBLIC,
-- anon, and authenticated; execute is granted ONLY to service_role (the
-- trusted server-side ingestion identity per the Bite 5B access contract).
-- A narrower dedicated ingestion role remains a documented infrastructure
-- decision; nothing here weakens RLS or the append-only triggers (triggers
-- fire regardless of SECURITY DEFINER).
--
-- This migration writes no data itself: it only defines the function.
-- RUN ORDER: requires 2026-07-24_opportunity_ledger_storage.sql (applied).
-- Apply manually in the Supabase SQL Editor after review. NOT YET APPLIED.

CREATE OR REPLACE FUNCTION sf_apply_opportunity_ingestion(
  p_snapshots JSONB DEFAULT '[]'::JSONB,
  p_events JSONB DEFAULT '[]'::JSONB,
  p_reviews JSONB DEFAULT '[]'::JSONB,
  p_review_events JSONB DEFAULT '[]'::JSONB,
  p_run JSONB DEFAULT '{}'::JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item JSONB;
  v_opp_uuid UUID;
  v_review_id UUID;
  v_snapshots_applied INTEGER := 0;
  v_events_inserted INTEGER := 0;
  v_events_skipped INTEGER := 0;
  v_reviews_created INTEGER := 0;
  v_reviews_updated INTEGER := 0;
  v_review_events_inserted INTEGER := 0;
  v_review_events_deduped INTEGER := 0;
  v_count INTEGER;
BEGIN
  BEGIN
    -- 1. Snapshot upserts (one current row per Salesforce Opportunity).
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_snapshots, '[]'::JSONB)) LOOP
      INSERT INTO sf_opportunities (
        sf_opportunity_id, record_type_developer_name, record_type_label,
        stage_name, opportunity_name, account_name, amount, amount_currency,
        close_date, commercial_region, opportunity_owner,
        primary_campaign_source, sf_created_at, sf_last_modified_at,
        content_hash, last_seen_at, last_synced_at
      ) VALUES (
        v_item->>'sf_opportunity_id',
        v_item->>'record_type_developer_name',
        v_item->>'record_type_label',
        v_item->>'stage_name',
        v_item->>'opportunity_name',
        v_item->>'account_name',
        NULLIF(v_item->>'amount', '')::NUMERIC,
        v_item->>'amount_currency',
        NULLIF(v_item->>'close_date', '')::DATE,
        v_item->>'commercial_region',
        v_item->>'opportunity_owner',
        v_item->>'primary_campaign_source',
        NULLIF(v_item->>'sf_created_at', '')::TIMESTAMPTZ,
        NULLIF(v_item->>'sf_last_modified_at', '')::TIMESTAMPTZ,
        v_item->>'content_hash',
        NOW(), NOW()
      )
      ON CONFLICT (sf_opportunity_id) DO UPDATE SET
        record_type_developer_name = EXCLUDED.record_type_developer_name,
        record_type_label = EXCLUDED.record_type_label,
        stage_name = EXCLUDED.stage_name,
        opportunity_name = EXCLUDED.opportunity_name,
        account_name = EXCLUDED.account_name,
        amount = EXCLUDED.amount,
        amount_currency = EXCLUDED.amount_currency,
        close_date = EXCLUDED.close_date,
        commercial_region = EXCLUDED.commercial_region,
        opportunity_owner = EXCLUDED.opportunity_owner,
        primary_campaign_source = EXCLUDED.primary_campaign_source,
        sf_created_at = EXCLUDED.sf_created_at,
        sf_last_modified_at = EXCLUDED.sf_last_modified_at,
        content_hash = EXCLUDED.content_hash,
        last_seen_at = NOW(),
        last_synced_at = NOW();
      v_snapshots_applied := v_snapshots_applied + 1;
    END LOOP;

    -- 2. Append-only history events: conflict-safe insert on the History Id.
    -- An existing event is skipped, never touched; the append-only trigger
    -- independently rejects any UPDATE or DELETE.
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_events, '[]'::JSONB)) LOOP
      SELECT id INTO v_opp_uuid FROM sf_opportunities
        WHERE sf_opportunity_id = v_item->>'sf_opportunity_id';
      IF v_opp_uuid IS NULL THEN
        RAISE EXCEPTION 'event references an unknown staged opportunity';
      END IF;
      INSERT INTO sf_opportunity_events (
        sf_opportunity_uuid, sf_opportunity_id, sf_history_id, source_field,
        old_value, new_value, event_kind,
        from_record_type_state, to_record_type_state,
        from_terminal_state, to_terminal_state,
        changed_at, content_hash
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
        v_item->>'content_hash'
      )
      ON CONFLICT (sf_history_id) DO NOTHING;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      IF v_count = 1 THEN
        v_events_inserted := v_events_inserted + 1;
      ELSE
        v_events_skipped := v_events_skipped + 1;
      END IF;
    END LOOP;

    -- 3. Reviews: create-if-absent, or issue update restricted to PENDING
    -- projections. The state machine is never bypassed here.
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_reviews, '[]'::JSONB)) LOOP
      SELECT id INTO v_opp_uuid FROM sf_opportunities
        WHERE sf_opportunity_id = v_item->>'sf_opportunity_id';
      IF v_opp_uuid IS NULL THEN
        RAISE EXCEPTION 'review references an unknown staged opportunity';
      END IF;
      IF v_item->>'kind' = 'create' THEN
        INSERT INTO sf_opportunity_reviews (sf_opportunity_uuid, review_state, issue_codes)
        VALUES (
          v_opp_uuid, 'pending',
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_item->'issue_codes', '[]'::JSONB)))
        )
        ON CONFLICT (sf_opportunity_uuid) DO NOTHING;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        v_reviews_created := v_reviews_created + v_count;
      ELSIF v_item->>'kind' = 'update_issues' THEN
        UPDATE sf_opportunity_reviews SET
          issue_codes = ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_item->'issue_codes', '[]'::JSONB)))
        WHERE sf_opportunity_uuid = v_opp_uuid AND review_state = 'pending';
        GET DIAGNOSTICS v_count = ROW_COUNT;
        v_reviews_updated := v_reviews_updated + v_count;
      ELSE
        RAISE EXCEPTION 'unknown review operation kind';
      END IF;
    END LOOP;

    -- 4. Append-only review audit events, dedupe-key conflict-safe.
    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_review_events, '[]'::JSONB)) LOOP
      SELECT r.id, r.sf_opportunity_uuid INTO v_review_id, v_opp_uuid
        FROM sf_opportunity_reviews r
        JOIN sf_opportunities o ON o.id = r.sf_opportunity_uuid
        WHERE o.sf_opportunity_id = v_item->>'sf_opportunity_id';
      IF v_review_id IS NULL THEN
        RAISE EXCEPTION 'review event references an unknown review projection';
      END IF;
      INSERT INTO sf_opportunity_review_events (
        review_id, sf_opportunity_uuid, event_type, previous_state, new_state,
        issue_codes_snapshot, actor_type, actor_id, note,
        sf_history_id, accepted_content_hash, conflicting_content_hash,
        dedupe_key, occurred_at
      ) VALUES (
        v_review_id, v_opp_uuid,
        v_item->>'event_type',
        v_item->>'previous_state',
        v_item->>'new_state',
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_item->'issue_codes_snapshot', '[]'::JSONB))),
        v_item->>'actor_type',
        v_item->>'actor_id',
        v_item->>'note',
        v_item->>'sf_history_id',
        v_item->>'accepted_content_hash',
        v_item->>'conflicting_content_hash',
        v_item->>'dedupe_key',
        (v_item->>'occurred_at')::TIMESTAMPTZ
      )
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      IF v_count = 1 THEN
        v_review_events_inserted := v_review_events_inserted + 1;
      ELSE
        v_review_events_deduped := v_review_events_deduped + 1;
      END IF;
    END LOOP;

    -- 5. The completed run row: watermarks persist HERE and only here.
    INSERT INTO sf_opportunity_sync_runs (
      source, started_at, completed_at, status,
      watermark_system_modstamp, watermark_history_created_at,
      rows_discovered, rows_accepted, duplicates_ignored, conflicts, sent_to_review
    ) VALUES (
      'salesforce',
      COALESCE(NULLIF(p_run->>'started_at', '')::TIMESTAMPTZ, NOW()),
      NOW(),
      'completed',
      NULLIF(p_run->>'watermark_system_modstamp', '')::TIMESTAMPTZ,
      NULLIF(p_run->>'watermark_history_created_at', '')::TIMESTAMPTZ,
      COALESCE((p_run->>'rows_discovered')::INTEGER, 0),
      v_events_inserted,
      v_events_skipped,
      COALESCE((p_run->>'conflicts')::INTEGER, 0),
      v_reviews_created
    );

    RETURN jsonb_build_object(
      'ok', true,
      'snapshots_applied', v_snapshots_applied,
      'events_inserted', v_events_inserted,
      'events_skipped', v_events_skipped,
      'reviews_created', v_reviews_created,
      'reviews_updated', v_reviews_updated,
      'review_events_inserted', v_review_events_inserted,
      'review_events_deduped', v_review_events_deduped
    );
  EXCEPTION WHEN OTHERS THEN
    -- Every batch write above is rolled back to this block's savepoint. The
    -- failed run is recorded with a non-sensitive summary and NO watermark,
    -- so a failed or partial batch can never claim a successful watermark.
    INSERT INTO sf_opportunity_sync_runs (
      source, started_at, completed_at, status, error_summary
    ) VALUES (
      'salesforce',
      COALESCE(NULLIF(p_run->>'started_at', '')::TIMESTAMPTZ, NOW()),
      NOW(),
      'failed',
      LEFT(SQLERRM, 500)
    );
    RETURN jsonb_build_object('ok', false, 'error', LEFT(SQLERRM, 500));
  END;
END;
$$;

-- Access boundary: server-side ingestion identity only.
REVOKE ALL ON FUNCTION sf_apply_opportunity_ingestion(JSONB, JSONB, JSONB, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION sf_apply_opportunity_ingestion(JSONB, JSONB, JSONB, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION sf_apply_opportunity_ingestion(JSONB, JSONB, JSONB, JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION sf_apply_opportunity_ingestion(JSONB, JSONB, JSONB, JSONB, JSONB) TO service_role;

-- Done. Defines one restricted function; writes no data by itself.
