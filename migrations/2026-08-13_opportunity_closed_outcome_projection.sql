-- 2026-08-13_opportunity_closed_outcome_projection.sql
-- STATUS: PENDING / NOT YET APPLIED.
--
-- Closed Salesforce Opportunities already carry an authoritative IsClosed,
-- IsWon, CloseDate, and StageName in protected staging. The existing review
-- runtime discarded every closed Opportunity during reporting refresh, so a
-- reviewer could approve its attribution but could not record Closed Won or
-- Closed Lost in Sourced. This migration keeps Salesforce authoritative for
-- the terminal outcome and close date while preserving the human-selected
-- channel, region, optional Lead link, BDR, and stage-entry dates. The review
-- queue now derives those dates through the same ordered Salesforce-history
-- replay used by reporting, so reviewers do not have to retype known dates.
--
-- No review is approved and no reporting row is written by applying this
-- migration. Existing approved records are reconciled by the nightly refresh
-- or an explicit call to sf_refresh_all_approved_opportunity_reporting().

BEGIN;

CREATE OR REPLACE FUNCTION public.sf_derive_opportunity_stage_dates(
  p_sf_opportunity_uuid UUID
) RETURNS TABLE (
  hpp_entered_at DATE,
  opp_entered_at DATE,
  pursuit_entered_at DATE
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_opp public.sf_opportunities%ROWTYPE;
  v_review public.sf_opportunity_reviews%ROWTYPE;
  v_event RECORD;
BEGIN
  SELECT * INTO v_opp
  FROM public.sf_opportunities
  WHERE id = p_sf_opportunity_uuid;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO v_review
  FROM public.sf_opportunity_reviews
  WHERE sf_opportunity_uuid = p_sf_opportunity_uuid;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  hpp_entered_at := v_review.hpp_entered_at_override;
  opp_entered_at := v_review.opp_entered_at_override;
  pursuit_entered_at := v_review.pursuit_entered_at_override;

  IF hpp_entered_at IS NULL AND v_opp.sf_created_at IS NOT NULL THEN
    hpp_entered_at := v_opp.sf_created_at::DATE;
  END IF;

  -- Exact same ordered replay used by reporting. Backward movement clears
  -- downstream dates so the queue never presents a stage as current evidence
  -- after Salesforce moved the Opportunity back.
  FOR v_event IN
    SELECT to_record_type_state, changed_at
    FROM public.sf_opportunity_events
    WHERE sf_opportunity_uuid = p_sf_opportunity_uuid
      AND event_kind = 'record_type'
    ORDER BY changed_at, sf_history_id
  LOOP
    CASE v_event.to_record_type_state
      WHEN 'hpp' THEN
        hpp_entered_at := v_event.changed_at::DATE;
        opp_entered_at := NULL;
        pursuit_entered_at := NULL;
      WHEN 'opp' THEN
        opp_entered_at := v_event.changed_at::DATE;
        pursuit_entered_at := NULL;
      WHEN 'pursuit' THEN
        pursuit_entered_at := v_event.changed_at::DATE;
      WHEN 'out_of_scope' THEN
        hpp_entered_at := NULL;
        opp_entered_at := NULL;
        pursuit_entered_at := NULL;
      ELSE
        NULL;
    END CASE;
  END LOOP;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.sf_guard_opportunity_deal_link_duplicate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_opportunity_name TEXT;
  v_account_name TEXT;
BEGIN
  IF NEW.link_state IS DISTINCT FROM 'active' THEN
    RETURN NEW;
  END IF;

  SELECT opportunity_name, account_name
  INTO v_opportunity_name, v_account_name
  FROM public.sf_opportunities
  WHERE id = NEW.sf_opportunity_uuid;

  IF NULLIF(pg_catalog.btrim(v_opportunity_name), '') IS NULL
     OR NULLIF(pg_catalog.btrim(v_account_name), '') IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.attributions a
    WHERE (a.source_system IS NULL OR a.source_system = 'manual')
      AND NULLIF(pg_catalog.btrim(a.deal_id), '') IS NOT NULL
      AND pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(a.label), '\s+', ' ', 'g'))
        = pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(v_opportunity_name), '\s+', ' ', 'g'))
      AND pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(a.account), '\s+', ' ', 'g'))
        = pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(v_account_name), '\s+', ' ', 'g'))
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'possible existing Sourced deal with the same Opportunity name and Account; resolve or link the legacy deal before approval';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sf_guard_opportunity_deal_link_duplicate
  ON public.sf_opportunity_deal_links;
