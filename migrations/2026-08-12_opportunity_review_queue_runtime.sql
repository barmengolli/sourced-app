-- 2026-08-12_opportunity_review_queue_runtime.sql
--
-- Live Opportunity review boundary for the Data Entry queue.
-- STATUS: Applied manually to production on 2026-08-12. Supabase reported
-- success; the migration itself performed no review decision or attribution.
--
-- Guarantees:
-- - browser users never receive service-role access;
-- - every decision, audit event, exact Salesforce link, and generated
--   reporting-row reconciliation is one database transaction;
-- - manual attribution rows are never updated or deleted;
-- - reviewer overrides survive nightly Salesforce refreshes;
-- - identical retries are replayed and conflicting retries are refused;
-- - approved records follow Salesforce stage regressions without erasing the
--   append-only movement ledger.

BEGIN;

ALTER TABLE public.sf_opportunity_reviews
  ADD COLUMN IF NOT EXISTS hpp_entered_at_override DATE,
  ADD COLUMN IF NOT EXISTS opp_entered_at_override DATE,
  ADD COLUMN IF NOT EXISTS pursuit_entered_at_override DATE;

CREATE TABLE IF NOT EXISTS public.sf_opportunity_review_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id TEXT NOT NULL CHECK (length(pg_catalog.btrim(actor_id)) > 0),
  action TEXT NOT NULL CHECK (action IN ('approve', 'ignore', 'block', 'reopen', 'reconsider')),
  review_id UUID NOT NULL REFERENCES public.sf_opportunity_reviews(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(pg_catalog.btrim(idempotency_key)) > 0),
  request_hash TEXT NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (actor_id, action, review_id, idempotency_key)
);

ALTER TABLE public.sf_opportunity_review_requests ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS append_only_sf_opportunity_review_requests
  ON public.sf_opportunity_review_requests;
CREATE TRIGGER append_only_sf_opportunity_review_requests
  BEFORE UPDATE OR DELETE ON public.sf_opportunity_review_requests
  FOR EACH ROW EXECUTE FUNCTION public.sf_opportunity_append_only();

-- Rebuild one approved Opportunity's generated reporting projection from its
-- reviewer-owned baseline plus append-only Salesforce movement evidence.
-- This function is intentionally not granted directly to browser roles.
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
  v_event RECORD;
  v_hpp_date DATE;
  v_opp_date DATE;
  v_pursuit_date DATE;
  v_region TEXT;
  v_inserted INTEGER := 0;
