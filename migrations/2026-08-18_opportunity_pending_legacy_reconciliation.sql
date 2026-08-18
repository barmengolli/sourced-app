-- 2026-08-18_opportunity_pending_legacy_reconciliation.sql
-- STATUS: PENDING. Applying this migration installs protected preview and
-- reconciliation functions only. It does not reconcile any Opportunity.
--
-- Covers the three deferred pending-review shapes that the original exact-ID
-- adoption guard intentionally refused:
--   1. one manually verified name/account deal whose legacy URL is an Account;
--   2. one exact Opportunity split across two legacy deal ids;
--   3. one exact Opportunity whose legacy labels differ only in hyphen spacing.
--
-- The mutation is explicit and fail closed. The caller supplies the retained
-- deal id, every absorbed deal id, expected attribution/touch counts, review
-- version, actor, and idempotency key. It never chooses a deal automatically.
-- Duplicate stage rows may be removed only when their complete reporting
-- fields and ordered attribution-touch payloads equal the retained row.

BEGIN;

DO $constraint$
DECLARE
  v_constraint_name TEXT;
BEGIN
  SELECT c.conname INTO v_constraint_name
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'sf_opportunity_deal_adoptions'
    AND c.contype = 'c'
    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%adoption_kind%';

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.sf_opportunity_deal_adoptions DROP CONSTRAINT %I',
      v_constraint_name
    );
  END IF;

  ALTER TABLE public.sf_opportunity_deal_adoptions
    ADD CONSTRAINT sf_opportunity_deal_adoptions_kind_valid
    CHECK (adoption_kind IN (
      'pending_exact_id',
      'active_duplicate',
      'active_duplicate_fill_missing',
      'pending_manual_review',
      'pending_split_exact_id',
      'pending_exact_id_label_repair'
    ));
END;
$constraint$;

