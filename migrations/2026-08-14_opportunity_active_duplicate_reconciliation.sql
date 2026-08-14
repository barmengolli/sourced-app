-- 2026-08-14_opportunity_active_duplicate_reconciliation.sql
-- STATUS: APPLIED manually to production on 2026-08-14. The migration changed
-- protected functions only; three guarded RPC calls then reconciled MAPFRE,
-- Daiichi Life, and Physicians Mutual without removing any attribution touch.
--
-- Reconciles the narrow duplicate shape created before exact-deal adoption:
-- an already-linked Salesforce-generated deal plus one legacy manual deal whose
-- stored Salesforce URL contains the exact same Opportunity ID. The protected
-- candidate function admits only one unambiguous legacy deal, matching stage
-- sets and non-conflicting funnel fields, and zero touches on the generated
-- copy. The mutation keeps the legacy deal and attribution row IDs, preserves
-- its touches, removes only the empty generated rows, redirects the active
-- Salesforce link, and refreshes Salesforce-owned reporting in place.

BEGIN;

CREATE OR REPLACE FUNCTION public.sf_list_opportunity_active_duplicate_candidates()
RETURNS SETOF JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH active AS (
    SELECT
      r.id AS review_id,
      r.updated_at AS review_updated_at,
      o.id AS sf_opportunity_uuid,
      o.sf_opportunity_id,
      l.deal_id AS active_deal_id
    FROM public.sf_opportunity_reviews r
    JOIN public.sf_opportunities o ON o.id = r.sf_opportunity_uuid
    JOIN public.sf_opportunity_deal_links l
      ON l.sf_opportunity_uuid = o.id
     AND l.link_state = 'active'
    WHERE r.review_state IN ('approved', 'linked')
  ), legacy AS (
    SELECT
      x.review_id,
      x.review_updated_at,
      x.sf_opportunity_uuid,
      x.sf_opportunity_id,
      x.active_deal_id,
      a.deal_id AS legacy_deal_id,
      pg_catalog.count(DISTINCT a.id) AS legacy_rows,
      pg_catalog.count(t.id) AS legacy_touches
    FROM active x
    JOIN public.attributions a
      ON a.source_system = 'manual'
     AND NULLIF(pg_catalog.btrim(a.deal_id), '') IS NOT NULL
     AND a.deal_id <> x.active_deal_id
     AND NULLIF(pg_catalog.btrim(a.sf_link), '') IS NOT NULL
     AND pg_catalog.length(x.sf_opportunity_id) >= 15
     AND pg_catalog.strpos(a.sf_link, pg_catalog.left(x.sf_opportunity_id, 15)) > 0
    LEFT JOIN public.attribution_touches t ON t.attribution_id = a.id
    GROUP BY x.review_id, x.review_updated_at, x.sf_opportunity_uuid,
             x.sf_opportunity_id, x.active_deal_id, a.deal_id
  ), candidate_counts AS (
    SELECT review_id, pg_catalog.count(*) AS legacy_deal_matches
    FROM legacy
    GROUP BY review_id
  ), eligible AS (
    SELECT l.*
    FROM legacy l
    JOIN candidate_counts cc
      ON cc.review_id = l.review_id
     AND cc.legacy_deal_matches = 1
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.sf_opportunity_deal_adoptions d
      WHERE d.review_id = l.review_id
    )
      AND NOT EXISTS (
        SELECT 1
        FROM public.sf_opportunity_deal_links other_link
        WHERE other_link.deal_id = l.legacy_deal_id
          AND other_link.link_state = 'active'
      )
      AND EXISTS (
        SELECT 1
        FROM public.attributions g
        WHERE g.deal_id = l.active_deal_id
          AND g.source_system = 'salesforce'
          AND g.sf_opportunity_id = l.sf_opportunity_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.attributions g
        WHERE g.deal_id = l.active_deal_id
          AND (g.source_system <> 'salesforce'
               OR g.sf_opportunity_id IS DISTINCT FROM l.sf_opportunity_id)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.attribution_touches t
        JOIN public.attributions g ON g.id = t.attribution_id
        WHERE g.deal_id = l.active_deal_id
      )
      AND ARRAY(
        SELECT m.stage_key
        FROM public.attributions m
        WHERE m.deal_id = l.legacy_deal_id AND m.source_system = 'manual'
        ORDER BY m.stage_key
      ) = ARRAY(
        SELECT g.stage_key
        FROM public.attributions g
        WHERE g.deal_id = l.active_deal_id
          AND g.source_system = 'salesforce'
          AND g.sf_opportunity_id = l.sf_opportunity_id
        ORDER BY g.stage_key
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.attributions m
        JOIN public.attributions g ON g.stage_key = m.stage_key
        WHERE m.deal_id = l.legacy_deal_id
          AND m.source_system = 'manual'
          AND g.deal_id = l.active_deal_id
          AND g.source_system = 'salesforce'
          AND g.sf_opportunity_id = l.sf_opportunity_id
          AND (
            m.channel_id IS DISTINCT FROM g.channel_id
            OR m.stage_entered_at IS DISTINCT FROM g.stage_entered_at
            OR (m.lead_id IS NOT NULL AND g.lead_id IS NOT NULL
                AND m.lead_id IS DISTINCT FROM g.lead_id)
            OR (m.amount IS NOT NULL AND g.amount IS NOT NULL
                AND m.amount IS DISTINCT FROM g.amount)
            OR (NULLIF(pg_catalog.btrim(m.region), '') IS NOT NULL
                AND NULLIF(pg_catalog.btrim(g.region), '') IS NOT NULL
                AND m.region IS DISTINCT FROM g.region)
            OR (NULLIF(pg_catalog.btrim(m.bdr_name), '') IS NOT NULL
                AND NULLIF(pg_catalog.btrim(g.bdr_name), '') IS NOT NULL
                AND m.bdr_name IS DISTINCT FROM g.bdr_name)
          )
      )
  )
  SELECT pg_catalog.jsonb_build_object(
    'reviewId', e.review_id,
    'sfOpportunityId', e.sf_opportunity_id,
    'legacyDealId', e.legacy_deal_id,
    'activeDealId', e.active_deal_id,
    'legacyAttributionRows', e.legacy_rows,
    'legacyAttributionTouches', e.legacy_touches,
    'generatedAttributionTouches', 0,
    'version', pg_catalog.to_char(
      e.review_updated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  )
  FROM eligible e
  ORDER BY e.review_id;
$$;

CREATE OR REPLACE FUNCTION public.sf_reconcile_active_opportunity_duplicate(
  p_review_id UUID,
  p_expected_legacy_deal_id TEXT,
  p_expected_active_deal_id TEXT,
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
  v_link public.sf_opportunity_deal_links%ROWTYPE;
  v_existing public.sf_opportunity_deal_adoptions%ROWTYPE;
  v_current_version TEXT;
  v_request_hash TEXT;
  v_candidate_count INTEGER;
  v_legacy_rows INTEGER;
  v_legacy_touches INTEGER;
  v_generated_rows INTEGER;
  v_generated_touches INTEGER;
  v_reporting_rows INTEGER;
  v_response JSONB;
BEGIN
  IF NULLIF(pg_catalog.btrim(p_expected_legacy_deal_id), '') IS NULL
     OR NULLIF(pg_catalog.btrim(p_expected_active_deal_id), '') IS NULL
     OR NULLIF(pg_catalog.btrim(p_actor_id), '') IS NULL
     OR NULLIF(pg_catalog.btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'expected legacy deal, active deal, actor, and idempotency key are required';
  END IF;
  IF p_expected_legacy_deal_id = p_expected_active_deal_id THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'legacy and active deal ids must be different';
  END IF;

  v_request_hash := pg_catalog.md5(pg_catalog.concat_ws(
    '|', p_review_id::TEXT, p_expected_legacy_deal_id,
    p_expected_active_deal_id, p_expected_version
  ));

  SELECT * INTO v_existing
  FROM public.sf_opportunity_deal_adoptions
  WHERE actor_id = p_actor_id
    AND review_id = p_review_id
    AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_hash <> v_request_hash THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'idempotency key already used for another request';
    END IF;
    RETURN v_existing.response_json || pg_catalog.jsonb_build_object('replayed', TRUE);
  END IF;

  SELECT * INTO v_existing
  FROM public.sf_opportunity_deal_adoptions
  WHERE review_id = p_review_id;
  IF FOUND THEN
    IF v_existing.adoption_kind = 'active_duplicate'
       AND v_existing.deal_id = p_expected_legacy_deal_id THEN
      RETURN v_existing.response_json || pg_catalog.jsonb_build_object('replayed', TRUE);
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23505',
      MESSAGE = 'review already has a different deal adoption';
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
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'opportunity not found';
  END IF;

  SELECT * INTO v_link
  FROM public.sf_opportunity_deal_links
  WHERE sf_opportunity_uuid = v_opp.id
    AND link_state = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'active Salesforce deal link not found';
  END IF;

  v_current_version := pg_catalog.to_char(
    v_review.updated_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
  IF p_expected_version IS DISTINCT FROM v_current_version THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'review changed; reload and retry';
  END IF;
  IF v_review.review_state NOT IN ('approved', 'linked') THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'review is not linked to active Salesforce reporting';
  END IF;
  IF v_link.deal_id IS DISTINCT FROM pg_catalog.btrim(p_expected_active_deal_id) THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'active Salesforce deal changed; reload and retry';
  END IF;

  SELECT pg_catalog.count(*) INTO v_candidate_count
  FROM public.sf_list_opportunity_active_duplicate_candidates() c
  WHERE c->>'reviewId' = p_review_id::TEXT
    AND c->>'legacyDealId' = pg_catalog.btrim(p_expected_legacy_deal_id)
    AND c->>'activeDealId' = pg_catalog.btrim(p_expected_active_deal_id);
  IF v_candidate_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'active duplicate is ambiguous, conflicting, touched on both copies, or no longer present';
  END IF;

  SELECT pg_catalog.count(DISTINCT a.id), pg_catalog.count(t.id)
  INTO v_legacy_rows, v_legacy_touches
  FROM public.attributions a
  LEFT JOIN public.attribution_touches t ON t.attribution_id = a.id
  WHERE a.deal_id = p_expected_legacy_deal_id
    AND a.source_system = 'manual';

  SELECT pg_catalog.count(DISTINCT a.id), pg_catalog.count(t.id)
  INTO v_generated_rows, v_generated_touches
  FROM public.attributions a
  LEFT JOIN public.attribution_touches t ON t.attribution_id = a.id
  WHERE a.deal_id = p_expected_active_deal_id
    AND a.source_system = 'salesforce'
    AND a.sf_opportunity_id = v_opp.sf_opportunity_id;

  IF v_legacy_rows = 0 OR v_generated_rows = 0 OR v_generated_touches <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'duplicate rows changed after validation; reload and retry';
  END IF;

  -- The generated copy has no touches by candidate contract, so deleting it
  -- cannot discard attribution history. The legacy rows and their IDs survive.
  DELETE FROM public.attributions
  WHERE deal_id = p_expected_active_deal_id
    AND source_system = 'salesforce'
    AND sf_opportunity_id = v_opp.sf_opportunity_id;

  UPDATE public.attributions
  SET source_system = 'salesforce',
      sf_opportunity_id = v_opp.sf_opportunity_id,
      updated_at = pg_catalog.now()
  WHERE deal_id = p_expected_legacy_deal_id
    AND source_system = 'manual';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'legacy deal changed during reconciliation';
  END IF;

  UPDATE public.sf_opportunity_deal_links
  SET deal_id = p_expected_legacy_deal_id,
      link_method = 'exact_sf_opportunity_id',
      linked_by = p_actor_id,
      review_note = 'Active duplicate reconciled; legacy attribution rows and touches preserved',
      updated_at = pg_catalog.now()
  WHERE id = v_link.id
    AND deal_id = p_expected_active_deal_id
    AND link_state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'active link changed during reconciliation';
  END IF;

  UPDATE public.sf_opportunity_reviews
  SET issue_codes = pg_catalog.array_remove(issue_codes, 'possible_existing_deal'),
      updated_at = pg_catalog.now()
  WHERE id = p_review_id;

  INSERT INTO public.sf_opportunity_review_events (
    review_id, sf_opportunity_uuid, event_type, previous_state, new_state,
    issue_codes_snapshot, actor_type, actor_id, note, occurred_at
  ) VALUES (
    p_review_id, v_opp.id, 'link_recorded', v_review.review_state, v_review.review_state,
    v_review.issue_codes, 'reviewer', p_actor_id,
    'Active duplicate consolidated by exact Salesforce Opportunity ID; legacy deal retained',
    pg_catalog.now()
  );

  v_reporting_rows := public.sf_refresh_opportunity_reporting(v_opp.id);
  v_response := pg_catalog.jsonb_build_object(
    'status', 'reconciled',
    'reviewId', p_review_id,
    'reviewState', v_review.review_state,
    'dealId', p_expected_legacy_deal_id,
    'removedGeneratedDealId', p_expected_active_deal_id,
    'attributionRowsAdopted', v_legacy_rows,
    'generatedRowsRemoved', v_generated_rows,
    'attributionTouchesPreserved', v_legacy_touches,
    'generatedTouchesRemoved', 0,
    'reportingRows', v_reporting_rows,
    'version', (
      SELECT pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      FROM public.sf_opportunity_reviews
      WHERE id = p_review_id
    ),
    'replayed', FALSE
  );

  INSERT INTO public.sf_opportunity_deal_adoptions (
    review_id, sf_opportunity_uuid, deal_id, adoption_kind,
    attribution_rows_adopted, attribution_touches_preserved,
    actor_id, idempotency_key, request_hash, response_json
  ) VALUES (
    p_review_id, v_opp.id, p_expected_legacy_deal_id, 'active_duplicate',
    v_legacy_rows, v_legacy_touches, p_actor_id, p_idempotency_key,
    v_request_hash, v_response
  );

  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.sf_list_opportunity_active_duplicate_candidates()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sf_reconcile_active_opportunity_duplicate(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sf_list_opportunity_active_duplicate_candidates()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.sf_reconcile_active_opportunity_duplicate(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

COMMIT;