BEGIN
  SELECT * INTO v_opp
  FROM public.sf_opportunities
  WHERE id = p_sf_opportunity_uuid
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  SELECT * INTO v_review
  FROM public.sf_opportunity_reviews
  WHERE sf_opportunity_uuid = p_sf_opportunity_uuid
  FOR UPDATE;
  IF NOT FOUND OR v_review.review_state NOT IN ('approved', 'linked') THEN
    RETURN 0;
  END IF;

  SELECT * INTO v_link
  FROM public.sf_opportunity_deal_links
  WHERE sf_opportunity_uuid = p_sf_opportunity_uuid AND link_state = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  v_hpp_date := v_review.hpp_entered_at_override;
  v_opp_date := v_review.opp_entered_at_override;
  v_pursuit_date := v_review.pursuit_entered_at_override;

  -- Opportunity creation is the confirmed HPP baseline for this import.
  -- Downstream dates are never inferred from a current snapshot.
  IF v_hpp_date IS NULL AND v_opp.sf_created_at IS NOT NULL THEN
    v_hpp_date := v_opp.sf_created_at::DATE;
  END IF;

  FOR v_event IN
    SELECT to_record_type_state, changed_at
    FROM public.sf_opportunity_events
    WHERE sf_opportunity_uuid = p_sf_opportunity_uuid
      AND event_kind = 'record_type'
    ORDER BY changed_at, sf_history_id
  LOOP
    CASE v_event.to_record_type_state
      WHEN 'hpp' THEN
        v_hpp_date := v_event.changed_at::DATE;
        v_opp_date := NULL;
        v_pursuit_date := NULL;
      WHEN 'opp' THEN
        v_opp_date := v_event.changed_at::DATE;
        v_pursuit_date := NULL;
      WHEN 'pursuit' THEN
        v_pursuit_date := v_event.changed_at::DATE;
      WHEN 'out_of_scope' THEN
        v_hpp_date := NULL;
        v_opp_date := NULL;
        v_pursuit_date := NULL;
      ELSE
        NULL;
    END CASE;
  END LOOP;

  DELETE FROM public.attributions
  WHERE source_system = 'salesforce'
    AND sf_opportunity_id = v_opp.sf_opportunity_id;

  IF v_opp.source_deleted
     OR v_opp.is_closed IS TRUE
     OR v_opp.normalized_record_type_state NOT IN ('hpp', 'opp', 'pursuit') THEN
    RETURN 0;
  END IF;

  v_region := COALESCE(
    NULLIF(pg_catalog.btrim(v_review.commercial_region_override), ''),
    NULLIF(pg_catalog.btrim(v_opp.commercial_region), '')
  );
  IF v_region IS NULL OR v_region NOT IN (
    'NA', 'EMEA cont & LATAM', 'UK&IRE, ME, Japan', 'Other'
  ) THEN
    RETURN 0;
  END IF;

  IF v_hpp_date IS NOT NULL THEN
    INSERT INTO public.attributions (
      source_system, sf_opportunity_id, lead_id, deal_id, stage_key,
      channel_id, year, period_index, label, account, sfdc_account_id,
      amount, sf_link, region, stage_entered_at, lost_reason, bdr_name
    ) VALUES (
      'salesforce', v_opp.sf_opportunity_id, v_review.lead_id, v_link.deal_id, 'hpp',
      v_review.channel_id, EXTRACT(YEAR FROM v_hpp_date)::INTEGER,
      EXTRACT(QUARTER FROM v_hpp_date)::INTEGER,
      v_opp.opportunity_name, v_opp.account_name, v_opp.account_id,
      v_opp.saas_revenue_usd, NULL, v_region, v_hpp_date, NULL,
      COALESCE(v_review.bdr_name, v_opp.suggested_bdr_name)
    );
    v_inserted := v_inserted + 1;
  END IF;

  IF v_opp.normalized_record_type_state IN ('opp', 'pursuit') AND v_opp_date IS NOT NULL THEN
    INSERT INTO public.attributions (
      source_system, sf_opportunity_id, lead_id, deal_id, stage_key,
      channel_id, year, period_index, label, account, sfdc_account_id,
      amount, sf_link, region, stage_entered_at, lost_reason, bdr_name
    ) VALUES (
      'salesforce', v_opp.sf_opportunity_id, v_review.lead_id, v_link.deal_id, 'opp',
      v_review.channel_id, EXTRACT(YEAR FROM v_opp_date)::INTEGER,
      EXTRACT(QUARTER FROM v_opp_date)::INTEGER,
      v_opp.opportunity_name, v_opp.account_name, v_opp.account_id,
      v_opp.saas_revenue_usd, NULL, v_region, v_opp_date, NULL,
      COALESCE(v_review.bdr_name, v_opp.suggested_bdr_name)
    );
    v_inserted := v_inserted + 1;
  END IF;

  IF v_opp.normalized_record_type_state = 'pursuit' AND v_pursuit_date IS NOT NULL THEN
    INSERT INTO public.attributions (
      source_system, sf_opportunity_id, lead_id, deal_id, stage_key,
      channel_id, year, period_index, label, account, sfdc_account_id,
      amount, sf_link, region, stage_entered_at, lost_reason, bdr_name
    ) VALUES (
      'salesforce', v_opp.sf_opportunity_id, v_review.lead_id, v_link.deal_id, 'pursuit',
      v_review.channel_id, EXTRACT(YEAR FROM v_pursuit_date)::INTEGER,
      EXTRACT(QUARTER FROM v_pursuit_date)::INTEGER,
      v_opp.opportunity_name, v_opp.account_name, v_opp.account_id,
      v_opp.saas_revenue_usd, NULL, v_region, v_pursuit_date, NULL,
      COALESCE(v_review.bdr_name, v_opp.suggested_bdr_name)
    );
    v_inserted := v_inserted + 1;
  END IF;

  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.sf_refresh_all_approved_opportunity_reporting()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_row RECORD;
  v_reviewed INTEGER := 0;
  v_rows INTEGER := 0;
