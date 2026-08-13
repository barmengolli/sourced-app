-- 2026-08-13_opportunity_review_context.sql
-- STATUS: APPLIED MANUALLY TO PRODUCTION ON 2026-08-13.
-- Application confirmed by the operator. Live catalog verification is still
-- recorded separately from this status statement.
-- Protected read context only. No approval, lead link, ingestion calculation,
-- or reporting row is changed by applying this migration.

BEGIN;

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
    'hppEnteredAt', COALESCE(r.hpp_entered_at_override, o.sf_created_at::DATE),
    'oppEnteredAt', r.opp_entered_at_override,
    'pursuitEnteredAt', r.pursuit_entered_at_override,
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

CREATE OR REPLACE FUNCTION public.sf_find_lead_by_email(p_email TEXT)
RETURNS SETOF JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', l.id,
    'email', l.email,
    'firstName', l.first_name,
    'lastName', l.last_name,
    'account', l.account
  )
  FROM public.leads l
  WHERE pg_catalog.lower(pg_catalog.btrim(l.email)) = pg_catalog.lower(pg_catalog.btrim(p_email))
  ORDER BY l.id
  LIMIT 2;
$$;

REVOKE ALL ON FUNCTION public.sf_list_opportunity_reviews(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sf_find_lead_by_email(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sf_list_opportunity_reviews(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sf_find_lead_by_email(TEXT) TO service_role;

COMMIT;
