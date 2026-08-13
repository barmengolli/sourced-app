-- 2026-08-12_opportunity_owner_label_upgrade.sql
--
-- Narrow compatibility boundary for the initial Opportunity workflow, which
-- stored Salesforce OwnerId in the human-facing opportunity_owner field.
-- The v4 function accepts an owner-label repair only when the stored row still
-- matches the exact legacy owner id, source timestamp, and legacy content
-- fingerprint supplied by the authoritative planner. Every other
-- same-timestamp content difference remains blocked by the v3 boundary.
--
-- Forward-only and idempotent. No business row changes until the v4 RPC is
-- explicitly invoked by the closed-by-default workflow.
-- STATUS: Applied manually to production on 2026-08-12. Supabase reported
-- success. Function only; this migration invoked no RPC and changed no
-- Opportunity business row by itself.

BEGIN;

CREATE OR REPLACE FUNCTION public.sf_apply_opportunity_ingestion_v4(
  p_owner_repairs JSONB DEFAULT '[]'::JSONB,
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
  v_result JSONB;
  v_item JSONB;
  v_count INTEGER;
  v_repaired INTEGER := 0;
  v_idempotent INTEGER := 0;
  v_existing_owner TEXT;
  v_existing_stamp TIMESTAMPTZ;
  v_existing_hash TEXT;
BEGIN
  IF pg_catalog.jsonb_typeof(COALESCE(p_owner_repairs, '[]'::JSONB)) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'owner repairs must be an array';
  END IF;

  -- The proven v3 boundary remains authoritative for ordinary snapshots,
  -- append-only history, reviews, run rows, idempotency, and watermarks.
  v_result := public.sf_apply_opportunity_ingestion_v3(
    p_snapshots, p_events, p_reviews, p_run
  );
  IF COALESCE((v_result->>'ok')::BOOLEAN, FALSE) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  FOR v_item IN
    SELECT * FROM pg_catalog.jsonb_array_elements(COALESCE(p_owner_repairs, '[]'::JSONB))
  LOOP
    IF NULLIF(pg_catalog.btrim(v_item->>'sf_opportunity_id'), '') IS NULL
       OR (v_item->>'sf_opportunity_id') !~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$'
       OR NULLIF(pg_catalog.btrim(v_item->>'legacy_owner_user_id'), '') IS NULL
       OR (v_item->>'legacy_owner_user_id') !~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$'
       OR NULLIF(pg_catalog.btrim(v_item->>'owner_name'), '') IS NULL
       OR NULLIF(v_item->>'sf_last_modified_at', '') IS NULL
       OR (v_item->>'prior_content_hash') !~ '^sha256:[0-9a-f]{64}$'
       OR (v_item->>'content_hash') !~ '^sha256:[0-9a-f]{64}$'
       OR v_item->>'prior_content_hash' = v_item->>'content_hash'
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid owner-label repair payload';
    END IF;

    UPDATE public.sf_opportunities
    SET opportunity_owner = pg_catalog.btrim(v_item->>'owner_name'),
        content_hash = v_item->>'content_hash',
        last_seen_at = pg_catalog.now(),
        last_synced_at = pg_catalog.now()
    WHERE sf_opportunity_id = v_item->>'sf_opportunity_id'
      AND opportunity_owner = v_item->>'legacy_owner_user_id'
      AND sf_last_modified_at = (v_item->>'sf_last_modified_at')::TIMESTAMPTZ
      AND content_hash = v_item->>'prior_content_hash';
    GET DIAGNOSTICS v_count = ROW_COUNT;

    IF v_count = 1 THEN
      v_repaired := v_repaired + 1;
    ELSE
      SELECT opportunity_owner, sf_last_modified_at, content_hash
      INTO v_existing_owner, v_existing_stamp, v_existing_hash
      FROM public.sf_opportunities
      WHERE sf_opportunity_id = v_item->>'sf_opportunity_id'
      FOR UPDATE;

      IF v_existing_owner = pg_catalog.btrim(v_item->>'owner_name')
         AND v_existing_stamp = (v_item->>'sf_last_modified_at')::TIMESTAMPTZ
         AND v_existing_hash = v_item->>'content_hash'
      THEN
        v_idempotent := v_idempotent + 1;
      ELSE
        RAISE EXCEPTION USING ERRCODE = 'SF008',
          MESSAGE = 'owner-label repair precondition failed';
      END IF;
    END IF;
  END LOOP;

  RETURN v_result || pg_catalog.jsonb_build_object(
    'contract_version', 4,
    'owner_labels_repaired', v_repaired,
    'owner_labels_idempotent', v_idempotent
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sf_apply_opportunity_ingestion_v4(JSONB, JSONB, JSONB, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sf_apply_opportunity_ingestion_v4(JSONB, JSONB, JSONB, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.sf_apply_opportunity_ingestion_v4(JSONB, JSONB, JSONB, JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sf_apply_opportunity_ingestion_v4(JSONB, JSONB, JSONB, JSONB, JSONB) TO service_role;

COMMIT;