BEGIN
  FOR v_row IN
    SELECT sf_opportunity_uuid
    FROM public.sf_opportunity_reviews
    WHERE review_state IN ('approved', 'linked')
    ORDER BY sf_opportunity_uuid
  LOOP
    v_reviewed := v_reviewed + 1;
    v_rows := v_rows + public.sf_refresh_opportunity_reporting(v_row.sf_opportunity_uuid);
  END LOOP;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'refreshed',
    'approved_opportunities', v_reviewed,
    'generated_rows', v_rows
  );
END;
$$;

-- Service-only queue read. The browser sees this data only through the
-- authenticated same-origin API and never queries protected tables itself.
CREATE OR REPLACE FUNCTION public.sf_list_opportunity_reviews(p_view TEXT DEFAULT 'attention')
RETURNS SETOF JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'reviewId', r.id,
    'version', pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'opportunityName', COALESCE(o.opportunity_name, 'Unnamed opportunity'),
    'accountName', o.account_name,
    'recordType', o.normalized_record_type_state,
    'stageName', o.stage_name,
    'isClosed', COALESCE(o.is_closed, FALSE),
    'amount', o.amount,
    'amountCurrency', o.amount_currency,
    'saasRevenue', o.saas_revenue,
    'saasRevenueUsd', o.saas_revenue_usd,
    'createdAt', o.sf_created_at,
    'lastModifiedAt', o.sf_last_modified_at,
    'owner', o.opportunity_owner,
    'reviewState', r.review_state,
    'issueCodes', r.issue_codes,
    'channelId', r.channel_id,
    'leadId', r.lead_id,
    'bdrName', r.bdr_name,
    'sourceMarket', o.market,
    'sourceCommercialRegion', o.commercial_region,
    'sourceGtmCube', o.gtm_cube,
    'marketOverride', r.market_override,
    'commercialRegionOverride', r.commercial_region_override,
    'gtmCubeOverride', r.gtm_cube_override,
    'hppEnteredAt', COALESCE(r.hpp_entered_at_override, o.sf_created_at::DATE),
    'oppEnteredAt', r.opp_entered_at_override,
    'pursuitEnteredAt', r.pursuit_entered_at_override,
    'suggestedBdrName', o.suggested_bdr_name,
    'primaryCampaignSource', o.primary_campaign_source,
    'customerExpansionRaw', o.customer_expansion_raw,
    'linkStatus', COALESCE(l.link_state, 'none')
  )
  FROM public.sf_opportunity_reviews r
  JOIN public.sf_opportunities o ON o.id = r.sf_opportunity_uuid
  LEFT JOIN public.sf_opportunity_deal_links l
    ON l.sf_opportunity_uuid = o.id AND l.link_state = 'active'
  WHERE CASE p_view
    WHEN 'attention' THEN r.review_state IN ('pending', 'blocked')
    WHEN 'not_selected' THEN r.review_state = 'ignored'
    ELSE FALSE
  END
    AND o.normalized_record_type_state IS DISTINCT FROM 'out_of_scope'
    AND l.id IS NULL
  ORDER BY o.sf_created_at DESC NULLS LAST, r.id;
$$;

