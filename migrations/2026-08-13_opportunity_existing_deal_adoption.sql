-- 2026-08-13_opportunity_existing_deal_adoption.sql
-- STATUS: APPLIED MANUALLY TO PRODUCTION ON 2026-08-13.
--
-- Safely adopts a legacy Sourced deal when its stored Salesforce URL contains
-- exactly one matching Opportunity ID and every legacy stage row agrees on
-- channel, Lead, region, and BDR. The legacy deal id and attribution row ids
-- remain stable, so attribution_touches are preserved. Ambiguous, name-only,
-- conflicting, or unmatched candidates remain manual review work.
--
-- Applying this migration changes structure and protected functions only. It
-- does not adopt a review or reconcile an active duplicate by itself.

BEGIN;

CREATE TABLE IF NOT EXISTS public.sf_opportunity_deal_adoptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES public.sf_opportunity_reviews(id) ON DELETE RESTRICT,
  sf_opportunity_uuid UUID NOT NULL REFERENCES public.sf_opportunities(id) ON DELETE RESTRICT,
  deal_id TEXT NOT NULL CHECK (length(pg_catalog.btrim(deal_id)) > 0),
  adoption_kind TEXT NOT NULL CHECK (adoption_kind IN ('pending_exact_id', 'active_duplicate')),
  attribution_rows_adopted INTEGER NOT NULL CHECK (attribution_rows_adopted >= 0),
  attribution_touches_preserved INTEGER NOT NULL CHECK (attribution_touches_preserved >= 0),
  actor_id TEXT NOT NULL CHECK (length(pg_catalog.btrim(actor_id)) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(pg_catalog.btrim(idempotency_key)) > 0),
  request_hash TEXT NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (actor_id, review_id, idempotency_key),
  UNIQUE (review_id)
);

ALTER TABLE public.sf_opportunity_deal_adoptions ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS append_only_sf_opportunity_deal_adoptions
  ON public.sf_opportunity_deal_adoptions;
CREATE TRIGGER append_only_sf_opportunity_deal_adoptions
  BEFORE UPDATE OR DELETE ON public.sf_opportunity_deal_adoptions
  FOR EACH ROW EXECUTE FUNCTION public.sf_opportunity_append_only();

-- Only exact Salesforce-ID candidates are actionable. Name/account equality
-- remains a warning and never appears in this result.
CREATE OR REPLACE FUNCTION public.sf_list_opportunity_existing_deal_candidates()
RETURNS SETOF JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH candidate_deals AS (
    SELECT
      r.id AS review_id,
      a.deal_id,
      pg_catalog.count(DISTINCT a.label) FILTER (
        WHERE NULLIF(pg_catalog.btrim(a.label), '') IS NOT NULL
      ) AS label_variants,
      pg_catalog.count(DISTINCT a.account) FILTER (
        WHERE NULLIF(pg_catalog.btrim(a.account), '') IS NOT NULL
      ) AS account_variants,
      pg_catalog.count(DISTINCT a.channel_id) FILTER (WHERE a.channel_id IS NOT NULL)
        AS channel_variants,
      pg_catalog.count(DISTINCT a.lead_id) FILTER (WHERE a.lead_id IS NOT NULL)
        AS lead_variants,
      pg_catalog.count(DISTINCT a.region) FILTER (
        WHERE NULLIF(pg_catalog.btrim(a.region), '') IS NOT NULL
      ) AS region_variants,
      pg_catalog.count(DISTINCT a.bdr_name) FILTER (
        WHERE NULLIF(pg_catalog.btrim(a.bdr_name), '') IS NOT NULL
      ) AS bdr_variants,
      pg_catalog.min(a.label) AS label,
      pg_catalog.min(a.account) AS account,
      pg_catalog.count(DISTINCT a.id) AS attribution_rows,
      pg_catalog.count(t.id) AS attribution_touches
    FROM public.sf_opportunity_reviews r
    JOIN public.sf_opportunities o ON o.id = r.sf_opportunity_uuid
    JOIN public.attributions a
      ON a.source_system = 'manual'
     AND NULLIF(pg_catalog.btrim(a.deal_id), '') IS NOT NULL
     AND NULLIF(pg_catalog.btrim(a.sf_link), '') IS NOT NULL
     AND pg_catalog.length(o.sf_opportunity_id) >= 15
     AND pg_catalog.strpos(a.sf_link, pg_catalog.left(o.sf_opportunity_id, 15)) > 0
    LEFT JOIN public.attribution_touches t ON t.attribution_id = a.id
    LEFT JOIN public.sf_opportunity_deal_links l
      ON l.sf_opportunity_uuid = o.id AND l.link_state = 'active'
    WHERE r.review_state = 'pending'
      AND l.id IS NULL
      AND o.normalized_record_type_state IN ('hpp', 'opp', 'pursuit')
    GROUP BY r.id, a.deal_id
  ), rollup AS (
    SELECT review_id, pg_catalog.count(*) AS deal_matches
    FROM candidate_deals
    GROUP BY review_id
  )
  SELECT pg_catalog.jsonb_build_object(
    'reviewId', c.review_id,
    'dealId', c.deal_id,
    'label', c.label,
    'account', c.account,
    'attributionRows', c.attribution_rows,
    'attributionTouches', c.attribution_touches
  )
  FROM candidate_deals c
  JOIN rollup r ON r.review_id = c.review_id AND r.deal_matches = 1
  WHERE c.label_variants <= 1
    AND c.account_variants <= 1
    AND c.channel_variants = 1
    AND c.lead_variants <= 1
    AND c.region_variants <= 1
    AND c.bdr_variants <= 1
  ORDER BY c.review_id;