CREATE OR REPLACE FUNCTION public.sf_list_pending_opportunity_legacy_reconciliations()
RETURNS SETOF JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH pending AS (
    SELECT
      r.id AS review_id,
      r.updated_at AS review_updated_at,
      o.id AS sf_opportunity_uuid,
      o.sf_opportunity_id,
      o.opportunity_name,
      o.account_name,
      pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
        pg_catalog.btrim(COALESCE(o.opportunity_name, '')),
        '\s*-\s*', ' - ', 'g'), '\s+', ' ', 'g')) AS normalized_name,
      pg_catalog.lower(pg_catalog.regexp_replace(
        pg_catalog.btrim(COALESCE(o.account_name, '')), '\s+', ' ', 'g')) AS normalized_account
    FROM public.sf_opportunity_reviews r
    JOIN public.sf_opportunities o ON o.id = r.sf_opportunity_uuid
    WHERE r.review_state = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM public.sf_opportunity_deal_links l
        WHERE l.sf_opportunity_uuid = o.id AND l.link_state = 'active'
      )
  ), deals AS (
    SELECT
      p.*,
      a.deal_id,
      pg_catalog.bool_or(
        NULLIF(pg_catalog.btrim(a.sf_link), '') IS NOT NULL
        AND pg_catalog.length(p.sf_opportunity_id) >= 15
        AND pg_catalog.strpos(a.sf_link, pg_catalog.left(p.sf_opportunity_id, 15)) > 0
      ) AS exact_id_match,
      pg_catalog.bool_and(
        pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
          pg_catalog.btrim(COALESCE(a.label, '')),
          '\s*-\s*', ' - ', 'g'), '\s+', ' ', 'g')) = p.normalized_name
        AND pg_catalog.lower(pg_catalog.regexp_replace(
          pg_catalog.btrim(COALESCE(a.account, '')), '\s+', ' ', 'g')) = p.normalized_account
      ) AS exact_name_account_match,
      pg_catalog.count(DISTINCT a.id) AS attribution_rows,
      pg_catalog.count(t.id) AS attribution_touches
    FROM pending p
    JOIN public.attributions a
      ON a.source_system = 'manual'
     AND NULLIF(pg_catalog.btrim(a.deal_id), '') IS NOT NULL
    LEFT JOIN public.attribution_touches t ON t.attribution_id = a.id
    GROUP BY p.review_id, p.review_updated_at, p.sf_opportunity_uuid,
      p.sf_opportunity_id, p.opportunity_name, p.account_name,
      p.normalized_name, p.normalized_account, a.deal_id
  ), matched AS (
    SELECT * FROM deals WHERE exact_id_match OR exact_name_account_match
  )
  SELECT pg_catalog.jsonb_build_object(
    'reviewId', review_id,
    'sfOpportunityId', pg_catalog.min(sf_opportunity_id),
    'opportunityName', pg_catalog.min(opportunity_name),
    'accountName', pg_catalog.min(account_name),
    'exactIdDealIds', pg_catalog.to_jsonb(pg_catalog.array_agg(deal_id ORDER BY deal_id)
      FILTER (WHERE exact_id_match)),
    'nameAccountDealIds', pg_catalog.to_jsonb(pg_catalog.array_agg(deal_id ORDER BY deal_id)
      FILTER (WHERE exact_name_account_match)),
    'attributionRows', pg_catalog.sum(attribution_rows),
    'attributionTouches', pg_catalog.sum(attribution_touches),
    'version', pg_catalog.to_char(
      pg_catalog.min(review_updated_at) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  )
  FROM matched
  GROUP BY review_id
  ORDER BY review_id;
$$;

CREATE OR REPLACE FUNCTION public.sf_reconcile_pending_opportunity_legacy_deals(
  p_review_id UUID,
  p_retained_deal_id TEXT,
  p_absorbed_deal_ids TEXT[],
  p_identity_method TEXT,
  p_manual_confirmation TEXT,
  p_expected_attribution_rows INTEGER,
  p_expected_attribution_touches INTEGER,
  p_actor_id TEXT,
  p_idempotency_key TEXT,
  p_expected_version TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_review public.sf_opportunity_reviews%ROWTYPE;
  v_opp public.sf_opportunities%ROWTYPE;
  v_existing public.sf_opportunity_deal_adoptions%ROWTYPE;
  v_candidate_deals TEXT[];
  v_actual_exact_deals TEXT[];
  v_current_version TEXT;
  v_request_hash TEXT;
  v_channel UUID;
  v_lead UUID;
  v_region TEXT;
  v_bdr TEXT;
  v_rows_before INTEGER;
  v_touches_before INTEGER;
  v_duplicate_rows_removed INTEGER;
  v_duplicate_touches_removed INTEGER;
  v_rows_adopted INTEGER;
  v_touches_preserved INTEGER;
  v_reporting_rows INTEGER;
  v_adoption_kind TEXT;
  v_response JSONB;
BEGIN
  IF NULLIF(pg_catalog.btrim(p_retained_deal_id), '') IS NULL
     OR NULLIF(pg_catalog.btrim(p_actor_id), '') IS NULL
     OR NULLIF(pg_catalog.btrim(p_idempotency_key), '') IS NULL
     OR p_identity_method NOT IN ('exact_sf_opportunity_id', 'manual_review')
     OR p_expected_attribution_rows <= 0
     OR p_expected_attribution_touches < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'complete reconciliation inputs are required';
  END IF;

  SELECT pg_catalog.array_agg(x ORDER BY x)
  INTO v_candidate_deals
  FROM (
    SELECT DISTINCT pg_catalog.btrim(x) AS x
    FROM pg_catalog.unnest(
      pg_catalog.array_prepend(p_retained_deal_id, COALESCE(p_absorbed_deal_ids, ARRAY[]::TEXT[]))
    ) x
    WHERE NULLIF(pg_catalog.btrim(x), '') IS NOT NULL
  ) d;
  IF NOT (pg_catalog.btrim(p_retained_deal_id) = ANY(v_candidate_deals))
     OR pg_catalog.cardinality(v_candidate_deals)
        <> 1 + pg_catalog.cardinality(COALESCE(p_absorbed_deal_ids, ARRAY[]::TEXT[])) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'deal ids must be nonblank and unique';
  END IF;

  v_request_hash := pg_catalog.md5(pg_catalog.concat_ws('|',
    p_review_id::TEXT, pg_catalog.array_to_string(v_candidate_deals, ','),
    p_identity_method, p_expected_attribution_rows::TEXT,
    p_expected_attribution_touches::TEXT, p_expected_version
  ));
  SELECT * INTO v_existing
  FROM public.sf_opportunity_deal_adoptions
  WHERE actor_id = p_actor_id
    AND review_id = p_review_id
    AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_hash <> v_request_hash THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'idempotency key already used for another request';
    END IF;
    RETURN v_existing.response_json || pg_catalog.jsonb_build_object('replayed', TRUE);
  END IF;

  SELECT * INTO v_review
  FROM public.sf_opportunity_reviews
  WHERE id = p_review_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'review not found';
  END IF;
  SELECT * INTO v_opp
  FROM public.sf_opportunities
  WHERE id = v_review.sf_opportunity_uuid
  FOR UPDATE;

  v_current_version := pg_catalog.to_char(
    v_review.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
  IF p_expected_version IS DISTINCT FROM v_current_version THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'review changed; reload and retry';
  END IF;
  IF v_review.review_state <> 'pending'
     OR v_opp.normalized_record_type_state NOT IN ('hpp', 'opp', 'pursuit') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'review is not eligible for legacy reconciliation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.sf_opportunity_deal_links
    WHERE sf_opportunity_uuid = v_opp.id AND link_state = 'active'
  ) OR EXISTS (
    SELECT 1 FROM public.sf_opportunity_deal_links
    WHERE deal_id = ANY(v_candidate_deals) AND link_state = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'opportunity or candidate deal already has an active link';
  END IF;

  PERFORM 1 FROM public.attributions
  WHERE deal_id = ANY(v_candidate_deals)
  FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.attributions
    WHERE deal_id = ANY(v_candidate_deals) AND source_system <> 'manual'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'candidate set contains a non-manual attribution';
  END IF;

  SELECT pg_catalog.count(DISTINCT a.id), pg_catalog.count(t.id)
  INTO v_rows_before, v_touches_before
  FROM public.attributions a
  LEFT JOIN public.attribution_touches t ON t.attribution_id = a.id
  WHERE a.deal_id = ANY(v_candidate_deals);
  IF v_rows_before <> p_expected_attribution_rows
     OR v_touches_before <> p_expected_attribution_touches THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'candidate row or touch counts changed; reload and retry';
  END IF;

  SELECT pg_catalog.array_agg(x ORDER BY x)
  INTO v_actual_exact_deals
  FROM (
    SELECT DISTINCT a.deal_id AS x
    FROM public.attributions a
    WHERE a.source_system = 'manual'
      AND NULLIF(pg_catalog.btrim(a.deal_id), '') IS NOT NULL
      AND NULLIF(pg_catalog.btrim(a.sf_link), '') IS NOT NULL
      AND pg_catalog.length(v_opp.sf_opportunity_id) >= 15
      AND pg_catalog.strpos(a.sf_link, pg_catalog.left(v_opp.sf_opportunity_id, 15)) > 0
  ) exact_ids;

  IF p_identity_method = 'exact_sf_opportunity_id' THEN
    IF v_actual_exact_deals IS DISTINCT FROM v_candidate_deals THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'exact Salesforce ID candidate set changed';
    END IF;
  ELSE
    IF pg_catalog.cardinality(v_candidate_deals) <> 1
       OR p_manual_confirmation IS DISTINCT FROM 'I VERIFIED THE SALESFORCE OPPORTUNITY'
       OR v_actual_exact_deals IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'manual identity review is not fully confirmed';
    END IF;
  END IF;

  -- Every row must agree with the authoritative Salesforce name/account after
  -- harmless whitespace normalization. This repairs only display drift.
  IF EXISTS (
    SELECT 1 FROM public.attributions a
    WHERE a.deal_id = ANY(v_candidate_deals)
      AND (
        pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
          pg_catalog.btrim(COALESCE(a.label, '')), '\s*-\s*', ' - ', 'g'), '\s+', ' ', 'g'))
          IS DISTINCT FROM
        pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
          pg_catalog.btrim(COALESCE(v_opp.opportunity_name, '')), '\s*-\s*', ' - ', 'g'), '\s+', ' ', 'g'))
        OR pg_catalog.lower(pg_catalog.regexp_replace(
          pg_catalog.btrim(COALESCE(a.account, '')), '\s+', ' ', 'g'))
          IS DISTINCT FROM
        pg_catalog.lower(pg_catalog.regexp_replace(
          pg_catalog.btrim(COALESCE(v_opp.account_name, '')), '\s+', ' ', 'g'))
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'candidate name or account does not match Salesforce';
  END IF;

  SELECT pg_catalog.min(channel_id::TEXT)::UUID,
         pg_catalog.min(lead_id::TEXT)::UUID,
         pg_catalog.min(region),
         pg_catalog.min(bdr_name)
  INTO v_channel, v_lead, v_region, v_bdr
  FROM public.attributions
  WHERE deal_id = ANY(v_candidate_deals)
  HAVING pg_catalog.count(DISTINCT channel_id) FILTER (WHERE channel_id IS NOT NULL) = 1
     AND pg_catalog.count(DISTINCT lead_id) FILTER (WHERE lead_id IS NOT NULL) <= 1
     AND pg_catalog.count(DISTINCT region) FILTER (
       WHERE NULLIF(pg_catalog.btrim(region), '') IS NOT NULL
     ) <= 1
     AND pg_catalog.count(DISTINCT bdr_name) FILTER (
       WHERE NULLIF(pg_catalog.btrim(bdr_name), '') IS NOT NULL
     ) <= 1;
  IF v_channel IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'candidate channel, Lead, region, or BDR conflicts';
  END IF;
  v_region := COALESCE(NULLIF(pg_catalog.btrim(v_region), ''),
    NULLIF(pg_catalog.btrim(v_opp.commercial_region), ''));
  IF v_region IS NULL
     OR v_region NOT IN ('NA', 'EMEA cont & LATAM', 'UK&IRE, ME, Japan', 'Other') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'candidate does not resolve to a valid region';
  END IF;

  -- A duplicated stage can be collapsed only into a retained-deal row with
  -- identical reporting fields and an identical ordered touch payload.
  IF EXISTS (
    SELECT 1
    FROM public.attributions duplicate_row
    JOIN public.attributions retained_row
      ON retained_row.deal_id = pg_catalog.btrim(p_retained_deal_id)
     AND retained_row.stage_key = duplicate_row.stage_key
    WHERE duplicate_row.deal_id = ANY(COALESCE(p_absorbed_deal_ids, ARRAY[]::TEXT[]))
      AND (
        duplicate_row.channel_id IS DISTINCT FROM retained_row.channel_id
        OR duplicate_row.lead_id IS DISTINCT FROM retained_row.lead_id
        OR duplicate_row.stage_entered_at IS DISTINCT FROM retained_row.stage_entered_at
        OR duplicate_row.amount IS DISTINCT FROM retained_row.amount
        OR duplicate_row.region IS DISTINCT FROM retained_row.region
        OR duplicate_row.bdr_name IS DISTINCT FROM retained_row.bdr_name
        OR duplicate_row.lost_reason IS DISTINCT FROM retained_row.lost_reason
        OR COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'touchOrder', t.touch_order, 'channelId', t.channel_id,
            'touchedAt', t.touched_at, 'notes', t.notes
          ) ORDER BY t.touch_order)
          FROM public.attribution_touches t
          WHERE t.attribution_id = duplicate_row.id
        ), '[]'::JSONB) IS DISTINCT FROM COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'touchOrder', t.touch_order, 'channelId', t.channel_id,
            'touchedAt', t.touched_at, 'notes', t.notes
          ) ORDER BY t.touch_order)
          FROM public.attribution_touches t
          WHERE t.attribution_id = retained_row.id
        ), '[]'::JSONB)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'duplicate stage rows are not semantically identical';
  END IF;

  SELECT pg_catalog.count(DISTINCT a.id), pg_catalog.count(t.id)
  INTO v_duplicate_rows_removed, v_duplicate_touches_removed
  FROM public.attributions a
  LEFT JOIN public.attribution_touches t ON t.attribution_id = a.id
  WHERE a.deal_id = ANY(COALESCE(p_absorbed_deal_ids, ARRAY[]::TEXT[]))
    AND EXISTS (
      SELECT 1 FROM public.attributions retained
      WHERE retained.deal_id = pg_catalog.btrim(p_retained_deal_id)
        AND retained.stage_key = a.stage_key
    );

  DELETE FROM public.attributions a
  WHERE a.deal_id = ANY(COALESCE(p_absorbed_deal_ids, ARRAY[]::TEXT[]))
    AND EXISTS (
      SELECT 1 FROM public.attributions retained
      WHERE retained.deal_id = pg_catalog.btrim(p_retained_deal_id)
        AND retained.stage_key = a.stage_key
    );

  UPDATE public.attributions
  SET deal_id = pg_catalog.btrim(p_retained_deal_id), updated_at = pg_catalog.now()
  WHERE deal_id = ANY(COALESCE(p_absorbed_deal_ids, ARRAY[]::TEXT[]));
  IF EXISTS (
    SELECT 1 FROM public.attributions
    WHERE deal_id = ANY(COALESCE(p_absorbed_deal_ids, ARRAY[]::TEXT[]))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'absorbed deal rows remain after consolidation';
  END IF;

  UPDATE public.sf_opportunity_reviews
  SET review_state = 'linked',
      channel_id = v_channel,
      lead_id = v_lead,
      bdr_name = COALESCE(v_bdr, v_opp.suggested_bdr_name),
      commercial_region_override = v_region,
      issue_codes = pg_catalog.array_remove(pg_catalog.array_remove(
        pg_catalog.array_remove(issue_codes,
          'missing_channel'), 'missing_region'), 'possible_existing_deal'),
      reviewer_note = CASE p_identity_method
        WHEN 'manual_review' THEN 'Legacy Sourced deal linked after explicit Salesforce identity review'
        ELSE 'Legacy Sourced deal history reconciled by exact Salesforce Opportunity ID'
      END,
      reviewed_at = pg_catalog.now(),
      reviewed_by = p_actor_id,
      updated_at = pg_catalog.now()
  WHERE id = p_review_id;

  UPDATE public.attributions
  SET source_system = 'salesforce',
      sf_opportunity_id = v_opp.sf_opportunity_id,
      label = v_opp.opportunity_name,
      account = v_opp.account_name,
      sfdc_account_id = v_opp.account_id,
      sf_link = 'https://eisgroup.lightning.force.com/lightning/r/Opportunity/'
        || v_opp.sf_opportunity_id || '/view',
      updated_at = pg_catalog.now()
  WHERE deal_id = pg_catalog.btrim(p_retained_deal_id);

  INSERT INTO public.sf_opportunity_deal_links (
    sf_opportunity_uuid, deal_id, link_state, link_method, linked_by, review_note
  ) VALUES (
    v_opp.id, pg_catalog.btrim(p_retained_deal_id), 'active', p_identity_method,
    p_actor_id, 'Reconciled reviewed legacy history; retained deal and meaningful touches preserved'
  );

  INSERT INTO public.sf_opportunity_review_events (
    review_id, sf_opportunity_uuid, event_type, previous_state, new_state,
    issue_codes_snapshot, actor_type, actor_id, note, occurred_at
  ) VALUES (
    p_review_id, v_opp.id, 'link_recorded', 'pending', 'linked',
    v_review.issue_codes, 'reviewer', p_actor_id,
    'Legacy deal set reconciled into one exact Salesforce Opportunity', pg_catalog.now()
  );

  v_reporting_rows := public.sf_refresh_opportunity_reporting(v_opp.id);

  SELECT pg_catalog.count(DISTINCT a.id), pg_catalog.count(t.id)
  INTO v_rows_adopted, v_touches_preserved
  FROM public.attributions a
  LEFT JOIN public.attribution_touches t ON t.attribution_id = a.id
  WHERE a.deal_id = pg_catalog.btrim(p_retained_deal_id)
    AND a.source_system = 'salesforce'
    AND a.sf_opportunity_id = v_opp.sf_opportunity_id;

  v_adoption_kind := CASE
    WHEN p_identity_method = 'manual_review' THEN 'pending_manual_review'
    WHEN pg_catalog.cardinality(v_candidate_deals) > 1 THEN 'pending_split_exact_id'
    ELSE 'pending_exact_id_label_repair'
  END;
  v_response := pg_catalog.jsonb_build_object(
    'status', 'reconciled',
    'reviewId', p_review_id,
    'reviewState', 'linked',
    'sfOpportunityId', v_opp.sf_opportunity_id,
    'dealId', pg_catalog.btrim(p_retained_deal_id),
    'absorbedDealIds', COALESCE(p_absorbed_deal_ids, ARRAY[]::TEXT[]),
    'identityMethod', p_identity_method,
    'attributionRowsBefore', v_rows_before,
    'attributionTouchesBefore', v_touches_before,
    'duplicateRowsRemoved', v_duplicate_rows_removed,
    'duplicateTouchesRemoved', v_duplicate_touches_removed,
    'attributionRowsAdopted', v_rows_adopted,
    'attributionTouchesPreserved', v_touches_preserved,
    'reportingRows', v_reporting_rows,
    'version', (SELECT pg_catalog.to_char(
      updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) FROM public.sf_opportunity_reviews WHERE id = p_review_id),
    'replayed', FALSE
  );

  INSERT INTO public.sf_opportunity_deal_adoptions (
    review_id, sf_opportunity_uuid, deal_id, adoption_kind,
    attribution_rows_adopted, attribution_touches_preserved,
    actor_id, idempotency_key, request_hash, response_json
  ) VALUES (
    p_review_id, v_opp.id, pg_catalog.btrim(p_retained_deal_id), v_adoption_kind,
    v_rows_adopted, v_touches_preserved,
    p_actor_id, p_idempotency_key, v_request_hash, v_response
  );
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.sf_list_pending_opportunity_legacy_reconciliations()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sf_reconcile_pending_opportunity_legacy_deals(
  UUID, TEXT, TEXT[], TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sf_list_pending_opportunity_legacy_reconciliations()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.sf_reconcile_pending_opportunity_legacy_deals(
  UUID, TEXT, TEXT[], TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT
) TO service_role;

COMMIT;