CREATE OR REPLACE FUNCTION public.sf_apply_opportunity_review_action(
  p_review_id UUID,
  p_action TEXT,
  p_decision JSONB,
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
  v_existing public.sf_opportunity_review_requests%ROWTYPE;
  v_request_hash TEXT;
  v_current_version TEXT;
  v_response JSONB;
  v_previous_state TEXT;
  v_note TEXT;
  v_channel_id UUID;
  v_lead_id UUID;
  v_hpp DATE;
  v_opp_date DATE;
  v_pursuit DATE;
  v_region TEXT;
  v_deal_id TEXT;
  v_rows INTEGER := 0;
BEGIN
  IF p_action NOT IN ('approve', 'ignore', 'block', 'reopen', 'reconsider') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unsupported review action';
  END IF;
  IF NULLIF(pg_catalog.btrim(p_actor_id), '') IS NULL
     OR NULLIF(pg_catalog.btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'actor and idempotency key are required';
  END IF;

  v_request_hash := pg_catalog.md5(pg_catalog.concat_ws('|', p_action, p_review_id::TEXT, p_decision::TEXT));
  SELECT * INTO v_existing
  FROM public.sf_opportunity_review_requests
  WHERE actor_id = p_actor_id AND action = p_action
    AND review_id = p_review_id AND idempotency_key = p_idempotency_key;
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
  SELECT * INTO v_opp FROM public.sf_opportunities WHERE id = v_review.sf_opportunity_uuid FOR UPDATE;

  v_current_version := pg_catalog.to_char(v_review.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  IF p_expected_version IS DISTINCT FROM v_current_version THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'review changed; reload and retry';
  END IF;
  v_previous_state := v_review.review_state;
  v_note := NULLIF(pg_catalog.btrim(p_decision->>'note'), '');

  IF p_action = 'approve' THEN
    IF v_review.review_state <> 'pending' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'only a pending review can be approved';
    END IF;
    IF v_opp.normalized_record_type_state NOT IN ('hpp', 'opp', 'pursuit') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'record type is not reportable';
    END IF;
    IF v_review.issue_codes && ARRAY['unknown_record_type','conflicting_history_id','invalid_source_row']::TEXT[] THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'blocking issues must be resolved first';
    END IF;

    v_channel_id := NULLIF(p_decision->>'channelId', '')::UUID;
    v_lead_id := NULLIF(p_decision->>'leadId', '')::UUID;
    IF v_channel_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.channels WHERE id = v_channel_id) THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'a valid channel is required';
    END IF;
    IF v_lead_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.leads WHERE id = v_lead_id) THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'lead does not exist';
    END IF;

    v_hpp := NULLIF(p_decision->>'hppEnteredAt', '')::DATE;
    v_opp_date := NULLIF(p_decision->>'oppEnteredAt', '')::DATE;
    v_pursuit := NULLIF(p_decision->>'pursuitEnteredAt', '')::DATE;
    IF v_hpp IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'HPP date is required';
    END IF;
    IF v_opp.normalized_record_type_state IN ('opp', 'pursuit') AND v_opp_date IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Opportunity date is required';
    END IF;
    IF v_opp.normalized_record_type_state = 'pursuit' AND v_pursuit IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Pursuit date is required';
    END IF;
    IF v_opp_date IS NOT NULL AND v_opp_date < v_hpp THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Opportunity date cannot precede HPP date';
    END IF;
    IF v_pursuit IS NOT NULL AND v_pursuit < COALESCE(v_opp_date, v_hpp) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Pursuit date cannot precede the prior stage';
    END IF;

    v_region := NULLIF(pg_catalog.btrim(COALESCE(p_decision->>'commercialRegionOverride', v_opp.commercial_region)), '');
    IF v_region IS NULL OR v_region NOT IN ('NA','EMEA cont & LATAM','UK&IRE, ME, Japan','Other') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'select a valid Commercial Region';
    END IF;

    UPDATE public.sf_opportunity_reviews SET
      review_state = 'approved',
      issue_codes = pg_catalog.array_remove(pg_catalog.array_remove(issue_codes, 'missing_channel'), 'missing_region'),
      channel_id = v_channel_id,
      lead_id = v_lead_id,
      bdr_name = NULLIF(pg_catalog.btrim(COALESCE(p_decision->>'bdrName', v_opp.suggested_bdr_name)), ''),
      market_override = NULLIF(pg_catalog.btrim(p_decision->>'marketOverride'), ''),
      commercial_region_override = v_region,
      gtm_cube_override = NULLIF(pg_catalog.btrim(p_decision->>'gtmCubeOverride'), ''),
      hpp_entered_at_override = v_hpp,
      opp_entered_at_override = v_opp_date,
      pursuit_entered_at_override = v_pursuit,
      reviewer_note = v_note,
      reviewed_at = pg_catalog.now(),
      reviewed_by = p_actor_id
    WHERE id = p_review_id;

    v_deal_id := 'salesforce:' || v_opp.sf_opportunity_id;
    IF EXISTS (
      SELECT 1 FROM public.sf_opportunity_deal_links
      WHERE sf_opportunity_uuid = v_opp.id AND link_state = 'active' AND deal_id <> v_deal_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'opportunity already has another active deal link';
    END IF;
    INSERT INTO public.sf_opportunity_deal_links (
      sf_opportunity_uuid, deal_id, link_state, link_method, linked_by, review_note
    ) SELECT v_opp.id, v_deal_id, 'active', 'manual_review', p_actor_id, v_note
    WHERE NOT EXISTS (
      SELECT 1 FROM public.sf_opportunity_deal_links
      WHERE sf_opportunity_uuid = v_opp.id AND link_state = 'active'
    );

    INSERT INTO public.sf_opportunity_review_events (
      review_id, sf_opportunity_uuid, event_type, previous_state, new_state,
      issue_codes_snapshot, actor_type, actor_id, note, occurred_at
    ) VALUES (
      p_review_id, v_opp.id, 'approval_recorded', v_previous_state, 'approved',
      pg_catalog.array_remove(pg_catalog.array_remove(v_review.issue_codes, 'missing_channel'), 'missing_region'),
      'reviewer', p_actor_id, v_note, pg_catalog.now()
    ), (
      p_review_id, v_opp.id, 'link_recorded', 'approved', 'approved',
      pg_catalog.array_remove(pg_catalog.array_remove(v_review.issue_codes, 'missing_channel'), 'missing_region'),
      'reviewer', p_actor_id, NULL, pg_catalog.now()
    );
    v_rows := public.sf_refresh_opportunity_reporting(v_opp.id);
  ELSIF p_action = 'ignore' THEN
    IF v_review.review_state <> 'pending' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'only a pending review can be not selected';
    END IF;
    UPDATE public.sf_opportunity_reviews SET review_state = 'ignored', reviewer_note = v_note,
      reviewed_at = pg_catalog.now(), reviewed_by = p_actor_id WHERE id = p_review_id;
    INSERT INTO public.sf_opportunity_review_events (
      review_id, sf_opportunity_uuid, event_type, previous_state, new_state,
      issue_codes_snapshot, actor_type, actor_id, note, occurred_at
    ) VALUES (p_review_id, v_opp.id, 'state_transition', v_previous_state, 'ignored',
      v_review.issue_codes, 'reviewer', p_actor_id, v_note, pg_catalog.now());
  ELSIF p_action = 'block' THEN
    IF v_review.review_state <> 'pending' OR v_note IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'blocking requires a pending review and a reason';
    END IF;
    UPDATE public.sf_opportunity_reviews SET review_state = 'blocked', reviewer_note = v_note,
      reviewed_at = pg_catalog.now(), reviewed_by = p_actor_id WHERE id = p_review_id;
    INSERT INTO public.sf_opportunity_review_events (
      review_id, sf_opportunity_uuid, event_type, previous_state, new_state,
      issue_codes_snapshot, actor_type, actor_id, note, occurred_at
    ) VALUES (p_review_id, v_opp.id, 'state_transition', v_previous_state, 'blocked',
      v_review.issue_codes, 'reviewer', p_actor_id, v_note, pg_catalog.now());
  ELSE
    IF (p_action = 'reopen' AND v_review.review_state <> 'blocked')
       OR (p_action = 'reconsider' AND (v_review.review_state <> 'ignored' OR v_note IS NULL)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'review cannot be reopened from its current state';
    END IF;
    UPDATE public.sf_opportunity_reviews SET review_state = 'pending', reviewer_note = v_note,
      reviewed_at = pg_catalog.now(), reviewed_by = p_actor_id WHERE id = p_review_id;
    INSERT INTO public.sf_opportunity_review_events (
      review_id, sf_opportunity_uuid, event_type, previous_state, new_state,
      issue_codes_snapshot, actor_type, actor_id, note, occurred_at
    ) VALUES (p_review_id, v_opp.id, 'reopened', v_previous_state, 'pending',
      v_review.issue_codes, 'reviewer', p_actor_id, v_note, pg_catalog.now());
  END IF;

  SELECT * INTO v_review FROM public.sf_opportunity_reviews WHERE id = p_review_id;
  v_response := pg_catalog.jsonb_build_object(
    'status', 'applied',
    'action', p_action,
    'reviewId', p_review_id,
    'reviewState', v_review.review_state,
    'version', pg_catalog.to_char(v_review.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'reportingRows', v_rows,
    'replayed', FALSE
  );
  INSERT INTO public.sf_opportunity_review_requests (
    actor_id, action, review_id, idempotency_key, request_hash, response_json
  ) VALUES (p_actor_id, p_action, p_review_id, p_idempotency_key, v_request_hash, v_response);
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.sf_refresh_opportunity_reporting(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sf_refresh_all_approved_opportunity_reporting() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sf_list_opportunity_reviews(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sf_apply_opportunity_review_action(UUID, TEXT, JSONB, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sf_refresh_all_approved_opportunity_reporting() TO service_role;
GRANT EXECUTE ON FUNCTION public.sf_list_opportunity_reviews(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sf_apply_opportunity_review_action(UUID, TEXT, JSONB, TEXT, TEXT, TEXT) TO service_role;

COMMIT;