$$;

-- The current refresh deleted and recreated every Salesforce attribution.
-- This replacement reconciles by stable deal/stage keys. Existing row ids
-- survive, and any obsolete-stage touches move to the retained HPP row before
-- the obsolete stage is removed.
CREATE OR REPLACE FUNCTION public.sf_refresh_opportunity_reporting(
  p_sf_opportunity_uuid UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_opp public.sf_opportunities%ROWTYPE;
  v_review public.sf_opportunity_reviews%ROWTYPE;
  v_link public.sf_opportunity_deal_links%ROWTYPE;
  v_hpp_date DATE;
  v_opp_date DATE;
  v_pursuit_date DATE;
  v_region TEXT;
  v_terminal_stage TEXT;
  v_lost_reason TEXT;
  v_expected_stages TEXT[] := ARRAY[]::TEXT[];
  v_hpp_attribution_id UUID;
  v_base_touch_order INTEGER;
  v_rows INTEGER := 0;
BEGIN
  SELECT * INTO v_opp FROM public.sf_opportunities
  WHERE id = p_sf_opportunity_uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT * INTO v_review FROM public.sf_opportunity_reviews
  WHERE sf_opportunity_uuid = p_sf_opportunity_uuid FOR UPDATE;
  IF NOT FOUND OR v_review.review_state NOT IN ('approved', 'linked') THEN RETURN 0; END IF;

  SELECT * INTO v_link FROM public.sf_opportunity_deal_links
  WHERE sf_opportunity_uuid = p_sf_opportunity_uuid AND link_state = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT d.hpp_entered_at, d.opp_entered_at, d.pursuit_entered_at
  INTO v_hpp_date, v_opp_date, v_pursuit_date
  FROM public.sf_derive_opportunity_stage_dates(p_sf_opportunity_uuid) d;

  -- A legacy deal can contain reviewed stage dates that predate Salesforce
  -- history ingestion. Preserve those proven dates when history has no value;
  -- never replace a Salesforce-derived date with a legacy one.
  SELECT
    COALESCE(v_hpp_date, pg_catalog.min(stage_entered_at) FILTER (WHERE stage_key = 'hpp')),
    COALESCE(v_opp_date, pg_catalog.min(stage_entered_at) FILTER (WHERE stage_key = 'opp')),
    COALESCE(v_pursuit_date, pg_catalog.min(stage_entered_at) FILTER (WHERE stage_key = 'pursuit'))
  INTO v_hpp_date, v_opp_date, v_pursuit_date
  FROM public.attributions
  WHERE deal_id = v_link.deal_id;

  IF v_opp.source_deleted OR v_opp.normalized_record_type_state NOT IN ('hpp','opp','pursuit') THEN
    RETURN 0;
  END IF;
  IF v_opp.is_closed IS TRUE AND v_opp.close_date IS NULL THEN
    RAISE EXCEPTION 'closed opportunity requires Salesforce CloseDate';
  END IF;

  v_region := COALESCE(NULLIF(pg_catalog.btrim(v_review.commercial_region_override), ''),
                       NULLIF(pg_catalog.btrim(v_opp.commercial_region), ''));
  IF v_region IS NULL OR v_region NOT IN ('NA','EMEA cont & LATAM','UK&IRE, ME, Japan','Other') THEN
    RETURN 0;
  END IF;

  IF v_hpp_date IS NOT NULL THEN
    v_expected_stages := pg_catalog.array_append(v_expected_stages, 'hpp');
    INSERT INTO public.attributions (
      source_system, sf_opportunity_id, lead_id, deal_id, stage_key, channel_id,
      year, period_index, label, account, sfdc_account_id, amount, sf_link,
      region, stage_entered_at, lost_reason, bdr_name
    ) VALUES (
      'salesforce', v_opp.sf_opportunity_id, v_review.lead_id, v_link.deal_id, 'hpp',
      v_review.channel_id, EXTRACT(YEAR FROM v_hpp_date)::INTEGER,
      EXTRACT(QUARTER FROM v_hpp_date)::INTEGER, v_opp.opportunity_name,
      v_opp.account_name, v_opp.account_id, v_opp.saas_revenue_usd, NULL, v_region,
      v_hpp_date, NULL, COALESCE(v_review.bdr_name, v_opp.suggested_bdr_name)
    ) ON CONFLICT (deal_id, stage_key) WHERE deal_id IS NOT NULL AND deal_id <> ''
    DO UPDATE SET source_system = 'salesforce', sf_opportunity_id = EXCLUDED.sf_opportunity_id,
      lead_id = EXCLUDED.lead_id, channel_id = EXCLUDED.channel_id, year = EXCLUDED.year,
      period_index = EXCLUDED.period_index, label = EXCLUDED.label, account = EXCLUDED.account,
      sfdc_account_id = EXCLUDED.sfdc_account_id, amount = EXCLUDED.amount,
      region = EXCLUDED.region, stage_entered_at = EXCLUDED.stage_entered_at,
      lost_reason = NULL, bdr_name = EXCLUDED.bdr_name, updated_at = pg_catalog.now();
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  END IF;

  IF v_opp.normalized_record_type_state IN ('opp','pursuit') AND v_opp_date IS NOT NULL THEN
    v_expected_stages := pg_catalog.array_append(v_expected_stages, 'opp');
    INSERT INTO public.attributions (
      source_system, sf_opportunity_id, lead_id, deal_id, stage_key, channel_id,
      year, period_index, label, account, sfdc_account_id, amount, sf_link,
      region, stage_entered_at, lost_reason, bdr_name
    ) VALUES (
      'salesforce', v_opp.sf_opportunity_id, v_review.lead_id, v_link.deal_id, 'opp',
      v_review.channel_id, EXTRACT(YEAR FROM v_opp_date)::INTEGER,
      EXTRACT(QUARTER FROM v_opp_date)::INTEGER, v_opp.opportunity_name,
      v_opp.account_name, v_opp.account_id, v_opp.saas_revenue_usd, NULL, v_region,
      v_opp_date, NULL, COALESCE(v_review.bdr_name, v_opp.suggested_bdr_name)
    ) ON CONFLICT (deal_id, stage_key) WHERE deal_id IS NOT NULL AND deal_id <> ''
    DO UPDATE SET source_system = 'salesforce', sf_opportunity_id = EXCLUDED.sf_opportunity_id,
      lead_id = EXCLUDED.lead_id, channel_id = EXCLUDED.channel_id, year = EXCLUDED.year,
      period_index = EXCLUDED.period_index, label = EXCLUDED.label, account = EXCLUDED.account,
      sfdc_account_id = EXCLUDED.sfdc_account_id, amount = EXCLUDED.amount,
      region = EXCLUDED.region, stage_entered_at = EXCLUDED.stage_entered_at,
      lost_reason = NULL, bdr_name = EXCLUDED.bdr_name, updated_at = pg_catalog.now();
    v_rows := v_rows + 1;
  END IF;

  IF v_opp.normalized_record_type_state = 'pursuit' AND v_pursuit_date IS NOT NULL THEN
    v_expected_stages := pg_catalog.array_append(v_expected_stages, 'pursuit');
    INSERT INTO public.attributions (
      source_system, sf_opportunity_id, lead_id, deal_id, stage_key, channel_id,
      year, period_index, label, account, sfdc_account_id, amount, sf_link,
      region, stage_entered_at, lost_reason, bdr_name
    ) VALUES (
      'salesforce', v_opp.sf_opportunity_id, v_review.lead_id, v_link.deal_id, 'pursuit',
      v_review.channel_id, EXTRACT(YEAR FROM v_pursuit_date)::INTEGER,
      EXTRACT(QUARTER FROM v_pursuit_date)::INTEGER, v_opp.opportunity_name,
      v_opp.account_name, v_opp.account_id, v_opp.saas_revenue_usd, NULL, v_region,
      v_pursuit_date, NULL, COALESCE(v_review.bdr_name, v_opp.suggested_bdr_name)
    ) ON CONFLICT (deal_id, stage_key) WHERE deal_id IS NOT NULL AND deal_id <> ''
    DO UPDATE SET source_system = 'salesforce', sf_opportunity_id = EXCLUDED.sf_opportunity_id,
      lead_id = EXCLUDED.lead_id, channel_id = EXCLUDED.channel_id, year = EXCLUDED.year,
      period_index = EXCLUDED.period_index, label = EXCLUDED.label, account = EXCLUDED.account,
      sfdc_account_id = EXCLUDED.sfdc_account_id, amount = EXCLUDED.amount,
      region = EXCLUDED.region, stage_entered_at = EXCLUDED.stage_entered_at,
      lost_reason = NULL, bdr_name = EXCLUDED.bdr_name, updated_at = pg_catalog.now();
    v_rows := v_rows + 1;
  END IF;

  IF v_opp.is_closed IS TRUE THEN
    v_terminal_stage := CASE WHEN COALESCE(v_opp.is_won, FALSE) THEN 'closeWon' ELSE 'closeLost' END;
    v_expected_stages := pg_catalog.array_append(v_expected_stages, v_terminal_stage);
    v_lost_reason := CASE
      WHEN v_terminal_stage = 'closeWon' THEN NULL
      WHEN v_opp.stage_name = 'Closed-Lost-Competitor' THEN 'Closed-Lost to Competitor'
      WHEN v_opp.stage_name = 'Closed-Lost-InHouse' THEN 'Closed-Lost In-House'
      WHEN v_opp.stage_name = 'Closed-Disqualified' THEN 'Closed-Disqualified'
      ELSE NULL END;
    INSERT INTO public.attributions (
      source_system, sf_opportunity_id, lead_id, deal_id, stage_key, channel_id,
      year, period_index, label, account, sfdc_account_id, amount, sf_link,
      region, stage_entered_at, lost_reason, bdr_name
    ) VALUES (
      'salesforce', v_opp.sf_opportunity_id, v_review.lead_id, v_link.deal_id, v_terminal_stage,
      v_review.channel_id, EXTRACT(YEAR FROM v_opp.close_date)::INTEGER,
      EXTRACT(QUARTER FROM v_opp.close_date)::INTEGER, v_opp.opportunity_name,
      v_opp.account_name, v_opp.account_id, v_opp.saas_revenue_usd, NULL, v_region,
      v_opp.close_date, v_lost_reason, COALESCE(v_review.bdr_name, v_opp.suggested_bdr_name)
    ) ON CONFLICT (deal_id, stage_key) WHERE deal_id IS NOT NULL AND deal_id <> ''
    DO UPDATE SET source_system = 'salesforce', sf_opportunity_id = EXCLUDED.sf_opportunity_id,
      lead_id = EXCLUDED.lead_id, channel_id = EXCLUDED.channel_id, year = EXCLUDED.year,
      period_index = EXCLUDED.period_index, label = EXCLUDED.label, account = EXCLUDED.account,
      sfdc_account_id = EXCLUDED.sfdc_account_id, amount = EXCLUDED.amount,
      region = EXCLUDED.region, stage_entered_at = EXCLUDED.stage_entered_at,
      lost_reason = EXCLUDED.lost_reason, bdr_name = EXCLUDED.bdr_name, updated_at = pg_catalog.now();
    v_rows := v_rows + 1;
  END IF;

  SELECT id INTO v_hpp_attribution_id FROM public.attributions
  WHERE deal_id = v_link.deal_id AND stage_key = 'hpp';
  IF v_hpp_attribution_id IS NOT NULL THEN
    SELECT COALESCE(pg_catalog.max(touch_order), 0) INTO v_base_touch_order
    FROM public.attribution_touches WHERE attribution_id = v_hpp_attribution_id;
    WITH moved AS (
      SELECT t.id, v_base_touch_order + pg_catalog.row_number() OVER (ORDER BY t.created_at, t.id) AS new_order
      FROM public.attribution_touches t
      JOIN public.attributions a ON a.id = t.attribution_id
      WHERE a.deal_id = v_link.deal_id
        AND a.source_system = 'salesforce'
        AND NOT (a.stage_key = ANY(v_expected_stages))
    )
    UPDATE public.attribution_touches t
    SET attribution_id = v_hpp_attribution_id, touch_order = moved.new_order
    FROM moved WHERE t.id = moved.id;
  END IF;

  DELETE FROM public.attributions
  WHERE deal_id = v_link.deal_id
    AND source_system = 'salesforce'
    AND NOT (stage_key = ANY(v_expected_stages));

  RETURN v_rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.sf_adopt_existing_opportunity_deal(
  p_review_id UUID,
  p_expected_deal_id TEXT,
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
  v_current_version TEXT;
  v_request_hash TEXT;
  v_deal_id TEXT;
  v_match_count INTEGER;
  v_channel UUID;
  v_lead UUID;
  v_region TEXT;
  v_bdr TEXT;
  v_rows INTEGER;
  v_touches INTEGER;
  v_reporting_rows INTEGER;
  v_response JSONB;
BEGIN
  IF NULLIF(pg_catalog.btrim(p_expected_deal_id), '') IS NULL
     OR NULLIF(pg_catalog.btrim(p_actor_id), '') IS NULL
     OR NULLIF(pg_catalog.btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'expected deal, actor, and idempotency key are required';
  END IF;
  v_request_hash := pg_catalog.md5(
    pg_catalog.concat_ws('|', p_review_id::TEXT, p_expected_deal_id, p_expected_version)
  );
  SELECT * INTO v_existing FROM public.sf_opportunity_deal_adoptions
  WHERE actor_id = p_actor_id AND review_id = p_review_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_hash <> v_request_hash THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'idempotency key already used for another request';
    END IF;
    RETURN v_existing.response_json || pg_catalog.jsonb_build_object('replayed', TRUE);
  END IF;

  SELECT * INTO v_review FROM public.sf_opportunity_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'review not found'; END IF;
  SELECT * INTO v_opp FROM public.sf_opportunities WHERE id = v_review.sf_opportunity_uuid FOR UPDATE;
  v_current_version := pg_catalog.to_char(v_review.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  IF p_expected_version IS DISTINCT FROM v_current_version THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'review changed; reload and retry';
  END IF;
  IF v_review.review_state <> 'pending' OR v_opp.normalized_record_type_state NOT IN ('hpp','opp','pursuit') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'review is not eligible for existing-deal adoption';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sf_opportunity_deal_links WHERE sf_opportunity_uuid = v_opp.id AND link_state = 'active') THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'opportunity already has an active deal link';
  END IF;

  SELECT pg_catalog.count(DISTINCT a.deal_id), pg_catalog.min(a.deal_id)
  INTO v_match_count, v_deal_id
  FROM public.attributions a
  WHERE a.source_system = 'manual'
    AND NULLIF(pg_catalog.btrim(a.deal_id), '') IS NOT NULL
    AND NULLIF(pg_catalog.btrim(a.sf_link), '') IS NOT NULL
    AND pg_catalog.length(v_opp.sf_opportunity_id) >= 15
    AND pg_catalog.strpos(a.sf_link, pg_catalog.left(v_opp.sf_opportunity_id, 15)) > 0;
  IF v_match_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'exact Salesforce ID does not resolve to one legacy deal';
  END IF;
  IF v_deal_id <> pg_catalog.btrim(p_expected_deal_id) THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'existing Sourced deal candidate changed; reload and retry';
  END IF;

  SELECT pg_catalog.min(channel_id::TEXT)::UUID, pg_catalog.min(lead_id::TEXT)::UUID,
         pg_catalog.min(region), pg_catalog.min(bdr_name), pg_catalog.count(*),
         (SELECT pg_catalog.count(*) FROM public.attribution_touches t
          JOIN public.attributions x ON x.id = t.attribution_id WHERE x.deal_id = v_deal_id)
  INTO v_channel, v_lead, v_region, v_bdr, v_rows, v_touches
  FROM public.attributions
  WHERE deal_id = v_deal_id AND source_system = 'manual'
  HAVING pg_catalog.count(DISTINCT label) FILTER (WHERE NULLIF(pg_catalog.btrim(label), '') IS NOT NULL) <= 1
     AND pg_catalog.count(DISTINCT account) FILTER (WHERE NULLIF(pg_catalog.btrim(account), '') IS NOT NULL) <= 1
     AND pg_catalog.count(DISTINCT channel_id) FILTER (WHERE channel_id IS NOT NULL) = 1
     AND pg_catalog.count(DISTINCT lead_id) FILTER (WHERE lead_id IS NOT NULL) <= 1
     AND pg_catalog.count(DISTINCT region) FILTER (WHERE NULLIF(pg_catalog.btrim(region), '') IS NOT NULL) <= 1
     AND pg_catalog.count(DISTINCT bdr_name) FILTER (WHERE NULLIF(pg_catalog.btrim(bdr_name), '') IS NOT NULL) <= 1;
  IF v_rows IS NULL OR v_channel IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'legacy deal fields conflict or its channel is missing';
  END IF;
  v_region := COALESCE(NULLIF(pg_catalog.btrim(v_region), ''), NULLIF(pg_catalog.btrim(v_opp.commercial_region), ''));
  IF v_region IS NULL OR v_region NOT IN ('NA','EMEA cont & LATAM','UK&IRE, ME, Japan','Other') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'legacy deal does not resolve to a valid region';
  END IF;

  UPDATE public.sf_opportunity_reviews SET review_state = 'linked', channel_id = v_channel,
    lead_id = v_lead, bdr_name = COALESCE(v_bdr, v_opp.suggested_bdr_name),
    commercial_region_override = v_region,
    issue_codes = pg_catalog.array_remove(pg_catalog.array_remove(
      pg_catalog.array_remove(issue_codes, 'missing_channel'), 'missing_region'), 'possible_existing_deal'),
    reviewer_note = 'Adopted existing Sourced deal by exact Salesforce Opportunity ID',
    reviewed_at = pg_catalog.now(), reviewed_by = p_actor_id,
    updated_at = pg_catalog.now()
  WHERE id = p_review_id;

  UPDATE public.attributions SET source_system = 'salesforce',
    sf_opportunity_id = v_opp.sf_opportunity_id, updated_at = pg_catalog.now()
  WHERE deal_id = v_deal_id AND source_system = 'manual';

  INSERT INTO public.sf_opportunity_deal_links (
    sf_opportunity_uuid, deal_id, link_state, link_method, linked_by, review_note
  ) VALUES (
    v_opp.id, v_deal_id, 'active', 'exact_sf_opportunity_id', p_actor_id,
    'Adopted existing Sourced deal; attribution row ids and touches preserved'
  );

  INSERT INTO public.sf_opportunity_review_events (
    review_id, sf_opportunity_uuid, event_type, previous_state, new_state,
    issue_codes_snapshot, actor_type, actor_id, note, occurred_at
  ) VALUES (
    p_review_id, v_opp.id, 'link_recorded', 'pending', 'linked',
    v_review.issue_codes, 'reviewer', p_actor_id,
    'Existing Sourced deal adopted by exact Salesforce Opportunity ID', pg_catalog.now()
  );

  v_reporting_rows := public.sf_refresh_opportunity_reporting(v_opp.id);
  v_response := pg_catalog.jsonb_build_object(
    'status', 'adopted', 'reviewId', p_review_id, 'reviewState', 'linked',
    'dealId', v_deal_id, 'attributionRowsAdopted', v_rows,
    'attributionTouchesPreserved', v_touches, 'reportingRows', v_reporting_rows,
    'version', (SELECT pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                FROM public.sf_opportunity_reviews WHERE id = p_review_id),
    'replayed', FALSE
  );
  INSERT INTO public.sf_opportunity_deal_adoptions (
    review_id, sf_opportunity_uuid, deal_id, adoption_kind, attribution_rows_adopted,
    attribution_touches_preserved, actor_id, idempotency_key, request_hash, response_json
  ) VALUES (
    p_review_id, v_opp.id, v_deal_id, 'pending_exact_id', v_rows, v_touches,
    p_actor_id, p_idempotency_key, v_request_hash, v_response
  );
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.sf_list_opportunity_existing_deal_candidates() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sf_refresh_opportunity_reporting(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sf_adopt_existing_opportunity_deal(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sf_list_opportunity_existing_deal_candidates() TO service_role;
GRANT EXECUTE ON FUNCTION public.sf_adopt_existing_opportunity_deal(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

COMMIT;