CREATE TRIGGER trg_sf_guard_opportunity_deal_link_duplicate
BEFORE INSERT OR UPDATE OF sf_opportunity_uuid, deal_id, link_state
ON public.sf_opportunity_deal_links
FOR EACH ROW EXECUTE FUNCTION public.sf_guard_opportunity_deal_link_duplicate();

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

  SELECT d.hpp_entered_at, d.opp_entered_at, d.pursuit_entered_at
  INTO v_hpp_date, v_opp_date, v_pursuit_date
  FROM public.sf_derive_opportunity_stage_dates(p_sf_opportunity_uuid) d;

  IF v_opp.source_deleted
     OR v_opp.normalized_record_type_state NOT IN ('hpp', 'opp', 'pursuit') THEN
    DELETE FROM public.attributions
    WHERE source_system = 'salesforce'
      AND sf_opportunity_id = v_opp.sf_opportunity_id;
    RETURN 0;
  END IF;

  IF v_opp.is_closed IS TRUE AND v_opp.close_date IS NULL THEN
    RAISE EXCEPTION 'closed opportunity requires Salesforce CloseDate';
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

  DELETE FROM public.attributions
  WHERE source_system = 'salesforce'
    AND sf_opportunity_id = v_opp.sf_opportunity_id;

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

  IF v_opp.is_closed IS TRUE THEN
    v_terminal_stage := CASE
      WHEN COALESCE(v_opp.is_won, FALSE) THEN 'closeWon'
      ELSE 'closeLost'
    END;
    v_lost_reason := CASE
      WHEN v_terminal_stage = 'closeWon' THEN NULL
      WHEN v_opp.stage_name = 'Closed-Lost-Competitor' THEN 'Closed-Lost to Competitor'
      WHEN v_opp.stage_name = 'Closed-Lost-InHouse' THEN 'Closed-Lost In-House'
      WHEN v_opp.stage_name = 'Closed-Disqualified' THEN 'Closed-Disqualified'
      ELSE NULL
    END;

    INSERT INTO public.attributions (
      source_system, sf_opportunity_id, lead_id, deal_id, stage_key,
      channel_id, year, period_index, label, account, sfdc_account_id,
      amount, sf_link, region, stage_entered_at, lost_reason, bdr_name
    ) VALUES (
      'salesforce', v_opp.sf_opportunity_id, v_review.lead_id, v_link.deal_id, v_terminal_stage,
      v_review.channel_id, EXTRACT(YEAR FROM v_opp.close_date)::INTEGER,
      EXTRACT(QUARTER FROM v_opp.close_date)::INTEGER,
      v_opp.opportunity_name, v_opp.account_name, v_opp.account_id,
      v_opp.saas_revenue_usd, NULL, v_region, v_opp.close_date, v_lost_reason,
      COALESCE(v_review.bdr_name, v_opp.suggested_bdr_name)
    );
    v_inserted := v_inserted + 1;
  END IF;

  RETURN v_inserted;
