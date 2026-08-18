-- 2026-08-17_opportunity_active_duplicate_fill_missing.sql
-- STATUS: PENDING. Applying this migration changes structure and protected
-- functions only. It does not reconcile any Opportunity by itself.
--
-- Adds a second, deliberately narrow active-duplicate reconciliation path for
-- an exact Salesforce-ID pair where the generated Salesforce copy has no
-- touches and the legacy copy contains a value Salesforce does not provide.
-- Salesforce remains authoritative for identity, state, and proven stage
-- dates. A reviewer-owned revenue override survives future nightly refreshes;
-- the manual BDR is copied only when both Salesforce and the review are blank.

BEGIN;

ALTER TABLE public.sf_opportunity_reviews
  ADD COLUMN IF NOT EXISTS saas_revenue_usd_override NUMERIC(14, 2);

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'sf_opportunity_reviews'
      AND c.conname = 'sf_opportunity_reviews_revenue_override_nonnegative'
  ) THEN
    ALTER TABLE public.sf_opportunity_reviews
      ADD CONSTRAINT sf_opportunity_reviews_revenue_override_nonnegative
      CHECK (saas_revenue_usd_override IS NULL OR saas_revenue_usd_override >= 0);
  END IF;
END;
$constraint$;

-- The adoption ledger existed before this reconciliation class. Replace only
-- its vocabulary constraint; the table and every append-only row stay intact.
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
      'pending_exact_id', 'active_duplicate', 'active_duplicate_fill_missing'
    ));
END;
$constraint$;

-- Reporting refreshes continue to own the Salesforce amount. This trigger
-- applies the explicit reviewer override at the final write boundary so a
-- later nightly sync cannot turn an adopted $1.25M deal back into $0.
CREATE OR REPLACE FUNCTION public.sf_apply_opportunity_revenue_override()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_override NUMERIC(14, 2);
BEGIN
  IF NEW.source_system = 'salesforce'
     AND NULLIF(pg_catalog.btrim(NEW.sf_opportunity_id), '') IS NOT NULL THEN
    SELECT r.saas_revenue_usd_override
    INTO v_override
    FROM public.sf_opportunity_reviews r
    JOIN public.sf_opportunities o ON o.id = r.sf_opportunity_uuid
    WHERE o.sf_opportunity_id = NEW.sf_opportunity_id
      AND r.review_state IN ('approved', 'linked');

    IF v_override IS NOT NULL THEN
      NEW.amount := v_override;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS apply_sf_opportunity_revenue_override
  ON public.attributions;
CREATE TRIGGER apply_sf_opportunity_revenue_override
  BEFORE INSERT OR UPDATE OF amount, source_system, sf_opportunity_id
  ON public.attributions
  FOR EACH ROW EXECUTE FUNCTION public.sf_apply_opportunity_revenue_override();

CREATE OR REPLACE FUNCTION public.sf_list_opportunity_active_duplicate_fill_candidates()
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
      r.bdr_name AS review_bdr_name,
      r.saas_revenue_usd_override AS existing_revenue_override,
      o.id AS sf_opportunity_uuid,
      o.sf_opportunity_id,
      o.opportunity_name,
      o.account_name,
      o.saas_revenue_usd,
      o.suggested_bdr_name,
      l.deal_id AS active_deal_id
    FROM public.sf_opportunity_reviews r
    JOIN public.sf_opportunities o ON o.id = r.sf_opportunity_uuid
    JOIN public.sf_opportunity_deal_links l
      ON l.sf_opportunity_uuid = o.id
     AND l.link_state = 'active'
    WHERE r.review_state IN ('approved', 'linked')
  ), legacy AS (
    SELECT
      x.*,
      a.deal_id AS legacy_deal_id,
      pg_catalog.count(DISTINCT a.id) AS legacy_rows,
      pg_catalog.count(t.id) AS legacy_touches,
      pg_catalog.count(DISTINCT a.amount) FILTER (WHERE a.amount IS NOT NULL)
        AS legacy_amount_variants,
      pg_catalog.max(a.amount) FILTER (WHERE a.amount IS NOT NULL)
        AS legacy_amount,
      pg_catalog.count(DISTINCT a.bdr_name) FILTER (
        WHERE NULLIF(pg_catalog.btrim(a.bdr_name), '') IS NOT NULL
      ) AS legacy_bdr_variants,
      pg_catalog.min(a.bdr_name) FILTER (
        WHERE NULLIF(pg_catalog.btrim(a.bdr_name), '') IS NOT NULL
      ) AS legacy_bdr_name,
      pg_catalog.count(DISTINCT a.label) FILTER (
        WHERE NULLIF(pg_catalog.btrim(a.label), '') IS NOT NULL
      ) AS legacy_label_variants,
      pg_catalog.min(a.label) FILTER (
        WHERE NULLIF(pg_catalog.btrim(a.label), '') IS NOT NULL
      ) AS legacy_label,
      pg_catalog.count(DISTINCT a.account) FILTER (
        WHERE NULLIF(pg_catalog.btrim(a.account), '') IS NOT NULL
      ) AS legacy_account_variants,
      pg_catalog.min(a.account) FILTER (
        WHERE NULLIF(pg_catalog.btrim(a.account), '') IS NOT NULL
      ) AS legacy_account
    FROM active x
    JOIN public.attributions a
      ON a.source_system = 'manual'
     AND NULLIF(pg_catalog.btrim(a.deal_id), '') IS NOT NULL
     AND a.deal_id <> x.active_deal_id
     AND NULLIF(pg_catalog.btrim(a.sf_link), '') IS NOT NULL
     AND pg_catalog.length(x.sf_opportunity_id) >= 15
     AND pg_catalog.strpos(a.sf_link, pg_catalog.left(x.sf_opportunity_id, 15)) > 0
    LEFT JOIN public.attribution_touches t ON t.attribution_id = a.id
    GROUP BY x.review_id, x.review_updated_at, x.review_bdr_name,
      x.existing_revenue_override, x.sf_opportunity_uuid, x.sf_opportunity_id,
      x.opportunity_name, x.account_name, x.saas_revenue_usd,
      x.suggested_bdr_name, x.active_deal_id, a.deal_id
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
      SELECT 1 FROM public.sf_opportunity_deal_adoptions d
      WHERE d.review_id = l.review_id
    )
      AND NOT EXISTS (
        SELECT 1 FROM public.sf_opportunity_deal_links other_link
        WHERE other_link.deal_id = l.legacy_deal_id
          AND other_link.link_state = 'active'
      )
      AND l.legacy_label_variants = 1
      AND l.legacy_account_variants = 1
      AND pg_catalog.lower(pg_catalog.regexp_replace(
        pg_catalog.btrim(l.legacy_label), '\s+', ' ', 'g'
      )) = pg_catalog.lower(pg_catalog.regexp_replace(
        pg_catalog.btrim(l.opportunity_name), '\s+', ' ', 'g'
      ))
      AND pg_catalog.lower(pg_catalog.regexp_replace(
        pg_catalog.btrim(l.legacy_account), '\s+', ' ', 'g'
      )) = pg_catalog.lower(pg_catalog.regexp_replace(
        pg_catalog.btrim(l.account_name), '\s+', ' ', 'g'
      ))
      AND l.legacy_amount_variants <= 1
      AND l.legacy_bdr_variants <= 1
      AND (
        (COALESCE(l.saas_revenue_usd, 0) = 0
          AND l.legacy_amount > 0
          AND (l.existing_revenue_override IS NULL
            OR l.existing_revenue_override = l.legacy_amount))
        OR
        (NULLIF(pg_catalog.btrim(l.review_bdr_name), '') IS NULL
          AND NULLIF(pg_catalog.btrim(l.suggested_bdr_name), '') IS NULL
          AND NULLIF(pg_catalog.btrim(l.legacy_bdr_name), '') IS NOT NULL)
      )
      AND EXISTS (
        SELECT 1 FROM public.attributions g
        WHERE g.deal_id = l.active_deal_id
          AND g.source_system = 'salesforce'
          AND g.sf_opportunity_id = l.sf_opportunity_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.attributions g
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
        SELECT m.stage_key FROM public.attributions m
        WHERE m.deal_id = l.legacy_deal_id AND m.source_system = 'manual'
        ORDER BY m.stage_key
      ) = ARRAY(
        SELECT g.stage_key FROM public.attributions g
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
            OR (m.lead_id IS NOT NULL AND g.lead_id IS NOT NULL
              AND m.lead_id IS DISTINCT FROM g.lead_id)
            OR (NULLIF(pg_catalog.btrim(m.region), '') IS NOT NULL
              AND NULLIF(pg_catalog.btrim(g.region), '') IS NOT NULL
              AND m.region IS DISTINCT FROM g.region)
            OR (COALESCE(l.saas_revenue_usd, 0) <> 0
              AND m.amount IS NOT NULL AND g.amount IS NOT NULL
              AND m.amount IS DISTINCT FROM g.amount)
            OR (NULLIF(pg_catalog.btrim(l.review_bdr_name), '') IS NOT NULL
              AND NULLIF(pg_catalog.btrim(m.bdr_name), '') IS NOT NULL
              AND l.review_bdr_name IS DISTINCT FROM m.bdr_name)
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
    'revenueOverride', CASE
      WHEN COALESCE(e.saas_revenue_usd, 0) = 0 AND e.legacy_amount > 0
      THEN e.legacy_amount ELSE e.existing_revenue_override END,
    'bdrOverride', CASE
      WHEN NULLIF(pg_catalog.btrim(e.review_bdr_name), '') IS NULL
       AND NULLIF(pg_catalog.btrim(e.suggested_bdr_name), '') IS NULL
      THEN e.legacy_bdr_name ELSE e.review_bdr_name END,
    'datePolicy', 'salesforce_history_first_legacy_only_when_missing',
    'version', pg_catalog.to_char(
      e.review_updated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  )
  FROM eligible e
  ORDER BY e.review_id;
$$;

CREATE OR REPLACE FUNCTION public.sf_reconcile_active_opportunity_duplicate_fill_missing(
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
  v_candidate JSONB;
  v_current_version TEXT;
  v_request_hash TEXT;
  v_legacy_rows INTEGER;
  v_legacy_touches INTEGER;
  v_generated_rows INTEGER;
  v_generated_touches INTEGER;
  v_reporting_rows INTEGER;
  v_revenue_override NUMERIC(14, 2);
  v_bdr_override TEXT;
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
    IF v_existing.adoption_kind = 'active_duplicate_fill_missing'
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

  SELECT c INTO v_candidate
  FROM public.sf_list_opportunity_active_duplicate_fill_candidates() c
  WHERE c->>'reviewId' = p_review_id::TEXT
    AND c->>'legacyDealId' = pg_catalog.btrim(p_expected_legacy_deal_id)
    AND c->>'activeDealId' = pg_catalog.btrim(p_expected_active_deal_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'fill-missing duplicate is ambiguous, conflicting, touched on both copies, or no longer present';
  END IF;

  v_revenue_override := NULLIF(v_candidate->>'revenueOverride', '')::NUMERIC;
  v_bdr_override := NULLIF(pg_catalog.btrim(v_candidate->>'bdrOverride'), '');

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
  IF v_review.saas_revenue_usd_override IS NOT NULL
     AND v_review.saas_revenue_usd_override IS DISTINCT FROM v_revenue_override THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'existing revenue override conflicts with the legacy value';
  END IF;
  IF NULLIF(pg_catalog.btrim(v_review.bdr_name), '') IS NOT NULL
     AND NULLIF(pg_catalog.btrim(v_review.bdr_name), '') IS DISTINCT FROM v_bdr_override THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'existing reviewed BDR conflicts with the legacy value';
  END IF;

  -- The generated copy has no touches by candidate contract. The retained
  -- legacy rows and their IDs keep every attribution touch.
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
      review_note = 'Active duplicate reconciled; missing legacy values and touches preserved',
      updated_at = pg_catalog.now()
  WHERE id = v_link.id
    AND deal_id = p_expected_active_deal_id
    AND link_state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'active link changed during reconciliation';
  END IF;

  UPDATE public.sf_opportunity_reviews
  SET saas_revenue_usd_override = COALESCE(
        saas_revenue_usd_override, v_revenue_override
      ),
      bdr_name = COALESCE(NULLIF(pg_catalog.btrim(bdr_name), ''), v_bdr_override),
      issue_codes = pg_catalog.array_remove(issue_codes, 'possible_existing_deal'),
      updated_at = pg_catalog.now()
  WHERE id = p_review_id;

  INSERT INTO public.sf_opportunity_review_events (
    review_id, sf_opportunity_uuid, event_type, previous_state, new_state,
    issue_codes_snapshot, actor_type, actor_id, note, occurred_at
  ) VALUES (
    p_review_id, v_opp.id, 'link_recorded', v_review.review_state, v_review.review_state,
    v_review.issue_codes, 'reviewer', p_actor_id,
    'Active duplicate consolidated by exact Salesforce Opportunity ID; missing legacy values retained',
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
    'revenueOverrideApplied', v_revenue_override,
    'bdrOverrideApplied', v_bdr_override,
    'stageDatePolicy', 'salesforce_history_first_legacy_only_when_missing',
    'reportingRows', v_reporting_rows,
    'version', (
      SELECT pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      FROM public.sf_opportunity_reviews WHERE id = p_review_id
    ),
    'replayed', FALSE
  );

  INSERT INTO public.sf_opportunity_deal_adoptions (
    review_id, sf_opportunity_uuid, deal_id, adoption_kind,
    attribution_rows_adopted, attribution_touches_preserved,
    actor_id, idempotency_key, request_hash, response_json
  ) VALUES (
    p_review_id, v_opp.id, p_expected_legacy_deal_id,
    'active_duplicate_fill_missing', v_legacy_rows, v_legacy_touches,
    p_actor_id, p_idempotency_key, v_request_hash, v_response
  );

  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.sf_list_opportunity_active_duplicate_fill_candidates()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sf_reconcile_active_opportunity_duplicate_fill_missing(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sf_list_opportunity_active_duplicate_fill_candidates()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.sf_reconcile_active_opportunity_duplicate_fill_missing(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

COMMIT;