END;
$$;

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
    'sfOpportunityId', o.sf_opportunity_id,
    'opportunityName', COALESCE(o.opportunity_name, 'Unnamed opportunity'),
    'accountName', o.account_name,
    'recordType', o.normalized_record_type_state,
    'stageName', o.stage_name,
    'isClosed', COALESCE(o.is_closed, FALSE),
    'isWon', COALESCE(o.is_won, FALSE),
    'closeDate', o.close_date,
    'sourceLostReason', CASE
      WHEN COALESCE(o.is_closed, FALSE) IS NOT TRUE OR COALESCE(o.is_won, FALSE) IS TRUE THEN NULL
      WHEN o.stage_name = 'Closed-Lost-Competitor' THEN 'Closed-Lost to Competitor'
      WHEN o.stage_name = 'Closed-Lost-InHouse' THEN 'Closed-Lost In-House'
      WHEN o.stage_name = 'Closed-Disqualified' THEN 'Closed-Disqualified'
      ELSE NULL
    END,
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
    'linkedLead', CASE WHEN linked_lead.id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
      'id', linked_lead.id,
      'email', linked_lead.email,
      'firstName', linked_lead.first_name,
      'lastName', linked_lead.last_name,
      'account', linked_lead.account
    ) END,
    'bdrName', r.bdr_name,
    'sourceMarket', o.market,
    'sourceCommercialRegion', o.commercial_region,
    'sourceGtmCube', o.gtm_cube,
    'marketOverride', r.market_override,
    'commercialRegionOverride', r.commercial_region_override,
    'gtmCubeOverride', r.gtm_cube_override,
    'hppEnteredAt', dates.hpp_entered_at,
    'oppEnteredAt', dates.opp_entered_at,
    'pursuitEnteredAt', dates.pursuit_entered_at,
    'suggestedBdrName', o.suggested_bdr_name,
    'primaryCampaignSource', CASE
      WHEN suggested.channel_name IS NOT NULL THEN suggested.channel_name
      WHEN NULLIF(pg_catalog.btrim(o.primary_campaign_source), '') IS NOT NULL
        THEN 'Present in Salesforce (no exact child-channel match)'
      ELSE NULL
    END,
    'suggestedChannelId', suggested.channel_id,
    'suggestedChannelName', suggested.channel_name,
    'customerExpansionRaw', o.customer_expansion_raw,
    'linkStatus', COALESCE(l.link_state, 'none')
  )
  FROM public.sf_opportunity_reviews r
  JOIN public.sf_opportunities o ON o.id = r.sf_opportunity_uuid
  LEFT JOIN public.sf_opportunity_deal_links l
    ON l.sf_opportunity_uuid = o.id AND l.link_state = 'active'
  LEFT JOIN public.leads linked_lead ON linked_lead.id = r.lead_id
  LEFT JOIN LATERAL public.sf_derive_opportunity_stage_dates(o.id) dates ON TRUE
  LEFT JOIN LATERAL (
    SELECT pg_catalog.min(c.id::TEXT)::UUID AS channel_id,
           pg_catalog.min(c.name) AS channel_name
    FROM public.lead_campaign_touches t
    JOIN public.channels c ON c.id = t.channel_id
    WHERE NULLIF(pg_catalog.btrim(o.primary_campaign_source), '') IS NOT NULL
      AND pg_catalog.left(t.campaign_id, 15) = pg_catalog.left(o.primary_campaign_source, 15)
      AND c.parent_channel_id IS NOT NULL
    HAVING pg_catalog.count(DISTINCT c.id) = 1
  ) suggested ON TRUE
  WHERE CASE p_view
    WHEN 'attention' THEN r.review_state IN ('pending', 'blocked')
    WHEN 'not_selected' THEN r.review_state = 'ignored'
    ELSE FALSE
  END
    AND o.normalized_record_type_state IS DISTINCT FROM 'out_of_scope'
    AND l.id IS NULL
  ORDER BY o.sf_created_at DESC NULLS LAST, r.id;
$$;

REVOKE ALL ON FUNCTION public.sf_derive_opportunity_stage_dates(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sf_guard_opportunity_deal_link_duplicate() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sf_refresh_opportunity_reporting(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sf_list_opportunity_reviews(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sf_list_opportunity_reviews(TEXT) TO service_role;

COMMIT;
